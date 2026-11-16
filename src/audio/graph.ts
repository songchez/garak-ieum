import { SAMPLED_KIT_PARAMS, SAMPLED_PIANO_PARAMS, paramValue } from '../core/devices'
import { instrumentDef } from '../core/instruments'
import { audibleTrackIds, audioWindows, isTrackEnabled, midiControllerEvents, midiEvents } from '../core/playback'
import type { AudioWindow, PlaybackController, PlaybackNote } from '../core/playback'
import { DEFAULT_BEND_RANGE, controllerSpec } from '../core/controllers'
import type { ControllerKey } from '../core/types'
import { isEffectDevice, type AudioAsset, type AudioClip, type InstrumentId, type Project, type Track, type TrackInputTap } from '../core/types'
import { masterFeedExcluded, reconcileTrackRoutes, routeOf } from '../core/trackRouting'
import { isReturnTrack, sendLayoutKey, sendsOf } from '../core/sends'
import { clamp } from './math'
import { tempoMapOf, type TempoMap } from '../core/tempoMap'
import { AUDIO_CLIP_GAIN_MAX, envelopeAt, envelopeBreakpoints, fadeLengths } from '../core/clipEnvelope.js'
import { pickZone, releaseNoiseGain, type LoadedSet, type SampleLibrary } from './samples'
import type { DeviceGraph } from '../devices/contracts'
export type { DeviceGraph } from '../devices/contracts'
import { EFFECT_MODULES } from '../devices/effects/registry'
import { bindGuitarRigDevice, createGuitarRigMaster } from '../devices/guitar-rig'
import { bindDeviceAnalysis } from '../devices/effects/analysis'
import { bindDynamicsMeter } from '../devices/effects/dynamicsMeter'
import { forwardVintageControl, scheduleVintage, updateVintageParams } from '../devices/vintage/web'
import { isVintageInstrument, vintageTailSeconds } from '../devices/vintage/params'
import { dbToGain, randomGenerator, setParameter } from '../devices/effects/shared'
import { automationValue, evaluateLane, isActiveLane, isDiscrete, targetDef, trackAt } from '../core/automation'
import type { AutomationLane } from '../core/types'
import type { ParamDef } from '../core/devices'

type SourceNode = AudioBufferSourceNode | OscillatorNode

export interface Voice {
  stop(at: number): void
  /** Live MIDI note-off: from `at`, fade over the instrument's release instead of the 3 ms stop. */
  release(at: number, seconds: number): void
  disconnect(): void
}

/** The last voice started per sample choke group, so a closed hat can cut an open one. */
export type ChokeMap = Map<number, { voice: Voice; when: number }>

export interface TrackGraph {
  input: GainNode
  /** Unity node after the device chain, before pan/fader: the "시김새 후" route tap. */
  postFx: GainNode
  devices: Map<string, DeviceGraph>
  panner: StereoPannerNode
  fader: GainNode
  meter: AnalyserNode
  meterData: Float32Array<ArrayBuffer>
  chokes: ChokeMap
  /** Aux sends by return track ID (docs/SENDS_RETURNS.md): a gain from postFx (pre) or the fader (post) into the return's input. */
  sends: Map<string, SendGraph>
  /** Controller response of the built-in instruments (instrument tracks only; docs/MIDI_CONTROLLERS.md). */
  controls?: TrackControls
}

export interface SendGraph {
  gain: GainNode
  pre: boolean
}

/**
 * Per-track controller nodes. Voices connect to `input` (volume CC7 x expression CC11) instead of the track input,
 * and pitched voices connect `pitch` (a cents bus: pitch bend + mod-wheel vibrato) to their sources' detune.
 */
export interface TrackControls {
  input: GainNode
  pitch: GainNode
  bend: ConstantSourceNode
  vibrato: OscillatorNode
  vibratoDepth: GainNode
  /** Last scheduled values (MIDI units; bend in cents). */
  state: { bend: number; mod: number; aftertouch: number; volume: number; expression: number }
}

/** Mod wheel / aftertouch at 127 = this vibrato depth in cents, at VIBRATO_HZ. */
export const VIBRATO_CENTS = 50
export const VIBRATO_HZ = 5.5
const BEND_SMOOTHING = 0.004
const GAIN_SMOOTHING = 0.005
const defaultControlState = (): TrackControls['state'] => ({ bend: 0, mod: 0, aftertouch: 0, volume: 100, expression: 127 })
/** CC7 100 = unity (the GM default); both follow the usual squared MIDI volume curve. */
export const controllerGain = (volume: number, expression: number): number => (volume / 100) ** 2 * (expression / 127) ** 2

export interface EngineGraph {
  context: BaseAudioContext
  tracks: Map<string, TrackGraph>
  voices: Set<Voice>
  previewInput: GainNode
  masterVolume: GainNode
  gate: GainNode
  meter: AnalyserNode
  meterData: Float32Array<ArrayBuffer>
  nodes: AudioNode[]
  resources: DeviceGraph[]
  /** Internal inputs of routed audio tracks (docs/TRACK_INPUT_ROUTING.md); see connectRoutes. */
  routes: Map<string, RouteGraph>
  /** Master feed for resampling tracks: master volume over the tracks not excluded from it. */
  resampleVolume?: GainNode
  /** Live input currently wired into track inputs; see connectMonitor. */
  monitor?: { source: MediaStreamAudioSourceNode; trackIds: string[]; splitter?: ChannelSplitterNode; nodes: AudioNode[] }
}

/** A routed track's input: `input` carries the source signal (recorders tap it); `monitor` (0/1) feeds the track. */
export interface RouteGraph {
  input: GainNode
  monitor: GainNode
}

const disposedGraphs = new WeakSet<EngineGraph>()
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>()
let tineCurve: Float32Array<ArrayBuffer> | null = null
const SAMPLE_TRIM_DB = -6

function noiseBuffer(context: BaseAudioContext): AudioBuffer {
  const existing = noiseBuffers.get(context)
  if (existing) return existing
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * 2), context.sampleRate)
  const values = buffer.getChannelData(0)
  const random = randomGenerator(47081)
  for (let frame = 0; frame < values.length; frame += 1) values[frame] = random() * 2 - 1
  noiseBuffers.set(context, buffer)
  return buffer
}

/** Mild asymmetric soft clip: adds the even harmonics of an electric piano preamp. */
function tineShaperCurve(): Float32Array<ArrayBuffer> {
  if (tineCurve) return tineCurve
  const points = 1024
  tineCurve = new Float32Array(points)
  const top = Math.tanh(1.45)
  for (let point = 0; point < points; point += 1) {
    const x = point / (points - 1) * 2 - 1
    tineCurve[point] = Math.tanh(1.2 * x + 0.25 * x * x) / top
  }
  return tineCurve
}

/** Static parameters; automated targets take their value at `beat` (docs/AUTOMATION.md). While playing, the
 * engine reschedules automation from now on afterwards, since this cancels what was scheduled. `bpm` is the tempo
 * tempo-synced effects follow: the tempo at `beat` (the playhead) when the project has a tempo map. */
export function updateGraph(graph: EngineGraph, project: Project, smooth = true, beat?: number, bpm = beat === undefined ? project.bpm : tempoMapOf(project).bpmAt(beat)): void {
  const now = graph.context.currentTime
  if (beat !== undefined) project = { ...project, tracks: project.tracks.map(track => trackAt(track, beat)) }
  const audible = audibleTrackIds(project.tracks)
  setParameter(graph.masterVolume.gain, clamp(project.masterVolume, 0, 2), now, smooth)
  if (graph.resampleVolume) setParameter(graph.resampleVolume.gain, clamp(project.masterVolume, 0, 2), now, smooth)
  for (const track of project.tracks) {
    const channel = graph.tracks.get(track.id)
    if (!channel) continue
    setParameter(channel.fader.gain, audible.has(track.id) ? clamp(track.volume, 0, 2) : 0, now, smooth)
    setParameter(channel.panner.pan, clamp(track.pan, -1, 1), now, smooth)
    for (const send of sendsOf(track)) {
      const node = channel.sends.get(send.returnId)
      // A post-fader send already follows the fader (mute/solo included); a pre-fader one is still silenced by mute/solo.
      if (node) setParameter(node.gain.gain, node.pre && !audible.has(track.id) ? 0 : clamp(send.level, 0, 2), now, smooth)
    }
    for (const device of track.devices) {
      if (device.enabled && isEffectDevice(device)) channel.devices.get(device.id)?.update(device.params, bpm, now, smooth)
    }
    // Vintage instruments (Rust worklet) take knob edits now; their parameters glide inside the DSP.
    if (track.kind === 'instrument' && isVintageInstrument(track.instrument)) updateVintageParams(channel.controls?.input ?? channel.input, track.instrument, track.instrumentParams)
  }
}

/** Automation evaluation step: one render quantum. AudioParams glide between steps with a ~1 ms time constant;
 * worklet 시김새 apply each step at its block and smooth internally (12 ms), so steps never zipper. */
export const AUTOMATION_STEP_FRAMES = 128
interface CompiledLane { lane: AutomationLane; def: ParamDef; discrete: boolean }
interface CompiledAutomation { volume?: CompiledLane; pan?: CompiledLane; mute?: CompiledLane; devices: Map<string, CompiledLane[]>; sends: Map<string, CompiledLane> }
const compiledAutomation = new WeakMap<Track, CompiledAutomation | null>()
function compileAutomation(track: Track): CompiledAutomation | null {
  if (compiledAutomation.has(track)) return compiledAutomation.get(track)!
  let result: CompiledAutomation | null = null
  for (const lane of track.automation ?? []) {
    if (!isActiveLane(track, lane)) continue
    const def = targetDef(track, lane.target)!
    const compiled = { lane, def, discrete: isDiscrete(def) }
    const target = lane.target
    result ??= { devices: new Map(), sends: new Map() }
    if (target.kind === 'track') result[target.param] = compiled
    else if (target.kind === 'send') result.sends.set(target.returnId, compiled)
    else if (target.kind === 'device') {
      const device = track.devices.find(item => item.id === target.deviceId)
      if (device && device.enabled && isEffectDevice(device)) result.devices.set(device.id, [...result.devices.get(device.id) ?? [], compiled])
    }
    // Instrument parameters apply per note onset in scheduleRange; VST3 lanes are native-only.
  }
  compiledAutomation.set(track, result)
  return result
}
const laneValue = (compiled: CompiledLane, beat: number) => automationValue(compiled.def, evaluateLane(compiled.lane.points, beat, compiled.discrete)!)
/** Last values (and tempo) sent per device graph, so flat stretches send nothing. */
const sentParams = new WeakMap<DeviceGraph, Record<string, number>>()
const sentBpm = new WeakMap<DeviceGraph, number>()

/**
 * Schedules track volume, pan, mute, send level and 시김새 parameter automation for context times [startTime, endTime).
 * beatAt maps a context time to the project beat heard then (loops and the tempo map included); worklet events
 * carry the tempo at their beat so synced effects follow a tempo map. Steps sit on an absolute grid of
 * AUTOMATION_STEP_FRAMES so consecutive calls neither overlap nor leave gaps.
 */
export function scheduleAutomation(graph: EngineGraph, project: Project, startTime: number, endTime: number, beatAt: (time: number) => number): void {
  if (!(endTime > startTime)) return
  const step = AUTOMATION_STEP_FRAMES / graph.context.sampleRate
  const first = Math.ceil(startTime / step - 1e-9)
  const count = Math.max(0, Math.ceil(endTime / step - 1e-9) - first)
  if (!count) return
  let audible: Set<string> | null = null
  const tempo = tempoMapOf(project)
  for (const track of project.tracks) {
    const channel = graph.tracks.get(track.id)
    const compiled = channel && isTrackEnabled(track) ? compileAutomation(track) : null
    if (!channel || !compiled) continue
    const tau = step / 3
    if (compiled.volume || compiled.mute) {
      audible ??= audibleTrackIds(project.tracks)
      // Mute automation only changes this track's own audibility; solo state comes from the static flags.
      const unmuted = compiled.mute ? audibleTrackIds(project.tracks.map(item => item.id === track.id ? { ...item, mute: false } : item)).has(track.id) : audible.has(track.id)
      for (let i = 0; i < count; i++) {
        const time = (first + i) * step, beat = beatAt(time)
        const muted = compiled.mute ? laneValue(compiled.mute, beat) >= 0.5 : false
        const gain = muted || !unmuted ? 0 : clamp(compiled.volume ? laneValue(compiled.volume, beat) : track.volume, 0, 2)
        channel.fader.gain.setTargetAtTime(gain, time, tau)
      }
    }
    if (compiled.sends.size) {
      audible ??= audibleTrackIds(project.tracks)
      for (const [returnId, lane] of compiled.sends) {
        const node = channel.sends.get(returnId)
        if (!node) continue
        // A pre-fader send is still silenced while the track is not audible (mute/solo), as in updateGraph.
        const silent = node.pre && !audible.has(track.id)
        for (let i = 0; i < count; i++) {
          const time = (first + i) * step
          node.gain.gain.setTargetAtTime(silent ? 0 : clamp(laneValue(lane, beatAt(time)), 0, 2), time, tau)
        }
      }
    }
    if (compiled.pan) for (let i = 0; i < count; i++) {
      const time = (first + i) * step
      channel.panner.pan.setTargetAtTime(clamp(laneValue(compiled.pan, beatAt(time)), -1, 1), time, tau)
    }
    for (const [deviceId, lanes] of compiled.devices) {
      const node = channel.devices.get(deviceId)
      const device = track.devices.find(item => item.id === deviceId)
      if (!node || !device || !isEffectDevice(device)) continue
      const events: { at: number; params: Record<string, number>; bpm: number }[] = []
      let last = sentParams.get(node)
      let lastBpm = sentBpm.get(node)
      for (let i = 0; i < count; i++) {
        const at = (first + i) * step, beat = beatAt(at)
        const params = { ...device.params }
        const bpm = tempo.bpmAt(beat)
        let changed = !last || lastBpm === undefined || Math.abs(bpm - lastBpm) >= 0.05 || Object.keys(params).some(key => last![key] !== params[key] && !lanes.some(lane => lane.def.id === key))
        for (const compiled of lanes) {
          const value = laneValue(compiled, beat)
          params[compiled.def.id] = value
          const previous = last?.[compiled.def.id]
          if (previous === undefined || Math.abs(previous - value) > Math.abs(value) * 1e-7) changed = true
        }
        if (!changed) continue
        events.push({ at, params, bpm })
        last = params
        lastBpm = bpm
      }
      if (!events.length) continue
      sentParams.set(node, last!)
      sentBpm.set(node, lastBpm!)
      if (node.schedule) node.schedule(events, events[0].bpm)
      else for (const event of events) node.update(event.params, event.bpm, event.at, true)
    }
  }
}

/** Forget what was sent (a static update or a new graph replaced the scheduled values). */
export function resetAutomationState(graph: EngineGraph): void {
  for (const channel of graph.tracks.values()) for (const node of channel.devices.values()) { sentParams.delete(node); sentBpm.delete(node) }
}

/**
 * Tempo map follow (docs/TEMPO_MAP.md) without touching automation: only 시김새 without active lanes are retuned
 * (automated ones get the tempo with each scheduled event), and faders, pans and sends keep what is scheduled.
 */
export function updateEffectTempo(graph: EngineGraph, project: Project, bpm: number, smooth = true): void {
  const now = graph.context.currentTime
  for (const track of project.tracks) {
    const channel = graph.tracks.get(track.id)
    if (!channel) continue
    const automated = compileAutomation(track)?.devices
    for (const device of track.devices) {
      if (device.enabled && isEffectDevice(device) && !automated?.has(device.id)) channel.devices.get(device.id)?.update(device.params, bpm, now, smooth)
    }
  }
}

export function renderTailSeconds(project: Project): number {
  const tails = new Map<string, number>()
  // Synced delays ring longest at the slowest tempo of the map.
  const slowest = Math.min(...tempoMapOf(project).points.map(point => point.bpm))
  for (const track of project.tracks) {
    if (!isTrackEnabled(track)) continue
    let tail = 0
    const def = instrumentDef(track.instrument)
    if (track.kind === 'instrument' && isVintageInstrument(track.instrument)) {
      tail = Math.max(tail, vintageTailSeconds(track.instrument, track.instrumentParams) + 0.2)
    } else if (track.kind === 'instrument' && !def.isKit) {
      tail = Math.max(tail, clamp(paramValue(def.params, track.instrumentParams, 'release'), 0, 30) + 0.2)
    } else if (track.kind === 'instrument' && def.kind === 'sampled') tail = Math.max(tail, 2)
    for (const device of track.devices) {
      if (!device.enabled || !isEffectDevice(device)) continue
      tail = Math.max(tail, EFFECT_MODULES[device.type].tailSeconds(device.params, slowest))
    }
    tails.set(track.id, tail)
  }
  let result = 0.85
  for (const track of project.tracks) {
    const own = tails.get(track.id)
    if (own === undefined) continue
    // A return keeps ringing after its senders' own tails: its effect tail continues from theirs.
    const senders = isReturnTrack(track) ? project.tracks.filter(item => sendsOf(item).some(send => send.returnId === track.id)).map(item => tails.get(item.id) ?? 0) : []
    result = Math.max(result, isReturnTrack(track) ? own + Math.max(0, ...senders) : own)
  }
  return result
}

function usesGuitarRigMaster(tracks: readonly Track[]): boolean {
  return tracks.some(track => isTrackEnabled(track) && track.devices.some(device => device.enabled && device.type === 'guitar-rig'))
}

/** This graph is used unchanged by realtime playback and OfflineAudioContext. */
export function createGraph(context: BaseAudioContext, project: Project): EngineGraph {
  const nodes: AudioNode[] = []
  const resources: DeviceGraph[] = []
  const remember = <T extends AudioNode>(node: T): T => { nodes.push(node); return node }
  try {
    const sum = remember(context.createGain())
    const masterVolume = remember(context.createGain())
    const hasGuitarRig = usesGuitarRigMaster(project.tracks)
    let master: { input: AudioNode; output: AudioNode }
    if (hasGuitarRig) {
      // The legacy DynamicsCompressor has 6 ms of fixed lookahead. Select the same
      // causal master for live and offline rig projects; preserve existing mixes.
      const processor = createGuitarRigMaster(context, remember)
      resources.push(processor)
      master = processor
    } else {
      const compressor = remember(context.createDynamicsCompressor())
      compressor.threshold.value = -3
      compressor.knee.value = 3
      compressor.ratio.value = 12
      compressor.attack.value = 0.003
      compressor.release.value = 0.12
      master = { input: compressor, output: compressor }
    }
    const gate = remember(context.createGain())
    const meter = remember(context.createAnalyser())
    meter.fftSize = 256
    sum.connect(masterVolume).connect(master.input)
    master.output.connect(gate).connect(meter).connect(context.destination)
    const previewInput = remember(context.createGain())
    previewInput.gain.value = 0.65
    previewInput.connect(sum)
    const tracks = new Map<string, TrackGraph>()
    for (const track of project.tracks) {
      const input = remember(context.createGain())
      const panner = remember(context.createStereoPanner())
      const fader = remember(context.createGain())
      const trackMeter = remember(context.createAnalyser())
      trackMeter.fftSize = 256
      const devices = new Map<string, DeviceGraph>()
      let tail: AudioNode = input
      for (const device of track.devices) {
        if (!isEffectDevice(device)) continue
        const effect = EFFECT_MODULES[device.type]
        if (!device.enabled || !effect || devices.has(device.id)) continue
        const node = effect.create(context, remember)
        resources.push(node)
        if (device.type === 'guitar-rig') bindGuitarRigDevice(node, device.id, context)
        bindDeviceAnalysis(node, device.id, context)
        bindDynamicsMeter(node, device.id, context)
        tail.connect(node.input)
        tail = node.output
        devices.set(device.id, node)
      }
      const postFx = remember(context.createGain())
      tail.connect(postFx).connect(panner)
      panner.connect(fader).connect(trackMeter).connect(sum)

      const controls = track.kind === 'instrument' ? createTrackControls(context, input, remember) : undefined
      tracks.set(track.id, {
        input, postFx, devices, panner, fader, meter: trackMeter,
        meterData: new Float32Array(trackMeter.fftSize), chokes: new Map(), sends: new Map(), ...(controls ? { controls } : {}),
      })
    }
    connectSends(context, project, tracks, remember)
    const { routes, resampleVolume } = connectRoutes(context, project, tracks, remember)
    const graph: EngineGraph = {
      context, tracks, routes, ...(resampleVolume ? { resampleVolume } : {}), voices: new Set(), previewInput, masterVolume, gate, meter,
      meterData: new Float32Array(meter.fftSize), nodes, resources,
    }
    updateGraph(graph, project, false)
    return graph
  } catch (error) {
    // A partially constructed effect must not leave a connected/dry path behind.
    releaseResources(resources, nodes)
    throw error
  }
}

/**
 * Wires every send into its return track's input (docs/SENDS_RETURNS.md). Returns never send and are never
 * route sources, so these connections cannot form a cycle. Levels are set by updateGraph.
 */
export function connectSends(context: BaseAudioContext, project: Project, tracks: ReadonlyMap<string, TrackGraph>, remember: <T extends AudioNode>(node: T) => T): void {
  for (const track of project.tracks) {
    const channel = tracks.get(track.id)
    if (!channel) continue
    for (const send of sendsOf(track)) {
      const target = project.tracks.find(item => item.id === send.returnId)
      const destination = target && isReturnTrack(target) ? tracks.get(target.id) : undefined
      if (!destination || channel.sends.has(send.returnId)) continue
      const gain = remember(context.createGain())
      gain.gain.value = 0
      ;(send.pre ? channel.postFx : channel.fader).connect(gain).connect(destination.input)
      channel.sends.set(send.returnId, { gain, pre: !!send.pre })
    }
  }
}

function createTrackControls(context: BaseAudioContext, destination: AudioNode, remember: <T extends AudioNode>(node: T) => T): TrackControls | undefined {
  if (typeof context.createConstantSource !== 'function') return undefined
  const input = remember(context.createGain())
  input.connect(destination)
  const pitch = remember(context.createGain())
  const bend = remember(context.createConstantSource())
  bend.offset.value = 0
  bend.connect(pitch)
  const vibrato = remember(context.createOscillator())
  vibrato.frequency.value = VIBRATO_HZ
  const vibratoDepth = remember(context.createGain())
  vibratoDepth.gain.value = 0
  vibrato.connect(vibratoDepth).connect(pitch)
  bend.start()
  vibrato.start()
  return { input, pitch, bend, vibrato, vibratoDepth, state: defaultControlState() }
}

/** Applies one controller value at `time`. Other controllers (pan, other CCs, program) have no built-in meaning. */
export function applyControl(controls: TrackControls, key: ControllerKey, value: number, time: number, range = DEFAULT_BEND_RANGE): void {
  // Vintage instruments render pitch bend and modulation themselves (no detune input on a worklet).
  forwardVintageControl(controls.input, key, value, time, range)
  const state = controls.state
  if (key === 'pitchBend') {
    state.bend = value / 8192 * range * 100
    controls.bend.offset.setTargetAtTime(state.bend, time, BEND_SMOOTHING)
  } else if (key === 'cc1' || key === 'aftertouch') {
    if (key === 'cc1') state.mod = value
    else state.aftertouch = value
    controls.vibratoDepth.gain.setTargetAtTime(Math.max(state.mod, state.aftertouch) / 127 * VIBRATO_CENTS, time, GAIN_SMOOTHING)
  } else if (key === 'cc7' || key === 'cc11') {
    if (key === 'cc7') state.volume = value
    else state.expression = value
    controls.input.gain.setTargetAtTime(controllerGain(state.volume, state.expression), time, GAIN_SMOOTHING)
  }
}

/** Jumps every controller to its value in effect at `beat` (chase on start, seek and cycle wrap). */
export function chaseControls(controls: TrackControls, events: readonly PlaybackController[], beat: number, time: number): void {
  const last = new Map<ControllerKey, PlaybackController>()
  for (const event of events) { if (event.beat > beat + 1e-9) break; last.set(event.key, event) }
  for (const key of ['pitchBend', 'cc1', 'aftertouch', 'cc7', 'cc11'] as const) {
    const event = last.get(key)
    applyControl(controls, key, event?.value ?? controllerSpec(key).default, time, event?.range)
  }
}

/** The node a route listens on: before the chain, after it, or after pan and fader (mute/solo included). */
export function routeTapNode(channel: TrackGraph, tap: TrackInputTap): AudioNode {
  return tap === 'preFx' ? channel.input : tap === 'postFx' ? channel.postFx : channel.fader
}

/**
 * Wires every routed audio track's internal input. Sources are connected in the same render quantum, so a
 * recorder on `RouteGraph.input` sees the source's samples at the same context frames the source plays
 * them (no added latency). Routes are reconciled first, so the connections form no cycle; the master feed
 * leaves out resampling tracks and everything downstream of them (masterFeedExcluded).
 */
export function connectRoutes(context: BaseAudioContext, project: Project, tracks: ReadonlyMap<string, TrackGraph>, remember: <T extends AudioNode>(node: T) => T): { routes: Map<string, RouteGraph>; resampleVolume?: GainNode } {
  const routes = new Map<string, RouteGraph>()
  const reconciled = reconcileTrackRoutes(project.tracks)
  let resampleVolume: GainNode | undefined
  for (const track of reconciled) {
    const route = routeOf(track)
    const channel = tracks.get(track.id)
    if (!route || !channel) continue
    const input = remember(context.createGain())
    const monitor = remember(context.createGain())
    monitor.gain.value = 0
    input.connect(monitor).connect(channel.input)
    routes.set(track.id, { input, monitor })
    if (route.kind === 'track') {
      const source = tracks.get(route.trackId)
      if (source) routeTapNode(source, route.tap).connect(input)
    } else if (route.kind === 'master') {
      if (!resampleVolume) {
        const excluded = masterFeedExcluded(reconciled)
        const feed = remember(context.createGain())
        resampleVolume = remember(context.createGain())
        resampleVolume.gain.value = clamp(project.masterVolume, 0, 2)
        feed.connect(resampleVolume)
        for (const item of reconciled) if (!excluded.has(item.id)) tracks.get(item.id)?.fader.connect(feed)
      }
      resampleVolume.connect(input)
    }
  }
  return { routes, resampleVolume }
}

/** Opens the monitor gate of the routed tracks in `trackIds` and closes the others. */
export function setRouteMonitoring(graph: EngineGraph, trackIds: readonly string[]): void {
  const on = new Set(trackIds)
  const now = graph.context.currentTime
  for (const [id, route] of graph.routes) {
    const value = on.has(id) ? 1 : 0
    if (route.monitor.gain.value === value) continue
    route.monitor.gain.cancelScheduledValues(now)
    route.monitor.gain.setTargetAtTime(value, now, 0.003)
  }
}

function releaseResources(resources: readonly DeviceGraph[], nodes: readonly AudioNode[]): void {
  for (const resource of resources) {
    try { resource.dispose?.() } catch { /* Continue releasing the remaining graph. */ }
  }
  for (const node of nodes) {
    try { node.disconnect() } catch { /* A failed/disposed context may already have detached it. */ }
  }
}

/** A ChannelSplitterNode has at most 32 outputs; higher device channels cannot be split in a browser. */
const MAX_SPLIT_CHANNELS = 32

/**
 * Wires one live input into the given tracks' inputs, replacing any earlier wiring on this graph.
 * `inputs` picks stream channels per track (TrackInput.channels): one goes in as mono, two are merged as
 * left/right. Tracks without an entry hear the whole stream. The splitter reads the stream as discrete
 * channels, so a channel the stream does not have is silent, like a missing input on the native engine.
 */
export function connectMonitor(graph: EngineGraph, source: MediaStreamAudioSourceNode, trackIds: readonly string[], inputs: ReadonlyMap<string, readonly number[]> = new Map()): void {
  disconnectMonitor(graph)
  const targets = trackIds.filter(id => graph.tracks.has(id))
  if (!targets.length) return
  const routed = targets.map(id => inputs.get(id)).filter((channels): channels is readonly number[] => !!channels)
  const outputs = Math.min(MAX_SPLIT_CHANNELS, Math.max(1, ...routed.flat().map(channel => channel + 1)))
  const splitter = routed.length ? graph.context.createChannelSplitter(outputs) : undefined
  const nodes: AudioNode[] = []
  if (splitter) { splitter.channelInterpretation = 'discrete'; source.connect(splitter); nodes.push(splitter) }
  for (const id of targets) {
    const destination = graph.tracks.get(id)!.input
    const channels = inputs.get(id)
    if (!channels || !splitter) { source.connect(destination); continue }
    const usable = channels.filter(channel => channel < outputs)
    if (usable.length !== channels.length) continue
    if (channels.length === 1) { splitter.connect(destination, channels[0], 0); continue }
    const merger = graph.context.createChannelMerger(2)
    splitter.connect(merger, channels[0], 0)
    splitter.connect(merger, channels[1], 1)
    merger.connect(destination)
    nodes.push(merger)
  }
  graph.monitor = { source, trackIds: targets.filter(id => !inputs.has(id)), splitter, nodes }
}

export function disconnectMonitor(graph: EngineGraph): void {
  const monitor = graph.monitor
  if (!monitor) return
  graph.monitor = undefined
  for (const id of monitor.trackIds) {
    const channel = graph.tracks.get(id)
    if (!channel) continue
    try { monitor.source.disconnect(channel.input) } catch { /* Already detached. */ }
  }
  if (monitor.splitter) try { monitor.source.disconnect(monitor.splitter) } catch { /* Already detached. */ }
  for (const node of monitor.nodes) try { node.disconnect() } catch { /* Already detached. */ }
}

export function disposeGraph(graph: EngineGraph): void {
  if (disposedGraphs.has(graph)) return
  disposedGraphs.add(graph)
  disconnectMonitor(graph)
  for (const voice of [...graph.voices]) {
    try { voice.stop(graph.context.currentTime) } catch { /* Still release its nodes and effect processors. */ }
    try { voice.disconnect() } catch { /* Continue releasing the remaining graph. */ }
  }
  graph.voices.clear()
  for (const channel of graph.tracks.values()) {
    if (!channel.controls) continue
    try { channel.controls.bend.stop(); channel.controls.vibrato.stop() } catch { /* Already stopped. */ }
  }
  releaseResources(graph.resources, graph.nodes)
}

/** Scheduled voices per track (onset time, audio region or not), so an edit can replace one track's voices. */
interface OwnedVoice { onset: number; audio: boolean }
const trackVoices = new WeakMap<EngineGraph, Map<string, Map<Voice, OwnedVoice>>>()
/** Set by scheduleRange around each onset; registerVoice files the new voice under it. */
let voiceOwner: { trackId: string; onset: number; audio: boolean } | null = null

/**
 * Stops the voices scheduled for one track: every voice when `all`; otherwise audio regions (they are chased again
 * from their correct offset) and notes whose onset is at or after `from` (not heard yet). Sounding notes ring out.
 */
export function stopTrackVoices(graph: EngineGraph, trackId: string, from: number, all: boolean): number {
  const owned = trackVoices.get(graph)?.get(trackId)
  if (!owned) return 0
  const now = graph.context.currentTime
  let stopped = 0
  for (const [voice, info] of [...owned]) {
    if (!all && !info.audio && info.onset < from) continue
    try { voice.stop(now) } catch { /* Already silent. */ }
    owned.delete(voice)
    stopped += 1
  }
  return stopped
}

/** A voice rendered elsewhere (a vintage instrument's worklet): filed and released like registerVoice's. */
function adoptVoice(graph: EngineGraph, base: { stop(at: number): void; release(at: number, seconds: number): void; dispose(): void }): Voice {
  let disconnected = false
  const owner = voiceOwner
  const voice: Voice = {
    stop(at) { if (!disconnected) base.stop(at) },
    release(at, seconds) { if (!disconnected) base.release(at, seconds) },
    disconnect() {
      if (disconnected) return
      disconnected = true
      base.dispose()
      graph.voices.delete(voice)
      if (owner) trackVoices.get(graph)?.get(owner.trackId)?.delete(voice)
    },
  }
  if (owner) {
    let byTrack = trackVoices.get(graph)
    if (!byTrack) trackVoices.set(graph, byTrack = new Map())
    let owned = byTrack.get(owner.trackId)
    if (!owned) byTrack.set(owner.trackId, owned = new Map())
    owned.set(voice, { onset: owner.onset, audio: owner.audio })
  }
  graph.voices.add(voice)
  return voice
}

function registerVoice(graph: EngineGraph, sources: SourceNode[], nodes: AudioNode[], envelope: GainNode, pitchBus?: AudioNode): Voice {
  let disconnected = false
  // Pitch bend and vibrato reach every source of a pitched voice through its detune (cents).
  if (pitchBus) for (const source of sources) pitchBus.connect(source.detune)
  let ended = 0
  let stopped = false
  const voice: Voice = {
    stop(at) {
      if (stopped || disconnected) return
      stopped = true
      const when = Math.max(graph.context.currentTime, at)
      envelope.gain.cancelScheduledValues(when)
      envelope.gain.setTargetAtTime(0, when, 0.003)
      for (const source of sources) {
        try { source.stop(when + 0.015) } catch { /* A completed source is already silent. */ }
      }
    },
    release(at, seconds) {
      if (stopped || disconnected) return
      stopped = true
      const when = Math.max(graph.context.currentTime, at)
      const tail = Math.max(0.005, seconds)
      const gain = envelope.gain as AudioParam & { cancelAndHoldAtTime?: (time: number) => AudioParam }
      if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(when)
      else { gain.cancelScheduledValues(when); gain.setValueAtTime(gain.value, when) }
      gain.setTargetAtTime(0, when, tail / 4)
      for (const source of sources) {
        try { source.stop(when + tail * 1.5 + 0.02) } catch { /* A completed source is already silent. */ }
      }
    },
    disconnect() {
      if (disconnected) return
      disconnected = true
      for (const node of nodes) node.disconnect()
      if (pitchBus) for (const source of sources) { try { pitchBus.disconnect(source.detune) } catch { /* Not connected. */ } }
      for (const source of sources) source.onended = null
      graph.voices.delete(voice)
      if (owner) trackVoices.get(graph)?.get(owner.trackId)?.delete(voice)
    },
  }
  const owner = voiceOwner
  if (owner) {
    let byTrack = trackVoices.get(graph)
    if (!byTrack) trackVoices.set(graph, byTrack = new Map())
    let owned = byTrack.get(owner.trackId)
    if (!owned) byTrack.set(owner.trackId, owned = new Map())
    owned.set(voice, { onset: owner.onset, audio: owner.audio })
  }
  for (const source of sources) {
    source.onended = () => {
      ended += 1
      if (ended === sources.length) voice.disconnect()
    }
  }
  graph.voices.add(voice)
  return voice
}

function adsr(parameter: AudioParam, when: number, duration: number, peak: number, attack: number, decay: number, sustain: number, release: number): number {
  const attackEnd = when + Math.min(attack, duration * 0.3)
  const decayEnd = Math.min(attackEnd + decay, when + duration * 0.85)
  const sustainLevel = Math.max(0.00001, peak * sustain)
  parameter.setValueAtTime(0, when)
  parameter.linearRampToValueAtTime(peak, attackEnd)
  parameter.exponentialRampToValueAtTime(sustainLevel, decayEnd)
  parameter.setValueAtTime(sustainLevel, when + duration)
  parameter.exponentialRampToValueAtTime(0.00001, when + duration + release)
  parameter.linearRampToValueAtTime(0, when + duration + release + 0.003)
  return when + duration + release + 0.005
}

export function scheduleInstrument(
  graph: EngineGraph,
  destination: AudioNode,
  instrument: InstrumentId,
  pitch: number,
  when: number,
  duration: number,
  velocity: number,
  availableSeconds: number,
  params?: Record<string, number>,
  pitchBus?: AudioNode,
): Voice | undefined {
  if (velocity <= 0 || duration <= 0 || availableSeconds <= 0) return
  // Native instruments are rendered by their host; never use the browser's keys fallback.
  if (instrumentDef(instrument).kind === 'native') return
  // Vintage instruments: the Rust core in a worklet (silent while garak-dsp.wasm is unavailable).
  if (isVintageInstrument(instrument)) return scheduleVintage(graph, destination, instrument, pitch, when, duration, clamp(velocity, 0, 1), params, base => adoptVoice(graph, base))
  const context = graph.context
  const strength = clamp(velocity, 0, 2)
  const p = (id: string): number => paramValue(instrumentDef(instrument).params, params, id)
  const level = clamp(p('level'), 0, 2)
  const envelope = context.createGain()
  envelope.connect(destination)
  const nodes: AudioNode[] = [envelope]
  const sources: SourceNode[] = []
  let end: number
  const oscillator = (type: OscillatorType, frequency: number, gain: number, target: AudioNode = envelope, detune = 0): OscillatorNode => {
    const source = context.createOscillator()
    source.type = type
    source.frequency.setValueAtTime(Math.min(frequency, context.sampleRate * 0.45), when)
    source.detune.setValueAtTime(detune, when)
    const amplitude = context.createGain()
    amplitude.gain.value = gain
    source.connect(amplitude).connect(target)
    sources.push(source)
    nodes.push(source, amplitude)
    return source
  }
  const toneScale = instrument === 'drums' ? 2 ** (clamp(p('tone'), -4, 4) * 1.5) : 1
  const noise = (frequency: number, target: AudioNode = envelope): void => {
    const source = context.createBufferSource()
    source.buffer = noiseBuffer(context)
    source.loop = true
    const filter = context.createBiquadFilter()
    filter.type = 'highpass'
    filter.frequency.value = Math.min(frequency * toneScale, context.sampleRate * 0.5 * 0.95)
    source.connect(filter).connect(target)
    sources.push(source)
    nodes.push(source, filter)
  }
  if (instrument === 'drums') {
    const drum = Math.round(pitch)
    const tune = 2 ** (clamp(p('tune'), -48, 48) / 12)
    let decay: number
    let peak: number
    if (drum === 35 || drum === 36) {
      decay = 0.32
      peak = 0.8 * strength
      const punch = clamp(p('punch'), 0, 8)
      const kick = oscillator('sine', 47 * tune + (145 - 47) * tune * punch, 1)
      kick.frequency.exponentialRampToValueAtTime(Math.min(47 * tune, context.sampleRate * 0.45), when + 0.12)
    } else if (drum === 38 || drum === 40 || drum === 39) {
      decay = drum === 39 ? 0.12 : 0.18
      peak = 0.32 * strength
      noise(900)
      oscillator('triangle', 185 * tune, 0.25)
    } else if (drum === 42 || drum === 44 || drum === 46 || drum === 49 || drum === 51) {
      decay = drum === 46 ? 0.32 : drum === 49 || drum === 51 ? 0.62 : 0.065
      peak = (drum === 42 || drum === 44 ? 0.18 : 0.16) * strength
      noise(6500)
    } else {
      decay = 0.23
      peak = 0.5 * strength
      const frequency = 440 * Math.pow(2, (clamp(pitch, 24, 84) - 69) / 12) * tune
      const tom = oscillator('sine', frequency * 1.8, 1)
      tom.frequency.exponentialRampToValueAtTime(Math.min(frequency, context.sampleRate * 0.45), when + 0.1)
    }
    decay *= clamp(p('decay'), 0.05, 10)
    peak *= level
    const audibleDuration = Math.max(0.008, Math.min(decay, availableSeconds))
    envelope.gain.setValueAtTime(0, when)
    envelope.gain.linearRampToValueAtTime(peak, when + Math.min(0.002, audibleDuration / 4))
    envelope.gain.exponentialRampToValueAtTime(0.00001, when + audibleDuration)
    envelope.gain.linearRampToValueAtTime(0, when + audibleDuration + 0.002)
    end = when + audibleDuration + 0.004
  } else {
    const frequency = 440 * Math.pow(2, (clamp(pitch, 0, 127) - 69) / 12)
    const noteDuration = Math.max(0.008, Math.min(duration, availableSeconds))
    const filter = context.createBiquadFilter()
    filter.type = 'lowpass'
    filter.Q.value = 0.7
    filter.connect(envelope)
    nodes.push(filter)
    const toneFactor = 2 ** (clamp(p('tone'), -4, 4) * 2)
    const cutoff = (value: number): number => clamp(value * toneFactor, 20, context.sampleRate * 0.45)
    const shape = (peak: number): number => adsr(
      envelope.gain, when, noteDuration, peak * level,
      clamp(p('attack'), 0.0005, 10), clamp(p('decay'), 0.001, 10), clamp(p('sustain'), 0, 1), clamp(p('release'), 0.005, 30),
    )
    switch (instrument) {
      case 'bass':
        filter.frequency.value = cutoff(700 + strength * 1700)
        oscillator('sawtooth', frequency, 0.45, filter)
        oscillator('sine', frequency, clamp(p('sub'), 0, 1), filter)
        end = shape(0.32 * strength)
        break
      case 'pad': {
        const detune = clamp(p('detune'), 0, 1200)
        filter.frequency.value = cutoff(2600)
        oscillator('sawtooth', frequency, 0.27, filter, -detune)
        oscillator('sawtooth', frequency, 0.27, filter, detune)
        oscillator('triangle', frequency * 2, 0.2, filter)
        end = shape(0.25 * strength)
        break
      }
      case 'pluck':
        filter.frequency.setValueAtTime(cutoff(4800), when)
        filter.frequency.exponentialRampToValueAtTime(cutoff(900), when + Math.max(0.03, Math.min(noteDuration, p('sweep'))))
        oscillator('triangle', frequency, 0.85, filter)
        oscillator('sine', frequency * 2, 0.2, filter)
        end = shape(0.35 * strength)
        break
      case 'rhodes': {
        // 1:1 FM tine piano: the modulation index gives the "bark" and settles fast; a short
        // high partial is the hammer strike. Both scale with velocity, decay shortens with pitch.
        const hit = Math.min(1, strength)
        const bark = clamp(p('bark'), 0, 1)
        const index = (0.3 + 2.4 * bark) * (0.35 + 0.65 * hit) * 2 ** (clamp(p('tone'), -1, 1) * 1.2)
        filter.frequency.value = cutoff(9000)
        const shaper = context.createWaveShaper()
        shaper.curve = tineShaperCurve()
        shaper.connect(filter)
        nodes.push(shaper)
        const carrier = oscillator('sine', frequency, 0.75, shaper)
        const modulator = context.createOscillator()
        modulator.frequency.setValueAtTime(Math.min(frequency, context.sampleRate * 0.45), when)
        const modGain = context.createGain()
        const depth = frequency * index
        modGain.gain.setValueAtTime(depth, when)
        modGain.gain.setTargetAtTime(depth * 0.1, when + 0.012, 0.13)
        modulator.connect(modGain).connect(carrier.frequency)
        sources.push(modulator)
        nodes.push(modulator, modGain)
        const tine = context.createOscillator()
        tine.frequency.setValueAtTime(Math.min(frequency * 7, context.sampleRate * 0.45), when)
        const tineGain = context.createGain()
        tineGain.gain.setValueAtTime(0.12 * hit * (0.3 + bark), when)
        tineGain.gain.setTargetAtTime(0, when + 0.006, 0.03)
        tine.connect(tineGain).connect(shaper)
        sources.push(tine)
        nodes.push(tine, tineGain)
        const peak = (0.28 + 0.1 * hit) * strength * level
        const attack = Math.min(clamp(p('attack'), 0.0005, 10), noteDuration)
        const decay = clamp(p('decay'), 0.05, 20) * 2 ** (-(clamp(pitch, 0, 127) - 60) / 24)
        const sustain = Math.max(0.00001, clamp(p('sustain'), 0, 1) * peak)
        const release = clamp(p('release'), 0.005, 30)
        envelope.gain.setValueAtTime(0, when)
        envelope.gain.linearRampToValueAtTime(peak, when + attack)
        envelope.gain.setTargetAtTime(peak * 0.45, when + attack, decay * 0.1)
        envelope.gain.setTargetAtTime(sustain, when + attack + decay * 0.25, decay / 3)
        envelope.gain.setTargetAtTime(0, when + noteDuration, release / 4)
        const silent = sustain < 0.0001 ? attack + decay * 2.5 : Infinity
        end = when + Math.min(noteDuration, silent) + release * 1.5 + 0.02
        break
      }
      default: {
        const bell = clamp(p('bell'), 0, 1)
        filter.frequency.value = cutoff(6800)
        oscillator('sine', frequency, 0.8, filter)
        oscillator('triangle', frequency * 2, bell, filter)
        oscillator('sine', frequency * 3, bell * 0.4, filter)
        end = shape(0.35 * strength)
      }
    }
  }
  const voice = registerVoice(graph, sources, nodes, envelope, instrument === 'drums' ? undefined : pitchBus)
  for (const source of sources) { source.start(when); source.stop(end) }
  return voice
}

/** Plays one zone of a loaded sample set. Layers already carry dynamics, so velocity only trims. */
export function scheduleSampled(
  graph: EngineGraph,
  destination: AudioNode,
  loaded: LoadedSet,
  isKit: boolean,
  pitch: number,
  when: number,
  duration: number,
  velocity: number,
  availableSeconds: number,
  params?: Record<string, number>,
  chokes?: ChokeMap,
  pitchBus?: AudioNode,
): Voice | undefined {
  if (velocity <= 0 || duration <= 0 || availableSeconds <= 0) return
  const { set, startOffset } = loaded
  const zone = pickZone(set, pitch, clamp(velocity, 0, 1))
  const buffer = zone && loaded.buffers.get(zone.file)
  if (!zone || !buffer) return
  const context = graph.context
  // SAMPLED_PIANO_PARAMS is a superset of SAMPLED_PARAMS; releaseNoise only matters for sets with releaseZones.
  const p = (id: string): number => paramValue(isKit ? SAMPLED_KIT_PARAMS : SAMPLED_PIANO_PARAMS, params, id)
  const strength = clamp(velocity, 0, 2)
  const level = clamp(p('level'), 0, 2)
  const gain = dbToGain(set.gainDb + (zone.gainDb ?? 0) + SAMPLE_TRIM_DB) * (0.25 + 0.75 * strength) * level
  if (gain <= 0.00001) return
  const rate = 2 ** ((isKit ? 0 : clamp(pitch, 0, 127) - zone.root) / 12 + (zone.tune ?? 0) / 1200 + (isKit ? clamp(p('tune'), -48, 48) / 12 : 0))
  const source = context.createBufferSource()
  source.buffer = buffer
  source.playbackRate.value = rate
  const tone = clamp(p('tone'), -1, 1)
  const filter = context.createBiquadFilter()
  if (tone < 0) {
    filter.type = 'lowpass'
    filter.Q.value = 0.5
    filter.frequency.value = clamp(20000 * 2 ** (tone * 3), 20, context.sampleRate * 0.45)
  } else {
    filter.type = 'highshelf'
    filter.frequency.value = Math.min(2500, context.sampleRate * 0.45)
    filter.gain.value = tone * 6
  }
  const envelope = context.createGain()
  source.connect(filter).connect(envelope).connect(destination)
  const nodes: AudioNode[] = [source, filter, envelope]
  const natural = Math.max(0.01, (buffer.duration - startOffset) / rate)
  let end: number
  if (isKit) {
    const decay = clamp(p('decay'), 0.05, 1)
    envelope.gain.setValueAtTime(gain, when)
    if (decay < 1) {
      const fade = Math.max(0.02, decay * natural)
      envelope.gain.exponentialRampToValueAtTime(0.00001, when + fade)
      envelope.gain.linearRampToValueAtTime(0, when + fade + 0.002)
      end = when + fade + 0.004
    } else end = when + natural + 0.01
  } else {
    const noteDuration = Math.max(0.008, Math.min(duration, availableSeconds))
    const attack = Math.min(clamp(p('attack'), 0.0005, 10), noteDuration)
    const release = clamp(p('release'), 0.005, 30)
    envelope.gain.setValueAtTime(0, when)
    envelope.gain.linearRampToValueAtTime(gain, when + attack)
    envelope.gain.setValueAtTime(gain, when + noteDuration)
    envelope.gain.setTargetAtTime(0, when + noteDuration, release / 4)
    end = when + noteDuration + release * 1.5 + 0.02
    if (zone.loop) {
      source.loop = true
      source.loopStart = zone.loop[0] + startOffset
      source.loopEnd = zone.loop[1] + startOffset
    } else end = Math.min(end, when + natural + 0.01)
    // A note that runs into its clip end, the loop boundary or the project end is cut off, not released.
    const cut = duration >= availableSeconds - 1e-6
    const noiseLevel = set.releaseZones.length ? releaseNoiseGain(velocity, noteDuration, natural, p('releaseNoise'), cut) : 0
    const releaseZone = noiseLevel > 0 ? pickZone(set, pitch, clamp(velocity, 0, 1), set.releaseZones) : undefined
    const releaseBuffer = releaseZone && loaded.buffers.get(releaseZone.file)
    if (releaseZone && releaseBuffer) {
      const noise = context.createBufferSource()
      noise.buffer = releaseBuffer
      noise.playbackRate.value = 2 ** ((clamp(pitch, 0, 127) - releaseZone.root) / 12 + (releaseZone.tune ?? 0) / 1200)
      const noiseGain = context.createGain()
      noiseGain.gain.value = dbToGain(set.gainDb + (releaseZone.gainDb ?? 0) + SAMPLE_TRIM_DB) * noiseLevel * level
      noise.connect(noiseGain).connect(destination)
      registerVoice(graph, [noise], [noise, noiseGain], noiseGain)
      noise.start(when + noteDuration, startOffset)
    }
  }
  const voice = registerVoice(graph, [source], nodes, envelope, isKit ? undefined : pitchBus)
  source.start(when, startOffset)
  source.stop(end)
  if (isKit && chokes && zone.choke !== undefined) {
    const previous = chokes.get(zone.choke)
    if (previous && previous.when <= when) previous.voice.stop(when)
    chokes.set(zone.choke, { voice, when })
  }
  return voice
}

/** localSeconds is the position inside the clip content; maxSeconds caps playback at the window or range end;
 * regionSeconds is the occurrence's real duration through the tempo map. */
function scheduleAudioClip(graph: EngineGraph, destination: AudioNode, clip: AudioClip, asset: AudioAsset, localSeconds: number, when: number, maxSeconds: number, regionSeconds: number): void {
  const context = graph.context
  const offset = Math.max(0, clip.offsetSeconds) + localSeconds
  const clipDuration = Math.min(regionSeconds, asset.buffer.duration - Math.max(0, clip.offsetSeconds))
  const duration = Math.min(clipDuration - localSeconds, maxSeconds)
  if (duration <= 0.001 || offset >= asset.buffer.duration) return
  const source = context.createBufferSource()
  source.buffer = asset.buffer
  const envelope = context.createGain()
  const gain = clamp(clip.gain, 0, AUDIO_CLIP_GAIN_MAX)
  const [fadeIn, fadeOut] = fadeLengths(clipDuration, clip.fadeIn, clip.fadeOut)
  const levelAt = (position: number): number => gain * envelopeAt(position, clipDuration, fadeIn, fadeOut, clip.fadeInCurve, clip.fadeOutCurve)
  const endLocal = localSeconds + duration
  const clickFade = Math.min(0.004, duration / 4)
  envelope.gain.setValueAtTime(0, when)
  envelope.gain.linearRampToValueAtTime(levelAt(localSeconds + clickFade), when + clickFade)
  // Curved fades become short linear segments, so overlapping automation events can never throw.
  const points = envelopeBreakpoints(clipDuration, fadeIn, fadeOut, clip.fadeInCurve, clip.fadeOutCurve).filter(point => point > localSeconds + clickFade && point < endLocal - clickFade)
  for (const point of points) {
    envelope.gain.linearRampToValueAtTime(levelAt(point), when + point - localSeconds)
  }
  envelope.gain.linearRampToValueAtTime(levelAt(endLocal - clickFade), when + duration - clickFade)
  envelope.gain.linearRampToValueAtTime(0, when + duration)
  source.connect(envelope).connect(destination)
  registerVoice(graph, [source], [source, envelope], envelope)
  source.start(when, offset, duration)
  source.stop(when + duration + 0.002)
}

/** Schedule onsets only once per half-open range; chase sustains when seeking/looping. */
export function scheduleRange(
  graph: EngineGraph,
  project: Project,
  assets: Map<string, AudioAsset>,
  startBeat: number,
  endBeat: number,
  startTime: number,
  boundary: number,
  chase: boolean,
  realtime: boolean,
  library?: SampleLibrary,
  /** Only these tracks (an edit while playing); the value says whether sustained notes are chased as well. */
  only?: ReadonlyMap<string, boolean>,
): void {
  try { scheduleTracks(graph, project, assets, startBeat, endBeat, startTime, boundary, chase, realtime, library, only) }
  finally { voiceOwner = null }
}

function scheduleTracks(
  graph: EngineGraph, project: Project, assets: Map<string, AudioAsset>, startBeat: number, endBeat: number, startTime: number,
  boundary: number, chase: boolean, realtime: boolean, library: SampleLibrary | undefined, only: ReadonlyMap<string, boolean> | undefined,
): void {
  // Every beat→time conversion goes through the tempo map (docs/TEMPO_MAP.md).
  const tempo = tempoMapOf(project)
  const startSeconds = tempo.secondsAt(startBeat)
  const seconds = (from: number, to: number): number => tempo.secondsBetween(from, to)
  const epsilon = 0.0000001
  const adjustStart = (beat: number): [number, number] => {
    let time = startTime + tempo.secondsAt(beat) - startSeconds
    if (realtime && time < graph.context.currentTime) {
      const nextTime = graph.context.currentTime + 0.002
      beat = tempo.beatAfter(beat, nextTime - time)
      time = nextTime
    }
    return [beat, time]
  }
  const startsInRange = (beat: number): boolean => beat >= startBeat - epsilon && beat < endBeat - epsilon
  for (const track of project.tracks) {
    if (only && !only.has(track.id)) continue
    const chaseNotes = chase && (!only || only.get(track.id) === true)
    const channel = graph.tracks.get(track.id)
    if (!channel || !isTrackEnabled(track)) continue
    const def = instrumentDef(track.instrument)
    let loaded: LoadedSet | undefined
    if (track.kind === 'instrument' && def.kind === 'sampled' && def.set) {
      loaded = library?.get(def.set)
      // Not ready yet: start loading and let the engine reschedule once the set arrives.
      if (!loaded) {
        if (library && library.status(def.set) === 'idle') library.load(def.set, graph.context).catch(() => undefined)
        continue
      }
    }
    const events = trackEvents(track, project.lengthBeats, tempo)
    for (const window of events.windows) {
      const windowEnd = Math.min(window.end, boundary, project.lengthBeats)
      if (windowEnd <= startBeat || window.start >= endBeat) continue
      if (!startsInRange(window.start) && !(chase && window.start < startBeat && windowEnd > startBeat)) continue
      const asset = assets.get(window.clip.assetId)
      if (!asset) continue
      const [beat, time] = adjustStart(Math.max(window.start, startBeat))
      if (beat >= windowEnd) continue
      // Audio plays at 1×: its source position is the real time since the occurrence started.
      const origin = window.start - window.sourceOffsetBeats
      voiceOwner = { trackId: track.id, onset: time, audio: true }
      scheduleAudioClip(graph, channel.input, window.clip, asset, seconds(origin, beat), time, seconds(beat, windowEnd), seconds(origin, origin + window.clip.lengthBeats))
    }
    const controls = channel.controls
    const voiceInput = controls?.input ?? channel.input
    const pitchBus = def.isKit ? undefined : controls?.pitch
    if (controls && events.controls.length) {
      if (chase) chaseControls(controls, events.controls, startBeat, adjustStart(startBeat)[1])
      for (const event of events.controls) {
        if (event.beat >= endBeat - epsilon) break
        if (event.beat < startBeat - epsilon || (chase && event.beat <= startBeat + epsilon)) continue
        applyControl(controls, event.key, event.value, adjustStart(event.beat)[1], event.range)
      }
    }
    for (const note of events.notes) {
      const noteEnd = Math.min(note.end, boundary, project.lengthBeats)
      if (noteEnd <= startBeat || note.start >= endBeat) continue
      if (!startsInRange(note.start) && !(chaseNotes && !def.isKit && note.start < startBeat && noteEnd > startBeat)) continue
      const [beat, time] = adjustStart(Math.max(note.start, startBeat))
      if (beat >= noteEnd) continue
      const available = seconds(beat, Math.min(note.limit, boundary, project.lengthBeats))
      // Instrument parameter automation is read at each note onset, as the native engine does.
      const params = track.automation ? trackAt(track, beat).instrumentParams : track.instrumentParams
      voiceOwner = { trackId: track.id, onset: time, audio: false }
      if (loaded) {
        scheduleSampled(graph, voiceInput, loaded, def.isKit, note.pitch, time, seconds(beat, noteEnd), note.velocity, available, params, channel.chokes, pitchBus)
      } else {
        scheduleInstrument(graph, voiceInput, track.instrument, note.pitch, time, seconds(beat, noteEnd), note.velocity, available, params, pitchBus)
      }
    }
  }
}

interface TrackEvents {
  projectEnd: number
  tempo: TempoMap
  notes: PlaybackNote[]
  controls: PlaybackController[]
  windows: AudioWindow[]
}

// Track objects are immutable snapshots, so the expanded events can be reused across scheduler ticks.
const eventCache = new WeakMap<Track, TrackEvents>()

function trackEvents(track: Track, projectEnd: number, tempo: TempoMap): TrackEvents {
  const cached = eventCache.get(track)
  if (cached && cached.projectEnd === projectEnd && cached.tempo === tempo) return cached
  const events: TrackEvents = { projectEnd, tempo, notes: midiEvents(track, projectEnd), controls: track.kind === 'instrument' ? midiControllerEvents(track, projectEnd) : [], windows: audioWindows(track, projectEnd, tempo) }
  eventCache.set(track, events)
  return events
}

export function rmsLevel(meter: AnalyserNode, values: Float32Array<ArrayBuffer>): number {
  meter.getFloatTimeDomainData(values)
  let total = 0
  for (const value of values) total += value * value
  return Math.min(1, Math.sqrt(total / values.length))
}

export function trackLayoutKey(tracks: readonly Track[]): string {
  // Track enable changes may switch the master even while transport is stopped.
  // Mute, solo and solo-safe remain fader changes and do not alter master voicing.
  const master = usesGuitarRigMaster(tracks) ? 'guitar-rig' : 'legacy'
  return master + ':' + tracks.map(track => {
    const route = routeOf(track)
    // Internal inputs are graph connections: a route or tap change rebuilds the graph.
    const routed = route ? '<' + (route.kind === 'track' ? `${route.trackId}@${route.tap}` : route.kind) : ''
    return track.id + routed + sendLayoutKey(track) + '[' + track.devices.filter(device => device.enabled).map(device => device.type + ':' + device.id).join(',') + ']'
  }).join('|')
}

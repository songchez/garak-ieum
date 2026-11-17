import { DEFAULT_AUDIO_SETTINGS, projectSampleRate, type AudioSettings } from '../../core/audioSettings'
import { playbackProject } from '../../core/freeze'
import { instrumentDef } from '../../core/instruments'
import { countInBeats, type MetronomeEngineState, type PlayOptions } from '../../core/metronome'
import { meterMapOf } from '../../core/meterMap'
import { isTrackEnabled, trackNote } from '../../core/playback'
import type { AudioAsset, ControllerKey, InstrumentId, Project, RenderOptions, RenderedAudio, TransportSnapshot } from '../../core/types'
import { createEmptyProject } from '../../core/project'
import { tempoMapOf } from '../../core/tempoMap'
import type { TakeCallbacks } from '../../core/recording'
import { webDynamicsReading, type DynamicsReading } from '../../devices/effects/dynamicsMeter'
import { RouteRecordings, type RouteRecordingHost } from '../RouteRecording'
import { createGraph, disposeGraph, scheduleInstrument, scheduleSampled, trackTailSeconds, type EngineGraph } from '../graph'
import type { LiveVoiceHandle } from '../liveMidi'
import { clamp, loopRange, normalizedStart } from '../math'
import { metronomeStrokes } from '../metronomeSounds'
import { packAudioBuffer } from '../native/pcmTransfer'
import { compileNativeTimeline, NativeTimelineCompiler, type NativePcmAsset, type NativeProjectTimeline } from '../native/timeline'
import { encodeTracks, planNativeSync, type SyncTimeline } from '../native/timelineSync'
import { encodeWav } from '../wavEncode'
import { WebAudioEngine } from '../WebAudioEngine'
import { emptyStatus, TAP_CHANNELS, type EngineMeters, type EngineStatus } from './engineChannel'
import { KernelHelper, renderInEngineWorker, RustEngineNode, sharedGarakEngineModule } from './engineHost'
import type { EngineRenderAsset } from './engineOffline'
import { GarakEngineError, utf8Encode } from './garakEngineWasm'

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
/** Library previews (no track) while the engine plays: this long, like the Web Audio engine's. */
const PREVIEW_SECONDS = 0.3

/** What the page is doing with the Rust engine (tests, the smoke script and bug reports). */
export interface RustEngineDiagnostics {
  /** The worklet node exists on the current audio context. */
  running: boolean
  /** Status and transport use a SharedArrayBuffer (cross-origin isolated page). */
  sharedChannel: boolean
  /** The engine accepted the current project; otherwise `reason` says why it plays on Web Audio. */
  accepted: boolean
  reason: string
  /** Which renderer the transport is playing on right now. */
  playing: 'rust' | 'web-audio' | null
  status: EngineStatus
  /** The last offline render (export/bounce/freeze/stems). */
  lastRender: { engine: 'rust' | 'web-audio'; renderMs?: number; frames: number; reason?: string; preMaster?: boolean } | null
  /** Tracks the engine monitors (graph indices) and route taps being recorded. */
  monitoring: number[]
  taps: number[]
  /** Reverb kernels the helper worker computed for the worklet. */
  kernels: number
}

/** PCM referenced by a playback project's audio clips and frozen renders. */
function referencedAssets(project: Project): Set<string> {
  return new Set(project.tracks.flatMap(track => [...track.clips.flatMap(clip => clip.kind === 'audio' ? [clip.assetId] : []), ...(track.render?.frozen ? [track.render.frozen.assetId] : [])]))
}

const pcmMetadata = (id: string, buffer: AudioBuffer): NativePcmAsset => ({ id, sampleRate: buffer.sampleRate, frames: buffer.length, channels: buffer.numberOfChannels })

/** Reverb insert parameter maps of a timeline (enabled tracks and inserts), keyed for the kernel cache. */
function reverbParams(timeline: NativeProjectTimeline): Map<string, Record<string, number>> {
  const found = new Map<string, Record<string, number>>()
  for (const track of timeline.tracks) {
    if (!track.enabled) continue
    for (const insert of track.inserts) {
      if (!insert.enabled || insert.type !== 'reverb') continue
      const params = (insert as { params: Readonly<Record<string, number>> }).params
      const picked: Record<string, number> = {}
      for (const key of ['type', 'size']) if (typeof params[key] === 'number') picked[key] = params[key]
      found.set(JSON.stringify(picked), picked)
    }
  }
  return found
}

/** The graph order of an applied timeline: track ids and each track's insert ids (meters map through it). */
interface GraphOrder { ids: string[]; inserts: string[][] }

/**
 * The web app on the unified Rust render engine (docs/RUST_ENGINE.md 5), behind `rustEngineRequested()`.
 *
 * Everything that makes a project sound — clips, effect chains, sends/returns, automation, tempo map,
 * master, metronome and count-in — renders in one AudioWorklet running garak-engine.wasm, fed by the same
 * render-diff protocol the desktop host receives (NativeTimelineCompiler + planNativeSync: project.set,
 * then project.patch per edit). Export, bounce, freeze and stems (pre-master included) render the same
 * engine in a Worker. Track and dynamics meters, input monitoring, track-input route monitoring and route
 * recording taps, and live notes all go through the engine while it plays (docs/RUST_ENGINE.md 5.7).
 *
 * It is a WebAudioEngine: device setup, decoding, sample libraries and MediaStream capture stay there,
 * and any project the engine refuses (it says why: instrument tracks until they are ported, the guitar
 * rig, ...) plays and exports on the Web Audio graph with a console note. The engine is asked again
 * after every edit, so newly supported features switch over on their own. While the engine plays, no
 * Web Audio graph is kept (it is rebuilt on pause/stop for previews and a fallback).
 */
export class RustWebAudioEngine extends WebAudioEngine {
  private bridge: RustEngineNode | null = null
  private kernels: KernelHelper | null = null
  private readonly kernelKeys = new Set<string>()
  private kernelCount = 0
  private readonly compiler = new NativeTimelineCompiler()
  /** The last timeline the engine accepted on this bridge (patches are planned against it). */
  private synced: SyncTimeline | null = null
  private readonly orders = new Map<number, GraphOrder>()
  private timelineRevision = 0
  private projectRevision = 0
  private syncedRevision = -1
  private syncTask: Promise<void> | null = null
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private verdict = { accepted: false, reason: '아직 Rust 엔진에 프로젝트를 보내지 않았습니다.' }
  private uploaded = new Map<string, WeakRef<AudioBuffer>>()
  private rustPlaying = false
  /** Sequence number of the last play/seek command; status before it is stale. */
  private transportSeq = 0
  private playRequest = 0
  private status: EngineStatus = emptyStatus()
  private peak = 0
  private forceWebAudio = false
  private readonly notes = new Set<string>()
  private lastRender: RustEngineDiagnostics['lastRender'] = null
  private metronomeState: MetronomeEngineState | null = null
  private metronomeSent = ''
  private readonly dynamics = new Map<string, DynamicsReading>()
  /** Input monitoring (stream + tracks) and route monitoring, as the app last asked for them. */
  private liveStream: MediaStream | null = null
  private monitorTracks: string[] = []
  private routeMonitorTracks: string[] = []
  private liveSource: MediaStreamAudioSourceNode | null = null
  private monitored: number[] = []
  private monitoringKey = ''
  /** Route recording taps: graph index per slot, and the splitter on the worklet's tap output. */
  private tapSlots: (string | null)[] = []
  private tapIndices: number[] = []
  private tapSplitter: ChannelSplitterNode | null = null
  private previewGraph: EngineGraph | null = null
  private liveNoteId = 0

  constructor(project?: Project, settings: AudioSettings = DEFAULT_AUDIO_SETTINGS) {
    // The base constructor would call setProject before this class's fields exist.
    super(undefined, settings)
    if (project) this.setProject(project)
  }

  diagnostics(): RustEngineDiagnostics {
    if (this.bridge) this.poll()
    return {
      running: !!this.bridge && this.bridge.context === this.context && !this.bridge.error,
      sharedChannel: !!this.bridge?.sharedChannel,
      accepted: this.verdict.accepted, reason: this.verdict.reason,
      playing: this.rustPlaying ? 'rust' : this.playing ? 'web-audio' : null,
      status: { ...this.status }, lastRender: this.lastRender,
      monitoring: [...this.monitored], taps: this.tapIndices.filter(index => index >= 0), kernels: this.kernelCount,
    }
  }

  private note(text: string): void {
    if (this.notes.has(text)) return
    this.notes.add(text)
    console.info(`[가락이음] Rust 엔진: ${text}`)
  }

  /** The engine renders the current project now (else the Web Audio graph does). */
  private rustActive(): boolean {
    return !!this.bridge && !this.bridge.error && this.bridge.context === this.context && this.verdict.accepted && !this.forceWebAudio
  }

  /** The engine is what the listener hears: it plays, or it monitors tracks (stopped). */
  private engineOwnsOutput(): boolean {
    return this.rustPlaying || (this.rustActive() && this.monitored.length > 0)
  }

  /** The Web Audio graph exists only while the engine is not what is heard (a stopped project's previews and a fallback). */
  protected override graphEnabled(): boolean { return this.playing || !this.engineOwnsOutput() }

  protected override async prepareContext(context: AudioContext): Promise<void> {
    const module = await sharedGarakEngineModule()
    if (!module) { this.note('garak-engine.wasm이 없어 Web Audio 엔진을 씁니다 (pnpm rust:wasm으로 빌드).'); return }
    try {
      const bridge = await RustEngineNode.create(context, module)
      this.bridge?.dispose()
      this.disposeTaps()
      this.liveSource?.disconnect()
      this.liveSource = null
      this.bridge = bridge
      if (this.kernels?.sampleRate !== context.sampleRate) { this.kernels?.dispose(); this.kernels = new KernelHelper(module, context.sampleRate) }
      this.kernelKeys.clear()
      this.synced = null
      this.orders.clear()
      this.uploaded.clear()
      this.syncedRevision = -1
      this.metronomeSent = ''
      this.monitoringKey = ''
      this.monitored = []
      this.status = emptyStatus()
      this.verdict = { accepted: false, reason: '아직 Rust 엔진에 프로젝트를 보내지 않았습니다.' }
      this.pushMetronome()
      this.scheduleSync()
    } catch (error) {
      this.note(`워크릿을 시작하지 못해 Web Audio 엔진을 씁니다: ${message(error)}`)
    }
  }

  override setProject(source: Project): void {
    super.setProject(source)
    this.projectRevision += 1
    this.scheduleSync()
  }

  override setAssets(assets: Map<string, AudioAsset>): void {
    super.setAssets(assets)
    this.projectRevision += 1
    this.scheduleSync()
  }

  private scheduleSync(): void {
    if (!this.bridge || this.syncTimer !== null) return
    // Coalesces a burst of edits (a fader drag) into one patch, like the native engine.
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null
      void this.syncNow().catch(error => this.note(`프로젝트 동기화 실패: ${message(error)}`))
    }, 16)
  }

  private syncNow(): Promise<void> {
    if (this.syncTask) return this.syncTask
    const task = (async () => {
      while (this.bridge && this.project && this.syncedRevision !== this.projectRevision) {
        const bridge = this.bridge, revision = this.projectRevision
        await this.syncOnce(bridge, this.project)
        if (bridge !== this.bridge) return
        this.syncedRevision = revision
      }
    })()
    this.syncTask = task
    void task.finally(() => { if (this.syncTask === task) this.syncTask = null }).catch(() => undefined)
    return task
  }

  private async syncOnce(bridge: RustEngineNode, project: Project): Promise<void> {
    const reject = (reason: string) => { this.synced = null; this.setVerdict(false, reason) }
    if (bridge.error) return reject(bridge.error)
    if (project.sampleRate !== bridge.context.sampleRate) return reject(`프로젝트 ${project.sampleRate} Hz와 오디오 장치 ${bridge.context.sampleRate} Hz가 다릅니다.`)
    const metadata = new Map<string, NativePcmAsset>()
    const referenced = referencedAssets(project)
    try {
      for (const id of referenced) {
        const asset = this.assets.get(id)
        if (!asset) return reject(`오디오 자산을 찾을 수 없습니다: ${id}`)
        if (this.uploaded.get(id)?.deref() !== asset.buffer) {
          await bridge.putAsset(id, asset.buffer)
          this.uploaded.set(id, new WeakRef(asset.buffer))
        }
        metadata.set(id, pcmMetadata(id, asset.buffer))
      }
      // PCM nothing references any more leaves the worklet (graphs still using it keep it until rebuilt).
      for (const id of [...this.uploaded.keys()]) if (!referenced.has(id)) { this.uploaded.delete(id); void bridge.removeAsset(id).catch(() => undefined) }
    } catch (error) {
      return reject(message(error))
    }
    let timeline: NativeProjectTimeline
    try { timeline = this.compiler.compile(project, metadata, ++this.timelineRevision) } catch (error) { return reject(message(error)) }
    // Reverb kernels are generated by the helper worker; the worklet only imports them.
    try {
      const fresh = [...reverbParams(timeline)].filter(([key]) => !this.kernelKeys.has(key))
      if (fresh.length && this.kernels) {
        const kernels = await this.kernels.compute(fresh.map(([, params]) => params))
        if (bridge !== this.bridge) return
        await bridge.importKernels(kernels)
        for (const [key] of fresh) this.kernelKeys.add(key)
        this.kernelCount += kernels.length
      }
    } catch (error) {
      // The worklet generates what it lacks (one long quantum): a slower edit, not a failure.
      this.note(`리버브 커널을 미리 만들지 못했습니다: ${message(error)}`)
    }
    const plan = planNativeSync(this.synced, timeline)
    try {
      await bridge.update(plan.method, plan.method === 'project.set' ? (plan.params as { timeline: unknown }).timeline : plan.params, plan.binary)
      if (bridge !== this.bridge) return
      this.synced = timeline
      this.orders.set(timeline.revision, { ids: timeline.tracks.map(track => track.id), inserts: timeline.tracks.map(track => track.inserts.map(insert => insert.id)) })
      for (const key of [...this.orders.keys()]) if (key < timeline.revision - 8) this.orders.delete(key)
      this.setVerdict(true, '')
      this.syncMonitoring()
      this.syncTaps()
    } catch (error) {
      if (bridge !== this.bridge) return
      // A refused patch leaves the engine on its previous project: the next sync sends project.set.
      reject(message(error))
    }
  }

  private setVerdict(accepted: boolean, reason: string): void {
    const changed = accepted !== this.verdict.accepted
    this.verdict = { accepted, reason }
    if (!accepted) this.note(`이 프로젝트는 Web Audio 엔진으로 재생합니다: ${reason}`)
    if (changed) this.syncMonitoring()
    if (changed && !accepted && this.rustPlaying) this.handOff(reason)
  }

  /** Graph index of a track in the engine's current graph (the last accepted timeline), or -1. */
  private trackIndex(trackId: string): number {
    return this.synced ? this.synced.tracks.findIndex(track => track.id === trackId) : -1
  }

  /** Continues the playing transport on the Web Audio graph from the heard beat. */
  private handOff(reason: string): void {
    if (!this.rustPlaying) return
    const beat = this.rustBeat()
    this.bridge?.transport('pause')
    this.rustPlaying = false
    this.position = beat
    this.note(`재생을 Web Audio 엔진으로 넘깁니다: ${reason}`)
    this.forceWebAudio = true
    this.syncMonitoring()
    this.refreshGraph()
    void super.play().catch(error => this.note(`Web Audio 엔진으로 재생하지 못했습니다: ${message(error)}`))
  }

  override async play(options: PlayOptions = {}): Promise<void> {
    if (this.rustPlaying) return
    if (!this.project || this.playing) return super.play(options)
    this.forceWebAudio = false
    const request = ++this.playRequest
    await this.resume()
    if (request !== this.playRequest) return
    if (this.bridge && this.bridge.context === this.context) await this.syncNow()
    if (request !== this.playRequest || !this.project || this.rustPlaying || this.playing) return
    if (!this.rustActive()) {
      if (this.bridge && !this.verdict.accepted) this.note(`이 프로젝트는 Web Audio 엔진으로 재생합니다: ${this.verdict.reason}`)
      this.syncMonitoring()
      this.refreshGraph()
      return super.play(options)
    }
    const bridge = this.bridge!, project = this.project, context = this.context!
    let beat = normalizedStart(project, this.position)
    if (!loopRange(project) && beat >= project.lengthBeats) beat = 0
    this.position = beat
    bridge.transport('seek', Math.round(tempoMapOf(project).frameAt(beat, project.sampleRate)))
    // A count-in is a scheduled start in the engine: it clicks at the tempo and meter where the
    // transport starts (meter-map accents, the chosen sound), then the transport starts on the next frame.
    const countIn = Math.round(countInBeats(meterMapOf(project).meterAt(beat), options.countInBars ?? 0) * 60 / tempoMapOf(project).bpmAt(beat) * context.sampleRate)
    this.transportSeq = countIn > 0 ? bridge.transport('countIn', countIn) : bridge.transport('play')
    this.rustPlaying = true
    // No idle Web Audio graph (and its effect worklets) runs next to the engine.
    this.refreshGraph()
    this.publishSnapshot()
    // Resolve on the downbeat, so a recording starts its capture with the music.
    if (countIn > 0) await this.waitForDownbeat(request)
  }

  /** Waits until the engine has applied the count-in and left it (or the play was cancelled). */
  private async waitForDownbeat(request: number): Promise<void> {
    const limit = performance.now() + 130_000
    while (this.rustPlaying && request === this.playRequest && performance.now() < limit) {
      const status = this.poll()
      if (status.appliedSeq >= this.transportSeq && !status.countingIn) return
      await new Promise(resolve => setTimeout(resolve, 4))
    }
  }

  override pause(): void {
    this.playRequest += 1
    if (!this.rustPlaying) {
      this.forceWebAudio = false
      super.pause()
      return
    }
    const beat = this.rustBeat()
    this.bridge?.transport('pause')
    this.rustPlaying = false
    super.pause()
    this.position = beat
    this.publishSnapshot()
  }

  override stop(): void {
    this.playRequest += 1
    if (this.rustPlaying) this.bridge?.transport('stop')
    this.rustPlaying = false
    this.forceWebAudio = false
    super.stop()
  }

  override seek(beat: number): void {
    if (!this.rustPlaying || !this.project || !this.bridge || !this.context) { super.seek(beat); return }
    const project = this.project
    this.position = clamp(beat, 0, project.lengthBeats)
    this.transportSeq = this.bridge.transport('seek', Math.round(tempoMapOf(project).frameAt(this.position, project.sampleRate)))
    this.publishSnapshot()
  }

  /** The engine clicks the metronome (after its master; strokes sent once per sound/rate); the Web Audio graph keeps its own. */
  override setMetronome(state: MetronomeEngineState): void {
    super.setMetronome(state)
    this.metronomeState = { ...state }
    this.pushMetronome()
  }

  private pushMetronome(): void {
    const state = this.metronomeState, bridge = this.bridge
    if (!state || !bridge) return
    const rate = bridge.context.sampleRate
    const key = `${state.sound}:${state.accent}:${rate}`
    const strokes = key === this.metronomeSent ? null : metronomeStrokes(state.sound, state.accent, rate).map(stroke => new Float32Array(stroke))
    // The count-in clicks at the metronome volume even with the metronome off (it is the cue to start).
    void bridge.metronome(state.enabled, clamp(Number.isFinite(state.volume) ? state.volume : 0, 0, 1), strokes)
      .then(() => { if (strokes) this.metronomeSent = key })
      .catch(error => this.note(`메트로놈을 설정하지 못했습니다: ${message(error)}`))
  }

  override setInputMonitor(stream: MediaStream | null, trackIds: readonly string[]): void {
    this.liveStream = stream
    this.monitorTracks = stream ? [...trackIds] : []
    if (stream) this.observeInputStream(stream)
    this.syncMonitoring()
  }

  override setRouteMonitor(trackIds: readonly string[]): void {
    this.routeMonitorTracks = [...trackIds]
    this.syncMonitoring()
  }

  /**
   * Monitoring follows the renderer of the project: the engine (its live input is the stream, its route
   * inputs the source taps) while it owns the project, else the Web Audio graph. Never both at once.
   */
  private syncMonitoring(): void {
    const engine = this.rustActive() && !!this.bridge
    const software = this.getAudioState().settings.softwareMonitoring
    const stream = this.liveStream?.active ? this.liveStream : null
    if (!engine) {
      this.liveSource?.disconnect()
      this.liveSource = null
      if (this.bridge && this.monitored.length) { this.monitored = []; void this.bridge.monitor([]).catch(() => undefined) }
      this.monitoringKey = ''
      super.setInputMonitor(this.liveStream, this.monitorTracks)
      super.setRouteMonitor(this.routeMonitorTracks)
      return
    }
    super.setInputMonitor(null, [])
    super.setRouteMonitor([])
    const bridge = this.bridge!
    if (stream && software && this.monitorTracks.length) {
      if (this.liveSource?.mediaStream !== stream || this.liveSource.context !== bridge.context) {
        this.liveSource?.disconnect()
        this.liveSource = bridge.context.createMediaStreamSource(stream)
        this.liveSource.connect(bridge.node, 0, 0)
      }
    } else if (this.liveSource) {
      this.liveSource.disconnect()
      this.liveSource = null
    }
    const live = stream && software ? this.monitorTracks : []
    const indices = [...new Set([...live, ...this.routeMonitorTracks].map(id => this.trackIndex(id)).filter(index => index >= 0))].sort((a, b) => a - b)
    const key = `${this.synced?.revision ?? 0}:${indices.join(',')}`
    if (key === this.monitoringKey) return
    this.monitoringKey = key
    this.monitored = indices
    void bridge.monitor(indices).catch(error => this.note(`모니터링을 설정하지 못했습니다: ${message(error)}`))
    // Monitoring while stopped: the engine is heard and metered, no idle Web Audio graph next to it.
    this.refreshGraph()
  }

  /**
   * Route recording while the engine owns the project: each take records its track's route input from
   * the engine's tap output (output 1, a stereo slot per take), clocked by the engine's transport.
   */
  override createRouteRecordings(trackIds: readonly string[], callbacks: TakeCallbacks): RouteRecordings {
    const bridge = this.bridge, context = this.context
    if (!this.rustActive() || !bridge || !context || trackIds.length > TAP_CHANNELS / 2) return super.createRouteRecordings(trackIds, callbacks)
    const host: RouteRecordingHost = {
      context,
      attach: (trackId, node) => {
        const slot = this.tapSlots.indexOf(null) >= 0 ? this.tapSlots.indexOf(null) : this.tapSlots.length
        if (slot >= TAP_CHANNELS / 2) throw new Error('동시에 녹음할 수 있는 트랙 입력 수를 넘었습니다.')
        this.tapSlots[slot] = trackId
        this.tapSplitter ??= (() => { const splitter = context.createChannelSplitter(TAP_CHANNELS); bridge.node.connect(splitter, 1); return splitter })()
        const merger = context.createChannelMerger(2)
        this.tapSplitter.connect(merger, 2 * slot, 0)
        this.tapSplitter.connect(merger, 2 * slot + 1, 1)
        merger.connect(node)
        this.syncTaps()
        return () => {
          try { merger.disconnect() } catch { /* Already detached. */ }
          try { this.tapSplitter?.disconnect(merger) } catch { /* Not connected. */ }
          this.tapSlots[slot] = null
          this.syncTaps()
        }
      },
      projectFrameAt: time => {
        // Linear while playing: the engine's transport frame at the end of the last published quantum.
        const status = this.poll()
        return status.frame + (time * context.sampleRate - status.contextFrame)
      },
    }
    return new RouteRecordings(host, trackIds, callbacks)
  }

  private syncTaps(): void {
    const bridge = this.bridge
    if (!bridge) return
    while (this.tapSlots.length && this.tapSlots[this.tapSlots.length - 1] === null) this.tapSlots.pop()
    const indices = this.tapSlots.map(id => id === null ? -1 : this.trackIndex(id))
    if (indices.join(',') === this.tapIndices.join(',')) return
    this.tapIndices = indices
    void bridge.taps(indices).catch(error => this.note(`트랙 입력 녹음을 설정하지 못했습니다: ${message(error)}`))
  }

  private disposeTaps(): void {
    try { this.tapSplitter?.disconnect() } catch { /* Already detached. */ }
    this.tapSplitter = null
    this.tapSlots = []
    this.tapIndices = []
  }

  /**
   * Note previews while the engine plays (there is no Web Audio graph then). A track the engine renders
   * gets the note as a live event through its chain; a library preview (or a track the engine cannot
   * play yet) sounds on a small preview-only graph straight to the output, never the project's graph.
   */
  override async previewNote(instrument: InstrumentId, pitch: number, velocity = 0.8, trackId?: string): Promise<void> {
    if (!this.engineOwnsOutput()) return super.previewNote(instrument, pitch, velocity, trackId)
    const def = instrumentDef(instrument)
    if (def.kind === 'native' || (def.kind === 'vintage' && !this.vintage.available())) return super.previewNote(instrument, pitch, velocity, trackId)
    await this.resume()
    if (def.set) await this.preloadSamples(def.set)
    const context = this.context
    if (!context || !this.engineOwnsOutput()) return
    const track = trackId === undefined ? undefined : this.project?.tracks.find(item => item.id === trackId)
    if (trackId !== undefined && (!track || track.kind !== 'instrument' || track.instrument !== instrument || !isTrackEnabled(track))) return
    const live = trackNote(track, pitch, velocity)
    if (!live) return
    const duration = instrument === 'pad' || def.kind === 'sampled' ? 0.65 : PREVIEW_SECONDS
    if (track && this.engineVoice(track.id, live.pitch, live.velocity, duration)) return
    const graph = this.previewGraphFor(context)
    const loaded = def.set ? this.samples.get(def.set) : undefined
    const params = track?.instrument === instrument ? track.instrumentParams : undefined
    if (loaded) scheduleSampled(graph, graph.previewInput, loaded, def.isKit, live.pitch, context.currentTime + 0.006, duration, live.velocity, duration + 0.8, params)
    else scheduleInstrument(graph, graph.previewInput, instrument, live.pitch, context.currentTime + 0.006, duration, live.velocity, duration + 0.8, params)
  }

  /** A note through the engine's track (live event path); false when the engine does not render that track. */
  private engineVoice(trackId: string, pitch: number, velocity: number, seconds?: number): LiveVoiceHandle | null {
    const bridge = this.bridge, index = this.trackIndex(trackId)
    const track = this.synced?.tracks[index]
    if (!bridge || !this.rustActive() || index < 0 || !track || track.source.kind === 'audio') return null
    const id = ++this.liveNoteId
    bridge.live(index, 'noteOn', pitch, clamp(velocity, 0, 1), id)
    const release = () => { bridge.live(index, 'noteOff', pitch, 0, id) }
    if (seconds !== undefined) setTimeout(release, seconds * 1000)
    return { release }
  }

  private previewGraphFor(context: AudioContext): EngineGraph {
    if (this.previewGraph?.context === context) return this.previewGraph
    if (this.previewGraph) disposeGraph(this.previewGraph)
    // An empty project: just the preview bus and a master, straight to the output.
    this.previewGraph = createGraph(context, { ...createEmptyProject(), sampleRate: context.sampleRate as Project['sampleRate'], tracks: [] })
    return this.previewGraph
  }

  /** Live MIDI and computer-keyboard notes: through the engine's track while it renders the project. */
  protected override startLiveNote(trackId: string, pitch: number, velocity: number): LiveVoiceHandle | null {
    if (this.rustActive()) {
      const track = this.project?.tracks.find(item => item.id === trackId)
      if (!track || track.kind !== 'instrument' || !isTrackEnabled(track)) return null
      const voice = this.engineVoice(trackId, pitch, velocity)
      if (voice) return voice
      if (this.engineOwnsOutput()) return null
    }
    return super.startLiveNote(trackId, pitch, velocity)
  }

  protected override liveControl(trackId: string, key: ControllerKey, value: number): void {
    const index = this.trackIndex(trackId)
    if (this.rustActive() && this.bridge && index >= 0 && key.startsWith('cc')) {
      const controller = Number(key.slice(2))
      if (Number.isInteger(controller)) { this.bridge.live(index, 'control', controller, value); if (this.engineOwnsOutput()) return }
    }
    super.liveControl(trackId, key, value)
  }

  /** MIDI recording timestamps while the engine plays: the engine's frame at that context time. */
  protected override heardBeatAt(timeMs: number): number | null {
    if (!this.rustPlaying) return super.heardBeatAt(timeMs)
    const context = this.context, project = this.project
    if (!context || !project) return null
    const stamp = typeof context.getOutputTimestamp === 'function' ? context.getOutputTimestamp() : undefined
    const latency = (context as AudioContext & { outputLatency?: number }).outputLatency ?? 0
    const contextTime = stamp && typeof stamp.contextTime === 'number' && typeof stamp.performanceTime === 'number' && stamp.performanceTime > 0
      ? stamp.contextTime + (timeMs - stamp.performanceTime) / 1000
      : context.currentTime - (performance.now() - timeMs) / 1000 - (context.baseLatency ?? 0) - latency
    const status = this.poll()
    if (status.countingIn) return null
    const frame = status.frame + (contextTime * context.sampleRate - status.contextFrame)
    return clamp(tempoMapOf(project).beatAtFrame(Math.max(0, frame), project.sampleRate), 0, project.lengthBeats)
  }

  protected override currentBeat(): number {
    return this.rustPlaying ? this.rustBeat() : super.currentBeat()
  }

  private poll(): EngineStatus {
    if (this.bridge) {
      const status = this.bridge.readStatus()
      this.peak = Math.max(this.peak, status.peak)
      this.status = status
    }
    return this.status
  }

  /** The engine's transport beat (the start beat until the last play/seek has been applied). */
  private rustBeat(): number {
    const project = this.project
    if (!project) return this.position
    const status = this.poll()
    if (status.appliedSeq < this.transportSeq) return this.position
    return clamp(tempoMapOf(project).beatAtFrame(status.frame, project.sampleRate), 0, project.lengthBeats)
  }

  protected override publishSnapshot(): void {
    if (!this.rustPlaying) { super.publishSnapshot(); return }
    const status = this.poll()
    if (status.appliedSeq >= this.transportSeq && !status.playing) {
      // The engine reached the project end (no cycle): tails ring out, the transport rests there.
      this.rustPlaying = false
      this.position = this.project?.lengthBeats ?? this.position
      super.publishSnapshot()
      return
    }
    this.publishAudioState()
    const next: TransportSnapshot = {
      playing: true,
      beat: Math.round(this.rustBeat() * 10000) / 10000,
      ready: this.context?.state === 'running',
      sampleRate: this.context?.sampleRate ?? 0,
    }
    if (next.beat === this.snapshot.beat && this.snapshot.playing && next.ready === this.snapshot.ready && next.sampleRate === this.snapshot.sampleRate) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }

  /** Track and dynamics meters from the engine (peaks per graph track, readings per insert). */
  protected override readIdleMeters(): void {
    if (!this.bridge || !this.rustActive()) { super.readIdleMeters(); this.dynamics.clear(); return }
    this.poll()
    this.masterLevel = Math.max(this.peak, this.masterLevel * 0.7)
    this.peak = 0
    const meters = this.bridge.readMeters()
    if (meters) this.applyMeters(meters)
    else for (const [id, level] of this.levels) this.levels.set(id, level * 0.7)
  }

  private applyMeters(meters: EngineMeters): void {
    const order = this.orders.get(meters.revision)
    if (!order) return
    const seen = new Set<string>()
    meters.peaks.forEach((peak, index) => {
      const id = order.ids[index]
      if (id === undefined) return
      seen.add(id)
      this.levels.set(id, Math.max(peak, (this.levels.get(id) ?? 0) * 0.7))
    })
    for (const id of [...this.levels.keys()]) if (!seen.has(id)) this.levels.delete(id)
    for (const d of meters.dynamics) {
      const device = order.inserts[d.track]?.[d.insert]
      if (device) this.dynamics.set(device, { input: Math.max(0, Math.min(64, d.input)), gain: Math.max(0, Math.min(1, d.gain)) })
    }
  }

  /** A compressor/limiter/gate insert's live reading: the engine's while it renders the project, else the Web Audio node's. */
  readonly getDeviceMeter = (deviceId: string): DynamicsReading | null => {
    if (this.engineOwnsOutput()) return this.dynamics.get(deviceId) ?? null
    return webDynamicsReading(deviceId)
  }

  /** Export, bounce, freeze and stems (pre-master too) on the engine in a Worker; refused projects render on Web Audio. */
  override async renderAudio(source: Project, options: RenderOptions): Promise<RenderedAudio> {
    const fallback = async (reason: string): Promise<RenderedAudio> => {
      this.note(`이 렌더는 Web Audio 엔진으로 합니다: ${reason}`)
      const result = await super.renderAudio(source, options)
      this.lastRender = { engine: 'web-audio', frames: result.frames, reason, preMaster: !!options.preMaster }
      return result
    }
    const module = await sharedGarakEngineModule()
    if (!module) return fallback('garak-engine.wasm이 없습니다.')
    const project = playbackProject(source, this.assets)
    const sampleRate = projectSampleRate(project.sampleRate)
    const metadata = new Map<string, NativePcmAsset>()
    const assets: EngineRenderAsset[] = []
    for (const id of referencedAssets(project)) {
      const asset = this.assets.get(id)
      if (!asset) return fallback(`오디오 자산을 찾을 수 없습니다: ${id}`)
      metadata.set(id, pcmMetadata(id, asset.buffer))
      // One interleaved copy per export, transferred to the worker (which frees it once the module has it).
      const pcm = packAudioBuffer(asset.buffer)
      assets.push({ id, sampleRate: pcm.sampleRate, channels: pcm.channels, samples: new Float32Array(pcm.data.buffer, pcm.data.byteOffset, pcm.frames * pcm.channels) })
    }
    let timeline: NativeProjectTimeline
    try { timeline = compileNativeTimeline(project, metadata) } catch (error) { return fallback(message(error)) }
    if (timeline.lengthFrames > sampleRate * 60 * 15) throw new Error('이 초기 버전은 한 번에 최대 15분까지 WAV로 내보낼 수 있습니다. 프로젝트 길이를 줄여 주세요.')
    const encoded = encodeTracks(timeline.tracks)
    let result
    try {
      result = await renderInEngineWorker(module, {
        timeline: utf8Encode(JSON.stringify({ ...timeline, tracks: encoded.tracks })), binary: encoded.binary ?? undefined,
        sampleRate, lengthFrames: timeline.lengthFrames, assets,
        tailSeconds: options.tailSeconds === undefined ? undefined : Math.min(30, Math.max(0, options.tailSeconds)),
        startFrame: options.startFrame,
        // Stems and freeze: pre-master, like the C++ host's setMasterBypass.
        masterBypass: !!options.preMaster,
      })
    } catch (error) {
      if (error instanceof GarakEngineError) return fallback(error.message)
      throw error
    }
    this.lastRender = { engine: 'rust', renderMs: result.renderMs, frames: result.frames, preMaster: !!options.preMaster }
    return { blob: encodeWav([result.left, result.right], sampleRate, options.bitDepth), sampleRate, frames: result.frames, tailSeconds: result.tailSeconds, trackTailSeconds: trackTailSeconds(project) }
  }

  override dispose(): void {
    this.playRequest += 1
    if (this.syncTimer !== null) clearTimeout(this.syncTimer)
    this.syncTimer = null
    this.rustPlaying = false
    this.liveSource?.disconnect()
    this.liveSource = null
    this.disposeTaps()
    if (this.previewGraph) disposeGraph(this.previewGraph)
    this.previewGraph = null
    this.kernels?.dispose()
    this.kernels = null
    this.bridge?.dispose()
    this.bridge = null
    this.synced = null
    this.uploaded.clear()
    super.dispose()
  }
}

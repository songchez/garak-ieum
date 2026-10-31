import { EFFECT_DEFS, SAMPLED_KIT_PARAMS, SAMPLED_PARAMS, paramValue } from '../core/devices'
import { instrumentDef } from '../core/instruments'
import type { AudioAsset, AudioClip, EffectType, InstrumentId, Project, Track } from '../core/types'
import { clamp, clipEnvelope, secondsPerBeat } from './math'
import { pickZone, type LoadedSet, type SampleLibrary } from './samples'

type SourceNode = AudioBufferSourceNode | OscillatorNode

export interface Voice {
  stop(at: number): void
  disconnect(): void
}

export interface DeviceGraph {
  input: AudioNode
  output: AudioNode
  update(params: Record<string, number>, bpm: number, now: number, smooth: boolean): void
}

/** The last voice started per sample choke group, so a closed hat can cut an open one. */
export type ChokeMap = Map<number, { voice: Voice; when: number }>

export interface TrackGraph {
  input: GainNode
  devices: Map<string, DeviceGraph>
  panner: StereoPannerNode
  fader: GainNode
  meter: AnalyserNode
  meterData: Float32Array<ArrayBuffer>
  chokes: ChokeMap
}

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
}

const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>()
const impulseBuffers = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>()
const IMPULSES = {
  small: { seconds: 1.7, seed: 9183 },
  large: { seconds: 4.2, seed: 61427 },
}
let driveCurve: Float32Array<ArrayBuffer> | null = null
let tineCurve: Float32Array<ArrayBuffer> | null = null
const SAMPLE_TRIM_DB = -6

function randomGenerator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0xffffffff
  }
}

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

function impulseBuffer(context: BaseAudioContext, kind: keyof typeof IMPULSES): AudioBuffer {
  let cache = impulseBuffers.get(context)
  if (!cache) {
    cache = new Map()
    impulseBuffers.set(context, cache)
  }
  const existing = cache.get(kind)
  if (existing) return existing
  const { seconds, seed } = IMPULSES[kind]
  const length = Math.ceil(context.sampleRate * seconds)
  const buffer = context.createBuffer(2, length, context.sampleRate)
  const random = randomGenerator(seed)
  for (let channel = 0; channel < 2; channel += 1) {
    const values = buffer.getChannelData(channel)
    for (let frame = 0; frame < length; frame += 1) {
      values[frame] = (random() * 2 - 1) * Math.pow(1 - frame / length, 3.6)
    }
  }
  cache.set(kind, buffer)
  return buffer
}

function shaperCurve(): Float32Array<ArrayBuffer> {
  if (driveCurve) return driveCurve
  const points = 2048
  driveCurve = new Float32Array(points)
  for (let point = 0; point < points; point += 1) {
    const x = point / (points - 1) * 2 - 1
    driveCurve[point] = Math.tanh(2.5 * x) / Math.tanh(2.5)
  }
  return driveCurve
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

function setParameter(parameter: AudioParam, value: number, now: number, smooth: boolean): void {
  parameter.cancelScheduledValues(now)
  if (smooth) parameter.setTargetAtTime(value, now, 0.012)
  else parameter.setValueAtTime(value, now)
}

const dbToGain = (db: number): number => Math.pow(10, db / 20)

const effectParam = (type: EffectType, params: Record<string, number> | undefined) =>
  (id: string): number => paramValue(EFFECT_DEFS[type].params, params, id)

type Remember = <T extends AudioNode>(node: T) => T

const FILTER_MODES: BiquadFilterType[] = ['lowpass', 'highpass', 'bandpass']

const DEVICE_FACTORIES: Record<EffectType, (context: BaseAudioContext, remember: Remember) => DeviceGraph> = {
  eq(context, remember) {
    const low = remember(context.createBiquadFilter())
    const mid = remember(context.createBiquadFilter())
    const high = remember(context.createBiquadFilter())
    low.type = 'lowshelf'
    low.frequency.value = 220
    mid.type = 'peaking'
    mid.Q.value = 0.9
    high.type = 'highshelf'
    high.frequency.value = 4500
    low.connect(mid).connect(high)
    return {
      input: low,
      output: high,
      update(params, _bpm, now, smooth) {
        const p = effectParam('eq', params)
        setParameter(low.gain, clamp(p('low'), -40, 40), now, smooth)
        setParameter(mid.frequency, clamp(p('midFreq'), 20, context.sampleRate * 0.45), now, smooth)
        setParameter(mid.gain, clamp(p('mid'), -40, 40), now, smooth)
        setParameter(high.gain, clamp(p('high'), -40, 40), now, smooth)
      },
    }
  },
  filter(context, remember) {
    const filter = remember(context.createBiquadFilter())
    return {
      input: filter,
      output: filter,
      update(params, _bpm, now, smooth) {
        const p = effectParam('filter', params)
        const type = FILTER_MODES[clamp(Math.round(p('mode')), 0, FILTER_MODES.length - 1)]
        if (filter.type !== type) filter.type = type
        setParameter(filter.frequency, clamp(p('cutoff'), 10, context.sampleRate * 0.45), now, smooth)
        setParameter(filter.Q, clamp(p('resonance'), 0.0001, 40), now, smooth)
      },
    }
  },
  compressor(context, remember) {
    const compressor = remember(context.createDynamicsCompressor())
    const makeup = remember(context.createGain())
    compressor.knee.value = 6
    compressor.connect(makeup)
    return {
      input: compressor,
      output: makeup,
      update(params, _bpm, now, smooth) {
        const p = effectParam('compressor', params)
        setParameter(compressor.threshold, clamp(p('threshold'), -100, 0), now, smooth)
        setParameter(compressor.ratio, clamp(p('ratio'), 1, 20), now, smooth)
        setParameter(compressor.attack, clamp(p('attack') / 1000, 0, 1), now, smooth)
        setParameter(compressor.release, clamp(p('release') / 1000, 0, 1), now, smooth)
        setParameter(makeup.gain, dbToGain(clamp(p('makeup'), -60, 40)), now, smooth)
      },
    }
  },
  drive(context, remember) {
    const input = remember(context.createGain())
    const dry = remember(context.createGain())
    const pre = remember(context.createGain())
    const shaper = remember(context.createWaveShaper())
    const tone = remember(context.createBiquadFilter())
    const post = remember(context.createGain())
    const wet = remember(context.createGain())
    const output = remember(context.createGain())
    shaper.curve = shaperCurve()
    shaper.oversample = '2x'
    tone.type = 'lowpass'
    input.connect(dry).connect(output)
    input.connect(pre).connect(shaper).connect(tone).connect(post).connect(wet).connect(output)
    return {
      input,
      output,
      update(params, _bpm, now, smooth) {
        const p = effectParam('drive', params)
        const mix = clamp(p('mix'), 0, 1)
        const outputGain = dbToGain(clamp(p('output'), -60, 24))
        const preGain = dbToGain(clamp(p('drive'), -24, 48))
        setParameter(dry.gain, (1 - mix) * outputGain, now, smooth)
        setParameter(pre.gain, preGain, now, smooth)
        setParameter(tone.frequency, clamp(p('tone'), 10, context.sampleRate * 0.45), now, smooth)
        setParameter(post.gain, outputGain / Math.sqrt(preGain * 2.53), now, smooth)
        setParameter(wet.gain, mix, now, smooth)
      },
    }
  },
  delay(context, remember) {
    const input = remember(context.createGain())
    const output = remember(context.createGain())
    const delay = remember(context.createDelay(4))
    const wet = remember(context.createGain())
    const tone = remember(context.createBiquadFilter())
    const feedback = remember(context.createGain())
    tone.type = 'lowpass'
    input.connect(output)
    input.connect(delay).connect(wet).connect(output)
    delay.connect(tone).connect(feedback).connect(delay)
    return {
      input,
      output,
      update(params, bpm, now, smooth) {
        const p = effectParam('delay', params)
        setParameter(delay.delayTime, clamp(p('time') * secondsPerBeat(bpm), 0, 3.9), now, smooth)
        setParameter(wet.gain, clamp(p('amount'), 0, 1) * 0.45, now, smooth)
        setParameter(tone.frequency, clamp(p('tone'), 10, context.sampleRate * 0.45), now, smooth)
        setParameter(feedback.gain, clamp(p('feedback'), 0, 0.95), now, smooth)
      },
    }
  },
  reverb(context, remember) {
    const input = remember(context.createGain())
    const output = remember(context.createGain())
    const small = remember(context.createConvolver())
    const large = remember(context.createConvolver())
    const smallGain = remember(context.createGain())
    const largeGain = remember(context.createGain())
    const tone = remember(context.createBiquadFilter())
    const wet = remember(context.createGain())
    small.buffer = impulseBuffer(context, 'small')
    large.buffer = impulseBuffer(context, 'large')
    tone.type = 'lowpass'
    input.connect(output)
    input.connect(small).connect(smallGain).connect(tone)
    input.connect(large).connect(largeGain).connect(tone)
    tone.connect(wet).connect(output)
    return {
      input,
      output,
      update(params, _bpm, now, smooth) {
        const p = effectParam('reverb', params)
        const size = clamp(p('size'), 0, 1)
        setParameter(smallGain.gain, 1 - size, now, smooth)
        setParameter(largeGain.gain, size, now, smooth)
        setParameter(tone.frequency, clamp(p('tone'), 10, context.sampleRate * 0.45), now, smooth)
        setParameter(wet.gain, clamp(p('amount'), 0, 1) * 0.5, now, smooth)
      },
    }
  },
}

export function updateGraph(graph: EngineGraph, project: Project, smooth = true): void {
  const now = graph.context.currentTime
  const anySolo = project.tracks.some(track => track.solo)
  setParameter(graph.masterVolume.gain, clamp(project.masterVolume, 0, 2), now, smooth)
  for (const track of project.tracks) {
    const channel = graph.tracks.get(track.id)
    if (!channel) continue
    const audible = !track.mute && (!anySolo || track.solo)
    setParameter(channel.fader.gain, audible ? clamp(track.volume, 0, 2) : 0, now, smooth)
    setParameter(channel.panner.pan, clamp(track.pan, -1, 1), now, smooth)
    for (const device of track.devices) {
      if (device.enabled) channel.devices.get(device.id)?.update(device.params, project.bpm, now, smooth)
    }
  }
}

export function renderTailSeconds(project: Project): number {
  let tail = 0.85
  for (const track of project.tracks) {
    const def = instrumentDef(track.instrument)
    if (track.kind === 'instrument' && !def.isKit) {
      tail = Math.max(tail, clamp(paramValue(def.params, track.instrumentParams, 'release'), 0, 30) + 0.2)
    } else if (track.kind === 'instrument' && def.kind === 'sampled') tail = Math.max(tail, 2)
    for (const device of track.devices) {
      if (!device.enabled) continue
      const p = effectParam(device.type, device.params)
      if (device.type === 'reverb' && p('amount') > 0) {
        tail = Math.max(tail, 0.85 + 1.7 + clamp(p('size'), 0, 1) * 2.5)
      } else if (device.type === 'delay' && p('amount') > 0) {
        const feedback = clamp(p('feedback'), 0, 0.95)
        const repeats = feedback > 0.01 ? Math.ceil(Math.log(0.001) / Math.log(feedback)) : 1
        const delay = clamp(p('time') * secondsPerBeat(project.bpm), 0, 3.9)
        tail = Math.max(tail, Math.min(30, delay * (repeats + 1) + 0.85))
      }
    }
  }
  return tail
}

/** This graph is used unchanged by realtime playback and OfflineAudioContext. */
export function createGraph(context: BaseAudioContext, project: Project): EngineGraph {
  const nodes: AudioNode[] = []
  const remember = <T extends AudioNode>(node: T): T => { nodes.push(node); return node }
  const sum = remember(context.createGain())
  const masterVolume = remember(context.createGain())
  const compressor = remember(context.createDynamicsCompressor())
  compressor.threshold.value = -3
  compressor.knee.value = 3
  compressor.ratio.value = 12
  compressor.attack.value = 0.003
  compressor.release.value = 0.12
  const gate = remember(context.createGain())
  const meter = remember(context.createAnalyser())
  meter.fftSize = 256
  sum.connect(masterVolume).connect(compressor).connect(gate).connect(meter).connect(context.destination)
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
      const factory = DEVICE_FACTORIES[device.type]
      if (!device.enabled || !factory || devices.has(device.id)) continue
      const node = factory(context, remember)
      tail.connect(node.input)
      tail = node.output
      devices.set(device.id, node)
    }
    tail.connect(panner)
    panner.connect(fader).connect(trackMeter).connect(sum)

    tracks.set(track.id, {
      input, devices, panner, fader, meter: trackMeter,
      meterData: new Float32Array(trackMeter.fftSize), chokes: new Map(),
    })
  }
  const graph: EngineGraph = {
    context, tracks, voices: new Set(), previewInput, masterVolume, gate, meter,
    meterData: new Float32Array(meter.fftSize), nodes,
  }
  updateGraph(graph, project, false)
  return graph
}

export function disposeGraph(graph: EngineGraph): void {
  for (const voice of [...graph.voices]) {
    voice.stop(graph.context.currentTime)
    voice.disconnect()
  }
  graph.voices.clear()
  for (const node of graph.nodes) node.disconnect()
}

function registerVoice(graph: EngineGraph, sources: SourceNode[], nodes: AudioNode[], envelope: GainNode): Voice {
  let disconnected = false
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
    disconnect() {
      if (disconnected) return
      disconnected = true
      for (const node of nodes) node.disconnect()
      for (const source of sources) source.onended = null
      graph.voices.delete(voice)
    },
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
): void {
  if (velocity <= 0 || duration <= 0 || availableSeconds <= 0) return
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
  registerVoice(graph, sources, nodes, envelope)
  for (const source of sources) { source.start(when); source.stop(end) }
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
): void {
  if (velocity <= 0 || duration <= 0 || availableSeconds <= 0) return
  const { set, startOffset } = loaded
  const zone = pickZone(set, pitch, clamp(velocity, 0, 1))
  const buffer = zone && loaded.buffers.get(zone.file)
  if (!zone || !buffer) return
  const context = graph.context
  const p = (id: string): number => paramValue(isKit ? SAMPLED_KIT_PARAMS : SAMPLED_PARAMS, params, id)
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
    const releaseZone = set.releaseZones.length && noteDuration < natural ? pickZone(set, pitch, clamp(velocity, 0, 1), set.releaseZones) : undefined
    const releaseBuffer = releaseZone && loaded.buffers.get(releaseZone.file)
    if (releaseZone && releaseBuffer) {
      const noise = context.createBufferSource()
      noise.buffer = releaseBuffer
      noise.playbackRate.value = 2 ** ((clamp(pitch, 0, 127) - releaseZone.root) / 12 + (releaseZone.tune ?? 0) / 1200)
      const noiseGain = context.createGain()
      noiseGain.gain.value = dbToGain(set.gainDb + (releaseZone.gainDb ?? 0) + SAMPLE_TRIM_DB) * 0.35 * Math.min(1, strength) * level
      noise.connect(noiseGain).connect(destination)
      registerVoice(graph, [noise], [noise, noiseGain], noiseGain)
      noise.start(when + noteDuration, startOffset)
    }
  }
  const voice = registerVoice(graph, [source], nodes, envelope)
  source.start(when, startOffset)
  source.stop(end)
  if (isKit && chokes && zone.choke !== undefined) {
    const previous = chokes.get(zone.choke)
    if (previous && previous.when <= when) previous.voice.stop(when)
    chokes.set(zone.choke, { voice, when })
  }
}

function scheduleAudioClip(graph: EngineGraph, destination: AudioNode, clip: AudioClip, asset: AudioAsset, beat: number, when: number, boundary: number, beatSeconds: number): void {
  const context = graph.context
  const localSeconds = Math.max(0, (beat - clip.startBeat) * beatSeconds)
  const offset = Math.max(0, clip.offsetSeconds) + localSeconds
  const clipDuration = Math.min(clip.lengthBeats * beatSeconds, asset.buffer.duration - Math.max(0, clip.offsetSeconds))
  const duration = Math.min(clipDuration - localSeconds, (boundary - beat) * beatSeconds)
  if (duration <= 0.001 || offset >= asset.buffer.duration) return
  const source = context.createBufferSource()
  source.buffer = asset.buffer
  const envelope = context.createGain()
  const gain = clamp(clip.gain, 0, 2)
  const fadeIn = clamp(clip.fadeIn, 0, clipDuration / 2)
  const fadeOut = clamp(clip.fadeOut, 0, clipDuration / 2)
  const levelAt = (position: number): number => gain * clipEnvelope(position, clipDuration, fadeIn, fadeOut)
  const endLocal = localSeconds + duration
  const clickFade = Math.min(0.004, duration / 4)
  envelope.gain.setValueAtTime(0, when)
  envelope.gain.linearRampToValueAtTime(levelAt(localSeconds + clickFade), when + clickFade)
  const points = [fadeIn, clipDuration - fadeOut].filter(point => point > localSeconds + clickFade && point < endLocal - clickFade)
  for (const point of points.sort((a, b) => a - b)) {
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
): void {
  const beatSeconds = secondsPerBeat(project.bpm)
  const epsilon = 0.0000001
  const adjustStart = (beat: number): [number, number] => {
    let time = startTime + (beat - startBeat) * beatSeconds
    if (realtime && time < graph.context.currentTime) {
      const nextTime = graph.context.currentTime + 0.002
      beat += (nextTime - time) / beatSeconds
      time = nextTime
    }
    return [beat, time]
  }
  const startsInRange = (beat: number): boolean => beat >= startBeat - epsilon && beat < endBeat - epsilon
  for (const track of project.tracks) {
    const channel = graph.tracks.get(track.id)
    if (!channel) continue
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
    for (const clip of track.clips) {
      if (clip.mute) continue
      const clipEnd = Math.min(clip.startBeat + clip.lengthBeats, boundary, project.lengthBeats)
      if (clipEnd <= startBeat || clip.startBeat >= endBeat) continue
      if (clip.kind === 'audio') {
        if (!startsInRange(clip.startBeat) && !(chase && clip.startBeat < startBeat && clipEnd > startBeat)) continue
        const asset = assets.get(clip.assetId)
        if (!asset) continue
        const [beat, time] = adjustStart(Math.max(clip.startBeat, startBeat))
        if (beat < clipEnd) scheduleAudioClip(graph, channel.input, clip, asset, beat, time, clipEnd, beatSeconds)
      } else {
        for (const note of clip.notes) {
          const noteStart = clip.startBeat + Math.max(0, note.start)
          const noteEnd = Math.min(noteStart + Math.max(0, note.duration), clipEnd)
          if (noteEnd <= startBeat || noteStart >= clipEnd) continue
          if (!startsInRange(noteStart) && !(chase && !def.isKit && noteStart < startBeat && noteEnd > startBeat)) continue
          const [beat, time] = adjustStart(Math.max(noteStart, startBeat))
          if (beat >= noteEnd) continue
          const velocity = clamp(note.velocity, 0, 1) * clamp(clip.gain, 0, 2)
          if (loaded) {
            scheduleSampled(graph, channel.input, loaded, def.isKit, note.pitch, time, (noteEnd - beat) * beatSeconds, velocity, (clipEnd - beat) * beatSeconds, track.instrumentParams, channel.chokes)
          } else {
            scheduleInstrument(graph, channel.input, track.instrument, note.pitch, time, (noteEnd - beat) * beatSeconds, velocity, (clipEnd - beat) * beatSeconds, track.instrumentParams)
          }
        }
      }
    }
  }
}

export function rmsLevel(meter: AnalyserNode, values: Float32Array<ArrayBuffer>): number {
  meter.getFloatTimeDomainData(values)
  let total = 0
  for (const value of values) total += value * value
  return Math.min(1, Math.sqrt(total / values.length))
}

export function trackLayoutKey(tracks: readonly Track[]): string {
  return tracks.map(track =>
    track.id + '[' + track.devices.filter(device => device.enabled).map(device => device.type + ':' + device.id).join(',') + ']',
  ).join('|')
}

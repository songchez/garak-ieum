import type { AudioAsset, AudioClip, InstrumentId, Project, Track } from '../core/types'
import { clamp, clipEnvelope, secondsPerBeat } from './math'

type SourceNode = AudioBufferSourceNode | OscillatorNode

export interface Voice {
  stop(at: number): void
  disconnect(): void
}

export interface TrackGraph {
  input: GainNode
  filter: BiquadFilterNode
  reverbWet: GainNode
  delayWet: GainNode
  delay: DelayNode
  panner: StereoPannerNode
  fader: GainNode
  meter: AnalyserNode
  meterData: Float32Array<ArrayBuffer>
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
const impulseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>()

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

function impulseBuffer(context: BaseAudioContext): AudioBuffer {
  const existing = impulseBuffers.get(context)
  if (existing) return existing
  const length = Math.ceil(context.sampleRate * 1.7)
  const buffer = context.createBuffer(2, length, context.sampleRate)
  const random = randomGenerator(9183)
  for (let channel = 0; channel < 2; channel += 1) {
    const values = buffer.getChannelData(channel)
    for (let frame = 0; frame < length; frame += 1) {
      values[frame] = (random() * 2 - 1) * Math.pow(1 - frame / length, 3.6)
    }
  }
  impulseBuffers.set(context, buffer)
  return buffer
}

function setParameter(parameter: AudioParam, value: number, now: number, smooth: boolean): void {
  parameter.cancelScheduledValues(now)
  if (smooth) parameter.setTargetAtTime(value, now, 0.012)
  else parameter.setValueAtTime(value, now)
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
    setParameter(channel.filter.frequency, clamp(track.effects.filter, 40, Math.min(20000, graph.context.sampleRate * 0.45)), now, smooth)
    setParameter(channel.reverbWet.gain, clamp(track.effects.reverb, 0, 1) * 0.5, now, smooth)
    setParameter(channel.delayWet.gain, clamp(track.effects.delay, 0, 1) * 0.45, now, smooth)
    setParameter(channel.delay.delayTime, delaySeconds(project.bpm), now, smooth)
  }
}

export const delaySeconds = (bpm: number): number => Math.min(1.5, secondsPerBeat(bpm) * 0.75)

export function renderTailSeconds(project: Project): number {
  let tail = 0.85
  for (const track of project.tracks) {
    if (track.effects.reverb > 0) tail = Math.max(tail, 2.55)
    if (track.effects.delay > 0) tail = Math.max(tail, delaySeconds(project.bpm) * 6 + 0.85)
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
    const filter = remember(context.createBiquadFilter())
    filter.type = 'lowpass'
    filter.Q.value = 0.65
    const panner = remember(context.createStereoPanner())
    const fader = remember(context.createGain())
    const trackMeter = remember(context.createAnalyser())
    trackMeter.fftSize = 256
    input.connect(filter).connect(panner)
    panner.connect(fader).connect(trackMeter).connect(sum)

    const convolver = remember(context.createConvolver())
    convolver.buffer = impulseBuffer(context)
    const reverbWet = remember(context.createGain())
    filter.connect(convolver).connect(reverbWet).connect(panner)

    const delay = remember(context.createDelay(2))
    const delayWet = remember(context.createGain())
    const feedback = remember(context.createGain())
    const feedbackFilter = remember(context.createBiquadFilter())
    feedback.gain.value = 0.32
    feedbackFilter.type = 'lowpass'
    feedbackFilter.frequency.value = 3800
    filter.connect(delay).connect(delayWet).connect(panner)
    delay.connect(feedbackFilter).connect(feedback).connect(delay)

    tracks.set(track.id, {
      input, filter, reverbWet, delayWet, delay, panner, fader, meter: trackMeter,
      meterData: new Float32Array(trackMeter.fftSize),
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
): void {
  if (velocity <= 0 || duration <= 0 || availableSeconds <= 0) return
  const context = graph.context
  const level = clamp(velocity, 0, 2)
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
  const noise = (frequency: number, target: AudioNode = envelope): void => {
    const source = context.createBufferSource()
    source.buffer = noiseBuffer(context)
    source.loop = true
    const filter = context.createBiquadFilter()
    filter.type = 'highpass'
    filter.frequency.value = frequency
    source.connect(filter).connect(target)
    sources.push(source)
    nodes.push(source, filter)
  }
  if (instrument === 'drums') {
    const drum = Math.round(pitch)
    let decay: number
    let peak: number
    if (drum === 35 || drum === 36) {
      decay = 0.32
      peak = 0.8 * level
      const kick = oscillator('sine', 145, 1)
      kick.frequency.exponentialRampToValueAtTime(47, when + 0.12)
    } else if (drum === 38 || drum === 40 || drum === 39) {
      decay = drum === 39 ? 0.12 : 0.18
      peak = 0.32 * level
      noise(900)
      oscillator('triangle', 185, 0.25)
    } else if (drum === 42 || drum === 44 || drum === 46 || drum === 49 || drum === 51) {
      decay = drum === 46 ? 0.32 : drum === 49 || drum === 51 ? 0.62 : 0.065
      peak = (drum === 42 || drum === 44 ? 0.18 : 0.16) * level
      noise(6500)
    } else {
      decay = 0.23
      peak = 0.5 * level
      const frequency = 440 * Math.pow(2, (clamp(pitch, 24, 84) - 69) / 12)
      const tom = oscillator('sine', frequency * 1.8, 1)
      tom.frequency.exponentialRampToValueAtTime(frequency, when + 0.1)
    }
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
    switch (instrument) {
      case 'bass':
        filter.frequency.value = 700 + level * 1700
        oscillator('sawtooth', frequency, 0.45, filter)
        oscillator('sine', frequency, 0.65, filter)
        end = adsr(envelope.gain, when, noteDuration, 0.32 * level, 0.006, 0.09, 0.65, 0.13)
        break
      case 'pad':
        filter.frequency.value = 2600
        oscillator('sawtooth', frequency, 0.27, filter, -7)
        oscillator('sawtooth', frequency, 0.27, filter, 7)
        oscillator('triangle', frequency * 2, 0.2, filter)
        end = adsr(envelope.gain, when, noteDuration, 0.25 * level, 0.08, 0.24, 0.7, 0.7)
        break
      case 'pluck':
        filter.frequency.setValueAtTime(4800, when)
        filter.frequency.exponentialRampToValueAtTime(900, when + Math.max(0.03, Math.min(noteDuration, 0.25)))
        oscillator('triangle', frequency, 0.85, filter)
        oscillator('sine', frequency * 2, 0.2, filter)
        end = adsr(envelope.gain, when, noteDuration, 0.35 * level, 0.003, 0.12, 0.08, 0.16)
        break
      default:
        filter.frequency.value = 6800
        oscillator('sine', frequency, 0.8, filter)
        oscillator('triangle', frequency * 2, 0.2, filter)
        oscillator('sine', frequency * 3, 0.08, filter)
        end = adsr(envelope.gain, when, noteDuration, 0.35 * level, 0.004, 0.22, 0.2, 0.3)
    }
  }
  registerVoice(graph, sources, nodes, envelope)
  for (const source of sources) { source.start(when); source.stop(end) }
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
    for (const clip of track.clips) {
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
          if (!startsInRange(noteStart) && !(chase && track.instrument !== 'drums' && noteStart < startBeat && noteEnd > startBeat)) continue
          const [beat, time] = adjustStart(Math.max(noteStart, startBeat))
          if (beat >= noteEnd) continue
          scheduleInstrument(
            graph, channel.input, track.instrument, note.pitch, time,
            (noteEnd - beat) * beatSeconds, clamp(note.velocity, 0, 1) * clamp(clip.gain, 0, 2),
            (clipEnd - beat) * beatSeconds,
          )
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
  return tracks.map(track => track.id).join('|')
}

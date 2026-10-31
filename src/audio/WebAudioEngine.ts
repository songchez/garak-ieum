import { instrumentDef } from '../core/instruments'
import type { AudioAsset, AudioEngine, InstrumentId, Project, SampleAttribution, SampleStatus, TransportSnapshot } from '../core/types'
import {
  createGraph, disposeGraph, renderTailSeconds, rmsLevel, scheduleInstrument, scheduleRange, scheduleSampled,
  trackLayoutKey, updateGraph,
} from './graph'
import type { EngineGraph } from './graph'
import { clamp, encodePcm16Wav, loopRange, normalizedStart, positionAfter, secondsPerBeat } from './math'
import { SampleLibrary } from './samples'

const SCHEDULER_INTERVAL_MS = 25
const LOOKAHEAD_SECONDS = 0.12
const START_LEAD_SECONDS = 0.025
const SNAPSHOT_INTERVAL_MS = 40

/**
 * Initial browser backend. Native Web Audio nodes perform DSP; JavaScript only
 * queues timestamped events. This is not an openDAW or native VST host.
 *
 * Constructing this service never opens an audio device. resume/play/preview
 * should be called from a user gesture. dispose is idempotent, and a subsequent
 * explicit resume may open a fresh context (including React StrictMode remounts).
 */
export class WebAudioEngine implements AudioEngine {
  readonly kind = 'web-audio' as const
  /** Decoded sample sets outlive contexts and graphs; see audio/samples.ts. */
  readonly samples = new SampleLibrary()
  private project: Project | null = null
  private assets = new Map<string, AudioAsset>()
  private context: AudioContext | null = null
  private decodeContext: OfflineAudioContext | null = null
  private graph: EngineGraph | null = null
  private retiredGraphs = new Map<EngineGraph, ReturnType<typeof setTimeout>>()
  private scheduler: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<() => void>()
  private levels = new Map<string, number>()
  private masterLevel = 0
  private playing = false
  private position = 0
  private anchorBeat = 0
  private anchorTime = 0
  private cursorBeat = 0
  private cursorTime = 0
  private chaseCursor = true
  private lastSnapshotTime = 0
  private lifecycle = 0
  private transportRequest = 0
  private musicalKey = ''
  private snapshot: TransportSnapshot = { playing: false, beat: 0, ready: false, sampleRate: 0 }

  constructor(project?: Project) {
    // Notes of a set that arrived mid-playback were skipped; rescheduling from the
    // current beat picks them up at the cost of one small restart.
    this.samples.subscribe((_, status) => {
      if (status === 'ready' && this.playing) this.restartAt(this.currentBeat())
    })
    if (project) this.setProject(project)
  }

  readonly sampleStatus = (setId: string): SampleStatus => this.samples.status(setId)

  readonly subscribeSamples = (callback: () => void): (() => void) => this.samples.subscribe(callback)

  readonly sampleAttribution = (setId: string): SampleAttribution | undefined => this.samples.get(setId)?.set.attribution

  /** Decoding never opens an audio device: without a running context a tiny offline one decodes. */
  async preloadSamples(setId: string): Promise<void> {
    if (this.samples.status(setId) === 'ready') return
    const context = this.context && this.context.state !== 'closed' ? this.context : (this.decodeContext ??= new OfflineAudioContext(1, 1, 48000))
    await this.samples.load(setId, context)
  }

  private preloadProjectSamples(project: Project): void {
    for (const track of project.tracks) {
      const def = instrumentDef(track.instrument)
      if (track.kind === 'instrument' && def.set && this.samples.status(def.set) === 'idle') void this.preloadSamples(def.set).catch(() => undefined)
    }
  }

  private sampleSets(project: Project): string[] {
    return [...new Set(project.tracks.flatMap(track => {
      const def = instrumentDef(track.instrument)
      return track.kind === 'instrument' && def.set ? [def.set] : []
    }))]
  }

  readonly subscribe = (callback: () => void): (() => void) => {
    this.listeners.add(callback)
    return () => { this.listeners.delete(callback) }
  }

  /** A cached object is required by React's useSyncExternalStore contract. */
  readonly getSnapshot = (): TransportSnapshot => this.snapshot

  readonly getTrackLevel = (trackId: string): number => this.levels.get(trackId) ?? 0

  readonly getMasterLevel = (): number => this.masterLevel

  setProject(project: Project): void {
    const beat = this.currentBeat()
    const nextKey = JSON.stringify([
      project.bpm, project.lengthBeats, project.loop,
      project.tracks.map(track => [track.id, track.kind, track.instrument, track.clips]),
    ])
    const changedArrangement = nextKey !== this.musicalKey
    const changedLayout = this.project === null || trackLayoutKey(this.project.tracks) !== trackLayoutKey(project.tracks)
    this.project = project
    this.musicalKey = nextKey
    this.position = clamp(beat, 0, project.lengthBeats)
    this.preloadProjectSamples(project)
    if (this.context) {
      if (this.playing && (changedArrangement || changedLayout)) this.restartAt(this.position)
      else if (!this.graph || changedLayout) this.replaceGraph()
      else updateGraph(this.graph, project)
    }
    this.publishSnapshot()
  }

  setAssets(assets: Map<string, AudioAsset>): void {
    const changed = assets.size !== this.assets.size || [...assets].some(([id, asset]) => this.assets.get(id)?.buffer !== asset.buffer)
    this.assets = new Map(assets)
    if (changed && this.playing) this.restartAt(this.currentBeat())
  }

  async resume(): Promise<void> {
    const context = this.ensureContext()
    const lifecycle = this.lifecycle
    if (context.state !== 'running') await context.resume()
    if (lifecycle !== this.lifecycle || context !== this.context) return
    if (context.state !== 'running') throw new Error('오디오를 시작하려면 재생 버튼을 다시 눌러 주세요.')
    this.publishSnapshot()
  }

  async play(): Promise<void> {
    if (!this.project) throw new Error('재생할 프로젝트가 없습니다.')
    const request = ++this.transportRequest
    const lifecycle = this.lifecycle
    await this.resume()
    if (request !== this.transportRequest || lifecycle !== this.lifecycle || !this.context || !this.project) return
    if (this.playing) return
    let beat = normalizedStart(this.project, this.position)
    if (!loopRange(this.project) && beat >= this.project.lengthBeats) beat = 0
    this.playing = true
    this.restartAt(beat)
    this.publishSnapshot()
  }

  pause(): void {
    this.transportRequest += 1
    this.position = this.currentBeat()
    this.playing = false
    this.replaceGraph()
    this.publishSnapshot()
  }

  stop(): void {
    this.transportRequest += 1
    this.playing = false
    this.position = 0
    this.cursorBeat = 0
    this.replaceGraph()
    this.publishSnapshot()
  }

  seek(beat: number): void {
    if (!this.project) return
    this.position = clamp(beat, 0, this.project.lengthBeats)
    if (this.playing) this.restartAt(this.position)
    this.publishSnapshot()
  }

  async previewNote(instrument: InstrumentId, pitch: number, velocity = 0.8, trackId?: string): Promise<void> {
    const lifecycle = this.lifecycle
    const def = instrumentDef(instrument)
    await this.resume()
    if (def.set) await this.preloadSamples(def.set)
    if (lifecycle !== this.lifecycle || !this.context || !this.graph) return
    const tracks = this.project?.tracks ?? []
    const track = trackId === undefined ? undefined : tracks.find(item => item.id === trackId)
    const anySolo = tracks.some(item => item.solo)
    const audible = track !== undefined && !track.mute && (!anySolo || track.solo)
    const channel = audible ? this.graph.tracks.get(track.id) : undefined
    const params = track?.instrument === instrument ? track.instrumentParams : undefined
    const duration = instrument === 'pad' || def.kind === 'sampled' ? 0.65 : 0.3
    const destination = channel?.input ?? this.graph.previewInput
    const loaded = def.set ? this.samples.get(def.set) : undefined
    if (loaded) scheduleSampled(this.graph, destination, loaded, def.isKit, pitch, this.context.currentTime + 0.006, duration, velocity, duration + 0.8, params, channel?.chokes)
    else scheduleInstrument(this.graph, destination, instrument, pitch, this.context.currentTime + 0.006, duration, velocity, duration + 0.8, params)
  }

  async decodeAsset(blob: Blob, name: string, id?: string): Promise<AudioAsset> {
    if (blob.size === 0) throw new Error('비어 있는 오디오 파일입니다.')
    const context = this.ensureContext()
    let buffer: AudioBuffer
    try {
      buffer = await context.decodeAudioData(await blob.arrayBuffer())
    } catch {
      throw new Error('이 오디오 파일을 읽을 수 없습니다. 브라우저에서 지원하는 WAV, MP3, OGG 등의 파일을 사용해 주세요.')
    }
    if (buffer.length === 0 || !Number.isFinite(buffer.duration)) throw new Error('오디오 파일에 재생할 데이터가 없습니다.')
    const peaks: number[] = []
    const count = Math.min(320, buffer.length)
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel))
    for (let point = 0; point < count; point += 1) {
      const start = Math.floor(point * buffer.length / count)
      const end = Math.floor((point + 1) * buffer.length / count)
      const stride = Math.max(1, Math.floor((end - start) / 256))
      let peak = 0
      for (const channel of channels) {
        for (let frame = start; frame < end; frame += stride) peak = Math.max(peak, Math.abs(channel[frame]))
      }
      peaks.push(Math.min(1, peak))
    }
    return {
      id: id ?? globalThis.crypto.randomUUID(),
      name, blob, buffer, peaks,
    }
  }

  /** Exports the entire arrangement once; the audition loop is deliberately ignored. */
  async exportWav(project: Project = this.requireProject()): Promise<Blob> {
    for (const setId of this.sampleSets(project)) {
      try { await this.preloadSamples(setId) } catch (error) {
        throw new Error(`샘플 악기 "${setId}"를 불러오지 못했습니다: ${error instanceof Error ? error.message : ''}`)
      }
    }
    const sampleRate = this.context?.sampleRate ?? 48000
    const duration = project.lengthBeats * secondsPerBeat(project.bpm) + renderTailSeconds(project)
    const frames = Math.ceil(duration * sampleRate)
    if (!Number.isFinite(frames) || frames < 1) throw new Error('프로젝트의 내보내기 길이가 올바르지 않습니다.')
    // OfflineAudioContext stores all rendered samples in RAM. Fail clearly before
    // allocating a multi-gigabyte buffer in this initial browser implementation.
    if (frames > sampleRate * 60 * 15) throw new Error('이 초기 버전은 한 번에 최대 15분까지 WAV로 내보낼 수 있습니다. 프로젝트 길이를 줄여 주세요.')
    const offline = new OfflineAudioContext(2, frames, sampleRate)
    const graph = createGraph(offline, project)
    try {
      scheduleRange(graph, project, new Map(this.assets), 0, project.lengthBeats, 0, project.lengthBeats, true, false, this.samples)
      const rendered = await offline.startRendering()
      const bytes = encodePcm16Wav([rendered.getChannelData(0), rendered.getChannelData(1)], rendered.sampleRate)
      return new Blob([bytes], { type: 'audio/wav' })
    } finally {
      disposeGraph(graph)
    }
  }

  dispose(): void {
    this.lifecycle += 1
    this.transportRequest += 1
    this.playing = false
    this.position = 0
    if (this.scheduler !== null) clearInterval(this.scheduler)
    this.scheduler = null
    if (this.graph) disposeGraph(this.graph)
    this.graph = null
    for (const [graph, timeout] of this.retiredGraphs) {
      clearTimeout(timeout)
      disposeGraph(graph)
    }
    this.retiredGraphs.clear()
    const context = this.context
    this.context = null
    if (context) {
      context.onstatechange = null
      if (context.state !== 'closed') void context.close().catch(() => undefined)
    }
    this.levels.clear()
    this.masterLevel = 0
    this.publishSnapshot()
    this.listeners.clear()
  }

  private requireProject(): Project {
    if (!this.project) throw new Error('프로젝트가 아직 준비되지 않았습니다.')
    return this.project
  }

  private ensureContext(): AudioContext {
    if (this.context && this.context.state !== 'closed') return this.context
    if (typeof AudioContext === 'undefined') throw new Error('이 브라우저는 Web Audio를 지원하지 않습니다.')
    const context = new AudioContext({ latencyHint: 'interactive' })
    this.context = context
    this.lastSnapshotTime = 0
    context.onstatechange = () => {
      if (this.context === context) this.publishSnapshot()
    }
    if (this.project) this.graph = createGraph(context, this.project)
    this.scheduler = setInterval(() => this.tick(), SCHEDULER_INTERVAL_MS)
    this.publishSnapshot()
    return context
  }

  private currentBeat(): number {
    if (!this.playing || !this.context || !this.project) return this.position
    return positionAfter(this.project, this.anchorBeat, this.context.currentTime - this.anchorTime)
  }

  private replaceGraph(): void {
    if (!this.context || !this.project) return
    if (this.graph) {
      const old = this.graph
      if (this.context.state === 'running') {
        const now = this.context.currentTime
        old.gate.gain.cancelScheduledValues(now)
        old.gate.gain.setTargetAtTime(0, now, 0.003)
        for (const voice of old.voices) voice.stop(now)
        const timeout = setTimeout(() => {
          disposeGraph(old)
          this.retiredGraphs.delete(old)
        }, 30)
        this.retiredGraphs.set(old, timeout)
      } else disposeGraph(old)
    }
    this.graph = createGraph(this.context, this.project)
    this.levels.clear()
    this.masterLevel = 0
  }

  private restartAt(beat: number): void {
    if (!this.context || !this.project) return
    this.position = normalizedStart(this.project, beat)
    this.anchorBeat = this.position
    this.anchorTime = this.context.currentTime + START_LEAD_SECONDS
    this.cursorBeat = this.position
    this.cursorTime = this.anchorTime
    this.chaseCursor = true
    this.replaceGraph()
    this.schedule()
  }

  private schedule(): void {
    if (!this.playing || !this.context || !this.project || !this.graph) return
    const project = this.project
    const loop = loopRange(project)
    const beatSeconds = secondsPerBeat(project.bpm)
    const boundary = loop?.end ?? project.lengthBeats
    const horizon = this.context.currentTime + LOOKAHEAD_SECONDS

    // A backgrounded tab can miss timer ticks. Resume from the audio clock instead
    // of firing a burst of stale onsets; audio clips chase their correct offsets.
    if (this.cursorTime < this.context.currentTime - LOOKAHEAD_SECONDS) {
      const nextTime = this.context.currentTime + 0.008
      const beat = positionAfter(project, this.anchorBeat, nextTime - this.anchorTime)
      this.replaceGraph()
      this.cursorTime = nextTime
      this.cursorBeat = beat
      this.chaseCursor = true
    }

    let iterations = 0
    while (this.cursorTime < horizon && iterations < 128) {
      iterations += 1
      if (this.cursorBeat >= boundary - 0.0000001) {
        if (!loop) break
        this.cursorBeat = loop.start
        this.chaseCursor = true
      }
      const remainingSeconds = (boundary - this.cursorBeat) * beatSeconds
      const segmentSeconds = Math.min(horizon - this.cursorTime, remainingSeconds)
      if (segmentSeconds <= 0.00000001) break
      const endBeat = this.cursorBeat + segmentSeconds / beatSeconds
      scheduleRange(this.graph, project, this.assets, this.cursorBeat, endBeat, this.cursorTime, boundary, this.chaseCursor, true, this.samples)
      this.cursorTime += segmentSeconds
      this.cursorBeat = endBeat
      this.chaseCursor = false
    }
  }

  private tick(): void {
    if (!this.context) return
    if (this.playing && this.project) {
      const completed = !loopRange(this.project) && this.context.currentTime >= this.anchorTime + (this.project.lengthBeats - this.anchorBeat) * secondsPerBeat(this.project.bpm)
      if (completed) {
        this.position = this.project.lengthBeats
        this.playing = false
        // Let instrument releases, reverb, and delay decay naturally at the end.
        this.publishSnapshot()
      } else this.schedule()
    }
    const now = performance.now()
    if (now - this.lastSnapshotTime < SNAPSHOT_INTERVAL_MS) return
    this.lastSnapshotTime = now
    if (this.graph && this.context.state === 'running') {
      for (const [id, channel] of this.graph.tracks) {
        const level = rmsLevel(channel.meter, channel.meterData)
        this.levels.set(id, Math.max(level, (this.levels.get(id) ?? 0) * 0.7))
      }
      this.masterLevel = Math.max(rmsLevel(this.graph.meter, this.graph.meterData), this.masterLevel * 0.7)
    } else {
      this.levels.clear()
      this.masterLevel = 0
    }
    this.publishSnapshot()
  }

  private publishSnapshot(): void {
    const next: TransportSnapshot = {
      playing: this.playing,
      beat: Math.round(this.currentBeat() * 10000) / 10000,
      ready: this.context?.state === 'running',
      sampleRate: this.context?.sampleRate ?? 0,
    }
    if (next.playing === this.snapshot.playing && next.beat === this.snapshot.beat && next.ready === this.snapshot.ready && next.sampleRate === this.snapshot.sampleRate) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}

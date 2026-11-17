import { instrumentDef } from '../core/instruments'
import { DEFAULT_AUDIO_SETTINGS, DEFAULT_SAMPLE_RATE, normalizeAudioSettings, projectSampleRate, type AudioSettings, type AudioState, type RenderSizeHint, type SampleRate } from '../core/audioSettings'
import { isTrackEnabled, trackNote } from '../core/playback'
import type { AudioAsset, AudioEngine, ControllerKey, InputChoice, InstrumentId, Project, RenderOptions, RenderedAudio, SampleAttribution, SampleStatus, TransportSnapshot, VintageBridge } from '../core/types'
import { playbackProject } from '../core/freeze'
import { countInBeats, type MetronomeEngineState, type PlayOptions } from '../core/metronome'
import { meterMapOf } from '../core/meterMap'
import { createEmptyProject, createTrack } from '../core/project'
import { numberedInputChoices } from '../core/trackInputs'
import { tempoMapOf } from '../core/tempoMap'
import type { TakeCallbacks } from '../core/recording'
import type { DynamicsReading } from '../devices/effects/dynamicsMeter'
import { VINTAGE_WEB_UNAVAILABLE } from '../devices/vintage/availability'
import { registerDeviceAnalysis, requestedDeviceAnalysis, type StereoScopeTap } from '../devices/effects/analysis'
import { registerGuitarTunerTap, requestedGuitarTuners, unregisterGuitarTunerTap } from '../devices/guitar-rig/tuner'
import { EngineAnalyser, type AnalysisSource } from './engineAnalyser'
import { encodeWav } from './wavEncode'
import { clamp, loopRange, normalizedStart } from './math'
import { SampleLibrary, type LoadedSet } from './samples'
import { ownAudioBytes } from './assetBytes'
import { playOutputTest } from './OutputTest'
import { assertWebAudioProjectSupported, canPlayInstrument, instrumentUnavailableReason, unsupportedWebAudioInstruments } from './instrumentSupport'
import { prepareRouteRecorder, RouteRecordings, type RouteRecordingHost } from './RouteRecording'
import { WebLiveMidi, type LiveVoiceHandle } from './liveMidi'
import { metronomeStrokes } from './metronomeSounds'
import { renderTailSeconds, trackTailSeconds } from './renderTail'
import { packAudioBuffer } from './native/pcmTransfer'
import { compileNativeTimeline, NativeTimelineCompiler, type NativePcmAsset, type NativeProjectTimeline } from './native/timeline'
import { encodeTracks, planNativeSync, type SyncTimeline } from './native/timelineSync'
import { ANALYSIS_FRAMES, ANALYSIS_SLOTS, emptyStatus, TAP_CHANNELS, type EngineMeters, type EngineStatus } from './rust/engineChannel'
import { ENGINE_WORKLET_UNSUPPORTED, KernelHelper, renderInEngineWorker, RustEngineNode, sharedGarakEngineModule } from './rust/engineHost'
import type { EngineRenderAsset } from './rust/engineOffline'
import { GarakEngineError, utf8Encode } from './rust/garakEngineWasm'

const TICK_INTERVAL_MS = 25
/** How often the analysis taps follow the editors that are open. */
const ANALYSIS_SYNC_MS = 200
const SNAPSHOT_INTERVAL_MS = 40
/** Note previews: this long (pads and sampled instruments ring a little longer). */
const PREVIEW_SECONDS = 0.3
const LONG_PREVIEW_SECONDS = 0.65

type ContextExtras = {
  setSinkId?: (sinkId: string) => Promise<void>
  sinkId?: string | { type: string }
  outputLatency?: number
  renderQuantumSize?: number
}
const nonnegative = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const configurationCancelled = () => new DOMException('오디오 설정 요청이 취소되었습니다.', 'AbortError')
const contextKey = (settings: AudioSettings): string => JSON.stringify([settings.outputDeviceId, settings.latencyHint, settings.renderSizeHint])
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** User-facing reasons the audio engine cannot run in this browser (it has no other renderer). */
export const ENGINE_WASM_UNSUPPORTED = '이 브라우저는 오디오 엔진에 필요한 WebAssembly를 지원하지 않아 소리를 낼 수 없습니다. 최신 Chrome, Edge, Firefox 또는 Safari에서 열어 주세요.'
export const ENGINE_LOAD_FAILED = '가락이음 오디오 엔진(garak-engine.wasm)을 불러오지 못해 소리를 낼 수 없습니다. 네트워크 연결을 확인한 뒤 페이지를 새로 고쳐 주세요.'
export const engineStartFailed = (detail: string) => `오디오 엔진을 시작하지 못했습니다. 페이지를 새로 고친 뒤 다시 시도해 주세요. (${detail})`
export const engineRefused = (reason: string) => `오디오 엔진이 이 프로젝트를 재생할 수 없습니다: ${reason}`

/** The page's engine module: fetched and compiled once; a failed load may be retried by the next request. */
type EngineModuleState = 'idle' | 'loading' | 'ready' | 'unavailable'
let moduleState: EngineModuleState = 'idle'
let moduleTask: Promise<WebAssembly.Module | null> | null = null
const moduleListeners = new Set<() => void>()
function publishModuleState(next: EngineModuleState): void {
  if (moduleState === next) return
  moduleState = next
  for (const listener of [...moduleListeners]) listener()
}
function loadEngineModule(): Promise<WebAssembly.Module | null> {
  if (moduleState === 'ready' && moduleTask) return moduleTask
  if (moduleTask && moduleState === 'loading') return moduleTask
  publishModuleState('loading')
  const task = sharedGarakEngineModule().then(module => {
    if (!module) console.info('[가락이음] garak-engine.wasm이 없거나 불러오지 못했습니다. 개발 중이면 pnpm rust:wasm으로 만드세요 (docs/RUST.md).')
    publishModuleState(module ? 'ready' : 'unavailable')
    return module
  }, () => { publishModuleState('unavailable'); return null })
  moduleTask = task
  return task
}
/** Test hook: forget the page's module state. */
export function resetEngineModuleForTests(): void {
  moduleState = 'idle'
  moduleTask = null
}
async function requireEngineModule(): Promise<WebAssembly.Module> {
  if (typeof WebAssembly === 'undefined') { publishModuleState('unavailable'); throw new Error(ENGINE_WASM_UNSUPPORTED) }
  const module = await loadEngineModule()
  if (!module) throw new Error(ENGINE_LOAD_FAILED)
  return module
}

/** What the page is doing with the engine (tests, the smoke script and bug reports). */
export interface EngineDiagnostics {
  /** The worklet node exists on the current audio context. */
  running: boolean
  /** Status and transport use a SharedArrayBuffer (cross-origin isolated page). */
  sharedChannel: boolean
  /** The engine accepted the current project; otherwise `reason` says why it is silent. */
  accepted: boolean
  reason: string
  playing: boolean
  status: EngineStatus
  /** The last offline render (export/bounce/freeze/stems). */
  lastRender: { renderMs: number; frames: number; preMaster: boolean } | null
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

/** The engine asset id of one decoded sample file (the desktop host uses the same scheme). */
const sampleAssetId = (setId: string, file: string): string => `sample:${setId}:${file}`

/** A decoded sample set as the `samples.register` params the desktop host sends (protocol::parse_sample_set). */
function sampleSetJson(setId: string, loaded: LoadedSet): string {
  const files: Record<string, string> = {}
  for (const file of loaded.buffers.keys()) files[file] = sampleAssetId(setId, file)
  return JSON.stringify({ id: setId, manifest: loaded.set, startOffset: loaded.startOffset, files })
}

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

/** One analysis tap's history, read from the bridge once per publication. */
class BridgeAnalysisSource implements AnalysisSource {
  private readonly data = new Float32Array(ANALYSIS_FRAMES * 2)
  private version = -1
  private filled = false
  constructor(private readonly bridge: RustEngineNode, private readonly slot: number) {}
  latest(): Float32Array | null {
    const version = this.bridge.analysisVersion
    if (version !== this.version) {
      this.version = version
      if (this.bridge.readAnalysis(this.slot, this.data)) this.filled = true
    }
    return this.filled ? this.data : null
  }
}

/** PCM and sample sets already handed to one engine node (re-sent only when the decoded buffer changes). */
class EngineUploads {
  readonly pcm = new Map<string, WeakRef<AudioBuffer>>()
  readonly sets = new Map<string, LoadedSet>()

  async put(bridge: RustEngineNode, id: string, buffer: AudioBuffer): Promise<void> {
    if (this.pcm.get(id)?.deref() === buffer) return
    await bridge.putAsset(id, buffer)
    this.pcm.set(id, new WeakRef(buffer))
  }

  /** A decoded set: its zones' PCM (chunked into the worklet like any asset), then the set as samples.register JSON. */
  async putSet(bridge: RustEngineNode, setId: string, loaded: LoadedSet, referenced: Set<string>): Promise<void> {
    for (const [file, buffer] of loaded.buffers) {
      const id = sampleAssetId(setId, file)
      referenced.add(id)
      await this.put(bridge, id, buffer)
    }
    if (this.sets.get(setId) !== loaded) {
      await bridge.registerSamples(sampleSetJson(setId, loaded))
      this.sets.set(setId, loaded)
    }
  }

  /** PCM nothing references any more leaves the worklet. */
  prune(bridge: RustEngineNode, referenced: ReadonlySet<string>, sets: readonly string[]): void {
    for (const setId of [...this.sets.keys()]) if (!sets.includes(setId)) this.sets.delete(setId)
    for (const id of [...this.pcm.keys()]) if (!referenced.has(id)) { this.pcm.delete(id); void bridge.removeAsset(id).catch(() => undefined) }
  }

  clear(): void { this.pcm.clear(); this.sets.clear() }
}

/**
 * Library previews (no track): a second, tiny engine node playing a one-track project of the previewed
 * instrument, so an audition never touches the project's graph. Created on the first library preview.
 */
class PreviewEngine {
  private readonly uploads = new EngineUploads()
  private key = ''
  private noteId = 0

  constructor(readonly bridge: RustEngineNode) {}

  async play(instrument: InstrumentId, loaded: LoadedSet | undefined, pitch: number, velocity: number, seconds: number): Promise<void> {
    const bridge = this.bridge, def = instrumentDef(instrument)
    const key = `${instrument}:${bridge.context.sampleRate}`
    if (key !== this.key) {
      const referenced = new Set<string>()
      if (def.set && loaded) await this.uploads.putSet(bridge, def.set, loaded, referenced)
      this.uploads.prune(bridge, referenced, def.set ? [def.set] : [])
      const project: Project = { ...createEmptyProject(), sampleRate: bridge.context.sampleRate as Project['sampleRate'], tracks: [{ ...createTrack('instrument', instrument), id: 'preview' }] }
      const timeline = compileNativeTimeline(project, new Map())
      const encoded = encodeTracks(timeline.tracks)
      await bridge.update('project.set', { ...timeline, tracks: encoded.tracks }, encoded.binary)
      this.key = key
    }
    const id = ++this.noteId
    bridge.live(0, 'noteOn', pitch, clamp(velocity, 0, 1), id)
    setTimeout(() => { bridge.live(0, 'noteOff', pitch, 0, id) }, seconds * 1000)
  }

  dispose(): void { this.bridge.dispose() }
}

/**
 * The browser's audio engine: the unified Rust render engine (garak-engine.wasm) in one AudioWorklet
 * (docs/RUST_ENGINE.md 5), the same engine and render-diff protocol the desktop host runs.
 *
 * Everything that makes a project sound — clips, instruments, effect chains, sends/returns, automation, tempo
 * map, master, metronome and count-in — renders in the worklet, fed by NativeTimelineCompiler + planNativeSync
 * (project.set, then project.patch per edit). Export, bounce, freeze and stems (pre-master included) render
 * the same engine in a Worker. Track and dynamics meters, input monitoring, track-input route monitoring and
 * route recording taps, live notes and previews all go through the engine. There is no other renderer: a
 * browser without AudioWorklet or WebAssembly, or a module that fails to load, gets a clear error instead.
 *
 * This class keeps the browser around the engine: device setup and health, decoding, sample libraries,
 * MediaStream capture, route recorders and Web MIDI. Constructing it never opens an audio device;
 * resume/play/preview should be called from a user gesture. dispose is idempotent, and a later explicit
 * resume may open a fresh context (including React StrictMode remounts).
 */
export class WebAudioEngine implements AudioEngine {
  readonly kind = 'web-audio' as const
  /** 옥구슬 EP / 한밤 106 are part of the engine module (the Rust instrument core). */
  readonly vintage: VintageBridge = {
    available: () => moduleState === 'ready' && typeof AudioWorkletNode !== 'undefined',
    reason: () => moduleState === 'ready' ? '' : moduleState === 'loading' || moduleState === 'idle' ? '오디오 엔진(WASM)을 불러오는 중입니다.' : VINTAGE_WEB_UNAVAILABLE,
    subscribe: listener => {
      moduleListeners.add(listener)
      if (typeof WebAssembly !== 'undefined') void loadEngineModule()
      return () => { moduleListeners.delete(listener) }
    },
  }
  /** One MediaRecorder per take; a browser records the chosen track only. */
  readonly maxSimultaneousRecordings = 1
  /** Decoded sample sets outlive contexts; see audio/samples.ts. */
  readonly samples = new SampleLibrary()
  private project: Project | null = null
  private sourceProject: Project | null = null
  private assets = new Map<string, AudioAsset>()
  private context: AudioContext | null = null
  private decodeContext: OfflineAudioContext | null = null
  private ticker: ReturnType<typeof setInterval> | null = null
  private readonly listeners = new Set<() => void>()
  private readonly levels = new Map<string, number>()
  private masterLevel = 0
  private playing = false
  private position = 0
  private lastSnapshotTime = 0
  private lifecycle = 0
  private transportRequest = 0
  private pendingPlayRequest: number | null = null
  /** Channels of the last live input stream; null until a stream has been seen. */
  private inputChannelCount: number | null = null
  private snapshot: TransportSnapshot = { playing: false, beat: 0, ready: false, sampleRate: 0 }
  private settings: AudioSettings
  private desiredSampleRate: SampleRate = DEFAULT_SAMPLE_RATE
  private audioStatus: AudioState['status'] = 'idle'
  private audioError: string | null = null
  private audioSnapshot: AudioState
  private readonly audioListeners = new Set<() => void>()
  private configurationRequest = 0
  private configurationTask: Promise<void> | null = null
  private readonly preparingContexts = new Set<AudioContext>()
  private outputFault: string | null = null
  private removeOutputListeners: (() => void) | null = null

  // The engine worklet and its project sync.
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
  private verdict = { accepted: false, reason: '아직 오디오 엔진에 프로젝트를 보내지 않았습니다.' }
  private readonly uploads = new EngineUploads()
  private preview: PreviewEngine | null = null
  /** Sequence number of the last play/seek command; status before it is stale. */
  private transportSeq = 0
  private status: EngineStatus = emptyStatus()
  private peak = 0
  private readonly notes = new Set<string>()
  private lastRender: EngineDiagnostics['lastRender'] = null
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
  private liveNoteId = 0
  /** Analysis taps the open editors asked for (key: their engine addresses) and how to unregister them. */
  private analysisKey = ''
  private analysisRelease: (() => void)[] = []
  private lastAnalysisSync = 0

  /** Live MIDI from Web MIDI inputs and the computer keyboard (docs/MIDI_RECORDING.md). */
  readonly liveMidi = new WebLiveMidi({ startNote: (trackId, pitch, velocity) => this.startLiveNote(trackId, pitch, velocity), beatAt: time => this.heardBeatAt(time),
    control: (trackId, key, value) => this.liveControl(trackId, key, value) })

  constructor(project?: Project, settings: AudioSettings = DEFAULT_AUDIO_SETTINGS) {
    this.settings = normalizeAudioSettings(settings)
    this.audioSnapshot = this.readAudioState()
    // A sample set that finished decoding reaches the engine with the next sync.
    this.samples.subscribe((_, status) => { if (status === 'ready' && this.project && this.sampleSets(this.project).length) this.markDirty() })
    if (project) this.setProject(project)
  }

  readonly getAudioState = (): AudioState => this.audioSnapshot

  readonly subscribeAudioState = (callback: () => void): (() => void) => {
    this.audioListeners.add(callback)
    return () => { this.audioListeners.delete(callback) }
  }

  diagnostics(): EngineDiagnostics {
    if (this.bridge) this.poll()
    return {
      running: !!this.bridge && this.bridge.context === this.context && !this.bridge.error,
      sharedChannel: !!this.bridge?.sharedChannel,
      accepted: this.verdict.accepted, reason: this.verdict.reason,
      playing: this.playing, status: { ...this.status }, lastRender: this.lastRender,
      monitoring: [...this.monitored], taps: this.tapIndices.filter(index => index >= 0), kernels: this.kernelCount,
    }
  }

  private note(text: string): void {
    if (this.notes.has(text)) return
    this.notes.add(text)
    console.info(`[가락이음] 오디오 엔진: ${text}`)
  }

  /** Explicit Apply is transactional: a failed candidate never replaces the working context. */
  configure(settings: AudioSettings, sampleRate: SampleRate): Promise<void> {
    return this.configureAudio(settings, sampleRate, true)
  }

  private configureAudio(settings: AudioSettings, sampleRate: SampleRate, cancelTransport: boolean): Promise<void> {
    if (this.playing) return Promise.reject(new Error('재생을 멈춘 뒤 오디오 설정을 적용해 주세요.'))
    let rate: SampleRate
    try { rate = projectSampleRate(sampleRate) } catch (error) { return Promise.reject(error) }
    const next = normalizeAudioSettings(settings)
    this.cancelConfiguration()
    const request = this.configurationRequest
    if (cancelTransport) { this.lifecycle += 1; this.transportRequest += 1 }
    const lifecycle = this.lifecycle
    const current = () => request === this.configurationRequest && lifecycle === this.lifecycle
    const active = this.context
    if (active && this.bridge && !this.outputFault && active.state !== 'closed' && active.sampleRate === rate && contextKey(next) === contextKey(this.settings)) {
      this.settings = next
      this.desiredSampleRate = rate
      this.audioStatus = 'ready'
      this.audioError = null
      this.syncMonitoring()
      this.publishAudioState()
      return Promise.resolve()
    }
    this.audioStatus = 'configuring'
    this.audioError = null
    this.publishAudioState()
    const task = (async () => {
      let candidate: AudioContext | null = null
      let candidateBridge: RustEngineNode | null = null
      let candidateOutputError: Error | null = null
      const candidateError = () => { candidateOutputError = new Error('출력 장치를 시작하는 중 오류가 발생했습니다. 장치 연결과 스피커 권한을 확인해 주세요.') }
      try {
        if (typeof AudioContext === 'undefined') throw new Error('이 브라우저는 Web Audio를 지원하지 않습니다.')
        const options: AudioContextOptions & { renderSizeHint: RenderSizeHint } = { sampleRate: rate, latencyHint: next.latencyHint, renderSizeHint: next.renderSizeHint }
        candidate = new AudioContext(options)
        this.preparingContexts.add(candidate)
        candidate.addEventListener('error', candidateError)
        // The engine is the only renderer: without its module the candidate is closed with a clear error.
        const module = await requireEngineModule()
        if (!current()) throw configurationCancelled()
        const extras = candidate as AudioContext & ContextExtras
        if (candidate.sampleRate !== rate) throw new Error(`브라우저가 요청한 ${rate} Hz 대신 ${candidate.sampleRate} Hz를 선택했습니다.`)
        if (next.renderSizeHint !== 'default' && typeof extras.renderQuantumSize !== 'number') throw new Error('이 브라우저는 렌더 블록 크기 설정을 지원하지 않습니다. 기본값을 사용해 주세요.')
        if (next.outputDeviceId) {
          if (typeof extras.setSinkId !== 'function') throw new Error('이 브라우저는 출력 장치 선택을 지원하지 않습니다. 시스템 기본 출력을 사용해 주세요.')
          await extras.setSinkId(next.outputDeviceId)
          if (!current()) throw configurationCancelled()
        }
        if (candidate.state !== 'running') await candidate.resume()
        if (!current()) throw configurationCancelled()
        try { candidateBridge = await RustEngineNode.create(candidate, module) } catch (error) { throw message(error) === ENGINE_WORKLET_UNSUPPORTED ? error : new Error(engineStartFailed(message(error)), { cause: error }) }
        if (!current()) throw configurationCancelled()
        if (candidateOutputError) throw candidateOutputError
        if (candidate.state !== 'running') throw new Error('오디오 장치를 시작하지 못했습니다. 적용 버튼을 다시 눌러 주세요.')
        if (next.outputDeviceId && typeof extras.sinkId === 'string' && extras.sinkId !== next.outputDeviceId) throw new Error('브라우저의 실제 출력이 선택한 장치와 다릅니다. 출력 장치를 다시 선택해 주세요.')
        // No awaits after this point: publish the new context, then retire the old resources.
        const previous = this.context
        this.removeOutputListeners?.()
        this.removeOutputListeners = null
        this.releaseEngine()
        this.context = candidate
        this.settings = next
        this.desiredSampleRate = rate
        this.outputFault = null
        this.preparingContexts.delete(candidate)
        candidate.removeEventListener('error', candidateError)
        this.watchOutput(candidate, next.outputDeviceId)
        this.installEngine(candidateBridge, module)
        candidateBridge = null
        if (previous) { previous.onstatechange = null; this.closeContext(previous) }
        if (this.ticker === null) this.ticker = setInterval(() => this.tick(), TICK_INTERVAL_MS)
        this.levels.clear()
        this.masterLevel = 0
        this.audioStatus = 'ready'
        this.audioError = null
        this.publishSnapshot()
      } catch (error) {
        candidateBridge?.dispose()
        if (candidate) { candidate.removeEventListener('error', candidateError); this.preparingContexts.delete(candidate); this.closeContext(candidate) }
        if (!current()) throw configurationCancelled()
        this.audioStatus = 'error'
        this.audioError = message(error)
        this.publishAudioState()
        throw error
      }
    })().finally(() => { if (this.configurationTask === task) this.configurationTask = null })
    this.configurationTask = task
    return task
  }

  /** The new context's engine node: a fresh project sync (project.set), metronome strokes and monitoring. */
  private installEngine(bridge: RustEngineNode, module: WebAssembly.Module): void {
    this.bridge = bridge
    if (this.kernels?.sampleRate !== bridge.context.sampleRate) { this.kernels?.dispose(); this.kernels = new KernelHelper(module, bridge.context.sampleRate) }
    this.kernelKeys.clear()
    this.synced = null
    this.orders.clear()
    this.uploads.clear()
    this.syncedRevision = -1
    this.metronomeSent = ''
    this.monitoringKey = ''
    this.monitored = []
    this.status = emptyStatus()
    this.verdict = { accepted: false, reason: '아직 오디오 엔진에 프로젝트를 보내지 않았습니다.' }
    this.pushMetronome()
    this.scheduleSync()
  }

  /** Drops the engine nodes of the current context (a new context gets its own). */
  private releaseEngine(): void {
    if (this.syncTimer !== null) clearTimeout(this.syncTimer)
    this.syncTimer = null
    this.liveSource?.disconnect()
    this.liveSource = null
    this.disposeTaps()
    this.releaseAnalysis()
    this.preview?.dispose()
    this.preview = null
    this.bridge?.dispose()
    this.bridge = null
    this.synced = null
    this.uploads.clear()
    this.dynamics.clear()
  }

  private closeContext(context: AudioContext): void {
    if (context.state !== 'closed') void context.close().catch(() => undefined)
  }

  private cancelConfiguration(): void {
    this.configurationRequest += 1
    this.configurationTask = null
    for (const context of this.preparingContexts) this.closeContext(context)
    this.preparingContexts.clear()
  }

  /** No permission prompts: verify an explicit sink after device changes, and never substitute the default. */
  private watchOutput(context: AudioContext, selectedId: string): void {
    const devices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
    let disposed = false
    let enumeration = 0
    const current = () => !disposed && this.context === context
    const fail = (text: string) => { if (current()) this.blockOutput(context, text) }
    const sinkChanged = () => {
      if (!current()) return
      const sinkId = (context as AudioContext & ContextExtras).sinkId
      if (selectedId && typeof sinkId === 'string' && sinkId !== selectedId) {
        fail('브라우저의 실제 출력이 선택한 장치와 달라져 재생과 모니터링을 중지했습니다. 출력 장치를 다시 적용하거나 시스템 기본 출력을 선택해 주세요.')
      } else this.publishAudioState()
    }
    const deviceChanged = () => {
      if (!selectedId || !current() || !devices?.enumerateDevices) return
      const request = ++enumeration
      void devices.enumerateDevices().then(list => {
        if (!current() || request !== enumeration) return
        const outputs = list.filter(device => device.kind === 'audiooutput')
        if (outputs.some(device => device.deviceId === selectedId)) return
        // An absent ID can mean removal or revoked/redacted permission; do not claim physical removal.
        fail(outputs.length
          ? '선택한 출력 장치를 목록에서 확인할 수 없어 재생과 모니터링을 중지했습니다. 장치 연결·스피커 권한을 확인한 뒤 다시 적용하거나 시스템 기본 출력을 선택해 주세요.'
          : '브라우저가 출력 장치 목록을 제공하지 않아 선택한 출력의 연결을 확인할 수 없습니다. 재생과 모니터링을 중지했습니다. 스피커 권한을 확인한 뒤 다시 적용하거나 시스템 기본 출력을 선택해 주세요.')
      }).catch(() => {
        if (current() && request === enumeration) fail('출력 장치 변경 후 연결·권한을 확인하지 못해 재생과 모니터링을 중지했습니다. 출력 장치를 다시 적용하거나 시스템 기본 출력을 선택해 주세요.')
      })
    }
    const outputError = () => fail('출력 장치 오류로 재생과 모니터링을 중지했습니다. 장치 연결·스피커 권한을 확인한 뒤 출력 설정을 다시 적용해 주세요.')
    context.onstatechange = () => { if (current()) this.publishSnapshot() }
    context.addEventListener('sinkchange', sinkChanged)
    context.addEventListener('error', outputError)
    devices?.addEventListener?.('devicechange', deviceChanged)
    this.removeOutputListeners = () => {
      disposed = true
      enumeration += 1
      context.onstatechange = null
      context.removeEventListener('sinkchange', sinkChanged)
      context.removeEventListener('error', outputError)
      devices?.removeEventListener?.('devicechange', deviceChanged)
    }
  }

  /** Stops the transport and silences the engine (monitoring included) until a newly validated context replaces it. */
  private blockOutput(context: AudioContext, text: string): void {
    if (this.context !== context) return
    this.position = this.currentBeat()
    if (this.playing) this.bridge?.transport('pause')
    this.playing = false
    this.transportRequest += 1
    this.outputFault = text
    this.audioStatus = 'error'
    this.audioError = text
    this.liveSource?.disconnect()
    this.liveSource = null
    if (this.bridge) {
      if (this.monitored.length) { this.monitored = []; void this.bridge.monitor([]).catch(() => undefined) }
      this.monitoringKey = ''
      try { this.bridge.node.disconnect(context.destination) } catch { /* Already detached. */ }
    }
    this.preview?.dispose()
    this.preview = null
    this.levels.clear()
    this.masterLevel = 0
    this.publishSnapshot()
  }

  private readAudioState(): AudioState {
    const context = this.context
    const extras = context as (AudioContext & ContextExtras) | null
    const prototype = typeof AudioContext === 'undefined' ? undefined : AudioContext.prototype as AudioContext & ContextExtras
    const renderPrototype = typeof BaseAudioContext === 'undefined' ? undefined : BaseAudioContext.prototype as BaseAudioContext & ContextExtras
    return {
      status: this.audioStatus, contextState: context?.state ?? 'uninitialized', settings: this.settings,
      requestedSampleRate: this.desiredSampleRate, sampleRate: context?.sampleRate ?? null,
      baseLatency: context ? nonnegative(context.baseLatency) : null, outputLatency: nonnegative(extras?.outputLatency),
      sinkId: typeof extras?.sinkId === 'string' ? extras.sinkId : null,
      renderQuantumSize: typeof extras?.renderQuantumSize === 'number' && extras.renderQuantumSize > 0 ? extras.renderQuantumSize : null,
      supportsOutputSelection: typeof (extras ?? prototype)?.setSinkId === 'function',
      supportsRenderSize: extras ? typeof extras.renderQuantumSize === 'number' : !!renderPrototype && 'renderQuantumSize' in renderPrototype,
      needsReconfiguration: !!context && (!!this.outputFault || context.state === 'closed' || context.sampleRate !== this.desiredSampleRate),
      error: this.audioError,
    }
  }

  private publishAudioState(): void {
    const next = this.readAudioState()
    if (JSON.stringify(next) === JSON.stringify(this.audioSnapshot)) return
    this.audioSnapshot = next
    for (const listener of this.audioListeners) listener()
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
    for (const setId of this.sampleSets(project)) if (this.samples.status(setId) === 'idle') void this.preloadSamples(setId).catch(() => undefined)
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

  /** A compressor/limiter/gate insert's live reading from the engine's meter block. */
  readonly getDeviceMeter = (deviceId: string): DynamicsReading | null => this.dynamics.get(deviceId) ?? null

  setProject(source: Project): void {
    this.sourceProject = source
    // Frozen tracks play their cached render (core/freeze.ts); everything below sees that playback project.
    const project = playbackProject(source, this.assets)
    // A live edit can introduce an instrument this browser cannot play. Stop; the next Play explains why.
    if (this.playing && unsupportedWebAudioInstruments(project, this.vintage).length) this.pause()
    const beat = this.currentBeat()
    const rate = projectSampleRate(project.sampleRate)
    if (rate !== this.desiredSampleRate) {
      this.cancelConfiguration()
      this.lifecycle += 1
      this.transportRequest += 1
      if (this.playing) this.pause()
      this.desiredSampleRate = rate
      this.audioStatus = this.outputFault ? 'error' : this.context ? 'ready' : 'idle'
      this.audioError = this.outputFault
    }
    this.project = project
    this.position = clamp(beat, 0, project.lengthBeats)
    this.preloadProjectSamples(project)
    this.markDirty()
    this.publishSnapshot()
  }

  setAssets(assets: Map<string, AudioAsset>): void {
    const changed = assets.size !== this.assets.size || [...assets].some(([id, asset]) => this.assets.get(id)?.buffer !== asset.buffer)
    this.assets = new Map(assets)
    // A freeze cache arriving or leaving switches its track between the cached render and live playback.
    if (changed && this.sourceProject?.tracks.some(track => track.freeze)) { this.setProject(this.sourceProject); return }
    if (changed) this.markDirty()
  }

  private markDirty(): void {
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
    const sets = this.sampleSets(project)
    try {
      for (const id of referenced) {
        const asset = this.assets.get(id)
        if (!asset) return reject(`오디오 자산을 찾을 수 없습니다: ${id}`)
        await this.uploads.put(bridge, id, asset.buffer)
        metadata.set(id, pcmMetadata(id, asset.buffer))
      }
      // Sampled instruments: the decoded sets, registered as the desktop host does.
      for (const setId of sets) {
        await this.preloadSamples(setId)
        if (bridge !== this.bridge) return
        const loaded = this.samples.get(setId)
        if (!loaded) return reject(`샘플 세트를 불러오지 못했습니다: ${setId}`)
        await this.uploads.putSet(bridge, setId, loaded, referenced)
      }
      this.uploads.prune(bridge, referenced, sets)
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
    if (!accepted) this.note(`프로젝트를 재생할 수 없습니다: ${reason}`)
    if (changed) this.syncMonitoring()
    // An edit the engine refuses while playing stops the transport where it was heard; Play then says why.
    if (changed && !accepted && this.playing) this.pause()
  }

  /** The engine renders the current project now. */
  private engineReady(): boolean {
    return !!this.bridge && !this.bridge.error && this.bridge.context === this.context && this.verdict.accepted && !this.outputFault
  }

  /** Graph index of a track in the engine's current graph (the last accepted timeline), or -1. */
  private trackIndex(trackId: string): number {
    return this.synced ? this.synced.tracks.findIndex(track => track.id === trackId) : -1
  }

  async resume(): Promise<void> {
    if (this.configurationTask) await this.configurationTask
    if (this.outputFault) throw new Error(this.audioError ?? this.outputFault)
    if (!this.context || !this.bridge || this.context.state === 'closed' || this.context.sampleRate !== this.desiredSampleRate) {
      await this.configureAudio(this.settings, this.desiredSampleRate, false)
    }
    const context = this.context
    if (!context) throw new Error('오디오 장치를 시작하지 못했습니다.')
    const lifecycle = this.lifecycle
    if (context.state !== 'running') await context.resume()
    if (lifecycle !== this.lifecycle || context !== this.context) return
    if (context.state !== 'running') throw new Error('오디오를 시작하려면 재생 버튼을 다시 눌러 주세요.')
    this.publishSnapshot()
  }

  /** A cancellable, bounded test of the currently applied output device. */
  async testOutput(signal: AbortSignal): Promise<void> {
    await playOutputTest(async () => {
      await this.resume()
      if (!this.context) throw new Error('오디오 장치를 시작하지 못했습니다.')
      return this.context
    }, signal)
  }

  /** A second toggle cancels even when the first play is still opening the device. */
  async togglePlayback(): Promise<void> {
    if (this.playing || this.pendingPlayRequest === this.transportRequest) this.pause()
    else await this.play()
  }

  /** A project whose vintage instruments wait for the engine module (fetched once per page) before the support check. */
  private awaitsModule(project: Project): boolean {
    return moduleState !== 'ready' && typeof WebAssembly !== 'undefined' && unsupportedWebAudioInstruments(project, this.vintage).length > 0
  }

  async play(options: PlayOptions = {}): Promise<void> {
    if (!this.project) throw new Error('재생할 프로젝트가 없습니다.')
    if (this.awaitsModule(this.project)) await loadEngineModule()
    assertWebAudioProjectSupported(this.project, this.vintage)
    const request = ++this.transportRequest
    const lifecycle = this.lifecycle
    this.pendingPlayRequest = request
    const current = () => request === this.transportRequest && lifecycle === this.lifecycle
    try {
      await this.resume()
      if (!current() || !this.context || !this.project || this.playing) return
      await this.syncNow()
      if (!current() || !this.context || !this.project || this.playing) return
      // Project edits may land while a device permission/configuration promise is pending.
      assertWebAudioProjectSupported(this.project, this.vintage)
      if (this.outputFault) throw new Error(this.audioError ?? this.outputFault)
      if (!this.engineReady()) throw new Error(engineRefused(this.verdict.reason))
      const bridge = this.bridge!, project = this.project, context = this.context
      let beat = normalizedStart(project, this.position)
      if (!loopRange(project) && beat >= project.lengthBeats) beat = 0
      this.position = beat
      bridge.transport('seek', Math.round(tempoMapOf(project).frameAt(beat, project.sampleRate)))
      // A count-in is a scheduled start in the engine: it clicks at the tempo and meter where the
      // transport starts (meter-map accents, the chosen sound), then the transport starts on the next frame.
      const countIn = Math.round(countInBeats(meterMapOf(project).meterAt(beat), options.countInBars ?? 0) * 60 / tempoMapOf(project).bpmAt(beat) * context.sampleRate)
      this.transportSeq = countIn > 0 ? bridge.transport('countIn', countIn) : bridge.transport('play')
      this.playing = true
      this.publishSnapshot()
      // Resolve on the downbeat, so a recording starts its capture with the music.
      if (countIn > 0) await this.waitForDownbeat(request)
    } finally {
      // A cancelled play may settle after a newer play has already taken ownership.
      if (this.pendingPlayRequest === request) this.pendingPlayRequest = null
    }
  }

  /** Waits until the engine has applied the count-in and left it (or the play was cancelled). */
  private async waitForDownbeat(request: number): Promise<void> {
    const limit = performance.now() + 130_000
    while (this.playing && request === this.transportRequest && performance.now() < limit) {
      const status = this.poll()
      if (status.appliedSeq >= this.transportSeq && !status.countingIn) return
      await new Promise(resolve => setTimeout(resolve, 4))
    }
  }

  pause(): void {
    this.transportRequest += 1
    if (this.playing) {
      const beat = this.engineBeat()
      this.bridge?.transport('pause')
      this.position = beat
    }
    this.playing = false
    this.publishSnapshot()
  }

  stop(): void {
    this.transportRequest += 1
    if (this.playing) this.bridge?.transport('stop')
    this.playing = false
    this.position = 0
    this.publishSnapshot()
  }

  seek(beat: number): void {
    if (!this.project) return
    const project = this.project
    this.position = clamp(beat, 0, project.lengthBeats)
    if (this.playing && this.bridge) this.transportSeq = this.bridge.transport('seek', Math.round(tempoMapOf(project).frameAt(this.position, project.sampleRate)))
    this.publishSnapshot()
  }

  /** The engine clicks the metronome after its master (strokes sent once per sound/rate). */
  setMetronome(state: MetronomeEngineState): void {
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

  /** Routes a live input stream into the given audio tracks (the engine's input 0); no context is opened without a stream. */
  setInputMonitor(stream: MediaStream | null, trackIds: readonly string[]): void {
    this.liveStream = stream
    this.monitorTracks = stream ? [...trackIds] : []
    if (stream) this.observeInputStream(stream)
    this.syncMonitoring()
  }

  /** Monitor gates of routed tracks (track/master inputs); these need no microphone stream. */
  setRouteMonitor(trackIds: readonly string[]): void {
    this.routeMonitorTracks = [...trackIds]
    this.syncMonitoring()
  }

  /** Monitoring through the engine: its live input is the stream, its route inputs the source taps. */
  private syncMonitoring(): void {
    const bridge = this.bridge
    if (!bridge || this.outputFault) return
    const ready = this.engineReady()
    const software = this.settings.softwareMonitoring
    const stream = ready && software && this.liveStream?.active ? this.liveStream : null
    if (stream && this.monitorTracks.length) {
      if (this.liveSource?.mediaStream !== stream || this.liveSource.context !== bridge.context) {
        this.liveSource?.disconnect()
        this.liveSource = bridge.context.createMediaStreamSource(stream)
        this.liveSource.connect(bridge.node, 0, 0)
      }
    } else if (this.liveSource) {
      this.liveSource.disconnect()
      this.liveSource = null
    }
    const live = stream ? this.monitorTracks : []
    const indices = ready ? [...new Set([...live, ...this.routeMonitorTracks].map(id => this.trackIndex(id)).filter(index => index >= 0))].sort((a, b) => a - b) : []
    const key = `${this.synced?.revision ?? 0}:${indices.join(',')}`
    if (key === this.monitoringKey) return
    this.monitoringKey = key
    this.monitored = indices
    void bridge.monitor(indices).catch(error => this.note(`모니터링을 설정하지 못했습니다: ${message(error)}`))
  }

  /** Loads the route recorder processor ahead of the take, so capture starts with the transport. */
  async prepareRouteRecording(): Promise<void> {
    await this.resume()
    if (this.context) await prepareRouteRecorder(this.context)
  }

  /**
   * Records routed tracks (any number up to the engine's tap slots, no MediaRecorder): each take records its
   * track's route input from the engine's tap output (output 1, a stereo slot per take), clocked by the engine's
   * transport. Must be created while the transport plays.
   */
  createRouteRecordings(trackIds: readonly string[], callbacks: TakeCallbacks): RouteRecordings {
    const bridge = this.bridge, context = this.context
    if (!context || context.state === 'closed' || !bridge) throw new Error('오디오 장치를 먼저 시작해 주세요.')
    if (!this.engineReady()) throw new Error(engineRefused(this.verdict.reason))
    if (trackIds.length > TAP_CHANNELS / 2) throw new Error(`트랙 입력은 한 번에 ${TAP_CHANNELS / 2}개까지 녹음할 수 있습니다.`)
    const host: RouteRecordingHost = {
      context,
      attach: (trackId, node) => {
        const free = this.tapSlots.indexOf(null)
        const slot = free >= 0 ? free : this.tapSlots.length
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

  /** Browsers do not name input channels; choices are numbered from the stream (or the requested count). */
  getInputChoices(): InputChoice[] {
    return numberedInputChoices(this.inputChannelCount ?? (this.settings.inputChannels === 'default' ? 0 : this.settings.inputChannels))
  }

  /** Records the live stream's channel count so track input choices match what the browser delivers. */
  observeInputStream(stream: MediaStream): void {
    const count = stream.getAudioTracks?.()[0]?.getSettings?.().channelCount
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count === this.inputChannelCount) return
    this.inputChannelCount = count
    for (const listener of this.audioListeners) listener()
  }

  /**
   * A short audition. With a track, the note is a live event through that track's instrument and chain in
   * the engine; a library preview (no track) plays on a small preview engine of its own.
   */
  async previewNote(instrument: InstrumentId, pitch: number, velocity = 0.8, trackId?: string): Promise<void> {
    const lifecycle = this.lifecycle
    const def = instrumentDef(instrument)
    if (def.kind === 'vintage' && moduleState !== 'ready' && typeof WebAssembly !== 'undefined') await loadEngineModule()
    if (!canPlayInstrument(this, instrument)) throw new Error(instrumentUnavailableReason(this, instrument))
    await this.resume()
    if (def.set) await this.preloadSamples(def.set)
    if (lifecycle !== this.lifecycle || !this.context || this.outputFault) return
    const track = trackId === undefined ? undefined : this.project?.tracks.find(item => item.id === trackId)
    // Do not audition a stale instrument through a track that changed (or was removed)
    // while output/sample preparation was pending. Library previews have no trackId.
    if (trackId !== undefined && (!track || track.kind !== 'instrument' || track.instrument !== instrument || !isTrackEnabled(track))) return
    const live = trackNote(track, pitch, velocity)
    if (!live) return
    const seconds = instrument === 'pad' || def.kind === 'sampled' ? LONG_PREVIEW_SECONDS : PREVIEW_SECONDS
    if (track) {
      await this.syncNow()
      if (lifecycle !== this.lifecycle) return
      if (!this.engineReady()) throw new Error(engineRefused(this.verdict.reason))
      this.engineVoice(track.id, live.pitch, live.velocity, seconds)
      return
    }
    const preview = await this.previewEngine()
    if (!preview || lifecycle !== this.lifecycle) return
    await preview.play(instrument, def.set ? this.samples.get(def.set) : undefined, live.pitch, live.velocity, seconds)
  }

  private async previewEngine(): Promise<PreviewEngine | null> {
    const context = this.context, bridge = this.bridge
    if (!context || !bridge) return null
    if (this.preview?.bridge.context === context && !this.preview.bridge.error) return this.preview
    this.preview?.dispose()
    this.preview = null
    const module = await requireEngineModule()
    const node = await RustEngineNode.create(context, module)
    if (this.context !== context || this.outputFault) { node.dispose(); return null }
    this.preview = new PreviewEngine(node)
    return this.preview
  }

  /** A note through the engine's track (live event path); null when the engine does not render that track. */
  private engineVoice(trackId: string, pitch: number, velocity: number, seconds?: number): LiveVoiceHandle | null {
    const bridge = this.bridge, index = this.trackIndex(trackId)
    const track = this.synced?.tracks[index]
    if (!bridge || !this.engineReady() || index < 0 || !track || track.source.kind === 'audio') return null
    const id = ++this.liveNoteId
    bridge.live(index, 'noteOn', pitch, clamp(velocity, 0, 1), id)
    const release = () => { bridge.live(index, 'noteOff', pitch, 0, id) }
    if (seconds !== undefined) setTimeout(release, seconds * 1000)
    return { release }
  }

  /** Live MIDI and computer-keyboard notes: through the engine's track, released by their note-off. */
  private startLiveNote(trackId: string, pitch: number, velocity: number): LiveVoiceHandle | null {
    const context = this.context
    const track = this.project?.tracks.find(item => item.id === trackId)
    if (!context || this.outputFault || !track || track.kind !== 'instrument' || !isTrackEnabled(track)) return null
    if (context.state !== 'running') { void context.resume().catch(() => undefined); return null }
    const def = instrumentDef(track.instrument)
    if (def.set && this.samples.status(def.set) !== 'ready') { void this.preloadSamples(def.set).catch(() => undefined); return null }
    return this.engineVoice(trackId, pitch, velocity)
  }

  /** A live controller (CCs; the sustain pedal is handled by WebLiveMidi) on the track's instrument. */
  private liveControl(trackId: string, key: ControllerKey, value: number): void {
    const index = this.trackIndex(trackId)
    if (!this.bridge || !this.engineReady() || index < 0 || !key.startsWith('cc')) return
    const controller = Number(key.slice(2))
    if (Number.isInteger(controller)) this.bridge.live(index, 'control', controller, value)
  }

  /** Transport beat the listener heard at `timeMs` (performance.now base): the output timestamp folds in output latency. */
  private heardBeatAt(timeMs: number): number | null {
    const context = this.context, project = this.project
    if (!this.playing || !context || !project) return null
    const stamp = typeof context.getOutputTimestamp === 'function' ? context.getOutputTimestamp() : undefined
    const latency = (context as AudioContext & ContextExtras).outputLatency ?? 0
    const contextTime = stamp && typeof stamp.contextTime === 'number' && typeof stamp.performanceTime === 'number' && stamp.performanceTime > 0
      ? stamp.contextTime + (timeMs - stamp.performanceTime) / 1000
      : context.currentTime - (performance.now() - timeMs) / 1000 - (context.baseLatency ?? 0) - latency
    const status = this.poll()
    if (status.countingIn) return null
    const frame = status.frame + (contextTime * context.sampleRate - status.contextFrame)
    return clamp(tempoMapOf(project).beatAtFrame(Math.max(0, frame), project.sampleRate), 0, project.lengthBeats)
  }

  async decodeAsset(blob: Blob, name: string, id?: string): Promise<AudioAsset> {
    if (blob.size === 0) throw new Error('비어 있는 오디오 파일입니다.')
    // File decoding must not open an output device or request a saved output-device permission.
    const context = this.decodeContext?.sampleRate === this.desiredSampleRate ? this.decodeContext
      : (this.decodeContext = new OfflineAudioContext(1, 1, this.desiredSampleRate))
    const owned = await ownAudioBytes(blob, name)
    let buffer: AudioBuffer
    try {
      buffer = await context.decodeAudioData(owned.bytes)
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
      name, blob: owned.blob, buffer, peaks,
    }
  }

  /** Exports the entire arrangement once; the audition loop is deliberately ignored. */
  async exportWav(project: Project = this.requireProject()): Promise<Blob> {
    return (await this.renderAudio(project, { bitDepth: 16 })).blob
  }

  async renderTail(project: Project): Promise<number> {
    return Math.min(30, renderTailSeconds(playbackProject(project, this.assets)))
  }

  /** Offline render on the engine in a Worker (export, bounce, freeze, stems; docs/BOUNCE_FREEZE_STEMS.md). */
  async renderAudio(source: Project, options: RenderOptions): Promise<RenderedAudio> {
    const project = playbackProject(source, this.assets)
    if (this.awaitsModule(project)) await loadEngineModule()
    assertWebAudioProjectSupported(project, this.vintage)
    const module = await requireEngineModule()
    const sampleRate = projectSampleRate(project.sampleRate)
    const metadata = new Map<string, NativePcmAsset>()
    const assets: EngineRenderAsset[] = []
    const sampleSets: string[] = []
    for (const setId of this.sampleSets(project)) {
      try { await this.preloadSamples(setId) } catch (error) {
        throw new Error(`샘플 악기 "${setId}"를 불러오지 못했습니다: ${message(error)}`, { cause: error })
      }
      const loaded = this.samples.get(setId)
      if (!loaded) throw new Error(`샘플 악기 "${setId}"를 불러오지 못했습니다.`)
      for (const [file, buffer] of loaded.buffers) {
        const pcm = packAudioBuffer(buffer)
        assets.push({ id: sampleAssetId(setId, file), sampleRate: pcm.sampleRate, channels: pcm.channels, samples: new Float32Array(pcm.data.buffer, pcm.data.byteOffset, pcm.frames * pcm.channels) })
      }
      sampleSets.push(sampleSetJson(setId, loaded))
    }
    for (const id of referencedAssets(project)) {
      const asset = this.assets.get(id)
      if (!asset) throw new Error(`오디오 자산을 찾을 수 없습니다: ${id}`)
      metadata.set(id, pcmMetadata(id, asset.buffer))
      // One interleaved copy per export, transferred to the worker (which frees it once the module has it).
      const pcm = packAudioBuffer(asset.buffer)
      assets.push({ id, sampleRate: pcm.sampleRate, channels: pcm.channels, samples: new Float32Array(pcm.data.buffer, pcm.data.byteOffset, pcm.frames * pcm.channels) })
    }
    const timeline = compileNativeTimeline(project, metadata)
    if (timeline.lengthFrames > sampleRate * 60 * 15) throw new Error('이 초기 버전은 한 번에 최대 15분까지 WAV로 내보낼 수 있습니다. 프로젝트 길이를 줄여 주세요.')
    const encoded = encodeTracks(timeline.tracks)
    let result
    try {
      result = await renderInEngineWorker(module, {
        timeline: utf8Encode(JSON.stringify({ ...timeline, tracks: encoded.tracks })), binary: encoded.binary ?? undefined,
        sampleRate, lengthFrames: timeline.lengthFrames, assets, sampleSets,
        tailSeconds: options.tailSeconds === undefined ? undefined : Math.min(30, Math.max(0, options.tailSeconds)),
        startFrame: options.startFrame,
        // Stems and freeze: pre-master, like the C++ host's setMasterBypass.
        masterBypass: !!options.preMaster,
      })
    } catch (error) {
      if (error instanceof GarakEngineError) throw new Error(`오디오 엔진이 이 프로젝트를 렌더하지 못했습니다: ${error.message}`, { cause: error })
      throw error
    }
    this.lastRender = { renderMs: result.renderMs, frames: result.frames, preMaster: !!options.preMaster }
    return { blob: encodeWav([result.left, result.right], sampleRate, options.bitDepth), sampleRate, frames: result.frames, tailSeconds: result.tailSeconds, trackTailSeconds: trackTailSeconds(project) }
  }

  dispose(): void {
    this.cancelConfiguration()
    this.removeOutputListeners?.()
    this.removeOutputListeners = null
    this.lifecycle += 1
    this.transportRequest += 1
    this.playing = false
    this.position = 0
    if (this.ticker !== null) clearInterval(this.ticker)
    this.ticker = null
    this.releaseEngine()
    this.kernels?.dispose()
    this.kernels = null
    this.liveStream = null
    this.monitorTracks = []
    const context = this.context
    this.context = null
    if (context) {
      context.onstatechange = null
      if (context.state !== 'closed') void context.close().catch(() => undefined)
    }
    this.levels.clear()
    this.masterLevel = 0
    this.audioStatus = 'idle'
    this.audioError = null
    this.outputFault = null
    this.publishSnapshot()
    this.listeners.clear()
    this.audioListeners.clear()
  }

  private requireProject(): Project {
    if (!this.project) throw new Error('프로젝트가 아직 준비되지 않았습니다.')
    return this.project
  }

  private currentBeat(): number {
    return this.playing ? this.engineBeat() : this.position
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
  private engineBeat(): number {
    const project = this.project
    if (!project) return this.position
    const status = this.poll()
    if (status.appliedSeq < this.transportSeq) return this.position
    return clamp(tempoMapOf(project).beatAtFrame(status.frame, project.sampleRate), 0, project.lengthBeats)
  }

  private tick(): void {
    if (!this.context) return
    const now = performance.now()
    if (now - this.lastAnalysisSync >= ANALYSIS_SYNC_MS) {
      this.lastAnalysisSync = now
      this.syncAnalysis()
    }
    if (now - this.lastSnapshotTime >= SNAPSHOT_INTERVAL_MS) {
      this.lastSnapshotTime = now
      this.readMeters()
    }
    this.publishSnapshot()
  }

  /**
   * Analysis taps follow the editors that are open: the devices whose spectrum, stereo scope or tuner was
   * looked up recently (devices/effects/analysis.ts, devices/guitar-rig/tuner.ts) become engine taps, and
   * each streamed tap is registered for its editor. Nothing is requested while no editor looks.
   */
  private syncAnalysis(): void {
    const bridge = this.bridge, synced = this.synced
    if (!bridge || !synced || !this.engineReady() || bridge.error) { this.releaseAnalysis(); return }
    const address = (deviceId: string): [number, number] | null => {
      for (let track = 0; track < synced.tracks.length; track += 1) {
        const insert = synced.tracks[track].inserts.findIndex(item => item.id === deviceId)
        if (insert >= 0) return [track, insert]
      }
      return null
    }
    const wanted: { id: string; track: number; insert: number; tuner: boolean }[] = []
    for (const [ids, tuner] of [[requestedDeviceAnalysis(), false], [requestedGuitarTuners(), true]] as const) {
      for (const id of ids) {
        const at = address(id)
        if (at && wanted.length < ANALYSIS_SLOTS) wanted.push({ id, track: at[0], insert: at[1], tuner })
      }
    }
    const key = wanted.map(item => `${item.id}:${item.track}:${item.insert}:${item.tuner ? 1 : 0}`).join(',')
    if (key === this.analysisKey) return
    this.releaseAnalysis()
    if (!wanted.length) return
    this.analysisKey = key
    void bridge.analysis(wanted.map(({ track, insert, tuner }) => ({ track, insert, tuner })))
      .catch(error => { this.note(`분석 신호를 요청하지 못했습니다: ${message(error)}`); this.releaseAnalysis() })
    const rate = bridge.context.sampleRate
    wanted.forEach((item, slot) => {
      const source = new BridgeAnalysisSource(bridge, slot)
      if (item.tuner) {
        // The tuner window of the 0.3.2 rig analyser: 4096 frames, 8192 above 50 kHz.
        const tap = { analyser: new EngineAnalyser(source, rate > 50000 ? 8192 : 4096, 'mono'), sampleRate: rate }
        registerGuitarTunerTap(item.id, tap)
        this.analysisRelease.push(() => unregisterGuitarTunerTap(tap))
      } else {
        // The spectrum reads a 4096-point mono analyser; the utility's scope reads 1024 frames per side.
        const tap: StereoScopeTap = {
          analyser: new EngineAnalyser(source, 4096, 'mono'), sampleRate: rate,
          left: new EngineAnalyser(source, 1024, 'left'), right: new EngineAnalyser(source, 1024, 'right'),
        }
        this.analysisRelease.push(registerDeviceAnalysis(item.id, tap))
      }
    })
  }

  private releaseAnalysis(): void {
    for (const release of this.analysisRelease) release()
    this.analysisRelease = []
    if (this.analysisKey && this.bridge && !this.bridge.error) void this.bridge.analysis([]).catch(() => undefined)
    this.analysisKey = ''
  }

  /** Track and dynamics meters from the engine (peaks per graph track, readings per insert). */
  private readMeters(): void {
    if (!this.bridge || !this.engineReady() || this.context?.state !== 'running') { this.levels.clear(); this.masterLevel = 0; this.dynamics.clear(); return }
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

  private publishSnapshot(): void {
    if (this.playing && this.bridge) {
      const status = this.poll()
      if (status.appliedSeq >= this.transportSeq && !status.playing) {
        // The engine reached the project end (no cycle): tails ring out, the transport rests there.
        this.playing = false
        this.position = this.project?.lengthBeats ?? this.position
      }
    }
    this.publishAudioState()
    const next: TransportSnapshot = {
      playing: this.playing,
      beat: Math.round(this.currentBeat() * 10000) / 10000,
      ready: this.context?.state === 'running' && !this.outputFault,
      sampleRate: this.context?.sampleRate ?? 0,
    }
    if (next.playing === this.snapshot.playing && next.beat === this.snapshot.beat && next.ready === this.snapshot.ready && next.sampleRate === this.snapshot.sampleRate) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}

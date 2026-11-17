import { instrumentDef } from '../core/instruments'
import { DEFAULT_AUDIO_SETTINGS, DEFAULT_SAMPLE_RATE, normalizeAudioSettings, projectSampleRate, type AudioSettings, type AudioState, type RenderSizeHint, type SampleRate } from '../core/audioSettings'
import { audibleTrackIds, isTrackEnabled, trackNote } from '../core/playback'
import type { AudioAsset, AudioEngine, InputChoice, InstrumentId, Project, RenderOptions, RenderedAudio, SampleAttribution, SampleStatus, TransportSnapshot, VintageBridge } from '../core/types'
import { playbackProject } from '../core/freeze'
import { encodeWav } from './wavEncode'
import { numberedInputChoices } from '../core/trackInputs'
import {
  applyControl, connectMonitor, createGraph, disconnectMonitor, disposeGraph, renderTailSeconds, trackTailSeconds, resetAutomationState, rmsLevel, scheduleAutomation, scheduleInstrument, scheduleRange, scheduleSampled,
  setRouteMonitoring, stopTrackVoices, trackLayoutKey, updateEffectTempo, updateGraph,
} from './graph'
import { diffArrangement, type TrackChange } from './arrangementDiff'
import { hasActiveAutomation } from '../core/automation'
import type { EngineGraph } from './graph'
import { clamp, loopRange, normalizedStart, positionAfter } from './math'
import { tempoMapOf } from '../core/tempoMap'
import { SampleLibrary } from './samples'
import { ownAudioBytes } from './assetBytes'
import { playOutputTest } from './OutputTest'
import { assertWebAudioProjectSupported, unsupportedWebAudioInstruments, WAVETABLE_HOST_REQUIRED } from './instrumentSupport'
import { prepareEffects } from './effectPreparation'
import { loadVintageWasm, subscribeVintageWasm, vintageWasmStatus, vintageWorkletSupported, VINTAGE_WEB_UNAVAILABLE } from '../devices/vintage/availability'
import { flushVintage, prepareVintage } from '../devices/vintage/web'
import { assertGuitarRigHealthy } from '../devices/guitar-rig'
import { prepareRouteRecorder, RouteRecordings, type RouteRecordingHost } from './RouteRecording'
import type { TakeCallbacks } from '../core/recording'
import { WebMetronome } from './webMetronome'
import type { MetronomeEngineState, PlayOptions } from '../core/metronome'
import { WebLiveMidi, type LiveVoiceHandle } from './liveMidi'
import { heardTransportBeat, LIVE_NOTE_HOLD_SECONDS } from '../core/midiRecording'
import { paramValue } from '../core/devices'

const SCHEDULER_INTERVAL_MS = 25
const LOOKAHEAD_SECONDS = 0.12
const START_LEAD_SECONDS = 0.025
const SNAPSHOT_INTERVAL_MS = 40

type ContextExtras = {
  setSinkId?: (sinkId: string) => Promise<void>
  sinkId?: string | { type: string }
  outputLatency?: number
  renderQuantumSize?: number
}
const nonnegative = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const configurationCancelled = () => new DOMException('오디오 설정 요청이 취소되었습니다.', 'AbortError')
const contextKey = (settings: AudioSettings): string => JSON.stringify([settings.outputDeviceId, settings.latencyHint, settings.renderSizeHint])

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
  /** 옥구슬 EP / 한밤 106 run from the Rust core compiled to WASM (no TypeScript fallback). */
  readonly vintage: VintageBridge = {
    available: () => vintageWasmStatus() === 'ready' && vintageWorkletSupported(),
    reason: () => vintageWasmStatus() === 'ready' ? '' : vintageWasmStatus() === 'loading' || vintageWasmStatus() === 'idle' ? 'Rust 오디오 코어(WASM)를 불러오는 중입니다.' : VINTAGE_WEB_UNAVAILABLE,
    subscribe: listener => { void loadVintageWasm(); return subscribeVintageWasm(listener) },
  }
  /** One MediaRecorder per take; a browser records the chosen track only. */
  readonly maxSimultaneousRecordings = 1
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
  private pendingPlayRequest: number | null = null
  private monitorStream: MediaStream | null = null
  private monitorSource: MediaStreamAudioSourceNode | null = null
  private monitorTrackIds: string[] = []
  /** Channel routes last wired for monitoring; a track input change rewires without a new stream. */
  private monitorRoutes = ''
  /** Routed tracks whose internal input is heard (docs/TRACK_INPUT_ROUTING.md); independent of any mic stream. */
  private routeMonitorIds: string[] = []
  /** Route recorders and the track input each listens to; rewired to every replacement graph. */
  private routeRecorders = new Map<AudioNode, string>()
  /** Channels of the last live input stream; null until a stream has been seen. */
  private inputChannelCount: number | null = null
  private snapshot: TransportSnapshot = { playing: false, beat: 0, ready: false, sampleRate: 0 }
  private settings: AudioSettings
  private desiredSampleRate: SampleRate = DEFAULT_SAMPLE_RATE
  private audioStatus: AudioState['status'] = 'idle'
  private audioError: string | null = null
  private audioSnapshot: AudioState
  private audioListeners = new Set<() => void>()
  private configurationRequest = 0
  private configurationTask: Promise<void> | null = null
  private preparingContexts = new Set<AudioContext>()
  private outputFault: string | null = null
  private removeOutputListeners: (() => void) | null = null
  /** Monitor-only clicks on the audio clock; never part of the graph, recordings or export. */
  private readonly metronome = new WebMetronome()
  /** Live MIDI from Web MIDI inputs and the computer keyboard (docs/MIDI_RECORDING.md). */
  readonly liveMidi = new WebLiveMidi({ startNote: (trackId, pitch, velocity) => this.startLiveNote(trackId, pitch, velocity), beatAt: time => this.heardBeatAt(time),
    control: (trackId, key, value) => { const controls = this.graph?.tracks.get(trackId)?.controls; if (controls && this.context) applyControl(controls, key, value, this.context.currentTime) } })

  constructor(project?: Project, settings: AudioSettings = DEFAULT_AUDIO_SETTINGS) {
    this.settings = normalizeAudioSettings(settings)
    this.audioSnapshot = this.readAudioState()
    // Notes of a set that arrived mid-playback were skipped; rescheduling from the
    // current beat picks them up at the cost of one small restart.
    this.samples.subscribe((_, status) => {
      if (status === 'ready' && this.playing) this.restartAt(this.currentBeat())
    })
    if (project) this.setProject(project)
  }

  readonly getAudioState = (): AudioState => this.audioSnapshot

  readonly subscribeAudioState = (callback: () => void): (() => void) => {
    this.audioListeners.add(callback)
    return () => { this.audioListeners.delete(callback) }
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
    if (active && !this.outputFault && active.state !== 'closed' && active.sampleRate === rate && contextKey(next) === contextKey(this.settings)) {
      this.settings = next
      this.desiredSampleRate = rate
      this.audioStatus = 'ready'
      this.audioError = null
      this.wireMonitor()
      this.publishAudioState()
      return Promise.resolve()
    }
    this.audioStatus = 'configuring'
    this.audioError = null
    this.publishAudioState()
    const task = (async () => {
      let candidate: AudioContext | null = null
      let candidateGraph: EngineGraph | null = null
      let candidateMonitor: MediaStreamAudioSourceNode | null = null
      let candidateOutputError: Error | null = null
      const candidateError = () => { candidateOutputError = new Error('출력 장치를 시작하는 중 오류가 발생했습니다. 장치 연결과 스피커 권한을 확인해 주세요.') }
      try {
        if (typeof AudioContext === 'undefined') throw new Error('이 브라우저는 Web Audio를 지원하지 않습니다.')
        const options: AudioContextOptions & { renderSizeHint: RenderSizeHint } = { sampleRate: rate, latencyHint: next.latencyHint, renderSizeHint: next.renderSizeHint }
        candidate = new AudioContext(options)
        this.preparingContexts.add(candidate)
        candidate.addEventListener('error', candidateError)
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
        // Load all built-in worklets once per context. Later graph edits are synchronous.
        await prepareEffects(candidate)
        // The vintage instruments' worklet + Rust core (never throws; unavailable keeps them silent).
        await prepareVintage(candidate)
        if (!current()) throw configurationCancelled()
        if (candidateOutputError) throw candidateOutputError
        if (candidate.state !== 'running') throw new Error('오디오 장치를 시작하지 못했습니다. 적용 버튼을 다시 눌러 주세요.')
        if (next.outputDeviceId && typeof extras.sinkId === 'string' && extras.sinkId !== next.outputDeviceId) throw new Error('브라우저의 실제 출력이 선택한 장치와 다릅니다. 출력 장치를 다시 선택해 주세요.')
        if (this.project) {
          candidateGraph = createGraph(candidate, this.project)
          candidateGraph.gate.gain.value = 0
          this.wireRoutes(candidateGraph)
          if (next.softwareMonitoring && this.monitorStream?.active && this.monitorTrackIds.length) {
            candidateMonitor = candidate.createMediaStreamSource(this.monitorStream)
            connectMonitor(candidateGraph, candidateMonitor, this.monitorTrackIds, this.monitorInputs())
          }
        }
        if (!current()) throw configurationCancelled()
        // No awaits after this point: publish the new context, then retire the old resources.
        const previous = this.context
        this.removeOutputListeners?.()
        this.removeOutputListeners = null
        if (this.graph) disposeGraph(this.graph)
        this.monitorSource?.disconnect()
        for (const [graph, timeout] of this.retiredGraphs) { clearTimeout(timeout); disposeGraph(graph) }
        this.retiredGraphs.clear()
        this.context = candidate
        this.graph = candidateGraph
        this.monitorSource = candidateMonitor
        this.settings = next
        this.desiredSampleRate = rate
        this.outputFault = null
        this.preparingContexts.delete(candidate)
        candidate.removeEventListener('error', candidateError)
        this.watchOutput(candidate, next.outputDeviceId)
        if (candidateGraph) candidateGraph.gate.gain.setValueAtTime(1, candidate.currentTime)
        if (previous) { previous.onstatechange = null; this.closeContext(previous) }
        if (this.scheduler === null) this.scheduler = setInterval(() => this.tick(), SCHEDULER_INTERVAL_MS)
        this.levels.clear()
        this.masterLevel = 0
        this.audioStatus = 'ready'
        this.audioError = null
        this.publishSnapshot()
      } catch (error) {
        candidateMonitor?.disconnect()
        if (candidateGraph) disposeGraph(candidateGraph)
        if (candidate) { candidate.removeEventListener('error', candidateError); this.preparingContexts.delete(candidate); this.closeContext(candidate) }
        if (!current()) throw configurationCancelled()
        this.audioStatus = 'error'
        this.audioError = error instanceof Error ? error.message : String(error)
        this.publishAudioState()
        throw error
      }
    })().finally(() => { if (this.configurationTask === task) this.configurationTask = null })
    this.configurationTask = task
    return task
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
    const fail = (message: string) => { if (current()) this.blockOutput(context, message) }
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
    const outputError = () => {
      try { assertGuitarRigHealthy(context) } catch (error) {
        fail(error instanceof Error ? error.message : String(error))
        return
      }
      fail('출력 장치 오류로 재생과 모니터링을 중지했습니다. 장치 연결·스피커 권한을 확인한 뒤 출력 설정을 다시 적용해 주세요.')
    }
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

  private blockOutput(context: AudioContext, message: string): void {
    if (this.context !== context) return
    this.position = this.currentBeat()
    this.playing = false
    this.transportRequest += 1
    this.outputFault = message
    this.audioStatus = 'error'
    this.audioError = message
    for (const graph of [this.graph, ...this.retiredGraphs.keys()]) {
      if (!graph) continue
      graph.gate.gain.cancelScheduledValues(context.currentTime)
      graph.gate.gain.setValueAtTime(0, context.currentTime)
      disconnectMonitor(graph)
      for (const voice of graph.voices) voice.stop(context.currentTime)
    }
    this.monitorSource?.disconnect()
    this.monitorSource = null
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

  setProject(source: Project): void {
    this.sourceProject = source
    // Frozen tracks play their cached render (core/freeze.ts); everything below sees that playback project.
    const project = playbackProject(source, this.assets)
    // A live edit can introduce a native instrument. Stop before the browser scheduler
    // would omit it; the next Play explains the host requirement without replacing its sound.
    if (this.playing && unsupportedWebAudioInstruments(project, this.vintage).length) this.pause()
    const beat = this.currentBeat()
    const rate = projectSampleRate(project.sampleRate)
    const changedRate = rate !== this.desiredSampleRate
    if (changedRate) {
      this.cancelConfiguration()
      this.lifecycle += 1
      this.transportRequest += 1
      if (this.playing) this.pause()
      this.desiredSampleRate = rate
      this.audioStatus = this.outputFault ? 'error' : this.context ? 'ready' : 'idle'
      this.audioError = this.outputFault
    }
    // Identity diff over immutable project snapshots (src/audio/arrangementDiff.ts), not a stringify of every clip.
    const arrangement = diffArrangement(this.project, project)
    const changedLayout = this.project === null || (this.project.tracks !== project.tracks && trackLayoutKey(this.project.tracks) !== trackLayoutKey(project.tracks))
    this.project = project
    this.position = clamp(beat, 0, project.lengthBeats)
    this.preloadProjectSamples(project)
    if (this.context) {
      try {
        if (this.playing && (arrangement.global || changedLayout)) this.restartAt(this.position)
        else if (!this.graph || changedLayout || changedRate) this.replaceGraph()
        else {
          // A mixer edit (fader, send level, effect knob) keeps synced effects — returns' delays included — on the
          // tempo at the playhead, not the project's beat-0 tempo (docs/TEMPO_MAP.md); automated targets keep their lanes.
          this.applyStatic(project)
          // A region/note edit while playing replaces only the edited tracks' upcoming voices; the rest keep sounding.
          if (this.playing && arrangement.tracks.size) this.rescheduleTracks(arrangement.tracks)
        }
      } catch (error) {
        this.blockEffectGraph(this.context, error)
      }
      if (this.graph && this.monitorStream && JSON.stringify([...this.monitorInputs()]) !== this.monitorRoutes) this.wireMonitor()
    }
    this.publishSnapshot()
  }

  setAssets(assets: Map<string, AudioAsset>): void {
    const changed = assets.size !== this.assets.size || [...assets].some(([id, asset]) => this.assets.get(id)?.buffer !== asset.buffer)
    this.assets = new Map(assets)
    // A freeze cache arriving or leaving switches its track between the cached render and live playback.
    if (changed && this.sourceProject?.tracks.some(track => track.freeze)) {
      const before = this.project
      this.setProject(this.sourceProject)
      if (before !== this.project) return
    }
    if (changed && this.playing) this.restartAt(this.currentBeat())
  }
  private sourceProject: Project | null = null

  async resume(): Promise<void> {
    if (this.configurationTask) await this.configurationTask
    if (this.outputFault) throw new Error(this.audioError ?? this.outputFault)
    if (!this.context || this.context.state === 'closed' || this.context.sampleRate !== this.desiredSampleRate) {
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

  setMetronome(state: MetronomeEngineState): void {
    this.metronome.setState(state, this.context?.currentTime ?? 0)
  }

  async play(options: PlayOptions = {}): Promise<void> {
    if (!this.project) throw new Error('재생할 프로젝트가 없습니다.')
    // A first Play of a project with vintage instruments waits for the Rust core (fetched once per page).
    if (vintageWasmStatus() !== 'ready' && unsupportedWebAudioInstruments(this.project, this.vintage).length) await loadVintageWasm()
    assertWebAudioProjectSupported(this.project, this.vintage)
    const request = ++this.transportRequest
    const lifecycle = this.lifecycle
    this.pendingPlayRequest = request
    try {
      await this.resume()
      if (request !== this.transportRequest || lifecycle !== this.lifecycle || !this.context || !this.project) return
      if (this.playing) return
      // Project edits may land while a device permission/configuration promise is pending.
      assertWebAudioProjectSupported(this.project, this.vintage)
      let beat = normalizedStart(this.project, this.position)
      if (!loopRange(this.project) && beat >= this.project.lengthBeats) beat = 0
      this.playing = true
      // A count-in delays the transport anchor; its clicks share the same audio clock.
      const countIn = this.metronome.countInSeconds(this.project, options.countInBars ?? 0, beat)
      this.restartAt(beat, countIn)
      if (countIn > 0 && this.context && !this.outputFault) this.metronome.scheduleCountIn(this.context, this.project, options.countInBars ?? 0, this.anchorTime - countIn, beat)
      if (this.outputFault) throw new Error(this.audioError ?? this.outputFault)
      this.publishSnapshot()
      // Resolve on the downbeat, so a recording starts its capture with the music.
      if (countIn > 0) await this.waitForAnchor(request)
    } finally {
      // A cancelled play may settle after a newer play has already taken ownership.
      if (this.pendingPlayRequest === request) this.pendingPlayRequest = null
    }
  }

  pause(): void {
    this.transportRequest += 1
    this.position = this.currentBeat()
    this.playing = false
    this.metronome.cancel(this.context?.currentTime ?? 0)
    this.replaceGraph()
    this.publishSnapshot()
  }

  stop(): void {
    this.transportRequest += 1
    this.playing = false
    this.metronome.cancel(this.context?.currentTime ?? 0)
    this.position = 0
    this.cursorBeat = 0
    this.replaceGraph()
    this.publishSnapshot()
  }

  seek(beat: number): void {
    if (!this.project) return
    this.position = clamp(beat, 0, this.project.lengthBeats)
    if (this.playing) this.restartAt(this.position)
    else if (this.graph && hasActiveAutomation(this.project)) this.applyStatic(this.project)
    this.publishSnapshot()
  }

  /** Static parameter edit. Automated targets keep their lane value at the heard beat; while playing, the
   * automation already scheduled ahead is replaced from now on (docs/AUTOMATION.md). */
  private applyStatic(project: Project): void {
    if (!this.graph || !this.context) return
    const automated = hasActiveAutomation(project)
    const beat = this.currentBeat()
    this.effectBpm = tempoMapOf(project).bpmAt(beat)
    updateGraph(this.graph, project, true, automated ? beat : undefined, this.effectBpm)
    resetAutomationState(this.graph)
    if (automated && this.playing && this.cursorTime > this.context.currentTime) {
      const anchorBeat = this.anchorBeat, anchorTime = this.anchorTime
      scheduleAutomation(this.graph, project, this.context.currentTime, this.cursorTime, time => positionAfter(project, anchorBeat, time - anchorTime))
    }
  }

  async previewNote(instrument: InstrumentId, pitch: number, velocity = 0.8, trackId?: string): Promise<void> {
    const lifecycle = this.lifecycle
    const def = instrumentDef(instrument)
    if (def.kind === 'native') throw new Error(WAVETABLE_HOST_REQUIRED)
    if (def.kind === 'vintage' && !this.vintage.available()) throw new Error(this.vintage.reason())
    await this.resume()
    if (def.set) await this.preloadSamples(def.set)
    if (lifecycle !== this.lifecycle || !this.context || !this.graph || this.outputFault) return
    const tracks = this.project?.tracks ?? []
    const track = trackId === undefined ? undefined : tracks.find(item => item.id === trackId)
    // Do not audition a stale instrument through a track that changed (or was removed)
    // while output/sample preparation was pending. Library previews have no trackId.
    if (trackId !== undefined && (!track || track.kind !== 'instrument' || track.instrument !== instrument)) return
    if (track && !isTrackEnabled(track)) return
    const live = trackNote(track, pitch, velocity)
    if (!live) return
    const audible = track !== undefined && audibleTrackIds(tracks).has(track.id)
    const channel = audible ? this.graph.tracks.get(track.id) : undefined
    const params = track?.instrument === instrument ? track.instrumentParams : undefined
    const duration = instrument === 'pad' || def.kind === 'sampled' ? 0.65 : 0.3
    const destination = channel?.input ?? this.graph.previewInput
    const loaded = def.set ? this.samples.get(def.set) : undefined
    if (loaded) scheduleSampled(this.graph, destination, loaded, def.isKit, live.pitch, this.context.currentTime + 0.006, duration, live.velocity, duration + 0.8, params, channel?.chokes)
    else scheduleInstrument(this.graph, destination, instrument, live.pitch, this.context.currentTime + 0.006, duration, live.velocity, duration + 0.8, params)
  }

  /** A held live note through the track's chain; released by its note-off with the instrument's release. */
  private startLiveNote(trackId: string, pitch: number, velocity: number): LiveVoiceHandle | null {
    const context = this.context, graph = this.graph
    const track = this.project?.tracks.find(item => item.id === trackId)
    if (!context || !graph || this.outputFault || !track || track.kind !== 'instrument' || !isTrackEnabled(track)) return null
    if (context.state !== 'running') { void context.resume().catch(() => undefined); return null }
    const def = instrumentDef(track.instrument)
    const channel = graph.tracks.get(track.id)
    if (def.kind === 'native' || !channel) return null
    const loaded = def.set ? this.samples.get(def.set) : undefined
    if (def.set && !loaded) { void this.preloadSamples(def.set).catch(() => undefined); return null }
    const when = context.currentTime
    // available === duration: no release-noise sample is scheduled at the far end of the hold.
    const input = channel.controls?.input ?? channel.input, pitchBus = def.isKit ? undefined : channel.controls?.pitch
    const voice = loaded
      ? scheduleSampled(graph, input, loaded, def.isKit, pitch, when, LIVE_NOTE_HOLD_SECONDS, velocity, LIVE_NOTE_HOLD_SECONDS, track.instrumentParams, channel.chokes, pitchBus)
      : scheduleInstrument(graph, input, track.instrument, pitch, when, LIVE_NOTE_HOLD_SECONDS, velocity, LIVE_NOTE_HOLD_SECONDS, track.instrumentParams, pitchBus)
    if (!voice) return null
    // Drum hits ring out on their own, like timeline notes; note-offs do not cut them.
    if (def.isKit) return { release: () => undefined }
    const release = clamp(paramValue(def.params, track.instrumentParams, 'release'), 0.005, 30)
    return { release: () => voice.release(context.currentTime, release) }
  }

  /** Transport beat the listener heard at `timeMs` (performance.now base): the output timestamp folds in output latency. */
  private heardBeatAt(timeMs: number): number | null {
    const context = this.context
    if (!this.playing || !context || !this.project) return null
    const stamp = typeof context.getOutputTimestamp === 'function' ? context.getOutputTimestamp() : undefined
    const latency = (context as AudioContext & ContextExtras).outputLatency ?? 0
    const contextTime = stamp && typeof stamp.contextTime === 'number' && typeof stamp.performanceTime === 'number' && stamp.performanceTime > 0
      ? stamp.contextTime + (timeMs - stamp.performanceTime) / 1000
      : context.currentTime - (performance.now() - timeMs) / 1000 - (context.baseLatency ?? 0) - latency
    return heardTransportBeat(this.project, this.anchorBeat, this.anchorTime, contextTime)
  }

  /** One source node per stream, rewired to the current graph's track inputs; no context is opened without a stream. */
  setInputMonitor(stream: MediaStream | null, trackIds: readonly string[]): void {
    if (stream !== this.monitorStream && this.monitorSource) {
      if (this.graph) disconnectMonitor(this.graph)
      this.monitorSource.disconnect()
      this.monitorSource = null
    }
    this.monitorStream = stream
    this.monitorTrackIds = stream ? [...trackIds] : []
    if (!stream) return
    this.observeInputStream(stream)
    if (this.context && this.context.state !== 'closed') this.wireMonitor()
  }

  private wireMonitor(): void {
    if (!this.context || !this.graph) return
    if (this.outputFault || !this.settings.softwareMonitoring || !this.monitorStream || !this.monitorTrackIds.length) { disconnectMonitor(this.graph); this.monitorRoutes = ''; return }
    this.monitorSource ??= this.context.createMediaStreamSource(this.monitorStream)
    const inputs = this.monitorInputs()
    connectMonitor(this.graph, this.monitorSource, this.monitorTrackIds, inputs)
    this.monitorRoutes = JSON.stringify([...inputs])
  }

  /** Track input channels for the monitored tracks; absent = the whole stream (the default input). */
  private monitorInputs(): Map<string, readonly number[]> {
    const ids = new Set(this.monitorTrackIds)
    return new Map((this.project?.tracks ?? []).flatMap(track => ids.has(track.id) && track.kind === 'audio' && track.input ? [[track.id, track.input.channels] as const] : []))
  }

  /** Monitor gates of routed tracks (track/master inputs); these need no microphone stream. */
  setRouteMonitor(trackIds: readonly string[]): void {
    this.routeMonitorIds = [...trackIds]
    if (this.graph) setRouteMonitoring(this.graph, this.routeMonitorIds)
  }

  private wireRoutes(graph: EngineGraph): void {
    setRouteMonitoring(graph, this.routeMonitorIds)
    for (const [node, trackId] of this.routeRecorders) graph.routes.get(trackId)?.input.connect(node)
  }

  /** Loads the route recorder processor ahead of the take, so capture starts with the transport. */
  async prepareRouteRecording(): Promise<void> {
    await this.resume()
    if (this.context) await prepareRouteRecorder(this.context)
  }

  /**
   * Records routed tracks straight from the graph (no MediaRecorder, any number of tracks). Must be
   * created while the transport plays; the take positions come from the audio clock.
   */
  createRouteRecordings(trackIds: readonly string[], callbacks: TakeCallbacks): RouteRecordings {
    const context = this.context
    if (!context || context.state === 'closed') throw new Error('오디오 장치를 먼저 시작해 주세요.')
    const host: RouteRecordingHost = {
      context,
      attach: (trackId, node) => {
        this.routeRecorders.set(node, trackId)
        this.graph?.routes.get(trackId)?.input.connect(node)
        return () => {
          this.routeRecorders.delete(node)
          try { node.disconnect() } catch { /* Already detached. */ }
          for (const graph of [this.graph, ...this.retiredGraphs.keys()]) try { graph?.routes.get(trackId)?.input.disconnect(node) } catch { /* Not connected. */ }
        }
      },
      projectFrameAt: time => {
        const project = this.project
        if (!project) return 0
        return (tempoMapOf(project).secondsAt(this.anchorBeat) + time - this.anchorTime) * projectSampleRate(project.sampleRate)
      },
    }
    return new RouteRecordings(host, trackIds, callbacks)
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

  /** Offline render (export, bounce, freeze, stems; docs/BOUNCE_FREEZE_STEMS.md). */
  async renderAudio(source: Project, options: RenderOptions): Promise<RenderedAudio> {
    const project = playbackProject(source, this.assets)
    if (vintageWasmStatus() !== 'ready' && unsupportedWebAudioInstruments(project, this.vintage).length) await loadVintageWasm()
    assertWebAudioProjectSupported(project, this.vintage)
    for (const setId of this.sampleSets(project)) {
      try { await this.preloadSamples(setId) } catch (error) {
        throw new Error(`샘플 악기 "${setId}"를 불러오지 못했습니다: ${error instanceof Error ? error.message : ''}`)
      }
    }
    const sampleRate = projectSampleRate(project.sampleRate)
    const tempo = tempoMapOf(project)
    const tailSeconds = options.tailSeconds === undefined ? renderTailSeconds(project) : Math.min(30, Math.max(0, options.tailSeconds))
    const duration = tempo.secondsAt(project.lengthBeats) + tailSeconds
    const frames = Math.ceil(duration * sampleRate)
    if (!Number.isFinite(frames) || frames < 1) throw new Error('프로젝트의 내보내기 길이가 올바르지 않습니다.')
    // OfflineAudioContext stores all rendered samples in RAM. Fail clearly before
    // allocating a multi-gigabyte buffer in this initial browser implementation.
    if (frames > sampleRate * 60 * 15) throw new Error('이 초기 버전은 한 번에 최대 15분까지 WAV로 내보낼 수 있습니다. 프로젝트 길이를 줄여 주세요.')
    const offline = new OfflineAudioContext(2, frames, sampleRate)
    await prepareEffects(offline)
    await prepareVintage(offline)
    const graph = createGraph(offline, project, { preMaster: options.preMaster })
    try {
      scheduleRange(graph, project, new Map(this.assets), 0, project.lengthBeats, 0, project.lengthBeats, true, false, this.samples)
      // Automation is scheduled for the whole render before it starts, so worklet events are queued first.
      if (hasActiveAutomation(project)) {
        const tempo = tempoMapOf(project)
        updateGraph(graph, project, false, 0)
        scheduleAutomation(graph, project, 0, duration, time => Math.min(project.lengthBeats, tempo.beatAt(time)))
      }
      scheduleTempoUpdates(offline, graph, project, duration)
      // Vintage instrument nodes are built now, with every note of the render in their options.
      flushVintage(graph)
      const rendered = await offline.startRendering()
      assertGuitarRigHealthy(offline)
      const start = Math.min(rendered.length - 1, Math.max(0, Math.round(options.startFrame ?? 0)))
      const channels = [rendered.getChannelData(0).subarray(start), rendered.getChannelData(1).subarray(start)]
      return { blob: encodeWav(channels, rendered.sampleRate, options.bitDepth), sampleRate: rendered.sampleRate, frames: channels[0].length, tailSeconds, trackTailSeconds: trackTailSeconds(project) }
    } finally {
      disposeGraph(graph)
    }
  }

  dispose(): void {
    this.cancelConfiguration()
    this.removeOutputListeners?.()
    this.removeOutputListeners = null
    this.lifecycle += 1
    this.transportRequest += 1
    this.playing = false
    this.position = 0
    if (this.scheduler !== null) clearInterval(this.scheduler)
    this.scheduler = null
    this.metronome.dispose()
    if (this.graph) disposeGraph(this.graph)
    this.graph = null
    this.monitorSource?.disconnect()
    this.monitorSource = null
    this.monitorStream = null
    this.monitorTrackIds = []
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
    if (!this.playing || !this.context || !this.project) return this.position
    return positionAfter(this.project, this.anchorBeat, this.context.currentTime - this.anchorTime)
  }

  private blockEffectGraph(context: AudioContext, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error)
    this.blockOutput(context, `오디오 이펙트를 적용하지 못해 재생과 모니터링을 중지했습니다. 오디오 설정을 다시 적용해 주세요. ${detail}`)
  }

  private replaceGraph(): boolean {
    const context = this.context
    if (!context || !this.project || this.outputFault) return false
    let replacement: EngineGraph | null = null
    try {
      // Construct before retiring the current graph. A failed effect must never leave
      // a partly connected replacement or quietly substitute the old/dry signal.
      replacement = createGraph(context, this.project)
      if (hasActiveAutomation(this.project) || !tempoMapOf(this.project).isConstant) updateGraph(replacement, this.project, false, this.currentBeat())
      if (this.graph) {
        const old = this.graph
        if (context.state === 'running') {
          const now = context.currentTime
          const fadeSeconds = 0.003
          // Both graphs briefly receive live input. Complementary envelopes keep
          // their total gain at unity while the previous processors are retired.
          replacement.gate.gain.value = 0
          replacement.gate.gain.setValueAtTime(0, now)
          old.gate.gain.cancelScheduledValues(now)
          old.gate.gain.setTargetAtTime(0, now, fadeSeconds)
          replacement.gate.gain.setTargetAtTime(1, now, fadeSeconds)
          for (const voice of old.voices) voice.stop(now)
          const timeout = setTimeout(() => {
            disposeGraph(old)
            this.retiredGraphs.delete(old)
          }, 30)
          this.retiredGraphs.set(old, timeout)
        } else disposeGraph(old)
      }
      this.graph = replacement
      this.effectBpm = 0
      if (this.outputFault) this.graph.gate.gain.value = 0
      this.wireRoutes(replacement)
      this.wireMonitor()
      this.levels.clear()
      this.masterLevel = 0
      return true
    } catch (error) {
      if (replacement && replacement !== this.graph) disposeGraph(replacement)
      this.blockEffectGraph(context, error)
      return false
    }
  }

  private restartAt(beat: number, preRollSeconds = 0): void {
    if (!this.context || !this.project) return
    this.position = normalizedStart(this.project, beat)
    this.anchorBeat = this.position
    this.anchorTime = this.context.currentTime + START_LEAD_SECONDS + preRollSeconds
    this.metronome.cancel(this.context.currentTime)
    this.cursorBeat = this.position
    this.cursorTime = this.anchorTime
    this.chaseCursor = true
    if (!this.replaceGraph()) return
    this.schedule()
  }

  /** Tracks rescheduled by the last live edit (tests and profiling). */
  lastReschedule: { tracks: string[]; stopped: number } | null = null

  /**
   * Replaces the already scheduled look-ahead of the edited tracks only. Notes that have not sounded yet are stopped and
   * the window from now to the scheduler cursor is scheduled again from the edited project; untouched tracks, the
   * graph, effect tails and the transport anchor stay as they are (no restart). `hard` changes also cut sounding notes
   * and chase sustained ones, like a seek does for that track alone.
   */
  private rescheduleTracks(changes: ReadonlyMap<string, TrackChange>): void {
    if (!this.playing || !this.context || !this.project || !this.graph) return
    const graph = this.graph, project = this.project
    const from = Math.max(this.context.currentTime + 0.003, this.anchorTime)
    let stopped = 0
    for (const [trackId, change] of changes) stopped += stopTrackVoices(graph, trackId, from, change === 'hard')
    this.lastReschedule = { tracks: [...changes.keys()], stopped }
    if (this.cursorTime <= from) return
    const only = new Map([...changes].map(([trackId, change]) => [trackId, change === 'hard']))
    const loop = loopRange(project)
    const tempo = tempoMapOf(project)
    const boundary = loop?.end ?? project.lengthBeats
    let beat = positionAfter(project, this.anchorBeat, from - this.anchorTime)
    let time = from
    let chase = true
    for (let iterations = 0; time < this.cursorTime - 0.000001 && iterations < 128; iterations++) {
      if (beat >= boundary - 0.0000001) {
        if (!loop) break
        beat = loop.start
        chase = true
      }
      const remainingSeconds = tempo.secondsBetween(beat, boundary)
      const segmentSeconds = Math.min(this.cursorTime - time, remainingSeconds)
      if (segmentSeconds <= 0.00000001) break
      const endBeat = segmentSeconds >= remainingSeconds ? boundary : Math.min(boundary, tempo.beatAfter(beat, segmentSeconds))
      scheduleRange(graph, project, this.assets, beat, endBeat, time, boundary, chase, true, this.samples, only)
      time += segmentSeconds
      beat = endBeat
      chase = false
    }
  }

  private schedule(): void {
    if (!this.playing || !this.context || !this.project || !this.graph) return
    const project = this.project
    const loop = loopRange(project)
    const tempo = tempoMapOf(project)
    const boundary = loop?.end ?? project.lengthBeats
    const horizon = this.context.currentTime + LOOKAHEAD_SECONDS

    // A backgrounded tab can miss timer ticks. Resume from the audio clock instead
    // of firing a burst of stale onsets; audio clips chase their correct offsets.
    if (this.cursorTime < this.context.currentTime - LOOKAHEAD_SECONDS) {
      const nextTime = this.context.currentTime + 0.008
      const beat = positionAfter(project, this.anchorBeat, nextTime - this.anchorTime)
      if (!this.replaceGraph()) return
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
      const remainingSeconds = tempo.secondsBetween(this.cursorBeat, boundary)
      const segmentSeconds = Math.min(horizon - this.cursorTime, remainingSeconds)
      if (segmentSeconds <= 0.00000001) break
      const endBeat = segmentSeconds >= remainingSeconds ? boundary : Math.min(boundary, tempo.beatAfter(this.cursorBeat, segmentSeconds))
      scheduleRange(this.graph, project, this.assets, this.cursorBeat, endBeat, this.cursorTime, boundary, this.chaseCursor, true, this.samples)
      const segmentBeat = this.cursorBeat, segmentTime = this.cursorTime
      scheduleAutomation(this.graph, project, segmentTime, segmentTime + segmentSeconds, time => tempo.beatAfter(segmentBeat, time - segmentTime))
      if (!this.outputFault) this.metronome.scheduleSegment(this.context, project, this.cursorBeat, endBeat, this.cursorTime)
      this.cursorTime += segmentSeconds
      this.cursorBeat = endBeat
      this.chaseCursor = false
    }    // Tempo-synced effects (delay, tremolo) follow the tempo at the playhead (docs/TEMPO_MAP.md).
    if (!tempo.isConstant) this.followTempo(tempo.bpmAt(this.currentBeat()))
  }

  private effectBpm = 0
  private followTempo(bpm: number): void {
    if (!this.graph || !this.project || Math.abs(bpm - this.effectBpm) < 0.05) return
    this.effectBpm = bpm
    // Only non-automated synced effects: a full updateGraph would cancel the scheduled automation.
    updateEffectTempo(this.graph, this.project, bpm)
  }

  /** Waits on the audio clock for a count-in to reach the transport anchor (or for the play to be cancelled). */
  private async waitForAnchor(request: number): Promise<void> {
    while (this.context && this.playing && request === this.transportRequest) {
      const remaining = this.anchorTime - this.context.currentTime
      if (remaining <= 0.002) return
      await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, (remaining - 0.001) * 1000))))
    }
  }

  private tick(): void {
    if (!this.context) return
    if (this.playing && this.project) {
      const completed = !loopRange(this.project) && this.context.currentTime >= this.anchorTime + tempoMapOf(this.project).secondsBetween(this.anchorBeat, this.project.lengthBeats)
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

/**
 * Offline export: tempo-synced effects follow the tempo map. The render suspends where the tempo has moved
 * by more than 0.05 BPM (checked every 50 ms) and retunes the effects, like the realtime scheduler does.
 */
function scheduleTempoUpdates(offline: OfflineAudioContext, graph: EngineGraph, project: Project, duration: number): void {
  const tempo = tempoMapOf(project)
  if (tempo.isConstant || typeof offline.suspend !== 'function') return
  const step = 0.05
  let last = tempo.bpmAt(0)
  for (let time = step; time < duration; time += step) {
    const bpm = tempo.bpmAt(Math.min(project.lengthBeats, tempo.beatAt(time)))
    if (Math.abs(bpm - last) < 0.05) continue
    last = bpm
    // Suspend times are quantized to render quanta (128 frames); each one is unique here.
    const at = Math.ceil(time * offline.sampleRate / 128) * 128 / offline.sampleRate
    offline.suspend(at).then(() => { updateEffectTempo(graph, project, bpm); return offline.resume() }).catch(() => undefined)
  }
}

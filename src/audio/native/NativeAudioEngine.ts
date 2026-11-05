import {
  DEFAULT_AUDIO_SETTINGS, DEFAULT_SAMPLE_RATE, normalizeAudioSettings, projectSampleRate,
  type AudioSettings, type AudioState, type InputState, type SampleRate,
} from '../../core/audioSettings'
import { defaultInstrumentParams } from '../../core/project'
import { validateNativePluginState } from '../../core/nativePlugins'
import { instrumentDef } from '../../core/instruments'
import { isPluginDevice, type AudioAsset, type AudioEngine, type InstrumentId, type Project, type SampleAttribution, type SampleStatus, type Track, type TransportSnapshot } from '../../core/types'
import type { AudioRecordingCallbacks } from '../AudioRecording'
import { SampleLibrary } from '../samples'
import { clamp, normalizedStart } from '../math'
import { assertNativeInstrumentsSupported, canPlayInstrument, unsupportedNativeInstruments, WAVETABLE_HOST_REQUIRED } from '../instrumentSupport'
import { compileNativeTimeline, type NativePcmAsset } from './timeline'
import type {
  NativeAudioBridge, NativeAudioFile, NativeBackend, NativeDevice, NativeDeviceState,
  NativeEngineEvent, NativeLatencyMeasurement, NativePluginDescriptor, NativePluginInstance, NativePluginParameter, NativePluginState,
} from './contracts'
import { NativeRecording, NativeRecordings, type NativeRecordingsCallbacks } from './NativeRecording'
import { encodeWavetablePatch, WAVETABLE_UNAVAILABLE_STATUS, type WavetableBridgeStatus, type WavetableNativeBridge } from '../../devices/wavetable-synth/bridge'
import { combineWavetablePatch, type WavetablePatch } from '../../devices/wavetable-synth/model'
import { WAVE_SCHEMA_FINGERPRINT } from '../../devices/wavetable-synth/schema.generated'
import type { NativeEngineCapabilities, NativeProjectApplied } from './contracts'
import { ownAudioBytes } from '../assetBytes'

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const nonnegative = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const finite = (value: unknown, fallback = 0): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback
const abortError = () => new DOMException('오디오 작업이 취소되었습니다.', 'AbortError')
const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError'
const wavePatchData = (patch: WavetablePatch): string => {
  const bytes = encodeWavetablePatch(patch)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}
interface WaveAuditionNote { noteId: number; pitch: number; generation: number; configuration: number }

export function nativeBackendForPlatform(settings: AudioSettings, platform: string): NativeBackend {
  if (platform !== 'win32' && platform !== 'darwin') throw new Error('이 데스크톱 오디오 엔진은 Windows와 Apple Silicon macOS를 지원합니다.')
  if (settings.nativeBackend !== 'auto') {
    if ((platform === 'darwin') !== (settings.nativeBackend === 'coreaudio')) throw new Error('현재 운영체제에서 사용할 수 없는 오디오 드라이버입니다.')
    return settings.nativeBackend
  }
  if (platform === 'win32') return 'wasapi'
  if (platform === 'darwin') return 'coreaudio'
  throw new Error('이 데스크톱 오디오 엔진은 Windows와 Apple Silicon macOS를 지원합니다.')
}

/**
 * Desktop facade: only editing commands, native snapshots and one-time PCM uploads
 * cross IPC. Audio playback, live monitoring, recording and WAV rendering all run
 * in the native host. The tiny OfflineAudioContext below is a codec utility for
 * existing compressed assets; it never opens an output device or renders a graph.
 */
export class NativeAudioEngine implements AudioEngine {
  readonly kind = 'native' as const
  /** `record.start { takes }` accepts up to 64 tracks from one transport start. */
  readonly maxSimultaneousRecordings = 64
  readonly samples: SampleLibrary
  private project: Project | null = null
  private assets = new Map<string, AudioAsset>()
  private settings: AudioSettings
  private desiredSampleRate: SampleRate = DEFAULT_SAMPLE_RATE
  private decodeContext: OfflineAudioContext | null = null
  private uploaded = new Map<string, AudioBuffer>()
  private uploadTasks = new Map<string, Promise<void>>()
  private registeredSets = new Set<string>()
  private sampleTasks = new Map<string, Promise<void>>()
  private sampleErrors = new Map<string, string>()
  private listeners = new Set<() => void>()
  private audioListeners = new Set<() => void>()
  private inputListeners = new Set<() => void>()
  private sampleListeners = new Set<() => void>()
  private bridgeRelease: (() => void) | null = null
  private generation = 0
  private transportRequest = 0
  private pendingPlayRequest: number | null = null
  private revision = 0
  private appliedRevision = -1
  private syncTask: Promise<void> | null = null
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private configurationTask: Promise<void> | null = null
  private closingTask: Promise<void> | null = null
  private configured = false
  private monitorIds: string[] = []
  private levels = new Map<string, number>()
  private masterLevel = 0
  private snapshot: TransportSnapshot = { playing: false, beat: 0, ready: false, sampleRate: DEFAULT_SAMPLE_RATE }
  private audioSnapshot: AudioState
  private inputSnapshot: InputState = { status: 'idle', deviceLabel: null, settings: null, error: null }
  private nativeDevice: NativeDeviceState | null = null
  private hostGeneration: number | null = null
  private captureWanted = false
  private monitorRequest = 0
  private configurationEpoch = 0
  private waveCapability: boolean | undefined
  private waveCapabilityTask: Promise<void> | null = null
  private waveCapabilityReason = WAVETABLE_UNAVAILABLE_STATUS.reason!
  private waveStatus: WavetableBridgeStatus = WAVETABLE_UNAVAILABLE_STATUS
  private waveListeners = new Set<(status: WavetableBridgeStatus) => void>()
  private wavePatchRequests = new Map<string, { revision: number }>()
  private waveReady = new Map<string, { patchData: string; generation: number; configuration: number }>()
  private wavePayloads = new Map<string, { params: Track['instrumentParams']; state: Track['instrumentState']; data: string }>()
  private waveNotes = new Map<string, Map<string, WaveAuditionNote>>()
  private nextWaveNoteId = 1_000_000_000

  readonly wavetable: WavetableNativeBridge = {
    protocolVersion: 1,
    getStatus: () => this.waveStatus,
    subscribe: listener => {
      this.waveListeners.add(listener)
      void this.ensureWaveCapability().catch(() => undefined)
      return () => { this.waveListeners.delete(listener) }
    },
    applyPatch: (trackId, patch, revision) => this.applyWavePatch(trackId, patch, revision),
    previewNoteOn: (trackId, note, velocity, channel = 0) => this.waveNoteOn(trackId, note, velocity, channel),
    previewNoteOff: (trackId, note, channel = 0) => this.waveNoteOff(trackId, note, channel),
    allNotesOff: trackId => this.releaseWaveNotes(trackId),
  }

  constructor(
    private readonly bridge: NativeAudioBridge | undefined,
    readonly platform: string,
    project?: Project,
    settings: AudioSettings = DEFAULT_AUDIO_SETTINGS,
    samples = new SampleLibrary(),
  ) {
    this.settings = normalizeAudioSettings(settings)
    this.samples = samples
    this.audioSnapshot = {
      status: bridge ? 'idle' : 'error', contextState: 'uninitialized', settings: this.settings,
      requestedSampleRate: this.desiredSampleRate, sampleRate: null, baseLatency: null,
      outputLatency: null, sinkId: null, renderQuantumSize: null,
      supportsOutputSelection: true, supportsRenderSize: true, needsReconfiguration: false,
      nativeDevice: null, inputLatency: null,
      error: bridge ? null : '네이티브 오디오 연결부를 불러오지 못했습니다. 앱 설치를 확인해 주세요.',
    }
    if (project) this.setProject(project)
  }

  readonly getSnapshot = (): TransportSnapshot => this.snapshot
  readonly getAudioState = (): AudioState => this.audioSnapshot
  readonly getInputState = (): InputState => this.inputSnapshot
  readonly getTrackLevel = (trackId: string): number => this.levels.get(trackId) ?? 0
  readonly getMasterLevel = (): number => this.masterLevel
  readonly subscribe = (callback: () => void): (() => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback) } }
  readonly subscribeAudioState = (callback: () => void): (() => void) => { this.audioListeners.add(callback); return () => { this.audioListeners.delete(callback) } }
  readonly subscribeInputState = (callback: () => void): (() => void) => { this.inputListeners.add(callback); return () => { this.inputListeners.delete(callback) } }
  readonly subscribeSamples = (callback: () => void): (() => void) => { this.sampleListeners.add(callback); return () => { this.sampleListeners.delete(callback) } }
  readonly sampleStatus = (setId: string): SampleStatus => this.sampleErrors.has(setId) ? 'error' : this.registeredSets.has(setId) ? 'ready' : this.sampleTasks.has(setId) ? 'loading' : 'idle'
  readonly sampleAttribution = (setId: string): SampleAttribution | undefined => this.samples.get(setId)?.set.attribution

  private connect(): NativeAudioBridge {
    if (!this.bridge) throw new Error(this.audioSnapshot.error ?? '네이티브 오디오 연결부가 없습니다.')
    if (!this.bridgeRelease) this.bridgeRelease = this.bridge.subscribe(event => this.receive(event))
    return this.bridge
  }

  private async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return await this.connect().request(method, params) as T
  }

  private updateAudio(patch: Partial<AudioState>): void {
    this.audioSnapshot = { ...this.audioSnapshot, ...patch }
    this.publishWaveStatus()
    for (const listener of this.audioListeners) listener()
  }

  private publishWaveStatus(): void {
    const usable = this.audioSnapshot.status !== 'error' && this.audioSnapshot.status !== 'configuring'
    const backend = this.nativeDevice?.backend
    const next: WavetableBridgeStatus = Object.freeze({
      available: this.waveCapability === true && usable,
      ...(this.waveCapability !== true ? { reason: this.waveCapabilityReason }
        : !usable ? { reason: this.audioSnapshot.error ?? '오디오 장치 설정을 적용하는 중입니다.' } : {}),
      ...(this.configured && backend ? { backend: backend === 'coreaudio' ? 'core-audio' : backend === 'test' ? 'offline' : backend, sampleRate: this.nativeDevice!.sampleRate } : {}),
    })
    if (next.available === this.waveStatus.available && next.reason === this.waveStatus.reason && next.backend === this.waveStatus.backend && next.sampleRate === this.waveStatus.sampleRate) return
    this.waveStatus = next
    for (const listener of this.waveListeners) listener(next)
  }

  private ensureWaveCapability(): Promise<void> {
    if (this.waveCapabilityTask) return this.waveCapabilityTask
    if (this.waveCapability !== undefined) return Promise.resolve()
    const generation = this.generation, closing = this.closingTask
    const task = (async () => {
      if (closing) await closing.catch(() => undefined)
      if (generation !== this.generation) throw abortError()
      try {
        const value = await this.request<NativeEngineCapabilities>('engine.capabilities')
        if (generation !== this.generation) throw abortError()
        this.waveCapability = value?.protocol === 1 && value.wavetable?.protocolVersion === 1 && value.wavetable.schemaFingerprint === WAVE_SCHEMA_FINGERPRINT
        this.waveCapabilityReason = value?.wavetable
          ? 'IEUM WAVE 엔진과 앱의 버전이 다릅니다. 앱을 업데이트해 주세요.'
          : '이 앱의 네이티브 오디오 엔진은 IEUM WAVE를 지원하지 않습니다. 앱을 업데이트해 주세요.'
      } catch (error) {
        if (generation !== this.generation) throw abortError()
        // Older installed hosts remain usable for their supported instruments.
        // They must never acquire WAVE support merely by being a native process.
        this.waveCapability = false
        this.waveCapabilityReason = `IEUM WAVE 엔진을 확인하지 못했습니다. ${message(error)}`
      }
      this.publishWaveStatus()
    })()
    this.waveCapabilityTask = task
    void task.finally(() => { if (this.waveCapabilityTask === task) this.waveCapabilityTask = null }).catch(() => undefined)
    return task
  }

  private waveTrack(trackId: string): Track | undefined {
    return this.project?.tracks.find(track => track.id === trackId && track.kind === 'instrument' && track.instrument === 'wavetable' && !track.pluginInstrument)
  }

  private trackWaveData(track: Track): string {
    const cached = this.wavePayloads.get(track.id)
    if (cached && cached.params === track.instrumentParams && cached.state === track.instrumentState) return cached.data
    const data = wavePatchData(combineWavetablePatch(track.instrumentParams, track.instrumentState))
    this.wavePayloads.set(track.id, { params: track.instrumentParams, state: track.instrumentState, data })
    return data
  }

  private async applyWavePatch(trackId: string, patch: WavetablePatch, revision: number): Promise<{ revision: number }> {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('IEUM WAVE 패치 확인 번호가 유효하지 않습니다.')
    if (revision <= (this.wavePatchRequests.get(trackId)?.revision ?? 0)) throw abortError()
    const request = { revision }, generation = this.generation, patchData = wavePatchData(patch)
    this.wavePatchRequests.set(trackId, request)
    // Yield before reading the authoritative project: React's parent project
    // effect can follow the editor's effect in the same commit.
    await this.ensureWaveCapability()
    const current = () => {
      if (generation !== this.generation || this.wavePatchRequests.get(trackId) !== request) throw abortError()
      const track = this.waveTrack(trackId)
      if (!track || this.trackWaveData(track) !== patchData) throw abortError()
      return track
    }
    current()
    if (this.waveCapability !== true) throw new Error(this.waveStatus.reason ?? WAVETABLE_HOST_REQUIRED)
    await this.resume()
    const configuration = this.configurationEpoch
    await this.syncProject()
    current()
    if (configuration !== this.configurationEpoch || !this.configured || !this.waveStatus.available || this.appliedRevision !== this.revision) throw abortError()
    this.waveReady.set(trackId, { patchData, generation, configuration })
    return { revision }
  }

  private waveNoteOn(trackId: string, pitch: number, velocity: number, channel: number): void {
    if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127 || !Number.isInteger(channel) || channel < 0 || channel > 15 || !Number.isFinite(velocity) || velocity < 0 || velocity > 1) throw new Error('IEUM WAVE 미리듣기 음표가 유효하지 않습니다.')
    if (velocity === 0) { this.waveNoteOff(trackId, pitch, channel); return }
    const track = this.waveTrack(trackId), ready = this.waveReady.get(trackId)
    if (!this.configured || !this.waveStatus.available || !track?.enabled || !ready || ready.generation !== this.generation || ready.configuration !== this.configurationEpoch || ready.patchData !== this.trackWaveData(track) || this.appliedRevision !== this.revision) throw new Error('IEUM WAVE의 최신 음색이 오디오 엔진에 적용될 때까지 기다려 주세요.')
    this.waveNoteOff(trackId, pitch, channel)
    let notes = this.waveNotes.get(trackId)
    if (!notes) { notes = new Map(); this.waveNotes.set(trackId, notes) }
    const key = `${channel}:${pitch}`, note = { pitch, noteId: this.nextWaveNoteId++, generation: this.generation, configuration: this.configurationEpoch }
    if (this.nextWaveNoteId > 2_000_000_000) this.nextWaveNoteId = 1_000_000_000
    notes.set(key, note)
    void this.request('note.on', { trackId, pitch, velocity, noteId: note.noteId }).catch(error => {
      if (this.waveNotes.get(trackId)?.get(key) === note && note.generation === this.generation && note.configuration === this.configurationEpoch) this.fail(error)
    })
  }

  private waveNoteOff(trackId: string, pitch: number, channel: number): void {
    const notes = this.waveNotes.get(trackId), key = `${channel}:${pitch}`, note = notes?.get(key)
    if (!note) return
    notes!.delete(key)
    if (!notes!.size) this.waveNotes.delete(trackId)
    if (!this.configured || note.generation !== this.generation || note.configuration !== this.configurationEpoch) return
    void this.request('note.off', { trackId, pitch: note.pitch, noteId: note.noteId }).catch(error => {
      if (this.configured && note.generation === this.generation && note.configuration === this.configurationEpoch && this.waveTrack(trackId)?.enabled) this.fail(error)
    })
  }

  private releaseWaveNotes(trackId: string): void {
    const notes = this.waveNotes.get(trackId)
    if (!notes) return
    for (const key of [...notes.keys()]) {
      const [channel, pitch] = key.split(':').map(Number)
      this.waveNoteOff(trackId, pitch, channel)
    }
  }

  private clearWaveAudition(release: boolean): void {
    if (release) for (const trackId of [...this.waveNotes.keys()]) this.releaseWaveNotes(trackId)
    this.waveNotes.clear(); this.waveReady.clear()
  }

  private updateTransport(patch: Partial<TransportSnapshot>): void {
    const next = { ...this.snapshot, ...patch }
    if (Object.keys(next).every(key => next[key as keyof TransportSnapshot] === this.snapshot[key as keyof TransportSnapshot])) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }

  private fail(error: unknown): void {
    const text = message(error)
    this.clearWaveAudition(true)
    this.updateTransport({ playing: false, ready: false })
    this.levels.clear(); this.masterLevel = 0
    this.updateAudio({ status: 'error', error: text, needsReconfiguration: true })
  }

  private invalidateHost(): void {
    this.generation++; this.transportRequest++; this.monitorRequest++
    this.pendingPlayRequest = null
    this.uploaded.clear(); this.uploadTasks.clear(); this.registeredSets.clear(); this.sampleTasks.clear(); this.sampleErrors.clear()
    this.appliedRevision = -1; this.configured = false; this.syncTask = null
    this.clearWaveAudition(false); this.wavePatchRequests.clear(); this.wavePayloads.clear()
    this.waveCapability = undefined; this.waveCapabilityTask = null
    this.waveCapabilityReason = '네이티브 오디오 엔진 연결을 다시 확인해야 합니다. 오디오 설정을 다시 적용해 주세요.'
    this.publishWaveStatus()
    this.updateTransport({ playing: false, ready: false })
  }

  private receive(event: NativeEngineEvent): void {
    if (!event || typeof event !== 'object') return
    if (typeof event.generation === 'number' && event.generation !== this.hostGeneration) {
      if (this.hostGeneration !== null && event.generation < this.hostGeneration) return
      // A failed host was already invalidated. Its replacement announces its
      // generation before configure starts; do not cancel that recovery request.
      if (this.hostGeneration !== null && (this.configured || this.uploaded.size || this.registeredSets.size || this.appliedRevision >= 0 || (this.waveCapability !== undefined && this.audioSnapshot.status !== 'configuring'))) this.invalidateHost()
      else if (this.hostGeneration !== null && this.waveCapability !== undefined) {
        // A replacement can announce itself during explicit recovery. Keep
        // that configure request alive, but rediscover its actual DSP module.
        this.waveCapability = undefined; this.waveCapabilityTask = null
        this.waveCapabilityReason = WAVETABLE_UNAVAILABLE_STATUS.reason!
        this.publishWaveStatus()
      }
      this.hostGeneration = event.generation
    }
    if (event.type === 'error' || event.error) {
      if (event.type === 'error' && (this.configured || this.uploaded.size || this.audioSnapshot.status !== 'error')) this.invalidateHost()
      this.fail(event.error || '네이티브 오디오 엔진이 종료되었습니다.'); return
    }
    if (event.type !== 'state') return
    if (event.device) {
      if (event.device.needsReconfigure) { this.fail(event.device.error || '오디오 장치의 설정이 변경되었습니다. 장치 설정을 다시 적용해 주세요.'); return }
      try { this.setDevice(event.device) } catch (error) { this.fail(error); return }
    }
    if (event.levels && typeof event.levels === 'object') this.levels = new Map(Object.entries(event.levels).map(([id, value]) => [id, Math.max(0, finite(value))]))
    this.masterLevel = Math.max(0, finite(event.masterLevel))
    const rate = finite(event.sampleRate, this.nativeDevice?.sampleRate ?? this.desiredSampleRate)
    const bpm = this.project?.bpm ?? 120
    const beat = typeof event.frame === 'number' && Number.isFinite(event.frame) && rate > 0
      ? event.frame / rate * bpm / 60 : this.snapshot.beat
    this.updateTransport({
      ...(typeof event.playing === 'boolean' ? { playing: event.playing } : {}),
      beat: this.project ? clamp(beat, 0, this.project.lengthBeats) : Math.max(0, beat),
      ready: this.configured && event.ready !== false && this.audioSnapshot.status !== 'error',
      sampleRate: rate,
    })
    const diagnostics = {
      pluginLatencyFrames: nonnegative(event.latencyFrames) ?? this.audioSnapshot.pluginLatencyFrames,
      commandOverflows: nonnegative(event.commandOverflows) ?? this.audioSnapshot.commandOverflows,
      voiceOverflows: nonnegative(event.voiceOverflows) ?? this.audioSnapshot.voiceOverflows,
      underruns: event.device?.underruns ?? this.audioSnapshot.underruns,
    }
    if (Object.entries(diagnostics).some(([key, value]) => this.audioSnapshot[key as keyof AudioState] !== value)) this.updateAudio(diagnostics)
    if (event.recordingDroppedFrames && event.recordingDroppedFrames > 0) this.updateAudio({ error: '녹음 데이터 기록이 지연되었습니다. 녹음 결과와 장치 상태를 확인해 주세요.' })
  }

  private setDevice(device: NativeDeviceState): void {
    if (!device || !Number.isFinite(device.sampleRate) || device.sampleRate <= 0 || !Number.isInteger(device.bufferFrames) || device.bufferFrames < 1) {
      throw new Error('오디오 드라이버가 유효한 실제 샘플레이트와 버퍼 크기를 반환하지 않았습니다.')
    }
    this.nativeDevice = device
    this.inputSnapshot = {
      status: device.inputChannels > 0 ? 'active' : 'idle', deviceLabel: device.inputName ?? null,
      settings: { sampleRate: device.sampleRate, channelCount: device.inputChannels, deviceId: device.inputDeviceId }, error: null,
    }
    for (const listener of this.inputListeners) listener()
    const inputFrames = nonnegative(device.inputLatencyFrames), outputFrames = nonnegative(device.outputLatencyFrames)
    this.updateAudio({
      nativeDevice: device, contextState: device.running === false ? 'suspended' : 'running', sampleRate: device.sampleRate,
      renderQuantumSize: device.bufferFrames, sinkId: device.outputDeviceId,
      inputLatency: inputFrames === null ? null : inputFrames / device.sampleRate,
      baseLatency: null, outputLatency: outputFrames === null ? null : outputFrames / device.sampleRate,
      underruns: device.underruns,
    })
  }

  async listDevices(backend = nativeBackendForPlatform(this.settings, this.platform)): Promise<NativeDevice[]> {
    const value = await this.request<unknown>('devices.list', { backend })
    const devices = Array.isArray(value) ? value : (value as { devices?: unknown })?.devices
    if (!Array.isArray(devices)) throw new Error('오디오 장치 목록을 읽지 못했습니다.')
    return devices.filter((device): device is NativeDevice => !!device && typeof device.id === 'string' && typeof device.name === 'string' && device.backend === backend)
  }

  configure(settings: AudioSettings, sampleRate: SampleRate): Promise<void> {
    this.transportRequest++
    this.pendingPlayRequest = null
    return this.beginConfiguration(settings, sampleRate)
  }

  private beginConfiguration(settings: AudioSettings, sampleRate: SampleRate): Promise<void> {
    const next = normalizeAudioSettings(settings), rate = projectSampleRate(sampleRate)
    const previous = this.configurationTask, closing = this.closingTask, generation = this.generation
    const task = (async () => {
      if (closing) await closing.catch(() => undefined)
      if (previous) await previous.catch(() => undefined)
      if (generation !== this.generation) throw abortError()
      await this.configureDevice(next, rate)
    })()
    this.configurationTask = task
    void task.finally(() => { if (this.configurationTask === task) this.configurationTask = null }).catch(() => undefined)
    return task
  }

  private async configureDevice(next: AudioSettings, rate: SampleRate): Promise<void> {
    const generation = this.generation
    this.clearWaveAudition(true)
    this.configurationEpoch++; this.configured = false; this.appliedRevision = -1; this.syncTask = null
    if (this.syncTimer !== null) { clearTimeout(this.syncTimer); this.syncTimer = null }
    this.updateTransport({ playing: false, ready: false })
    this.updateAudio({ status: 'configuring', error: null })
    try {
      await this.ensureWaveCapability()
      if (generation !== this.generation) throw abortError()
      // This is a requested device block, independent of the browser renderSizeHint.
      const result = await this.request<NativeDeviceState | { device: NativeDeviceState }>('engine.configure', {
        backend: nativeBackendForPlatform(next, this.platform),
        inputDeviceId: next.inputDeviceId, outputDeviceId: next.outputDeviceId,
        sampleRate: rate, bufferFrames: next.nativeBufferFrames,
        inputChannels: this.captureWanted || (next.softwareMonitoring && this.monitorIds.length) ? next.inputChannels === 'default' ? 1 : next.inputChannels : 0,
        inputChannelOffset: next.nativeInputChannel, lowLatencyMonitoring: next.lowLatencyMonitoring,
      })
      if (generation !== this.generation) throw abortError()
      await this.ensureWaveCapability()
      if (generation !== this.generation) throw abortError()
      const device = 'device' in result ? result.device : result
      if (device.sampleRate !== rate) throw new Error(`장치가 ${rate} Hz 요청 대신 ${device.sampleRate} Hz를 적용했습니다. 프로젝트와 장치의 샘플레이트를 맞춰 주세요.`)
      if (!(device.backend === 'test' && device.testClock === true)) {
        if (device.backend !== nativeBackendForPlatform(next, this.platform)) throw new Error('선택한 오디오 드라이버와 실제 열린 드라이버가 다릅니다.')
        if (next.outputDeviceId && device.outputDeviceId !== next.outputDeviceId) throw new Error('선택한 출력 장치와 실제 열린 장치가 다릅니다.')
        if (device.inputChannels > 0 && next.inputDeviceId && device.inputDeviceId !== next.inputDeviceId) throw new Error('선택한 입력 장치와 실제 열린 장치가 다릅니다.')
      }
      this.settings = next; this.desiredSampleRate = rate; this.configured = true
      this.setDevice(device)
      this.updateAudio({ status: 'ready', settings: next, requestedSampleRate: rate, needsReconfiguration: false, error: null })
      this.appliedRevision = -1
      await this.syncProject()
      if (generation !== this.generation) throw abortError()
      this.updateTransport({ ready: true, sampleRate: rate })
      if (this.monitorIds.length) await this.request('monitor.set', { trackIds: this.monitorIds, enabled: next.softwareMonitoring })
    } catch (error) {
      if (generation === this.generation) { this.configured = false; this.fail(error) }
      throw error
    }
  }

  setProject(project: Project): void {
    const rate = projectSampleRate(project.sampleRate)
    if (project === this.project) return
    if ((this.snapshot.playing || this.pendingPlayRequest !== null) && unsupportedNativeInstruments(project, this.sourceAvailable).length) this.pause()
    if (this.project?.id !== project.id) {
      this.clearWaveAudition(true); this.waveReady.clear(); this.wavePatchRequests.clear(); this.wavePayloads.clear()
    }
    this.project = project; this.desiredSampleRate = rate; this.revision++
    for (const trackId of new Set([...this.waveReady.keys(), ...this.waveNotes.keys()])) {
      if (!this.waveTrack(trackId)?.enabled) { this.releaseWaveNotes(trackId); this.waveReady.delete(trackId); this.wavePatchRequests.delete(trackId); this.wavePayloads.delete(trackId) }
    }
    this.updateAudio({ requestedSampleRate: rate, needsReconfiguration: !!this.nativeDevice && this.nativeDevice.sampleRate !== rate })
    this.updateTransport({ beat: clamp(this.snapshot.beat, 0, project.lengthBeats) })
    if (this.configured && this.nativeDevice?.sampleRate === rate) this.scheduleSync()
  }

  setAssets(assets: Map<string, AudioAsset>): void {
    if (assets.size === this.assets.size && [...assets].every(([id, value]) => this.assets.get(id)?.buffer === value.buffer)) return
    this.assets = new Map(assets); this.revision++
    if (this.configured) this.scheduleSync()
  }

  private scheduleSync(): void {
    if (this.syncTimer !== null) return
    // Coalescing edits does not schedule audio; native sample frames own musical timing.
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null
      void this.syncProject().catch(error => {
        if (isAbort(error)) return
        this.fail(error)
        void this.request('transport.pause').catch(() => undefined)
      })
    }, 16)
  }

  private async putPcm(id: string, buffer: AudioBuffer): Promise<void> {
    if (this.uploaded.get(id) === buffer) return
    const pending = this.uploadTasks.get(id)
    if (pending) { await pending; if (this.uploaded.get(id) === buffer) return }
    const generation = this.generation
    const task = (async () => {
      // The bridge writes a private PCM asset, not a path supplied by project JSON.
      await this.request('asset.put', { id, sampleRate: buffer.sampleRate, channels: Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel)) })
      if (generation !== this.generation) throw abortError()
      this.uploaded.set(id, buffer)
    })()
    this.uploadTasks.set(id, task)
    try { await task } finally { if (this.uploadTasks.get(id) === task) this.uploadTasks.delete(id) }
  }

  async preloadSamples(setId: string): Promise<void> {
    if (this.registeredSets.has(setId)) return
    const pending = this.sampleTasks.get(setId)
    if (pending) return pending
    const generation = this.generation
    const task = (async () => {
      const decoded = await this.samples.load(setId, this.codec())
      if (generation !== this.generation) throw abortError()
      const files: Record<string, string> = {}
      // Bound IPC memory and disk work; each decoded buffer is transferred only once.
      for (const [file, buffer] of decoded.buffers) {
        const id = `sample:${setId}:${file}`
        await this.putPcm(id, buffer); files[file] = id
        if (generation !== this.generation) throw abortError()
      }
      await this.request('samples.register', { id: setId, manifest: decoded.set, startOffset: decoded.startOffset, files })
      if (generation !== this.generation) throw abortError()
      this.registeredSets.add(setId); this.sampleErrors.delete(setId)
    })()
    this.sampleTasks.set(setId, task); this.publishSamples()
    try { await task }
    catch (error) { if (generation === this.generation) this.sampleErrors.set(setId, message(error)); throw error }
    finally { if (this.sampleTasks.get(setId) === task) this.sampleTasks.delete(setId); this.publishSamples() }
  }

  private publishSamples(): void { for (const listener of this.sampleListeners) listener() }

  private readonly sourceAvailable = (track: Track): boolean => !!track.pluginInstrument || (track.instrument === 'wavetable' ? this.waveCapability === true : canPlayInstrument(this, track.instrument))

  private async prepareTimeline(project: Project, revision: number) {
    for (const track of project.tracks) {
      if (track.kind !== 'instrument' || track.pluginInstrument) continue
      const setId = instrumentDef(track.instrument).set
      if (setId) await this.preloadSamples(setId)
    }
    const metadata = new Map<string, NativePcmAsset>()
    const referenced = new Set(project.tracks.flatMap(track => track.clips.flatMap(clip => clip.kind === 'audio' ? [clip.assetId] : [])))
    for (const id of referenced) {
      const asset = this.assets.get(id)
      if (!asset) throw new Error(`오디오 자산을 찾을 수 없습니다: ${id}`)
      await this.putPcm(id, asset.buffer)
      metadata.set(id, { id, sampleRate: asset.buffer.sampleRate, frames: asset.buffer.length, channels: asset.buffer.numberOfChannels })
    }
    const timeline = compileNativeTimeline(project, metadata, revision)
    // Native DSP receives the bounded binary schema. Unsupported older hosts
    // can still save/edit WAVE and play other tracks; audible use is rejected.
    const tracks = timeline.tracks.map(track => {
      if (track.source.kind !== 'native-wavetable') return track
      if (this.waveCapability !== true) return { ...track, source: { kind: 'audio' as const }, notes: [] }
      const { patch, ...source } = track.source
      return { ...track, source: { ...source, patchData: wavePatchData(patch) } }
    })
    return { ...timeline, tracks, lowLatencyMonitoring: this.settings.lowLatencyMonitoring }
  }

  private syncProject(): Promise<void> {
    if (this.syncTask) return this.syncTask
    if (!this.project || !this.configured || this.appliedRevision === this.revision) return Promise.resolve()
    const generation = this.generation, configuration = this.configurationEpoch
    const task = (async () => {
      while (generation === this.generation && configuration === this.configurationEpoch && this.project && this.appliedRevision !== this.revision) {
        const revision = this.revision
        // Settings Apply configures the device before the UI commits its project
        // rate. Compile the candidate at that rate so no stale-rate graph reaches it.
        const project = this.project.sampleRate === this.desiredSampleRate ? this.project : { ...this.project, sampleRate: this.desiredSampleRate }
        const timeline = await this.prepareTimeline(project, revision)
        if (generation !== this.generation || configuration !== this.configurationEpoch) throw abortError()
        if (revision !== this.revision) continue
        const awaitApplied = timeline.tracks.some(track => track.source.kind === 'native-wavetable')
        const result = await this.request<NativeProjectApplied>('project.set', { timeline, ...(awaitApplied ? { awaitApplied: true } : {}) })
        if (generation !== this.generation || configuration !== this.configurationEpoch) throw abortError()
        if (awaitApplied && result?.revision !== revision) throw new Error('IEUM WAVE의 프로젝트 적용 확인 번호가 일치하지 않습니다.')
        this.appliedRevision = revision
      }
    })()
    this.syncTask = task
    void task.finally(() => { if (this.syncTask === task) this.syncTask = null }).catch(() => undefined)
    return task
  }

  async resume(): Promise<void> {
    const generation = this.generation
    await this.ensureWaveCapability()
    if (generation !== this.generation) throw abortError()
    if (this.configurationTask) await this.configurationTask
    if (generation !== this.generation) throw abortError()
    if (this.audioSnapshot.status === 'error') throw new Error(this.audioSnapshot.error ?? '오디오 장치를 다시 적용해 주세요.')
    if (!this.configured || this.nativeDevice?.sampleRate !== this.desiredSampleRate) await this.beginConfiguration(this.settings, this.desiredSampleRate)
    else await this.syncProject()
  }

  async play(): Promise<void> {
    const request = ++this.transportRequest, generation = this.generation
    await this.ensureWaveCapability()
    if (generation !== this.generation) throw abortError()
    if (request !== this.transportRequest) return
    assertNativeInstrumentsSupported(this.requireProject(), this.sourceAvailable)
    await this.resume()
    if (generation !== this.generation || this.transportRequest !== request) return
    await this.startNativePlayback(request, generation, normalizedStart(this.requireProject(), this.snapshot.beat))
  }

  /** Shared by Play and playback restoration after opening recording/monitoring input. */
  private async startNativePlayback(request: number, generation: number, beat: number): Promise<void> {
    if (generation !== this.generation || request !== this.transportRequest) return
    assertNativeInstrumentsSupported(this.requireProject(), this.sourceAvailable)
    this.pendingPlayRequest = request
    try {
      await this.request('transport.play', { frame: this.frameForBeat(beat) })
      if (generation !== this.generation || request !== this.transportRequest) return
      this.updateTransport({ playing: true, ready: true, beat })
    } finally {
      if (this.pendingPlayRequest === request) this.pendingPlayRequest = null
    }
  }

  async togglePlayback(): Promise<void> { if (this.snapshot.playing) this.pause(); else await this.play() }

  pause(): void {
    this.transportRequest++
    this.pendingPlayRequest = null
    this.updateTransport({ playing: false })
    if (this.configured) void this.request('transport.pause').catch(error => this.fail(error))
  }

  async pauseAndWait(): Promise<void> {
    this.transportRequest++
    this.pendingPlayRequest = null
    this.updateTransport({ playing: false })
    if (this.configured) await this.request('transport.pause')
  }

  stop(): void {
    this.transportRequest++
    this.pendingPlayRequest = null
    this.clearWaveAudition(true)
    this.updateTransport({ playing: false, beat: 0 })
    if (this.configured) void this.request('transport.stop').catch(error => this.fail(error))
  }

  seek(beat: number): void {
    const position = this.project ? clamp(beat, 0, this.project.lengthBeats) : Math.max(0, finite(beat))
    this.updateTransport({ beat: position })
    if (this.configured) void this.request('transport.seek', { frame: this.frameForBeat(position) }).catch(error => this.fail(error))
  }

  private frameForBeat(beat: number): number { return Math.round(beat * 60 / (this.project?.bpm ?? 120) * this.desiredSampleRate) }

  async previewNote(instrument: InstrumentId, pitch: number, velocity = .8, trackId?: string): Promise<void> {
    const generation = this.generation
    await this.ensureWaveCapability()
    if (generation !== this.generation) throw abortError()
    const requestedTrack = trackId ? this.project?.tracks.find(item => item.id === trackId) : undefined
    if (!requestedTrack?.pluginInstrument && (requestedTrack?.instrument ?? instrument) === 'wavetable' && this.waveCapability !== true) throw new Error(WAVETABLE_HOST_REQUIRED)
    if (!requestedTrack && instrument === 'wavetable') throw new Error('IEUM WAVE 미리듣기에는 프로젝트의 악기 트랙이 필요합니다.')
    await this.resume()
    const def = instrumentDef(instrument)
    const track = trackId ? this.project?.tracks.find(item => item.id === trackId) : undefined
    if (trackId && (!track || !track.enabled || track.kind !== 'instrument')) return
    if (!track?.pluginInstrument && !canPlayInstrument(this, track?.instrument ?? instrument)) throw new Error(WAVETABLE_HOST_REQUIRED)
    if (!track?.pluginInstrument && def.set) await this.preloadSamples(def.set)
    if (generation !== this.generation) return
    await this.request('note.preview', {
      instrumentId: instrument, trackId, pitch: Math.round(clamp(pitch, 0, 127)), velocity: clamp(velocity, 0, 1),
      params: track?.instrumentParams ?? defaultInstrumentParams(instrument),
      sampleSetId: def.set, isKit: def.isKit, kind: def.kind,
      source: { kind: def.kind === 'sampled' ? 'builtin-sampled' : 'builtin-synth', instrumentId: instrument, sampleSetId: def.set, isKit: def.isKit, params: track?.instrumentParams ?? defaultInstrumentParams(instrument) },
      durationSeconds: instrument === 'pad' || def.kind === 'sampled' ? .65 : .3,
    })
  }

  /** Desktop capture is selected by native channel; MediaStream values are never consumed. */
  setInputMonitor(stream: MediaStream | null, trackIds: readonly string[]): void {
    if (stream) { this.fail(new Error('네이티브 모니터링에는 브라우저 MediaStream을 사용할 수 없습니다.')); return }
    void this.setNativeMonitoring(trackIds).catch(error => this.fail(error))
  }

  async setNativeMonitoring(trackIds: readonly string[]): Promise<void> {
    const request = ++this.monitorRequest, generation = this.generation
    this.monitorIds = [...new Set(trackIds)]
    if (!this.monitorIds.length && !this.configured) return
    if (this.monitorIds.length) {
      await this.resume()
      if (request !== this.monitorRequest || generation !== this.generation) return
      await this.ensureInput()
      if (request !== this.monitorRequest || generation !== this.generation) return
    }
    await this.request('monitor.set', { trackIds: this.monitorIds, enabled: this.settings.softwareMonitoring && this.monitorIds.length > 0 })
  }

  /** Called only by a user recording/monitoring action, never by ordinary playback. */
  private async ensureInput(): Promise<void> {
    const count = this.settings.inputChannels === 'default' ? 1 : this.settings.inputChannels
    if (this.nativeDevice && this.nativeDevice.inputChannels >= count && (this.nativeDevice.inputChannelOffset ?? 0) === this.settings.nativeInputChannel) return
    if (!this.captureWanted && !this.monitorIds.length) return
    const playing = this.snapshot.playing, beat = this.snapshot.beat, request = this.transportRequest, generation = this.generation
    await this.beginConfiguration(this.settings, this.desiredSampleRate)
    if (generation !== this.generation) throw abortError()
    if (request === this.transportRequest) {
      await this.request('transport.seek', { frame: this.frameForBeat(beat) })
      this.updateTransport({ beat })
    }
    if (playing && request === this.transportRequest && (this.captureWanted || this.monitorIds.length)) {
      await this.startNativePlayback(request, generation, beat)
    }
    if (!this.nativeDevice?.inputChannels) throw new Error('선택한 장치에 사용할 수 있는 오디오 입력이 없습니다.')
  }

  async prepareRecording(): Promise<void> {
    this.captureWanted = true
    try { await this.resume(); await this.ensureInput() }
    catch (error) { this.captureWanted = false; throw error }
  }

  cancelRecordingPreparation(): void { this.captureWanted = false }

  createRecording(trackId: string, callbacks: AudioRecordingCallbacks): NativeRecording {
    if (!this.configured || this.audioSnapshot.status !== 'ready') throw new Error('네이티브 입력 장치를 먼저 시작해 주세요.')
    return new NativeRecording(this.connect(), trackId, {
      ...callbacks,
      onComplete: result => { this.captureWanted = false; callbacks.onComplete(result) },
    }, this.desiredSampleRate)
  }

  /** Several armed tracks, each from its own input, sharing one start frame. Same lifetime as createRecording. */
  createRecordings(trackIds: readonly string[], callbacks: NativeRecordingsCallbacks): NativeRecordings {
    if (!this.configured || this.audioSnapshot.status !== 'ready') throw new Error('네이티브 입력 장치를 먼저 시작해 주세요.')
    if (trackIds.length > this.maxSimultaneousRecordings) throw new Error(`한 번에 ${this.maxSimultaneousRecordings}개 트랙까지 녹음할 수 있습니다.`)
    return new NativeRecordings(this.connect(), [...trackIds], {
      ...callbacks,
      onComplete: results => { this.captureWanted = false; callbacks.onComplete(results) },
    }, this.desiredSampleRate)
  }

  /**
   * Physical loopback (output pair → input channel) round trip, measured by the host while the
   * transport is stopped. The device must already be open with that input channel.
   */
  async measureLatency(options: { inputChannel: number; outputChannelOffset?: number }): Promise<NativeLatencyMeasurement> {
    const channel = (value: unknown, label: string) => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 255) throw new Error(`잘못된 ${label} 채널입니다.`)
      return value
    }
    const params: Record<string, unknown> = { inputChannel: channel(options.inputChannel, '입력') }
    if (options.outputChannelOffset !== undefined) params.outputChannelOffset = channel(options.outputChannelOffset, '출력')
    if (!this.configured) throw new Error('지연을 측정하려면 오디오 장치를 먼저 시작해 주세요.')
    if (this.snapshot.playing) await this.pauseAndWait()
    const value = await this.request<Record<string, unknown>>('latency.measure', params)
    const frames = (field: unknown, label: string): number | null => {
      if (field === null || field === undefined) return null
      if (typeof field !== 'number' || !Number.isSafeInteger(field)) throw new Error(`네이티브 엔진이 잘못된 ${label} 값을 반환했습니다.`)
      return field
    }
    const confidence = finite(value?.confidence, NaN)
    if (!(confidence >= 0 && confidence <= 1)) throw new Error('네이티브 엔진이 잘못된 측정 신뢰도를 반환했습니다.')
    const roundTripFrames = frames(value.roundTripFrames, '왕복 지연')
    if (roundTripFrames !== null && roundTripFrames < 0) throw new Error('네이티브 엔진이 잘못된 왕복 지연 값을 반환했습니다.')
    return { roundTripFrames, reportedFrames: frames(value.reportedFrames, '드라이버 지연'), extraFrames: frames(value.extraFrames, '추가 지연'),
      confidence, attempts: frames(value.attempts, '시도 횟수') ?? 0 }
  }

  async testOutput(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    await this.resume()
    let end: (() => void) | null = null
    const stop = () => { end?.(); void this.request('output.test', { active: false }).catch(() => undefined) }
    signal.addEventListener('abort', stop, { once: true })
    try {
      if (signal.aborted) return
      await this.request('output.test', { active: true, seconds: .7 })
      if (!signal.aborted) await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 700)
        end = () => { clearTimeout(timer); resolve() }
      })
    } finally { signal.removeEventListener('abort', stop); await this.request('output.test', { active: false }).catch(() => undefined) }
  }

  private codec(): OfflineAudioContext {
    if (!this.decodeContext || this.decodeContext.sampleRate !== this.desiredSampleRate) this.decodeContext = new OfflineAudioContext(1, 1, this.desiredSampleRate)
    return this.decodeContext
  }

  async decodeAsset(blob: Blob, name: string, id: string = globalThis.crypto.randomUUID()): Promise<AudioAsset> {
    if (!blob.size) throw new Error('비어 있는 오디오 파일입니다.')
    const owned = await ownAudioBytes(blob, name)
    let buffer: AudioBuffer
    try { buffer = await this.codec().decodeAudioData(owned.bytes) }
    catch { throw new Error('이 오디오 파일을 읽을 수 없습니다. 지원되는 WAV, MP3, AAC, OGG 또는 WebM 파일을 사용해 주세요.') }
    if (!buffer.length || !Number.isFinite(buffer.duration)) throw new Error('오디오 파일에 재생할 데이터가 없습니다.')
    const count = Math.min(320, buffer.length), peaks: number[] = []
    for (let point = 0; point < count; point++) {
      const start = Math.floor(point * buffer.length / count), end = Math.floor((point + 1) * buffer.length / count)
      const stride = Math.max(1, Math.floor((end - start) / 256)); let peak = 0
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const values = buffer.getChannelData(channel)
        for (let frame = start; frame < end; frame += stride) peak = Math.max(peak, Math.abs(values[frame]))
      }
      peaks.push(Math.min(1, peak))
    }
    return { id, name, blob: owned.blob, buffer, peaks }
  }

  async exportWav(project = this.requireProject()): Promise<Blob> {
    const generation = this.generation
    await this.ensureWaveCapability()
    if (generation !== this.generation) throw abortError()
    assertNativeInstrumentsSupported(project, this.sourceAvailable)
    // Wait for uploads/graph edits and their errors before asking the host to clone.
    await this.resume()
    await this.pauseAndWait()
    const timeline = await this.prepareTimeline(project, this.revision)
    if (generation !== this.generation) throw abortError()
    assertNativeInstrumentsSupported(project, this.sourceAvailable)
    const result = await this.request<NativeAudioFile>('render.wav', { timeline })
    if (!(result?.data instanceof Uint8Array) || result.data.byteLength < 44) throw new Error('네이티브 엔진이 유효한 WAV 파일을 반환하지 않았습니다.')
    return new Blob([new Uint8Array(result.data)], { type: 'audio/wav' })
  }

  async listPlugins(): Promise<NativePluginDescriptor[]> { return this.request('plugins.list') }
  async openDriverPanel(): Promise<void> { await this.request('device.controlPanel') }
  async scanPlugins(): Promise<NativePluginDescriptor[]> { return this.request('plugins.scan') }
  async pluginParameters(instanceId: string): Promise<NativePluginParameter[]> {
    await this.resume()
    await this.syncProject()
    const result = await this.request<Array<NativePluginParameter & { id: string | number }>>('plugins.parameters', { instanceId })
    if (!Array.isArray(result)) throw new Error('플러그인 파라미터를 읽지 못했습니다.')
    return result.filter(parameter => Number.isFinite(parameter.value) && parameter.value >= 0 && parameter.value <= 1).map(parameter => ({ ...parameter, id: String(parameter.id), min: 0, max: 1 }))
  }
  async setPluginParameter(instanceId: string, id: string, value: number): Promise<void> {
    if (!Number.isFinite(value)) throw new Error('플러그인 값은 유한한 숫자여야 합니다.')
    await this.request('plugins.parameter', { instanceId, id, value: clamp(value, 0, 1) })
  }
  async pluginEditor(instanceId: string, open: boolean): Promise<void> {
    await this.resume()
    await this.syncProject()
    await this.request('plugins.editor', { instanceId, open })
  }
  async pluginState(instanceId: string): Promise<NativePluginState> {
    await this.pauseAndWait()
    await this.syncProject()
    return validateNativePluginState(await this.request('plugins.state', { instanceId }))
  }

  /** Returns the same object when nothing changed; otherwise a copy that keeps every field (a VST3 device stays a device). */
  async capturePlugin<T extends NativePluginInstance>(instance: T, allowUnloaded = !instance.enabled): Promise<T> {
    await this.pauseAndWait(); await this.syncProject()
    const value = await this.request('plugins.state', { instanceId: instance.id, allowUnloaded })
    if (value === null && allowUnloaded) return instance
    const state = validateNativePluginState(value)
    // An editor can change values without going through our sliders. Capturing
    // current values prevents an old parameter map overriding the restored state.
    const parameters = { ...instance.parameters }
    for (const parameter of await this.pluginParameters(instance.id)) if (!parameter.readOnly) parameters[parameter.id] = parameter.value
    return JSON.stringify(parameters) === JSON.stringify(instance.parameters) && state.component === instance.state?.component && state.controller === instance.state?.controller
      ? instance : { ...instance, state, parameters }
  }

  /** Call for explicit save/close or after editing a plugin, never on a realtime callback. */
  async capturePluginStates(project: Project): Promise<Project> {
    const pluginsOf = (track: Track): NativePluginInstance[] => [...(track.pluginInstrument ? [track.pluginInstrument] : []), ...track.devices.filter(isPluginDevice)]
    const instances = project.tracks.flatMap(pluginsOf)
    if (!instances.length || !this.configured) return project
    await this.pauseAndWait()
    await this.syncProject()
    const captured = new Map<string, NativePluginInstance>()
    for (const track of project.tracks) for (const instance of pluginsOf(track)) {
      captured.set(instance.id, await this.capturePlugin(instance, !track.enabled || !instance.enabled))
    }
    if (instances.every(instance => captured.get(instance.id) === instance)) return project
    return { ...project, tracks: project.tracks.map(track => {
      const instrument = track.pluginInstrument && captured.get(track.pluginInstrument.id)!
      // capturePlugin keeps every field it was given, so a VST3 device stays a device.
      const devices = track.devices.map(device => device.type === 'vst3' ? captured.get(device.id) as typeof device : device)
      if (instrument === track.pluginInstrument && devices.every((device, index) => device === track.devices[index])) return track
      return { ...track, ...(instrument ? { pluginInstrument: instrument } : {}), devices }
    }) }
  }

  dispose(): void {
    this.clearWaveAudition(true)
    this.generation++; this.transportRequest++; this.monitorRequest++
    this.pendingPlayRequest = null
    if (this.syncTimer !== null) clearTimeout(this.syncTimer)
    const hostWasUsed = this.configured || !!this.configurationTask || !!this.bridgeRelease
    this.syncTimer = null; this.syncTask = null; this.configurationTask = null
    const bridge = this.bridge
    if (hostWasUsed && bridge) this.closingTask = bridge.request('engine.close').then(() => undefined)
    if (this.closingTask) void this.closingTask.catch(() => undefined)
    this.bridgeRelease?.(); this.bridgeRelease = null
    this.configured = false; this.nativeDevice = null; this.monitorIds = []; this.captureWanted = false; this.appliedRevision = -1
    this.waveCapability = undefined; this.waveCapabilityTask = null; this.waveCapabilityReason = WAVETABLE_UNAVAILABLE_STATUS.reason!
    this.wavePatchRequests.clear(); this.wavePayloads.clear()
    this.project = null; this.assets = new Map(); this.decodeContext = null
    this.uploaded.clear(); this.uploadTasks.clear(); this.registeredSets.clear(); this.sampleTasks.clear(); this.sampleErrors.clear()
    this.levels.clear(); this.masterLevel = 0
    this.updateTransport({ playing: false, ready: false, beat: 0 })
    this.updateAudio({ status: this.bridge ? 'idle' : 'error', contextState: 'uninitialized', sampleRate: null, nativeDevice: null, error: this.bridge ? null : '네이티브 오디오 연결부가 없습니다.', needsReconfiguration: false })
    this.listeners.clear(); this.audioListeners.clear(); this.inputListeners.clear(); this.sampleListeners.clear(); this.waveListeners.clear()
  }

  private requireProject(): Project {
    if (!this.project) throw new Error('프로젝트가 아직 준비되지 않았습니다.')
    return this.project
  }
}

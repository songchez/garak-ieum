/** Browser/device preferences are local; the rendering sample rate belongs to Project. */
export const SAMPLE_RATES = [44100, 48000, 88200, 96000, 176400, 192000] as const
export type SampleRate = typeof SAMPLE_RATES[number]
export const DEFAULT_SAMPLE_RATE: SampleRate = 48000
export const RENDER_SIZES = ['default', 'hardware', 32, 64, 128, 256, 512, 1024] as const
export type RenderSizeHint = typeof RENDER_SIZES[number]
export type LatencyHint = 'interactive' | 'balanced' | 'playback'
/** `driver` asks the driver for its preferred block; a number is snapped by ASIO to its nearest allowed size. */
export type NativeBufferFrames = number | 'driver'
/** Native engine worker threads besides the audio callback: `auto` = hardware threads - 1 (at most 8), 0 = single-threaded. */
export type ProcessingThreads = 'auto' | number
export const MAX_PROCESSING_THREADS = 16
/** Pre-render playing tracks that are not live (not monitored, recording or played live) ahead of the callback. */
export type RenderAhead = 'off' | 'normal' | 'high'
/** Per device (`${backend}:${deviceId}`): which physical channels open, how inputs pair, and the user's names. */
export interface NativeDeviceProfile {
  /** Enabled physical inputs (zero based, ascending, at most MAX_ENABLED_INPUTS). The host opens exactly these. */
  inputs: number[]
  /** Left channel `p` of each stereo pair `p, p + 1`; both channels are in `inputs`. */
  stereoPairs: number[]
  /** Names override the driver's channel names; an absent entry falls back to the driver. */
  inputNames: Record<number, string>
  outputNames: Record<number, string>
}
export const MAX_ENABLED_INPUTS = 32
export const MAX_PHYSICAL_CHANNELS = 256
export const MAX_CHANNEL_NAME = 64
/** ±1 s at the highest supported rate; the old ±1000 ms manual range fits at every rate. */
export const MAX_RECORDING_OFFSET_FRAMES = 192000
/** Old millisecond offsets carried no rate; 48 kHz was the default project rate when they were written. */
const LEGACY_OFFSET_RATE = 48000

export interface AudioSettings {
  inputDeviceId: string
  outputDeviceId: string
  latencyHint: LatencyHint
  /** Web Audio render quantum request, not the audio interface's hardware I/O buffer. */
  renderSizeHint: RenderSizeHint
  softwareMonitoring: boolean
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
  inputChannels: 'default' | 1 | 2
  /**
   * Sample frames at the device (= project) rate. Positive shifts the new recorded region later;
   * negative shifts it earlier. Replaces `recordingOffsetMs`, which is read once and converted.
   */
  recordingOffsetFrames: number
  /** Device backend is independent of the web renderer. Auto resolves by desktop platform. */
  nativeBackend: 'auto' | 'asio' | 'wasapi' | 'coreaudio'
  nativeBufferFrames: NativeBufferFrames
  /**
   * Legacy single input selection (zero based; stereo used this channel and the next). Only read
   * to derive the profile of a device that has none yet; see nativeInputProfile.
   */
  nativeInputChannel: number
  lowLatencyMonitoring: boolean
  nativeDeviceProfiles: Record<string, NativeDeviceProfile>
  /** Close the driver while the window is in the background so other apps can use it (Cubase-style). */
  releaseInBackground: boolean
  /** Driver clock source index from `devices.probe`; absent keeps the driver's own choice. */
  clockSource?: number
  /** Interface hardware (ASIO direct) monitoring, when the driver supports it. */
  directMonitoring: boolean
  /** Multi-core track processing in the native engine. */
  processingThreads: ProcessingThreads
  /** Render-ahead window for non-live tracks: normal = 2 device buffers, high = 4. */
  renderAhead: RenderAhead
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  inputDeviceId: '', outputDeviceId: '', latencyHint: 'interactive', renderSizeHint: 'default',
  softwareMonitoring: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
  inputChannels: 'default', recordingOffsetFrames: 0,
  nativeBackend: 'auto', nativeBufferFrames: 'driver', nativeInputChannel: 0, lowLatencyMonitoring: true,
  nativeDeviceProfiles: {}, releaseInBackground: false, directMonitoring: false,
  processingThreads: 'auto', renderAhead: 'off',
}
export const AUDIO_SETTINGS_STORAGE_KEY = 'garak-ieum:audio-settings:v1'

export const isSampleRate = (value: unknown): value is SampleRate => SAMPLE_RATES.some(rate => rate === value)

/** Missing rate migrates old v1/v2 projects; an explicitly invalid rate is never silently changed. */
export function projectSampleRate(value: unknown): SampleRate {
  if (value === undefined) return DEFAULT_SAMPLE_RATE
  if (!isSampleRate(value)) throw new Error('Project sample rate must be one of the supported sample rates.')
  return value
}

export function normalizeAudioSettings(value: unknown): AudioSettings {
  const raw = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const id = (key: string) => typeof raw[key] === 'string' && raw[key].length <= 1024 ? raw[key] : ''
  const flag = (key: keyof AudioSettings) => typeof raw[key] === 'boolean' ? raw[key] : DEFAULT_AUDIO_SETTINGS[key] as boolean
  return {
    inputDeviceId: id('inputDeviceId'), outputDeviceId: id('outputDeviceId'),
    latencyHint: raw.latencyHint === 'balanced' || raw.latencyHint === 'playback' ? raw.latencyHint : 'interactive',
    renderSizeHint: RENDER_SIZES.some(size => size === raw.renderSizeHint) ? raw.renderSizeHint as RenderSizeHint : 'default',
    softwareMonitoring: flag('softwareMonitoring'), echoCancellation: flag('echoCancellation'),
    noiseSuppression: flag('noiseSuppression'), autoGainControl: flag('autoGainControl'),
    inputChannels: raw.inputChannels === 1 || raw.inputChannels === 2 ? raw.inputChannels : 'default',
    recordingOffsetFrames: recordingOffsetFrames(raw),
    nativeBackend: raw.nativeBackend === 'asio' || raw.nativeBackend === 'wasapi' || raw.nativeBackend === 'coreaudio' ? raw.nativeBackend : 'auto',
    nativeBufferFrames: raw.nativeBufferFrames === 'driver' || isBufferFrames(raw.nativeBufferFrames) ? raw.nativeBufferFrames : 'driver',
    nativeInputChannel: channelIndex(raw.nativeInputChannel) ? raw.nativeInputChannel : 0,
    lowLatencyMonitoring: flag('lowLatencyMonitoring'),
    nativeDeviceProfiles: normalizeProfiles(raw.nativeDeviceProfiles),
    releaseInBackground: flag('releaseInBackground'),
    ...(channelIndex(raw.clockSource) ? { clockSource: raw.clockSource } : {}),
    directMonitoring: flag('directMonitoring'),
    processingThreads: isProcessingThreads(raw.processingThreads) ? raw.processingThreads : 'auto',
    renderAhead: raw.renderAhead === 'normal' || raw.renderAhead === 'high' ? raw.renderAhead : 'off',
  }
}

const isProcessingThreads = (value: unknown): value is AudioSettings['processingThreads'] =>
  value === 'auto' || (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_PROCESSING_THREADS)

const isBufferFrames = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 16 && value <= 8192
const channelIndex = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MAX_PHYSICAL_CHANNELS
const clampOffset = (frames: number) => Math.round(Math.min(MAX_RECORDING_OFFSET_FRAMES, Math.max(-MAX_RECORDING_OFFSET_FRAMES, frames)))

function recordingOffsetFrames(raw: Record<string, unknown>): number {
  const frames = raw.recordingOffsetFrames, ms = raw.recordingOffsetMs
  if (typeof frames === 'number' && Number.isFinite(frames)) return clampOffset(frames)
  if (typeof ms === 'number' && Number.isFinite(ms)) return clampOffset(Math.min(1000, Math.max(-1000, ms)) * LEGACY_OFFSET_RATE / 1000)
  return 0
}

function names(value: unknown): Record<number, string> {
  const result: Record<number, string> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [key, name] of Object.entries(value)) {
    const index = Number(key)
    if (!channelIndex(index) || typeof name !== 'string') continue
    const text = name.trim().slice(0, MAX_CHANNEL_NAME)
    if (text) result[index] = text
  }
  return result
}

/** Sorted, unique, bounded; a pair survives only when both of its channels are enabled and it overlaps no earlier pair. */
export function normalizeDeviceProfile(value: unknown): NativeDeviceProfile {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const inputs = [...new Set(Array.isArray(raw.inputs) ? raw.inputs.filter(channelIndex) : [])].sort((a, b) => a - b).slice(0, MAX_ENABLED_INPUTS)
  const enabled = new Set(inputs), stereoPairs: number[] = []
  for (const left of [...new Set(Array.isArray(raw.stereoPairs) ? raw.stereoPairs.filter(channelIndex) : [])].sort((a, b) => a - b)) {
    if (enabled.has(left) && enabled.has(left + 1) && (stereoPairs.at(-1) ?? -2) + 1 < left) stereoPairs.push(left)
  }
  return { inputs, stereoPairs, inputNames: names(raw.inputNames), outputNames: names(raw.outputNames) }
}

function normalizeProfiles(value: unknown): Record<string, NativeDeviceProfile> {
  const result: Record<string, NativeDeviceProfile> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  // Bounded: one entry per device ever configured on this computer.
  for (const [key, profile] of Object.entries(value).slice(0, 64)) {
    if (/^(asio|wasapi|coreaudio):/.test(key) && key.length <= 1100) result[key] = normalizeDeviceProfile(profile)
  }
  return result
}

export const nativeProfileKey = (backend: string, deviceId: string): string => `${backend}:${deviceId}`
/** ASIO opens one device for both directions; other backends take inputs from the input device. */
export const nativeInputDeviceId = (settings: AudioSettings, backend: string): string => backend === 'asio' ? settings.outputDeviceId : settings.inputDeviceId

/** The saved profile, or one derived from the legacy single-input settings (the migration path). */
export function nativeInputProfile(settings: AudioSettings, backend: string, deviceId = nativeInputDeviceId(settings, backend)): NativeDeviceProfile {
  const saved = settings.nativeDeviceProfiles[nativeProfileKey(backend, deviceId)]
  if (saved) return saved
  const first = settings.nativeInputChannel
  return settings.inputChannels === 2
    ? { inputs: [first, first + 1], stereoPairs: [first], inputNames: {}, outputNames: {} }
    : { inputs: [first], stereoPairs: [], inputNames: {}, outputNames: {} }
}

export const nativeOutputProfile = (settings: AudioSettings, backend: string): NativeDeviceProfile =>
  settings.nativeDeviceProfiles[nativeProfileKey(backend, settings.outputDeviceId)] ?? { inputs: [], stereoPairs: [], inputNames: {}, outputNames: {} }

/** `engine.configure`'s `inputChannelList`: the physical channels the host opens, in callback order. */
export const nativeInputChannelList = (settings: AudioSettings, backend: string): number[] => normalizeDeviceProfile(nativeInputProfile(settings, backend)).inputs

/** Keep partial signed input in the UI until it is a whole number of frames within ±MAX_RECORDING_OFFSET_FRAMES. */
export function parseRecordingOffsetFrames(value: string): number | null {
  const text = value.trim()
  if (!/^[+-]?\d+$/.test(text)) return null
  const number = Number(text)
  return Number.isSafeInteger(number) && Math.abs(number) <= MAX_RECORDING_OFFSET_FRAMES ? number : null
}

/** Milliseconds for placement code that still works in time; frames are at the recording's sample rate. */
export const recordingOffsetMs = (settings: AudioSettings, sampleRate: number): number => sampleRate > 0 ? settings.recordingOffsetFrames * 1000 / sampleRate : 0

export function loadAudioSettings(): AudioSettings {
  try { return normalizeAudioSettings(JSON.parse(localStorage.getItem(AUDIO_SETTINGS_STORAGE_KEY) ?? 'null')) }
  catch { return { ...DEFAULT_AUDIO_SETTINGS } }
}

/** False means preferences are only effective for this session; the caller must report this. */
export function saveAudioSettings(settings: AudioSettings): boolean {
  try { localStorage.setItem(AUDIO_SETTINGS_STORAGE_KEY, JSON.stringify(normalizeAudioSettings(settings))); return true }
  catch { return false }
}

/** Constraints are requests. Always read MediaStreamTrack.getSettings() to display actual capture values. */
export function inputConstraints(settings: AudioSettings, sampleRate?: SampleRate): MediaStreamConstraints {
  const requested = normalizeAudioSettings(settings)
  return { audio: {
    ...(requested.inputDeviceId ? { deviceId: { exact: requested.inputDeviceId } } : {}),
    ...(requested.inputChannels === 'default' ? {} : { channelCount: { ideal: requested.inputChannels } }),
    ...(sampleRate === undefined ? {} : { sampleRate: { ideal: projectSampleRate(sampleRate) } }),
    echoCancellation: requested.echoCancellation, noiseSuppression: requested.noiseSuppression, autoGainControl: requested.autoGainControl,
  } }
}

export interface AudioState {
  status: 'idle' | 'configuring' | 'ready' | 'error'
  contextState: AudioContextState | 'uninitialized'
  settings: AudioSettings
  requestedSampleRate: SampleRate
  sampleRate: number | null
  /** Browser-reported output-path values, in seconds. Neither is a measured round-trip latency. */
  baseLatency: number | null
  outputLatency: number | null
  sinkId: string | null
  renderQuantumSize: number | null
  supportsOutputSelection: boolean
  supportsRenderSize: boolean
  needsReconfiguration: boolean
  error: string | null
  /** Native driver reports; kept separate from browser render-quantum hints. */
  nativeDevice?: import('../audio/native/contracts').NativeDeviceState | null
  inputLatency?: number | null
  pluginLatencyFrames?: number
  underruns?: number
  commandOverflows?: number
  voiceOverflows?: number
}

export interface InputState {
  status: 'idle' | 'requesting' | 'active' | 'error'
  deviceLabel: string | null
  settings: MediaTrackSettings | null
  error: string | null
}

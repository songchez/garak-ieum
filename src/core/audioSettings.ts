/** Browser/device preferences are local; the rendering sample rate belongs to Project. */
export const SAMPLE_RATES = [44100, 48000, 88200, 96000, 176400, 192000] as const
export type SampleRate = typeof SAMPLE_RATES[number]
export const DEFAULT_SAMPLE_RATE: SampleRate = 48000
export const RENDER_SIZES = ['default', 'hardware', 32, 64, 128, 256, 512, 1024] as const
export type RenderSizeHint = typeof RENDER_SIZES[number]
export type LatencyHint = 'interactive' | 'balanced' | 'playback'

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
  /** Positive shifts the new recorded region later; negative shifts it earlier. */
  recordingOffsetMs: number
  /** Device backend is independent of the web renderer. Auto resolves by desktop platform. */
  nativeBackend: 'auto' | 'asio' | 'wasapi' | 'coreaudio'
  nativeBufferFrames: number
  /** First physical input channel (zero based); stereo uses this channel and the next. */
  nativeInputChannel: number
  lowLatencyMonitoring: boolean
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  inputDeviceId: '', outputDeviceId: '', latencyHint: 'interactive', renderSizeHint: 'default',
  softwareMonitoring: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
  inputChannels: 'default', recordingOffsetMs: 0,
  nativeBackend: 'auto', nativeBufferFrames: 128, nativeInputChannel: 0, lowLatencyMonitoring: true,
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
    recordingOffsetMs: typeof raw.recordingOffsetMs === 'number' && Number.isFinite(raw.recordingOffsetMs)
      ? Math.round(Math.min(1000, Math.max(-1000, raw.recordingOffsetMs))) : 0,
    nativeBackend: raw.nativeBackend === 'asio' || raw.nativeBackend === 'wasapi' || raw.nativeBackend === 'coreaudio' ? raw.nativeBackend : 'auto',
    nativeBufferFrames: typeof raw.nativeBufferFrames === 'number' && Number.isInteger(raw.nativeBufferFrames) && raw.nativeBufferFrames >= 16 && raw.nativeBufferFrames <= 8192 ? raw.nativeBufferFrames : 128,
    nativeInputChannel: typeof raw.nativeInputChannel === 'number' && Number.isInteger(raw.nativeInputChannel) && raw.nativeInputChannel >= 0 && raw.nativeInputChannel < 256 ? raw.nativeInputChannel : 0,
    lowLatencyMonitoring: flag('lowLatencyMonitoring'),
  }
}

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

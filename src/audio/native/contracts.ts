import type { SampleAttribution } from '../../core/types'

/** Only control data crosses this boundary. Live PCM stays inside the native process. */
export interface NativeAudioBridge {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>
  subscribe(callback: (event: NativeEngineEvent) => void): () => void
}

export type NativeBackend = 'asio' | 'wasapi' | 'coreaudio'

/** Host error codes (docs/AUDIO_CORE_PLAN.md). The request Error carries `code` and optional `details`. */
export type NativeErrorCode = 'DEVICE_NOT_FOUND' | 'DEVICE_IN_USE' | 'DRIVER_INIT_FAILED' | 'SAMPLE_RATE_UNSUPPORTED'
  | 'BUFFER_UNSUPPORTED' | 'CHANNELS_UNAVAILABLE' | 'DEVICE_LOST'
export interface NativeRequestError extends Error {
  code?: NativeErrorCode
  details?: unknown
}

/** `devices.probe`: what a driver reports after it is opened. Unknown values are empty or null. */
export interface NativeDeviceProbe {
  id: string
  name: string
  backend: NativeBackend | 'test'
  inputs: { index: number; name: string }[]
  outputs: { index: number; name: string }[]
  sampleRates: number[]
  currentSampleRate: number | null
  buffer: { min: number | null; max: number | null; preferred: number | null; granularity: number | null; sizes: number[]; fixed: boolean }
  clockSources: { index: number; name: string; current: boolean }[]
  canDirectMonitor: boolean
  inputLatencyFrames: number | null
  outputLatencyFrames: number | null
}

/** One take of a multi-track recording (`record.start` / `record.stop` with `takes`). */
export interface NativeRecordingTake {
  trackId: string
  takeId: string
  channels: number
  startFrame: number
  rawStartFrame: number
  compensationFrames: number
  compensationKnown: boolean
}

/** `latency.measure`: a physical output→input loopback, not a driver report. */
export interface NativeLatencyMeasurement {
  roundTripFrames: number | null
  reportedFrames: number | null
  extraFrames: number | null
  confidence: number
  attempts: number
}

/** Advertised by the loaded host, independently of opening an audio device. */
export interface NativeEngineCapabilities {
  protocol: number
  wavetable?: { protocolVersion: number; schemaFingerprint: number }
}

/** With awaitApplied, this revision has crossed the native audio block boundary. */
export interface NativeProjectApplied {
  revision: number
}

export interface NativeDevice {
  id: string
  name: string
  backend: NativeBackend
  inputChannels: number
  outputChannels: number
  isDefault?: boolean
  sampleRates?: number[]
  bufferSizes?: number[]
  minBufferFrames?: number
  maxBufferFrames?: number
  preferredBufferFrames?: number
}

export interface NativeDeviceState {
  /** `test` is reported only by an explicitly started test-clock harness. */
  backend: NativeBackend | 'test'
  testClock?: boolean
  inputDeviceId: string
  outputDeviceId: string
  inputName?: string
  outputName?: string
  sampleRate: number
  bufferFrames: number
  inputChannels: number
  outputChannels: number
  inputChannelOffset?: number
  outputChannelOffset?: number
  inputDeviceSampleRate?: number
  outputDeviceSampleRate?: number
  resampling?: boolean
  needsReconfigure?: boolean
  running?: boolean
  error?: string
  /** Device/driver reports in frames, not a physical loopback measurement. */
  inputLatencyFrames?: number | null
  outputLatencyFrames?: number | null
  underruns?: number
  /** docs/AUDIO_CORE_PLAN.md additions (WP1/WP2). */
  inputChannelList?: number[]
  inputNames?: string[]
  outputNames?: string[]
  bufferAdjusted?: boolean
  recovering?: boolean
  recoveries?: number
  suspended?: boolean
  clockSource?: number | null
  directMonitoring?: boolean
  overloads?: number
  lastCallbackLoad?: number
}

export interface NativeEngineEvent {
  type: 'state' | 'error'
  generation?: number
  revision?: number
  playing?: boolean
  frame?: number
  sampleRate?: number
  ready?: boolean
  levels?: Record<string, number>
  masterLevel?: number
  device?: NativeDeviceState
  error?: string | null
  recording?: boolean
  recordingStartFrame?: number
  recordedFrames?: number
  recordingDroppedFrames?: number
  latencyFrames?: number
  commandOverflows?: number
  voiceOverflows?: number
}

export interface NativeAudioFile {
  takeId?: string
  name?: string
  data: Uint8Array
  startFrame?: number
  rawStartFrame?: number
  compensationFrames?: number
  compensationKnown?: boolean
  frames?: number
  sampleRate?: number
  channels?: number
  error?: string | null
}

export interface NativePluginDescriptor {
  pluginId: string
  classId: string
  name: string
  vendor: string
  version?: string
  isInstrument: boolean
  category?: string
  hasEditor?: boolean
}

export interface NativePluginParameter {
  id: string
  title: string
  min: 0
  max: 1
  defaultValue: number
  value: number
  stepCount: number
  units?: string
  readOnly?: boolean
  hidden?: boolean
}

export interface NativePluginState {
  component: string
  controller?: string
}

/** No executable path is accepted in a .garak project. Catalog consent lives in Electron. */
export interface NativePluginInstance {
  id: string
  pluginId: string
  classId: string
  name: string
  enabled: boolean
  parameters: Record<string, number>
  state?: NativePluginState
}

export interface NativeSampleStatus {
  status: 'idle' | 'loading' | 'ready' | 'error'
  attribution?: SampleAttribution
  error?: string
}

export const NATIVE_PROTOCOL_VERSION = 1
export const MAX_PLUGIN_STATE_BYTES = 16 * 1024 * 1024


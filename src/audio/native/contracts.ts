import type { SampleAttribution } from '../../core/types'

/** Only control data crosses this boundary. Live PCM stays inside the native process. */
export interface NativeAudioBridge {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>
  subscribe(callback: (event: NativeEngineEvent) => void): () => void
}

export type NativeBackend = 'asio' | 'wasapi' | 'coreaudio'

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


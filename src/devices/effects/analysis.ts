import type { DeviceGraph } from '../contracts.js'

/**
 * Live analysis taps for graphical 시김새 editors (spectrum behind the EQ curve, etc.).
 * A realtime device graph may expose `analysisTap`; the audio graph binds it to the device id.
 * Offline (export) contexts never register. Only the Web Audio engine feeds taps; the native
 * desktop engine has no analysis stream to the UI yet.
 */
export interface DeviceAnalysisTap { readonly analyser: AnalyserNode; readonly sampleRate: number }
const taps = new Map<string, DeviceAnalysisTap>()

export function bindDeviceAnalysis(graph: DeviceGraph, deviceId: string, context: BaseAudioContext): void {
  const tap = (graph as DeviceGraph & { analysisTap?: DeviceAnalysisTap }).analysisTap
  if (!tap || 'startRendering' in context) return
  taps.set(deviceId, tap)
}
export function unbindDeviceAnalysis(tap: DeviceAnalysisTap): void {
  for (const [id, value] of taps) if (value === tap) taps.delete(id)
}
export function deviceAnalysisTap(deviceId: string): DeviceAnalysisTap | undefined { return taps.get(deviceId) }

/** Post-effect analyser for realtime contexts only (none while exporting). */
export function createAnalysisTap(context: BaseAudioContext, source: AudioNode, remember: <T extends AudioNode>(node: T) => T): DeviceAnalysisTap | undefined {
  if ('startRendering' in context || typeof context.createAnalyser !== 'function') return undefined
  const analyser = remember(context.createAnalyser())
  analyser.fftSize = 4096
  analyser.smoothingTimeConstant = 0.72
  analyser.minDecibels = -110
  analyser.maxDecibels = 0
  source.connect(analyser)
  return { analyser, sampleRate: context.sampleRate }
}

/** Stereo time-domain scope (goniometer / correlation) on top of the mono tap interface. */
export interface StereoScopeTap extends DeviceAnalysisTap { readonly left: AnalyserNode; readonly right: AnalyserNode }

/** Post-effect L/R analysers for realtime contexts only (utility's stereo image view). */
export function createStereoScopeTap(context: BaseAudioContext, source: AudioNode, remember: <T extends AudioNode>(node: T) => T): StereoScopeTap | undefined {
  if ('startRendering' in context || typeof context.createAnalyser !== 'function') return undefined
  const splitter = remember(context.createChannelSplitter(2))
  const left = remember(context.createAnalyser()), right = remember(context.createAnalyser())
  left.fftSize = 1024; right.fftSize = 1024
  source.connect(splitter); splitter.connect(left, 0); splitter.connect(right, 1)
  return { analyser: left, left, right, sampleRate: context.sampleRate }
}

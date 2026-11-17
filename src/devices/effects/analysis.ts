/**
 * Live analysis taps for graphical 시김새 editors (spectrum behind the EQ curve, the utility's stereo scope).
 *
 * Looking a tap up is also the request for it: the engine hosts (src/audio/WebAudioEngine.ts, the desktop's
 * src/audio/native/NativeAudioEngine.ts) ask the engine for the taps editors looked up in the last moment
 * (`requestedDeviceAnalysis`), and register each one here once the engine streams it. Closing the editor stops
 * the lookups, and the engine stops the tap.
 */

/** The AnalyserNode subset the editors read (the engine's taps implement it: src/audio/engineAnalyser.ts). */
export interface AnalysisReader {
  readonly fftSize: number
  readonly frequencyBinCount: number
  getFloatTimeDomainData(out: Float32Array<ArrayBuffer>): void
  getFloatFrequencyData(out: Float32Array<ArrayBuffer>): void
}

export interface DeviceAnalysisTap { readonly analyser: AnalysisReader; readonly sampleRate: number }

/** Stereo time-domain scope (goniometer / correlation) on top of the mono tap interface. */
export interface StereoScopeTap extends DeviceAnalysisTap { readonly left: AnalysisReader; readonly right: AnalysisReader }

/** A tap stays requested this long after its last lookup (editors look up at least once a second). */
export const ANALYSIS_REQUEST_MS = 1500

const taps = new Map<string, DeviceAnalysisTap>()
const requested = new Map<string, number>()
const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now()

export function registerDeviceAnalysis(deviceId: string, tap: DeviceAnalysisTap): () => void {
  taps.set(deviceId, tap)
  return () => { if (taps.get(deviceId) === tap) taps.delete(deviceId) }
}

/** The device's tap, if the engine streams it; asks the engine for it either way. */
export function deviceAnalysisTap(deviceId: string): DeviceAnalysisTap | undefined {
  requested.set(deviceId, now())
  return taps.get(deviceId)
}

/** Devices whose tap an editor looked up within `maxAgeMs` (older requests are forgotten). */
export function requestedDeviceAnalysis(maxAgeMs = ANALYSIS_REQUEST_MS, at = now()): string[] {
  for (const [id, time] of requested) if (at - time > maxAgeMs) requested.delete(id)
  return [...requested.keys()]
}

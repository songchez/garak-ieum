/**
 * Live analysis taps for graphical 시김새 editors (spectrum behind the EQ curve, the utility's stereo scope).
 *
 * Both engines render off the main thread (the web engine worklet, the desktop host) and neither streams
 * analysis to the UI yet, so nothing registers a tap today: the editors draw their curves and test-signal
 * previews. A future engine analysis stream registers per device id here and the editors pick it up.
 */
export interface DeviceAnalysisTap { readonly analyser: AnalyserNode; readonly sampleRate: number }

/** Stereo time-domain scope (goniometer / correlation) on top of the mono tap interface. */
export interface StereoScopeTap extends DeviceAnalysisTap { readonly left: AnalyserNode; readonly right: AnalyserNode }

const taps = new Map<string, DeviceAnalysisTap>()

export function registerDeviceAnalysis(deviceId: string, tap: DeviceAnalysisTap): () => void {
  taps.set(deviceId, tap)
  return () => { if (taps.get(deviceId) === tap) taps.delete(deviceId) }
}

export function deviceAnalysisTap(deviceId: string): DeviceAnalysisTap | undefined { return taps.get(deviceId) }

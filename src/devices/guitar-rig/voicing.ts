/** Original filter designs, intentionally not branded circuits or measured speaker responses. */
export interface FilterSetting { type: BiquadFilterType; frequency: number; Q: number; gain: number }
export interface AmpVoicing { preGain: number; interstageGain: number; preHighpass: number; interstageLowpass: number; compensation: number }
const limit = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

/** Indexed by the saved `ampModel` value: 0 clean, 1 crunch, 2 high-gain lead, 3 chime, 4 warm jazz clean. Keep in sync with native/src/dsp.cpp. */
const AMP_VOICINGS: readonly AmpVoicing[] = [
  { preGain: 0.55, interstageGain: 0.8, preHighpass: 45, interstageLowpass: 9500, compensation: 0.9 },
  { preGain: 1.5, interstageGain: 1.2, preHighpass: 75, interstageLowpass: 6600, compensation: 0.55 },
  { preGain: 3.5, interstageGain: 1.65, preHighpass: 100, interstageLowpass: 5200, compensation: 0.42 },
  { preGain: 1.0, interstageGain: 1.05, preHighpass: 90, interstageLowpass: 8200, compensation: 0.7 },
  { preGain: 0.4, interstageGain: 0.7, preHighpass: 40, interstageLowpass: 6000, compensation: 1.0 },
]
export const AMP_MODEL_COUNT = AMP_VOICINGS.length
export const CABINET_COUNT = 5
export const MIC_COUNT = 5

export function ampVoicing(model: number): AmpVoicing {
  return AMP_VOICINGS[limit(Math.round(model), 0, AMP_VOICINGS.length - 1)]
}

const ampCurves = new Map<string, Float32Array<ArrayBuffer>>()
/** Odd size and subtraction of the bias at x=0 preserve exact silence. */
/** `fuzz` is a hard, asymmetric clipper; native GuitarRig uses Saturator(4.5, 0.3) for it. */
export function saturationCurve(kind: 'drive' | 'amp' | 'fuzz', model = 0, stage = 0): Float32Array<ArrayBuffer> {
  const index = limit(Math.round(model), 0, 2)
  const key = `${kind}-${index}-${stage}`
  const cached = ampCurves.get(key)
  if (cached) return cached
  const points = 4097
  const curve = new Float32Array(points)
  const amount = kind === 'fuzz' ? 4.5 : kind === 'drive' ? 2.8 : [1.15, 2.4, 3.6][index] * (stage ? 0.65 : 1)
  const bias = kind === 'fuzz' ? 0.3 : kind === 'drive' ? 0.12 : [0.03, 0.08, 0.14][index] * (stage ? -1 : 1)
  const origin = Math.tanh(bias)
  const normalization = Math.max(Math.tanh(amount + bias) - origin, origin - Math.tanh(-amount + bias))
  for (let i = 0; i < points; i += 1) {
    const x = 2 * i / (points - 1) - 1
    curve[i] = (Math.tanh(amount * x + bias) - origin) / normalization
  }
  ampCurves.set(key, curve)
  return curve
}

/**
 * Cabinet, off-axis response and proximity are spectral approximations.
 * Distance changes proximity and high-frequency coloration; it is not physical mic travel delay.
 */
export function cabinetFilters(cabinet: number, micType: number, position: number, distance: number): readonly FilterSetting[] {
  // Cabinets: 0 1x12 tweed, 1 2x12 open back, 2 4x12 closed, 3 tiny 1x10, 4 2x12 chime open back.
  // Mics: 0 dynamic, 1 ribbon, 2 large condenser, 3 large-diaphragm dynamic, 4 small condenser.
  const cab = limit(Math.round(cabinet), 0, CABINET_COUNT - 1)
  const mic = limit(Math.round(micType), 0, MIC_COUNT - 1)
  const edge = limit(position, 0, 1)
  const far = limit(distance, 0, 1)
  const highpass = [95, 75, 62, 120, 85][cab]
  const resonance = [145, 118, 95, 175, 125][cab]
  const cutoff = [6500, 7200, 5700, 5600, 7800][cab] * [1, 0.76, 1.15, 0.92, 1.25][mic] * (1 - 0.33 * edge) * (1 - 0.12 * far)
  return [
    { type: 'highpass', frequency: highpass, Q: 0.72, gain: 0 },
    { type: 'peaking', frequency: resonance, Q: [0.9, 0.75, 1.1, 1.0, 0.8][cab], gain: [2.4, 1.5, 3.4, 1.8, 1.6][cab] + (1 - far) * [2, 3, 1, 2.5, 0.5][mic] },
    { type: 'peaking', frequency: [620, 750, 480, 800, 900][cab], Q: 0.8, gain: [-1.5, -2.3, -3.4, -0.8, -1.2][cab] },
    { type: 'peaking', frequency: [3200, 2300, 4200, 2800, 5500][mic], Q: 0.8 + edge * 0.4, gain: [3.4, -0.6, 2.2, 2.0, 2.8][mic] * (1 - edge) - 2.2 * edge },
    { type: 'highshelf', frequency: 2400 - 500 * edge, Q: 0.707, gain: -1.5 - edge * 5 - far * 1.5 + [0, -2, 1, -1, 2][mic] },
    { type: 'lowpass', frequency: cutoff, Q: 0.68, gain: 0 },
    { type: 'lowpass', frequency: cutoff * 1.15, Q: 0.55, gain: 0 },
  ]
}

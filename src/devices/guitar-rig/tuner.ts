/**
 * Rack tuner. A tap of the signal at the tuner's rack position (an AnalyserNode) is registered per device; the editor
 * reads it here and runs the same YIN estimator as the pitch editor (src/devices/pitch-editor/analysis.ts:
 * cumulative mean normalised difference, 0.15 threshold, parabolic refinement of the raw difference).
 * Both engines render the rig off the main thread and neither streams that tap to the UI yet, so the
 * readout waits for one (the estimator and the editor are ready for it).
 */
export const TUNER_A4 = 440
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'] as const
const ANALYSIS_RATE = 12000
const MIN_HZ = 40
const MAX_HZ = 1600

export interface TunerReading { frequency: number; midi: number; note: string; octave: number; cents: number }

export function tunerReading(frequency: number, a4 = TUNER_A4): TunerReading {
  const exact = 69 + 12 * Math.log2(frequency / a4)
  const midi = Math.round(exact)
  return { frequency, midi, note: NOTE_NAMES[((midi % 12) + 12) % 12], octave: Math.floor(midi / 12) - 1, cents: Math.round((exact - midi) * 1000) / 10 }
}

/** Area-average downsampling (as in the pitch editor) keeps the YIN search cheap enough for a UI frame. */
function downsample(input: Float32Array, sampleRate: number): { signal: Float32Array; rate: number } {
  if (sampleRate <= ANALYSIS_RATE) return { signal: input, rate: sampleRate }
  const ratio = sampleRate / ANALYSIS_RATE
  const output = new Float32Array(Math.floor(input.length / ratio))
  for (let i = 0; i < output.length; i += 1) {
    const start = i * ratio, end = Math.min(input.length, (i + 1) * ratio)
    let sum = 0
    for (let frame = Math.floor(start); frame < Math.ceil(end); frame += 1) sum += input[frame] * (Math.min(frame + 1, end) - Math.max(frame, start))
    output[i] = sum / (end - start)
  }
  return { signal: output, rate: ANALYSIS_RATE }
}

/** Monophonic pitch in Hz, or null for silence / no clear period. */
export function detectPitch(samples: Float32Array, sampleRate: number): number | null {
  const { signal, rate } = downsample(samples, sampleRate)
  const minimumLag = Math.max(2, Math.floor(rate / MAX_HZ))
  const maximumLag = Math.floor(rate / MIN_HZ)
  const window = signal.length - maximumLag - 2
  if (window < maximumLag) return null
  let mean = 0, square = 0
  for (let j = 0; j < window; j += 1) { mean += signal[j]; square += signal[j] * signal[j] }
  const rms = Math.sqrt(Math.max(0, square / window - (mean / window) ** 2))
  if (rms < 0.003) return null
  const difference = new Float64Array(maximumLag + 2)
  const raw = new Float64Array(maximumLag + 2)
  difference[0] = 1
  let cumulative = 0
  for (let lag = 1; lag <= maximumLag + 1; lag += 1) {
    let sum = 0
    for (let j = 0; j < window; j += 1) { const delta = signal[j] - signal[j + lag]; sum += delta * delta }
    raw[lag] = sum
    cumulative += sum
    difference[lag] = cumulative > 0 ? sum * lag / cumulative : 1
  }
  let chosen = -1
  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    if (difference[lag] < 0.15) {
      while (lag < maximumLag && difference[lag + 1] < difference[lag]) lag += 1
      chosen = lag
      break
    }
  }
  if (chosen < 1) return null
  const a = raw[chosen - 1], b = raw[chosen], c = raw[chosen + 1]
  const denominator = a - 2 * b + c
  const offset = Math.abs(denominator) > 1e-12 ? Math.max(-1, Math.min(1, 0.5 * (a - c) / denominator)) : 0
  const frequency = rate / (chosen + offset)
  return Number.isFinite(frequency) && frequency >= MIN_HZ * 0.98 && frequency <= MAX_HZ * 1.02 ? frequency : null
}

/** What a live rig exposes for its tuner. */
export interface GuitarTunerTap { readonly analyser: AnalyserNode; readonly sampleRate: number }
const taps = new Map<string, GuitarTunerTap>()

/** Called by the audio graph for realtime contexts only; offline renders never replace the live tap. */
export function registerGuitarTunerTap(deviceId: string, tap: GuitarTunerTap): void { taps.set(deviceId, tap) }
export function unregisterGuitarTunerTap(tap: GuitarTunerTap): void {
  for (const [id, value] of taps) if (value === tap) taps.delete(id)
}
export function guitarTunerTap(deviceId: string): GuitarTunerTap | undefined { return taps.get(deviceId) }

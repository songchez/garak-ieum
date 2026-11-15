/**
 * Plate-style reverb impulse responses. Same generator, seeds and normalisation as `impulse()` in
 * native/src/dsp.cpp, so the web ConvolverNodes and the native convolver hear the same tail.
 * The Decay knob crossfades the short and long IR (linear, so equal to blending the IRs natively).
 */
export const REVERB_SHORT_SECONDS = 1.7
export const REVERB_LONG_SECONDS = 4.2
const SHORT_SEED = 9183
const LONG_SEED = 61427

export function reverbImpulse(sampleRate: number, seconds: number, seed: number): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const length = Math.ceil(sampleRate * seconds)
  const result: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] = [new Float32Array(length), new Float32Array(length)]
  let state = seed >>> 0
  let power = 0
  for (const channel of result) for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    channel[i] = (state / 4294967295 * 2 - 1) * Math.pow(1 - i / length, 3.6)
    power += channel[i] * channel[i]
  }
  power = Math.max(0.000125, Math.sqrt(power / (length * 2)))
  const scale = 0.00125 / power * 44100 / sampleRate
  for (const channel of result) for (let i = 0; i < length; i += 1) channel[i] *= scale
  return result
}

const cache = new Map<number, { short: ReturnType<typeof reverbImpulse>; long: ReturnType<typeof reverbImpulse> }>()
export function reverbImpulses(sampleRate: number) {
  let entry = cache.get(sampleRate)
  if (!entry) {
    entry = { short: reverbImpulse(sampleRate, REVERB_SHORT_SECONDS, SHORT_SEED), long: reverbImpulse(sampleRate, REVERB_LONG_SECONDS, LONG_SEED) }
    cache.set(sampleRate, entry)
  }
  return entry
}

/** Tone knob → wet lowpass cutoff (1.5 – 12 kHz). */
export const reverbToneHz = (tone: number) => 1500 * Math.pow(8, tone)
/** Fixed wet highpass that keeps the plate from muddying the low strings. */
export const REVERB_HIGHPASS_HZ = 180
/** Export tail allowance: the long IR is audible whenever Decay is above zero. */
export const reverbTailSeconds = (decay: number) => (decay > 0.001 ? REVERB_LONG_SECONDS : REVERB_SHORT_SECONDS) + 0.25

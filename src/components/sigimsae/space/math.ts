/**
 * Display math for the space / modulation / drive 시김새 editors. Everything here mirrors the DSP in
 * engine (rust/garak-dsp; the parameter catalogs in src/devices/effects) so the pictures tell the truth
 * about the sound. Pure functions, no DOM: unit-tested in math.test.ts.
 */
import { DELAY_TIME_OPTIONS, LFO_SYNC_OPTIONS } from '../../../devices/effects/sigimsaeDefs'
import { DELAY_MAX_SECONDS } from '../../../devices/effects/sigimsae'
import { REVERB_SPACES } from '../../../devices/effects/reverb'

export type Read = (id: string) => number
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const db = (gain: number) => 20 * Math.log10(Math.max(1e-9, gain))
const TAU = Math.PI * 2

/* ------------------------------------------------------------------ delay */

/** Seconds between repeats; identical to sigimsae.ts delaySeconds(). */
export function delayTime(p: Read, bpm: number): number {
  return Math.min(DELAY_MAX_SECONDS, p('sync') >= 0.5 ? p('time') * 60 / bpm : p('ms') * 0.001)
}

export const noteLabel = (beats: number): string | undefined =>
  DELAY_TIME_OPTIONS.find(option => Math.abs(option.value - beats) < 1e-6)?.label

/** Nearest note value (in log distance) for a length in beats. */
export function snapBeats(beats: number): number {
  let best: number = DELAY_TIME_OPTIONS[0].value, distance = Infinity
  for (const option of DELAY_TIME_OPTIONS) {
    const d = Math.abs(Math.log(option.value / Math.max(1e-6, beats)))
    if (d < distance) { distance = d; best = option.value }
  }
  return best
}

export const formatMs = (seconds: number) => seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(2)} s`

/** Readout for the first repeat: note value (synced) or ms, with the other unit as a hint. */
export function delayReadout(p: Read, bpm: number): { main: string; hint: string } {
  const seconds = delayTime(p, bpm)
  if (p('sync') >= 0.5) return { main: noteLabel(p('time')) ?? `${p('time').toFixed(2)}박`, hint: formatMs(seconds) }
  const beats = seconds * bpm / 60, near = snapBeats(beats)
  const close = Math.abs(Math.log(near / beats)) < 0.03
  return { main: formatMs(seconds), hint: close ? `≈ ${noteLabel(near)}` : `${beats.toFixed(2)}박` }
}

export interface EchoTap {
  /** 1 = first repeat. */
  index: number
  time: number
  /** Linear level relative to the input (wet amount included). */
  gain: number
  /** Which output side carries the repeat. */
  lane: 'L' | 'R' | 'LR'
  /** 0..1: how much top end survives (each repeat passes the high cut again). */
  brightness: number
}

/** Magnitude of the kernel's Q=1 lowpass at `f` (analog prototype; good enough for a tint). */
function lowpassMagnitude(f: number, cutoff: number, q = 1): number {
  const r = f / cutoff
  return 1 / Math.sqrt((1 - r * r) ** 2 + (r / q) ** 2)
}

/**
 * Echo taps inside `window` seconds until they fall below `floorDb`. Stereo: every repeat on both
 * sides; ping-pong: the mono sum enters the left line, so repeats alternate L, R, L ...
 */
export function echoTaps(p: Read, bpm: number, window: number, floorDb = -48, maxTaps = 48): EchoTap[] {
  const time = delayTime(p, bpm), feedback = p('feedback'), amount = p('amount')
  const pingPong = p('mode') >= 0.5
  const perRepeat = Math.min(1, lowpassMagnitude(5000, p('tone')))
  const taps: EchoTap[] = []
  if (time <= 0) return taps
  for (let index = 1; index <= maxTaps; index += 1) {
    const t = time * index
    if (t > window + 1e-9) break
    const gain = amount * Math.pow(feedback, index - 1)
    if (index > 1 && (gain <= 0 || db(gain) < floorDb)) break
    taps.push({ index, time: t, gain, lane: pingPong ? (index % 2 ? 'L' : 'R') : 'LR', brightness: Math.pow(perRepeat, index) })
  }
  return taps
}

const WINDOWS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8]
/** A tidy visible span that shows the audible repeats (down to −48 dB, at least 3) of `time`. */
export function delayWindow(time: number, feedback: number, amount = 1): number {
  const floor = 0.004 / Math.max(0.004, amount)
  const repeats = feedback < 0.05 ? 3 : clamp(Math.floor(Math.log(floor) / Math.log(Math.max(0.05, feedback))) + 1, 3, 9)
  const want = time * (repeats + 0.6)
  return WINDOWS.find(w => w >= want) ?? WINDOWS[WINDOWS.length - 1]
}

/** Seconds → delay params, snapping to note values when synced. */
export function delayParamsForTime(seconds: number, synced: boolean, bpm: number): Record<string, number> {
  if (synced) return { time: snapBeats(seconds * bpm / 60) }
  return { ms: clamp(Math.round(seconds * 1000 * 10) / 10, 1, 2000) }
}

/* ----------------------------------------------------------------- reverb */

/** Envelope exponent per space type; mirrors reverb.ts reverbImpulse(). */
export const REVERB_SHAPE = [3.6, 4.5, 2.4, 3] as const

const shape = (u: number, k: number) => u >= 1 ? 0 : Math.pow(1 - u, k)

/**
 * Wet amplitude envelope `t` seconds after the pre-delay (relative, before Amount). Size blends the
 * short and the long impulse; ConvolverNode normalises each impulse to equal energy, so a long tail
 * starts quieter: amplitude ∝ 1 / sqrt(length / (2k + 1)).
 */
export function reverbEnvelope(space: number, size: number, t: number): number {
  const s = REVERB_SPACES[clamp(Math.round(space), 0, 3)], k = REVERB_SHAPE[clamp(Math.round(space), 0, 3)]
  const norm = (seconds: number) => 1 / Math.sqrt(seconds / (2 * k + 1))
  const a = clamp(size, 0, 1)
  return (1 - a) * norm(s.short.seconds) * shape(t / s.short.seconds, k) + a * norm(s.long.seconds) * shape(t / s.long.seconds, k)
}

/** Time for the tail to fall 60 dB below its start (seconds, pre-delay excluded). */
export function reverbRt60(space: number, size: number): number {
  const s = REVERB_SPACES[clamp(Math.round(space), 0, 3)]
  const start = reverbEnvelope(space, size, 0), target = start * 1e-3
  let lo = 0, hi = Math.max(s.short.seconds, s.long.seconds)
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2
    if (reverbEnvelope(space, size, mid) > target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** Inverse of reverbRt60 over Size (monotonic), clamped to what the space can do. */
export function sizeForRt60(space: number, rt60: number): number {
  let lo = 0, hi = 1
  if (rt60 <= reverbRt60(space, 0)) return 0
  if (rt60 >= reverbRt60(space, 1)) return 1
  for (let i = 0; i < 30; i += 1) {
    const mid = (lo + hi) / 2
    if (reverbRt60(space, mid) < rt60) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** Envelope in dB (0 dB = start of the tail at Amount 100%), floored. */
export function reverbEnvelopeDb(space: number, size: number, amount: number, t: number, floor = -72): number {
  const start = reverbEnvelope(space, size, 0)
  const v = reverbEnvelope(space, size, t) / start * amount
  return Math.max(floor, db(v))
}

/* ------------------------------------------------------------- modulation */

export type ModType = 'chorus' | 'phaser' | 'flanger' | 'tremolo'

/** LFO rate in Hz; tremolo follows the tempo when synced (cycle = `sync` beats). */
export function lfoRate(type: ModType, p: Read, bpm: number): number {
  if (type === 'tremolo' && p('sync') > 0) return bpm / 60 / p('sync')
  return p('rate')
}

export const syncLabel = (beats: number) => LFO_SYNC_OPTIONS.find(o => Math.abs(o.value - beats) < 1e-6)?.label

/** Chorus voice delays (ms) at LFO phase (radians): 14 / 17 ms swept in opposite directions. */
export function chorusDelays(phase: number, depth: number): [number, number] {
  const m = Math.sin(phase) * depth * 5
  return [14 + m, 17 - m]
}

/** Flanger delays (ms); the right side runs a quarter cycle ahead. */
export function flangerDelays(phase: number, depth: number): [number, number] {
  return [0.3 + depth * (0.5 + 0.5 * Math.sin(phase)) * 6, 0.3 + depth * (0.5 + 0.5 * Math.sin(phase + Math.PI / 2)) * 6]
}

/** Phaser all-pass break frequency (Hz) per side. */
export function phaserFrequency(phase: number, depth: number, side: 0 | 1): number {
  const lfo = 0.5 + 0.5 * Math.sin(phase + (side ? Math.PI / 2 : 0))
  return 200 * Math.pow(16, 0.5 + (lfo - 0.5) * depth)
}

/** Tremolo / auto-pan gains [left, right] at LFO phase (radians). */
export function tremoloGains(phase: number, depth: number, shapeAmount: number, pan: boolean): [number, number] {
  const k = 0.01 + shapeAmount * 9
  const wave = Math.tanh(k * Math.sin(phase)) / Math.tanh(k)
  if (!pan) { const g = 1 - depth * 0.5 * (1 - wave); return [g, g] }
  return [1 - depth * 0.5 * (1 + wave), 1 - depth * 0.5 * (1 - wave)]
}

/** Log-spaced display frequencies. */
export function logFrequencies(count: number, lo = 20, hi = 20000): Float64Array {
  const out = new Float64Array(count)
  for (let i = 0; i < count; i += 1) out[i] = lo * Math.pow(hi / lo, i / (count - 1))
  return out
}

/**
 * Flanger magnitude (dB) for a delay in seconds; writes into `out` (no allocation).
 * Y = z^-D X / (1 - fb z^-D), out = (1 - mix/2) X + wet·Y with wet = mix/2·(1 - fb/2).
 */
export function flangerResponse(freqs: Float64Array, delaySeconds: number, feedback: number, mix: number, out: Float64Array): void {
  const wet = 0.5 * mix * (1 - 0.5 * feedback), dry = 1 - 0.5 * mix
  for (let i = 0; i < freqs.length; i += 1) {
    const w = TAU * freqs[i] * delaySeconds
    const zr = Math.cos(w), zi = -Math.sin(w) // z^-D
    const dr = 1 - feedback * zr, di = -feedback * zi
    const den = dr * dr + di * di
    const yr = (zr * dr + zi * di) / den, yi = (zi * dr - zr * di) / den
    const hr = dry + wet * yr, hi = wet * yi
    out[i] = 10 * Math.log10(Math.max(1e-12, hr * hr + hi * hi))
  }
}

/**
 * Six first-order all-passes at `breakHz` with one-sample feedback (as PhaserKernel):
 * Y = A X / (1 - fb z^-1 A), out = (1 - mix/2) X + mix/2 · Y. dB into `out`.
 */
export function phaserResponse(freqs: Float64Array, breakHz: number, feedback: number, mix: number, sampleRate: number, out: Float64Array): void {
  const t = Math.tan(Math.PI * Math.min(breakHz, sampleRate * 0.45) / sampleRate), a = (t - 1) / (t + 1)
  for (let i = 0; i < freqs.length; i += 1) {
    const w = TAU * freqs[i] / sampleRate, cr = Math.cos(w), ci = -Math.sin(w) // z^-1
    // H = (a + z^-1) / (1 + a z^-1)
    const nr = a + cr, ni = ci, dr = 1 + a * cr, di = a * ci
    const dd = dr * dr + di * di
    const hr = (nr * dr + ni * di) / dd, hi = (ni * dr - nr * di) / dd
    let ar = 1, ai = 0
    for (let s = 0; s < 6; s += 1) { const r = ar * hr - ai * hi; ai = ar * hi + ai * hr; ar = r }
    // denominator 1 - fb z^-1 A
    const zr = cr * ar - ci * ai, zi = cr * ai + ci * ar
    const er = 1 - feedback * zr, ei = -feedback * zi
    const ee = er * er + ei * ei
    const yr = (ar * er + ai * ei) / ee, yi = (ai * er - ar * ei) / ee
    const outR = (1 - 0.5 * mix) + 0.5 * mix * yr, outI = 0.5 * mix * yi
    out[i] = 10 * Math.log10(Math.max(1e-12, outR * outR + outI * outI))
  }
}

/* ------------------------------------------------------------------ drive */

const dbToGain = (v: number) => Math.pow(10, v / 20)

/** Hot Tube transfer (drive.ts): WaveShaper tanh(2.5x)/tanh(2.5), input clipped to ±1, gain-compensated. */
export function driveTransfer(p: Read): (x: number) => number {
  const pre = dbToGain(p('drive')), out = dbToGain(p('output')), mix = clamp(p('mix'), 0, 1)
  const post = out / Math.sqrt(pre * 2.53), norm = Math.tanh(2.5)
  return x => (1 - mix) * out * x + mix * post * Math.tanh(2.5 * clamp(pre * x, -1, 1)) / norm
}

/** Reel 15 static curve (TapeKernel without its filters): biased tanh, so even harmonics appear. */
export function tapeTransfer(p: Read): (x: number) => number {
  const pre = dbToGain(p('drive')), out = dbToGain(p('output')), mix = clamp(p('mix'), 0, 1)
  const post = Math.pow(pre, -0.8), bias = 0.15, origin = Math.tanh(bias)
  return x => (x * (1 - mix) + (Math.tanh(x * pre + bias) - origin) * post * mix) * out
}

/**
 * Harmonic levels (dB relative to the fundamental) of a sine of `amplitude` through `curve`:
 * harmonics[0] is the fundamental (0 dB), [1] the 2nd ... DFT over one cycle.
 */
export function harmonics(curve: (x: number) => number, amplitude = 0.5, count = 9, points = 512): number[] {
  const re = new Float64Array(count), im = new Float64Array(count)
  for (let n = 0; n < points; n += 1) {
    const ph = TAU * n / points, y = curve(amplitude * Math.sin(ph))
    for (let h = 0; h < count; h += 1) { re[h] += y * Math.cos((h + 1) * ph); im[h] += y * Math.sin((h + 1) * ph) }
  }
  const mags = Array.from(re, (r, h) => Math.hypot(r, im[h]))
  const f = Math.max(1e-12, mags[0])
  return mags.map(m => Math.max(-96, db(m / f)))
}

/** Bitcrusher output for an input sequence, sample for sample as BitcrusherKernel (mix 100%). */
export function crushSequence(input: ArrayLike<number>, bits: number, downsample: number, out: Float64Array): void {
  const levels = Math.pow(2, bits - 1)
  let countdown = 0, hold = 0
  for (let i = 0; i < input.length; i += 1) {
    if (countdown <= 0) { hold = input[i]; countdown += downsample }
    countdown -= 1
    out[i] = Math.floor(hold * levels + 0.5) / levels
  }
}

/* ---------------------------------------------------------------- utility */

/** Output = M · [L, R]; rows are [L', R'], mirrors UtilityKernel. */
export function utilityMatrix(p: Read): [[number, number], [number, number]] {
  const phase = Math.round(p('phase')), sL = phase & 1 ? -1 : 1, sR = phase & 2 ? -1 : 1
  const w = p('mono') >= 0.5 ? 0 : p('width'), pan = p('pan'), g = dbToGain(p('gain'))
  const gl = pan > 0 ? 1 - pan : 1, gr = pan < 0 ? 1 + pan : 1
  return [
    [g * gl * (1 + w) / 2 * sL, g * gl * (1 - w) / 2 * sR],
    [g * gr * (1 - w) / 2 * sL, g * gr * (1 + w) / 2 * sR],
  ]
}

/**
 * Output L/R correlation for unit-variance input with correlation `rho`, or null when the output
 * is (nearly) silent on a side, e.g. mono-summing a phase-inverted signal.
 */
export function utilityCorrelation(p: Read, rho = 0.6): number | null {
  const [[a, b], [c, d]] = utilityMatrix(p)
  const varL = a * a + b * b + 2 * rho * a * b, varR = c * c + d * d + 2 * rho * c * d
  const cov = a * c + b * d + rho * (a * d + b * c)
  if (varL < 1e-9 || varR < 1e-9) return null
  return clamp(cov / Math.sqrt(varL * varR), -1, 1)
}

/** Output level relative to input (dB) for that test signal, summed L+R power. */
export function utilityLevelDb(p: Read, rho = 0.6): number {
  const [[a, b], [c, d]] = utilityMatrix(p)
  const power = a * a + b * b + 2 * rho * a * b + c * c + d * d + 2 * rho * c * d
  return db(Math.sqrt(power / 2))
}

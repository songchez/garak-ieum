/**
 * Pure math for the dynamics views (compressor, limiter, gate): static transfer curves that match
 * the DSP (native/src/dsp.cpp Compressor, kernels.ts LimiterKernel/GateKernel), the inverse
 * mappings that turn pointer positions into parameters, the meter history ring and the gate
 * envelope sketch. No DOM here; everything is unit-tested in curve.test.ts.
 */

export const COMPRESSOR_KNEE_DB = 6
/** Gate closes 4 dB under its threshold (hysteresis, see GateKernel). */
export const GATE_HYSTERESIS_DB = 4
/** "Silence" on every graph: lower than any range shown. */
export const FLOOR_DB = -120

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export const toDb = (linear: number) => linear > 1e-6 ? 20 * Math.log10(linear) : FLOOR_DB
export const fromDb = (db: number) => Math.pow(10, db / 20)

/** Soft-knee overshoot above threshold, in dB (identical to the native compressor). */
export function kneeOver(inputDb: number, threshold: number, knee = COMPRESSOR_KNEE_DB): number {
  const above = inputDb - threshold
  if (above < -knee / 2) return 0
  if (above < knee / 2) return (above + knee / 2) * (above + knee / 2) / (2 * knee)
  return above
}

/** Static gain reduction (positive dB) of the compressor at a steady input level. */
export function compressorReduction(inputDb: number, threshold: number, ratio: number, knee = COMPRESSOR_KNEE_DB): number {
  return (1 - 1 / Math.max(1, ratio)) * kneeOver(inputDb, threshold, knee)
}

/** Output level of the compressor at a steady input level, makeup included. */
export function compressorOutput(inputDb: number, threshold: number, ratio: number, makeup = 0, knee = COMPRESSOR_KNEE_DB): number {
  return inputDb - compressorReduction(inputDb, threshold, ratio, knee) + makeup
}

/** Limiter: input gain, then a hard ceiling. */
export function limiterOutput(inputDb: number, gain: number, ceiling: number): number {
  return Math.min(inputDb + gain, ceiling)
}

/**
 * Gate transfer at a steady level. Between close and open thresholds the gate keeps its state
 * (hysteresis): `open` picks the branch. Closed means silence.
 */
export function gateOutput(inputDb: number, threshold: number, open = false): number {
  if (inputDb >= threshold) return inputDb
  if (inputDb < threshold - GATE_HYSTERESIS_DB) return FLOOR_DB
  return open ? inputDb : FLOOR_DB
}

/**
 * Ratio that makes the compressor curve pass through (inputDb, outputDb) above the threshold —
 * dragging the curve itself. Outside the compressing region the ratio is unchanged.
 */
export function ratioThrough(inputDb: number, outputDb: number, threshold: number, makeup: number, current: number, min = 1, max = 20): number {
  const above = inputDb - threshold
  if (above < 1) return current
  const rise = outputDb - makeup - threshold
  if (rise <= above / max) return max
  if (rise >= above) return min
  return clamp(above / rise, min, max)
}

/** Linear mapping between a dB range and pixels (y grows downward). */
export interface DbScale { min: number; max: number }
export const dbToX = (db: number, s: DbScale, width: number) => (clamp(db, s.min, s.max) - s.min) / (s.max - s.min) * width
export const dbToY = (db: number, s: DbScale, height: number) => height - (clamp(db, s.min, s.max) - s.min) / (s.max - s.min) * height
export const xToDb = (x: number, s: DbScale, width: number) => s.min + clamp(x / width, 0, 1) * (s.max - s.min)
export const yToDb = (y: number, s: DbScale, height: number) => s.min + clamp(1 - y / height, 0, 1) * (s.max - s.min)

/** SVG path of a transfer function over the scale (square plot, `steps` segments). */
export function transferPath(fn: (inputDb: number) => number, s: DbScale, size: number, steps = 96): string {
  let d = ''
  for (let i = 0; i <= steps; i += 1) {
    const input = s.min + (s.max - s.min) * i / steps
    const x = dbToX(input, s, size), y = dbToY(fn(input), s, size)
    d += `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`
  }
  return d
}

/** Nice grid lines (dB) for a scale. */
export function gridLines(s: DbScale, step?: number): number[] {
  const span = s.max - s.min
  const every = step ?? (span > 60 ? 20 : span > 30 ? 12 : 6)
  const lines: number[] = []
  for (let db = Math.ceil(s.min / every) * every; db <= s.max + 1e-9; db += every) lines.push(db)
  return lines
}

/**
 * Fixed-size ring of meter frames (input dB, gain-reduction dB) for the scrolling history.
 * Allocation-free after construction; `at(age)` reads 0 = newest.
 */
export class MeterHistory {
  readonly input: Float32Array
  readonly reduction: Float32Array
  private head = 0
  private filled = 0
  constructor(readonly capacity: number) {
    this.input = new Float32Array(capacity).fill(FLOOR_DB)
    this.reduction = new Float32Array(capacity)
  }
  push(inputDb: number, reductionDb: number): void {
    this.head = (this.head + 1) % this.capacity
    this.input[this.head] = Number.isFinite(inputDb) ? inputDb : FLOOR_DB
    this.reduction[this.head] = Number.isFinite(reductionDb) ? Math.max(0, reductionDb) : 0
    this.filled = Math.min(this.capacity, this.filled + 1)
  }
  get size(): number { return this.filled }
  /** Index into input/reduction for `age` frames ago (0 = newest). */
  index(age: number): number { return ((this.head - age) % this.capacity + this.capacity) % this.capacity }
  clear(): void { this.input.fill(FLOOR_DB); this.reduction.fill(0); this.filled = 0 }
}

/** One live meter frame in dB, derived from the engine's linear (input peak, lowest gain). */
export interface MeterFrame { inputDb: number; reductionDb: number }
export function meterFrame(reading: { input: number; gain: number } | null | undefined): MeterFrame {
  if (!reading) return { inputDb: FLOOR_DB, reductionDb: 0 }
  return { inputDb: toDb(reading.input), reductionDb: reading.gain >= 1 ? 0 : Math.min(-FLOOR_DB, -toDb(Math.max(reading.gain, 1e-6))) }
}

/**
 * Gate envelope sketch: gain over time for one note — closed, attack ramp, open, hold after the
 * signal drops, then release (60 dB fall). Segment widths follow each parameter's knob position
 * so short and long times both stay grabbable. Returns breakpoints in a width × height box.
 */
export interface EnvelopeSketch { points: [number, number][]; attackX: number; holdX: number; releaseX: number; signalEndX: number }
export function gateEnvelope(attackN: number, holdN: number, releaseN: number, width: number, height: number): EnvelopeSketch {
  const lead = width * 0.08, open = width * 0.14
  const seg = (n: number) => width * (0.04 + 0.2 * clamp(n, 0, 1))
  const attackX = lead + seg(attackN)
  const signalEndX = attackX + open
  const holdX = signalEndX + seg(holdN)
  const releaseX = Math.min(width, holdX + seg(releaseN))
  const top = height * 0.12, bottom = height * 0.92
  const points: [number, number][] = [[0, bottom], [lead, bottom], [attackX, top], [signalEndX, top], [holdX, top]]
  // Exponential release drawn as a curve (−60 dB over the segment, plotted linearly in gain).
  for (let i = 1; i <= 12; i += 1) {
    const t = i / 12
    points.push([holdX + (releaseX - holdX) * t, top + (bottom - top) * (1 - Math.pow(10, -3 * t))])
  }
  points.push([width, bottom])
  return { points, attackX, holdX, releaseX, signalEndX }
}

/** Inverse of a gateEnvelope segment: knob position (0..1) from a segment's pixel width. */
export function segmentToNormalized(widthPx: number, width: number): number {
  return clamp((widthPx / width - 0.04) / 0.2, 0, 1)
}

/** VU ballistics: ~300 ms integration toward the target, per elapsed second. */
export function vuStep(current: number, target: number, seconds: number, time = 0.3): number {
  const k = 1 - Math.exp(-Math.max(0, seconds) / (time / 2.2))
  return current + (target - current) * k
}

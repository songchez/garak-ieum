/**
 * Display math for the vintage editors' graphs. These are explanatory pictures of the DSP's shape
 * (rust/garak-dsp/src/instruments), not measurements: each returns SVG path data in a given box.
 */

export interface Box { w: number; h: number; pad?: number }
type Point = readonly [number, number]

export const pathOf = (points: readonly Point[]) => points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('')
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** 옥구슬 EP pickup: y = (tanh(d·x+q) − tanh q)/(d·(1−tanh²q)), q = pickup·0.9, d = 1 + bark·(0.4+4.6·v²). Unity slope at 0. */
export function pickupTransfer(x: number, bark: number, pickup: number, velocity: number): number {
  const q = pickup * 0.9, d = 1 + bark * (0.4 + 4.6 * velocity * velocity), t = Math.tanh(q)
  return (Math.tanh(d * x + q) - t) / (d * (1 - t * t))
}

/** Transfer curves for x ∈ [−1, 1], sharing one y scale so soft and hard strikes compare. */
export function pickupPaths(bark: number, pickup: number, velocities: readonly number[], box: Box, steps = 64): { curves: string[]; scale: number } {
  const xs = Array.from({ length: steps + 1 }, (_, i) => -1 + 2 * i / steps)
  const ys = velocities.map(v => xs.map(x => pickupTransfer(x, bark, pickup, v)))
  const scale = Math.max(1, ...ys.flat().map(Math.abs))
  const pad = box.pad ?? 4, cx = box.w / 2, cy = box.h / 2, sx = (box.w / 2 - pad), sy = (box.h / 2 - pad) / scale
  return { scale, curves: ys.map(row => pathOf(row.map((y, i) => [cx + xs[i] * sx, cy - y * sy] as const))) }
}

/** Damper picture: a held tine (slow decay) released at 40 % of the window; `release` reaches −40 dB. */
export function damperPath(release: number, decay: number, box: Box, window = 2): { line: string; area: string; keyUpX: number } {
  const pad = box.pad ?? 4, keyUp = window * 0.4, steps = 90
  const points: Point[] = []
  for (let i = 0; i <= steps; i++) {
    const t = window * i / steps
    const held = Math.exp(-t / (2.5 * decay))
    const level = t <= keyUp ? held : Math.exp(-keyUp / (2.5 * decay)) * Math.exp(-(t - keyUp) / Math.max(0.004, release / 4.6))
    points.push([pad + (box.w - 2 * pad) * t / window, box.h - pad - (box.h - 2 * pad) * level])
  }
  const line = pathOf(points)
  return { line, area: `${line}L${(box.w - pad).toFixed(1)} ${box.h - pad}L${pad} ${box.h - pad}Z`, keyUpX: pad + (box.w - 2 * pad) * keyUp / window }
}

/** Tremolo / autopan over one second: left and right gains (autopan offsets them by up to half a cycle). */
export function tremoloPaths(rate: number, depth: number, autopan: number, box: Box, window = 1): { left: string; right: string } {
  const pad = box.pad ?? 4, steps = Math.max(80, Math.ceil(rate * window * 24))
  const gain = (t: number, phase: number) => 1 - depth * (0.5 + 0.5 * Math.sin(2 * Math.PI * rate * t + phase))
  const trace = (phase: number) => pathOf(Array.from({ length: steps + 1 }, (_, i) => {
    const t = window * i / steps
    return [pad + (box.w - 2 * pad) * i / steps, pad + (box.h - 2 * pad) * (1 - gain(t, phase))] as const
  }))
  return { left: trace(0), right: trace(Math.PI * autopan) }
}

/** 한밤 106 DCO mix: saw + pulse (width from PWM) + sub square one octave down + noise, two cycles. */
export function dcoPath(levels: { saw: number; pulse: number; pwm: number; sub: number; noise: number }, box: Box, steps = 160): string {
  const pad = box.pad ?? 4, width = 0.5 - 0.45 * clamp(levels.pwm, 0, 1)
  let seed = 7
  const noise = () => { seed = (seed * 16807) % 2147483647; return seed / 1073741823.5 - 1 }
  const raw = Array.from({ length: steps + 1 }, (_, i) => {
    const phase = (2 * i / steps) % 1, sub = (i / steps) < 0.5 ? 1 : -1
    return levels.saw * (2 * phase - 1) + levels.pulse * (phase < width ? 1 : -1) + levels.sub * sub + levels.noise * noise() * 0.8
  })
  const peak = Math.max(0.001, ...raw.map(Math.abs))
  return pathOf(raw.map((y, i) => [pad + (box.w - 2 * pad) * i / steps, box.h / 2 - (box.h / 2 - pad) * y / peak] as const))
}

export const FREQ_MIN = 20, FREQ_MAX = 20000
export const freqX = (f: number, box: Box) => { const pad = box.pad ?? 4; return pad + (box.w - 2 * pad) * Math.log(f / FREQ_MIN) / Math.log(FREQ_MAX / FREQ_MIN) }

/** HPF switch positions (0 = bass boost, 1 = flat, 2/3 = higher high-pass): gain at `f`. */
export function hpfGain(position: number, f: number): number {
  if (position <= 0) { const r = (f / 90) ** 2; return Math.sqrt((4 + r) / (1 + r)) } // ≈ +6 dB shelf below 90 Hz
  if (position === 1) return 1
  const fc = position === 2 ? 240 : 720, r = f / fc
  return r / Math.sqrt(1 + r * r)
}

/** 4-pole ladder low-pass: H = G⁴/(1 + k·G⁴), G = 1/(1 + jf/fc), k = 3.9·resonance. Magnitude at `f`. */
export function ladderGain(cutoff: number, resonance: number, f: number): number {
  const w = f / cutoff
  // (1 + jw)^4 = re + j·im
  const a2 = 1 - w * w, b2 = 2 * w // (1+jw)^2
  const re4 = a2 * a2 - b2 * b2, im4 = 2 * a2 * b2
  const k = 3.9 * clamp(resonance, 0, 1)
  return 1 / Math.hypot(re4 + k, im4)
}

/** Combined HPF + VCF response in dB over 20 Hz – 20 kHz (range −48…+18 dB). */
export function filterResponsePath(cutoff: number, resonance: number, hpf: number, box: Box, steps = 120): { line: string; area: string } {
  const pad = box.pad ?? 4, top = 18, bottom = -48
  const points: Point[] = Array.from({ length: steps + 1 }, (_, i) => {
    const f = FREQ_MIN * (FREQ_MAX / FREQ_MIN) ** (i / steps)
    const db = clamp(20 * Math.log10(Math.max(1e-6, ladderGain(cutoff, resonance, f) * hpfGain(hpf, f))), bottom, top)
    return [freqX(f, box), pad + (box.h - 2 * pad) * (top - db) / (top - bottom)] as const
  })
  const line = pathOf(points)
  return { line, area: `${line}L${(box.w - pad).toFixed(1)} ${box.h - pad}L${pad} ${box.h - pad}Z` }
}
export const dbY = (db: number, box: Box) => { const pad = box.pad ?? 4; return pad + (box.h - 2 * pad) * (18 - db) / 66 }

/** ADSR on a compressed time axis (log-like widths so 1 ms and 10 s both read). */
export function adsrPath(env: { attack: number; decay: number; sustain: number; release: number }, box: Box): { line: string; area: string; points: Point[] } {
  const pad = box.pad ?? 4, span = (t: number) => 0.08 + Math.log1p(t * 40) / Math.log1p(400)
  const a = span(env.attack), d = span(env.decay), hold = 0.55, r = span(env.release)
  const unit = (box.w - 2 * pad) / (a + d + hold + r), bottom = box.h - pad, height = box.h - 2 * pad
  const x0 = pad, x1 = x0 + a * unit, x2 = x1 + d * unit, x3 = x2 + hold * unit, x4 = x3 + r * unit
  const sy = bottom - height * clamp(env.sustain, 0, 1)
  const line = `M${x0} ${bottom}L${x1.toFixed(1)} ${pad}Q${(x1 + (x2 - x1) * 0.25).toFixed(1)} ${sy.toFixed(1)} ${x2.toFixed(1)} ${sy.toFixed(1)}L${x3.toFixed(1)} ${sy.toFixed(1)}Q${(x3 + (x4 - x3) * 0.25).toFixed(1)} ${bottom} ${x4.toFixed(1)} ${bottom}`
  return { line, area: `${line}Z`, points: [[x1, pad], [x2, sy], [x3, sy], [x4, bottom]] }
}

/** LFO triangle over two seconds with the delayed fade-in envelope. */
export function lfoPath(rate: number, delay: number, box: Box, window = 2): { line: string; envelope: string } {
  const pad = box.pad ?? 4, steps = Math.min(1200, Math.max(120, Math.ceil(rate * window * 16)))
  const fade = (t: number) => delay <= 0 ? 1 : clamp(t / delay, 0, 1)
  const cy = box.h / 2, amp = box.h / 2 - pad
  const tri = (t: number) => { const p = (rate * t) % 1; return p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4 }
  const x = (t: number) => pad + (box.w - 2 * pad) * t / window
  const line = pathOf(Array.from({ length: steps + 1 }, (_, i) => { const t = window * i / steps; return [x(t), cy - amp * fade(t) * tri(t)] as const }))
  const envelope = delay > 0 ? `M${x(0)} ${cy}L${x(Math.min(window, delay)).toFixed(1)} ${(cy - amp * fade(Math.min(window, delay))).toFixed(1)}L${x(window)} ${(cy - amp * fade(window)).toFixed(1)}` : ''
  return { line, envelope }
}

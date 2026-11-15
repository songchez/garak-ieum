/** Log-frequency / dB plotting helpers shared by the EQ and filter graphs. */
export const F_MIN = 20
export const F_MAX = 20000
const LOG_SPAN = Math.log(F_MAX / F_MIN)

export const freqToUnit = (hz: number): number => Math.log(Math.max(1, hz) / F_MIN) / LOG_SPAN
export const unitToFreq = (unit: number): number => F_MIN * Math.exp(unit * LOG_SPAN)
export const clampFreq = (hz: number): number => Math.min(F_MAX, Math.max(F_MIN, hz))

export interface Plot { width: number; height: number; range: number; padTop: number; padBottom: number }
export const xOf = (p: Plot, hz: number): number => freqToUnit(hz) * p.width
export const freqAt = (p: Plot, x: number): number => clampFreq(unitToFreq(x / Math.max(1, p.width)))
const inner = (p: Plot) => Math.max(1, p.height - p.padTop - p.padBottom)
export const yOf = (p: Plot, db: number): number => p.padTop + (0.5 - db / (2 * p.range)) * inner(p)
export const dbAt = (p: Plot, y: number): number => (0.5 - (y - p.padTop) / inner(p)) * 2 * p.range

/** Log-spaced sample frequencies across the plot. */
export function sampleFreqs(count: number): number[] {
  return Array.from({ length: count }, (_, i) => unitToFreq(i / (count - 1)))
}

/** SVG path through points; dense log sampling keeps it visually smooth without splines. */
export function linePath(points: readonly (readonly [number, number])[]): string {
  let d = ''
  for (let i = 0; i < points.length; i += 1) d += `${i ? 'L' : 'M'}${points[i][0].toFixed(1)} ${points[i][1].toFixed(1)}`
  return d
}

export const MAJOR_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
export const MINOR_FREQS = [30, 40, 60, 70, 80, 90, 300, 400, 600, 700, 800, 900, 3000, 4000, 6000, 7000, 8000, 9000]
export const freqLabel = (hz: number): string => hz >= 1000 ? `${+(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k` : `${Math.round(hz)}`

export function formatHz(hz: number): string {
  if (hz >= 1000) return `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2)} kHz`
  return `${hz < 100 ? hz.toFixed(1) : Math.round(hz)} Hz`
}
export const formatDb = (db: number): string => `${db > 0.04 ? '+' : db < -0.04 ? '−' : ''}${Math.abs(db).toFixed(1)} dB`

const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
/** "A4 +3¢" for a frequency (A4 = 440 Hz). */
export function noteName(hz: number): string {
  const exact = 69 + 12 * Math.log2(hz / 440), midi = Math.round(exact), cents = Math.round((exact - midi) * 100)
  return `${NOTES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}${cents ? ` ${cents > 0 ? '+' : '−'}${Math.abs(cents)}¢` : ''}`
}
/** C1…C9 marker frequencies. */
export const C_NOTES = Array.from({ length: 10 }, (_, octave) => ({ label: `C${octave}`, hz: 440 * Math.pow(2, (12 * (octave + 1) - 69) / 12) })).filter(note => note.hz >= F_MIN && note.hz <= F_MAX)

/** dB ticks for a visible ±range. */
export function dbTicks(range: number): number[] {
  const step = range <= 6 ? 2 : range <= 12 ? 3 : 6
  const ticks: number[] = []
  for (let db = -range; db <= range + 1e-9; db += step) ticks.push(Math.round(db))
  return ticks
}

/** Parse "1.2k", "1200", "1.2 kHz" → Hz. */
export function parseHz(text: string): number | null {
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(k)?\s*(hz)?\s*$/i.exec(text)
  if (!m) return null
  const value = parseFloat(m[1]) * (m[2] ? 1000 : 1)
  return Number.isFinite(value) ? value : null
}

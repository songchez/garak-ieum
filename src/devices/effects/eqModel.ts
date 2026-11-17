import type { ParamDef } from '../contracts.js'

/**
 * Parametric EQ ("Curve") model shared by the editor graph and tests (the engine's EQ, garak-dsp, mirrors it).
 * Keep the section maths in sync with native/src/eq_effects.inc.
 *
 * Saved-state compatibility: the original 3-band EQ stored `low`, `mid`, `midFreq` and `high`.
 * Those ids ARE the gain/frequency parameters of bands 1–3, whose defaults reproduce the old
 * fixed voicing (220 Hz low shelf, Q 0.9 bell, 4.5 kHz high shelf), so old projects and presets
 * sound identical without migration. Bands 4–8 start switched off.
 */
export const EQ_BAND_COUNT = 8
export type EqField = 'on' | 'type' | 'freq' | 'gain' | 'q' | 'slope'
/** Band state (`b{n}On`): 0 = unused, 1 = active, 2 = bypassed (silent but kept on the graph). */
export const EqState = { off: 0, on: 1, bypassed: 2 } as const

/** Saved numeric band types. Order of values is persisted; order of EQ_TYPE_MENU is display only. */
export const EqType = { bell: 0, lowShelf: 1, highShelf: 2, lowCut: 3, highCut: 4, notch: 5 } as const
export type EqTypeValue = typeof EqType[keyof typeof EqType]
export const EQ_TYPE_LABELS: Record<EqTypeValue, string> = { 0: '벨', 1: '로우 셸프', 2: '하이 셸프', 3: '로우 컷', 4: '하이 컷', 5: '노치' }
export const EQ_TYPE_MENU: readonly EqTypeValue[] = [EqType.lowCut, EqType.lowShelf, EqType.bell, EqType.notch, EqType.highShelf, EqType.highCut]
export const EQ_SLOPES = [12, 24, 36, 48] as const

const LEGACY: Partial<Record<string, string>> = { '1:gain': 'low', '2:gain': 'mid', '2:freq': 'midFreq', '3:gain': 'high' }
/** Parameter id of one band field; bands are 1-based. */
export function eqParamId(band: number, field: EqField): string {
  return LEGACY[`${band}:${field}`] ?? `b${band}${field[0].toUpperCase()}${field.slice(1)}`
}
export const EQ_OUTPUT_ID = 'output'
export const EQ_GAIN_RANGE = 24

interface BandDefaults { on: number; type: EqTypeValue; freq: number; q: number }
const BAND_DEFAULTS: readonly BandDefaults[] = [
  { on: 1, type: EqType.lowShelf, freq: 220, q: 1 },
  { on: 1, type: EqType.bell, freq: 1000, q: 0.9 },
  { on: 1, type: EqType.highShelf, freq: 4500, q: 1 },
  { on: 0, type: EqType.lowCut, freq: 40, q: 0.71 },
  { on: 0, type: EqType.bell, freq: 180, q: 1 },
  { on: 0, type: EqType.bell, freq: 600, q: 1 },
  { on: 0, type: EqType.bell, freq: 2500, q: 1 },
  { on: 0, type: EqType.highCut, freq: 16000, q: 0.71 },
]

const TYPE_OPTIONS = EQ_TYPE_MENU.map(value => ({ value, label: EQ_TYPE_LABELS[value] }))
const SLOPE_OPTIONS = EQ_SLOPES.map((slope, value) => ({ value, label: `${slope} dB/oct` }))

/** Param defs in saved order: the legacy four first (as before), then every band field, then output. */
export function eqParamDefs(): ParamDef[] {
  const defs: ParamDef[] = [
    { id: 'low', label: '1 게인', min: -EQ_GAIN_RANGE, max: EQ_GAIN_RANGE, default: 0, unit: 'db' },
    { id: 'mid', label: '2 게인', min: -EQ_GAIN_RANGE, max: EQ_GAIN_RANGE, default: 0, unit: 'db' },
    { id: 'midFreq', label: '2 주파수', min: 20, max: 20000, default: 1000, unit: 'hz', scale: 'log' },
    { id: 'high', label: '3 게인', min: -EQ_GAIN_RANGE, max: EQ_GAIN_RANGE, default: 0, unit: 'db' },
  ]
  const have = new Set(defs.map(def => def.id))
  BAND_DEFAULTS.forEach((band, index) => {
    const n = index + 1
    const fields: ParamDef[] = [
      { id: eqParamId(n, 'on'), label: `${n} 켜기`, min: 0, max: 2, default: band.on, unit: 'q', options: [{ value: 0, label: '끔' }, { value: 1, label: '켬' }, { value: 2, label: '바이패스' }] },
      { id: eqParamId(n, 'type'), label: `${n} 모양`, min: 0, max: 5, default: band.type, unit: 'q', options: TYPE_OPTIONS },
      { id: eqParamId(n, 'freq'), label: `${n} 주파수`, min: 20, max: 20000, default: band.freq, unit: 'hz', scale: 'log' },
      { id: eqParamId(n, 'gain'), label: `${n} 게인`, min: -EQ_GAIN_RANGE, max: EQ_GAIN_RANGE, default: 0, unit: 'db' },
      { id: eqParamId(n, 'q'), label: `${n} Q`, min: 0.1, max: 18, default: band.q, unit: 'q', scale: 'log' },
      { id: eqParamId(n, 'slope'), label: `${n} 기울기`, min: 0, max: 3, default: 0, unit: 'q', options: SLOPE_OPTIONS },
    ]
    for (const def of fields) if (!have.has(def.id)) { defs.push(def); have.add(def.id) }
  })
  defs.push({ id: EQ_OUTPUT_ID, label: '출력', min: -24, max: 24, default: 0, unit: 'db' })
  return defs
}

export interface EqBand { index: number; on: boolean; bypassed: boolean; type: EqTypeValue; freq: number; gain: number; q: number; slope: number }

export function readEqBands(value: (id: string) => number): EqBand[] {
  return Array.from({ length: EQ_BAND_COUNT }, (_, i) => {
    const n = i + 1
    return {
      index: n, on: Math.round(value(eqParamId(n, 'on'))) === EqState.on, bypassed: Math.round(value(eqParamId(n, 'on'))) === EqState.bypassed,
      type: Math.max(0, Math.min(5, Math.round(value(eqParamId(n, 'type'))))) as EqTypeValue,
      freq: value(eqParamId(n, 'freq')), gain: value(eqParamId(n, 'gain')), q: value(eqParamId(n, 'q')),
      slope: Math.max(0, Math.min(3, Math.round(value(eqParamId(n, 'slope'))))),
    }
  })
}

/** A band's saved default state (bands 1–3 on, 4–8 off). */
export function eqBandDefault(index: number): EqBand {
  const d = BAND_DEFAULTS[index - 1]
  return { index, on: d.on >= 0.5, bypassed: false, type: d.type, freq: d.freq, gain: 0, q: d.q, slope: 0 }
}
/** Shown on the graph: active or bypassed (an unused band is hidden). */
export const eqBandInUse = (band: EqBand): boolean => band.on || band.bypassed

export const typeHasGain = (type: EqTypeValue): boolean => type === EqType.bell || type === EqType.lowShelf || type === EqType.highShelf
export const typeHasQ = (type: EqTypeValue): boolean => type !== EqType.lowShelf && type !== EqType.highShelf
export const typeHasSlope = (type: EqTypeValue): boolean => type === EqType.lowCut || type === EqType.highCut

/** One biquad stage, in Web Audio BiquadFilterNode units (low/high-pass Q in dB, others linear). */
export interface BiquadSection { type: 'lowpass' | 'highpass' | 'bandpass' | 'peaking' | 'lowshelf' | 'highshelf' | 'notch'; freq: number; q: number; gain: number }
/** A stage that passes the signal unchanged (peaking at 0 dB is exactly 1). */
export const IDENTITY_SECTION: BiquadSection = { type: 'peaking', freq: 1000, q: 1, gain: 0 }
export const MAX_SECTIONS = 4

/** Butterworth stage Qs for an order-2n low/high-pass made of n biquads, ascending. */
export function butterworthQs(stages: number): number[] {
  const order = 2 * stages
  return Array.from({ length: stages }, (_, k) => 1 / (2 * Math.cos((2 * k + 1) * Math.PI / (2 * order)))).sort((a, b) => a - b)
}
const toDbQ = (linear: number) => 20 * Math.log10(Math.max(1e-4, linear))

/**
 * Cascaded low/high-pass: Butterworth stages (flat at Q 0.707); `resonanceQ` (linear) scales the
 * sharpest stage so Q 0.707 stays maximally flat and higher values add a resonant peak.
 */
export function passSections(kind: 'lowpass' | 'highpass', freq: number, resonanceQ: number, stages: number): BiquadSection[] {
  const qs = butterworthQs(stages)
  qs[qs.length - 1] *= resonanceQ / Math.SQRT1_2
  return qs.map(q => ({ type: kind, freq, q: toDbQ(q), gain: 0 }))
}

export function eqBandSections(band: EqBand, sampleRate: number): BiquadSection[] {
  if (!band.on) return []
  const freq = Math.min(Math.max(band.freq, 10), sampleRate * 0.45)
  switch (band.type) {
    case EqType.bell: return [{ type: 'peaking', freq, q: band.q, gain: band.gain }]
    case EqType.lowShelf: return [{ type: 'lowshelf', freq, q: 1, gain: band.gain }]
    case EqType.highShelf: return [{ type: 'highshelf', freq, q: 1, gain: band.gain }]
    case EqType.notch: return [{ type: 'notch', freq, q: band.q, gain: 0 }]
    case EqType.lowCut: return passSections('highpass', freq, band.q, band.slope + 1)
    case EqType.highCut: return passSections('lowpass', freq, band.q, band.slope + 1)
  }
}

// ---- Frequency response (same formulas as the W3C BiquadFilterNode and native Biquad::configure) ----

export interface Coefficients { b0: number; b1: number; b2: number; a1: number; a2: number }
export function sectionCoefficients(section: BiquadSection, sampleRate: number): Coefficients {
  const hz = Math.min(Math.max(section.freq, 1), sampleRate * 0.45)
  const w = 2 * Math.PI * hz / sampleRate, cos = Math.cos(w), sin = Math.sin(w)
  const pass = section.type === 'lowpass' || section.type === 'highpass'
  const quality = pass ? Math.pow(10, Math.min(Math.max(section.q, -60), 60) / 20) : Math.min(Math.max(section.q, 1e-4), 40)
  const A = Math.pow(10, section.gain / 40), alpha = sin / (2 * quality)
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0
  switch (section.type) {
    case 'lowpass': b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break
    case 'highpass': b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break
    case 'bandpass': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break
    case 'notch': b0 = 1; b1 = -2 * cos; b2 = 1; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break
    case 'peaking': b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A; break
    case 'lowshelf': {
      const beta = Math.sqrt(2 * A) * sin
      b0 = A * ((A + 1) - (A - 1) * cos + beta); b1 = 2 * A * ((A - 1) - (A + 1) * cos); b2 = A * ((A + 1) - (A - 1) * cos - beta)
      a0 = (A + 1) + (A - 1) * cos + beta; a1 = -2 * ((A - 1) + (A + 1) * cos); a2 = (A + 1) + (A - 1) * cos - beta; break
    }
    case 'highshelf': {
      const beta = Math.sqrt(2 * A) * sin
      b0 = A * ((A + 1) + (A - 1) * cos + beta); b1 = -2 * A * ((A - 1) + (A + 1) * cos); b2 = A * ((A + 1) + (A - 1) * cos - beta)
      a0 = (A + 1) - (A - 1) * cos + beta; a1 = 2 * ((A - 1) - (A + 1) * cos); a2 = (A + 1) - (A - 1) * cos - beta; break
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

/** |H(f)| in dB of a cascade of sections. */
export function sectionsResponseDb(sections: readonly BiquadSection[], freq: number, sampleRate: number): number {
  const w = 2 * Math.PI * freq / sampleRate, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w)
  let db = 0
  for (const section of sections) {
    const k = sectionCoefficients(section, sampleRate)
    const nr = k.b0 + k.b1 * c1 + k.b2 * c2, ni = -(k.b1 * s1 + k.b2 * s2)
    const dr = 1 + k.a1 * c1 + k.a2 * c2, di = -(k.a1 * s1 + k.a2 * s2)
    const mag2 = (nr * nr + ni * ni) / Math.max(1e-30, dr * dr + di * di)
    db += 10 * Math.log10(Math.max(1e-30, mag2))
  }
  return db
}

export const eqBandResponseDb = (band: EqBand, freq: number, sampleRate: number): number => sectionsResponseDb(eqBandSections(band, sampleRate), freq, sampleRate)
export function eqResponseDb(bands: readonly EqBand[], output: number, freq: number, sampleRate: number): number {
  let db = output
  for (const band of bands) db += eqBandResponseDb(band, freq, sampleRate)
  return db
}

// ---- Sweep filter ----

export const FILTER_SLOPES = [12, 24, 48] as const
const FILTER_STAGES = [1, 2, 4]
/** mode 0 low-pass / 1 high-pass / 2 band-pass; slope 0 keeps the original single BiquadFilterNode exactly. */
export function filterSections(mode: number, cutoff: number, resonance: number, slope: number, sampleRate: number): BiquadSection[] {
  const freq = Math.min(Math.max(cutoff, 10), sampleRate * 0.45)
  const stages = FILTER_STAGES[Math.max(0, Math.min(2, Math.round(slope)))]
  const m = Math.max(0, Math.min(2, Math.round(mode)))
  if (m === 2) return Array.from({ length: stages }, () => ({ type: 'bandpass' as const, freq, q: resonance, gain: 0 }))
  const kind = m === 0 ? 'lowpass' : 'highpass'
  if (stages === 1) return [{ type: kind, freq, q: resonance, gain: 0 }]
  // Cascades: the default 0.7 (dB) resonance is maximally flat; more adds a resonant peak.
  return passSections(kind, freq, Math.SQRT1_2 * Math.pow(10, (resonance - 0.7) / 20), stages)
}

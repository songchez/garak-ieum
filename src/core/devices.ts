import type { EffectType } from './types'

export type SynthId = 'drums' | 'bass' | 'keys' | 'pad' | 'pluck' | 'rhodes'
export type ParamUnit = 'hz' | 'db' | 's' | 'ms' | 'pct' | 'signed' | 'ct' | 'st' | 'x' | 'q' | 'ratio' | 'gain' | 'pan'

export interface ParamDef {
  id: string
  label: string
  min: number
  max: number
  default: number
  unit: ParamUnit
  scale?: 'log'
  options?: readonly { value: number; label: string }[]
}

const tone = (fallback = 0): ParamDef => ({ id: 'tone', label: '톤', min: -1, max: 1, default: fallback, unit: 'signed' })
const level: ParamDef = { id: 'level', label: '레벨', min: 0, max: 2, default: 1, unit: 'gain' }
const envelope = (attack: number, decay: number, sustain: number, release: number): ParamDef[] => [
  { id: 'attack', label: '어택', min: 0.001, max: 2, default: attack, unit: 's', scale: 'log' },
  { id: 'decay', label: '디케이', min: 0.01, max: 3, default: decay, unit: 's', scale: 'log' },
  { id: 'sustain', label: '서스테인', min: 0, max: 1, default: sustain, unit: 'pct' },
  { id: 'release', label: '릴리즈', min: 0.01, max: 5, default: release, unit: 's', scale: 'log' },
]

const tune: ParamDef = { id: 'tune', label: '튠', min: -12, max: 12, default: 0, unit: 'st' }

/** Defaults reproduce the original built-in instrument voicings exactly. */
export const INSTRUMENT_PARAMS: Record<SynthId, readonly ParamDef[]> = {
  bass: [tone(), ...envelope(0.006, 0.09, 0.65, 0.13), { id: 'sub', label: '서브', min: 0, max: 1, default: 0.65, unit: 'pct' }, level],
  keys: [tone(), ...envelope(0.004, 0.22, 0.2, 0.3), { id: 'bell', label: '배음', min: 0, max: 0.6, default: 0.2, unit: 'pct' }, level],
  pad: [tone(), ...envelope(0.08, 0.24, 0.7, 0.7), { id: 'detune', label: '디튠', min: 0, max: 40, default: 7, unit: 'ct' }, level],
  pluck: [tone(), ...envelope(0.003, 0.12, 0.08, 0.16), { id: 'sweep', label: '스윕', min: 0.02, max: 1, default: 0.25, unit: 's', scale: 'log' }, level],
  rhodes: [
    tone(),
    { id: 'attack', label: '어택', min: 0.001, max: 2, default: 0.003, unit: 's', scale: 'log' },
    { id: 'decay', label: '디케이', min: 0.2, max: 6, default: 2.5, unit: 's', scale: 'log' },
    { id: 'sustain', label: '서스테인', min: 0, max: 1, default: 0, unit: 'pct' },
    { id: 'release', label: '릴리즈', min: 0.01, max: 5, default: 0.25, unit: 's', scale: 'log' },
    { id: 'bark', label: '바크', min: 0, max: 1, default: 0.5, unit: 'pct' },
    level,
  ],
  drums: [
    tune,
    { id: 'decay', label: '디케이', min: 0.3, max: 3, default: 1, unit: 'x', scale: 'log' },
    tone(),
    { id: 'punch', label: '펀치', min: 0.5, max: 2, default: 1, unit: 'x' },
    level,
  ],
}

/** Sample sets already encode dynamics per layer, so the knobs only shape the playback. */
export const SAMPLED_PARAMS: readonly ParamDef[] = [
  tone(),
  { id: 'attack', label: '어택', min: 0.001, max: 2, default: 0.001, unit: 's', scale: 'log' },
  { id: 'release', label: '릴리즈', min: 0.02, max: 5, default: 0.25, unit: 's', scale: 'log' },
  level,
]
export const SAMPLED_KIT_PARAMS: readonly ParamDef[] = [
  tune,
  { id: 'decay', label: '디케이', min: 0.1, max: 1, default: 1, unit: 'x' },
  tone(),
  level,
]

export interface EffectDef {
  name: string
  short: string
  params: readonly ParamDef[]
}

const eqBand = (id: string, label: string): ParamDef => ({ id, label, min: -18, max: 18, default: 0, unit: 'db' })

export const EFFECT_DEFS: Record<EffectType, EffectDef> = {
  eq: {
    name: '3밴드 EQ', short: 'EQ',
    params: [eqBand('low', '저음'), eqBand('mid', '중음'), { id: 'midFreq', label: '중음 주파수', min: 200, max: 5000, default: 1000, unit: 'hz', scale: 'log' }, eqBand('high', '고음')],
  },
  filter: {
    name: '필터', short: '필터',
    params: [
      { id: 'cutoff', label: '컷오프', min: 20, max: 20000, default: 1200, unit: 'hz', scale: 'log' },
      { id: 'resonance', label: '레조넌스', min: 0.1, max: 18, default: 0.7, unit: 'q', scale: 'log' },
      { id: 'mode', label: '모드', min: 0, max: 2, default: 0, unit: 'q', options: [{ value: 0, label: '로우패스' }, { value: 1, label: '하이패스' }, { value: 2, label: '밴드패스' }] },
    ],
  },
  compressor: {
    name: '컴프레서', short: '컴프',
    params: [
      { id: 'threshold', label: '스레숄드', min: -60, max: 0, default: -18, unit: 'db' },
      { id: 'ratio', label: '비율', min: 1, max: 20, default: 4, unit: 'ratio', scale: 'log' },
      { id: 'attack', label: '어택', min: 0.1, max: 100, default: 10, unit: 'ms', scale: 'log' },
      { id: 'release', label: '릴리즈', min: 10, max: 1000, default: 150, unit: 'ms', scale: 'log' },
      { id: 'makeup', label: '메이크업', min: 0, max: 24, default: 0, unit: 'db' },
    ],
  },
  drive: {
    name: '드라이브', short: '드라이브',
    params: [
      { id: 'drive', label: '드라이브', min: 0, max: 36, default: 9, unit: 'db' },
      { id: 'tone', label: '톤', min: 500, max: 20000, default: 9000, unit: 'hz', scale: 'log' },
      { id: 'mix', label: '믹스', min: 0, max: 1, default: 1, unit: 'pct' },
      { id: 'output', label: '출력', min: -24, max: 6, default: 0, unit: 'db' },
    ],
  },
  delay: {
    name: '딜레이', short: '딜레이',
    params: [
      { id: 'amount', label: '양', min: 0, max: 1, default: 0.3, unit: 'pct' },
      {
        id: 'time', label: '시간', min: 0.25, max: 2, default: 0.75, unit: 'x',
        options: [{ value: 0.25, label: '1/16' }, { value: 0.5, label: '1/8' }, { value: 0.75, label: '1/8.' }, { value: 1, label: '1/4' }, { value: 1.5, label: '1/4.' }, { value: 2, label: '1/2' }],
      },
      { id: 'feedback', label: '피드백', min: 0, max: 0.95, default: 0.32, unit: 'pct' },
      { id: 'tone', label: '톤', min: 500, max: 16000, default: 3800, unit: 'hz', scale: 'log' },
    ],
  },
  reverb: {
    name: '리버브', short: '리버브',
    params: [
      { id: 'amount', label: '양', min: 0, max: 1, default: 0.3, unit: 'pct' },
      { id: 'size', label: '크기', min: 0, max: 1, default: 0.35, unit: 'pct' },
      { id: 'tone', label: '톤', min: 1000, max: 20000, default: 9000, unit: 'hz', scale: 'log' },
    ],
  },
}

export const EFFECT_TYPES = Object.keys(EFFECT_DEFS) as EffectType[]

export function defaultParams(defs: readonly ParamDef[]): Record<string, number> {
  return Object.fromEntries(defs.map(def => [def.id, def.default]))
}

export function paramValue(defs: readonly ParamDef[], params: Record<string, number> | undefined, id: string): number {
  const value = params?.[id]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return defs.find(def => def.id === id)?.default ?? 0
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

export function toNormalized(def: ParamDef, value: number): number {
  if (def.options) {
    const index = def.options.findIndex(option => option.value === value)
    return def.options.length > 1 ? Math.max(0, index) / (def.options.length - 1) : 0
  }
  if (def.scale === 'log') return clamp01(Math.log(value / def.min) / Math.log(def.max / def.min))
  return clamp01((value - def.min) / (def.max - def.min))
}

export function fromNormalized(def: ParamDef, normalized: number): number {
  const n = clamp01(normalized)
  if (def.options) return def.options[Math.round(n * (def.options.length - 1))].value
  const value = def.scale === 'log' ? def.min * Math.pow(def.max / def.min, n) : def.min + n * (def.max - def.min)
  return Math.min(def.max, Math.max(def.min, Number(value.toPrecision(5))))
}

export function formatParam(def: ParamDef, value: number): string {
  const option = def.options?.find(item => item.value === value)
  if (option) return option.label
  const sign = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '')
  switch (def.unit) {
    case 'hz': return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} kHz` : `${Math.round(value)} Hz`
    case 'db': return `${sign(value)}${Math.abs(value).toFixed(1)} dB`
    case 's': return value < 1 ? `${Math.round(value * 1000)} ms` : `${value.toFixed(2)} s`
    case 'ms': return `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`
    case 'pct': return `${Math.round(value * 100)}%`
    case 'signed': return `${sign(value)}${Math.abs(Math.round(value * 100))}`
    case 'ct': return `±${Math.round(value)} ct`
    case 'st': return `${sign(value)}${Math.abs(value).toFixed(1)} st`
    case 'x': return `×${value.toFixed(2)}`
    case 'ratio': return `${value.toFixed(1)}:1`
    case 'gain': return value <= 0.0001 ? '−∞ dB' : `${sign(20 * Math.log10(value))}${Math.abs(20 * Math.log10(value)).toFixed(1)} dB`
    case 'pan': return Math.abs(value) < 0.01 ? 'C' : `${Math.round(Math.abs(value) * 100)}${value < 0 ? 'L' : 'R'}`
    default: return value.toFixed(2)
  }
}

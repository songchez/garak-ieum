import type { ParamDef } from '../contracts'

/**
 * Parameter catalogs of the built-in vintage instruments (docs/RUST.md "빈티지 악기"). The DSP is
 * Rust (rust/garak-dsp/src/instruments): ids, order, defaults and ranges here must equal its
 * `PARAMS` tables — the WASM test (src/audio/rust/vintage.test.ts) compares them, and the native
 * engine rejects unknown ids. Ids persist in projects: append only.
 */

const pct = (id: string, label: string, fallback: number): ParamDef => ({ id, label, min: 0, max: 1, default: fallback, unit: 'pct' })
const level: ParamDef = { id: 'level', label: '레벨', min: 0, max: 2, default: 1, unit: 'gain' }

export const OKGU_EP_ID = 'okgu-ep' as const
export const HANBAM_106_ID = 'hanbam-106' as const
export type VintageInstrumentId = typeof OKGU_EP_ID | typeof HANBAM_106_ID
export const VINTAGE_INSTRUMENT_IDS: readonly VintageInstrumentId[] = [OKGU_EP_ID, HANBAM_106_ID]
export const isVintageInstrument = (id: unknown): id is VintageInstrumentId => id === OKGU_EP_ID || id === HANBAM_106_ID
/** `garak_dsp::instruments::InstrumentKind` (ABI). */
export const VINTAGE_KIND: Readonly<Record<VintageInstrumentId, number>> = { [OKGU_EP_ID]: 0, [HANBAM_106_ID]: 1 }

export const OKGU_EP_PARAMS: readonly ParamDef[] = [
  { id: 'tone', label: '톤', min: -1, max: 1, default: 0, unit: 'signed' },
  { id: 'decay', label: '울림 길이', min: 0.25, max: 4, default: 1, unit: 'x', scale: 'log' },
  pct('bark', '바크', 0.45),
  pct('bell', '벨', 0.5),
  pct('pickup', '픽업 비대칭', 0.35),
  pct('hammer', '해머', 0.4),
  { id: 'release', label: '댐퍼', min: 0.02, max: 1.5, default: 0.12, unit: 's', scale: 'log' },
  pct('thump', '댐퍼 소리', 0.35),
  pct('dynamics', '다이내믹', 0.7),
  { id: 'tremRate', label: '트레몰로 속도', min: 0.1, max: 12, default: 4.5, unit: 'hz', scale: 'log' },
  pct('tremDepth', '트레몰로', 0),
  pct('autopan', '오토팬', 0),
  pct('drive', '앰프 드라이브', 0),
  { id: 'tune', label: '튠', min: -100, max: 100, default: 0, unit: 'ct' },
  level,
]

export const HANBAM_106_PARAMS: readonly ParamDef[] = [
  { id: 'range', label: '옥타브', min: 0, max: 2, default: 1, unit: 'x', options: [{ value: 0, label: "16'" }, { value: 1, label: "8'" }, { value: 2, label: "4'" }] },
  pct('saw', '톱니', 1),
  pct('pulse', '펄스', 0),
  pct('pwm', 'PWM', 0.35),
  { id: 'pwmSource', label: 'PWM 소스', min: 0, max: 2, default: 1, unit: 'x', options: [{ value: 0, label: '수동' }, { value: 1, label: 'LFO' }, { value: 2, label: 'ENV' }] },
  pct('sub', '서브', 0.3),
  pct('noise', '노이즈', 0),
  { id: 'hpf', label: 'HPF', min: 0, max: 3, default: 1, unit: 'x', options: [{ value: 0, label: '부스트' }, { value: 1, label: '0' }, { value: 2, label: '1' }, { value: 3, label: '2' }] },
  { id: 'cutoff', label: '컷오프', min: 20, max: 18000, default: 2400, unit: 'hz', scale: 'log' },
  pct('resonance', '레조넌스', 0.15),
  { id: 'envAmount', label: '엔벨로프 양', min: -1, max: 1, default: 0.35, unit: 'signed' },
  pct('lfoFilter', 'LFO → 필터', 0),
  pct('keyTrack', '키 트래킹', 0.5),
  pct('velocity', '벨로시티', 0.3),
  { id: 'attack', label: '어택', min: 0.001, max: 3, default: 0.005, unit: 's', scale: 'log' },
  { id: 'decay', label: '디케이', min: 0.002, max: 10, default: 0.6, unit: 's', scale: 'log' },
  pct('sustain', '서스테인', 0.6),
  { id: 'release', label: '릴리즈', min: 0.002, max: 10, default: 0.35, unit: 's', scale: 'log' },
  { id: 'vcaMode', label: 'VCA', min: 0, max: 1, default: 0, unit: 'x', options: [{ value: 0, label: 'ENV' }, { value: 1, label: 'GATE' }] },
  { id: 'lfoRate', label: 'LFO 속도', min: 0.05, max: 20, default: 4, unit: 'hz', scale: 'log' },
  { id: 'lfoDelay', label: 'LFO 지연', min: 0, max: 3, default: 0, unit: 's' },
  pct('vibrato', '비브라토', 0),
  { id: 'glide', label: '포르타멘토', min: 0, max: 2, default: 0, unit: 's' },
  { id: 'voices', label: '보이스', min: 1, max: 8, default: 6, unit: 'x', options: [{ value: 1, label: '모노' }, { value: 4, label: '4' }, { value: 6, label: '6' }, { value: 8, label: '8' }] },
  { id: 'chorus', label: '코러스', min: 0, max: 3, default: 1, unit: 'x', options: [{ value: 0, label: '끔' }, { value: 1, label: 'I' }, { value: 2, label: 'II' }, { value: 3, label: 'I+II' }] },
  pct('drift', '드리프트', 0.15),
  level,
]

export const VINTAGE_PARAMS: Readonly<Record<VintageInstrumentId, readonly ParamDef[]>> = {
  [OKGU_EP_ID]: OKGU_EP_PARAMS,
  [HANBAM_106_ID]: HANBAM_106_PARAMS,
}

/** Release tail after the last note-off (export allowance), mirroring Rust `tail_seconds`. */
export function vintageTailSeconds(id: VintageInstrumentId, params: Readonly<Record<string, number>> | undefined): number {
  const values = vintageParamVector(id, params)
  const value = (key: string) => values[VINTAGE_PARAMS[id].findIndex(def => def.id === key)]
  if (id === OKGU_EP_ID) return Math.min(30, Math.max(value('release'), 7.5 * value('decay') * 2 ** (-(92 - 40) / 22)) + 0.15)
  return Math.min(30, (value('vcaMode') >= 0.5 ? 0.02 : value('release') * 2) + 0.02)
}

/** Every catalog value in order (missing / non-finite → default, clamped): the Rust `set_params` layout. */
export function vintageParamVector(id: VintageInstrumentId, params: Readonly<Record<string, number>> | undefined): number[] {
  return VINTAGE_PARAMS[id].map(def => {
    const value = params?.[def.id]
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(def.max, Math.max(def.min, value)) : def.default
  })
}

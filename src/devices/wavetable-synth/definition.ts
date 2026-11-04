import type { ParamDef } from '../contracts'
import { WAVE_PARAMETER_SCHEMA, WAVE_MODULATION_SOURCES } from './schema.generated'

export { WAVE_LIMITS, WAVE_SCHEMA_FINGERPRINT, WAVE_FACTORY_BANKS } from './schema.generated'
export type { WavetableParamId, WavetableModSource } from './schema.generated'

/** Stable numeric and textual IDs shared by project automation and the C++ DSP. */
export const WAVE_PARAMS: readonly ParamDef[] = WAVE_PARAMETER_SCHEMA
export const WAVE_PARAM_DEFINITIONS = WAVE_PARAMETER_SCHEMA
export const WAVE_SOURCES = WAVE_MODULATION_SOURCES
export const WAVE_MOD_DESTINATIONS = WAVE_PARAMETER_SCHEMA.filter(p => 'modulate' in p && p.modulate)
export const WAVETABLE_INSTRUMENT_ID = 'wavetable' as const
export const WAVETABLE_DEFINITION = {
  id: WAVETABLE_INSTRUMENT_ID,
  name: 'IEUM WAVE',
  nameKo: '이음 웨이브',
  type: 'WAVETABLE SYNTH',
  category: 'synth',
  kind: 'native',
  isKit: false,
  icon: 'synth',
  color: '#64d9be',
  description: '세 개의 웨이브테이블과 직접 그리는 변조 곡선으로 만드는 나만의 소리',
  params: WAVE_PARAMS,
} as const

import { HANBAM_106_ID, OKGU_EP_ID, VINTAGE_PARAMS, type VintageInstrumentId } from '../params'
import { matchingPreset, presetParams, VINTAGE_PRESETS } from '../presets'
import { sanitizePresetParams, type VintageUserPreset } from '../userPresets'

/** Display names of the vintage instruments (header, undo labels). */
export const VINTAGE_NAMES: Readonly<Record<VintageInstrumentId, string>> = { [OKGU_EP_ID]: '옥구슬 EP', [HANBAM_106_ID]: '한밤 106' }
/** Shown when the current sound matches no factory or user preset. */
export const CUSTOM_PRESET_NAME = '사용자 설정'
export const USER_PREFIX = 'user:'

/** True when `params` (missing ids = defaults) equals the complete set `other` within rounding. */
export function sameVintageParams(instrument: VintageInstrumentId, params: Readonly<Record<string, number>>, other: Readonly<Record<string, number>>): boolean {
  return VINTAGE_PARAMS[instrument].every(def => Math.abs((params[def.id] ?? def.default) - (other[def.id] ?? def.default)) < 1e-6)
}

export interface CurrentPreset { value: string; name: string; detail?: string; user?: VintageUserPreset }

/** The preset the current sound equals: factory first, then the user's own, else 사용자 설정. */
export function currentPreset(instrument: VintageInstrumentId, params: Readonly<Record<string, number>>, users: readonly VintageUserPreset[]): CurrentPreset {
  const factory = matchingPreset(instrument, params)
  if (factory) return { value: factory.id, name: factory.name, detail: factory.description }
  const user = users.find(item => sameVintageParams(instrument, params, item.params))
  if (user) return { value: USER_PREFIX + user.id, name: user.name, detail: '내 프리셋', user }
  return { value: 'custom', name: CUSTOM_PRESET_NAME }
}

/** A picker value (`<factory id>` or `user:<id>`) as one complete parameter set plus its undo label. */
export function resolvePresetChoice(instrument: VintageInstrumentId, value: string, users: readonly VintageUserPreset[]): { params: Record<string, number>; label: string; name: string } | null {
  if (value.startsWith(USER_PREFIX)) {
    const user = users.find(item => USER_PREFIX + item.id === value)
    return user ? { params: sanitizePresetParams(instrument, user.params), label: `${VINTAGE_NAMES[instrument]} 프리셋: ${user.name}`, name: user.name } : null
  }
  const preset = VINTAGE_PRESETS[instrument].find(item => item.id === value)
  return preset ? { params: presetParams(instrument, preset), label: `${VINTAGE_NAMES[instrument]} 프리셋: ${preset.name}`, name: preset.name } : null
}

/** Applies a picker choice as ONE edit (one undo step). Returns the applied preset name, or null. */
export function applyPresetChoice(instrument: VintageInstrumentId, value: string, users: readonly VintageUserPreset[], onParams: (params: Record<string, number>, label: string) => void): string | null {
  const choice = resolvePresetChoice(instrument, value, users)
  if (!choice) return null
  onParams(choice.params, choice.label)
  return choice.name
}

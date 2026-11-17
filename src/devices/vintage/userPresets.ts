import { VINTAGE_PARAMS, type VintageInstrumentId } from './params'

/**
 * Sounds the user saved from a vintage instrument editor: local to this app (shared by all
 * projects, kept across restarts), one list per instrument — the same model as the guitar rig's
 * user presets (src/devices/guitar-rig/userPresets.ts).
 */
export interface VintageUserPreset { id: string; name: string; params: Record<string, number>; savedAt: number }

export const userPresetStorageKey = (instrument: VintageInstrumentId) => `garak-ieum:vintage-presets:${instrument}`
export const MAX_USER_PRESETS = 200
export const MAX_PRESET_NAME = 40

type Store = Pick<Storage, 'getItem' | 'setItem'>
const storage = (): Store | undefined => { try { return globalThis.localStorage } catch { return undefined } }

export function sanitizePresetParams(instrument: VintageInstrumentId, raw: unknown): Record<string, number> {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return Object.fromEntries(VINTAGE_PARAMS[instrument].map(def => {
    const value = source[def.id]
    return [def.id, typeof value === 'number' && Number.isFinite(value) ? Math.min(def.max, Math.max(def.min, value)) : def.default]
  }))
}

export const cleanPresetName = (name: string) => name.replace(/\s+/g, ' ').trim().slice(0, MAX_PRESET_NAME)

export function sanitizeUserPresets(instrument: VintageInstrumentId, raw: unknown): VintageUserPreset[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: VintageUserPreset[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const value = item as Record<string, unknown>
    const id = typeof value.id === 'string' ? value.id.slice(0, 64) : ''
    const name = typeof value.name === 'string' ? cleanPresetName(value.name) : ''
    if (!id || !name || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name, params: sanitizePresetParams(instrument, value.params), savedAt: typeof value.savedAt === 'number' && Number.isFinite(value.savedAt) ? value.savedAt : 0 })
    if (out.length >= MAX_USER_PRESETS) break
  }
  return out
}

export function loadUserPresets(instrument: VintageInstrumentId, store = storage()): VintageUserPreset[] {
  try { const raw = store?.getItem(userPresetStorageKey(instrument)); return raw ? sanitizeUserPresets(instrument, JSON.parse(raw)) : [] } catch { return [] }
}

export function saveUserPresets(instrument: VintageInstrumentId, list: readonly VintageUserPreset[], store = storage()): boolean {
  try { store?.setItem(userPresetStorageKey(instrument), JSON.stringify(list)); return !!store } catch { return false }
}

/** Saves `params` under `name`; an existing preset with the same name (ignoring case) is overwritten in place. */
export function putUserPreset(instrument: VintageInstrumentId, list: readonly VintageUserPreset[], name: string, params: Record<string, number>, now = Date.now(),
  makeId = () => `p${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`): { list: VintageUserPreset[]; preset: VintageUserPreset; replaced: boolean } {
  const clean = cleanPresetName(name)
  if (!clean) throw new Error('프리셋 이름을 입력해 주세요.')
  const existing = list.find(item => item.name.toLocaleLowerCase() === clean.toLocaleLowerCase())
  const preset: VintageUserPreset = { id: existing?.id ?? makeId(), name: clean, params: sanitizePresetParams(instrument, params), savedAt: now }
  if (existing) return { list: list.map(item => item.id === existing.id ? preset : item), preset, replaced: true }
  if (list.length >= MAX_USER_PRESETS) throw new Error(`프리셋은 최대 ${MAX_USER_PRESETS}개까지 저장할 수 있습니다.`)
  return { list: [...list, preset], preset, replaced: false }
}

export const removeUserPreset = (list: readonly VintageUserPreset[], id: string) => list.filter(item => item.id !== id)

import { GUITAR_RIG_PARAMS } from './definition.js'

/**
 * Presets the user saved from the guitar rig editor. They live in this app's local storage (shared by all
 * projects, kept across restarts), not in a project file: a project keeps its own rig settings anyway.
 */
export interface GuitarRigUserPreset { id: string; name: string; params: Record<string, number>; savedAt: number }

export const USER_PRESET_STORAGE_KEY = 'garak-ieum:guitar-rig-presets'
export const MAX_USER_PRESETS = 200
export const MAX_PRESET_NAME = 40

type Store = Pick<Storage, 'getItem' | 'setItem'>
const storage = (): Store | undefined => { try { return globalThis.localStorage } catch { return undefined } }

/** Every rig parameter, clamped to its range; missing or invalid values fall back to the default. */
export function sanitizePresetParams(raw: unknown): Record<string, number> {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return Object.fromEntries(GUITAR_RIG_PARAMS.map(def => {
    const value = source[def.id]
    return [def.id, typeof value === 'number' && Number.isFinite(value) ? Math.min(def.max, Math.max(def.min, value)) : def.default]
  }))
}

export const cleanPresetName = (name: string) => name.replace(/\s+/g, ' ').trim().slice(0, MAX_PRESET_NAME)

export function sanitizeUserPresets(raw: unknown): GuitarRigUserPreset[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: GuitarRigUserPreset[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const value = item as Record<string, unknown>
    const id = typeof value.id === 'string' ? value.id.slice(0, 64) : ''
    const name = typeof value.name === 'string' ? cleanPresetName(value.name) : ''
    if (!id || !name || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name, params: sanitizePresetParams(value.params), savedAt: typeof value.savedAt === 'number' && Number.isFinite(value.savedAt) ? value.savedAt : 0 })
    if (out.length >= MAX_USER_PRESETS) break
  }
  return out
}

export function loadUserPresets(store = storage()): GuitarRigUserPreset[] {
  try { const raw = store?.getItem(USER_PRESET_STORAGE_KEY); return raw ? sanitizeUserPresets(JSON.parse(raw)) : [] } catch { return [] }
}

export function saveUserPresets(list: readonly GuitarRigUserPreset[], store = storage()): boolean {
  try { store?.setItem(USER_PRESET_STORAGE_KEY, JSON.stringify(list)); return !!store } catch { return false }
}

/** Saves `params` under `name`; an existing preset with the same name (ignoring case) is overwritten in place. */
export function putUserPreset(list: readonly GuitarRigUserPreset[], name: string, params: Record<string, number>, now = Date.now(), makeId = () => `p${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`): { list: GuitarRigUserPreset[]; preset: GuitarRigUserPreset; replaced: boolean } {
  const clean = cleanPresetName(name)
  if (!clean) throw new Error('프리셋 이름을 입력해 주세요.')
  const existing = list.find(item => item.name.toLocaleLowerCase() === clean.toLocaleLowerCase())
  const preset: GuitarRigUserPreset = { id: existing?.id ?? makeId(), name: clean, params: sanitizePresetParams(params), savedAt: now }
  if (existing) return { list: list.map(item => item.id === existing.id ? preset : item), preset, replaced: true }
  if (list.length >= MAX_USER_PRESETS) throw new Error(`프리셋은 최대 ${MAX_USER_PRESETS}개까지 저장할 수 있습니다.`)
  return { list: [...list, preset], preset, replaced: false }
}

export const removeUserPreset = (list: readonly GuitarRigUserPreset[], id: string) => list.filter(item => item.id !== id)

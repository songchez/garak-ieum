import { describe, expect, it } from 'vitest'
import { HANBAM_106_ID, OKGU_EP_ID, VINTAGE_PARAMS } from './params'
import { loadUserPresets, MAX_PRESET_NAME, putUserPreset, removeUserPreset, sanitizePresetParams, sanitizeUserPresets, saveUserPresets, userPresetStorageKey } from './userPresets'

const memory = () => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, data } }
const def = (id: string) => VINTAGE_PARAMS[HANBAM_106_ID].find(item => item.id === id)!

describe('vintage user presets', () => {
  it('sanitises params: clamps, fills defaults, drops unknown and non-finite values', () => {
    const clean = sanitizePresetParams(HANBAM_106_ID, { cutoff: 99999, resonance: -3, saw: Number.NaN, attack: 'slow', bogus: 1 })
    expect(Object.keys(clean)).toEqual(VINTAGE_PARAMS[HANBAM_106_ID].map(item => item.id))
    expect(clean.cutoff).toBe(def('cutoff').max)
    expect(clean.resonance).toBe(0)
    expect(clean.saw).toBe(def('saw').default)
    expect(clean.attack).toBe(def('attack').default)
    expect('bogus' in clean).toBe(false)
    expect(sanitizePresetParams(OKGU_EP_ID, null).tone).toBe(0)
  })

  it('saves per instrument and reads it back', () => {
    const store = memory()
    const { list, preset, replaced } = putUserPreset(OKGU_EP_ID, [], '  내   소리 ', { bark: 0.9 }, 1000, () => 'a')
    expect(replaced).toBe(false)
    expect(preset).toMatchObject({ id: 'a', name: '내 소리', savedAt: 1000 })
    expect(preset.params.bark).toBe(0.9)
    expect(Object.keys(preset.params)).toHaveLength(VINTAGE_PARAMS[OKGU_EP_ID].length)
    expect(saveUserPresets(OKGU_EP_ID, list, store)).toBe(true)
    expect(store.data.has(userPresetStorageKey(OKGU_EP_ID))).toBe(true)
    expect(loadUserPresets(OKGU_EP_ID, store)).toEqual(list)
    expect(loadUserPresets(HANBAM_106_ID, store)).toEqual([])
  })

  it('overwrites a preset with the same name (ignoring case), keeps its id, and removes by id', () => {
    const first = putUserPreset(HANBAM_106_ID, [], 'Pad', { cutoff: 1000 }, 1, () => 'x').list
    const other = putUserPreset(HANBAM_106_ID, first, 'Lead', { cutoff: 3000 }, 2, () => 'y').list
    const second = putUserPreset(HANBAM_106_ID, other, 'pad', { cutoff: 1500 }, 3, () => 'z')
    expect(second.replaced).toBe(true)
    expect(second.list.map(item => item.id)).toEqual(['x', 'y'])
    expect(second.list[0]).toMatchObject({ id: 'x', name: 'pad', savedAt: 3 })
    expect(second.list[0].params.cutoff).toBe(1500)
    expect(removeUserPreset(second.list, 'x').map(item => item.id)).toEqual(['y'])
    expect(() => putUserPreset(HANBAM_106_ID, [], '   ', {})).toThrow('이름')
  })

  it('repairs stored data: drops broken entries and duplicates, trims long names, survives bad JSON', () => {
    const repaired = sanitizeUserPresets(OKGU_EP_ID, [
      { id: 'a', name: 'x'.repeat(80), params: { bark: 7 }, savedAt: 5 },
      { id: 'a', name: 'dup' }, { name: 'no id' }, null, 'junk', { id: 'b', name: '   ' },
    ])
    expect(repaired).toHaveLength(1)
    expect(repaired[0].name).toHaveLength(MAX_PRESET_NAME)
    expect(repaired[0].params.bark).toBe(1)
    expect(sanitizeUserPresets(OKGU_EP_ID, { not: 'a list' })).toEqual([])
    const broken = memory(); broken.setItem(userPresetStorageKey(OKGU_EP_ID), '{not json')
    expect(loadUserPresets(OKGU_EP_ID, broken)).toEqual([])
  })
})

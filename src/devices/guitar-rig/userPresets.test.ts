import { describe, expect, it } from 'vitest'
import { GUITAR_RIG_DEFAULTS, GUITAR_RIG_PARAMS, guitarRigOrderParams } from './definition'
import { loadUserPresets, MAX_PRESET_NAME, putUserPreset, removeUserPreset, saveUserPresets, sanitizeUserPresets, USER_PRESET_STORAGE_KEY } from './userPresets'

const memory = () => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, data } }

describe('guitar rig user presets', () => {
  it('saves every rig control, including rack order and second copies, and reads it back', () => {
    const store = memory()
    const params = { ...GUITAR_RIG_DEFAULTS, ...guitarRigOrderParams(['drive', 'drive_2', 'amp', 'delay', 'cabinet']), driveGain_2: 21, delayMix: 0.4 }
    const { list, preset, replaced } = putUserPreset([], '  My   Lead  ', params, 1000, () => 'a')
    expect(replaced).toBe(false)
    expect(preset).toMatchObject({ id: 'a', name: 'My Lead', savedAt: 1000 })
    expect(Object.keys(preset.params)).toHaveLength(GUITAR_RIG_PARAMS.length)
    expect(saveUserPresets(list, store)).toBe(true)
    expect(JSON.parse(store.data.get(USER_PRESET_STORAGE_KEY)!)).toHaveLength(1)
    expect(loadUserPresets(store)).toEqual(list)
    expect(loadUserPresets(store)[0].params).toMatchObject({ driveGain_2: 21, delayMix: 0.4, rackSlot1: 2 + 16 })
  })
  it('overwrites a preset with the same name instead of adding a duplicate, and removes by id', () => {
    const first = putUserPreset([], 'Clean', GUITAR_RIG_DEFAULTS, 1, () => 'x').list
    const second = putUserPreset(first, 'clean', { ...GUITAR_RIG_DEFAULTS, ampGain: 20 }, 2, () => 'y')
    expect(second.replaced).toBe(true)
    expect(second.list).toHaveLength(1)
    expect(second.list[0]).toMatchObject({ id: 'x', name: 'clean', savedAt: 2 })
    expect(second.list[0].params.ampGain).toBe(20)
    expect(removeUserPreset(second.list, 'x')).toEqual([])
    expect(() => putUserPreset([], '   ', GUITAR_RIG_DEFAULTS)).toThrow('이름')
  })
  it('repairs stored data: clamps values, fills missing controls, drops broken entries and long names', () => {
    const repaired = sanitizeUserPresets([
      { id: 'a', name: 'x'.repeat(80), params: { ampGain: 999, delayMix: 'loud' }, savedAt: 5 },
      { id: 'a', name: 'dup' }, { name: 'no id' }, null, 'junk', { id: 'b', name: '' },
    ])
    expect(repaired).toHaveLength(1)
    expect(repaired[0].name).toHaveLength(MAX_PRESET_NAME)
    expect(repaired[0].params.ampGain).toBe(GUITAR_RIG_PARAMS.find(p => p.id === 'ampGain')!.max)
    expect(repaired[0].params.delayMix).toBe(GUITAR_RIG_DEFAULTS.delayMix)
    expect(sanitizeUserPresets({})).toEqual([])
    const broken = memory(); broken.setItem(USER_PRESET_STORAGE_KEY, '{not json')
    expect(loadUserPresets(broken)).toEqual([])
  })
})

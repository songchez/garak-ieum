import { describe, expect, it } from 'vitest'
import { HANBAM_106_ID, OKGU_EP_ID, VINTAGE_INSTRUMENT_IDS, VINTAGE_PARAMS } from './params'
import { matchingPreset, presetParams, VINTAGE_PRESETS } from './presets'

describe('vintage factory presets', () => {
  it('only override catalog parameters, within range, with unique ids and names', () => {
    for (const id of VINTAGE_INSTRUMENT_IDS) {
      const defs = new Map(VINTAGE_PARAMS[id].map(def => [def.id, def]))
      const presets = VINTAGE_PRESETS[id]
      expect(presets.length).toBeGreaterThan(0)
      expect(new Set(presets.map(p => p.id)).size).toBe(presets.length)
      expect(new Set(presets.map(p => p.name)).size).toBe(presets.length)
      for (const preset of presets) for (const [key, value] of Object.entries(preset.params)) {
        const def = defs.get(key)
        expect(def, `${id}/${preset.id}: ${key}`).toBeDefined()
        expect(value).toBeGreaterThanOrEqual(def!.min)
        expect(value).toBeLessThanOrEqual(def!.max)
        if (def!.options) expect(def!.options.map(o => o.value)).toContain(value)
      }
    }
  })

  it('expands a preset to the complete parameter set (defaults + overrides)', () => {
    const preset = VINTAGE_PRESETS[OKGU_EP_ID][0]
    const full = presetParams(OKGU_EP_ID, preset)
    expect(Object.keys(full)).toEqual(VINTAGE_PARAMS[OKGU_EP_ID].map(def => def.id))
    for (const def of VINTAGE_PARAMS[OKGU_EP_ID]) expect(full[def.id]).toBe(preset.params[def.id] ?? def.default)
  })

  it('matches the preset whose complete set equals the params, and nothing once edited', () => {
    for (const id of [OKGU_EP_ID, HANBAM_106_ID] as const) for (const preset of VINTAGE_PRESETS[id]) {
      expect(matchingPreset(id, presetParams(id, preset))?.id).toBe(preset.id)
      // Sparse params (missing ids = defaults) still match.
      expect(matchingPreset(id, { ...preset.params })?.id).toBe(preset.id)
    }
    const bass = VINTAGE_PRESETS[HANBAM_106_ID].find(p => p.id === 'bass')!
    expect(matchingPreset(HANBAM_106_ID, { ...presetParams(HANBAM_106_ID, bass), cutoff: 421 })).toBeUndefined()
    expect(matchingPreset(HANBAM_106_ID, { ...presetParams(HANBAM_106_ID, bass), cutoff: 420 + 1e-9 })?.id).toBe('bass')
    // All defaults is not one of the factory sounds.
    expect(matchingPreset(OKGU_EP_ID, {})).toBeUndefined()
  })
})

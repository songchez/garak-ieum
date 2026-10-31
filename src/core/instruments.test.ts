import { describe, expect, it } from 'vitest'
import { INSTRUMENTS, INSTRUMENT_SECTIONS, SAMPLE_SETS, instrumentDef, isInstrumentId, previewPitch } from './instruments'
import { SAMPLED_KIT_PARAMS, SAMPLED_PARAMS } from './devices'
import { createEmptyProject, createTrack, defaultInstrumentParams, validateProject } from './project'

describe('instrument registry', () => {
  it('has unique ids, a section for every category, and a set for every sampled instrument', () => {
    expect(new Set(INSTRUMENTS.map(def => def.id)).size).toBe(INSTRUMENTS.length)
    const sectioned = new Set(INSTRUMENT_SECTIONS.flatMap(section => section.categories))
    for (const def of INSTRUMENTS) {
      expect(sectioned.has(def.category)).toBe(true)
      expect(def.color).toMatch(/^#[\da-f]{6}$/i)
      if (def.kind === 'sampled') {
        expect(def.set).toMatch(/^[\w-]+$/)
        expect(def.params).toBe(def.isKit ? SAMPLED_KIT_PARAMS : SAMPLED_PARAMS)
      } else expect(def.set).toBeUndefined()
    }
    expect(SAMPLE_SETS).toEqual(['salamander', 'wurlitzer', 'kit-acoustic', 'kit-808', 'kit-lofi', 'samul', 'gayageum', 'haegeum', 'daegeum'])
  })

  it('falls back to the keys definition for unknown ids without accepting them', () => {
    expect(instrumentDef('grand').name).toBe('Grand Piano')
    expect(instrumentDef('no-such-thing')).toBe(instrumentDef('keys'))
    expect(isInstrumentId('samul')).toBe(true)
    expect(isInstrumentId('no-such-thing')).toBe(false)
    expect(isInstrumentId(42)).toBe(false)
  })

  it('previews kits on the snare, bass on a low note, and everything else on middle C', () => {
    expect(previewPitch(instrumentDef('kit-808'))).toBe(38)
    expect(previewPitch(instrumentDef('samul'))).toBe(38)
    expect(previewPitch(instrumentDef('drums'))).toBe(38)
    expect(previewPitch(instrumentDef('bass'))).toBe(36)
    expect(previewPitch(instrumentDef('grand'))).toBe(60)
  })
})

describe('sampled instruments in projects', () => {
  it('creates tracks from the registry and validates their parameters', () => {
    const track = createTrack('instrument', 'grand')
    expect(track.name).toBe('Grand Piano')
    expect(track.color).toBe('#d9b45a')
    expect(track.instrumentParams).toEqual({ tone: 0, attack: 0.001, release: 0.25, level: 1 })
    const kit = createTrack('instrument', 'kit-808')
    expect(kit.instrumentParams).toEqual({ tune: 0, decay: 1, tone: 0, level: 1 })
    const project = { ...createEmptyProject(), tracks: [track, kit] }
    expect(validateProject(project)).toEqual(project)
    expect(() => validateProject({ ...project, tracks: [{ ...kit, instrumentParams: { ...kit.instrumentParams, decay: 3 } }] })).toThrow(/instrument decay/)
  })

  it('rejects unknown instrument ids with the original message', () => {
    const track = { ...createTrack('instrument', 'haegeum'), instrument: 'theremin' }
    expect(() => validateProject({ ...createEmptyProject(), tracks: [track] })).toThrow(/unknown instrument/)
    expect(defaultInstrumentParams('rhodes')).toMatchObject({ bark: 0.5, decay: 2.5, sustain: 0 })
  })
})

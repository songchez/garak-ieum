import { describe, expect, it } from 'vitest'
import { defaultParams } from '../../core/devices'
import { createDevice, createEmptyProject, createTrack, validateProject } from '../../core/project'
import { sigimsaeVariant } from '../../core/sigimsaeVariants'
import { paramValue } from './shared'
import { EFFECT_DEFS } from './registry'
import { EqType, butterworthQs, eqBandInUse, eqBandSections, eqParamId, eqResponseDb, filterSections, readEqBands, sectionsResponseDb, type EqBand } from './eqModel'

const SR = 48000
const band = (patch: Partial<EqBand>): EqBand => ({ index: 5, on: true, bypassed: false, type: EqType.bell, freq: 1000, gain: 0, q: 1, slope: 0, ...patch })
const bandsOf = (params: Record<string, number>) => readEqBands(id => paramValue(EFFECT_DEFS.eq.params, params, id))

describe('parametric EQ model', () => {
  it('keeps the original 3-band ids as bands 1–3 so saved projects and presets sound the same', () => {
    expect([eqParamId(1, 'gain'), eqParamId(2, 'gain'), eqParamId(2, 'freq'), eqParamId(3, 'gain')]).toEqual(['low', 'mid', 'midFreq', 'high'])
    const bands = bandsOf({ low: 5, mid: -2, midFreq: 450 })
    expect(bands.slice(0, 3).map(b => [b.on, b.type, b.freq, b.gain, b.q])).toEqual([
      [true, EqType.lowShelf, 220, 5, 1], [true, EqType.bell, 450, -2, 0.9], [true, EqType.highShelf, 4500, 0, 1],
    ])
    expect(bands.slice(3).every(b => !b.on && !eqBandInUse(b))).toBe(true)
    // Library variants still load with their old values.
    const presence = sigimsaeVariant('eq-vocal-presence')!
    expect(bandsOf(presence.params as Record<string, number>)[1]).toMatchObject({ freq: 2800, gain: 3.5 })
  })

  it('loads an old 3-band project file unchanged and fills the new band defaults', () => {
    const track = { ...createTrack('audio'), devices: [{ id: 'eq-old', type: 'eq', enabled: true, params: { low: -3, mid: 4, midFreq: 1500, high: 2 } }] }
    const project = validateProject({ ...createEmptyProject(), tracks: [track] } as never)
    const params = project.tracks[0].devices[0].type === 'eq' ? (project.tracks[0].devices[0] as { params: Record<string, number> }).params : {}
    expect(params).toMatchObject({ low: -3, mid: 4, midFreq: 1500, high: 2, b4On: 0, output: 0 })
    expect(Object.keys(params)).toEqual(Object.keys(defaultParams(EFFECT_DEFS.eq.params)))
  })

  it('is flat by default and matches the response maths of each band shape', () => {
    const flat = bandsOf({})
    for (const f of [30, 200, 1000, 8000, 16000]) expect(eqResponseDb(flat, 0, f, SR)).toBeCloseTo(0, 9)
    expect(sectionsResponseDb(eqBandSections(band({ gain: 6, q: 2 }), SR), 1000, SR)).toBeCloseTo(6, 6)
    expect(sectionsResponseDb(eqBandSections(band({ type: EqType.lowShelf, freq: 200, gain: 6 }), SR), 20, SR)).toBeCloseTo(6, 1)
    expect(sectionsResponseDb(eqBandSections(band({ type: EqType.highShelf, freq: 2000, gain: -6 }), SR), 18000, SR)).toBeCloseTo(-6, 0)
    expect(sectionsResponseDb(eqBandSections(band({ type: EqType.notch, q: 4 }), SR), 1000, SR)).toBeLessThan(-60)
    expect(eqResponseDb(flat, -3, 1000, SR)).toBeCloseTo(-3, 9)
    // State 2 = bypassed: silent but still shown on the graph.
    const bypassed = bandsOf({ mid: 9, b2On: 2 })
    expect(bypassed[1]).toMatchObject({ on: false, bypassed: true })
    expect(eqBandInUse(bypassed[1])).toBe(true)
    expect(eqResponseDb(bypassed, 0, 1000, SR)).toBeCloseTo(0, 9)
  })

  it('builds Butterworth cut slopes: -3 dB at the corner and 12·n dB/oct beyond', () => {
    expect(butterworthQs(1)[0]).toBeCloseTo(Math.SQRT1_2, 9)
    expect(butterworthQs(2)).toEqual([expect.closeTo(0.5412, 3), expect.closeTo(1.3066, 3)])
    for (const slope of [0, 1, 2, 3]) {
      const cut = eqBandSections(band({ type: EqType.lowCut, freq: 200, q: Math.SQRT1_2, slope }), SR)
      expect(cut).toHaveLength(slope + 1)
      expect(sectionsResponseDb(cut, 200, SR)).toBeCloseTo(-3.01, 1)
      // Analog Butterworth of order N one octave below the corner: -10·log10(1 + 2^(2N)).
      expect(sectionsResponseDb(cut, 100, SR)).toBeCloseTo(-10 * Math.log10(1 + Math.pow(2, 4 * (slope + 1))), 0)
    }
    const high = eqBandSections(band({ type: EqType.highCut, freq: 1000, q: Math.SQRT1_2, slope: 3 }), SR)
    expect(sectionsResponseDb(high, 2000, SR)).toBeCloseTo(-48.2, 0)
    // More Q = a resonant peak at the corner.
    expect(sectionsResponseDb(eqBandSections(band({ type: EqType.highCut, freq: 1000, q: 4, slope: 1 }), SR), 1000, SR)).toBeGreaterThan(10)
  })

  it('Sweep keeps the original single filter at 12 dB/oct and adds flat 24/48 dB cascades', () => {
    expect(filterSections(0, 1200, 0.7, 0, SR)).toEqual([{ type: 'lowpass', freq: 1200, q: 0.7, gain: 0 }])
    expect(filterSections(2, 1800, 1.4, 0, SR)).toEqual([{ type: 'bandpass', freq: 1800, q: 1.4, gain: 0 }])
    expect(sectionsResponseDb(filterSections(0, 1200, 0.7, 1, SR), 1200, SR)).toBeCloseTo(-3.01, 1)
    expect(sectionsResponseDb(filterSections(1, 500, 0.7, 2, SR), 250, SR)).toBeCloseTo(-48.2, 0)
    expect(createDevice('filter').params.slope).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import { PALETTE_COLUMNS, PALETTE_ROWS, TRACK_PALETTE, defaultTrackColor, hexToRgb, hslToHex, nearestPaletteColor, paletteIndex, paletteSlot, rgbToHsl } from './colors'

const LEGACY = ['#e38457', '#7fb59a', '#6f9fd0', '#8cc7c0', '#d98a9f', '#d9b45a', '#c9a06a']

describe('TRACK_PALETTE', () => {
  it('has 96 unique lowercase #rrggbb colors', () => {
    expect(TRACK_PALETTE).toHaveLength(PALETTE_ROWS * PALETTE_COLUMNS)
    expect(TRACK_PALETTE).toHaveLength(96)
    expect(new Set(TRACK_PALETTE).size).toBe(96)
    for (const c of TRACK_PALETTE) expect(c).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('contains the legacy demo/instrument colors exactly', () => {
    for (const c of LEGACY) expect(TRACK_PALETTE).toContain(c)
  })

  it('keeps hues ordered within a row and rows ordered light to dark', () => {
    for (let row = 0; row < PALETTE_ROWS; row++) {
      for (let i = 1; i < PALETTE_COLUMNS; i++) {
        const [h] = rgbToHsl(hexToRgb(paletteSlot(row, i))!)
        expect(Math.abs(h - i * 15)).toBeLessThan(8)
      }
    }
    const lightness = (row: number) => rgbToHsl(hexToRgb(paletteSlot(row, 8))!)[2]
    expect(lightness(0)).toBeGreaterThan(lightness(1))
    expect(lightness(1)).toBeGreaterThan(lightness(2))
    expect(lightness(2)).toBeGreaterThan(lightness(3))
  })

  it('never goes neon', () => {
    for (const c of TRACK_PALETTE) expect(rgbToHsl(hexToRgb(c)!)[1]).toBeLessThanOrEqual(.72)
  })
})

describe('defaults and lookup', () => {
  it('uses second-row blue for audio and green for instruments', () => {
    expect(defaultTrackColor('audio')).toBe(paletteSlot(1, 14))
    expect(defaultTrackColor('audio')).toBe('#6f9fd0')
    expect(defaultTrackColor('instrument')).toBe(paletteSlot(1, 8))
    expect(defaultTrackColor('instrument', 'drums')).toBe(paletteSlot(1, 8))
    expect(rgbToHsl(hexToRgb(defaultTrackColor('instrument'))!)[0]).toBe(120)
  })

  it('finds exact members regardless of case or short form', () => {
    expect(paletteIndex('#6F9FD0')).toBe(24 + 14)
    expect(paletteIndex(TRACK_PALETTE[95])).toBe(95)
    expect(paletteIndex('#000000')).toBe(-1)
    expect(paletteIndex('nope')).toBe(-1)
  })

  it('maps legacy or arbitrary colors to the nearest palette entry', () => {
    for (const c of LEGACY) expect(nearestPaletteColor(c)).toBe(c)
    expect(nearestPaletteColor('#E38457')).toBe('#e38457')
    expect(nearestPaletteColor('#6f9fd1')).toBe('#6f9fd0')
    expect(TRACK_PALETTE).toContain(nearestPaletteColor('#123456'))
    expect(nearestPaletteColor('#fff')).toBe(nearestPaletteColor('#ffffff'))
    expect(nearestPaletteColor('garbage')).toBe(defaultTrackColor('instrument'))
  })
})

describe('color math', () => {
  it('converts hsl to hex and back', () => {
    expect(hslToHex(0, 1, .5)).toBe('#ff0000')
    expect(hslToHex(120, 1, .5)).toBe('#00ff00')
    expect(hslToHex(240, 1, .5)).toBe('#0000ff')
    expect(hslToHex(0, 0, .5)).toBe('#808080')
    expect(hslToHex(-120, 1, .5)).toBe('#0000ff')
    const [h, s, l] = rgbToHsl(hexToRgb(hslToHex(210, .58, .62))!)
    expect(h).toBeCloseTo(210, 0)
    expect(s).toBeCloseTo(.58, 1)
    expect(l).toBeCloseTo(.62, 1)
    expect(rgbToHsl([128, 128, 128])).toEqual([0, 0, 128 / 255])
  })

  it('parses hex forms', () => {
    expect(hexToRgb('#abc')).toEqual([170, 187, 204])
    expect(hexToRgb('ABCDEF')).toEqual([171, 205, 239])
    expect(hexToRgb('#12345')).toBeNull()
    expect(hexToRgb('red')).toBeNull()
  })
})

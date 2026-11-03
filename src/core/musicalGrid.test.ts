import { describe, expect, it } from 'vitest'
import { musicalGrid, musicalGridStyle, musicalRulerMarks, musicalSpan } from './musicalGrid'

describe('zoom-adaptive musical grids', () => {
  it('reveals finer binary divisions as time zoom grows without dense hairlines when zoomed out', () => {
    expect([4, 12, 30, 80, 200].map(ppb => musicalGrid(ppb).stepBeats)).toEqual([4, 1, .5, .125, .0625])
    for (const ppb of [4, 12, 30, 80, 200]) expect(musicalGrid(ppb).stepBeats * ppb).toBeGreaterThanOrEqual(10)
  })
  it('keeps triplet lines in thirds and sixths while retaining bar and beat hierarchy', () => {
    const grid = musicalGrid(120, { snap: 1 / 6 })
    for (const snap of [2 / 3, 1 / 3, 1 / 6]) expect(musicalGrid(120, { snap }).subdivisionBeats).toBeCloseTo(1 / 12)
    expect(grid.subdivisionBeats).toBeCloseTo(1 / 12)
    const marks = musicalRulerMarks(grid, 0, 4)
    expect(marks.find(mark => Math.abs(mark.beat - 1 / 3) < 1e-7)?.kind).toBe('subdivision')
    expect(marks.find(mark => mark.beat === 1)?.kind).toBe('beat')
    expect(marks.find(mark => mark.beat === 4)?.kind).toBe('bar')
    expect(musicalGridStyle(grid).backgroundSize).toBe('480px 100%,120px 100%,10px 100%')
  })
  it('renders only the visible interval and bounds even adversarial long ranges', () => {
    const grid = musicalGrid(200)
    const marks = musicalRulerMarks(grid, 1024, 1032)
    expect(marks[0].beat).toBe(1024)
    expect(marks.at(-1)?.beat).toBe(1032)
    expect(marks.length).toBeLessThan(150)
    expect(musicalRulerMarks(grid, 0, 1_000_000).length).toBeLessThanOrEqual(512)
    expect(musicalRulerMarks(grid, 0, Infinity)).toEqual([])
  })
  it('uses exactly the same pixel boundary for adjoining regions and notes including triplets', () => {
    for (const ppb of [4, 30, 83.75, 240]) {
      const a = musicalSpan(1 / 3, 2 / 3, ppb), b = musicalSpan(1, .25, ppb)
      expect(a.left + a.width).toBe(b.left)
      expect(b.width).toBeCloseTo(.25 * ppb)
    }
  })
})

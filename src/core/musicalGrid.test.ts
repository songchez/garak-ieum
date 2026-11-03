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
  it('labels three quarter beats in 3/4 and six eighth beats in 6/8 within the same duration', () => {
    const quarterMeter = musicalGrid(120, { beatsPerBar: 3, beatUnit: 1 })
    const eighthMeter = musicalGrid(120, { beatsPerBar: 3, beatUnit: .5 })
    const quarterMarks = musicalRulerMarks(quarterMeter, 0, 3).filter(mark => mark.kind !== 'subdivision')
    const eighthMarks = musicalRulerMarks(eighthMeter, 0, 3).filter(mark => mark.kind !== 'subdivision')
    expect(quarterMarks.map(mark => [mark.beat, mark.label])).toEqual([[0, '1'], [1, '1.2'], [2, '1.3'], [3, '2']])
    expect(eighthMarks.map(mark => [mark.beat, mark.label])).toEqual([[0, '1'], [.5, '1.2'], [1, '1.3'], [1.5, '1.4'], [2, '1.5'], [2.5, '1.6'], [3, '2']])
    expect(musicalGridStyle(eighthMeter).backgroundSize).toBe('360px 100%,60px 100%,15px 100%')
  })
  it('keeps fractional bar boundaries and denominator beats aligned in 7/8 and 5/16', () => {
    const eighthMarks = musicalRulerMarks(musicalGrid(120, { beatsPerBar: 3.5, beatUnit: .5 }), 0, 7)
    expect(eighthMarks.filter(mark => mark.kind === 'bar').map(mark => [mark.beat, mark.label])).toEqual([[0, '1'], [3.5, '2'], [7, '3']])
    expect(eighthMarks.find(mark => mark.beat === 3)?.label).toBe('1.7')
    const sixteenthMarks = musicalRulerMarks(musicalGrid(240, { beatsPerBar: 1.25, beatUnit: .25 }), 0, 2.5)
    expect(sixteenthMarks.find(mark => mark.beat === 1)?.label).toBe('1.5')
    expect(sixteenthMarks.filter(mark => mark.kind === 'bar').map(mark => mark.beat)).toEqual([0, 1.25, 2.5])
  })
  it('counts half-note beats in 2/2 without changing the internal quarter-note positions', () => {
    const marks = musicalRulerMarks(musicalGrid(120, { beatsPerBar: 4, beatUnit: 2 }), 0, 4)
    expect(marks.find(mark => mark.beat === 1)?.kind).toBe('subdivision')
    expect(marks.find(mark => mark.beat === 2)).toEqual({ beat: 2, kind: 'beat', label: '1.2' })
    expect(marks.find(mark => mark.beat === 4)).toEqual({ beat: 4, kind: 'bar', label: '2' })
  })
  it('coarsens a dense odd-meter triplet ruler at bar boundaries instead of losing them', () => {
    const marks = musicalRulerMarks(musicalGrid(120, { snap: 1 / 6, beatsPerBar: 3.5, beatUnit: .5 }), 0, 60, 24)
    expect(marks.length).toBeLessThanOrEqual(24)
    expect(marks.length).toBeGreaterThan(10)
    expect(marks.every(mark => mark.kind === 'bar')).toBe(true)
    expect(marks.slice(0, 3).map(mark => [mark.beat, mark.label])).toEqual([[0, '1'], [3.5, '2'], [7, '3']])
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

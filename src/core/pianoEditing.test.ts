import { describe, expect, it } from 'vitest'
import { snapDragDelta } from './input'
import { snapToEdges } from './edgeSnap'
import { musicalGrid } from './musicalGrid'
import { editNoteTiming, noteTimingBounds, pianoNoteStart, MIN_PIANO_NOTE_LENGTH } from './pianoEditing'
import type { MidiNote } from './types'

const note = (id = 'note', start = .03, duration = 1): MidiNote => ({ id, start, duration, pitch: 60, velocity: .8 })

describe('piano pointer timing and keyboard grid steps', () => {
  it('creates at a fractional beat by default and honours explicitly selected straight/triplet grids', () => {
    expect(pianoNoteStart(1.137, 4)).toBe(1.137)
    expect(pianoNoteStart(1.137, 4, .25)).toBe(1)
    expect(pianoNoteStart(.81, 4, 1 / 3)).toBeCloseTo(2 / 3)
    expect(pianoNoteStart(8, 4)).toBe(4 - MIN_PIANO_NOTE_LENGTH)
  })

  it('moves and resizes at fractional pointer positions without grid or nearby-edge attraction in free mode', () => {
    const original = [note()], ppb = 200, rawDelta = 13.7 / ppb
    const gridDelta = snapDragDelta(rawDelta, 0)
    const { delta, guide } = snapToEdges({ rawDelta, gridDelta, movingEdges: [.03, 1.03], targetEdges: [1.1], ppb, enabled: false })
    expect(delta).toBe(rawDelta)
    expect(guide).toBeNull()
    const moved = editNoteTiming(original, delta, 4, 'move')[0]
    const right = editNoteTiming(original, delta, 4, 'resize')[0]
    const left = editNoteTiming(original, delta, 4, 'resize-left')[0]
    expect(moved.start).toBeCloseTo(.0985)
    expect(right.duration).toBeCloseTo(1.0685)
    expect(left.start).toBeCloseTo(.0985)
    expect(left.start + left.duration).toBeCloseTo(1.03)
    expect(original[0]).toEqual(note())
  })

  it('nudges one visible subdivision at every zoom without quantizing an off-grid starting position', () => {
    for (const [ppb, expected] of [[30, .5], [80, .125], [200, .0625]]) {
      const grid = musicalGrid(ppb)
      const next = editNoteTiming([note()], grid.stepBeats, 4, 'move')[0]
      expect(next.start - .03).toBeCloseTo(expected)
      expect(next.start).toBeCloseTo(.03 + grid.stepBeats)
    }
    // Even an explicit coarse mouse snap does not replace the finer visible keyboard step.
    const grid = musicalGrid(200, { snap: .5 })
    expect(editNoteTiming([note()], grid.stepBeats, 4, 'move')[0].start).toBeCloseTo(.0925)
  })

  it('moves a selection by one common bounded delta and makes an empty selection a no-op', () => {
    const original = [note('first', .03, .5), note('last', 3.48, .5)]
    const right = editNoteTiming(original, .0625, 4, 'move')
    expect(right[1].start + right[1].duration).toBe(4)
    expect(right[0].start).toBeCloseTo(.05)
    expect(right[1].start - right[0].start).toBeCloseTo(3.45)
    const left = editNoteTiming(original, -.0625, 4, 'move')
    expect(left[0].start).toBe(0)
    expect(left[1].start - left[0].start).toBeCloseTo(3.45)
    expect(editNoteTiming([], .0625, 4, 'move')).toEqual([])
  })

  it('uses the same bounds for both resize edges without collapsing short notes or separating the group', () => {
    const original = [note('first', .2, .1), note('second', 1, .5)]
    const bounds = noteTimingBounds(original, 4, 'resize-left')
    expect(bounds.maxDelta).toBeCloseTo(.1 - MIN_PIANO_NOTE_LENGTH)
    const resized = editNoteTiming(original, .2, 4, 'resize-left')
    expect(resized[0].duration).toBeCloseTo(MIN_PIANO_NOTE_LENGTH)
    expect(resized[1].start - resized[0].start).toBeCloseTo(.8)
    expect(resized[1].start + resized[1].duration).toBeCloseTo(1.5)
  })
})

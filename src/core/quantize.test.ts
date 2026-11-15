import { describe, expect, it } from 'vitest'
import { gridTarget, quantizeNotes, quantizePosition } from './quantize'
import { playbackNotes } from './playback'
import { createTrack } from './project'
import type { MidiClip, MidiNote } from './types'

const note = (start: number, duration = 0.5, id = `n${start}`): MidiNote => ({ id, pitch: 60, start, duration, velocity: 0.8 })

describe('quantize math', () => {
  it('moves strength % of the way to the nearest line', () => {
    expect(quantizePosition(1.1, 0.25)).toBeCloseTo(1)
    expect(quantizePosition(1.1, 0.25, 50, 50)).toBeCloseTo(1.05)
    expect(quantizePosition(1.1, 0.25, 50, 0)).toBeCloseTo(1.1)
    expect(quantizePosition(1.1, 0, 50, 100)).toBe(1.1)
  })
  it('swing delays odd grid lines', () => {
    expect(gridTarget(0.5, 0.5, 50)).toBeCloseTo(0.5)
    expect(gridTarget(0.5, 0.5, 75)).toBeCloseTo(0.75)
    expect(gridTarget(1, 0.5, 75)).toBeCloseTo(1)
  })
})

describe('quantizeNotes (piano roll popover)', () => {
  it('starts only keep the length; ends move the end to its own line', () => {
    const close = (n: MidiNote, start: number, duration: number) => { expect(n.start).toBeCloseTo(start); expect(n.duration).toBeCloseTo(duration) }
    close(quantizeNotes([note(1.1, 0.4)], { grid: 0.25 }, 8)[0], 1, 0.4)
    close(quantizeNotes([note(1.1, 0.4)], { grid: 0.25, ends: true }, 8)[0], 1, 0.5)
    close(quantizeNotes([note(1.1, 0.4)], { grid: 0.25, starts: false, ends: true }, 8)[0], 1.1, 0.4)
  })
  it('half strength, untargeted notes untouched, stays inside the region', () => {
    const notes = [note(1.1, 0.5, 'a'), note(2.1, 0.5, 'b'), note(7.99, 0.5, 'c')]
    const result = quantizeNotes(notes, { grid: 0.25, strength: 50 }, 8, new Set(['a', 'c']))
    expect(result[0].start).toBeCloseTo(1.05)
    expect(result[1]).toBe(notes[1])
    expect(result[2].start).toBeLessThan(8)
  })
  it('never collapses a note when its ends meet on one line', () => {
    const [q] = quantizeNotes([note(1.0, 0.05)], { grid: 0.25, ends: true }, 8)
    expect(q.duration).toBeGreaterThan(0)
  })
})

describe('region Q-강도 in playback (both engines read playbackNotes)', () => {
  it('scales the non-destructive quantize', () => {
    const track = createTrack('instrument')
    const clip: MidiClip = { id: 'c', kind: 'midi', name: 'x', startBeat: 0, lengthBeats: 4, gain: 1, quantize: 0.5, notes: [note(1.2)] }
    const at = (qStrength?: number) => playbackNotes(track, { ...clip, ...(qStrength === undefined ? {} : { qStrength }) }, { start: 0, end: 4, index: 0 })[0].start
    expect(at()).toBeCloseTo(1)
    expect(at(100)).toBeCloseTo(1)
    expect(at(50)).toBeCloseTo(1.1)
    expect(at(0)).toBeCloseTo(1.2)
  })
})

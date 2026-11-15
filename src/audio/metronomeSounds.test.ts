import { describe, expect, it } from 'vitest'
import { METRONOME_SOUNDS, type MetronomeLevel } from '../core/metronome'
import { metronomeStroke, metronomeStrokes } from './metronomeSounds'

const peak = (data: Float32Array) => data.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
const onset = (data: Float32Array) => data.findIndex(value => Math.abs(value) > 0.01)

describe('procedural metronome strokes', () => {
  for (const { id } of METRONOME_SOUNDS) {
    it(`${id}: short, finite, sounding on its first frames, accent strongest`, () => {
      const strokes = ([0, 1, 2] as MetronomeLevel[]).map(level => metronomeStroke(id, level, 48000))
      for (const stroke of strokes) {
        expect(stroke.every(Number.isFinite)).toBe(true)
        expect(stroke.length).toBeLessThanOrEqual(48000 * 0.6)
        expect(peak(stroke)).toBeLessThanOrEqual(0.9)
        expect(peak(stroke)).toBeGreaterThan(0.15)
        // The transient lands on the beat: within 1.5 ms of the scheduled frame.
        expect(onset(stroke)).toBeLessThan(72)
        expect(Math.abs(stroke[stroke.length - 1])).toBeLessThan(1e-3)
      }
      expect(peak(strokes[0])).toBeGreaterThanOrEqual(peak(strokes[2]))
    })
  }

  it('is deterministic and rate aware', () => {
    expect(metronomeStroke('bak', 0, 44100)).toEqual(metronomeStroke('bak', 0, 44100))
    expect(metronomeStroke('moktak', 2, 96000).length).toBe(2 * metronomeStroke('moktak', 2, 48000).length)
  })

  it('uses the plain stroke everywhere without accent', () => {
    const [a, b, c] = metronomeStrokes('janggu', false, 48000)
    expect(a).toBe(c)
    expect(b).toBe(c)
  })
})

import { describe, expect, it } from 'vitest'
import { parseRecordingOffset, recordingPlacement } from './recordingOffset'

describe('manual recording alignment', () => {
  it('accepts completed signed input without treating partial or out-of-range text as zero', () => {
    expect(parseRecordingOffset('-100')).toBe(-100)
    expect(parseRecordingOffset('+125')).toBe(125)
    expect(parseRecordingOffset(' 0 ')).toBe(0)
    for (const value of ['', '-', '+', '1001', '-1001', '1.5', 'NaN']) expect(parseRecordingOffset(value)).toBeNull()
  })
  it('keeps an uncorrected recording at its original beat and length', () => {
    expect(recordingPlacement(8, 120, 3, 0)).toEqual({ startBeat: 8, lengthBeats: 6, offsetSeconds: 0 })
  })
  it('moves positive correction later and negative correction earlier', () => {
    expect(recordingPlacement(8, 120, 3, 125)).toEqual({ startBeat: 8.25, lengthBeats: 6, offsetSeconds: 0 })
    expect(recordingPlacement(8, 120, 3, -125)).toEqual({ startBeat: 7.75, lengthBeats: 6, offsetSeconds: 0 })
  })
  it('crops the source when moving across zero instead of delaying its remaining content', () => {
    expect(recordingPlacement(.25, 120, 2, -500)).toEqual({ startBeat: 0, lengthBeats: 3.25, offsetSeconds: .375 })
  })
  it('does not create an empty region when correction moves the entire recording before zero', () => {
    expect(recordingPlacement(0, 120, .25, -500)).toBeNull()
  })
  it('trims native latency pre-roll and applies the manual adjustment exactly once', () => {
    // At 120 BPM, a -960 frame correction at 48 kHz is -0.04 beats.
    expect(recordingPlacement(-.04, 120, 1, 0)).toEqual({ startBeat: 0, lengthBeats: 1.96, offsetSeconds: .02 })
    expect(recordingPlacement(-.04, 120, 1, 10)).toEqual({ startBeat: 0, lengthBeats: 1.98, offsetSeconds: .01 })
    expect(recordingPlacement(-.04, 120, .01, 0)).toBeNull()
    expect(recordingPlacement(-.04, 120, 1, 30)!.startBeat).toBeCloseTo(.02)
  })
  it('uses project tempo and rejects invalid recording dimensions', () => {
    expect(recordingPlacement(4, 60, 1.5, 500)).toEqual({ startBeat: 4.5, lengthBeats: 1.5, offsetSeconds: 0 })
    expect(() => recordingPlacement(0, 0, 1, 0)).toThrow()
    expect(() => recordingPlacement(0, 120, 1, NaN)).toThrow()
  })
})

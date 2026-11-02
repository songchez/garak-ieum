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
  it('uses project tempo and rejects invalid recording dimensions', () => {
    expect(recordingPlacement(4, 60, 1.5, 500)).toEqual({ startBeat: 4.5, lengthBeats: 1.5, offsetSeconds: 0 })
    expect(() => recordingPlacement(0, 0, 1, 0)).toThrow()
    expect(() => recordingPlacement(0, 120, 1, NaN)).toThrow()
  })
})

import { describe, expect, it } from 'vitest'
import { waveformColumns } from './waveform'

describe('waveform source windows', () => {
  const peaks = [.1, .2, .3, .4, .5, .6, .7, .8]
  it('shows only the trimmed source interval, including a split right half', () => {
    expect(waveformColumns(peaks, 4, { sourceDuration: 8, offsetSeconds: 2, durationSeconds: 4 })).toEqual([.3, .4, .5, .6])
    expect(waveformColumns(peaks, 4, { sourceDuration: 8, offsetSeconds: 4, durationSeconds: 4 })).toEqual([.5, .6, .7, .8])
  })
  it('keeps the original time scale when a region extends beyond the source', () => {
    expect(waveformColumns(peaks, 4, { sourceDuration: 8, offsetSeconds: 6, durationSeconds: 4 })).toEqual([.7, .8, 0, 0])
    expect(waveformColumns(peaks, 3, { sourceDuration: 8, offsetSeconds: 8, durationSeconds: 2 })).toEqual([0, 0, 0])
  })
  it('restores the overview when the start is expanded again and crops partial repeats', () => {
    expect(waveformColumns(peaks, 8, { sourceDuration: 8, durationSeconds: 8 })).toEqual(peaks)
    expect(waveformColumns(peaks, 2, { sourceDuration: 8, offsetSeconds: 2, durationSeconds: 2 })).toEqual([.3, .4])
  })
  it('uses actual stereo samples at close zoom without showing a transient before the trim', () => {
    const left = new Float32Array(80), right = new Float32Array(80)
    left[19] = 1 // belongs to the source before the visible window
    right[22] = .5
    expect(waveformColumns([1, .2], 4, { sourceDuration: 8, offsetSeconds: 2, durationSeconds: 1 }, { sampleRate: 10, channels: [left, right] })).toEqual([.5, .5, 0, 0])
  })
  it('handles empty, silent and invalid ranges without stretching or unbounded allocation', () => {
    expect(waveformColumns([], 3)).toEqual([0, 0, 0])
    expect(waveformColumns(peaks, 3, { sourceDuration: 8, durationSeconds: 0 })).toEqual([0, 0, 0])
    expect(waveformColumns([NaN, 2, -.5], 3)).toEqual([0, 1, 0])
    expect(waveformColumns(peaks, Number.MAX_SAFE_INTEGER)).toHaveLength(4096)
  })
})

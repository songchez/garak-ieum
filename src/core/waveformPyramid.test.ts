import { describe, expect, it } from 'vitest'
import { buildWaveformPyramid, pyramidBytes, pyramidMax, pyramidPeak } from './waveformPyramid'
import { waveformColumns, waveformNeedsSamples } from './waveform'

/** Deterministic noise with a few sharp peaks. */
function signal(frames: number, seed: number): Float32Array {
  const out = new Float32Array(frames)
  let state = seed
  for (let i = 0; i < frames; i++) {
    state = (state * 1103515245 + 12345) >>> 0
    out[i] = ((state / 2 ** 32) * 2 - 1) * (i % 997 === 0 ? 1 : .4)
  }
  return out
}

const exactPeak = (channels: Float32Array[], first: number, last: number) => {
  let peak = 0
  for (const channel of channels) for (let i = Math.max(0, first); i < Math.min(channel.length, last); i++) peak = Math.max(peak, Math.abs(channel[i]))
  return peak
}

describe('waveform pyramid', () => {
  const channels = [signal(100_003, 1), signal(100_003, 7)]
  const pyramid = buildWaveformPyramid(channels, 48000)

  it('stores the exact block maxima over every channel, coarsening by the factor up to one block', () => {
    expect(pyramid.frames).toBe(100_003)
    expect(pyramid.levels[0]).toHaveLength(Math.ceil(100_003 / pyramid.base))
    for (const block of [0, 1, 1234, pyramid.levels[0].length - 1])
      expect(pyramid.levels[0][block]).toBe(Math.fround(exactPeak(channels, block * pyramid.base, (block + 1) * pyramid.base)))
    for (let level = 1; level < pyramid.levels.length; level++)
      expect(pyramid.levels[level]).toHaveLength(Math.ceil(pyramid.levels[level - 1].length / pyramid.factor))
    expect(pyramid.levels.at(-1)).toHaveLength(1)
    expect(pyramidMax(pyramid)).toBe(Math.fround(exactPeak(channels, 0, 100_003)))
  })

  it('answers a block-aligned range exactly, at any length and position', () => {
    const { base } = pyramid
    for (const [first, last] of [[0, base], [base * 3, base * 900], [base * 5, base * 3125], [0, 100_003], [base * 3000, 100_003]])
      expect(pyramidPeak(pyramid, first, last)).toBe(Math.fround(exactPeak(channels, first, last)))
  })

  it('covers an unaligned range with its whole first and last blocks', () => {
    const { base } = pyramid
    for (const [first, last] of [[5, 77], [1000, 54_321], [99_000, 100_003], [31, 33]]) {
      const outer = exactPeak(channels, Math.floor(first / base) * base, Math.ceil(last / base) * base)
      expect(pyramidPeak(pyramid, first, last)).toBe(Math.fround(outer))
      expect(pyramidPeak(pyramid, first, last)).toBeGreaterThanOrEqual(Math.fround(exactPeak(channels, first, last)))
    }
    expect(pyramidPeak(pyramid, 200_000, 300_000)).toBe(0)
    expect(pyramidPeak(pyramid, 50, 50)).toBe(0)
  })

  it('keeps about 1/24 of a mono signal (1/48 of stereo) in memory', () => {
    const pcm = channels.length * 100_003 * 4
    expect(pyramidBytes(pyramid)).toBeLessThan(pcm / 40)
  })

  it('handles empty and single-block sources', () => {
    expect(pyramidMax(buildWaveformPyramid([], 48000))).toBe(0)
    const tiny = buildWaveformPyramid([Float32Array.from([.1, -.6, .2])], 48000)
    expect(tiny.levels).toHaveLength(1)
    expect(pyramidPeak(tiny, 0, 3)).toBe(Math.fround(.6))
  })
})

describe('waveform columns from a pyramid', () => {
  const sampleRate = 48000, frames = 480_000
  const channels = [signal(frames, 3)]
  const pyramid = buildWaveformPyramid(channels, sampleRate)
  const peaks = Array.from({ length: 320 }, () => 0.01)
  const range = { sourceDuration: frames / sampleRate, offsetSeconds: 2, durationSeconds: 1 }

  it('draws close zoom from the pyramid, matching the samples wherever a column covers whole blocks', () => {
    const fromSamples = waveformColumns(peaks, 600, range, { sampleRate, channels })
    const fromPyramid = waveformColumns(peaks, 600, range, undefined, pyramid)
    // 80 frames per column: each column is read from whole blocks plus at most one block of its neighbours.
    let equal = 0
    fromPyramid.forEach((value, i) => { expect(value).toBeGreaterThanOrEqual(fromSamples[i]); if (Math.abs(value - fromSamples[i]) < 1e-7) equal++ })
    expect(equal / fromPyramid.length).toBeGreaterThan(.6)
  })

  it('is exact at block-aligned columns', () => {
    // 1 s from 1 s over 300 columns: 160 frames (5 blocks) per column, starting on a block boundary.
    const aligned = { sourceDuration: frames / sampleRate, offsetSeconds: 1, durationSeconds: 1 }
    const expected = Array.from({ length: 300 }, (_, column) => Math.fround(exactPeak(channels, 48000 + column * 160, 48000 + (column + 1) * 160)))
    expect(waveformColumns(peaks, 300, aligned, undefined, pyramid).map(v => Math.fround(v))).toEqual(expected)
  })

  it('keeps the overview when a column is no finer than it, and asks for samples only below one block per column', () => {
    const whole = { sourceDuration: frames / sampleRate }
    expect(waveformColumns(peaks, 100, whole, undefined, pyramid)).toEqual(waveformColumns(peaks, 100, whole))
    expect(waveformNeedsSamples(600, range, pyramid)).toBe(false)
    expect(waveformNeedsSamples(600, { ...range, durationSeconds: .2 }, pyramid)).toBe(true)
    expect(waveformNeedsSamples(600, { sourceDuration: 3600, offsetSeconds: 0, durationSeconds: 3600 }, pyramid)).toBe(false)
  })
})

import { pyramidPeak, type WaveformPyramid } from './waveformPyramid'

/** A waveform uses the same source window as playback; empty source tails stay empty. */
export interface WaveformRange {
  sourceDuration: number
  offsetSeconds?: number
  durationSeconds?: number
}

export interface WaveformSamples {
  sampleRate: number
  channels: readonly Float32Array[]
}

const finite = (value: number | undefined, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
const MAX_COLUMNS = 4096
// At close zoom read the actual samples instead of magnifying the coarse overview.
// A long overview continues to use the cached peaks, keeping redraws bounded.
const MAX_DETAIL_FRAMES = 2_000_000

/** Frames one column spans; a pyramid draws it exactly once a column covers a level-0 block. */
export function waveformColumnFrames(columns: number, range: WaveformRange, sampleRate: number): number {
  const count = Math.min(MAX_COLUMNS, Math.max(1, Math.floor(finite(columns, 1))))
  return Math.max(0, finite(range.durationSeconds, range.sourceDuration)) / count * sampleRate
}

/**
 * Samples help only at close zoom: a column narrower than the pyramid's finest block, over a window
 * small enough to read sample by sample (the Waveform then loads the asset's PCM on demand).
 */
export function waveformNeedsSamples(columns: number, range: WaveformRange, pyramid: WaveformPyramid): boolean {
  const offset = Math.max(0, finite(range.offsetSeconds, 0))
  const visible = Math.min(Math.max(0, finite(range.durationSeconds, range.sourceDuration)), Math.max(0, finite(range.sourceDuration, 0) - offset))
  return visible > 0 && waveformColumnFrames(columns, range, pyramid.sampleRate) < pyramid.base
    && visible * pyramid.sampleRate <= MAX_DETAIL_FRAMES
}

/**
 * Bar heights of `columns` columns. Finer than the overview `peaks`, a column reads `samples` when given
 * (exact), else the `pyramid` (exact over its level-0 blocks).
 */
export function waveformColumns(peaks: readonly number[], columns: number, range: WaveformRange = { sourceDuration: 1 }, samples?: WaveformSamples, pyramid?: WaveformPyramid): number[] {
  const count = Math.min(MAX_COLUMNS, Math.max(1, Math.floor(finite(columns, 1))))
  const sourceDuration = Math.max(0, finite(range.sourceDuration, 0))
  const offset = Math.max(0, finite(range.offsetSeconds, 0))
  const duration = Math.max(0, finite(range.durationSeconds, sourceDuration))
  const result = new Array<number>(count).fill(0)
  if (!sourceDuration || !duration || offset >= sourceDuration) return result
  const visibleDuration = Math.min(duration, sourceDuration - offset)
  const finer = duration / count < sourceDuration / Math.max(1, peaks.length)
  const detailed = finer && samples && samples.sampleRate > 0 && samples.channels.length > 0
    && visibleDuration * samples.sampleRate * samples.channels.length <= MAX_DETAIL_FRAMES
  const pyramidal = !detailed && finer && pyramid !== undefined && pyramid.sampleRate > 0 && pyramid.frames > 0

  for (let column = 0; column < count; column++) {
    const from = offset + column * duration / count
    const to = Math.min(sourceDuration, offset + (column + 1) * duration / count)
    if (from >= sourceDuration || to <= from) continue
    let peak = 0
    if (detailed) {
      const first = Math.max(0, Math.floor(from * samples.sampleRate))
      const last = Math.ceil(to * samples.sampleRate)
      for (const channel of samples.channels) {
        const end = Math.min(channel.length, last)
        for (let frame = first; frame < end; frame++) peak = Math.max(peak, Math.abs(channel[frame]))
      }
    } else if (pyramidal) {
      // A column edge a rounding error past a block boundary must not pull in the neighbouring block.
      peak = pyramidPeak(pyramid, Math.max(0, Math.floor(from * pyramid.sampleRate + 1e-6)), Math.ceil(to * pyramid.sampleRate - 1e-6))
    } else {
      const first = Math.floor(from / sourceDuration * peaks.length)
      const last = Math.min(peaks.length, Math.ceil(to / sourceDuration * peaks.length))
      for (let point = first; point < last; point++) peak = Math.max(peak, finite(peaks[point], 0))
    }
    result[column] = Math.min(1, Math.max(0, finite(peak, 0)))
  }
  return result
}

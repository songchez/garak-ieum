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

export function waveformColumns(peaks: readonly number[], columns: number, range: WaveformRange = { sourceDuration: 1 }, samples?: WaveformSamples): number[] {
  const count = Math.min(MAX_COLUMNS, Math.max(1, Math.floor(finite(columns, 1))))
  const sourceDuration = Math.max(0, finite(range.sourceDuration, 0))
  const offset = Math.max(0, finite(range.offsetSeconds, 0))
  const duration = Math.max(0, finite(range.durationSeconds, sourceDuration))
  const result = new Array<number>(count).fill(0)
  if (!sourceDuration || !duration || offset >= sourceDuration) return result
  const visibleDuration = Math.min(duration, sourceDuration - offset)
  const detailed = samples && samples.sampleRate > 0 && samples.channels.length > 0
    && duration / count < sourceDuration / Math.max(1, peaks.length)
    && visibleDuration * samples.sampleRate * samples.channels.length <= MAX_DETAIL_FRAMES

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
    } else {
      const first = Math.floor(from / sourceDuration * peaks.length)
      const last = Math.min(peaks.length, Math.ceil(to / sourceDuration * peaks.length))
      for (let point = first; point < last; point++) peak = Math.max(peak, finite(peaks[point], 0))
    }
    result[column] = Math.min(1, Math.max(0, finite(peak, 0)))
  }
  return result
}

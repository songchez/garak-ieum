/**
 * Multi-resolution peaks of an audio asset (docs/ARCHITECTURE.md "오디오 자산 메모리").
 *
 * Level 0 holds the exact largest absolute sample over every channel in each block of
 * `PYRAMID_BASE` frames; each next level holds the largest of `PYRAMID_FACTOR` blocks below it.
 * Drawing reads it instead of the PCM, so the main thread keeps about 1/24 of a mono float32
 * signal (1/48 of stereo) per asset instead of every sample.
 */
export interface WaveformPyramid {
  readonly sampleRate: number
  /** Frames of the source. */
  readonly frames: number
  /** Frames per level-0 block. */
  readonly base: number
  /** Level-k blocks per level-(k+1) block. */
  readonly factor: number
  /** levels[0] is the finest; the last level has a single block. */
  readonly levels: readonly Float32Array[]
}

export const PYRAMID_BASE = 32
export const PYRAMID_FACTOR = 4

/** Builds the pyramid in one pass over the channels. */
export function buildWaveformPyramid(channels: readonly Float32Array[], sampleRate: number, base = PYRAMID_BASE, factor = PYRAMID_FACTOR): WaveformPyramid {
  const frames = channels.reduce((longest, channel) => Math.max(longest, channel.length), 0)
  const level0 = new Float32Array(Math.max(1, Math.ceil(frames / base)))
  for (const channel of channels) {
    for (let block = 0, start = 0; start < channel.length; block++, start += base) {
      const end = Math.min(channel.length, start + base)
      let peak = level0[block]
      for (let frame = start; frame < end; frame++) {
        const value = channel[frame]
        const magnitude = value < 0 ? -value : value
        if (magnitude > peak) peak = magnitude
      }
      level0[block] = peak
    }
  }
  const levels: Float32Array[] = [level0]
  while (levels[levels.length - 1].length > 1) {
    const below = levels[levels.length - 1]
    const above = new Float32Array(Math.ceil(below.length / factor))
    for (let index = 0; index < below.length; index++) {
      const parent = Math.floor(index / factor)
      if (below[index] > above[parent]) above[parent] = below[index]
    }
    levels.push(above)
  }
  return { sampleRate, frames, base, factor, levels }
}

/**
 * Largest absolute sample over frames [first, last). Exact over whole level-0 blocks: a range that does
 * not start or end on a block boundary also covers the rest of its first and last block.
 */
export function pyramidPeak(pyramid: WaveformPyramid, first: number, last: number): number {
  const { base, factor, levels } = pyramid
  if (!(last > first)) return 0
  let low = Math.max(0, Math.floor(first / base))
  let high = Math.min(levels[0].length, Math.ceil(Math.min(last, pyramid.frames) / base))
  let peak = 0
  // Climb while both ends sit on parent boundaries; read the unaligned blocks at each level.
  for (let level = 0; level < levels.length && low < high; level++) {
    const values = levels[level]
    if (level === levels.length - 1 || high - low <= factor) {
      for (let index = low; index < high; index++) if (values[index] > peak) peak = values[index]
      break
    }
    while (low < high && low % factor) { if (values[low] > peak) peak = values[low]; low++ }
    while (low < high && high % factor) { high--; if (values[high] > peak) peak = values[high] }
    low /= factor; high /= factor
  }
  return peak
}

/** Largest absolute sample of the whole source (exact). */
export function pyramidMax(pyramid: WaveformPyramid): number {
  return pyramid.levels[pyramid.levels.length - 1][0] ?? 0
}

/** Bytes the pyramid's levels hold. */
export function pyramidBytes(pyramid: WaveformPyramid): number {
  return pyramid.levels.reduce((sum, level) => sum + level.byteLength, 0)
}

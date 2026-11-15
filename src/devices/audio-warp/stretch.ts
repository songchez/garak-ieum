import createSignalsmith from '../pitch-editor/vendor/signalsmith-core.mjs'
import { validateStretchJob, WARP_RENDER_LIMITS } from './limits'

export { validateStretchJob, WARP_RENDER_LIMITS }

/**
 * Pitch-preserving offline time stretch with the vendored Signalsmith Stretch core.
 * Output length is round(input × ratio). The stream is aligned by the stretcher's
 * latency (input latency × ratio + output latency) and its tail is flushed with zeros.
 * Inputs are never mutated.
 */
export async function stretchPcm(channels: readonly Float32Array[], sampleRate: number, ratio: number, onProgress?: (fraction: number) => void): Promise<Float32Array[]> {
  const frames = validateStretchJob(channels, sampleRate, ratio)
  for (const channel of channels) for (let i = 0; i < channel.length; i += 1) if (!Number.isFinite(channel[i])) throw new Error('워프할 오디오에 유효하지 않은 샘플이 있습니다.')
  const outputFrames = Math.round(frames * ratio)
  onProgress?.(0)
  if (Math.abs(ratio - 1) < 1e-9) { onProgress?.(1); return channels.map(channel => channel.slice()) }
  // One module per job: the upstream C binding stores a single global stretcher.
  const module = await createSignalsmith()
  module._presetDefault(channels.length, sampleRate)
  module._reset()
  const blockSize = 1024
  const latency = Math.round(module._inputLatency() * ratio + module._outputLatency())
  const bufferFrames = Math.max(blockSize, Math.ceil(blockSize * ratio) + 1)
  const base = module._setBuffers(channels.length, bufferFrames) / Float32Array.BYTES_PER_ELEMENT
  const output = channels.map(() => new Float32Array(outputFrames))
  const needed = latency + outputFrames
  for (let position = 0; ; position += blockSize) {
    const outputStart = Math.round(position * ratio)
    if (outputStart >= needed) break
    const outputEnd = Math.round((position + blockSize) * ratio)
    const outputCount = outputEnd - outputStart
    let heap = new Float32Array(module.HEAP8.buffer)
    const available = Math.max(0, Math.min(blockSize, frames - position))
    for (let channel = 0; channel < channels.length; channel += 1) {
      const offset = base + bufferFrames * channel
      heap.fill(0, offset, offset + blockSize)
      if (available) heap.set(channels[channel].subarray(position, position + available), offset)
    }
    module._process(blockSize, outputCount)
    // Emscripten may grow memory during processing; never reuse an old view.
    heap = new Float32Array(module.HEAP8.buffer)
    for (let channel = 0; channel < channels.length; channel += 1) {
      const offset = base + bufferFrames * (channels.length + channel)
      const target = output[channel]
      for (let i = 0; i < outputCount; i += 1) {
        const index = outputStart + i - latency
        if (index < 0 || index >= outputFrames) continue
        const value = heap[offset + i]
        if (!Number.isFinite(value)) throw new Error('워프 렌더링 중 유효하지 않은 오디오가 생성되었습니다.')
        target[index] = value
      }
    }
    if (position % (blockSize * 32) === 0) onProgress?.(Math.min(1, outputStart / needed))
  }
  onProgress?.(1)
  return output
}

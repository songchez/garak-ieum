import createSignalsmith from '../pitch-editor/vendor/signalsmith-core.mjs'
import { validateRenderJob, validateStretchJob, WARP_RENDER_LIMITS, type PcmRenderJob } from './limits'
import { RESAMPLE_HALF_TAPS as HALF, RESAMPLE_PHASES as PHASES, resamplingKernel } from '../pitch-editor/render'

export { validateRenderJob, validateStretchJob, WARP_RENDER_LIMITS, type PcmRenderJob }

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

/**
 * Warp and region pitch in one offline pass: a neutral-pitch Signalsmith stretch (skipped
 * when stretch is 1 and no formant change is asked) streamed into a windowed-sinc resampler.
 * Output length is round(frames × stretch / pitch). Neutral stretching + exact resampling
 * avoids the spectral bin-mapping pitch error measured in the pitch editor (render.ts).
 * Memory stays bounded: the stretched signal only lives in a small ring buffer.
 */
export async function renderPcm(channels: readonly Float32Array[], sampleRate: number, job: PcmRenderJob, onProgress?: (fraction: number) => void): Promise<Float32Array[]> {
  const frames = validateRenderJob(channels, sampleRate, job)
  const { stretch, pitch, formantSemitones } = job
  if (Math.abs(pitch - 1) < 1e-12 && formantSemitones === null && stretch >= WARP_RENDER_LIMITS.minRatio && stretch <= WARP_RENDER_LIMITS.maxRatio) return stretchPcm(channels, sampleRate, stretch, onProgress)
  for (const channel of channels) for (let i = 0; i < channel.length; i += 1) if (!Number.isFinite(channel[i])) throw new Error('렌더할 오디오에 유효하지 않은 샘플이 있습니다.')
  const midFrames = Math.round(frames * stretch)
  const outFrames = Math.max(1, Math.round(frames * stretch / pitch))
  const channelCount = channels.length
  onProgress?.(0)
  const taps = HALF * 2
  const kernel = resamplingKernel(pitch)
  const blockSize = 1024
  const useStretch = Math.abs(stretch - 1) > 1e-9 || formantSemitones !== null
  const burst = useStretch ? Math.max(blockSize, Math.ceil(blockSize * stretch) + 1) : blockSize
  const ringFrames = 2 ** Math.ceil(Math.log2(burst + taps * 2 + 16))
  const mask = ringFrames - 1
  const ring = channels.map(() => new Float32Array(ringFrames))
  // Frame i of the stretched signal lives at ring[(i + HALF) & mask]; HALF leading zeros pad the start.
  let produced = 0
  const write = (index: number, channel: number, value: number) => { ring[channel][(index + HALF) & mask] = index < midFrames ? value : 0 }

  let produce: () => void
  if (!useStretch) {
    produce = () => {
      for (let i = 0; i < blockSize; i += 1, produced += 1) for (let c = 0; c < channelCount; c += 1) write(produced, c, produced < frames ? channels[c][produced] : 0)
    }
  } else {
    const module = await createSignalsmith()
    module._presetDefault(channelCount, sampleRate)
    module._reset()
    if (formantSemitones !== null) { module._setFormantSemitones(formantSemitones, false); module._setFormantBase(0) }
    const latency = Math.round(module._inputLatency() * stretch + module._outputLatency())
    const bufferFrames = burst
    const base = module._setBuffers(channelCount, bufferFrames) / Float32Array.BYTES_PER_ELEMENT
    let position = 0
    produce = () => {
      const outputStart = Math.round(position * stretch)
      const outputEnd = Math.round((position + blockSize) * stretch)
      const outputCount = outputEnd - outputStart
      let heap = new Float32Array(module.HEAP8.buffer)
      const available = Math.max(0, Math.min(blockSize, frames - position))
      for (let c = 0; c < channelCount; c += 1) {
        const offset = base + bufferFrames * c
        heap.fill(0, offset, offset + blockSize)
        if (available) heap.set(channels[c].subarray(position, position + available), offset)
      }
      module._process(blockSize, outputCount)
      heap = new Float32Array(module.HEAP8.buffer)
      for (let c = 0; c < channelCount; c += 1) {
        const offset = base + bufferFrames * (channelCount + c)
        for (let i = 0; i < outputCount; i += 1) {
          const index = outputStart + i - latency
          if (index < 0) continue
          const value = heap[offset + i]
          if (!Number.isFinite(value)) throw new Error('렌더링 중 유효하지 않은 오디오가 생성되었습니다.')
          write(index, c, value)
        }
      }
      produced = Math.max(produced, outputEnd - latency)
      position += blockSize
    }
  }

  const output = channels.map(() => new Float32Array(outFrames))
  for (let j = 0; j < outFrames; j += 1) {
    const t = j * pitch
    const center = Math.floor(t)
    const phase = Math.round((t - center) * PHASES)
    const first = center - HALF + 1
    while (produced <= first + taps - 1) produce()
    const kernelOffset = phase * taps
    for (let c = 0; c < channelCount; c += 1) {
      const data = ring[c]
      let value = 0
      for (let tap = 0; tap < taps; tap += 1) value += data[(first + tap + HALF) & mask] * kernel[kernelOffset + tap]
      if (!Number.isFinite(value)) throw new Error('렌더링 중 유효하지 않은 오디오가 생성되었습니다.')
      output[c][j] = value
    }
    if ((j & 16383) === 0) onProgress?.(j / outFrames)
  }
  onProgress?.(1)
  return output
}

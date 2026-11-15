/**
 * Main-process reader for the binary PCM attachment of `asset.put` (renderer side: src/audio/native/pcmTransfer.ts).
 *
 * Accepts one interleaved little-endian float32 buffer (`encoding: 'f32le-interleaved'`) and returns bytes ready to be
 * written to the host's private `.f32` file without any per-sample conversion. The legacy planar form (an array of
 * Float32Array channels) is still accepted and interleaved with typed-array copies. Every sample must be finite.
 */
export interface PcmPayload { sampleRate: number; channels: number; frames: number; data: Uint8Array }

const ENCODING = 'f32le-interleaved'
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

function count(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${label}.`)
  return value
}

function assertFinite(values: Float32Array): void {
  for (let index = 0; index < values.length; index++) {
    // NaN and ±Infinity fail this comparison; it is the fastest finite test on a typed array.
    const value = values[index]
    if (!(value - value === 0)) throw new Error('오디오에 유효하지 않은 샘플이 있습니다.')
  }
}

export function readPcmTransfer(params: Record<string, unknown>, maxBytes: number): PcmPayload {
  if (!LITTLE_ENDIAN) throw new Error('PCM transfer requires a little-endian platform.')
  const sampleRate = count(params.sampleRate, 8000, 192000, 'PCM sample rate')
  if (params.encoding === ENCODING) {
    const channels = count(params.channels, 1, 32, 'PCM channels')
    const frames = count(params.frames, 1, Math.floor(maxBytes / 4 / channels), 'PCM asset size')
    const input = params.data
    if (!(input instanceof Uint8Array) || input.byteLength !== frames * channels * 4) throw new Error('PCM asset size is invalid.')
    // Float32Array views need 4-byte alignment; IPC delivers a fresh buffer, so this copy is a rare fallback.
    const data = input.byteOffset % 4 === 0 ? input : new Uint8Array(input)
    assertFinite(new Float32Array(data.buffer, data.byteOffset, frames * channels))
    return { sampleRate, channels, frames, data }
  }
  if (!Array.isArray(params.channels) || !params.channels.length || params.channels.length > 32) throw new Error('Invalid PCM channels.')
  const planar = params.channels as unknown[]
  if (!planar.every((channel): channel is Float32Array => channel instanceof Float32Array)) throw new Error('PCM channels must be Float32Array.')
  const channels = planar.length, frames = planar[0].length
  if (!frames || frames * channels * 4 > maxBytes || !planar.every(channel => channel.length === frames)) throw new Error('PCM asset size is invalid.')
  const out = new Float32Array(frames * channels)
  for (let channel = 0; channel < channels; channel++) {
    const values = planar[channel]
    assertFinite(values)
    for (let frame = 0, index = channel; frame < frames; frame++, index += channels) out[index] = values[frame]
  }
  return { sampleRate, channels, frames, data: new Uint8Array(out.buffer) }
}

/**
 * Binary PCM attachment for the desktop `asset.put` request (renderer side; the main-process reader is
 * desktop/pcmTransfer.ts).
 *
 * The renderer interleaves an AudioBuffer once into a single little-endian float32 buffer. Electron's IPC copies that
 * one ArrayBuffer with a memcpy, and the main process writes it to the host's private PCM file as is. Before, every
 * channel travelled separately and the main process interleaved with a `writeFloatLE` call per sample (60 s stereo:
 * 28.6 ms vs 4.9 ms for a Float32Array copy, docs/ARCHITECTURE_REVIEW.md 4.1).
 *
 * Kept apart from the note/timeline binary framing on purpose: this is only the PCM payload of one request.
 */
export const PCM_TRANSFER_ENCODING = 'f32le-interleaved'

export interface PcmTransfer {
  encoding: typeof PCM_TRANSFER_ENCODING
  sampleRate: number
  channels: number
  frames: number
  /** frames x channels float32 values, frame-major (L R L R ...), little-endian. */
  data: Uint8Array
}

export const PCM_HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

/** Interleaves planar channels into one buffer. A mono channel is still copied, so the caller's buffer may be released. */
export function packPcm(sampleRate: number, planar: readonly Float32Array[]): PcmTransfer {
  if (!PCM_HOST_LITTLE_ENDIAN) throw new Error('PCM transfer requires a little-endian platform.')
  const channels = planar.length
  if (!channels) throw new Error('PCM must have at least one channel.')
  const frames = planar[0].length
  if (!planar.every(channel => channel.length === frames)) throw new Error('PCM channels must have the same length.')
  const out = new Float32Array(frames * channels)
  if (channels === 1) out.set(planar[0])
  else if (channels === 2) {
    const left = planar[0], right = planar[1]
    for (let frame = 0, index = 0; frame < frames; frame++, index += 2) { out[index] = left[frame]; out[index + 1] = right[frame] }
  } else {
    for (let channel = 0; channel < channels; channel++) {
      const values = planar[channel]
      for (let frame = 0, index = channel; frame < frames; frame++, index += channels) out[index] = values[frame]
    }
  }
  return { encoding: PCM_TRANSFER_ENCODING, sampleRate, channels, frames, data: new Uint8Array(out.buffer) }
}

export function packAudioBuffer(buffer: AudioBuffer): PcmTransfer {
  return packPcm(buffer.sampleRate, Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel)))
}

/** The inverse of packPcm (tests and diagnostics). */
export function unpackPcm(transfer: PcmTransfer): Float32Array[] {
  const values = new Float32Array(transfer.data.buffer, transfer.data.byteOffset, transfer.frames * transfer.channels)
  return Array.from({ length: transfer.channels }, (_, channel) => {
    const out = new Float32Array(transfer.frames)
    for (let frame = 0; frame < transfer.frames; frame++) out[frame] = values[frame * transfer.channels + channel]
    return out
  })
}

import type { RenderBitDepth } from '../core/types'
import { encodePcm16Wav } from './math'
import { encodeFloatWav } from '../devices/audio-warp/wav'

/** PCM 16/24-bit (clipped to ±1) or 32-bit IEEE float (unclipped) WAV, mono or stereo. */
export function encodeWav(channels: readonly Float32Array[], sampleRate: number, bitDepth: RenderBitDepth): Blob {
  if (bitDepth === 16) return new Blob([encodePcm16Wav(channels, sampleRate)], { type: 'audio/wav' })
  if (bitDepth === 32) return encodeFloatWav(channels, sampleRate)
  if (channels.length < 1 || channels.length > 2) throw new Error('WAV 내보내기는 모노 또는 스테레오만 지원합니다.')
  const frames = channels[0].length
  if (channels.some(channel => channel.length !== frames)) throw new Error('오디오 채널 길이가 서로 다릅니다.')
  const dataBytes = frames * channels.length * 3
  if (dataBytes > 0xffffffff - 36) throw new Error('WAV 파일이 RIFF 형식의 최대 크기를 초과합니다.')
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)) }
  text(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); text(8, 'WAVE')
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, channels.length, true); view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels.length * 3, true); view.setUint16(32, channels.length * 3, true); view.setUint16(34, 24, true)
  text(36, 'data'); view.setUint32(40, dataBytes, true)
  const bytes = new Uint8Array(buffer, 44)
  let offset = 0
  for (let frame = 0; frame < frames; frame++) {
    for (const channel of channels) {
      const sample = channel[frame]
      const x = Number.isFinite(sample) ? Math.min(1, Math.max(-1, sample)) : 0
      const value = Math.round(x * (x < 0 ? 8388608 : 8388607))
      bytes[offset++] = value & 0xff; bytes[offset++] = (value >> 8) & 0xff; bytes[offset++] = (value >> 16) & 0xff
    }
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

/** True when a pre-fader render left its right channel silent: the track's source is mono (keep it mono). */
export function rightChannelSilent(buffer: { readonly numberOfChannels: number; getChannelData(channel: number): Float32Array }): boolean {
  if (buffer.numberOfChannels < 2) return true
  const right = buffer.getChannelData(1)
  for (let index = 0; index < right.length; index++) if (right[index] !== 0) return false
  return true
}

/** Largest absolute sample over every channel. */
export function peakOf(buffer: { readonly numberOfChannels: number; getChannelData(channel: number): Float32Array }): number {
  let peak = 0
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel)
    for (let index = 0; index < data.length; index++) { const value = Math.abs(data[index]); if (value > peak) peak = value }
  }
  return peak
}

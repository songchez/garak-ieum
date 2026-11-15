/** 32-bit float WAV, so warp renders keep headroom above 0 dBFS like the original decode. */
export function encodeFloatWav(channels: readonly Float32Array[], sampleRate: number): Blob {
  const frames = channels[0]?.length ?? 0
  if (!channels.length || frames < 1 || channels.some(channel => channel.length !== frames) || !Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error('워프 오디오 형식이 올바르지 않습니다.')
  const dataBytes = frames * channels.length * 4
  if (dataBytes > 0xffffffff - 64) throw new Error('워프 오디오가 너무 깁니다.')
  const output = new ArrayBuffer(56 + dataBytes)
  const view = new DataView(output)
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)) }
  text(0, 'RIFF'); view.setUint32(4, output.byteLength - 8, true); text(8, 'WAVE')
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 3, true)
  view.setUint16(22, channels.length, true); view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels.length * 4, true); view.setUint16(32, channels.length * 4, true); view.setUint16(34, 32, true)
  text(36, 'fact'); view.setUint32(40, 4, true); view.setUint32(44, frames, true)
  text(48, 'data'); view.setUint32(52, dataBytes, true)
  const samples = new Float32Array(output, 56)
  for (let frame = 0, i = 0; frame < frames; frame++) for (const channel of channels) samples[i++] = channel[frame]
  return new Blob([output], { type: 'audio/wav' })
}

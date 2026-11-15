/** Kept apart from the renderer so project validation never loads the WASM core. */
export const WARP_RENDER_LIMITS = {
  /** Output length / input length. */
  minRatio: 0.25,
  maxRatio: 4,
  maxChannels: 8,
  minSampleRate: 8000,
  maxSampleRate: 192000,
  /** Output length cap; float renders of longer material would overwhelm project storage. */
  maxOutputSeconds: 30 * 60,
} as const

export function validateStretchJob(channels: readonly Float32Array[], sampleRate: number, ratio: number): number {
  const frames = channels?.[0]?.length ?? 0
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > WARP_RENDER_LIMITS.maxChannels || channels.some(channel => !(channel instanceof Float32Array) || channel.length !== frames)) throw new Error('워프할 오디오의 채널 구성이 올바르지 않습니다.')
  if (!Number.isInteger(sampleRate) || sampleRate < WARP_RENDER_LIMITS.minSampleRate || sampleRate > WARP_RENDER_LIMITS.maxSampleRate) throw new Error('워프는 8~192 kHz 오디오를 지원합니다.')
  if (!Number.isFinite(ratio) || ratio < WARP_RENDER_LIMITS.minRatio || ratio > WARP_RENDER_LIMITS.maxRatio) throw new Error('원본과 프로젝트의 템포 차이가 너무 큽니다. 워프는 원래 길이의 1/4~4배까지 지원합니다.')
  if (frames < 1 || frames * ratio / sampleRate > WARP_RENDER_LIMITS.maxOutputSeconds) throw new Error('워프한 결과가 30분을 넘습니다. 오디오를 나누어 가져와 주세요.')
  return frames
}

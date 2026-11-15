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

/** A combined warp + region-pitch render; see renderPlan.renderJob. */
export interface PcmRenderJob {
  /** Signalsmith time ratio (output / input) at neutral pitch. */
  stretch: number
  /** Resampling factor applied afterwards: > 1 raises the pitch and shortens by 1/pitch. */
  pitch: number
  /** Formant shift in semitones given to Signalsmith before resampling; null = untouched. */
  formantSemitones: number | null
}

export const RENDER_JOB_LIMITS = { minStretch: 1 / 16, maxStretch: 16, minPitch: 0.25, maxPitch: 4 } as const

export function validateRenderJob(channels: readonly Float32Array[], sampleRate: number, job: PcmRenderJob): number {
  const frames = channels?.[0]?.length ?? 0
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > WARP_RENDER_LIMITS.maxChannels || channels.some(channel => !(channel instanceof Float32Array) || channel.length !== frames)) throw new Error('렌더할 오디오의 채널 구성이 올바르지 않습니다.')
  if (!Number.isInteger(sampleRate) || sampleRate < WARP_RENDER_LIMITS.minSampleRate || sampleRate > WARP_RENDER_LIMITS.maxSampleRate) throw new Error('리전 렌더는 8~192 kHz 오디오를 지원합니다.')
  const { stretch, pitch, formantSemitones } = job ?? {}
  if (!Number.isFinite(stretch) || stretch < RENDER_JOB_LIMITS.minStretch || stretch > RENDER_JOB_LIMITS.maxStretch) throw new Error('늘이기 비율이 지원 범위를 벗어났습니다.')
  if (!Number.isFinite(pitch) || pitch < RENDER_JOB_LIMITS.minPitch - 1e-9 || pitch > RENDER_JOB_LIMITS.maxPitch + 1e-9) throw new Error('피치 이동은 ±24반음까지 지원합니다.')
  if (formantSemitones !== null && (!Number.isFinite(formantSemitones) || Math.abs(formantSemitones) > 24)) throw new Error('포먼트 이동 값이 올바르지 않습니다.')
  if (frames < 1 || frames * stretch / pitch / sampleRate > WARP_RENDER_LIMITS.maxOutputSeconds) throw new Error('렌더 결과가 30분을 넘습니다. 오디오를 나누어 가져와 주세요.')
  return frames
}

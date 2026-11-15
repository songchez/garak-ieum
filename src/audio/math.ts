import type { FadeCurve, Project } from '../core/types'
import { envelopeAt, fadeLengths } from '../core/clipEnvelope.js'
import { tempoMapOf } from '../core/tempoMap.js'

export const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum))

export const secondsPerBeat = (bpm: number): number => 60 / clamp(bpm, 20, 400)

export interface LoopRange {
  start: number
  end: number
}

export function loopRange(project: Project): LoopRange | null {
  if (!project.loop.enabled) return null
  const start = clamp(project.loop.startBeat, 0, project.lengthBeats)
  const end = clamp(project.loop.endBeat, 0, project.lengthBeats)
  return end - start > 0.001 ? { start, end } : null
}

/** The audio clock is the transport's clock; UI timers never accumulate beats. */
export function positionAfter(project: Project, startBeat: number, elapsedSeconds: number): number {
  const tempo = tempoMapOf(project)
  const elapsed = Math.max(0, elapsedSeconds)
  const unwrapped = tempo.beatAfter(startBeat, elapsed)
  const loop = loopRange(project)
  if (loop && unwrapped >= loop.end) {
    // Wrap in seconds: with tempo changes inside the cycle, each pass takes the cycle's real duration.
    const cycleSeconds = tempo.secondsBetween(loop.start, loop.end)
    const past = elapsed - tempo.secondsBetween(startBeat, loop.end)
    return Math.min(loop.end, tempo.beatAfter(loop.start, cycleSeconds > 0 ? Math.max(0, past) % cycleSeconds : 0))
  }
  return clamp(unwrapped, 0, project.lengthBeats)
}

export function normalizedStart(project: Project, beat: number): number {
  const result = clamp(beat, 0, project.lengthBeats)
  const loop = loopRange(project)
  if (loop && result >= loop.end) return loop.start
  return result
}

/** Fades are seconds, relative to the audible part of a trimmed audio clip; see core/clipEnvelope.ts. */
export function clipEnvelope(position: number, duration: number, fadeIn: number, fadeOut: number, inCurve?: FadeCurve, outCurve?: FadeCurve): number {
  if (position < 0 || position > duration || duration <= 0) return 0
  const [attack, release] = fadeLengths(duration, fadeIn, fadeOut)
  return envelopeAt(position, duration, attack, release, inCurve, outCurve)
}

/** Stereo/interleaved little-endian PCM16, including the RIFF padding/size fields. */
export function encodePcm16Wav(channels: readonly Float32Array[], sampleRate: number): ArrayBuffer {
  if (channels.length < 1 || channels.length > 2) throw new Error('WAV 내보내기는 모노 또는 스테레오만 지원합니다.')
  const frames = channels[0].length
  if (channels.some(channel => channel.length !== frames)) throw new Error('오디오 채널 길이가 서로 다릅니다.')
  const dataBytes = frames * channels.length * 2
  if (dataBytes > 0xffffffff - 36) throw new Error('WAV 파일이 RIFF 형식의 최대 크기를 초과합니다.')
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const writeText = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels.length, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels.length * 2, true)
  view.setUint16(32, channels.length * 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, dataBytes, true)
  let offset = 44
  for (let frame = 0; frame < frames; frame += 1) {
    for (const channel of channels) {
      const sample = channel[frame]
      const value = Number.isFinite(sample) ? clamp(sample, -1, 1) : 0
      view.setInt16(offset, Math.round(value * (value < 0 ? 32768 : 32767)), true)
      offset += 2
    }
  }
  return buffer
}

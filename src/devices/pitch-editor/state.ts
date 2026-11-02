import type { AudioClip } from '../../core/types'
import { PITCH_LIMITS, type PitchAnalysis, type PitchEditDocument, type PitchNote, type PitchPoint } from './model'

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}: 객체가 필요합니다.`)
  return value as Record<string, unknown>
}
function finite(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name}: 유효한 범위를 벗어났습니다.`)
  return value
}
function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[\w.:-]{1,200}$/.test(value) || value === 'prototype' || Object.hasOwn(Object.prototype, value)) throw new Error(`${name}: 식별자가 올바르지 않습니다.`)
  return value
}
/** Asset IDs are opaque existing project references, including non-ASCII names. */
function assetIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.length || value.length > 200) throw new Error(`${name}: 식별자가 올바르지 않습니다.`)
  return value
}
function list(value: unknown, limit: number, name: string): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${name}: 항목 수가 올바르지 않습니다.`)
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) throw new Error(`${name}: 비어 있는 항목이 있습니다.`)
  }
  return value
}
function notes(value: unknown, duration: number, name: string): PitchNote[] {
  const ids = new Set<string>()
  let end = 0
  return list(value, PITCH_LIMITS.maxNotes, name).map((input, index) => {
    const note = object(input, `${name} ${index + 1}`)
    const id = identifier(note.id, `${name} ID`)
    if (ids.has(id)) throw new Error(`${name}: 중복 음표 ID입니다.`)
    ids.add(id)
    const start = finite(note.start, 0, duration, `${name} 시작`)
    const nextEnd = finite(note.end, 0, duration, `${name} 끝`)
    if (start < end - 1e-8 || nextEnd <= start) throw new Error(`${name}: 겹치거나 역전된 음표 구간입니다.`)
    end = nextEnd
    return { id, start, end: nextEnd, midi: finite(note.midi, 0, 127, `${name} 음높이`), confidence: finite(note.confidence, 0, 1, `${name} 신뢰도`) }
  })
}

/** Parse known data into fresh containers; reject corrupt or unsupported editor state. */
export function validatePitchDocument(input: unknown): PitchEditDocument {
  const doc = object(input, '피치 편집')
  if (doc.version !== 1) throw new Error('지원하지 않는 피치 편집 버전입니다.')
  const sourceAssetId = assetIdentifier(doc.sourceAssetId, '피치 원본')
  if (typeof doc.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(doc.sourceHash)) throw new Error('피치 원본 해시가 올바르지 않습니다.')
  const rendererId = identifier(doc.rendererId, '피치 렌더러')
  const raw = object(doc.analysis, '피치 분석')
  if (raw.version !== 1 || raw.algorithm !== 'yin-v1') throw new Error('지원하지 않는 피치 분석 버전입니다.')
  const sampleRate = finite(raw.sampleRate, PITCH_LIMITS.minSampleRate, PITCH_LIMITS.maxSampleRate, '분석 샘플레이트')
  const sourceFrames = finite(raw.sourceFrames, 1, sampleRate * PITCH_LIMITS.maxDurationSeconds, '분석 프레임 수')
  if (!Number.isInteger(sampleRate) || !Number.isInteger(sourceFrames)) throw new Error('분석 레이트와 프레임 수는 정수여야 합니다.')
  const duration = sourceFrames / sampleRate
  let previous = -1
  const contour: PitchPoint[] = list(raw.contour, PITCH_LIMITS.maxContourPoints, '피치 곡선').map(input => {
    const point = object(input, '피치 곡선 지점')
    const time = finite(point.time, 0, duration, '곡선 시각')
    if (time <= previous) throw new Error('피치 곡선의 시각이 순서대로 정렬되지 않았습니다.')
    previous = time
    return { time, midi: finite(point.midi, 0, 127, '곡선 음높이'), confidence: finite(point.confidence, 0, 1, '곡선 신뢰도') }
  })
  const analysis: PitchAnalysis = { version: 1, algorithm: 'yin-v1', sampleRate, sourceFrames, notes: notes(raw.notes, duration, '분석 음표'), contour }
  const segments = notes(doc.segments, duration, '편집 음표')
  const segmentIds = new Set(segments.map(note => note.id))
  const shifts: Record<string, number> = {}
  const entries = Object.entries(object(doc.shifts, '피치 이동'))
  if (entries.length > PITCH_LIMITS.maxNotes) throw new Error('피치 이동 항목이 너무 많습니다.')
  for (const [id, value] of entries) {
    identifier(id, '피치 이동 ID')
    if (!segmentIds.has(id)) throw new Error('피치 이동이 존재하지 않는 음표를 참조합니다.')
    const cents = finite(value, PITCH_LIMITS.minCents, PITCH_LIMITS.maxCents, '피치 이동량')
    if (cents !== 0) shifts[id] = cents
  }
  return { version: 1, sourceAssetId, sourceHash: doc.sourceHash, rendererId, analysis, segments, shifts }
}

/** Analysis is immutable; editable segmentation and shift values belong to each clip. */
export function copyPitchDocument(doc: PitchEditDocument): PitchEditDocument {
  return { ...doc, segments: doc.segments.map(note => ({ ...note })), shifts: { ...doc.shifts } }
}

/** Re-decoding at a different project rate is valid when source time is preserved. */
export function assertPitchSourceTiming(doc: PitchEditDocument, sampleRate: number, sourceFrames: number): void {
  const rate = finite(sampleRate, PITCH_LIMITS.minSampleRate, PITCH_LIMITS.maxSampleRate, '원본 샘플레이트')
  const frames = finite(sourceFrames, 1, Number.MAX_SAFE_INTEGER, '원본 프레임 수')
  if (!Number.isInteger(rate) || !Number.isInteger(frames)) throw new Error('원본 레이트와 프레임 수는 정수여야 합니다.')
  const analysisRate = finite(doc.analysis.sampleRate, PITCH_LIMITS.minSampleRate, PITCH_LIMITS.maxSampleRate, '분석 샘플레이트')
  const analysisFrames = finite(doc.analysis.sourceFrames, 1, Number.MAX_SAFE_INTEGER, '분석 프레임 수')
  if (!Number.isInteger(analysisRate) || !Number.isInteger(analysisFrames)) throw new Error('분석 레이트와 프레임 수는 정수여야 합니다.')
  const tolerance = 2 / Math.min(rate, analysisRate)
  if (Math.abs(frames / rate - analysisFrames / analysisRate) > tolerance + 1e-12) {
    throw new Error('피치 분석과 원본 음원의 길이가 다릅니다. 다시 분석해 주세요.')
  }
}

export function restorePitchSource(clip: AudioClip): AudioClip {
  if (!clip.pitch) return clip
  const { pitch, ...original } = clip
  return { ...original, assetId: pitch.sourceAssetId }
}

/** Derived audio is a separate immutable asset, so the existing scheduler/exporter agree. */
export function applyPitchDocument(clip: AudioClip, document: PitchEditDocument, renderedAssetId: string): AudioClip {
  const pitch = validatePitchDocument(document)
  if (pitch.sourceAssetId !== (clip.pitch?.sourceAssetId ?? clip.assetId)) throw new Error('피치 편집 원본이 변경되었습니다. 다시 분석해 주세요.')
  const renderId = assetIdentifier(renderedAssetId, '피치 렌더 음원')
  const changed = Object.keys(pitch.shifts).length > 0
  if (changed && renderId === pitch.sourceAssetId) throw new Error('수정된 피치의 렌더 음원이 없습니다.')
  return { ...clip, assetId: changed ? renderId : pitch.sourceAssetId, pitch }
}

/** Float PCM preserves the renderer output in portable project bundles. */
export function encodePitchWav(channels: readonly Float32Array[], sampleRate: number): Blob {
  if (channels.length < 1 || channels.length > PITCH_LIMITS.maxChannels || !Number.isInteger(sampleRate) || sampleRate < PITCH_LIMITS.minSampleRate || sampleRate > PITCH_LIMITS.maxSampleRate) throw new Error('피치 오디오 형식이 올바르지 않습니다.')
  const frames = channels[0].length
  if (frames < 1 || frames > sampleRate * PITCH_LIMITS.maxDurationSeconds || channels.some(channel => channel.length !== frames)) throw new Error('피치 오디오 길이가 올바르지 않습니다.')
  const dataBytes = frames * channels.length * 4
  const output = new ArrayBuffer(56 + dataBytes)
  const view = new DataView(output)
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)) }
  text(0, 'RIFF'); view.setUint32(4, output.byteLength - 8, true); text(8, 'WAVE')
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 3, true)
  view.setUint16(22, channels.length, true); view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels.length * 4, true); view.setUint16(32, channels.length * 4, true); view.setUint16(34, 32, true)
  text(36, 'fact'); view.setUint32(40, 4, true); view.setUint32(44, frames, true)
  text(48, 'data'); view.setUint32(52, dataBytes, true)
  let offset = 56
  for (let frame = 0; frame < frames; frame++) for (const channel of channels) {
    const sample = channel[frame]
    if (!Number.isFinite(sample)) throw new Error('피치 렌더 결과에 유효하지 않은 샘플이 있습니다.')
    view.setFloat32(offset, sample, true); offset += 4
  }
  return new Blob([output], { type: 'audio/wav' })
}

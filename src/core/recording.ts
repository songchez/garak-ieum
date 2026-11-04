import { loopRange, normalizedStart } from '../audio/math'
import { recordingPlacement } from './recordingOffset'
import type { AudioClip, Project, Track } from './types'

/** A take keeps one identity from its temporary timeline preview to its committed audio region. */
export interface RecordingDraft {
  id: string
  name: string
  trackId: string
  track: Track
  /** May be negative after native driver/PDC compensation; placement trims pre-roll. */
  startBeat: number
  bpm: number
  offsetMs: number
  startedAtMs: number
  status: 'recording' | 'processing'
  /** Captured at stop so decoding cannot keep extending the preview. */
  elapsedSeconds?: number
}

export interface RecordingDraftPlacement {
  startBeat: number
  lengthBeats: number
  offsetSeconds: number
  elapsedSeconds: number
}

/** Match the start chosen by WebAudioEngine.play() when the transport is stopped. */
export function recordingStartBeat(project: Project, transportBeat: number): number {
  const beat = normalizedStart(project, transportBeat)
  return !loopRange(project) && beat >= project.lengthBeats ? 0 : beat
}

/** The monotonic take clock keeps growing when the playback cursor loops or stops at the project end. */
export function recordingDraftPlacement(draft: RecordingDraft, nowMs: number): RecordingDraftPlacement {
  const elapsed = draft.status === 'processing' ? draft.elapsedSeconds ?? 0 : (nowMs - draft.startedAtMs) / 1000
  const elapsedSeconds = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0
  const placement = elapsedSeconds > 0 ? recordingPlacement(draft.startBeat, draft.bpm, elapsedSeconds, draft.offsetMs) : null
  if (placement) return { ...placement, elapsedSeconds }

  // A take can be visible before it contains any samples, or before a negative
  // placement correction has crossed beat zero. Keep its corrected start but no length.
  const shiftedSeconds = draft.startBeat * 60 / draft.bpm + draft.offsetMs / 1000
  return {
    startBeat: Math.max(0, shiftedSeconds * draft.bpm / 60),
    lengthBeats: 0,
    offsetSeconds: Math.max(0, -shiftedSeconds),
    elapsedSeconds,
  }
}

/** Commit only completed audio. A newly reserved track and its region enter Undo together. */
export function appendAudioRecording(project: Project, draft: RecordingDraft, assetId: string, durationSeconds: number): { project: Project; clip: AudioClip } | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('녹음 데이터에 유효한 길이가 없습니다.')
  const existing = project.tracks.flatMap(track => track.clips).find(clip => clip.id === draft.id)
  if (existing) {
    if (existing.kind !== 'audio') throw new Error('녹음 리전 ID가 다른 종류의 리전과 겹칩니다.')
    return { project, clip: existing }
  }

  const placement = recordingPlacement(draft.startBeat, draft.bpm, durationSeconds, draft.offsetMs)
  if (!placement) return null
  const target = project.tracks.find(track => track.id === draft.trackId)
  if ((target ?? draft.track).kind !== 'audio') throw new Error('녹음 대상이 오디오 트랙이 아닙니다.')
  const clip: AudioClip = {
    id: draft.id, kind: 'audio', name: draft.name, assetId, ...placement,
    gain: 1, fadeIn: .005, fadeOut: .01,
  }
  const tracks = target
    ? project.tracks.map(track => track.id === target.id ? { ...track, hidden: false, clips: [...track.clips, clip] } : track)
    // A target deleted during the take must not resurrect its old regions.
    : [...project.tracks, { ...draft.track, id: draft.trackId, hidden: false, clips: [clip] }]
  return {
    project: {
      ...project, tracks,
      lengthBeats: Math.max(project.lengthBeats, Math.ceil((clip.startBeat + clip.lengthBeats) / project.beatsPerBar) * project.beatsPerBar),
    },
    clip,
  }
}

import { loopRange, normalizedStart } from '../audio/math'
import type { AudioRecordingCallbacks, AudioRecordingResult } from '../audio/AudioRecording'
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

export interface FinishedTake { draft: RecordingDraft; assetId: string; durationSeconds: number }

/** Several takes enter the project (and Undo) together; takes placed wholly before beat 0 are skipped. */
export function appendAudioRecordings(project: Project, takes: readonly FinishedTake[]): { project: Project; clips: AudioClip[]; skipped: RecordingDraft[] } {
  let next = project
  const clips: AudioClip[] = [], skipped: RecordingDraft[] = []
  for (const take of takes) {
    const completed = appendAudioRecording(next, take.draft, take.assetId, take.durationSeconds)
    if (!completed) { skipped.push(take.draft); continue }
    next = completed.project
    clips.push(completed.clip)
  }
  return { project: next, clips, skipped }
}

/** One finished take of a multi-track pass (docs/AUDIO_CORE_PLAN.md: `{ trackId, ...existing result }`). */
export interface TakeResult extends AudioRecordingResult { trackId: string }
export interface TakeCallbacks {
  /** Every take of the pass at once, so they can be committed as one Undo step. */
  onComplete(results: TakeResult[]): void
  onError?(error: Error): void
}
/** The single-take recorders (AudioRecording, NativeRecording) as the take flow uses them. */
export interface SingleCapture {
  start(): void | Promise<void>
  stop(): void
  dispose(): void
  readonly startedAtMs: number
  readonly elapsedSeconds: number
  /** Native only: the compensated project frame where the take starts. */
  readonly startFrame?: number | null
  readonly compensationKnown?: boolean | null
}
/** WP2's `createRecordings` session: NativeRecording's lifecycle over all takes of one `record.start`. */
export interface RecordingSession extends SingleCapture {
  /** Per-take start frame; takes share `startFrame` when absent. */
  startFrameOf?(trackId: string): number | null
}
export interface MultiTakeEngine {
  readonly maxSimultaneousRecordings?: number
  createRecordings?(trackIds: string[], callbacks: TakeCallbacks): RecordingSession
}
/** What App.tsx drives, whichever recorder is underneath. */
export interface TakeCapture {
  start(): Promise<void>
  stop(): void
  dispose(): void
  readonly startedAtMs: number
  readonly elapsedSeconds: number
  readonly compensationKnown: boolean | null
  startFrameOf(trackId: string): number | null
}

/** Takes the engine can capture in one pass: 1 unless it implements createRecordings. */
export const simultaneousTakeLimit = (engine: MultiTakeEngine): number =>
  typeof engine.createRecordings === 'function' && (engine.maxSimultaneousRecordings ?? 1) > 1 ? Math.floor(engine.maxSimultaneousRecordings!) : 1

/**
 * Several tracks go through the engine's multi-take session; one track keeps the existing single recorder
 * (MediaRecorder in a browser, NativeRecording on desktop) and reports through the same take callbacks.
 */
export function createTakeCapture(engine: MultiTakeEngine, trackIds: readonly string[], callbacks: TakeCallbacks, single: (trackId: string, callbacks: AudioRecordingCallbacks) => SingleCapture): TakeCapture {
  if (!trackIds.length) throw new Error('녹음할 트랙이 없습니다.')
  if (trackIds.length > 1) {
    if (trackIds.length > simultaneousTakeLimit(engine)) throw new Error('이 오디오 엔진은 여러 트랙을 동시에 녹음할 수 없습니다.')
    const session = engine.createRecordings!([...trackIds], callbacks)
    return {
      start: async () => { await session.start() },
      stop: () => session.stop(),
      dispose: () => session.dispose(),
      get startedAtMs() { return session.startedAtMs },
      get elapsedSeconds() { return session.elapsedSeconds },
      get compensationKnown() { return session.compensationKnown ?? null },
      startFrameOf: trackId => session.startFrameOf?.(trackId) ?? session.startFrame ?? null,
    }
  }
  const trackId = trackIds[0]
  const capture = single(trackId, { onError: callbacks.onError, onComplete: result => callbacks.onComplete([{ ...result, trackId }]) })
  return {
    start: async () => { await capture.start() },
    stop: () => capture.stop(),
    dispose: () => capture.dispose(),
    get startedAtMs() { return capture.startedAtMs },
    get elapsedSeconds() { return capture.elapsedSeconds },
    get compensationKnown() { return capture.compensationKnown ?? null },
    startFrameOf: () => capture.startFrame ?? null,
  }
}

/**
 * A browser MediaRecorder records the whole input stream; the track's chosen channel(s) are taken out
 * after decoding. Returns null when nothing needs to change or the recording lacks a chosen channel
 * (the browser or codec may deliver fewer channels than the device has; the full take is kept then).
 */
export function selectInputChannels(buffer: Pick<AudioBuffer, 'numberOfChannels' | 'getChannelData'>, channels: readonly number[] | undefined): Float32Array[] | null {
  if (!channels?.length || channels.some(channel => channel >= buffer.numberOfChannels)) return null
  if (channels.length === buffer.numberOfChannels && channels.every((channel, index) => channel === index)) return null
  return channels.map(channel => buffer.getChannelData(channel).slice())
}

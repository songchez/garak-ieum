import type { Project, Track } from '../core/types'

/**
 * What a project edit changed in the *scheduled* music (notes, controllers, audio regions), as opposed to mixer
 * state that `updateGraph` applies in place.
 *
 * Project updates are immutable with structural sharing (core/ProjectSession.ts), so an unchanged clip list keeps its
 * identity. Comparing references replaces the former `JSON.stringify` of every clip on every edit (26 ms at 66k notes,
 * docs/ARCHITECTURE_REVIEW.md 4.1). A new reference with equal content is reported as changed: that only costs a
 * reschedule of one track, never a missed edit. Small value objects (loop, meter, tempo map, key/velocity limits)
 * are compared by value, because some edits rebuild them without changing them.
 *
 * - `global`: the transport timeline moved (tempo, tempo map, length, loop, meter) or tracks were added, removed or
 *   reordered. Everything restarts from the playhead, as before.
 * - `tracks`: per changed track, `hard` (the voice itself changed: instrument, kind, enabled, transpose, limits,
 *   delay — sounding notes are cut and sustained notes chased) or `soft` (only its regions changed: already sounding
 *   notes ring out, onsets not yet heard are replaced).
 */
export type TrackChange = 'hard' | 'soft'

export interface ArrangementDiff {
  global: boolean
  tracks: Map<string, TrackChange>
}

const NONE: ArrangementDiff = Object.freeze({ global: false, tracks: new Map<string, TrackChange>() }) as ArrangementDiff

const sameSmall = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)

function sameList<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false
  return true
}

/** The voice of a track; any difference cuts its sounding notes. */
function sameVoice(a: Track, b: Track): boolean {
  return a.kind === b.kind && a.instrument === b.instrument && a.enabled === b.enabled && a.transpose === b.transpose
    && a.velocityOffset === b.velocityOffset && a.delayTicks === b.delayTicks
    && sameSmall(a.keyLimit, b.keyLimit) && sameSmall(a.velocityLimit, b.velocityLimit)
}

export function trackChange(previous: Track, next: Track): TrackChange | null {
  if (previous === next) return null
  if (!sameVoice(previous, next)) return 'hard'
  // Clip playback fields (loop, delay, quantize, swing, transpose, velocity, controllers) travel inside track.clips.
  return sameList(previous.clips, next.clips) ? null : 'soft'
}

export function diffArrangement(previous: Project | null, next: Project): ArrangementDiff {
  if (previous === next) return NONE
  if (!previous) return { global: true, tracks: new Map() }
  if (previous.bpm !== next.bpm || previous.lengthBeats !== next.lengthBeats || !sameSmall(previous.loop, next.loop)
    || !sameSmall(previous.timeSignature, next.timeSignature) || !sameSmall(previous.tempoMap, next.tempoMap) || !sameSmall(previous.meterMap, next.meterMap)) return { global: true, tracks: new Map() }
  const before = previous.tracks, after = next.tracks
  if (before === after) return NONE
  if (before.length !== after.length) return { global: true, tracks: new Map() }
  const tracks = new Map<string, TrackChange>()
  for (let index = 0; index < after.length; index++) {
    const a = before[index], b = after[index]
    if (a.id !== b.id) return { global: true, tracks: new Map() }
    const change = trackChange(a, b)
    if (change) tracks.set(b.id, change)
  }
  return tracks.size ? { global: false, tracks } : NONE
}

export const arrangementChanged = (diff: ArrangementDiff): boolean => diff.global || diff.tracks.size > 0

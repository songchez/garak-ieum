import type { AudioClip, Clip, MidiClip, Track } from './types'
import { midiSourceOffset } from './midiRegions'
import { fadeLengths } from './clipEnvelope.js'
import { sustainSpans, sustainedEnds, visibleSustain } from './sustain'
import { quantizePosition } from './quantize'
import { spanBeats, spanSeconds, type Tempo } from './tempoMap.js'
import { bendRangeOf, occurrenceControllers } from './controllers'
import type { ControllerKey } from './types'

/** Ticks per beat for Track.delayTicks and ClipBase.delayTicks. */
export const PPQ = 960
const EPSILON = 1e-9
const MAX_OCCURRENCES = 4096

export interface Occurrence {
  start: number
  end: number
  index: number
}

/** One scheduled note in absolute beats. velocity is 0…2 (MIDI velocity / 127 × clip gain). */
export interface PlaybackNote {
  pitch: number
  start: number
  end: number
  velocity: number
  /** End of the occurrence window the note belongs to; drums may decay until here. */
  limit: number
}

export interface AudioWindow {
  clip: AudioClip
  start: number
  end: number
  /** Beats into the clip content (after clip.offsetSeconds) where this window starts. */
  sourceOffsetBeats: number
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum))

// Projects loaded before these fields existed may still be in memory: treat missing values as defaults.
const num = (value: number | undefined): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const range = (value: [number, number] | undefined, fallback: [number, number]): [number, number] =>
  Array.isArray(value) && value.length === 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]) ? value : fallback

export const isTrackEnabled = (track: Track): boolean => track.enabled !== false

/**
 * enabled && !mute && (!anySolo || solo || soloSafe || implied); anySolo counts enabled tracks only.
 * Send/return solo follows Logic (docs/SENDS_RETURNS.md): a return is implied by a soloed track that sends
 * to it (returns are also solo-safe by default, like Ableton's solo-in-place), and soloing a return implies
 * the tracks that send to it. Only sends with a level above 0 imply anything.
 */
export function audibleTrackIds(tracks: readonly Track[]): Set<string> {
  const enabled = tracks.filter(isTrackEnabled)
  const anySolo = enabled.some(track => track.solo)
  if (!anySolo) return new Set(enabled.filter(track => !track.mute).map(track => track.id))
  const feeds = (track: Track): readonly string[] => track.kind === 'return' ? [] : (track.sends ?? []).filter(send => send.level > 0).map(send => send.returnId)
  const soloedReturns = new Set(enabled.filter(track => track.kind === 'return' && track.solo).map(track => track.id))
  const impliedReturns = new Set(enabled.filter(track => track.kind !== 'return' && track.solo).flatMap(feeds))
  return new Set(enabled.filter(track => !track.mute && (track.solo || track.soloSafe
    || (track.kind === 'return' ? impliedReturns.has(track.id) : feeds(track).some(id => soloedReturns.has(id))))).map(track => track.id))
}

const trackDelay = (track: Track, clip: Clip): number => (num(clip.delayTicks) + num(track.delayTicks)) / PPQ

/**
 * A loop stops at its manual endpoint, the next clip (including muted clips), or the project
 * end, whichever comes first. None of those boundaries truncate the original source region.
 */
export function loopEnd(track: Track, clip: Clip, projectEnd: number): number {
  const clipEnd = clip.startBeat + clip.lengthBeats
  if (!clip.loop) return clipEnd
  let end = clip.loopLengthBeats === undefined ? projectEnd : Math.min(projectEnd, clip.startBeat + clip.loopLengthBeats)
  for (const other of track.clips) {
    if (other.id === clip.id || other.startBeat <= clip.startBeat) continue
    end = Math.min(end, other.startBeat)
  }
  return Math.max(clipEnd, end)
}

export function clipOccurrences(track: Track, clip: Clip, projectEnd: number): Occurrence[] {
  const length = clip.lengthBeats
  if (!(length > EPSILON)) return []
  const end = loopEnd(track, clip, projectEnd)
  const occurrences: Occurrence[] = []
  for (let index = 0; index < MAX_OCCURRENCES; index += 1) {
    const start = clip.startBeat + index * length
    if (start >= end - EPSILON) break
    occurrences.push({ start, end: Math.min(start + length, end), index })
  }
  return occurrences
}

/** Applies a track's playback parameters to one live note. null = filtered out by the limits. */
export function trackNote(track: Track | undefined, pitch: number, velocity: number): { pitch: number; velocity: number } | null {
  if (!track) return { pitch, velocity }
  const [keyLow, keyHigh] = range(track.keyLimit, [0, 127])
  const [velocityLow, velocityHigh] = range(track.velocityLimit, [1, 127])
  const transposed = pitch + num(track.transpose)
  const scaled = clamp(Math.round(clamp(velocity, 0, 1) * 127) + num(track.velocityOffset), 1, 127)
  if (transposed < 0 || transposed > 127 || transposed < keyLow || transposed > keyHigh) return null
  if (scaled < velocityLow || scaled > velocityHigh) return null
  return { pitch: transposed, velocity: scaled / 127 }
}

/**
 * Notes of one occurrence: quantize+swing (× Q-강도) → delay → transpose → velocity → limits → crop → gain.
 * The crop window moves with the delay, so a negative delay plays the first notes early instead of dropping them.
 * The sustain pedal (clip.sustain) is applied per occurrence unless `sustain` is false (docs/SUSTAIN_PEDAL.md):
 * note-offs inside a pedal-down span move to the pedal-up (or occurrence end), and a re-struck pitch cuts its tail.
 * Callers that deliver CC64 to the instrument themselves (VST3, MIDI export) pass false and use playbackSustain.
 */
export function playbackNotes(track: Track, clip: MidiClip, occ: Occurrence, sustain = true): PlaybackNote[] {
  const grid = num(clip.quantize)
  const swing = clip.swing === undefined ? 50 : clamp(clip.swing, 0, 100)
  const strength = clip.qStrength === undefined ? 100 : clamp(clip.qStrength, 0, 100)
  const delay = trackDelay(track, clip)
  const transpose = num(clip.transpose) + num(track.transpose)
  const velocityOffset = num(clip.velocity) + num(track.velocityOffset)
  const [keyLow, keyHigh] = range(track.keyLimit, [0, 127])
  const [velocityLow, velocityHigh] = range(track.velocityLimit, [1, 127])
  const gain = clamp(clip.gain, 0, 2)
  const window = occ.end - occ.start
  const origin = occ.start + delay
  const sourceOffset = midiSourceOffset(clip)
  const notes: PlaybackNote[] = []
  for (const note of clip.notes) {
    const sourceStart = Math.max(0, note.start) - sourceOffset
    let local = Math.max(0, sourceStart)
    const duration = note.duration + Math.min(0, sourceStart)
    if (duration <= EPSILON) continue
    if (grid > 0) local = clamp(quantizePosition(local, grid, swing, strength), 0, clip.lengthBeats)
    const pitch = note.pitch + transpose
    if (pitch < 0 || pitch > 127) continue
    const velocity = clamp(Math.round(clamp(note.velocity, 0, 1) * 127) + velocityOffset, 1, 127)
    if (pitch < keyLow || pitch > keyHigh || velocity < velocityLow || velocity > velocityHigh) continue
    if (local >= window - EPSILON) continue
    const end = Math.min(local + duration, window)
    if (end <= local) continue
    notes.push({ pitch, start: local, end, velocity: velocity / 127 * gain, limit: window })
  }
  const spans = sustain && clip.sustain?.length ? sustainSpans(visibleSustain(clip), 0, window) : []
  const ends = spans.length ? sustainedEnds(notes, spans, window) : null
  return notes.map((note, index) => ({ ...note, start: origin + note.start, end: origin + (ends ? ends[index] : note.end), limit: origin + window }))
}

/** One CC64 value in absolute project beats. */
export interface PlaybackSustain { beat: number; value: number }

/**
 * CC64 events of one occurrence, with track/clip delay applied: the chased value at the occurrence start
 * (only when down), the visible events, and a release at the occurrence end when the pedal is still down.
 */
export function playbackSustain(track: Track, clip: MidiClip, occ: Occurrence): PlaybackSustain[] {
  if (!clip.sustain?.length) return []
  const window = occ.end - occ.start
  const origin = occ.start + trackDelay(track, clip)
  const events: PlaybackSustain[] = []
  let value = 0
  for (const event of visibleSustain(clip)) {
    if (event.beat >= window - EPSILON) break
    events.push({ beat: origin + event.beat, value: event.value })
    value = event.value
  }
  if (value >= 64) events.push({ beat: origin + window, value: 0 })
  return events
}

/** One controller event in absolute project beats (docs/MIDI_CONTROLLERS.md). */
export interface PlaybackController {
  beat: number
  key: ControllerKey
  value: number
  /** Pitch bend only: the region's bend range in semitones (built-in instruments). */
  range?: number
  /** A reset at the occurrence end: sorts before other events at the same beat. */
  reset?: true
}

/**
 * Controller events of one occurrence with track/clip delay applied: per lane the chased value at the occurrence
 * start, the visible events, and a reset to the default at the occurrence end for reset controllers.
 */
export function playbackControllers(track: Track, clip: MidiClip, occ: Occurrence): PlaybackController[] {
  if (!clip.controllers) return []
  const window = occ.end - occ.start
  const origin = occ.start + trackDelay(track, clip)
  const range = bendRangeOf(clip)
  return occurrenceControllers(clip, window).map(event => ({ beat: origin + event.beat, key: event.key, value: event.value,
    ...(event.key === 'pitchBend' ? { range } : {}), ...(event.beat >= window ? { reset: true as const } : {}) }))
}

/** Every controller event of a track, sorted by beat (stable: a region-end reset precedes the next region's chase). */
export function midiControllerEvents(track: Track, projectEnd: number): PlaybackController[] {
  const events: PlaybackController[] = []
  for (const clip of track.clips) {
    if (clip.kind !== 'midi' || clip.mute || !clip.controllers) continue
    for (const occ of clipOccurrences(track, clip, projectEnd)) for (const event of playbackControllers(track, clip, occ)) events.push(event)
  }
  return events.sort((a, b) => a.beat - b.beat || (a.reset ? 0 : 1) - (b.reset ? 0 : 1))
}

/**
 * Audio occurrences with delay applied; where clips overlap, the later-starting clip cuts the earlier one (V-09).
 * With `tempo`, the earlier clip keeps playing under the later clip's fade-in (crossfade, docs/REGION_GAIN_FADES.md).
 */
export function audioWindows(track: Track, projectEnd: number, tempo?: Tempo): AudioWindow[] {
  const expanded: (AudioWindow & { order: number })[] = []
  track.clips.forEach((clip, order) => {
    if (clip.kind !== 'audio' || clip.mute) return
    const delay = trackDelay(track, clip)
    for (const occ of clipOccurrences(track, clip, projectEnd)) {
      expanded.push({ clip, start: occ.start + delay, end: occ.end + delay, sourceOffsetBeats: 0, order })
    }
  })
  const windows: AudioWindow[] = []
  for (const window of expanded) {
    let end = window.end
    for (const other of expanded) {
      if (other.clip.id === window.clip.id || other.start >= end) continue
      const later = other.start > window.start + EPSILON || (other.start >= window.start - EPSILON && other.order > window.order)
      if (later) end = Math.max(window.start, Math.min(end, other.start + crossfadeBeats(other.clip, tempo)))
    }
    if (end - window.start > EPSILON) windows.push({ clip: window.clip, start: window.start, end, sourceOffsetBeats: window.sourceOffsetBeats })
  }
  return windows
}

/** Beats of `clip`'s effective fade-in, during which an earlier overlapping clip keeps sounding. */
function crossfadeBeats(clip: AudioClip, tempo: Tempo | undefined): number {
  if (tempo === undefined || (typeof tempo === 'number' && !(tempo > 0)) || !(clip.fadeIn > 0)) return 0
  const fadeIn = fadeLengths(spanSeconds(tempo, clip.startBeat, clip.startBeat + clip.lengthBeats), clip.fadeIn, clip.fadeOut)[0]
  return spanBeats(tempo, clip.startBeat, fadeIn)
}

export function midiEvents(track: Track, projectEnd: number): PlaybackNote[] {
  const notes: PlaybackNote[] = []
  for (const clip of track.clips) {
    if (clip.kind !== 'midi' || clip.mute) continue
    for (const occ of clipOccurrences(track, clip, projectEnd)) {
      for (const note of playbackNotes(track, clip, occ)) notes.push(note)
    }
  }
  return notes
}

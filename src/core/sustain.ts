import type { MidiClip, MidiNote, SustainEvent } from './types'

/**
 * Sustain pedal (MIDI CC64) semantics shared by both engines, import/export and the piano roll.
 * docs/SUSTAIN_PEDAL.md has the benchmark and the user-facing behaviour.
 *
 * - A value of 64 or more is "down" (MIDI 1.0 on/off switch threshold); intermediate values are kept
 *   for a future half-pedal model but currently behave as on/off.
 * - The pedal state is right-continuous: an event at beat b decides the state *at* b. A note-off at the
 *   exact beat of a pedal-down is caught; a note-off at the exact beat of a pedal-up is not extended.
 * - While the pedal is down, note-offs are deferred until the pedal lifts. Striking the same pitch again
 *   ends the sustained (already released) note at the new onset, like a re-struck piano string.
 * - Pedal state belongs to one region occurrence: it is chased at the visible left edge and released at the
 *   region end (and at every loop wrap), exactly like notes are cropped there.
 */
export const SUSTAIN_CONTROLLER = 64
export const SUSTAIN_THRESHOLD = 64
const EPSILON = 1e-9

export const isPedalDown = (value: number): boolean => value >= SUSTAIN_THRESHOLD

/** Sorted, de-duplicated (last event per beat wins), integer 0…127 values, non-negative beats. */
export function normalizeSustain(events: readonly SustainEvent[] | undefined): SustainEvent[] {
  if (!events?.length) return []
  const sorted = events
    .map((event, index) => ({ beat: Math.max(0, event.beat), value: Math.max(0, Math.min(127, Math.round(event.value))), index }))
    .filter(event => Number.isFinite(event.beat) && Number.isFinite(event.value))
    .sort((a, b) => a.beat - b.beat || a.index - b.index)
  const result: SustainEvent[] = []
  for (const { beat, value } of sorted) {
    const last = result[result.length - 1]
    if (last && Math.abs(last.beat - beat) < EPSILON) last.value = value
    else result.push({ beat, value })
  }
  return result
}

/** Pedal value at `beat` (right-continuous); 0 before the first event. */
export function sustainValueAt(events: readonly SustainEvent[] | undefined, beat: number): number {
  let value = 0
  for (const event of events ?? []) {
    if (event.beat > beat + EPSILON) break
    value = event.value
  }
  return value
}

/** Half-open [start, end) spans where the pedal is down, clipped to [from, to). */
export function sustainSpans(events: readonly SustainEvent[] | undefined, from = 0, to = Infinity): [number, number][] {
  const spans: [number, number][] = []
  let downAt: number | null = isPedalDown(sustainValueAt(events, from)) ? from : null
  for (const event of events ?? []) {
    if (event.beat <= from + EPSILON) continue
    if (event.beat >= to - EPSILON) break
    const down = isPedalDown(event.value)
    if (down && downAt === null) downAt = event.beat
    else if (!down && downAt !== null) { if (event.beat - downAt > EPSILON) spans.push([downAt, event.beat]); downAt = null }
  }
  if (downAt !== null && to - downAt > EPSILON) spans.push([downAt, to])
  return spans
}

/** Minimal events describing spans: a down (127) at each start and an up (0) at each end. */
export function spansToSustain(spans: readonly (readonly [number, number])[]): SustainEvent[] {
  const merged: [number, number][] = []
  for (const [start, end] of [...spans].filter(([s, e]) => e - s > EPSILON).sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1] + EPSILON) last[1] = Math.max(last[1], end)
    else merged.push([Math.max(0, start), end])
  }
  return merged.flatMap(([start, end]) => [{ beat: start, value: 127 }, { beat: end, value: 0 }])
}

/** Region-relative (visible) pedal events: the value at the left edge is chased as an event at 0. */
export function visibleSustain(clip: MidiClip): SustainEvent[] {
  const events = clip.sustain
  if (!events?.length) return []
  const offset = clip.sourceOffsetBeats ?? 0
  const result: SustainEvent[] = []
  const initial = sustainValueAt(events, offset)
  if (initial > 0) result.push({ beat: 0, value: initial })
  for (const event of events) {
    const beat = event.beat - offset
    if (beat <= EPSILON || beat >= clip.lengthBeats - EPSILON) continue
    result.push({ beat, value: event.value })
  }
  return result
}

/** Replace the visible pedal window of a clip. Hidden source events before and after the window survive. */
export function applyVisibleSustain(clip: MidiClip, visible: readonly SustainEvent[]): MidiClip {
  const offset = clip.sourceOffsetBeats ?? 0
  const end = offset + clip.lengthBeats
  const source = clip.sustain ?? []
  const before = source.filter(event => event.beat < offset - EPSILON)
  const after = source.filter(event => event.beat >= end - EPSILON)
  const inside = normalizeSustain(visible.map(event => ({ beat: event.beat + offset, value: event.value })))
    .filter(event => event.beat < end - EPSILON)
  // If the visible window starts up but the hidden source before it ended down, an explicit up at the edge.
  const head = isPedalDown(sustainValueAt(before, offset)) && !(inside[0] && inside[0].beat <= offset + EPSILON) ? [{ beat: offset, value: 0 }] : []
  // Keep the hidden tail's state: if the pedal ends up down at the right edge but the original source was
  // up there (or vice versa), restore the original state at the edge so the hidden part is unchanged.
  const originalAtEnd = sustainValueAt(source, end - EPSILON * 2)
  const editedAtEnd = sustainValueAt([...before, ...head, ...inside], end - EPSILON * 2)
  const tail = after.length && Math.abs(after[0].beat - end) < EPSILON ? [] : isPedalDown(originalAtEnd) !== isPedalDown(editedAtEnd) ? [{ beat: end, value: originalAtEnd }] : []
  const next = normalizeSustain([...before, ...head, ...inside, ...tail, ...after])
  const pruned = prune(next)
  if (sameEvents(pruned, source)) return clip
  if (!pruned.length) { const { sustain: _sustain, ...rest } = clip; return rest }
  return { ...clip, sustain: pruned }
}

/** Drops events that do not change the on/off state (keeps the first event's exact value). */
function prune(events: SustainEvent[]): SustainEvent[] {
  const result: SustainEvent[] = []
  let down = false
  for (const event of events) {
    const next = isPedalDown(event.value)
    if (next === down && (result.length || !next)) continue
    result.push(event)
    down = next
  }
  return result
}

const sameEvents = (a: readonly SustainEvent[], b: readonly SustainEvent[]): boolean =>
  a.length === b.length && a.every((event, index) => Math.abs(event.beat - b[index].beat) < EPSILON && event.value === b[index].value)

export interface SustainableNote { pitch: number; start: number; end: number }

/**
 * Deferred note-offs. `notes` are in one coordinate system with `spans` (e.g. region-relative beats);
 * `limit` crops every extended end (the occurrence end). Returns new end positions in input order.
 */
export function sustainedEnds(notes: readonly SustainableNote[], spans: readonly (readonly [number, number])[], limit = Infinity): number[] {
  if (!spans.length) return notes.map(note => note.end)
  const order = notes.map((_, index) => index).sort((a, b) => notes[a].start - notes[b].start || a - b)
  const byPitch = new Map<number, number[]>()
  for (const index of order) {
    const list = byPitch.get(notes[index].pitch)
    if (list) list.push(index)
    else byPitch.set(notes[index].pitch, [index])
  }
  const ends = notes.map(note => note.end)
  for (const indices of byPitch.values()) {
    indices.forEach((index, position) => {
      const note = notes[index]
      const span = spans.find(([start, end]) => start <= note.end + EPSILON && note.end < end - EPSILON)
      if (!span) return
      let end = Math.min(span[1], limit)
      // A re-struck pitch takes over the string: the sustained tail ends at the next onset of that pitch.
      for (let next = position + 1; next < indices.length; next++) {
        const onset = notes[indices[next]].start
        if (onset >= note.end - EPSILON) { if (onset < end) end = Math.max(note.end, onset); break }
      }
      ends[index] = Math.max(note.end, end)
    })
  }
  return ends
}

/** Hold notes through the pedal permanently ("서스테인을 음 길이로 굳히기") and remove the pedal events. */
export function bakeSustain(clip: MidiClip): MidiClip {
  if (!clip.sustain?.length) return clip
  const spans = sustainSpans(clip.sustain)
  const ends = sustainedEnds(clip.notes.map(note => ({ pitch: note.pitch, start: note.start, end: note.start + note.duration })), spans)
  const notes: MidiNote[] = clip.notes.map((note, index) => {
    const duration = ends[index] - note.start
    return Math.abs(duration - note.duration) < EPSILON ? note : { ...note, duration }
  })
  const { sustain: _sustain, ...rest } = clip
  return { ...rest, notes }
}

/** Short summary for UI hints: number of pedal presses. */
export const sustainPressCount = (clip: MidiClip): number => sustainSpans(clip.sustain).length

/** Joined regions keep each source's audible pedal: visible windows rebased to `startBeat`, released at each region end. */
export function joinSustain(clips: readonly MidiClip[], startBeat: number): SustainEvent[] {
  const spans: [number, number][] = []
  for (const clip of clips) {
    const shift = clip.startBeat - startBeat
    for (const [start, end] of sustainSpans(visibleSustain(clip), 0, clip.lengthBeats)) spans.push([start + shift, end + shift])
  }
  return spansToSustain(spans)
}

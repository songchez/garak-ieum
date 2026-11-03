import type { MidiNote } from './types'

export const MIN_PIANO_NOTE_LENGTH = 1 / 64
export type NoteTimingMode = 'move' | 'resize' | 'resize-left'

/** Free creation keeps the exact pointer beat; an explicitly chosen grid snaps down. */
export function pianoNoteStart(beat: number, clipLength: number, snap = 0): number {
  const position = snap > 0 ? Math.floor(beat / snap) * snap : beat
  return Math.max(0, Math.min(Math.max(0, clipLength - (snap || MIN_PIANO_NOTE_LENGTH)), position))
}

/** One common time delta keeps a selection's spacing and stops at its first region boundary. */
export function noteTimingBounds(notes: readonly MidiNote[], clipLength: number, mode: NoteTimingMode, minimumLength = MIN_PIANO_NOTE_LENGTH): { minDelta: number; maxDelta: number } {
  if (!notes.length) return { minDelta: 0, maxDelta: 0 }
  const minimum = (note: MidiNote) => Math.min(note.duration, minimumLength)
  return {
    minDelta: mode === 'resize' ? Math.max(...notes.map(note => minimum(note) - note.duration)) : -Math.min(...notes.map(note => note.start)),
    maxDelta: mode === 'resize-left' ? Math.min(...notes.map(note => note.duration - minimum(note))) : Math.max(0, Math.min(...notes.map(note => clipLength - note.start - note.duration))),
  }
}

/** Both pointer edits and keyboard nudges share the same region and group bounds. No quantization. */
export function editNoteTiming(notes: MidiNote[], requestedDelta: number, clipLength: number, mode: NoteTimingMode, minimumLength = MIN_PIANO_NOTE_LENGTH): MidiNote[] {
  const { minDelta, maxDelta } = noteTimingBounds(notes, clipLength, mode, minimumLength)
  const delta = Math.min(maxDelta, Math.max(minDelta, requestedDelta))
  if (!delta) return notes
  return notes.map(note => mode === 'move' ? { ...note, start: note.start + delta }
    : mode === 'resize' ? { ...note, duration: note.duration + delta }
      : { ...note, start: note.start + delta, duration: note.duration - delta })
}

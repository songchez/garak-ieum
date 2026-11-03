import type { MidiClip, MidiNote } from './types'

const EPSILON = 1e-9

/** Stored note starts use source beats; editors and playback use beats from the visible left edge. */
export const midiSourceOffset = (clip: MidiClip): number => clip.sourceOffsetBeats ?? 0

/** A non-mutating, cropped view. Original note IDs identify the source notes during editing. */
export function visibleMidiNotes(clip: MidiClip): MidiNote[] {
  const offset = midiSourceOffset(clip)
  const notes: MidiNote[] = []
  for (const note of clip.notes) {
    const start = Math.max(0, note.start - offset)
    const end = Math.min(clip.lengthBeats, note.start + note.duration - offset)
    if (end - start <= EPSILON) continue
    notes.push(start === note.start && end - start === note.duration ? note : { ...note, start, duration: end - start })
  }
  return notes
}

/** The piano roll can keep operating on non-negative region-relative note coordinates. */
export function midiEditorClip(clip: MidiClip): MidiClip {
  const { sourceOffsetBeats: _offset, ...view } = clip
  return { ...view, notes: visibleMidiNotes(clip) }
}

/**
 * Merge an edited visible view back into its source. Hidden notes are untouched. Unchanged note
 * edges retain their hidden tails, including when only pitch or velocity changed. Moving or
 * resizing an edge replaces only that edge; deleting a visible note deletes that source note.
 */
export function applyMidiNoteEdits(clip: MidiClip, editedVisibleNotes: readonly MidiNote[]): MidiClip {
  const offset = midiSourceOffset(clip)
  const visible = new Map(visibleMidiNotes(clip).map(note => [note.id, note]))
  const edited = new Map(editedVisibleNotes.map(note => [note.id, note]))
  const sourceIds = new Set(clip.notes.map(note => note.id))
  if (edited.size !== editedVisibleNotes.length) throw new Error('Edited MIDI notes must have unique IDs.')
  const notes: MidiNote[] = []
  for (const source of clip.notes) {
    const before = visible.get(source.id)
    if (!before) { notes.push(source); continue }
    const next = edited.get(source.id)
    if (!next) continue
    const start = Math.abs(next.start - before.start) < EPSILON ? source.start : next.start + offset
    const sourceEnd = source.start + source.duration
    const end = Math.abs(next.start + next.duration - before.start - before.duration) < EPSILON
      ? sourceEnd : next.start + next.duration + offset
    const duration = end - start
    notes.push(start === source.start && duration === source.duration && next.pitch === source.pitch && next.velocity === source.velocity
      ? source : { ...source, pitch: next.pitch, velocity: next.velocity, start, duration })
  }
  for (const note of editedVisibleNotes) {
    if (!sourceIds.has(note.id)) notes.push({ ...note, start: note.start + offset })
  }
  return notes.length === clip.notes.length && notes.every((note, index) => note === clip.notes[index]) ? clip : { ...clip, notes }
}

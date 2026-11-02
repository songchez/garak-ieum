import { PITCH_LIMITS, type PitchEditDocument, type PitchNote } from './model'

const clampCents = (value: number) => Math.max(PITCH_LIMITS.minCents, Math.min(PITCH_LIMITS.maxCents, Math.round(value * 10) / 10))
export const segmentShift = (document: PitchEditDocument, id: string): number => Object.hasOwn(document.shifts, id) ? document.shifts[id] : 0
const copyShifts = (document: PitchEditDocument): Record<string, number> => Object.assign(Object.create(null), document.shifts)

/** The analysis stays immutable; only the region's explicit pitch deltas change. */
export function shiftSegments(document: PitchEditDocument, ids: ReadonlySet<string>, value: number, absolute = false): PitchEditDocument {
  if (!Number.isFinite(value)) return document
  const shifts = copyShifts(document)
  let changed = false
  for (const note of document.segments) {
    if (!ids.has(note.id)) continue
    const before = segmentShift(document, note.id)
    const after = clampCents(absolute ? value : before + value)
    if (before === after) continue
    changed = true
    if (after === 0) delete shifts[note.id]
    else shifts[note.id] = after
  }
  return changed ? { ...document, shifts } : document
}

function center(document: PitchEditDocument, start: number, end: number, fallback: number): number {
  const pitches = document.analysis.contour.filter(point => point.time >= start && point.time < end && point.confidence >= 0.5).map(point => point.midi).sort((a, b) => a - b)
  if (!pitches.length) return fallback
  const mid = Math.floor(pitches.length / 2)
  return pitches.length % 2 ? pitches[mid] : (pitches[mid - 1] + pitches[mid]) / 2
}

export function splitSegment(document: PitchEditDocument, id: string, at: number, newId: string): PitchEditDocument {
  const note = document.segments.find(item => item.id === id)
  if (!note || document.segments.length >= PITCH_LIMITS.maxNotes || !Number.isFinite(at) || at - note.start < PITCH_LIMITS.minNoteSeconds || note.end - at < PITCH_LIMITS.minNoteSeconds || document.segments.some(item => item.id === newId)) return document
  const left = { ...note, end: at, midi: center(document, note.start, at, note.midi) }
  const right = { ...note, id: newId, start: at, midi: center(document, at, note.end, note.midi) }
  const shifts = copyShifts(document)
  if (Object.hasOwn(shifts, id)) shifts[newId] = shifts[id]
  return { ...document, segments: document.segments.flatMap(item => item.id === id ? [left, right] : [item]), shifts }
}

/** Adjacent notes with different applied shifts cannot be merged ambiguously. */
export function mergeCandidate(document: PitchEditDocument, ids: ReadonlySet<string>): PitchNote[] | null {
  const notes = document.segments.filter(note => ids.has(note.id))
  if (notes.length < 2) return null
  const first = document.segments.indexOf(notes[0])
  if (notes.some((note, index) => document.segments[first + index] !== note)) return null
  const shift = segmentShift(document, notes[0].id)
  if (notes.some(note => segmentShift(document, note.id) !== shift)) return null
  if (notes.some((note, index) => index > 0 && note.start - notes[index - 1].end > 0.05)) return null
  return notes
}

export function mergeSegments(document: PitchEditDocument, ids: ReadonlySet<string>): PitchEditDocument {
  const notes = mergeCandidate(document, ids)
  if (!notes) return document
  const first = notes[0], end = notes.at(-1)!.end
  const duration = notes.reduce((sum, note) => sum + note.end - note.start, 0)
  const fallback = notes.reduce((sum, note) => sum + note.midi * (note.end - note.start), 0) / duration
  const combined = { ...first, end, midi: center(document, first.start, end, fallback), confidence: Math.min(...notes.map(note => note.confidence)) }
  const shifts = copyShifts(document)
  for (const note of notes.slice(1)) delete shifts[note.id]
  return { ...document, segments: document.segments.flatMap(note => note.id === first.id ? [combined] : ids.has(note.id) ? [] : [note]), shifts }
}

/** Clip boundary pieces keep their sound and pitch delta, with independent IDs. */
export function scopeSegments(document: PitchEditDocument, start: number, end: number, makeId: () => string): PitchEditDocument {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return document
  const segments: PitchNote[] = []
  const shifts = copyShifts(document)
  let changed = false
  for (const note of document.segments) {
    const cuts = [note.start, ...[start, end].filter(cut => cut > note.start + 1e-8 && cut < note.end - 1e-8), note.end].sort((a, b) => a - b)
    if (cuts.length === 2) { segments.push(note); continue }
    if (document.segments.length + cuts.length - 2 > PITCH_LIMITS.maxNotes) return document
    changed = true
    for (let i = 0; i < cuts.length - 1; i++) {
      const id = i === 0 ? note.id : makeId()
      segments.push({ ...note, id, start: cuts[i], end: cuts[i + 1] })
      if (Object.hasOwn(shifts, note.id)) shifts[id] = shifts[note.id]
    }
  }
  return changed && segments.length <= PITCH_LIMITS.maxNotes ? { ...document, segments, shifts } : document
}

export function pitchCurvePath(document: PitchEditDocument, start: number, end: number, pixelsPerSecond: number, topMidi: number, rowHeight: number, edited: boolean): string {
  let path = '', previousTime = -Infinity, previousX = -Infinity, segmentIndex = 0
  const segments = document.segments
  for (const point of document.analysis.contour) {
    if (point.time < start || point.time > end) continue
    const x = (point.time - start) * pixelsPerSecond
    if (x - previousX < 1.2 && point.time - previousTime < 0.06) continue
    while (segmentIndex < segments.length && point.time >= segments[segmentIndex].end) segmentIndex++
    const note = segments[segmentIndex]
    const shift = edited && note && point.time >= note.start ? segmentShift(document, note.id) / 100 : 0
    const y = (topMidi - point.midi - shift + 0.5) * rowHeight
    path += `${point.time - previousTime > 0.08 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    previousTime = point.time
    previousX = x
  }
  return path
}

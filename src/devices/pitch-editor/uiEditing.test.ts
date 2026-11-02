import { describe, expect, it } from 'vitest'
import { PITCH_LIMITS, type PitchEditDocument } from './model'
import { mergeCandidate, mergeSegments, pitchCurvePath, scopeSegments, segmentShift, shiftSegments, splitSegment } from './uiEditing'

const document = (): PitchEditDocument => {
  const notes = [
    { id: 'a', start: 0, end: 1, midi: 60, confidence: 0.95 },
    { id: 'b', start: 1, end: 2, midi: 62, confidence: 0.9 },
    { id: 'c', start: 3, end: 4, midi: 64, confidence: 0.8 },
  ]
  return {
    version: 1, sourceAssetId: 'source', sourceHash: 'a'.repeat(64), rendererId: 'test',
    analysis: { version: 1, algorithm: 'yin-v1', sampleRate: 48000, sourceFrames: 192000, notes, contour: [
      { time: 0.1, midi: 59.8, confidence: 0.95 }, { time: 0.2, midi: 60, confidence: 0.95 },
      { time: 0.7, midi: 60.4, confidence: 0.95 }, { time: 0.8, midi: 60.6, confidence: 0.95 },
      { time: 1.2, midi: 62, confidence: 0.9 },
    ] },
    segments: notes.map(note => ({ ...note })), shifts: {},
  }
}

describe('pitch editor non-destructive operations', () => {
  it('changes only selected pitch deltas and preserves the source analysis', () => {
    const source = document(), before = structuredClone(source)
    const edited = shiftSegments(source, new Set(['a']), 125.5)
    expect(edited.shifts).toEqual({ a: 125.5 })
    expect(edited.analysis).toBe(source.analysis)
    expect(edited.segments).toBe(source.segments)
    expect(source).toEqual(before)
    expect(shiftSegments(edited, new Set(['a']), 0, true).shifts).toEqual({})
  })

  it('bounds pitch changes and ignores invalid or missing selections', () => {
    const source = document()
    expect(shiftSegments(source, new Set(['a', 'b']), 5000).shifts).toEqual({ a: 1200, b: 1200 })
    expect(shiftSegments(source, new Set(['a']), -5000).shifts).toEqual({ a: -1200 })
    expect(shiftSegments(source, new Set(['a']), Number.NaN)).toBe(source)
    expect(shiftSegments(source, new Set(['unknown']), 50)).toBe(source)
  })

  it('does not interpret inherited property names as existing shifts', () => {
    const source = document()
    source.segments[0] = { ...source.segments[0], id: '__proto__' }
    expect(segmentShift(source, '__proto__')).toBe(0)
    const edited = shiftSegments(source, new Set(['__proto__']), 100)
    expect(segmentShift(edited, '__proto__')).toBe(100)
    expect(Object.getPrototypeOf(edited.shifts)).toBe(null)
    expect({}).not.toHaveProperty('cents')
  })

  it('splits source intervals without moving audio and inherits the pitch correction', () => {
    const source = shiftSegments(document(), new Set(['a']), -35)
    const result = splitSegment(source, 'a', 0.5, 'right')
    expect(result.segments.slice(0, 2)).toMatchObject([
      { id: 'a', start: 0, end: 0.5, midi: 59.9 },
      { id: 'right', start: 0.5, end: 1, midi: 60.5 },
    ])
    expect(result.shifts).toEqual({ a: -35, right: -35 })
    expect(result.analysis).toBe(source.analysis)
    expect(source.segments).toHaveLength(3)
    expect(splitSegment(source, 'a', 0.01, 'tiny')).toBe(source)
    expect(splitSegment(source, 'a', 0.5, 'b')).toBe(source)
  })

  it('merges contiguous equally shifted notes while preserving their pitch curve', () => {
    const source = shiftSegments(document(), new Set(['a', 'b']), 40)
    const result = mergeSegments(source, new Set(['a', 'b']))
    expect(result.segments).toHaveLength(2)
    expect(result.segments[0]).toMatchObject({ id: 'a', start: 0, end: 2, confidence: 0.9 })
    expect(result.shifts).toEqual({ a: 40 })
    expect(result.analysis.contour).toBe(source.analysis.contour)
  })

  it('rejects non-adjacent, widely separated or differently corrected merges', () => {
    const source = document()
    expect(mergeCandidate(source, new Set(['a', 'c']))).toBe(null)
    expect(mergeSegments(source, new Set(['b', 'c']))).toBe(source)
    const shifted = shiftSegments(source, new Set(['a']), 100)
    expect(mergeSegments(shifted, new Set(['a', 'b']))).toBe(shifted)
  })

  it('splits at trim boundaries so the visible piece can be edited independently', () => {
    const source = shiftSegments(document(), new Set(['a']), 20)
    let sequence = 0
    const scoped = scopeSegments(source, 0.2, 0.8, () => `scope-${++sequence}`)
    expect(scoped.segments.slice(0, 3).map(note => [note.start, note.end])).toEqual([[0, 0.2], [0.2, 0.8], [0.8, 1]])
    expect(scoped.shifts).toEqual({ a: 20, 'scope-1': 20, 'scope-2': 20 })
    const changed = shiftSegments(scoped, new Set(['scope-1']), 100)
    expect(changed.shifts).toEqual({ a: 20, 'scope-1': 120, 'scope-2': 20 })
    expect(scoped.analysis).toBe(source.analysis)
    expect(source.segments).toHaveLength(3)
  })

  it('preserves short source tails at boundaries without manual note-size rounding', () => {
    let id = 0
    const scoped = scopeSegments(document(), 0.001, 0.999, () => `short-${++id}`)
    expect(scoped.segments[0].end).toBe(0.001)
    expect(scoped.segments[2].start).toBe(0.999)
    expect(scoped.segments[2].end).toBe(1)
  })

  it('keeps a document unchanged when scoping would exceed the note bound', () => {
    const source = document()
    source.segments = Array.from({ length: PITCH_LIMITS.maxNotes - 1 }, (_, i) => ({ id: `n${i}`, start: i, end: i + 1, midi: 60, confidence: 1 }))
    let id = 0
    expect(scopeSegments(source, 0.5, 1.5, () => `cut-${++id}`)).toBe(source)
  })

  it('keeps raw and edited curves distinct and never bridges a long silent gap', () => {
    const source = document()
    source.analysis.contour = [
      { time: 0.1, midi: 60, confidence: 1 }, { time: 0.12, midi: 60.5, confidence: 1 },
      { time: 1.2, midi: 62, confidence: 1 },
    ]
    const edited = shiftSegments(source, new Set(['a']), 100)
    const raw = pitchCurvePath(edited, 0, 2, 100, 70, 18, false)
    const curve = pitchCurvePath(edited, 0, 2, 100, 70, 18, true)
    expect(raw.match(/M/g)).toHaveLength(2)
    expect(curve.match(/M/g)).toHaveLength(2)
    expect(curve).not.toBe(raw)
    expect(curve.split('M').at(-1)).toBe(raw.split('M').at(-1))
  })
})

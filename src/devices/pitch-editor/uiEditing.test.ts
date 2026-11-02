import { describe, expect, it } from 'vitest'
import { PITCH_LIMITS, type PitchEditDocument } from './model'
import { hasUnsupportedFormantCombination, mergeCandidate, mergeSegments, pitchCurvePath, scopeSegments, segmentFormantShift, segmentShift, shiftFormants, shiftSegments, splitSegment, visibleSelectionIds } from './uiEditing'

const document = (): PitchEditDocument => {
  const notes = [
    { id: 'a', start: 0, end: 1, midi: 60, confidence: 0.95 },
    { id: 'b', start: 1, end: 2, midi: 62, confidence: 0.9 },
    { id: 'c', start: 3, end: 4, midi: 64, confidence: 0.8 },
  ]
  return {
    version: 2, sourceAssetId: 'source', sourceHash: 'a'.repeat(64), rendererId: 'test',
    analysis: { version: 1, algorithm: 'yin-v1', sampleRate: 48000, sourceFrames: 192000, notes, contour: [
      { time: 0.1, midi: 59.8, confidence: 0.95 }, { time: 0.2, midi: 60, confidence: 0.95 },
      { time: 0.7, midi: 60.4, confidence: 0.95 }, { time: 0.8, midi: 60.6, confidence: 0.95 },
      { time: 1.2, midi: 62, confidence: 0.9 },
    ] },
    segments: notes.map(note => ({ ...note })), shifts: {}, preserveFormants: false, formantShifts: {},
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

  it('changes selected formant offsets without changing pitch, contour, or other notes', () => {
    const source = shiftSegments(document(), new Set(['a']), 100), before = structuredClone(source)
    const edited = shiftFormants(source, new Set(['a']), -235.5, true)
    expect(edited.formantShifts).toEqual({ a: -235.5 })
    expect(edited.shifts).toBe(source.shifts)
    expect(edited.analysis).toBe(source.analysis)
    expect(edited.segments).toBe(source.segments)
    expect(edited.preserveFormants).toBe(false)
    expect(source).toEqual(before)
    expect(shiftFormants(edited, new Set(['a']), 0, true).formantShifts).toEqual({})
    expect(shiftFormants(source, new Set(['a']), -5000).formantShifts).toEqual({ a: -1200 })
    expect(shiftFormants(source, new Set(['a']), 5000).formantShifts).toEqual({ a: 1200 })
    expect(shiftFormants(source, new Set(['a']), Number.NaN)).toBe(source)
    expect(shiftFormants(source, new Set(['missing']), 100)).toBe(source)
  })

  it('allows exact ±1200-cent internal formant boundaries and detects an excess in either direction', () => {
    const source: PitchEditDocument = { ...document(), preserveFormants: true, shifts: { a: 600, b: -600 }, formantShifts: { a: -600, b: 600 } }
    expect(hasUnsupportedFormantCombination(source)).toBe(false)
    expect(hasUnsupportedFormantCombination(shiftFormants(source, new Set(['a']), -600.1, true))).toBe(true)
    expect(hasUnsupportedFormantCombination(shiftFormants(source, new Set(['b']), 600.1, true))).toBe(true)
    expect(hasUnsupportedFormantCombination({ ...source, shifts: { a: 1200, b: -1200 }, formantShifts: {} })).toBe(false)
    expect(hasUnsupportedFormantCombination({ ...source, shifts: { a: 1200, b: -1200 }, formantShifts: { a: 1200, b: -1200 } })).toBe(false)
  })

  it('keeps unsupported settings editable and allows recovery by moving formants or disabling preservation', () => {
    const source: PitchEditDocument = { ...document(), preserveFormants: true, shifts: { a: 1200, b: -1200 }, formantShifts: { a: -1200, b: 1200 } }
    expect(hasUnsupportedFormantCombination(source)).toBe(true)
    const corrected = shiftFormants(source, new Set(['a', 'b']), 0, true)
    expect(hasUnsupportedFormantCombination(corrected)).toBe(false)
    expect(hasUnsupportedFormantCombination({ ...source, preserveFormants: false })).toBe(false)
    expect(source.formantShifts).toEqual({ a: -1200, b: 1200 })
  })

  it('checks rendered notes beyond the current visible selection', () => {
    const source: PitchEditDocument = { ...document(), preserveFormants: true, shifts: { c: 1200 }, formantShifts: { c: -100 } }
    expect(visibleSelectionIds(source, new Set(['a', 'b', 'c']), 0, 1)).toEqual(new Set(['a']))
    expect(hasUnsupportedFormantCombination(source)).toBe(true)
    expect(hasUnsupportedFormantCombination(shiftFormants(source, new Set(['c']), 0, true))).toBe(false)
  })

  it('does not interpret inherited property names as existing shifts', () => {
    const source = document()
    source.segments[0] = { ...source.segments[0], id: '__proto__' }
    expect(segmentShift(source, '__proto__')).toBe(0)
    const edited = shiftSegments(source, new Set(['__proto__']), 100)
    expect(segmentShift(edited, '__proto__')).toBe(100)
    expect(Object.getPrototypeOf(edited.shifts)).toBe(null)
    expect(segmentFormantShift(source, '__proto__')).toBe(0)
    const formants = shiftFormants(edited, new Set(['__proto__']), 200)
    expect(segmentFormantShift(formants, '__proto__')).toBe(200)
    expect(Object.getPrototypeOf(formants.formantShifts)).toBe(null)
    expect({}).not.toHaveProperty('cents')
  })

  it('splits source intervals without moving audio and inherits the pitch correction', () => {
    const source = shiftFormants(shiftSegments(document(), new Set(['a']), -35), new Set(['a']), 175)
    const result = splitSegment(source, 'a', 0.5, 'right')
    expect(result.segments.slice(0, 2)).toMatchObject([
      { id: 'a', start: 0, end: 0.5, midi: 59.9 },
      { id: 'right', start: 0.5, end: 1, midi: 60.5 },
    ])
    expect(result.shifts).toEqual({ a: -35, right: -35 })
    expect(result.formantShifts).toEqual({ a: 175, right: 175 })
    const editedRight = shiftFormants(result, new Set(['right']), -25)
    expect(editedRight.formantShifts).toEqual({ a: 175, right: 150 })
    expect(result.formantShifts).toEqual({ a: 175, right: 175 })
    expect(result.analysis).toBe(source.analysis)
    expect(source.segments).toHaveLength(3)
    expect(splitSegment(source, 'a', 0.01, 'tiny')).toBe(source)
    expect(splitSegment(source, 'a', 0.5, 'b')).toBe(source)
  })

  it('merges contiguous equally shifted notes while preserving their pitch curve', () => {
    const source = shiftFormants(shiftSegments(document(), new Set(['a', 'b']), 40), new Set(['a', 'b']), -80)
    const result = mergeSegments(source, new Set(['a', 'b']))
    expect(result.segments).toHaveLength(2)
    expect(result.segments[0]).toMatchObject({ id: 'a', start: 0, end: 2, confidence: 0.9 })
    expect(result.shifts).toEqual({ a: 40 })
    expect(result.formantShifts).toEqual({ a: -80 })
    expect(source.formantShifts).toEqual({ a: -80, b: -80 })
    expect(result.analysis.contour).toBe(source.analysis.contour)
  })

  it('rejects non-adjacent, widely separated or differently corrected merges', () => {
    const source = document()
    expect(mergeCandidate(source, new Set(['a', 'c']))).toBe(null)
    expect(mergeSegments(source, new Set(['b', 'c']))).toBe(source)
    const shifted = shiftSegments(source, new Set(['a']), 100)
    expect(mergeSegments(shifted, new Set(['a', 'b']))).toBe(shifted)
    const formantShifted = shiftFormants(source, new Set(['b']), 100)
    expect(mergeCandidate(formantShifted, new Set(['a', 'b']))).toBe(null)
    expect(mergeSegments(formantShifted, new Set(['a', 'b']))).toBe(formantShifted)
    const opposing = shiftFormants(shiftFormants(source, new Set(['a']), 100), new Set(['b']), -100)
    expect(mergeSegments(opposing, new Set(['a', 'b']))).toBe(opposing)
  })

  it('splits at trim boundaries so the visible piece can be edited independently', () => {
    const source = shiftFormants(shiftSegments(document(), new Set(['a']), 20), new Set(['a']), 300)
    let sequence = 0
    const scoped = scopeSegments(source, 0.2, 0.8, () => `scope-${++sequence}`)
    expect(scoped.segments.slice(0, 3).map(note => [note.start, note.end])).toEqual([[0, 0.2], [0.2, 0.8], [0.8, 1]])
    expect(scoped.shifts).toEqual({ a: 20, 'scope-1': 20, 'scope-2': 20 })
    expect(scoped.formantShifts).toEqual({ a: 300, 'scope-1': 300, 'scope-2': 300 })
    const changed = shiftSegments(scoped, new Set(['scope-1']), 100)
    expect(changed.shifts).toEqual({ a: 20, 'scope-1': 120, 'scope-2': 20 })
    const formants = shiftFormants(changed, new Set(['scope-1']), 100)
    expect(formants.formantShifts).toEqual({ a: 300, 'scope-1': 400, 'scope-2': 300 })
    expect(source.formantShifts).toEqual({ a: 300 })
    expect(scoped.analysis).toBe(source.analysis)
    expect(source.segments).toHaveLength(3)
  })

  it('excludes retained hidden selections at trim and BPM boundaries', () => {
    const source = document()
    let id = 0
    const scoped = scopeSegments(source, 0.2, 0.8, () => `visible-${++id}`)
    const retained = new Set(scoped.segments.map(note => note.id))
    const visible = visibleSelectionIds(scoped, retained, 0.2, 0.8)
    expect([...visible]).toEqual(['visible-1'])
    const edited = shiftFormants(scoped, visible, 120)
    expect(edited.formantShifts).toEqual({ 'visible-1': 120 })
    expect(visibleSelectionIds(scoped, retained, 1, 2)).toEqual(new Set(['b']))
    expect(visibleSelectionIds(source, new Set(['a']), 1e-9, 1 - 1e-9)).toEqual(new Set(['a']))
    expect(visibleSelectionIds(source, new Set(['a']), 0.0001, 0.9999)).toEqual(new Set())
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

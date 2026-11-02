import { describe, expect, it } from 'vitest'
import { correctSelectedPitch, nearestScalePitch, readPitchCorrectionSettings, rememberPitchCorrectionSettings, type PitchCorrectionOptions } from './correction'
import { PITCH_LIMITS, type PitchEditDocument } from './model'
import { mergeSegments, pitchCurvePath, scopeSegments, shiftFormants, shiftSegments, visibleSelectionIds } from './uiEditing'

const options: PitchCorrectionOptions = { root: 0, scale: 'major', strength: 100, skipUncertain: true }
const document = (): PitchEditDocument => {
  const notes = [
    { id: 'a', start: 0, end: 1, midi: 60.4, confidence: 0.95 },
    { id: 'b', start: 1, end: 2, midi: 61.6, confidence: 0.75 },
    { id: 'c', start: 2, end: 3, midi: 63.2, confidence: 0.749 },
    { id: 'd', start: 3, end: 4, midi: 67.4, confidence: 0.9 },
  ]
  return {
    version: 2, sourceAssetId: 'source', sourceHash: 'a'.repeat(64), rendererId: 'test',
    analysis: { version: 1, algorithm: 'yin-v1', sampleRate: 48000, sourceFrames: 192000, notes, contour: [
      { time: 0.1, midi: 60.2, confidence: 0.95 },
      { time: 0.14, midi: 60.6, confidence: 0.95 },
      { time: 0.18, midi: 60.3, confidence: 0.95 },
      { time: 1.2, midi: 61.6, confidence: 0.75 },
    ] },
    segments: notes.map(note => ({ ...note })), shifts: {}, preserveFormants: true, formantShifts: { a: 100 },
  }
}

describe('nearest scale center', () => {
  it('uses the smaller absolute move and a lower-note halfway tie', () => {
    expect(nearestScalePitch(60.49, 0, 'chromatic')).toBe(60)
    expect(nearestScalePitch(60.5, 0, 'chromatic')).toBe(60)
    expect(nearestScalePitch(60.50001, 0, 'chromatic')).toBe(61)
    expect(nearestScalePitch(61, 0, 'major')).toBe(60)
    expect(nearestScalePitch(61.001, 0, 'major')).toBe(62)
    expect(nearestScalePitch(60.4, 7, 'chromatic')).toBe(60)
  })

  it('respects the chosen root, scale, and octave boundary', () => {
    expect(nearestScalePitch(63.2, 0, 'major')).toBe(64)
    expect(nearestScalePitch(63.2, 0, 'natural-minor')).toBe(63)
    expect(nearestScalePitch(60, 11, 'major')).toBe(59)
    expect(nearestScalePitch(60.1, 11, 'major')).toBe(61)
    expect(nearestScalePitch(72.2, 11, 'major')).toBe(73)
    expect(nearestScalePitch(70.2, 9, 'natural-minor')).toBe(71)
    expect(nearestScalePitch(128.2, 0, 'major')).toBe(129)
  })

  it('handles negative MIDI centers and signed roots without JavaScript modulo errors', () => {
    expect(nearestScalePitch(-0.5, 0, 'chromatic')).toBe(-1)
    expect(nearestScalePitch(-12.5, 0, 'chromatic')).toBe(-13)
    expect(nearestScalePitch(-11, 0, 'major')).toBe(-12)
    expect(nearestScalePitch(-10.9, 0, 'major')).toBe(-10)
    expect(nearestScalePitch(0, -1, 'major')).toBe(-1)
    expect(nearestScalePitch(-12, 11, 'major')).toBe(-13)
  })
})

describe('selected-note pitch correction', () => {
  it('makes strength 0 a no-op, 50 a half move, and 100 the exact scale center', () => {
    const source = document(), ids = new Set(['a'])
    const zero = correctSelectedPitch(source, ids, { ...options, strength: 0 })
    expect(zero.document).toBe(source)
    expect(zero.changed).toBe(0)
    const half = correctSelectedPitch(source, ids, { ...options, strength: 50 })
    expect(half.document.shifts).toEqual({ a: -20 })
    const repeated = correctSelectedPitch(half.document, ids, { ...options, strength: 50 })
    expect(repeated.document.shifts).toEqual({ a: -30 })
    const full = correctSelectedPitch(source, ids, options)
    expect(full.document.shifts).toEqual({ a: -40 })
    expect(correctSelectedPitch(full.document, ids, options).document).toBe(full.document)
  })

  it('uses the edited center and retains the manual-shift baseline', () => {
    const source = shiftSegments(document(), new Set(['a']), 120)
    // 60.4 + 1.2 = 61.6, so C major targets D4 (62), not the source C4.
    expect(correctSelectedPitch(source, new Set(['a']), options).document.shifts).toEqual({ a: 160 })
    expect(correctSelectedPitch(source, new Set(['a']), { ...options, strength: 50 }).document.shifts).toEqual({ a: 140 })
  })

  it('changes selected notes only and uses confidence 0.75 as an inclusive threshold', () => {
    const source = shiftSegments(document(), new Set(['d']), 55)
    const result = correctSelectedPitch(source, new Set(['a', 'b', 'c', 'missing']), options)
    expect(result.document.shifts).toEqual({ a: -40, b: 40, d: 55 })
    expect(result.changed).toBe(2)
    expect(result.skipped).toBe(1)
    const included = correctSelectedPitch(source, new Set(['c']), { ...options, skipUncertain: false })
    expect(included.document.shifts).toEqual({ c: 80, d: 55 })
    expect(included.skipped).toBe(0)
  })

  it('leaves source analysis, formants, and the vibrato shape immutable', () => {
    const source = document(), before = structuredClone(source)
    const result = correctSelectedPitch(source, new Set(['a']), options).document
    expect(result.analysis).toBe(source.analysis)
    expect(result.segments).toBe(source.segments)
    expect(result.formantShifts).toBe(source.formantShifts)
    expect(result.preserveFormants).toBe(true)
    expect(source).toEqual(before)
    const yValues = (path: string) => [...path.matchAll(/[ML][\d.]+,(-?[\d.]+)/g)].map(match => Number(match[1]))
    const beforeY = yValues(pitchCurvePath(source, 0, 0.5, 100, 70, 10, true))
    const afterY = yValues(pitchCurvePath(result, 0, 0.5, 100, 70, 10, true))
    expect(beforeY).toHaveLength(3)
    expect(afterY.map((value, index) => value - beforeY[index])).toEqual([4, 4, 4])
  })

  it('keeps hidden trim pieces untouched even when their selection is retained', () => {
    let id = 0
    const scoped = scopeSegments(document(), 0.2, 0.8, () => `trim-${++id}`)
    const selected = new Set(scoped.segments.map(note => note.id))
    const ids = visibleSelectionIds(scoped, selected, 0.2, 0.8)
    const result = correctSelectedPitch(scoped, ids, options)
    expect(result.document.shifts).toEqual({ 'trim-1': -40 })
    expect(result.changed).toBe(1)
    expect(result.skipped).toBe(0)
  })

  it('keeps an unsplit boundary note read-only at the 4096-note cap while other notes remain editable', () => {
    const source = document()
    source.segments = Array.from({ length: PITCH_LIMITS.maxNotes }, (_, index) => ({
      id: `cap-${index}`, start: index === 0 ? 0 : 1 + (index - 1) * 0.01,
      end: index === 0 ? 1 : 1 + index * 0.01, midi: 60.4, confidence: 1,
    }))
    source.analysis = { ...source.analysis, sourceFrames: 48000 * 60, notes: source.segments.map(note => ({ ...note })), contour: [] }
    source.shifts = { 'cap-0': 75 }
    source.formantShifts = { 'cap-0': 200 }
    const before = structuredClone(source)
    const scoped = scopeSegments(source, 0.25, 1.02, () => 'new-boundary')
    expect(scoped).toBe(source)
    const retained = new Set(source.segments.map(note => note.id))
    const visible = visibleSelectionIds(scoped, retained, 0.25, 1.02)
    expect(visible).toEqual(new Set(['cap-1', 'cap-2']))
    const pitch = shiftSegments(scoped, visible, 100)
    expect(pitch.shifts).toEqual({ 'cap-0': 75, 'cap-1': 100, 'cap-2': 100 })
    const formants = shiftFormants(scoped, visible, 300)
    expect(formants.formantShifts).toEqual({ 'cap-0': 200, 'cap-1': 300, 'cap-2': 300 })
    const corrected = correctSelectedPitch(scoped, visible, options)
    expect(corrected.document.shifts).toEqual({ 'cap-0': 75, 'cap-1': -40, 'cap-2': -40 })
    expect(corrected.changed).toBe(2)
    expect(corrected.document.formantShifts['cap-0']).toBe(200)
    const hiddenSelection = visibleSelectionIds(scoped, new Set(['cap-0']), 0.25, 1.02)
    expect(shiftSegments(scoped, hiddenSelection, 0, true)).toBe(scoped)
    expect(shiftFormants(scoped, hiddenSelection, 0, true)).toBe(scoped)
    expect(correctSelectedPitch(scoped, hiddenSelection, options).document).toBe(scoped)
    const merged = mergeSegments(scoped, visible)
    expect(merged.segments).toHaveLength(PITCH_LIMITS.maxNotes - 1)
    const rescope = scopeSegments(merged, 0.25, 1.02, () => 'freed-boundary')
    expect(rescope.segments).toHaveLength(PITCH_LIMITS.maxNotes)
    expect(rescope.shifts['freed-boundary']).toBe(75)
    expect(rescope.formantShifts['freed-boundary']).toBe(200)
    expect(source).toEqual(before)
  })

  it('reports scale targets outside cumulative ±1200 cents and clamps both directions', () => {
    const source = document()
    const raised = shiftSegments(source, new Set(['b']), 1195)
    const upper = correctSelectedPitch(raised, new Set(['b']), { ...options, scale: 'chromatic' })
    expect(upper.document.shifts.b).toBe(1200)
    expect(upper.limited).toBe(1)
    const lowered = shiftSegments(source, new Set(['a']), -1195)
    const lower = correctSelectedPitch(lowered, new Set(['a']), { ...options, scale: 'chromatic' })
    expect(lower.document.shifts.a).toBe(-1200)
    expect(lower.limited).toBe(1)
    const stillLimited = correctSelectedPitch(lower.document, new Set(['a']), { ...options, scale: 'chromatic' })
    expect(stillLimited.document).toBe(lower.document)
    expect(stillLimited.limited).toBe(1)
  })

  it('ignores empty selections and invalid strength without creating an undoable edit', () => {
    const source = document()
    expect(correctSelectedPitch(source, new Set(), options).document).toBe(source)
    expect(correctSelectedPitch(source, new Set(['missing']), options).document).toBe(source)
    for (const strength of [Number.NaN, Infinity, -1, 101]) {
      expect(correctSelectedPitch(source, new Set(['a']), { ...options, strength }).document).toBe(source)
    }
  })
})

describe('correction tool session settings', () => {
  it('restores a project preference after reopening and isolates other projects', () => {
    const settings: PitchCorrectionOptions = { root: 9, scale: 'natural-minor', strength: 50, skipUncertain: false }
    rememberPitchCorrectionSettings('session-project-a', settings)
    expect(readPitchCorrectionSettings('session-project-a')).toEqual(settings)
    expect(readPitchCorrectionSettings('session-project-b')).toEqual({ root: 0, scale: 'chromatic', strength: 100, skipUncertain: true })
    rememberPitchCorrectionSettings('session-project-b', { root: 5, scale: 'major', strength: 80, skipUncertain: true })
    expect(readPitchCorrectionSettings('session-project-a')).toEqual(settings)
    const reopened = readPitchCorrectionSettings('session-project-a')
    reopened.strength = 20
    expect(readPitchCorrectionSettings('session-project-a').strength).toBe(50)
  })
})

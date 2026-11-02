import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioClip } from '../../core/types'
import type { PitchEditDocument } from './model'
import { enterPitchDraftProject, firstPitchDraftId, pitchDrafts, reconcilePitchDrafts, scopePitchSnapshot, type PitchDraftSnapshot } from './draftCache'
import { segmentShift, shiftSegments } from './uiEditing'

const clip = (id = 'clip'): AudioClip => ({ id, kind: 'audio', name: 'Voice', startBeat: 0, lengthBeats: 8, gain: 1, assetId: 'asset', offsetSeconds: 0, fadeIn: 0, fadeOut: 0 })
const document = (): PitchEditDocument => {
  const notes = [{ id: 'note', start: 0, end: 4, midi: 60, confidence: 1 }]
  return { version: 1, sourceAssetId: 'asset', sourceHash: 'a'.repeat(64), rendererId: 'test', analysis: { version: 1, algorithm: 'yin-v1', sampleRate: 48000, sourceFrames: 192000, notes, contour: [] }, segments: notes.map(note => ({ ...note })), shifts: {} }
}
function storeDraft(source: AudioClip) {
  pitchDrafts.set(source.id, { base: source.pitch, sourceId: source.pitch?.sourceAssetId ?? source.assetId, offset: source.offsetSeconds, length: source.lengthBeats, bpm: 120, name: source.name, snapshot: { document: document(), dirty: true }, past: [], future: [], selection: [] })
}

describe('pitch draft cache across editor unmounts', () => {
  beforeEach(() => { pitchDrafts.clear(); enterPitchDraftProject('project') })

  it('keeps a draft when its clip is renamed or moved without changing the source', () => {
    const source = clip(); storeDraft(source)
    expect(reconcilePitchDrafts('project', [{ ...source, name: 'Renamed', startBeat: 16, gain: 0.8 }], 120)).toBe(true)
    expect(firstPitchDraftId('project')).toBe(source.id)
  })

  it('removes a deleted clip but preserves another clip’s unapplied work', () => {
    const first = clip('first'), second = clip('second')
    storeDraft(first); storeDraft(second)
    expect(reconcilePitchDrafts('project', [second], 120)).toBe(true)
    expect(pitchDrafts.has(first.id)).toBe(false)
    expect(firstPitchDraftId('project')).toBe('second')
    expect(reconcilePitchDrafts('project', [], 120)).toBe(false)
  })

  it('reports the conflict when Undo or import replaces the applied pitch document', () => {
    const source = { ...clip(), pitch: document() }; storeDraft(source)
    const conflict = vi.fn()
    expect(reconcilePitchDrafts('project', [source], 120)).toBe(true)
    expect(reconcilePitchDrafts('project', [{ ...source, pitch: structuredClone(source.pitch) }], 120, conflict)).toBe(false)
    expect(conflict).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/Voice.*적용된 피치 상태가 바뀌어.*초기화/))
  })

  it('invalidates and reports a draft whose original asset was replaced', () => {
    const source = clip(); storeDraft(source)
    const conflict = vi.fn()
    expect(reconcilePitchDrafts('project', [{ ...source, assetId: 'new-source' }], 120, conflict)).toBe(false)
    expect(conflict).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/원본 음원이 바뀌어/))
  })

  it('preserves draft and local history through trims, tempo changes and timeline Undo while unmounted', () => {
    const source = clip(); storeDraft(source)
    const draft = pitchDrafts.get(source.id)!
    const original = document()
    draft.past = [{ document: original, dirty: false }]
    draft.snapshot = { document: shiftSegments(original, new Set(['note']), 100), dirty: true }
    draft.future = [{ document: shiftSegments(original, new Set(['note']), 200), dirty: true }]
    const conflict = vi.fn()
    expect(reconcilePitchDrafts('project', [{ ...source, offsetSeconds: 0.5, lengthBeats: 2 }], 96, conflict)).toBe(true)
    expect(pitchDrafts.get(source.id)).toBe(draft)
    expect(draft.snapshot.document!.shifts).toEqual({ note: 100 })
    expect(draft.past[0].document).toBe(original)
    expect(draft.future[0].document!.shifts).toEqual({ note: 200 })
    // A timeline Undo restores the former window without discarding the same source-time draft.
    expect(reconcilePitchDrafts('project', [source], 120, conflict)).toBe(true)
    expect(pitchDrafts.get(source.id)).toBe(draft)
    expect(conflict).not.toHaveBeenCalled()
  })

  it('scopes a restored draft and its Undo/Redo snapshots without moving or losing hidden source edits', () => {
    const original = document()
    const shifted: PitchDraftSnapshot = { document: shiftSegments(original, new Set(['note']), 100), dirty: true }
    const historyBefore: PitchDraftSnapshot = { document: original, dirty: false }
    let sequence = 0
    const makeId = () => `scope-${++sequence}`
    const restored = scopePitchSnapshot(shifted, 0.5, 1.5, makeId)
    expect(restored.dirty).toBe(true)
    expect(restored.document!.analysis).toBe(original.analysis)
    expect(restored.document!.segments.map(note => [note.start, note.end])).toEqual([[0, 0.5], [0.5, 1.5], [1.5, 4]])
    const visible = restored.document!.segments[1]
    const edited = shiftSegments(restored.document!, new Set([visible.id]), 50)
    expect(edited.segments.map(note => segmentShift(edited, note.id))).toEqual([100, 150, 100])

    // This is the same restore path used by local Undo after a viewport change.
    const undo = scopePitchSnapshot(historyBefore, 0.5, 1.5, makeId)
    expect(undo.dirty).toBe(false)
    expect(undo.document!.segments.map(note => segmentShift(undo.document!, note.id))).toEqual([0, 0, 0])
    const redo = scopePitchSnapshot({ document: edited, dirty: true }, 0.5, 1.5, makeId)
    expect(redo.document).toBe(edited)
    expect(redo.document!.segments.map(note => segmentShift(redo.document!, note.id))).toEqual([100, 150, 100])

    // Expanding the view exposes the preserved outer edits; historical documents were never mutated.
    expect(scopePitchSnapshot(redo, 0, 4, makeId)).toBe(redo)
    expect(original.segments).toHaveLength(1)
    expect(original.shifts).toEqual({})
    expect(shifted.document!.shifts).toEqual({ note: 100 })
    const empty: PitchDraftSnapshot = { document: null, dirty: false }
    expect(scopePitchSnapshot(empty, 0.5, 1.5, makeId)).toBe(empty)
  })

  it('never carries drafts into another project even when clip IDs match', () => {
    const source = clip(); storeDraft(source)
    expect(firstPitchDraftId('other-project')).toBeUndefined()
    expect(reconcilePitchDrafts('other-project', [source], 120)).toBe(false)
    expect(pitchDrafts.size).toBe(0)
  })
})

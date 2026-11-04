import { describe, expect, it } from 'vitest'
import { applyMidiNoteEdits, midiEditorClip, visibleMidiNotes } from './midiRegions'
import { audioWindows, clipOccurrences, loopEnd, midiEvents } from './playback'
import { ProjectSession } from './ProjectSession'
import { createEmptyProject, createTrack, duplicateClip, fitProjectLength, joinClips, setClipLoopEnd, splitClip, trimClipEnd, trimClipStart, validateProject } from './project'
import { exportProjectBundle, importProjectBundle } from './storage'
import type { AudioClip, Clip, MidiClip, MidiNote, Project } from './types'

const note = (id: string, start: number, duration: number, pitch = 60): MidiNote => ({ id, start, duration, pitch, velocity: 0.7 })
const phrase = (): MidiClip => ({
  id: 'phrase', kind: 'midi', name: 'Phrase', startBeat: 8, lengthBeats: 8, gain: 1,
  notes: [note('hidden', 0, 1), note('crossing', 1, 3, 64), note('later', 5, 1, 67), note('tail', 7, 2, 72)],
})
function projectWith(...clips: Clip[]): Project {
  const project = createEmptyProject()
  project.id = 'project'
  project.tracks = [{ ...createTrack(clips[0]?.kind === 'audio' ? 'audio' : 'instrument'), id: 'track', clips }]
  return project
}
function asMidi(clip: Clip): MidiClip {
  if (clip.kind !== 'midi') throw new Error('Expected MIDI clip')
  return clip
}
const events = (clip: MidiClip) => midiEvents(projectWith(clip).tracks[0], 64).map(({ pitch, start, end }) => ({ pitch, start, end }))

describe('recoverable MIDI source windows', () => {
  it('loads legacy versions 1–4 as version 5 without changing their note playback', () => {
    const current = projectWith(phrase())
    for (const schemaVersion of [1, 2, 3, 4]) {
      const legacy = { ...current, schemaVersion, tracks: current.tracks.map(track => ({ ...track, effects: { filter: 20000, reverb: 0, delay: 0 } })) }
      const loaded = validateProject(legacy)
      expect(loaded).toEqual(current)
      expect(loaded.schemaVersion).toBe(6)
      expect(events(asMidi(loaded.tracks[0].clips[0]))).toEqual(events(phrase()))
    }
  })

  it('restores hidden and boundary-spanning notes after trim, save/load, and re-expansion', () => {
    const original = phrase()
    const trimmed = asMidi(trimClipEnd(trimClipStart(original, 10, 120), 14))
    expect(trimmed.sourceOffsetBeats).toBe(2)
    expect(trimmed.notes).toBe(original.notes)
    expect(visibleMidiNotes(trimmed)).toEqual([
      { ...original.notes[1], start: 0, duration: 2 }, { ...original.notes[2], start: 3 },
    ])
    expect(events(trimmed)).toEqual([{ pitch: 64, start: 10, end: 12 }, { pitch: 67, start: 13, end: 14 }])
    const loaded = validateProject(JSON.parse(JSON.stringify(projectWith(trimmed)))).tracks[0].clips[0]
    const restored = asMidi(trimClipEnd(trimClipStart(loaded, 8, 120), 16))
    expect(restored).toEqual(original)
    expect(restored.notes.map(item => item.id)).toEqual(original.notes.map(item => item.id))
  })

  it('keeps hidden notes and original note edges when changing a visible pitch or velocity', () => {
    const original = phrase(), trimmed = asMidi(trimClipStart(original, 10, 120))
    const view = midiEditorClip(trimmed)
    expect(view.sourceOffsetBeats).toBeUndefined()
    expect(view.notes.map(item => item.id)).toEqual(['crossing', 'later', 'tail'])
    expect(applyMidiNoteEdits(trimmed, view.notes)).toBe(trimmed)
    const edited = applyMidiNoteEdits(trimmed, view.notes.map(item => item.id === 'crossing' ? { ...item, pitch: 65, velocity: 0.9 } : item))
    const restored = asMidi(trimClipStart(edited, 8, 120))
    expect(restored.notes).toEqual(original.notes.map(item => item.id === 'crossing' ? { ...item, pitch: 65, velocity: 0.9 } : item))
    expect(original.notes[1]).toMatchObject({ pitch: 64, velocity: 0.7, start: 1, duration: 3 })
  })

  it('maps visible insert/delete/resize edits to the source without changing hidden notes', () => {
    const trimmed = asMidi(trimClipStart(phrase(), 10, 120)), view = visibleMidiNotes(trimmed)
    const edited = applyMidiNoteEdits(trimmed, [
      ...view.filter(item => item.id !== 'later').map(item => item.id === 'crossing' ? { ...item, duration: 1 } : item),
      note('new', 2.5, 0.5, 69),
    ])
    expect(edited.notes.find(item => item.id === 'hidden')).toEqual(phrase().notes[0])
    expect(edited.notes.find(item => item.id === 'later')).toBeUndefined()
    // Only the resized right edge changes; the portion before the trim remains recoverable.
    expect(edited.notes.find(item => item.id === 'crossing')).toMatchObject({ start: 1, duration: 2 })
    expect(edited.notes.find(item => item.id === 'new')).toMatchObject({ start: 4.5, duration: 0.5 })
    expect(visibleMidiNotes(edited).find(item => item.id === 'new')).toMatchObject({ start: 2.5 })
    expect(validateProject(projectWith(edited)).tracks[0].clips[0]).toEqual(edited)
  })

  it('allows leading silence before the source and keeps absolute note timing intact', () => {
    const original = phrase()
    const extended = asMidi(trimClipStart(trimClipStart(original, 10, 120), 6, 120))
    expect(extended.sourceOffsetBeats ?? 0).toBe(0)
    expect(extended.notes[0]).toMatchObject({ id: 'hidden', start: 2 })
    expect(events(extended)).toEqual(events(original))
    const added = applyMidiNoteEdits(extended, [note('intro', 0, 0.5), ...visibleMidiNotes(extended)])
    expect(validateProject(projectWith(added)).tracks[0].clips[0]).toEqual(added)
  })

  it('keeps separate recoverable sources for split/copy and materializes correct local notes when joining', () => {
    const trimmed = asMidi(trimClipStart(phrase(), 10, 120))
    const [left, right] = splitClip(trimmed, 12, 120).map(asMidi)
    expect(left.notes).toEqual(trimmed.notes)
    expect(right.sourceOffsetBeats).toBe(4)
    expect(right.notes.map(item => item.id).some(id => left.notes.some(item => item.id === id))).toBe(false)
    const rightRestored = asMidi(trimClipStart(right, 8, 120))
    expect(visibleMidiNotes(rightRestored).map(({ id: _id, ...value }) => value)).toEqual(visibleMidiNotes(phrase()).map(({ id: _id, ...value }) => value))
    const joined = asMidi(joinClips([left, right], 120)!)
    expect(joined.sourceOffsetBeats ?? 0).toBe(0)
    expect(events(joined)).toEqual(events(trimmed))
    const copy = asMidi(duplicateClip(trimmed, 20))
    expect(copy.sourceOffsetBeats).toBe(2)
    expect(events(copy)).toEqual(events(trimmed).map(item => ({ ...item, start: item.start + 10, end: item.end + 10 })))
    copy.notes[0].pitch = 12
    expect(trimmed.notes[0].pitch).toBe(60)
    expect(validateProject(projectWith(left, right, copy)).tracks[0].clips).toHaveLength(3)
  })

  it('retains the new fields through MCP move/repeat commands with fresh source note IDs', () => {
    const source = setClipLoopEnd(trimClipStart(phrase(), 10, 120), 19)
    const session = new ProjectSession(projectWith(source))
    session.execute({ projectId: 'project', expectedRevision: 0, operationId: 'repeat-window', commands: [
      { type: 'clip.move', clipId: source.id, startBeat: 20 },
      { type: 'clip.repeat', clipId: source.id, startBeat: 30, count: 2 },
    ] })
    const result = session.getSnapshot().history.present
    const clips = result.tracks[0].clips.map(asMidi)
    expect(clips.map(clip => [clip.startBeat, clip.sourceOffsetBeats, clip.loopLengthBeats])).toEqual([[20, 2, 9], [30, 2, 9], [36, 2, 9]])
    expect(new Set(clips.flatMap(clip => clip.notes.map(item => item.id))).size).toBe(12)
    expect(validateProject(JSON.parse(JSON.stringify(result)))).toEqual(result)
  })

  it('round-trips the full source and loop endpoint in a versioned .garak file', async () => {
    const clip = setClipLoopEnd(trimClipStart(phrase(), 10, 120), 19)
    const project = projectWith(clip)
    const bundle = await exportProjectBundle(project, new Map())
    const serialized = JSON.parse(await bundle.text())
    expect(serialized).toMatchObject({ schemaVersion: 1, project: { schemaVersion: 6 } })
    const restored = await importProjectBundle(bundle)
    expect(restored.project).toEqual(project)
    expect(asMidi(trimClipStart(restored.project.tracks[0].clips[0], 8, 120)).notes).toEqual(phrase().notes)
    // The interpretation cannot be silently relabeled as an older project format.
    await expect(importProjectBundle(new Blob([JSON.stringify({ ...serialized, project: { ...serialized.project, schemaVersion: 3 } })]))).rejects.toThrow(/schema version 4/)
  })
})

describe('bounded region loops', () => {
  const sample = (): AudioClip => ({ id: 'sample', kind: 'audio', name: 'Sample', startBeat: 2, lengthBeats: 4, gain: 1, assetId: 'asset', offsetSeconds: 3, fadeIn: 0, fadeOut: 0 })

  it('plays a partial final MIDI and audio repeat at an explicitly chosen endpoint', () => {
    const source: MidiClip = { ...phrase(), startBeat: 2, lengthBeats: 4, sourceOffsetBeats: 1, notes: [note('first', 1, 1), note('last', 4, 1, 64)] }
    const clip = asMidi(setClipLoopEnd(source, 11.5)), track = projectWith(clip).tracks[0]
    expect(clip.loopLengthBeats).toBe(9.5)
    expect(clipOccurrences(track, clip, 64)).toEqual([{ start: 2, end: 6, index: 0 }, { start: 6, end: 10, index: 1 }, { start: 10, end: 11.5, index: 2 }])
    expect(events(clip)).toEqual([
      { pitch: 60, start: 2, end: 3 }, { pitch: 64, start: 5, end: 6 },
      { pitch: 60, start: 6, end: 7 }, { pitch: 64, start: 9, end: 10 }, { pitch: 60, start: 10, end: 11 },
    ])
    const audio = setClipLoopEnd(sample(), 11.5)
    expect(audioWindows(projectWith(audio).tracks[0], 64).map(window => [window.start, window.end, window.clip.offsetSeconds])).toEqual([[2, 6, 3], [6, 10, 3], [10, 11.5, 3]])
  })

  it('respects a next region/project boundary and retains continuous/off loop behavior', () => {
    const clip = setClipLoopEnd(sample(), 15), next = { ...sample(), id: 'next', startBeat: 9, mute: true }
    expect(loopEnd(projectWith(clip, next).tracks[0], clip, 64)).toBe(9)
    expect(loopEnd(projectWith(clip).tracks[0], clip, 8)).toBe(8)
    const overlapping = { ...next, startBeat: 4 }
    expect(loopEnd(projectWith(clip, overlapping).tracks[0], clip, 64)).toBe(6)
    expect(loopEnd(projectWith(clip).tracks[0], { ...clip, loop: false }, 64)).toBe(6)
    const continuous = { ...sample(), loop: true }
    expect(loopEnd(projectWith(continuous).tracks[0], continuous, 64)).toBe(64)
    expect(setClipLoopEnd(clip, 6)).toMatchObject({ loop: false })
    expect(setClipLoopEnd(clip, 6)).not.toHaveProperty('loopLengthBeats')
  })

  it('carries a bounded span on moves/copies and preserves its absolute end during source trims/splits', () => {
    const clip = setClipLoopEnd(sample(), 15.5)
    const copy = duplicateClip(clip, 20)
    expect(loopEnd(projectWith(copy).tracks[0], copy, 64)).toBe(33.5)
    const leftTrimmed = trimClipStart(clip, 3.5, 120)
    expect(leftTrimmed.loopLengthBeats).toBe(12)
    expect(loopEnd(projectWith(leftTrimmed).tracks[0], leftTrimmed, 64)).toBe(15.5)
    const rightTrimmed = trimClipEnd(clip, 5)
    expect(loopEnd(projectWith(rightTrimmed).tracks[0], rightTrimmed, 64)).toBe(15.5)
    const longer = trimClipEnd(clip, 18)
    expect(longer.loopLengthBeats).toBe(longer.lengthBeats)
    const [left, right] = splitClip(clip, 4, 120), owner = projectWith(left, right).tracks[0]
    expect(loopEnd(owner, left, 64)).toBe(4)
    expect(loopEnd(owner, right, 64)).toBe(15.5)
  })

  it('persists source offsets and bounded spans while rejecting malformed imports', () => {
    const clip = asMidi(setClipLoopEnd(trimClipStart(phrase(), 10, 120), 19))
    expect(validateProject(JSON.parse(JSON.stringify(projectWith(clip)))).tracks[0].clips[0]).toEqual(clip)
    expect(validateProject(projectWith(phrase())).tracks[0].clips[0]).not.toHaveProperty('sourceOffsetBeats')
    for (const sourceOffsetBeats of [-1, Infinity, '2', null]) {
      expect(() => validateProject(projectWith({ ...clip, sourceOffsetBeats } as MidiClip))).toThrow(/source offset/)
    }
    for (const loopLengthBeats of [-1, 0, clip.lengthBeats - 0.01, Infinity, '8', null]) {
      expect(() => validateProject(projectWith({ ...clip, loopLengthBeats } as MidiClip))).toThrow(/loop length/)
    }
    const shortProject = { ...projectWith(setClipLoopEnd(sample(), 70.5)), lengthBeats: 32 }
    expect(fitProjectLength(shortProject).lengthBeats).toBe(72)
    expect(() => setClipLoopEnd(clip, NaN)).toThrow(/finite/)
  })
})

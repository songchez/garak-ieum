import { describe, expect, it } from 'vitest'
import { positionAfter } from '../audio/math'
import { ProjectSession } from './ProjectSession'
import { quarterNotesPerBar, quarterNotesPerBeat, setProjectTimeSignature, validateTimeSignature } from './meter'
import { createDemoProject, createEmptyProject, createTrack, fitProjectLength, validateProject } from './project'
import { appendAudioRecording, type RecordingDraft } from './recording'
import { exportProjectBundle, importProjectBundle } from './storage'

describe('project time signatures', () => {
  it.each([
    [3, 4, 1, 3], [6, 8, 0.5, 3], [7, 8, 0.5, 3.5], [2, 2, 2, 4], [1, 16, 0.25, 0.25], [32, 2, 2, 64],
  ])('converts %i/%i to quarter-note units without changing the BPM unit', (numerator, denominator, beatLength, barLength) => {
    const signature = validateTimeSignature({ numerator, denominator })
    expect(quarterNotesPerBeat(signature)).toBe(beatLength)
    expect(quarterNotesPerBar(signature)).toBe(barLength)
    const project = setProjectTimeSignature({ ...createEmptyProject(), bpm: 120 }, numerator, denominator)
    expect(positionAfter(project, 0, 1)).toBe(2)
    expect(project.beatsPerBar).toBe(barLength)
    expect(validateProject(project)).toEqual(project)
  })

  it.each([undefined, null, [], '3/4', { numerator: 0, denominator: 4 }, { numerator: 33, denominator: 4 },
    { numerator: 3.5, denominator: 4 }, { numerator: '3', denominator: 4 }, { numerator: 4, denominator: 0 },
    { numerator: 4, denominator: 3 }, { numerator: 4, denominator: 32 }, { numerator: 4, denominator: '8' },
    { numerator: Infinity, denominator: 4 }])('rejects invalid meter %j', value => {
    expect(() => validateTimeSignature(value)).toThrow(/Time signature/)
  })

  it.each([1, 2, 3, 4])('migrates schema %i into an explicit 4/4 project', schemaVersion => {
    const { timeSignature: _signature, ...legacy } = createEmptyProject()
    const migrated = validateProject({ ...legacy, schemaVersion })
    expect(migrated).toMatchObject({ schemaVersion: 5, timeSignature: { numerator: 4, denominator: 4 }, beatsPerBar: 4 })
    expect(() => validateProject({ ...legacy, schemaVersion, beatsPerBar: 3 })).toThrow(/Legacy projects/)
  })

  it('rejects missing or inconsistent schema 5 meter data and copies imported meter objects', () => {
    const project = setProjectTimeSignature(createEmptyProject(), 6, 8)
    expect(() => validateProject({ ...project, beatsPerBar: 6 })).toThrow(/must agree/)
    expect(() => validateProject({ ...project, timeSignature: undefined })).toThrow(/Time signature/)
    const imported = validateProject(project)
    imported.timeSignature.numerator = 7
    expect(project.timeSignature.numerator).toBe(6)
  })

  it('changes meter in one reversible edit while keeping all musical positions and loop boundaries', () => {
    const session = new ProjectSession(createDemoProject())
    const before = session.getSnapshot().history.present
    session.edit(project => setProjectTimeSignature(project, 7, 8), '', '박자표 변경')
    const after = session.getSnapshot().history.present
    expect(after.timeSignature).toEqual({ numerator: 7, denominator: 8 })
    expect(after.beatsPerBar).toBe(3.5)
    expect(after.tracks).toBe(before.tracks)
    expect(after.loop).toBe(before.loop)
    expect(after.lengthBeats).toBe(before.lengthBeats)
    expect(after.bpm).toBe(before.bpm)
    expect(session.getSnapshot().undoLabel).toBe('박자표 변경')
    session.edit(project => setProjectTimeSignature(project, 7, 8))
    expect(session.getSnapshot().history.past).toHaveLength(1)
    session.dispatch({ type: 'undo' })
    expect(session.getSnapshot().history.present).toEqual(before)
    session.dispatch({ type: 'redo' })
    expect(session.getSnapshot().history.present).toEqual(after)
  })

  it('extends arrangements and completed recordings to bars of the selected meter', () => {
    const base = setProjectTimeSignature({ ...createEmptyProject(), lengthBeats: 7, bpm: 120, loop: { enabled: false, startBeat: 0, endBeat: 7 } }, 7, 8)
    const track = createTrack('instrument')
    track.clips = [{ id: 'phrase', name: 'Phrase', kind: 'midi', startBeat: 7, lengthBeats: 4, gain: 1, notes: [] }]
    expect(fitProjectLength({ ...base, tracks: [track] }).lengthBeats).toBe(14)
    const audio = createTrack('audio')
    const draft: RecordingDraft = { id: 'take', name: 'Take', trackId: audio.id, track: audio, startBeat: 7, bpm: 120, offsetMs: 0, startedAtMs: 0, status: 'processing' }
    const result = appendAudioRecording(base, draft, 'original-audio', 2)
    expect(result?.project.lengthBeats).toBe(14)
    expect(result?.clip).toMatchObject({ startBeat: 7, lengthBeats: 4, offsetSeconds: 0 })
  })

  it.each([[6, 8], [2, 2]])('round-trips %i/%i using schema 5 without changing the bundle format', async (numerator, denominator) => {
    const project = setProjectTimeSignature(createDemoProject(), numerator, denominator)
    const blob = await exportProjectBundle(project, new Map())
    const serialized = JSON.parse(await blob.text())
    expect(serialized).toMatchObject({ schemaVersion: 1, project: { schemaVersion: 5, timeSignature: { numerator, denominator } } })
    expect((await importProjectBundle(blob)).project).toEqual(project)
  })
})

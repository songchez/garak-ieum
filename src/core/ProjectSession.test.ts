import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_LIMITS, DomainError, type CommandRequest, type DawCommand } from './commands'
import { ProjectSession } from './ProjectSession'
import { createDevice, createEmptyProject, createTrack, validateProject } from './project'
import type { AudioClip, MidiClip, Project } from './types'

const note = { pitch: 60, start: 0, duration: 1, velocity: 0.7 }
const draft = { name: '8마디 초안', startBeat: 0, lengthBeats: 32, notes: [note, { ...note, pitch: 64, start: 4 }, { ...note, pitch: 67, start: 28 }] }
function fixture(): Project {
  const project = createEmptyProject(); project.id = 'project'
  const track = createTrack('instrument', 'keys'); track.id = 'keys'
  track.clips = [{ id: 'midi', kind: 'midi', name: 'Phrase', startBeat: 0, lengthBeats: 4, gain: 1, notes: [{ ...note, id: 'note' }] }]
  track.devices = [{ ...createDevice('eq'), id: 'eq' }]
  const second = createTrack('instrument', 'bass'); second.id = 'bass'
  const audio = createTrack('audio'); audio.id = 'audio'
  audio.clips = [{ id: 'audio-clip', kind: 'audio', name: 'Voice', startBeat: 4, lengthBeats: 4, gain: 1, assetId: 'asset', offsetSeconds: 0.5, fadeIn: 0.005, fadeOut: 0.01 }]
  project.tracks = [track, second, audio]
  return project
}
function request(session: ProjectSession, commands: DawCommand[], operationId = 'op'): CommandRequest {
  const { history, revision } = session.getSnapshot()
  return { projectId: history.present.id, expectedRevision: revision, operationId, commands }
}
function fails(action: () => unknown, code: string) {
  let error: unknown
  try { action() } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(DomainError)
  expect(error).toMatchObject({ code })
}
afterEach(() => vi.restoreAllMocks())

describe('ProjectSession shared history', () => {
  it('treats a paused fader drag as one undo and rapid separate drags as separate edits', () => {
    let now = 100
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const session = new ProjectSession(fixture()), original = session.getSnapshot().history.present.masterVolume
    session.beginGesture('fader', '볼륨 조절')
    session.edit(project => ({ ...project, masterVolume: .7 }), 'master-volume')
    now += 3000
    session.beginGesture('fader', '볼륨 조절') // a held key may repeat its start notification
    session.edit(project => ({ ...project, masterVolume: .4 }), 'master-volume')
    session.endGesture('fader')
    expect(session.getSnapshot().history.past).toHaveLength(1)
    expect(session.getSnapshot().undoLabel).toBe('볼륨 조절')
    now += 10
    session.beginGesture('fader', '볼륨 조절')
    session.edit(project => ({ ...project, masterVolume: .2 }), 'master-volume')
    session.endGesture('fader')
    expect(session.getSnapshot().history.past).toHaveLength(2)
    session.dispatch({ type: 'undo' })
    expect(session.getSnapshot().history.present.masterVolume).toBe(.4)
    session.dispatch({ type: 'undo' })
    expect(session.getSnapshot().history.present.masterVolume).toBe(original)
    expect(session.getSnapshot()).toMatchObject({ undoLabel: null, redoLabel: '볼륨 조절' })
  })

  it('keeps the next undo and redo names aligned across UI, AI, live edits and branches', () => {
    const session = new ProjectSession(fixture())
    session.edit(project => ({ ...project, name: 'Moved' }), '', '리전 이동')
    session.execute({ ...request(session, [{ type: 'track.setPan', trackId: 'keys', pan: .25 }]), label: 'AI 드럼 편집' })
    expect(session.getSnapshot()).toMatchObject({ undoLabel: 'AI 드럼 편집', redoLabel: null })
    session.dispatch({ type: 'live', edit: project => ({ ...project, tracks: project.tracks.map(track => track.id === 'audio' ? { ...track, armed: true } : track) }) })
    expect(session.getSnapshot().undoLabel).toBe('AI 드럼 편집')
    session.history({ projectId: 'project', expectedRevision: session.getSnapshot().revision, operationId: 'undo-ai', action: 'undo' })
    expect(session.getSnapshot()).toMatchObject({ undoLabel: '리전 이동', redoLabel: 'AI 드럼 편집' })
    session.dispatch({ type: 'redo' })
    expect(session.getSnapshot()).toMatchObject({ undoLabel: 'AI 드럼 편집', redoLabel: null })
    session.dispatch({ type: 'undo' })
    session.edit(project => ({ ...project, bpm: 130 }), '', '템포 조절')
    expect(session.getSnapshot()).toMatchObject({ undoLabel: '템포 조절', redoLabel: null })
    session.dispatch({ type: 'reset', project: fixture() })
    expect(session.getSnapshot()).toMatchObject({ undoLabel: null, redoLabel: null })
  })

  it('does not add an undo for an untouched gesture and closes merging on external edits', () => {
    const session = new ProjectSession(fixture()), before = session.getSnapshot()
    session.beginGesture('empty', '팬 조절'); session.edit(project => project); session.endGesture('empty')
    expect(session.getSnapshot()).toBe(before)
    session.beginGesture('parameter')
    session.edit(project => ({ ...project, masterVolume: .6 }), '', '마스터 볼륨 조절')
    session.endGesture('other')
    expect(session.isGestureActive()).toBe(true)
    session.execute(request(session, [{ type: 'track.setPan', trackId: 'keys', pan: .25 }]))
    expect(session.isGestureActive()).toBe(false)
    session.edit(project => ({ ...project, masterVolume: .3 }), '', '마스터 볼륨 조절')
    expect(session.getSnapshot().history.past).toHaveLength(3)
    session.dispatch({ type: 'undo' })
    expect(session.getSnapshot().history.present.masterVolume).toBe(.6)
    expect(session.getSnapshot().undoLabel).toBe('AI 편집')
  })

  it('cancels a restored fader gesture without losing prior undo, redo, labels or live flags', () => {
    const session = new ProjectSession(fixture())
    session.edit(project => ({ ...project, masterVolume: .8 }), '', '볼륨 조절')
    session.edit(project => ({ ...project, bpm: 140 }), '', '템포 조절')
    session.dispatch({ type: 'undo' })
    const before = session.getSnapshot()
    session.beginGesture('fader', '볼륨 조절')
    session.edit(project => ({ ...project, masterVolume: .4 }), 'master-volume')
    session.dispatch({ type: 'live', edit: project => ({ ...project, tracks: project.tracks.map(track => track.id === 'audio' ? { ...track, armed: true, monitor: true } : track) }) })
    // Escape restores the controlled value before cancelling the history gesture.
    session.edit(project => ({ ...project, masterVolume: .8 }), 'master-volume')
    session.cancelGesture('fader')
    const after = session.getSnapshot()
    expect(after.history.present.masterVolume).toBe(.8)
    expect(after.history.present.tracks[2]).toMatchObject({ armed: true, monitor: true })
    expect(after.history.past).toBe(before.history.past)
    expect(after.history.future).toBe(before.history.future)
    expect(after).toMatchObject({ undoLabel: '볼륨 조절', redoLabel: '템포 조절' })
    expect(after.revision).toBeGreaterThan(before.revision)
    expect(session.isGestureActive()).toBe(false)
    session.dispatch({ type: 'redo' })
    expect(session.getSnapshot().history.present.bpm).toBe(140)
    expect(session.getSnapshot().history.present.tracks[2]).toMatchObject({ armed: true, monitor: true })
  })

  it('never cancels a different gesture or an intervening external edit', () => {
    const session = new ProjectSession(fixture())
    session.beginGesture('pan', '팬 조절')
    session.edit(project => ({ ...project, masterVolume: .5 }))
    const changed = session.getSnapshot()
    session.cancelGesture('other')
    expect(session.getSnapshot()).toBe(changed)
    session.execute(request(session, [{ type: 'track.setPan', trackId: 'keys', pan: .25 }]))
    const external = session.getSnapshot()
    session.cancelGesture('pan')
    expect(session.getSnapshot()).toBe(external)
    expect(external.history.present.tracks[0].pan).toBe(.25)
    session.beginGesture('untouched'); session.cancelGesture('untouched')
    expect(session.getSnapshot()).toBe(external)
  })

  it('exposes stable snapshots, synchronous updates, and removable subscriptions', () => {
    const session = new ProjectSession(fixture()), listener = vi.fn()
    const before = session.getSnapshot(), unsubscribe = session.subscribe(listener)
    expect(session.getSnapshot()).toBe(before)
    session.edit(project => ({ ...project, name: 'Edited' }))
    expect(session.getSnapshot().history.present.name).toBe('Edited')
    expect(session.getSnapshot().revision).toBe(1)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe(); session.edit(project => ({ ...project, name: 'Again' }))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(session.getSnapshot()).toBe(session.getSnapshot())
  })

  it('preserves the UI 450ms coalescing rule and 50-item history bound', () => {
    let now = 100
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const session = new ProjectSession(fixture())
    session.edit(project => ({ ...project, name: 'First' }), 'name')
    now += 100; session.edit(project => ({ ...project, name: 'Second' }), 'name')
    expect(session.getSnapshot().history.past).toHaveLength(1)
    now += 451; session.edit(project => ({ ...project, name: 'Third' }), 'name')
    expect(session.getSnapshot().history.past).toHaveLength(2)
    for (let i = 0; i < 60; i++) session.edit(project => ({ ...project, name: `Change ${i}` }))
    expect(session.getSnapshot().history.past).toHaveLength(50)
  })

  it('separates UI coalescing from an atomic external edit in both directions', () => {
    vi.spyOn(performance, 'now').mockReturnValue(100)
    const session = new ProjectSession(fixture())
    session.edit(project => ({ ...project, name: 'UI before' }), 'name')
    session.execute(request(session, [{ type: 'track.setPan', trackId: 'keys', pan: 0.25 }]))
    session.edit(project => ({ ...project, name: 'UI after' }), 'name')
    expect(session.getSnapshot().history.past).toHaveLength(3)
    session.dispatch({ type: 'undo' })
    expect(session.getSnapshot().history.present).toMatchObject({ name: 'UI before', tracks: [{ id: 'keys', pan: 0.25 }, {}, {}] })
    session.dispatch({ type: 'undo' })
    expect(session.getSnapshot().history.present.tracks[0].pan).toBe(0)
  })

  it('preserves current arm/monitor flags through undo/redo without adding live undo items', () => {
    const session = new ProjectSession(fixture())
    session.edit(project => ({ ...project, name: 'Changed' }))
    session.dispatch({ type: 'live', edit: project => ({ ...project, tracks: project.tracks.map(track => track.id === 'audio' ? { ...track, armed: true, monitor: true } : track) }) })
    expect(session.getSnapshot().revision).toBe(2)
    expect(session.getSnapshot().history.past).toHaveLength(1)
    session.dispatch({ type: 'undo' })
    expect(session.getSnapshot().history.present.tracks[2]).toMatchObject({ armed: true, monitor: true })
    session.dispatch({ type: 'redo' })
    expect(session.getSnapshot().history.present).toMatchObject({ name: 'Changed', tracks: [{}, {}, { armed: true, monitor: true }] })
    expect(session.getSnapshot().revision).toBe(4)
  })

  it('increments revision and clears operation/undo state on a same-ID project reset', () => {
    const session = new ProjectSession(fixture())
    const original = request(session, [{ type: 'track.rename', trackId: 'keys', name: 'Renamed' }])
    session.execute(original)
    session.dispatch({ type: 'reset', project: fixture() })
    expect(session.getSnapshot().revision).toBe(2)
    expect(session.getSnapshot().history.past).toEqual([])
    fails(() => session.execute(original), 'REVISION_CONFLICT')
    expect(session.execute({ ...original, expectedRevision: 2 }).revision).toBe(3)
  })

  it('keeps snapshots/revision unchanged for no-op edits and empty undo/redo', () => {
    const session = new ProjectSession(fixture()), before = session.getSnapshot()
    session.edit(project => project)
    session.dispatch({ type: 'undo' }); session.dispatch({ type: 'redo' })
    const result = session.history({ projectId: 'project', expectedRevision: 0, operationId: 'empty-undo', action: 'undo' })
    expect(result).toMatchObject({ changed: false, revision: 0, action: 'undo' })
    expect(result.summary).toContain('없습니다')
    expect(session.getSnapshot()).toBe(before)
  })
})

describe('atomic command execution and conflicts', () => {
  it('previews without mutation and applies exactly the preview IDs in one undo item', () => {
    const session = new ProjectSession(fixture()), before = session.getSnapshot(), listener = vi.fn()
    session.subscribe(listener)
    const input = request(session, [{ type: 'track.create', kind: 'instrument', instrument: 'gayageum', name: '가야금', initialClip: draft }, { type: 'track.setPan', trackId: 'keys', pan: -0.2 }])
    const preview = session.preview(input)
    expect(preview).toMatchObject({ preview: true, changed: true, revision: 0, changes: { created: { tracks: 1, clips: 1, notes: 3, devices: 0 } } })
    expect(preview.summary).toContain('미리보기')
    expect(session.getSnapshot()).toBe(before); expect(listener).not.toHaveBeenCalled()
    const applied = session.execute(input)
    expect(applied.results[0].createdIds).toEqual(preview.results[0].createdIds)
    expect(applied.revision).toBe(1); expect(listener).toHaveBeenCalledTimes(1)
    expect(session.getSnapshot().history.past).toHaveLength(1)
    session.history({ projectId: 'project', expectedRevision: 1, operationId: 'undo-created', action: 'undo' })
    expect(session.getSnapshot().history.present).toEqual(before.history.present)
  })

  it('rolls back every earlier command when a later command fails', () => {
    const session = new ProjectSession(fixture()), before = session.getSnapshot(), listener = vi.fn()
    session.subscribe(listener)
    const input = request(session, [
      { type: 'track.setMute', trackId: 'keys', mute: true },
      { type: 'track.create', kind: 'instrument', instrument: 'keys', initialClip: draft },
      { type: 'track.create', kind: 'instrument', instrument: 'missing-instrument', initialClip: draft },
    ])
    fails(() => session.execute(input), 'UNKNOWN_INSTRUMENT')
    expect(session.getSnapshot()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
    // A failed operation did not consume the idempotency key.
    expect(session.execute({ ...input, commands: input.commands.slice(0, 2) }).changed).toBe(true)
  })

  it('returns a successful operation once even after later UI changes and rejects changed payload reuse', () => {
    const session = new ProjectSession(fixture())
    const input = request(session, [{ type: 'clip.repeat', clipId: 'midi', count: 2 }])
    const applied = session.execute(input)
    session.edit(project => ({ ...project, name: 'Human changed this' }))
    const current = session.getSnapshot()
    const repeated = session.execute(input)
    expect(repeated).toEqual(applied); expect(session.getSnapshot()).toBe(current)
    expect(session.getSnapshot().history.present.tracks[0].clips).toHaveLength(3)
    repeated.results[0].createdIds!.clipIds.length = 0
    expect(session.execute(input).results[0].createdIds!.clipIds).toHaveLength(2)
    fails(() => session.execute({ ...input, label: 'different payload' }), 'OPERATION_ID_REUSED')
  })

  it('rejects stale revisions and wrong projects before applying or previewing', () => {
    const session = new ProjectSession(fixture())
    const input = request(session, [{ type: 'track.setMute', trackId: 'keys', mute: true }])
    session.edit(project => ({ ...project, name: 'Newer' }))
    const current = session.getSnapshot()
    fails(() => session.execute(input), 'REVISION_CONFLICT')
    fails(() => session.preview(input), 'REVISION_CONFLICT')
    fails(() => session.execute({ ...input, projectId: 'other' }), 'PROJECT_MISMATCH')
    expect(session.getSnapshot()).toBe(current)
  })

  it('gives history operations the same revision and idempotency protections', () => {
    const session = new ProjectSession(fixture())
    session.execute(request(session, [{ type: 'track.setPan', trackId: 'keys', pan: -1 }], 'edit'))
    const input = { projectId: 'project', expectedRevision: 1, operationId: 'undo', action: 'undo' as const }
    const undone = session.history(input)
    expect(undone).toMatchObject({ changed: true, revision: 2 })
    expect(session.history(input)).toEqual(undone)
    fails(() => session.history({ ...input, operationId: 'another' }), 'REVISION_CONFLICT')
    fails(() => session.history({ ...input, action: 'redo' }), 'OPERATION_ID_REUSED')
    expect(session.history({ ...input, operationId: 'redo', expectedRevision: 2, action: 'redo' })).toMatchObject({ changed: true, revision: 3 })
    expect(session.getSnapshot().history.present.tracks[0].pan).toBe(-1)
  })

  it('rejects unknown targets and invalid effect parameter ranges without partial edits', () => {
    const session = new ProjectSession(fixture()), before = session.getSnapshot()
    for (const command of [
      { type: 'track.rename', trackId: 'missing', name: 'Name' },
      { type: 'clip.delete', clipId: 'missing' },
      { type: 'effect.remove', trackId: 'keys', deviceId: 'missing' },
    ] as DawCommand[]) fails(() => session.execute(request(session, [command])), 'NOT_FOUND')
    fails(() => session.execute(request(session, [{ type: 'effect.setParam', trackId: 'keys', deviceId: 'eq', paramId: 'cutoff', value: 1000 }])), 'UNKNOWN_PARAMETER')
    fails(() => session.execute(request(session, [{ type: 'track.setMute', trackId: 'keys', mute: true }, { type: 'effect.add', trackId: 'keys', effectType: 'delay', params: { time: 0.6 } }])), 'INVALID_ARGUMENT')
    expect(session.getSnapshot()).toBe(before)
  })

  it('checks the total generated-note budget before allocating repeated notes', () => {
    const project = fixture(), clip = project.tracks[0].clips[0] as MidiClip
    clip.notes = Array.from({ length: 300 }, (_, i) => ({ ...note, id: `note-${i}` }))
    const session = new ProjectSession(project), before = session.getSnapshot()
    fails(() => session.execute(request(session, [{ type: 'clip.repeat', clipId: 'midi', count: 64 }])), 'LIMIT_EXCEEDED')
    expect(session.getSnapshot()).toBe(before)
  })
})

describe('music-domain edits', () => {
  it('does not change an imported project horizon while adjusting an unrelated mixer value', () => {
    const project = fixture()
    project.lengthBeats = 4; project.loop.endBeat = 4
    const session = new ProjectSession(project)
    session.execute(request(session, [{ type: 'track.setPan', trackId: 'keys', pan: 0.2 }]))
    expect(session.getSnapshot().history.present.lengthBeats).toBe(4)
  })

  it('uses dB for faders, normalized pan, and explicit silence instead of percentages', () => {
    const session = new ProjectSession(fixture())
    const set = session.execute(request(session, [{ type: 'track.setVolumeDb', trackId: 'keys', volumeDb: -6 }, { type: 'track.setPan', trackId: 'keys', pan: -0.5 }], 'set'))
    expect(session.getSnapshot().history.present.tracks[0]).toMatchObject({ volume: 10 ** (-6 / 20), pan: -0.5 })
    expect(set.results[0].after?.volumeDb).toBeCloseTo(-6)
    session.execute(request(session, [{ type: 'track.adjustVolumeDb', trackId: 'keys', deltaDb: -3 }], 'adjust'))
    expect(session.getSnapshot().history.present.tracks[0].volume).toBeCloseTo(10 ** (-9 / 20))
    session.execute(request(session, [{ type: 'track.setVolumeDb', trackId: 'keys', volumeDb: null }], 'silence'))
    expect(session.getSnapshot().history.present.tracks[0].volume).toBe(0)
    const unchanged = session.execute(request(session, [{ type: 'track.adjustVolumeDb', trackId: 'keys', deltaDb: 6 }], 'silent-adjust'))
    expect(unchanged.changed).toBe(false)
  })

  it('rejects relative gain overflow and supports the exact gain-two boundary', () => {
    const session = new ProjectSession(fixture())
    const before = session.getSnapshot()
    fails(() => session.execute(request(session, [{ type: 'track.adjustVolumeDb', trackId: 'keys', deltaDb: 20 }])), 'INVALID_ARGUMENT')
    expect(session.getSnapshot()).toBe(before)
    session.execute(request(session, [{ type: 'track.setVolumeDb', trackId: 'keys', volumeDb: COMMAND_LIMITS.maxVolumeDb }], 'max'))
    expect(session.getSnapshot().history.present.tracks[0].volume).toBe(2)
  })

  it('creates an editable draft with globally unique stable IDs and normal save validation', () => {
    const session = new ProjectSession(fixture())
    const result = session.execute(request(session, [{ type: 'track.create', kind: 'instrument', instrument: 'gayageum', name: '가야금 초안', initialClip: draft }]))
    const project = session.getSnapshot().history.present, track = project.tracks.at(-1)!, clip = track.clips[0] as MidiClip
    expect(track).toMatchObject({ name: '가야금 초안', instrument: 'gayageum', kind: 'instrument' })
    expect(clip).toMatchObject({ name: draft.name, lengthBeats: 32, startBeat: 0 })
    expect(clip.notes.map(({ id: _id, ...value }) => value)).toEqual(draft.notes)
    expect(result.results[0].createdIds).toMatchObject({ trackIds: [track.id], clipIds: [clip.id] })
    expect(validateProject(project)).toEqual(project)
  })

  it('retains editable note pitches when setting region transpose and preserves IDs on compatible moves', () => {
    const session = new ProjectSession(fixture())
    session.execute(request(session, [{ type: 'clip.setTranspose', clipId: 'midi', semitones: 12 }, { type: 'clip.move', clipId: 'midi', startBeat: 8, toTrackId: 'bass' }]))
    const project = session.getSnapshot().history.present
    expect(project.tracks[0].clips).toEqual([])
    expect(project.tracks[1].clips[0]).toMatchObject({ id: 'midi', startBeat: 8, transpose: 12, notes: [{ id: 'note', pitch: 60 }] })
  })

  it('rejects MIDI on audio tracks, audio transposition, and cross-kind moves', () => {
    const session = new ProjectSession(fixture()), before = session.getSnapshot()
    for (const command of [
      { type: 'clip.addMidi', trackId: 'audio', ...draft },
      { type: 'clip.setTranspose', clipId: 'audio-clip', semitones: 1 },
      { type: 'clip.move', clipId: 'midi', startBeat: 8, toTrackId: 'audio' },
    ] as DawCommand[]) fails(() => session.execute(request(session, [command])), 'TYPE_MISMATCH')
    expect(session.getSnapshot()).toBe(before)
  })

  it('repeats audio without changing original source offset and grows the project by whole bars', () => {
    const session = new ProjectSession(fixture())
    session.execute(request(session, [{ type: 'clip.repeat', clipId: 'audio-clip', count: 2, startBeat: 65 }]))
    const project = session.getSnapshot().history.present, copies = project.tracks[2].clips.slice(1) as AudioClip[]
    expect(copies.map(clip => clip.startBeat)).toEqual([65, 69])
    expect(copies.every(clip => clip.assetId === 'asset' && clip.offsetSeconds === 0.5)).toBe(true)
    expect(project.lengthBeats).toBe(76)
    expect(new Set(project.tracks.flatMap(track => track.clips.map(clip => clip.id))).size).toBe(4)
  })

  it('validates effect parameters in their native unit, changes them by device ID, then removes them', () => {
    const session = new ProjectSession(fixture())
    const added = session.execute(request(session, [{ type: 'effect.add', trackId: 'keys', effectType: 'compressor', params: { attack: 20, threshold: -24 } }], 'add'))
    const deviceId = added.results[0].createdIds!.deviceIds[0]
    session.execute(request(session, [{ type: 'effect.setParam', trackId: 'keys', deviceId, paramId: 'ratio', value: 3 }, { type: 'effect.setEnabled', trackId: 'keys', deviceId, enabled: false }], 'change'))
    expect(session.getSnapshot().history.present.tracks[0].devices[1]).toMatchObject({ id: deviceId, type: 'compressor', enabled: false, params: { attack: 20, threshold: -24, ratio: 3 } })
    session.execute(request(session, [{ type: 'effect.remove', trackId: 'keys', deviceId }], 'remove'))
    expect(session.getSnapshot().history.present.tracks[0].devices.map(device => device.id)).toEqual(['eq'])
  })

  it('deletes clips/tracks with a summary and restores the whole transaction with undo', () => {
    const session = new ProjectSession(fixture()), original = session.getSnapshot().history.present
    const result = session.execute(request(session, [{ type: 'clip.delete', clipId: 'audio-clip' }, { type: 'track.delete', trackId: 'keys' }]))
    expect(result.changes.deleted).toEqual({ tracks: 1, clips: 2, notes: 1, devices: 1 })
    session.dispatch({ type: 'undo' })
    expect(session.getSnapshot().history.present).toEqual(original)
  })
})

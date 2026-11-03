import { describe, expect, it, vi } from 'vitest'
import { ProjectSession } from '../core/ProjectSession'
import { createDevice, createEmptyProject, createTrack, setClipLoopEnd, trimClipStart } from '../core/project'
import type { MidiClip, Project } from '../core/types'
import { createDawRequestHandler, type DawRuntime } from './host'
import type { BridgeParams, DawMethod } from './protocol'

function fixture(): Project {
  const project = createEmptyProject()
  project.id = 'project'; project.lengthBeats = 256
  const keys = createTrack('instrument', 'keys'); keys.id = 'keys'
  keys.devices = [{ ...createDevice('eq'), id: 'eq' }]
  keys.clips = [{
    id: 'phrase', kind: 'midi', name: 'Original phrase', startBeat: 4, lengthBeats: 160, gain: 1, transpose: 12,
    notes: Array.from({ length: 513 }, (_, i) => ({ id: `note-${i}`, pitch: 60, start: i / 4, duration: 0.2, velocity: 0.7 })),
  }, { id: 'empty', kind: 'midi', name: 'Empty', startBeat: 164, lengthBeats: 4, gain: 1, notes: [] }]
  const bass = createTrack('instrument', 'bass'); bass.id = 'bass'; bass.volume = 0
  const audio = createTrack('audio'); audio.id = 'audio'
  audio.clips = [{ id: 'voice', kind: 'audio', name: 'Voice', startBeat: 0, lengthBeats: 4, gain: 1, assetId: 'asset', offsetSeconds: 1, fadeIn: 0.01, fadeOut: 0.01 }]
  project.tracks = [keys, bass, audio]
  return project
}
function setup() {
  const session = new ProjectSession(fixture())
  const runtime: DawRuntime = { ready: true, editsAllowed: true, blockedReason: null, persistence: 'saved' }
  const onMutation = vi.fn()
  const handler = createDawRequestHandler({ session, getRuntime: () => runtime, onMutation,
    getSelection: () => ({ focusedTrackId: 'deleted', trackIds: ['keys', 'deleted', 'keys'], clipIds: ['phrase', 'deleted', 'phrase'] }),
    getTransport: () => ({ playing: false, beat: 4, ready: false, sampleRate: 48000 }),
  })
  const request = (commands: BridgeParams[], operationId = 'edit') => ({ projectId: 'project', expectedRevision: session.getSnapshot().revision, operationId, commands })
  return { session, runtime, onMutation, handler, request }
}

describe('DAW host bounded reads', () => {
  it('pages track summaries and removes stale or duplicate selection IDs', () => {
    const { handler } = setup()
    const first = handler('get_state', { trackLimit: 1 })
    expect(first).toMatchObject({ projectId: 'project', revision: 0, scope: 'project', trackCount: 3, nextTrackOffset: 1,
      selection: { focusedTrackId: null, trackIds: ['keys'], clipIds: ['phrase'] },
      transport: { playing: false, beat: 4 }, persistence: 'saved', editAccess: { allowed: true },
      tracks: [{ id: 'keys', clipCount: 2, effectCount: 1 }],
    })
    const tracks = (first as { tracks: Record<string, unknown>[] }).tracks
    expect(tracks[0]).not.toHaveProperty('clips')
    expect(tracks[0]).not.toHaveProperty('notes')
    expect(tracks[0].volumeDb).toBeCloseTo(20 * Math.log10(0.7))
    expect(handler('get_state', { trackOffset: 1, trackLimit: 2 })).toMatchObject({ nextTrackOffset: null, tracks: [{ id: 'bass', volumeDb: null }, { id: 'audio' }] })
  })

  it('returns clip metadata in a track page and source notes only in a clip page', () => {
    const { handler, session } = setup()
    const track = handler('get_state', { trackId: 'keys', clipLimit: 1 }) as { clips: Record<string, unknown>[] }
    expect(track).toMatchObject({ scope: 'track', nextClipOffset: 1, track: { id: 'keys', devices: [{ id: 'eq' }] }, clips: [{ id: 'phrase', noteCount: 513, transpose: 12 }] })
    expect(track.clips[0]).not.toHaveProperty('notes')
    const notes = handler('get_state', { clipId: 'phrase', noteOffset: 512, noteLimit: 512 }) as { notes: { pitch: number }[] }
    expect(notes).toMatchObject({ scope: 'clip', noteView: 'source', noteCount: 513, noteOffset: 512, nextNoteOffset: null, notes: [{ pitch: 60, start: 128 }] })
    notes.notes[0].pitch = 10
    const original = session.getSnapshot().history.present.tracks[0].clips[0] as MidiClip
    expect(original.notes[512].pitch).toBe(60)
    expect(handler('get_state', { clipId: 'phrase' })).toMatchObject({ noteOffset: 0, nextNoteOffset: 128 })
  })

  it('provides audio metadata without audio bytes or MIDI pages', () => {
    const { handler } = setup()
    const response = handler('get_state', { clipId: 'voice' })
    expect(response).toMatchObject({ clip: { kind: 'audio', assetId: 'asset', offsetSeconds: 1 } })
    expect(response).not.toHaveProperty('notes')
    expect(response).not.toHaveProperty('assets')
    expect(() => handler('get_state', { clipId: 'voice', noteLimit: 1 })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  })

  it('keeps source note pages explicit after trimming and exposes the source/loop coordinate metadata', () => {
    const { handler, session } = setup()
    session.edit(project => ({ ...project, tracks: project.tracks.map(track => track.id === 'keys'
      ? { ...track, clips: track.clips.map(clip => clip.id === 'phrase' ? setClipLoopEnd(trimClipStart(clip, 8, project.bpm), 180) : clip) } : track) }))
    expect(handler('get_state', { clipId: 'phrase', noteLimit: 1 })).toMatchObject({
      noteView: 'source', clip: { startBeat: 8, lengthBeats: 156, sourceOffsetBeats: 4, loop: true, loopLengthBeats: 172 },
      notes: [{ id: 'note-0', start: 0 }], noteCount: 513,
    })
    expect(handler('get_state', { trackId: 'keys', clipLimit: 1 })).toMatchObject({ clips: [{ sourceOffsetBeats: 4, loopLengthBeats: 172 }] })
    expect(handler('get_capabilities', {})).toMatchObject({ units: {
      position: expect.stringContaining('note.start - (clip.sourceOffsetBeats ?? 0)'),
      regionLoop: expect.stringContaining('loopLengthBeats'),
    } })
  })

  it.each([
    [{ projectId: 'other' }, 'PROJECT_MISMATCH'],
    [{ trackId: 'missing' }, 'NOT_FOUND'],
    [{ clipId: 'missing' }, 'NOT_FOUND'],
    [{ trackId: 'keys', clipId: 'phrase' }, 'INVALID_REQUEST'],
    [{ trackId: 'keys', noteLimit: 1 }, 'INVALID_REQUEST'],
    [{ clipId: 'phrase', clipOffset: 0 }, 'INVALID_REQUEST'],
    [{ trackLimit: 101 }, 'INVALID_REQUEST'],
    [{ noteOffset: 1 }, 'INVALID_REQUEST'],
    [{ clipId: 'phrase', noteLimit: 513 }, 'INVALID_REQUEST'],
    [{ trackOffset: 0.5 }, 'INVALID_REQUEST'],
    [{ trackOffset: -1 }, 'INVALID_REQUEST'],
    [{ trackId: '' }, 'INVALID_REQUEST'],
    [{ arbitrary: true }, 'INVALID_REQUEST'],
  ] as [BridgeParams, string][])('rejects invalid query %j', (params, code) => {
    expect(() => setup().handler('get_state', params)).toThrow(expect.objectContaining({ code }))
  })

  it('exposes registered instruments, effect units and supported boundaries', () => {
    const { handler } = setup()
    const catalog = handler('get_catalog', {}) as { instruments: { id: string; params: unknown[] }[]; effects: { id: string; params: unknown[] }[] }
    expect(catalog.instruments.some(item => item.id === 'keys')).toBe(true)
    expect(catalog.effects.find(item => item.id === 'eq')?.params.length).toBeGreaterThan(0)
    expect(handler('get_catalog', { kind: 'effects' })).not.toHaveProperty('instruments')
    expect(handler('get_catalog', { kind: 'instruments' })).not.toHaveProperty('effects')
    expect(() => handler('get_catalog', { kind: ['effects'] })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    const capabilities = handler('get_capabilities', {})
    expect(capabilities).toMatchObject({ units: { pitch: expect.stringContaining('C3=60') }, unsupported: expect.arrayContaining(['composition-language execution', 'transport control']), commands: expect.arrayContaining([expect.objectContaining({ type: 'clip.addMidi' })]) })
    expect(() => handler('get_capabilities', { unexpected: true })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(() => handler('not_real' as DawMethod, {})).toThrow(expect.objectContaining({ code: 'METHOD_NOT_SUPPORTED' }))
  })
})

describe('DAW host mutation boundary', () => {
  it('blocks all requests until loading finishes and blocks writes during read-only or busy states', () => {
    const { handler, runtime, session, request } = setup()
    runtime.ready = false
    expect(() => handler('get_state', {})).toThrow(expect.objectContaining({ code: 'DAW_NOT_READY' }))
    runtime.ready = true; runtime.editsAllowed = false
    const edit = request([{ type: 'track.setVolumeDb', trackId: 'keys', volumeDb: -6 }])
    const before = session.getSnapshot()
    expect(handler('preview_edits', edit)).toMatchObject({ preview: true, changed: true })
    expect(session.getSnapshot()).toBe(before)
    expect(() => handler('apply_edits', edit)).toThrow(expect.objectContaining({ code: 'READ_ONLY' }))
    runtime.editsAllowed = true; runtime.blockedReason = 'Recording'
    expect(handler('get_state', {})).toMatchObject({ editAccess: { allowed: false, reason: 'Recording' } })
    expect(() => handler('apply_edits', edit)).toThrow(expect.objectContaining({ code: 'DAW_BUSY' }))
    expect(() => handler('history', { projectId: 'project', expectedRevision: 0, operationId: 'undo', action: 'undo' })).toThrow(expect.objectContaining({ code: 'DAW_BUSY' }))
    expect(session.getSnapshot()).toBe(before)
  })

  it('applies a MIDI draft and gain as one history entry, then undoes it through the same host', () => {
    const { handler, session, request, onMutation } = setup()
    const original = session.getSnapshot().history.present
    const edit = request([
      { type: 'track.setVolumeDb', trackId: 'keys', volumeDb: -6 },
      { type: 'track.create', kind: 'instrument', instrument: 'keys', name: '8마디 초안', initialClip: { startBeat: 0, lengthBeats: 32, notes: [{ pitch: 60, start: 0, duration: 1, velocity: 0.7 }, { pitch: 67, start: 28, duration: 1, velocity: 0.8 }] } },
    ])
    const result = handler('apply_edits', edit)
    expect(result).toMatchObject({ changed: true, revision: 1, currentRevision: 1, persistence: 'pending', changes: { created: { tracks: 1, clips: 1, notes: 2 } } })
    expect(session.getSnapshot().history.past).toHaveLength(1)
    expect(session.getSnapshot().history.present.tracks[0].volume).toBeCloseTo(10 ** (-6 / 20))
    expect(session.getSnapshot().history.present.tracks[3].clips[0]).toMatchObject({ kind: 'midi', lengthBeats: 32, notes: [{ pitch: 60 }, { pitch: 67 }] })
    expect(onMutation).toHaveBeenCalledTimes(1)
    expect(handler('history', { projectId: 'project', expectedRevision: 1, operationId: 'undo', action: 'undo' })).toMatchObject({ changed: true, revision: 2, currentRevision: 2 })
    expect(session.getSnapshot().history.present).toEqual(original)
  })

  it('does not repeat post-commit effects or report a fresh save for a retried operation', () => {
    const { handler, session, request, onMutation } = setup()
    const edit = request([{ type: 'track.setPan', trackId: 'keys', pan: 0.5 }])
    handler('apply_edits', edit)
    session.edit(project => ({ ...project, name: 'User renamed after AI' }))
    expect(handler('apply_edits', edit)).toMatchObject({ changed: true, revision: 1, currentRevision: 2, persistence: 'saved' })
    expect(onMutation).toHaveBeenCalledTimes(1)
    expect(session.getSnapshot().history.past).toHaveLength(2)
  })

  it('reports a committed edit honestly even if a post-commit observer fails', () => {
    const { handler, session, request, onMutation } = setup()
    onMutation.mockImplementation(() => { throw new Error('Audio unavailable') })
    expect(handler('apply_edits', request([{ type: 'track.setPan', trackId: 'keys', pan: -0.2 }]))).toMatchObject({ changed: true, revision: 1, warnings: [expect.stringContaining('편집은 적용')] })
    expect(session.getSnapshot().history.present.tracks[0].pan).toBe(-0.2)
  })

  it('does not notify or create history for a no-op', () => {
    const { handler, session, request, onMutation } = setup()
    expect(handler('apply_edits', request([{ type: 'track.setPan', trackId: 'keys', pan: 0 }]))).toMatchObject({ changed: false, revision: 0, currentRevision: 0, persistence: 'saved' })
    expect(onMutation).not.toHaveBeenCalled()
    expect(session.getSnapshot().history.past).toHaveLength(0)
  })
})

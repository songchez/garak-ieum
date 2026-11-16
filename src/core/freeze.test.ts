import { describe, expect, it } from 'vitest'
import { createDevice, createEmptyProject, createTrack, duplicateTrack, FREEZE_SCHEMA_VERSION, PROJECT_SCHEMA_VERSION, validateProject } from './project'
import { FREEZE_ASSET_PREFIX, canonicalJson, freezeSignature, freezeStatus, frozenEditViolation, playbackProject, unusedFreezeAssets } from './freeze'
import { ProjectSession } from './ProjectSession'
import { setTempoAt } from './tempoMap'
import { compileNativeTimeline } from '../audio/native/timeline'
import { renderTailSeconds, trackTailSeconds } from '../audio/graph'
import type { MidiClip, Project, Track, TrackFreeze } from './types'

const midi = (id: string, patch: Partial<MidiClip> = {}): MidiClip => ({
  id, kind: 'midi', name: id, startBeat: 0, lengthBeats: 4, gain: 1, notes: [{ id: `${id}-n`, start: 0, duration: 1, pitch: 60, velocity: 0.8 }], ...patch,
})
const keys = (patch: Partial<Track> = {}): Track => ({ ...createTrack('instrument', 'keys'), id: 'keys', name: 'Keys', clips: [midi('c1')], devices: [({ ...createDevice('delay', {}), id: 'dly' })], ...patch })
const project = (tracks: Track[], patch: Partial<Project> = {}): Project => ({
  ...createEmptyProject(), id: 'p', bpm: 120, sampleRate: 48000, lengthBeats: 16, loop: { enabled: false, startBeat: 0, endBeat: 16 }, tracks, ...patch,
})
const frozen = (p: Project, trackId = 'keys', assetId = `${FREEZE_ASSET_PREFIX}a`): Project => ({
  ...p, tracks: p.tracks.map(track => track.id === trackId ? { ...track, freeze: { assetId, signature: freezeSignature(p, track), tailSeconds: 1.5, sampleRate: p.sampleRate } satisfies TrackFreeze } : track),
})
const has = (...ids: string[]) => new Map(ids.map(id => [id, {}]))

describe('freeze signature (docs/BOUNCE_FREEZE_STEMS.md)', () => {
  it('ignores mixing and naming but follows content and project timing', () => {
    const base = project([keys(), { ...createTrack('return'), id: 'ret', name: 'Ret' }])
    const track = base.tracks[0]
    const signature = freezeSignature(base, track)
    const same = (patch: Partial<Track>) => freezeSignature(base, { ...track, ...patch })
    expect(same({ volume: 0.3, pan: -1, mute: true, solo: true, name: 'Other', color: '#123456', sends: [{ returnId: 'ret', level: 0.5 }] })).toBe(signature)
    expect(same({ automation: [{ id: 'l', target: { kind: 'track', param: 'volume' }, points: [{ beat: 0, value: 0.2 }] }] })).toBe(signature)
    expect(same({ clips: [midi('c1', { startBeat: 1 })] })).not.toBe(signature)
    expect(same({ devices: [({ ...createDevice('delay', { feedback: 0.9 }), id: 'dly' })] })).not.toBe(signature)
    expect(same({ instrument: 'bass' })).not.toBe(signature)
    expect(same({ transpose: 2 })).not.toBe(signature)
    expect(same({ automation: [{ id: 'l', target: { kind: 'device', deviceId: 'dly', param: 'feedback' }, points: [{ beat: 0, value: 0.2 }] }] })).not.toBe(signature)
    expect(freezeSignature({ ...base, lengthBeats: 32, loop: { enabled: false, startBeat: 0, endBeat: 32 } }, track)).not.toBe(signature)
    expect(freezeSignature({ ...base, sampleRate: 44100 }, track)).not.toBe(signature)
    expect(freezeSignature(setTempoAt(base, 8, 90), track)).not.toBe(signature)
  })

  it('survives a save/load round trip (validation normalizes defaults)', () => {
    const p = frozen(project([keys({ clips: [midi('c1', { mute: false, loop: false })] })]))
    const loaded = validateProject(JSON.parse(JSON.stringify(p)))
    expect(loaded.schemaVersion).toBe(PROJECT_SCHEMA_VERSION)
    expect(loaded.tracks[0].freeze).toEqual(p.tracks[0].freeze)
    expect(freezeStatus(loaded, loaded.tracks[0], has(`${FREEZE_ASSET_PREFIX}a`))).toBe('frozen')
  })

  it('is canonical: key order and undefined members do not matter', () => {
    expect(canonicalJson({ b: 1, a: [1, { d: undefined, c: 2 }] })).toBe(canonicalJson({ a: [1, { c: 2 }], b: 1 }))
  })
})

describe('freeze schema', () => {
  it(`persists Track.freeze from schema ${FREEZE_SCHEMA_VERSION}, rejects it before, and drops malformed or return records`, () => {
    const p = frozen(project([keys()]))
    expect(() => validateProject({ ...JSON.parse(JSON.stringify(p)), schemaVersion: FREEZE_SCHEMA_VERSION - 1 })).toThrow(/Frozen tracks require/)
    const broken = JSON.parse(JSON.stringify(p))
    broken.tracks[0].freeze = { assetId: 'x', signature: 's', tailSeconds: -1, sampleRate: 48000 }
    expect(validateProject(broken).tracks[0].freeze).toBeUndefined()
    const ret: Track = { ...createTrack('return'), id: 'ret', freeze: { assetId: 'x', signature: 's', tailSeconds: 1, sampleRate: 48000 } }
    expect(validateProject(project([ret])).tracks[0].freeze).toBeUndefined()
    expect(duplicateTrack(p.tracks[0]).freeze).toBeUndefined()
  })
})

describe('frozen playback and invalidation', () => {
  it('plays the cached render through the live fader, pan and sends; anything else stays live', () => {
    const ret = { ...createTrack('return'), id: 'ret', name: 'Ret' }
    const p = frozen(project([keys({ volume: 0.5, pan: 0.25, sends: [{ returnId: 'ret', level: 0.3 }], automation: [
      { id: 'v', target: { kind: 'track', param: 'volume' }, points: [{ beat: 0, value: 0.5 }] },
      { id: 'd', target: { kind: 'device', deviceId: 'dly', param: 'feedback' }, points: [{ beat: 0, value: 0.5 }] },
    ] }), ret, { ...createTrack('audio'), id: 'live' }]))
    const assets = has(`${FREEZE_ASSET_PREFIX}a`)
    const played = playbackProject(p, assets)
    const track = played.tracks[0]
    expect(track).toMatchObject({ id: 'keys', kind: 'audio', clips: [], devices: [], volume: 0.5, pan: 0.25, sends: [{ returnId: 'ret', level: 0.3 }],
      render: { frozen: { assetId: `${FREEZE_ASSET_PREFIX}a`, tailSeconds: 1.5 } } })
    expect(track.automation?.map(lane => lane.id)).toEqual(['v'])
    expect(track.freeze).toBeUndefined()
    expect(played.tracks[1]).toBe(p.tracks[1])
    expect(played.tracks[2]).toBe(p.tracks[2])
    // Identity is stable for unchanged input, so engines see no edit between calls.
    expect(playbackProject(p, assets)).toBe(played)
    expect(playbackProject({ ...p }, new Map(assets)).tracks[0]).toBe(track)
    // A missing cache, a tempo change or another project rate makes the freeze stale: the track plays live.
    expect(playbackProject(p, new Map()).tracks[0]).toBe(p.tracks[0])
    const retimed = setTempoAt(p, 4, 100)
    expect(freezeStatus(retimed, retimed.tracks[0], assets)).toBe('stale')
    expect(playbackProject(retimed, assets).tracks[0]).toBe(retimed.tracks[0])
    expect(playbackProject({ ...p, sampleRate: 44100 }, assets).tracks[0].render).toBeUndefined()
  })

  it('reports the stored tail to the render tail and compiles a native freeze window', () => {
    const p = frozen(project([keys()]))
    const played = playbackProject(p, has(`${FREEZE_ASSET_PREFIX}a`))
    expect(trackTailSeconds(played)).toBe(1.5)
    expect(renderTailSeconds(played)).toBe(1.5)
    const timeline = compileNativeTimeline(played, new Map([[`${FREEZE_ASSET_PREFIX}a`, { id: `${FREEZE_ASSET_PREFIX}a`, sampleRate: 48000, frames: 48000 * 10, channels: 1 }]]))
    expect(timeline.tracks[0].source).toEqual({ kind: 'audio' })
    expect(timeline.tracks[0].inserts).toEqual([])
    expect(timeline.tracks[0].audio).toEqual([expect.objectContaining({ startFrame: 0, endFrame: 48000 * 10, freeze: true, tailSeconds: 1.5, gain: 1, clipOffsetFrames: 0 })])
    // The window runs past the project end (8 s at 120 BPM) into the export tail.
    expect(timeline.tracks[0].audio[0].endFrame).toBeGreaterThan(timeline.lengthFrames)
  })

  it('locks content edits of frozen tracks but allows mixing, freezing, unfreezing and deleting', () => {
    const live = project([keys()])
    const p = frozen(live)
    const edit = (patch: Partial<Track>): Project => ({ ...p, tracks: [{ ...p.tracks[0], ...patch }] })
    expect(frozenEditViolation(p, edit({ clips: [midi('c1', { startBeat: 2 })] }))?.id).toBe('keys')
    expect(frozenEditViolation(p, edit({ devices: [] }))?.id).toBe('keys')
    expect(frozenEditViolation(p, edit({ instrumentParams: { ...p.tracks[0].instrumentParams, release: 3 } }))?.id).toBe('keys')
    expect(frozenEditViolation(p, edit({ volume: 0.2, pan: 1, mute: true, name: 'Renamed' }))).toBeNull()
    expect(frozenEditViolation(p, edit({ automation: [{ id: 'v', target: { kind: 'track', param: 'pan' }, points: [] }] }))).toBeNull()
    expect(frozenEditViolation(live, p)).toBeNull()
    expect(frozenEditViolation(p, live)).toBeNull()
    expect(frozenEditViolation(p, { ...p, tracks: [] })).toBeNull()
    // Re-creating identical content (a new object) is not an edit.
    expect(frozenEditViolation(p, edit({ clips: p.tracks[0].clips.map(clip => ({ ...clip })) }))).toBeNull()
  })

  it('refuses frozen edits in the editing session (UI notice) and over MCP (TRACK_FROZEN)', () => {
    const session = new ProjectSession(frozen(project([keys()])))
    const notices: string[] = []
    session.onBlocked(message => notices.push(message))
    const before = session.getSnapshot()
    session.edit(p => ({ ...p, tracks: [{ ...p.tracks[0], clips: [] }] }), '', '리전 삭제')
    expect(session.getSnapshot()).toBe(before)
    expect(notices[0]).toMatch(/얼려져 있어 편집할 수 없습니다/)
    session.edit(p => ({ ...p, tracks: [{ ...p.tracks[0], volume: 0.4 }] }), '', '볼륨')
    expect(session.getSnapshot().history.present.tracks[0].volume).toBe(0.4)
    const state = session.getSnapshot()
    expect(() => session.execute({ projectId: 'p', expectedRevision: state.revision, operationId: 'op-1', commands: [{ type: 'clip.delete', clipId: 'c1' }] }))
      .toThrow(expect.objectContaining({ code: 'TRACK_FROZEN' }))
  })

  it('finds freeze caches no present or undo/redo state refers to', () => {
    const p = frozen(project([keys()]), 'keys', `${FREEZE_ASSET_PREFIX}used`)
    expect(unusedFreezeAssets([p, project([keys()])], [`${FREEZE_ASSET_PREFIX}used`, `${FREEZE_ASSET_PREFIX}old`, 'recording'])).toEqual([`${FREEZE_ASSET_PREFIX}old`])
  })
})

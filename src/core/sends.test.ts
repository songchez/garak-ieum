import { describe, expect, it } from 'vitest'
import { DEFAULT_TRACK_COLORS, createEmptyProject, createTrack, duplicateTrack, duplicateTrackSettings, validateProject } from './project'
import { audibleTrackIds } from './playback'
import { RETURN_COLOR, applySend, createEffectReturns, createReturnTrack, detachDeletedSends, nextReturnName, reconcileSends, remapCopiedSends, returnLetter, sendLevel, sendProblem } from './sends'
import { masterFeedExcluded, routeChoices, routeLevels, routeProblem } from './trackRouting'
import type { Project, Track } from './types'

const track = (kind: Track['kind'], id: string, patch: Partial<Track> = {}): Track => ({ ...createTrack(kind), id, name: id, ...patch })
const project = (tracks: Track[]): Project => ({ ...createEmptyProject(), tracks })

describe('send/return model (docs/SENDS_RETURNS.md)', () => {
  it('creates solo-safe returns at unity and the reverb quick action with 100% wet Hall and Echo', () => {
    const empty = createReturnTrack(nextReturnName([]))
    expect(empty).toMatchObject({ kind: 'return', name: 'A 리턴', volume: 1, soloSafe: true, clips: [], devices: [] })
    const [hall, echo] = createEffectReturns([empty])
    expect(hall.name).toBe('B 리버브')
    expect(echo.name).toBe('C 딜레이')
    expect(hall.devices).toEqual([expect.objectContaining({ type: 'reverb', name: '대청 Hall', params: expect.objectContaining({ amount: 1, dry: 0 }) })])
    expect(echo.devices).toEqual([expect.objectContaining({ type: 'delay', name: '메아리 Echo', params: expect.objectContaining({ amount: 1, dry: 0 }) })])
    expect([0, 1, 25, 26, 27].map(returnLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AB'])
    expect(empty.color).toBe(DEFAULT_TRACK_COLORS.return)
    expect(RETURN_COLOR).toBe(DEFAULT_TRACK_COLORS.return)
  })

  it('edits one send per return and refuses loops (a return cannot send, not even to itself)', () => {
    let p = project([track('audio', 'vox'), track('return', 'ret')])
    p = applySend(p, 'vox', 'ret', { level: 0.5 })
    expect(p.tracks[0].sends).toEqual([{ returnId: 'ret', level: 0.5 }])
    p = applySend(p, 'vox', 'ret', { pre: true })
    expect(p.tracks[0].sends).toEqual([{ returnId: 'ret', level: 0.5, pre: true }])
    expect(applySend(p, 'vox', 'ret', { pre: true })).toBe(p)
    expect(sendLevel(applySend(p, 'vox', 'ret', { level: 9 }).tracks[0], 'ret')).toBe(2)
    expect(applySend(p, 'vox', 'ret', null).tracks[0].sends).toBeUndefined()
    expect(sendProblem(p, 'ret', 'ret')).toMatch(/자기 자신/)
    expect(() => applySend(p, 'ret', 'ret', { level: 1 })).toThrow(/자기 자신/)
    expect(() => applySend(project([...p.tracks, track('return', 'ret2')]), 'ret', 'ret2', { level: 1 })).toThrow(/센드를 가질 수 없습니다/)
    expect(() => applySend(p, 'vox', 'vox', { level: 1 })).toThrow(/리턴 트랙/)
  })

  it('removes sends with a deleted return in the same edit and remaps copies made together', () => {
    const vox = track('audio', 'vox', { sends: [{ returnId: 'a', level: 0.5 }, { returnId: 'b', level: 0.25, pre: true }] })
    const deleted = detachDeletedSends(project([vox, track('return', 'b')]))
    expect(deleted.tracks[0].sends).toEqual([{ returnId: 'b', level: 0.25, pre: true }])
    expect(detachDeletedSends(deleted)).toBe(deleted)
    expect(reconcileSends([track('audio', 'x', { sends: [{ returnId: 'gone', level: 1 }] })])[0].sends).toBeUndefined()
    // Duplicates keep their sends (fresh arrays); a return copied in the same operation receives the copied sends.
    const copy = duplicateTrack(vox), settings = duplicateTrackSettings(vox)
    expect(copy.sends).toEqual(vox.sends)
    expect(copy.sends).not.toBe(vox.sends)
    expect(settings.sends).toEqual(vox.sends)
    const remapped = remapCopiedSends([copy], new Map([['vox', copy.id], ['a', 'a-copy']]))
    expect(remapped[0].sends).toEqual([{ returnId: 'a-copy', level: 0.5 }, { returnId: 'b', level: 0.25, pre: true }])
  })
})

describe('send/return solo logic follows Logic/Ableton', () => {
  const tracks = () => [
    track('audio', 'vox', { sends: [{ returnId: 'verb', level: 0.5 }] }),
    track('instrument', 'keys', { sends: [{ returnId: 'echo', level: 0.4 }] }),
    track('audio', 'gtr', { sends: [{ returnId: 'echo', level: 0 }] }),
    track('return', 'verb', { soloSafe: true }),
    track('return', 'echo', { soloSafe: false }),
  ]
  const solo = (list: Track[], ids: string[]) => list.map(item => ids.includes(item.id) ? { ...item, solo: true } : item)

  it('keeps solo-safe returns audible and implies the returns a soloed track feeds', () => {
    expect([...audibleTrackIds(tracks())].sort()).toEqual(['echo', 'gtr', 'keys', 'verb', 'vox'])
    expect([...audibleTrackIds(solo(tracks(), ['vox']))].sort()).toEqual(['verb', 'vox'])
    // echo is not solo-safe, but the soloed keys send to it.
    expect([...audibleTrackIds(solo(tracks(), ['keys']))].sort()).toEqual(['echo', 'keys', 'verb'])
  })

  it('soloing a return implies the tracks that send to it (level above 0 only), and mute still wins', () => {
    expect([...audibleTrackIds(solo(tracks(), ['echo']))].sort()).toEqual(['echo', 'keys', 'verb'])
    const muted = solo(tracks(), ['echo']).map(item => item.id === 'keys' ? { ...item, mute: true } : item)
    expect([...audibleTrackIds(muted)].sort()).toEqual(['echo', 'verb'])
  })
})

describe('sends in the routing graph', () => {
  it('renders returns after every sender and keeps them out of route sources', () => {
    const tracks = [
      track('return', 'ret'),
      track('audio', 'rec', { inputRoute: { kind: 'track', trackId: 'synth', tap: 'postFx' }, sends: [{ returnId: 'ret', level: 1 }] }),
      track('instrument', 'synth', { sends: [{ returnId: 'ret', level: 1 }] }),
    ]
    const levels = routeLevels(tracks)
    expect(levels.get('synth')).toBe(0)
    expect(levels.get('rec')).toBe(1)
    expect(levels.get('ret')).toBe(2)
    const p = project(tracks)
    expect(routeChoices(p, 'rec').map(choice => choice.trackId)).toEqual(['synth'])
    expect(routeProblem(p, 'rec', { kind: 'track', trackId: 'ret', tap: 'postFader' })).toMatch(/리턴 트랙/)
  })

  it('leaves a return fed by a resampling track out of the master feed', () => {
    const tracks = [
      track('audio', 'resample', { inputRoute: { kind: 'master' }, sends: [{ returnId: 'fx', level: 1 }] }),
      track('return', 'fx'), track('return', 'clean'), track('audio', 'dry', { sends: [{ returnId: 'clean', level: 1 }] }),
    ]
    expect([...masterFeedExcluded(tracks)].sort()).toEqual(['fx', 'resample'])
    const levels = routeLevels(tracks)
    expect(levels.get('clean')).toBe(1)
    expect(levels.get('resample')).toBe(2)
    expect(levels.get('fx')).toBe(3)
  })
})

describe('schema 15 send/return validation', () => {
  const saved = (tracks: Track[], schemaVersion = 15) => JSON.parse(JSON.stringify({ ...project(tracks), schemaVersion }))

  it('round-trips returns and sends, and loads schema 13 and 14 files (no sends) as the current schema', () => {
    const tracks = [track('audio', 'vox', { sends: [{ returnId: 'ret', level: 0.5, pre: true }] }), createReturnTrack('리버브')]
    tracks[0].sends![0].returnId = tracks[1].id
    const loaded = validateProject(saved(tracks))
    expect(loaded.schemaVersion).toBe(18)
    expect(loaded.tracks[0].sends).toEqual([{ returnId: tracks[1].id, level: 0.5, pre: true }])
    expect(loaded.tracks[1]).toMatchObject({ kind: 'return', soloSafe: true, volume: 1 })
    expect(validateProject(loaded)).toEqual(loaded)
    for (const version of [13, 14]) expect(validateProject(saved([track('audio', 'a')], version)).schemaVersion).toBe(18)
  })

  it('requires schema 15 and rejects sends on returns, regions on returns and repeated returns', () => {
    const ret = track('return', 'ret')
    expect(() => validateProject(saved([ret], 14))).toThrow(/schema version 15/)
    expect(() => validateProject(saved([track('audio', 'a', { sends: [{ returnId: 'ret', level: 1 }] }), ret], 14))).toThrow(/schema version 15/)
    expect(() => validateProject(saved([{ ...ret, sends: [{ returnId: 'ret', level: 1 }] }]))).toThrow(/cannot have sends/)
    expect(() => validateProject(saved([{ ...ret, clips: [{ id: 'c', kind: 'midi', name: 'x', startBeat: 0, lengthBeats: 1, gain: 1, notes: [] }] }]))).toThrow(/regions/)
    expect(() => validateProject(saved([track('audio', 'a', { sends: [{ returnId: 'ret', level: 1 }, { returnId: 'ret', level: 0.5 }] }), ret]))).toThrow(/repeats/)
    expect(() => validateProject(saved([track('audio', 'a', { sends: [{ returnId: 'ret', level: 3 }] }), ret]))).toThrow(/level/)
  })

  it('drops sends to a missing track or a non-return track on load', () => {
    const loaded = validateProject(saved([track('audio', 'a', { sends: [{ returnId: 'gone', level: 1 }, { returnId: 'b', level: 1 }] }), track('audio', 'b')]))
    expect(loaded.tracks[0].sends).toBeUndefined()
  })
})

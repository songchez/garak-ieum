import { describe, expect, it, vi } from 'vitest'
import { createEmptyProject, createTrack, duplicateTrack, duplicateTrackSettings, validateProject } from './project'
import { recordTakeTrackIds, recordTarget } from './trackActions'
import { combineTakeCaptures, type TakeCallbacks, type TakeCapture, type TakeResult } from './recording'
import {
  applyTrackSource, detachDeletedRoutes, masterFeedExcluded, reconcileTrackRoutes, remapCopiedRoutes, routeChoices, routeLevels, routeProblem, routeText,
} from './trackRouting'
import type { Project, Track, TrackInputRoute } from './types'

const from = (trackId: string, tap: 'preFx' | 'postFx' | 'postFader' = 'postFx'): TrackInputRoute => ({ kind: 'track', trackId, tap })
const audio = (id: string, name: string, inputRoute?: TrackInputRoute): Track => ({ ...createTrack('audio'), id, name, ...(inputRoute ? { inputRoute } : {}) })
const synth = (id: string, name: string): Track => ({ ...createTrack('instrument'), id, name })
const project = (...tracks: Track[]): Project => ({ ...createEmptyProject(), tracks })

describe('track-input routes', () => {
  it('lists every other track, instruments included, and refuses self and (transitive) feedback loops', () => {
    const p = project(synth('piano', '피아노'), audio('a', 'A', from('piano')), audio('b', 'B', from('a')), audio('c', 'C'))
    expect(routeChoices(p, 'c').map(choice => choice.trackId)).toEqual(['piano', 'a', 'b'])
    expect(routeProblem(p, 'c', from('c'))).toContain('자기 자신')
    // b takes a, which takes piano: a cannot take b (direct), piano is not audio, and a cannot take b's downstream.
    expect(routeProblem(p, 'a', from('b'))).toContain('되먹임')
    expect(routeProblem(p, 'piano', from('a'))).toContain('오디오 트랙만')
    expect(routeProblem(p, 'c', from('b'))).toBeNull()
    expect(routeProblem(p, 'a', { kind: 'master' })).toBeNull()
    expect(routeChoices(p, 'a').find(choice => choice.trackId === 'b')?.problem).toContain('되먹임')
    expect(() => applyTrackSource(p, 'a', from('b'))).toThrow('되먹임')
  })

  it('leaves resampling tracks and their downstream out of the master feed, and orders sources first', () => {
    const p = project(audio('r', 'R', { kind: 'master' }), audio('x', 'X', from('r', 'postFader')), synth('piano', '피아노'), audio('rec', 'Rec', from('piano')), audio('dry', 'Dry'))
    expect([...masterFeedExcluded(p.tracks)].sort()).toEqual(['r', 'x'])
    const levels = routeLevels(p.tracks)
    expect(levels.get('piano')).toBe(0)
    expect(levels.get('rec')).toBe(1)
    // Resampling hears rec (level 1), so it renders after it; x follows r.
    expect(levels.get('r')).toBe(2)
    expect(levels.get('x')).toBe(3)
  })

  it('labels the header text and survives renames because routes keep track IDs', () => {
    const p = project(synth('piano', '피아노'), audio('a', 'A', from('piano')), audio('m', 'M', { kind: 'master' }), audio('n', 'N', { kind: 'none' }))
    expect(routeText(p.tracks, p.tracks[1])).toBe('← 피아노 (시김새 후)')
    expect(routeText(p.tracks, p.tracks[2])).toBe('← 마스터 (리샘플링)')
    expect(routeText(p.tracks, p.tracks[3])).toBe('없음 (입력 트랙 삭제됨)')
    const renamed = { ...p, tracks: p.tracks.map(track => track.id === 'piano' ? { ...track, name: '그랜드' } : track) }
    expect(routeText(renamed.tracks, renamed.tracks[1])).toBe('← 그랜드 (시김새 후)')
  })

  it('turns routes to deleted tracks into none, naming the affected tracks, and breaks saved loops', () => {
    const p = project(audio('a', '베이스 녹음', from('piano')), audio('b', 'B'))
    const detached = detachDeletedRoutes(p)
    expect(detached.detached).toEqual(['베이스 녹음'])
    expect(detached.project.tracks[0].inputRoute).toEqual({ kind: 'none' })
    expect(detachDeletedRoutes(detached.project).project).toBe(detached.project)
    const loop = reconcileTrackRoutes([audio('a', 'A', from('b')), audio('b', 'B', from('a'))])
    expect(loop.map(track => track.inputRoute)).toEqual([{ kind: 'none' }, from('a')])
  })

  it('saves routes in schema 11, rejects them in older files and repairs dangling references on load', () => {
    const p = project(synth('piano', '피아노'), audio('a', 'A', from('piano', 'preFx')), audio('m', 'M', { kind: 'master' }), audio('o', 'O', from('gone')))
    const loaded = validateProject(JSON.parse(JSON.stringify(p)))
    expect(loaded.schemaVersion).toBeGreaterThanOrEqual(11)
    expect(loaded.tracks.map(track => track.inputRoute)).toEqual([undefined, from('piano', 'preFx'), { kind: 'master' }, { kind: 'none' }])
    expect(() => validateProject({ ...JSON.parse(JSON.stringify(p)), schemaVersion: 10 })).toThrow('schema version 11')
    const instrumentRoute = { ...JSON.parse(JSON.stringify(p)) }
    instrumentRoute.tracks[0].inputRoute = { kind: 'master' }
    expect(() => validateProject(instrumentRoute)).toThrow('audio track')
    const badTap = JSON.parse(JSON.stringify(p))
    badTap.tracks[1].inputRoute.tap = 'sideways'
    expect(() => validateProject(badTap)).toThrow('tap')
  })

  it('switches between a route and a physical input in one edit', () => {
    const p = project(synth('piano', '피아노'), { ...audio('a', 'A'), input: { channels: [2] } })
    const routed = applyTrackSource(p, 'a', from('piano'))
    expect(routed.tracks[1]).toMatchObject({ inputRoute: from('piano'), input: { channels: [2] } })
    const back = applyTrackSource(routed, 'a', null, { channels: [0, 1], label: 'In 1/2' })
    expect(back.tracks[1].inputRoute).toBeUndefined()
    expect(back.tracks[1].input).toEqual({ channels: [0, 1], label: 'In 1/2' })
    expect(applyTrackSource(back, 'a', null)).toBe(back)
  })

  it('duplicates keep their source, and copies made together follow each other', () => {
    const piano = synth('piano', '피아노'), rec = audio('rec', 'Rec', from('piano', 'postFader'))
    expect(duplicateTrack(rec).inputRoute).toEqual(from('piano', 'postFader'))
    expect(duplicateTrackSettings(rec).inputRoute).toEqual(from('piano', 'postFader'))
    const copies = [duplicateTrack(piano), duplicateTrack(rec)]
    const remapped = remapCopiedRoutes(copies, new Map([[piano.id, copies[0].id], [rec.id, copies[1].id]]))
    expect(remapped[1].inputRoute).toEqual(from(copies[0].id, 'postFader'))
    expect(remapCopiedRoutes([duplicateTrack(rec)], new Map([[rec.id, 'x']]))[0].inputRoute).toEqual(from('piano', 'postFader'))
  })
})

describe('recording routed tracks', () => {
  it('a single physical recorder records every armed routed track plus the topmost physical one', () => {
    const p = project(synth('piano', '피아노'), { ...audio('mic1', 'Mic 1'), armed: true }, { ...audio('r1', 'R1', from('piano')), armed: true }, { ...audio('mic2', 'Mic 2'), armed: true }, { ...audio('r2', 'R2', { kind: 'master' }), armed: true })
    const target = recordTarget(p, null)
    const routed = (id: string) => p.tracks.some(track => track.id === id && !!track.inputRoute)
    expect(recordTakeTrackIds(target, 1, routed)).toEqual(['mic1', 'r1', 'r2'])
    expect(recordTakeTrackIds(target, 1)).toEqual(['mic1'])
    expect(recordTakeTrackIds(target, 64, routed)).toEqual(['mic1', 'r1', 'mic2', 'r2'])
  })

  it('combines a graph recorder and a device recorder into one pass that completes once', async () => {
    const parts = [['r1', 'r2'], ['mic']].map(trackIds => {
      let callbacks!: TakeCallbacks
      const capture: TakeCapture = { start: vi.fn(async () => undefined), stop: vi.fn(), dispose: vi.fn(), startedAtMs: trackIds.length * 10, elapsedSeconds: trackIds.length, compensationKnown: trackIds[0] === 'mic' ? false : true, startFrameOf: id => trackIds.indexOf(id) * 100 }
      return { trackIds, create: (cb: TakeCallbacks) => { callbacks = cb; return capture }, finish: (results: TakeResult[]) => callbacks.onComplete(results), capture }
    })
    const onComplete = vi.fn()
    const combined = combineTakeCaptures(parts, { onComplete })
    await combined.start()
    expect(parts.every(part => (part.capture.start as ReturnType<typeof vi.fn>).mock.calls.length === 1)).toBe(true)
    expect(combined.startFrameOf('r2')).toBe(100)
    expect(combined.startFrameOf('mic')).toBe(0)
    expect(combined.startFrameOf('other')).toBeNull()
    expect(combined.compensationKnown).toBe(false)
    combined.stop()
    const take = (trackId: string): TakeResult => ({ trackId, blob: new Blob(['x']), durationSeconds: 1, error: null })
    parts[0].finish([take('r1'), take('r2')])
    expect(onComplete).not.toHaveBeenCalled()
    parts[1].finish([take('mic')])
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onComplete.mock.calls[0][0].map((result: TakeResult) => result.trackId)).toEqual(['r1', 'r2', 'mic'])
  })
})

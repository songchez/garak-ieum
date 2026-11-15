import { describe, expect, it } from 'vitest'
import { createEmptyProject, createTrack, validateProject } from '../../core/project'
import { ProjectSession } from '../../core/ProjectSession'
import type { AudioAsset, AudioClip, Project } from '../../core/types'
import { applyWarpRender, pendingGroups, referencedAssets } from './renderPlan'
import { attachWarpTempo, disableWarp, enableWarp } from './state'

const asset = (id: string) => ({ id } as AudioAsset)
const assets = (...ids: string[]) => new Map(ids.map(id => [id, asset(id)]))
const loop = (id: string, sourceBpm = 100, startBeat = 0): AudioClip => attachWarpTempo(
  { id, kind: 'audio', name: id, startBeat, lengthBeats: 8, gain: 1, assetId: 'orig', offsetSeconds: 0, fadeIn: 0, fadeOut: 0 },
  { bpm: sourceBpm, confidence: .9, firstBeatSeconds: 0 })
function project(bpm: number, ...clips: AudioClip[]): Project {
  return { ...createEmptyProject(), bpm, tracks: [{ ...createTrack('audio'), id: 't', clips }] }
}
const clipsOf = (value: Project) => value.tracks[0].clips as AudioClip[]
/** What the renderer does once a stretch finishes: a live change, never an undo step. */
function render(session: ProjectSession, available: Map<string, AudioAsset>) {
  for (const group of pendingGroups(session.getSnapshot().history.present, available)) {
    const id = Math.abs(group.bpm - group.sourceBpm) < 1e-6 ? group.originalAssetId : `r${group.bpm}`
    available.set(id, asset(id))
    session.dispatch({ type: 'live', edit: current => applyWarpRender(current, group, id, available) })
  }
}

describe('warp render plan', () => {
  it('groups clips that share one original and tempo into a single render', () => {
    const value = project(120, enableWarp(loop('a'), 120), enableWarp(loop('b', 100, 16), 120), loop('c', 90, 32))
    expect(pendingGroups(value, assets('orig'))).toEqual([{ key: 'orig|100|120|0', originalAssetId: 'orig', sourceBpm: 100, bpm: 120, tempoDependent: true, warpRatio: 100 / 120, cents: 0, mode: 'keep', formant: false }])
    const next = applyWarpRender(value, pendingGroups(value, assets('orig'))[0], 'r120', assets('orig', 'r120'))
    expect(clipsOf(next).map(clip => clip.assetId)).toEqual(['r120', 'r120', 'orig'])
    expect(pendingGroups(next, assets('orig', 'r120'))).toEqual([])
    expect(() => validateProject(next)).not.toThrow()
    // A stale result for another tempo is ignored.
    expect(applyWarpRender({ ...value, bpm: 90 }, pendingGroups(value, assets('orig'))[0], 'r120', assets('orig'))).toEqual({ ...value, bpm: 90 })
  })

  it('re-renders a warped clip whose render asset is missing', () => {
    const value = project(120, { ...enableWarp(loop('a'), 120), assetId: 'gone', warp: { ...enableWarp(loop('a'), 120).warp!, renderBpm: 120 } })
    expect(pendingGroups(value, assets('orig'))).toHaveLength(1)
  })

  it('keeps every undo/redo state self-consistent across tempo changes and warp toggles', () => {
    const available = assets('orig')
    const session = new ProjectSession(project(120, loop('a')))
    session.edit(current => ({ ...current, tracks: [{ ...current.tracks[0], clips: [enableWarp(clipsOf(current)[0], current.bpm)] }] }), '', '리전 편집')
    render(session, available)
    const warped = session.getSnapshot()
    expect(clipsOf(warped.history.present)[0]).toMatchObject({ assetId: 'r120', warp: { renderBpm: 120 } })
    expect(warped.undoLabel).toBe('리전 편집')
    expect(warped.history.past).toHaveLength(1)

    session.edit(current => ({ ...current, bpm: 90 }), '', '템포 조절')
    render(session, available)
    expect(clipsOf(session.getSnapshot().history.present)[0]).toMatchObject({ assetId: 'r90', warp: { renderBpm: 90 } })
    expect(session.getSnapshot().history.past).toHaveLength(2)

    session.dispatch({ type: 'undo' })
    const back = session.getSnapshot().history.present
    expect(back.bpm).toBe(120)
    expect(clipsOf(back)[0]).toMatchObject({ assetId: 'r120', warp: { renderBpm: 120 } })
    expect(pendingGroups(back, available)).toEqual([])
    session.dispatch({ type: 'redo' })
    expect(clipsOf(session.getSnapshot().history.present)[0]).toMatchObject({ assetId: 'r90' })

    session.edit(current => ({ ...current, tracks: [{ ...current.tracks[0], clips: [disableWarp(clipsOf(current)[0], current.bpm)] }] }))
    const off = clipsOf(session.getSnapshot().history.present)[0]
    expect(off).toMatchObject({ assetId: 'orig', lengthBeats: 8 * 90 / 120, warp: { enabled: false } })
    for (const state of [...session.getSnapshot().history.past, session.getSnapshot().history.present]) expect(() => validateProject(state)).not.toThrow()
    // Renders still reachable through undo must not be pruned.
    expect([...referencedAssets(session.getSnapshot())].sort()).toEqual(['orig', 'r120', 'r90'])
  })

  it('uses the original directly when the project tempo equals the source tempo', () => {
    const available = assets('orig')
    const session = new ProjectSession(project(120, enableWarp(loop('a'), 120)))
    render(session, available)
    session.edit(current => ({ ...current, bpm: 100 }))
    render(session, available)
    expect(clipsOf(session.getSnapshot().history.present)[0]).toMatchObject({ assetId: 'orig', warp: { renderBpm: 100 } })
  })
})

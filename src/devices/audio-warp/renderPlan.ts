import type { AudioAsset, AudioClip, Clip, Project } from '../../core/types'
import type { ProjectSessionSnapshot } from '../../core/ProjectSession'
import { clipAssetIds, warpNeedsRender, warpRenderKey, withWarpRender } from './state'

export interface RenderGroup { key: string; originalAssetId: string; sourceBpm: number; bpm: number }

/** Stale for this tempo, or its render is gone (e.g. pasted after the render was pruned). */
export const needsRender = (clip: AudioClip, bpm: number, assets: ReadonlyMap<string, AudioAsset>) =>
  !!clip.warp?.enabled && (warpNeedsRender(clip, bpm) || !assets.has(clip.assetId))

export function pendingGroups(project: Project, assets: ReadonlyMap<string, AudioAsset>): RenderGroup[] {
  const groups = new Map<string, RenderGroup>()
  for (const track of project.tracks) for (const clip of track.clips) {
    if (clip.kind !== 'audio' || !clip.warp || !needsRender(clip, project.bpm, assets)) continue
    const key = warpRenderKey(clip.warp, project.bpm)
    if (!groups.has(key)) groups.set(key, { key, originalAssetId: clip.warp.originalAssetId, sourceBpm: clip.warp.sourceBpm, bpm: project.bpm })
  }
  return [...groups.values()]
}

function mapWarpClips(project: Project, fn: (clip: AudioClip) => AudioClip): Project {
  let changed = false
  const tracks = project.tracks.map(track => {
    let trackChanged = false
    const clips = track.clips.map((clip: Clip) => {
      if (clip.kind !== 'audio') return clip
      const next = fn(clip)
      if (next !== clip) trackChanged = true
      return next
    })
    if (!trackChanged) return track
    changed = true
    return { ...track, clips }
  })
  return changed ? { ...project, tracks } : project
}

/** Every asset any undo/redo state can still play. */
export function referencedAssets(snapshot: ProjectSessionSnapshot): Set<string> {
  const ids = new Set<string>()
  const { past, present, future } = snapshot.history
  for (const project of [...past, present, ...future]) for (const track of project.tracks) for (const clip of track.clips) if (clip.kind === 'audio') for (const id of clipAssetIds(clip)) ids.add(id)
  return ids
}

/** Install one render into every clip waiting for it. Returns the same project if none match. */
export function applyWarpRender(project: Project, group: RenderGroup, assetId: string, assets: ReadonlyMap<string, AudioAsset>): Project {
  if (project.bpm !== group.bpm) return project
  return mapWarpClips(project, clip => clip.warp && needsRender(clip, group.bpm, assets) && warpRenderKey(clip.warp, group.bpm) === group.key ? withWarpRender(clip, group.bpm, assetId) : clip)
}

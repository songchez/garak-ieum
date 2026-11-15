import type { AudioAsset, AudioClip, Clip, Project } from '../../core/types'
import type { ProjectSessionSnapshot } from '../../core/ProjectSession'
import { clipAssetIds, clipNeedsRender, clipRenderIsIdentity, clipRenderKey, warpRatio, warpStretches, withClipRender } from './state'
import { pitchFactor, transposeTarget } from '../region-pitch/state'
import type { PcmRenderJob } from './limits'
import { tempoMapOf } from '../../core/tempoMap'

/**
 * The tempo a warped clip is rendered for: the tempo at the clip start (docs/TEMPO_MAP.md). Inside a
 * tempo ramp the render keeps that one tempo; it is not re-stretched along the ramp.
 */
export const clipTempo = (project: Project, clip: Pick<Clip, 'startBeat'>): number => tempoMapOf(project).bpmAt(clip.startBeat)

/**
 * One offline render shared by every clip of the same file, tempos and pitch settings.
 * Output = resample(stretch(original, stretch), pitch): pitch > 1 raises the pitch and
 * shortens by 1/pitch, so keep-tempo uses stretch = warp × pitch and varispeed stretch = warp.
 */
export interface RenderGroup {
  key: string
  originalAssetId: string
  sourceBpm: number
  bpm: number
  /** The render depends on the project tempo (warp stretches). */
  tempoDependent: boolean
  /** Warp time ratio (output / input); 1 without warp. */
  warpRatio: number
  /** Total region-pitch cents; 0 = none. */
  cents: number
  mode: 'keep' | 'varispeed'
  formant: boolean
}

export type RenderJob = PcmRenderJob

/** Worker parameters for a group. formantSemitones = null: no formant correction. */
export function renderJob(group: Pick<RenderGroup, 'warpRatio' | 'cents' | 'mode' | 'formant'>): RenderJob {
  const pitch = pitchFactor(group.cents)
  const stretch = group.mode === 'keep' ? group.warpRatio * pitch : group.warpRatio
  return { stretch, pitch, formantSemitones: group.cents !== 0 && group.mode === 'keep' && group.formant ? -group.cents / 100 : null }
}

/** Output length / original length of a render. */
export const renderTimeRatio = (group: Pick<RenderGroup, 'warpRatio' | 'cents' | 'mode'>) => group.mode === 'varispeed' ? group.warpRatio / pitchFactor(group.cents) : group.warpRatio

/** Stale for this tempo/pitch, or its render is gone (e.g. pasted after the render was pruned). */
export const needsRender = (clip: AudioClip, bpm: number, assets: ReadonlyMap<string, AudioAsset>) =>
  (!!clip.warp?.enabled || !!clip.regionPitch) && (clipNeedsRender(clip, bpm) || (!clipRenderIsIdentity(clip, bpm) && !assets.has(clip.assetId)))

export function groupFor(clip: AudioClip, bpm: number): RenderGroup {
  const target = transposeTarget(clip)
  const tempoDependent = warpStretches(clip, bpm)
  return {
    key: clipRenderKey(clip, bpm),
    originalAssetId: clip.regionPitch?.originalAssetId ?? clip.warp?.originalAssetId ?? clip.assetId,
    sourceBpm: clip.warp?.sourceBpm ?? bpm, bpm, tempoDependent,
    warpRatio: tempoDependent ? warpRatio(clip.warp!.sourceBpm, bpm) : 1,
    cents: target?.cents ?? 0, mode: target?.mode ?? 'keep', formant: target?.formant ?? false,
  }
}

/** An identity group plays the original file; nothing to render. */
export const isIdentityGroup = (group: RenderGroup) => !group.tempoDependent && group.cents === 0

export function pendingGroups(project: Project, assets: ReadonlyMap<string, AudioAsset>): RenderGroup[] {
  const groups = new Map<string, RenderGroup>()
  for (const track of project.tracks) for (const clip of track.clips) {
    if (clip.kind !== 'audio') continue
    const bpm = clipTempo(project, clip)
    if (!needsRender(clip, bpm, assets)) continue
    const group = groupFor(clip, bpm)
    if (!groups.has(group.key)) groups.set(group.key, group)
  }
  return [...groups.values()]
}

function mapAudioClips(project: Project, fn: (clip: AudioClip) => AudioClip): Project {
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
  // The key carries the tempo of tempo-dependent renders, so a clip whose local tempo changed never matches.
  return mapAudioClips(project, clip => {
    const bpm = clipTempo(project, clip)
    return needsRender(clip, bpm, assets) && clipRenderKey(clip, bpm) === group.key ? withClipRender(clip, bpm, assetId) : clip
  })
}

import type { Clip, Track } from './types'

/** The region name describes its own transpose parameter; track transpose is shown in the inspector. */
export function regionDisplayName(clip: Clip): string {
  const transpose = clip.kind === 'midi' ? clip.transpose ?? 0 : 0
  return transpose ? `${clip.name} (${transpose > 0 ? '+' : ''}${transpose})` : clip.name
}

export interface RegionPlacement {
  clip: Clip
  trackId: string
}

/**
 * A temporary track layout for drawing loops during a move/trim/copy gesture. The playback
 * loop calculation can use it unchanged, including other selected clips and destination tracks.
 * These objects never enter the project or undo history.
 */
export function previewRegionTracks(
  tracks: readonly Track[],
  placements: ReadonlyMap<string, RegionPlacement>,
  copy: boolean,
): { tracks: Map<string, Track>; placements: Map<string, RegionPlacement> } {
  const projected = new Map(tracks.map(track => [track.id, {
    ...track,
    clips: track.clips.filter(clip => copy || !placements.has(clip.id)),
  }]))
  const usedIds = new Set(tracks.flatMap(track => track.clips.map(clip => clip.id)))
  const resolved = new Map<string, RegionPlacement>()
  for (const [sourceId, placement] of placements) {
    const destination = projected.get(placement.trackId)
    if (!destination) continue
    let clip = placement.clip
    if (copy) {
      let id = `${sourceId}:preview`
      while (usedIds.has(id)) id += ':preview'
      usedIds.add(id)
      clip = { ...clip, id }
    }
    destination.clips.push(clip)
    resolved.set(sourceId, { ...placement, clip })
  }
  return { tracks: projected, placements: resolved }
}

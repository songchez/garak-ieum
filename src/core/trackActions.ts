/** Track button semantics (Logic: M/S/R/I/⏻/H with ⌥/⌘/⌃) and the derived audible/record/monitor sets. All pure. */
import type { Project, Track } from './types'

export type TrackButtonKind = 'mute' | 'solo' | 'arm' | 'monitor' | 'enabled' | 'hidden'
export interface TrackButtonMods { alt?: boolean; mod?: boolean; soloSafe?: boolean }
export type ArmState = 'off' | 'auto' | 'armed'

const FIELD: Record<TrackButtonKind, 'mute' | 'solo' | 'armed' | 'monitor' | 'enabled' | 'hidden'> = {
  mute: 'mute', solo: 'solo', arm: 'armed', monitor: 'monitor', enabled: 'enabled', hidden: 'hidden',
}

/** Applies patch(track) to every track; returns the same project when nothing actually changed. */
function mapTracks(project: Project, patch: (track: Track) => Partial<Track> | null): Project {
  let changed = false
  const tracks = project.tracks.map(track => {
    const p = patch(track)
    if (!p) return track
    for (const key of Object.keys(p) as (keyof Track)[]) {
      if (track[key] !== p[key]) { changed = true; return { ...track, ...p } }
    }
    return track
  })
  return changed ? { ...project, tracks } : project
}

export function pressTrackButton(project: Project, trackId: string, kind: TrackButtonKind, mods: TrackButtonMods = {}): Project {
  const target = project.tracks.find(t => t.id === trackId)
  if (!target) return project
  const field = FIELD[kind]
  const toggle = () => mapTracks(project, t => t.id === trackId ? { [field]: !t[field] } : null)
  const exclusive = () => mapTracks(project, t => ({ [field]: t.id === trackId }))
  switch (kind) {
    case 'mute': {
      if (mods.alt) return exclusive()
      if (mods.mod) { const s = target.mute; return mapTracks(project, t => t.mute === s ? { mute: !s } : null) }
      return toggle()
    }
    case 'solo': {
      if (mods.soloSafe) {
        const on = !target.soloSafe
        return mapTracks(project, t => t.id === trackId ? (on ? { soloSafe: true, solo: false } : { soloSafe: false }) : null)
      }
      if (mods.alt) return exclusive()
      if (mods.mod) { const v = !target.solo; return mapTracks(project, () => ({ solo: v })) }
      return toggle()
    }
    case 'arm': {
      if (mods.alt) return target.armed ? mapTracks(project, () => ({ armed: false })) : exclusive()
      return toggle()
    }
    case 'enabled': {
      if (mods.mod) { const v = !target.enabled; return mapTracks(project, () => ({ enabled: v })) }
      return toggle()
    }
    default:
      return toggle()
  }
}

/** Drag-across activation: the swept button takes the value computed at pointerdown. */
export function sweepTrackButton(project: Project, trackId: string, kind: TrackButtonKind, value: boolean): Project {
  const field = FIELD[kind]
  return mapTracks(project, t => t.id === trackId ? { [field]: value } : null)
}

/** Clear/Recall Solo (⌥S): clears every solo and remembers them, or restores the remembered ones. */
export function clearRecallSolo(project: Project, recall: string[] | null): { project: Project; recall: string[] | null } {
  const soloed = project.tracks.filter(t => t.solo).map(t => t.id)
  if (soloed.length) return { project: mapTracks(project, t => t.solo ? { solo: false } : null), recall: soloed }
  if (recall) {
    const ids = new Set(recall)
    return { project: mapTracks(project, t => ids.has(t.id) ? { solo: true } : null), recall: null }
  }
  return { project, recall: null }
}

/** 'auto' = Logic's implicit record-enable of the focused software-instrument track when no instrument track is explicitly armed. */
export function effectiveArm(track: Track, focusedTrackId: string | null, tracks: readonly Track[]): ArmState {
  if (track.armed) return 'armed'
  if (track.kind === 'instrument' && track.id === focusedTrackId && !tracks.some(t => t.kind === 'instrument' && t.armed)) return 'auto'
  return 'off'
}

export const anySolo = (project: Project): boolean => project.tracks.some(t => t.enabled && t.solo)

export function audibleTracks(project: Project): Set<string> {
  const solo = anySolo(project)
  const out = new Set<string>()
  for (const t of project.tracks) if (t.enabled && !t.mute && (!solo || t.solo || t.soloSafe)) out.add(t.id)
  return out
}

/** Silenced only because another track is soloed (the M button blinks). */
export const implicitlyMuted = (track: Track, project: Project): boolean =>
  track.enabled && !track.mute && !audibleTracks(project).has(track.id)

export type RecordReason = 'armed' | 'focusedAudio' | 'focusedInstrument' | 'none'
export interface RecordTarget { trackId: string | null; reason: RecordReason; extraArmed: string[] }

/** Topmost armed audio track wins; otherwise the focused audio track; a focused instrument track cannot record (no MIDI input). */
export function recordTarget(project: Project, focusedTrackId: string | null): RecordTarget {
  const armed = project.tracks.filter(t => t.kind === 'audio' && t.enabled && t.armed)
  if (armed.length) return { trackId: armed[0].id, reason: 'armed', extraArmed: armed.slice(1).map(t => t.id) }
  const focused = project.tracks.find(t => t.id === focusedTrackId)
  if (!focused) return { trackId: null, reason: 'none', extraArmed: [] }
  if (focused.kind === 'audio') return { trackId: focused.id, reason: 'focusedAudio', extraArmed: [] }
  return { trackId: null, reason: 'focusedInstrument', extraArmed: [] }
}

/** Audio tracks that should receive the live input stream. */
export const monitorTargets = (project: Project, recording: boolean): string[] =>
  project.tracks.filter(t => t.kind === 'audio' && t.enabled && (t.monitor || (t.armed && recording))).map(t => t.id)

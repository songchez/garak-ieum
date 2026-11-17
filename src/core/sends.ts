/**
 * Send/return (aux bus) tracks: pure helpers shared by the UI, both engines' graph builders, project
 * validation and the automation host. See docs/SENDS_RETURNS.md.
 *
 * A return track (kind 'return') has no regions and no input of its own. Audio and instrument tracks feed
 * it through sends (Track.sends); it runs its own 시김새 chain, then pan/fader/mute/solo, into the master.
 * Returns never send (v1), and a return can never be the input route of another track, so sends can
 * never form a loop.
 */
import { createDevice, createTrack, uid } from './project'
import type { Project, Track, TrackSend } from './types'

/** Linear send gain range (same scale as Track.volume): 0 = off, 1 = 0 dB, 2 = +6 dB. */
export const SEND_LEVEL_MAX = 2
/** Ableton/Logic start a newly used send at −∞; a double-click resets the knob to this. */
export const SEND_LEVEL_DEFAULT = 0
/** Returns start at unity: the return fader is the wet level of the effect. */
export const RETURN_VOLUME = 1
// Same as DEFAULT_TRACK_COLORS.return in project.ts (a literal: the two modules import each other).
export const RETURN_COLOR = '#9e66d6'

export const isReturnTrack = (track: Pick<Track, 'kind'>): boolean => track.kind === 'return'
/** Only audio and instrument tracks have sends (returns do not send in v1). */
export const canSend = (track: Pick<Track, 'kind'>): boolean => track.kind === 'audio' || track.kind === 'instrument'
export const returnTracks = (tracks: readonly Track[]): Track[] => tracks.filter(isReturnTrack)
export const sendsOf = (track: Track): readonly TrackSend[] => canSend(track) ? track.sends ?? [] : []
export const sendTo = (track: Track, returnId: string): TrackSend | undefined => sendsOf(track).find(send => send.returnId === returnId)
export const sendLevel = (track: Track, returnId: string): number => sendTo(track, returnId)?.level ?? 0
export const copySend = (send: TrackSend): TrackSend => ({ returnId: send.returnId, level: send.level, ...(send.pre ? { pre: true } : {}) })

/** "A", "B", … "Z", "AA" — the letter Ableton shows on return tracks and send knobs. */
export function returnLetter(index: number): string {
  let n = Math.max(0, Math.trunc(index)), out = ''
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1 } while (n >= 0)
  return out
}
/** Letter of a return by its position among the project's returns; '' when it is not a return. */
export function returnLetterOf(tracks: readonly Track[], returnId: string): string {
  const index = returnTracks(tracks).findIndex(track => track.id === returnId)
  return index < 0 ? '' : returnLetter(index)
}

/** An empty return: unity fader, solo-safe (soloing a track keeps it audible), no regions or inputs. */
export function createReturnTrack(name: string): Track {
  const base = createTrack('return')
  return { ...base, name: name.slice(0, 512) || '리턴', color: RETURN_COLOR, volume: RETURN_VOLUME, soloSafe: true, icon: 'return' }
}

/** Next free "리턴 A/B/…" style name. */
export function nextReturnName(tracks: readonly Track[], label = '리턴'): string {
  const names = new Set(tracks.map(track => track.name))
  const start = returnTracks(tracks).length
  for (let index = start; index < start + 702; index += 1) {
    const name = `${returnLetter(index)} ${label}`
    if (!names.has(name)) return name
  }
  return `${label} ${uid().slice(0, 4)}`
}

/**
 * The "리버브 리턴 추가" quick action (Ableton's default A Reverb / B Delay): one return with 대청 Hall and
 * one with 메아리 Echo, both 100% wet (effect amount 1, dry 0) so the return fader sets the wet level.
 */
export function createEffectReturns(tracks: readonly Track[]): Track[] {
  const hall = createReturnTrack(nextReturnName(tracks, '리버브'))
  hall.devices = [{ ...createDevice('reverb', { amount: 1, dry: 0 }), name: '대청 Hall' }]
  const echo = createReturnTrack(nextReturnName([...tracks, hall], '딜레이'))
  echo.devices = [{ ...createDevice('delay', { amount: 1, dry: 0 }), name: '메아리 Echo' }]
  return [hall, echo]
}

/** Why `trackId` cannot send to `returnId`, in Korean for the UI; null when it can. */
export function sendProblem(project: { readonly tracks: readonly Track[] }, trackId: string, returnId: string): string | null {
  const track = project.tracks.find(item => item.id === trackId)
  if (!track) return '트랙을 찾을 수 없습니다.'
  if (track.id === returnId) return '리턴 트랙은 자기 자신에게 보낼 수 없습니다.'
  if (!canSend(track)) return '리턴 트랙은 센드를 가질 수 없습니다.'
  const target = project.tracks.find(item => item.id === returnId)
  if (!target || !isReturnTrack(target)) return '보낼 리턴 트랙을 찾을 수 없습니다.'
  return null
}

export interface SendPatch { level?: number; pre?: boolean }

/** One undoable edit of one send. A level of 0 keeps the entry (it remembers pre/post) unless `remove`. */
export function applySend(project: Project, trackId: string, returnId: string, patch: SendPatch | null): Project {
  const problem = sendProblem(project, trackId, returnId)
  if (problem) throw new Error(problem)
  let changed = false
  const tracks = project.tracks.map(track => {
    if (track.id !== trackId) return track
    const sends = track.sends ?? []
    const current = sends.find(send => send.returnId === returnId)
    if (patch === null) {
      if (!current) return track
      changed = true
      const rest = sends.filter(send => send !== current)
      const { sends: _sends, ...base } = track
      return rest.length ? { ...base, sends: rest } : base
    }
    const level = patch.level === undefined ? current?.level ?? SEND_LEVEL_DEFAULT : Math.max(0, Math.min(SEND_LEVEL_MAX, Number.isFinite(patch.level) ? patch.level : 0))
    const pre = patch.pre === undefined ? !!current?.pre : patch.pre
    if (current && current.level === level && !!current.pre === pre) return track
    changed = true
    const next: TrackSend = { returnId, level, ...(pre ? { pre: true } : {}) }
    return { ...track, sends: current ? sends.map(send => send === current ? next : send) : [...sends, next] }
  })
  return changed ? { ...project, tracks } : project
}

/** Drops sends whose return no longer exists (or is not a return) and sends on tracks that cannot send.
 * Unchanged arrays and tracks are kept by identity. */
export function reconcileSends(tracks: Track[]): Track[] {
  const returns = new Set(returnTracks(tracks).map(track => track.id))
  let changed = false
  const next = tracks.map(track => {
    if (!track.sends) return track
    const seen = new Set<string>()
    const kept = canSend(track) ? track.sends.filter(send => returns.has(send.returnId) && !seen.has(send.returnId) && !!seen.add(send.returnId)) : []
    if (kept.length === track.sends.length) return track
    changed = true
    const { sends: _sends, ...base } = track
    return kept.length ? { ...base, sends: kept } : base
  })
  return changed ? next : tracks
}

/** After deleting tracks: sends that named a deleted return disappear in the same edit. */
export function detachDeletedSends(project: Project): Project {
  const tracks = reconcileSends(project.tracks)
  return tracks === project.tracks ? project : { ...project, tracks }
}

/**
 * Copies made together keep their sends among themselves (like track-input routes): a copied sender whose
 * return was copied in the same operation sends to the copied return; other sends keep their return.
 */
export function remapCopiedSends(copies: Track[], idMap: ReadonlyMap<string, string>): Track[] {
  return copies.map(track => {
    if (!track.sends) return track
    if (!canSend(track)) { const { sends: _sends, ...base } = track; return base }
    return { ...track, sends: track.sends.map(send => ({ ...copySend(send), returnId: idMap.get(send.returnId) ?? send.returnId })) }
  })
}

/** Tracks that feed `returnId` with a send entry (any level: the graph is built for every entry). */
export const sendersOf = (tracks: readonly Track[], returnId: string): Track[] => tracks.filter(track => sendsOf(track).some(send => send.returnId === returnId))

/** Graph topology of the sends (a change rebuilds the engine's routing; levels are parameters). */
export function sendLayoutKey(track: Track): string {
  const sends = sendsOf(track)
  return sends.length ? '>' + sends.map(send => `${send.returnId}${send.pre ? '^' : ''}`).join(',') : ''
}

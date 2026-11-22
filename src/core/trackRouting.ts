/**
 * Track-input routing (resampling): an audio track records another track's signal, or the master mix,
 * instead of a physical input. Pure helpers shared by the UI, both engines' graph builders and project
 * validation. See docs/TRACK_INPUT_ROUTING.md.
 */
import type { Project, Track, TrackInput, TrackInputRoute, TrackInputTap } from './types'
import { applyTrackInputs } from './trackInputs'

export const TAP_LABELS: Readonly<Record<TrackInputTap, string>> = { preFx: '시김새 전', postFx: '시김새 후', postFader: '페이더 후' }
export const TAP_ORDER: readonly TrackInputTap[] = ['preFx', 'postFx', 'postFader']
/** The default for "Audio From <track>" is Post FX. */
export const DEFAULT_TAP: TrackInputTap = 'postFx'
export const MASTER_ROUTE_LABEL = '마스터 (리샘플링)'
export const NO_ROUTE_LABEL = '없음'

/** The route a track records from, if any; only audio tracks can have one. */
export const routeOf = (track: Track): TrackInputRoute | undefined => track.kind === 'audio' ? track.inputRoute : undefined
/** True when the track records/monitors an internal signal rather than a physical input. */
export const isRouted = (track: Track): boolean => !!routeOf(track)
export const sameRoute = (a: TrackInputRoute | undefined, b: TrackInputRoute | undefined): boolean =>
  a === b || (!!a && !!b && a.kind === b.kind && (a.kind !== 'track' || (b.kind === 'track' && a.trackId === b.trackId && a.tap === b.tap)))
export const copyRoute = (route: TrackInputRoute): TrackInputRoute => route.kind === 'track' ? { kind: 'track', trackId: route.trackId, tap: route.tap } : { kind: route.kind }

/** Return IDs a track feeds through sends (docs/SENDS_RETURNS.md); returns themselves never send. */
const sendTargets = (track: Track): readonly string[] => track.kind === 'return' ? [] : (track.sends ?? []).map(send => send.returnId)

/** dst → src for every track route whose source exists (the graph's dependency edges). Return tracks are
 * never route sources (they cannot be recorded in v1), so routes and sends cannot form a loop together. */
export function trackRouteSources(tracks: readonly Track[]): Map<string, string> {
  const ids = new Set(tracks.filter(track => track.kind !== 'return').map(track => track.id))
  const edges = new Map<string, string>()
  for (const track of tracks) {
    const route = routeOf(track)
    if (route?.kind === 'track' && route.trackId !== track.id && ids.has(route.trackId)) edges.set(track.id, route.trackId)
  }
  return edges
}

/** Whether `toId` (transitively) takes `fromId`'s signal through track routes. Each track has one input,
 * so the walk follows a single chain upstream from `toId`. */
export function takesFrom(tracks: readonly Track[], toId: string, fromId: string, edges = trackRouteSources(tracks)): boolean {
  const seen = new Set<string>()
  for (let id = edges.get(toId); id !== undefined && !seen.has(id); id = edges.get(id)) {
    if (id === fromId) return true
    seen.add(id)
  }
  return false
}

/**
 * Tracks left out of the master feed a resampling track hears: every track that records the master,
 * and every track downstream of one (it carries the resampled signal), so a
 * resampling track is never fed its own output.
 */
export function masterFeedExcluded(tracks: readonly Track[], edges = trackRouteSources(tracks)): Set<string> {
  const excluded = new Set(tracks.filter(track => routeOf(track)?.kind === 'master').map(track => track.id))
  if (!excluded.size) return excluded
  for (const track of tracks) {
    if (excluded.has(track.id)) continue
    const seen = new Set<string>()
    for (let id = edges.get(track.id); id !== undefined && !seen.has(id); id = edges.get(id)) {
      if (excluded.has(id)) { excluded.add(track.id); break }
      seen.add(id)
    }
  }
  // A return fed by an excluded track carries the resampled signal too.
  for (const track of tracks) if (excluded.has(track.id)) for (const id of sendTargets(track)) excluded.add(id)
  return excluded
}

/**
 * Processing level per track: sources render before the tracks that take them. Level 0 tracks have no
 * internal input; a track route is one level above its source; a return is one level above its senders;
 * a master-resampling track is one level above every track in the master feed. The native engine computes the same order in prepare().
 * Assumes reconciled routes (no loops); a loop member would simply stay at level 0.
 */
export function routeLevels(tracks: readonly Track[]): Map<string, number> {
  const edges = trackRouteSources(tracks)
  const excluded = masterFeedExcluded(tracks, edges)
  const levels = new Map<string, number>()
  const level = (track: Track, stack: Set<string>): number => {
    const known = levels.get(track.id)
    if (known !== undefined) return known
    if (stack.has(track.id)) return 0
    stack.add(track.id)
    const route = routeOf(track)
    let value = 0
    if (route?.kind === 'track') {
      const source = tracks.find(item => item.id === edges.get(track.id))
      if (source) value = level(source, stack) + 1
    } else if (route?.kind === 'master') {
      value = 1 + Math.max(-1, ...tracks.filter(item => !excluded.has(item.id)).map(item => level(item, stack)))
    } else if (track.kind === 'return') {
      // Returns render after every track that sends to them.
      value = 1 + Math.max(-1, ...tracks.filter(item => sendTargets(item).includes(track.id)).map(item => level(item, stack)))
    }
    stack.delete(track.id)
    levels.set(track.id, value)
    return value
  }
  for (const track of tracks) level(track, new Set())
  return levels
}

/** Why `route` cannot be the input of `trackId`, in Korean for the UI; null when it can. */
export function routeProblem(project: { readonly tracks: readonly Track[] }, trackId: string, route: TrackInputRoute | null): string | null {
  const track = project.tracks.find(item => item.id === trackId)
  if (!track) return '트랙을 찾을 수 없습니다.'
  if (!route) return null
  if (track.kind !== 'audio') return '오디오 트랙만 다른 트랙이나 마스터를 녹음할 수 있습니다.'
  if (route.kind !== 'track') return null
  if (route.trackId === trackId) return '트랙은 자기 자신의 출력을 입력으로 쓸 수 없습니다.'
  const source = project.tracks.find(item => item.id === route.trackId)
  if (!source) return '입력으로 고른 트랙을 찾을 수 없습니다.'
  if (source.kind === 'return') return '리턴 트랙은 다른 트랙의 입력으로 쓸 수 없습니다.'
  if (takesFrom(project.tracks, route.trackId, trackId)) return `‘${source.name}’ 트랙이 이미 이 트랙의 신호를 받고 있어 되먹임(피드백) 루프가 생기므로 고를 수 없습니다.`
  return null
}

/** Removes references to missing tracks and breaks loops (both read as 'none'); unchanged arrays are kept. */
export function reconcileTrackRoutes(tracks: Track[]): Track[] {
  const ids = new Set(tracks.filter(track => track.kind !== 'return').map(track => track.id))
  let changed = false
  let next = tracks.map(track => {
    const route = routeOf(track)
    if (route?.kind === 'track' && (!ids.has(route.trackId) || route.trackId === track.id)) { changed = true; return { ...track, inputRoute: { kind: 'none' as const } } }
    return track
  })
  // Each track has one input, so a loop is a chain that returns to its start. Break it at the first member.
  for (const track of next) {
    if (routeOf(track)?.kind !== 'track') continue
    if (takesFrom(next, track.id, track.id)) {
      changed = true
      next = next.map(item => item.id === track.id ? { ...item, inputRoute: { kind: 'none' as const } } : item)
    }
  }
  return changed ? next : tracks
}

/** After deleting tracks: routes that named them become 'none'. Returns the names of affected tracks. */
export function detachDeletedRoutes(project: Project): { project: Project; detached: string[] } {
  const tracks = reconcileTrackRoutes(project.tracks)
  if (tracks === project.tracks) return { project, detached: [] }
  const detached = tracks.filter((track, index) => track !== project.tracks[index] && routeOf(track)?.kind === 'none').map(track => track.name)
  return { project: { ...project, tracks }, detached }
}

/**
 * Copies made together keep their routing among themselves: a copied destination whose source was copied
 * in the same operation follows the copy; other routes keep their original source (a duplicated
 * track keeps its input).
 */
export function remapCopiedRoutes(copies: Track[], idMap: ReadonlyMap<string, string>): Track[] {
  return copies.map(track => {
    const route = routeOf(track)
    if (route?.kind !== 'track') return route ? { ...track, inputRoute: copyRoute(route) } : track
    const mapped = idMap.get(route.trackId)
    return { ...track, inputRoute: { kind: 'track', trackId: mapped ?? route.trackId, tap: route.tap } }
  })
}

/** One undoable edit: null returns the track to its physical input. Throws the routeProblem message. */
export function applyTrackRoute(project: Project, trackId: string, route: TrackInputRoute | null): Project {
  const problem = routeProblem(project, trackId, route)
  if (problem) throw new Error(problem)
  let changed = false
  const tracks = project.tracks.map(track => {
    if (track.id !== trackId || track.kind !== 'audio' || sameRoute(track.inputRoute, route ?? undefined)) return track
    changed = true
    const { inputRoute: _previous, ...rest } = track
    return route ? { ...rest, inputRoute: copyRoute(route) } : rest
  })
  return changed ? { ...project, tracks } : project
}

/** "← 피아노 (시김새 후)", "← 마스터 (리샘플링)" or "없음 (입력 트랙 삭제됨)"; null for a physical input. */
export function routeText(tracks: readonly Track[], track: Track): string | null {
  const route = routeOf(track)
  if (!route) return null
  if (route.kind === 'master') return `← ${MASTER_ROUTE_LABEL}`
  if (route.kind === 'none') return `${NO_ROUTE_LABEL} (입력 트랙 삭제됨)`
  const source = tracks.find(item => item.id === route.trackId)
  return source ? `← ${source.name} (${TAP_LABELS[route.tap]})` : `${NO_ROUTE_LABEL} (입력 트랙 삭제됨)`
}

export interface RouteChoice { trackId: string; name: string; kind: Track['kind']; problem: string | null }
/** Every other track as a possible input of `trackId`, with the reason it would loop when it would. */
export function routeChoices(project: { readonly tracks: readonly Track[] }, trackId: string): RouteChoice[] {
  return project.tracks.filter(track => track.id !== trackId && track.kind !== 'return').map(track => ({
    trackId: track.id, name: track.name, kind: track.kind,
    problem: routeProblem(project, trackId, { kind: 'track', trackId: track.id, tap: DEFAULT_TAP }),
  }))
}

/** `<select>` values: hardware inputs keep their channel keys; routes use these. */
export const routeKey = (route: TrackInputRoute): string => route.kind === 'track' ? `track:${route.trackId}` : route.kind
export function routeFromKey(key: string, tap: TrackInputTap = DEFAULT_TAP): TrackInputRoute | null {
  if (key === 'master') return { kind: 'master' }
  if (key === 'none') return { kind: 'none' }
  return key.startsWith('track:') ? { kind: 'track', trackId: key.slice(6), tap } : null
}

/** Route and physical input in one edit (picking a hardware input on a routed track does both). */
export function applyTrackSource(project: Project, trackId: string, route: TrackInputRoute | null, input?: TrackInput | null): Project {
  const routed = applyTrackRoute(project, trackId, route)
  return input === undefined ? routed : applyTrackInputs(routed, [{ trackId, input }])
}

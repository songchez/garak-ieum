/** Tracks-area UI state that outlives a session: view toggles, snap, header layout, per-track zoom. Persistence follows zoom.ts. */

export type SnapMode = 'smart' | 'bar' | 'beat' | 'division' | 'ticks' | 'off'
export type DragMode = 'overlap' | 'noOverlap'

export const SNAP_MODES: readonly SnapMode[] = ['smart', 'bar', 'beat', 'division', 'ticks', 'off']
export const SNAP_MODE_LABELS: Readonly<Record<SnapMode, string>> = { smart: '스마트', bar: '마디', beat: '비트', division: '분할', ticks: '틱', off: '끔' }
export const DRAG_MODES: readonly DragMode[] = ['overlap', 'noOverlap']
export const DRAG_MODE_LABELS: Readonly<Record<DragMode, string>> = { overlap: '겹침', noOverlap: '겹치지 않음' }

/** Stable icon keys used by the track picker and saved projects. */
export const TRACK_ICON_OPTIONS: readonly (readonly [name: string, label: string])[] = [
  ['keys', '건반'], ['synth', '신스'], ['guitar', '기타'], ['strings', '현악'],
  ['wind', '관악'], ['drum', '드럼 · 타악'], ['pad', '패드'], ['note', '음표'],
  ['mic', '마이크'], ['vocal', '보컬'], ['wave', '오디오 파형'], ['audio', '오디오 파일'],
]

export interface SnapState { on: boolean; mode: SnapMode; relative: boolean }
export interface InspectorSections { region: boolean; track: boolean; strips: boolean }

export interface ViewState {
  zoomFocused: boolean
  catch: boolean
  scrollInPlay: boolean
  snap: SnapState
  dragMode: DragMode
  globalTracks: boolean
  gridLines: boolean
  inspectorOpen: boolean
  libraryOpen: boolean
  browserOpen: boolean
  inspectorSections: InspectorSections
}

export const DEFAULT_VIEW: ViewState = {
  zoomFocused: false,
  catch: true,
  scrollInPlay: false,
  snap: { on: true, mode: 'smart', relative: false },
  dragMode: 'noOverlap',
  globalTracks: false,
  gridLines: true,
  inspectorOpen: true,
  libraryOpen: true,
  browserOpen: false,
  inspectorSections: { region: true, track: true, strips: true },
}

export interface TrackHeaderConfig {
  mute: boolean
  solo: boolean
  record: boolean
  monitor: boolean
  onOff: boolean
  hide: boolean
  volume: boolean
  pan: boolean
  trackNumber: boolean
  colorBar: boolean
  icon: boolean
}

export const DEFAULT_HEADER_CONFIG: TrackHeaderConfig = {
  mute: true, solo: true, record: true, monitor: true, onOff: false, hide: false,
  volume: true, pan: true, trackNumber: true, colorBar: false, icon: true,
}

export const HEADER_WIDTH_LIMITS = { min: 160, max: 420 } as const
export const DEFAULT_HEADER_WIDTH = 248

export interface TrackHeaderState { headerWidth: number; headerConfig: TrackHeaderConfig }
export const DEFAULT_TRACK_HEADER: TrackHeaderState = { headerWidth: DEFAULT_HEADER_WIDTH, headerConfig: DEFAULT_HEADER_CONFIG }

/** Per-track height factor applied to the global row height. */
export type TrackZoom = Record<string, number>
export const TRACK_ZOOM_LIMITS = { min: .5, max: 4 } as const

export const SNAP_MIN_PX = 12
export const TICK = 1 / 960

/**
 * Grid in beats for the current snap setting; 0 = no snap.
 * Smart picks the finest of [division, 1, 4, 16] whose on-screen size is at least SNAP_MIN_PX, never finer than division.
 */
export function resolveSnap(snap: { on: boolean; mode: SnapMode }, ppb: number, division = .25): number {
  if (!snap.on) return 0
  switch (snap.mode) {
    case 'off': return 0
    case 'bar': return 4
    case 'beat': return 1
    case 'division': return division
    case 'ticks': return TICK
    default: {
      const px = Number.isFinite(ppb) && ppb > 0 ? ppb : 0
      for (const v of [division, 1, 4, 16]) if (v * px >= SNAP_MIN_PX) return v
      return 16
    }
  }
}

const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
const bool = (value: unknown, fallback: boolean) => typeof value === 'boolean' ? value : fallback
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const num = (value: unknown, min: number, max: number, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback
const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => options.includes(value as T) ? value as T : fallback

export function sanitizeView(raw: unknown, fallback: ViewState = DEFAULT_VIEW): ViewState {
  const r = obj(raw), s = obj(r.snap), sections = obj(r.inspectorSections)
  return {
    zoomFocused: bool(r.zoomFocused, fallback.zoomFocused),
    catch: bool(r.catch, fallback.catch),
    scrollInPlay: bool(r.scrollInPlay, fallback.scrollInPlay),
    snap: { on: bool(s.on, fallback.snap.on), mode: oneOf(s.mode, SNAP_MODES, fallback.snap.mode), relative: bool(s.relative, fallback.snap.relative) },
    dragMode: oneOf(r.dragMode, DRAG_MODES, fallback.dragMode),
    globalTracks: bool(r.globalTracks, fallback.globalTracks),
    gridLines: bool(r.gridLines, fallback.gridLines),
    inspectorOpen: bool(r.inspectorOpen, fallback.inspectorOpen),
    libraryOpen: bool(r.libraryOpen, fallback.libraryOpen),
    browserOpen: bool(r.browserOpen, fallback.browserOpen),
    inspectorSections: {
      region: bool(sections.region, fallback.inspectorSections.region),
      track: bool(sections.track, fallback.inspectorSections.track),
      strips: bool(sections.strips, fallback.inspectorSections.strips),
    },
  }
}

export function sanitizeHeaderConfig(raw: unknown, fallback: TrackHeaderConfig = DEFAULT_HEADER_CONFIG): TrackHeaderConfig {
  const r = obj(raw)
  const out = { ...fallback }
  for (const key of Object.keys(fallback) as (keyof TrackHeaderConfig)[]) out[key] = bool(r[key], fallback[key])
  return out
}

export function sanitizeTrackHeader(raw: unknown, fallback: TrackHeaderState = DEFAULT_TRACK_HEADER): TrackHeaderState {
  const r = obj(raw)
  return {
    headerWidth: num(r.headerWidth, HEADER_WIDTH_LIMITS.min, HEADER_WIDTH_LIMITS.max, fallback.headerWidth),
    headerConfig: sanitizeHeaderConfig(r.headerConfig, fallback.headerConfig),
  }
}

/** Keeps only finite factors within range; everything else is dropped (= factor 1). */
export function sanitizeTrackZoom(raw: unknown): TrackZoom {
  const r = obj(raw), out: TrackZoom = {}
  for (const [id, value] of Object.entries(r)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[id] = clamp(value, TRACK_ZOOM_LIMITS.min, TRACK_ZOOM_LIMITS.max)
  }
  return out
}

/** Drops entries for tracks that no longer exist. Returns the same object when nothing was removed. */
export function pruneTrackZoom(zoom: TrackZoom, trackIds: Iterable<string>): TrackZoom {
  const keep = trackIds instanceof Set ? trackIds as Set<string> : new Set(trackIds)
  const ids = Object.keys(zoom)
  if (ids.every(id => keep.has(id))) return zoom
  const out: TrackZoom = {}
  for (const id of ids) if (keep.has(id)) out[id] = zoom[id]
  return out
}

export const VIEW_STORAGE_KEY = 'garak-ieum:view'
export const TRACK_HEADER_STORAGE_KEY = 'garak-ieum:track-header'
export const trackZoomStorageKey = (projectId: string) => `garak-ieum:track-zoom:${projectId}`

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>
const store = (): KeyValueStore | undefined => { try { return globalThis.localStorage } catch { return undefined } }

function load<T>(key: string, sanitize: (raw: unknown) => T, fallback: () => T, storage: KeyValueStore | undefined): T {
  try { const text = storage?.getItem(key); return text ? sanitize(JSON.parse(text)) : fallback() } catch { return fallback() }
}
function save(key: string, value: unknown, storage: KeyValueStore | undefined) {
  try { storage?.setItem(key, JSON.stringify(value)) } catch { /* private mode or quota: view state is not essential */ }
}

export const loadView = (storage: KeyValueStore | undefined = store()): ViewState => load(VIEW_STORAGE_KEY, sanitizeView, () => DEFAULT_VIEW, storage)
export const saveView = (view: ViewState, storage: KeyValueStore | undefined = store()) => save(VIEW_STORAGE_KEY, view, storage)

export const loadTrackHeader = (storage: KeyValueStore | undefined = store()): TrackHeaderState => load(TRACK_HEADER_STORAGE_KEY, sanitizeTrackHeader, () => DEFAULT_TRACK_HEADER, storage)
export const saveTrackHeader = (state: TrackHeaderState, storage: KeyValueStore | undefined = store()) => save(TRACK_HEADER_STORAGE_KEY, state, storage)

/** With trackIds, entries for missing tracks are pruned on load. */
export const loadTrackZoom = (projectId: string, trackIds?: Iterable<string>, storage: KeyValueStore | undefined = store()): TrackZoom => {
  const zoom = load(trackZoomStorageKey(projectId), sanitizeTrackZoom, () => ({}), storage)
  return trackIds ? pruneTrackZoom(zoom, trackIds) : zoom
}
export const saveTrackZoom = (projectId: string, zoom: TrackZoom, storage: KeyValueStore | undefined = store()) => save(trackZoomStorageKey(projectId), zoom, storage)

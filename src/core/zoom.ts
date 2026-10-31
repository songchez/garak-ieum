/** Per-area zoom: pure math, bounds and persistence. Each area owns its own scale. */
export interface ZoomAxis { min: number; max: number; step?: number }

export const ZOOM_LIMITS = {
  timelineX: { min: 4, max: 200 },
  timelineY: { min: 36, max: 160 },
  pianoX: { min: 12, max: 240 },
  pianoY: { min: 8, max: 40 },
  mixerWidth: { min: 64, max: 160 },
  mixerFader: { min: 80, max: 220 },
  deviceScale: { min: .75, max: 1.5 },
} as const satisfies Record<string, ZoomAxis>

/** Keyboard/button step per press; the wheel uses a continuous factor. */
export const ZOOM_KEY_FACTOR = 1.25
export const ZOOM_KEY_FACTOR_V = 1.2
export const DEVICE_KEY_FACTOR = 1.1

export type ZoomArea = 'timeline' | 'piano' | 'mixer' | 'devices'
export type ZoomCommand = 'zoomIn' | 'zoomOut' | 'zoomInV' | 'zoomOutV' | 'zoomToFit'
export interface ZoomHandle { zoom(axis: 'x' | 'y', factor: number): void; fit(): void }

export interface ZoomState {
  timeline: { ppb: number; rowHeight: number }
  /** ppb null = fit the clip into the editor width (refits on clip/viewport change). */
  piano: { ppb: number | null; rowHeight: number }
  mixer: { channelWidth: number; faderHeight: number }
  devices: { scale: number }
  browser: { compact: boolean }
}

export const clampZoom = (value: number, axis: ZoomAxis) => Math.min(axis.max, Math.max(axis.min, value))

/** Multiplies and clamps. With a step, the result snaps to it and always moves at least one step. */
export function zoomBy(value: number, factor: number, axis: ZoomAxis): number {
  const base = Number.isFinite(value) ? value : axis.min
  const next = clampZoom(base * (Number.isFinite(factor) && factor > 0 ? factor : 1), axis)
  if (!axis.step) return next
  const s = axis.step, from = Math.round(base / s) * s
  let q = Math.round(next / s) * s
  if (factor > 1 && q <= from) q = from + s
  else if (factor < 1 && q >= from) q = from - s
  return clampZoom(Math.round(q / s) * s, axis)
}

/** New scroll offset that keeps the content point under the pointer fixed when the scale changes. */
export function zoomAround(scroll: number, pointerOffset: number, oldScale: number, newScale: number): number {
  if (!(oldScale > 0) || !(newScale > 0)) return Math.max(0, scroll)
  return Math.max(0, (scroll + pointerOffset) / oldScale * newScale - pointerOffset)
}

/** Scale at which contentLength (in content units) fills the viewport, clamped to the axis. */
export function fitScale(contentLength: number, viewport: number, axis: ZoomAxis): number {
  return clampZoom(viewport / Math.max(1e-6, contentLength), axis)
}

/** Wheel delta in pixels regardless of deltaMode (lines ×16, pages ×400), clamped per event. */
export function wheelPixels(delta: number, deltaMode = 0): number {
  const px = delta * (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1)
  return Math.max(-300, Math.min(300, px))
}
export const wheelFactor = (delta: number, deltaMode = 0) => Math.exp(-wheelPixels(delta, deltaMode) * .0015)

/** Defaults follow the old CSS breakpoints: tall rows on wide screens, short rows on short screens. */
export function defaultZoom(view: { width: number; height: number } = typeof window === 'undefined' ? { width: 1280, height: 900 } : { width: window.innerWidth, height: window.innerHeight }): ZoomState {
  const rowHeight = view.height <= 760 ? 62 : view.width >= 1700 ? 80 : 70
  return { timeline: { ppb: 30, rowHeight }, piano: { ppb: null, rowHeight: 19 }, mixer: { channelWidth: 110, faderHeight: 110 }, devices: { scale: 1 }, browser: { compact: false } }
}

const num = (value: unknown, axis: ZoomAxis, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? clampZoom(value, axis) : fallback
const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}

/** Accepts any stored value; unknown or out-of-range fields fall back or are clamped. */
export function sanitizeZoom(raw: unknown, fallback: ZoomState = defaultZoom()): ZoomState {
  const r = obj(raw), t = obj(r.timeline), p = obj(r.piano), m = obj(r.mixer), d = obj(r.devices), b = obj(r.browser)
  return {
    timeline: { ppb: num(t.ppb, ZOOM_LIMITS.timelineX, fallback.timeline.ppb), rowHeight: num(t.rowHeight, ZOOM_LIMITS.timelineY, fallback.timeline.rowHeight) },
    piano: { ppb: typeof p.ppb === 'number' && Number.isFinite(p.ppb) ? clampZoom(p.ppb, ZOOM_LIMITS.pianoX) : p.ppb === null ? null : fallback.piano.ppb, rowHeight: num(p.rowHeight, ZOOM_LIMITS.pianoY, fallback.piano.rowHeight) },
    mixer: { channelWidth: num(m.channelWidth, ZOOM_LIMITS.mixerWidth, fallback.mixer.channelWidth), faderHeight: num(m.faderHeight, ZOOM_LIMITS.mixerFader, fallback.mixer.faderHeight) },
    devices: { scale: num(d.scale, ZOOM_LIMITS.deviceScale, fallback.devices.scale) },
    browser: { compact: typeof b.compact === 'boolean' ? b.compact : fallback.browser.compact },
  }
}

export const ZOOM_STORAGE_KEY = 'garak-ieum:zoom'
type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>
const store = (): KeyValueStore | undefined => { try { return globalThis.localStorage } catch { return undefined } }

export function loadZoom(storage: KeyValueStore | undefined = store()): ZoomState {
  try { const text = storage?.getItem(ZOOM_STORAGE_KEY); return text ? sanitizeZoom(JSON.parse(text)) : defaultZoom() } catch { return defaultZoom() }
}
export function saveZoom(state: ZoomState, storage: KeyValueStore | undefined = store()) {
  try { storage?.setItem(ZOOM_STORAGE_KEY, JSON.stringify(state)) } catch { /* private mode or quota: zoom is not essential */ }
}

export const EDITOR_KINDS = ['piano', 'audio', 'mixer', 'devices', 'pitch'] as const
export type EditorKind = typeof EDITOR_KINDS[number]
export interface EditorPanelLayout {
  heights: Record<EditorKind, number>
  collapsed: boolean
}
export const PANEL_COLLAPSED_HEIGHT = 40
export const PANEL_MIN_HEIGHT = 180
export const ARRANGEMENT_MIN_HEIGHT = 160
export const PANEL_STORAGE_KEY = 'garak-ieum:editor-panel'
const finite = (n: unknown, fallback: number): number => typeof n === 'number' && Number.isFinite(n) ? n : fallback

export function defaultEditorPanel(view = typeof window === 'undefined' ? { width: 1280, height: 900 } : { width: window.innerWidth, height: window.innerHeight }): EditorPanelLayout {
  const height = view.height <= 760 ? 252 : view.width >= 1700 ? 340 : view.width <= 1250 ? 290 : 310
  return { heights: { piano: height, audio: height, mixer: height, devices: height, pitch: Math.max(310, height) }, collapsed: false }
}

/** A small window constrains the displayed size, without destroying the user's preferred height. */
export function editorPanelHeight(preferred: number, available: number, collapsed = false, maximized = false): number {
  const space = Math.max(PANEL_COLLAPSED_HEIGHT, finite(available, PANEL_MIN_HEIGHT + ARRANGEMENT_MIN_HEIGHT))
  if (collapsed) return PANEL_COLLAPSED_HEIGHT
  if (maximized) return space
  const max = Math.max(PANEL_COLLAPSED_HEIGHT, space - ARRANGEMENT_MIN_HEIGHT)
  const min = Math.min(PANEL_MIN_HEIGHT, max)
  return Math.min(max, Math.max(min, finite(preferred, PANEL_MIN_HEIGHT)))
}

export function sanitizeEditorPanel(raw: unknown, fallback = defaultEditorPanel()): EditorPanelLayout {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const stored = value.heights && typeof value.heights === 'object' ? value.heights as Record<string, unknown> : {}
  const heights = { ...fallback.heights }
  for (const kind of EDITOR_KINDS) heights[kind] = Math.min(4000, Math.max(PANEL_MIN_HEIGHT, finite(stored[kind], heights[kind])))
  return { heights, collapsed: typeof value.collapsed === 'boolean' ? value.collapsed : fallback.collapsed }
}

type Store = Pick<Storage, 'getItem' | 'setItem'>
const storage = (): Store | undefined => { try { return globalThis.localStorage } catch { return undefined } }
export function loadEditorPanel(store = storage()): EditorPanelLayout {
  try { const raw = store?.getItem(PANEL_STORAGE_KEY); return raw ? sanitizeEditorPanel(JSON.parse(raw)) : defaultEditorPanel() } catch { return defaultEditorPanel() }
}
export function saveEditorPanel(layout: EditorPanelLayout, store = storage()): void {
  try { store?.setItem(PANEL_STORAGE_KEY, JSON.stringify(layout)) } catch { /* Size preferences never block music editing. */ }
}

/**
 * Piano-roll lower lane pane (velocity, controller and sustain lanes under the note grid).
 * The pane sits under a splitter; its height is the user's choice (remembered in this browser), clamped so the
 * note grid keeps a few rows and every expanded lane keeps a usable height. Collapsed lanes shrink to a strip.
 */
export type PaneLaneKind = 'velocity' | 'controller' | 'sustain'
export interface PaneLane { kind: PaneLaneKind; collapsed: boolean }
export interface LanePaneLayout {
  /** Height of the lanes under the splitter (the splitter itself is not included). */
  height: number
  /** Per-lane heights, in input order; they add up to `height`. */
  heights: number[]
  min: number
  max: number
  /** Height used when the user has not dragged the splitter (double-click resets to it). */
  auto: number
  /** False when no expanded lane can grow (only collapsed strips and the fixed pedal lane). */
  resizable: boolean
}

export const LANE_SPLITTER_HEIGHT = 6
export const LANE_COLLAPSED_HEIGHT = 16
export const LANE_SPECS: Record<PaneLaneKind, { min: number; preferred: number }> = {
  velocity: { min: 64, preferred: 80 },
  controller: { min: 40, preferred: 60 },
  sustain: { min: 26, preferred: 26 },
}
const FLOOR = 20

const flexible = (lane: PaneLane) => !lane.collapsed && lane.kind !== 'sustain'
const fixedHeight = (lane: PaneLane) => lane.collapsed ? LANE_COLLAPSED_HEIGHT : LANE_SPECS[lane.kind].preferred

/**
 * @param room   vertical space under the ruler (scroll viewport height minus the ruler)
 * @param gridMin height the note grid should keep before lanes may take more
 * @param gridFloor height the note grid always keeps, even when lanes must drop under their minimum
 */
export function layoutLanePane(lanes: readonly PaneLane[], preferred: number | null, room: number, gridMin: number, gridFloor = gridMin / 3): LanePaneLayout {
  const fixed = lanes.filter(lane => !flexible(lane)).reduce((total, lane) => total + fixedHeight(lane), 0)
  const flex = lanes.filter(flexible)
  const minFlex = flex.reduce((total, lane) => total + LANE_SPECS[lane.kind].min, 0)
  const auto = fixed + flex.reduce((total, lane) => total + LANE_SPECS[lane.kind].preferred, 0)
  const min = fixed + minFlex
  const resizable = flex.length > 0
  // A dragged pane may grow until the grid keeps only `gridFloor`; the default stops where it keeps `gridMin`.
  const cap = Math.max(fixed + flex.length * FLOOR, Math.floor(room - gridFloor))
  const max = cap
  const fitted = Math.min(cap, Math.max(min, Math.min(auto, Math.floor(room - gridMin))))
  const wanted = preferred !== null && Number.isFinite(preferred) ? Math.min(max, Math.max(min, preferred)) : fitted
  const height = Math.round(resizable ? Math.min(cap, wanted) : fixed)
  const sizes = distribute(flex, height - fixed, minFlex)
  let next = 0
  const heights = lanes.map(lane => flexible(lane) ? sizes[next++] : fixedHeight(lane))
  return { height: heights.reduce((total, value) => total + value, 0), heights, min: Math.min(min, max), max, auto: resizable ? fitted : fixed, resizable }
}

/** Shares `space` between the flexible lanes by their preferred height, honoring minimums; leftovers go to the first lane. */
function distribute(flex: readonly PaneLane[], space: number, minTotal: number): number[] {
  if (!flex.length) return []
  if (space <= minTotal) {
    const sizes = flex.map(lane => Math.max(FLOOR, Math.floor(space * LANE_SPECS[lane.kind].min / minTotal)))
    sizes[0] += Math.max(0, space - sizes.reduce((total, value) => total + value, 0))
    return sizes
  }
  const sizes: (number | null)[] = flex.map(() => null)
  let left = space
  for (;;) {
    const open = flex.map((lane, index) => sizes[index] === null ? index : -1).filter(index => index >= 0)
    const weight = open.reduce((total, index) => total + LANE_SPECS[flex[index].kind].preferred, 0)
    const pinned = open.filter(index => LANE_SPECS[flex[index].kind].preferred * left / weight < LANE_SPECS[flex[index].kind].min)
    if (!pinned.length) {
      for (const index of open) sizes[index] = Math.floor(LANE_SPECS[flex[index].kind].preferred * left / weight)
      break
    }
    for (const index of pinned) { sizes[index] = LANE_SPECS[flex[index].kind].min; left -= LANE_SPECS[flex[index].kind].min }
  }
  const result = sizes.map(value => value ?? 0)
  result[0] += space - result.reduce((total, value) => total + value, 0)
  return result
}

export interface LanePanePrefs { height: number | null; collapsed: string[] }
export const LANE_PANE_STORAGE_KEY = 'garak-ieum:piano-lanes'
type Store = Pick<Storage, 'getItem' | 'setItem'>
const storage = (): Store | undefined => { try { return globalThis.localStorage } catch { return undefined } }

export function loadLanePane(store = storage()): LanePanePrefs {
  try {
    const raw = store?.getItem(LANE_PANE_STORAGE_KEY)
    const value = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    const height = typeof value.height === 'number' && Number.isFinite(value.height) ? Math.min(4000, Math.max(0, value.height)) : null
    const collapsed = Array.isArray(value.collapsed) ? value.collapsed.filter((item): item is string => typeof item === 'string').slice(0, 256) : []
    return { height, collapsed }
  } catch { return { height: null, collapsed: [] } }
}

export function saveLanePane(prefs: LanePanePrefs, store = storage()): void {
  try { store?.setItem(LANE_PANE_STORAGE_KEY, JSON.stringify(prefs)) } catch { /* storage full or blocked: the layout still works this session */ }
}

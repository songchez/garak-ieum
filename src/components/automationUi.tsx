import { createContext, useContext, useSyncExternalStore } from 'react'
import { trackAt } from '../core/automation'
import type { AutomationTarget, Project, Track } from '../core/types'

/**
 * Automation in the UI (docs/AUTOMATION.md): controls follow playback, and a knob knows which target it drives.
 *  - AutomationDisplay is an external store: components read the displayed (automated) track at the playhead
 *    with useDisplayTrack(); only tracks with active lanes change identity, so other controls never re-render.
 *  - AutomationScope tells a Knob inside a device card which track/device its parameter belongs to.
 *  - AutomationUi gives the knob its ring state and its right-click menu.
 */

export class AutomationDisplay {
  private beat = 0
  private version = 0
  private active = false
  private transform: ((track: Track) => Track) | null = null
  private readonly listeners = new Set<() => void>()
  private readonly cache = new WeakMap<Track, { version: number; value: Track }>()

  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  /** The project changed (or a recording pass started/stopped/touched). */
  update(project: Project, transform: ((track: Track) => Track) | null = null): void {
    const active = !!transform || project.tracks.some(track => track.automation?.some(lane => lane.enabled !== false && lane.points.length > 0))
    if (!active && !this.active && !this.transform) return
    this.active = active
    this.transform = transform
    this.bump()
  }

  setBeat(beat: number): void {
    if (!this.active || Math.abs(beat - this.beat) < 1e-6) { this.beat = beat; return }
    this.beat = beat
    this.bump()
  }

  /** The track as heard now: lane values replace the static values. Same object when nothing is automated. */
  display(track: Track): Track {
    if (!this.active || (!track.automation?.length && !this.transform)) return track
    const cached = this.cache.get(track)
    if (cached?.version === this.version) return cached.value
    const source = this.transform ? this.transform(track) : track
    const value = trackAt(source, this.beat)
    this.cache.set(track, { version: this.version, value })
    return value
  }

  private bump(): void {
    this.version += 1
    for (const listener of [...this.listeners]) listener()
  }
}

const noSubscribe = () => () => {}
export const AutomationDisplayContext = createContext<AutomationDisplay | null>(null)
export function useDisplayTrack(track: Track): Track
export function useDisplayTrack(track: Track | undefined): Track | undefined
export function useDisplayTrack(track: Track | undefined): Track | undefined {
  const display = useContext(AutomationDisplayContext)
  return useSyncExternalStore(display?.subscribe ?? noSubscribe, () => track && display ? display.display(track) : track, () => track)
}

/** Where knobs below this point belong. `kind: 'track'` maps knob ids volume/pan to the track's own lanes. */
export type AutomationScopeValue =
  | { trackId: string; kind: 'track' }
  | { trackId: string; kind: 'device'; deviceId: string }
  | { trackId: string; kind: 'instrument'; plugin?: boolean }
export const AutomationScope = createContext<AutomationScopeValue | null>(null)

export function scopeTarget(scope: AutomationScopeValue, param: string): AutomationTarget | null {
  switch (scope.kind) {
    case 'track': return param === 'volume' || param === 'pan' || param === 'mute' ? { kind: 'track', param } : null
    case 'device': return { kind: 'device', deviceId: scope.deviceId, param }
    case 'instrument': return scope.plugin ? { kind: 'plugin-instrument', param } : { kind: 'instrument', param }
  }
}

export type AutomationControlState = 'active' | 'override' | 'writing' | null
export interface AutomationUiHost {
  state(trackId: string, target: AutomationTarget): AutomationControlState
  /** Right-click on a control: 오토메이션 보기 / 지우기 / 다시 켜기. */
  openMenu(trackId: string, target: AutomationTarget, at: { x: number; y: number }): void
}
export const AutomationUi = createContext<AutomationUiHost | null>(null)

/** Ring state and context-menu handler for one control (null outside a scope). */
export function useAutomationControl(param: string): { state: AutomationControlState; onContextMenu?: (event: React.MouseEvent) => void } {
  const scope = useContext(AutomationScope)
  const host = useContext(AutomationUi)
  const target = scope ? scopeTarget(scope, param) : null
  if (!scope || !host || !target) return { state: null }
  return {
    state: host.state(scope.trackId, target),
    onContextMenu: event => { event.preventDefault(); event.stopPropagation(); host.openMenu(scope.trackId, target, { x: event.clientX, y: event.clientY }) },
  }
}

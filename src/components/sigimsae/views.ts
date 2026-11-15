import { createElement, lazy, Suspense } from 'react'
import type { ComponentType } from 'react'
import type { DeviceView, DeviceViewProps } from './types'

/**
 * Graphical 시김새 editors load on first use, one chunk per group, so the editors (about 100 KB of graph code) stay out of
 * the main bundle (docs/ARCHITECTURE_REVIEW.md, bottleneck 5). The type lists mirror each group's VIEWS keys;
 * views.test.ts keeps them in sync.
 */
type Group = 'eq' | 'dynamics' | 'space'
export const VIEW_GROUPS: Record<Group, readonly string[]> = {
  eq: ['eq', 'filter'],
  dynamics: ['compressor', 'limiter', 'gate'],
  space: ['delay', 'reverb', 'chorus', 'phaser', 'flanger', 'tremolo', 'drive', 'tape', 'bitcrusher', 'utility'],
}
export const loadViewGroup: Record<Group, () => Promise<{ VIEWS: Record<string, DeviceView> }>> = {
  eq: () => import('./views-eq'),
  dynamics: () => import('./views-dynamics'),
  space: () => import('./views-space'),
}
const GROUP_OF = new Map(Object.entries(VIEW_GROUPS).flatMap(([group, types]) => types.map(type => [type, group as Group])))
const cache = new Map<string, DeviceView>()

/** The graphical editor for an effect type, or undefined to fall back to the knob grid. */
export function deviceView(type: string): DeviceView | undefined {
  const group = GROUP_OF.get(type)
  if (!group) return undefined
  let view = cache.get(type)
  if (!view) {
    const Lazy = lazy(async (): Promise<{ default: ComponentType<DeviceViewProps> }> => {
      const views = (await loadViewGroup[group]()).VIEWS
      return { default: views[type] ?? (() => null) }
    })
    // A stable component per type; the card keeps its size while the group chunk arrives.
    view = props => createElement(Suspense, { fallback: createElement('div', { className: 'dc-view-loading', 'aria-busy': true }) }, createElement(Lazy, props))
    cache.set(type, view)
  }
  return view
}
export type { DeviceView, DeviceViewProps } from './types'

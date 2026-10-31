import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HEADER_CONFIG, DEFAULT_TRACK_HEADER, DEFAULT_VIEW, DRAG_MODE_LABELS, SNAP_MODE_LABELS, TICK, TRACK_HEADER_STORAGE_KEY, VIEW_STORAGE_KEY,
  loadTrackHeader, loadTrackZoom, loadView, pruneTrackZoom, resolveSnap, sanitizeHeaderConfig, sanitizeTrackHeader, sanitizeTrackZoom, sanitizeView,
  saveTrackHeader, saveTrackZoom, saveView, trackZoomStorageKey,
} from './trackUi'

const memory = () => {
  const map = new Map<string, string>()
  return { map, storage: { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v) } } }
}

describe('defaults', () => {
  it('match the spec', () => {
    expect(DEFAULT_VIEW).toEqual({
      zoomFocused: false, catch: true, scrollInPlay: false, snap: { on: true, mode: 'smart', relative: false }, dragMode: 'noOverlap',
      globalTracks: false, gridLines: true, inspectorOpen: true, libraryOpen: true, browserOpen: false, inspectorSections: { region: true, track: true, strips: true },
    })
    expect(DEFAULT_HEADER_CONFIG).toEqual({ mute: true, solo: true, record: true, monitor: true, onOff: false, hide: false, volume: true, pan: true, trackNumber: true, colorBar: false, icon: true })
    expect(DEFAULT_TRACK_HEADER.headerWidth).toBe(248)
    expect(VIEW_STORAGE_KEY).toBe('garak-ieum:view')
    expect(TRACK_HEADER_STORAGE_KEY).toBe('garak-ieum:track-header')
    expect(trackZoomStorageKey('abc')).toBe('garak-ieum:track-zoom:abc')
  })

  it('has Korean labels for every mode', () => {
    expect(SNAP_MODE_LABELS).toEqual({ smart: '스마트', bar: '마디', beat: '비트', division: '분할', ticks: '틱', off: '끔' })
    expect(DRAG_MODE_LABELS).toEqual({ overlap: '겹침', noOverlap: '겹치지 않음' })
  })
})

describe('resolveSnap', () => {
  it('returns fixed grids for explicit modes', () => {
    expect(resolveSnap({ on: true, mode: 'bar' }, 30)).toBe(4)
    expect(resolveSnap({ on: true, mode: 'beat' }, 30)).toBe(1)
    expect(resolveSnap({ on: true, mode: 'division' }, 30)).toBe(.25)
    expect(resolveSnap({ on: true, mode: 'division' }, 30, .125)).toBe(.125)
    expect(resolveSnap({ on: true, mode: 'ticks' }, 30)).toBe(TICK)
    expect(resolveSnap({ on: true, mode: 'ticks' }, 30)).toBe(1 / 960)
    expect(resolveSnap({ on: true, mode: 'off' }, 30)).toBe(0)
    expect(resolveSnap({ on: false, mode: 'bar' }, 30)).toBe(0)
  })

  it.each([
    [200, .25],
    [48, .25],
    [47, 1],
    [12, 1],
    [11, 4],
    [3, 4],
    [2, 16],
    [.5, 16],
    [0, 16],
    [NaN, 16],
  ])('smart at %s px/beat picks %s beats', (ppb, grid) => {
    expect(resolveSnap({ on: true, mode: 'smart' }, ppb)).toBe(grid)
  })

  it('smart never goes finer than the division', () => {
    expect(resolveSnap({ on: true, mode: 'smart' }, 200, .125)).toBe(.125)
    expect(resolveSnap({ on: true, mode: 'smart' }, 200, 1)).toBe(1)
  })
})

describe('sanitize', () => {
  it('fills a view from partial or bad input', () => {
    expect(sanitizeView(null)).toEqual(DEFAULT_VIEW)
    expect(sanitizeView('x')).toEqual(DEFAULT_VIEW)
    expect(sanitizeView(42)).toEqual(DEFAULT_VIEW)
    const v = sanitizeView({ catch: false, snap: { on: 'yes', mode: 'frames', relative: true }, dragMode: 'shuffle', inspectorSections: { region: false }, gridLines: 0, extra: 1 })
    expect(v).toEqual({ ...DEFAULT_VIEW, catch: false, snap: { on: true, mode: 'smart', relative: true }, inspectorSections: { region: false, track: true, strips: true } })
    expect(sanitizeView({ snap: { mode: 'ticks' }, dragMode: 'overlap', browserOpen: true }).snap.mode).toBe('ticks')
    expect(sanitizeView({ dragMode: 'overlap' }).dragMode).toBe('overlap')
    expect(Object.keys(v)).toEqual(Object.keys(DEFAULT_VIEW))
  })

  it('fills a header config and clamps the width', () => {
    expect(sanitizeHeaderConfig(undefined)).toEqual(DEFAULT_HEADER_CONFIG)
    expect(sanitizeHeaderConfig({ onOff: true, mute: 'no', bogus: true })).toEqual({ ...DEFAULT_HEADER_CONFIG, onOff: true })
    expect(sanitizeTrackHeader(null)).toEqual(DEFAULT_TRACK_HEADER)
    expect(sanitizeTrackHeader({ headerWidth: 9999 }).headerWidth).toBe(420)
    expect(sanitizeTrackHeader({ headerWidth: 10 }).headerWidth).toBe(160)
    expect(sanitizeTrackHeader({ headerWidth: '300' }).headerWidth).toBe(248)
    expect(sanitizeTrackHeader({ headerWidth: 300, headerConfig: { hide: true } })).toEqual({ headerWidth: 300, headerConfig: { ...DEFAULT_HEADER_CONFIG, hide: true } })
  })

  it('clamps per-track zoom and drops junk', () => {
    expect(sanitizeTrackZoom(null)).toEqual({})
    expect(sanitizeTrackZoom([1, 2])).toEqual({ 0: 1, 1: 2 })
    expect(sanitizeTrackZoom({ a: 2, b: 99, c: .1, d: 'x', e: NaN, f: null })).toEqual({ a: 2, b: 4, c: .5 })
  })

  it('prunes zoom entries for missing tracks', () => {
    const zoom = { a: 2, b: 1.5 }
    expect(pruneTrackZoom(zoom, ['a', 'b', 'c'])).toBe(zoom)
    expect(pruneTrackZoom(zoom, new Set(['b']))).toEqual({ b: 1.5 })
    expect(pruneTrackZoom(zoom, [])).toEqual({})
  })
})

describe('storage', () => {
  it('round-trips view state and survives broken JSON', () => {
    const { map, storage } = memory()
    const view = { ...DEFAULT_VIEW, catch: false, snap: { on: false, mode: 'bar' as const, relative: true } }
    saveView(view, storage)
    expect(map.get(VIEW_STORAGE_KEY)).toBeDefined()
    expect(loadView(storage)).toEqual(view)
    map.set(VIEW_STORAGE_KEY, '{oops')
    expect(loadView(storage)).toEqual(DEFAULT_VIEW)
    map.set(VIEW_STORAGE_KEY, '"string"')
    expect(loadView(storage)).toEqual(DEFAULT_VIEW)
    expect(loadView(undefined)).toEqual(DEFAULT_VIEW)
  })

  it('round-trips header state', () => {
    const { map, storage } = memory()
    expect(loadTrackHeader(storage)).toEqual(DEFAULT_TRACK_HEADER)
    const state = { headerWidth: 300, headerConfig: { ...DEFAULT_HEADER_CONFIG, colorBar: true } }
    saveTrackHeader(state, storage)
    expect(loadTrackHeader(storage)).toEqual(state)
    map.set(TRACK_HEADER_STORAGE_KEY, JSON.stringify({ headerWidth: -5, headerConfig: 'x' }))
    expect(loadTrackHeader(storage)).toEqual({ headerWidth: 160, headerConfig: DEFAULT_HEADER_CONFIG })
  })

  it('keys track zoom by project and prunes on load', () => {
    const { map, storage } = memory()
    saveTrackZoom('p1', { a: 2, b: 3 }, storage)
    expect(map.has(trackZoomStorageKey('p1'))).toBe(true)
    expect(loadTrackZoom('p1', undefined, storage)).toEqual({ a: 2, b: 3 })
    expect(loadTrackZoom('p1', ['a'], storage)).toEqual({ a: 2 })
    expect(loadTrackZoom('p2', ['a'], storage)).toEqual({})
    map.set(trackZoomStorageKey('p1'), '[')
    expect(loadTrackZoom('p1', ['a'], storage)).toEqual({})
  })

  it('ignores storage failures', () => {
    const broken = { getItem: () => { throw new Error('nope') }, setItem: () => { throw new Error('quota') } }
    expect(() => saveView(DEFAULT_VIEW, broken)).not.toThrow()
    expect(() => saveTrackHeader(DEFAULT_TRACK_HEADER, broken)).not.toThrow()
    expect(() => saveTrackZoom('p', {}, broken)).not.toThrow()
    expect(loadView(broken)).toEqual(DEFAULT_VIEW)
    expect(loadTrackHeader(broken)).toEqual(DEFAULT_TRACK_HEADER)
    expect(loadTrackZoom('p', undefined, broken)).toEqual({})
  })
})

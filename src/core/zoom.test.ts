import { describe, expect, it } from 'vitest'
import { ZOOM_LIMITS, ZOOM_STORAGE_KEY, defaultZoom, fitScale, loadZoom, sanitizeZoom, saveZoom, wheelFactor, wheelPixels, zoomAround, zoomBy } from './zoom'

describe('zoom math', () => {
  it('multiplies and clamps to the axis bounds', () => {
    expect(zoomBy(30, 1.25, ZOOM_LIMITS.timelineX)).toBe(37.5)
    expect(zoomBy(190, 2, ZOOM_LIMITS.timelineX)).toBe(200)
    expect(zoomBy(5, .1, ZOOM_LIMITS.timelineX)).toBe(4)
    expect(zoomBy(NaN, 2, { min: 1, max: 4 })).toBe(2)
    expect(zoomBy(2, 0, { min: 1, max: 4 })).toBe(2)
  })

  it('snaps to a step and always moves at least one step', () => {
    const axis = { min: 8, max: 40, step: 1 }
    expect(zoomBy(19, 1.01, axis)).toBe(20)
    expect(zoomBy(19, .99, axis)).toBe(18)
    expect(zoomBy(19, 1.5, axis)).toBe(29)
    expect(zoomBy(40, 1.2, axis)).toBe(40)
    expect(zoomBy(8, .5, axis)).toBe(8)
  })

  it('keeps the point under the pointer fixed', () => {
    // Content at (100 + 50) / 10 = 15 units stays at offset 50.
    const scroll = zoomAround(100, 50, 10, 20)
    expect((scroll + 50) / 20).toBe(15)
    expect(zoomAround(0, 10, 10, 5)).toBe(0)
    expect(zoomAround(40, 10, 0, 5)).toBe(40)
  })

  it('fits content into a viewport within bounds', () => {
    expect(fitScale(16, 800, ZOOM_LIMITS.timelineX)).toBe(50)
    expect(fitScale(1000, 800, ZOOM_LIMITS.timelineX)).toBe(4)
    expect(fitScale(0, 800, ZOOM_LIMITS.timelineX)).toBe(200)
  })

  it('normalizes wheel delta modes and clamps a single event', () => {
    expect(wheelPixels(3, 1)).toBe(48)
    expect(wheelPixels(1, 2)).toBe(300)
    expect(wheelPixels(-120)).toBe(-120)
    expect(wheelFactor(-120)).toBeGreaterThan(1)
    expect(wheelFactor(120)).toBeLessThan(1)
    expect(wheelFactor(100000)).toBeCloseTo(Math.exp(-.45))
  })
})

describe('zoom state', () => {
  it('derives row height defaults from the viewport', () => {
    expect(defaultZoom({ width: 1280, height: 900 }).timeline.rowHeight).toBe(70)
    expect(defaultZoom({ width: 1800, height: 1000 }).timeline.rowHeight).toBe(80)
    expect(defaultZoom({ width: 1800, height: 700 }).timeline.rowHeight).toBe(62)
    expect(defaultZoom().piano.ppb).toBeNull()
  })

  it('sanitizes stored values', () => {
    const fallback = defaultZoom({ width: 1280, height: 900 })
    expect(sanitizeZoom(null, fallback)).toEqual(fallback)
    expect(sanitizeZoom('x', fallback)).toEqual(fallback)
    const z = sanitizeZoom({ timeline: { ppb: 999, rowHeight: 10 }, piano: { ppb: 50, rowHeight: 'big' }, mixer: { channelWidth: 1, faderHeight: 150 }, devices: { scale: 9 }, browser: { compact: true } }, fallback)
    expect(z).toEqual({ timeline: { ppb: 200, rowHeight: 36 }, piano: { ppb: 50, rowHeight: 19 }, mixer: { channelWidth: 64, faderHeight: 150 }, devices: { scale: 1.5 }, browser: { compact: true } })
    expect(sanitizeZoom({ piano: { ppb: null } }, { ...fallback, piano: { ppb: 40, rowHeight: 19 } }).piano.ppb).toBeNull()
    expect(sanitizeZoom({ piano: { ppb: 'x' } }, fallback).piano.ppb).toBeNull()
  })

  it('round-trips through storage and survives broken JSON', () => {
    const map = new Map<string, string>()
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v) } }
    const state = { ...defaultZoom({ width: 1280, height: 900 }), devices: { scale: 1.2 } }
    saveZoom(state, storage)
    expect(loadZoom(storage)).toEqual(state)
    map.set(ZOOM_STORAGE_KEY, '{oops')
    expect(loadZoom(storage).devices.scale).toBe(1)
    expect(() => saveZoom(state, { getItem: () => null, setItem: () => { throw new Error('quota') } })).not.toThrow()
  })
})

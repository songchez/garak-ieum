import { describe, expect, it } from 'vitest'
import { LANE_COLLAPSED_HEIGHT, LANE_PANE_STORAGE_KEY, layoutLanePane, loadLanePane, saveLanePane, type PaneLane } from './pianoLaneLayout'

const velocity: PaneLane = { kind: 'velocity', collapsed: false }
const sustain: PaneLane = { kind: 'sustain', collapsed: false }
const controller: PaneLane = { kind: 'controller', collapsed: false }
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

describe('piano-roll lane pane layout', () => {
  it('gives velocity a usable default height while the note grid keeps its rows', () => {
    const roomy = layoutLanePane([velocity, sustain], null, 400, 57)
    expect(roomy.heights).toEqual([80, 26])
    expect(roomy.height).toBe(roomy.auto)
    // The default 1280×720 panel: the grid keeps three rows, velocity stays above its minimum.
    const tight = layoutLanePane([velocity, sustain], null, 150, 57)
    expect(tight.height).toBe(150 - 57)
    expect(tight.heights[0]).toBeGreaterThanOrEqual(64)
  })

  it('clamps a dragged height between the lane minimums and the last grid row', () => {
    expect(layoutLanePane([velocity, sustain], 10, 400, 57).heights).toEqual([64, 26])
    const tall = layoutLanePane([velocity, sustain], 5000, 400, 57)
    expect(tall.height).toBe(400 - 19)
    // The default never takes more than leaves the grid its minimum rows.
    expect(tall.auto).toBe(106)
    expect(sum(tall.heights)).toBe(tall.height)
  })

  it('shares extra space between velocity and controllers and keeps the pedal lane fixed', () => {
    const layout = layoutLanePane([velocity, controller, controller, sustain], 300, 600, 57)
    expect(sum(layout.heights)).toBe(300)
    expect(layout.heights[3]).toBe(26)
    expect(layout.heights[0]).toBeGreaterThan(layout.heights[1])
    expect(layout.heights[1]).toBeGreaterThanOrEqual(40)
  })

  it('collapsed lanes become strips and only expanded lanes can be resized', () => {
    const layout = layoutLanePane([{ ...velocity, collapsed: true }, sustain], 300, 600, 57)
    expect(layout.heights).toEqual([LANE_COLLAPSED_HEIGHT, 26])
    expect(layout.resizable).toBe(false)
  })

  it('never lets lanes cover the whole grid when the panel is tiny', () => {
    const layout = layoutLanePane([velocity, controller, sustain], null, 120, 57, 19)
    expect(layout.height).toBeLessThanOrEqual(120 - 19)
    expect(sum(layout.heights)).toBe(layout.height)
  })

  it('remembers the pane per browser and survives broken or blocked storage', () => {
    const data = new Map<string, string>()
    const store = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
    saveLanePane({ height: 140, collapsed: ['sustain'] }, store)
    expect(loadLanePane(store)).toEqual({ height: 140, collapsed: ['sustain'] })
    data.set(LANE_PANE_STORAGE_KEY, '{nope')
    expect(loadLanePane(store)).toEqual({ height: null, collapsed: [] })
    const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(loadLanePane(blocked)).toEqual({ height: null, collapsed: [] })
    expect(() => saveLanePane({ height: 1, collapsed: [] }, blocked)).not.toThrow()
  })
})

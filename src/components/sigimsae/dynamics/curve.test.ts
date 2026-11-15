import { describe, expect, it } from 'vitest'
import {
  compressorOutput, compressorReduction, dbToX, dbToY, FLOOR_DB, gateEnvelope, gateOutput, kneeOver, limiterOutput,
  MeterHistory, meterFrame, ratioThrough, segmentToNormalized, toDb, vuStep, xToDb, yToDb,
} from './curve'
import { createDynamicsFeed } from './feed'

describe('dynamics transfer curves', () => {
  it('compressor follows threshold, ratio and a 6 dB soft knee like the native DSP', () => {
    expect(compressorOutput(-40, -18, 4)).toBeCloseTo(-40)          // below the knee: unity
    expect(compressorOutput(-6, -18, 4)).toBeCloseTo(-18 + 12 / 4)   // well above: threshold + over/ratio
    expect(compressorOutput(-6, -18, 4, 5)).toBeCloseTo(-18 + 3 + 5) // makeup adds after
    // Knee: continuous at both edges, and half-way reduction at the threshold itself.
    expect(kneeOver(-21, -18)).toBeCloseTo(0)
    expect(kneeOver(-15, -18)).toBeCloseTo(3)
    expect(kneeOver(-18, -18)).toBeCloseTo(0.75)
    expect(compressorReduction(-18, -18, 1)).toBe(0)
    // Monotonic for any ratio.
    for (const ratio of [1, 2, 4, 20]) {
      let last = -Infinity
      for (let x = -60; x <= 6; x += 0.5) { const y = compressorOutput(x, -24, ratio); expect(y).toBeGreaterThanOrEqual(last - 1e-9); last = y }
    }
  })

  it('ratioThrough makes the curve pass through the pointer', () => {
    const t = -30, makeup = 2
    for (const ratio of [1.5, 3, 8]) {
      const x = -6, y = compressorOutput(x, t, ratio, makeup, 0)
      expect(ratioThrough(x, y, t, makeup, 4)).toBeCloseTo(ratio, 6)
    }
    expect(ratioThrough(-6, 10, t, makeup, 4)).toBe(1)    // above unity → 1:1
    expect(ratioThrough(-6, -40, t, makeup, 4)).toBe(20)  // below the threshold line → max
    expect(ratioThrough(-31, -31, t, makeup, 4)).toBe(4)  // left of the threshold: unchanged
  })

  it('limiter and gate curves', () => {
    expect(limiterOutput(-20, 6, -1)).toBe(-14)
    expect(limiterOutput(-3, 6, -1)).toBe(-1)
    expect(gateOutput(-30, -50)).toBe(-30)
    expect(gateOutput(-60, -50)).toBe(FLOOR_DB)
    expect(gateOutput(-52, -50, true)).toBe(-52) // hysteresis: stays open
    expect(gateOutput(-52, -50, false)).toBe(FLOOR_DB)
  })

  it('pixel mappings invert and clamp', () => {
    const s = { min: -60, max: 6 }
    for (const db of [-60, -18, 0, 6]) {
      expect(xToDb(dbToX(db, s, 200), s, 200)).toBeCloseTo(db)
      expect(yToDb(dbToY(db, s, 120), s, 120)).toBeCloseTo(db)
    }
    expect(dbToY(-200, s, 120)).toBe(120)
    expect(dbToX(40, s, 200)).toBe(200)
  })
})

describe('meter frames and history', () => {
  it('converts linear readings to dB frames', () => {
    expect(meterFrame(null)).toEqual({ inputDb: FLOOR_DB, reductionDb: 0 })
    const f = meterFrame({ input: 0.5, gain: 0.5 })
    expect(f.inputDb).toBeCloseTo(-6.02, 2)
    expect(f.reductionDb).toBeCloseTo(6.02, 2)
    expect(meterFrame({ input: 0, gain: 1 }).inputDb).toBe(FLOOR_DB)
    expect(toDb(1)).toBe(0)
  })

  it('ring keeps the newest frames in order without growing', () => {
    const h = new MeterHistory(4)
    for (let i = 1; i <= 6; i += 1) h.push(-i, i)
    expect(h.size).toBe(4)
    expect([0, 1, 2, 3].map(age => h.input[h.index(age)])).toEqual([-6, -5, -4, -3])
    expect(h.reduction[h.index(0)]).toBe(6)
    h.push(Number.NaN, -3)
    expect(h.input[h.index(0)]).toBe(FLOOR_DB)
    expect(h.reduction[h.index(0)]).toBe(0)
  })

  it('feed pushes fixed 60 Hz history and notifies listeners', () => {
    let reading: { input: number; gain: number } | null = null
    const feed = createDynamicsFeed(() => reading)
    const seen: number[] = []
    const stop = feed.subscribe(frame => seen.push(frame.reductionDb))
    feed.tick(0)
    expect(feed.live).toBe(false)
    reading = { input: 1, gain: 0.25 }
    feed.tick(100) // 100 ms → 6 frames
    expect(feed.live).toBe(true)
    expect(feed.history.size).toBe(7)
    expect(feed.latest.reductionDb).toBeCloseTo(12.04, 1)
    expect(seen.length).toBe(2)
    stop(); feed.tick(116)
    expect(seen.length).toBe(2)
  })
})

describe('gate envelope sketch and VU ballistics', () => {
  it('segment widths follow knob positions and invert', () => {
    const w = 320
    const a = gateEnvelope(0, 0.5, 1, w, 100)
    expect(a.attackX).toBeLessThan(a.signalEndX)
    expect(a.holdX).toBeGreaterThan(a.signalEndX)
    expect(segmentToNormalized(a.holdX - a.signalEndX, w)).toBeCloseTo(0.5)
    expect(segmentToNormalized(a.attackX - w * 0.08, w)).toBeCloseTo(0)
    expect(a.points[a.points.length - 1][0]).toBe(w)
  })
  it('VU needle settles toward its target', () => {
    let v = 0
    for (let i = 0; i < 60; i += 1) v = vuStep(v, 10, 1 / 60)
    expect(v).toBeGreaterThan(9.5)
    expect(vuStep(0, 10, 0.3 / 2.2)).toBeCloseTo(10 * (1 - Math.exp(-1)), 5)
  })
})

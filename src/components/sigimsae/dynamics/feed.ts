import { useEffect, useMemo } from 'react'
import type { AudioEngine } from '../../../core/types'
import { webDynamicsReading, type DynamicsReading } from '../../../devices/effects/dynamicsMeter'
import { MeterHistory, meterFrame, type MeterFrame } from './curve'

/** History length: 6 s at 60 frames/s. */
export const HISTORY_FRAMES = 360
const FRAME_SECONDS = 1 / 60

/** The live reading for a device on whichever engine is running. */
export function readDeviceMeter(engine: AudioEngine, deviceId: string): DynamicsReading | null {
  // The native host and the web Rust engine meter their own inserts; plain Web Audio binds its nodes.
  if (engine.getDeviceMeter) return engine.getDeviceMeter(deviceId)
  return webDynamicsReading(deviceId)
}

/**
 * One meter loop per dynamics card, shared by the card and its large editor. Listeners are called
 * on animation frames with the newest frame; they draw into refs (never React state), so live
 * metering never re-renders the rack. The loop sleeps while the tab is hidden.
 */
export interface DynamicsFeed {
  readonly history: MeterHistory
  latest: MeterFrame
  /** True once any reading arrived (the engine meters this device). */
  live: boolean
  subscribe(listener: (frame: MeterFrame, seconds: number) => void): () => void
}

export function createDynamicsFeed(read: () => DynamicsReading | null): DynamicsFeed & { tick(now: number): void } {
  const listeners = new Set<(frame: MeterFrame, seconds: number) => void>()
  const feed = {
    history: new MeterHistory(HISTORY_FRAMES),
    latest: meterFrame(null),
    live: false,
    subscribe(listener: (frame: MeterFrame, seconds: number) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    tick: (now: number) => tick(now),
  }
  let last = -1, carry = 0
  const tick = (now: number) => {
    const seconds = last < 0 ? FRAME_SECONDS : Math.min(0.25, (now - last) / 1000)
    last = now
    const reading = read()
    if (reading) feed.live = true
    const frame = meterFrame(reading)
    feed.latest = frame
    // Fixed 60 Hz history regardless of display refresh rate.
    carry += seconds
    let pushes = 0
    while (carry >= FRAME_SECONDS && pushes < 15) { feed.history.push(frame.inputDb, frame.reductionDb); carry -= FRAME_SECONDS; pushes += 1 }
    if (pushes === 15) carry = 0
    for (const listener of listeners) listener(frame, seconds)
  }
  return feed
}

/** requestAnimationFrame while the page is visible. Returns a stop function. */
export function defaultScheduler(tick: (now: number) => void): () => void {
  if (typeof requestAnimationFrame === 'undefined') return () => {}
  let id = 0, stopped = false
  const loop = (now: number) => { if (stopped) return; if (document.visibilityState !== 'hidden') tick(now); id = requestAnimationFrame(loop) }
  id = requestAnimationFrame(loop)
  return () => { stopped = true; cancelAnimationFrame(id) }
}

export function useDynamicsFeed(engine: AudioEngine, deviceId: string): DynamicsFeed {
  const feed = useMemo(() => createDynamicsFeed(() => readDeviceMeter(engine, deviceId)), [engine, deviceId])
  useEffect(() => defaultScheduler(feed.tick), [feed])
  return feed
}

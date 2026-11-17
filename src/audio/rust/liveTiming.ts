// Sample-accurate live MIDI in the browser (docs/RUST_ENGINE.md 5.8).
//
// The main thread stamps each live event with the AudioContext frame it should sound at: the context's render
// clock when the key was struck (the MIDI event's timeStamp, performance.now() base) plus a constant lead. The
// worklet turns that frame into an offset inside the render quantum it is about to render, and the engine starts
// the event on that sample. Every event keeps its distance from the others — no quantum (or render-burst) jitter —
// at the price of the lead; an event that arrives after its frame plays at the start of the quantum, as before.

/** The latest an event may be scheduled ahead of the quantum (garak-engine `MAX_LIVE_OFFSET`). */
export const MAX_LIVE_OFFSET = 65536

/** One render quantum (Web Audio renders 128 frames at a time). */
const QUANTUM = 128
/** The lead never exceeds this: live playing must stay tight. */
const MAX_LEAD_SECONDS = 0.02

/**
 * The lead of a stamped live event: the context's base latency (about one render callback, how far `currentTime`
 * can jump at once), at least a quantum and at most 20 ms.
 */
export function liveLeadSeconds(sampleRate: number, baseLatency?: number): number {
  const quantum = QUANTUM / sampleRate
  const base = typeof baseLatency === 'number' && Number.isFinite(baseLatency) ? baseLatency : 0
  return Math.min(MAX_LEAD_SECONDS, Math.max(quantum, base))
}

/**
 * The context frame an event stamped `eventMs` (performance.now() base) plays at. `nowMs` and `currentTime` are
 * read together on the main thread; an event older than now maps back by its age. Never 0 (0 means "the next
 * quantum's first frame" on the wire).
 */
export function liveContextFrame(eventMs: number, nowMs: number, currentTime: number, sampleRate: number, leadSeconds: number): number {
  const age = Number.isFinite(eventMs) && eventMs > 0 ? Math.max(0, nowMs - eventMs) / 1000 : 0
  return Math.max(1, Math.round((currentTime - age + leadSeconds) * sampleRate))
}

/** Worklet: frames into the quantum starting at context frame `quantumFrame` for an event stamped `at` (0: now). */
export function liveOffsetFrames(at: number, quantumFrame: number): number {
  if (!(at > 0)) return 0
  return Math.min(MAX_LIVE_OFFSET, Math.max(0, Math.round(at - quantumFrame)))
}

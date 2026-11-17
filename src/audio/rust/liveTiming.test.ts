import { describe, expect, it } from 'vitest'
import { liveContextFrame, liveLeadSeconds, liveOffsetFrames, MAX_LIVE_OFFSET } from './liveTiming'

describe('live MIDI timing (docs/RUST_ENGINE.md 5.8)', () => {
  it('leads by the base latency, at least a quantum and at most 20 ms', () => {
    expect(liveLeadSeconds(48_000, 0.01)).toBe(0.01)
    expect(liveLeadSeconds(48_000, 0)).toBeCloseTo(128 / 48_000, 12)
    expect(liveLeadSeconds(48_000, undefined)).toBeCloseTo(128 / 48_000, 12)
    expect(liveLeadSeconds(44_100, Number.NaN)).toBeCloseTo(128 / 44_100, 12)
    expect(liveLeadSeconds(48_000, 0.2)).toBe(0.02)
  })

  it('maps a stamped event to the render clock at its moment plus the lead', () => {
    const rate = 48_000, lead = 0.005
    // Struck 4 ms ago while the context renders t = 10 s: frame (10 - 0.004 + 0.005) * 48000.
    expect(liveContextFrame(996, 1000, 10, rate, lead)).toBe(480_048)
    // Two events 1 ms apart keep 48 frames between them whatever the read moment.
    const a = liveContextFrame(990, 1000, 10, rate, lead), b = liveContextFrame(991, 1000, 10, rate, lead)
    expect(b - a).toBe(48)
    const later = liveContextFrame(991, 1003, 10.003, rate, lead)
    expect(later).toBe(b)
    // A stamp from the future (clock skew) counts as now; a missing or broken one too.
    expect(liveContextFrame(1005, 1000, 10, rate, lead)).toBe(liveContextFrame(1000, 1000, 10, rate, lead))
    expect(liveContextFrame(Number.NaN, 1000, 10, rate, lead)).toBe(480_240)
    expect(liveContextFrame(0, 1000, 10, rate, lead)).toBe(480_240)
    // Never 0 (0 is "the next quantum's first frame" on the wire).
    expect(liveContextFrame(0, 1000, 0, rate, 0)).toBe(1)
  })

  it('becomes a frame offset inside the quantum the worklet renders next', () => {
    expect(liveOffsetFrames(0, 1_000_000)).toBe(0) // unstamped: the quantum's first frame
    expect(liveOffsetFrames(1_000_037, 1_000_000)).toBe(37)
    expect(liveOffsetFrames(1_000_300, 1_000_000)).toBe(300) // a later quantum: the engine carries it
    expect(liveOffsetFrames(999_000, 1_000_000)).toBe(0) // late: plays at once
    expect(liveOffsetFrames(1_000_000 + 10 * MAX_LIVE_OFFSET, 1_000_000)).toBe(MAX_LIVE_OFFSET)
  })

  it('round-trips: an event struck k frames into a quantum plays k frames into its quantum, one lead later', () => {
    const rate = 48_000, lead = 256 / rate
    // The main thread reads currentTime at the start of quantum q (frame 128 q); the key went down 40 frames after
    // the previous quantum started.
    const quantum = 7_500, now = 1_000_000
    const struck = now - ((128 - 40) / rate) * 1000
    const at = liveContextFrame(struck, now, (quantum * 128) / rate, rate, lead)
    const target = (quantum - 1) * 128 + 40 + 256
    expect(at).toBe(target)
    expect(liveOffsetFrames(at, Math.floor(target / 128) * 128)).toBe(target % 128)
  })
})

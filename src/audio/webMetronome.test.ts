import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '../core/project'
import type { Project } from '../core/types'
import { WebMetronome } from './webMetronome'

/** Records what the metronome asks Web Audio to do; no DSP. */
class FakeContext {
  currentTime = 0
  sampleRate = 48000
  destination = {}
  starts: Array<{ time: number; length: number; stopped: boolean }> = []
  createGain() { return { context: this, gain: { value: 1, setTargetAtTime(value: number) { this.value = value } }, connect() {}, disconnect() {} } }
  createBuffer(_channels: number, length: number) { return { length, copyToChannel() {} } }
  createBufferSource() {
    const entry = { time: NaN, length: 0, stopped: false }
    const source = {
      buffer: null as { length: number } | null, onended: null as null | (() => void),
      connect() {}, disconnect() {},
      start: (time: number) => { entry.time = time; entry.length = source.buffer?.length ?? 0; this.starts.push(entry) },
      stop: () => { entry.stopped = true },
    }
    return source
  }
}

const project = (patch: Partial<Project> = {}): Project => ({ ...createEmptyProject(), bpm: 120, timeSignature: { numerator: 4, denominator: 4 }, beatsPerBar: 4, ...patch })
const on = { enabled: true, sound: 'janggu' as const, volume: 0.5, accent: true }

describe('WebMetronome', () => {
  it('starts each click at its exact audio-clock time, with one buffer per level', () => {
    const context = new FakeContext(), metronome = new WebMetronome()
    metronome.setState(on, 0)
    const ctx = context as unknown as BaseAudioContext
    metronome.scheduleSegment(ctx, project(), 0, 2.5, 1)
    metronome.scheduleSegment(ctx, project(), 2.5, 4.5, 2.25)
    expect(context.starts.map(start => start.time)).toEqual([1, 1.5, 2, 2.5, 3])
    // Downbeats share the 덩 stroke, other beats the 덕 stroke.
    const [down, beat] = [context.starts[0].length, context.starts[1].length]
    expect(down).not.toBe(beat)
    expect(context.starts[4].length).toBe(down)
  })

  it('stays silent when off, but still plays a count-in', () => {
    const context = new FakeContext(), metronome = new WebMetronome()
    const ctx = context as unknown as BaseAudioContext
    metronome.scheduleSegment(ctx, project(), 0, 4, 0)
    expect(context.starts).toHaveLength(0)
    const p = project({ timeSignature: { numerator: 6, denominator: 8 }, beatsPerBar: 3 })
    expect(metronome.countInSeconds(p, 2)).toBe(3)
    metronome.scheduleCountIn(ctx, p, 1, 0.1)
    expect(context.starts.map(start => +start.time.toFixed(6))).toEqual([0.1, 0.35, 0.6, 0.85, 1.1, 1.35])
  })

  it('cancels queued clicks on stop/restart or when switched off, keeping ringing ones', () => {
    const context = new FakeContext(), metronome = new WebMetronome()
    const ctx = context as unknown as BaseAudioContext
    metronome.setState(on, 0)
    metronome.scheduleSegment(ctx, project(), 0, 4, 0)
    context.currentTime = 0.6
    metronome.setState({ ...on, enabled: false }, context.currentTime)
    expect(context.starts.map(start => start.stopped)).toEqual([false, false, true, true])
  })

  it('never starts a click in the past', () => {
    const context = new FakeContext(), metronome = new WebMetronome()
    const ctx = context as unknown as BaseAudioContext
    metronome.setState(on, 0)
    context.currentTime = 5
    metronome.scheduleSegment(ctx, project(), 0, 2, 4.999)
    expect(context.starts.map(start => start.time)).toEqual([5, 5.499])
  })
})

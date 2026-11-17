import { describe, expect, it } from 'vitest'
import { CommandRing, emptyStatus, liveControllerNumber, METER_BYTES, MeterReader, MeterWriter, RING_BYTES, RING_LIVE, STATUS_BYTES, StatusReader, StatusWriter, type RingCommand } from './engineChannel'

const ring = () => new CommandRing(new SharedArrayBuffer(RING_BYTES))

describe('engine worklet channel', () => {
  it('drains transport commands in order, holding each until the message before it was applied', () => {
    const r = ring()
    expect(r.push({ command: 3, frame: 4800, afterSeq: 1, seq: 2 })).toBe(true)
    expect(r.push({ command: 0, frame: 0, afterSeq: 2, seq: 3 })).toBe(true)
    const seen: RingCommand[] = []
    r.drain(0, command => seen.push(command))
    expect(seen).toEqual([]) // message 1 (say, project.set) has not been applied yet
    r.drain(1, command => seen.push(command))
    expect(seen.map(command => command.seq)).toEqual([2, 3])
    expect(seen[0]).toMatchObject({ command: 3, frame: 4800, a: 0, d: 0 })
    r.drain(9, command => seen.push(command))
    expect(seen).toHaveLength(2)
  })

  it('reports a full ring so the caller falls back to postMessage', () => {
    const r = ring()
    for (let seq = 1; seq <= 64; seq += 1) expect(r.push({ command: 0, frame: 0, afterSeq: 0, seq })).toBe(true)
    expect(r.push({ command: 0, frame: 0, afterSeq: 0, seq: 65 })).toBe(false)
    let count = 0
    r.drain(0, () => { count += 1 })
    expect(count).toBe(64)
    expect(r.push({ command: 1, frame: 0, afterSeq: 0, seq: 66 })).toBe(true)
  })

  it('publishes status through the seqlock and keeps the loudest unread peak', () => {
    const buffer = new SharedArrayBuffer(STATUS_BYTES)
    const writer = new StatusWriter(buffer), reader = new StatusReader(buffer)
    writer.write({ ...emptyStatus(), frame: 128, playing: true, peak: 0.5, quanta: 1, appliedSeq: 3 })
    writer.write({ ...emptyStatus(), frame: 256, playing: true, peak: 0.25, quanta: 2, appliedSeq: 3, countingIn: true, contextFrame: 9000, revision: 7 })
    const status = emptyStatus()
    expect(reader.read(status)).toBe(true)
    expect(status).toMatchObject({ frame: 256, playing: true, peak: 0.5, quanta: 2, appliedSeq: 3, countingIn: true, contextFrame: 9000, revision: 7 })
    const next = emptyStatus()
    reader.read(next)
    expect(next.peak).toBe(0) // the reader cleared it
  })

  it('numbers live controllers the way the engine does: CCs, aftertouch, pitch bend, program', () => {
    expect(liveControllerNumber('cc1')).toBe(1)
    expect(liveControllerNumber('cc127')).toBe(127)
    expect(liveControllerNumber('aftertouch')).toBe(128)
    expect(liveControllerNumber('pitchBend')).toBe(129)
    expect(liveControllerNumber('program')).toBe(130)
    expect(liveControllerNumber('cc128')).toBeNull()
    expect(liveControllerNumber('sustain')).toBeNull()
  })

  it('carries live note events in the ring with their track, kind, pitch, velocity and target context frame', () => {
    const r = ring()
    expect(r.push({ command: RING_LIVE, frame: 42, afterSeq: 0, seq: 1, a: 3, b: 0, c: 60, d: 0.75, e: 9_000_123 })).toBe(true)
    expect(r.push({ command: RING_LIVE, frame: 43, afterSeq: 1, seq: 2, a: 3, b: 1, c: 60 })).toBe(true)
    const seen: RingCommand[] = []
    r.drain(0, command => seen.push(command))
    expect(seen).toEqual([
      { command: RING_LIVE, frame: 42, afterSeq: 0, seq: 1, a: 3, b: 0, c: 60, d: 0.75, e: 9_000_123 },
      { command: RING_LIVE, frame: 43, afterSeq: 1, seq: 2, a: 3, b: 1, c: 60, d: 0, e: 0 },
    ])
  })

  it('keeps unread meters (louder peak, lower gain) until the main thread reads them', () => {
    const buffer = new SharedArrayBuffer(METER_BYTES)
    const writer = new MeterWriter(buffer), reader = new MeterReader(buffer)
    writer.write(5, new Float32Array([0.5, 0.25, 0]), 3, [{ track: 1, insert: 2, input: 0.5, gain: 0.9 }])
    writer.write(5, new Float32Array([0.25, 0.75, 0]), 3, [{ track: 1, insert: 2, input: 0.25, gain: 0.5 }, { track: 0, insert: 0, input: 0.125, gain: 1 }])
    const read = reader.read()!
    expect(read.revision).toBe(5)
    expect([...read.peaks]).toEqual([0.5, 0.75, 0])
    expect(read.dynamics).toEqual([{ track: 1, insert: 2, input: 0.5, gain: 0.5 }, { track: 0, insert: 0, input: 0.125, gain: 1 }])
    expect([...reader.read()!.peaks]).toEqual([0, 0, 0])
    // A new graph (revision) starts its peaks afresh.
    writer.write(6, new Float32Array([0.125]), 1, [])
    expect([...reader.read()!.peaks]).toEqual([0.125])
  })
})

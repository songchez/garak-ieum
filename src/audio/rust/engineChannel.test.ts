import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AUDIO_SETTINGS } from '../../core/audioSettings'
import { createAudioEngine } from '../engineFactory'
import { WebAudioEngine } from '../WebAudioEngine'
import { CommandRing, emptyStatus, METER_BYTES, MeterReader, MeterWriter, RING_BYTES, RING_LIVE, STATUS_BYTES, StatusReader, StatusWriter, type RingCommand } from './engineChannel'
import { RUST_ENGINE_STORAGE_KEY, rustEngineRequested } from './flag'
import { RustWebAudioEngine } from './RustWebAudioEngine'

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

  it('carries live note events in the ring with their track, kind, pitch and velocity', () => {
    const r = ring()
    expect(r.push({ command: RING_LIVE, frame: 42, afterSeq: 0, seq: 1, a: 3, b: 0, c: 60, d: 0.75 })).toBe(true)
    const seen: RingCommand[] = []
    r.drain(0, command => seen.push(command))
    expect(seen).toEqual([{ command: RING_LIVE, frame: 42, afterSeq: 0, seq: 1, a: 3, b: 0, c: 60, d: 0.75 }])
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

describe('Rust engine flag', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  const storage = (value: string | null) => vi.stubGlobal('localStorage', { getItem: (key: string) => key === RUST_ENGINE_STORAGE_KEY ? value : null })

  it('is off by default and follows localStorage', () => {
    storage(null)
    expect(rustEngineRequested()).toBe(false)
    storage('1')
    expect(rustEngineRequested()).toBe(true)
    storage('0')
    expect(rustEngineRequested()).toBe(false)
  })

  it('selects the Rust engine host only when requested; it stays a WebAudioEngine', () => {
    vi.stubGlobal('window', {})
    storage(null)
    const plain = createAudioEngine(DEFAULT_AUDIO_SETTINGS)
    expect(plain).not.toBeInstanceOf(RustWebAudioEngine)
    plain.dispose()
    storage('1')
    const rust = createAudioEngine(DEFAULT_AUDIO_SETTINGS)
    expect(rust).toBeInstanceOf(RustWebAudioEngine)
    expect(rust).toBeInstanceOf(WebAudioEngine)
    expect(rust.kind).toBe('web-audio')
    expect((rust as RustWebAudioEngine).diagnostics()).toMatchObject({ running: false, accepted: false, playing: null })
    rust.dispose()
  })
})

import { describe, expect, it, vi } from 'vitest'
import { WebLiveMidi, type StampedMidi } from './liveMidi'
import { NativeLiveMidi } from './native/nativeLiveMidi'
import type { MidiRoute } from '../core/midiInput'

const route = (trackId: string, patch: Partial<MidiRoute> = {}): MidiRoute => ({ trackId, device: null, channel: 0, transpose: 0, velocityOffset: 0, keyLow: 0, keyHigh: 127, velocityLow: 1, velocityHigh: 127, ...patch })

function fakeHost(beat: number | null = 2) {
  const started: { trackId: string; pitch: number; velocity: number; release: ReturnType<typeof vi.fn> }[] = []
  return {
    started,
    host: {
      startNote: (trackId: string, pitch: number, velocity: number) => { const release = vi.fn(); started.push({ trackId, pitch, velocity, release }); return { release } },
      beatAt: vi.fn(() => beat),
    },
  }
}

describe('WebLiveMidi', () => {
  it('plays routed notes velocity-sensitively and stamps every message with the heard beat', () => {
    const { host, started } = fakeHost(3.5)
    const live = new WebLiveMidi(host, () => 1000)
    const seen: StampedMidi[] = []
    live.subscribe(event => seen.push(event))
    live.setRoutes([route('a', { transpose: 12 })])
    live.send('kbd', [0x90, 60, 64], 990)
    expect(started).toMatchObject([{ trackId: 'a', pitch: 72, velocity: 64 / 127 }])
    expect(host.beatAt).toHaveBeenCalledWith(990)
    expect(seen).toEqual([{ source: 'kbd', data: [0x90, 60, 64], time: 990, beat: 3.5 }])
    live.send('kbd', [0x80, 60, 0])
    expect(started[0].release).toHaveBeenCalledTimes(1)
  })
  it('clamps future timestamps to now', () => {
    const { host } = fakeHost()
    const live = new WebLiveMidi(host, () => 500)
    live.send('k', [0x90, 60, 1], 9999)
    expect(host.beatAt).toHaveBeenCalledWith(500)
  })
  it('switching tracks releases the old track’s held notes; the note-off then does nothing more', () => {
    const { host, started } = fakeHost()
    const live = new WebLiveMidi(host)
    live.setRoutes([route('a')])
    live.send('k', [0x90, 60, 100])
    live.setRoutes([route('b')])
    expect(started[0].release).toHaveBeenCalledTimes(1)
    live.send('k', [0x80, 60, 0])
    expect(started[0].release).toHaveBeenCalledTimes(1)
  })
  it('panic and All Notes Off release everything held', () => {
    const { host, started } = fakeHost()
    const live = new WebLiveMidi(host)
    live.setRoutes([route('a')])
    live.send('k', [0x90, 60, 100]); live.send('k', [0x90, 62, 100])
    live.send('k', [0xB0, 123, 0])
    expect(started.every(note => note.release.mock.calls.length === 1)).toBe(true)
    live.send('k', [0x90, 64, 100])
    live.panic()
    expect(started[2].release).toHaveBeenCalledTimes(1)
  })
  it('controllers (CC64) are reported for recording but play nothing yet', () => {
    const { host, started } = fakeHost()
    const live = new WebLiveMidi(host)
    const seen: StampedMidi[] = []
    live.subscribe(event => seen.push(event))
    live.setRoutes([route('a')])
    live.send('k', [0xB0, 64, 127])
    expect(started).toEqual([])
    expect(seen[0].data).toEqual([0xB0, 64, 127])
  })
  it('hands each message’s stamp to the engine (sample-accurate playback) and records the same stamp', () => {
    // docs/RUST_ENGINE.md 5.8: note-on, note-off, controllers and pedal releases carry the MIDI timeStamp, so the
    // engine schedules them at that moment; the recording stamp stays the heard beat at that same time.
    const startNote = vi.fn((_trackId: string, _pitch: number, _velocity: number, _time?: number) => ({ release }))
    const release = vi.fn(), control = vi.fn()
    const host = { startNote, beatAt: vi.fn((time: number) => time / 1000), control }
    const live = new WebLiveMidi(host, () => 2000)
    const seen: StampedMidi[] = []
    live.subscribe(event => seen.push(event))
    live.setRoutes([route('a')])
    live.send('k', [0x90, 60, 100], 1990.25)
    live.send('k', [0xE0, 0, 80], 1991)
    live.send('k', [0xB0, 64, 127], 1992)
    live.send('k', [0x80, 60, 0], 1993)
    expect(release).not.toHaveBeenCalled() // held by the pedal
    live.send('k', [0xB0, 64, 0], 1994.5)
    expect(startNote).toHaveBeenCalledWith('a', 60, 100 / 127, 1990.25)
    expect(control).toHaveBeenCalledWith('a', 'pitchBend', expect.any(Number), 1991)
    expect(release).toHaveBeenCalledWith(1994.5)
    expect(seen.map(event => [event.time, event.beat])).toEqual([[1990.25, 1.99025], [1991, 1.991], [1992, 1.992], [1993, 1.993], [1994.5, 1.9945]])
    // Channel and poly aftertouch play as the track's aftertouch with their stamps (poly: the key's pressure).
    live.send('k', [0xD0, 64], 1995)
    live.send('k', [0xA0, 60, 99], 1996)
    expect(control).toHaveBeenCalledWith('a', 'aftertouch', 64, 1995)
    expect(control).toHaveBeenLastCalledWith('a', 'aftertouch', 99, 1996)
    expect(seen.at(-1)?.data).toEqual([0xA0, 60, 99]) // recorded as sent
    // Without a stamp (computer keyboard focus loss, panic) the engine plays it now.
    live.send('k', [0x90, 62, 90])
    expect(startNote).toHaveBeenLastCalledWith('a', 62, 90 / 127, 2000)
  })
})

describe('NativeLiveMidi', () => {
  it('turns snapshot frames into beats and keeps null for a stopped transport', () => {
    const live = new NativeLiveMidi(vi.fn(), () => true, () => 120, () => 42)
    const seen: StampedMidi[] = []
    live.subscribe(event => seen.push(event))
    live.receive([{ source: 'Keys', data: [0x90, 60, 100], frame: 24000 }, { source: 'keyboard', data: [0x80, 60, 0], frame: null }, { source: 1, data: [] }], 48000)
    expect(seen).toEqual([{ source: 'Keys', data: [0x90, 60, 100], time: 42, beat: 1 }, { source: 'keyboard', data: [0x80, 60, 0], time: 42, beat: null }])
  })
  it('sends routes once per change and again after a project was applied; injects keyboard notes', async () => {
    const request = vi.fn(async () => ({}))
    const live = new NativeLiveMidi(request as never, () => true, () => 120)
    live.setRoutes([route('a')]); live.setRoutes([route('a')])
    live.resync()
    live.send('keyboard', [0x90, 60, 100])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(request.mock.calls.filter(call => (call as unknown[])[0] === 'midi.routes')).toHaveLength(2)
    expect(request).toHaveBeenCalledWith('midi.inject', { messages: [{ source: 'keyboard', data: [0x90, 60, 100] }] })
  })
})

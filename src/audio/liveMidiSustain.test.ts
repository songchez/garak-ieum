import { describe, expect, it, vi } from 'vitest'
import { WebLiveMidi } from './liveMidi'
import type { MidiRoute } from '../core/midiInput'

const route = (trackId: string, patch: Partial<MidiRoute> = {}): MidiRoute => ({ trackId, device: null, channel: 0, transpose: 0, velocityOffset: 0, keyLow: 0, keyHigh: 127, velocityLow: 1, velocityHigh: 127, ...patch })
function fakeHost() {
  const started: { trackId: string; pitch: number; release: ReturnType<typeof vi.fn> }[] = []
  return { started, host: { startNote: (trackId: string, pitch: number) => { const release = vi.fn(); started.push({ trackId, pitch, release }); return { release } }, beatAt: () => null } }
}

describe('WebLiveMidi sustain pedal (core/sustain.ts rules)', () => {
  it('defers note-offs while CC64 is down and releases them on pedal up', () => {
    const { host, started } = fakeHost()
    const live = new WebLiveMidi(host)
    live.setRoutes([route('a')])
    live.send('k', [0xB0, 64, 127])
    live.send('k', [0x90, 60, 100]); live.send('k', [0x80, 60, 0])
    expect(started[0].release).not.toHaveBeenCalled()
    live.send('k', [0xB0, 64, 0])
    expect(started[0].release).toHaveBeenCalledTimes(1)
  })
  it('a re-struck sustained pitch ends its old voice; the channel filter decides which tracks get the pedal', () => {
    const { host, started } = fakeHost()
    const live = new WebLiveMidi(host)
    live.setRoutes([route('a', { channel: 1 }), route('b', { channel: 2 })])
    live.send('k', [0xB0, 64, 127]) // channel 1: only track a
    live.send('k', [0x90, 60, 100]); live.send('k', [0x80, 60, 0])
    expect(started.map(n => n.trackId)).toEqual(['a'])
    live.send('k', [0x90, 60, 90])
    expect(started[0].release).toHaveBeenCalledTimes(1)
    live.send('k', [0x91, 64, 100]); live.send('k', [0x81, 64, 0]) // channel 2 → track b, no pedal there
    expect(started.find(n => n.trackId === 'b')!.release).toHaveBeenCalledTimes(1)
  })
  it('switching tracks and panic lift the pedal', () => {
    const { host, started } = fakeHost()
    const live = new WebLiveMidi(host)
    live.setRoutes([route('a')])
    live.send('k', [0xB0, 64, 127]); live.send('k', [0x90, 60, 100]); live.send('k', [0x80, 60, 0])
    live.setRoutes([route('b')])
    expect(started[0].release).toHaveBeenCalledTimes(1)
    live.send('k', [0xB0, 64, 127]); live.send('k', [0x90, 62, 100]); live.send('k', [0x80, 62, 0])
    live.panic()
    expect(started[1].release).toHaveBeenCalledTimes(1)
  })
})

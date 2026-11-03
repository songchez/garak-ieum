import { describe, expect, it } from 'vitest'
import type { Project, Track } from './types'
import { anySolo, audibleTracks, clearRecallSolo, effectiveArm, implicitlyMuted, monitorTargets, pressTrackButton, recordTarget, sweepTrackButton } from './trackActions'

const track = (id: string, patch: Partial<Track> = {}): Track => ({
  id, name: id, kind: 'instrument', instrument: 'keys', color: '#66d666', volume: 1, pan: 0,
  mute: false, solo: false, soloSafe: false, enabled: true, armed: false, monitor: false, hidden: false,
  transpose: 0, velocityOffset: 0, keyLimit: [0, 127], velocityLimit: [1, 127], delayTicks: 0,
  clips: [], instrumentParams: {}, devices: [], ...patch,
})

const project = (...tracks: Track[]): Project => ({
  schemaVersion: 4, id: 'p', name: 'p', bpm: 120, sampleRate: 48000, beatsPerBar: 4, lengthBeats: 64, masterVolume: 1,
  loop: { enabled: false, startBeat: 0, endBeat: 4 }, tracks, markers: [],
})

const field = (p: Project, key: keyof Track) => p.tracks.map(t => t[key])

describe('pressTrackButton: mute', () => {
  const base = project(track('a', { mute: true }), track('b'), track('c', { mute: true }))

  it('toggles the target', () => {
    expect(field(pressTrackButton(base, 'b', 'mute', {}), 'mute')).toEqual([true, true, true])
    expect(field(pressTrackButton(base, 'a', 'mute'), 'mute')).toEqual([false, false, true])
  })

  it('alt = only the target is muted', () => {
    expect(field(pressTrackButton(base, 'b', 'mute', { alt: true }), 'mute')).toEqual([false, true, false])
  })

  it('mod = every track in the same state as the target flips', () => {
    expect(field(pressTrackButton(base, 'a', 'mute', { mod: true }), 'mute')).toEqual([false, false, false])
    expect(field(pressTrackButton(base, 'b', 'mute', { mod: true }), 'mute')).toEqual([true, true, true])
  })

  it('returns the same project for an unknown track and untouched tracks keep their identity', () => {
    expect(pressTrackButton(base, 'zzz', 'mute')).toBe(base)
    const next = pressTrackButton(base, 'b', 'mute')
    expect(next).not.toBe(base)
    expect(next.tracks[0]).toBe(base.tracks[0])
    expect(next.tracks[2]).toBe(base.tracks[2])
  })
})

describe('pressTrackButton: solo', () => {
  const base = project(track('a', { solo: true }), track('b'), track('c', { soloSafe: true }))

  it('toggles', () => {
    expect(field(pressTrackButton(base, 'b', 'solo'), 'solo')).toEqual([true, true, false])
    expect(field(pressTrackButton(base, 'a', 'solo'), 'solo')).toEqual([false, false, false])
  })

  it('alt = exclusive solo', () => {
    expect(field(pressTrackButton(base, 'b', 'solo', { alt: true }), 'solo')).toEqual([false, true, false])
  })

  it('mod = all tracks take the target new value', () => {
    expect(field(pressTrackButton(base, 'b', 'solo', { mod: true }), 'solo')).toEqual([true, true, true])
    expect(field(pressTrackButton(base, 'a', 'solo', { mod: true }), 'solo')).toEqual([false, false, false])
  })

  it('soloSafe toggles the flag and clears solo when turning on', () => {
    const on = pressTrackButton(base, 'a', 'solo', { soloSafe: true })
    expect(on.tracks[0]).toMatchObject({ solo: false, soloSafe: true })
    expect(on.tracks[1]).toBe(base.tracks[1])
    const off = pressTrackButton(base, 'c', 'solo', { soloSafe: true })
    expect(off.tracks[2]).toMatchObject({ solo: false, soloSafe: false })
    expect(pressTrackButton(base, 'b', 'solo', { soloSafe: true, alt: true, mod: true }).tracks[1].soloSafe).toBe(true)
  })
})

describe('pressTrackButton: arm', () => {
  const base = project(track('a', { armed: true }), track('b'), track('c', { armed: true }))

  it('toggles (mod ignored)', () => {
    expect(field(pressTrackButton(base, 'b', 'arm'), 'armed')).toEqual([true, true, true])
    expect(field(pressTrackButton(base, 'a', 'arm', { mod: true }), 'armed')).toEqual([false, false, true])
  })

  it('alt on an armed track disarms everything, on an unarmed track arms only that one', () => {
    expect(field(pressTrackButton(base, 'a', 'arm', { alt: true }), 'armed')).toEqual([false, false, false])
    expect(field(pressTrackButton(base, 'b', 'arm', { alt: true }), 'armed')).toEqual([false, true, false])
  })
})

describe('pressTrackButton: monitor / hidden', () => {
  const base = project(track('a', { monitor: true, hidden: true }), track('b'))

  it('toggle and ignore modifiers', () => {
    for (const mods of [{}, { alt: true }, { mod: true }, { alt: true, mod: true }]) {
      expect(field(pressTrackButton(base, 'b', 'monitor', mods), 'monitor')).toEqual([true, true])
      expect(field(pressTrackButton(base, 'a', 'monitor', mods), 'monitor')).toEqual([false, false])
      expect(field(pressTrackButton(base, 'b', 'hidden', mods), 'hidden')).toEqual([true, true])
      expect(field(pressTrackButton(base, 'a', 'hidden', mods), 'hidden')).toEqual([false, false])
    }
  })
})

describe('pressTrackButton: enabled', () => {
  const base = project(track('a', { enabled: false }), track('b'), track('c'))

  it('toggles with or without alt', () => {
    expect(field(pressTrackButton(base, 'b', 'enabled'), 'enabled')).toEqual([false, false, true])
    expect(field(pressTrackButton(base, 'a', 'enabled', { alt: true }), 'enabled')).toEqual([true, true, true])
  })

  it('mod = all tracks take the target new value', () => {
    expect(field(pressTrackButton(base, 'b', 'enabled', { mod: true }), 'enabled')).toEqual([false, false, false])
    expect(field(pressTrackButton(base, 'a', 'enabled', { mod: true }), 'enabled')).toEqual([true, true, true])
  })
})

describe('sweepTrackButton', () => {
  it('sets the value and returns the same project when already there', () => {
    const base = project(track('a'), track('b', { mute: true }))
    expect(field(sweepTrackButton(base, 'a', 'mute', true), 'mute')).toEqual([true, true])
    expect(sweepTrackButton(base, 'b', 'mute', true)).toBe(base)
    expect(field(sweepTrackButton(base, 'b', 'mute', false), 'mute')).toEqual([false, false])
    expect(sweepTrackButton(base, 'a', 'arm', true).tracks[0].armed).toBe(true)
    expect(sweepTrackButton(base, 'a', 'enabled', false).tracks[0].enabled).toBe(false)
    expect(sweepTrackButton(base, 'nope', 'solo', true)).toBe(base)
  })
})

describe('clearRecallSolo', () => {
  it('clears all solos and remembers them, then restores the ones that still exist', () => {
    const base = project(track('a', { solo: true }), track('b'), track('c', { solo: true }))
    const cleared = clearRecallSolo(base, null)
    expect(field(cleared.project, 'solo')).toEqual([false, false, false])
    expect(cleared.recall).toEqual(['a', 'c'])

    const withoutC = { ...cleared.project, tracks: cleared.project.tracks.filter(t => t.id !== 'c') }
    const restored = clearRecallSolo(withoutC, cleared.recall)
    expect(field(restored.project, 'solo')).toEqual([true, false])
    expect(restored.recall).toBeNull()
  })

  it('prefers clearing when a solo exists even with a recall list', () => {
    const base = project(track('a', { solo: true }), track('b'))
    const out = clearRecallSolo(base, ['b'])
    expect(field(out.project, 'solo')).toEqual([false, false])
    expect(out.recall).toEqual(['a'])
  })

  it('is a no-op with nothing soloed and nothing to recall', () => {
    const base = project(track('a'), track('b'))
    const out = clearRecallSolo(base, null)
    expect(out.project).toBe(base)
    expect(out.recall).toBeNull()
  })
})

describe('effectiveArm', () => {
  const inst = track('i'), inst2 = track('j'), audio = track('x', { kind: 'audio' })

  it('is armed when explicitly armed', () => {
    const t = track('i', { armed: true })
    expect(effectiveArm(t, null, [t])).toBe('armed')
  })

  it('is auto for the focused instrument track when no instrument track is armed', () => {
    expect(effectiveArm(inst, 'i', [inst, inst2, audio])).toBe('auto')
    expect(effectiveArm(inst2, 'i', [inst, inst2, audio])).toBe('off')
    expect(effectiveArm(audio, 'x', [inst, inst2, audio])).toBe('off')
    expect(effectiveArm(inst, null, [inst, inst2])).toBe('off')
  })

  it('drops auto when another instrument track is armed, but not for an armed audio track', () => {
    const armedInst = track('j', { armed: true }), armedAudio = track('x', { kind: 'audio', armed: true })
    expect(effectiveArm(inst, 'i', [inst, armedInst])).toBe('off')
    expect(effectiveArm(inst, 'i', [inst, armedAudio])).toBe('auto')
  })
})

describe('audible / implicit mute', () => {
  it('without solo, enabled and unmuted tracks are audible', () => {
    const p = project(track('a'), track('b', { mute: true }), track('c', { enabled: false }))
    expect(anySolo(p)).toBe(false)
    expect([...audibleTracks(p)]).toEqual(['a'])
    expect(p.tracks.map(t => implicitlyMuted(t, p))).toEqual([false, false, false])
  })

  it('with a solo, only soloed and solo-safe tracks are audible; the rest are implicitly muted', () => {
    const p = project(track('a', { solo: true }), track('b'), track('c', { soloSafe: true }), track('d', { mute: true }), track('e', { enabled: false }), track('f', { solo: true, mute: true }))
    expect(anySolo(p)).toBe(true)
    expect([...audibleTracks(p)]).toEqual(['a', 'c'])
    expect(p.tracks.map(t => implicitlyMuted(t, p))).toEqual([false, true, false, false, false, false])
  })

  it('ignores solo on disabled tracks', () => {
    const p = project(track('a'), track('b', { solo: true, enabled: false }))
    expect(anySolo(p)).toBe(false)
    expect([...audibleTracks(p)]).toEqual(['a'])
  })
})

describe('recordTarget', () => {
  it('picks the topmost armed audio track and reports the extras', () => {
    const p = project(track('i', { armed: true }), track('x', { kind: 'audio', armed: true }), track('y', { kind: 'audio', armed: true }), track('z', { kind: 'audio', armed: true, enabled: false }))
    expect(recordTarget(p, 'i')).toEqual({ trackId: 'x', reason: 'armed', extraArmed: ['y'] })
  })

  it('falls back to the focused audio track', () => {
    const p = project(track('i'), track('x', { kind: 'audio' }))
    expect(recordTarget(p, 'x')).toEqual({ trackId: 'x', reason: 'focusedAudio', extraArmed: [] })
  })

  it('refuses a focused instrument track', () => {
    const p = project(track('i', { armed: true }), track('x', { kind: 'audio' }))
    expect(recordTarget(p, 'i')).toEqual({ trackId: null, reason: 'focusedInstrument', extraArmed: [] })
  })

  it('reports none without a usable focus', () => {
    expect(recordTarget(project(track('i')), null)).toEqual({ trackId: null, reason: 'none', extraArmed: [] })
    expect(recordTarget(project(), 'gone')).toEqual({ trackId: null, reason: 'none', extraArmed: [] })
  })
})

describe('monitorTargets', () => {
  it('includes monitoring audio tracks, plus armed ones while recording', () => {
    const p = project(
      track('i', { monitor: true, armed: true }),
      track('a', { kind: 'audio', monitor: true }),
      track('b', { kind: 'audio', armed: true }),
      track('c', { kind: 'audio', monitor: true, enabled: false }),
      track('d', { kind: 'audio' }),
    )
    expect(monitorTargets(p, false)).toEqual(['a'])
    expect(monitorTargets(p, true)).toEqual(['a', 'b'])
  })
})

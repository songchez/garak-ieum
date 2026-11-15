import { describe, expect, it } from 'vitest'
import { createEmptyProject, createTrack } from './project'
import { HeldNotes, KEYBOARD_SOURCE, acceptsMidi, liveMidiTrackIds, midiRecordTrackIds, midiRoutes, parseMidi, routeNoteOn } from './midiInput'
import type { Project, Track } from './types'

const project = (tracks: Track[]): Project => ({ ...createEmptyProject(), tracks })
const inst = (patch: Partial<Track> = {}): Track => ({ ...createTrack('instrument'), ...patch })

describe('parseMidi', () => {
  it('reads channels 1–16, note-on velocity 0 as note-off, controllers and pitch bend', () => {
    expect(parseMidi([0x90, 60, 100])).toEqual({ type: 'noteOn', channel: 1, pitch: 60, velocity: 100 })
    expect(parseMidi([0x9F, 60, 0])).toEqual({ type: 'noteOff', channel: 16, pitch: 60, velocity: 0 })
    expect(parseMidi([0x82, 61, 40])).toEqual({ type: 'noteOff', channel: 3, pitch: 61, velocity: 40 })
    expect(parseMidi([0xB0, 64, 127])).toEqual({ type: 'controller', channel: 1, controller: 64, value: 127 })
    expect(parseMidi([0xE0, 0, 64])).toEqual({ type: 'pitchBend', channel: 1, value: 0 })
    expect(parseMidi([0xF8]).type).toBe('other')
    expect(parseMidi([0x40, 1, 2]).type).toBe('other')
  })
})

describe('track MIDI input', () => {
  it('defaults to every input and channel, filters by device and channel, none hears nothing', () => {
    expect(acceptsMidi({ source: 'all' }, 'dev-a', 5)).toBe(true)
    expect(acceptsMidi({ source: 'all' }, KEYBOARD_SOURCE, 1)).toBe(true)
    expect(acceptsMidi({ source: 'device', deviceId: 'dev-a' }, 'dev-b', 1)).toBe(false)
    expect(acceptsMidi({ source: 'device', deviceId: 'dev-a', channel: 2 }, 'dev-a', 2)).toBe(true)
    expect(acceptsMidi({ source: 'device', deviceId: 'dev-a', channel: 2 }, 'dev-a', 3)).toBe(false)
    expect(acceptsMidi({ source: 'none' }, 'dev-a', 1)).toBe(false)
  })
})

describe('live MIDI targets (monitor / auto-arm rules)', () => {
  it('auto-arms the focused instrument track only while no instrument track is armed', () => {
    const a = inst(), b = inst()
    expect(liveMidiTrackIds(project([a, b]), b.id)).toEqual([b.id])
    const armed = { ...a, armed: true }
    expect(liveMidiTrackIds(project([armed, b]), b.id)).toEqual([armed.id])
  })
  it('I (in) always hears, off never, disabled tracks and input none never', () => {
    const on = inst({ monitor: true, monitorMode: 'in' }), off = inst({ armed: true, monitorMode: 'off' })
    const disabled = inst({ armed: true, enabled: false }), deaf = inst({ armed: true, midiInput: { source: 'none' } })
    expect(liveMidiTrackIds(project([on, off, disabled, deaf]), null)).toEqual([on.id])
  })
  it('never routes audio tracks', () => {
    const audio = { ...createTrack('audio'), armed: true, monitorMode: 'in' as const }
    expect(liveMidiTrackIds(project([audio]), audio.id)).toEqual([])
  })
  it('records every armed instrument track, else the focused one unless an audio track is armed', () => {
    const a = inst({ armed: true }), b = inst({ armed: true }), c = inst()
    expect(midiRecordTrackIds(project([a, b, c]), c.id)).toEqual([a.id, b.id])
    expect(midiRecordTrackIds(project([c]), c.id)).toEqual([c.id])
    const audio = { ...createTrack('audio'), armed: true }
    expect(midiRecordTrackIds(project([audio, c]), c.id)).toEqual([])
  })
})

describe('routing', () => {
  it('applies track transpose, velocity offset and limits like trackNote', () => {
    const track = inst({ transpose: 12, velocityOffset: -10, keyLimit: [0, 80], velocityLimit: [20, 127] })
    const routes = midiRoutes(project([track]), [track.id])
    expect(routeNoteOn(routes, 'x', 1, 60, 100)).toEqual([{ trackId: track.id, pitch: 72, velocity: 90 / 127 }])
    expect(routeNoteOn(routes, 'x', 1, 70, 100)).toEqual([]) // 82 is above the key limit
    expect(routeNoteOn(routes, 'x', 1, 60, 25)).toEqual([]) // 15 is below the velocity limit
  })
  it('sends one input to several tracks and respects each channel filter', () => {
    const a = inst({ midiInput: { source: 'all', channel: 1 } }), b = inst({ midiInput: { source: 'device', deviceId: 'pad' } })
    const routes = midiRoutes(project([a, b]), [a.id, b.id])
    expect(routeNoteOn(routes, 'pad', 1, 60, 64).map(n => n.trackId)).toEqual([a.id, b.id])
    expect(routeNoteOn(routes, 'pad', 2, 60, 64).map(n => n.trackId)).toEqual([b.id])
    expect(routeNoteOn(routes, 'keys', 1, 60, 64).map(n => n.trackId)).toEqual([a.id])
  })
})

describe('HeldNotes', () => {
  it('note-off releases what the note-on started even after the routes changed', () => {
    const held = new HeldNotes()
    held.noteOn('k', 1, 60, [{ trackId: 'a', pitch: 72, velocity: 1 }])
    expect(held.noteOff('k', 1, 60)).toEqual([{ trackId: 'a', pitch: 72, velocity: 1 }])
    expect(held.noteOff('k', 1, 60)).toEqual([])
  })
  it('retain releases notes on tracks that lost their route (track switch), clear releases all', () => {
    const held = new HeldNotes()
    held.noteOn('k', 1, 60, [{ trackId: 'a', pitch: 60, velocity: 1 }, { trackId: 'b', pitch: 60, velocity: 1 }])
    held.noteOn('k', 1, 62, [{ trackId: 'a', pitch: 62, velocity: 1 }])
    expect(held.retain(new Set(['b'])).map(n => n.pitch)).toEqual([60, 62])
    expect(held.size).toBe(1)
    expect(held.clear()).toEqual([{ trackId: 'b', pitch: 60, velocity: 1 }])
  })
  it('a repeated note-on returns the previous voices so they can be released', () => {
    const held = new HeldNotes()
    held.noteOn('k', 1, 60, [{ trackId: 'a', pitch: 60, velocity: 1 }])
    expect(held.noteOn('k', 1, 60, [{ trackId: 'a', pitch: 60, velocity: .5 }])).toHaveLength(1)
    expect(held.releaseSource('k')).toHaveLength(1)
  })
})

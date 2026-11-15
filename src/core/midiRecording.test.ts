import { describe, expect, it } from 'vitest'
import { createEmptyProject, createTrack, validateProject } from './project'
import { MIN_RECORDED_NOTE, MidiTake, commitMidiTake, compensatedBeat, frameToBeat, heardTransportBeat, takeSpan, type MidiTakeResult } from './midiRecording'
import type { MidiClip, Project, Track } from './types'

const on = (pitch: number, beat: number, velocity = 100, source = 'k', channel = 1) => ({ source, data: [0x90 | (channel - 1), pitch, velocity], beat })
const off = (pitch: number, beat: number, source = 'k', channel = 1) => ({ source, data: [0x80 | (channel - 1), pitch, 0], beat })
const inst = (patch: Partial<Track> = {}): Track => ({ ...createTrack('instrument'), ...patch })
const project = (tracks: Track[], patch: Partial<Project> = {}): Project => ({ ...createEmptyProject(), tracks, lengthBeats: 64, ...patch })

describe('timestamp → beat', () => {
  const p = { bpm: 120, loop: { enabled: false, startBeat: 0, endBeat: 0 }, lengthBeats: 64 }
  it('maps the heard context time to transport beats, before the anchor too', () => {
    expect(heardTransportBeat(p, 4, 10, 11)).toBeCloseTo(6)
    expect(heardTransportBeat(p, 4, 10, 9.75)).toBeCloseTo(3.5)
  })
  it('wraps at the cycle end like the scheduler', () => {
    const loop = { ...p, loop: { enabled: true, startBeat: 4, endBeat: 8 } }
    expect(heardTransportBeat(loop, 4, 0, 2.5)).toBeCloseTo(5) // 4 + 5 beats → 9 → wraps to 5
  })
  it('subtracts output latency: a key pressed when the arrangement was heard 40 ms late lands 40 ms earlier', () => {
    expect(compensatedBeat(8, 0.04, 120)).toBeCloseTo(8 - 0.08)
    expect(compensatedBeat(8, -1, 120)).toBe(8)
  })
  it('converts native host frames (already compensated) to beats', () => {
    expect(frameToBeat(48000, 48000, 120)).toBeCloseTo(2)
  })
})

describe('MidiTake', () => {
  const track = inst()
  const takeOf = (cycle: { start: number; end: number } | null = null, startBeat = 0, tracks = [{ trackId: track.id, input: { source: 'all' as const } }]) => new MidiTake({ startBeat, cycle, tracks })

  it('pairs note-ons and note-offs with raw pitch and velocity', () => {
    const take = takeOf()
    take.input(on(60, 1, 127)); take.input(off(60, 2))
    take.input(on(64, 2.5, 64)); take.input(off(64, 3))
    const result = take.finish(4)
    expect(result.tracks[0].notes).toEqual([{ pitch: 60, start: 1, end: 2, velocity: 1 }, { pitch: 64, start: 2.5, end: 3, velocity: 64 / 127 }])
  })
  it('ignores messages without a transport beat and closes held notes at stop', () => {
    const take = takeOf()
    take.input({ ...on(60, 0), beat: null })
    take.input(on(62, 1))
    expect(take.finish(3).tracks[0].notes).toEqual([{ pitch: 62, start: 1, end: 3, velocity: 100 / 127 }])
  })
  it('gives an instant note-off the minimum length and pulls a pre-start note to the first beat', () => {
    const take = takeOf(null, 4)
    take.input(on(60, 3.9)); take.input(off(60, 3.95))
    expect(take.finish(8).tracks[0].notes[0]).toMatchObject({ start: 4, end: 4 + MIN_RECORDED_NOTE })
  })
  it('a note held through the count-in starts on the record start', () => {
    const take = takeOf(null, 8)
    take.holdAtStart('k', 1, 67, 90)
    take.input(off(67, 9))
    expect(take.finish(12).tracks[0].notes).toEqual([{ pitch: 67, start: 8, end: 9, velocity: 90 / 127 }])
  })
  it('cycle recording merges passes and ends notes held across the wrap at the cycle end', () => {
    const take = takeOf({ start: 0, end: 4 })
    take.input(on(60, 0.5)); take.input(off(60, 1))
    take.input(on(62, 3.5))
    take.tick(0.1) // wrapped
    take.input(off(62, 0.2)) // its note was closed at the wrap
    take.input(on(64, 2)); take.input(off(64, 2.5))
    const notes = take.finish(3).tracks[0].notes
    expect(notes).toEqual([
      { pitch: 60, start: 0.5, end: 1, velocity: 100 / 127 },
      { pitch: 64, start: 2, end: 2.5, velocity: 100 / 127 },
      { pitch: 62, start: 3.5, end: 4, velocity: 100 / 127 },
    ])
  })
  it('records several tracks at once, each through its own input filter', () => {
    const a = inst(), b = inst()
    const take = new MidiTake({ startBeat: 0, cycle: null, tracks: [{ trackId: a.id, input: { source: 'all', channel: 1 } }, { trackId: b.id, input: { source: 'device', deviceId: 'pad' } }] })
    take.input(on(60, 1, 100, 'keys', 1)); take.input(off(60, 2, 'keys', 1))
    take.input(on(36, 1, 100, 'pad', 10)); take.input(off(36, 1.5, 'pad', 10))
    const result = take.finish(4)
    expect(result.tracks[0].notes.map(n => n.pitch)).toEqual([60])
    expect(result.tracks[1].notes.map(n => n.pitch)).toEqual([36])
  })
  it('keeps raw controller events (CC64) for the sustain work without turning them into notes', () => {
    const take = takeOf()
    take.input({ source: 'k', data: [0xB0, 64, 127], beat: 1 })
    take.input({ source: 'k', data: [0xB0, 64, 0], beat: 2 })
    const result = take.finish(4).tracks[0]
    expect(result.notes).toEqual([])
    expect(result.controllers).toEqual([{ beat: 1, channel: 1, controller: 64, value: 127 }, { beat: 2, channel: 1, controller: 64, value: 0 }])
  })
  it('previews held notes up to now', () => {
    const take = takeOf()
    take.input(on(60, 1))
    expect(take.preview(2.5).get(track.id)).toEqual([{ pitch: 60, start: 1, end: 2.5, velocity: 100 / 127 }])
  })
})

describe('takeSpan', () => {
  it('rounds to whole bars around the recorded time, at least one bar; a cycle uses the cycle', () => {
    expect(takeSpan({ startBeat: 5, endBeat: 9.5, cycle: null }, [], 4)).toEqual({ start: 4, end: 12 })
    expect(takeSpan({ startBeat: 8, endBeat: 8, cycle: null }, [], 4)).toEqual({ start: 8, end: 12 })
    expect(takeSpan({ startBeat: 8, endBeat: 9, cycle: { start: 4, end: 12 } }, [], 4)).toEqual({ start: 4, end: 12 })
  })
})

describe('commitMidiTake', () => {
  const result = (trackId: string, notes: MidiTakeResult['tracks'][0]['notes'], startBeat = 4, endBeat = 8): MidiTakeResult => ({ startBeat, endBeat, cycle: null, tracks: [{ trackId, notes, controllers: [] }] })
  const existing = (startBeat: number, lengthBeats: number, notes: { pitch: number; start: number }[]): MidiClip => ({ id: `c${startBeat}`, kind: 'midi', name: 'old', startBeat, lengthBeats, gain: 1, notes: notes.map((n, i) => ({ id: `n${startBeat}-${i}`, pitch: n.pitch, start: n.start, duration: 0.5, velocity: 0.8 })) })

  it('creates one region in source coordinates and the result validates', () => {
    const track = inst()
    const committed = commitMidiTake(project([track]), result(track.id, [{ pitch: 60, start: 5, end: 6, velocity: 1 }]), { mode: 'merge', beatsPerBar: 4, name: 'MIDI' })
    const clip = committed.project.tracks[0].clips[0] as MidiClip
    expect(committed.clipIds).toEqual([clip.id])
    expect(clip).toMatchObject({ kind: 'midi', startBeat: 4, lengthBeats: 4 })
    expect(clip.notes).toMatchObject([{ pitch: 60, start: 1, duration: 1, velocity: 1 }])
    expect(() => validateProject(committed.project)).not.toThrow()
  })
  it('adds nothing for empty takes (and returns the same project)', () => {
    const track = inst()
    const before = project([track])
    expect(commitMidiTake(before, result(track.id, []), { mode: 'merge', beatsPerBar: 4, name: 'MIDI' })).toEqual({ project: before, clipIds: [] })
  })
  it('합치기 joins overlapping regions with the new notes', () => {
    const track = inst({ clips: [existing(0, 8, [{ pitch: 48, start: 0 }, { pitch: 50, start: 6 }])] })
    const committed = commitMidiTake(project([track]), result(track.id, [{ pitch: 60, start: 5, end: 6, velocity: 1 }]), { mode: 'merge', beatsPerBar: 4, name: 'MIDI' })
    const clips = committed.project.tracks[0].clips as MidiClip[]
    expect(clips).toHaveLength(1)
    expect(clips[0]).toMatchObject({ startBeat: 0, lengthBeats: 8 })
    expect(clips[0].notes.map(n => [n.pitch, n.start]).sort((a, b) => a[1] - b[1])).toEqual([[48, 0], [60, 5], [50, 6]])
  })
  it('대체 cuts away what the recording covers and keeps the rest', () => {
    const track = inst({ clips: [existing(0, 12, [{ pitch: 48, start: 1 }, { pitch: 50, start: 5 }, { pitch: 52, start: 9 }])] })
    const committed = commitMidiTake(project([track]), result(track.id, [{ pitch: 60, start: 5, end: 6, velocity: 1 }]), { mode: 'replace', beatsPerBar: 4, name: 'MIDI' })
    const clips = [...committed.project.tracks[0].clips as MidiClip[]].sort((a, b) => a.startBeat - b.startBeat)
    expect(clips.map(c => [c.startBeat, c.lengthBeats])).toEqual([[0, 4], [4, 4], [8, 4]])
    expect(clips[1].notes.map(n => n.pitch)).toEqual([60])
    expect(() => validateProject(committed.project)).not.toThrow()
  })
  it('writes every armed track of a take in one project (one undo step for the caller)', () => {
    const a = inst(), b = inst()
    const take: MidiTakeResult = { startBeat: 0, endBeat: 4, cycle: null, tracks: [
      { trackId: a.id, notes: [{ pitch: 60, start: 0, end: 1, velocity: 1 }], controllers: [] },
      { trackId: b.id, notes: [{ pitch: 36, start: 1, end: 2, velocity: 1 }], controllers: [] },
    ] }
    const committed = commitMidiTake(project([a, b]), take, { mode: 'merge', beatsPerBar: 4, name: 'MIDI' })
    expect(committed.clipIds).toHaveLength(2)
    expect(committed.project.tracks.map(t => t.clips.length)).toEqual([1, 1])
  })
})

describe('project validation', () => {
  it('keeps a track MIDI input and region Q-강도, and rejects bad values', () => {
    const track = inst({ midiInput: { source: 'device', deviceId: 'id-1', deviceName: 'Keys', channel: 3 }, clips: [{ ...existing(0, 4), qStrength: 60, quantize: 0.25 }] })
    function existing(startBeat: number, lengthBeats: number): MidiClip { return { id: 'c', kind: 'midi', name: 'x', startBeat, lengthBeats, gain: 1, notes: [] } }
    const parsed = validateProject(JSON.parse(JSON.stringify(project([track]))))
    expect(parsed.tracks[0].midiInput).toEqual({ source: 'device', deviceId: 'id-1', deviceName: 'Keys', channel: 3 })
    expect((parsed.tracks[0].clips[0] as MidiClip).qStrength).toBe(60)
    expect(() => validateProject(JSON.parse(JSON.stringify(project([{ ...track, midiInput: { source: 'all', channel: 17 } }]))))).toThrow()
    expect(() => validateProject(JSON.parse(JSON.stringify(project([{ ...createTrack('audio'), midiInput: { source: 'all' } }]))))).toThrow()
  })
})

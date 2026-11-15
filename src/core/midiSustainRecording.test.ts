import { describe, expect, it } from 'vitest'
import { createEmptyProject, createTrack, validateProject } from './project'
import { MidiTake, commitMidiTake, type MidiTakeResult } from './midiRecording'
import { capturePerformance, type CaptureEvent } from './midiCapture'
import type { MidiClip, Project, Track } from './types'

const inst = (patch: Partial<Track> = {}): Track => ({ ...createTrack('instrument'), ...patch })
const project = (tracks: Track[]): Project => ({ ...createEmptyProject(), tracks, lengthBeats: 64 })
const cc = (value: number, beat: number, source = 'k') => ({ source, data: [0xB0, 64, value], beat })

describe('sustain pedal recording (CC64 → MidiClip.sustain)', () => {
  const track = inst()
  const takeOf = (cycle: { start: number; end: number } | null = null, startBeat = 0) => new MidiTake({ startBeat, cycle, tracks: [{ trackId: track.id, input: { source: 'all' } }] })

  it('turns pedal down/up into spans, closes a held pedal at stop, and a count-in pedal starts on the first beat', () => {
    const take = takeOf(null, 4)
    take.pedalAtStart('k', 1)
    take.input(cc(0, 5)); take.input(cc(127, 6)); take.input(cc(100, 6.5)); take.input(cc(0, 7))
    take.input(cc(127, 7.5))
    expect(take.finish(8).tracks[0].sustain).toEqual([[4, 5], [6, 7], [7.5, 8]])
  })
  it('cycle passes unite their pedal; a pedal held across the wrap continues from the cycle start', () => {
    const take = takeOf({ start: 0, end: 4 })
    take.input(cc(127, 1)); take.input(cc(0, 2))
    take.input(cc(127, 3.5))
    take.tick(0.05)
    take.input(cc(0, 0.5))
    take.input(cc(127, 1.5)); take.input(cc(0, 2.5))
    const committed = commitMidiTake(project([track]), take.finish(3), { mode: 'merge', beatsPerBar: 4, name: 'MIDI' })
    const clip = committed.project.tracks[0].clips[0] as MidiClip
    expect(clip.sustain).toEqual([{ beat: 0, value: 127 }, { beat: 0.5, value: 0 }, { beat: 1, value: 127 }, { beat: 2.5, value: 0 }, { beat: 3.5, value: 127 }, { beat: 4, value: 0 }])
    expect(() => validateProject(committed.project)).not.toThrow()
  })
  it('writes region-relative sustain; 합치기 keeps the existing pedal, 대체 replaces it in the recorded range', () => {
    const old: MidiClip = { id: 'old', kind: 'midi', name: 'old', startBeat: 0, lengthBeats: 12, gain: 1, notes: [{ id: 'n', pitch: 48, start: 0, duration: 1, velocity: 0.8 }], sustain: [{ beat: 0, value: 127 }, { beat: 1, value: 0 }, { beat: 5, value: 127 }, { beat: 6, value: 0 }] }
    const result: MidiTakeResult = { startBeat: 4, endBeat: 8, cycle: null, tracks: [{ trackId: track.id, notes: [{ pitch: 60, start: 4.5, end: 5, velocity: 1 }], controllers: [], sustain: [[6.5, 7]] }] }
    const merged = commitMidiTake(project([{ ...track, clips: [old] }]), result, { mode: 'merge', beatsPerBar: 4, name: 'MIDI' })
    const joined = merged.project.tracks[0].clips[0] as MidiClip
    expect(joined.sustain).toEqual([{ beat: 0, value: 127 }, { beat: 1, value: 0 }, { beat: 5, value: 127 }, { beat: 6, value: 0 }, { beat: 6.5, value: 127 }, { beat: 7, value: 0 }])
    const replaced = commitMidiTake(project([{ ...track, clips: [old] }]), result, { mode: 'replace', beatsPerBar: 4, name: 'MIDI' })
    const middle = (replaced.project.tracks[0].clips as MidiClip[]).find(clip => clip.startBeat === 4)!
    expect(middle.sustain).toEqual([{ beat: 2.5, value: 127 }, { beat: 3, value: 0 }])
    expect(() => validateProject(replaced.project)).not.toThrow()
  })
})

describe('capture with the sustain pedal', () => {
  const ev = (type: 'on' | 'off', pitch: number, time: number): CaptureEvent => ({ source: 'k', data: type === 'on' ? [0x90, pitch, 100] : [0x80, pitch, 0], time, beat: null })
  it('keeps CC64 spans inside the captured phrase', () => {
    const pedal = (value: number, time: number): CaptureEvent => ({ source: 'k', data: [0xB0, 64, value], time, beat: null })
    const events = [pedal(127, 900), ev('on', 60, 1000), ev('off', 60, 1500), pedal(0, 1750), ev('on', 62, 2000), ev('off', 62, 2500)]
    expect(capturePerformance(events, { bpm: 120, playheadBeat: 0 })!.sustain).toEqual([[0, 1.5]])
  })
})

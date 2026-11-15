import { describe, expect, it } from 'vitest'
import { applyVisibleSustain, bakeSustain, joinSustain, normalizeSustain, spansToSustain, sustainSpans, sustainValueAt, sustainedEnds, visibleSustain } from './sustain'
import { clipOccurrences, midiEvents, playbackNotes, playbackSustain } from './playback'
import { createEmptyProject, createTrack, duplicateClip, joinClips, splitClip, transposeClip, trimClipStart, validateProject } from './project'
import { parseMidiFile } from './midiImport'
import { writeMidiFile } from './midiExport'
import { compileNativeTimeline, planNativeSeek } from '../audio/native/timeline'
import type { MidiClip, MidiNote, Project, Track } from './types'

let sequence = 0
const note = (start: number, duration: number, pitch = 60, velocity = 100 / 127): MidiNote => ({ id: `n${sequence++}`, pitch, start, duration, velocity })
const clip = (patch: Partial<MidiClip> = {}): MidiClip => ({ id: `c${sequence++}`, kind: 'midi', name: 'clip', startBeat: 0, lengthBeats: 8, gain: 1, notes: [], ...patch })
const keys = (clips: MidiClip[], patch: Partial<Track> = {}): Track => ({ ...createTrack('instrument', 'keys'), id: `t${sequence++}`, clips, ...patch })
const project = (tracks: Track[], lengthBeats = 16): Project => ({ ...createEmptyProject(), id: 'p', bpm: 120, sampleRate: 48000, lengthBeats, loop: { enabled: false, startBeat: 0, endBeat: lengthBeats }, tracks })
const pedal = (...pairs: [number, number][]) => pairs.map(([beat, value]) => ({ beat, value }))

describe('sustain pedal model (CC64)', () => {
  it('normalizes, reads values right-continuously and builds down spans', () => {
    expect(normalizeSustain(pedal([2, 0], [1, 127.4], [1, 100], [-1, 0]))).toEqual(pedal([0, 0], [1, 100], [2, 0]))
    const events = pedal([1, 127], [3, 0], [4, 64], [5, 63])
    expect(sustainValueAt(events, .999)).toBe(0)
    expect(sustainValueAt(events, 1)).toBe(127)
    expect(sustainValueAt(events, 3)).toBe(0)
    expect(sustainSpans(events)).toEqual([[1, 3], [4, 5]])
    expect(sustainSpans(events, 2, 4.5)).toEqual([[2, 3], [4, 4.5]])
    expect(spansToSustain([[4, 5], [1, 2], [1.5, 3]])).toEqual(pedal([1, 127], [3, 0], [4, 127], [5, 0]))
  })

  it('defers note-offs to the pedal-up, never shortens, and cuts a sustained tail on re-strike', () => {
    const spans: [number, number][] = [[1, 4]]
    const notes = [
      { pitch: 60, start: 0, end: .5 },  // released before the pedal: unchanged
      { pitch: 62, start: 0, end: 2 },   // released under the pedal: rings to 4
      { pitch: 64, start: 0, end: 1 },   // note-off exactly at pedal-down: caught
      { pitch: 65, start: 3, end: 4 },   // note-off exactly at pedal-up: not extended
      { pitch: 67, start: 2, end: 5 },   // still held at pedal-up: unchanged
      { pitch: 62, start: 3, end: 3.5 }, // re-strike of 62 at 3 ends the first 62 there, then rings to 4 itself
    ]
    expect(sustainedEnds(notes, spans)).toEqual([.5, 3, 4, 4, 5, 4])
    expect(sustainedEnds(notes, spans, 3.25)).toEqual([.5, 3, 3.25, 4, 5, 3.5])
    expect(sustainedEnds(notes, [])).toEqual(notes.map(n => n.end))
  })

  it('bakes the pedal into note lengths and removes the controller lane', () => {
    const source = clip({ notes: [note(0, 1), note(2, 1, 64), note(5, 1)], sustain: pedal([.5, 127], [4, 0]) })
    const baked = bakeSustain(source)
    expect(baked.sustain).toBeUndefined()
    expect(baked.notes.map(n => n.duration)).toEqual([4, 2, 1])
    expect(baked.notes[2]).toBe(source.notes[2])
    const empty = clip()
    expect(bakeSustain(empty)).toBe(empty)
  })

  it('chases the pedal at a trimmed left edge and edits only the visible window', () => {
    const source = clip({ lengthBeats: 4, sourceOffsetBeats: 2, sustain: pedal([1, 127], [3, 0], [5, 127], [7, 0]) })
    expect(visibleSustain(source)).toEqual(pedal([0, 127], [1, 0], [3, 127]))
    expect(sustainSpans(visibleSustain(source), 0, source.lengthBeats)).toEqual([[0, 1], [3, 4]])
    // Erase everything visible: hidden events before 2 and after 6 survive, state at the edges is restored.
    const erased = applyVisibleSustain(source, [])
    expect(erased.sustain).toEqual(pedal([1, 127], [2, 0], [6, 127], [7, 0]))
    expect(sustainSpans(visibleSustain(erased), 0, 4)).toEqual([])
    // Drawing the same spans back is identity.
    expect(applyVisibleSustain(source, spansToSustain([[0, 1], [3, 4]]))).toBe(source)
  })

  it('survives split, trim, duplicate, join and transpose', () => {
    const source = clip({ notes: [note(0, 1), note(4, 1)], sustain: pedal([0, 127], [2, 0], [4, 127], [6, 0]) })
    const [left, right] = splitClip(source, 3, 120) as MidiClip[]
    expect(sustainSpans(visibleSustain(left), 0, left.lengthBeats)).toEqual([[0, 2]])
    expect(sustainSpans(visibleSustain(right), 0, right.lengthBeats)).toEqual([[1, 3]])
    expect((duplicateClip(source) as MidiClip).sustain).toEqual(source.sustain)
    expect(transposeClip(source, 5).sustain).toBe(source.sustain)
    // Extending the left edge before the source rebases notes and pedal together.
    const extended = trimClipStart({ ...source, startBeat: 4 }, 2, 120) as MidiClip
    expect(extended.notes[0].start).toBe(2)
    expect(sustainSpans(visibleSustain(extended), 0, extended.lengthBeats)).toEqual([[2, 4], [6, 8]])
    const joined = joinClips([left, right], 120) as MidiClip
    expect(sustainSpans(joined.sustain)).toEqual([[0, 2], [4, 6]])
    expect(joinSustain([left, right], 0)).toEqual(joined.sustain)
  })

  it('validates schema 13 data and keeps older projects valid without a pedal', () => {
    const p = project([keys([clip({ notes: [note(0, 1)], sustain: pedal([0, 127], [1, 0]) })])])
    const roundTrip = validateProject(JSON.parse(JSON.stringify(p)))
    expect(roundTrip.schemaVersion).toBe(13)
    expect((roundTrip.tracks[0].clips[0] as MidiClip).sustain).toEqual(pedal([0, 127], [1, 0]))
    const old = JSON.parse(JSON.stringify(project([keys([clip({ notes: [note(0, 1)] })])])))
    old.schemaVersion = 12
    const migrated = validateProject(old)
    expect(migrated.schemaVersion).toBe(13)
    expect((migrated.tracks[0].clips[0] as MidiClip).sustain).toBeUndefined()
    expect(() => validateProject({ ...JSON.parse(JSON.stringify(p)), schemaVersion: 12 })).toThrow(/schema version 13/)
    const unsorted = JSON.parse(JSON.stringify(p)); unsorted.tracks[0].clips[0].sustain = pedal([1, 0], [0, 127])
    expect(() => validateProject(unsorted)).toThrow(/after the previous sustain event/)
    const range = JSON.parse(JSON.stringify(p)); range.tracks[0].clips[0].sustain = pedal([0, 128])
    expect(() => validateProject(range)).toThrow()
  })
})

describe('sustain pedal playback', () => {
  it('extends playback notes through the pedal and releases it at each loop wrap', () => {
    const looping = clip({ lengthBeats: 4, loop: true, loopLengthBeats: 8, notes: [note(0, .5), note(3, .5, 62)], sustain: pedal([0, 127], [2, 0], [3, 127]) })
    const track = keys([looping])
    const notes = midiEvents(track, 16).map(n => [n.pitch, n.start, n.end])
    // Pedal down at 3 is still down at the region end (4): the tail stops at the wrap, then the pedal is chased again.
    expect(notes).toEqual([[60, 0, 2], [62, 3, 4], [60, 4, 6], [62, 7, 8]])
    const raw = playbackNotes(track, looping, clipOccurrences(track, looping, 16)[0], false).map(n => n.end)
    expect(raw).toEqual([.5, 3.5])
    expect(playbackSustain(track, looping, clipOccurrences(track, looping, 16)[1])).toEqual(pedal([4, 127], [6, 0], [7, 127], [8, 0]))
  })

  it('applies delay to pedal events and ignores transpose / key limits for the pedal itself', () => {
    const source = clip({ notes: [note(0, 1, 60)], sustain: pedal([0, 127], [2, 0]) })
    const track = keys([source], { delayTicks: 480, transpose: 12 })
    const [played] = midiEvents(track, 16)
    expect([played.pitch, played.start, played.end]).toEqual([72, .5, 2.5])
    expect(playbackSustain(track, source, clipOccurrences(track, source, 16)[0])).toEqual(pedal([.5, 127], [2.5, 0]))
  })

  it('compiles extended note-offs for built-in instruments and raw notes + CC64 for VST3', () => {
    const source = clip({ notes: [note(0, 1), note(1, 1, 64)], sustain: pedal([.5, 127], [3, 0]) })
    const builtin = keys([source], { id: 'keys' })
    const vst = keys([{ ...source, id: 'vst-clip' }], { id: 'vst', pluginInstrument: { id: 'synth', path: 'C:/x.vst3', classId: '0'.repeat(32), name: 'Synth', vendor: 'v', enabled: true, parameters: {} } as unknown as Track['pluginInstrument'] })
    const timeline = compileNativeTimeline(project([builtin, vst]))
    const frames = 24000 // 120 BPM at 48 kHz
    expect(timeline.tracks[0].notes.map(n => [n.onFrame, n.offFrame])).toEqual([[0, 3 * frames], [frames, 3 * frames]])
    expect(timeline.tracks[0].controls).toEqual([])
    expect(timeline.tracks[1].notes.map(n => [n.onFrame, n.offFrame])).toEqual([[0, frames], [frames, 2 * frames]])
    expect(timeline.tracks[1].controls).toEqual([{ frame: frames / 2, controller: 64, value: 127 }, { frame: 3 * frames, controller: 64, value: 0 }])
    // Seeking into the pedal span chases built-in notes that only ring because of the pedal.
    const plan = planNativeSeek(timeline, 2.5 * frames)
    expect(plan.tracks[0].chasedNotes.map(n => n.pitch)).toEqual([60, 64])
  })
})

describe('MIDI file sustain import / export', () => {
  const ascii = (value: string) => Array.from(value, c => c.charCodeAt(0))
  const u32 = (v: number) => [v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255]
  const smf = (events: number[]) => new Uint8Array([...ascii('MThd'), ...u32(6), 0, 0, 0, 1, 1, 0xe0, ...ascii('MTrk'), ...u32(events.length + 4), ...events, 0, 0xff, 0x2f, 0])
  // PPQ 480: pedal down at 0, note 0..1 beat, pedal up at 2 beats, a redundant pedal-down repeat.
  const file = smf([0, 0xb0, 64, 127, 0, 0x90, 60, 100, 0x83, 0x60, 0x80, 60, 0, 0, 0xb0, 64, 120, 0x83, 0x60, 0xb0, 64, 0])

  it('keeps CC64 as controller events by default and bakes it only on request', () => {
    const kept = parseMidiFile(file)
    expect(kept.tracks[0].notes).toEqual([{ pitch: 60, start: 0, duration: 1, velocity: 100 / 127 }])
    expect(kept.tracks[0].sustain).toEqual(pedal([0, 127], [2, 0]))
    const baked = parseMidiFile(file, { sustainToLength: true })
    expect(baked.tracks[0].notes[0].duration).toBe(2)
    expect(baked.tracks[0].sustain).toBeUndefined()
  })

  it('round-trips notes and pedal through export and import', () => {
    const source = clip({ lengthBeats: 4, notes: [note(0, 1), note(1.5, .25, 67, 64 / 127)], sustain: pedal([0, 127], [2, 0], [2.5, 127], [3, 0]) })
    const p = project([keys([source], { name: 'Piano' })])
    const imported = parseMidiFile(writeMidiFile(p))
    expect(imported.bpm).toBe(120)
    expect(imported.tracks).toHaveLength(1)
    expect(imported.tracks[0].name).toBe('Piano')
    expect(imported.tracks[0].notes).toEqual([{ pitch: 60, start: 0, duration: 1, velocity: 100 / 127 }, { pitch: 67, start: 1.5, duration: .25, velocity: 64 / 127 }])
    expect(imported.tracks[0].sustain).toEqual(source.sustain)
    // The exported pedal sounds exactly like the source when played back after import.
    const reimported = keys([clip({ lengthBeats: 4, notes: imported.tracks[0].notes.map(n => ({ ...n, id: `r${sequence++}` })), sustain: imported.tracks[0].sustain })])
    expect(midiEvents(reimported, 16).map(n => n.end)).toEqual(midiEvents(p.tracks[0], 16).map(n => n.end))
  })

  it('releases a pedal still down at a region end in the exported file', () => {
    const p = project([keys([clip({ lengthBeats: 2, notes: [note(0, 1)], sustain: pedal([0, 127]) })])])
    expect(parseMidiFile(writeMidiFile(p)).tracks[0].sustain).toEqual(pedal([0, 127], [2, 0]))
  })
})

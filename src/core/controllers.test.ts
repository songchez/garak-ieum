import { describe, expect, it } from 'vitest'
import {
  applyVisibleController, controllerSpec, controllerValueAt, isControllerKey, joinControllers, keyOfNumber, lineController, normalizeController,
  occurrenceControllers, thinController, visibleController,
} from './controllers'
import { clipOccurrences, midiControllerEvents, playbackControllers } from './playback'
import { createEmptyProject, createTrack, joinClips, splitClip, trimClipStart, validateProject, withInstrument } from './project'
import { parseMidiFile } from './midiImport'
import { writeMidiFile } from './midiExport'
import { MidiTake, commitMidiTake, recordedControllers } from './midiRecording'
import { capturePerformance } from './midiCapture'
import { compileNativeTimeline } from '../audio/native/timeline'
import { WebLiveMidi } from '../audio/liveMidi'
import type { ControllerPoint, MidiClip, Project, Track } from './types'

let sequence = 0
const clip = (patch: Partial<MidiClip> = {}): MidiClip => ({ id: `c${sequence++}`, kind: 'midi', name: 'clip', startBeat: 0, lengthBeats: 8, gain: 1, notes: [], ...patch })
const keys = (clips: MidiClip[], patch: Partial<Track> = {}): Track => ({ ...createTrack('instrument', 'keys'), id: `t${sequence++}`, clips, ...patch })
const project = (tracks: Track[], lengthBeats = 16): Project => ({ ...createEmptyProject(), id: 'p', bpm: 120, sampleRate: 48000, lengthBeats, loop: { enabled: false, startBeat: 0, endBeat: lengthBeats }, tracks })
const pts = (...pairs: [number, number][]): ControllerPoint[] => pairs.map(([beat, value]) => ({ beat, value }))
const note = (start: number, duration = 1, pitch = 60) => ({ id: `n${sequence++}`, pitch, start, duration, velocity: 100 / 127 })

describe('controller lanes model', () => {
  it('knows keys, wire numbers, defaults and reset policy', () => {
    expect(['cc0', 'cc1', 'cc127', 'pitchBend', 'aftertouch', 'program'].every(isControllerKey)).toBe(true)
    expect(['cc64', 'cc128', 'cc01', 'pitch', 7].some(isControllerKey)).toBe(false)
    expect([keyOfNumber(1), keyOfNumber(64), keyOfNumber(128), keyOfNumber(129), keyOfNumber(130)]).toEqual(['cc1', null, 'aftertouch', 'pitchBend', 'program'])
    expect(controllerSpec('pitchBend')).toMatchObject({ min: -8192, max: 8191, default: 0, reset: true })
    expect(controllerSpec('cc11')).toMatchObject({ default: 127, reset: true })
    expect(controllerSpec('cc7')).toMatchObject({ default: 100, reset: false })
    expect(normalizeController('pitchBend', pts([2, 9000], [1, 10.4], [1, -9000]))).toEqual(pts([1, -8192], [2, 8191]))
    expect(controllerValueAt(pts([1, 5], [2, 9]), .5)).toBeUndefined()
    expect(controllerValueAt(pts([1, 5], [2, 9]), 2)).toBe(9)
  })

  it('chases at the visible left edge and keeps hidden source on window edits (like the pedal)', () => {
    const c = clip({ sourceOffsetBeats: 2, lengthBeats: 4, controllers: { pitchBend: pts([1, 4000], [3, 0], [5, -2000], [7, 100]), cc7: pts([0, 80]) } })
    expect(visibleController(c, 'pitchBend')).toEqual(pts([0, 4000], [1, 0], [3, -2000]))
    expect(visibleController(c, 'cc7')).toEqual(pts([0, 80]))
    // A reset lane at its default at the edge needs no chase.
    expect(visibleController({ ...c, sourceOffsetBeats: 3.5 }, 'pitchBend')).toEqual(pts([1.5, -2000], [3.5, 100]))
    // Replacing the window keeps the hidden part before and after; the right edge restores the original value.
    const edited = applyVisibleController(c, 'pitchBend', pts([0, 0], [2, 8191]))
    expect(edited.controllers?.pitchBend).toEqual(pts([1, 4000], [2, 0], [4, 8191], [6, -2000], [7, 100]))
    expect(applyVisibleController(c, 'pitchBend', visibleController(c, 'pitchBend'))).toBe(c)
    // Clearing every lane removes the map.
    const cleared = applyVisibleController(applyVisibleController(clip({ controllers: { cc1: pts([1, 40]) } }), 'cc1', []), 'cc1', [])
    expect(cleared.controllers).toBeUndefined()
  })

  it('resets reset lanes at the occurrence end and every loop wrap; hold lanes keep their value', () => {
    const c = clip({ lengthBeats: 4, loop: true, controllers: { pitchBend: pts([1, 4096]), cc7: pts([0, 90]), cc1: pts([2, 64]) } })
    expect(occurrenceControllers(c, 4)).toEqual([
      { beat: 0, key: 'cc7', value: 90 }, { beat: 1, key: 'pitchBend', value: 4096 }, { beat: 2, key: 'cc1', value: 64 },
      { beat: 4, key: 'pitchBend', value: 0 }, { beat: 4, key: 'cc1', value: 0 },
    ])
    const track = keys([c])
    const events = midiControllerEvents(track, 8)
    expect(events.filter(event => event.key === 'pitchBend').map(event => [event.beat, event.value, event.range, !!event.reset])).toEqual([[1, 4096, 2, false], [4, 0, 2, true], [5, 4096, 2, false], [8, 0, 2, true]])
    // Delay moves the whole lane, including the reset.
    const delayed = playbackControllers({ ...track, delayTicks: 480 }, c, clipOccurrences(track, c, 8)[0])
    expect(delayed.find(event => event.key === 'pitchBend' && event.reset)?.beat).toBe(4.5)
  })

  it('travels with trims, splits and joins; joined regions keep each source audible lanes', () => {
    const c = clip({ lengthBeats: 4, controllers: { cc11: pts([1, 40], [3, 90]) } })
    const extended = trimClipStart(c, -1 as number, 120) as MidiClip
    expect(extended.controllers?.cc11).toEqual(c.controllers?.cc11)
    const before = trimClipStart({ ...c, startBeat: 2 }, 1, 120) as MidiClip
    expect(before.controllers?.cc11).toEqual(pts([2, 40], [4, 90]))
    const [left, right] = splitClip(c, 2, 120) as MidiClip[]
    expect(visibleController(right, 'cc11')).toEqual(pts([0, 40], [1, 90]))
    const joined = joinClips([left, right], 120) as MidiClip
    // The left source's reset at 2 and the right source's chase at 2 collapse (last value wins, repeats dropped).
    expect(visibleController(joined, 'cc11')).toEqual(pts([1, 40], [3, 90]))
    // A gap between the sources resets a reset lane at the first source's end.
    const a = clip({ lengthBeats: 2, controllers: { pitchBend: pts([1, 500]) } }), b = clip({ startBeat: 4, lengthBeats: 2, controllers: { pitchBend: pts([0, -500]) } })
    expect(joinControllers([a, b], 0)?.pitchBend).toEqual(pts([1, 500], [2, 0], [4, -500], [6, 0]))
  })

  it('thins dense streams (Logic-like) but keeps the final value and returns to center', () => {
    const dense = Array.from({ length: 500 }, (_, index) => ({ beat: index / 500, value: Math.round(Math.sin(index / 500 * Math.PI) * 4000) }))
    dense.push({ beat: 1, value: 0 })
    const thinned = thinController('pitchBend', dense)
    expect(thinned.length).toBeLessThan(140)
    expect(thinned[thinned.length - 1]).toEqual({ beat: 1, value: 0 })
    for (let index = 1; index < thinned.length; index++) expect(thinned[index].beat).toBeGreaterThan(thinned[index - 1].beat)
    // Every original value is within the tolerance (or a jump) of the thinned step curve.
    const errors = dense.map(point => Math.abs((controllerValueAt(thinned, point.beat) ?? 0) - point.value))
    expect(Math.max(...errors)).toBeLessThanOrEqual(32 * 4)
    expect(thinController('cc1', pts([0, 1], [.001, 1], [.002, 1], [.5, 2]))).toEqual(pts([0, 1], [.5, 2]))
    const line = lineController('cc11', { beat: 0, value: 0 }, { beat: 1, value: 127 }, 1 / 64)
    expect(line[0]).toEqual({ beat: 0, value: 0 })
    expect(line[line.length - 1]).toEqual({ beat: 1, value: 127 })
  })
})

describe('controller lanes persistence (schema 16)', () => {
  it('round-trips and rejects controller data in older schemas or invalid lanes', () => {
    const p = project([keys([clip({ bendRange: 12, controllers: { pitchBend: pts([0, -8192], [1, 8191]), cc74: pts([2, 3]) } })])])
    const loaded = validateProject(JSON.parse(JSON.stringify(p)))
    expect(loaded.schemaVersion).toBe(19)
    expect(loaded.tracks[0].clips[0]).toMatchObject({ bendRange: 12, controllers: { pitchBend: pts([0, -8192], [1, 8191]), cc74: pts([2, 3]) } })
    expect(() => validateProject({ ...JSON.parse(JSON.stringify(p)), schemaVersion: 13 })).toThrow(/schema version 16/)
    expect(() => validateProject({ ...JSON.parse(JSON.stringify(p)), schemaVersion: 15 })).toThrow(/schema version 16/)
    const bad = (controllers: unknown) => () => validateProject(JSON.parse(JSON.stringify({ ...p, tracks: [{ ...p.tracks[0], clips: [{ ...p.tracks[0].clips[0], controllers }] }] })))
    expect(bad({ cc64: pts([0, 127]) })).toThrow(/unknown controller/)
    expect(bad({ pitchBend: pts([0, 9000]) })).toThrow()
    expect(bad({ cc1: pts([1, 1], [1, 2]) })).toThrow(/after the previous/)
    // A schema 13 project (with a pedal) migrates unchanged.
    const old = { ...JSON.parse(JSON.stringify(project([keys([clip({ sustain: pts([0, 127]) })])]))), schemaVersion: 13 }
    expect(validateProject(old).tracks[0].clips[0]).toMatchObject({ sustain: pts([0, 127]) })
  })
})

describe('controller recording and capture', () => {
  const track = keys([])
  const takeOf = (cycle: { start: number; end: number } | null = null) => new MidiTake({ startBeat: 0, cycle, tracks: [{ trackId: track.id, input: { source: 'all' } }] })
  const bend = (value: number, beat: number) => ({ source: 'k', data: [0xE0, (value + 8192) & 127, (value + 8192) >> 7], beat })

  it('records pitch bend, CCs and aftertouch into thinned lanes, the pedal staying in sustain', () => {
    const take = takeOf()
    take.input({ source: 'k', data: [0x90, 60, 100], beat: 0 })
    for (let index = 0; index <= 400; index++) take.input(bend(Math.round(index / 400 * 8191), 1 + index / 400))
    take.input(bend(0, 2.5))
    take.input({ source: 'k', data: [0xB0, 1, 70], beat: 1 })
    take.input({ source: 'k', data: [0xD0, 40], beat: 1.5 })
    take.input({ source: 'k', data: [0xB0, 64, 127], beat: 1 })
    take.input({ source: 'k', data: [0x80, 60, 0], beat: 3 })
    const result = take.finish(4)
    const committed = commitMidiTake(project([track]), result, { mode: 'merge', beatsPerBar: 4, name: 'take' })
    const recorded = committed.project.tracks[0].clips[0] as MidiClip
    expect(recorded.sustain).toEqual(pts([1, 127], [4, 0]))
    expect(Object.keys(recorded.controllers ?? {}).sort()).toEqual(['aftertouch', 'cc1', 'pitchBend'])
    const lane = recorded.controllers!.pitchBend!
    expect(lane.length).toBeLessThan(140)
    expect(lane[lane.length - 1]).toEqual({ beat: 2.5, value: 0 })
    expect(controllerValueAt(lane, 2)).toBeGreaterThan(8191 - 4 * 32)
    // A controller-only take still makes a region.
    const only = takeOf()
    only.input({ source: 'k', data: [0xB0, 11, 30], beat: 1 })
    expect(commitMidiTake(project([track]), only.finish(2), { mode: 'merge', beatsPerBar: 4, name: 'cc' }).clipIds).toHaveLength(1)
  })

  it('a later cycle pass replaces the span it recorded on the same lane; values held at the start are chased', () => {
    const lanes = recordedControllers([
      { beat: 1, channel: 1, controller: 1, value: 10, pass: 0 }, { beat: 2, channel: 1, controller: 1, value: 20, pass: 0 }, { beat: 3, channel: 1, controller: 1, value: 30, pass: 0 },
      { beat: 1.5, channel: 1, controller: 1, value: 99, pass: 1 }, { beat: 2.5, channel: 1, controller: 1, value: 98, pass: 1 },
      { beat: 0, channel: 1, controller: 7, value: 50 },
    ], 0.5, 4)
    expect(lanes?.cc1).toEqual(pts([.5, 10], [1, 99], [2, 98], [2.5, 30]))
    expect(lanes?.cc7).toEqual(pts([0, 50]))
  })

  it('capture keeps the controllers of the last phrase', () => {
    const events = [
      { source: 'k', data: [0xB0, 1, 50], time: 0, beat: null },
      { source: 'k', data: [0x90, 60, 100], time: 100, beat: null },
      { source: 'k', data: [0xE0, 0, 96], time: 350, beat: null },
      { source: 'k', data: [0x80, 60, 0], time: 600, beat: null },
    ]
    const captured = capturePerformance(events, { bpm: 120, playheadBeat: 4 })!
    expect(captured.controllers).toEqual([
      { beat: 4, channel: 1, controller: 1, value: 50 },
      { beat: 4.5, channel: 1, controller: 129, value: 4096 },
    ])
  })

  it('live input routes pitch bend, CCs and aftertouch to the host, not the pedal', () => {
    const calls: [string, string, number][] = []
    const live = new WebLiveMidi({ startNote: () => null, beatAt: () => null, control: (trackId, key, value) => calls.push([trackId, key, value]) }, () => 1)
    live.setRoutes([{ trackId: 'a', device: null, channel: 0, transpose: 0, velocityOffset: 0, keyLow: 0, keyHigh: 127, velocityLow: 1, velocityHigh: 127 }])
    live.send('k', [0xE0, 0, 0x60])
    live.send('k', [0xB0, 1, 33])
    live.send('k', [0xB0, 64, 127])
    live.send('k', [0xD0, 9])
    expect(calls).toEqual([['a', 'pitchBend', 4096], ['a', 'cc1', 33], ['a', 'aftertouch', 9]])
  })
})

describe('controller import/export and native timeline', () => {
  it('round-trips lanes, the bend range and program changes through a Standard MIDI File', () => {
    const c = clip({ lengthBeats: 4, bendRange: 12, notes: [note(0, 2)], controllers: {
      pitchBend: pts([0, -8192], [1, 4096], [2, 8191]), cc1: pts([1, 64]), cc7: pts([0, 100]), cc10: pts([0, 30]), aftertouch: pts([3, 20]), program: pts([0, 5], [2, 7]),
    } })
    const exported = writeMidiFile(project([keys([c])], 4))
    const imported = parseMidiFile(exported)
    expect(imported.warnings).toEqual([])
    const part = imported.tracks[0]
    expect(part.bendRange).toBe(12)
    expect(part.program).toBe(5)
    // Region-end resets are written too (bend, mod and aftertouch back to their defaults at beat 4).
    expect(part.controllers).toEqual({
      pitchBend: pts([0, -8192], [1, 4096], [2, 8191], [4, 0]), cc1: pts([1, 64], [4, 0]), cc7: pts([0, 100]), cc10: pts([0, 30]),
      aftertouch: pts([3, 20], [4, 0]), program: pts([0, 5], [2, 7]),
    })
  })

  it('compiles controller events per source kind, sorted with region-end resets before the next chase', () => {
    const lanes = { pitchBend: pts([1, 8191]), cc1: pts([0, 64]), program: pts([0, 3]) }
    const builtin = keys([clip({ id: 'b', lengthBeats: 2, bendRange: 7, notes: [note(0)], controllers: lanes }), clip({ id: 'b2', startBeat: 2, lengthBeats: 2, notes: [note(0)], controllers: { pitchBend: pts([0, -4096]) } })], { id: 'builtin' })
    const wave = { ...withInstrument(keys([clip({ id: 'w', lengthBeats: 2, notes: [note(0)], controllers: lanes })]), 'wavetable'), id: 'wave' }
    const vst = keys([clip({ id: 'v', lengthBeats: 2, notes: [note(0)], controllers: lanes, sustain: pts([0, 127]) })], { id: 'vst', pluginInstrument: { id: 'synth', path: 'C:/x.vst3', classId: '0'.repeat(32), name: 'Synth', vendor: 'v', enabled: true, parameters: {} } as unknown as Track['pluginInstrument'] })
    const compiled = compileNativeTimeline(project([builtin, wave, vst], 4))
    const frames = 24000 // one beat at 120 BPM, 48 kHz
    const [b, w, v] = compiled.tracks.map(track => track.controls.map(event => [event.frame / frames, event.controller, event.value]))
    expect(b).toEqual([[0, 1, 64], [1, 131, 7], [1, 129, 8191], [2, 129, 0], [2, 1, 0], [2, 131, 2], [2, 129, -4096], [4, 129, 0]].filter(([frame]) => frame < 4))
    expect(w).toEqual([[0, 1, 64], [0, 130, 3], [1, 129, 8191], [2, 129, 0], [2, 1, 0]])
    expect(v).toEqual([[0, 64, 127], [0, 1, 64], [0, 130, 3], [1, 129, 8191], [2, 64, 0], [2, 129, 0], [2, 1, 0]])
    // A controller-only region still compiles its events.
    const only = compileNativeTimeline(project([keys([clip({ lengthBeats: 2, controllers: { cc11: pts([1, 10]) } })])], 4))
    expect(only.tracks[0].controls).toEqual([{ frame: frames, controller: 11, value: 10 }, { frame: 2 * frames, controller: 11, value: 127 }])
  })
})

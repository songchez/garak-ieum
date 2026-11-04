import { describe, expect, it } from 'vitest'
import { createDevice, createEmptyProject, createTrack } from '../../core/project'
import type { AudioClip, MidiClip, MidiNote, Project, Track } from '../../core/types'
import { compileNativeTimeline, NATIVE_TIMELINE_LIMITS, planNativeSeek, type NativePcmAsset } from './timeline'
import type { NativePluginInstance } from './contracts'

let noteSequence = 0
const note = (start: number, duration = 1, pitch = 60, velocity = 1): MidiNote => ({ id: `note-${noteSequence++}`, start, duration, pitch, velocity })
const midi = (id: string, patch: Partial<MidiClip> = {}): MidiClip => ({
  id, kind: 'midi', name: id, startBeat: 0, lengthBeats: 4, gain: 1, notes: [], ...patch,
})
const audio = (id: string, assetId: string, patch: Partial<AudioClip> = {}): AudioClip => ({
  id, kind: 'audio', name: id, startBeat: 0, lengthBeats: 4, gain: 1, assetId, offsetSeconds: 0, fadeIn: 0, fadeOut: 0, ...patch,
})
const track = (id: string, patch: Partial<Track> = {}): Track => ({ ...createTrack(patch.kind ?? 'instrument', patch.instrument ?? 'keys'), id, ...patch })
const project = (tracks: Track[] = [], patch: Partial<Project> = {}): Project => {
  const lengthBeats = patch.lengthBeats ?? 16
  return { ...createEmptyProject(), id: 'project', bpm: 120, sampleRate: 48000, lengthBeats,
    loop: { enabled: false, startBeat: 0, endBeat: lengthBeats }, tracks, ...patch }
}
const assets = (...items: NativePcmAsset[]) => new Map(items.map(item => [item.id, item]))
const pcm = (id: string, seconds = 10, sampleRate = 48000): NativePcmAsset => ({ id, sampleRate, frames: seconds * sampleRate, channels: 2 })

describe('native timeline preparation', () => {
  it('carries a validated independent wavetable patch instead of classifying it as a browser synth', () => {
    const owner = track('wave', { instrument: 'wavetable', clips: [midi('wave-phrase', { notes: [note(0)] })] })
    owner.instrumentState!.customBanks = [{ slot: 4, name: 'User', frames: [Array(2048).fill(0)] }]
    owner.instrumentParams.osc1Bank = 4
    owner.instrumentState!.lfoCurves[0][2] = 0.15
    const source = compileNativeTimeline(project([owner])).tracks[0].source
    expect(source.kind).toBe('native-wavetable')
    if (source.kind !== 'native-wavetable') throw new Error('Native wave source expected')
    expect(source.patch.params.osc1Bank).toBe(4)
    expect(source.patch.customBanks[0].frames[0]).toHaveLength(2048)
    owner.instrumentState!.customBanks[0].frames[0][0] = 0.7
    owner.instrumentState!.lfoCurves[0][2] = 0.9
    expect(source.patch.customBanks[0].frames[0][0]).toBe(0)
    expect(source.patch.lfoCurves[0][2]).toBe(0.15)
    owner.instrumentState!.customBanks = []
    expect(() => compileNativeTimeline(project([owner]))).toThrow(/Invalid IEUM WAVE patch/)
  })

  it('preserves WAVE and VST3 sources together, including plugin state, inserts and instrument bypass', () => {
    const plugin: NativePluginInstance = { id: 'instrument-instance', pluginId: 'catalog-instrument', classId: 'instrument-class', name: 'Native instrument',
      enabled: true, parameters: { '17': 0.25 }, state: { component: 'AQ==', controller: 'Ag==' } }
    const insert: NativePluginInstance = { id: 'insert-instance', pluginId: 'catalog-effect', classId: 'effect-class', name: 'Native insert',
      enabled: false, parameters: { '31': 0.75 }, state: { component: 'Aw==', controller: 'BA==' } }
    const wave = track('wave', { instrument: 'wavetable', pluginInserts: [insert], clips: [midi('wave-notes', { notes: [note(0)] })] })
    wave.instrumentParams.macro1 = 0.4
    const vst = track('vst', { pluginInstrument: plugin, clips: [midi('vst-notes', { notes: [note(1)] })] })
    const bypassed = track('bypassed', { pluginInstrument: { ...plugin, id: 'bypassed-instance', enabled: false }, clips: [midi('bypassed-notes', { notes: [note(2)] })] })

    const result = compileNativeTimeline(project([wave, vst, bypassed]))
    expect(result.tracks.map(item => item.source.kind)).toEqual(['native-wavetable', 'vst3', 'vst3'])
    expect(result.tracks[0].source).toMatchObject({ instrumentId: 'wavetable', patch: { params: { macro1: 0.4 } } })
    expect(result.tracks[0].inserts[0]).toMatchObject({ id: insert.id, type: 'vst3', enabled: false, params: { '31': 0.75 }, plugin: insert })
    expect(result.tracks[1]).toMatchObject({ enabled: true, audible: true, source: { kind: 'vst3', plugin, isKit: false } })
    expect(result.tracks[2]).toMatchObject({ enabled: false, audible: false, source: { kind: 'vst3', plugin: { id: 'bypassed-instance', enabled: false } } })
    expect(result.tracks.map(item => item.notes.length)).toEqual([1, 1, 1])

    // Project edits must not mutate an already prepared revision or lose either state block.
    wave.instrumentParams.macro1 = 0.9
    plugin.parameters['17'] = 0.8
    plugin.state!.component = 'BQ=='
    insert.parameters['31'] = 0.1
    insert.state!.controller = 'Bg=='
    expect(result.tracks[0].source).toMatchObject({ patch: { params: { macro1: 0.4 } } })
    expect(result.tracks[1].source).toMatchObject({ plugin: { parameters: { '17': 0.25 }, state: { component: 'AQ==', controller: 'Ag==' } } })
    expect(result.tracks[0].inserts[0]).toMatchObject({ params: { '31': 0.75 }, plugin: { parameters: { '31': 0.75 }, state: { component: 'Aw==', controller: 'BA==' } } })
  })

  it('copies builtin source, insert and mixer state without changing the project or creating audio objects', () => {
    const device = { ...createDevice('delay', { time: 0.75, feedback: 0.6 }), id: 'delay', enabled: false }
    const owner = track('piano', { instrument: 'grand', instrumentParams: { release: 0.7 }, volume: 1.2, pan: -0.25, devices: [device] })
    const input = project([owner], { timeSignature: { numerator: 6, denominator: 8 }, beatsPerBar: 3, masterVolume: 0.9 })
    const before = JSON.stringify(input)
    const result = compileNativeTimeline(input, new Map(), 23)
    expect(JSON.stringify(input)).toBe(before)
    expect(result).toMatchObject({ version: 1, projectId: 'project', revision: 23, sampleRate: 48000, bpm: 120,
      timeSignature: { numerator: 6, denominator: 8 }, beatsPerBar: 3, lengthFrames: 384000, masterGain: 0.9, cycle: null })
    expect(result.tracks[0]).toMatchObject({ gain: 1.2, pan: -0.25, audible: true,
      source: { kind: 'builtin-sampled', instrumentId: 'grand', sampleSetId: 'salamander', isKit: false,
        params: { release: 0.7, attack: 0.001, tone: 0, level: 1 } },
      inserts: [{ id: 'delay', type: 'delay', enabled: false, params: { time: 0.75, feedback: 0.6 } }] })
    owner.instrumentParams.release = 2
    device.params.feedback = 0.1
    input.timeSignature.numerator = 7
    expect(result.tracks[0].source).toMatchObject({ params: { release: 0.7 } })
    expect(result.tracks[0].inserts[0].params.feedback).toBe(0.6)
    expect(result.timeSignature.numerator).toBe(6)
  })

  it('preserves recoverable MIDI trims, swing, both delays, repeat cutoff and gain above MIDI velocity', () => {
    const clip = midi('phrase', { startBeat: 2, lengthBeats: 2, loop: true, loopLengthBeats: 5,
      sourceOffsetBeats: 1, quantize: 0.5, swing: 75, delayTicks: 240, transpose: -5, velocity: -5, gain: 1.75,
      notes: [note(1, 0.25), note(1.4, 0.5, 62, 0.5), note(0, 0.5), note(0.5, 1, 64), note(1.2, 0.25, 100)] })
    const owner = track('keys', { transpose: 12, velocityOffset: 5, keyLimit: [67, 71], delayTicks: 240,
      clips: [clip, midi('next-muted', { startBeat: 6.5, lengthBeats: 1, mute: true, notes: [note(0)] })] })
    const result = compileNativeTimeline(project([owner], { lengthBeats: 8 }))
    const notes = result.tracks[0].notes
    expect(notes.map(item => [item.pitch, item.onFrame, item.offFrame, item.limitFrame])).toEqual([
      [67, 60000, 66000, 108000], [71, 60000, 72000, 108000], [69, 78000, 90000, 108000],
      [67, 108000, 114000, 156000], [71, 108000, 120000, 156000], [69, 126000, 138000, 156000],
      [67, 156000, 162000, 168000], [71, 156000, 168000, 168000],
    ])
    expect(notes[0].velocity).toBe(1.75)
    expect(notes[2].velocity).toBeCloseTo(64 / 127 * 1.75)
    expect(notes.map(item => item.occurrenceIndex)).toEqual([0, 0, 0, 1, 1, 1, 2, 2])
    expect(new Set(notes.map(item => item.id)).size).toBe(notes.length)
  })

  it('rounds absolute triplet endpoints at the project rate without accumulating repeated rounding error', () => {
    const clip = midi('triplets', { lengthBeats: 1 / 3, loop: true, notes: [note(0, 1 / 6)] })
    const result = compileNativeTimeline(project([track('keys', { clips: [clip] })], { bpm: 137, sampleRate: 44100, lengthBeats: 8 }))
    expect(result.lengthFrames).toBe(Math.round(8 * 44100 * 60 / 137))
    expect(result.tracks[0].notes).toHaveLength(24)
    for (let index = 0; index < 24; index++) {
      expect(result.tracks[0].notes[index]).toMatchObject({
        onFrame: Math.round(index / 3 * 44100 * 60 / 137),
        offFrame: Math.round((index / 3 + 1 / 6) * 44100 * 60 / 137),
      })
    }
    expect(result.tracks[0].notes[23].onFrame).not.toBe(23 * Math.round(44100 * 60 / 137 / 3))
  })

  it('preserves soloSafe and disabled-solo semantics while retaining muted track events for the mixer', () => {
    const make = (id: string, patch: Partial<Track> = {}) => track(id, { clips: [midi(`${id}-clip`, { notes: [note(0)] })], ...patch })
    const result = compileNativeTimeline(project([
      make('normal'), make('solo', { solo: true }), make('safe', { soloSafe: true }),
      make('muted', { solo: true, mute: true }), make('disabled', { enabled: false, solo: true }),
    ]))
    expect(result.tracks.map(item => [item.id, item.audible, item.enabled, item.notes.length])).toEqual([
      ['normal', false, true, 1], ['solo', true, true, 1], ['safe', true, true, 1],
      ['muted', false, true, 1], ['disabled', false, false, 1],
    ])
    const disabledSolo = compileNativeTimeline(project([make('normal'), make('disabled', { enabled: false, solo: true })]))
    expect(disabledSolo.tracks[0].audible).toBe(true)
  })

  it('cuts overlapping audio without restarting clip fades and keeps source-rate PCM coordinates', () => {
    const original = { id: 'a', sampleRate: 44100, frames: 132300, channels: 2 }
    const owner = track('audio', { kind: 'audio', clips: [
      audio('first', 'a', { lengthBeats: 8, offsetSeconds: 0.5, fadeIn: 0.5, fadeOut: 2, gain: 0.8 }),
      audio('later', 'b', { startBeat: 2, lengthBeats: 2 }),
    ] })
    const result = compileNativeTimeline(project([owner]), assets(original, pcm('b', 1), pcm('unused')))
    expect(result.assets.map(item => item.id)).toEqual(['a', 'b'])
    expect(result.tracks[0].audio).toMatchObject([
      { clipId: 'first', startFrame: 0, endFrame: 48000, sourceStartFrame: 22050, sourceSampleRate: 44100,
        clipOffsetFrames: 0, clipLengthFrames: 120000, fadeInFrames: 24000, fadeOutFrames: 60000, gain: 0.8 },
      { clipId: 'later', startFrame: 48000, endFrame: 96000, sourceStartFrame: 0, clipLengthFrames: 48000 },
    ])
    original.frames = 1
    expect(result.assets[0].frames).toBe(132300)
    const middle = planNativeSeek(result, 24000).tracks[0]
    expect(middle.chasedAudio).toMatchObject([{ startFrame: 24000, endFrame: 48000, sourceStartFrame: 44100,
      clipOffsetFrames: 24000, fadeInFrames: 24000, fadeOutFrames: 60000 }])
    const boundary = planNativeSeek(result, 48000).tracks[0]
    expect(boundary.chasedAudio).toEqual([])
    expect(boundary.nextAudioIndex).toBe(1)
  })

  it('expands partial audio repeats and advances source position when negative delay crops at frame zero', () => {
    const owner = track('audio', { kind: 'audio', delayTicks: -480, clips: [
      audio('loop', 'pcm', { lengthBeats: 2, offsetSeconds: 0.5, loop: true, loopLengthBeats: 5 }),
    ] })
    const result = compileNativeTimeline(project([owner], { lengthBeats: 8 }), assets(pcm('pcm', 4, 44100)))
    expect(result.tracks[0].audio).toMatchObject([
      { startFrame: 0, endFrame: 36000, sourceStartFrame: 33075, clipOffsetFrames: 12000 },
      { startFrame: 36000, endFrame: 84000, sourceStartFrame: 22050, clipOffsetFrames: 0 },
      { startFrame: 84000, endFrame: 108000, sourceStartFrame: 22050, clipOffsetFrames: 0 },
    ])
    expect(planNativeSeek(result, 1).tracks[0].chasedAudio[0].sourceStartFrame).toBeCloseTo(33075.91875)
  })

  it('clips audio to its decoded source end and rejects missing/invalid PCM instead of silently producing silence', () => {
    const input = project([track('audio', { kind: 'audio', clips: [audio('clip', 'pcm', { lengthBeats: 8, offsetSeconds: 0.5 })] })])
    expect(compileNativeTimeline(input, assets(pcm('pcm', 1))).tracks[0].audio[0].endFrame).toBe(24000)
    expect(() => compileNativeTimeline(input)).toThrow(expect.objectContaining({ code: 'MISSING_PCM_ASSET' }))
    expect(() => compileNativeTimeline(input, assets({ ...pcm('pcm'), frames: NaN }))).toThrow(expect.objectContaining({ code: 'INVALID_PCM_ASSET' }))
  })
})

describe('native seek contract', () => {
  it('chases pitched sustains and audio, but never past drum hits, ended notes or exact-position onsets twice', () => {
    const phrase = (id: string) => midi(id, { lengthBeats: 8, notes: [note(0, 4), note(1, 1, 61), note(2, 1, 62), note(4, 2, 63)] })
    const input = project([
      track('pitched', { clips: [phrase('pitched-clip')] }),
      track('kit', { instrument: 'kit-808', clips: [phrase('kit-clip')] }),
      track('disabled', { enabled: false, clips: [phrase('disabled-clip')] }),
      track('audio', { kind: 'audio', clips: [audio('audio-clip', 'pcm', { startBeat: 1, lengthBeats: 6 })] }),
    ], { loop: { enabled: true, startBeat: 2, endBeat: 6 } })
    const result = compileNativeTimeline(input, assets(pcm('pcm')))
    const plan = planNativeSeek(result, 48000)
    expect(plan).toMatchObject({ frame: 48000, boundaryFrame: 144000 })
    expect(plan.tracks[0]).toMatchObject({ nextNoteIndex: 2, chasedNotes: [{ pitch: 60, onFrame: 48000, offFrame: 96000, limitFrame: 144000 }] })
    expect(plan.tracks[0].chasedNotes).toHaveLength(1)
    expect(plan.tracks[1].chasedNotes).toEqual([])
    expect(plan.tracks[2].chasedNotes).toEqual([])
    expect(plan.tracks[3].chasedAudio).toMatchObject([{ startFrame: 48000, endFrame: 144000, sourceStartFrame: 24000 }])
    expect(result.tracks[0].notes[0].onFrame).toBe(0)
  })

  it('retains negative note starts so playback at zero chases melodic notes without retriggering drums', () => {
    const result = compileNativeTimeline(project([
      track('pitched', { delayTicks: -960, clips: [midi('pitched-clip', { notes: [note(0, 2)] })] }),
      track('kit', { instrument: 'drums', delayTicks: -960, clips: [midi('kit-clip', { notes: [note(0, 2, 36)] })] }),
    ]))
    expect(result.tracks[0].notes[0]).toMatchObject({ onFrame: -24000, offFrame: 24000 })
    const plan = planNativeSeek(result, 0)
    expect(plan.tracks[0].chasedNotes).toMatchObject([{ onFrame: 0, offFrame: 24000 }])
    expect(plan.tracks[1].chasedNotes).toEqual([])
  })

  it('normalizes play/seek cycles but exports the full arrangement, with explicit project-end behavior', () => {
    const looped = compileNativeTimeline(project([], { loop: { enabled: true, startBeat: 2, endBeat: 6 } }))
    expect(planNativeSeek(looped, 168000)).toMatchObject({ frame: 48000, boundaryFrame: 144000 })
    expect(planNativeSeek(looped, 168000, 'export')).toMatchObject({ frame: 168000, boundaryFrame: 384000 })
    const straight = compileNativeTimeline(project())
    expect(planNativeSeek(straight, straight.lengthFrames, 'play').frame).toBe(0)
    expect(planNativeSeek(straight, straight.lengthFrames, 'seek').frame).toBe(straight.lengthFrames)
    expect(planNativeSeek(straight, straight.lengthFrames, 'export').frame).toBe(straight.lengthFrames)
    expect(planNativeSeek(straight, -5).frame).toBe(0)
    expect(() => planNativeSeek(straight, NaN)).toThrow(expect.objectContaining({ code: 'INVALID_POSITION' }))
  })
})

describe('native timeline bounds', () => {
  it('bounds duration and validates project rate, meter and revision before creating a payload', () => {
    const maximum = project([], { lengthBeats: NATIVE_TIMELINE_LIMITS.durationSeconds * 2, sampleRate: 192000 })
    expect(compileNativeTimeline(maximum).lengthFrames).toBe(691200000)
    expect(() => compileNativeTimeline(project([], { lengthBeats: maximum.lengthBeats + 0.1 }))).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }))
    expect(() => compileNativeTimeline(project([], { sampleRate: 32000 as Project['sampleRate'] }))).toThrow(expect.objectContaining({ code: 'INVALID_PROJECT' }))
    expect(() => compileNativeTimeline(project([], { beatsPerBar: 3 }))).toThrow(expect.objectContaining({ code: 'INVALID_PROJECT' }))
    expect(() => compileNativeTimeline(project(), new Map(), -1)).toThrow(expect.objectContaining({ code: 'INVALID_PROJECT' }))
  })

  it('rejects the playback helper repeat ceiling and expanded note candidates instead of dropping music', () => {
    const tooManyRepeats = midi('repeat', { lengthBeats: 0.125, loop: true, notes: [note(0, 0.125)] })
    expect(() => compileNativeTimeline(project([track('keys', { clips: [tooManyRepeats] })], { lengthBeats: 1024 })))
      .toThrow(/region repeat occurrences/)
    const dense = midi('dense', { lengthBeats: 1, loop: true, notes: Array.from({ length: 101 }, () => note(0, 0.5)) })
    expect(() => compileNativeTimeline(project([track('keys', { clips: [dense] })], { lengthBeats: 1000 })))
      .toThrow(/expanded note candidates/)
  })

  it('caps quadratic audio overlap work and input counts before expansion', () => {
    const loop = audio('repeat', 'pcm', { lengthBeats: 0.125, loop: true })
    expect(() => compileNativeTimeline(project([track('audio', { kind: 'audio', clips: [loop] })], { lengthBeats: 300 })))
      .toThrow(/audio windows per track/)
    expect(() => compileNativeTimeline(project(Array.from({ length: NATIVE_TIMELINE_LIMITS.tracks + 1 }, (_, index) => track(`track-${index}`)))))
      .toThrow(/tracks/)
    const huge = midi('huge', { notes: Array(NATIVE_TIMELINE_LIMITS.sourceNotes + 1).fill(note(0)) })
    expect(() => compileNativeTimeline(project([track('keys', { clips: [huge] })]))).toThrow(/source notes/)
    const tooManyClips = Array.from({ length: NATIVE_TIMELINE_LIMITS.clips + 1 }, (_, index) => midi(`clip-${index}`))
    expect(() => compileNativeTimeline(project([track('keys', { clips: tooManyClips })]))).toThrow(/clips/)
    const tooManyInserts = Array.from({ length: NATIVE_TIMELINE_LIMITS.insertsPerTrack + 1 }, () => createDevice('eq'))
    expect(() => compileNativeTimeline(project([track('keys', { devices: tooManyInserts })]))).toThrow(/inserts per track/)
    const audioTracks = Array.from({ length: 5 }, (_, index) => track(`audio-${index}`, { kind: 'audio',
      clips: [audio(`loop-${index}`, 'pcm', { lengthBeats: 1, loop: true })] }))
    expect(() => compileNativeTimeline(project(audioTracks, { lengthBeats: 2000 }))).toThrow(/audio windows\./)
  })

  it('does not silently substitute a builtin for an unknown instrument or misroute mismatched clip kinds', () => {
    expect(() => compileNativeTimeline(project([track('unknown', { instrument: 'vst3:unimplemented' })])))
      .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_SOURCE' }))
    expect(() => compileNativeTimeline(project([track('mismatch', { clips: [audio('wrong-kind', 'pcm')] })])))
      .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_SOURCE' }))
  })
})

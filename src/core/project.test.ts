import { describe, expect, it } from 'vitest'
import { EFFECT_DEFS, EFFECT_TYPES } from './devices'
import {
  addMarker, applyDragMode, createDemoProject, createDevice, createEmptyProject, createMarker, createTrack, cropNotesToClip,
  cycleClipIds, defaultInstrumentParams, deleteMarker, duplicateClip, duplicateTrack, duplicateTrackSettings, fitProjectLength,
  insertTracks, joinClips, moveClipToPlayhead, moveDevice, moveMarker, renameMarker, splitClip, transposeClip, trimClipEnd,
  trimClipStart, trimClipStarts, validateProject, visibleTracks, withInstrument, withWavetablePatch, DEFAULT_TRACK_COLORS, MIN_CLIP_BEATS,
} from './project'
import type { NativePluginInstance } from '../audio/native/contracts'
import { combineWavetablePatch, createDefaultWavetablePatch } from '../devices/wavetable-synth/model'
import { WAVE_LIMITS } from '../devices/wavetable-synth/definition'
import { instrumentDef } from './instruments'
import { SAMPLE_RATES } from './audioSettings'
import { visibleMidiNotes } from './midiRegions'
import { exportProjectBundle, importProjectBundle } from './storage'
import { QUANTIZE_VALUES, isEffectDevice, type AudioClip, type Clip, type EffectDevice, type MidiClip, type PluginDevice, type Project, type Track } from './types'

function midi(): MidiClip {
  return {
    id: 'original-clip', kind: 'midi', name: 'Phrase', startBeat: 8, lengthBeats: 4, gain: 0.8,
    notes: [
      { id: 'left-note', pitch: 60, start: 0, duration: 1, velocity: 0.7 },
      { id: 'crossing-note', pitch: 64, start: 1, duration: 3, velocity: 0.6 },
      { id: 'right-note', pitch: 67, start: 2, duration: 0.5, velocity: 0.9 },
    ],
  }
}

describe('project sample rate', () => {
  it('defaults new and legacy projects to 48 kHz and preserves supported project rates', () => {
    const project = createEmptyProject()
    expect(project.sampleRate).toBe(48000)
    const { sampleRate: _old, ...legacy } = project
    expect(validateProject(legacy).sampleRate).toBe(48000)
    expect(validateProject({ ...legacy, schemaVersion: 1 }).sampleRate).toBe(48000)
    for (const sampleRate of SAMPLE_RATES) expect(validateProject({ ...project, sampleRate }).sampleRate).toBe(sampleRate)
  })

  it('rejects explicit malformed rates instead of silently changing the project', () => {
    for (const sampleRate of [null, '48000', 12345, Infinity]) expect(() => validateProject({ ...createEmptyProject(), sampleRate })).toThrow(/sample rate/)
  })
})

describe('original demo project', () => {
  it('opens as a valid eight-bar arrangement with real notes on every track', () => {
    const project = createDemoProject()
    expect(validateProject(project)).toEqual(project)
    expect(project.tracks).toHaveLength(6)
    expect(project.loop).toEqual({ enabled: true, startBeat: 0, endBeat: 32 })
    expect(project.markers).toEqual([])
    for (const track of project.tracks) {
      expect(track.clips.length).toBeGreaterThan(0)
      expect(track.clips.every(clip => clip.kind === 'midi' && clip.notes.some(note => note.velocity > 0))).toBe(true)
    }
  })

  it('keeps the demo instrument colors instead of the Logic defaults', () => {
    const project = createDemoProject()
    expect(project.tracks[0].color).toBe(instrumentDef('drums').color)
    expect(project.tracks[1].color).toBe('#d9b45a')
    expect(project.tracks[3].color).toBe(instrumentDef('keys').color)
  })
})

describe('track defaults', () => {
  it('creates tracks with Logic inspector defaults and kind colors', () => {
    const instrument = createTrack('instrument', 'keys')
    expect(instrument).toMatchObject({
      enabled: true, armed: false, monitor: false, hidden: false, soloSafe: false,
      transpose: 0, velocityOffset: 0, keyLimit: [0, 127], velocityLimit: [1, 127], delayTicks: 0,
      color: instrumentDef('keys').color,
    })
    expect(instrument).not.toHaveProperty('icon')
    expect(createTrack('audio').color).toBe(DEFAULT_TRACK_COLORS.audio)
    expect(createEmptyProject().markers).toEqual([])
  })
})

describe('IEUM WAVE and native VST3 project coexistence', () => {
  const plugin = (id: string): NativePluginInstance => ({
    id, pluginId: 'catalog:trusted-module', classId: '0123456789ABCDEF0123456789ABCDEF',
    name: 'Native plugin', enabled: true, parameters: { '7': 0.375 },
    state: { component: 'AAECA/8=', controller: 'BAUG' },
  })
  function fixture() {
    const patch = createDefaultWavetablePatch()
    patch.params.osc1Bank = 4
    patch.params.macro1 = 0.3
    patch.customBanks = [{ slot: 4, name: 'Saved wave', frames: [Array.from({ length: WAVE_LIMITS.frameSize }, (_, i) => Math.sin(i * 2 * Math.PI / WAVE_LIMITS.frameSize))] }]
    patch.lfoCurves[0][12] = 0.15
    patch.routes = [{ id: 'wave-motion', enabled: true, source: 'lfo1', destination: 'osc1Position', amount: 0.4, bipolar: true, aux: 'macro1', curve: 0.2 }]
    patch.metadata.name = 'Preserved builtin sound'
    const track: Track = {
      ...withWavetablePatch(createTrack('instrument', 'wavetable'), patch),
      // A VST3 effect sits between builtin effects: the chain order is the project's order.
      devices: [createDevice('filter'), { ...plugin('vst-insert'), type: 'vst3' }, createDevice('reverb')],
      pluginInstrument: plugin('vst-source'),
    }
    return { patch, track, project: { ...createEmptyProject(), tracks: [track] } }
  }

  it('round-trips the custom wave and opaque VST3 source/insert states in the same schema 7 bundle', async () => {
    const { patch, track, project } = fixture()
    const bundle = await exportProjectBundle(project, new Map())
    const loaded = (await importProjectBundle(bundle)).project
    expect(loaded).toEqual(project)
    expect(loaded.schemaVersion).toBe(8)
    expect(combineWavetablePatch(loaded.tracks[0].instrumentParams, loaded.tracks[0].instrumentState)).toEqual(patch)
    expect(loaded.tracks[0].pluginInstrument?.state).toEqual(track.pluginInstrument!.state)
    expect(loaded.tracks[0].devices.map(device => device.type)).toEqual(['filter', 'vst3', 'reverb'])
    expect(loaded.tracks[0].devices[1]).toEqual(track.devices[1])
    expect(loaded.tracks[0].instrumentState).not.toHaveProperty('params')
    expect(loaded.tracks[0].instrumentState!.customBanks[0].frames[0]).not.toBe(track.instrumentState!.customBanks[0].frames[0])
  })

  it('migrates existing schema 5 WAVE projects before allowing native plugin data', () => {
    const { patch, track, project } = fixture()
    const { pluginInstrument: _source, ...legacyTrack } = track
    const builtinOnly = { ...legacyTrack, devices: track.devices.filter(device => device.type !== 'vst3') }
    const migrated = validateProject({ ...project, schemaVersion: 5, tracks: [builtinOnly] })
    expect(migrated.schemaVersion).toBe(8)
    expect(combineWavetablePatch(migrated.tracks[0].instrumentParams, migrated.tracks[0].instrumentState)).toEqual(patch)
    expect(migrated.tracks[0]).not.toHaveProperty('pluginInstrument')
    expect(() => validateProject({ ...project, schemaVersion: 5, tracks: [{ ...builtinOnly, pluginInstrument: track.pluginInstrument }] })).toThrow('schema version 6')
    expect(() => validateProject({ ...project, schemaVersion: 6 })).toThrow('unknown effect type')
  })

  it('moves schema 6 VST3 inserts into the device chain after the builtin effects they used to follow', () => {
    const { track, project } = fixture()
    const builtin = track.devices.filter(device => device.type !== 'vst3')
    const { type: _type, ...insert } = track.devices[1] as PluginDevice
    const legacy = JSON.parse(JSON.stringify({ ...project, schemaVersion: 6, tracks: [{ ...track, devices: builtin, pluginInserts: [insert] }] }))
    const migrated = validateProject(legacy)
    expect(migrated.schemaVersion).toBe(8)
    expect(migrated.tracks[0].devices.map(device => device.type)).toEqual(['filter', 'reverb', 'vst3'])
    expect(migrated.tracks[0].devices[2]).toEqual(track.devices[1])
    expect(migrated.tracks[0]).not.toHaveProperty('pluginInserts')
    expect(() => validateProject({ ...legacy, schemaVersion: 7 })).toThrow('device chain since schema version 7')
  })

  it('validates both sound formats even when the VST3 source overrides the builtin wave', () => {
    const { track, project } = fixture()
    expect(() => validateProject({ ...project, tracks: [{ ...track, instrumentState: { ...track.instrumentState, customBanks: [] } }] })).toThrow(/데이터가 없습니다/)
    expect(() => validateProject({ ...project, tracks: [{ ...track, pluginInstrument: { ...track.pluginInstrument, path: '/untrusted/plugin.vst3' } }] })).toThrow('unsupported plugin field')
    expect(() => validateProject({ ...project, tracks: [{ ...track, devices: [{ ...track.devices[1], state: { component: 'invalid!' } }] }] })).toThrow('base64')
    expect(() => validateProject({ ...project, tracks: [{ ...track, devices: [{ ...track.devices[1], path: '/untrusted/fx.vst3' }] }] })).toThrow('unsupported plugin field')
  })

  it.each([duplicateTrack, duplicateTrackSettings])('duplicates both editable states with independent data and fresh VST3 instance IDs', duplicate => {
    const { track, project } = fixture()
    const copied = duplicate(track)
    expect(validateProject({ ...project, tracks: [track, copied] }).tracks).toHaveLength(2)
    expect(copied.pluginInstrument?.id).not.toBe(track.pluginInstrument!.id)
    expect(copied.devices[1].id).not.toBe(track.devices[1].id)
    copied.instrumentParams.macro1 = 0.9
    copied.instrumentState!.customBanks[0].frames[0][0] = 0.8
    copied.instrumentState!.routes[0].amount = -0.3
    copied.pluginInstrument!.parameters['7'] = 1
    copied.pluginInstrument!.state!.component = 'BQ=='
    ;(copied.devices[1] as PluginDevice).state!.controller = 'Bg=='
    expect(track.instrumentParams.macro1).toBe(0.3)
    expect(track.instrumentState!.customBanks[0].frames[0][0]).toBe(0)
    expect(track.instrumentState!.routes[0].amount).toBe(0.4)
    expect(track.pluginInstrument!.parameters['7']).toBe(0.375)
    expect(track.pluginInstrument!.state!.component).toBe('AAECA/8=')
    expect((track.devices[1] as PluginDevice).state!.controller).toBe('BAUG')
  })

  it.each(['keys', 'wavetable'])('selecting builtin %s clears the VST3 source while retaining the insert chain', instrument => {
    const { track, project } = fixture()
    const changed = withInstrument(track, instrument)
    expect(changed.instrument).toBe(instrument)
    expect(changed).not.toHaveProperty('pluginInstrument')
    expect(changed.devices).toEqual(track.devices)
    expect(changed.instrumentParams).toEqual(defaultInstrumentParams(instrument))
    if (instrument === 'wavetable') {
      expect(combineWavetablePatch(changed.instrumentParams, changed.instrumentState)).toEqual(createDefaultWavetablePatch())
    } else {
      expect(changed).not.toHaveProperty('instrumentState')
    }
    expect(track.pluginInstrument?.id).toBe('vst-source')
    expect(track.instrumentState!.customBanks).toHaveLength(1)
    expect(validateProject({ ...project, tracks: [changed] }).tracks[0]).toEqual(changed)
  })
})

describe('non-destructive clip editing', () => {
  it('duplicates note IDs and note objects without changing the source clip', () => {
    const source = midi()
    const duplicate = duplicateClip(source)
    expect(duplicate.id).not.toBe(source.id)
    expect(duplicate.startBeat).toBe(12)
    expect(duplicate.kind).toBe('midi')
    if (duplicate.kind !== 'midi') throw new Error('Expected MIDI clip')
    expect(duplicate.notes[0].id).not.toBe(source.notes[0].id)
    duplicate.notes[0].pitch = 72
    expect(source.notes[0].pitch).toBe(60)
  })

  it('splits visible note windows without discarding the recoverable source', () => {
    const source = midi()
    const before = JSON.stringify(source)
    const [left, right] = splitClip(source, 10, 96)
    expect(left.kind).toBe('midi')
    expect(right.kind).toBe('midi')
    if (left.kind !== 'midi' || right.kind !== 'midi') throw new Error('Expected MIDI clips')
    expect(left.startBeat).toBe(8)
    expect(left.lengthBeats).toBe(2)
    expect(visibleMidiNotes(left).map(({ pitch, start, duration }) => ({ pitch, start, duration }))).toEqual([
      { pitch: 60, start: 0, duration: 1 }, { pitch: 64, start: 1, duration: 1 },
    ])
    expect(right.startBeat).toBe(10)
    expect(right.lengthBeats).toBe(2)
    expect(visibleMidiNotes(right).map(({ pitch, start, duration }) => ({ pitch, start, duration }))).toEqual([
      { pitch: 64, start: 0, duration: 2 }, { pitch: 67, start: 0, duration: 0.5 },
    ])
    const ids = [...left.notes, ...right.notes].map(note => note.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(JSON.stringify(source)).toBe(before)
  })

  it('does not create zero-length clips for an edge or out-of-range split', () => {
    const source = midi()
    for (const beat of [0, 8, 12, 20]) expect(splitClip(source, beat, 96)).toEqual([source])
  })

  it.each([60, 90, 120])('preserves the audio source offset at %i BPM', bpm => {
    const source: AudioClip = {
      id: 'recorded-clip', kind: 'audio', name: 'Recorded take', startBeat: 8, lengthBeats: 8,
      gain: 0.7, assetId: 'source-wav', offsetSeconds: 2.25, fadeIn: 0.1, fadeOut: 0.2,
    }
    const [left, right] = splitClip(source, 11, bpm)
    if (left.kind !== 'audio' || right.kind !== 'audio') throw new Error('Expected audio clips')
    expect(left.lengthBeats).toBe(3)
    expect(right.lengthBeats).toBe(5)
    expect(right.offsetSeconds).toBeCloseTo(2.25 + 3 * 60 / bpm)
    expect(left.offsetSeconds).toBe(2.25)
    expect(right.assetId).toBe(source.assetId)
    expect(left.fadeIn).toBe(0.1)
    expect(left.fadeOut).toBe(0)
    expect(right.fadeIn).toBe(0)
    expect(right.fadeOut).toBe(0.2)
    expect(source.lengthBeats).toBe(8)
    const duplicate = duplicateClip(source, 24)
    expect(duplicate).toMatchObject({ assetId: 'source-wav', offsetSeconds: 2.25, startBeat: 24 })
  })

  it('rejects unusable edit coordinates instead of producing NaN offsets', () => {
    expect(() => splitClip(midi(), NaN, 96)).toThrow(/finite/)
    expect(() => splitClip(midi(), 10, 0)).toThrow(/Tempo/)
    expect(() => duplicateClip(midi(), -1)).toThrow(/position/)
  })
})

function audio(patch: Partial<AudioClip> = {}): AudioClip {
  return {
    id: 'take', kind: 'audio', name: 'Take', startBeat: 8, lengthBeats: 8, gain: 1,
    assetId: 'source-wav', offsetSeconds: 1, fadeIn: 0.1, fadeOut: 0.2, ...patch,
  }
}
const timing = (clip: MidiClip) => visibleMidiNotes(clip).map(({ pitch, start, duration }) => ({ pitch, start, duration }))

describe('trim, join and arrangement helpers', () => {
  it('trims the visible MIDI window while retaining source notes', () => {
    const trimmed = trimClipStart(midi(), 9.5, 120)
    if (trimmed.kind !== 'midi') throw new Error('Expected MIDI clip')
    expect(trimmed).toMatchObject({ id: 'original-clip', startBeat: 9.5, lengthBeats: 2.5 })
    expect(trimmed.notes).toEqual(midi().notes)
    expect(timing(trimmed)).toEqual([{ pitch: 64, start: 0, duration: 2.5 }, { pitch: 67, start: 0.5, duration: 0.5 }])
  })

  it('extends a MIDI clip to the left by moving notes later', () => {
    const extended = trimClipStart(midi(), 6, 120)
    if (extended.kind !== 'midi') throw new Error('Expected MIDI clip')
    expect(extended).toMatchObject({ startBeat: 6, lengthBeats: 6 })
    expect(extended.notes[0].start).toBe(2)
  })

  it('trims audio starts by advancing the source offset and never reads before the file', () => {
    const trimmed = trimClipStart(audio(), 10, 120)
    if (trimmed.kind !== 'audio') throw new Error('Expected audio clip')
    expect(trimmed).toMatchObject({ startBeat: 10, lengthBeats: 6, offsetSeconds: 2 })
    const extended = trimClipStart(audio(), 0, 120)
    if (extended.kind !== 'audio') throw new Error('Expected audio clip')
    expect(extended.startBeat).toBe(6)
    expect(extended.offsetSeconds).toBe(0)
    expect(extended.lengthBeats).toBe(10)
  })

  it('keeps a minimum length when trimming past the opposite edge', () => {
    expect(trimClipStart(midi(), 50, 120)).toMatchObject({ startBeat: 12 - MIN_CLIP_BEATS, lengthBeats: MIN_CLIP_BEATS })
    expect(trimClipEnd(midi(), 2).lengthBeats).toBe(MIN_CLIP_BEATS)
    expect(trimClipEnd(midi(), 20, 6).lengthBeats).toBe(6)
    expect(trimClipEnd(midi(), 12)).toEqual(midi())
  })

  it('moves to the playhead and clamps negative positions', () => {
    expect(moveClipToPlayhead(midi(), 3).startBeat).toBe(3)
    expect(moveClipToPlayhead(midi(), -2).startBeat).toBe(0)
  })

  it('crops notes to the clip window', () => {
    const clip = { ...midi(), lengthBeats: 2.25 }
    expect(timing(cropNotesToClip(clip))).toEqual([
      { pitch: 60, start: 0, duration: 1 }, { pitch: 64, start: 1, duration: 1.25 }, { pitch: 67, start: 2, duration: 0.25 },
    ])
  })

  it('joins MIDI clips into one clip with re-based notes and the first clip identity', () => {
    const [left, right] = splitClip(midi(), 10, 96)
    const moved = { ...right, startBeat: 14 }
    const joined = joinClips([moved, left], 96)
    if (!joined || joined.kind !== 'midi') throw new Error('Expected MIDI clip')
    expect(joined).toMatchObject({ id: 'original-clip', startBeat: 8, lengthBeats: 8 })
    expect(timing(joined)).toEqual([
      { pitch: 60, start: 0, duration: 1 }, { pitch: 64, start: 1, duration: 1 },
      { pitch: 64, start: 6, duration: 2 }, { pitch: 67, start: 6, duration: 0.5 },
    ])
  })

  it('joins split audio back together but refuses gaps, other assets and broken offsets', () => {
    const [left, right] = splitClip(audio(), 11, 90)
    if (left.kind !== 'audio' || right.kind !== 'audio') throw new Error('Expected audio clips')
    const joined = joinClips([right, left], 90)
    expect(joined).toMatchObject({ id: 'take', startBeat: 8, lengthBeats: 8, offsetSeconds: 1, fadeIn: 0.1, fadeOut: 0.2 })
    expect(joinClips([left, { ...right, assetId: 'other' }], 90)).toBeNull()
    expect(joinClips([left, { ...right, startBeat: 13 }], 90)).toBeNull()
    expect(joinClips([left, { ...right, offsetSeconds: 0 }], 90)).toBeNull()
    expect(joinClips([left, midi()], 90)).toBeNull()
    expect(joinClips([left], 90)).toBeNull()
  })

  it('transposes with clamping and keeps the source untouched', () => {
    const source = midi()
    expect(transposeClip(source, 12).notes.map(n => n.pitch)).toEqual([72, 76, 79])
    expect(transposeClip(source, 100).notes.every(n => n.pitch === 127)).toBe(true)
    expect(source.notes[0].pitch).toBe(60)
  })

  it('duplicates a track with fresh IDs everywhere', () => {
    const track = createTrack('instrument', 'keys')
    track.devices = [createDevice('reverb')]
    track.clips = [midi()]
    const copy = duplicateTrack(track)
    const ids = (t: typeof track) => [t.id, ...t.devices.map(d => d.id), ...t.clips.map(c => c.id), ...t.clips.flatMap(c => c.kind === 'midi' ? c.notes.map(n => n.id) : [])]
    expect(ids(copy).some(id => ids(track).includes(id))).toBe(false)
    expect(validateProject({ ...createEmptyProject(), tracks: [track, copy] }).tracks).toHaveLength(2)
  })

  it('grows the project length to the next bar after the last clip', () => {
    const project = createEmptyProject()
    const track = createTrack('instrument')
    track.clips = [{ ...midi(), startBeat: 70, lengthBeats: 3 }]
    expect(fitProjectLength({ ...project, tracks: [track] }).lengthBeats).toBe(76)
    expect(fitProjectLength(project)).toBe(project)
  })
})

describe('project validation', () => {
  it('accepts an optional clip mute flag and rejects non-boolean values', () => {
    const track = createTrack('instrument')
    track.clips = [{ ...midi(), mute: true }]
    const project = { ...createEmptyProject(), tracks: [track] }
    expect(validateProject(project).tracks[0].clips[0].mute).toBe(true)
    expect(validateProject({ ...project, tracks: [{ ...track, clips: [midi()] }] }).tracks[0].clips[0]).not.toHaveProperty('mute')
    expect(() => validateProject({ ...project, tracks: [{ ...track, clips: [{ ...midi(), mute: 'yes' }] }] })).toThrow(/mute/)
  })

  it('returns an independent project and discards unrecognized imported fields', () => {
    const original = createDemoProject()
    const imported = validateProject({ ...original, unexpected: { executable: true } })
    imported.tracks[0].name = 'Changed later'
    expect(original.tracks[0].name).toBe('Pocket drums')
    expect(imported).not.toHaveProperty('unexpected')
  })

  it('rejects unsupported versions, duplicate IDs, and values that could break the engine', () => {
    const project = createEmptyProject()
    expect(() => validateProject({ ...project, schemaVersion: 9 })).toThrow(/version/)
    expect(() => validateProject({ ...project, bpm: Infinity })).toThrow(/Tempo/)
    expect(() => validateProject({ ...project, loop: { enabled: true, startBeat: 8, endBeat: 4 } })).toThrow(/Loop end/)
    const track = createTrack('instrument')
    expect(() => validateProject({ ...project, tracks: [track, track] })).toThrow(/duplicates/)
    expect(() => validateProject({ ...project, tracks: [{ ...track, devices: [createDevice('filter', { cutoff: 1 })] }] })).toThrow(/cutoff/)
    track.clips = [midi()]
    const clip = track.clips[0] as MidiClip
    clip.notes[0].velocity = 100
    expect(() => validateProject({ ...project, tracks: [track] })).toThrow(/velocity/)
  })

  it('migrates a version 1 project with fixed effects into an equivalent device chain', () => {
    const track: Record<string, unknown> = { ...createTrack('instrument', 'pad'), id: 'old-pad' }
    delete track.instrumentParams
    delete track.devices
    track.effects = { filter: 4200, reverb: 0.3, delay: 0 }
    const migrated = validateProject({ ...createEmptyProject(), schemaVersion: 1, tracks: [track] })
    expect(migrated.schemaVersion).toBe(8)
    expect(migrated.tracks[0].instrumentParams).toEqual(defaultInstrumentParams('pad'))
    expect(migrated.tracks[0].devices).toEqual([
      { id: 'old-pad/filter', type: 'filter', enabled: true, params: { cutoff: 4200, resonance: 0.65, mode: 0 } },
      { id: 'old-pad/reverb', type: 'reverb', enabled: true, params: { amount: 0.3, size: 0, tone: 20000 } },
    ])
    expect(validateProject(migrated)).toEqual(migrated)
    expect(() => validateProject({ ...createEmptyProject(), schemaVersion: 1, tracks: [{ ...track, effects: { filter: 1, reverb: 0, delay: 0 } }] }))
      .toThrow(/filter frequency/)
  })

  it('rejects unknown effect types and invalid option values', () => {
    const track = createTrack('instrument')
    const unknown = { ...createDevice('reverb'), type: 'flanger' }
    expect(() => validateProject({ ...createEmptyProject(), tracks: [{ ...track, devices: [unknown] }] })).toThrow(/unknown effect type/)
    expect(() => validateProject({ ...createEmptyProject(), tracks: [{ ...track, devices: [createDevice('delay', { time: 0.3 })] }] })).toThrow(/time/)
    const device = createDevice('eq')
    expect(() => validateProject({ ...createEmptyProject(), tracks: [{ ...track, devices: [device, { ...device }] }] })).toThrow(/duplicates/)
  })

  it('round-trips every effect type with its default parameters', () => {
    const track = createTrack('instrument', 'bass')
    track.devices = EFFECT_TYPES.map(type => createDevice(type))
    const project = { ...createEmptyProject(), tracks: [track] }
    expect(validateProject(project)).toEqual(project)
    for (const device of track.devices.filter(isEffectDevice)) expect(Object.keys(device.params).sort()).toEqual(EFFECT_DEFS[device.type].params.map(def => def.id).sort())
  })

  it('validates instrument parameters, fills missing keys and drops unknown ones', () => {
    const track = createTrack('instrument', 'keys')
    const base = createEmptyProject()
    expect(() => validateProject({ ...base, tracks: [{ ...track, instrumentParams: { ...track.instrumentParams, bell: 5 } }] })).toThrow(/instrument bell/)
    expect(() => validateProject({ ...base, tracks: [{ ...track, instrumentParams: 'loud' }] })).toThrow(/object/)
    const parsed = validateProject({ ...base, tracks: [{ ...track, instrumentParams: { tone: 0.5, extra: 1 } }] })
    expect(parsed.tracks[0].instrumentParams).toEqual({ ...defaultInstrumentParams('keys'), tone: 0.5 })
  })
})

describe('device chain editing', () => {
  it('moves devices left and right, clamped to the chain', () => {
    const track = createTrack('instrument')
    track.devices = [createDevice('eq'), createDevice('drive'), createDevice('reverb')]
    const [eq, drive, reverb] = track.devices
    expect(moveDevice(track, reverb.id, -1).devices).toEqual([eq, reverb, drive])
    expect(moveDevice(track, eq.id, 10).devices).toEqual([drive, reverb, eq])
    expect(moveDevice(track, drive.id, -5).devices).toEqual([drive, eq, reverb])
    expect(moveDevice(track, eq.id, -1)).toBe(track)
    expect(moveDevice(track, 'missing', 1)).toBe(track)
    expect(track.devices).toEqual([eq, drive, reverb])
  })
})

const REGION_FIELDS = { loop: true, delayTicks: -240, quantize: 0.25, swing: 62, transpose: 5, velocity: -10 } as const
const regionFields = (clip: Clip) => {
  const { loop, delayTicks } = clip
  return clip.kind === 'midi'
    ? { loop, delayTicks, quantize: clip.quantize, swing: clip.swing, transpose: clip.transpose, velocity: clip.velocity }
    : { loop, delayTicks }
}

describe('region fields survive clip editing', () => {
  const source = (): MidiClip => ({ ...midi(), ...REGION_FIELDS })

  it('keeps loop, quantize and transpose through split, join, duplicate, trim and transpose', () => {
    const [left, right] = splitClip(source(), 10, 96)
    expect(regionFields(left)).toEqual(REGION_FIELDS)
    expect(regionFields(right)).toEqual(REGION_FIELDS)
    expect(regionFields(duplicateClip(source()))).toEqual(REGION_FIELDS)
    expect(regionFields(trimClipStart(source(), 9, 96))).toEqual(REGION_FIELDS)
    expect(regionFields(trimClipEnd(source(), 10))).toEqual(REGION_FIELDS)
    expect(regionFields(transposeClip(source(), 2))).toEqual(REGION_FIELDS)
    expect(regionFields(moveClipToPlayhead(source(), 1))).toEqual(REGION_FIELDS)
  })

  it('joins with the first clip values', () => {
    const [left, right] = splitClip(source(), 10, 96)
    if (right.kind !== 'midi') throw new Error('Expected MIDI clip')
    const other: MidiClip = { ...right, quantize: 1, swing: 10, transpose: -3, velocity: 20, loop: false, delayTicks: 0 }
    const joined = joinClips([other, left], 96)
    if (!joined) throw new Error('Expected a clip')
    expect(regionFields(joined)).toEqual(REGION_FIELDS)
    const audioLeft = { ...audio(), loop: true, delayTicks: 12 }
    const [a, b] = splitClip(audioLeft, 11, 90)
    expect(regionFields(a)).toEqual({ loop: true, delayTicks: 12 })
    const audioJoined = joinClips([{ ...b, loop: false, delayTicks: 0 }, a], 90)
    if (!audioJoined) throw new Error('Expected a clip')
    expect(regionFields(audioJoined)).toEqual({ loop: true, delayTicks: 12 })
  })

  it('duplicates a track including region fields and track settings', () => {
    const track = { ...createTrack('instrument', 'keys'), transpose: 7, keyLimit: [36, 96] as [number, number], icon: 'piano' }
    track.clips = [source()]
    const copy = duplicateTrack(track)
    expect(regionFields(copy.clips[0])).toEqual(REGION_FIELDS)
    expect(copy).toMatchObject({ transpose: 7, keyLimit: [36, 96], icon: 'piano' })
  })
})

function clipAt(id: string, startBeat: number, lengthBeats: number, kind: 'midi' | 'audio' = 'midi'): Clip {
  return kind === 'midi'
    ? { ...midi(), id, startBeat, lengthBeats, notes: [{ id: `${id}-note`, pitch: 60, start: 0, duration: lengthBeats, velocity: 0.7 }] }
    : audio({ id, startBeat, lengthBeats, fadeIn: 0, fadeOut: 0 })
}

function projectWith(...tracks: Track[]): Project {
  return { ...createEmptyProject(), tracks }
}

describe('drag mode', () => {
  const layout = (clips: Clip[]) => clips.map(clip => [clip.id === 'moved' ? 'moved' : clip.id, clip.startBeat, clip.startBeat + clip.lengthBeats])

  it('returns the same project in overlap mode or when nothing is covered', () => {
    const track = { ...createTrack('instrument'), id: 't', clips: [clipAt('a', 0, 4), clipAt('moved', 4, 4)] }
    const project = projectWith(track)
    expect(applyDragMode(project, ['t'], ['moved'], 'overlap')).toBe(project)
    expect(applyDragMode(project, ['t'], ['moved'], 'noOverlap')).toBe(project)
    expect(applyDragMode(project, ['t'], [], 'noOverlap')).toBe(project)
    expect(applyDragMode(project, ['other'], ['moved'], 'noOverlap')).toBe(project)
  })

  it('trims the start of a clip whose beginning is covered', () => {
    const track = { ...createTrack('instrument'), id: 't', clips: [clipAt('moved', 0, 6), clipAt('a', 4, 8)] }
    const result = applyDragMode(projectWith(track), ['t'], ['moved'], 'noOverlap')
    expect(layout(result.tracks[0].clips)).toEqual([['moved', 0, 6], ['a', 6, 12]])
    const a = result.tracks[0].clips[1] as MidiClip
    expect(visibleMidiNotes(a)).toEqual([{ id: 'a-note', pitch: 60, start: 0, duration: 6, velocity: 0.7 }])
  })

  it('trims the end of a clip whose ending is covered', () => {
    const track = { ...createTrack('instrument'), id: 't', clips: [clipAt('a', 0, 8), clipAt('moved', 6, 6)] }
    const result = applyDragMode(projectWith(track), ['t'], ['moved'], 'noOverlap')
    expect(layout(result.tracks[0].clips)).toEqual([['a', 0, 6], ['moved', 6, 12]])
  })

  it('splits a clip around a moved clip dropped in its middle, keeping both parts', () => {
    const track = { ...createTrack('instrument'), id: 't', clips: [clipAt('a', 0, 12), clipAt('moved', 4, 4)] }
    const result = applyDragMode(projectWith(track), ['t'], ['moved'], 'noOverlap')
    const clips = result.tracks[0].clips
    expect(clips.map(clip => [clip.startBeat, clip.startBeat + clip.lengthBeats])).toEqual([[0, 4], [8, 12], [4, 8]])
    expect(clips[0].id).toBe('a')
    expect(clips[1].id).not.toBe('a')
    expect(clips[2].id).toBe('moved')
    expect(visibleMidiNotes(clips[1] as MidiClip)[0]).toMatchObject({ start: 0, duration: 4 })
  })

  it('removes a clip that is entirely covered and leaves other tracks alone', () => {
    const track = { ...createTrack('instrument'), id: 't', clips: [clipAt('a', 4, 2), clipAt('moved', 2, 8), clipAt('b', 10, 2)] }
    const untouched = { ...createTrack('instrument'), id: 'u', clips: [clipAt('c', 2, 8)] }
    const result = applyDragMode(projectWith(track, untouched), ['t'], ['moved'], 'noOverlap')
    expect(result.tracks[0].clips.map(clip => clip.id)).toEqual(['moved', 'b'])
    expect(result.tracks[1]).toBe(untouched)
  })

  it('handles audio clips and several moved clips at once', () => {
    const track = { ...createTrack('audio'), id: 't', clips: [clipAt('a', 0, 16, 'audio'), clipAt('m1', 2, 2, 'audio'), clipAt('m2', 8, 4, 'audio')] }
    const result = applyDragMode(projectWith(track), ['t'], ['m1', 'm2'], 'noOverlap')
    const pieces = result.tracks[0].clips.filter(clip => clip.id !== 'm1' && clip.id !== 'm2')
    expect(pieces.map(clip => [clip.startBeat, clip.startBeat + clip.lengthBeats])).toEqual([[0, 2], [4, 8], [12, 16]])
    expect(pieces.map(clip => (clip.kind === 'audio' ? clip.offsetSeconds : NaN))).toEqual([1, 1 + 4 * 60 / 96, 1 + 12 * 60 / 96])
  })
})

describe('batch left trim', () => {
  it('commits MIDI and audio trims on different tracks together without mutating the source project', () => {
    const keys = { ...createTrack('instrument'), id: 'keys', clips: [midi()] }
    const recording = { ...createTrack('audio'), id: 'recording', clips: [audio()] }
    const untouched = createTrack('instrument', 'pad')
    const project = { ...projectWith(keys, recording, untouched), bpm: 120 }
    const before = structuredClone(project)
    const result = trimClipStarts(project, [
      { trackId: keys.id, clipId: keys.clips[0].id, newStart: 9.5 },
      { trackId: recording.id, clipId: recording.clips[0].id, newStart: 9.5 },
    ])
    const phrase = result.tracks[0].clips[0] as MidiClip
    expect(phrase).toMatchObject({ id: 'original-clip', startBeat: 9.5, lengthBeats: 2.5 })
    expect(timing(phrase)).toEqual([{ pitch: 64, start: 0, duration: 2.5 }, { pitch: 67, start: 0.5, duration: 0.5 }])
    expect(result.tracks[1].clips[0]).toMatchObject({ id: 'take', startBeat: 9.5, lengthBeats: 6.5, assetId: 'source-wav', offsetSeconds: 1.75 })
    expect(result.tracks[2]).toBe(untouched)
    expect(project).toEqual(before)
  })

  it('resolves no-overlap after the whole batch while protecting every selected region', () => {
    const track = { ...createTrack('instrument'), id: 't', clips: [clipAt('background', 0, 20), clipAt('first', 8, 4), clipAt('second', 10, 4)] }
    const project = projectWith(track)
    const result = trimClipStarts(project, [
      { trackId: 't', clipId: 'first', newStart: 6 },
      { trackId: 't', clipId: 'second', newStart: 8 },
    ], 'noOverlap')
    const selected = result.tracks[0].clips.filter(clip => clip.id === 'first' || clip.id === 'second')
    expect(selected.map(clip => [clip.id, clip.startBeat, clip.lengthBeats])).toEqual([['first', 6, 6], ['second', 8, 6]])
    const surrounding = result.tracks[0].clips.filter(clip => clip.id !== 'first' && clip.id !== 'second')
    expect(surrounding.map(clip => [clip.startBeat, clip.startBeat + clip.lengthBeats])).toEqual([[0, 6], [14, 20]])
    expect(project.tracks[0].clips).toHaveLength(3)
    expect(project.tracks[0].clips[1].startBeat).toBe(8)
  })

  it('keeps each clip’s minimum length and audio source-offset limit in the batch', () => {
    const keys = { ...createTrack('instrument'), id: 'keys', clips: [midi()] }
    const recording = { ...createTrack('audio'), id: 'recording', clips: [audio()] }
    const project = { ...projectWith(keys, recording), bpm: 120 }
    const result = trimClipStarts(project, [
      { trackId: keys.id, clipId: keys.clips[0].id, newStart: 50 },
      { trackId: recording.id, clipId: recording.clips[0].id, newStart: 0 },
    ])
    expect(result.tracks[0].clips[0]).toMatchObject({ startBeat: 12 - MIN_CLIP_BEATS, lengthBeats: MIN_CLIP_BEATS })
    expect(result.tracks[1].clips[0]).toMatchObject({ startBeat: 6, lengthBeats: 10, offsetSeconds: 0 })
  })
})

describe('track list helpers', () => {
  it('duplicates settings with a fresh track and device IDs but no clips, arm or monitor', () => {
    const track = { ...createTrack('instrument', 'pad'), armed: true, monitor: true, transpose: -12, velocityLimit: [20, 100] as [number, number], icon: 'pad', hidden: true }
    track.devices = [createDevice('reverb', { amount: 0.4 }), createDevice('delay')]
    track.clips = [midi()]
    track.instrumentParams = { ...track.instrumentParams, tone: 0.25 }
    const copy = duplicateTrackSettings(track)
    expect(copy.id).not.toBe(track.id)
    expect(copy.clips).toEqual([])
    expect(copy).toMatchObject({ name: track.name, armed: false, monitor: false, transpose: -12, velocityLimit: [20, 100], icon: 'pad', hidden: true, color: track.color })
    expect(copy.instrumentParams).toEqual(track.instrumentParams)
    expect(copy.instrumentParams).not.toBe(track.instrumentParams)
    expect(copy.devices.map(device => device.type)).toEqual(['reverb', 'delay'])
    expect(copy.devices[0]).toMatchObject({ params: (track.devices[0] as EffectDevice).params })
    expect(copy.devices.some(device => track.devices.some(original => original.id === device.id))).toBe(false)
    copy.keyLimit[0] = 50
    expect(track.keyLimit[0]).toBe(0)
    expect(validateProject(projectWith(track, copy)).tracks).toHaveLength(2)
  })

  it('inserts tracks after a given track or at the end', () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(id => ({ ...createTrack('instrument'), id }))
    const project = projectWith(a, b)
    expect(insertTracks(project, 'a', [c, d]).tracks.map(track => track.id)).toEqual(['a', 'c', 'd', 'b'])
    expect(insertTracks(project, 'b', [c]).tracks.map(track => track.id)).toEqual(['a', 'b', 'c'])
    expect(insertTracks(project, null, [c]).tracks.map(track => track.id)).toEqual(['a', 'b', 'c'])
    expect(insertTracks(project, 'missing', [c]).tracks.map(track => track.id)).toEqual(['a', 'b', 'c'])
    expect(insertTracks(project, 'a', [])).toBe(project)
    expect(project.tracks).toHaveLength(2)
  })

  it('selects cycle clips only while the cycle is on', () => {
    const track = { ...createTrack('instrument'), clips: [clipAt('before', 0, 4), clipAt('edge', 4, 4), clipAt('inside', 9, 2), clipAt('after', 16, 4)] }
    expect(cycleClipIds(track, { enabled: true, startBeat: 8, endBeat: 16 })).toEqual(['inside'])
    expect(cycleClipIds(track, { enabled: true, startBeat: 6, endBeat: 16 })).toEqual(['edge', 'inside'])
    expect(cycleClipIds(track, { enabled: false, startBeat: 8, endBeat: 16 })).toEqual(['before', 'edge', 'inside', 'after'])
  })

  it('hides hidden tracks unless hide view is on', () => {
    const shown = createTrack('instrument')
    const hidden = { ...createTrack('audio'), hidden: true }
    const project = projectWith(shown, hidden)
    expect(visibleTracks(project, false)).toEqual([shown])
    expect(visibleTracks(project, true)).toBe(project.tracks)
  })
})

describe('markers', () => {
  it('adds, moves, renames and deletes while keeping startBeat order', () => {
    let project = createEmptyProject()
    const verse = createMarker(16, 'Verse')
    const intro = createMarker(0, '  Intro ')
    project = addMarker(addMarker(project, verse), intro)
    expect(project.markers.map(marker => marker.name)).toEqual(['Intro', 'Verse'])
    expect(() => addMarker(project, verse)).toThrow(/duplicates/)
    project = moveMarker(project, intro.id, 24)
    expect(project.markers.map(marker => marker.name)).toEqual(['Verse', 'Intro'])
    expect(moveMarker(project, intro.id, 24)).toBe(project)
    expect(moveMarker(project, 'missing', 2)).toBe(project)
    expect(moveMarker(project, intro.id, -5).markers[0]).toMatchObject({ name: 'Intro', startBeat: 0 })
    project = renameMarker(project, verse.id, 'Chorus')
    expect(project.markers[0].name).toBe('Chorus')
    expect(renameMarker(project, verse.id, '   ')).toBe(project)
    expect(renameMarker(project, 'missing', 'x')).toBe(project)
    expect(deleteMarker(project, 'missing')).toBe(project)
    expect(deleteMarker(project, verse.id).markers.map(marker => marker.id)).toEqual([intro.id])
    expect(createMarker(4, '').name).toBe('Marker')
    expect(() => createMarker(NaN, 'x')).toThrow(/finite/)
  })
})

describe('validation of Logic-style fields', () => {
  const withTrack = (patch: Record<string, unknown>) => ({ ...createEmptyProject(), tracks: [{ ...createTrack('instrument'), ...patch }] })
  const withClip = (patch: Record<string, unknown>, kind: 'midi' | 'audio' = 'midi') =>
    withTrack({ clips: [{ ...(kind === 'midi' ? midi() : audio()), ...patch }] })

  it('fills defaults for version 1 and version 2 files saved without the new fields', () => {
    const legacy: Record<string, unknown> = { ...createTrack('instrument', 'pad'), id: 'old-pad', effects: { filter: 20000, reverb: 0, delay: 0 } }
    for (const key of ['instrumentParams', 'devices', 'soloSafe', 'enabled', 'armed', 'monitor', 'hidden', 'transpose', 'velocityOffset', 'keyLimit', 'velocityLimit', 'delayTicks']) delete legacy[key]
    const v2: Record<string, unknown> = { ...createEmptyProject(), tracks: [{ ...legacy, devices: [] }] }
    delete v2.markers
    const defaults = { soloSafe: false, enabled: true, armed: false, monitor: false, hidden: false, transpose: 0, velocityOffset: 0, keyLimit: [0, 127], velocityLimit: [1, 127], delayTicks: 0 }
    const v1 = validateProject({ ...createEmptyProject(), schemaVersion: 1, tracks: [legacy] })
    expect(v1.tracks[0]).toMatchObject(defaults)
    expect(v1.markers).toEqual([])
    expect(validateProject(v2).tracks[0]).toMatchObject(defaults)
    expect(validateProject(v2).markers).toEqual([])
  })

  it('round-trips every track field and rejects values outside the inspector ranges', () => {
    const project = withTrack({ soloSafe: true, enabled: false, armed: true, monitor: true, hidden: true, transpose: -96, velocityOffset: 99, keyLimit: [36, 36], velocityLimit: [1, 1], delayTicks: 1920, icon: 'piano' })
    expect(validateProject(project)).toEqual(project)
    expect(() => validateProject(withTrack({ transpose: 97 }))).toThrow(/transpose/)
    expect(() => validateProject(withTrack({ transpose: 1.5 }))).toThrow(/integer/)
    expect(() => validateProject(withTrack({ velocityOffset: -100 }))).toThrow(/velocity offset/)
    expect(() => validateProject(withTrack({ keyLimit: [60, 59] }))).toThrow(/key limit/)
    expect(() => validateProject(withTrack({ keyLimit: [0, 128] }))).toThrow(/key limit high/)
    expect(() => validateProject(withTrack({ keyLimit: [0] }))).toThrow(/pair/)
    expect(() => validateProject(withTrack({ velocityLimit: [0, 127] }))).toThrow(/velocity limit low/)
    expect(() => validateProject(withTrack({ delayTicks: -1921 }))).toThrow(/delay/)
    expect(() => validateProject(withTrack({ enabled: 'yes' }))).toThrow(/enabled/)
  })

  it('drops icons that are not short strings', () => {
    expect(validateProject(withTrack({ icon: 7 })).tracks[0]).not.toHaveProperty('icon')
    expect(validateProject(withTrack({ icon: '' })).tracks[0]).not.toHaveProperty('icon')
    expect(validateProject(withTrack({ icon: 'x'.repeat(41) })).tracks[0]).not.toHaveProperty('icon')
    expect(validateProject(withTrack({ icon: 'wave' })).tracks[0].icon).toBe('wave')
  })

  it('keeps valid optional clip fields, omits absent ones and validates ranges', () => {
    const full = withClip(REGION_FIELDS)
    expect(validateProject(full)).toEqual(full)
    expect(validateProject(withClip({})).tracks[0].clips[0]).toEqual(midi())
    expect(() => validateProject(withClip({ loop: 1 }))).toThrow(/loop/)
    expect(() => validateProject(withClip({ delayTicks: 2000 }))).toThrow(/delay/)
    expect(() => validateProject(withClip({ delayTicks: 0.5 }))).toThrow(/integer/)
    expect(() => validateProject(withClip({ swing: 101 }))).toThrow(/swing/)
    expect(() => validateProject(withClip({ transpose: -97 }))).toThrow(/transpose/)
    expect(() => validateProject(withClip({ velocity: 9.5 }))).toThrow(/integer/)
  })

  it('accepts only the supported quantize grids, snapping to the canonical value', () => {
    for (const grid of QUANTIZE_VALUES) expect(validateProject(withClip({ quantize: grid })).tracks[0].clips[0]).toMatchObject({ quantize: grid })
    expect((validateProject(withClip({ quantize: 0.3333333 })).tracks[0].clips[0] as MidiClip).quantize).toBe(1 / 3)
    expect(() => validateProject(withClip({ quantize: 0.3 }))).toThrow(/quantize/)
    expect(() => validateProject(withClip({ quantize: 0.751 }))).toThrow(/quantize/)
    expect(() => validateProject(withClip({ quantize: 'off' }))).toThrow(/quantize/)
  })

  it('drops MIDI-only fields from audio clips but keeps loop and delay', () => {
    const parsed = validateProject(withClip({ quantize: 0.3, swing: 500, transpose: 'up', velocity: 1000, loop: true, delayTicks: 5 }, 'audio')).tracks[0].clips[0]
    expect(parsed).toEqual({ ...audio(), loop: true, delayTicks: 5 })
    expect(parsed).not.toHaveProperty('quantize')
    expect(parsed).not.toHaveProperty('transpose')
  })

  it('validates markers, sorts them and rejects duplicate or clashing IDs', () => {
    const base = createEmptyProject()
    const track = { ...createTrack('instrument'), id: 'shared' }
    const sorted = validateProject({ ...base, markers: [{ id: 'm2', name: 'B', startBeat: 8 }, { id: 'm1', name: 'A', startBeat: 0 }] })
    expect(sorted.markers.map(marker => marker.id)).toEqual(['m1', 'm2'])
    expect(() => validateProject({ ...base, markers: [{ id: 'm', name: 'A', startBeat: 0 }, { id: 'm', name: 'B', startBeat: 1 }] })).toThrow(/duplicates/)
    expect(() => validateProject({ ...base, tracks: [track], markers: [{ id: 'shared', name: 'A', startBeat: 0 }] })).toThrow(/duplicates/)
    expect(() => validateProject({ ...base, markers: [{ id: 'm', name: '', startBeat: 0 }] })).toThrow(/name/)
    expect(() => validateProject({ ...base, markers: [{ id: 'm', name: 'A', startBeat: -1 }] })).toThrow(/position/)
    expect(() => validateProject({ ...base, markers: [{ id: 'm', name: 'A', startBeat: 10_000_001 }] })).toThrow(/position/)
    expect(() => validateProject({ ...base, markers: 'none' })).toThrow(/Markers/)
    expect(() => validateProject({ ...base, markers: ['m'] })).toThrow(/object/)
  })
})

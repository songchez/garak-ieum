import { EFFECT_DEFS, defaultParams, type ParamDef } from './devices'
import { DEFAULT_SAMPLE_RATE, isSampleRate, projectSampleRate } from './audioSettings'
import { instrumentDef, isInstrumentId } from './instruments'
import { midiEditorClip, midiSourceOffset } from './midiRegions'
import { joinSustain } from './sustain'
import { MAX_BEND_RANGE, controllerOrder, controllerSpec, isControllerKey, joinControllers, mapControllerBeats } from './controllers'
import { cloneNativePlugin, validateNativePlugin } from './nativePlugins'
import { DEFAULT_TIME_SIGNATURE, quarterNotesPerBar, validateTimeSignature } from './meter'
import { MAX_METER_BAR, MAX_METER_EVENTS, meterMapOf, normalizeMeterEvents } from './meterMap'
import { copyPitchDocument, hasPitchAudioEdits, validatePitchDocument } from '../devices/pitch-editor/state'
import { checkWarpClip, validateWarp } from '../devices/audio-warp/state'
import { checkTransposeClip, validateTranspose } from '../devices/region-pitch/state'
import { cloneWavetableState, combineWavetablePatch, createDefaultWavetablePatch, parseWavetableParams, splitWavetablePatch, type WavetablePatch } from '../devices/wavetable-synth/model'
import { AUDIO_CLIP_GAIN_MAX, FADE_CURVES, MIDI_CLIP_GAIN_MAX, crossfadeOverlaps, isFadeCurve } from './clipEnvelope.js'
import { QUANTIZE_VALUES, type FadeCurve, type Clip, type Device, type EffectDevice, type EffectType, type InstrumentId, type Marker, type MidiClip, type MidiNote, type Project, type SustainEvent, type ControllerKey, type ControllerPoint, type TempoPoint, type MeterEvent, PROJECT_SCHEMA_VERSION, type Track, type TrackInput, type TrackInputRoute, type TrackInputTap, type TrackMidiInput, type TrackMonitorMode, type TrackSend, type AutomationLane, type AutomationMode, type AutomationTarget, type TrackFreeze } from './types'
import { copyRoute, reconcileTrackRoutes } from './trackRouting'
import { MAX_TEMPO_POINTS, TEMPO_MAX, TEMPO_MIN, beatAfterSeconds, normalizeTempoPoints, spanSeconds, tempoMapOf, type Tempo } from './tempoMap'
// sends.ts imports this module too: only use its exports inside functions (no top-level reads).
import { SEND_LEVEL_MAX, copySend, reconcileSends } from './sends'
import { AUTOMATION_MODES, MAX_AUTOMATION_LANES, MAX_AUTOMATION_POINTS, copyAutomation, parseTargetKey, pruneAutomation, targetKey } from './automation'

let fallbackSequence = 0
/** First schema with Project.meterMap (time-signature changes). Renumber here if another format change lands first. */
const METER_MAP_SCHEMA = 18

/** Logic defaults (C-02): palette row 2 at hue 210° (audio) and 120° (instrument), hsl(h 58% 62%); returns at 270°. */
export const DEFAULT_TRACK_COLORS: Readonly<Record<Track['kind'], string>> = { audio: '#669ed6', instrument: '#66d666', return: '#9e66d6' }

/**
 * The schema this build writes (defined in core/types.ts). Freeze state (Track.freeze) arrived in
 * FREEZE_SCHEMA_VERSION (19, after the meter map at 18; docs/BOUNCE_FREEZE_STEMS.md).
 */
export { PROJECT_SCHEMA_VERSION }
export const FREEZE_SCHEMA_VERSION = 19

/** IDs describe editing objects; they are not security tokens. */
export function uid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  fallbackSequence += 1
  return `noct-${Date.now().toString(36)}-${fallbackSequence.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function defaultInstrumentParams(instrument: InstrumentId): Record<string, number> {
  return defaultParams(instrumentDef(instrument).params)
}

/** A single transaction replaces both the scalar values and the versioned sound design state. */
export function withWavetablePatch(track: Track, patch: WavetablePatch): Track {
  if (track.kind !== 'instrument' || track.instrument !== 'wavetable') throw new Error('IEUM WAVE 악기 트랙이 필요합니다.')
  const { params, state } = splitWavetablePatch(patch)
  return { ...track, instrumentParams: params, instrumentState: state }
}

/** Choosing a builtin instrument clears the VST3 source override and previous sound-design state. */
export function withInstrument(track: Track, instrument: InstrumentId): Track {
  if (!isInstrumentId(instrument)) throw new Error('알 수 없는 악기입니다.')
  const { instrumentState: _previous, pluginInstrument: _previousPlugin, ...rest } = track
  const next = { ...rest, instrument, instrumentParams: defaultInstrumentParams(instrument) }
  return instrument === 'wavetable' && track.kind === 'instrument'
    ? withWavetablePatch(next, createDefaultWavetablePatch()) : next
}

export function createDevice(type: EffectType, params: Partial<Record<string, number>> = {}): EffectDevice {
  const values = defaultParams(EFFECT_DEFS[type].params)
  for (const [key, value] of Object.entries(params)) if (value !== undefined) values[key] = value
  return { id: uid(), type, enabled: true, params: values }
}

/** A copy with a new editing ID; VST3 state and parameters are copied, never shared. */
export function cloneDevice(device: Device, newId = uid()): Device {
  return device.type === 'vst3' ? cloneNativePlugin(device, newId) : { ...device, id: newId, params: { ...device.params } }
}

/** Moves a device by `offset` slots, clamped to the chain; returns the same track when nothing changes. */
export function moveDevice(track: Track, deviceId: string, offset: number): Track {
  const from = track.devices.findIndex(device => device.id === deviceId)
  if (from < 0 || !Number.isFinite(offset)) return track
  const to = Math.max(0, Math.min(track.devices.length - 1, from + Math.trunc(offset)))
  if (to === from) return track
  const devices = [...track.devices]
  const [device] = devices.splice(from, 1)
  devices.splice(to, 0, device)
  return { ...track, devices }
}

export function createTrack(kind: Track['kind'], instrument: InstrumentId = 'keys'): Track {
  const def = instrumentDef(instrument)
  return {
    id: uid(),
    name: kind === 'audio' ? 'Audio track' : kind === 'return' ? '리턴' : def.name,
    kind,
    instrument,
    color: kind === 'instrument' ? instrumentDef(instrument).color : DEFAULT_TRACK_COLORS[kind],
    volume: 0.7,
    pan: 0,
    mute: false,
    solo: false,
    soloSafe: false,
    enabled: true,
    armed: false,
    monitor: false,
    hidden: false,
    transpose: 0,
    velocityOffset: 0,
    keyLimit: [0, 127],
    velocityLimit: [1, 127],
    delayTicks: 0,
    clips: [],
    instrumentParams: defaultInstrumentParams(instrument),
    ...(kind === 'instrument' && instrument === 'wavetable' ? { instrumentState: splitWavetablePatch(createDefaultWavetablePatch()).state } : {}),
    devices: [],
  }
}

export function createEmptyProject(): Project {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: uid(),
    name: 'Untitled session',
    bpm: 96,
    sampleRate: DEFAULT_SAMPLE_RATE,
    timeSignature: { ...DEFAULT_TIME_SIGNATURE },
    beatsPerBar: 4,
    meterMap: [{ bar: 0, ...DEFAULT_TIME_SIGNATURE }],
    lengthBeats: 64,
    masterVolume: 0.8,
    loop: { enabled: false, startBeat: 0, endBeat: 32 },
    tracks: [],
    markers: [],
  }
}

/** A ready-to-edit guitar signal chain. Opening a track never enables an input device. */
export function createGuitarTrack(): Track {
  return {
    ...createTrack('audio'),
    name: '기타',
    icon: 'guitar',
    devices: [createDevice('guitar-rig')],
  }
}

function note(pitch: number, start: number, duration: number, velocity = 0.7): MidiNote {
  return { id: uid(), pitch, start, duration, velocity }
}

function midiClip(name: string, startBeat: number, lengthBeats: number, notes: MidiNote[]): MidiClip {
  return { id: uid(), kind: 'midi', name, startBeat, lengthBeats, gain: 1, notes }
}

/** Demo tracks keep their instrument colors rather than the Logic default (C-02). */
function demoTrack(instrument: InstrumentId): Track {
  return { ...createTrack('instrument', instrument), color: instrumentDef(instrument).color }
}

/** An original eight-bar sketch. All sound comes from the built-in instruments. */
export function createDemoProject(): Project {
  const project = createEmptyProject()
  project.name = 'Midnight, somewhere'
  project.lengthBeats = 32
  project.loop = { enabled: true, startBeat: 0, endBeat: 32 }

  const drums = demoTrack('drums')
  drums.name = 'Pocket drums'
  drums.volume = 0.67
  for (let section = 0; section < 4; section += 1) {
    const notes: MidiNote[] = []
    for (let bar = 0; bar < 2; bar += 1) {
      const offset = bar * 4
      notes.push(note(36, offset, 0.22, 0.87), note(36, offset + 2.5, 0.22, 0.69))
      notes.push(note(38, offset + 1, 0.18, 0.61), note(38, offset + 3, 0.18, 0.72))
      if (bar === 1) notes.push(note(36, offset + 3.5, 0.15, 0.48))
    }
    drums.clips.push(midiClip(section === 3 ? 'Pocket / turn' : 'Pocket', section * 8, 8, notes))
  }

  const hats = demoTrack('drums')
  hats.name = 'After-hours hats'
  hats.color = '#d9b45a'
  hats.volume = 0.35
  hats.pan = 0.16
  for (let section = 0; section < 4; section += 1) {
    const notes = Array.from({ length: 16 }, (_, index) =>
      note(index === 15 ? 46 : 42, index * 0.5 + (index % 2 ? 0.055 : 0), index === 15 ? 0.32 : 0.08,
        index % 2 ? 0.36 : 0.57),
    )
    hats.clips.push(midiClip('Soft shuffle', section * 8, 8, notes))
  }

  const bass = demoTrack('bass')
  bass.name = 'Sub currents'
  bass.volume = 0.55
  const roots = [40, 36, 43, 38]
  for (let section = 0; section < 4; section += 1) {
    const root = roots[section]
    bass.clips.push(midiClip(['E / grounded', 'C / soften', 'G / open', 'D / return'][section], section * 8, 8, [
      note(root, 0, 1.35, 0.78), note(root, 1.5, 0.4, 0.54),
      note(root + 7, 2.25, 0.65, 0.61), note(root + 12, 3.25, 0.5, 0.47),
      note(root, 4, 1.35, 0.74), note(root, 5.5, 0.4, 0.5),
      note(root + 7, 6.25, 0.65, 0.6), note(section === 3 ? 39 : root + 2, 7.25, 0.5, 0.43),
    ]))
  }

  const keys = demoTrack('keys')
  keys.name = 'Midnight keys'
  keys.volume = 0.5
  keys.pan = -0.12
  keys.devices = [createDevice('reverb', { amount: 0.2, size: 0, tone: 20000 })]
  const chords = [[52, 55, 59, 62], [48, 52, 55, 59], [47, 50, 54, 59], [50, 54, 57, 60]]
  const chordNames = ['Em7 / warm light', 'Cmaj7 / a little space', 'Gmaj7 / skyline', 'D7 / coming home']
  chords.forEach((chord, section) => {
    const notes = chord.flatMap((pitch, voice) => [
      note(pitch, voice * 0.025, 3.15, 0.48 + voice * 0.025),
      note(pitch, 4.5 + voice * 0.02, 2.9, 0.41 + voice * 0.025),
    ])
    keys.clips.push(midiClip(chordNames[section], section * 8, 8, notes))
  })

  const pluck = demoTrack('pluck')
  pluck.name = 'Glass echoes'
  pluck.volume = 0.3
  pluck.pan = 0.23
  pluck.devices = [
    createDevice('delay', { amount: 0.22, time: 0.75, feedback: 0.32, tone: 3800 }),
    createDevice('reverb', { amount: 0.17, size: 0, tone: 20000 }),
  ]
  const phrases = [[71, 67, 66, 64], [71, 67, 64, 62], [74, 71, 69, 66], [69, 66, 64, 62]]
  phrases.forEach((pitches, section) => {
    const notes = pitches.map((pitch, index) => note(pitch, [0.75, 2.5, 4.75, 6.5][index], 0.6, 0.48))
    pluck.clips.push(midiClip('Small reflections', section * 8, 8, notes))
  })

  const pad = demoTrack('pad')
  pad.name = 'Slow bloom'
  pad.volume = 0.23
  pad.pan = -0.2
  pad.devices = [
    createDevice('filter', { cutoff: 4200, resonance: 0.65, mode: 0 }),
    createDevice('reverb', { amount: 0.3, size: 0, tone: 20000 }),
  ]
  chords.forEach((chord, section) => {
    pad.clips.push(midiClip('Night air', section * 8, 8,
      [chord[0] + 12, chord[2] + 12].map(pitch => note(pitch, 0, 7.85, 0.4))))
  })

  project.tracks = [drums, hats, bass, keys, pluck, pad]
  return project
}

/** Duplicate editing IDs, while continuing to reference the same original audio asset. */
export function duplicateClip(clip: Clip, startBeat = clip.startBeat + clip.lengthBeats): Clip {
  if (!Number.isFinite(startBeat) || startBeat < 0) throw new Error('Clip position must be a non-negative number.')
  const base = { ...clip, id: uid(), startBeat }
  return clip.kind === 'midi'
    ? { ...base, kind: 'midi', notes: clip.notes.map(value => ({ ...value, id: uid() })) }
    : { ...clip, id: base.id, startBeat, ...(clip.pitch ? { pitch: copyPitchDocument(clip.pitch) } : {}) }
}

/** `beat` is an absolute project beat. Each MIDI half keeps an independent, recoverable source. */
export function splitClip(clip: Clip, beat: number, tempo: Tempo): Clip[] {
  if (!Number.isFinite(beat)) throw new Error('Split position must be a finite number.')
  checkTempo(tempo)
  const endBeat = clip.startBeat + clip.lengthBeats
  if (beat <= clip.startBeat || beat >= endBeat) return [clip]

  const cut = beat - clip.startBeat
  const rightLength = clip.lengthBeats - cut
  const rightLoop = clip.loopLengthBeats === undefined ? {} : { loopLengthBeats: clip.loopLengthBeats - cut }
  if (clip.kind === 'audio') {
    const leftSeconds = spanSeconds(tempo, clip.startBeat, beat)
    const rightSeconds = spanSeconds(tempo, beat, endBeat)
    return [
      { ...clip, lengthBeats: cut, fadeIn: Math.min(clip.fadeIn, leftSeconds), fadeOut: 0 },
      {
        ...clip,
        id: uid(),
        startBeat: beat,
        lengthBeats: rightLength,
        ...rightLoop,
        offsetSeconds: clip.offsetSeconds + leftSeconds,
        fadeIn: 0,
        fadeOut: Math.min(clip.fadeOut, rightSeconds),
        ...(clip.pitch ? { pitch: copyPitchDocument(clip.pitch) } : {}),
      },
    ]
  }

  return [
    { ...clip, lengthBeats: cut },
    { ...clip, id: uid(), startBeat: beat, lengthBeats: rightLength, ...rightLoop,
      sourceOffsetBeats: midiSourceOffset(clip) + cut, notes: clip.notes.map(value => ({ ...value, id: uid() })) },
  ]
}

function checkTempo(tempo: Tempo): void {
  if (typeof tempo === 'number' && (!Number.isFinite(tempo) || tempo <= 0)) throw new Error('Tempo must be greater than zero.')
}

/** Shortest clip a trim can leave: one 1/64 note. */
export const MIN_CLIP_BEATS = 0.0625
const EPSILON = 1e-9

/** Explicitly materializes the visible note window (used when joining regions). */
export function cropNotesToClip(clip: MidiClip): MidiClip {
  return midiEditorClip(clip)
}

/**
 * Moves the left edge while keeping source content and the right edge in place. MIDI notes
 * survive outside the visible window. Extending before the MIDI source inserts leading
 * silence by rebasing all source notes; audio can never read before the original file.
 */
export function trimClipStart(clip: Clip, newStartBeat: number, tempo: Tempo): Clip {
  if (!Number.isFinite(newStartBeat)) throw new Error('Trim position must be a finite number.')
  checkTempo(tempo)
  const end = clip.startBeat + clip.lengthBeats
  let start = Math.min(Math.max(0, newStartBeat), end - MIN_CLIP_BEATS)
  if (clip.kind === 'audio') start = Math.max(start, beatAfterSeconds(tempo, clip.startBeat, -clip.offsetSeconds))
  const delta = start - clip.startBeat
  if (Math.abs(delta) < EPSILON) return clip
  const lengthBeats = end - start
  const loop = clip.loopLengthBeats === undefined ? {} : { loopLengthBeats: Math.max(lengthBeats, clip.loopLengthBeats - delta) }
  if (clip.kind === 'audio') {
    const seconds = spanSeconds(tempo, start, end)
    return {
      ...clip, startBeat: start, lengthBeats,
      ...loop,
      offsetSeconds: Math.max(0, clip.offsetSeconds + spanSeconds(tempo, clip.startBeat, start)),
      fadeIn: Math.min(clip.fadeIn, seconds), fadeOut: Math.min(clip.fadeOut, seconds),
    }
  }
  const offset = midiSourceOffset(clip) + delta
  const { sourceOffsetBeats: _offset, ...source } = clip
  return { ...source, startBeat: start, lengthBeats, ...loop,
    ...(offset > 0 ? { sourceOffsetBeats: offset } : {}),
    notes: offset < 0 ? clip.notes.map(value => ({ ...value, start: value.start - offset })) : clip.notes,
    ...(offset < 0 && clip.sustain ? { sustain: clip.sustain.map(event => ({ ...event, beat: event.beat - offset })) } : {}),
    ...(offset < 0 && clip.controllers ? { controllers: mapControllerBeats(clip, beat => beat - offset) } : {}) }
}

/** Moves the right edge. `maxLengthBeats` lets callers clamp audio to the source length. */
export function trimClipEnd(clip: Clip, newEndBeat: number, maxLengthBeats = Infinity): Clip {
  if (!Number.isFinite(newEndBeat)) throw new Error('Trim position must be a finite number.')
  const lengthBeats = Math.max(MIN_CLIP_BEATS, Math.min(maxLengthBeats, newEndBeat - clip.startBeat))
  return Math.abs(lengthBeats - clip.lengthBeats) < EPSILON ? clip : { ...clip, lengthBeats,
    ...(clip.loopLengthBeats === undefined ? {} : { loopLengthBeats: Math.max(lengthBeats, clip.loopLengthBeats) }) }
}

/** Set a manual repeat endpoint in absolute project beats. Dragging back to the source end turns looping off. */
export function setClipLoopEnd(clip: Clip, endBeat: number): Clip {
  if (!Number.isFinite(endBeat)) throw new Error('Loop end must be a finite number.')
  const span = endBeat - clip.startBeat
  if (span <= clip.lengthBeats + EPSILON) {
    const { loopLengthBeats: _span, ...base } = clip
    return { ...base, loop: false }
  }
  if (span > 10_000_000) throw new Error('Loop length exceeds the project position limit.')
  return clip.loop && clip.loopLengthBeats === span ? clip : { ...clip, loop: true, loopLengthBeats: span }
}

export function moveClipToPlayhead(clip: Clip, beat: number): Clip {
  if (!Number.isFinite(beat)) throw new Error('Clip position must be a finite number.')
  const startBeat = Math.max(0, beat)
  return startBeat === clip.startBeat ? clip : { ...clip, startBeat }
}

/** Shifts every note by `semitones`; notes that would leave 0–127 are clamped. */
export function transposeClip(clip: MidiClip, semitones: number): MidiClip {
  if (!semitones) return clip
  return { ...clip, notes: clip.notes.map(value => ({ ...value, pitch: Math.max(0, Math.min(127, value.pitch + semitones)) })) }
}

/**
 * Joins clips from one track into one clip that keeps the earliest clip's ID and name.
 * MIDI: spans min start..max end, notes re-based (each source cropped to its window).
 * Audio: only when every clip reads the same asset with continuous source offsets
 * (within 1 ms) and no gap between them; otherwise null.
 */
export function joinClips(clips: Clip[], tempo: Tempo): Clip | null {
  if (clips.length < 2 || !clips.every(clip => clip.kind === clips[0].kind)) return null
  const sorted = [...clips].sort((a, b) => a.startBeat - b.startBeat)
  const first = sorted[0]
  const startBeat = first.startBeat
  const endBeat = Math.max(...sorted.map(clip => clip.startBeat + clip.lengthBeats))
  if (first.kind === 'midi') {
    const notes = (sorted as MidiClip[]).flatMap(clip => cropNotesToClip(clip).notes.map(value => ({ ...value, start: value.start + clip.startBeat - startBeat })))
    const { sourceOffsetBeats: _offset, sustain: _sustain, controllers: _controllers, ...base } = first
    const sustain = joinSustain(sorted as MidiClip[], startBeat)
    const controllers = joinControllers(sorted as MidiClip[], startBeat)
    return { ...base, startBeat, lengthBeats: endBeat - startBeat, notes, ...(sustain.length ? { sustain } : {}), ...(controllers ? { controllers } : {}),
      ...(first.loopLengthBeats === undefined ? {} : { loopLengthBeats: Math.max(endBeat - startBeat, first.loopLengthBeats) }) }
  }
  const audio = sorted as Extract<Clip, { kind: 'audio' }>[]
  let reach = first.startBeat + first.lengthBeats
  for (const clip of audio.slice(1)) {
    if (clip.assetId !== first.assetId) return null
    if (clip.startBeat > reach + 1e-6) return null
    const expected = first.offsetSeconds + spanSeconds(tempo, startBeat, clip.startBeat)
    if (Math.abs(clip.offsetSeconds - expected) > 1e-3) return null
    reach = Math.max(reach, clip.startBeat + clip.lengthBeats)
  }
  const last = audio.reduce((a, b) => (b.startBeat + b.lengthBeats >= a.startBeat + a.lengthBeats ? b : a))
  const { fadeOutCurve: _curve, ...head } = first
  return { ...head, lengthBeats: endBeat - startBeat, fadeOut: last.fadeOut, ...(last.fadeOutCurve ? { fadeOutCurve: last.fadeOutCurve } : {}),
    ...(first.loopLengthBeats === undefined ? {} : { loopLengthBeats: Math.max(endBeat - startBeat, first.loopLengthBeats) }) }
}

/** Fresh arrays so a copy never shares the channel list with its source. */
export const copyTrackInput = (input: TrackInput): TrackInput => ({ channels: [...input.channels] as TrackInput['channels'], ...(input.label === undefined ? {} : { label: input.label }) })

/** A deep copy with new track, clip, note and device IDs; audio assets stay shared. */
export function duplicateTrack(track: Track): Track {
  const { freeze: _freeze, ...unfrozen } = track
  const copy: Track = {
    ...unfrozen,
    id: uid(),
    name: `${track.name} 복사본`.slice(0, 512),
    ...(track.input ? { input: copyTrackInput(track.input) } : {}),
    ...(track.inputRoute ? { inputRoute: copyRoute(track.inputRoute) } : {}),
    ...(track.sends ? { sends: track.sends.map(copySend) } : {}),
    instrumentParams: { ...track.instrumentParams },
    ...(track.instrumentState ? { instrumentState: cloneWavetableState(track.instrumentState) } : {}),
    devices: track.devices.map(device => cloneDevice(device)),
    ...(track.pluginInstrument ? { pluginInstrument: cloneNativePlugin(track.pluginInstrument, uid()) } : {}),
    clips: track.clips.map(clip => duplicateClip(clip, clip.startBeat)),
  }
  return withCopiedAutomation(track, copy)
}

/** Lanes follow the copied devices; a copy without lanes carries no automation field. */
function withCopiedAutomation(source: Track, copy: Track): Track {
  const { automation: _lanes, ...rest } = copy
  const automation = copyAutomation(source, copy)
  return automation ? { ...rest, automation } : rest
}

/** Logic "New Track With Duplicate Settings": every setting but no clips; arm and monitor stay off.
 * The input and monitor mode are settings and carry over, except that `in` (the I flag) becomes `off`. */
export function duplicateTrackSettings(track: Track): Track {
  const { freeze: _freeze, ...unfrozen } = track
  const copy: Track = {
    ...unfrozen,
    id: uid(),
    armed: false,
    monitor: false,
    ...(track.monitorMode === 'in' ? { monitorMode: 'off' as const } : {}),
    ...(track.input ? { input: copyTrackInput(track.input) } : {}),
    ...(track.inputRoute ? { inputRoute: copyRoute(track.inputRoute) } : {}),
    ...(track.sends ? { sends: track.sends.map(copySend) } : {}),
    keyLimit: [...track.keyLimit],
    velocityLimit: [...track.velocityLimit],
    instrumentParams: { ...track.instrumentParams },
    ...(track.instrumentState ? { instrumentState: cloneWavetableState(track.instrumentState) } : {}),
    devices: track.devices.map(device => cloneDevice(device)),
    ...(track.pluginInstrument ? { pluginInstrument: cloneNativePlugin(track.pluginInstrument, uid()) } : {}),
    clips: [],
  }
  return withCopiedAutomation(track, copy)
}

/** Grows to the last source/manual-loop end; continuous loops never grow the project. */
export function fitProjectLength(project: Project): Project {
  const end = Math.max(0, ...project.tracks.flatMap(track => track.clips.map(clip => clip.startBeat + (clip.loop ? clip.loopLengthBeats ?? clip.lengthBeats : clip.lengthBeats))))
  const lengthBeats = Math.max(project.lengthBeats, meterMapOf(project).ceilBarStart(end))
  return lengthBeats === project.lengthBeats ? project : { ...project, lengthBeats }
}

export type DragMode = 'overlap' | 'noOverlap' | 'crossfade'

/** Cuts `piece` so it no longer overlaps [start, end); [] removes it, two clips means it was split around. */
function cutAround(piece: Clip, start: number, end: number, tempo: Tempo): Clip[] {
  const pieceEnd = piece.startBeat + piece.lengthBeats
  if (end <= piece.startBeat + EPSILON || start >= pieceEnd - EPSILON) return [piece]
  const coversStart = start <= piece.startBeat + EPSILON
  const coversEnd = end >= pieceEnd - EPSILON
  if (coversStart && coversEnd) return []
  if (coversStart) return pieceEnd - end < MIN_CLIP_BEATS ? [] : [trimClipStart(piece, end, tempo)]
  if (coversEnd) return start - piece.startBeat < MIN_CLIP_BEATS ? [] : [trimClipEnd(piece, start)]
  const [left, right] = splitClip(piece, start, tempo)
  return [left, ...cutAround(right, start, end, tempo)]
}

/**
 * Logic Drag mode (R-05). `noOverlap` trims, splits or removes the clips on `trackIds` that a moved
 * clip now covers; moved clips themselves are never changed. `overlap` returns the project as is.
 * `crossfade` (Logic X-Fade) crossfades partial audio overlaps instead of cutting them.
 */
export function applyDragMode(project: Project, trackIds: readonly string[], movedClipIds: readonly string[], mode: DragMode): Project {
  if (mode === 'overlap' || movedClipIds.length === 0) return project
  const moved = new Set(movedClipIds)
  let changed = false
  const tracks = project.tracks.map(input => {
    if (!trackIds.includes(input.id)) return input
    // X-Fade: partial audio overlaps become crossfades; covered regions and MIDI still resolve like noOverlap.
    const track = mode === 'crossfade' ? crossfadeOverlaps(input, moved, tempoMapOf(project)) : input
    if (track !== input) changed = true
    const crossfaded = (mover: Clip, clip: Clip) => mode === 'crossfade' && mover.kind === 'audio' && clip.kind === 'audio'
      && Math.min(mover.startBeat, clip.startBeat) < Math.max(mover.startBeat, clip.startBeat) - EPSILON
      && Math.abs(mover.startBeat + mover.lengthBeats - (clip.startBeat + clip.lengthBeats)) > EPSILON
      && (mover.startBeat < clip.startBeat) === (mover.startBeat + mover.lengthBeats < clip.startBeat + clip.lengthBeats)
    const movers = track.clips.filter(clip => moved.has(clip.id))
    if (movers.length === 0) return track
    let trackChanged = false
    const clips = track.clips.flatMap(clip => {
      if (moved.has(clip.id)) return [clip]
      let pieces = [clip]
      for (const mover of movers) {
        pieces = pieces.flatMap(piece => crossfaded(mover, piece) ? [piece] : cutAround(piece, mover.startBeat, mover.startBeat + mover.lengthBeats, tempoMapOf(project)))
      }
      if (pieces.length !== 1 || pieces[0] !== clip) trackChanged = true
      return pieces
    })
    if (!trackChanged) return track
    changed = true
    return { ...track, clips }
  })
  return changed ? { ...project, tracks } : project
}

export interface ClipStartTrim {
  trackId: string
  clipId: string
  newStart: number
}

/** Trims a selection in one project edit, then resolves overlaps with every selected clip protected. */
export function trimClipStarts(project: Project, trims: readonly ClipStartTrim[], mode: DragMode = 'overlap'): Project {
  const requests = new Map<string, Map<string, number>>()
  for (const trim of trims) {
    let trackRequests = requests.get(trim.trackId)
    if (!trackRequests) requests.set(trim.trackId, trackRequests = new Map())
    trackRequests.set(trim.clipId, trim.newStart)
  }
  const trackIds = new Set<string>(), clipIds: string[] = []
  let changed = false
  const tracks = project.tracks.map(track => {
    const own = requests.get(track.id)
    if (!own) return track
    let trackChanged = false
    const clips = track.clips.map(clip => {
      if (!own.has(clip.id)) return clip
      trackIds.add(track.id)
      clipIds.push(clip.id)
      const next = trimClipStart(clip, own.get(clip.id)!, tempoMapOf(project))
      if (next !== clip) trackChanged = true
      return next
    })
    if (!trackChanged) return track
    changed = true
    return { ...track, clips }
  })
  return applyDragMode(changed ? { ...project, tracks } : project, [...trackIds], clipIds, mode)
}

/** Inserts after the track with `afterId`; null or an unknown ID appends at the end (T-04). */
export function insertTracks(project: Project, afterId: string | null, tracks: readonly Track[]): Project {
  if (tracks.length === 0) return project
  const index = afterId === null ? -1 : project.tracks.findIndex(track => track.id === afterId)
  const at = index < 0 ? project.tracks.length : index + 1
  return { ...project, tracks: [...project.tracks.slice(0, at), ...tracks, ...project.tracks.slice(at)] }
}

/** Clip IDs a track-header click selects: those inside the cycle when it is on, otherwise all (A-01). */
export function cycleClipIds(track: Track, loop: Project['loop']): string[] {
  const clips = loop.enabled
    ? track.clips.filter(clip => clip.startBeat < loop.endBeat && clip.startBeat + clip.lengthBeats > loop.startBeat)
    : track.clips
  return clips.map(clip => clip.id)
}

/** Tracks shown in the Tracks area: hidden ones only appear while hide view is on (H-22). */
export function visibleTracks(project: Project, hideView: boolean): Track[] {
  return hideView ? project.tracks : project.tracks.filter(track => !track.hidden)
}

const MAX_MARKER_BEAT = 10_000_000

function sortMarkers(markers: readonly Marker[]): Marker[] {
  return [...markers].sort((a, b) => a.startBeat - b.startBeat)
}

export function createMarker(startBeat: number, name: string): Marker {
  if (!Number.isFinite(startBeat)) throw new Error('Marker position must be a finite number.')
  const trimmed = name.trim().slice(0, 512)
  return { id: uid(), name: trimmed || 'Marker', startBeat: Math.max(0, Math.min(MAX_MARKER_BEAT, startBeat)) }
}

export function addMarker(project: Project, marker: Marker): Project {
  if (project.markers.some(value => value.id === marker.id)) throw new Error('Marker ID duplicates another marker.')
  return { ...project, markers: sortMarkers([...project.markers, marker]) }
}

export function moveMarker(project: Project, markerId: string, startBeat: number): Project {
  if (!Number.isFinite(startBeat)) throw new Error('Marker position must be a finite number.')
  const beat = Math.max(0, Math.min(MAX_MARKER_BEAT, startBeat))
  const marker = project.markers.find(value => value.id === markerId)
  if (!marker || marker.startBeat === beat) return project
  return { ...project, markers: sortMarkers(project.markers.map(value => (value.id === markerId ? { ...value, startBeat: beat } : value))) }
}

export function renameMarker(project: Project, markerId: string, name: string): Project {
  const trimmed = name.trim().slice(0, 512)
  const marker = project.markers.find(value => value.id === markerId)
  if (!marker || !trimmed || marker.name === trimmed) return project
  return { ...project, markers: project.markers.map(value => (value.id === markerId ? { ...value, name: trimmed } : value)) }
}

export function deleteMarker(project: Project, markerId: string): Project {
  if (!project.markers.some(value => value.id === markerId)) return project
  return { ...project, markers: project.markers.filter(value => value.id !== markerId) }
}

type RecordValue = Record<string, unknown>

/** Schema 19 freeze record; undefined when malformed (the track then plays live and can be frozen again). */
function parseFreeze(value: unknown): TrackFreeze | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as RecordValue
  const { assetId, signature, tailSeconds, sampleRate } = record
  if (typeof assetId !== 'string' || !assetId || assetId.length > 200) return undefined
  if (typeof signature !== 'string' || !signature || signature.length > 200) return undefined
  if (typeof tailSeconds !== 'number' || !Number.isFinite(tailSeconds) || tailSeconds < 0 || tailSeconds > 3600) return undefined
  if (!isSampleRate(sampleRate)) return undefined
  return { assetId, signature, tailSeconds, sampleRate }
}

function object(value: unknown, path: string): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`)
  }
  return value as RecordValue
}

function text(value: unknown, path: string, maxLength = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`${path} must be a non-empty string of at most ${maxLength} characters.`)
  }
  return value
}

function number(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${path} must be a finite number between ${min} and ${max}.`)
  }
  return value
}

function integer(value: unknown, path: string, min: number, max: number): number {
  const result = number(value, path, min, max)
  if (!Number.isInteger(result)) throw new Error(`${path} must be an integer.`)
  return result
}

function flag(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be true or false.`)
  return value
}

/** Fields added after the first release: absent means the default (older saved files). */
function optional<T>(value: unknown, fallback: T, parse: (value: unknown) => T): T {
  return value === undefined ? fallback : parse(value)
}

function range(value: unknown, path: string, min: number, max: number): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${path} must be a [low, high] pair.`)
  const low = integer(value[0], `${path} low`, min, max)
  const high = integer(value[1], `${path} high`, min, max)
  if (low > high) throw new Error(`${path} low must not exceed its high value.`)
  return [low, high]
}

const MONITOR_MODES: readonly TrackMonitorMode[] = ['off', 'auto', 'in']

/** Physical channels are device indices: one (mono) or two distinct ones (stereo, not necessarily adjacent). */
function parseTrackInput(value: unknown, path: string): TrackInput {
  const source = object(value, path)
  const channels = source.channels
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2) throw new Error(`${path} channels must list one or two input channels.`)
  const parsed = channels.map((channel, index) => integer(channel, `${path} channel ${index + 1}`, 0, 255))
  if (parsed.length === 2 && parsed[0] === parsed[1]) throw new Error(`${path} channels must be two different channels.`)
  return {
    channels: parsed as TrackInput['channels'],
    ...(source.label === undefined ? {} : { label: text(source.label, `${path} label`, 128) }),
  }
}

const INPUT_TAPS: readonly TrackInputTap[] = ['preFx', 'postFx', 'postFader']

function parseTrackInputRoute(value: unknown, path: string): TrackInputRoute {
  const source = object(value, path)
  if (source.kind === 'master') return { kind: 'master' }
  if (source.kind === 'none') return { kind: 'none' }
  if (source.kind !== 'track') throw new Error(`${path} must name a track, the master or none.`)
  if (!INPUT_TAPS.includes(source.tap as TrackInputTap)) throw new Error(`${path} tap must be preFx, postFx or postFader.`)
  return { kind: 'track', trackId: text(source.trackId, `${path} track ID`, 200), tap: source.tap as TrackInputTap }
}

/** docs/MIDI_RECORDING.md: an optional field, so no schema bump; older readers ignore it. */
function parseTrackMidiInput(value: unknown, path: string): TrackMidiInput {
  const input = object(value, path)
  if (input.source !== 'all' && input.source !== 'none' && input.source !== 'device') throw new Error(`${path} source must be all, none or device.`)
  if (input.source === 'device' && input.deviceId === undefined) throw new Error(`${path} needs a device.`)
  return {
    source: input.source,
    ...(input.source === 'device' ? { deviceId: text(input.deviceId, `${path} device`, 512) } : {}),
    ...(input.source === 'device' && input.deviceName !== undefined ? { deviceName: text(input.deviceName, `${path} device name`, 512) } : {}),
    ...(input.channel === undefined ? {} : { channel: integer(input.channel, `${path} channel`, 1, 16) }),
  }
}

/** Schema 15 sends: one per return, level 0…2. Return IDs are checked after every track is read. */
function parseSends(value: unknown, path: string): TrackSend[] {
  const seen = new Set<string>()
  return list(value, `${path} sends`, 256).map((input, index): TrackSend => {
    const sendPath = `${path}, send ${index + 1}`
    const send = object(input, sendPath)
    const returnId = text(send.returnId, `${sendPath} return ID`, 200)
    if (seen.has(returnId)) throw new Error(`${sendPath} repeats a return track.`)
    seen.add(returnId)
    const pre = send.pre === undefined ? false : flag(send.pre, `${sendPath} pre-fader`)
    return { returnId, level: number(send.level, `${sendPath} level`, 0, SEND_LEVEL_MAX), ...(pre ? { pre: true } : {}) }
  })
}

function monitorMode(value: unknown, path: string): TrackMonitorMode {
  if (!MONITOR_MODES.includes(value as TrackMonitorMode)) throw new Error(`${path} must be off, auto or in.`)
  return value as TrackMonitorMode
}

function quantize(value: unknown, path: string): number {
  const parsed = number(value, path, 0, 4)
  const match = QUANTIZE_VALUES.find(grid => Math.abs(grid - parsed) <= 1e-6)
  if (match === undefined) throw new Error(`${path} must be one of the supported quantize grids.`)
  return match
}

/** CC64 lane (schema 13): sorted, unique beats, integer values 0…127. */
function sustainEvents(value: unknown, path: string, version: number): SustainEvent[] {
  if (version < 13) throw new Error(`${path} sustain pedal data requires project schema version 13 or later.`)
  let previous = -1
  return list(value, `${path} sustain pedal`, 100_000).map((input, index): SustainEvent => {
    const eventPath = `${path}, sustain event ${index + 1}`
    const event = object(input, eventPath)
    const beat = number(event.beat, `${eventPath} position`, 0, 10_000_000)
    if (beat <= previous) throw new Error(`${eventPath} must come after the previous sustain event.`)
    previous = beat
    return { beat, value: integer(event.value, `${eventPath} value`, 0, 127) }
  })
}

/** Controller lanes (schema 16): known keys, each sorted with unique beats and integer values in the lane's range. */
function controllerLanes(value: unknown, path: string, version: number): Partial<Record<ControllerKey, ControllerPoint[]>> {
  if (version < 16) throw new Error(`${path} controller data requires project schema version 16 or later.`)
  const source = object(value, `${path} controllers`)
  const keys = Object.keys(source)
  if (keys.length > 132) throw new Error(`${path} has too many controller lanes.`)
  const result: Partial<Record<ControllerKey, ControllerPoint[]>> = {}
  for (const key of keys.sort((a, b) => isControllerKey(a) && isControllerKey(b) ? controllerOrder(a, b) : 0)) {
    if (!isControllerKey(key)) throw new Error(`${path} has an unknown controller lane: ${key.slice(0, 40)}.`)
    const spec = controllerSpec(key)
    let previous = -1
    const points = list(source[key], `${path} ${key} lane`, 200_000).map((input, index): ControllerPoint => {
      const pointPath = `${path}, ${key} event ${index + 1}`
      const point = object(input, pointPath)
      const beat = number(point.beat, `${pointPath} position`, 0, 10_000_000)
      if (beat <= previous) throw new Error(`${pointPath} must come after the previous event.`)
      previous = beat
      return { beat, value: integer(point.value, `${pointPath} value`, spec.min, spec.max) }
    })
    if (points.length) result[key] = points
  }
  return result
}

function list(value: unknown, path: string, maxLength: number): unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) {
    throw new Error(`${path} must be an array with at most ${maxLength} items.`)
  }
  return value
}

/** Missing keys take their defaults and unknown keys are dropped. */
function params(value: unknown, defs: readonly ParamDef[], path: string): Record<string, number> {
  const source = value === undefined ? {} : object(value, `${path} parameters`)
  const result: Record<string, number> = {}
  for (const def of defs) {
    if (!Object.hasOwn(source, def.id)) {
      result[def.id] = def.default
      continue
    }
    const parsed = number(source[def.id], `${path} ${def.id}`, def.min, def.max)
    if (def.options && !def.options.some(option => option.value === parsed)) {
      throw new Error(`${path} ${def.id} must be one of ${def.options.map(option => option.value).join(', ')}.`)
    }
    result[def.id] = parsed
  }
  return result
}

/** Schema 10 fade shapes; linear stays absent so it saves like older files. */
function fadeCurves(clip: Record<string, unknown>, path: string, version: number): { fadeInCurve?: FadeCurve; fadeOutCurve?: FadeCurve } {
  const result: { fadeInCurve?: FadeCurve; fadeOutCurve?: FadeCurve } = {}
  for (const [key, label] of [['fadeInCurve', 'fade in curve'], ['fadeOutCurve', 'fade out curve']] as const) {
    const value = clip[key]
    if (value === undefined) continue
    if (version < 10) throw new Error('Fade curves require project schema version 10 or later.')
    if (!isFadeCurve(value)) throw new Error(`${path} ${label} must be one of ${FADE_CURVES.join(', ')}.`)
    if (value !== 'linear') result[key] = value
  }
  return result
}

/** Schema 14 tempo map: absent stays absent; the first point must sit at beat 0 with the project tempo. */
function validateTempoMap(input: unknown, bpm: number): TempoPoint[] | undefined {
  if (input === undefined) return undefined
  const points = list(input, 'Tempo map', MAX_TEMPO_POINTS).map((pointInput, index): TempoPoint => {
    const path = `Tempo point ${index + 1}`
    const point = object(pointInput, path)
    if (point.curve !== 'step' && point.curve !== 'ramp') throw new Error(`${path} curve must be step or ramp.`)
    return { beat: number(point.beat, `${path} position`, 0, 10_000_000), bpm: number(point.bpm, `${path} tempo`, TEMPO_MIN, TEMPO_MAX), curve: point.curve }
  })
  if (!points.length) return undefined
  for (let index = 1; index < points.length; index += 1) {
    if (!(points[index].beat > points[index - 1].beat)) throw new Error('Tempo points must be sorted by position without duplicates.')
  }
  if (points[0].beat !== 0) throw new Error('The first tempo point must be at the project start.')
  if (Math.abs(points[0].bpm - bpm) > 1e-6) throw new Error('The first tempo point must match the project tempo.')
  return points.length > 1 ? normalizeTempoPoints(bpm, points) : undefined
}
/**
 * Meter map (docs/METER_MAP.md). Schema METER_MAP_SCHEMA+ stores the time-signature changes; older files (and
 * newer ones without the field) migrate to one event at bar 0 with the project meter.
 */
function validateMeterMap(input: unknown, signature: { numerator: number; denominator: 2 | 4 | 8 | 16 }, version: number): MeterEvent[] {
  // Older files cannot carry meter changes: like the tempo map before schema 14, anything there is ignored.
  if (input === undefined || version < METER_MAP_SCHEMA) return normalizeMeterEvents(signature, [])
  const events = list(input, 'Meter map', MAX_METER_EVENTS).map((eventInput, index): MeterEvent => {
    const path = `Meter change ${index + 1}`
    const event = object(eventInput, path)
    return { bar: integer(event.bar, `${path} bar`, 0, MAX_METER_BAR), ...validateTimeSignature({ numerator: event.numerator, denominator: event.denominator }) }
  })
  if (!events.length) return normalizeMeterEvents(signature, [])
  for (let index = 1; index < events.length; index += 1) {
    if (!(events[index].bar > events[index - 1].bar)) throw new Error('Meter changes must be sorted by bar without duplicates.')
  }
  if (events[0].bar !== 0) throw new Error('The first meter change must be at bar 1.')
  if (events[0].numerator !== signature.numerator || events[0].denominator !== signature.denominator) throw new Error('The first meter change must match the project time signature.')
  return normalizeMeterEvents(signature, events.slice(1))
}
function parseAutomationMode(value: unknown, path: string): AutomationMode {
  if (typeof value !== 'string' || !AUTOMATION_MODES.includes(value as AutomationMode)) throw new Error(`${path} must be one of ${AUTOMATION_MODES.join(', ')}.`)
  return value as AutomationMode
}
function parseAutomationTarget(value: unknown, path: string): AutomationTarget {
  const source = object(value, path)
  let target: AutomationTarget | null = null
  if (source.kind === 'track') target = parseTargetKey(`track:${text(source.param, `${path} parameter`, 16)}`)
  else if (source.kind === 'device') target = { kind: 'device', deviceId: text(source.deviceId, `${path} device ID`, 200), param: text(source.param, `${path} parameter`, 120) }
  else if (source.kind === 'instrument') target = { kind: 'instrument', param: text(source.param, `${path} parameter`, 120) }
  else if (source.kind === 'plugin-instrument') target = parseTargetKey(`plugin:${text(source.param, `${path} parameter`, 20)}`)
  else if (source.kind === 'send') target = { kind: 'send', returnId: text(source.returnId, `${path} return ID`, 200) }
  if (!target) throw new Error(`${path} is not a supported automation target.`)
  return target
}
/** Schema 17 lanes. Points are sorted here so a hand-edited file still evaluates deterministically. */
function parseAutomation(value: unknown, path: string, id: (value: unknown, path: string) => string): AutomationLane[] {
  const keys = new Set<string>()
  let points = 0
  return list(value, path, MAX_AUTOMATION_LANES).map((laneInput, laneIndex): AutomationLane => {
    const lanePath = `${path} lane ${laneIndex + 1}`
    const lane = object(laneInput, lanePath)
    const target = parseAutomationTarget(lane.target, `${lanePath} target`)
    const key = targetKey(target)
    if (keys.has(key)) throw new Error(`${lanePath} duplicates another lane's target.`)
    keys.add(key)
    const parsedPoints = list(lane.points, `${lanePath} points`, MAX_AUTOMATION_POINTS).map((pointInput, pointIndex) => {
      if (++points > MAX_AUTOMATION_POINTS * 4) throw new Error(`${path} contains too many automation points.`)
      const pointPath = `${lanePath} point ${pointIndex + 1}`
      const point = object(pointInput, pointPath)
      const curve = point.curve === undefined ? 0 : number(point.curve, `${pointPath} curve`, -1, 1)
      return { beat: number(point.beat, `${pointPath} position`, 0, 10_000_000), value: number(point.value, `${pointPath} value`, 0, 1), ...(curve ? { curve } : {}) }
    }).map((point, index) => ({ point, index })).sort((a, b) => a.point.beat - b.point.beat || a.index - b.index).map(item => item.point)
    return {
      id: id(lane.id, `${lanePath} ID`),
      target,
      points: parsedPoints,
      ...(lane.enabled === undefined || flag(lane.enabled, `${lanePath} enabled`) ? {} : { enabled: false }),
    }
  })
}

/** Parse known fields into fresh objects; never trust JSON casts or imported prototypes. */
/** Snapshots that passed validateProject (its input and its normalized result). Immutable updates make this sound. */
const knownValid = new WeakSet<object>()

/** True when this exact object already passed validateProject (e.g. a ProjectSession command result). */
export const isKnownValidProject = (project: unknown): boolean => typeof project === 'object' && project !== null && knownValid.has(project)

export function validateProject(input: unknown): Project {
  const result = validateProjectFields(input)
  knownValid.add(input as object)
  knownValid.add(result)
  return result
}

function validateProjectFields(input: unknown): Project {
  const source = object(input, 'Project')
  const version = source.schemaVersion
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > PROJECT_SCHEMA_VERSION) throw new Error(`This project version is not supported. Expected schema version 1 through ${PROJECT_SCHEMA_VERSION}.`)
  const timeSignature = version >= 5 ? validateTimeSignature(source.timeSignature) : { ...DEFAULT_TIME_SIGNATURE }
  const beatsPerBar = quarterNotesPerBar(timeSignature)
  if (source.beatsPerBar !== beatsPerBar) throw new Error('Time signature and quarter-note beats per bar must agree. Legacy projects must use 4/4 time.')
  const seen = new Set<string>()
  const id = (value: unknown, path: string): string => {
    const result = text(value, path, 200)
    if (seen.has(result)) throw new Error(`${path} duplicates another editing object ID.`)
    seen.add(result)
    return result
  }
  const lengthBeats = number(source.lengthBeats, 'Project length', 0.001, 10_000_000)
  const loop = object(source.loop, 'Loop')
  const loopStart = number(loop.startBeat, 'Loop start', 0, lengthBeats)
  const loopEnd = number(loop.endBeat, 'Loop end', 0.001, lengthBeats)
  if (loopEnd <= loopStart) throw new Error('Loop end must be after its start.')
  const projectId = id(source.id, 'Project ID')
  let noteCount = 0
  let clipCount = 0
  const tracks = list(source.tracks, 'Tracks', 10_000).map((trackInput, trackIndex): Track => {
    const path = `Track ${trackIndex + 1}`
    const track = object(trackInput, path)
    if (track.kind !== 'audio' && track.kind !== 'instrument' && track.kind !== 'return') throw new Error(`${path} has an invalid track type.`)
    if (track.kind === 'return' && version < 15) throw new Error('Return tracks require project schema version 15 or later.')
    if (!isInstrumentId(track.instrument)) throw new Error(`${path} has an unknown instrument.`)
    const color = text(track.color, `${path} color`, 9)
    if (!/^#[\da-f]{6}$/i.test(color)) throw new Error(`${path} color must be a six-digit hex color.`)
    const trackId = id(track.id, `${path} ID`)
    const instrument: InstrumentId = track.instrument
    const instrumentParams = instrument === 'wavetable'
      ? parseWavetableParams(track.instrumentParams ?? {})
      : params(track.instrumentParams, instrumentDef(instrument).params, `${path} instrument`)
    if (track.instrumentState !== undefined && (instrument !== 'wavetable' || track.kind !== 'instrument')) {
      throw new Error(`${path} instrument state requires an IEUM WAVE instrument track.`)
    }
    const instrumentState = instrument === 'wavetable' && track.kind === 'instrument'
      ? splitWavetablePatch(combineWavetablePatch(instrumentParams, track.instrumentState)).state : undefined
    if (version < 6 && (track.pluginInstrument !== undefined || track.pluginInserts !== undefined)) throw new Error('VST3 plugins require project schema version 6 or later.')
    if (track.kind !== 'instrument' && track.pluginInstrument !== undefined) throw new Error(`${path} cannot place a VST3 instrument on an audio track.`)
    const pluginInstrument = track.pluginInstrument === undefined ? undefined : validateNativePlugin(track.pluginInstrument, `${path} VST3 instrument`, id)
    if (version >= 7 && track.pluginInserts !== undefined) throw new Error(`${path} keeps VST3 effects in its device chain since schema version 7.`)
    // Schema 6 processed its separate VST3 list after every builtin effect; that order becomes the chain.
    const legacyPluginInserts = track.pluginInserts === undefined ? [] : list(track.pluginInserts, `${path} VST3 inserts`, 64).map((plugin, index): Device => ({ ...validateNativePlugin(plugin, `${path} VST3 insert ${index + 1}`, id), type: 'vst3' }))
    let devices: Device[]
    if (version === 1) {
      const effects = object(track.effects, `${path} effects`)
      const filter = number(effects.filter, `${path} filter frequency`, 100, 20000)
      const reverb = number(effects.reverb, `${path} reverb`, 0, 1)
      const delay = number(effects.delay, `${path} delay`, 0, 1)
      const migrated = (type: EffectType, values: Record<string, number>): Device => ({
        id: id(`${trackId}/${type}`, `${path} ${type} device ID`), type, enabled: true,
        params: params(values, EFFECT_DEFS[type].params, `${path} ${type}`),
      })
      devices = []
      if (filter < 20000) devices.push(migrated('filter', { cutoff: filter, resonance: 0.65, mode: 0 }))
      if (reverb > 0) devices.push(migrated('reverb', { amount: reverb, size: 0, tone: 20000 }))
      if (delay > 0) devices.push(migrated('delay', { amount: delay, time: 0.75, feedback: 0.32, tone: 3800 }))
    } else {
      devices = list(track.devices, `${path} devices`, 64).map((deviceInput, deviceIndex): Device => {
        const devicePath = `${path}, device ${deviceIndex + 1}`
        const device = object(deviceInput, devicePath)
        if (device.type === 'vst3' && version >= 7) {
          const { type: _type, ...plugin } = device
          return { ...validateNativePlugin(plugin, `${devicePath} VST3`, id), type: 'vst3' }
        }
        const deviceId = id(device.id, `${devicePath} ID`)
        if (typeof device.type !== 'string' || !Object.hasOwn(EFFECT_DEFS, device.type)) {
          throw new Error(`${devicePath} has an unknown effect type.`)
        }
        const type = device.type as EffectType
        return {
          id: deviceId,
          type,
          enabled: flag(device.enabled, `${devicePath} enabled`),
          params: params(device.params, EFFECT_DEFS[type].params, `${devicePath} ${type}`),
          ...(device.name === undefined ? {} : { name: text(device.name, `${devicePath} name`, 80) }),
        }
      })
    }
    devices.push(...legacyPluginInserts)
    if (devices.length > 64) throw new Error(`${path} may contain at most 64 inserts including VST3.`)
    if (version < 8 && (track.input !== undefined || track.monitorMode !== undefined)) throw new Error('Track inputs and monitor modes require project schema version 8 or later.')
    if (track.kind !== 'audio' && track.input !== undefined) throw new Error(`${path} input requires an audio track.`)
    const input = track.input === undefined ? undefined : parseTrackInput(track.input, `${path} input`)
    if (version < 11 && track.inputRoute !== undefined) throw new Error('Track input routes require project schema version 11 or later.')
    if (track.kind !== 'audio' && track.inputRoute !== undefined) throw new Error(`${path} input route requires an audio track.`)
    const inputRoute = track.inputRoute === undefined ? undefined : parseTrackInputRoute(track.inputRoute, `${path} input route`)
    const mode = track.monitorMode === undefined ? undefined : monitorMode(track.monitorMode, `${path} monitor mode`)
    if (track.kind !== 'instrument' && track.midiInput !== undefined) throw new Error(`${path} MIDI input requires an instrument track.`)
    const midiInput = track.midiInput === undefined ? undefined : parseTrackMidiInput(track.midiInput, `${path} MIDI input`)
    if (version < 15 && track.sends !== undefined) throw new Error('Track sends require project schema version 15 or later.')
    if (track.kind === 'return' && track.sends !== undefined) throw new Error(`${path} is a return track; return tracks cannot have sends.`)
    const sends = track.sends === undefined ? undefined : parseSends(track.sends, path)
    if (track.kind === 'return' && Array.isArray(track.clips) && track.clips.length) throw new Error(`${path} is a return track and cannot contain regions.`)
    // Schema ≤7 has only the I flag, and an absent mode keeps deriving from it. A saved mode is authoritative.
    const monitor = mode === undefined ? optional(track.monitor, false, value => flag(value, `${path} monitor`)) : mode === 'in'
    const clips = list(track.clips, `${path} clips`, 100_000).map((clipInput, clipIndex): Clip => {
      clipCount += 1
      if (clipCount > 100_000) throw new Error('The project contains too many clips.')
      const clipPath = `${path}, clip ${clipIndex + 1}`
      const clip = object(clipInput, clipPath)
      if (version < 4 && (clip.loopLengthBeats !== undefined || (clip.kind === 'midi' && clip.sourceOffsetBeats !== undefined))) {
        throw new Error('Recoverable MIDI sources and bounded region loops require project schema version 4 or later.')
      }
      const startBeat = number(clip.startBeat, `${clipPath} start`, 0, 10_000_000)
      const clipLength = number(clip.lengthBeats, `${clipPath} length`, 0.000001, 10_000_000)
      const base = {
        id: id(clip.id, `${clipPath} ID`),
        name: text(clip.name, `${clipPath} name`),
        startBeat,
        lengthBeats: clipLength,
        gain: number(clip.gain, `${clipPath} gain`, 0, clip.kind === 'audio' && version >= 10 ? AUDIO_CLIP_GAIN_MAX : MIDI_CLIP_GAIN_MAX),
        ...(clip.mute === undefined ? {} : { mute: flag(clip.mute, `${clipPath} mute`) }),
        ...(clip.loop === undefined ? {} : { loop: flag(clip.loop, `${clipPath} loop`) }),
        ...(clip.loopLengthBeats === undefined ? {} : { loopLengthBeats: number(clip.loopLengthBeats, `${clipPath} loop length`, clipLength, 10_000_000) }),
        ...(clip.delayTicks === undefined ? {} : { delayTicks: integer(clip.delayTicks, `${clipPath} delay`, -1920, 1920) }),
      }
      if (clip.kind === 'audio') {
        if (clip.pitch !== undefined && version < 3) throw new Error('Pitch editing requires project schema version 3 or later.')
        const pitch = clip.pitch === undefined ? undefined : validatePitchDocument(clip.pitch)
        const changed = pitch && hasPitchAudioEdits(pitch)
        if (pitch && changed && clip.assetId === pitch.sourceAssetId) throw new Error(`${clipPath} is missing its pitch render.`)
        if (pitch && !changed && clip.assetId !== pitch.sourceAssetId) throw new Error(`${clipPath} has a pitch render without any pitch or formant changes.`)
        if (clip.warp !== undefined && version < 9) throw new Error('Audio warp requires project schema version 9 or later.')
        const assetId = text(clip.assetId, `${clipPath} audio asset ID`, 200)
        const warp = clip.warp === undefined ? undefined : validateWarp(clip.warp, `${clipPath} warp`)
        if (clip.regionPitch !== undefined && version < 12) throw new Error('Region pitch requires project schema version 12 or later.')
        const regionPitch = clip.regionPitch === undefined ? undefined : validateTranspose(clip.regionPitch, `${clipPath} region pitch`)
        if (warp) checkWarpClip({ assetId, pitch, regionPitch }, warp, clipPath)
        checkTransposeClip({ assetId, pitch, warp, regionPitch }, clipPath)
        return {
          ...base,
          kind: 'audio',
          assetId,
          offsetSeconds: number(clip.offsetSeconds, `${clipPath} source offset`, 0, 10_000_000),
          fadeIn: number(clip.fadeIn, `${clipPath} fade in`, 0, 10_000_000),
          fadeOut: number(clip.fadeOut, `${clipPath} fade out`, 0, 10_000_000),
          ...fadeCurves(clip, clipPath, version),
          ...(pitch ? { pitch } : {}),
          ...(warp ? { warp } : {}),
          ...(regionPitch ? { regionPitch } : {}),
        }
      }
      if (clip.kind !== 'midi') throw new Error(`${clipPath} has an invalid clip type.`)
      return {
        ...base,
        kind: 'midi',
        ...(clip.sourceOffsetBeats === undefined ? {} : { sourceOffsetBeats: number(clip.sourceOffsetBeats, `${clipPath} MIDI source offset`, 0, 10_000_000) }),
        ...(clip.quantize === undefined ? {} : { quantize: quantize(clip.quantize, `${clipPath} quantize`) }),
        ...(clip.swing === undefined ? {} : { swing: number(clip.swing, `${clipPath} swing`, 0, 100) }),
        ...(clip.qStrength === undefined ? {} : { qStrength: number(clip.qStrength, `${clipPath} quantize strength`, 0, 100) }),
        ...(clip.transpose === undefined ? {} : { transpose: integer(clip.transpose, `${clipPath} transpose`, -96, 96) }),
        ...(clip.velocity === undefined ? {} : { velocity: integer(clip.velocity, `${clipPath} velocity`, -99, 99) }),
        ...(clip.sustain === undefined ? {} : { sustain: sustainEvents(clip.sustain, clipPath, version) }),
        ...(() => {
          if (clip.controllers === undefined) return {}
          const controllers = controllerLanes(clip.controllers, clipPath, version)
          return Object.keys(controllers).length ? { controllers } : {}
        })(),
        ...(clip.bendRange === undefined ? {} : version < 16 ? (() => { throw new Error(`${clipPath} pitch-bend range requires project schema version 16 or later.`) })() : { bendRange: integer(clip.bendRange, `${clipPath} pitch-bend range`, 0, MAX_BEND_RANGE) }),
        notes: list(clip.notes, `${clipPath} notes`, 100_000).map((noteInput, noteIndex): MidiNote => {
          noteCount += 1
          if (noteCount > 1_000_000) throw new Error('The project contains too many notes.')
          const notePath = `${clipPath}, note ${noteIndex + 1}`
          const value = object(noteInput, notePath)
          const pitch = number(value.pitch, `${notePath} pitch`, 0, 127)
          if (!Number.isInteger(pitch)) throw new Error(`${notePath} pitch must be an integer.`)
          return {
            id: id(value.id, `${notePath} ID`),
            pitch,
            start: number(value.start, `${notePath} start`, 0, 10_000_000),
            duration: number(value.duration, `${notePath} duration`, 0.000001, 10_000_000),
            velocity: number(value.velocity, `${notePath} velocity`, 0, 1),
          }
        }),
      }
    })
    if (version < 17 && (track.automation !== undefined || track.automationMode !== undefined)) throw new Error('Track automation requires project schema version 17 or later.')
    const automationMode = track.automationMode === undefined ? undefined : parseAutomationMode(track.automationMode, `${path} automation mode`)
    const automation = track.automation === undefined ? undefined : parseAutomation(track.automation, `${path} automation`, id)
    if (version < FREEZE_SCHEMA_VERSION && track.freeze !== undefined) throw new Error(`Frozen tracks require project schema version ${FREEZE_SCHEMA_VERSION} or later.`)
    // A return track has nothing to freeze; a malformed record (hand-edited) is dropped and the track plays live.
    const freeze = track.freeze === undefined || track.kind === 'return' ? undefined : parseFreeze(track.freeze)
    const parsed: Track = {
      id: trackId,
      name: text(track.name, `${path} name`),
      kind: track.kind,
      instrument,
      color,
      volume: number(track.volume, `${path} volume`, 0, 2),
      pan: number(track.pan, `${path} pan`, -1, 1),
      mute: flag(track.mute, `${path} mute`),
      solo: flag(track.solo, `${path} solo`),
      soloSafe: optional(track.soloSafe, false, value => flag(value, `${path} solo safe`)),
      enabled: optional(track.enabled, true, value => flag(value, `${path} enabled`)),
      armed: optional(track.armed, false, value => flag(value, `${path} armed`)),
      monitor,
      ...(mode ? { monitorMode: mode } : {}),
      hidden: optional(track.hidden, false, value => flag(value, `${path} hidden`)),
      transpose: optional(track.transpose, 0, value => integer(value, `${path} transpose`, -96, 96)),
      velocityOffset: optional(track.velocityOffset, 0, value => integer(value, `${path} velocity offset`, -99, 99)),
      keyLimit: optional(track.keyLimit, [0, 127], value => range(value, `${path} key limit`, 0, 127)),
      velocityLimit: optional(track.velocityLimit, [1, 127], value => range(value, `${path} velocity limit`, 1, 127)),
      delayTicks: optional(track.delayTicks, 0, value => integer(value, `${path} delay`, -1920, 1920)),
      ...(typeof track.icon === 'string' && track.icon.length > 0 && track.icon.length <= 40 ? { icon: track.icon } : {}),
      clips,
      instrumentParams,
      ...(instrumentState ? { instrumentState } : {}),
      devices,
      ...(pluginInstrument ? { pluginInstrument } : {}),
      ...(input ? { input } : {}),
      ...(inputRoute ? { inputRoute } : {}),
      ...(midiInput ? { midiInput } : {}),
      ...(sends?.length ? { sends } : {}),
      ...(automation?.length ? { automation } : {}),
      ...(automationMode && automationMode !== 'read' ? { automationMode } : {}),
      ...(freeze ? { freeze } : {}),
    }
    // Lanes of a device or instrument parameter that is gone (hand-edited or older writers) are dropped, not fatal.
    return pruneAutomation(parsed)
  })
  // Routes to deleted tracks read as 'none'; a saved loop (only possible by hand-editing) is broken the same way.
  // Sends to a missing track (or one that is not a return) are dropped like deleted returns.
  // Send lanes whose send was just dropped go with it.
  const routedTracks = reconcileSends(reconcileTrackRoutes(tracks)).map(pruneAutomation)
  const markers = sortMarkers(list(source.markers ?? [], 'Markers', 10_000).map((markerInput, markerIndex): Marker => {
    const path = `Marker ${markerIndex + 1}`
    const marker = object(markerInput, path)
    return {
      id: id(marker.id, `${path} ID`),
      name: text(marker.name, `${path} name`),
      startBeat: number(marker.startBeat, `${path} position`, 0, MAX_MARKER_BEAT),
    }
  }))
  const bpm = number(source.bpm, 'Tempo', 30, 300)
  const tempoMap = version >= 14 ? validateTempoMap(source.tempoMap, bpm) : undefined
  const meterMap = validateMeterMap(source.meterMap, timeSignature, version)
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: projectId,
    name: text(source.name, 'Project name'),
    bpm,
    ...(tempoMap ? { tempoMap } : {}),
    sampleRate: projectSampleRate(source.sampleRate),
    timeSignature,
    beatsPerBar,
    meterMap,
    lengthBeats,
    masterVolume: number(source.masterVolume, 'Master volume', 0, 2),
    loop: { enabled: flag(loop.enabled, 'Loop enabled'), startBeat: loopStart, endBeat: loopEnd },
    tracks: routedTracks,
    markers,
  }
}

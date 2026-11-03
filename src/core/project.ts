import { EFFECT_DEFS, defaultParams, type ParamDef } from './devices'
import { DEFAULT_SAMPLE_RATE, projectSampleRate } from './audioSettings'
import { instrumentDef, isInstrumentId } from './instruments'
import { midiEditorClip, midiSourceOffset } from './midiRegions'
import { DEFAULT_TIME_SIGNATURE, quarterNotesPerBar, validateTimeSignature } from './meter'
import { copyPitchDocument, hasPitchAudioEdits, validatePitchDocument } from '../devices/pitch-editor/state'
import { QUANTIZE_VALUES, type Clip, type Device, type EffectType, type InstrumentId, type Marker, type MidiClip, type MidiNote, type Project, type Track } from './types'

let fallbackSequence = 0

/** Logic defaults (C-02): palette row 2 at hue 210° (audio) and 120° (instrument), hsl(h 58% 62%). */
export const DEFAULT_TRACK_COLORS: Readonly<Record<Track['kind'], string>> = { audio: '#669ed6', instrument: '#66d666' }

/** IDs describe editing objects; they are not security tokens. */
export function uid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  fallbackSequence += 1
  return `noct-${Date.now().toString(36)}-${fallbackSequence.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function defaultInstrumentParams(instrument: InstrumentId): Record<string, number> {
  return defaultParams(instrumentDef(instrument).params)
}

export function createDevice(type: EffectType, params: Partial<Record<string, number>> = {}): Device {
  const values = defaultParams(EFFECT_DEFS[type].params)
  for (const [key, value] of Object.entries(params)) if (value !== undefined) values[key] = value
  return { id: uid(), type, enabled: true, params: values }
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
    name: kind === 'audio' ? 'Audio track' : def.name,
    kind,
    instrument,
    color: kind === 'audio' ? DEFAULT_TRACK_COLORS.audio : instrumentDef(instrument).color,
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
    devices: [],
  }
}

export function createEmptyProject(): Project {
  return {
    schemaVersion: 5,
    id: uid(),
    name: 'Untitled session',
    bpm: 96,
    sampleRate: DEFAULT_SAMPLE_RATE,
    timeSignature: { ...DEFAULT_TIME_SIGNATURE },
    beatsPerBar: 4,
    lengthBeats: 64,
    masterVolume: 0.8,
    loop: { enabled: false, startBeat: 0, endBeat: 32 },
    tracks: [],
    markers: [],
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
export function splitClip(clip: Clip, beat: number, bpm: number): Clip[] {
  if (!Number.isFinite(beat)) throw new Error('Split position must be a finite number.')
  if (!Number.isFinite(bpm) || bpm <= 0) throw new Error('Tempo must be greater than zero.')
  const endBeat = clip.startBeat + clip.lengthBeats
  if (beat <= clip.startBeat || beat >= endBeat) return [clip]

  const cut = beat - clip.startBeat
  const rightLength = clip.lengthBeats - cut
  const rightLoop = clip.loopLengthBeats === undefined ? {} : { loopLengthBeats: clip.loopLengthBeats - cut }
  if (clip.kind === 'audio') {
    const leftSeconds = cut * 60 / bpm
    const rightSeconds = rightLength * 60 / bpm
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
export function trimClipStart(clip: Clip, newStartBeat: number, bpm: number): Clip {
  if (!Number.isFinite(newStartBeat)) throw new Error('Trim position must be a finite number.')
  if (!Number.isFinite(bpm) || bpm <= 0) throw new Error('Tempo must be greater than zero.')
  const end = clip.startBeat + clip.lengthBeats
  let start = Math.min(Math.max(0, newStartBeat), end - MIN_CLIP_BEATS)
  if (clip.kind === 'audio') start = Math.max(start, clip.startBeat - clip.offsetSeconds * bpm / 60)
  const delta = start - clip.startBeat
  if (Math.abs(delta) < EPSILON) return clip
  const lengthBeats = end - start
  const loop = clip.loopLengthBeats === undefined ? {} : { loopLengthBeats: Math.max(lengthBeats, clip.loopLengthBeats - delta) }
  if (clip.kind === 'audio') {
    const seconds = lengthBeats * 60 / bpm
    return {
      ...clip, startBeat: start, lengthBeats,
      ...loop,
      offsetSeconds: Math.max(0, clip.offsetSeconds + delta * 60 / bpm),
      fadeIn: Math.min(clip.fadeIn, seconds), fadeOut: Math.min(clip.fadeOut, seconds),
    }
  }
  const offset = midiSourceOffset(clip) + delta
  const { sourceOffsetBeats: _offset, ...source } = clip
  return { ...source, startBeat: start, lengthBeats, ...loop,
    ...(offset > 0 ? { sourceOffsetBeats: offset } : {}),
    notes: offset < 0 ? clip.notes.map(value => ({ ...value, start: value.start - offset })) : clip.notes }
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
export function joinClips(clips: Clip[], bpm: number): Clip | null {
  if (clips.length < 2 || !clips.every(clip => clip.kind === clips[0].kind)) return null
  const sorted = [...clips].sort((a, b) => a.startBeat - b.startBeat)
  const first = sorted[0]
  const startBeat = first.startBeat
  const endBeat = Math.max(...sorted.map(clip => clip.startBeat + clip.lengthBeats))
  if (first.kind === 'midi') {
    const notes = (sorted as MidiClip[]).flatMap(clip => cropNotesToClip(clip).notes.map(value => ({ ...value, start: value.start + clip.startBeat - startBeat })))
    const { sourceOffsetBeats: _offset, ...base } = first
    return { ...base, startBeat, lengthBeats: endBeat - startBeat, notes,
      ...(first.loopLengthBeats === undefined ? {} : { loopLengthBeats: Math.max(endBeat - startBeat, first.loopLengthBeats) }) }
  }
  const audio = sorted as Extract<Clip, { kind: 'audio' }>[]
  let reach = first.startBeat + first.lengthBeats
  for (const clip of audio.slice(1)) {
    if (clip.assetId !== first.assetId) return null
    if (clip.startBeat > reach + 1e-6) return null
    const expected = first.offsetSeconds + (clip.startBeat - startBeat) * 60 / bpm
    if (Math.abs(clip.offsetSeconds - expected) > 1e-3) return null
    reach = Math.max(reach, clip.startBeat + clip.lengthBeats)
  }
  const last = audio.reduce((a, b) => (b.startBeat + b.lengthBeats >= a.startBeat + a.lengthBeats ? b : a))
  return { ...first, lengthBeats: endBeat - startBeat, fadeOut: last.fadeOut,
    ...(first.loopLengthBeats === undefined ? {} : { loopLengthBeats: Math.max(endBeat - startBeat, first.loopLengthBeats) }) }
}

/** A deep copy with new track, clip, note and device IDs; audio assets stay shared. */
export function duplicateTrack(track: Track): Track {
  return {
    ...track,
    id: uid(),
    name: `${track.name} 복사본`.slice(0, 512),
    instrumentParams: { ...track.instrumentParams },
    devices: track.devices.map(device => ({ ...device, id: uid(), params: { ...device.params } })),
    clips: track.clips.map(clip => duplicateClip(clip, clip.startBeat)),
  }
}

/** Logic "New Track With Duplicate Settings": every setting but no clips; arm and monitor stay off. */
export function duplicateTrackSettings(track: Track): Track {
  return {
    ...track,
    id: uid(),
    armed: false,
    monitor: false,
    keyLimit: [...track.keyLimit],
    velocityLimit: [...track.velocityLimit],
    instrumentParams: { ...track.instrumentParams },
    devices: track.devices.map(device => ({ ...device, id: uid(), params: { ...device.params } })),
    clips: [],
  }
}

/** Grows to the last source/manual-loop end; continuous loops never grow the project. */
export function fitProjectLength(project: Project): Project {
  const end = Math.max(0, ...project.tracks.flatMap(track => track.clips.map(clip => clip.startBeat + (clip.loop ? clip.loopLengthBeats ?? clip.lengthBeats : clip.lengthBeats))))
  const lengthBeats = Math.max(project.lengthBeats, Math.ceil(end / project.beatsPerBar) * project.beatsPerBar)
  return lengthBeats === project.lengthBeats ? project : { ...project, lengthBeats }
}

export type DragMode = 'overlap' | 'noOverlap'

/** Cuts `piece` so it no longer overlaps [start, end); [] removes it, two clips means it was split around. */
function cutAround(piece: Clip, start: number, end: number, bpm: number): Clip[] {
  const pieceEnd = piece.startBeat + piece.lengthBeats
  if (end <= piece.startBeat + EPSILON || start >= pieceEnd - EPSILON) return [piece]
  const coversStart = start <= piece.startBeat + EPSILON
  const coversEnd = end >= pieceEnd - EPSILON
  if (coversStart && coversEnd) return []
  if (coversStart) return pieceEnd - end < MIN_CLIP_BEATS ? [] : [trimClipStart(piece, end, bpm)]
  if (coversEnd) return start - piece.startBeat < MIN_CLIP_BEATS ? [] : [trimClipEnd(piece, start)]
  const [left, right] = splitClip(piece, start, bpm)
  return [left, ...cutAround(right, start, end, bpm)]
}

/**
 * Logic Drag mode (R-05). `noOverlap` trims, splits or removes the clips on `trackIds` that a moved
 * clip now covers; moved clips themselves are never changed. `overlap` returns the project as is.
 */
export function applyDragMode(project: Project, trackIds: readonly string[], movedClipIds: readonly string[], mode: DragMode): Project {
  if (mode === 'overlap' || movedClipIds.length === 0) return project
  const moved = new Set(movedClipIds)
  let changed = false
  const tracks = project.tracks.map(track => {
    if (!trackIds.includes(track.id)) return track
    const movers = track.clips.filter(clip => moved.has(clip.id))
    if (movers.length === 0) return track
    let trackChanged = false
    const clips = track.clips.flatMap(clip => {
      if (moved.has(clip.id)) return [clip]
      let pieces = [clip]
      for (const mover of movers) {
        pieces = pieces.flatMap(piece => cutAround(piece, mover.startBeat, mover.startBeat + mover.lengthBeats, project.bpm))
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
      const next = trimClipStart(clip, own.get(clip.id)!, project.bpm)
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

function quantize(value: unknown, path: string): number {
  const parsed = number(value, path, 0, 4)
  const match = QUANTIZE_VALUES.find(grid => Math.abs(grid - parsed) <= 1e-6)
  if (match === undefined) throw new Error(`${path} must be one of the supported quantize grids.`)
  return match
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

/** Parse known fields into fresh objects; never trust JSON casts or imported prototypes. */
export function validateProject(input: unknown): Project {
  const source = object(input, 'Project')
  const version = source.schemaVersion
  if (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5) throw new Error('This project version is not supported. Expected schema version 1, 2, 3, 4 or 5.')
  const timeSignature = version === 5 ? validateTimeSignature(source.timeSignature) : { ...DEFAULT_TIME_SIGNATURE }
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
    if (track.kind !== 'audio' && track.kind !== 'instrument') throw new Error(`${path} has an invalid track type.`)
    if (!isInstrumentId(track.instrument)) throw new Error(`${path} has an unknown instrument.`)
    const color = text(track.color, `${path} color`, 9)
    if (!/^#[\da-f]{6}$/i.test(color)) throw new Error(`${path} color must be a six-digit hex color.`)
    const trackId = id(track.id, `${path} ID`)
    const instrument: InstrumentId = track.instrument
    const instrumentParams = params(track.instrumentParams, instrumentDef(instrument).params, `${path} instrument`)
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
        }
      })
    }
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
        gain: number(clip.gain, `${clipPath} gain`, 0, 2),
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
        return {
          ...base,
          kind: 'audio',
          assetId: text(clip.assetId, `${clipPath} audio asset ID`, 200),
          offsetSeconds: number(clip.offsetSeconds, `${clipPath} source offset`, 0, 10_000_000),
          fadeIn: number(clip.fadeIn, `${clipPath} fade in`, 0, 10_000_000),
          fadeOut: number(clip.fadeOut, `${clipPath} fade out`, 0, 10_000_000),
          ...(pitch ? { pitch } : {}),
        }
      }
      if (clip.kind !== 'midi') throw new Error(`${clipPath} has an invalid clip type.`)
      return {
        ...base,
        kind: 'midi',
        ...(clip.sourceOffsetBeats === undefined ? {} : { sourceOffsetBeats: number(clip.sourceOffsetBeats, `${clipPath} MIDI source offset`, 0, 10_000_000) }),
        ...(clip.quantize === undefined ? {} : { quantize: quantize(clip.quantize, `${clipPath} quantize`) }),
        ...(clip.swing === undefined ? {} : { swing: number(clip.swing, `${clipPath} swing`, 0, 100) }),
        ...(clip.transpose === undefined ? {} : { transpose: integer(clip.transpose, `${clipPath} transpose`, -96, 96) }),
        ...(clip.velocity === undefined ? {} : { velocity: integer(clip.velocity, `${clipPath} velocity`, -99, 99) }),
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
    return {
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
      monitor: optional(track.monitor, false, value => flag(value, `${path} monitor`)),
      hidden: optional(track.hidden, false, value => flag(value, `${path} hidden`)),
      transpose: optional(track.transpose, 0, value => integer(value, `${path} transpose`, -96, 96)),
      velocityOffset: optional(track.velocityOffset, 0, value => integer(value, `${path} velocity offset`, -99, 99)),
      keyLimit: optional(track.keyLimit, [0, 127], value => range(value, `${path} key limit`, 0, 127)),
      velocityLimit: optional(track.velocityLimit, [1, 127], value => range(value, `${path} velocity limit`, 1, 127)),
      delayTicks: optional(track.delayTicks, 0, value => integer(value, `${path} delay`, -1920, 1920)),
      ...(typeof track.icon === 'string' && track.icon.length > 0 && track.icon.length <= 40 ? { icon: track.icon } : {}),
      clips,
      instrumentParams,
      devices,
    }
  })
  const markers = sortMarkers(list(source.markers ?? [], 'Markers', 10_000).map((markerInput, markerIndex): Marker => {
    const path = `Marker ${markerIndex + 1}`
    const marker = object(markerInput, path)
    return {
      id: id(marker.id, `${path} ID`),
      name: text(marker.name, `${path} name`),
      startBeat: number(marker.startBeat, `${path} position`, 0, MAX_MARKER_BEAT),
    }
  }))
  return {
    schemaVersion: 5,
    id: projectId,
    name: text(source.name, 'Project name'),
    bpm: number(source.bpm, 'Tempo', 30, 300),
    sampleRate: projectSampleRate(source.sampleRate),
    timeSignature,
    beatsPerBar,
    lengthBeats,
    masterVolume: number(source.masterVolume, 'Master volume', 0, 2),
    loop: { enabled: flag(loop.enabled, 'Loop enabled'), startBeat: loopStart, endBeat: loopEnd },
    tracks,
    markers,
  }
}

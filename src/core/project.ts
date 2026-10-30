import type { Clip, InstrumentId, MidiClip, MidiNote, Project, Track } from './types'

const COLORS: Record<InstrumentId, string> = {
  drums: '#f0ad74',
  bass: '#a9bd75',
  keys: '#aaa0f5',
  pad: '#86b5ca',
  pluck: '#e398b4',
}

const INSTRUMENT_NAMES: Record<InstrumentId, string> = {
  drums: 'Drum machine',
  bass: 'Sub bass',
  keys: 'Midnight keys',
  pad: 'Soft atmosphere',
  pluck: 'Glass pluck',
}

let fallbackSequence = 0

/** IDs describe editing objects; they are not security tokens. */
export function uid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  fallbackSequence += 1
  return `noct-${Date.now().toString(36)}-${fallbackSequence.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function createTrack(kind: Track['kind'], instrument: InstrumentId = 'keys'): Track {
  return {
    id: uid(),
    name: kind === 'audio' ? 'Audio track' : INSTRUMENT_NAMES[instrument],
    kind,
    instrument,
    color: kind === 'audio' ? '#7fc3bb' : COLORS[instrument],
    volume: 0.7,
    pan: 0,
    mute: false,
    solo: false,
    clips: [],
    effects: { filter: 20000, reverb: 0, delay: 0 },
  }
}

export function createEmptyProject(): Project {
  return {
    schemaVersion: 1,
    id: uid(),
    name: 'Untitled session',
    bpm: 96,
    beatsPerBar: 4,
    lengthBeats: 64,
    masterVolume: 0.8,
    loop: { enabled: false, startBeat: 0, endBeat: 32 },
    tracks: [],
  }
}

function note(pitch: number, start: number, duration: number, velocity = 0.7): MidiNote {
  return { id: uid(), pitch, start, duration, velocity }
}

function midiClip(name: string, startBeat: number, lengthBeats: number, notes: MidiNote[]): MidiClip {
  return { id: uid(), kind: 'midi', name, startBeat, lengthBeats, gain: 1, notes }
}

/** An original eight-bar sketch. All sound comes from the built-in instruments. */
export function createDemoProject(): Project {
  const project = createEmptyProject()
  project.name = 'Midnight, somewhere'
  project.lengthBeats = 32
  project.loop = { enabled: true, startBeat: 0, endBeat: 32 }

  const drums = createTrack('instrument', 'drums')
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

  const hats = createTrack('instrument', 'drums')
  hats.name = 'After-hours hats'
  hats.color = '#dfc17e'
  hats.volume = 0.35
  hats.pan = 0.16
  for (let section = 0; section < 4; section += 1) {
    const notes = Array.from({ length: 16 }, (_, index) =>
      note(index === 15 ? 46 : 42, index * 0.5 + (index % 2 ? 0.055 : 0), index === 15 ? 0.32 : 0.08,
        index % 2 ? 0.36 : 0.57),
    )
    hats.clips.push(midiClip('Soft shuffle', section * 8, 8, notes))
  }

  const bass = createTrack('instrument', 'bass')
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

  const keys = createTrack('instrument', 'keys')
  keys.name = 'Midnight keys'
  keys.volume = 0.5
  keys.pan = -0.12
  keys.effects.reverb = 0.2
  const chords = [[52, 55, 59, 62], [48, 52, 55, 59], [47, 50, 54, 59], [50, 54, 57, 60]]
  const chordNames = ['Em7 / warm light', 'Cmaj7 / a little space', 'Gmaj7 / skyline', 'D7 / coming home']
  chords.forEach((chord, section) => {
    const notes = chord.flatMap((pitch, voice) => [
      note(pitch, voice * 0.025, 3.15, 0.48 + voice * 0.025),
      note(pitch, 4.5 + voice * 0.02, 2.9, 0.41 + voice * 0.025),
    ])
    keys.clips.push(midiClip(chordNames[section], section * 8, 8, notes))
  })

  const pluck = createTrack('instrument', 'pluck')
  pluck.name = 'Glass echoes'
  pluck.volume = 0.3
  pluck.pan = 0.23
  pluck.effects.delay = 0.22
  pluck.effects.reverb = 0.17
  const phrases = [[71, 67, 66, 64], [71, 67, 64, 62], [74, 71, 69, 66], [69, 66, 64, 62]]
  phrases.forEach((pitches, section) => {
    const notes = pitches.map((pitch, index) => note(pitch, [0.75, 2.5, 4.75, 6.5][index], 0.6, 0.48))
    pluck.clips.push(midiClip('Small reflections', section * 8, 8, notes))
  })

  const pad = createTrack('instrument', 'pad')
  pad.name = 'Slow bloom'
  pad.volume = 0.23
  pad.pan = -0.2
  pad.effects.filter = 4200
  pad.effects.reverb = 0.3
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
    : { ...clip, id: base.id, startBeat }
}

/** `beat` is an absolute project beat; MIDI note starts remain clip-relative. */
export function splitClip(clip: Clip, beat: number, bpm: number): Clip[] {
  if (!Number.isFinite(beat)) throw new Error('Split position must be a finite number.')
  if (!Number.isFinite(bpm) || bpm <= 0) throw new Error('Tempo must be greater than zero.')
  const endBeat = clip.startBeat + clip.lengthBeats
  if (beat <= clip.startBeat || beat >= endBeat) return [clip]

  const cut = beat - clip.startBeat
  const rightLength = clip.lengthBeats - cut
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
        offsetSeconds: clip.offsetSeconds + leftSeconds,
        fadeIn: 0,
        fadeOut: Math.min(clip.fadeOut, rightSeconds),
      },
    ]
  }

  const leftNotes: MidiNote[] = []
  const rightNotes: MidiNote[] = []
  for (const value of clip.notes) {
    const start = Math.max(0, value.start)
    const end = Math.min(clip.lengthBeats, value.start + value.duration)
    if (start < cut && end > start) {
      leftNotes.push({ ...value, start, duration: Math.min(cut, end) - start })
    }
    if (end > cut && end > start) {
      const rightStart = Math.max(cut, start)
      rightNotes.push({ ...value, id: uid(), start: rightStart - cut, duration: end - rightStart })
    }
  }
  return [
    { ...clip, lengthBeats: cut, notes: leftNotes },
    { ...clip, id: uid(), startBeat: beat, lengthBeats: rightLength, notes: rightNotes },
  ]
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

function flag(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be true or false.`)
  return value
}

function list(value: unknown, path: string, maxLength: number): unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) {
    throw new Error(`${path} must be an array with at most ${maxLength} items.`)
  }
  return value
}

/** Parse known fields into fresh objects; never trust JSON casts or imported prototypes. */
export function validateProject(input: unknown): Project {
  const source = object(input, 'Project')
  if (source.schemaVersion !== 1) throw new Error('This project version is not supported. Expected schema version 1.')
  if (source.beatsPerBar !== 4) throw new Error('This version supports projects in 4/4 time.')
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
    if (typeof track.instrument !== 'string' || !Object.hasOwn(INSTRUMENT_NAMES, track.instrument)) {
      throw new Error(`${path} has an unknown instrument.`)
    }
    const color = text(track.color, `${path} color`, 9)
    if (!/^#[\da-f]{6}$/i.test(color)) throw new Error(`${path} color must be a six-digit hex color.`)
    const effects = object(track.effects, `${path} effects`)
    const trackId = id(track.id, `${path} ID`)
    const clips = list(track.clips, `${path} clips`, 100_000).map((clipInput, clipIndex): Clip => {
      clipCount += 1
      if (clipCount > 100_000) throw new Error('The project contains too many clips.')
      const clipPath = `${path}, clip ${clipIndex + 1}`
      const clip = object(clipInput, clipPath)
      const startBeat = number(clip.startBeat, `${clipPath} start`, 0, 10_000_000)
      const clipLength = number(clip.lengthBeats, `${clipPath} length`, 0.000001, 10_000_000)
      const base = {
        id: id(clip.id, `${clipPath} ID`),
        name: text(clip.name, `${clipPath} name`),
        startBeat,
        lengthBeats: clipLength,
        gain: number(clip.gain, `${clipPath} gain`, 0, 2),
      }
      if (clip.kind === 'audio') {
        return {
          ...base,
          kind: 'audio',
          assetId: text(clip.assetId, `${clipPath} audio asset ID`, 200),
          offsetSeconds: number(clip.offsetSeconds, `${clipPath} source offset`, 0, 10_000_000),
          fadeIn: number(clip.fadeIn, `${clipPath} fade in`, 0, 10_000_000),
          fadeOut: number(clip.fadeOut, `${clipPath} fade out`, 0, 10_000_000),
        }
      }
      if (clip.kind !== 'midi') throw new Error(`${clipPath} has an invalid clip type.`)
      return {
        ...base,
        kind: 'midi',
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
      instrument: track.instrument as InstrumentId,
      color,
      volume: number(track.volume, `${path} volume`, 0, 2),
      pan: number(track.pan, `${path} pan`, -1, 1),
      mute: flag(track.mute, `${path} mute`),
      solo: flag(track.solo, `${path} solo`),
      clips,
      effects: {
        filter: number(effects.filter, `${path} filter frequency`, 100, 20000),
        reverb: number(effects.reverb, `${path} reverb`, 0, 1),
        delay: number(effects.delay, `${path} delay`, 0, 1),
      },
    }
  })
  return {
    schemaVersion: 1,
    id: projectId,
    name: text(source.name, 'Project name'),
    bpm: number(source.bpm, 'Tempo', 30, 300),
    beatsPerBar: 4,
    lengthBeats,
    masterVolume: number(source.masterVolume, 'Master volume', 0, 2),
    loop: { enabled: flag(loop.enabled, 'Loop enabled'), startBeat: loopStart, endBeat: loopEnd },
    tracks,
  }
}

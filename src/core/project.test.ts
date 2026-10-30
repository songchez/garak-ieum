import { describe, expect, it } from 'vitest'
import { createDemoProject, createEmptyProject, createTrack, duplicateClip, splitClip, validateProject } from './project'
import type { AudioClip, MidiClip } from './types'

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

describe('original demo project', () => {
  it('opens as a valid eight-bar arrangement with real notes on every track', () => {
    const project = createDemoProject()
    expect(validateProject(project)).toEqual(project)
    expect(project.tracks).toHaveLength(6)
    expect(project.loop).toEqual({ enabled: true, startBeat: 0, endBeat: 32 })
    for (const track of project.tracks) {
      expect(track.clips.length).toBeGreaterThan(0)
      expect(track.clips.every(clip => clip.kind === 'midi' && clip.notes.some(note => note.velocity > 0))).toBe(true)
    }
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

  it('splits crossing notes and rebases the right side from an absolute project beat', () => {
    const source = midi()
    const before = JSON.stringify(source)
    const [left, right] = splitClip(source, 10, 96)
    expect(left.kind).toBe('midi')
    expect(right.kind).toBe('midi')
    if (left.kind !== 'midi' || right.kind !== 'midi') throw new Error('Expected MIDI clips')
    expect(left.startBeat).toBe(8)
    expect(left.lengthBeats).toBe(2)
    expect(left.notes.map(({ pitch, start, duration }) => ({ pitch, start, duration }))).toEqual([
      { pitch: 60, start: 0, duration: 1 }, { pitch: 64, start: 1, duration: 1 },
    ])
    expect(right.startBeat).toBe(10)
    expect(right.lengthBeats).toBe(2)
    expect(right.notes.map(({ pitch, start, duration }) => ({ pitch, start, duration }))).toEqual([
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

describe('project validation', () => {
  it('returns an independent project and discards unrecognized imported fields', () => {
    const original = createDemoProject()
    const imported = validateProject({ ...original, unexpected: { executable: true } })
    imported.tracks[0].name = 'Changed later'
    expect(original.tracks[0].name).toBe('Pocket drums')
    expect(imported).not.toHaveProperty('unexpected')
  })

  it('rejects unsupported versions, duplicate IDs, and values that could break the engine', () => {
    const project = createEmptyProject()
    expect(() => validateProject({ ...project, schemaVersion: 2 })).toThrow(/version/)
    expect(() => validateProject({ ...project, bpm: Infinity })).toThrow(/Tempo/)
    expect(() => validateProject({ ...project, loop: { enabled: true, startBeat: 8, endBeat: 4 } })).toThrow(/Loop end/)
    const track = createTrack('instrument')
    expect(() => validateProject({ ...project, tracks: [track, track] })).toThrow(/duplicates/)
    expect(() => validateProject({ ...project, tracks: [{ ...track, effects: { ...track.effects, filter: 1 } }] })).toThrow(/filter frequency/)
    track.clips = [midi()]
    const clip = track.clips[0] as MidiClip
    clip.notes[0].velocity = 100
    expect(() => validateProject({ ...project, tracks: [track] })).toThrow(/velocity/)
  })
})

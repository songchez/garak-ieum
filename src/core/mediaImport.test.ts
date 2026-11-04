import { describe, expect, it, vi } from 'vitest'
import { createEmptyProject, createTrack, validateProject } from './project'
import { ProjectSession } from './ProjectSession'
import { isMidiFile, MEDIA_FILE_ACCEPT, planMediaImport, readMediaFile, type ImportedMedia } from './mediaImport'
import { MAX_MIDI_FILE_BYTES, type MidiImportResult } from './midiImport'
import type { AudioAsset, Project } from './types'

const midiBytes = () => new Uint8Array([
  0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 1, 0xe0,
  0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 13,
  0, 0x90, 60, 100, 0x83, 0x60, 0x80, 60, 0, 0, 0xff, 0x2f, 0,
])
const midi = (overrides: Partial<MidiImportResult> = {}): MidiImportResult => ({
  tracks: [{ name: 'Piano part', channel: 0, notes: [{ pitch: 60, start: .5, duration: 1.25, velocity: .75 }] }],
  lengthBeats: 4, bpm: 120, timeSignature: { numerator: 4, denominator: 4 }, warnings: [], ...overrides,
})
const midiFile = (data = midi(), name = 'phrase.mid'): ImportedMedia => ({ kind: 'midi', name, midi: data })
const audio = (): AudioAsset => ({ id: 'pcm', name: 'take.wav', blob: new Blob(['wave']), peaks: [], buffer: { duration: 2 } as AudioBuffer })
const audioFile = (): ImportedMedia => ({ kind: 'audio', name: 'take.wav', asset: audio() })

describe('media file routing', () => {
  it.each([
    { name: 'part.MID', type: '' }, { name: 'part.midi', type: 'application/octet-stream' },
    { name: 'part.smf', type: '' }, { name: 'unnamed', type: 'audio/midi' }, { name: 'unnamed', type: 'audio/x-midi' },
  ])('recognizes MIDI extensions and MIME types without an audio decoder: %j', file => {
    expect(isMidiFile(file)).toBe(true)
    expect(MEDIA_FILE_ACCEPT).toContain('.mid,.midi')
  })

  it.each(['part.MID', 'mislabelled.dat'])('reads editable note data from %s without constructing or calling audio codecs', async name => {
    const decode = vi.fn(), file = new File([midiBytes()], name, { type: 'application/octet-stream' })
    const result = await readMediaFile(file, decode)
    expect(result.kind).toBe('midi')
    if (result.kind !== 'midi') throw new Error('Wrong route')
    expect(result.midi.tracks[0].notes).toEqual([{ pitch: 60, start: 0, duration: 1, velocity: 100 / 127 }])
    expect(decode).not.toHaveBeenCalled()
  })

  it('retains the audio decode path and rejects malformed or oversized MIDI before touching it', async () => {
    const asset = audio(), decode = vi.fn(async () => asset), file = new File(['RIFFwave'], 'take.wav')
    await expect(readMediaFile(file, decode)).resolves.toEqual({ kind: 'audio', name: 'take.wav', asset })
    expect(decode).toHaveBeenCalledExactlyOnceWith(file, 'take.wav')
    await expect(readMediaFile(new File(['not MIDI'], 'broken.mid'), decode)).rejects.toThrow()
    const arrayBuffer = vi.fn(), oversized = { name: 'large.mid', type: '', size: MAX_MIDI_FILE_BYTES + 1, arrayBuffer } as unknown as File
    await expect(readMediaFile(oversized, decode)).rejects.toThrow('16 MB')
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(decode).toHaveBeenCalledTimes(1)
  })
})

describe('atomic MIDI and audio project import', () => {
  it('adopts initial tempo and meter only for one MIDI file at the start of a new empty project', () => {
    const original = createEmptyProject(), data = midi({ bpm: 90, timeSignature: { numerator: 6, denominator: 8 } })
    const plan = planMediaImport(original, [midiFile(data)])
    expect(plan.project).toMatchObject({ bpm: 90, timeSignature: { numerator: 6, denominator: 8 }, beatsPerBar: 3 })
    const track = plan.project.tracks[0], clip = track.clips[0]
    expect(track.instrument).toBe('keys')
    expect(clip).toMatchObject({ kind: 'midi', startBeat: 0, lengthBeats: 4, notes: [{ pitch: 60, start: .5, duration: 1.25, velocity: .75 }] })
    expect(plan.assets).toEqual([])
    expect(plan).toMatchObject({ midiFiles: 1, audioFiles: 0 })
    expect(original.tracks).toEqual([]); expect(original.bpm).toBe(96)
    expect(validateProject(plan.project)).toEqual(plan.project)
  })

  it('places a single MIDI part on the chosen instrument without replacing its WAVE patch or existing clips', () => {
    const wave = { ...createTrack('instrument', 'wavetable'), id: 'target' }
    const original = { ...createEmptyProject(), bpm: 104, tracks: [wave] }
    const plan = planMediaImport(original, [midiFile()], { trackId: wave.id, beat: 12 })
    expect(plan.project.bpm).toBe(104)
    expect(plan.project.tracks).toHaveLength(1)
    const track = plan.project.tracks[0]
    expect(track.instrument).toBe('wavetable')
    expect(track.instrumentParams).toBe(wave.instrumentParams)
    expect(track.instrumentState).toBe(wave.instrumentState)
    expect(track.clips[0]).toMatchObject({ startBeat: 12, kind: 'midi', notes: [{ start: .5, duration: 1.25 }] })
    expect(wave.clips).toEqual([])
    expect(plan.placements[0].trackId).toBe('target')
    expect(plan.warnings.join(' ')).toContain('템포를 유지')
  })

  it('keeps multi-part MIDI aligned on separate lanes and routes channel 10 to drums', () => {
    const target = { ...createTrack('instrument', 'wavetable'), id: 'target' }, after = { ...createTrack('audio'), id: 'after' }
    const original = { ...createEmptyProject(), tracks: [target, after] }
    const data = midi({ tracks: [
      ...midi().tracks,
      { name: 'Drum part', channel: 9, program: 0, notes: [{ pitch: 36, start: 1, duration: .25, velocity: .9 }] },
    ] })
    const plan = planMediaImport(original, [midiFile(data)], { trackId: target.id, beat: 8 })
    expect(plan.project.tracks.map(track => track.instrument)).toEqual(['wavetable', 'keys', 'drums', 'keys'])
    expect(plan.project.tracks[0]).toBe(target)
    expect(plan.project.tracks.at(-1)).toBe(after)
    expect(plan.project.tracks.slice(1, 3).map(track => track.clips[0].startBeat)).toEqual([8, 8])
    const ids = plan.project.tracks.slice(1, 3).flatMap(track => [track.id, ...track.clips.flatMap(clip => [clip.id, ...(clip.kind === 'midi' ? clip.notes.map(note => note.id) : [])])])
    expect(new Set(ids).size).toBe(ids.length)
    expect(plan.warnings.join(' ')).toContain('기본 건반·드럼')
    expect(validateProject(plan.project)).toEqual(plan.project)
  })

  it.each([true, false])('preserves tempo and audio duration in mixed imports regardless of file order (%s)', midiFirst => {
    const p = createEmptyProject(), items = [midiFile(midi({ bpm: 60, timeSignature: { numerator: 3, denominator: 4 } })), audioFile()]
    const plan = planMediaImport(p, midiFirst ? items : [...items].reverse(), { beat: 4 })
    expect(plan.project.bpm).toBe(96)
    expect(plan.project.timeSignature).toEqual({ numerator: 4, denominator: 4 })
    const clip = plan.project.tracks.find(track => track.kind === 'audio')!.clips[0]
    expect(clip).toMatchObject({ kind: 'audio', startBeat: 4, lengthBeats: 3.2 })
    expect(plan.assets).toHaveLength(1)
    expect(plan.placements).toHaveLength(2)
    expect(plan.warnings.join(' ')).toContain('템포를 유지')
    expect(plan.warnings.join(' ')).toContain('박자를 유지')
  })

  it('reports unsupported tempo/meter and parser limitations while preserving note positions', () => {
    const plan = planMediaImport(createEmptyProject(), [midiFile(midi({ bpm: 480, timeSignature: { numerator: 4, denominator: 32 }, warnings: ['템포 변경은 반영하지 않았습니다.'] }))])
    expect(plan.project.bpm).toBe(96)
    expect(plan.project.timeSignature).toEqual({ numerator: 4, denominator: 4 })
    expect(plan.warnings).toHaveLength(3)
    expect(plan.warnings.join(' ')).toContain('템포 변경')
    expect(plan.project.tracks[0].clips[0]).toMatchObject({ notes: [{ start: .5, duration: 1.25 }] })
  })

  it('prepares the whole import before one undoable edit and leaves the original untouched on invalid MIDI', () => {
    const original = createEmptyProject(), session = new ProjectSession(original)
    expect(() => planMediaImport(original, [audioFile(), midiFile(midi({ tracks: [] }))])).toThrow('MIDI 음표')
    expect(original.tracks).toEqual([])
    const plan = planMediaImport(original, [midiFile()])
    session.edit(() => plan.project, '', '오디오·MIDI 가져오기')
    expect(session.getSnapshot().history.past).toHaveLength(1)
    session.dispatch({ type: 'undo' })
    expect(session.getSnapshot().history.present.tracks).toEqual([])
    session.dispatch({ type: 'redo' })
    expect(session.getSnapshot().history.present).toEqual(plan.project)
  })

  it('does not adopt file tempo when importing at a later beat or into an existing marker arrangement', () => {
    const empty = createEmptyProject(), marked: Project = { ...empty, markers: [{ id: 'marker', name: 'Intro', startBeat: 0 }] }
    expect(planMediaImport(empty, [midiFile()], { beat: 4 }).project.bpm).toBe(96)
    expect(planMediaImport(marked, [midiFile()]).project.bpm).toBe(96)
  })

  it('validates the complete planned project before a mixed batch can be committed', () => {
    const original = createEmptyProject(), invalid = midi({ tracks: [{ name: 'Invalid pitch', channel: 0, notes: [{ pitch: 128, start: 0, duration: 1, velocity: .8 }] }] })
    expect(() => planMediaImport(original, [audioFile(), midiFile(invalid)])).toThrow(/pitch/i)
    expect(original.tracks).toEqual([])
  })
})

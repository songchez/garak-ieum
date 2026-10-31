import { describe, expect, it } from 'vitest'
import { audibleTrackIds, audioWindows, clipOccurrences, loopEnd, midiEvents, playbackNotes, trackNote } from './playback'
import type { AudioClip, MidiClip, MidiNote, Track } from './types'

const track = (patch: Partial<Track> = {}): Track => ({
  id: 't', name: 'Track', kind: 'instrument', instrument: 'keys', color: '#000000', volume: 1, pan: 0,
  mute: false, solo: false, soloSafe: false, enabled: true, armed: false, monitor: false, hidden: false,
  transpose: 0, velocityOffset: 0, keyLimit: [0, 127], velocityLimit: [1, 127], delayTicks: 0,
  clips: [], instrumentParams: {}, devices: [],
  ...patch,
})
const midi = (patch: Partial<MidiClip> = {}): MidiClip => ({
  id: 'm', kind: 'midi', name: 'Midi', startBeat: 0, lengthBeats: 4, gain: 1, notes: [], ...patch,
})
const audio = (patch: Partial<AudioClip> = {}): AudioClip => ({
  id: 'a', kind: 'audio', name: 'Audio', startBeat: 0, lengthBeats: 4, gain: 1, assetId: 'asset', offsetSeconds: 0, fadeIn: 0, fadeOut: 0, ...patch,
})
const note = (start: number, duration = 1, pitch = 60, velocity = 1): MidiNote => ({ id: `n${start}-${pitch}`, pitch, start, duration, velocity })
const occ = (start: number, end: number, index = 0) => ({ start, end, index })
const starts = (notes: { start: number }[]): number[] => notes.map(item => Math.round(item.start * 1e6) / 1e6)

describe('audibleTrackIds', () => {
  it('mutes and disables tracks, and ignores solo on disabled tracks', () => {
    const tracks = [
      track({ id: 'a' }), track({ id: 'b', mute: true }), track({ id: 'c', enabled: false }), track({ id: 'd', enabled: false, solo: true }),
    ]
    expect([...audibleTrackIds(tracks)]).toEqual(['a'])
  })

  it('keeps solo and solo-safe tracks when any enabled track is soloed', () => {
    const tracks = [
      track({ id: 'a' }), track({ id: 'b', solo: true }), track({ id: 'c', soloSafe: true }),
      track({ id: 'd', solo: true, mute: true }), track({ id: 'e', soloSafe: true, enabled: false }),
    ]
    expect([...audibleTrackIds(tracks)]).toEqual(['b', 'c'])
  })

  it('treats a missing enabled flag as enabled', () => {
    const legacy = { ...track({ id: 'a' }), enabled: undefined } as unknown as Track
    expect(audibleTrackIds([legacy]).has('a')).toBe(true)
  })
})

describe('loopEnd and clipOccurrences', () => {
  it('ends a non-looping clip at its own end as a single occurrence', () => {
    const clip = midi({ startBeat: 2, lengthBeats: 4 })
    const owner = track({ clips: [clip, midi({ id: 'next', startBeat: 4 })] })
    expect(loopEnd(owner, clip, 100)).toBe(6)
    expect(clipOccurrences(owner, clip, 100)).toEqual([occ(2, 6)])
  })

  it('loops until the next clip on the track, counting muted clips but not earlier ones', () => {
    const clip = midi({ startBeat: 4, lengthBeats: 2, loop: true })
    const owner = track({ clips: [midi({ id: 'before', startBeat: 0 }), clip, midi({ id: 'muted', startBeat: 11, mute: true }), midi({ id: 'later', startBeat: 20 })] })
    expect(loopEnd(owner, clip, 100)).toBe(11)
    expect(clipOccurrences(owner, clip, 100)).toEqual([occ(4, 6, 0), occ(6, 8, 1), occ(8, 10, 2), occ(10, 11, 3)])
  })

  it('loops to the project end when nothing follows', () => {
    const clip = midi({ startBeat: 1, lengthBeats: 4, loop: true })
    const owner = track({ clips: [clip] })
    expect(loopEnd(owner, clip, 10)).toBe(10)
    expect(clipOccurrences(owner, clip, 10)).toEqual([occ(1, 5, 0), occ(5, 9, 1), occ(9, 10, 2)])
  })

  it('never shortens a looping clip below its own end when the next clip overlaps it', () => {
    const clip = midi({ startBeat: 0, lengthBeats: 4, loop: true })
    const owner = track({ clips: [clip, midi({ id: 'overlap', startBeat: 2 })] })
    expect(loopEnd(owner, clip, 100)).toBe(4)
    expect(clipOccurrences(owner, clip, 100)).toEqual([occ(0, 4)])
  })

  it('produces nothing for an empty-length clip and only the clip itself past the project end', () => {
    expect(clipOccurrences(track(), midi({ lengthBeats: 0 }), 100)).toEqual([])
    expect(clipOccurrences(track(), midi({ startBeat: 8, lengthBeats: 4, loop: true }), 8)).toEqual([occ(8, 12)])
  })
})

describe('playbackNotes quantize and swing', () => {
  it('rounds to the grid and shifts odd steps by the swing amount, keeping durations', () => {
    const clip = midi({ quantize: 0.5, swing: 66, notes: [note(0, 0.4), note(0.3, 0.2), note(0.55, 0.5), note(1.2, 1), note(1.7, 0.1)] })
    const notes = playbackNotes(track(), clip, occ(0, 4))
    expect(starts(notes)).toEqual([0, 0.66, 0.66, 1, 1.66])
    expect(notes.map(item => Math.round((item.end - item.start) * 1e6) / 1e6)).toEqual([0.4, 0.2, 0.5, 1, 0.1])
  })

  it('leaves odd steps straight at swing 50 and pulls them a full grid early at swing 0', () => {
    const notes = [note(0.9), note(1.1), note(2.1)]
    expect(starts(playbackNotes(track(), midi({ quantize: 1, swing: 50, notes }), occ(0, 4)))).toEqual([1, 1, 2])
    expect(starts(playbackNotes(track(), midi({ quantize: 1, swing: 0, notes }), occ(0, 4)))).toEqual([0, 0, 2])
    expect(starts(playbackNotes(track(), midi({ quantize: 1, notes }), occ(0, 4)))).toEqual([1, 1, 2])
  })

  it('does not quantize when the grid is off and drops notes quantized onto the clip end', () => {
    expect(starts(playbackNotes(track(), midi({ quantize: 0, swing: 90, notes: [note(0.3)] }), occ(0, 4)))).toEqual([0.3])
    expect(playbackNotes(track(), midi({ quantize: 1, notes: [note(3.8)] }), occ(0, 4))).toEqual([])
  })

  it('offsets absolute starts by the occurrence start', () => {
    const notes = playbackNotes(track(), midi({ startBeat: 8, quantize: 1, notes: [note(1.4)] }), occ(12, 16, 1))
    expect(starts(notes)).toEqual([13])
  })
})

describe('playbackNotes delay, transpose, velocity and limits', () => {
  it('sums clip and track delay in ticks, and a negative delay keeps the first note', () => {
    const clip = midi({ delayTicks: 480, notes: [note(0, 1), note(3.5, 1)] })
    const late = playbackNotes(track({ delayTicks: 240 }), clip, occ(0, 4))
    expect(starts(late)).toEqual([0.75, 4.25])
    expect(late[1].end).toBeCloseTo(4.75)
    const early = playbackNotes(track({ delayTicks: -1920 }), midi({ delayTicks: 480, notes: [note(0, 1)] }), occ(4, 8))
    expect(early).toHaveLength(1)
    expect(early[0].start).toBeCloseTo(2.5)
    expect(early[0].limit).toBeCloseTo(6.5)
  })

  it('transposes by clip plus track and drops pitches outside 0…127', () => {
    const clip = midi({ transpose: 5, notes: [note(0, 1, 60), note(1, 1, 120), note(2, 1, 2)] })
    expect(playbackNotes(track({ transpose: 7 }), clip, occ(0, 4)).map(item => item.pitch)).toEqual([72, 14])
    expect(playbackNotes(track({ transpose: -12 }), clip, occ(0, 4)).map(item => item.pitch)).toEqual([53, 113])
  })

  it('offsets velocity in MIDI units, clamps to 1…127 and multiplies by clip gain', () => {
    const clip = midi({ velocity: 10, gain: 0.5, notes: [note(0, 1, 60, 0.5), note(1, 1, 60, 1), note(2, 1, 60, 0)] })
    const notes = playbackNotes(track({ velocityOffset: -5 }), clip, occ(0, 4))
    expect(notes.map(item => item.velocity)).toEqual([69 / 127 * 0.5, 1 * 0.5, 5 / 127 * 0.5])
    expect(playbackNotes(track({ velocityOffset: -120 }), clip, occ(0, 4)).map(item => item.velocity)).toEqual([1 / 127 * 0.5, 17 / 127 * 0.5, 1 / 127 * 0.5])
  })

  it('drops notes outside the key and velocity limits after transpose and offset', () => {
    const clip = midi({ notes: [note(0, 1, 59, 1), note(1, 1, 60, 1), note(2, 1, 72, 0.5), note(3, 1, 73, 1)] })
    const keyed = playbackNotes(track({ keyLimit: [60, 72] }), clip, occ(0, 4))
    expect(keyed.map(item => item.pitch)).toEqual([60, 72])
    const velocity = playbackNotes(track({ velocityLimit: [100, 127] }), clip, occ(0, 4))
    expect(velocity.map(item => item.pitch)).toEqual([59, 60, 73])
    const shifted = playbackNotes(track({ keyLimit: [60, 72], transpose: 1 }), clip, occ(0, 4))
    expect(shifted.map(item => item.pitch)).toEqual([60, 61])
  })

  it('crops notes to the occurrence window and drops notes that start at or after it', () => {
    const clip = midi({ lengthBeats: 4, notes: [note(3, 4), note(4, 1), note(-1, 2), note(1, 0)] })
    const full = playbackNotes(track(), clip, occ(0, 4))
    expect(full.map(item => [item.start, item.end])).toEqual([[3, 4], [0, 2]])
    const partial = playbackNotes(track(), clip, occ(8, 10, 2))
    expect(partial.map(item => [item.start, item.end, item.limit])).toEqual([[8, 10, 10]])
    const cropped = playbackNotes(track(), midi({ lengthBeats: 4, notes: [note(1, 3)] }), occ(8, 10, 2))
    expect(cropped.map(item => [item.start, item.end, item.limit])).toEqual([[9, 10, 10]])
  })

  it('tolerates objects created before the playback fields existed', () => {
    const legacy = { ...track(), transpose: undefined, velocityOffset: undefined, keyLimit: undefined, velocityLimit: undefined, delayTicks: undefined } as unknown as Track
    const notes = playbackNotes(legacy, midi({ notes: [note(0, 1, 60, 0.8)] }), occ(0, 4))
    expect(notes).toEqual([{ pitch: 60, start: 0, end: 1, velocity: 102 / 127, limit: 4 }])
  })
})

describe('audioWindows', () => {
  it('cuts the earlier clip where a later clip starts and ends after it', () => {
    const owner = track({ kind: 'audio', clips: [audio({ id: 'a', startBeat: 0, lengthBeats: 4 }), audio({ id: 'b', startBeat: 2, lengthBeats: 4 })] })
    expect(audioWindows(owner, 100).map(item => [item.clip.id, item.start, item.end])).toEqual([['a', 0, 2], ['b', 2, 6]])
  })

  it('does not resume the earlier clip after a later clip that ends inside it', () => {
    const owner = track({ kind: 'audio', clips: [audio({ id: 'b', startBeat: 1, lengthBeats: 1 }), audio({ id: 'a', startBeat: 0, lengthBeats: 4 })] })
    expect(audioWindows(owner, 100).map(item => [item.clip.id, item.start, item.end])).toEqual([['b', 1, 2], ['a', 0, 1]])
  })

  it('lets the higher array index win when two clips start together', () => {
    const owner = track({ kind: 'audio', clips: [audio({ id: 'a', startBeat: 0, lengthBeats: 4 }), audio({ id: 'b', startBeat: 0, lengthBeats: 2 })] })
    expect(audioWindows(owner, 100).map(item => [item.clip.id, item.start, item.end])).toEqual([['b', 0, 2]])
  })

  it('skips muted clips, which also do not cut other clips', () => {
    const owner = track({ kind: 'audio', clips: [audio({ id: 'a', startBeat: 0, lengthBeats: 4 }), audio({ id: 'b', startBeat: 2, lengthBeats: 4, mute: true })] })
    expect(audioWindows(owner, 100).map(item => [item.clip.id, item.start, item.end])).toEqual([['a', 0, 4]])
  })

  it('expands loops with delay and lets a following clip cut the last repeat', () => {
    const owner = track({ kind: 'audio', delayTicks: 240, clips: [audio({ id: 'a', startBeat: 0, lengthBeats: 2, loop: true }), audio({ id: 'b', startBeat: 5, lengthBeats: 2, delayTicks: -240 })] })
    expect(audioWindows(owner, 100).map(item => [item.clip.id, item.start, item.end, item.sourceOffsetBeats])).toEqual([
      ['a', 0.25, 2.25, 0], ['a', 2.25, 4.25, 0], ['a', 4.25, 5, 0], ['b', 5, 7, 0],
    ])
  })

  it('ignores MIDI clips on the same track', () => {
    const owner = track({ clips: [midi({ id: 'm', startBeat: 1 }), audio({ id: 'a', startBeat: 0, lengthBeats: 4 })] })
    expect(audioWindows(owner, 100).map(item => [item.clip.id, item.start, item.end])).toEqual([['a', 0, 4]])
  })
})

describe('midiEvents', () => {
  it('expands looping clips across occurrences and skips muted and audio clips', () => {
    const owner = track({
      clips: [
        midi({ id: 'loop', startBeat: 0, lengthBeats: 2, loop: true, notes: [note(0, 1, 60), note(1.5, 1, 62)] }),
        midi({ id: 'muted', startBeat: 5, mute: true, notes: [note(0, 1, 70)] }),
        audio({ id: 'a', startBeat: 6 }),
        midi({ id: 'last', startBeat: 6, lengthBeats: 2, notes: [note(0, 1, 64)] }),
      ],
    })
    const events = midiEvents(owner, 100)
    expect(events.map(item => [item.pitch, item.start, item.end])).toEqual([
      [60, 0, 1], [62, 1.5, 2], [60, 2, 3], [62, 3.5, 4], [60, 4, 5], [64, 6, 7],
    ])
  })

  it('returns a single occurrence for a non-looping clip', () => {
    const owner = track({ clips: [midi({ startBeat: 3, lengthBeats: 2, notes: [note(0, 1), note(1, 1)] })] })
    expect(starts(midiEvents(owner, 100))).toEqual([3, 4])
  })
})

describe('trackNote', () => {
  it('passes live notes through track transpose, velocity offset and limits', () => {
    expect(trackNote(undefined, 60, 0.8)).toEqual({ pitch: 60, velocity: 0.8 })
    expect(trackNote(track({ transpose: 12, velocityOffset: 25 }), 60, 0.8)).toEqual({ pitch: 72, velocity: 127 / 127 })
    expect(trackNote(track({ keyLimit: [48, 59] }), 60, 0.8)).toBeNull()
    expect(trackNote(track({ velocityLimit: [1, 50] }), 60, 0.8)).toBeNull()
    expect(trackNote(track({ transpose: 90 }), 60, 0.8)).toBeNull()
  })
})

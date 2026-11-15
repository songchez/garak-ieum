import { parseMidi } from './midiInput'
import { MIN_RECORDED_NOTE, type RecordedNote } from './midiRecording'
import type { StampedMidi } from '../audio/liveMidi'

/**
 * 캡처 (Ableton Capture MIDI, Logic Capture Recording): the last few minutes of live input are kept while not
 * recording, and one command turns the last performance into a region (docs/MIDI_RECORDING.md).
 */
export const CAPTURE_WINDOW_MS = 5 * 60_000
export const CAPTURE_MAX_EVENTS = 20_000
/** Silence that separates two performances while the transport is stopped. */
export const CAPTURE_GAP_MS = 4_000

export interface CaptureEvent { source: string; data: readonly number[]; time: number; beat: number | null }

export class MidiCaptureBuffer {
  private events: CaptureEvent[] = []

  constructor(private readonly windowMs = CAPTURE_WINDOW_MS, private readonly maxEvents = CAPTURE_MAX_EVENTS) {}

  push(event: StampedMidi | CaptureEvent): void {
    const message = parseMidi(event.data)
    if (message.type === 'other') return
    this.events.push({ source: event.source, data: [...event.data].slice(0, 3), time: event.time, beat: event.beat })
    this.prune(event.time)
  }

  private prune(now: number): void {
    const oldest = now - this.windowMs
    let drop = 0
    while (drop < this.events.length && (this.events[drop].time < oldest || this.events.length - drop > this.maxEvents)) drop += 1
    if (drop) this.events.splice(0, drop)
  }

  clear(): void { this.events = [] }
  get size(): number { return this.events.length }
  snapshot(): readonly CaptureEvent[] { return this.events }
}

export interface CaptureTrack { notes: RecordedNote[]; startBeat: number; endBeat: number; playing: boolean }

/**
 * The last performance: the events after the last silence of `gapMs` with no held note. When it was played over a
 * running transport (every note-on has a beat), notes keep their beats; otherwise times convert at the project
 * tempo and the first note lands on `playheadBeat`. `accepts` filters by the target track's MIDI input.
 */
export function capturePerformance(
  events: readonly CaptureEvent[],
  options: { bpm: number; playheadBeat: number; gapMs?: number; accepts?: (source: string, channel: number) => boolean },
): CaptureTrack | null {
  const accepts = options.accepts ?? (() => true)
  const gap = options.gapMs ?? CAPTURE_GAP_MS
  const relevant = events.filter(event => {
    const message = parseMidi(event.data)
    return (message.type === 'noteOn' || message.type === 'noteOff') && accepts(event.source, message.channel)
  })
  if (!relevant.some(event => parseMidi(event.data).type === 'noteOn')) return null
  // Walk back from the end until a silent gap with nothing held.
  let first = relevant.length - 1
  const held = new Set<string>()
  for (let index = relevant.length - 1; index >= 0; index -= 1) {
    const event = relevant[index], message = parseMidi(event.data)
    if (message.type !== 'noteOn' && message.type !== 'noteOff') continue
    const key = `${event.source}:${message.channel}:${message.pitch}`
    // Walking backwards: a note-off opens a held span, its note-on closes it.
    if (message.type === 'noteOff') held.add(key)
    else held.delete(key)
    const previous = relevant[index - 1]
    first = index
    if (!previous || (held.size === 0 && event.time - previous.time >= gap)) break
    // A performance never mixes a running and a stopped transport: playing, then stopping, starts a new one.
    if ((previous.beat === null) !== (event.beat === null)) break
    // Over a running cycle only the last pass is captured: the beat jumped back between these two events.
    if (previous.beat !== null && event.beat !== null && previous.beat - event.beat > 0.25) break
  }
  const phrase = relevant.slice(first)
  const playing = phrase.every(event => event.beat !== null)
  const beatsPerMs = options.bpm / 60_000
  const origin = phrase[0].time
  const beatOf = (event: CaptureEvent) => playing ? event.beat! : options.playheadBeat + (event.time - origin) * beatsPerMs
  const open = new Map<string, { start: number; velocity: number }>()
  const notes: RecordedNote[] = []
  let lastBeat = beatOf(phrase[phrase.length - 1])
  for (const event of phrase) {
    const message = parseMidi(event.data)
    if (message.type !== 'noteOn' && message.type !== 'noteOff') continue
    const key = `${event.source}:${message.channel}:${message.pitch}`
    const beat = beatOf(event)
    const previous = open.get(key)
    // In a cycle the beat wraps backwards: end the note at its own start + a minimum length.
    if (previous) { notes.push({ pitch: message.pitch, start: previous.start, end: Math.max(beat, previous.start + MIN_RECORDED_NOTE), velocity: previous.velocity }); open.delete(key) }
    if (message.type === 'noteOn') open.set(key, { start: beat, velocity: message.velocity / 127 })
    lastBeat = Math.max(lastBeat, beat)
  }
  for (const [key, note] of open) notes.push({ pitch: Number(key.split(':').pop()), start: note.start, end: Math.max(lastBeat, note.start + MIN_RECORDED_NOTE), velocity: note.velocity })
  if (!notes.length) return null
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  return { notes, startBeat: Math.min(...notes.map(note => note.start)), endBeat: Math.max(...notes.map(note => note.end)), playing }
}


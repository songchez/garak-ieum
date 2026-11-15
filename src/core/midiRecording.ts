import type { MidiClip, MidiNote, Project, TrackMidiInput } from './types'
import { acceptsMidi, parseMidi } from './midiInput'
import { applyDragMode, fitProjectLength, joinClips, uid } from './project'
import { beatAfterSeconds, tempoMapOf, type Tempo, type TempoSource } from './tempoMap'
import { SUSTAIN_CONTROLLER, isPedalDown, spansToSustain } from './sustain'
import type { StampedMidi } from '../audio/liveMidi'

/**
 * MIDI recording (docs/MIDI_RECORDING.md): a take collects stamped live messages per armed track, shows them while
 * recording, and becomes one MIDI region per track on stop. Pure, so the timing rules are unit-tested.
 */

/** Live notes hold this long before the browser engine would end them on its own. */
export const LIVE_NOTE_HOLD_SECONDS = 60
/** Shortest recorded note (a 1/64): a note-off in the same instant as its note-on is still visible. */
export const MIN_RECORDED_NOTE = 1 / 16
const EPSILON = 1e-6

export type MidiRecordMode = 'merge' | 'replace'
export const MIDI_RECORD_MODE_LABELS: Record<MidiRecordMode, string> = { merge: '합치기', replace: '대체' }

/**
 * Transport beat heard at `contextTime` for a transport anchored at (anchorBeat, anchorTime). Unlike
 * `positionAfter` it may return a beat before the anchor (a note just ahead of the downbeat), and it wraps at the
 * cycle end the same way the scheduler does.
 */
export function heardTransportBeat(project: TempoSource & Pick<Project, 'loop' | 'lengthBeats'>, anchorBeat: number, anchorTime: number, contextTime: number): number {
  const tempo = tempoMapOf(project)
  const beat = tempo.beatAfter(anchorBeat, contextTime - anchorTime)
  const loop = project.loop.enabled && project.loop.endBeat - project.loop.startBeat > 0.001 ? project.loop : null
  if (loop && beat >= loop.endBeat) {
    const cycle = tempo.secondsBetween(loop.startBeat, loop.endBeat)
    return tempo.beatAfter(loop.startBeat, (tempo.secondsBetween(loop.endBeat, beat)) % cycle)
  }
  return beat
}

/** Native host frames (already latency compensated by the host) to beats through the tempo map. */
export const frameToBeat = (frame: number, sampleRate: number, tempo: Tempo): number => beatAfterSeconds(tempo, 0, frame / sampleRate)

/**
 * Latency compensation for a timestamp that only knows when the player pressed the key: subtract what the player
 * hears late (output latency) so the note lands on the beat they played along to.
 */
export const compensatedBeat = (beatAtArrival: number, latencySeconds: number, tempo: Tempo): number => beatAfterSeconds(tempo, beatAtArrival, -Math.max(0, latencySeconds))

export interface RecordedNote { pitch: number; start: number; end: number; velocity: number }
/** Raw controller data (CC64 becomes the region's sustain pedal; other controllers wait for the controller-lane work). */
export interface RecordedController { beat: number; channel: number; controller: number; value: number }
export interface TakeTrack { trackId: string; input: TrackMidiInput }
export interface MidiTakeOptions {
  startBeat: number
  /** Cycle recording: passes wrap inside it and merge. */
  cycle: { start: number; end: number } | null
  tracks: readonly TakeTrack[]
}
export interface MidiTakeTrackResult {
  trackId: string
  notes: RecordedNote[]
  controllers: RecordedController[]
  /** Sustain pedal (CC64) down spans in absolute beats; passes of a cycle take are united. */
  sustain?: [number, number][]
}
export interface MidiTakeResult { startBeat: number; endBeat: number; cycle: MidiTakeOptions['cycle']; tracks: MidiTakeTrackResult[] }

interface OpenNote { start: number; velocity: number; pass: number }

/** One recording pass over several tracks. Notes keep raw input pitch/velocity: track transpose applies at playback. */
export class MidiTake {
  readonly startBeat: number
  readonly cycle: MidiTakeOptions['cycle']
  private readonly tracks: readonly TakeTrack[]
  private notes = new Map<string, RecordedNote[]>()
  private controllers = new Map<string, RecordedController[]>()
  private open = new Map<string, OpenNote>()
  /** Pedal-down beat per track (null = up) and finished spans. */
  private pedal = new Map<string, number | null>()
  private spans = new Map<string, [number, number][]>()
  private lastBeat: number
  private pass = 0
  private maxBeat: number
  /** Bumps whenever the visible notes change (cheap re-render check). */
  revision = 0

  constructor(options: MidiTakeOptions) {
    this.startBeat = options.startBeat
    this.cycle = options.cycle && options.cycle.end - options.cycle.start > EPSILON ? options.cycle : null
    this.tracks = options.tracks
    this.lastBeat = options.startBeat
    this.maxBeat = options.startBeat
    for (const track of options.tracks) { this.notes.set(track.trackId, []); this.controllers.set(track.trackId, []); this.pedal.set(track.trackId, null); this.spans.set(track.trackId, []) }
  }

  get trackIds(): string[] { return this.tracks.map(track => track.trackId) }

  private key(trackId: string, source: string, channel: number, pitch: number) { return `${trackId}\u0001${source}\u0001${channel}\u0001${pitch}` }

  /** Transport position from the UI clock, so a cycle wrap is seen even when no key was played around it. */
  tick(beat: number): void { if (Number.isFinite(beat)) this.advance(beat) }

  /** Detects a cycle wrap; held notes end at the cycle end (Logic) and are not continued in the next pass. */
  private advance(beat: number): void {
    if (this.cycle && beat < this.lastBeat - EPSILON && this.lastBeat - beat > (this.cycle.end - this.cycle.start) / 2) {
      this.pass += 1
      for (const [key, note] of this.open) {
        const trackId = key.split('\u0001')[0]
        this.push(trackId, note.start, this.cycle.end, key, note.velocity)
      }
      this.open.clear()
      // A pedal held through the wrap closes at the cycle end and keeps holding from the cycle start.
      for (const [trackId, downAt] of this.pedal) if (downAt !== null) { this.closePedal(trackId, downAt, this.cycle.end); this.pedal.set(trackId, this.cycle.start) }
    }
    this.lastBeat = beat
    this.maxBeat = Math.max(this.maxBeat, beat)
  }

  private push(trackId: string, start: number, end: number, key: string, velocity: number): void {
    const pitch = Number(key.split('\u0001')[3])
    const limit = this.cycle ? this.cycle.end : Infinity
    const safeEnd = Math.min(limit, Math.max(end, start + MIN_RECORDED_NOTE))
    this.notes.get(trackId)?.push({ pitch, start, end: safeEnd, velocity })
    this.revision += 1
  }

  private closePedal(trackId: string, start: number, end: number): void {
    if (end - start > EPSILON) { this.spans.get(trackId)?.push([start, end]); this.revision += 1 }
  }

  /** The pedal already down when recording started (pressed during the count-in) holds from the first recorded beat. */
  pedalAtStart(source: string, channel: number): void {
    for (const track of this.tracks) if (acceptsMidi(track.input, source, channel)) this.pedal.set(track.trackId, this.startBeat)
  }

  /** A note already held when recording started (played during the count-in) starts on the first recorded beat. */
  holdAtStart(source: string, channel: number, pitch: number, velocity127: number): void {
    for (const track of this.tracks) {
      if (!acceptsMidi(track.input, source, channel)) continue
      this.open.set(this.key(track.trackId, source, channel, pitch), { start: this.startBeat, velocity: velocity127 / 127, pass: this.pass })
    }
  }

  /** Returns true when the take changed. Messages without a beat (transport not running) are ignored. */
  input(event: Pick<StampedMidi, 'source' | 'data' | 'beat'>): boolean {
    if (event.beat === null || !Number.isFinite(event.beat)) return false
    const message = parseMidi(event.data)
    if (message.type === 'other' || message.type === 'pitchBend') return false
    let beat = event.beat
    this.advance(beat)
    if (this.cycle) beat = Math.min(Math.max(beat, this.cycle.start), this.cycle.end)
    // Played ahead of the record start (latency-compensated count-in tail): start on the first beat.
    if (this.pass === 0 && beat < this.startBeat) beat = this.startBeat
    let changed = false
    for (const track of this.tracks) {
      if (!acceptsMidi(track.input, event.source, message.channel)) continue
      if (message.type === 'controller') {
        this.controllers.get(track.trackId)?.push({ beat, channel: message.channel, controller: message.controller, value: message.value })
        if (message.controller === SUSTAIN_CONTROLLER) {
          const downAt = this.pedal.get(track.trackId) ?? null
          if (isPedalDown(message.value) && downAt === null) this.pedal.set(track.trackId, beat)
          else if (!isPedalDown(message.value) && downAt !== null) { this.closePedal(track.trackId, downAt, beat); this.pedal.set(track.trackId, null) }
        }
        continue
      }
      const key = this.key(track.trackId, event.source, message.channel, message.pitch)
      const open = this.open.get(key)
      if (open) { this.push(track.trackId, open.start, beat, key, open.velocity); this.open.delete(key); changed = true }
      if (message.type === 'noteOn') { this.open.set(key, { start: beat, velocity: message.velocity / 127, pass: this.pass }); changed = true; this.revision += 1 }
    }
    return changed
  }

  /** Recorded notes plus held notes drawn up to `nowBeat` (the live display). */
  preview(nowBeat: number): Map<string, RecordedNote[]> {
    const out = new Map<string, RecordedNote[]>()
    for (const [trackId, notes] of this.notes) out.set(trackId, [...notes])
    for (const [key, note] of this.open) {
      const [trackId, , , pitch] = key.split('\u0001')
      const end = this.cycle && nowBeat < note.start ? this.cycle.end : Math.max(nowBeat, note.start + MIN_RECORDED_NOTE)
      out.get(trackId)?.push({ pitch: Number(pitch), start: note.start, end, velocity: note.velocity })
    }
    return out
  }

  /** Furthest transport beat seen (for the growing region). */
  get reach(): number { return this.maxBeat }

  /** Closes held notes at `endBeat` (or the cycle end once the pass wrapped past them). */
  finish(endBeat: number): MidiTakeResult {
    const end = this.cycle ? Math.min(Math.max(endBeat, this.cycle.start), this.cycle.end) : Math.max(endBeat, this.startBeat)
    for (const [key, note] of this.open) {
      const trackId = key.split('\u0001')[0]
      this.push(trackId, note.start, end > note.start ? end : this.cycle ? this.cycle.end : end, key, note.velocity)
    }
    this.open.clear()
    for (const [trackId, downAt] of this.pedal) if (downAt !== null) { this.closePedal(trackId, downAt, end > downAt ? end : this.cycle ? this.cycle.end : end); this.pedal.set(trackId, null) }
    return {
      startBeat: this.startBeat, endBeat: Math.max(end, this.maxBeat), cycle: this.cycle,
      tracks: this.tracks.map(track => ({ trackId: track.trackId, notes: [...(this.notes.get(track.trackId) ?? [])].sort((a, b) => a.start - b.start || a.pitch - b.pitch), controllers: [...(this.controllers.get(track.trackId) ?? [])], sustain: [...(this.spans.get(track.trackId) ?? [])] })),
    }
  }
}

/** Region span of a take: the cycle, else whole bars around the recorded time and notes (at least one bar). */
export function takeSpan(result: Pick<MidiTakeResult, 'startBeat' | 'endBeat' | 'cycle'>, notes: readonly RecordedNote[], beatsPerBar: number): { start: number; end: number } {
  if (result.cycle) return { start: result.cycle.start, end: result.cycle.end }
  const bar = beatsPerBar > 0 ? beatsPerBar : 4
  const first = Math.min(result.startBeat, ...notes.map(note => note.start))
  const last = Math.max(result.endBeat, ...notes.map(note => note.end))
  const start = Math.max(0, Math.floor(first / bar + EPSILON) * bar)
  const end = Math.max(start + bar, Math.ceil(last / bar - EPSILON) * bar)
  return { start, end }
}

export interface CommitOptions { mode: MidiRecordMode; beatsPerBar: number; name: string }
export interface CommitResult { project: Project; clipIds: string[] }

/** One region from absolute-beat notes starting at `start`. */
export function recordedClip(notes: readonly RecordedNote[], start: number, end: number, name: string, pedal: readonly (readonly [number, number])[] = []): MidiClip {
  const sustain = spansToSustain(pedal.map(([from, to]) => [Math.max(start, from) - start, Math.min(end, to) - start] as [number, number]).filter(([from, to]) => to - from > EPSILON))
  return {
    ...(sustain.length ? { sustain } : {}),
    id: uid(), kind: 'midi', name, startBeat: start, lengthBeats: end - start, gain: 1,
    notes: notes.filter(note => note.end > start + EPSILON && note.start < end - EPSILON).map((note): MidiNote => {
      const noteStart = Math.max(start, note.start)
      return { id: uid(), pitch: note.pitch, start: noteStart - start, duration: Math.max(MIN_RECORDED_NOTE / 4, Math.min(end, note.end) - noteStart), velocity: Math.min(1, Math.max(1 / 127, note.velocity)) }
    }),
  }
}

/**
 * Writes a finished take into the project (one undo step for the caller). Empty tracks add nothing.
 * 합치기 (merge, default): MIDI regions overlapping the recording join it (Ableton arrangement overdub / Logic merge).
 * 대체 (replace): the recording cuts away whatever it covers on its track (Logic replace).
 */
export function commitMidiTake(project: Project, result: MidiTakeResult, options: CommitOptions): CommitResult {
  let next = project
  const clipIds: string[] = []
  for (const take of result.tracks) {
    if (!take.notes.length && !take.sustain?.length) continue
    const track = next.tracks.find(item => item.id === take.trackId)
    if (!track || track.kind !== 'instrument') continue
    const span = takeSpan(result, take.notes, options.beatsPerBar)
    let clip: MidiClip = recordedClip(take.notes, span.start, span.end, options.name, take.sustain)
    if (options.mode === 'replace') {
      next = { ...next, tracks: next.tracks.map(item => item.id === track.id ? { ...item, clips: [...item.clips, clip] } : item) }
      next = applyDragMode(next, [track.id], [clip.id], 'noOverlap')
    } else {
      const overlapping = track.clips.filter((existing): existing is MidiClip => existing.kind === 'midi'
        && existing.startBeat < span.end - EPSILON && existing.startBeat + existing.lengthBeats > span.start + EPSILON)
      if (overlapping.length) {
        const joined = joinClips([...overlapping, clip], tempoMapOf(next))
        if (joined && joined.kind === 'midi') clip = joined
      }
      const removed = new Set(overlapping.map(existing => existing.id))
      next = { ...next, tracks: next.tracks.map(item => item.id === track.id ? { ...item, clips: [...item.clips.filter(existing => !removed.has(existing.id)), clip] } : item) }
    }
    clipIds.push(clip.id)
  }
  return { project: clipIds.length ? fitProjectLength(next) : project, clipIds }
}

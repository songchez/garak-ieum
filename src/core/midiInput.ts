import type { Project, Track, TrackMidiInput } from './types'
import { trackNote } from './playback'
import { effectiveArm, monitorModeOf } from './trackActions'

/**
 * Live MIDI routing shared by both engines (docs/MIDI_RECORDING.md).
 *
 * Sources are strings: a Web MIDI input id, a native host device id, or `KEYBOARD_SOURCE` for
 * computer-keyboard playing. A route says which track hears which source/channel and carries the
 * track's playback parameters so the native host can transform notes on its audio thread exactly
 * like `trackNote` does here.
 */
export const KEYBOARD_SOURCE = 'keyboard'

export type ParsedMidi =
  | { type: 'noteOn'; channel: number; pitch: number; velocity: number }
  | { type: 'noteOff'; channel: number; pitch: number; velocity: number }
  | { type: 'controller'; channel: number; controller: number; value: number }
  | { type: 'pitchBend'; channel: number; value: number }
  | { type: 'aftertouch'; channel: number; value: number }
  | { type: 'program'; channel: number; program: number }
  | { type: 'other' }

/** channel is 1…16. A note-on with velocity 0 is a note-off (running-status keyboards send that). */
export function parseMidi(data: ArrayLike<number>): ParsedMidi {
  const status = data[0] ?? 0
  if (status < 0x80 || status >= 0xF0) return { type: 'other' }
  const kind = status & 0xF0, channel = (status & 0x0F) + 1
  const a = (data[1] ?? 0) & 0x7F, b = (data[2] ?? 0) & 0x7F
  if (kind === 0x90) return b > 0 ? { type: 'noteOn', channel, pitch: a, velocity: b } : { type: 'noteOff', channel, pitch: a, velocity: 0 }
  if (kind === 0x80) return { type: 'noteOff', channel, pitch: a, velocity: b }
  if (kind === 0xB0) return { type: 'controller', channel, controller: a, value: b }
  if (kind === 0xE0) return { type: 'pitchBend', channel, value: (b << 7 | a) - 8192 }
  if (kind === 0xD0) return { type: 'aftertouch', channel, value: a }
  if (kind === 0xC0) return { type: 'program', channel, program: a }
  return { type: 'other' }
}

export const noteOnMessage = (pitch: number, velocity: number, channel = 1): number[] => [0x90 | ((channel - 1) & 15), pitch & 0x7F, Math.max(1, Math.min(127, Math.round(velocity)))]
export const noteOffMessage = (pitch: number, channel = 1): number[] => [0x80 | ((channel - 1) & 15), pitch & 0x7F, 0]

/** Absent = every enabled input on every channel (the default). */
export const DEFAULT_MIDI_INPUT: TrackMidiInput = { source: 'all' }
export const midiInputOf = (track: Track): TrackMidiInput => track.midiInput ?? DEFAULT_MIDI_INPUT

/** Whether a track's input selection accepts a message from `source` on `channel` (1…16). The computer keyboard
 * counts as an input like any device, so 모든 MIDI 입력 hears it. */
export function acceptsMidi(input: TrackMidiInput, source: string, channel: number): boolean {
  if (input.source === 'none') return false
  if (input.source === 'device' && input.deviceId !== source) return false
  return !input.channel || input.channel === channel
}

/**
 * Instrument tracks that hear live MIDI (record-enable / arm + monitor):
 * I (`in`) always; `off` never; `auto` while armed, or while the track is focused and no instrument track is
 * armed (auto arm). A muted track still receives notes (its fader silences them), a disabled track does not.
 */
export function liveMidiTrackIds(project: Project, focusedTrackId: string | null): string[] {
  return project.tracks.filter(track => {
    if (track.kind !== 'instrument' || track.enabled === false || midiInputOf(track).source === 'none') return false
    const mode = monitorModeOf(track)
    if (mode === 'in') return true
    if (mode === 'off') return false
    return effectiveArm(track, focusedTrackId, project.tracks) !== 'off'
  }).map(track => track.id)
}

/** Instrument tracks a MIDI recording pass writes to: every armed one, else the auto-armed focused one. */
export function midiRecordTrackIds(project: Project, focusedTrackId: string | null): string[] {
  const armed = project.tracks.filter(track => track.kind === 'instrument' && track.enabled !== false && track.armed)
  if (armed.length) return armed.map(track => track.id)
  const focused = project.tracks.find(track => track.id === focusedTrackId)
  return focused && focused.kind === 'instrument' && focused.enabled !== false && !project.tracks.some(t => t.kind === 'audio' && t.armed) ? [focused.id] : []
}

export interface MidiRoute {
  trackId: string
  /** null = every input. */
  device: string | null
  /** 0 = every channel, else 1…16. */
  channel: number
  transpose: number
  velocityOffset: number
  keyLow: number
  keyHigh: number
  velocityLow: number
  velocityHigh: number
}

export function midiRoutes(project: Project, trackIds: readonly string[]): MidiRoute[] {
  const wanted = new Set(trackIds)
  return project.tracks.filter(track => wanted.has(track.id)).map(track => {
    const input = midiInputOf(track)
    return {
      trackId: track.id,
      device: input.source === 'device' ? input.deviceId ?? '' : null,
      channel: input.channel ?? 0,
      transpose: track.transpose ?? 0,
      velocityOffset: track.velocityOffset ?? 0,
      keyLow: track.keyLimit?.[0] ?? 0, keyHigh: track.keyLimit?.[1] ?? 127,
      velocityLow: track.velocityLimit?.[0] ?? 1, velocityHigh: track.velocityLimit?.[1] ?? 127,
    }
  })
}

export const routeAccepts = (route: MidiRoute, source: string, channel: number): boolean =>
  (route.device === null || route.device === source) && (!route.channel || route.channel === channel)

/** Same transform as `trackNote` (and the native host): pitch/velocity after the route's track parameters, or null. */
export function routeNote(route: MidiRoute, pitch: number, velocity127: number): { pitch: number; velocity: number } | null {
  return trackNote({ transpose: route.transpose, velocityOffset: route.velocityOffset, keyLimit: [route.keyLow, route.keyHigh], velocityLimit: [route.velocityLow, route.velocityHigh] } as Track, pitch, velocity127 / 127)
}

export interface RoutedNote { trackId: string; pitch: number; velocity: number }

/**
 * Held notes keyed by the incoming (source, channel, pitch). A note-off releases what its note-on started, even when
 * routes changed in between, so switching tracks never strands a note. `retain` releases notes whose track lost its route.
 */
export class HeldNotes<T extends { trackId: string } = RoutedNote> {
  private held = new Map<string, T[]>()
  private key = (source: string, channel: number, pitch: number) => `${source}\u0000${channel}\u0000${pitch}`

  noteOn(source: string, channel: number, pitch: number, notes: T[]): T[] {
    // A repeated note-on without a note-off (some keyboards) first releases the previous one.
    const key = this.key(source, channel, pitch)
    const previous = this.held.get(key) ?? []
    if (notes.length) this.held.set(key, notes)
    else this.held.delete(key)
    return previous
  }

  noteOff(source: string, channel: number, pitch: number): T[] {
    const key = this.key(source, channel, pitch)
    const notes = this.held.get(key) ?? []
    this.held.delete(key)
    return notes
  }

  /** Releases (and returns) held notes on tracks outside `trackIds`. */
  retain(trackIds: ReadonlySet<string>): T[] {
    const released: T[] = []
    for (const [key, notes] of this.held) {
      const keep = notes.filter(note => trackIds.has(note.trackId))
      released.push(...notes.filter(note => !trackIds.has(note.trackId)))
      if (keep.length) this.held.set(key, keep)
      else this.held.delete(key)
    }
    return released
  }

  /** Every held note, cleared (panic, stop). */
  /** Held notes from one source (All Notes Off on that input). */
  releaseSource(source: string): T[] {
    const released: T[] = []
    for (const [key, notes] of this.held) if (key.startsWith(`${source}\u0000`)) { released.push(...notes); this.held.delete(key) }
    return released
  }

  clear(): T[] {
    const all = [...this.held.values()].flat()
    this.held.clear()
    return all
  }

  get size(): number { return this.held.size }
}

/** Routes one note-on through every matching route. */
export function routeNoteOn(routes: readonly MidiRoute[], source: string, channel: number, pitch: number, velocity127: number): RoutedNote[] {
  const out: RoutedNote[] = []
  for (const route of routes) {
    if (!routeAccepts(route, source, channel)) continue
    const note = routeNote(route, pitch, velocity127)
    if (note) out.push({ trackId: route.trackId, ...note })
  }
  return out
}

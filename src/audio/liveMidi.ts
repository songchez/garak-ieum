import { HeldNotes, parseMidi, routeAccepts, routeNoteOn, type MidiRoute } from '../core/midiInput'
import { SUSTAIN_CONTROLLER, isPedalDown } from '../core/sustain'
import { keyOfNumber } from '../core/controllers'
import type { ControllerKey } from '../core/types'

/** One incoming MIDI message after the engine played it (docs/MIDI_RECORDING.md). */
export interface StampedMidi {
  source: string
  /** [status, data1, data2] */
  data: readonly number[]
  /** performance.now() milliseconds when it was played; the capture buffer uses it while the transport is stopped. */
  time: number
  /**
   * Transport beat the player heard when playing it: output (and, on the desktop, scheduling) latency is already
   * subtracted, so recording writes the note where it sounded against the arrangement. null while the transport
   * is not running (stopped, paused, count-in).
   */
  beat: number | null
}

export type StampedMidiListener = (event: StampedMidi) => void

/**
 * Live MIDI of one engine. Routes come from `midiRoutes` (core/midiInput.ts). Web Audio routes in JavaScript;
 * the native host routes and plays on its audio thread with sample offsets, then reports every message with its
 * transport frame. CC64 is the live sustain pedal in both engines; other controllers are reported for recording.
 */
export interface LiveMidiPort {
  setRoutes(routes: readonly MidiRoute[]): void
  /** Raw message from a source in this renderer (Web MIDI input, computer keyboard). timeStampMs: performance.now() base. */
  send(source: string, data: readonly number[], timeStampMs?: number): void
  /** Every message the engine received from any source, stamped. */
  subscribe(listener: StampedMidiListener): () => void
  /** Releases every live note (stop, panic, project switch). */
  panic(): void
}

/** A sounding live note in the browser engine; `release(timeMs)` gets the note-off's stamp (performance.now() base). */
export interface LiveVoiceHandle { release(timeMs?: number): void }

/**
 * `timeMs` arguments are the message's stamp (performance.now() base): the Rust engine starts each event on its
 * sample (docs/RUST_ENGINE.md 5.8); without one an event plays now.
 */
export interface WebLiveMidiHost {
  startNote(trackId: string, pitch: number, velocity: number, timeMs?: number): LiveVoiceHandle | null
  /** Transport beat heard at a performance.now() time, or null while not playing. */
  beatAt(timeMs: number): number | null
  /** Live controller (pitch bend, CCs other than the pedal, aftertouch) for a track's built-in instrument. */
  control?(trackId: string, key: ControllerKey, value: number, timeMs?: number): void
}

interface HeldVoice { trackId: string; pitch: number; voice: LiveVoiceHandle | null }

export class ListenerSet<T> {
  private listeners = new Set<(value: T) => void>()
  add(listener: (value: T) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(value: T): void { for (const listener of [...this.listeners]) { try { listener(value) } catch (error) { console.error(error) } } }
}

/**
 * Browser routing: note-ons start voices immediately (input latency = one audio quantum + output latency).
 * CC64 follows core/sustain.ts per track: while the pedal is down a note-off is deferred to the pedal-up, and
 * re-striking a sustained pitch ends its old voice at the new onset. Drum kits ignore the pedal (their voices
 * ring out regardless). The native host applies the same rules on its audio thread.
 */
export class WebLiveMidi implements LiveMidiPort {
  private routes: readonly MidiRoute[] = []
  private held = new HeldNotes<HeldVoice>()
  private listeners = new ListenerSet<StampedMidi>()
  private pedal = new Set<string>()
  private sustained = new Map<string, HeldVoice[]>()

  constructor(private readonly host: WebLiveMidiHost, private readonly now: () => number = () => performance.now()) {}

  setRoutes(routes: readonly MidiRoute[]): void {
    this.routes = routes
    const routed = new Set(routes.map(route => route.trackId))
    // Switching the focused track (or disarming) releases the notes the old track was holding, and its pedal.
    for (const note of this.held.retain(routed)) note.voice?.release()
    for (const trackId of [...this.pedal]) if (!routed.has(trackId)) this.liftPedal(trackId)
  }

  private release(note: HeldVoice, time?: number): void {
    if (!this.pedal.has(note.trackId)) { note.voice?.release(time); return }
    const list = this.sustained.get(note.trackId)
    if (list) list.push(note)
    else this.sustained.set(note.trackId, [note])
  }

  private liftPedal(trackId: string, time?: number): void {
    this.pedal.delete(trackId)
    for (const note of this.sustained.get(trackId) ?? []) note.voice?.release(time)
    this.sustained.delete(trackId)
  }

  /** A re-struck pitch takes over the string: its sustained voice ends at the new onset. */
  private restrike(trackId: string, pitch: number, time?: number): void {
    const list = this.sustained.get(trackId)
    if (!list) return
    const keep = list.filter(note => { if (note.pitch !== pitch) return true; note.voice?.release(time); return false })
    if (keep.length) this.sustained.set(trackId, keep)
    else this.sustained.delete(trackId)
  }

  send(source: string, data: readonly number[], timeStampMs?: number): void {
    const time = typeof timeStampMs === 'number' && Number.isFinite(timeStampMs) && timeStampMs > 0 ? Math.min(timeStampMs, this.now()) : this.now()
    const polyPressure = ((data[0] ?? 0) & 0xF0) === 0xA0
    // Poly key pressure plays as the track's channel aftertouch (one pressure per instrument), like the desktop host.
    const message = polyPressure ? { type: 'aftertouch' as const, channel: ((data[0] ?? 0) & 0x0F) + 1, value: (data[2] ?? 0) & 0x7F } : parseMidi(data)
    if (message.type === 'noteOn') {
      const routed = routeNoteOn(this.routes, source, message.channel, message.pitch, message.velocity)
      for (const note of routed) this.restrike(note.trackId, note.pitch, time)
      const voices = routed.map(note => ({ trackId: note.trackId, pitch: note.pitch, voice: this.host.startNote(note.trackId, note.pitch, note.velocity, time) }))
      for (const previous of this.held.noteOn(source, message.channel, message.pitch, voices)) previous.voice?.release(time)
    } else if (message.type === 'noteOff') {
      for (const note of this.held.noteOff(source, message.channel, message.pitch)) this.release(note, time)
    } else if (message.type === 'controller' && (message.controller === 123 || message.controller === 120)) {
      for (const note of this.held.releaseSource(source)) note.voice?.release(time)
      for (const trackId of [...this.pedal]) this.liftPedal(trackId, time)
    } else if (message.type === 'controller' && message.controller === SUSTAIN_CONTROLLER) {
      const tracks = new Set(this.routes.filter(route => routeAccepts(route, source, message.channel)).map(route => route.trackId))
      for (const trackId of tracks) {
        if (isPedalDown(message.value)) this.pedal.add(trackId)
        else if (this.pedal.has(trackId)) this.liftPedal(trackId, time)
      }
    } else if (message.type === 'controller' || message.type === 'pitchBend' || message.type === 'aftertouch' || message.type === 'program') {
      // Pitch bend, mod wheel, expression…: every track hearing this input (docs/MIDI_CONTROLLERS.md).
      const key = message.type === 'controller' ? keyOfNumber(message.controller) : message.type
      const value = message.type === 'program' ? message.program : message.value
      if (key && this.host.control) {
        for (const trackId of new Set(this.routes.filter(route => routeAccepts(route, source, message.channel)).map(route => route.trackId))) this.host.control(trackId, key, value, time)
      }
    }
    // Every message (controllers included) is reported for recording and capture.
    this.listeners.emit({ source, data: [...data].slice(0, 3), time, beat: this.host.beatAt(time) })
  }

  subscribe(listener: StampedMidiListener): () => void { return this.listeners.add(listener) }

  panic(): void {
    for (const note of this.held.clear()) note.voice?.release()
    for (const trackId of [...this.pedal, ...this.sustained.keys()]) this.liftPedal(trackId)
  }
}

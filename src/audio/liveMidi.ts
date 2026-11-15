import { HeldNotes, parseMidi, routeNoteOn, type MidiRoute } from '../core/midiInput'

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
 * transport frame. Controllers other than All Notes Off are reported but not played yet: CC64 sustain arrives
 * with the sustain-pedal work, which can read them from `subscribe`.
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

/** A sounding live note in the browser engine. */
export interface LiveVoiceHandle { release(): void }

export interface WebLiveMidiHost {
  startNote(trackId: string, pitch: number, velocity: number): LiveVoiceHandle | null
  /** Transport beat heard at a performance.now() time, or null while not playing. */
  beatAt(timeMs: number): number | null
}

interface HeldVoice { trackId: string; voice: LiveVoiceHandle | null }

export class ListenerSet<T> {
  private listeners = new Set<(value: T) => void>()
  add(listener: (value: T) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(value: T): void { for (const listener of [...this.listeners]) { try { listener(value) } catch (error) { console.error(error) } } }
}

/** Browser routing: note-ons start voices immediately (input latency = one audio quantum + output latency). */
export class WebLiveMidi implements LiveMidiPort {
  private routes: readonly MidiRoute[] = []
  private held = new HeldNotes<HeldVoice>()
  private listeners = new ListenerSet<StampedMidi>()

  constructor(private readonly host: WebLiveMidiHost, private readonly now: () => number = () => performance.now()) {}

  setRoutes(routes: readonly MidiRoute[]): void {
    this.routes = routes
    // Switching the focused track (or disarming) releases the notes the old track was holding.
    for (const note of this.held.retain(new Set(routes.map(route => route.trackId)))) note.voice?.release()
  }

  send(source: string, data: readonly number[], timeStampMs?: number): void {
    const time = typeof timeStampMs === 'number' && Number.isFinite(timeStampMs) && timeStampMs > 0 ? Math.min(timeStampMs, this.now()) : this.now()
    const message = parseMidi(data)
    if (message.type === 'noteOn') {
      const routed = routeNoteOn(this.routes, source, message.channel, message.pitch, message.velocity)
      const voices = routed.map(note => ({ trackId: note.trackId, voice: this.host.startNote(note.trackId, note.pitch, note.velocity) }))
      for (const previous of this.held.noteOn(source, message.channel, message.pitch, voices)) previous.voice?.release()
    } else if (message.type === 'noteOff') {
      for (const note of this.held.noteOff(source, message.channel, message.pitch)) note.voice?.release()
    } else if (message.type === 'controller' && (message.controller === 123 || message.controller === 120)) {
      for (const note of this.held.releaseSource(source)) note.voice?.release()
    }
    // Sustain (CC64) and other controllers: reported below for recording; playback belongs to the sustain work.
    this.listeners.emit({ source, data: [...data].slice(0, 3), time, beat: this.host.beatAt(time) })
  }

  subscribe(listener: StampedMidiListener): () => void { return this.listeners.add(listener) }

  panic(): void { for (const note of this.held.clear()) note.voice?.release() }
}

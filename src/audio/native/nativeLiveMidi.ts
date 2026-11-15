import type { MidiRoute } from '../../core/midiInput'
import { frameToBeat } from '../../core/midiRecording'
import { ListenerSet, type LiveMidiPort, type StampedMidi, type StampedMidiListener } from '../liveMidi'

export interface NativeMidiDevice { id: string; name: string; enabled: boolean }
export interface NativeMidiDeviceList { supported: boolean; devices: NativeMidiDevice[] }

type Request = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>

/**
 * Desktop live MIDI. The native host opens the MIDI devices itself (WinMM / CoreMIDI), routes notes to tracks on
 * its audio thread with sample offsets and reports every message in `engine.snapshot` as
 * `midi: [{ source, data, frame }]`; `frame` is the transport frame the player heard (output latency and the
 * one-block scheduling delay already subtracted) or null while the transport is not running.
 * Computer-keyboard notes are injected into the same host queue, so they get the same routing and stamps.
 */
export class NativeLiveMidi implements LiveMidiPort {
  private routesKey = ''
  private routes: readonly MidiRoute[] = []
  private listeners = new ListenerSet<StampedMidi>()
  private sending: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly request: Request,
    private readonly ready: () => boolean,
    private readonly bpm: () => number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  setRoutes(routes: readonly MidiRoute[]): void {
    this.routes = routes
    const key = JSON.stringify(routes)
    if (key === this.routesKey) return
    this.routesKey = key
    this.flushRoutes()
  }

  /** The host maps track IDs to graph indices: resend after every applied project. */
  resync(): void { this.flushRoutes() }

  private flushRoutes(): void {
    if (!this.ready()) return
    const routes = this.routes
    this.sending = this.sending.then(() => this.request('midi.routes', { routes })).catch(() => undefined)
  }

  send(source: string, data: readonly number[], _timeStampMs?: number): void {
    if (!this.ready()) return
    void this.request('midi.inject', { messages: [{ source, data: [...data].slice(0, 3) }] }).catch(() => undefined)
  }

  subscribe(listener: StampedMidiListener): () => void { return this.listeners.add(listener) }

  panic(): void { if (this.ready()) void this.request('midi.panic').catch(() => undefined) }

  /** Snapshot `midi` entries → stamped events. */
  receive(entries: unknown, sampleRate: number): void {
    if (!Array.isArray(entries) || !entries.length) return
    const time = this.now()
    for (const entry of entries.slice(0, 1024)) {
      if (!entry || typeof entry !== 'object') continue
      const { source, data, frame } = entry as { source?: unknown; data?: unknown; frame?: unknown }
      if (typeof source !== 'string' || !Array.isArray(data) || data.length < 1 || !data.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) continue
      const beat = typeof frame === 'number' && Number.isFinite(frame) && sampleRate > 0 ? frameToBeat(frame, sampleRate, this.bpm()) : null
      this.listeners.emit({ source, data: (data as number[]).slice(0, 3), time, beat })
    }
  }

  async listDevices(): Promise<NativeMidiDeviceList> { return parseDevices(await this.request('midi.devices')) }
  async enableDevices(ids: readonly string[]): Promise<NativeMidiDeviceList> { return parseDevices(await this.request('midi.enable', { ids: [...ids] })) }
}

function parseDevices(value: unknown): NativeMidiDeviceList {
  const record = value && typeof value === 'object' ? value as { supported?: unknown; devices?: unknown } : {}
  const devices = Array.isArray(record.devices) ? record.devices.flatMap(item => {
    const device = item && typeof item === 'object' ? item as { id?: unknown; name?: unknown; enabled?: unknown } : {}
    return typeof device.id === 'string' && device.id ? [{ id: device.id, name: typeof device.name === 'string' && device.name ? device.name : device.id, enabled: device.enabled === true }] : []
  }) : []
  return { supported: record.supported === true, devices }
}

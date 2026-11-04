import { cloneWavetablePatch, parseWavetablePatch } from './model'
import type { WavetablePatch } from './model'
import { WAVE_LIMITS, WAVE_PARAMETER_SCHEMA, WAVE_MODULATION_SOURCES, WAVE_SCHEMA_FINGERPRINT } from './schema.generated'

export interface WavetableBridgeStatus {
  readonly available: boolean
  readonly reason?: string
  readonly backend?: 'asio' | 'wasapi' | 'core-audio' | 'offline'
  readonly sampleRate?: number
}

/**
 * Host contract, not an audio device implementation. The checked-in Web Audio
 * engine does not implement this interface. Native hosts own their device clock,
 * project-wide track synchronization, and real-time event queues.
 */
export interface WavetableNativeBridge {
  readonly protocolVersion: 1
  /** Cached immutable snapshot; suitable for React.useSyncExternalStore. */
  getStatus(): WavetableBridgeStatus
  subscribe(listener: (status: WavetableBridgeStatus) => void): () => void
  /**
   * Prepare immutable tables away from the audio callback, then acknowledge the
   * revision applied at a block boundary. Coalesce/ignore superseded revisions
   * per track. AudioEngine.setProject must also synchronize unopened tracks.
   */
  applyPatch(trackId: string, patch: WavetablePatch, revision: number): Promise<{ revision: number }>
  /** MIDI note 0..127, normalized velocity 0..1, MIDI channel 0..15 (default 0). */
  previewNoteOn(trackId: string, note: number, velocity: number, channel?: number): void
  previewNoteOff(trackId: string, note: number, channel?: number): void
  /** Releases audition notes owned by this track; never another track's notes. */
  allNotesOff(trackId: string): void
}

export const WAVETABLE_UNAVAILABLE_STATUS: WavetableBridgeStatus = Object.freeze({
  available: false,
  reason: '네이티브 신디사이저 엔진이 아직 연결되지 않았습니다. 패치를 편집하고 저장할 수 있습니다.',
})

export function wavetableBridgeStatus(bridge?: WavetableNativeBridge): WavetableBridgeStatus {
  return bridge?.protocolVersion === 1 ? bridge.getStatus() : WAVETABLE_UNAVAILABLE_STATUS
}

export const WAVE_BINARY_MAGIC = 'IEWAVE01'
export const WAVE_BINARY_VERSION = 1
export const WAVE_BINARY_HEADER_BYTES = 32
export const WAVE_BINARY_ROUTE_BYTES = 24

/**
 * Bounded little-endian transport / offline-render fixture format.
 * Header: magic[8], version, schema fingerprint, parameter count, bank count,
 * route count, reserved(0), each integer uint32. Payload: float32 scalar array,
 * float32 curves[4][128], routes, then custom banks. A route is six 32-bit words:
 * source, destination, aux(0xffffffff = none), flags(bit0 bipolar / bit1 enabled),
 * amount(float), curve(float). A bank is slot/frames(uint32), then frame samples.
 * Human metadata and route IDs are project data and are not sent to the DSP.
 * Allocation, validation and conversion here belong to the control thread.
 */
export function encodeWavetablePatch(value: WavetablePatch): Uint8Array {
  const patch = parseWavetablePatch(value)
  const bytes = WAVE_BINARY_HEADER_BYTES + WAVE_PARAMETER_SCHEMA.length * 4 +
    WAVE_LIMITS.lfos * WAVE_LIMITS.lfoPoints * 4 + patch.routes.length * WAVE_BINARY_ROUTE_BYTES +
    patch.customBanks.reduce((sum, bank) => sum + 8 + bank.frames.length * WAVE_LIMITS.frameSize * 4, 0)
  const buffer = new ArrayBuffer(bytes)
  const result = new Uint8Array(buffer)
  result.set(new TextEncoder().encode(WAVE_BINARY_MAGIC))
  const view = new DataView(buffer)
  let cursor = 8
  const uint = (number: number) => { view.setUint32(cursor, number, true); cursor += 4 }
  const float = (number: number) => { view.setFloat32(cursor, number, true); cursor += 4 }
  uint(WAVE_BINARY_VERSION)
  uint(WAVE_SCHEMA_FINGERPRINT)
  uint(WAVE_PARAMETER_SCHEMA.length)
  uint(patch.customBanks.length)
  uint(patch.routes.length)
  uint(0)
  for (const parameter of WAVE_PARAMETER_SCHEMA) float(patch.params[parameter.id])
  for (const curve of patch.lfoCurves) for (const sample of curve) float(sample)
  for (const route of patch.routes) {
    uint(WAVE_MODULATION_SOURCES.find(source => source.id === route.source)!.index)
    uint(WAVE_PARAMETER_SCHEMA.find(parameter => parameter.id === route.destination)!.index)
    uint(route.aux === null ? 0xffffffff : WAVE_MODULATION_SOURCES.find(source => source.id === route.aux)!.index)
    uint((route.bipolar ? 1 : 0) | (route.enabled ? 2 : 0))
    float(route.amount)
    float(route.curve)
  }
  for (const bank of patch.customBanks) {
    uint(bank.slot)
    uint(bank.frames.length)
    for (const frame of bank.frames) for (const sample of frame) float(sample)
  }
  return result
}

export interface WavetablePreviewStatus {
  readonly ready: boolean
  readonly pending: boolean
  readonly revision: number
  readonly error: string | null
}

// Reopening an editor for the same host/track must not restart revision numbers.
const bridgeRevisions = new WeakMap<WavetableNativeBridge, Map<string, number>>()

/**
 * Small UI-side audition guard. It does not render audio or synchronize the DAW.
 * Only the newest accepted patch can enable notes; old acknowledgements, errors,
 * disconnects and disposal cannot revive a stale keyboard.
 */
export class WavetablePreviewSession {
  private revision = 0
  private disposed = false
  private snapshot: WavetablePreviewStatus = Object.freeze({ ready: false, pending: false, revision: 0, error: null })
  private readonly listeners = new Set<() => void>()
  private unsubscribe: () => void = () => {}
  private watching = false

  constructor(private readonly bridge: WavetableNativeBridge | undefined, private readonly trackId: string) {}

  private watchHost(): void {
    if (this.watching || this.disposed) return
    this.watching = true
    this.unsubscribe = this.bridge?.subscribe(status => {
      if (!status.available && !this.disposed) {
        this.nextRevision()
        this.stopNotes()
        this.publish({ ready: false, pending: false, revision: this.revision, error: status.reason ?? null })
      }
    }) ?? (() => {})
  }

  getSnapshot = (): WavetablePreviewStatus => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.watchHost()
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(status: WavetablePreviewStatus): void {
    this.snapshot = Object.freeze(status)
    for (const listener of this.listeners) listener()
  }

  private nextRevision(): number {
    if (!this.bridge) return ++this.revision
    let tracks = bridgeRevisions.get(this.bridge)
    if (!tracks) { tracks = new Map(); bridgeRevisions.set(this.bridge, tracks) }
    this.revision = (tracks.get(this.trackId) ?? 0) + 1
    tracks.set(this.trackId, this.revision)
    return this.revision
  }

  private failCommand(error: unknown): void {
    this.nextRevision()
    this.stopNotes()
    this.publish({ ready: false, pending: false, revision: this.revision, error: error instanceof Error ? error.message : '네이티브 엔진 명령을 전달하지 못했습니다.' })
  }

  private stopNotes(): void {
    // Device loss can make a host reject commands; the unavailable status remains
    // authoritative and the host is responsible for clearing its own voice queue.
    try { this.bridge?.allNotesOff(this.trackId) } catch { /* already disconnected */ }
  }

  async applyPatch(patch: WavetablePatch): Promise<boolean> {
    if (this.disposed) return false
    this.watchHost()
    const revision = this.nextRevision()
    const status = wavetableBridgeStatus(this.bridge)
    if (!this.bridge || !status.available) {
      this.publish({ ready: false, pending: false, revision, error: status.reason ?? WAVETABLE_UNAVAILABLE_STATUS.reason! })
      return false
    }
    this.publish({ ready: false, pending: true, revision, error: null })
    try {
      const result = await this.bridge.applyPatch(this.trackId, cloneWavetablePatch(patch), revision)
      if (this.disposed || this.revision !== revision || bridgeRevisions.get(this.bridge)?.get(this.trackId) !== revision) return false
      if (result.revision !== revision) throw new Error('네이티브 엔진의 패치 확인 번호가 일치하지 않습니다.')
      if (!wavetableBridgeStatus(this.bridge).available) throw new Error('네이티브 엔진 연결이 끊겼습니다.')
      this.publish({ ready: true, pending: false, revision, error: null })
      return true
    } catch (error) {
      if (this.disposed || this.revision !== revision || bridgeRevisions.get(this.bridge)?.get(this.trackId) !== revision) return false
      this.stopNotes()
      this.publish({ ready: false, pending: false, revision, error: error instanceof Error ? error.message : '패치를 적용하지 못했습니다.' })
      return false
    }
  }

  noteOn(note: number, velocity = 0.8, channel = 0): boolean {
    if (this.disposed || !this.snapshot.ready || !this.bridge || !wavetableBridgeStatus(this.bridge).available) return false
    if (!Number.isInteger(note) || note < 0 || note > 127 || !Number.isFinite(velocity) || velocity < 0 || velocity > 1 || !Number.isInteger(channel) || channel < 0 || channel > 15) return false
    try {
      this.bridge.previewNoteOn(this.trackId, note, velocity, channel)
      return true
    } catch (error) { this.failCommand(error); return false }
  }

  noteOff(note: number, channel = 0): void {
    if (!this.disposed && Number.isInteger(note) && note >= 0 && note <= 127 && Number.isInteger(channel) && channel >= 0 && channel <= 15) {
      try { this.bridge?.previewNoteOff(this.trackId, note, channel) } catch (error) { this.failCommand(error) }
    }
  }

  allNotesOff(): void { if (!this.disposed) this.stopNotes() }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.nextRevision()
    this.stopNotes()
    this.unsubscribe()
    this.snapshot = Object.freeze({ ready: false, pending: false, revision: this.revision, error: null })
    this.listeners.clear()
  }
}

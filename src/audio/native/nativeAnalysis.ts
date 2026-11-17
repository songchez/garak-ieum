import type { AnalysisSource } from '../engineAnalyser'

/** Slots and history length of the host's analysis taps (native/include/garak/engine.hpp analysisSlots/Frames). */
export const NATIVE_ANALYSIS_SLOTS = 4
export const NATIVE_ANALYSIS_FRAMES = 8192
/** The editors read about every 60 ms; one host read serves all slots. */
const READ_INTERVAL_MS = 50

export interface NativeAnalysisRead { version?: unknown; frames?: unknown; data?: unknown }

function decodeSlot(value: unknown): Float32Array | null {
  if (typeof value !== 'string' || !value) return null
  const binary = atob(value)
  if (binary.length !== NATIVE_ANALYSIS_FRAMES * 2 * 4) return null
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Float32Array(bytes.buffer)
}

/**
 * The desktop host's analysis taps (`analysis.read`, docs/RUST_ENGINE.md 5.7): each slot's latest
 * NATIVE_ANALYSIS_FRAMES interleaved stereo frames, read from the host only while an editor reads a slot, at most
 * every READ_INTERVAL_MS. `latest()` is synchronous (the editors' AnalyserNode-shaped readers): it returns the last
 * read and asks for a fresh one.
 */
export class NativeAnalysisStream {
  private slots: (Float32Array | null)[] = []
  private count = 0
  private inFlight = false
  private lastRead = -Infinity
  private disposed = false

  constructor(private readonly read: (slots: number) => Promise<NativeAnalysisRead>) {}

  /** The taps changed: `count` slots, nothing read yet. */
  reset(count: number): void {
    this.count = Math.max(0, Math.min(NATIVE_ANALYSIS_SLOTS, count))
    this.slots = Array.from({ length: this.count }, () => null)
    this.lastRead = -Infinity
  }

  dispose(): void { this.disposed = true; this.count = 0; this.slots = [] }

  source(slot: number): AnalysisSource {
    return { latest: () => { this.refresh(); return this.slots[slot] ?? null } }
  }

  private refresh(): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    if (this.disposed || this.inFlight || !this.count || now - this.lastRead < READ_INTERVAL_MS) return
    this.inFlight = true
    this.lastRead = now
    const count = this.count
    void this.read(count).then(result => {
      if (this.disposed || count !== this.count || !Array.isArray(result?.data)) return
      result.data.forEach((value, slot) => { const data = decodeSlot(value); if (data && slot < this.slots.length) this.slots[slot] = data })
    }, () => undefined).finally(() => { this.inFlight = false })
  }
}

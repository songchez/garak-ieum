// Main thread <-> engine worklet channel (docs/RUST_ENGINE.md 5).
//
// Large or allocating work (timeline JSON, binary frames, PCM) always travels by postMessage with
// transferred buffers and is applied in the worklet's `port.onmessage`, between render quanta. The
// latency-sensitive parts use a SharedArrayBuffer when the page is cross-origin isolated:
// - transport commands: a single-producer/single-consumer ring the worklet drains at the start of
//   `process()` (no message hop, applied on the very next quantum);
// - status: a seqlock-protected block the worklet writes after every quantum (transport frame,
//   playing, master peak, render-time statistics) and the main thread reads when it wants.
// Without isolation the same commands go by postMessage and the worklet posts status ~30 times a
// second. Ring commands carry the sequence number of the last message sent before them, and the
// worklet holds a command back until that message has been applied, so `set` + `play` keep order.

export const ENGINE_PROCESSOR = 'garak-engine'

/** Status block (Float64 slots after the Int32 seqlock word). */
export const STATUS = {
  frame: 0, playing: 1, peak: 2, quanta: 3, renderMs: 4, renderMaxMs: 5, appliedSeq: 6, budgetMisses: 7, latency: 8,
} as const
const STATUS_SLOTS = 9
const STATUS_BYTES = 8 + STATUS_SLOTS * 8

const RING_CAPACITY = 64
const RING_RECORD = 4 // command, frame, afterSeq, seq
const RING_BYTES = 16 + RING_CAPACITY * RING_RECORD * 8

export interface EngineStatus {
  frame: number
  playing: boolean
  /** Highest master peak since the previous read (linear). */
  peak: number
  quanta: number
  /** Total and worst `process()` render time since the processor started (milliseconds). */
  renderMs: number
  renderMaxMs: number
  /** Last message/command sequence number the worklet has applied. */
  appliedSeq: number
  /** Quanta whose render took longer than the quantum lasts. */
  budgetMisses: number
  latency: number
}

export const emptyStatus = (): EngineStatus => ({ frame: 0, playing: false, peak: 0, quanta: 0, renderMs: 0, renderMaxMs: 0, appliedSeq: 0, budgetMisses: 0, latency: 0 })

export interface SharedChannel { status: SharedArrayBuffer; ring: SharedArrayBuffer }

export function sharedChannelAvailable(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
}

export function createSharedChannel(): SharedChannel | null {
  if (!sharedChannelAvailable()) return null
  return { status: new SharedArrayBuffer(STATUS_BYTES), ring: new SharedArrayBuffer(RING_BYTES) }
}

/** Worklet side of the status block. */
export class StatusWriter {
  private readonly lock: Int32Array
  private readonly slots: Float64Array
  constructor(buffer: SharedArrayBuffer) {
    this.lock = new Int32Array(buffer, 0, 1)
    this.slots = new Float64Array(buffer, 8, STATUS_SLOTS)
  }
  write(status: EngineStatus): void {
    Atomics.add(this.lock, 0, 1) // odd: writing
    const s = this.slots
    s[STATUS.frame] = status.frame; s[STATUS.playing] = status.playing ? 1 : 0
    // The reader clears the peak; keep the louder of the unread and the new one.
    s[STATUS.peak] = Math.max(s[STATUS.peak], status.peak)
    s[STATUS.quanta] = status.quanta; s[STATUS.renderMs] = status.renderMs; s[STATUS.renderMaxMs] = status.renderMaxMs
    s[STATUS.appliedSeq] = status.appliedSeq; s[STATUS.budgetMisses] = status.budgetMisses; s[STATUS.latency] = status.latency
    Atomics.add(this.lock, 0, 1) // even: stable
  }
}

/** Main-thread side of the status block. */
export class StatusReader {
  private readonly lock: Int32Array
  private readonly slots: Float64Array
  constructor(buffer: SharedArrayBuffer) {
    this.lock = new Int32Array(buffer, 0, 1)
    this.slots = new Float64Array(buffer, 8, STATUS_SLOTS)
  }
  read(into: EngineStatus): boolean {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = Atomics.load(this.lock, 0)
      if (before & 1) continue
      const s = this.slots
      const next = { frame: s[STATUS.frame], playing: s[STATUS.playing] !== 0, peak: s[STATUS.peak], quanta: s[STATUS.quanta], renderMs: s[STATUS.renderMs],
        renderMaxMs: s[STATUS.renderMaxMs], appliedSeq: s[STATUS.appliedSeq], budgetMisses: s[STATUS.budgetMisses], latency: s[STATUS.latency] }
      if (Atomics.load(this.lock, 0) !== before) continue
      Object.assign(into, next, { peak: Math.max(into.peak, next.peak) })
      // A peak written between the read and this clear is lost: a meter, not a measurement.
      s[STATUS.peak] = 0
      return true
    }
    return false
  }
}

export interface RingCommand { command: number; frame: number; afterSeq: number; seq: number }

/** Single producer (main thread), single consumer (worklet). Indices only grow; capacity is a power of two. */
export class CommandRing {
  private readonly indices: Int32Array
  private readonly records: Float64Array
  constructor(buffer: SharedArrayBuffer) {
    this.indices = new Int32Array(buffer, 0, 2)
    this.records = new Float64Array(buffer, 16, RING_CAPACITY * RING_RECORD)
  }
  /** False when full (the caller falls back to postMessage). */
  push(command: RingCommand): boolean {
    const write = Atomics.load(this.indices, 0), read = Atomics.load(this.indices, 1)
    if (write - read >= RING_CAPACITY) return false
    const at = (write & (RING_CAPACITY - 1)) * RING_RECORD
    this.records[at] = command.command; this.records[at + 1] = command.frame; this.records[at + 2] = command.afterSeq; this.records[at + 3] = command.seq
    Atomics.store(this.indices, 0, write + 1)
    return true
  }
  /** Applies queued commands whose preceding message has been applied; stops at the first that waits. */
  drain(appliedSeq: number, apply: (command: RingCommand) => void): void {
    let applied = appliedSeq
    let read = Atomics.load(this.indices, 1)
    const write = Atomics.load(this.indices, 0)
    while (read !== write) {
      const at = (read & (RING_CAPACITY - 1)) * RING_RECORD
      const command = { command: this.records[at], frame: this.records[at + 1], afterSeq: this.records[at + 2], seq: this.records[at + 3] }
      if (command.afterSeq > applied) break
      apply(command)
      applied = Math.max(applied, command.seq)
      read += 1
      Atomics.store(this.indices, 1, read)
    }
  }
}

/** Messages to the worklet. Every message carries a sequence number; replies echo it. */
export type EngineRequest =
  | { type: 'asset'; seq: number; id: string; sampleRate: number; channels: number; samples: Float32Array }
  | { type: 'remove-asset'; seq: number; id: string }
  | { type: 'set' | 'patch'; seq: number; json: Uint8Array; binary: Uint8Array | null }
  | { type: 'transport'; seq: number; command: number; frame: number }
  | { type: 'dispose'; seq: number }

export type EngineReply =
  | { type: 'ack'; seq: number; applied?: string; latency: number; tail: number }
  | { type: 'error'; seq: number; message: string; engine: boolean }
  | { type: 'status'; status: EngineStatus }
  | { type: 'fatal'; message: string }

export interface EngineProcessorOptions {
  module: WebAssembly.Module
  maxBlock: number
  shared: SharedChannel | null
}

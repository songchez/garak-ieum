// Main thread <-> engine worklet channel (docs/RUST_ENGINE.md 5).
//
// Large or allocating work (timeline JSON, binary frames, PCM, kernels, metronome strokes) always
// travels by postMessage with transferred buffers and is applied in the worklet between render quanta
// (a large project.set in stages, one track per quantum: docs/RUST_ENGINE.md 5.7). The
// latency-sensitive parts use a SharedArrayBuffer when the page is cross-origin isolated:
// - transport commands and live note/controller events: a single-producer/single-consumer ring the
//   worklet drains at the start of `process()` (no message hop, applied on the very next quantum);
// - status: a seqlock-protected block the worklet writes after every quantum (transport frame,
//   playing, count-in, master peak, render-time statistics, the context frame of that quantum);
// - meters: a seqlock-protected block of track peaks and dynamics readings, written ~40 times a second;
// - analysis: a seqlock-protected block with the latest ANALYSIS_FRAMES of each requested analysis tap
//   (the editors' spectrum, stereo scope and rig tuner), written ~30 times a second while any is open.
// Without isolation the same commands go by postMessage and the worklet posts status and meters
// ~30 times a second. Ring commands carry the sequence number of the last message sent before them,
// and the worklet holds a command back until that message has been applied, so `set` + `play` keep order.

export const ENGINE_PROCESSOR = 'garak-engine'

/** Status block (Float64 slots after the Int32 seqlock word). */
export const STATUS = {
  frame: 0, playing: 1, peak: 2, quanta: 3, renderMs: 4, renderMaxMs: 5, appliedSeq: 6, budgetMisses: 7, latency: 8,
  countingIn: 9, contextFrame: 10, revision: 11, staging: 12, livePlayed: 13, liveIgnored: 14,
  playingQuanta: 15, playingMs: 16, playingMaxMs: 17, playingMisses: 18,
} as const
const STATUS_SLOTS = 19
export const STATUS_BYTES = 8 + STATUS_SLOTS * 8

const RING_CAPACITY = 64
const RING_RECORD = 8 // command, frame, afterSeq, seq, a, b, c, d
export const RING_BYTES = 16 + RING_CAPACITY * RING_RECORD * 8

/** Ring command codes: transport (garakEngineWasm ENGINE_TRANSPORT) and live events. */
export const RING_LIVE = 16

/** Channels of the worklet's second output: route recording taps, stereo slots (garak_engine_max_taps). */
export const TAP_CHANNELS = 16

/** Track peaks and dynamics readings the meter block holds. */
export const METER_TRACKS = 256
export const METER_DYNAMICS = 256
// Float32 slots after the Int32 seqlock word: [revision, count, peaks..., dynamics count, (track, insert, input, gain)...].
const METER_SLOTS = 2 + METER_TRACKS + 1 + METER_DYNAMICS * 4
export const METER_BYTES = 8 + METER_SLOTS * 4

/** Analysis taps (garak_engine_max_analysis) and the history each keeps: enough for an 8192-point tuner window at 96 kHz. */
export const ANALYSIS_SLOTS = 4
export const ANALYSIS_FRAMES = 8192
/** Int32 seqlock word, Int32 publish counter, then per slot ANALYSIS_FRAMES interleaved stereo frames, oldest first. */
export const ANALYSIS_BYTES = 8 + ANALYSIS_SLOTS * ANALYSIS_FRAMES * 2 * 4

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
  /** A count-in is running (the transport frame stays at the start until it ends). */
  countingIn: boolean
  /** The context frame at the end of the quantum that published `frame` (maps context time to project frames). */
  contextFrame: number
  /** Revision of the running graph (its timeline revision). */
  revision: number
  /** Tracks of a staged project.set/patch still to build (0 = none pending). */
  staging: number
  /** Live events a track played, and events no track could play. */
  livePlayed: number
  liveIgnored: number
  /** The same statistics for quanta that rendered a playing transport with no staged update or control message. */
  playingQuanta: number
  playingMs: number
  playingMaxMs: number
  playingMisses: number
}

export const emptyStatus = (): EngineStatus => ({
  frame: 0, playing: false, peak: 0, quanta: 0, renderMs: 0, renderMaxMs: 0, appliedSeq: 0, budgetMisses: 0, latency: 0,
  countingIn: false, contextFrame: 0, revision: 0, staging: 0, livePlayed: 0, liveIgnored: 0,
  playingQuanta: 0, playingMs: 0, playingMaxMs: 0, playingMisses: 0,
})

/** Track peaks (graph order) and dynamics readings since the previous read. */
export interface EngineMeters {
  revision: number
  peaks: Float32Array
  dynamics: { track: number; insert: number; input: number; gain: number }[]
}

export interface SharedChannel { status: SharedArrayBuffer; ring: SharedArrayBuffer; meters: SharedArrayBuffer; analysis: SharedArrayBuffer }

export function sharedChannelAvailable(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
}

export function createSharedChannel(): SharedChannel | null {
  if (!sharedChannelAvailable()) return null
  return { status: new SharedArrayBuffer(STATUS_BYTES), ring: new SharedArrayBuffer(RING_BYTES), meters: new SharedArrayBuffer(METER_BYTES), analysis: new SharedArrayBuffer(ANALYSIS_BYTES) }
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
    s[STATUS.countingIn] = status.countingIn ? 1 : 0; s[STATUS.contextFrame] = status.contextFrame; s[STATUS.revision] = status.revision
    s[STATUS.staging] = status.staging; s[STATUS.livePlayed] = status.livePlayed; s[STATUS.liveIgnored] = status.liveIgnored
    s[STATUS.playingQuanta] = status.playingQuanta; s[STATUS.playingMs] = status.playingMs; s[STATUS.playingMaxMs] = status.playingMaxMs; s[STATUS.playingMisses] = status.playingMisses
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
      const next: EngineStatus = {
        frame: s[STATUS.frame], playing: s[STATUS.playing] !== 0, peak: s[STATUS.peak], quanta: s[STATUS.quanta], renderMs: s[STATUS.renderMs],
        renderMaxMs: s[STATUS.renderMaxMs], appliedSeq: s[STATUS.appliedSeq], budgetMisses: s[STATUS.budgetMisses], latency: s[STATUS.latency],
        countingIn: s[STATUS.countingIn] !== 0, contextFrame: s[STATUS.contextFrame], revision: s[STATUS.revision], staging: s[STATUS.staging],
        livePlayed: s[STATUS.livePlayed], liveIgnored: s[STATUS.liveIgnored],
        playingQuanta: s[STATUS.playingQuanta], playingMs: s[STATUS.playingMs], playingMaxMs: s[STATUS.playingMaxMs], playingMisses: s[STATUS.playingMisses],
      }
      if (Atomics.load(this.lock, 0) !== before) continue
      Object.assign(into, next, { peak: Math.max(into.peak, next.peak) })
      // A peak written between the read and this clear is lost: a meter, not a measurement.
      s[STATUS.peak] = 0
      return true
    }
    return false
  }
}

/** Worklet side of the meter block: unread values are kept (louder peak, lower gain). */
export class MeterWriter {
  private readonly lock: Int32Array
  private readonly slots: Float32Array
  constructor(buffer: SharedArrayBuffer) {
    this.lock = new Int32Array(buffer, 0, 1)
    this.slots = new Float32Array(buffer, 8, METER_SLOTS)
  }
  write(revision: number, peaks: Float32Array, count: number, dynamics: readonly { track: number; insert: number; input: number; gain: number }[]): void {
    Atomics.add(this.lock, 0, 1)
    const s = this.slots
    const n = Math.min(count, METER_TRACKS)
    if (s[0] !== revision || s[1] !== n) { s.fill(0, 2, 2 + METER_TRACKS); s[0] = revision; s[1] = n }
    for (let k = 0; k < n; k += 1) if (peaks[k] > s[2 + k]) s[2 + k] = peaks[k]
    const base = 2 + METER_TRACKS
    let stored = s[base]
    for (const d of dynamics) {
      let at = -1
      for (let k = 0; k < stored; k += 1) if (s[base + 1 + k * 4] === d.track && s[base + 2 + k * 4] === d.insert) { at = k; break }
      if (at < 0) {
        if (stored >= METER_DYNAMICS) continue
        at = stored++
        s[base + 1 + at * 4] = d.track; s[base + 2 + at * 4] = d.insert; s[base + 3 + at * 4] = 0; s[base + 4 + at * 4] = 1
      }
      s[base + 3 + at * 4] = Math.max(s[base + 3 + at * 4], d.input)
      s[base + 4 + at * 4] = Math.min(s[base + 4 + at * 4], d.gain)
    }
    s[base] = stored
    Atomics.add(this.lock, 0, 1)
  }
}

/** Main-thread side of the meter block; a read clears what it returns. */
export class MeterReader {
  private readonly lock: Int32Array
  private readonly slots: Float32Array
  constructor(buffer: SharedArrayBuffer) {
    this.lock = new Int32Array(buffer, 0, 1)
    this.slots = new Float32Array(buffer, 8, METER_SLOTS)
  }
  read(): EngineMeters | null {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = Atomics.load(this.lock, 0)
      if (before & 1) continue
      const s = this.slots
      const count = Math.min(METER_TRACKS, s[1])
      const peaks = s.slice(2, 2 + count)
      const base = 2 + METER_TRACKS, stored = Math.min(METER_DYNAMICS, s[base])
      const dynamics = []
      for (let k = 0; k < stored; k += 1) dynamics.push({ track: s[base + 1 + k * 4], insert: s[base + 2 + k * 4], input: s[base + 3 + k * 4], gain: s[base + 4 + k * 4] })
      const revision = s[0]
      if (Atomics.load(this.lock, 0) !== before) continue
      // Values written between the read and this clear are lost: meters, not measurements.
      s.fill(0, 2, 2 + count)
      s[base] = 0
      return { revision, peaks, dynamics }
    }
    return null
  }
}

/**
 * Worklet side of the analysis taps: a history ring per slot that every render appends to (no allocation),
 * published oldest-first to the shared block or as copies by postMessage.
 */
export class AnalysisRings {
  readonly data = new Float32Array(ANALYSIS_SLOTS * ANALYSIS_FRAMES * 2)
  private write = 0
  /** Appends `frames` of each of the `count` first slots of `view` (slots of `slotFrames` interleaved stereo frames). */
  append(view: Float32Array, slotFrames: number, count: number, frames: number): void {
    const size = ANALYSIS_FRAMES * 2
    for (let i = 0; i < frames; i += 1) {
      const at = ((this.write + i) % ANALYSIS_FRAMES) * 2
      for (let k = 0; k < count; k += 1) {
        const from = k * slotFrames * 2 + i * 2
        this.data[k * size + at] = view[from]
        this.data[k * size + at + 1] = view[from + 1]
      }
    }
    this.write = (this.write + frames) % ANALYSIS_FRAMES
  }
  clear(): void { this.data.fill(0); this.write = 0 }
  /** Slot `k` oldest first into `out` (ANALYSIS_FRAMES * 2 values). */
  copySlot(k: number, out: Float32Array): void {
    const size = ANALYSIS_FRAMES * 2, base = k * size, split = this.write * 2
    out.set(this.data.subarray(base + split, base + size), 0)
    out.set(this.data.subarray(base, base + split), size - split)
  }
}

export class AnalysisWriter {
  private readonly lock: Int32Array
  private readonly slots: Float32Array
  constructor(buffer: SharedArrayBuffer) {
    this.lock = new Int32Array(buffer, 0, 2)
    this.slots = new Float32Array(buffer, 8, ANALYSIS_SLOTS * ANALYSIS_FRAMES * 2)
  }
  write(rings: AnalysisRings, count: number): void {
    Atomics.add(this.lock, 0, 1)
    const size = ANALYSIS_FRAMES * 2
    for (let k = 0; k < count; k += 1) rings.copySlot(k, this.slots.subarray(k * size, (k + 1) * size))
    Atomics.add(this.lock, 1, 1)
    Atomics.add(this.lock, 0, 1)
  }
}

/** Main-thread side of the analysis block. */
export class AnalysisReader {
  private readonly lock: Int32Array
  private readonly slots: Float32Array
  constructor(buffer: SharedArrayBuffer) {
    this.lock = new Int32Array(buffer, 0, 2)
    this.slots = new Float32Array(buffer, 8, ANALYSIS_SLOTS * ANALYSIS_FRAMES * 2)
  }
  /** Publications so far (a new value means new data). */
  get version(): number { return Atomics.load(this.lock, 1) }
  /** Slot `k` (oldest first) into `out`; false when the worklet kept writing. */
  read(k: number, out: Float32Array): boolean {
    const size = ANALYSIS_FRAMES * 2
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const before = Atomics.load(this.lock, 0)
      if (before & 1) continue
      out.set(this.slots.subarray(k * size, (k + 1) * size))
      if (Atomics.load(this.lock, 0) === before) return true
    }
    return false
  }
}

export interface RingCommand { command: number; frame: number; afterSeq: number; seq: number; a?: number; b?: number; c?: number; d?: number }

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
    const at = (write & (RING_CAPACITY - 1)) * RING_RECORD, r = this.records
    r[at] = command.command; r[at + 1] = command.frame; r[at + 2] = command.afterSeq; r[at + 3] = command.seq
    r[at + 4] = command.a ?? 0; r[at + 5] = command.b ?? 0; r[at + 6] = command.c ?? 0; r[at + 7] = command.d ?? 0
    Atomics.store(this.indices, 0, write + 1)
    return true
  }
  /** Applies queued commands whose preceding message has been applied; stops at the first that waits. */
  drain(appliedSeq: number, apply: (command: RingCommand) => void): void {
    let applied = appliedSeq
    let read = Atomics.load(this.indices, 1)
    const write = Atomics.load(this.indices, 0)
    while (read !== write) {
      const at = (read & (RING_CAPACITY - 1)) * RING_RECORD, r = this.records
      const command = { command: r[at], frame: r[at + 1], afterSeq: r[at + 2], seq: r[at + 3], a: r[at + 4], b: r[at + 5], c: r[at + 6], d: r[at + 7] }
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
  | { type: 'samples'; seq: number; json: Uint8Array }
  | { type: 'set' | 'patch'; seq: number; json: Uint8Array; binary: Uint8Array | null }
  | { type: 'transport'; seq: number; command: number; frame: number }
  | { type: 'live'; seq: number; track: number; kind: number; pitch: number; value: number; id: number }
  | { type: 'kernels'; seq: number; kernels: { type: number; size: number; data: Float32Array }[] }
  | { type: 'metronome'; seq: number; on: boolean; gain: number; strokes: Float32Array[] | null }
  | { type: 'monitor'; seq: number; tracks: number[] }
  | { type: 'taps'; seq: number; tracks: number[] }
  | { type: 'analysis'; seq: number; taps: { track: number; insert: number; tuner: boolean }[] }
  | { type: 'dispose'; seq: number }

export type EngineReply =
  | { type: 'ack'; seq: number; applied?: string; latency: number; tail: number }
  | { type: 'error'; seq: number; message: string; engine: boolean }
  | { type: 'status'; status: EngineStatus; meters: EngineMeters | null }
  | { type: 'fatal'; message: string }
  /** Without a SharedArrayBuffer: the analysis taps' latest ANALYSIS_FRAMES (oldest first), one array per tap. */
  | { type: 'analysis'; slots: Float32Array[] }

export interface EngineProcessorOptions {
  module: WebAssembly.Module
  maxBlock: number
  shared: SharedChannel | null
}

/**
 * Timed instrument events in AudioContext seconds, shared by the vintage worklet (its live queue) and
 * the main thread (events gathered for an offline render before the worklet node exists). No DOM,
 * no allocation in `drain` beyond the reused output objects.
 */
import { VINTAGE_EVENT, type VintageEvent } from '../../audio/rust/vintageWasm.js'

export interface TimedEvent {
  /** AudioContext time in seconds. */
  at: number
  kind: number
  id: number
  pitch: number
  value: number
  param: number
}

/** Messages the main thread posts to the vintage worklet. */
export type VintageMessage =
  | { type: 'events'; events: TimedEvent[] }
  /** Note `id` ends at `at`: a pending note-off moves there; a note that has not started yet never starts. */
  | { type: 'off'; id: number; at: number }
  /** Every parameter (catalog order) from `at` (or now). */
  | { type: 'params'; values: number[]; at?: number }
  | { type: 'dispose' }

interface Entry extends TimedEvent { seq: number }

export class EventQueue {
  private items: Entry[] = []
  private head = 0
  private seq = 0
  /** Pitch of every note whose note-on was queued or delivered and whose note-off was not delivered. */
  private readonly pitches = new Map<number, number>()
  private readonly out: VintageEvent[] = []
  private readonly pool: VintageEvent[] = []

  get size(): number { return this.items.length - this.head }

  push(event: TimedEvent): void {
    if (!Number.isFinite(event.at)) return
    const entry: Entry = { ...event, seq: this.seq++ }
    if (entry.kind === VINTAGE_EVENT.noteOn) this.pitches.set(entry.id, entry.pitch)
    // Usually appended in time order; otherwise binary-search the slot (stable for equal times).
    let lo = this.head, hi = this.items.length
    if (hi > lo && this.items[hi - 1].at > entry.at) {
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (this.items[mid].at <= entry.at) lo = mid + 1
        else hi = mid
      }
      this.items.splice(lo, 0, entry)
    } else this.items.push(entry)
  }

  off(id: number, at: number): void {
    let removedOn = false, startsAt = -Infinity
    const kept: Entry[] = []
    for (let i = this.head; i < this.items.length; i += 1) {
      const e = this.items[i]
      if (e.id === id && e.kind === VINTAGE_EVENT.noteOff) continue
      if (e.id === id && e.kind === VINTAGE_EVENT.noteOn) {
        if (e.at >= at) { removedOn = true; continue }
        startsAt = Math.max(startsAt, e.at)
      }
      kept.push(e)
    }
    this.items = kept
    this.head = 0
    const pitch = this.pitches.get(id)
    if (removedOn && startsAt === -Infinity) { this.pitches.delete(id); return }
    if (pitch === undefined) return
    this.push({ at: Math.max(at, startsAt), kind: VINTAGE_EVENT.noteOff, id, pitch, value: 0, param: 0 })
  }

  /** Every queued event, in order (offline: handed to the worklet at construction). */
  all(): TimedEvent[] {
    return this.items.slice(this.head).map(({ seq: _seq, ...event }) => event)
  }

  /**
   * Removes the events due before `end` and returns them as block events (offsets from `start` at
   * `sampleRate`, clamped into the block). The returned array and its objects are reused.
   */
  drain(start: number, end: number, sampleRate: number, frames: number): VintageEvent[] {
    this.out.length = 0
    while (this.head < this.items.length && this.items[this.head].at < end) {
      const e = this.items[this.head++]
      if (e.kind === VINTAGE_EVENT.noteOff) this.pitches.delete(e.id)
      const target = this.pool[this.out.length] ?? (this.pool[this.out.length] = { offset: 0, kind: 0, id: 0, pitch: 0, value: 0, param: 0 })
      target.offset = Math.min(frames - 1, Math.max(0, Math.round((e.at - start) * sampleRate)))
      target.kind = e.kind; target.id = e.id; target.pitch = e.pitch; target.value = e.value; target.param = e.param
      this.out.push(target)
    }
    if (this.head > 1024 && this.head * 2 > this.items.length) { this.items = this.items.slice(this.head); this.head = 0 }
    return this.out
  }
}

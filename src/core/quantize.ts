import type { MidiNote } from './types'

/**
 * Quantize math shared by region playback (non-destructive Q, Q-스윙, Q-강도) and the piano roll's
 * destructive quantize popover (docs/MIDI_RECORDING.md §퀀타이즈).
 */
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** Nearest grid line of `position`; odd lines move by swing (50 = straight, 100 = a full grid step late). */
export function gridTarget(position: number, grid: number, swing = 50): number {
  const step = Math.round(position / grid)
  return step * grid + (step % 2 ? (clamp(swing, 0, 100) - 50) / 50 * grid : 0)
}

/** Strength 0…100 moves the position that fraction of the way to its grid line (Logic Q-Strength, Ableton Amount). */
export function quantizePosition(position: number, grid: number, swing = 50, strength = 100): number {
  if (!(grid > 0)) return position
  const target = gridTarget(position, grid, swing)
  return position + (target - position) * clamp(strength, 0, 100) / 100
}

export interface QuantizeOptions {
  /** Beats; > 0. */
  grid: number
  /** 0…100, default 100. */
  strength?: number
  /** 0…100, default 50 (straight). */
  swing?: number
  /** Move note starts. Default true. */
  starts?: boolean
  /** Move note ends (Logic "Quantize Note End"). Default false. */
  ends?: boolean
}

export const DEFAULT_QUANTIZE_OPTIONS: Required<QuantizeOptions> = { grid: 0.25, strength: 100, swing: 50, starts: true, ends: false }

/** Destructive quantize of `notes` inside a region of `regionLength` beats. Untargeted notes are returned as is. */
export function quantizeNotes(notes: readonly MidiNote[], options: QuantizeOptions, regionLength: number, targets?: ReadonlySet<string>): MidiNote[] {
  const { grid, strength = 100, swing = 50, starts = true, ends = false } = options
  if (!(grid > 0)) return [...notes]
  const minimum = Math.min(grid / 4, 1 / 64)
  return notes.map(note => {
    if (targets && !targets.has(note.id)) return note
    const end = note.start + note.duration
    let start = starts ? quantizePosition(note.start, grid, swing, strength) : note.start
    start = clamp(start, 0, Math.max(0, regionLength - minimum))
    // With only starts, a note keeps its length; with ends, the end moves to its own grid line (straight grid).
    let nextEnd = ends ? quantizePosition(end, grid, 50, strength) : start + note.duration
    if (nextEnd - start < minimum) nextEnd = start + (ends ? Math.max(minimum, grid * clamp(strength, 0, 100) / 100) : note.duration)
    nextEnd = Math.min(nextEnd, Math.max(regionLength, start + minimum))
    const duration = Math.max(minimum, nextEnd - start)
    return Math.abs(start - note.start) < 1e-9 && Math.abs(duration - note.duration) < 1e-9 ? note : { ...note, start, duration }
  })
}

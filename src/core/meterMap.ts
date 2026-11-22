import type { MeterEvent, Project, TimeSignature, TimeSignatureDenominator } from './types'
import { MAX_TIME_SIGNATURE_NUMERATOR, MIN_TIME_SIGNATURE_NUMERATOR, TIME_SIGNATURE_DENOMINATORS, quarterNotesPerBar, quarterNotesPerBeat, validateTimeSignature } from './meter'

/**
 * Meter map (docs/METER_MAP.md): the one place that converts bars ↔ quarter-note beats when the time
 * signature changes during a song. Beats ↔ seconds stay in core/tempoMap.ts; the two maps are independent
 * (tempo is per quarter note, meter only groups quarter notes into bars), so bars ↔ seconds is
 * `tempoMapOf(project).secondsAt(meterMapOf(project).beatAtBar(bar))`.
 *
 * Events sit on bar lines: `bar` is a 0-based bar index. The first event is always bar 0 with the
 * project meter (Project.timeSignature). A meter lasts until the next event; after the last event it
 * continues forever, and before beat 0 (negative beats) the first meter extrapolates.
 * native/include/garak/meter.hpp mirrors the bar → beat walk so both engines accent the same pulses.
 */
export const MAX_METER_EVENTS = 1024
/** About 30 hours of 4/4 at 300 BPM: anything beyond is a broken file. */
export const MAX_METER_BAR = 1_000_000
const EPSILON = 1e-7

export type MeterSource = Pick<Project, 'timeSignature'> & { meterMap?: readonly MeterEvent[] }

/** A compiled meter event: where it starts in beats and the length of its bars and beats (quarter notes). */
export interface MeterSegment extends MeterEvent {
  /** Quarter-note beat where the event's first bar starts. */
  beat: number
  /** Quarter-note length of one bar (6/8 = 3). */
  barBeats: number
  /** Quarter-note length of one denominator beat (x/8 = 0.5). */
  beatUnit: number
}

/** Musical position of a beat: 1-based bar and beat (in the bar's own denominator) plus the fraction of that beat. */
export interface MeterPosition { bar: number; beat: number; fraction: number; meter: TimeSignature }

export const isValidMeter = (numerator: unknown, denominator: unknown): boolean =>
  typeof numerator === 'number' && Number.isSafeInteger(numerator) && numerator >= MIN_TIME_SIGNATURE_NUMERATOR && numerator <= MAX_TIME_SIGNATURE_NUMERATOR
  && TIME_SIGNATURE_DENOMINATORS.includes(denominator as TimeSignatureDenominator)

export const sameMeter = (a: TimeSignature, b: TimeSignature): boolean => a.numerator === b.numerator && a.denominator === b.denominator

/**
 * Sorted, de-duplicated events with the first at bar 0 carrying `signature`. Invalid entries are dropped and
 * events at the same bar keep the last one. A repeated meter is kept: it is a no-op.
 */
export function normalizeMeterEvents(signature: TimeSignature, events: readonly MeterEvent[] | undefined): MeterEvent[] {
  const first: MeterEvent = { bar: 0, numerator: signature.numerator, denominator: signature.denominator }
  const valid = (events ?? []).filter(event => event && Number.isSafeInteger(event.bar) && event.bar > 0 && event.bar <= MAX_METER_BAR && isValidMeter(event.numerator, event.denominator))
    .map((event, order) => ({ event: { bar: event.bar, numerator: event.numerator, denominator: event.denominator }, order }))
    .sort((a, b) => a.event.bar - b.event.bar || a.order - b.order)
  const result: MeterEvent[] = [first]
  for (const { event } of valid) {
    if (event.bar === result[result.length - 1].bar) result[result.length - 1] = event
    else result.push(event)
  }
  return result.slice(0, MAX_METER_EVENTS)
}

export class MeterMap {
  readonly segments: readonly MeterSegment[]

  constructor(signature: TimeSignature, events?: readonly MeterEvent[]) {
    const segments: MeterSegment[] = []
    let beat = 0
    for (const event of normalizeMeterEvents(signature, events)) {
      const previous = segments[segments.length - 1]
      if (previous) beat += (event.bar - previous.bar) * previous.barBeats
      segments.push({ ...event, beat, barBeats: quarterNotesPerBar(event), beatUnit: quarterNotesPerBeat(event) })
    }
    this.segments = segments
  }

  static constant(signature: TimeSignature): MeterMap { return new MeterMap(signature) }

  /** Plain events (bar + meter), as stored in Project.meterMap. */
  get events(): MeterEvent[] { return this.segments.map(({ bar, numerator, denominator }) => ({ bar, numerator, denominator })) }

  /** True when every bar has the same meter. */
  get isConstant(): boolean { return this.segments.every(segment => sameMeter(segment, this.segments[0])) }

  /** Index of the segment containing `beat` (the last event at or before it). */
  segmentAt(beat: number): number {
    let lo = 0, hi = this.segments.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1
      if (this.segments[mid].beat <= beat + EPSILON) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /** Index of the segment containing (0-based, possibly fractional) `bar`. */
  segmentAtBar(bar: number): number {
    let lo = 0, hi = this.segments.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1
      if (this.segments[mid].bar <= bar + EPSILON) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  meterAt(beat: number): TimeSignature {
    const { numerator, denominator } = this.segments[this.segmentAt(beat)]
    return { numerator, denominator }
  }

  /** Quarter-note length of the bar containing `beat`. */
  barBeatsAt(beat: number): number { return this.segments[this.segmentAt(beat)].barBeats }

  /** Quarter-note length of one denominator beat at `beat`. */
  beatUnitAt(beat: number): number { return this.segments[this.segmentAt(beat)].beatUnit }

  /** 0-based fractional bar of `beat` (bar 0 starts at beat 0). */
  barAt(beat: number): number {
    if (!Number.isFinite(beat)) return beat
    const segment = this.segments[this.segmentAt(beat)]
    return segment.bar + (beat - segment.beat) / segment.barBeats
  }

  /** Quarter-note beat of a 0-based (possibly fractional) bar. */
  beatAtBar(bar: number): number {
    if (!Number.isFinite(bar)) return bar
    const segment = this.segments[this.segmentAtBar(bar)]
    return segment.beat + (bar - segment.bar) * segment.barBeats
  }

  /** 0-based index of the bar containing `beat`. */
  barIndexAt(beat: number): number { return Math.floor(this.barAt(beat) + EPSILON) }

  /** Start of the bar containing `beat` (a bar line at or before it). */
  barStart(beat: number): number { return this.beatAtBar(this.barIndexAt(beat)) }

  /** The first bar line strictly after `beat`. */
  nextBarStart(beat: number): number { return this.beatAtBar(this.barIndexAt(beat) + 1) }

  /** The last bar line strictly before `beat`. */
  previousBarStart(beat: number): number { return this.beatAtBar(Math.ceil(this.barAt(beat) - EPSILON) - 1) }

  /** The first bar line at or after `beat`. */
  ceilBarStart(beat: number): number { return this.beatAtBar(Math.ceil(this.barAt(beat) - EPSILON)) }

  /** The closest bar line (in beats, so a long bar before a short one splits fairly). */
  nearestBarStart(beat: number): number {
    const start = this.barStart(beat), next = this.nextBarStart(beat)
    return beat - start <= next - beat ? start : next
  }

  /** Bar, beat (in the bar's denominator) and fraction of `beat`, 1-based like the LCD (001.1.00). */
  position(beat: number): MeterPosition {
    const index = this.barIndexAt(beat)
    const segment = this.segments[this.segmentAtBar(index)]
    const local = (beat - this.beatAtBar(index)) / segment.beatUnit
    const whole = Math.min(segment.numerator - 1, Math.max(0, Math.floor(local + EPSILON)))
    return { bar: index + 1, beat: whole + 1, fraction: Math.max(0, local - whole), meter: { numerator: segment.numerator, denominator: segment.denominator } }
  }

  /** Bars needed to cover [0, beat] (at least one). */
  barsCovering(beat: number): number { return Math.max(1, Math.ceil(this.barAt(beat) - EPSILON)) }

  /** Beats covering `bars` whole bars starting at the bar line at or after `startBeat`. */
  beatsForBars(startBeat: number, bars: number): number {
    const from = this.barAt(startBeat)
    return this.beatAtBar(from + bars) - startBeat
  }

  /**
   * Snaps `beat` to a grid of `step` beats that restarts at each meter change, so a quarter-note grid after a
   * 7/8 bar still lands on that bar's beats. With one meter it is the plain round(beat / step) · step.
   */
  snap(beat: number, step: number): number {
    if (!(step > 0) || !Number.isFinite(beat)) return beat
    const index = this.segmentAt(beat)
    const segment = this.segments[index]
    const snapped = segment.beat + Math.round((beat - segment.beat) / step) * step
    // The next meter change is a grid point too (its own grid starts there); a point past it would be off-grid.
    const next = this.segments[index + 1]
    return next && (snapped > next.beat + EPSILON || next.beat - beat < Math.abs(beat - snapped)) ? next.beat : snapped
  }
}

// Projects are immutable snapshots: one compiled map per meterMap array (or per constant meter).
const mapCache = new WeakMap<readonly MeterEvent[], MeterMap>()
const constantCache = new Map<string, MeterMap>()

/** The compiled meter map of a project (cached). */
export function meterMapOf(project: MeterSource): MeterMap {
  const signature = project.timeSignature ?? { numerator: 4, denominator: 4 }
  const events = project.meterMap
  if (!events || events.length < 2) {
    const key = `${signature.numerator}/${signature.denominator}`
    let map = constantCache.get(key)
    if (!map) {
      if (constantCache.size > 64) constantCache.clear()
      map = MeterMap.constant(signature)
      constantCache.set(key, map)
    }
    return map
  }
  const cached = mapCache.get(events)
  if (cached && sameMeter(cached.segments[0], signature)) return cached
  const map = new MeterMap(signature, events)
  mapCache.set(events, map)
  return map
}

/** True when the project's meter changes somewhere. */
export const hasMeterChanges = (project: MeterSource): boolean => !meterMapOf(project).isConstant

// --- Editing (every function returns a new project; callers commit it as one undo step) ---

/** Writes an event list back: the first event becomes the project meter (Project.timeSignature). */
export function withMeterEvents<T extends MeterSource & { beatsPerBar: number }>(project: T, events: readonly MeterEvent[]): T {
  const first = events[0] && isValidMeter(events[0].numerator, events[0].denominator) ? validateTimeSignature(events[0]) : project.timeSignature
  const meterMap = normalizeMeterEvents(first, events.slice(1))
  return { ...project, timeSignature: { numerator: first.numerator, denominator: first.denominator }, beatsPerBar: quarterNotesPerBar(first), meterMap }
}

const eventsOf = (project: MeterSource): MeterEvent[] => normalizeMeterEvents(project.timeSignature, project.meterMap?.slice(1))

/** Adds (or replaces) the meter at 0-based `bar`. Bar 0 changes the project meter. */
export function addMeterEvent<T extends MeterSource & { beatsPerBar: number }>(project: T, bar: number, numerator: number, denominator: number): T {
  const signature = validateTimeSignature({ numerator, denominator })
  const at = Math.max(0, Math.min(MAX_METER_BAR, Math.round(bar)))
  const events = eventsOf(project)
  if (at === 0) return withMeterEvents(project, [{ bar: 0, ...signature }, ...events.slice(1)])
  return withMeterEvents(project, [...events.filter(event => event.bar !== at), { bar: at, ...signature }])
}

/** Changes the meter of event `index`. */
export function setMeterEvent<T extends MeterSource & { beatsPerBar: number }>(project: T, index: number, numerator: number, denominator: number): T {
  const signature = validateTimeSignature({ numerator, denominator })
  const events = eventsOf(project)
  if (!events[index] || sameMeter(events[index], signature)) return project
  return withMeterEvents(project, events.map((event, at) => at === index ? { bar: event.bar, ...signature } : event))
}

/** Moves event `index` (never the first) to 0-based `bar`, staying between its neighbours. */
export function moveMeterEvent<T extends MeterSource & { beatsPerBar: number }>(project: T, index: number, bar: number): T {
  const events = eventsOf(project)
  if (index <= 0 || !events[index]) return project
  const lower = events[index - 1].bar + 1
  const upper = events[index + 1] ? events[index + 1].bar - 1 : MAX_METER_BAR
  const clamped = Math.min(upper, Math.max(lower, Math.round(bar)))
  if (clamped === events[index].bar) return project
  return withMeterEvents(project, events.map((event, at) => at === index ? { ...event, bar: clamped } : event))
}

export function deleteMeterEvent<T extends MeterSource & { beatsPerBar: number }>(project: T, index: number): T {
  const events = eventsOf(project)
  if (index <= 0 || !events[index]) return project
  return withMeterEvents(project, events.filter((_, at) => at !== index))
}

// --- Standard MIDI File meter (meta event 0x58: numerator, log2 denominator, clocks per click, 32nds per quarter) ---

/** Meter events for an SMF conductor track at `ppq`: one FF 58 per change, at its bar line. */
export function meterEventsForExport(map: MeterMap, ppq: number): Array<{ tick: number; numerator: number; denominatorPower: number; clocksPerClick: number }> {
  return map.segments.map(segment => ({
    tick: Math.max(0, Math.round(segment.beat * ppq)),
    numerator: segment.numerator,
    denominatorPower: Math.round(Math.log2(segment.denominator)),
    // MIDI clocks (24 per quarter) per metronome click: the dotted pulse in compound meters, else one beat.
    clocksPerClick: Math.round(24 * segment.beatUnit * (segment.denominator >= 8 && segment.numerator > 3 && segment.numerator % 3 === 0 ? 3 : 1)),
  }))
}

/**
 * Meter events from SMF time signatures (beats in quarter notes, sorted). A change that does not fall on a
 * bar line of the meter before it moves to the next bar line (`moved` counts them), because meters change
 * only on bar lines here. Unsupported meters are skipped (`skipped`).
 */
export function meterEventsFromSmf(changes: ReadonlyArray<{ beat: number; numerator: number; denominator: number }>): { initial: TimeSignature | null; events: MeterEvent[]; moved: number; skipped: number } {
  let initial: TimeSignature | null = null, moved = 0, skipped = 0
  const events: MeterEvent[] = []
  // Walk bar by bar: the current segment's start beat/bar and bar length.
  let segmentBeat = 0, segmentBar = 0, barBeats = 4
  for (const change of changes) {
    if (!isValidMeter(change.numerator, change.denominator)) { skipped += 1; continue }
    const meter = { numerator: change.numerator, denominator: change.denominator as TimeSignatureDenominator }
    if (change.beat <= EPSILON) {
      initial = meter; barBeats = quarterNotesPerBar(meter)
      if (events.length) events.length = 0
      continue
    }
    const exact = segmentBar + (change.beat - segmentBeat) / barBeats
    const bar = Math.ceil(exact - 1e-6)
    if (Math.abs(bar - exact) > 1e-6) moved += 1
    if (bar <= 0) { initial = meter; barBeats = quarterNotesPerBar(meter); continue }
    const last = events[events.length - 1]
    // Files often repeat the meter (one FF 58 per bar or per track): a repeat changes nothing.
    const before = last ?? initial ?? { numerator: 4, denominator: 4 }
    if (!(last && last.bar === bar) && sameMeter(before, meter)) continue
    if (last && last.bar === bar) events[events.length - 1] = { bar, ...meter }
    else events.push({ bar, ...meter })
    segmentBeat = segmentBeat + (bar - segmentBar) * barBeats
    segmentBar = bar
    barBeats = quarterNotesPerBar(meter)
  }
  return { initial, events, moved, skipped }
}

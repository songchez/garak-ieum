import type { Project, TempoCurve, TempoPoint } from './types'

/**
 * Tempo map (docs/TEMPO_MAP.md): the one place that converts quarter-note beats to seconds and back.
 *
 * The map is a list of points sorted by beat. The first point is always at beat 0 and carries the
 * project tempo (Project.bpm). A point's curve shapes the segment that follows it:
 * - 'step': the tempo jumps at the point and stays constant until the next point;
 * - 'ramp': the tempo changes linearly in beats until the next point's tempo.
 * After the last point the tempo stays constant; before beat 0 it is the first point's tempo.
 *
 * A ramp's bpm(b) = v0 + k·(b − b0) integrates exactly: t = 60/k · ln(bpm(b)/v0), and its inverse is
 * b = b0 + v0/k · (exp(k·t/60) − 1). log1p/expm1 keep both exact for tiny slopes. native/src/tempo.hpp
 * mirrors these formulas so both engines place every event on the same sample.
 */
export const TEMPO_MIN = 30
export const TEMPO_MAX = 300
/** More than this is almost certainly a broken file; it also bounds the native timeline payload. */
export const MAX_TEMPO_POINTS = 4096
const EPSILON = 1e-9

export type TempoSource = Pick<Project, 'bpm'> & { tempoMap?: readonly TempoPoint[] }

const clampBpm = (bpm: number): number => Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, Number.isFinite(bpm) ? bpm : 120))

/**
 * Sorted, de-duplicated points with the first at beat 0 carrying `bpm`. Invalid entries are dropped,
 * points at the same beat keep the last one, and tempos are clamped to the project range.
 */
export function normalizeTempoPoints(bpm: number, points: readonly TempoPoint[] | undefined): TempoPoint[] {
  const first: TempoPoint = { beat: 0, bpm: clampBpm(bpm), curve: 'step' }
  const valid = (points ?? []).filter(point => point && Number.isFinite(point.beat) && point.beat >= 0 && Number.isFinite(point.bpm))
    .map((point, order) => ({ point: { beat: point.beat, bpm: clampBpm(point.bpm), curve: point.curve === 'ramp' ? 'ramp' as const : 'step' as const }, order }))
    .sort((a, b) => a.point.beat - b.point.beat || a.order - b.order)
  const result: TempoPoint[] = [first]
  for (const { point } of valid) {
    const last = result[result.length - 1]
    if (point.beat <= last.beat + EPSILON) {
      // The point at beat 0 always takes the project tempo; it only contributes its curve.
      result[result.length - 1] = result.length === 1 ? { ...first, curve: point.curve } : point
    } else result.push(point)
  }
  return result.slice(0, MAX_TEMPO_POINTS)
}

export class TempoMap {
  readonly points: readonly TempoPoint[]
  /** Seconds at each point. */
  private readonly seconds: readonly number[]
  /** Tempo slope (bpm per beat) of the segment starting at each point; 0 for steps and the last point. */
  private readonly slopes: readonly number[]

  constructor(bpm: number, points?: readonly TempoPoint[]) {
    this.points = normalizeTempoPoints(bpm, points)
    const seconds: number[] = [0]
    const slopes: number[] = []
    for (let index = 0; index < this.points.length; index += 1) {
      const point = this.points[index]
      const next = this.points[index + 1]
      const slope = next && point.curve === 'ramp' ? (next.bpm - point.bpm) / (next.beat - point.beat) : 0
      slopes.push(slope)
      if (next) seconds.push(seconds[index] + segmentSeconds(point.bpm, slope, next.beat - point.beat))
    }
    this.seconds = seconds
    this.slopes = slopes
  }

  static constant(bpm: number): TempoMap { return new TempoMap(bpm) }

  /** True when the tempo never changes (one point, or every point has the same tempo). */
  get isConstant(): boolean { return this.points.every(point => Math.abs(point.bpm - this.points[0].bpm) < EPSILON) }

  /** Index of the segment containing `beat` (the last point at or before it). */
  segmentAt(beat: number): number {
    let lo = 0, hi = this.points.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1
      if (this.points[mid].beat <= beat) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  private segmentAtSeconds(seconds: number): number {
    let lo = 0, hi = this.points.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1
      if (this.seconds[mid] <= seconds) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /** Tempo at `beat` (quarter notes per minute). */
  bpmAt(beat: number): number {
    if (!(beat > 0)) return this.points[0].bpm
    const index = this.segmentAt(beat)
    return this.points[index].bpm + this.slopes[index] * (beat - this.points[index].beat)
  }

  /** Seconds from beat 0 to `beat`; negative beats extrapolate at the first tempo. */
  secondsAt(beat: number): number {
    if (!Number.isFinite(beat)) return beat
    if (beat <= 0) return beat * 60 / this.points[0].bpm
    const index = this.segmentAt(beat)
    const point = this.points[index]
    return this.seconds[index] + segmentSeconds(point.bpm, this.slopes[index], beat - point.beat)
  }

  /** Beat at `seconds` from beat 0 (inverse of secondsAt). */
  beatAt(seconds: number): number {
    if (!Number.isFinite(seconds)) return seconds
    if (seconds <= 0) return seconds * this.points[0].bpm / 60
    const index = this.segmentAtSeconds(seconds)
    const point = this.points[index]
    return point.beat + segmentBeats(point.bpm, this.slopes[index], seconds - this.seconds[index])
  }

  secondsBetween(startBeat: number, endBeat: number): number { return this.secondsAt(endBeat) - this.secondsAt(startBeat) }

  /** The beat `seconds` after `startBeat`. */
  beatAfter(startBeat: number, seconds: number): number { return this.beatAt(this.secondsAt(startBeat) + seconds) }

  /** Project frame of `beat` (unrounded). */
  frameAt(beat: number, sampleRate: number): number { return this.secondsAt(beat) * sampleRate }

  beatAtFrame(frame: number, sampleRate: number): number { return this.beatAt(frame / sampleRate) }
}

/** Seconds a segment starting at `bpm` with `slope` takes to cover `beats`. */
function segmentSeconds(bpm: number, slope: number, beats: number): number {
  if (slope === 0) return beats * 60 / bpm
  return 60 / slope * Math.log1p(slope * beats / bpm)
}

/** Beats a segment starting at `bpm` with `slope` covers in `seconds`. */
function segmentBeats(bpm: number, slope: number, seconds: number): number {
  if (slope === 0) return seconds * bpm / 60
  return bpm / slope * Math.expm1(slope * seconds / 60)
}

// Projects are immutable snapshots: one compiled map per tempoMap array (or per constant tempo).
const mapCache = new WeakMap<readonly TempoPoint[], TempoMap>()
const constantCache = new Map<number, TempoMap>()

/** The compiled tempo map of a project (cached). */
export function tempoMapOf(project: TempoSource): TempoMap {
  const points = project.tempoMap
  if (!points || points.length < 2) {
    let map = constantCache.get(project.bpm)
    if (!map) {
      if (constantCache.size > 64) constantCache.clear()
      map = TempoMap.constant(project.bpm)
      constantCache.set(project.bpm, map)
    }
    return map
  }
  const cached = mapCache.get(points)
  if (cached && cached.points[0].bpm === clampBpm(project.bpm)) return cached
  const map = new TempoMap(project.bpm, points)
  mapCache.set(points, map)
  return map
}

/** A constant tempo or a tempo map: the clip-editing helpers accept either. */
export type Tempo = number | TempoMap

/** Seconds between two beats. */
export function spanSeconds(tempo: Tempo, startBeat: number, endBeat: number): number {
  return typeof tempo === 'number' ? (endBeat - startBeat) * 60 / tempo : tempo.secondsBetween(startBeat, endBeat)
}

/** The beat `seconds` after (or, when negative, before) `startBeat`. */
export function beatAfterSeconds(tempo: Tempo, startBeat: number, seconds: number): number {
  return typeof tempo === 'number' ? startBeat + seconds * tempo / 60 : tempo.beatAfter(startBeat, seconds)
}

/** Beats covered by `seconds` starting at `startBeat`. */
export const spanBeats = (tempo: Tempo, startBeat: number, seconds: number): number => beatAfterSeconds(tempo, startBeat, seconds) - startBeat

/** The constant tempo that covers [startBeat, endBeat) in the same time (for per-region seconds ↔ beats). */
export function averageBpm(tempo: Tempo, startBeat: number, endBeat: number): number {
  const seconds = spanSeconds(tempo, startBeat, endBeat)
  return endBeat > startBeat && seconds > 0 ? (endBeat - startBeat) * 60 / seconds : tempoAt(tempo, startBeat)
}

export const tempoAt = (tempo: Tempo, beat: number): number => typeof tempo === 'number' ? tempo : tempo.bpmAt(beat)

/** True when the project has more than one tempo. */
export const hasTempoChanges = (project: TempoSource): boolean => !tempoMapOf(project).isConstant

// --- Editing (every function returns a new project; callers commit it as one undo step) ---

/** Writes a point list back: the first point's tempo becomes Project.bpm; one point removes the map. */
export function withTempoPoints<T extends TempoSource>(project: T, points: readonly TempoPoint[]): T {
  const bpm = points.length ? clampBpm(points[0].bpm) : project.bpm
  const normalized = normalizeTempoPoints(bpm, points.length ? [{ ...points[0], beat: 0, bpm }, ...points.slice(1)] : [])
  const { tempoMap: _drop, ...rest } = project
  if (normalized.length < 2) return { ...rest, bpm } as unknown as T
  return { ...rest, bpm, tempoMap: normalized } as unknown as T
}

/** Adds a point at `beat` (≥ 0). An existing point at the same beat is replaced. */
export function addTempoPoint<T extends TempoSource>(project: T, beat: number, bpm: number, curve: TempoCurve = 'step'): T {
  const points = normalizeTempoPoints(project.bpm, project.tempoMap)
  if (beat <= EPSILON) return withTempoPoints(project, [{ ...points[0], bpm, curve: points[0].curve }, ...points.slice(1)])
  return withTempoPoints(project, [...points.filter(point => Math.abs(point.beat - beat) > EPSILON), { beat, bpm, curve }])
}

/** Moves point `index` (never the first point's beat) and/or changes its tempo. */
export function moveTempoPoint<T extends TempoSource>(project: T, index: number, beat: number, bpm: number): T {
  const points = normalizeTempoPoints(project.bpm, project.tempoMap)
  if (!points[index]) return project
  if (index === 0) return withTempoPoints(project, [{ ...points[0], bpm }, ...points.slice(1)])
  // A point cannot pass its neighbours: dragging stays between them, like Logic's tempo track.
  const lower = points[index - 1].beat + 1 / 960
  const upper = points[index + 1] ? points[index + 1].beat - 1 / 960 : Infinity
  const clamped = Math.min(upper, Math.max(lower, beat))
  return withTempoPoints(project, points.map((point, at) => at === index ? { ...point, beat: clamped, bpm } : point))
}

export function deleteTempoPoint<T extends TempoSource>(project: T, index: number): T {
  const points = normalizeTempoPoints(project.bpm, project.tempoMap)
  if (index <= 0 || !points[index]) return project
  return withTempoPoints(project, points.filter((_, at) => at !== index))
}

export function setTempoCurve<T extends TempoSource>(project: T, index: number, curve: TempoCurve): T {
  const points = normalizeTempoPoints(project.bpm, project.tempoMap)
  if (!points[index] || points[index].curve === curve) return project
  return withTempoPoints(project, points.map((point, at) => at === index ? { ...point, curve } : point))
}

/**
 * The header tempo field: without a map it sets Project.bpm. With a map it edits the point at or before
 * `beat` (the playhead), like Logic's LCD tempo while a tempo track exists.
 */
export function setTempoAt<T extends TempoSource>(project: T, beat: number, bpm: number): T {
  const points = normalizeTempoPoints(project.bpm, project.tempoMap)
  if (points.length < 2) return withTempoPoints(project, [{ ...points[0], bpm }])
  const index = new TempoMap(project.bpm, points).segmentAt(Math.max(0, beat))
  return moveTempoPoint(project, index, points[index].beat, bpm)
}

/** Scales every tempo by bpm / Project.bpm (used when one tempo for the whole song is adopted). */
export function scaleTempoMap<T extends TempoSource>(project: T, bpm: number): T {
  const points = normalizeTempoPoints(project.bpm, project.tempoMap)
  const factor = clampBpm(bpm) / points[0].bpm
  return withTempoPoints(project, points.map(point => ({ ...point, bpm: point.bpm * factor })))
}

// --- Standard MIDI File tempo (meta event 0x51 carries microseconds per quarter note; steps only) ---

/** One SMF tempo event. */
export interface TempoStep { beat: number; bpm: number }

/** Ramps are written as tempo steps this far apart (a 32nd note), like Logic and Cubase do. */
export const SMF_RAMP_STEP_BEATS = 1 / 8

/**
 * Tempo events for an SMF conductor track at `ppq`. Each step inside a ramp carries the segment's exact
 * average tempo (Δbeats / Δseconds), so every step boundary lands at its exact time.
 */
export function tempoStepsForExport(map: TempoMap, ppq: number): Array<{ tick: number; microseconds: number }> {
  const result: Array<{ tick: number; microseconds: number }> = []
  const push = (tick: number, bpm: number) => {
    const microseconds = Math.max(1, Math.min(0xffffff, Math.round(60_000_000 / bpm)))
    const last = result[result.length - 1]
    if (last && last.tick === tick) { last.microseconds = microseconds; return }
    if (last && last.microseconds === microseconds) return
    result.push({ tick, microseconds })
  }
  map.points.forEach((point, index) => {
    const next = map.points[index + 1]
    const startTick = Math.max(0, Math.round(point.beat * ppq))
    if (!next || point.curve !== 'ramp' || Math.abs(next.bpm - point.bpm) < 1e-9) { push(startTick, point.bpm); return }
    const endTick = Math.round(next.beat * ppq)
    const stepTicks = Math.max(1, Math.round(SMF_RAMP_STEP_BEATS * ppq))
    for (let tick = startTick; tick < endTick; tick += stepTicks) {
      const to = Math.min(endTick, tick + stepTicks)
      push(tick, (to - tick) / ppq * 60 / map.secondsBetween(tick / ppq, to / ppq))
    }
  })
  return result
}

/**
 * Tempo-map points from SMF tempo events (sorted by beat; the first must be at beat 0). Runs of at least
 * three evenly spaced steps that follow a straight line (how DAWs write ramps, see tempoStepsForExport)
 * become one ramp point, so an exported ramp imports as a ramp again.
 */
export function tempoPointsFromSteps(steps: readonly TempoStep[]): TempoPoint[] {
  const events: TempoStep[] = []
  for (const step of steps) {
    if (events.length && Math.abs(events[events.length - 1].beat - step.beat) < 1e-9) events[events.length - 1] = step
    else events.push(step)
  }
  const points: TempoPoint[] = []
  let index = 0
  while (index < events.length) {
    const end = rampRunEnd(events, index)
    if (end > index) {
      // Average tempos belong to interval midpoints: extrapolate the line back to the run start.
      const a = events[index], b = events[end - 1]
      const ma = (a.beat + events[index + 1].beat) / 2, mb = (b.beat + events[end].beat) / 2
      const slope = (b.bpm - a.bpm) / (mb - ma)
      points.push({ beat: a.beat, bpm: a.bpm - slope * (ma - a.beat), curve: 'ramp' })
      index = end
    } else {
      points.push({ beat: events[index].beat, bpm: events[index].bpm, curve: 'step' })
      index += 1
    }
  }
  return points
}

/** Index of the event that ends a ramp run starting at `start`, or `start` when there is none. */
function rampRunEnd(events: readonly TempoStep[], start: number): number {
  const spacing = (events[start + 1]?.beat ?? Infinity) - events[start].beat
  if (!(spacing <= 1 + 1e-9)) return start
  let last = start + 1
  // Evenly spaced steps; the final interval before the ramp's end point may be shorter.
  while (last + 1 < events.length && Math.abs(events[last + 1].beat - events[last].beat - spacing) < 1e-6) last += 1
  if (last + 1 < events.length && events[last + 1].beat - events[last].beat < spacing - 1e-6) last += 1
  for (let end = last; end - start >= 3; end -= 1) {
    if (isRamp(events, start, end, spacing)) return end
  }
  return start
}

function isRamp(events: readonly TempoStep[], start: number, end: number, spacing: number): boolean {
  const mid = (index: number) => (events[index].beat + events[index + 1].beat) / 2
  const a = events[start], b = events[end - 1]
  const slope = (b.bpm - a.bpm) / (mid(end - 1) - mid(start))
  if (!Number.isFinite(slope) || Math.abs(slope * spacing) < 0.01) return false
  const tolerance = 0.02 + Math.abs(slope) * spacing * 0.02
  for (let index = start; index < end; index += 1) {
    if (Math.abs(events[index].bpm - (a.bpm + slope * (mid(index) - mid(start)))) > tolerance) return false
  }
  // The event after the run is the ramp's target tempo, exactly on the line.
  return Math.abs(events[end].bpm - (a.bpm + slope * (events[end].beat - mid(start)))) <= tolerance + Math.abs(slope) * spacing * 0.1
}

import { automationValue, evaluateLane, withStaticValue, isDiscrete, laneFor, newLaneId, normalizeValue, replaceRange, staticValue, targetDef, targetKey, thinPoints, updateLane } from './automation'
import { toNormalized } from './devices'
import type { AutomationMode, AutomationPoint, AutomationTarget, Project, Track } from './types'

/**
 * One automation recording pass (play → stop), Logic's 터치/래치/쓰기 (docs/AUTOMATION.md).
 * The pass never edits the project while it runs: the UI draws `apply(project)` and the engine hears
 * `engineProject(project)`; stopping commits `apply()` as one undo step.
 *  - 터치: writes while a control is held, then returns to the existing lane.
 *  - 래치: starts on the first touch and keeps writing the last value until stop.
 *  - 쓰기: every lane of the track is overwritten from the start of the pass, holding its current value until touched.
 */

/** After a written range ends, the lane glides back to its previous curve over this many beats. */
export const RETURN_BEATS = 1 / 16
const MAX_SAMPLES = 50_000

interface Range { start: number; end: number; samples: AutomationPoint[] }
interface Writer {
  trackId: string
  target: AutomationTarget
  mode: Exclude<AutomationMode, 'read'>
  active: boolean
  /** Normalized value being written. */
  value: number
  last: number
  ranges: Range[]
}

export const trackMode = (track: Track): AutomationMode => track.automationMode ?? 'read'
export const recordsAutomation = (project: Project): boolean => project.tracks.some(track => trackMode(track) !== 'read')

function originalValue(track: Track, target: AutomationTarget, beat: number): number | undefined {
  const def = targetDef(track, target)
  if (!def) return undefined
  const lane = laneFor(track, target)
  const lanes = lane && lane.enabled !== false ? evaluateLane(lane.points, beat, isDiscrete(def)) : undefined
  if (lanes !== undefined) return lanes
  const value = staticValue(track, target)
  return value === undefined ? undefined : toNormalized(def, value)
}

export class AutomationPass {
  private readonly writers = new Map<string, Writer>()
  private beat: number
  private stopped = false

  constructor(private readonly base: Project, startBeat: number) {
    this.beat = startBeat
    for (const track of base.tracks) {
      if (trackMode(track) !== 'write') continue
      for (const lane of track.automation ?? []) {
        const value = originalValue(track, lane.target, startBeat)
        if (value === undefined) continue
        this.writers.set(this.key(track.id, lane.target), { trackId: track.id, target: lane.target, mode: 'write', active: true, value, last: startBeat, ranges: [{ start: startBeat, end: startBeat, samples: [{ beat: startBeat, value }] }] })
      }
    }
  }

  private key(trackId: string, target: AutomationTarget): string { return `${trackId}\n${targetKey(target)}` }

  /** Whether a control edit on this track is written by the pass instead of changing the static value. */
  handles(trackId: string): boolean {
    const track = this.base.tracks.find(item => item.id === trackId)
    return !this.stopped && !!track && trackMode(track) !== 'read'
  }

  /** A control moved to `value` (target units) at `beat`. Returns false when the pass does not record it. */
  touch(track: Track, target: AutomationTarget, value: number, beat: number): boolean {
    if (!this.handles(track.id)) return false
    const normalized = normalizeValue(track, target, value)
    if (normalized === null) return false
    const mode = trackMode(this.base.tracks.find(item => item.id === track.id)!) as Writer['mode']
    const key = this.key(track.id, target)
    let writer = this.writers.get(key)
    if (!writer) { writer = { trackId: track.id, target, mode, active: false, value: normalized, last: beat, ranges: [] }; this.writers.set(key, writer) }
    if (!writer.active) { writer.active = true; writer.ranges.push({ start: beat, end: beat, samples: [] }) }
    this.follow(writer, beat)
    writer.value = normalized
    this.sample(writer, beat)
    return true
  }

  /** The control was let go. Touch stops writing; latch and write keep the last value. */
  release(trackId: string, target: AutomationTarget, beat: number): void {
    const writer = this.writers.get(this.key(trackId, target))
    if (!writer?.active || writer.mode !== 'touch') return
    this.follow(writer, beat)
    this.sample(writer, beat)
    writer.active = false
  }

  /** Playhead position while the pass runs (cycle jumps split the written ranges). */
  advance(beat: number): void {
    if (this.stopped) return
    for (const writer of this.writers.values()) if (writer.active) { this.follow(writer, beat); this.sample(writer, beat) }
    this.beat = beat
  }

  stop(beat = this.beat): void {
    if (this.stopped) return
    this.advance(beat)
    this.stopped = true
    for (const writer of this.writers.values()) writer.active = false
  }

  get isEmpty(): boolean { return ![...this.writers.values()].some(writer => writer.ranges.some(range => range.samples.length)) }

  private follow(writer: Writer, beat: number): void {
    if (beat < writer.last - 1e-6 && writer.active) {
      // Cycle jump: close the range at the loop end, continue at the loop start.
      this.sample(writer, writer.last)
      writer.ranges.push({ start: beat, end: beat, samples: [] })
    }
    writer.last = beat
  }

  private sample(writer: Writer, beat: number): void {
    const range = writer.ranges.at(-1)
    if (!range) return
    range.end = Math.max(range.end, beat)
    const last = range.samples.at(-1)
    if (last && Math.abs(last.beat - beat) < 1e-9) { last.value = writer.value; return }
    if (range.samples.length < MAX_SAMPLES) range.samples.push({ beat, value: writer.value })
  }

  /** The project with everything written so far (or, after stop, the final result). */
  apply(project: Project): Project {
    if (this.isEmpty) return project
    let tracks = project.tracks
    for (const writer of this.writers.values()) {
      const index = tracks.findIndex(track => track.id === writer.trackId)
      if (index < 0) continue
      const original = this.base.tracks.find(track => track.id === writer.trackId) ?? tracks[index]
      let track = tracks[index]
      if (!targetDef(track, writer.target)) continue
      for (const range of writer.ranges) {
        if (!range.samples.length) continue
        const before = originalValue(original, writer.target, range.start)
        const after = originalValue(original, writer.target, range.end + RETURN_BEATS)
        const written = thinPoints(range.samples)
        const inserted = [...(before === undefined ? [] : [{ beat: range.start, value: before }]), ...written,
          ...(after === undefined || (writer.active && range === writer.ranges.at(-1)) ? [] : [{ beat: range.end + RETURN_BEATS, value: after }])]
        track = updateLane(track, writer.target, lane => ({ ...lane, id: lane.id || newLaneId(), points: replaceRange(lane.points, range.start, range.end + RETURN_BEATS, inserted), enabled: true }))
      }
      // A re-enabled lane saves without the flag.
      track = { ...track, automation: track.automation?.map(lane => lane.enabled === true ? (({ enabled: _on, ...rest }) => rest)(lane) : lane) }
      tracks = tracks.map((item, i) => i === index ? track : item)
    }
    return tracks === project.tracks ? project : { ...project, tracks }
  }

  /** What the engine should hear: targets being written play the written value as their static value. */
  engineProject(project: Project): Project {
    const active = [...this.writers.values()].filter(writer => writer.active)
    if (!active.length) return project
    const tracks = project.tracks.map(track => {
      const writers = active.filter(writer => writer.trackId === track.id)
      if (!writers.length) return track
      let next = track
      for (const writer of writers) {
        const def = targetDef(next, writer.target)
        if (!def) continue
        const keyed = targetKey(writer.target)
        next = { ...next, automation: next.automation?.filter(lane => targetKey(lane.target) !== keyed) }
        next = withStaticValue(next, writer.target, automationValue(def, writer.value))
      }
      return next
    })
    return { ...project, tracks }
  }

  /** Targets being written right now, for the UI (knob rings turn red). */
  writing(trackId: string): string[] {
    return [...this.writers.values()].filter(writer => writer.active && writer.trackId === trackId).map(writer => targetKey(writer.target))
  }
}

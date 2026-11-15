import type { ControllerKey, ControllerPoint, MidiClip } from './types'

/**
 * MIDI controller lanes (docs/MIDI_CONTROLLERS.md): CC 0–127, pitch bend, channel aftertouch and program change,
 * stored per region in source beats like notes (MidiClip.controllers). The sustain pedal (CC64) keeps its own
 * field, MidiClip.sustain (core/sustain.ts), because its meaning goes beyond a value: it defers note-offs.
 *
 * Rules shared by both engines, import/export, recording and the piano roll — the same ones the pedal follows:
 * - Values are step events (right-continuous): an event at beat b decides the value *at* b. Drawn lines and
 *   curves are written as dense, thinned steps; instruments smooth pitch bend themselves.
 * - The state belongs to one region occurrence: the value in effect at the visible left edge is chased as an event
 *   at 0, and "reset" controllers (pitch bend, aftertouch, modulation, breath, expression) return to their default
 *   at the region end and at every loop wrap. Hold controllers (volume, pan, program, other CCs) keep their value.
 * - Never transposed or quantized.
 */
const EPSILON = 1e-9

export const PITCH_BEND_MIN = -8192
export const PITCH_BEND_MAX = 8191
export const DEFAULT_BEND_RANGE = 2
export const MAX_BEND_RANGE = 48
/** Wire numbers (native timeline, recording): 0–127 CC, then these, as in VST3's ControllerNumbers. */
export const AFTERTOUCH_NUMBER = 128
export const PITCH_BEND_NUMBER = 129
export const PROGRAM_NUMBER = 130
/** Native host meta-controller: the region's pitch-bend range (semitones) for built-in instruments. */
export const BEND_RANGE_NUMBER = 131
/** Lanes and recording keep CC64 in MidiClip.sustain. */
export const SUSTAIN_CC = 64

const RESET_CCS = new Set([1, 2, 11])
const CC_DEFAULTS: Readonly<Record<number, number>> = { 7: 100, 8: 64, 10: 64, 11: 127 }
const CC_NAMES: Readonly<Record<number, string>> = {
  0: '뱅크 선택', 1: '모듈레이션', 2: '브레스', 4: '풋 컨트롤', 5: '포르타멘토 시간', 7: '볼륨', 8: '밸런스', 10: '팬', 11: '익스프레션',
  64: '서스테인', 65: '포르타멘토', 66: '소스테누토', 67: '소프트 페달', 71: '레조넌스', 72: '릴리스', 73: '어택', 74: '브라이트니스',
  91: '리버브', 93: '코러스',
}

export const ccKey = (number: number): ControllerKey => `cc${number}` as ControllerKey

export function isControllerKey(value: unknown): value is ControllerKey {
  if (value === 'pitchBend' || value === 'aftertouch' || value === 'program') return true
  if (typeof value !== 'string' || !/^cc(0|[1-9]\d?|1[01]\d|12[0-7])$/.test(value)) return false
  return Number(value.slice(2)) !== SUSTAIN_CC
}

/** 0–127 CC, 128 aftertouch, 129 pitch bend, 130 program. */
export function controllerNumber(key: ControllerKey): number {
  if (key === 'aftertouch') return AFTERTOUCH_NUMBER
  if (key === 'pitchBend') return PITCH_BEND_NUMBER
  if (key === 'program') return PROGRAM_NUMBER
  return Number(key.slice(2))
}

export function keyOfNumber(number: number): ControllerKey | null {
  if (number === AFTERTOUCH_NUMBER) return 'aftertouch'
  if (number === PITCH_BEND_NUMBER) return 'pitchBend'
  if (number === PROGRAM_NUMBER) return 'program'
  return Number.isInteger(number) && number >= 0 && number <= 127 && number !== SUSTAIN_CC ? ccKey(number) : null
}

export interface ControllerSpec { min: number; max: number; default: number; reset: boolean; label: string; short: string }

export function controllerSpec(key: ControllerKey): ControllerSpec {
  if (key === 'pitchBend') return { min: PITCH_BEND_MIN, max: PITCH_BEND_MAX, default: 0, reset: true, label: '피치 벤드', short: 'PB' }
  if (key === 'aftertouch') return { min: 0, max: 127, default: 0, reset: true, label: '애프터터치', short: 'AT' }
  if (key === 'program') return { min: 0, max: 127, default: 0, reset: false, label: '프로그램 체인지', short: 'PG' }
  const number = controllerNumber(key)
  return { min: 0, max: 127, default: CC_DEFAULTS[number] ?? 0, reset: RESET_CCS.has(number), label: CC_NAMES[number] ? `${CC_NAMES[number]} (CC${number})` : `CC ${number}`, short: `CC${number}` }
}

export const controllerName = (number: number): string | undefined => CC_NAMES[number]

/** Lane order in the piano roll and in saved files: pitch bend, CCs by number, aftertouch, program. */
export function controllerOrder(a: ControllerKey, b: ControllerKey): number {
  const rank = (key: ControllerKey) => key === 'pitchBend' ? -1 : key === 'aftertouch' ? 200 : key === 'program' ? 201 : controllerNumber(key)
  return rank(a) - rank(b)
}

export function clampControllerValue(key: ControllerKey, value: number): number {
  const spec = controllerSpec(key)
  return Math.max(spec.min, Math.min(spec.max, Math.round(Number.isFinite(value) ? value : spec.default)))
}

/** Sorted, de-duplicated (last event per beat wins), integer values in range, non-negative beats. */
export function normalizeController(key: ControllerKey, points: readonly ControllerPoint[] | undefined): ControllerPoint[] {
  if (!points?.length) return []
  const sorted = points
    .filter(point => Number.isFinite(point.beat) && Number.isFinite(point.value))
    .map((point, index) => ({ beat: Math.max(0, point.beat), value: clampControllerValue(key, point.value), index }))
    .sort((a, b) => a.beat - b.beat || a.index - b.index)
  const result: ControllerPoint[] = []
  for (const { beat, value } of sorted) {
    const last = result[result.length - 1]
    if (last && Math.abs(last.beat - beat) < EPSILON) last.value = value
    else result.push({ beat, value })
  }
  return result
}

/** Value at `beat` (right-continuous); undefined before the first event. */
export function controllerValueAt(points: readonly ControllerPoint[] | undefined, beat: number): number | undefined {
  let value: number | undefined
  for (const point of points ?? []) {
    if (point.beat > beat + EPSILON) break
    value = point.value
  }
  return value
}

/** Drops events that repeat the previous value. */
export function pruneController(points: readonly ControllerPoint[]): ControllerPoint[] {
  const result: ControllerPoint[] = []
  for (const point of points) if (!result.length || result[result.length - 1].value !== point.value) result.push(point)
  return result
}

export const controllerKeys = (clip: Pick<MidiClip, 'controllers'>): ControllerKey[] =>
  Object.keys(clip.controllers ?? {}).filter((key): key is ControllerKey => isControllerKey(key) && !!clip.controllers?.[key as ControllerKey]?.length).sort(controllerOrder)

export const hasControllers = (clip: Pick<MidiClip, 'controllers'>): boolean => controllerKeys(clip).length > 0

/** Returns the clip with `points` as the lane (removing the lane, and the map, when empty). */
export function withController(clip: MidiClip, key: ControllerKey, points: readonly ControllerPoint[]): MidiClip {
  const next = { ...(clip.controllers ?? {}) }
  if (points.length) next[key] = points.map(point => ({ beat: point.beat, value: point.value }))
  else delete next[key]
  const { controllers: _controllers, ...rest } = clip
  return Object.keys(next).length ? { ...rest, controllers: next } : rest
}

/** Maps every lane's beats (source coordinates); used by left trims that extend before source beat 0. */
export function mapControllerBeats(clip: MidiClip, map: (beat: number) => number): MidiClip['controllers'] {
  if (!clip.controllers) return undefined
  return Object.fromEntries(Object.entries(clip.controllers).map(([key, points]) => [key, (points ?? []).map(point => ({ beat: map(point.beat), value: point.value }))]))
}

/** Region-relative (visible) events of one lane: the value at the left edge is chased as an event at 0. */
export function visibleController(clip: MidiClip, key: ControllerKey): ControllerPoint[] {
  const points = clip.controllers?.[key]
  if (!points?.length) return []
  const offset = clip.sourceOffsetBeats ?? 0
  const spec = controllerSpec(key)
  const result: ControllerPoint[] = []
  const initial = controllerValueAt(points, offset)
  // A reset controller already sits at its default when the region starts; a hold controller is always re-sent.
  if (initial !== undefined && (!spec.reset || initial !== spec.default)) result.push({ beat: 0, value: initial })
  for (const point of points) {
    const beat = point.beat - offset
    if (beat <= EPSILON || beat >= clip.lengthBeats - EPSILON) continue
    result.push({ beat, value: point.value })
  }
  return result
}

/** Replace the visible window of one lane. Hidden source events before and after the window survive unchanged. */
export function applyVisibleController(clip: MidiClip, key: ControllerKey, visible: readonly ControllerPoint[]): MidiClip {
  const offset = clip.sourceOffsetBeats ?? 0
  const end = offset + clip.lengthBeats
  const spec = controllerSpec(key)
  const source = clip.controllers?.[key] ?? []
  const before = source.filter(point => point.beat < offset - EPSILON)
  const after = source.filter(point => point.beat >= end - EPSILON)
  const inside = normalizeController(key, visible.map(point => ({ beat: point.beat + offset, value: point.value }))).filter(point => point.beat < end - EPSILON)
  // The hidden part before the window would otherwise leak into it: start the window at the default.
  const hiddenStart = controllerValueAt(before, offset)
  const head = hiddenStart !== undefined && hiddenStart !== spec.default && !(inside[0] && inside[0].beat <= offset + EPSILON) ? [{ beat: offset, value: spec.default }] : []
  // Keep the hidden tail's state: restore the original value at the right edge when the edit changed it there.
  const originalAtEnd = controllerValueAt(source, end - EPSILON * 2)
  const editedAtEnd = controllerValueAt([...before, ...head, ...inside], end - EPSILON * 2)
  const tail = after.length && after[0].beat - end < EPSILON ? [] : originalAtEnd !== undefined && after.length && originalAtEnd !== editedAtEnd ? [{ beat: end, value: originalAtEnd }] : []
  const next = pruneController(normalizeController(key, [...before, ...head, ...inside, ...tail, ...after]))
  // A reset lane holding nothing but its default carries no information.
  const meaningful = !spec.reset || next.some(point => point.value !== spec.default) ? next : []
  if (sameEvents(meaningful, source)) return clip
  return withController(clip, key, meaningful)
}

const sameEvents = (a: readonly ControllerPoint[], b: readonly ControllerPoint[]): boolean =>
  a.length === b.length && a.every((point, index) => Math.abs(point.beat - b[index].beat) < EPSILON && point.value === b[index].value)

/** One controller event of one occurrence, in the occurrence's beats (0 = occurrence start). */
export interface OccurrenceController { beat: number; key: ControllerKey; value: number }

/**
 * Every lane of one occurrence `window` beats long: visible events (with the chase at 0), then — for reset
 * controllers left away from their default — a reset event at the occurrence end. Sorted by beat, lane order stable.
 */
export function occurrenceControllers(clip: MidiClip, window: number): OccurrenceController[] {
  const events: OccurrenceController[] = []
  for (const key of controllerKeys(clip)) {
    const spec = controllerSpec(key)
    let value: number | undefined
    for (const point of visibleController(clip, key)) {
      if (point.beat >= window - EPSILON) break
      events.push({ beat: point.beat, key, value: point.value })
      value = point.value
    }
    if (spec.reset && value !== undefined && value !== spec.default) events.push({ beat: window, key, value: spec.default })
  }
  return events.sort((a, b) => a.beat - b.beat)
}

/** Joined regions keep each source's audible lanes: visible windows rebased to `startBeat`, reset at each region end. */
export function joinControllers(clips: readonly MidiClip[], startBeat: number): MidiClip['controllers'] {
  const lanes = new Map<ControllerKey, ControllerPoint[]>()
  const sorted = [...clips].sort((a, b) => a.startBeat - b.startBeat)
  for (const clip of sorted) {
    const shift = clip.startBeat - startBeat
    const end = clip.startBeat + clip.lengthBeats
    // Overlapping sources (a merged recording) keep playing past this one's end: no reset there.
    const covered = sorted.some(other => other !== clip && other.startBeat < end - EPSILON && other.startBeat + other.lengthBeats > end + EPSILON)
    for (const event of occurrenceControllers(clip, clip.lengthBeats)) {
      if (covered && event.beat >= clip.lengthBeats - EPSILON) continue
      const list = lanes.get(event.key) ?? []
      list.push({ beat: event.beat + shift, value: event.value })
      lanes.set(event.key, list)
    }
  }
  const result: NonNullable<MidiClip['controllers']> = {}
  for (const [key, points] of lanes) {
    const normalized = pruneController(normalizeController(key, points))
    if (!controllerSpec(key).reset || normalized.some(point => point.value !== controllerSpec(key).default)) result[key] = normalized
  }
  return Object.keys(result).length ? result : undefined
}

/** Pitch-bend range of a region in semitones (absent = ±2). */
export const bendRangeOf = (clip: Pick<MidiClip, 'bendRange'>): number =>
  typeof clip.bendRange === 'number' && Number.isFinite(clip.bendRange) ? Math.max(0, Math.min(MAX_BEND_RANGE, clip.bendRange)) : DEFAULT_BEND_RANGE

/** Pitch bend in semitones for a raw −8192…8191 value. */
export const bendSemitones = (value: number, range = DEFAULT_BEND_RANGE): number => value / 8192 * range

// ---- Thinning --------------------------------------------------------------------------------------------------

export interface ThinOptions {
  /** Smallest value change kept between two events (in the lane's units). */
  tolerance?: number
  /** Smallest distance in beats between two kept events, unless the value jumps by 4 × tolerance or more. */
  minGapBeats?: number
}

/** Default thinning: pitch bend ±32 (≈ ¾ cent at ±2), 7-bit values ±1; at most 128 events per beat. */
export function thinDefaults(key: ControllerKey): Required<ThinOptions> {
  return { tolerance: key === 'pitchBend' ? 32 : 1, minGapBeats: 1 / 128 }
}

/**
 * Logic-like event thinning for recorded and drawn controller streams: repeated values are dropped, and a new
 * event is kept only once it moved by `tolerance` and `minGapBeats` passed (or the value jumped). The last event
 * of the stream and every return to the lane default (pitch bend back to center) are always kept, so the final
 * value is exact. Input must be sorted by beat.
 */
export function thinController(key: ControllerKey, points: readonly ControllerPoint[], options: ThinOptions = {}): ControllerPoint[] {
  const { tolerance, minGapBeats } = { ...thinDefaults(key), ...options }
  const spec = controllerSpec(key)
  const result: ControllerPoint[] = []
  let pending: ControllerPoint | null = null
  for (const point of points) {
    const last = result[result.length - 1]
    if (!last) { result.push(point); continue }
    if (point.value === last.value) { pending = null; continue }
    const delta = Math.abs(point.value - last.value)
    const gap = point.beat - last.beat
    const keep = point.value === spec.default || key === 'program' || delta >= tolerance * 4 || (delta >= tolerance && gap >= minGapBeats - EPSILON)
    if (keep) { result.push(point); pending = null }
    else pending = point
  }
  if (pending && result[result.length - 1].value !== pending.value) result.push(pending)
  return result
}

/** Points along a straight line (or an eased curve, `curve` −1…1) from a to b, one per `step` beats, thinned. */
export function lineController(key: ControllerKey, from: ControllerPoint, to: ControllerPoint, step: number, curve = 0): ControllerPoint[] {
  const [a, b] = from.beat <= to.beat ? [from, to] : [to, from]
  const span = b.beat - a.beat
  if (span < EPSILON) return [{ beat: a.beat, value: clampControllerValue(key, b.value) }]
  const count = Math.max(1, Math.min(4096, Math.ceil(span / Math.max(step, 1 / 960))))
  const shape = (t: number): number => curve === 0 ? t : curve > 0 ? t ** (1 + curve * 3) : 1 - (1 - t) ** (1 - curve * 3)
  const points: ControllerPoint[] = []
  for (let index = 0; index <= count; index += 1) {
    const t = index / count
    points.push({ beat: a.beat + span * t, value: clampControllerValue(key, a.value + (b.value - a.value) * shape(t)) })
  }
  return thinController(key, points)
}

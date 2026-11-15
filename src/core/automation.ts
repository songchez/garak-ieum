import { EFFECT_DEFS, fromNormalized, toNormalized, type ParamDef } from './devices'
import { instrumentDef } from './instruments'
import type { AutomationLane, AutomationMode, AutomationPoint, AutomationTarget, Device, Project, Track } from './types'

/**
 * Track automation (schema 17, docs/AUTOMATION.md): evaluation, curves, thinning, target addressing and the
 * lane edits the timeline uses. Both engines evaluate lanes with exactly these rules; native/src/engine.cpp
 * mirrors automationShape() and evaluateLane().
 */

export const AUTOMATION_MODES: readonly AutomationMode[] = ['read', 'touch', 'latch', 'write']
export const AUTOMATION_MODE_LABELS: Readonly<Record<AutomationMode, string>> = { read: '읽기', touch: '터치', latch: '래치', write: '쓰기' }
export const MAX_AUTOMATION_LANES = 256
export const MAX_AUTOMATION_POINTS = 20_000
/** Segment curvature exponent at |curve| = 1 (Ableton-like bend). */
const CURVE_STRENGTH = 6

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/** Stable key for maps, picker values and the native protocol. */
export function targetKey(target: AutomationTarget): string {
  switch (target.kind) {
    case 'track': return `track:${target.param}`
    case 'device': return `device:${target.deviceId}:${target.param}`
    case 'instrument': return `instrument:${target.param}`
    case 'plugin-instrument': return `plugin:${target.param}`
  }
}
export function parseTargetKey(key: string): AutomationTarget | null {
  const [kind, ...rest] = key.split(':')
  if (kind === 'track' && (rest[0] === 'volume' || rest[0] === 'pan' || rest[0] === 'mute') && rest.length === 1) return { kind: 'track', param: rest[0] }
  if (kind === 'device' && rest.length >= 2 && rest[0]) return { kind: 'device', deviceId: rest[0], param: rest.slice(1).join(':') }
  if (kind === 'instrument' && rest.length === 1 && rest[0]) return { kind: 'instrument', param: rest[0] }
  if (kind === 'plugin' && rest.length === 1 && /^\d+$/.test(rest[0])) return { kind: 'plugin-instrument', param: rest[0] }
  return null
}
export const sameTarget = (a: AutomationTarget, b: AutomationTarget): boolean => targetKey(a) === targetKey(b)

/** Track volume uses the fader's own 0…2 linear gain range; the lane draws it in dB. */
export const TRACK_PARAM_DEFS: Readonly<Record<'volume' | 'pan' | 'mute', ParamDef>> = {
  volume: { id: 'volume', label: '볼륨', min: 0, max: 2, default: 1, unit: 'gain' },
  pan: { id: 'pan', label: '팬', min: -1, max: 1, default: 0, unit: 'pan' },
  mute: { id: 'mute', label: '뮤트', min: 0, max: 1, default: 0, unit: 'q', options: [{ value: 0, label: '켬' }, { value: 1, label: '뮤트' }] },
}
const VST3_DEF = (param: string, label?: string): ParamDef => ({ id: param, label: label ?? `파라미터 ${param}`, min: 0, max: 1, default: 0, unit: 'pct' })

/** Rack layout and preset-structure values are not continuous controls (they rebuild the processor). */
export function isAutomatableParam(def: ParamDef): boolean {
  return !/^rackSlot\d+$/.test(def.id)
}

export function effectDeviceDefs(device: Device): readonly ParamDef[] {
  return device.type === 'vst3' ? [] : EFFECT_DEFS[device.type].params.filter(isAutomatableParam)
}

/** Built-in instrument parameters; IEUM WAVE keeps its own patch and is not automatable yet. */
export function instrumentParamDefs(track: Track): readonly ParamDef[] {
  if (track.kind !== 'instrument' || track.pluginInstrument) return []
  const def = instrumentDef(track.instrument)
  return def.kind === 'native' ? [] : def.params
}

/** The parameter definition a target is normalized against, or null when the target no longer exists. */
export function targetDef(track: Track, target: AutomationTarget): ParamDef | null {
  switch (target.kind) {
    case 'track': return TRACK_PARAM_DEFS[target.param] ?? null
    case 'device': {
      const device = track.devices.find(item => item.id === target.deviceId)
      if (!device) return null
      if (device.type === 'vst3') return /^\d+$/.test(target.param) ? VST3_DEF(target.param) : null
      return effectDeviceDefs(device).find(def => def.id === target.param) ?? null
    }
    case 'instrument': return instrumentParamDefs(track).find(def => def.id === target.param) ?? null
    case 'plugin-instrument': return track.pluginInstrument && /^\d+$/.test(target.param) ? VST3_DEF(target.param) : null
  }
}

/** Discrete targets (mute, option lists) hold each point's value until the next point. */
export const isDiscrete = (def: ParamDef): boolean => !!def.options

/** The static (unautomated) value of a target, in its own units. */
export function staticValue(track: Track, target: AutomationTarget): number | undefined {
  switch (target.kind) {
    case 'track': return target.param === 'mute' ? (track.mute ? 1 : 0) : track[target.param]
    case 'device': {
      const device = track.devices.find(item => item.id === target.deviceId)
      if (!device) return undefined
      if (device.type === 'vst3') return device.parameters[target.param]
      return device.params[target.param] ?? EFFECT_DEFS[device.type].params.find(def => def.id === target.param)?.default
    }
    case 'instrument': return track.instrumentParams[target.param] ?? instrumentParamDefs(track).find(def => def.id === target.param)?.default
    case 'plugin-instrument': return track.pluginInstrument?.parameters[target.param]
  }
}

/** Writes a value (own units) back as the static value; returns the same track when unchanged. */
export function withStaticValue(track: Track, target: AutomationTarget, value: number): Track {
  if (staticValue(track, target) === value) return track
  switch (target.kind) {
    case 'track': return target.param === 'mute' ? { ...track, mute: value >= 0.5 } : { ...track, [target.param]: value }
    case 'device': return { ...track, devices: track.devices.map(device => device.id !== target.deviceId ? device
      : device.type === 'vst3' ? { ...device, parameters: { ...device.parameters, [target.param]: value } }
        : { ...device, params: { ...device.params, [target.param]: value } }) }
    case 'instrument': return { ...track, instrumentParams: { ...track.instrumentParams, [target.param]: value } }
    case 'plugin-instrument': return track.pluginInstrument ? { ...track, pluginInstrument: { ...track.pluginInstrument, parameters: { ...track.pluginInstrument.parameters, [target.param]: value } } } : track
  }
}

/** Shape of a curved segment at t∈[0,1]; curve > 0 starts slowly (bows below a rising line). Mirrored in engine.cpp. */
export function automationShape(t: number, curve = 0): number {
  const x = clamp01(t)
  if (!(Math.abs(curve) > 1e-6)) return x
  const k = Math.max(-1, Math.min(1, curve)) * CURVE_STRENGTH
  return (Math.exp(k * x) - 1) / (Math.exp(k) - 1)
}

/** Index of the last point at or before beat, or −1. */
function pointBefore(points: readonly AutomationPoint[], beat: number): number {
  let lo = 0, hi = points.length
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid].beat <= beat) lo = mid + 1; else hi = mid }
  return lo - 1
}

/** Normalized lane value at a beat; undefined when the lane has no points. Before the first point the first
 * value holds, after the last point the last value holds. */
export function evaluateLane(points: readonly AutomationPoint[], beat: number, discrete = false): number | undefined {
  if (!points.length) return undefined
  const index = pointBefore(points, beat)
  if (index < 0) return points[0].value
  const a = points[index]
  if (index === points.length - 1 || discrete) return a.value
  const b = points[index + 1]
  const span = b.beat - a.beat
  if (!(span > 1e-9)) return b.value
  return a.value + (b.value - a.value) * automationShape((beat - a.beat) / span, a.curve ?? 0)
}

/** An enabled lane with points whose target still exists. */
export const isActiveLane = (track: Track, lane: AutomationLane): boolean => lane.enabled !== false && lane.points.length > 0 && targetDef(track, lane.target) !== null

export function laneFor(track: Track, target: AutomationTarget): AutomationLane | undefined {
  const key = targetKey(target)
  return track.automation?.find(lane => targetKey(lane.target) === key)
}

/** Automation state of one control: drives the knob ring. */
export function automationState(track: Track | undefined, target: AutomationTarget): 'active' | 'override' | null {
  const lane = track && laneFor(track, target)
  if (!lane || !lane.points.length) return null
  return lane.enabled === false ? 'override' : 'active'
}

/** The value (own units) a target plays at a beat: the lane when active, otherwise the static value. */
export function valueAt(track: Track, target: AutomationTarget, beat: number): number | undefined {
  const lane = laneFor(track, target)
  const def = targetDef(track, target)
  if (lane && def && lane.enabled !== false) {
    const normalized = evaluateLane(lane.points, beat, isDiscrete(def))
    if (normalized !== undefined) return automationValue(def, normalized)
  }
  return staticValue(track, target)
}

/** A copy of the track whose static values are the automated values at a beat (UI follow, offline helpers).
 * Returns the same object when nothing is automated. */
export function trackAt(track: Track, beat: number): Track {
  if (!track.automation?.length) return track
  let next = track
  for (const lane of track.automation) {
    if (!isActiveLane(track, lane)) continue
    const def = targetDef(track, lane.target)!
    const normalized = evaluateLane(lane.points, beat, isDiscrete(def))!
    next = withStaticValue(next, lane.target, automationValue(def, normalized))
  }
  return next
}

export const hasActiveAutomation = (project: Project): boolean => project.tracks.some(track => track.automation?.some(lane => isActiveLane(track, lane)))

/** Normalizes a value in a target's units (core/devices.ts toNormalized). */
export function normalizeValue(track: Track, target: AutomationTarget, value: number): number | null {
  const def = targetDef(track, target)
  return def ? toNormalized(def, value) : null
}
/** A normalized lane value in the target's units, unrounded (the engines use this; native mirrors it). */
export function automationValue(def: ParamDef, normalized: number): number {
  const n = clamp01(normalized)
  if (def.options) return def.options[Math.round(n * (def.options.length - 1))].value
  return def.scale === 'log' ? def.min * Math.pow(def.max / def.min, n) : def.min + n * (def.max - def.min)
}
export function denormalizeValue(track: Track, target: AutomationTarget, normalized: number): number | null {
  const def = targetDef(track, target)
  return def ? fromNormalized(def, normalized) : null
}

/** Ramer–Douglas–Peucker on value error (normalized units) at each sample's beat. Keeps the first and last sample. */
export function thinPoints(samples: readonly AutomationPoint[], tolerance = 0.004): AutomationPoint[] {
  if (samples.length <= 2) return samples.map(point => ({ ...point }))
  const keep = new Uint8Array(samples.length)
  keep[0] = 1; keep[samples.length - 1] = 1
  const stack: [number, number][] = [[0, samples.length - 1]]
  while (stack.length) {
    const [first, last] = stack.pop()!
    const a = samples[first], b = samples[last]
    let worst = -1, error = tolerance
    for (let i = first + 1; i < last; i++) {
      const span = b.beat - a.beat
      const expected = span > 1e-12 ? a.value + (b.value - a.value) * (samples[i].beat - a.beat) / span : a.value
      const distance = Math.abs(samples[i].value - expected)
      if (distance > error) { error = distance; worst = i }
    }
    if (worst > 0) { keep[worst] = 1; stack.push([first, worst], [worst, last]) }
  }
  return samples.filter((_, i) => keep[i]).map(point => ({ beat: point.beat, value: point.value }))
}

const roundBeat = (beat: number) => Math.round(beat * 1e6) / 1e6
export function sortPoints(points: readonly AutomationPoint[]): AutomationPoint[] {
  return points.map((point, index) => ({ point, index })).sort((a, b) => a.point.beat - b.point.beat || a.index - b.index).map(item => item.point)
}

/** Replaces the points inside [start, end] with `inserted` (already within the range). */
export function replaceRange(points: readonly AutomationPoint[], start: number, end: number, inserted: readonly AutomationPoint[]): AutomationPoint[] {
  return sortPoints([...points.filter(point => point.beat < start - 1e-9 || point.beat > end + 1e-9), ...inserted.map(point => ({ ...point, beat: roundBeat(point.beat) }))])
}

export const newLaneId = (): string => typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `lane-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

/** Edits one lane (created for the target when absent) and drops lanes left without points only when asked. */
export function updateLane(track: Track, target: AutomationTarget, edit: (lane: AutomationLane) => AutomationLane): Track {
  const key = targetKey(target)
  const lanes = track.automation ?? []
  const index = lanes.findIndex(lane => targetKey(lane.target) === key)
  const current = index >= 0 ? lanes[index] : { id: newLaneId(), target, points: [] }
  const next = edit(current)
  if (next === current && index >= 0) return track
  const automation = index >= 0 ? lanes.map((lane, i) => i === index ? next : lane) : [...lanes, next]
  return { ...track, automation }
}

export function removeLane(track: Track, laneId: string): Track {
  if (!track.automation?.some(lane => lane.id === laneId)) return track
  const automation = track.automation.filter(lane => lane.id !== laneId)
  if (automation.length) return { ...track, automation }
  const { automation: _removed, ...rest } = track
  return rest
}

/** Drops lanes whose device, instrument parameter or plug-in instrument is gone (device delete, instrument
 * change). Moving a device keeps its lanes because they address it by id. */
export function pruneAutomation(track: Track): Track {
  if (!track.automation?.length) return track
  const automation = track.automation.filter(lane => targetDef(track, lane.target) !== null)
  if (automation.length === track.automation.length) return track
  if (automation.length) return { ...track, automation }
  const { automation: _removed, ...rest } = track
  return rest
}
export function pruneProjectAutomation(project: Project): Project {
  let changed = false
  const tracks = project.tracks.map(track => { const next = pruneAutomation(track); changed ||= next !== track; return next })
  return changed ? { ...project, tracks } : project
}

/** Lanes copied for a duplicated track: device lanes follow the copies (same position in the chain). */
export function copyAutomation(source: Track, copy: Track): AutomationLane[] | undefined {
  if (!source.automation?.length) return undefined
  const ids = new Map(source.devices.map((device, index) => [device.id, copy.devices[index]?.id]))
  const lanes = source.automation.flatMap((lane): AutomationLane[] => {
    let target = lane.target
    if (target.kind === 'device') {
      const deviceId = ids.get(target.deviceId)
      if (!deviceId) return []
      target = { ...target, deviceId }
    } else target = { ...target }
    return [{ id: newLaneId(), target, points: lane.points.map(point => ({ ...point })), ...(lane.enabled === false ? { enabled: false } : {}) }]
  })
  return lanes.length ? lanes : undefined
}

export interface TargetOption { target: AutomationTarget; key: string; label: string }
export interface TargetGroup { label: string; options: TargetOption[] }

/** Picker groups: 트랙, each 시김새 device, 악기. VST3 parameters appear once named (known) or already used. */
export function targetGroups(track: Track, pluginNames: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map()): TargetGroup[] {
  const option = (target: AutomationTarget, label: string): TargetOption => ({ target, key: targetKey(target), label })
  const used = (predicate: (target: AutomationTarget) => string | null) => (track.automation ?? []).map(lane => predicate(lane.target)).filter((id): id is string => id !== null)
  const groups: TargetGroup[] = [{ label: '트랙', options: (['volume', 'pan', 'mute'] as const).map(param => option({ kind: 'track', param }, TRACK_PARAM_DEFS[param].label)) }]
  track.devices.forEach((device, index) => {
    const name = device.type === 'vst3' ? device.name : device.name ?? EFFECT_DEFS[device.type].name
    let options: TargetOption[]
    if (device.type === 'vst3') {
      const names = pluginNames.get(device.id) ?? new Map<string, string>()
      const ids = new Set([...names.keys(), ...Object.keys(device.parameters), ...used(target => target.kind === 'device' && target.deviceId === device.id ? target.param : null)])
      options = [...ids].filter(id => /^\d+$/.test(id)).sort((a, b) => Number(a) - Number(b)).map(id => option({ kind: 'device', deviceId: device.id, param: id }, names.get(id) ?? `파라미터 ${id}`))
    } else options = effectDeviceDefs(device).map(def => option({ kind: 'device', deviceId: device.id, param: def.id }, def.label))
    if (options.length) groups.push({ label: `${index + 1}. ${name}`, options })
  })
  const instrument = instrumentParamDefs(track).map(def => option({ kind: 'instrument', param: def.id }, def.label))
  if (track.pluginInstrument) {
    const names = pluginNames.get(track.pluginInstrument.id) ?? new Map<string, string>()
    const ids = new Set([...names.keys(), ...Object.keys(track.pluginInstrument.parameters), ...used(target => target.kind === 'plugin-instrument' ? target.param : null)])
    instrument.push(...[...ids].filter(id => /^\d+$/.test(id)).sort((a, b) => Number(a) - Number(b)).map(id => option({ kind: 'plugin-instrument', param: id }, names.get(id) ?? `파라미터 ${id}`)))
  }
  if (instrument.length) groups.push({ label: '악기', options: instrument })
  return groups
}

export function targetLabel(track: Track, target: AutomationTarget): string {
  for (const group of targetGroups(track)) {
    const found = group.options.find(item => item.key === targetKey(target))
    if (found) return group.label === '트랙' ? found.label : `${group.label.replace(/^\d+\.\s*/, '')} · ${found.label}`
  }
  return targetKey(target)
}


/** Every automatable target whose static value differs between two versions of a track (a control was moved). */
export function changedTargets(previous: Track, next: Track): AutomationTarget[] {
  if (previous === next) return []
  const changed: AutomationTarget[] = []
  for (const param of ['volume', 'pan', 'mute'] as const) if (staticValue(previous, { kind: 'track', param }) !== staticValue(next, { kind: 'track', param })) changed.push({ kind: 'track', param })
  if (previous.devices !== next.devices) for (const device of next.devices) {
    const before = previous.devices.find(item => item.id === device.id)
    if (!before || before === device || before.type !== device.type) continue
    const ids = device.type === 'vst3' ? Object.keys(device.parameters) : effectDeviceDefs(device).map(def => def.id)
    for (const param of ids) {
      const target: AutomationTarget = { kind: 'device', deviceId: device.id, param }
      if (staticValue(previous, target) !== staticValue(next, target)) changed.push(target)
    }
  }
  if (previous.instrumentParams !== next.instrumentParams && previous.instrument === next.instrument) for (const def of instrumentParamDefs(next)) {
    const target: AutomationTarget = { kind: 'instrument', param: def.id }
    if (staticValue(previous, target) !== staticValue(next, target)) changed.push(target)
  }
  if (previous.pluginInstrument && next.pluginInstrument && previous.pluginInstrument.id === next.pluginInstrument.id && previous.pluginInstrument.parameters !== next.pluginInstrument.parameters) {
    for (const param of Object.keys(next.pluginInstrument.parameters)) {
      const target: AutomationTarget = { kind: 'plugin-instrument', param }
      if (/^\d+$/.test(param) && staticValue(previous, target) !== staticValue(next, target)) changed.push(target)
    }
  }
  return changed
}

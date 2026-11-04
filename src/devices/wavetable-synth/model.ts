import { WAVE_LIMITS, WAVE_PARAMETER_SCHEMA, WAVE_MODULATION_SOURCES, WAVE_FACTORY_BANKS } from './schema.generated'
import type { WavetableParamId, WavetableModSource } from './schema.generated'

export type { WavetableParamId, WavetableModSource } from './schema.generated'
export type WavetableParams = Record<WavetableParamId, number>

export interface WavetableCustomBank {
  /** Stable user slots 4..7; factory slots 0..3 are never saved in projects. */
  slot: number
  name: string
  frames: number[][]
}

export interface WavetableModRoute {
  id: string
  enabled: boolean
  source: WavetableModSource
  destination: WavetableParamId
  amount: number
  bipolar: boolean
  aux: WavetableModSource | null
  /** sign(x) * abs(x) ** (2 ** (curve * 2)); applied before aux/amount. */
  curve: number
}

/** Serializable structural state. Scalars are stored once in Track.instrumentParams. */
export interface WavetableState {
  version: 1
  customBanks: WavetableCustomBank[]
  /** Four cyclic, linearly interpolated curves; exactly 128 normalized values each. */
  lfoCurves: number[][]
  routes: WavetableModRoute[]
  metadata: { name: string; author: string; description: string }
}

/** Editor and control-channel view assembled from the project's two stored fields. */
export interface WavetablePatch extends WavetableState {
  params: WavetableParams
}

type ParameterDefinition = {
  id: WavetableParamId; min: number; max: number; default: number
  integer?: boolean; options?: readonly { value: number }[]; modulate?: boolean
}
const definitions: readonly ParameterDefinition[] = WAVE_PARAMETER_SCHEMA
const parameterIds = new Set<string>(definitions.map(p => p.id))
const modulationSources = new Set<string>(WAVE_MODULATION_SOURCES.map(s => s.id))
const modulationDestinations = new Set<string>(definitions.filter(p => p.modulate).map(p => p.id))
const stateKeys = ['version', 'customBanks', 'lfoCurves', 'routes', 'metadata'] as const
const patchKeys = [...stateKeys, 'params'] as const

export class WavetableValidationError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`이음 웨이브 ${path}: ${detail}`)
    this.name = 'WavetableValidationError'
  }
}

function fail(path: string, detail: string): never { throw new WavetableValidationError(path, detail) }

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, '객체가 필요합니다.')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail(path, '일반 객체가 필요합니다.')
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, '지원하지 않는 필드입니다.')
}

function finite(value: unknown, min: number, max: number, path: string, clamp = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, '유한한 숫자가 필요합니다.')
  if (!clamp && (value < min || value > max)) fail(path, `${min}–${max} 범위를 벗어났습니다.`)
  return Math.min(max, Math.max(min, value))
}

function text(value: unknown, fallback: string, max: number, path: string): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length > max) fail(path, `${max}자 이내의 문자열이 필요합니다.`)
  return value
}

function boolean(value: unknown, fallback: boolean, path: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') fail(path, '참 또는 거짓 값이 필요합니다.')
  return value
}

function array(value: unknown, max: number, path: string, exact = false): unknown[] {
  if (!Array.isArray(value) || (exact ? value.length !== max : value.length > max)) {
    fail(path, exact ? `정확히 ${max}개의 값이 필요합니다.` : `최대 ${max}개까지 저장할 수 있습니다.`)
  }
  return value
}

export function createDefaultWavetableParams(): WavetableParams {
  return Object.fromEntries(definitions.map(p => [p.id, p.default])) as WavetableParams
}

export function createDefaultWavetableState(): WavetableState {
  return {
    version: 1,
    customBanks: [],
    lfoCurves: Array.from({ length: WAVE_LIMITS.lfos }, (_, lfo) =>
      Array.from({ length: WAVE_LIMITS.lfoPoints }, (_, point) => {
        const phase = point / WAVE_LIMITS.lfoPoints
        if (lfo === 0) return (1 - Math.cos(phase * Math.PI * 2)) / 2
        if (lfo === 1) return 1 - Math.abs(2 * phase - 1)
        return lfo === 2 ? phase : 1 - phase
      })),
    routes: [],
    metadata: { name: 'Init Wave', author: '가락이음', description: '' },
  }
}

export function createDefaultWavetablePatch(): WavetablePatch {
  return { ...createDefaultWavetableState(), params: createDefaultWavetableParams() }
}

/** Missing known scalars use their version-one defaults; unknown IDs never disappear silently. */
export function parseWavetableParams(value: unknown, clamp = false): WavetableParams {
  const input = value === undefined ? {} : object(value, 'params')
  for (const key of Object.keys(input)) if (!parameterIds.has(key)) fail(`params.${key}`, '알 수 없는 파라미터입니다.')
  const result = createDefaultWavetableParams()
  for (const definition of definitions) {
    if (!Object.hasOwn(input, definition.id)) continue
    let numeric = finite(input[definition.id], definition.min, definition.max, `params.${definition.id}`, clamp)
    if (definition.options && !definition.options.some(option => option.value === numeric)) {
      if (!clamp) fail(`params.${definition.id}`, '지원하지 않는 선택 값입니다.')
      numeric = definition.options.reduce((nearest, option) => Math.abs(option.value - numeric) < Math.abs(nearest.value - numeric) ? option : nearest).value
    }
    if (definition.integer && !Number.isInteger(numeric)) {
      if (!clamp) fail(`params.${definition.id}`, '정수가 필요합니다.')
      numeric = Math.round(numeric)
    }
    result[definition.id] = numeric
  }
  return result
}

function parseBank(value: unknown, index: number): WavetableCustomBank {
  const path = `customBanks[${index}]`
  const input = object(value, path)
  keys(input, ['slot', 'name', 'frames'], path)
  const slot = finite(input.slot, WAVE_LIMITS.factoryBanks, WAVE_LIMITS.factoryBanks + WAVE_LIMITS.customBanks - 1, `${path}.slot`)
  if (!Number.isInteger(slot)) fail(`${path}.slot`, '정수 슬롯이 필요합니다.')
  const sourceFrames = array(input.frames, WAVE_LIMITS.framesPerBank, `${path}.frames`)
  if (!sourceFrames.length) fail(`${path}.frames`, '최소 한 프레임이 필요합니다.')
  const frames = Array.from({ length: sourceFrames.length }, (_, frame) => {
    const samples = array(sourceFrames[frame], WAVE_LIMITS.frameSize, `${path}.frames[${frame}]`, true)
    return Array.from({ length: samples.length }, (_, sample) => finite(samples[sample], -1, 1, `${path}.frames[${frame}][${sample}]`))
  })
  return { slot, name: text(input.name, `User ${slot - WAVE_LIMITS.factoryBanks + 1}`, 64, `${path}.name`), frames }
}

function source(value: unknown, path: string): WavetableModSource {
  if (typeof value !== 'string' || !modulationSources.has(value)) fail(path, '알 수 없는 변조 소스입니다.')
  return value as WavetableModSource
}

function parseRoute(value: unknown, index: number): WavetableModRoute {
  const path = `routes[${index}]`
  const input = object(value, path)
  keys(input, ['id', 'enabled', 'source', 'destination', 'amount', 'bipolar', 'aux', 'curve'], path)
  const id = text(input.id, `route-${index + 1}`, 64, `${path}.id`)
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) fail(`${path}.id`, '영문·숫자·하이픈·밑줄로 된 ID가 필요합니다.')
  if (typeof input.destination !== 'string' || !modulationDestinations.has(input.destination)) fail(`${path}.destination`, '지원하지 않는 변조 대상입니다.')
  return {
    id,
    enabled: boolean(input.enabled, true, `${path}.enabled`),
    source: source(input.source, `${path}.source`),
    destination: input.destination as WavetableParamId,
    amount: finite(input.amount, -1, 1, `${path}.amount`),
    bipolar: boolean(input.bipolar, false, `${path}.bipolar`),
    aux: input.aux === null || input.aux === undefined ? null : source(input.aux, `${path}.aux`),
    curve: finite(input.curve === undefined ? 0 : input.curve, -1, 1, `${path}.curve`),
  }
}

/** Structural validation also deep-copies all editable arrays and metadata. */
export function parseWavetableState(value: unknown): WavetableState {
  const input = object(value, 'state')
  keys(input, stateKeys, 'state')
  if (input.version !== 1) fail('version', '지원하는 패치 버전은 1입니다.')
  const defaults = createDefaultWavetableState()
  const banks = array(input.customBanks === undefined ? [] : input.customBanks, WAVE_LIMITS.customBanks, 'customBanks')
  const customBanks = Array.from({ length: banks.length }, (_, index) => parseBank(banks[index], index))
  if (new Set(customBanks.map(bank => bank.slot)).size !== customBanks.length) fail('customBanks', '중복된 사용자 슬롯입니다.')
  const curveInputs = array(input.lfoCurves === undefined ? defaults.lfoCurves : input.lfoCurves, WAVE_LIMITS.lfos, 'lfoCurves', true)
  const lfoCurves = Array.from({ length: WAVE_LIMITS.lfos }, (_, lfo) => {
    const curve = array(curveInputs[lfo], WAVE_LIMITS.lfoPoints, `lfoCurves[${lfo}]`, true)
    return Array.from({ length: curve.length }, (_, point) => finite(curve[point], 0, 1, `lfoCurves[${lfo}][${point}]`))
  })
  const routeInputs = array(input.routes === undefined ? [] : input.routes, WAVE_LIMITS.routes, 'routes')
  const routes = Array.from({ length: routeInputs.length }, (_, index) => parseRoute(routeInputs[index], index))
  if (new Set(routes.map(route => route.id)).size !== routes.length) fail('routes', '중복된 변조 경로 ID입니다.')
  const meta = input.metadata === undefined ? {} : object(input.metadata, 'metadata')
  keys(meta, ['name', 'author', 'description'], 'metadata')
  return {
    version: 1, customBanks, lfoCurves, routes,
    metadata: {
      name: text(meta.name, defaults.metadata.name, 64, 'metadata.name'),
      author: text(meta.author, defaults.metadata.author, 64, 'metadata.author'),
      description: text(meta.description, '', 512, 'metadata.description'),
    },
  }
}

function validateReferences(patch: WavetablePatch): WavetablePatch {
  for (let oscillator = 1; oscillator <= WAVE_LIMITS.oscillators; oscillator++) {
    const key = `osc${oscillator}Bank` as WavetableParamId
    const slot = patch.params[key]
    if (slot >= WAVE_LIMITS.factoryBanks && !patch.customBanks.some(bank => bank.slot === slot)) {
      fail(`params.${key}`, `사용자 뱅크 ${slot - WAVE_LIMITS.factoryBanks + 1}의 데이터가 없습니다.`)
    }
  }
  return patch
}

export function combineWavetablePatch(params: unknown, state?: unknown): WavetablePatch {
  return validateReferences({
    ...parseWavetableState(state === undefined ? createDefaultWavetableState() : state),
    params: parseWavetableParams(params),
  })
}

function parsePatch(value: unknown, clamp: boolean): WavetablePatch {
  const input = object(value, 'patch')
  keys(input, patchKeys, 'patch')
  const state = Object.fromEntries(stateKeys.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]))
  return validateReferences({ ...parseWavetableState(state), params: parseWavetableParams(input.params, clamp) })
}

export function parseWavetablePatch(value: unknown): WavetablePatch { return parsePatch(value, false) }

/** Explicit editor repair: clamp finite scalar values only; corrupt structural data still fails. */
export function sanitizeWavetablePatch(value: unknown): WavetablePatch { return parsePatch(value, true) }

export function cloneWavetablePatch(patch: WavetablePatch): WavetablePatch { return parseWavetablePatch(patch) }
export function cloneWavetableState(state: WavetableState): WavetableState { return parseWavetableState(state) }

export function splitWavetablePatch(patch: WavetablePatch): { params: WavetableParams; state: WavetableState } {
  const { params, ...state } = parseWavetablePatch(patch)
  return { params, state }
}

export function parseWavetablePatchJson(json: string): WavetablePatch {
  if (typeof json !== 'string' || json.length > WAVE_LIMITS.maxTextBytes || new TextEncoder().encode(json).byteLength > WAVE_LIMITS.maxTextBytes) {
    fail('JSON', '패치 파일은 4 MiB 이하여야 합니다.')
  }
  let value: unknown
  try { value = JSON.parse(json) } catch { fail('JSON', '올바른 JSON 파일이 아닙니다.') }
  return parseWavetablePatch(value)
}

export function serializeWavetablePatch(patch: WavetablePatch): string {
  const json = JSON.stringify(parseWavetablePatch(patch))
  if (new TextEncoder().encode(json).byteLength > WAVE_LIMITS.maxTextBytes) fail('JSON', '패치 파일은 4 MiB 이하여야 합니다.')
  return json
}

const factoryCache = new Map<number, number[][]>()

/** Original factory spectra, DC-corrected and normalized once per bank, matching native preparation. */
export function getFactoryWavetableFrames(bankIndex: number): number[][] {
  if (!Number.isInteger(bankIndex) || bankIndex < 0 || bankIndex >= WAVE_LIMITS.factoryBanks) fail('factoryBank', '알 수 없는 공장 뱅크입니다.')
  let frames = factoryCache.get(bankIndex)
  if (!frames) {
    const bank = WAVE_FACTORY_BANKS[bankIndex]
    let peak = 0
    frames = bank.harmonics.map(harmonics => {
      const frame = Array.from({ length: WAVE_LIMITS.frameSize }, (_, point) => {
        const phase = point / WAVE_LIMITS.frameSize * Math.PI * 2
        return harmonics.reduce((sum: number, amplitude, index) => sum + amplitude * Math.sin(phase * (index + 1)), 0)
      })
      const dc = frame.reduce((sum, value) => sum + value, 0) / frame.length
      for (let point = 0; point < frame.length; point++) {
        frame[point] -= dc
        peak = Math.max(peak, Math.abs(frame[point]))
      }
      return frame
    })
    if (peak > 0) for (const frame of frames) for (let point = 0; point < frame.length; point++) frame[point] /= peak
    factoryCache.set(bankIndex, frames)
  }
  return frames.map(frame => [...frame])
}

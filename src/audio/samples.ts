import type { SampleAttribution, SampleStatus } from '../core/types'

export interface SampleZone {
  file: string
  root: number
  lo: number
  hi: number
  vlo: number
  vhi: number
  gainDb?: number
  tune?: number
  loop?: [number, number]
  choke?: number
}

export interface SampleSet {
  id: string
  kind: 'pitched' | 'kit'
  formats: string[]
  gainDb: number
  release: number
  zones: SampleZone[]
  releaseZones: SampleZone[]
  attribution: SampleAttribution
}

export interface LoadedSet {
  set: SampleSet
  buffers: Map<string, AudioBuffer>
  format: string
  /** Seconds skipped at the start of every file (AAC encoder delay for m4a). */
  startOffset: number
}

/** Format preference order and the MIME types probed with canPlayType. */
const MIME: Record<string, string> = { webm: 'audio/webm; codecs="opus"', m4a: 'audio/mp4; codecs="mp4a.40.2"' }
const START_OFFSET: Record<string, number> = { m4a: 0.044 }
const MAX_CONCURRENT = 6

const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback
const asRecord = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}

function parseZone(input: unknown, kind: SampleSet['kind']): SampleZone | null {
  const raw = asRecord(input)
  if (typeof raw.file !== 'string' || !/^[\w.-]+$/.test(raw.file) || typeof raw.root !== 'number') return null
  const root = Math.round(raw.root)
  const zone: SampleZone = {
    file: raw.file, root,
    lo: kind === 'kit' ? root : Math.round(finite(raw.lo, root)),
    hi: kind === 'kit' ? root : Math.round(finite(raw.hi, root)),
    vlo: finite(raw.vlo, 0), vhi: finite(raw.vhi, 1),
  }
  if (typeof raw.gainDb === 'number') zone.gainDb = finite(raw.gainDb, 0)
  if (typeof raw.tune === 'number') zone.tune = finite(raw.tune, 0)
  if (Array.isArray(raw.loop) && raw.loop.length === 2 && finite(raw.loop[1], 0) > finite(raw.loop[0], -1) && finite(raw.loop[0], -1) >= 0) zone.loop = [raw.loop[0], raw.loop[1]]
  if (typeof raw.choke === 'number') zone.choke = raw.choke
  return zone
}

export function parseManifest(input: unknown, id: string): SampleSet {
  const raw = asRecord(input)
  const kind = raw.kind === 'kit' ? 'kit' : 'pitched'
  const formats = Array.isArray(raw.formats) ? raw.formats.filter((f): f is string => typeof f === 'string' && Object.hasOwn(MIME, f)) : []
  if (!formats.length) throw new Error(`Sample set "${id}" lists no supported formats.`)
  const zones = Array.isArray(raw.zones) ? raw.zones.map(zone => parseZone(zone, kind)).filter((zone): zone is SampleZone => zone !== null) : []
  if (!zones.length) throw new Error(`Sample set "${id}" has no zones.`)
  const releaseZones = Array.isArray(raw.releaseZones) ? raw.releaseZones.map(zone => parseZone(zone, kind)).filter((zone): zone is SampleZone => zone !== null) : []
  const credit = asRecord(raw.attribution)
  const attribution: SampleAttribution = {
    title: typeof credit.title === 'string' ? credit.title : id,
    author: typeof credit.author === 'string' ? credit.author : '',
    license: typeof credit.license === 'string' ? credit.license : '',
  }
  for (const key of ['url', 'licenseUrl', 'changes'] as const) if (typeof credit[key] === 'string') attribution[key] = credit[key]
  return { id, kind, formats, gainDb: finite(raw.gainDb, 0), release: Math.max(0.01, finite(raw.release, 0.25)), zones, releaseZones, attribution }
}

/**
 * Key range first, then the velocity layer. Layers are half-open [vlo, vhi)
 * except the loudest, which also takes velocity == vhi. Overlapping key ranges
 * prefer the zone whose root is nearest.
 */
export function pickZone(set: Pick<SampleSet, 'kind' | 'zones'>, pitch: number, velocity: number, zones: readonly SampleZone[] = set.zones): SampleZone | undefined {
  const key = Math.round(pitch)
  const candidates = zones.filter(zone => set.kind === 'kit' ? zone.root === key : key >= zone.lo && key <= zone.hi)
  if (!candidates.length) return undefined
  const top = Math.max(...candidates.map(zone => zone.vhi))
  const inLayer = candidates.filter(zone => velocity >= zone.vlo && (velocity < zone.vhi || (zone.vhi === top && velocity <= zone.vhi)))
  const pool = inLayer.length ? inLayer : candidates
  const distance = (zone: SampleZone): number => inLayer.length ? 0 : Math.max(zone.vlo - velocity, velocity - zone.vhi, 0)
  return pool.reduce((best, zone) => {
    const better = distance(zone) < distance(best) || (distance(zone) === distance(best) && Math.abs(zone.root - key) < Math.abs(best.root - key))
    return better ? zone : best
  })
}

export function chooseFormat(formats: readonly string[]): string {
  const probe = typeof Audio === 'function' ? new Audio() : null
  const supported = (format: string): boolean => !probe || probe.canPlayType(MIME[format] ?? '') !== ''
  return formats.find(format => format === 'webm' && supported(format)) ?? formats.find(supported) ?? formats[0]
}

async function forEachLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let index = 0
  const worker = async (): Promise<void> => {
    while (index < items.length) await task(items[index++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

type Listener = (setId: string, status: SampleStatus) => void

/**
 * One per engine. AudioBuffers are not tied to a context, so a set decoded for
 * realtime playback is reused as-is by OfflineAudioContext exports and by
 * every rebuilt graph.
 */
export class SampleLibrary {
  private loads = new Map<string, Promise<LoadedSet>>()
  private ready = new Map<string, LoadedSet>()
  private statuses = new Map<string, SampleStatus>()
  private errors = new Map<string, string>()
  private listeners = new Set<Listener>()
  readonly baseUrl: string

  constructor(baseUrl = import.meta.env.BASE_URL) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  }

  get(setId: string): LoadedSet | undefined { return this.ready.get(setId) }
  status(setId: string): SampleStatus { return this.statuses.get(setId) ?? 'idle' }
  error(setId: string): string | undefined { return this.errors.get(setId) }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Concurrent callers share one in-flight load; a failed set may be retried. */
  load(setId: string, context: BaseAudioContext): Promise<LoadedSet> {
    const pending = this.loads.get(setId)
    if (pending) return pending
    const promise = this.fetchSet(setId, context)
    this.loads.set(setId, promise)
    this.setStatus(setId, 'loading')
    promise.then(loaded => {
      this.ready.set(setId, loaded)
      this.errors.delete(setId)
      this.setStatus(setId, 'ready')
    }, (error: unknown) => {
      this.loads.delete(setId)
      this.errors.set(setId, error instanceof Error ? error.message : String(error))
      this.setStatus(setId, 'error')
    })
    return promise
  }

  private setStatus(setId: string, status: SampleStatus): void {
    this.statuses.set(setId, status)
    for (const listener of this.listeners) listener(setId, status)
  }

  private async fetchSet(setId: string, context: BaseAudioContext): Promise<LoadedSet> {
    if (!/^[\w-]+$/.test(setId)) throw new Error(`Invalid sample set id "${setId}".`)
    const folder = `${this.baseUrl}samples/${setId}/`
    const response = await fetch(`${folder}manifest.json`)
    if (!response.ok) throw new Error(`샘플 세트 "${setId}"를 찾을 수 없습니다 (${response.status}).`)
    const set = parseManifest(await response.json(), setId)
    const format = chooseFormat(set.formats)
    const files = [...new Set([...set.zones, ...set.releaseZones].map(zone => zone.file))]
    const buffers = new Map<string, AudioBuffer>()
    await forEachLimited(files, MAX_CONCURRENT, async file => {
      const audio = await fetch(`${folder}${file}.${format}`)
      if (!audio.ok) throw new Error(`샘플 "${file}.${format}"을 받지 못했습니다 (${audio.status}).`)
      buffers.set(file, await context.decodeAudioData(await audio.arrayBuffer()))
    })
    return { set, buffers, format, startOffset: START_OFFSET[format] ?? 0 }
  }
}

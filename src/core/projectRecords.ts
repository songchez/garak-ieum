import type { Clip, Project, Track } from './types'

/**
 * Incremental local storage layout (IndexedDB `project-records`). A project is stored as a small Merkle tree of
 * content-addressed records instead of one whole-project bundle:
 *
 *   manifest (project-bundles[id])  ->  meta record (Project without tracks)
 *                                   ->  track records (Track without clips + ordered clip refs)  ->  clip records
 *                                   ->  asset records ({ id, name, blob })
 *
 * Every record key is [projectId, kind, entityId, contentHash]. A changed clip gets a new key, so its track record and
 * the manifest change too, but nothing else is written: a single note edit writes one clip, one track and the manifest.
 * Records are never overwritten in place, so the manifest put is the commit point: until it lands, the previous
 * manifest still references a complete set of records. Unreachable records are garbage-collected in the same
 * transaction. This is storage only: the Project format (schema 17) and .garak bundles are unchanged.
 */
export const RECORD_FORMAT = 'records-1'

export type RecordKind = 'meta' | 'track' | 'clip' | 'asset'
/** [kind, entity id, content hash] */
export type RecordRef = [RecordKind, string, string]
/** [entity id, content hash] */
export type EntityRef = [string, string]
export type RecordKey = [string, RecordKind, string, string]

export interface TrackRecord { track: Omit<Track, 'clips'>; clips: EntityRef[] }

export interface ProjectManifest {
  id: string
  format: typeof RECORD_FORMAT
  generation: number
  meta: string
  tracks: EntityRef[]
  assets: EntityRef[]
  /**
   * Every record the manifest reaches (meta, tracks, clips, assets). Only the last-validated recovery manifest stores
   * it, so GC can keep that copy's records without reading its track records; the main manifest stays small.
   */
  reachable?: RecordRef[]
}

export interface PlannedRecord { key: RecordKey; value: unknown }

export interface ProjectPlan {
  meta: string
  tracks: EntityRef[]
  /** Every reachable project record (not assets) with its value, by keyString. */
  records: Map<string, PlannedRecord>
}

export interface AssetInput { id: string; name: string; blob: Blob }

export const recordKey = (projectId: string, [kind, id, hash]: RecordRef): RecordKey => [projectId, kind, id, hash]
export const keyString = (key: readonly unknown[]): string => key.join('\u0000')
/** All records of one project: arrays sort after strings, so [id, []] bounds every [id, kind, ...] key. */
export const projectKeyRange = (projectId: string): IDBKeyRange => IDBKeyRange.bound([projectId], [projectId, []])

/** cyrb53 (public domain) over a string, plus its length: 53-bit hash, used only to detect changed records. */
export function hashString(text: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}.${text.length.toString(36)}`
}

/**
 * JSON with object keys sorted, so the hash names content, not key order: a validated copy (validateProject builds
 * fresh objects in its own key order) or a command-created object hashes like the stored record it equals.
 * Like JSON, undefined object members are dropped.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) {
    let out = '['
    for (let i = 0; i < value.length; i++) out += (i ? ',' : '') + canonicalJson(value[i])
    return `${out}]`
  }
  const record = value as Record<string, unknown>
  let out = '{', first = true
  for (const key of Object.keys(record).sort()) {
    const item = record[key]
    if (item === undefined || typeof item === 'function') continue
    out += `${first ? '' : ','}${JSON.stringify(key)}:${canonicalJson(item)}`
    first = false
  }
  return `${out}}`
}

// Snapshots are immutable (ProjectSession edits copy only the changed path), so an unchanged object keeps its hash.
// A new object with identical content (load, undo across a validation, a full validation copy) re-hashes to the same key.
const clipHashes = new WeakMap<Clip, string>()
interface TrackEntry { hash: string; record: TrackRecord }
const trackEntries = new WeakMap<Track, TrackEntry>()
interface MetaEntry { hash: string; meta: Omit<Project, 'tracks'> }
const metaEntries = new WeakMap<Project, MetaEntry>()

function clipHash(clip: Clip): string {
  let hash = clipHashes.get(clip)
  if (hash === undefined) { hash = hashString(canonicalJson(clip)); clipHashes.set(clip, hash) }
  return hash
}

function trackEntry(track: Track): TrackEntry {
  let entry = trackEntries.get(track)
  if (!entry) {
    const { clips, ...shell } = track
    const refs = clips.map((clip): EntityRef => [clip.id, clipHash(clip)])
    entry = { hash: hashString(`${canonicalJson(shell)}\u0001${JSON.stringify(refs)}`), record: { track: shell, clips: refs } }
    trackEntries.set(track, entry)
  }
  return entry
}

function metaEntry(project: Project): MetaEntry {
  let entry = metaEntries.get(project)
  if (!entry) {
    const { tracks: _tracks, ...meta } = project
    entry = { hash: hashString(canonicalJson(meta)), meta }
    metaEntries.set(project, entry)
  }
  return entry
}

/** Splits a snapshot into its records. O(tracks + clips) WeakMap lookups when only a few objects changed. */
export function planProject(project: Project): ProjectPlan {
  const records = new Map<string, PlannedRecord>()
  const add = (ref: RecordRef, value: unknown) => {
    const key = recordKey(project.id, ref)
    records.set(keyString(key), { key, value })
  }
  const meta = metaEntry(project)
  add(['meta', project.id, meta.hash], meta.meta)
  const tracks = project.tracks.map((track): EntityRef => {
    const entry = trackEntry(track)
    add(['track', track.id, entry.hash], entry.record)
    track.clips.forEach((clip, index) => add(['clip', clip.id, entry.record.clips[index][1]], clip))
    return [track.id, entry.hash]
  })
  return { meta: meta.hash, tracks, records }
}

// Original audio is immutable per Blob; hash its bytes once per Blob object (SHA-256 off the main thread).
const blobHashes = new WeakMap<Blob, Promise<string>>()

function blobHash(blob: Blob): Promise<string> {
  let hash = blobHashes.get(blob)
  if (!hash) {
    const subtle = globalThis.crypto?.subtle
    // Insecure origins have no SubtleCrypto: a per-Blob random version still writes each Blob at most once per session.
    hash = subtle
      ? blob.arrayBuffer().then(bytes => subtle.digest('SHA-256', bytes)).then(digest => Array.from(new Uint8Array(digest).subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join(''))
      : Promise.resolve(`v${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`)
    hash = hash.catch(error => { blobHashes.delete(blob); throw error })
    blobHashes.set(blob, hash)
  }
  return hash
}

/** Asset refs in input order; `values` is keyed by keyString([id, hash]). */
export async function planAssets(assets: readonly AssetInput[]): Promise<{ refs: EntityRef[]; values: Map<string, AssetInput> }> {
  const hashes = await Promise.all(assets.map(asset => blobHash(asset.blob)))
  const refs: EntityRef[] = [], values = new Map<string, AssetInput>()
  assets.forEach((asset, index) => {
    const hash = `${hashes[index]}.${hashString(`${asset.name}\u0000${asset.blob.type}\u0000${asset.blob.size}`)}`
    refs.push([asset.id, hash])
    values.set(keyString([asset.id, hash]), asset)
  })
  return { refs, values }
}

/** Every record a manifest reaches; track records come from `getTrack` (the plan or the stored records). */
export function reachableRefs(manifest: Pick<ProjectManifest, 'meta' | 'tracks' | 'assets' | 'id'>, projectId: string, getTrack: (ref: EntityRef) => TrackRecord | undefined): RecordRef[] {
  const refs: RecordRef[] = [['meta', projectId, manifest.meta]]
  for (const ref of manifest.tracks) {
    refs.push(['track', ref[0], ref[1]])
    for (const clip of getTrack(ref)?.clips ?? []) refs.push(['clip', clip[0], clip[1]])
  }
  for (const [id, hash] of manifest.assets) refs.push(['asset', id, hash])
  return refs
}

const isEntityRefs = (value: unknown): value is EntityRef[] => Array.isArray(value) && value.every(ref => Array.isArray(ref) && ref.length === 2 && typeof ref[0] === 'string' && typeof ref[1] === 'string')

export function isManifest(value: unknown): value is ProjectManifest {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.format === RECORD_FORMAT && typeof record.id === 'string' && typeof record.meta === 'string' && Number.isSafeInteger(record.generation)
    && isEntityRefs(record.tracks) && isEntityRefs(record.assets)
}

/**
 * Rebuilds the stored project and its assets from a manifest. Missing records throw (the caller falls back to the
 * validated copy); the result is still raw and goes through the same validation as a legacy bundle.
 */
export function assembleProject(manifest: ProjectManifest, projectId: string, get: (key: RecordKey) => unknown): { project: unknown; assets: unknown[] } {
  const need = (ref: RecordRef): unknown => {
    const value = get(recordKey(projectId, ref))
    if (value === undefined) throw new Error('저장된 프로젝트 일부를 찾지 못했습니다.')
    return value
  }
  const meta = need(['meta', projectId, manifest.meta])
  if (!meta || typeof meta !== 'object') throw new Error('저장된 프로젝트 정보가 올바르지 않습니다.')
  const tracks = manifest.tracks.map(([id, hash]) => {
    const record = need(['track', id, hash]) as Partial<TrackRecord> | null
    if (!record || typeof record.track !== 'object' || !isEntityRefs(record.clips)) throw new Error('저장된 트랙 정보가 올바르지 않습니다.')
    return { ...record.track, clips: record.clips.map(([clipId, clipHash]) => need(['clip', clipId, clipHash])) }
  })
  const assets = manifest.assets.map(([id, hash]) => need(['asset', id, hash]))
  return { project: { ...meta, tracks }, assets }
}

import { validateProject } from './project'
import type { AudioAsset, Project } from './types'

export interface StoredAudioAsset {
  id: string
  name: string
  blob: Blob
}

export interface StoredProject {
  project: Project
  assets: StoredAudioAsset[]
}

/** Listing reads only these small records; it never loads or decodes original audio. */
export interface ProjectSummary {
  id: string
  name: string
  bpm: number
  trackCount: number
  lengthBeats: number
  createdAt: number
  updatedAt: number
}

const DATABASE_NAME = 'noct-studio'
const DATABASE_VERSION = 2
const LEGACY_PROJECT_STORE = 'projects'
const LEGACY_ASSET_STORE = 'audio-assets'
const LATEST_PROJECT = 'latest'
const PROJECT_STORE = 'project-bundles'
const SUMMARY_STORE = 'project-summaries'
const BUNDLE_FORMAT = 'noct-studio'

// Autosaves must commit in call order, even if a previous save was rejected.
let saveQueue: Promise<void> = Promise.resolve()

function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new Error('Local project storage is unavailable in this browser. Export a .garak file to keep your work.'))
  return new Promise((resolve, reject) => {
    let settled = false
    let migrationError: Error | null = null
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      const transaction = request.transaction!
      // A blocked open has already rejected. Do not let its eventual upgrade
      // silently run after a later explicit retry takes ownership.
      if (settled) { transaction.abort(); return }
      database.createObjectStore(PROJECT_STORE, { keyPath: 'id' })
      const summaries = database.createObjectStore(SUMMARY_STORE, { keyPath: 'id' })
      summaries.createIndex('updatedAt', 'updatedAt')
      if (!database.objectStoreNames.contains(LEGACY_PROJECT_STORE)) return
      const legacy = transaction.objectStore(LEGACY_PROJECT_STORE).get(LATEST_PROJECT)
      legacy.onsuccess = () => {
        if (legacy.result === undefined) return
        const migrate = (assets: unknown[]) => {
          try {
            const project = validateProject(legacy.result)
            const originals = validateAssets(project, assets)
            const now = Date.now()
            transaction.objectStore(PROJECT_STORE).put({ id: project.id, project, assets: originals })
            summaries.put(projectSummary(project, now, now))
          } catch (error) {
            migrationError = new Error(`기존 자동 저장 프로젝트를 이전하지 못했습니다. 원본 저장소는 변경하지 않았습니다. ${error instanceof Error ? error.message : ''}`)
            transaction.abort()
          }
        }
        if (database.objectStoreNames.contains(LEGACY_ASSET_STORE)) {
          const assets = transaction.objectStore(LEGACY_ASSET_STORE).getAll()
          assets.onsuccess = () => migrate(assets.result)
        } else migrate([])
      }
      // Keep both legacy stores intact. The versionchange transaction commits
      // the complete migrated bundle and summary together, or rolls back all.
    }
    request.onsuccess = () => {
      if (settled) { request.result.close(); return }
      settled = true
      const database = request.result
      database.onversionchange = () => database.close()
      resolve(database)
    }
    request.onerror = () => {
      settled = true
      reject(migrationError ?? request.error ?? new Error('Could not open local project storage.'))
    }
    request.onblocked = () => {
      settled = true
      reject(new Error('로컬 프로젝트 저장소를 업데이트하려면 다른 가락이음 탭을 닫아 주세요.'))
    }
  })
}

function validatedAsset(input: unknown): StoredAudioAsset {
  if (typeof input !== 'object' || input === null) throw new Error('An audio asset is invalid.')
  const value = input as Record<string, unknown>
  if (typeof value.id !== 'string' || !value.id || value.id.length > 200) throw new Error('An audio asset ID is invalid.')
  if (typeof value.name !== 'string' || !value.name || value.name.length > 512) throw new Error('An audio asset name is invalid.')
  if (!(value.blob instanceof Blob)) throw new Error(`The original audio file for “${value.name}” is missing.`)
  return { id: value.id, name: value.name, blob: value.blob }
}

function validateAssets(project: Project, inputs: unknown[]): StoredAudioAsset[] {
  if (!Array.isArray(inputs) || inputs.length > 100_000) throw new Error('The project audio asset list is invalid.')
  const seen = new Set<string>()
  const assets = inputs.map(input => {
    const asset = validatedAsset(input)
    if (seen.has(asset.id)) throw new Error('The project contains duplicate audio asset IDs.')
    seen.add(asset.id)
    return asset
  })
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === 'audio' && !seen.has(clip.assetId)) {
        throw new Error(`The original audio file for “${clip.name}” is missing. The project was not saved.`)
      }
      if (clip.kind === 'audio' && clip.pitch && !seen.has(clip.pitch.sourceAssetId)) {
        throw new Error(`The original audio file for pitch editing “${clip.name}” is missing. The project was not saved.`)
      }
    }
  }
  return assets
}

function projectSummary(project: Project, createdAt: number, updatedAt: number): ProjectSummary {
  return { id: project.id, name: project.name, bpm: project.bpm, trackCount: project.tracks.length, lengthBeats: project.lengthBeats, createdAt, updatedAt }
}

function validateSummary(input: unknown): ProjectSummary {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('프로젝트 목록 정보가 올바르지 않습니다.')
  const value = input as Record<string, unknown>
  const text = (key: 'id' | 'name', max: number): string => {
    const item = value[key]
    if (typeof item !== 'string' || !item.trim() || item.length > max) throw new Error('프로젝트 목록의 이름 또는 ID가 올바르지 않습니다.')
    return item
  }
  const numeric = (key: 'bpm' | 'trackCount' | 'lengthBeats' | 'createdAt' | 'updatedAt', min: number, max: number, integer = false): number => {
    const item = value[key]
    if (typeof item !== 'number' || !Number.isFinite(item) || item < min || item > max || (integer && !Number.isSafeInteger(item))) throw new Error('프로젝트 목록의 정보가 올바르지 않습니다.')
    return item
  }
  const createdAt = numeric('createdAt', 0, Number.MAX_SAFE_INTEGER, true)
  const updatedAt = numeric('updatedAt', createdAt, Number.MAX_SAFE_INTEGER, true)
  return { id: text('id', 200), name: text('name', 512), bpm: numeric('bpm', 30, 300), trackCount: numeric('trackCount', 0, 10_000, true), lengthBeats: numeric('lengthBeats', 0.001, 10_000_000), createdAt, updatedAt }
}

function validateStoredProject(input: unknown, expectedId?: string): StoredProject {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('저장된 프로젝트 정보가 올바르지 않습니다.')
  const value = input as Record<string, unknown>
  const project = validateProject(value.project)
  if (expectedId !== undefined && (project.id !== expectedId || value.id !== expectedId)) throw new Error('저장된 프로젝트 ID가 URL의 프로젝트와 일치하지 않습니다.')
  return { project, assets: validateAssets(project, value.assets as unknown[]) }
}

function assetsFromMap(project: Project, values: Map<string, AudioAsset>): StoredAudioAsset[] {
  const inputs: StoredAudioAsset[] = []
  for (const [key, value] of values) {
    if (key !== value.id) throw new Error('An audio asset has a mismatched ID.')
    inputs.push({ id: value.id, name: value.name, blob: value.blob })
  }
  return validateAssets(project, inputs)
}

async function persist(project: Project, assets: StoredAudioAsset[]): Promise<void> {
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([PROJECT_STORE, SUMMARY_STORE], 'readwrite')
      let failure: unknown
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('The local save was interrupted. Your previous saved project was kept.'))
      transaction.onerror = () => { /* The abort handler reports the transaction failure. */ }
      try {
        const store = transaction.objectStore(SUMMARY_STORE)
        const previous = store.get(project.id)
        const latest = store.index('updatedAt').openCursor(null, 'prev')
        let completed = 0
        const write = () => {
          if (++completed !== 2) return
          try {
            const before = previous.result === undefined ? null : validateSummary(previous.result)
            const last = latest.result === null ? null : validateSummary(latest.result.value)
            if (before && before.id !== project.id) throw new Error('저장된 프로젝트 ID가 일치하지 않습니다.')
            // A monotonic stamp makes latest deterministic even with a frozen
            // clock or two tabs writing inside the same millisecond. Readwrite
            // transactions serialize these reads and writes across connections.
            const updatedAt = Math.max(Date.now(), (last?.updatedAt ?? -1) + 1)
            if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) throw new Error('프로젝트 저장 시각이 올바르지 않습니다.')
            transaction.objectStore(PROJECT_STORE).put({ id: project.id, project, assets })
            store.put(projectSummary(project, before?.createdAt ?? updatedAt, updatedAt))
          } catch (error) {
            failure = error
            transaction.abort()
          }
        }
        previous.onsuccess = write
        latest.onsuccess = write
      } catch (error) {
        failure = error
        transaction.abort()
      }
    })
  } finally {
    database.close()
  }
}

function enqueueSave(project: Project, assets: StoredAudioAsset[]): Promise<void> {
  const next = saveQueue.catch(() => undefined).then(() => persist(project, assets))
  saveQueue = next
  return next
}

/** Atomically stores this project's originals and summary, preserving every other project. */
export function saveProject(project: Project, assets: Map<string, AudioAsset>): Promise<void> {
  let snapshot: Project
  let originals: StoredAudioAsset[]
  try {
    snapshot = validateProject(project)
    originals = assetsFromMap(snapshot, assets)
  } catch (error) {
    return Promise.reject(error)
  }
  return enqueueSave(snapshot, originals)
}

/** Launcher creation/import can save original Blobs before audio decoding or opening a device. */
export function saveStoredProject(stored: StoredProject): Promise<void> {
  try {
    const snapshot = validateStoredProject(stored)
    return enqueueSave(snapshot.project, snapshot.assets)
  } catch (error) {
    return Promise.reject(error)
  }
}

export async function listProjects(): Promise<ProjectSummary[]> {
  await saveQueue.catch(() => undefined)
  const database = await openDatabase()
  try {
    return await new Promise<ProjectSummary[]>((resolve, reject) => {
      const transaction = database.transaction(SUMMARY_STORE, 'readonly')
      const request = transaction.objectStore(SUMMARY_STORE).getAll()
      transaction.onabort = () => reject(transaction.error ?? new Error('프로젝트 목록을 읽지 못했습니다.'))
      transaction.onerror = () => { /* The abort handler reports the transaction failure. */ }
      transaction.oncomplete = () => {
        try { resolve(request.result.map(validateSummary).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))) }
        catch (error) { reject(error) }
      }
    })
  } finally {
    database.close()
  }
}

/** An explicit ID never falls back to a different project. Omitted ID reads the most recently saved one. */
export async function loadProject(id?: string): Promise<StoredProject | null> {
  if (id !== undefined && (typeof id !== 'string' || !id.trim() || id.length > 200)) throw new Error('프로젝트 ID가 올바르지 않습니다.')
  await saveQueue.catch(() => undefined)
  const database = await openDatabase()
  try {
    return await new Promise<StoredProject | null>((resolve, reject) => {
      const transaction = database.transaction(id === undefined ? [PROJECT_STORE, SUMMARY_STORE] : PROJECT_STORE, 'readonly')
      let expectedId = id
      let result: unknown
      let failure: unknown
      const read = (projectId: string) => {
        const request = transaction.objectStore(PROJECT_STORE).get(projectId)
        request.onsuccess = () => { result = request.result }
      }
      if (id !== undefined) read(id)
      else {
        const latest = transaction.objectStore(SUMMARY_STORE).index('updatedAt').openCursor(null, 'prev')
        latest.onsuccess = () => {
          if (!latest.result) return
          try { expectedId = validateSummary(latest.result.value).id; read(expectedId) }
          catch (error) { failure = error; transaction.abort() }
        }
      }
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Could not read the saved project.'))
      transaction.onerror = () => { /* The abort handler reports the transaction failure. */ }
      transaction.oncomplete = () => {
        if (failure) { reject(failure); return }
        if (result === undefined) {
          if (id === undefined && expectedId !== undefined) reject(new Error('목록에 있는 프로젝트의 저장 데이터를 찾지 못했습니다.'))
          else resolve(null)
          return
        }
        try {
          resolve(validateStoredProject(result, expectedId))
        } catch (error) {
          reject(error)
        }
      }
    })
  } finally {
    database.close()
  }
}

function encodeBase64(bytes: Uint8Array): string {
  const encoded: string[] = []
  // A multiple of three keeps intermediate chunks free of base64 padding.
  const chunkSize = 24_576
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    encoded.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))))
  }
  return encoded.join('')
}

function decodeBase64(value: unknown, name: string): ArrayBuffer {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(`The audio data for “${name}” is not valid base64.`)
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const output = new Uint8Array(value.length / 4 * 3 - padding)
  let written = 0
  try {
    for (let offset = 0; offset < value.length; offset += 32_768) {
      const decoded = atob(value.slice(offset, offset + 32_768))
      for (let index = 0; index < decoded.length; index += 1) output[written++] = decoded.charCodeAt(index)
    }
  } catch {
    throw new Error(`The audio data for “${name}” is damaged.`)
  }
  if (written !== output.length) throw new Error(`The audio data for “${name}” is incomplete.`)
  return output.buffer
}

/** Portable .garak JSON (legacy .noct files share the same format): versioned metadata plus unmodified original audio bytes. */
export async function exportProjectBundle(project: Project, assets: Map<string, AudioAsset>): Promise<Blob> {
  const snapshot = validateProject(project)
  const originals = assetsFromMap(snapshot, assets)
  const bundled = []
  for (const asset of originals) {
    bundled.push({
      id: asset.id,
      name: asset.name,
      mimeType: asset.blob.type,
      byteLength: asset.blob.size,
      dataBase64: encodeBase64(new Uint8Array(await asset.blob.arrayBuffer())),
    })
  }
  return new Blob([JSON.stringify({
    format: BUNDLE_FORMAT,
    schemaVersion: 1,
    project: snapshot,
    assets: bundled,
  })], { type: 'application/json' })
}

export async function importProjectBundle(file: Blob): Promise<StoredProject> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await file.text())
  } catch {
    throw new Error('This file is not a readable .garak project bundle.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('가락이음 프로젝트 파일이 아닙니다.')
  }
  const bundle = parsed as Record<string, unknown>
  if (bundle.format !== BUNDLE_FORMAT || bundle.schemaVersion !== 1) {
    throw new Error('This project bundle format or version is not supported.')
  }
  const project = validateProject(bundle.project)
  if (!Array.isArray(bundle.assets) || bundle.assets.length > 100_000) throw new Error('The project audio asset list is invalid.')
  const assets = bundle.assets.map((input: unknown): StoredAudioAsset => {
    if (typeof input !== 'object' || input === null) throw new Error('A bundled audio asset is invalid.')
    const asset = input as Record<string, unknown>
    if (typeof asset.mimeType !== 'string' || asset.mimeType.length > 200) throw new Error('An audio file type is invalid.')
    if (typeof asset.byteLength !== 'number' || !Number.isSafeInteger(asset.byteLength) || asset.byteLength < 0) {
      throw new Error('An audio file size is invalid.')
    }
    const bytes = decodeBase64(asset.dataBase64, typeof asset.name === 'string' ? asset.name : 'audio file')
    if (bytes.byteLength !== asset.byteLength) throw new Error('A bundled audio file is incomplete or damaged.')
    return validatedAsset({ id: asset.id, name: asset.name, blob: new Blob([bytes], { type: asset.mimeType }) })
  })
  return { project, assets: validateAssets(project, assets) }
}

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

const DATABASE_NAME = 'noct-studio'
const DATABASE_VERSION = 1
const PROJECT_STORE = 'projects'
const ASSET_STORE = 'audio-assets'
const LATEST_PROJECT = 'latest'
const BUNDLE_FORMAT = 'noct-studio'

// Autosaves must commit in call order, even if a previous save was rejected.
let saveQueue: Promise<void> = Promise.resolve()

function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new Error('Local project storage is unavailable in this browser. Export a .garak file to keep your work.'))
  return new Promise((resolve, reject) => {
    let settled = false
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(PROJECT_STORE)) database.createObjectStore(PROJECT_STORE)
      if (!database.objectStoreNames.contains(ASSET_STORE)) database.createObjectStore(ASSET_STORE, { keyPath: 'id' })
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
      reject(request.error ?? new Error('Could not open local project storage.'))
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
    }
  }
  return assets
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
      const transaction = database.transaction([PROJECT_STORE, ASSET_STORE], 'readwrite')
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('The local save was interrupted. Your previous saved project was kept.'))
      transaction.onerror = () => { /* The abort handler reports the transaction failure. */ }
      try {
        transaction.objectStore(PROJECT_STORE).put(project, LATEST_PROJECT)
        const store = transaction.objectStore(ASSET_STORE)
        store.clear()
        for (const asset of assets) store.put(asset)
      } catch (error) {
        transaction.abort()
        reject(error)
      }
    })
  } finally {
    database.close()
  }
}

/** Atomically stores the project and every original audio Blob, never AudioBuffers. */
export function saveProject(project: Project, assets: Map<string, AudioAsset>): Promise<void> {
  let snapshot: Project
  let originals: StoredAudioAsset[]
  try {
    snapshot = validateProject(project)
    originals = assetsFromMap(snapshot, assets)
  } catch (error) {
    return Promise.reject(error)
  }
  const next = saveQueue.catch(() => undefined).then(() => persist(snapshot, originals))
  saveQueue = next
  return next
}

export async function loadProject(): Promise<StoredProject | null> {
  await saveQueue.catch(() => undefined)
  const database = await openDatabase()
  try {
    return await new Promise<StoredProject | null>((resolve, reject) => {
      const transaction = database.transaction([PROJECT_STORE, ASSET_STORE], 'readonly')
      const projectRequest = transaction.objectStore(PROJECT_STORE).get(LATEST_PROJECT)
      const assetRequest = transaction.objectStore(ASSET_STORE).getAll()
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not read the saved project.'))
      transaction.onerror = () => { /* The abort handler reports the transaction failure. */ }
      transaction.oncomplete = () => {
        if (projectRequest.result === undefined) { resolve(null); return }
        try {
          const project = validateProject(projectRequest.result)
          resolve({ project, assets: validateAssets(project, assetRequest.result as unknown[]) })
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

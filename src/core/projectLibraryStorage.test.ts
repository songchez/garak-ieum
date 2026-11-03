import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { createEmptyProject, createTrack, uid } from './project'
import { setProjectTimeSignature } from './meter'
import { listProjects, loadProject, saveProject, saveStoredProject, type StoredProject } from './storage'
import type { AudioAsset, AudioClip } from './types'

const DATABASE = 'noct-studio'
const PROJECTS = 'project-bundles'
const SUMMARIES = 'project-summaries'

function recordedProject(name: string, data: number[]): { stored: StoredProject; assets: Map<string, AudioAsset> } {
  const project = { ...createEmptyProject(), name }
  const track = createTrack('audio')
  const clip: AudioClip = { id: uid(), kind: 'audio', name: 'Original take', startBeat: 0, lengthBeats: 8, gain: 1, assetId: 'shared-id', offsetSeconds: 0, fadeIn: 0, fadeOut: 0 }
  track.clips = [clip]
  project.tracks = [track]
  const asset = { id: clip.assetId, name: `${name}.wav`, blob: new Blob([new Uint8Array(data)], { type: 'audio/wav' }) }
  return { stored: { project, assets: [asset] }, assets: new Map([[asset.id, { ...asset, buffer: {} as AudioBuffer, peaks: [] }]]) }
}

function opened(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, version)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
  })
}

async function seedLegacy(project: unknown, assets: StoredProject['assets'], keepOpen = false): Promise<IDBDatabase> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('projects')
      request.result.createObjectStore('audio-assets', { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const transaction = database.transaction(['projects', 'audio-assets'], 'readwrite')
  const done = completed(transaction)
  transaction.objectStore('projects').put(project, 'latest')
  for (const asset of assets) transaction.objectStore('audio-assets').put(asset)
  await done
  if (!keepOpen) database.close()
  return database
}

async function rawRecord(store: string, key: IDBValidKey): Promise<unknown> {
  const database = await opened()
  try {
    const transaction = database.transaction(store, 'readonly')
    const done = completed(transaction)
    const request = transaction.objectStore(store).get(key)
    await done
    return request.result
  } finally { database.close() }
}

beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('project library persistence', () => {
  it('keeps meter in autosaves and summaries and defaults pre-meter summaries to 4/4', async () => {
    const compound = setProjectTimeSignature(createEmptyProject(), 6, 8)
    const legacy = createEmptyProject()
    await saveProject(compound, new Map())
    await saveProject(legacy, new Map())
    expect((await loadProject(compound.id))?.project).toEqual(compound)
    expect((await listProjects()).find(row => row.id === compound.id)).toMatchObject({ timeSignature: { numerator: 6, denominator: 8 }, beatsPerBar: 3 })

    const oldSummary = await rawRecord(SUMMARIES, legacy.id) as Record<string, unknown>
    delete oldSummary.timeSignature
    delete oldSummary.beatsPerBar
    const database = await opened()
    const transaction = database.transaction(SUMMARIES, 'readwrite')
    const done = completed(transaction)
    transaction.objectStore(SUMMARIES).put(oldSummary)
    await done
    database.close()
    expect((await listProjects()).find(row => row.id === legacy.id)).toMatchObject({ timeSignature: { numerator: 4, denominator: 4 }, beatsPerBar: 4 })
  })

  it('starts empty and an explicit missing URL never opens the latest project', async () => {
    expect(await listProjects()).toEqual([])
    expect(await loadProject()).toBeNull()
    expect(await loadProject('missing')).toBeNull()
    const project = createEmptyProject()
    await saveProject(project, new Map())
    expect((await loadProject())?.project.id).toBe(project.id)
    expect(await loadProject('missing')).toBeNull()
    for (const id of ['', ' ', 'a'.repeat(201)]) await expect(loadProject(id)).rejects.toThrow('프로젝트 ID')
  })

  it('stores multiple projects with isolated original audio even when asset IDs match', async () => {
    const a = recordedProject('첫 작업', [1, 2, 3]), b = recordedProject('다음 작업', [4, 5, 6, 7])
    await saveProject(a.stored.project, a.assets)
    await saveStoredProject(b.stored)
    const first = await loadProject(a.stored.project.id), second = await loadProject(b.stored.project.id)
    expect(first?.project).toEqual(a.stored.project)
    expect(second?.project).toEqual(b.stored.project)
    expect(new Uint8Array(await first!.assets[0].blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(new Uint8Array(await second!.assets[0].blob.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6, 7]))
    // Removing originals from one saved project must never clear the other's assets.
    await saveProject({ ...a.stored.project, tracks: [] }, new Map())
    expect((await loadProject(a.stored.project.id))?.assets).toEqual([])
    expect(new Uint8Array(await (await loadProject(b.stored.project.id))!.assets[0].blob.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6, 7]))
  })

  it('maintains creation time and deterministic latest order with equal or backward clocks', async () => {
    const time = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const a = createEmptyProject(), b = createEmptyProject()
    await saveProject(a, new Map())
    await saveProject(b, new Map())
    expect((await listProjects()).map(row => [row.id, row.createdAt, row.updatedAt])).toEqual([[b.id, 1001, 1001], [a.id, 1000, 1000]])
    time.mockReturnValue(900)
    const renamed = { ...a, name: '이름을 바꾼 작업', bpm: 112, lengthBeats: 128, tracks: [createTrack('instrument', 'gayageum')] }
    await saveProject(renamed, new Map())
    expect(await listProjects()).toEqual([
      { id: a.id, name: renamed.name, bpm: 112, timeSignature: { numerator: 4, denominator: 4 }, beatsPerBar: 4, trackCount: 1, lengthBeats: 128, createdAt: 1000, updatedAt: 1002 },
      { id: b.id, name: b.name, bpm: b.bpm, timeSignature: { numerator: 4, denominator: 4 }, beatsPerBar: 4, trackCount: 0, lengthBeats: b.lengthBeats, createdAt: 1001, updatedAt: 1001 },
    ])
    expect((await loadProject())?.project).toEqual(renamed)
  })

  it('lists only summary records without reading projects or original blobs', async () => {
    const fixture = recordedProject('저장한 녹음', [8, 9])
    await saveStoredProject(fixture.stored)
    const stores: string[] = []
    const getAll = IDBObjectStore.prototype.getAll
    vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (this: IDBObjectStore, ...args) { stores.push(this.name); return getAll.apply(this, args) })
    const rows = await listProjects()
    expect(stores).toEqual([SUMMARIES])
    expect(rows[0]).not.toHaveProperty('assets')
    expect(rows[0]).not.toHaveProperty('project')
  })

  it('snapshots queued input immediately and preserves call order', async () => {
    const a = recordedProject('첫 저장', [1]), b = createEmptyProject()
    const pending = saveStoredProject(a.stored)
    a.stored.project.name = '호출 뒤 변경'
    a.stored.assets[0].name = 'changed.wav'
    const later = saveProject(b, new Map())
    await Promise.all([pending, later])
    const first = await loadProject(a.stored.project.id)
    expect(first?.project.name).toBe('첫 저장')
    expect(first?.assets[0].name).toBe('첫 저장.wav')
    expect((await loadProject())?.project.id).toBe(b.id)
  })

  it('serializes metadata updates from independent tab save queues', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5000)
    // A separate module instance has its own in-memory queue, as another tab does.
    vi.resetModules()
    const secondTab = await import('./storage')
    const a = createEmptyProject(), b = createEmptyProject()
    await Promise.all([saveProject(a, new Map()), secondTab.saveProject(b, new Map())])
    const rows = await listProjects()
    expect(new Set(rows.map(row => row.id))).toEqual(new Set([a.id, b.id]))
    expect(rows.map(row => row.updatedAt)).toEqual([5001, 5000])
  })

  it('rolls back a synchronous quota failure after the bundle put and recovers for the next save', async () => {
    const original = recordedProject('기존 녹음', [1, 2])
    await saveStoredProject(original.stored)
    const before = await listProjects()
    const put = IDBObjectStore.prototype.put
    let fail = true
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === SUMMARIES && fail) { fail = false; throw new DOMException('Storage full', 'QuotaExceededError') }
      return put.apply(this, args)
    })
    const edited = { ...original.stored.project, name: '실패한 변경' }
    await expect(saveProject(edited, original.assets)).rejects.toMatchObject({ name: 'QuotaExceededError' })
    expect(await listProjects()).toEqual(before)
    expect((await loadProject(edited.id))?.project.name).toBe('기존 녹음')
    spy.mockRestore()
    await saveProject({ ...edited, name: '복구 후 저장' }, original.assets)
    expect((await loadProject(edited.id))?.project.name).toBe('복구 후 저장')
  })

  it('rolls back an asynchronous request error and keeps subsequent queued projects', async () => {
    const a = createEmptyProject(), b = createEmptyProject()
    await saveProject(a, new Map())
    const put = IDBObjectStore.prototype.put
    let fail = true
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      // add() causes a real asynchronous ConstraintError on the existing key.
      if (this.name === SUMMARIES && fail) { fail = false; return this.add(...args) }
      return put.apply(this, args)
    })
    const failed = saveProject({ ...a, name: '롤백될 이름' }, new Map())
    const succeeding = saveProject(b, new Map())
    await expect(failed).rejects.toMatchObject({ name: 'ConstraintError' })
    await succeeding
    expect((await loadProject(a.id))?.project.name).toBe(a.name)
    expect((await loadProject())?.project.id).toBe(b.id)
    expect(await listProjects()).toHaveLength(2)
  })

  it('rejects missing originals and mismatched stored IDs without overwriting another project', async () => {
    const valid = createEmptyProject()
    await saveProject(valid, new Map())
    const fixture = recordedProject('누락된 원본', [1])
    await expect(saveStoredProject({ ...fixture.stored, assets: [] })).rejects.toThrow('original audio file')
    await expect(saveStoredProject({ ...fixture.stored, assets: undefined } as unknown as StoredProject)).rejects.toThrow('asset list')
    expect(await listProjects()).toHaveLength(1)
    const database = await opened()
    const transaction = database.transaction(PROJECTS, 'readwrite')
    const done = completed(transaction)
    transaction.objectStore(PROJECTS).put({ id: 'wrong-record', project: valid, assets: [] })
    await done; database.close()
    await expect(loadProject('wrong-record')).rejects.toThrow('ID')
    expect((await loadProject(valid.id))?.project).toEqual(valid)
  })
})

describe('legacy autosave migration', () => {
  it('atomically migrates the v1 latest project and original bytes while retaining legacy stores', async () => {
    const fixture = recordedProject('이전 자동 저장', [10, 20, 30])
    await seedLegacy(fixture.stored.project, fixture.stored.assets)
    const list = await listProjects()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: fixture.stored.project.id, name: fixture.stored.project.name, trackCount: 1 })
    const restored = await loadProject(fixture.stored.project.id)
    expect(restored?.project).toEqual(fixture.stored.project)
    expect(new Uint8Array(await restored!.assets[0].blob.arrayBuffer())).toEqual(new Uint8Array([10, 20, 30]))
    expect(await rawRecord('projects', 'latest')).toEqual(fixture.stored.project)
    const legacyAsset = await rawRecord('audio-assets', 'shared-id') as { blob: Blob }
    expect(new Uint8Array(await legacyAsset.blob.arrayBuffer())).toEqual(new Uint8Array([10, 20, 30]))
    await saveProject(createEmptyProject(), new Map())
    expect(await listProjects()).toHaveLength(2)
    expect((await loadProject(fixture.stored.project.id))?.project).toEqual(fixture.stored.project)
  })

  it('does not recreate the legacy snapshot over a later edit on reopen', async () => {
    const project = createEmptyProject()
    await seedLegacy(project, [])
    await loadProject()
    const edited = { ...project, name: '새 버전에서 고친 이름' }
    await saveProject(edited, new Map())
    expect((await loadProject(project.id))?.project).toEqual(edited)
    expect(await listProjects()).toHaveLength(1)
    expect(await rawRecord('projects', 'latest')).toEqual(project)
  })

  it('aborts an invalid legacy migration without upgrading or replacing the original data', async () => {
    const fixture = recordedProject('원본이 빠진 이전 작업', [1, 2, 3])
    await seedLegacy(fixture.stored.project, [])
    await expect(listProjects()).rejects.toThrow('원본 저장소는 변경하지 않았습니다')
    const database = await opened(1)
    expect(database.version).toBe(1)
    expect([...database.objectStoreNames]).toEqual(['audio-assets', 'projects'])
    database.close()
    expect(await rawRecord('projects', 'latest')).toEqual(fixture.stored.project)
  })

  it('rolls back a failed migration write and successfully retries the unchanged v1 data', async () => {
    const fixture = recordedProject('이전 저장본', [5, 6, 7])
    await seedLegacy(fixture.stored.project, fixture.stored.assets)
    const put = IDBObjectStore.prototype.put
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === SUMMARIES) throw new DOMException('Migration storage full', 'QuotaExceededError')
      return put.apply(this, args)
    })
    await expect(listProjects()).rejects.toThrow('Migration storage full')
    spy.mockRestore()
    const database = await opened(1)
    expect(database.version).toBe(1)
    expect(database.objectStoreNames.contains(PROJECTS)).toBe(false)
    database.close()
    const restored = await loadProject(fixture.stored.project.id)
    expect(restored?.project).toEqual(fixture.stored.project)
    expect(new Uint8Array(await restored!.assets[0].blob.arrayBuffer())).toEqual(new Uint8Array([5, 6, 7]))
  })

  it('reports a blocked upgrade, closes the rejected attempt, and permits an explicit retry', async () => {
    const project = createEmptyProject()
    const legacy = await seedLegacy(project, [], true)
    await expect(listProjects()).rejects.toThrow('다른 가락이음 탭')
    legacy.close()
    expect((await loadProject(project.id))?.project).toEqual(project)
    expect(await listProjects()).toHaveLength(1)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb'
import { autosaveSnapshot, resetAutosaveValidation } from './autosave'
import { createDemoProject, createTrack, uid, validateProject } from './project'
import { canonicalJson, keyString, planProject } from './projectRecords'
import { listProjects, loadProject, saveProject, type StoredAudioAsset } from './storage'
import type { AudioAsset, AudioClip, Project } from './types'

const DATABASE = 'noct-studio'
const PROJECTS = 'project-bundles'
const SUMMARIES = 'project-summaries'
const RECORDS = 'project-records'
const validatedKey = (id: string) => `${id}\u0000validated`

beforeEach(() => {
  resetAutosaveValidation()
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

/** A demo arrangement plus two audio tracks sharing one original and a second original. */
function fixture(): { project: Project; assets: Map<string, AudioAsset> } {
  const demo = createDemoProject()
  const assets = new Map<string, AudioAsset>()
  const tracks = [...demo.tracks]
  for (const [index, assetId] of ['take-a', 'take-b'].entries()) {
    const track = createTrack('audio')
    const clip: AudioClip = { id: uid(), kind: 'audio', name: `take ${index}`, startBeat: index * 8, lengthBeats: 8, gain: 1, assetId, offsetSeconds: 0, fadeIn: 0, fadeOut: 0 }
    track.clips = [clip, { ...clip, id: uid(), startBeat: 16 + index * 8 }]
    tracks.push(track)
    assets.set(assetId, { id: assetId, name: `${assetId}.wav`, blob: new Blob([new Uint8Array(4096).map((_, i) => (i * 7 + index) & 255)], { type: 'audio/wav' }), sampleRate: 48000, numberOfChannels: 1, length: 48000, duration: 1, peaks: [] })
  }
  return { project: validateProject({ ...demo, tracks }), assets }
}

const midiAt = (project: Project) => {
  const trackIndex = project.tracks.findIndex(track => track.clips.some(clip => clip.kind === 'midi' && clip.notes.length > 1))
  const clipIndex = project.tracks[trackIndex].clips.findIndex(clip => clip.kind === 'midi' && clip.notes.length > 1)
  return { trackIndex, clipIndex }
}

/** ProjectSession-style structural update of one note. */
function editNote(project: Project, velocity: number): Project {
  const { trackIndex, clipIndex } = midiAt(project)
  return {
    ...project,
    tracks: project.tracks.map((track, t) => t !== trackIndex ? track : {
      ...track,
      clips: track.clips.map((clip, c) => c !== clipIndex || clip.kind !== 'midi' ? clip : { ...clip, notes: clip.notes.map((note, n) => n === 0 ? { ...note, velocity } : note) }),
    }),
  }
}

function opened(version?: number, upgrade?: (database: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, version)
    if (upgrade) request.onupgradeneeded = () => upgrade(request.result)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function run<T>(stores: string[], mode: IDBTransactionMode, body: (transaction: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  const database = await opened()
  try {
    const transaction = database.transaction(stores, mode)
    const request = body(transaction)
    await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error) })
    return request ? request.result : undefined
  } finally { database.close() }
}

const recordKeys = async (projectId: string) => (await run([RECORDS], 'readonly', t => t.objectStore(RECORDS).getAllKeys(IDBKeyRange.bound([projectId], [projectId, []]))) as IDBValidKey[][]).map(key => keyString(key))
const rawProjectRecord = (key: string) => run([PROJECTS], 'readonly', t => t.objectStore(PROJECTS).get(key)) as Promise<Record<string, unknown> | undefined>

/** Counts record puts by kind during `body`. */
async function recordPuts(body: () => Promise<unknown>): Promise<string[]> {
  const kinds: string[] = []
  const put = IDBObjectStore.prototype.put
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === RECORDS) kinds.push(String((args[1] as unknown[])[1]))
    return put.apply(this, args)
  })
  try { await body() } finally { spy.mockRestore() }
  return kinds.sort()
}

async function expectSameAssets(actual: StoredAudioAsset[], expected: Map<string, AudioAsset>) {
  expect(actual.map(asset => [asset.id, asset.name, asset.blob.type])).toEqual([...expected.values()].map(asset => [asset.id, asset.name, asset.blob.type]))
  for (const asset of actual) expect(new Uint8Array(await asset.blob.arrayBuffer())).toEqual(new Uint8Array(await expected.get(asset.id)!.blob.arrayBuffer()))
}

describe('record change detection', () => {
  it('a single note edit changes exactly one clip record and its track record', () => {
    const { project } = fixture()
    const before = planProject(project)
    const after = planProject(editNote(project, 0.33))
    const added = [...after.records.keys()].filter(key => !before.records.has(key))
    const removed = [...before.records.keys()].filter(key => !after.records.has(key))
    expect(added.map(key => key.split('\u0000')[1]).sort()).toEqual(['clip', 'track'])
    expect(removed.map(key => key.split('\u0000')[1]).sort()).toEqual(['clip', 'track'])
    expect(after.meta).toBe(before.meta)
  })

  it('hashes content, not object identity or key order', () => {
    const { project } = fixture()
    const plan = planProject(project)
    // A structured clone and a re-validated copy (fresh objects, validateProject key order) name the same records.
    expect([...planProject(structuredClone(project)).records.keys()]).toEqual([...plan.records.keys()])
    expect([...planProject(validateProject(structuredClone(project))).records.keys()]).toEqual([...plan.records.keys()])
    expect(canonicalJson({ b: 1, a: [{ d: undefined, c: 'x' }] })).toBe(canonicalJson({ a: [{ c: 'x' }], b: 1 }))
    // Any field change, track metadata or project metadata, changes only the records that hold it.
    const renamed = planProject({ ...project, tracks: project.tracks.map((track, index) => index === 0 ? { ...track, name: 'renamed' } : track) })
    expect([...renamed.records.keys()].filter(key => !plan.records.has(key)).map(key => key.split('\u0000')[1])).toEqual(['track'])
    const tempo = planProject({ ...project, bpm: project.bpm + 1 })
    expect(tempo.meta).not.toBe(plan.meta)
    expect(tempo.tracks).toEqual(plan.tracks)
  })

  it('autosave writes only the changed clip and track records, and nothing for an unchanged snapshot', async () => {
    const { project, assets } = fixture()
    const initial = await recordPuts(() => saveProject(project, assets, { trusted: true }))
    expect(initial.filter(kind => kind === 'asset')).toHaveLength(2)
    const edited = editNote(project, 0.21)
    expect(await recordPuts(() => saveProject(edited, assets, { trusted: true }))).toEqual(['clip', 'track'])
    // Re-saving equal content (fresh objects and re-wrapped original Blobs, as after reopening) writes no records.
    const rewrapped = new Map([...assets].map(([id, asset]) => [id, { ...asset, blob: new Blob([asset.blob], { type: asset.blob.type }) }]))
    expect(await recordPuts(() => saveProject(validateProject(structuredClone(edited)), rewrapped))).toEqual([])
    const loaded = await loadProject(project.id)
    expect(loaded?.project).toEqual(validateProject(edited))
  })
})

describe('atomic commit', () => {
  it('a crash between record writes keeps the previous project intact and the next save succeeds', async () => {
    const { project, assets } = fixture()
    await saveProject(project, assets, { trusted: true })
    const before = await recordKeys(project.id)
    const summaries = await listProjects()
    const put = IDBObjectStore.prototype.put
    let records = 0
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      // The clip record lands, then the process "dies" before the track record and the manifest.
      if (this.name === RECORDS && ++records === 2) throw new DOMException('crash', 'AbortError')
      return put.apply(this, args)
    })
    const edited = editNote(project, 0.77)
    await expect(saveProject(edited, assets, { trusted: true })).rejects.toThrow('crash')
    spy.mockRestore()
    expect(await recordKeys(project.id)).toEqual(before)
    expect(await listProjects()).toEqual(summaries)
    const reopened = await loadProject(project.id)
    expect(reopened?.project).toEqual(project)
    expect(reopened?.recovered).toBeUndefined()
    await saveProject(edited, assets, { trusted: true })
    expect((await loadProject(project.id))?.project).toEqual(validateProject(edited))
  })

  it('records without a committed manifest (a torn writer) are invisible to load and collected by the next save', async () => {
    const { project, assets } = fixture()
    await saveProject(project, assets, { trusted: true })
    const committed = await recordKeys(project.id)
    // Simulate a writer that stored new records for a later generation and died before its manifest.
    const edited = editNote(project, 0.55)
    const orphans = [...planProject(edited).records.values()].filter(record => !committed.includes(keyString(record.key)))
    expect(orphans).toHaveLength(2)
    await run([RECORDS], 'readwrite', t => { for (const record of orphans) t.objectStore(RECORDS).put(record.value, record.key) })
    await run([RECORDS], 'readwrite', t => { t.objectStore(RECORDS).put('junk', [project.id, 'clip', 'orphan', 'x']) })
    expect((await loadProject(project.id))?.project).toEqual(project)
    // A new session (no cached record set) scans and collects the unreachable records.
    vi.resetModules()
    const fresh = await import('./storage')
    await fresh.saveProject({ ...project, name: 'next' }, assets, { trusted: true })
    const after = await recordKeys(project.id)
    expect(after).not.toContain(keyString([project.id, 'clip', 'orphan', 'x']))
    for (const record of orphans) expect(after).not.toContain(keyString(record.key))
    expect((await fresh.loadProject(project.id))?.project.name).toBe('next')
  })

  it('a manifest pointing at a missing record opens the last validated copy instead of a mixed project', async () => {
    const { project, assets } = fixture()
    await saveProject(project, assets, { trusted: true })
    const edited = editNote(project, 0.12)
    await saveProject(edited, assets, { trusted: true })
    const editedKeys = new Set(await recordKeys(project.id))
    const clipKey = [...planProject(edited).records.values()].find(record => record.key[1] === 'clip' && !planProject(project).records.has(keyString(record.key)))!.key
    expect(editedKeys.has(keyString(clipKey))).toBe(true)
    await run([RECORDS], 'readwrite', t => { t.objectStore(RECORDS).delete(clipKey) })
    const loaded = await loadProject(project.id)
    expect(loaded?.recovered).toBe(true)
    expect(loaded?.project).toEqual(project)
    await expectSameAssets(loaded!.assets, assets)
  })
})

describe('garbage collection', () => {
  it('keeps exactly the records the latest and the last validated manifests reach', async () => {
    const { project, assets } = fixture()
    await saveProject(project, assets, { trusted: true })
    let current = project
    for (let i = 0; i < 6; i++) {
      current = editNote(current, 0.1 + i / 10)
      await saveProject(current, assets, { trusted: true })
    }
    const reachable = new Set([...planProject(current).records.keys(), ...planProject(project).records.keys()])
    const stored = await recordKeys(project.id)
    const assetRecords = stored.filter(key => key.split('\u0000')[1] === 'asset')
    expect(assetRecords).toHaveLength(2)
    expect(new Set(stored.filter(key => key.split('\u0000')[1] !== 'asset'))).toEqual(reachable)
    // A validated save moves the recovery copy forward and releases the first snapshot's records.
    resetAutosaveValidation()
    await saveProject(current, assets, { trusted: true })
    expect(new Set((await recordKeys(project.id)).filter(key => key.split('\u0000')[1] !== 'asset'))).toEqual(new Set(planProject(current).records.keys()))
  })

  it('collects removed tracks and unreferenced audio originals without touching other projects', async () => {
    const a = fixture(), b = fixture()
    await saveProject(a.project, a.assets)
    await saveProject(b.project, b.assets)
    const bKeys = await recordKeys(b.project.id)
    const trimmed = validateProject({ ...a.project, tracks: a.project.tracks.filter(track => track.kind !== 'audio') })
    await saveProject(trimmed, new Map())
    const stored = await recordKeys(a.project.id)
    expect(stored.some(key => key.split('\u0000')[1] === 'asset')).toBe(false)
    expect(new Set(stored)).toEqual(new Set(planProject(trimmed).records.keys()))
    expect(await recordKeys(b.project.id)).toEqual(bKeys)
    const other = await loadProject(b.project.id)
    expect(other?.project).toEqual(b.project)
    await expectSameAssets(other!.assets, b.assets)
  })

  it('stays correct when another tab writes the same project between saves', async () => {
    const { project, assets } = fixture()
    await saveProject(project, assets, { trusted: true })
    vi.resetModules()
    const otherTab = await import('./storage')
    // The other tab changes a different track, so its GC releases that track's original record.
    const theirs = { ...project, tracks: project.tracks.map((track, index) => index === project.tracks.length - 1 ? { ...track, name: 'their take' } : track) }
    await otherTab.saveProject(theirs, assets)
    // This tab's cached record set is stale: it must rescan instead of skipping records the other tab collected.
    const ours = editNote(project, 0.44)
    await saveProject(ours, assets, { trusted: true })
    const loaded = await loadProject(project.id)
    expect(loaded?.recovered).toBeUndefined()
    expect(loaded?.project).toEqual(validateProject(ours))
    const stored = new Set(await recordKeys(project.id))
    for (const key of planProject(ours).records.keys()) expect(stored.has(key)).toBe(true)
  })
})

describe('migration from whole-project bundles', () => {
  async function seedV2(project: Project, assets: StoredAudioAsset[], validatedCopy: Project): Promise<void> {
    const database = await opened(2, db => {
      db.createObjectStore(PROJECTS, { keyPath: 'id' })
      db.createObjectStore(SUMMARIES, { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt')
    })
    const transaction = database.transaction([PROJECTS, SUMMARIES], 'readwrite')
    transaction.objectStore(PROJECTS).put({ id: project.id, project, assets })
    transaction.objectStore(PROJECTS).put({ id: validatedKey(project.id), project: validatedCopy })
    transaction.objectStore(SUMMARIES).put({ id: project.id, name: project.name, bpm: project.bpm, timeSignature: project.timeSignature, beatsPerBar: project.beatsPerBar, trackCount: project.tracks.length, lengthBeats: project.lengthBeats, createdAt: 10, updatedAt: 20 })
    await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error) })
    database.close()
  }

  it('opens a v2 bundle unchanged, then converts it on the next save with identical recovery', async () => {
    const { project, assets } = fixture()
    const stored = [...assets.values()].map(({ id, name, blob }) => ({ id, name, blob }))
    await seedV2(project, stored, project)
    const legacy = await loadProject(project.id)
    expect(legacy?.project).toEqual(project)
    await expectSameAssets(legacy!.assets, assets)
    expect((await listProjects())[0]).toMatchObject({ id: project.id, createdAt: 10, updatedAt: 20 })

    await saveProject(legacy!.project, new Map([...assets]), { trusted: true })
    const manifest = await rawProjectRecord(project.id)
    expect(manifest).toMatchObject({ format: 'records-1', generation: 1 })
    expect(manifest).not.toHaveProperty('project')
    expect(await rawProjectRecord(validatedKey(project.id))).toMatchObject({ format: 'records-1' })
    const migrated = await loadProject(project.id)
    expect(migrated?.project).toEqual(legacy?.project)
    await expectSameAssets(migrated!.assets, assets)
    expect((await listProjects())[0]).toMatchObject({ id: project.id, createdAt: 10 })
  })

  it('keeps a legacy validated copy usable for recovery until the next validated save', async () => {
    const { project, assets } = fixture()
    const stored = [...assets.values()].map(({ id, name, blob }) => ({ id, name, blob }))
    await seedV2(project, stored, project)
    // The session's first trusted save is validated (refreshes the copy); simulate a session that already validated.
    autosaveSnapshot(project, true)
    const broken = { ...project, name: 'broken', tracks: [{ ...createTrack('instrument'), color: 'not-a-color' }, ...project.tracks] }
    await saveProject(broken, assets, { trusted: true })
    expect(await rawProjectRecord(validatedKey(project.id))).toHaveProperty('project')
    const loaded = await loadProject(project.id)
    expect(loaded?.recovered).toBe(true)
    expect(loaded?.project).toEqual(project)
    await expectSameAssets(loaded!.assets, assets)
  })
})

describe('recovery equality', () => {
  it('a records save loads exactly what the whole-project bundle loaded', async () => {
    const { project, assets } = fixture()
    await saveProject(project, assets)
    const viaRecords = await loadProject(project.id)
    // The same project stored as a legacy bundle (another id space: a fresh database).
    vi.stubGlobal('indexedDB', new IDBFactory())
    const database = await opened(2, db => {
      db.createObjectStore(PROJECTS, { keyPath: 'id' })
      db.createObjectStore(SUMMARIES, { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt')
    })
    const transaction = database.transaction(PROJECTS, 'readwrite')
    transaction.objectStore(PROJECTS).put({ id: project.id, project, assets: [...assets.values()].map(({ id, name, blob }) => ({ id, name, blob })) })
    await new Promise<void>(resolve => { transaction.oncomplete = () => resolve() })
    database.close()
    const viaBundle = await loadProject(project.id)
    expect(viaRecords?.project).toEqual(viaBundle?.project)
    expect(JSON.stringify(viaRecords?.project)).toBe(JSON.stringify(viaBundle?.project))
    expect(viaRecords?.assets.map(asset => [asset.id, asset.name, asset.blob.size, asset.blob.type])).toEqual(viaBundle?.assets.map(asset => [asset.id, asset.name, asset.blob.size, asset.blob.type]))
  })

  it('a broken trusted autosave reopens the records recovery copy with its own originals', async () => {
    const { project, assets } = fixture()
    await saveProject(project, assets, { trusted: true })
    const broken = { ...project, name: 'broken', tracks: [{ ...createTrack('instrument'), color: 'not-a-color' }] }
    await saveProject(broken, new Map(), { trusted: true })
    // The latest manifest no longer references the originals, but the recovery copy keeps them alive.
    expect((await recordKeys(project.id)).filter(key => key.split('\u0000')[1] === 'asset')).toHaveLength(2)
    const loaded = await loadProject(project.id)
    expect(loaded?.recovered).toBe(true)
    expect(loaded?.project).toEqual(project)
    await expectSameAssets(loaded!.assets, assets)
  })
})

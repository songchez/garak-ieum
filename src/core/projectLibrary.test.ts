import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyProject, createTrack, uid } from './project'
import { createLocalProject, importAsNewLocalProject } from './projectLibrary'
import { PROJECT_TEMPLATES } from './projectTemplates'
import { exportProjectBundle, listProjects, loadProject, saveStoredProject, type StoredProject } from './storage'
import type { AudioAsset, AudioClip, MidiClip } from './types'

beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function recording(name: string, bytes: readonly number[]): { stored: StoredProject; exportAssets: Map<string, AudioAsset> } {
  const project = { ...createEmptyProject(), name }
  const track = createTrack('audio')
  const clip: AudioClip = {
    id: uid(), kind: 'audio', name: '녹음 원본', startBeat: 4, lengthBeats: 8,
    gain: 0.8, assetId: 'recording-source', offsetSeconds: 0.75, fadeIn: 0.02, fadeOut: 0.1,
  }
  track.clips = [clip]
  project.tracks = [track]
  const asset = { id: clip.assetId, name: `${name}.wav`, blob: new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }) }
  return { stored: { project, assets: [asset] }, exportAssets: new Map([[asset.id, { ...asset, buffer: {} as AudioBuffer, peaks: [] }]]) }
}

describe('project launcher creation and import', () => {
  it('creates and persists an empty session before returning it', async () => {
    const project = await createLocalProject()
    expect(project.tracks).toEqual([])
    expect(await loadProject(project.id)).toEqual({ project, assets: [] })
    expect(await listProjects()).toEqual([expect.objectContaining({ id: project.id, name: project.name, trackCount: 0 })])
  })

  it.each(PROJECT_TEMPLATES)('opens two independent saved copies of $name and isolates later edits', async template => {
    const a = await createLocalProject(template.id)
    const b = await createLocalProject(template.id)
    expect(a.id).not.toBe(b.id)
    const aClip = a.tracks[0].clips[0] as MidiClip
    const bClip = b.tracks[0].clips[0] as MidiClip
    expect(a.tracks[0].id).not.toBe(b.tracks[0].id)
    expect(aClip.id).not.toBe(bClip.id)
    expect(aClip.notes[0].id).not.toBe(bClip.notes[0].id)
    const before = await loadProject(b.id)
    a.name = '내가 편집한 사본'
    a.tracks[0].volume = 0.31
    aClip.notes[0].velocity = 0.2
    await saveStoredProject({ project: a, assets: [] })
    expect((await loadProject(a.id))?.project).toEqual(a)
    expect(await loadProject(b.id)).toEqual(before)
    expect((await listProjects()).map(row => row.id)).toEqual([a.id, b.id])
  })

  it('imports the same source ID as new projects without replacing existing work or decoding original audio', async () => {
    const openAudio = vi.fn(function () { throw new Error('Audio devices must not open in the launcher') })
    vi.stubGlobal('AudioContext', openAudio)
    vi.stubGlobal('OfflineAudioContext', openAudio)
    const existing = recording('저장소의 현재 작업', [1, 3, 5, 7])
    await saveStoredProject(existing.stored)
    const fromFile = recording('가져온 버전', [0, 128, 255, 4, 9, 20])
    fromFile.stored.project.id = existing.stored.project.id
    const file = await exportProjectBundle(fromFile.stored.project, fromFile.exportAssets)
    const originalFileText = await file.text()
    const first = await importAsNewLocalProject(file)
    const second = await importAsNewLocalProject(file)
    expect(new Set([existing.stored.project.id, first.id, second.id]).size).toBe(3)
    expect(first).toEqual({ ...fromFile.stored.project, id: first.id })
    expect(second).toEqual({ ...fromFile.stored.project, id: second.id })
    const unchanged = await loadProject(existing.stored.project.id)
    expect(unchanged?.project).toEqual(existing.stored.project)
    expect(new Uint8Array(await unchanged!.assets[0].blob.arrayBuffer())).toEqual(new Uint8Array([1, 3, 5, 7]))
    for (const imported of [first, second]) {
      const saved = await loadProject(imported.id)
      expect(saved?.project).toEqual(imported)
      expect(saved?.assets[0]).toMatchObject({ id: 'recording-source', name: '가져온 버전.wav' })
      expect(saved!.assets[0].blob.type).toBe('audio/wav')
      expect(new Uint8Array(await saved!.assets[0].blob.arrayBuffer())).toEqual(new Uint8Array([0, 128, 255, 4, 9, 20]))
      expect(saved!.assets[0]).not.toHaveProperty('buffer')
    }
    expect(await file.text()).toBe(originalFileText)
    expect(await listProjects()).toHaveLength(3)
    expect(openAudio).not.toHaveBeenCalled()
  })

  it('leaves the list and saved project untouched after malformed files or unknown template IDs', async () => {
    const existing = await createLocalProject()
    const before = await listProjects()
    const badProject = new Blob([JSON.stringify({ format: 'noct-studio', schemaVersion: 1, project: { id: existing.id }, assets: [] })])
    for (const file of [new Blob(['{broken JSON']), new Blob(['[]']), badProject]) {
      await expect(importAsNewLocalProject(file)).rejects.toThrow()
      expect(await listProjects()).toEqual(before)
    }
    for (const id of ['missing-template', '']) {
      await expect(createLocalProject(id)).rejects.toThrow(/Unknown project template/)
      expect(await listProjects()).toEqual(before)
    }
    expect((await loadProject(existing.id))?.project).toEqual(existing)
  })

  it.each(['create', 'import'] as const)('rejects %s if the storage transaction fails and keeps existing projects', async action => {
    const existing = await createLocalProject()
    const before = await listProjects()
    const file = await exportProjectBundle(createEmptyProject(), new Map())
    const put = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'project-summaries') throw new DOMException('Storage full', 'QuotaExceededError')
      return put.apply(this, args)
    })
    const pending = action === 'create' ? createLocalProject() : importAsNewLocalProject(file)
    await expect(pending).rejects.toMatchObject({ name: 'QuotaExceededError' })
    expect(await listProjects()).toEqual(before)
    expect((await loadProject(existing.id))?.project).toEqual(existing)
  })
})

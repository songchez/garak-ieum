import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyProject, createTrack, uid } from './project'
import { exportProjectBundle, importProjectBundle, loadProject, saveProject } from './storage'
import type { AudioAsset, AudioClip, Project } from './types'

function audioFixture(): { project: Project; assets: Map<string, AudioAsset>; bytes: Uint8Array } {
  const project = createEmptyProject()
  project.name = 'Local-only recording'
  const track = createTrack('audio')
  const clip: AudioClip = {
    id: uid(), kind: 'audio', name: 'Original take', startBeat: 3, lengthBeats: 12,
    gain: 0.9, assetId: 'audio-source', offsetSeconds: 1.75, fadeIn: 0.05, fadeOut: 0.2,
  }
  track.clips = [clip, { ...clip, id: uid(), startBeat: 20 }]
  project.tracks = [track]
  // Cross multiple base64 chunk boundaries and cover every possible byte value.
  const bytes = Uint8Array.from({ length: 73_733 }, (_, index) => (index * 53 + 17) % 256)
  const asset: AudioAsset = {
    id: 'audio-source', name: '녹음 take.wav', blob: new Blob([bytes], { type: 'audio/wav' }),
    buffer: {} as AudioBuffer, peaks: [0.2, 0.5],
  }
  return { project, assets: new Map([[asset.id, asset]]), bytes }
}

afterEach(() => vi.unstubAllGlobals())

describe('portable project bundles', () => {
  it('round-trips all original audio bytes, filenames, clip source offsets, and shared references', async () => {
    const { project, assets, bytes } = audioFixture()
    const blob = await exportProjectBundle(project, assets)
    const imported = await importProjectBundle(blob)
    expect(imported.project).toEqual(project)
    expect(imported.assets).toHaveLength(1)
    expect(imported.assets[0]).toMatchObject({ id: 'audio-source', name: '녹음 take.wav' })
    expect(imported.assets[0].blob.type).toBe('audio/wav')
    expect(new Uint8Array(await imported.assets[0].blob.arrayBuffer())).toEqual(bytes)
    const serialized = JSON.parse(await blob.text())
    expect(serialized.schemaVersion).toBe(1)
    expect(serialized.assets[0]).not.toHaveProperty('buffer')
    expect(serialized.assets[0]).not.toHaveProperty('peaks')
  })

  it('exports MIDI-only projects without requiring audio files or IndexedDB', async () => {
    const project = createEmptyProject()
    expect(await importProjectBundle(await exportProjectBundle(project, new Map()))).toEqual({ project, assets: [] })
  })

  it('refuses to save or export a project when its source audio is missing', async () => {
    const { project } = audioFixture()
    await expect(exportProjectBundle(project, new Map())).rejects.toThrow(/original audio file/)
    await expect(saveProject(project, new Map())).rejects.toThrow(/original audio file/)
  })

  it('rejects a damaged bundle without returning a partially recovered project', async () => {
    const { project, assets } = audioFixture()
    const original = JSON.parse(await (await exportProjectBundle(project, assets)).text())
    await expect(importProjectBundle(new Blob(['{not json']))).rejects.toThrow(/readable/)
    await expect(importProjectBundle(new Blob([JSON.stringify({ ...original, schemaVersion: 9 })]))).rejects.toThrow(/version/)
    await expect(importProjectBundle(new Blob([JSON.stringify({ ...original, assets: [] })]))).rejects.toThrow(/original audio file/)
    const broken = structuredClone(original)
    broken.assets[0].dataBase64 = 'not@base64'
    await expect(importProjectBundle(new Blob([JSON.stringify(broken)]))).rejects.toThrow(/base64/)
    broken.assets[0] = { ...original.assets[0], byteLength: 5 }
    await expect(importProjectBundle(new Blob([JSON.stringify(broken)]))).rejects.toThrow(/incomplete or damaged/)
  })

  it('rejects duplicate asset IDs instead of silently picking a different recording', async () => {
    const { project, assets } = audioFixture()
    const original = JSON.parse(await (await exportProjectBundle(project, assets)).text())
    original.assets.push(original.assets[0])
    await expect(importProjectBundle(new Blob([JSON.stringify(original)]))).rejects.toThrow(/duplicate audio asset/)
  })
})

describe('local storage failure handling', () => {
  it('reports unavailable storage and continues to allow a portable export', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const project = createEmptyProject()
    await expect(saveProject(project, new Map())).rejects.toThrow(/storage is unavailable/)
    await expect(loadProject()).rejects.toThrow(/storage is unavailable/)
    await expect(exportProjectBundle(project, new Map())).resolves.toBeInstanceOf(Blob)
  })
})

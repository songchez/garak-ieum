import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb'
import { resetAutosaveValidation } from './autosave'
import { createDemoProject, createTrack, uid, validateProject } from './project'
import { loadProject, saveProject } from './storage'
import type { AudioAsset, AudioClip, MidiClip, Project, Track } from './types'

/**
 * Autosave cost after a single note edit on a large project (32 tracks, ~66k notes, 4 audio clips with 4 MB originals).
 * Opt-in: `GARAK_AUTOSAVE_BENCH=1 pnpm vitest run src/core/autosaveBenchmark.test.ts`. fake-indexeddb structured-clones
 * every put like a browser does, so bytes are exact and times are indicative (a real IndexedDB also hits disk).
 */
const enabled = !!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.GARAK_AUTOSAVE_BENCH

function largeProject(): { project: Project; assets: Map<string, AudioAsset> } {
  const demo = createDemoProject()
  const tracks: Track[] = []
  const sources = demo.tracks.filter(track => track.clips.some(clip => clip.kind === 'midi'))
  for (let i = 0; i < 28; i++) {
    const src = sources[i % sources.length]
    const clips: MidiClip[] = []
    for (let r = 0; r < 36; r++) for (const c of src.clips) {
      if (c.kind !== 'midi') continue
      const notes = []
      for (let d = 0; d < 2; d++) for (const n of c.notes) notes.push({ ...n, id: uid(), start: Math.min(c.lengthBeats - 0.01, n.start + d * 0.01) })
      clips.push({ ...c, id: uid(), startBeat: c.startBeat + r * 32, notes })
    }
    tracks.push({ ...src, id: uid(), clips, devices: [] })
  }
  const assets = new Map<string, AudioAsset>()
  for (let i = 0; i < 4; i++) {
    const track = createTrack('audio')
    const assetId = `take-${i}`
    const clip: AudioClip = { id: uid(), kind: 'audio', name: `take ${i}`, startBeat: i * 16, lengthBeats: 16, gain: 1, assetId, offsetSeconds: 0, fadeIn: 0, fadeOut: 0 }
    track.clips = [clip]
    tracks.push(track)
    const bytes = new Uint8Array(4 * 1024 * 1024).map((_, index) => (index * 31 + i) & 255)
    assets.set(assetId, { id: assetId, name: `take-${i}.wav`, blob: new Blob([bytes], { type: 'audio/wav' }), buffer: {} as AudioBuffer, peaks: [] })
  }
  return { project: { ...demo, tracks, lengthBeats: 36 * 32, loop: { enabled: false, startBeat: 0, endBeat: 32 } }, assets }
}

/** The same structural-sharing update ProjectSession makes for one note velocity change. */
function editOneNote(project: Project, trackIndex: number, clipIndex: number, velocity: number): Project {
  return {
    ...project,
    tracks: project.tracks.map((track, t) => t !== trackIndex ? track : {
      ...track,
      clips: track.clips.map((clip, c) => c !== clipIndex || clip.kind !== 'midi' ? clip : { ...clip, notes: clip.notes.map((note, n) => n === 0 ? { ...note, velocity } : note) }),
    }),
  }
}

let written = { bytes: 0, blobBytes: 0, puts: 0, deletes: 0 }
function size(value: unknown): number {
  let blobs = 0
  const json = JSON.stringify(value, (_key, item) => {
    if (item instanceof Blob) { blobs += item.size; return null }
    return item
  })
  written.blobBytes += blobs
  return (json?.length ?? 0) + blobs
}

beforeEach(() => {
  resetAutosaveValidation()
  vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  const put = IDBObjectStore.prototype.put
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) { written.puts++; written.bytes += size(args[0]); return put.apply(this, args) })
  const remove = IDBObjectStore.prototype.delete
  vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, ...args) { written.deletes++; return remove.apply(this, args) })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`

describe.skipIf(!enabled)('autosave benchmark', () => {
  it('measures bytes and time per autosave after a single note edit', { timeout: 300_000 }, async () => {
    const { project, assets } = largeProject()
    const notes = project.tracks.reduce((sum, track) => sum + track.clips.reduce((n, clip) => n + (clip.kind === 'midi' ? clip.notes.length : 0), 0), 0)
    const clips = project.tracks.reduce((sum, track) => sum + track.clips.length, 0)
    const measure = async (label: string, run: () => Promise<unknown>) => {
      written = { bytes: 0, blobBytes: 0, puts: 0, deletes: 0 }
      const started = performance.now()
      await run()
      const ms = performance.now() - started
      console.info(`${label}: ${ms.toFixed(1)} ms, ${written.puts} puts, ${written.deletes} deletes, ${written.bytes > 1024 * 1024 ? mb(written.bytes) : kb(written.bytes)} written (${mb(written.blobBytes)} audio)`)
      return { ms, ...written }
    }
    console.info(`project: ${project.tracks.length} tracks, ${clips} clips, ${notes} notes, ${assets.size} audio originals (${mb([...assets.values()].reduce((s, a) => s + a.blob.size, 0))})`)
    await measure('initial save (validated)', () => saveProject(project, assets, { trusted: true }))
    let current = project
    const edits: { ms: number; bytes: number }[] = []
    for (let i = 0; i < 10; i++) {
      current = editOneNote(current, 3 + (i % 5), 7 + i, 0.4 + i / 100)
      edits.push(await measure(`note edit ${i + 1} (trusted autosave)`, () => saveProject(current, assets, { trusted: true })))
    }
    const steady = edits.slice(1)
    console.info(`steady note-edit autosave: mean ${(steady.reduce((s, e) => s + e.ms, 0) / steady.length).toFixed(1)} ms, ${kb(steady.reduce((s, e) => s + e.bytes, 0) / steady.length)} per save`)
    current = editOneNote(current, 9, 2, 0.99)
    resetAutosaveValidation()
    await measure('note edit with periodic full validation', () => saveProject(current, assets, { trusted: true }))
    await measure('explicit save (navigation, untrusted)', () => saveProject(current, assets))
    let loaded: Awaited<ReturnType<typeof loadProject>> = null
    await measure('load', async () => { loaded = await loadProject(project.id) })
    expect(loaded!.project.tracks.length).toBe(32)
    // A reopened session: fresh objects (ProjectSession reset validates again, the engine re-wraps original Blobs).
    const reopened = validateProject(loaded!.project)
    const rewrapped = new Map([...assets].map(([id, asset]) => [id, { ...asset, blob: new Blob([asset.blob], { type: asset.blob.type }) }]))
    resetAutosaveValidation()
    await measure('first autosave after reopening', () => saveProject(reopened, rewrapped, { trusted: true }))
    const next = editOneNote(reopened, 4, 1, 0.5)
    await measure('next note edit after reopening', () => saveProject(next, rewrapped, { trusted: true }))
  })
})

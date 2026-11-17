import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { AUTOSAVE_MAX_DELAY_MS, AUTOSAVE_MIN_DELAY_MS, FULL_VALIDATION_INTERVAL_MS, assertProjectInvariants, autosaveDelay, autosaveSnapshot, resetAutosaveValidation } from './autosave'
import { createDemoProject, createEmptyProject, createTrack, uid } from './project'
import { loadProject, saveProject } from './storage'
import type { Project, Track } from './types'

beforeEach(() => { resetAutosaveValidation(); vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const edited = (project: Project, patch: Partial<Project>): Project => ({ ...project, ...patch })

function large(): Project {
  const demo = createDemoProject()
  const tracks: Track[] = []
  for (let i = 0; i < 32; i++) {
    const src = demo.tracks[i % demo.tracks.length]
    const clips = []
    for (let r = 0; r < 32; r++) for (const c of src.clips) {
      if (c.kind !== 'midi') continue
      const notes = []
      for (let d = 0; d < 2; d++) for (const n of c.notes) notes.push({ ...n, id: uid(), start: Math.min(c.lengthBeats - 0.01, n.start + d * 0.01) })
      clips.push({ ...c, id: uid(), startBeat: c.startBeat + r * 32, notes })
    }
    tracks.push({ ...src, id: uid(), clips, devices: [] })
  }
  return { ...demo, tracks, lengthBeats: 32 * 32, loop: { enabled: false, startBeat: 0, endBeat: 32 } }
}

describe('autosave debounce', () => {
  it('waits longer after slow saves, within bounds', () => {
    expect(autosaveDelay(0)).toBe(AUTOSAVE_MIN_DELAY_MS)
    expect(autosaveDelay(Number.NaN)).toBe(AUTOSAVE_MIN_DELAY_MS)
    expect(autosaveDelay(5)).toBe(700)
    expect(autosaveDelay(75)).toBe(1400)
    expect(autosaveDelay(10_000)).toBe(AUTOSAVE_MAX_DELAY_MS)
  })
})

describe('autosave validation policy', () => {
  it('validates untrusted snapshots every time and trusted ones at most once per interval', () => {
    const project = createEmptyProject()
    expect(autosaveSnapshot(project, false, 0).validated).toBe(true)
    expect(autosaveSnapshot(project, false, 1).validated).toBe(true)
    resetAutosaveValidation()
    // The first trusted save of a session is fully validated (and refreshes the recovery copy)...
    expect(autosaveSnapshot(project, true, 1000).validated).toBe(true)
    // ...later ones write the session snapshot itself, after the cheap check.
    const next = edited(project, { name: 'next' })
    const quick = autosaveSnapshot(next, true, 2000)
    expect(quick).toEqual({ project: next, validated: false })
    expect(autosaveSnapshot(next, true, 1000 + FULL_VALIDATION_INTERVAL_MS).validated).toBe(true)
  })

  it('still rejects a structurally broken trusted snapshot', () => {
    const project = createEmptyProject()
    autosaveSnapshot(project, true, 0)
    const track = createTrack('instrument')
    expect(() => autosaveSnapshot(edited(project, { tracks: [track, { ...track }] }), true, 1)).toThrow(/track id/)
    expect(() => autosaveSnapshot(edited(project, { loop: { enabled: true, startBeat: 4, endBeat: 2 } }), true, 1)).toThrow(/loop/)
    expect(() => assertProjectInvariants(edited(project, { bpm: Number.NaN }))).toThrow(/bpm/)
    const clip = { id: 'c', kind: 'midi' as const, name: 'c', startBeat: -1, lengthBeats: 4, gain: 1, notes: [] }
    expect(() => assertProjectInvariants(edited(project, { tracks: [{ ...track, clips: [clip] }] }))).toThrow(/clip position/)
  })

  it('skips the 66k-note validation on trusted autosaves (cheap check, a fraction of full validation)', () => {
    const project = large()
    autosaveSnapshot(project, true, 0)
    const next = edited(project, { name: 'x' })
    const t0 = performance.now()
    for (let i = 0; i < 20; i++) autosaveSnapshot(next, true, 1)
    const trusted = (performance.now() - t0) / 20
    const t1 = performance.now()
    autosaveSnapshot(next, false, 2)
    const full = performance.now() - t1
    console.info(`autosave snapshot, 66k notes: full validation ${full.toFixed(1)} ms, trusted check ${trusted.toFixed(3)} ms`)
    // Relative bound: shared CI runners are slower and noisier than a desktop (macOS measured 2.45 ms against a 2 ms cap).
    expect(trusted).toBeLessThan(full / 4)
    expect(trusted).toBeLessThan(10)
  })
})

describe('autosave storage', () => {
  it('saves trusted snapshots, and opens the last validated copy if the latest autosave fails validation', async () => {
    const project = createEmptyProject()
    await saveProject(project, new Map(), { trusted: true })
    // A trusted snapshot passes the cheap check but is not valid (an impossible track color).
    const broken = edited(project, { name: 'broken edit', tracks: [{ ...createTrack('instrument'), color: 'not-a-color' }] })
    await saveProject(broken, new Map(), { trusted: true })
    const loaded = await loadProject(project.id)
    expect(loaded?.recovered).toBe(true)
    expect(loaded?.project.name).toBe(project.name)
    // A valid latest autosave opens normally.
    const fine = edited(project, { name: 'fine' })
    await saveProject(fine, new Map(), { trusted: true })
    expect(await loadProject(project.id)).toMatchObject({ project: { name: 'fine' } })
    expect((await loadProject(project.id))?.recovered).toBeUndefined()
  })

  it('an untrusted save still refuses an invalid project and keeps the previous one', async () => {
    const project = createEmptyProject()
    await saveProject(project, new Map())
    await expect(saveProject(edited(project, { tracks: [{ ...createTrack('instrument'), color: 'bad' }] }), new Map())).rejects.toThrow()
    expect((await loadProject(project.id))?.project).toEqual(project)
  })
})

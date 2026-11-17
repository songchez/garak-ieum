import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { AUTOSAVE_MAX_PENDING_MS, AUTOSAVE_MIN_DELAY_MS, AutosaveScheduler, resetAutosaveValidation } from './autosave'
import { EFFECT_DEFS } from './devices'
import { createDevice, createEmptyProject, createGuitarTrack, createTrack, validateProject } from './project'
import { ProjectSession } from './ProjectSession'
import { loadProject, saveProject } from './storage'
import { GUITAR_RIG_PRESETS } from '../devices/guitar-rig/definition'
import type { EffectDevice, Project, Track } from './types'

describe('AutosaveScheduler', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })
  const scheduler = () => new AutosaveScheduler(AUTOSAVE_MAX_PENDING_MS, () => Date.now())

  it('waits for a quiet period and runs only the latest job', () => {
    const autosave = scheduler(), runs: string[] = []
    autosave.schedule(() => runs.push('a'), AUTOSAVE_MIN_DELAY_MS)
    vi.advanceTimersByTime(AUTOSAVE_MIN_DELAY_MS - 1)
    autosave.schedule(() => runs.push('b'), AUTOSAVE_MIN_DELAY_MS)
    vi.advanceTimersByTime(AUTOSAVE_MIN_DELAY_MS - 1)
    expect(runs).toEqual([])
    vi.advanceTimersByTime(1)
    expect(runs).toEqual(['b'])
    expect(autosave.pending).toBe(false)
  })

  it('a stream of edits (held controls, live monitor flags) cannot postpone the save past the ceiling', () => {
    const autosave = scheduler(), runs: number[] = []
    for (let t = 0; t < AUTOSAVE_MAX_PENDING_MS * 2; t += 100) {
      autosave.schedule(() => runs.push(t), AUTOSAVE_MIN_DELAY_MS)
      vi.advanceTimersByTime(100)
    }
    expect(runs.length).toBeGreaterThanOrEqual(2)
    expect(runs[0]).toBeLessThan(AUTOSAVE_MAX_PENDING_MS)
  })

  it('flush runs the pending job now; cancel drops it', () => {
    const autosave = scheduler(), runs: string[] = []
    expect(autosave.flush()).toBe(false)
    autosave.schedule(() => runs.push('now'), AUTOSAVE_MIN_DELAY_MS)
    expect(autosave.flush()).toBe(true)
    expect(runs).toEqual(['now'])
    vi.advanceTimersByTime(AUTOSAVE_MAX_PENDING_MS)
    expect(runs).toEqual(['now'])
    autosave.schedule(() => runs.push('dropped'), AUTOSAVE_MIN_DELAY_MS)
    autosave.cancel()
    vi.advanceTimersByTime(AUTOSAVE_MAX_PENDING_MS)
    expect(runs).toEqual(['now'])
  })
})

/**
 * The editor's autosave path end to end, without React: ProjectSession edits as the device editors make them (a preset,
 * a gesture on the mic position, the mic type, a footswitch, live monitor flags), the scheduler as App arms it on every
 * change, and the page going away before the quiet period ends. Before the fix the scheduler had no flush and the
 * project reopened from the last write before the burst, i.e. without the preset's follow-up edits.
 */
describe('device edits after a preset survive a reload', () => {
  beforeEach(() => { resetAutosaveValidation(); vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange) })
  afterEach(() => { vi.unstubAllGlobals() })

  type Params = Record<string, number>
  const deviceParams = (project: Project, trackId: string, deviceId: string): Params => (project.tracks.find(t => t.id === trackId)!.devices.find(d => d.id === deviceId) as EffectDevice).params

  function harness() {
    const guitar = createGuitarTrack()
    const synth = createTrack('instrument')
    synth.devices = [createDevice('eq'), createDevice('compressor')]
    const session = new ProjectSession(validateProject({ ...createEmptyProject(), tracks: [guitar, synth] }))
    const present = () => session.getSnapshot().history.present
    const autosave = new AutosaveScheduler()
    const writes: Promise<void>[] = []
    let persisted = present()
    const save = () => { const project = present(); writes.push(saveProject(project, new Map(), { trusted: true }).then(() => { persisted = project })) }
    // App: an effect re-arms the autosave after every published change.
    session.subscribe(() => { if (present() !== persisted) autosave.schedule(save, AUTOSAVE_MIN_DELAY_MS) })
    // App: onDeviceParam / onDeviceParams / onInstrumentParam (src/App.tsx).
    const editTrack = (id: string, edit: (t: Track) => Track, key = '', label?: string) => session.edit(p => ({ ...p, tracks: p.tracks.map(t => t.id === id ? edit(t) : t) }), key, label)
    const deviceEdit = (trackId: string, deviceId: string, params: Params, key = '') => editTrack(trackId, t => ({ ...t, devices: t.devices.map(d => d.id === deviceId && d.type !== 'vst3' ? { ...d, params: { ...d.params, ...params } } : d) }), key)
    const pageHide = async () => { autosave.flush(); await Promise.all(writes) }
    return { session, present, autosave, writes, deviceEdit, editTrack, pageHide, guitar: present().tracks[0], synth: present().tracks[1] }
  }

  it('guitar rig: preset, then mic position (key gesture), mic type and a footswitch', async () => {
    const h = harness(), rig = h.guitar.devices[0].id, track = h.guitar.id
    await h.pageHide()
    const wide = GUITAR_RIG_PRESETS.find(p => p.id === 'wide-clean')!
    h.deviceEdit(track, rig, { ...wide.params }, '')
    // RigRange: key down begins a gesture, each change edits, key up ends it.
    h.session.beginGesture('mic-range', '마이크 위치 조절')
    h.deviceEdit(track, rig, { micPosition: 0.9 }, `${track}:dev:${rig}:micPosition`)
    h.deviceEdit(track, rig, { micPosition: 1 }, `${track}:dev:${rig}:micPosition`)
    h.session.endGesture('mic-range')
    h.deviceEdit(track, rig, { micType: 3 }, `${track}:dev:${rig}:micType`)
    h.deviceEdit(track, rig, { chorusEnabled: 0 }, `${track}:dev:${rig}:chorusEnabled`)
    // Input monitoring on and off: live edits, each one a new snapshot that re-arms the timer.
    h.session.dispatch({ type: 'live', edit: p => ({ ...p, tracks: p.tracks.map(t => t.id === track ? { ...t, monitor: true } : t) }) })
    h.session.dispatch({ type: 'live', edit: p => ({ ...p, tracks: p.tracks.map(t => t.id === track ? { ...t, monitor: false } : t) }) })
    expect(h.autosave.pending).toBe(true)

    // Reload inside the quiet period: the page-hide flush writes the latest snapshot.
    await h.pageHide()
    const loaded = await loadProject()
    const params = deviceParams(loaded!.project, track, rig)
    expect(loaded!.recovered).toBeFalsy()
    expect(params).toMatchObject({ micPosition: 1, micType: 3, chorusEnabled: 0, micDistance: wide.params.micDistance, ampGain: wide.params.ampGain })
  })

  it('other device editors (EQ, 시김새 knobs, instrument editors) take the same path', async () => {
    const h = harness(), track = h.synth.id
    await h.pageHide()
    for (const device of h.synth.devices) {
      const def = EFFECT_DEFS[device.type as keyof typeof EFFECT_DEFS].params[0]
      const value = def.min + (def.max - def.min) * 0.75
      h.deviceEdit(track, device.id, { [def.id]: value }, `${track}:dev:${device.id}:${def.id}`)
    }
    const instrumentKey = Object.keys(h.synth.instrumentParams ?? {})[0]
    if (instrumentKey) h.editTrack(track, t => ({ ...t, instrumentParams: { ...t.instrumentParams, [instrumentKey]: (t.instrumentParams?.[instrumentKey] ?? 0) + 0.125 } }), `${track}:inst:${instrumentKey}`)
    const expected = h.present().tracks.find(t => t.id === track)!
    await h.pageHide()
    const saved = (await loadProject())!.project.tracks.find(t => t.id === track)!
    expect(saved.devices).toEqual(expected.devices)
    expect(saved.instrumentParams).toEqual(expected.instrumentParams)
  })
})

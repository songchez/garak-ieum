import { describe, expect, it } from 'vitest'
import { createDefaultWavetablePatch, combineWavetablePatch } from '../devices/wavetable-synth/model'
import { WAVE_LIMITS } from '../devices/wavetable-synth/definition'
import { createEmptyProject, createTrack, duplicateTrack, duplicateTrackSettings, validateProject, withInstrument, withWavetablePatch } from './project'
import { exportProjectBundle, importProjectBundle } from './storage'
import { ProjectSession } from './ProjectSession'
import type { DawCommand } from './commands'

function fixture() {
  const patch = createDefaultWavetablePatch()
  patch.metadata.name = '직접 그린 파형'
  patch.customBanks = [{ slot: 4, name: 'My wave', frames: [Array.from({ length: WAVE_LIMITS.frameSize }, (_, i) => Math.sin(i * 2 * Math.PI / WAVE_LIMITS.frameSize))] }]
  patch.params.osc1Bank = 4
  patch.params.macro1 = 0.3
  patch.lfoCurves[0][12] = 0.15
  patch.routes = [{ id: 'my-motion', enabled: true, source: 'lfo1', destination: 'osc1Position', amount: 0.4, bipolar: true, aux: 'macro1', curve: 0.2 }]
  const track = withWavetablePatch(createTrack('instrument', 'wavetable'), patch)
  return { patch, track, project: { ...createEmptyProject(), tracks: [track] } }
}

function execute(session: ProjectSession, commands: DawCommand[], operationId: string) {
  const { history, revision } = session.getSnapshot()
  return session.execute({ projectId: history.present.id, expectedRevision: revision, operationId, commands })
}

describe('IEUM WAVE project integration', () => {
  it('round trips drawn frames, modulation, metadata and scalar values in a real project bundle', async () => {
    const { patch, track, project } = fixture()
    expect(track.instrumentState).not.toHaveProperty('params')
    const file = await exportProjectBundle(project, new Map())
    const loaded = (await importProjectBundle(file)).project
    expect(loaded).toEqual(project)
    expect(combineWavetablePatch(loaded.tracks[0].instrumentParams, loaded.tracks[0].instrumentState)).toEqual(patch)
    expect(loaded.tracks[0].instrumentState!.customBanks[0].frames[0]).not.toBe(track.instrumentState!.customBanks[0].frames[0])
  })

  it.each([duplicateTrack, duplicateTrackSettings])('copies all editable sound data without linking the copies', duplicate => {
    const { track } = fixture()
    const copied = duplicate(track)
    expect(copied.instrumentState).toEqual(track.instrumentState)
    copied.instrumentParams.macro1 = 0.9
    copied.instrumentState!.customBanks[0].frames[0][0] = 0.8
    copied.instrumentState!.lfoCurves[0][12] = 0.9
    copied.instrumentState!.routes[0].amount = -0.3
    copied.instrumentState!.metadata.name = 'Copy'
    expect(track.instrumentParams.macro1).toBe(0.3)
    expect(track.instrumentState!.customBanks[0].frames[0][0]).toBe(0)
    expect(track.instrumentState!.lfoCurves[0][12]).toBe(0.15)
    expect(track.instrumentState!.routes[0].amount).toBe(0.4)
    expect(track.instrumentState!.metadata.name).toBe('직접 그린 파형')
  })

  it('changes an instrument atomically and restores the previous custom sound through project undo', () => {
    const { track, project } = fixture()
    const session = new ProjectSession(project)
    session.dispatch({ type: 'edit', merge: false, label: '악기 변경', edit: p => ({ ...p, tracks: [withInstrument(p.tracks[0], 'keys')] }) })
    const keys = session.getSnapshot().history.present.tracks[0]
    expect(keys.instrument).toBe('keys')
    expect(keys).not.toHaveProperty('instrumentState')
    session.dispatch({ type: 'undo' })
    expect(session.getSnapshot().history.present.tracks[0]).toEqual(track)
    const reset = withInstrument(keys, 'wavetable')
    expect(reset.instrumentState!.customBanks).toEqual([])
    expect(reset.instrumentParams.osc1Bank).toBe(0)
  })

  it('rejects instrument state on unrelated instruments and validates bank references', () => {
    const { track, project } = fixture()
    expect(() => validateProject({ ...project, tracks: [{ ...track, instrument: 'keys' }] })).toThrow(/instrument state/)
    expect(() => validateProject({ ...project, tracks: [{ ...track, kind: 'audio' }] })).toThrow(/instrument state/)
    expect(() => validateProject({ ...project, tracks: [{ ...track, instrumentState: { ...track.instrumentState, customBanks: [] } }] })).toThrow()
    expect(validateProject({ ...createEmptyProject(), tracks: [{ ...createTrack('instrument', 'wavetable'), instrumentState: undefined }] }).tracks[0].instrumentState?.version).toBe(1)
  })

  it('changes a native parameter through the MCP command path, preserving all structural state and shared undo', () => {
    const { track, project } = fixture()
    const session = new ProjectSession(project)
    execute(session, [{ type: 'instrument.setParam', trackId: track.id, paramId: 'macro1', value: 0.7 }], 'wave-param')
    const edited = session.getSnapshot().history.present.tracks[0]
    expect(edited.instrumentParams.macro1).toBe(0.7)
    expect(edited.instrumentState).toEqual(track.instrumentState)
    session.dispatch({ type: 'undo' })
    expect(session.getSnapshot().history.present.tracks[0].instrumentParams.macro1).toBe(0.3)
    const before = session.getSnapshot()
    expect(() => execute(session, [{ type: 'instrument.setParam', trackId: track.id, paramId: 'osc1Bank', value: 7 }], 'missing-bank')).toThrow()
    expect(session.getSnapshot()).toBe(before)
    expect(() => execute(session, [{ type: 'instrument.setParam', trackId: track.id, paramId: 'madeUp', value: 1 }], 'bad-param')).toThrow()
    expect(() => execute(session, [{ type: 'instrument.setParam', trackId: track.id, paramId: 'osc1Unison', value: 1.5 }], 'fractional-unison')).toThrow()
  })
})

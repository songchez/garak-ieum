import { describe, expect, it } from 'vitest'
import type { NativePluginInstance } from '../audio/native/contracts'
import type { Device, PluginDevice } from './types'
import { MAX_PLUGIN_STATE_BYTES } from '../audio/native/contracts'
import { compileNativeTimeline } from '../audio/native/timeline'
import { createDevice, createEmptyProject, createTrack, duplicateTrack, duplicateTrackSettings, validateProject } from './project'
import { validateNativePluginState } from './nativePlugins'

const plugin = (id = 'plugin'): NativePluginInstance => ({ id, pluginId: 'trusted:catalog:module', classId: '0123456789abcdef0123456789abcdef', name: 'VST3 Instrument', enabled: true, parameters: { '0': .25, '4294967295': 1 }, state: { component: 'AQID', controller: 'BA==' } })
const fx = (id = 'fx'): PluginDevice => ({ ...plugin(id), type: 'vst3' })
function project() {
  const track = { ...createTrack('instrument', 'keys'), id: 'track', pluginInstrument: plugin(), devices: [fx()] as Device[] }
  return { ...createEmptyProject(), id: 'project', tracks: [track] }
}
const insert = (track: { devices: Device[] }, index = 0) => track.devices[index] as PluginDevice

describe('schema 7 native plugin persistence', () => {
  it('round-trips catalog IDs, separate component/controller state and normalized parameters without executable paths', () => {
    const raw = project(), normalized = validateProject(JSON.parse(JSON.stringify(raw)))
    expect(normalized.schemaVersion).toBe(8)
    expect(normalized.tracks[0].pluginInstrument).toEqual({ ...raw.tracks[0].pluginInstrument, classId: raw.tracks[0].pluginInstrument.classId.toUpperCase() })
    expect(insert(normalized.tracks[0])).toMatchObject({ type: 'vst3', state: { component: 'AQID', controller: 'BA==' } })
    expect(JSON.stringify(normalized)).not.toContain('path')
  })

  it('migrates schema 5 projects while preserving their exact meter and rejects hidden VST data under an old schema', () => {
    const old = { ...createEmptyProject(), schemaVersion: 5, timeSignature: { numerator: 7, denominator: 8 }, beatsPerBar: 3.5 }
    expect(validateProject(old)).toMatchObject({ schemaVersion: 8, timeSignature: { numerator: 7, denominator: 8 }, beatsPerBar: 3.5 })
    const { devices: _devices, ...sourceOnly } = project().tracks[0]
    expect(() => validateProject({ ...project(), schemaVersion: 5, tracks: [{ ...sourceOnly, devices: [] }] })).toThrow('schema version 6')
    expect(() => validateProject({ ...project(), schemaVersion: 6 })).toThrow('unknown effect type')
    expect(() => validateProject({ ...project(), schemaVersion: 9 })).toThrow()
  })

  it.each(['path', 'modulePath', 'executable', 'unknown'])('rejects executable or unknown plugin field %s instead of passing it through', field => {
    const raw = project()
    Object.assign(raw.tracks[0].pluginInstrument, { [field]: '/untrusted/module.vst3' })
    expect(() => validateProject(raw)).toThrow('unsupported plugin field')
  })

  it('rejects plugin ID reuse across tracks, inserts, notes and builtin devices', () => {
    const raw = project(); insert(raw.tracks[0]).id = raw.tracks[0].pluginInstrument.id
    expect(() => validateProject(raw)).toThrow(/duplicate/i)
    const builtin = project(); builtin.tracks[0].devices = [{ ...createDevice('delay'), id: 'plugin' }]
    expect(() => validateProject(builtin)).toThrow(/duplicate/i)
    const audio = { ...createEmptyProject(), tracks: [{ ...createTrack('audio'), pluginInstrument: plugin() }] }
    expect(() => validateProject(audio)).toThrow('audio track')
  })

  it.each([NaN, Infinity, -.1, 1.1, '0.3'])('rejects invalid normalized parameter %s', value => {
    const raw = project(); Object.assign(raw.tracks[0].pluginInstrument.parameters, { '1': value })
    expect(() => validateProject(raw)).toThrow('normalized plugin parameter')
  })

  it('bounds and validates opaque state without interpreting plugin-owned bytes', () => {
    expect(validateNativePluginState({ component: '', controller: 'AA==' })).toEqual({ component: '', controller: 'AA==' })
    for (const value of ['A', '###=', 'AA=A', 'AA===', 32]) expect(() => validateNativePluginState({ component: value })).toThrow('base64')
    expect(() => validateNativePluginState({ component: '', executable: '/tmp/bad' })).toThrow('Unknown')
    expect(() => validateNativePluginState({ component: 'A'.repeat(Math.ceil(MAX_PLUGIN_STATE_BYTES / 3) * 4 + 4) })).toThrow('base64')
  })

  it('deep-copies state and assigns fresh instance IDs when duplicating a track or its settings', () => {
    const original = project().tracks[0]
    for (const copy of [duplicateTrack(original), duplicateTrackSettings(original)]) {
      expect(copy.pluginInstrument?.id).not.toBe(original.pluginInstrument.id)
      expect(copy.devices[0].id).not.toBe(original.devices[0].id)
      expect(copy.pluginInstrument?.state).toEqual(original.pluginInstrument.state)
      expect(copy.pluginInstrument?.state).not.toBe(original.pluginInstrument.state)
      expect(insert(copy).parameters).not.toBe(insert(original).parameters)
      expect(insert(copy).state).not.toBe(insert(original).state)
      expect(() => validateProject({ ...createEmptyProject(), tracks: [original, copy] })).not.toThrow()
    }
  })

  it('bounds the combined builtin and VST insert count', () => {
    const raw = project()
    raw.tracks[0].devices = [...Array.from({ length: 64 }, () => createDevice('filter')), fx()]
    expect(() => validateProject(raw)).toThrow('at most 64')
  })

  it('compiles VST note scheduling, state and an interleaved insert chain as independent control snapshots', () => {
    const raw = project(); raw.bpm = 120; raw.sampleRate = 48000
    raw.tracks[0].devices = [createDevice('filter'), fx(), createDevice('reverb')]
    raw.tracks[0].clips = [{ id: 'clip', kind: 'midi', name: 'Phrase', startBeat: 1, lengthBeats: 4, gain: 1, notes: [{ id: 'note', start: 0, duration: 1, pitch: 60, velocity: .75 }] }]
    const normalized = validateProject(raw), compiled = compileNativeTimeline(normalized)
    expect(compiled.tracks[0].source).toMatchObject({ kind: 'vst3', plugin: { id: 'plugin', state: { component: 'AQID' } } })
    expect(compiled.tracks[0].inserts.map(insert => insert.type)).toEqual(['filter', 'vst3', 'reverb'])
    expect(compiled.tracks[0].inserts[1]).not.toHaveProperty('plugin.type')
    expect(compiled.tracks[0].notes).toMatchObject([{ onFrame: 24000, offFrame: 48000, pitch: 60 }])
    normalized.tracks[0].pluginInstrument!.parameters['0'] = .9
    normalized.tracks[0].pluginInstrument!.state!.component = 'BQ=='
    insert(normalized.tracks[0], 1).parameters['0'] = 0
    expect(compiled.tracks[0].source).toMatchObject({ plugin: { parameters: { '0': .25 }, state: { component: 'AQID' } } })
    expect(compiled.tracks[0].inserts[1]).toMatchObject({ params: { '0': .25 }, plugin: { parameters: { '0': .25 } } })
  })
})

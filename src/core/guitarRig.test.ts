import { describe, expect, it } from 'vitest'
import { EFFECT_DEFS } from './devices'
import { ProjectSession } from './ProjectSession'
import { createDevice, createEmptyProject, createGuitarTrack, validateProject } from './project'
import { exportProjectBundle, importProjectBundle } from './storage'
import type { AudioAsset, AudioClip, EffectDevice } from './types'

const definitions = EFFECT_DEFS['guitar-rig'].params
const editedParams = () => Object.fromEntries(definitions.map(def => [
  def.id, def.options?.at(-1)?.value ?? def.min + (def.max - def.min) * 0.37,
]))

describe('built-in guitar rig project integration', () => {
  it('creates independent audio tracks with the rig and leaves input activation to the user', () => {
    const first = createGuitarTrack(), second = createGuitarTrack()
    expect(first).toMatchObject({ kind: 'audio', icon: 'guitar', monitor: false, armed: false })
    expect(first.devices).toHaveLength(1)
    expect(first.devices[0]).toMatchObject({ type: 'guitar-rig', enabled: true })
    expect(first.id).not.toBe(second.id)
    expect(first.devices[0].id).not.toBe(second.devices[0].id)
    expect((first.devices[0] as EffectDevice).params).not.toBe((second.devices[0] as EffectDevice).params)
    const project = { ...createEmptyProject(), tracks: [first, second] }
    expect(validateProject(JSON.parse(JSON.stringify(project)))).toEqual(project)
  })

  it('preserves every rig setting and bypass in a portable project without altering the dry source', async () => {
    const track = createGuitarTrack()
    track.devices[0] = { ...(track.devices[0] as EffectDevice), enabled: false, params: editedParams() }
    const clip: AudioClip = {
      id: 'dry-take', kind: 'audio', name: 'Guitar DI', assetId: 'dry-source',
      startBeat: 0, lengthBeats: 4, gain: 1, offsetSeconds: 0, fadeIn: 0, fadeOut: 0,
    }
    track.clips = [clip]
    const project = { ...createEmptyProject(), tracks: [track] }
    const bytes = new Uint8Array([82, 73, 70, 70, 0, 1, 17, 255])
    const source: AudioAsset = {
      id: 'dry-source', name: 'original-di.wav', blob: new Blob([bytes], { type: 'audio/wav' }),
      buffer: {} as AudioBuffer, peaks: [],
    }
    const imported = await importProjectBundle(await exportProjectBundle(project, new Map([[source.id, source]])))
    expect(imported.project).toEqual(project)
    expect(imported.assets).toHaveLength(1)
    expect(new Uint8Array(await imported.assets[0].blob.arrayBuffer())).toEqual(bytes)
  })

  it('fills missing settings, discards unknown keys, and rejects invalid knob and selector values', () => {
    const track = createGuitarTrack()
    ;(track.devices[0] as EffectDevice).params = { unused: 99 }
    const project = { ...createEmptyProject(), tracks: [track] }
    const restored = validateProject(project)
    expect((restored.tracks[0].devices[0] as EffectDevice).params).toEqual(createDevice('guitar-rig').params)
    for (const def of definitions) {
      ;(track.devices[0] as EffectDevice).params = { [def.id]: def.max + 1 }
      expect(() => validateProject(project)).toThrow(def.id)
      if (def.options) {
        ;(track.devices[0] as EffectDevice).params = { [def.id]: def.min + 0.123 }
        expect(() => validateProject(project)).toThrow(def.id)
      }
    }
  })

  it('accepts the complete parameter set through the shared command API and restores it with undo', () => {
    const track = createGuitarTrack()
    track.devices = []
    const project = { ...createEmptyProject(), tracks: [track] }
    const session = new ProjectSession(project)
    session.execute({
      projectId: project.id, expectedRevision: 0, operationId: 'add-guitar-rig',
      commands: [{ type: 'effect.add', trackId: track.id, effectType: 'guitar-rig', params: editedParams() }],
    })
    const added = session.getSnapshot().history.present
    expect((added.tracks[0].devices[0] as EffectDevice).params).toEqual(editedParams())
    expect(validateProject(added)).toEqual(added)
    session.dispatch({ type: 'undo' })
    expect(session.getSnapshot().history.present.tracks[0].devices).toEqual([])
    session.dispatch({ type: 'redo' })
    expect(session.getSnapshot().history.present).toEqual(added)
  })
})

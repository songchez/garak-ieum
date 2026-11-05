import { describe, expect, it } from 'vitest'
import { createEmptyProject, createTrack, duplicateTrack, duplicateTrackSettings, validateProject } from './project'
import { ProjectSession } from './ProjectSession'
import { DomainError, parseCommand } from './commands'
import { applyTrackInputs, numberedInputChoices, planInputRemap } from './trackInputs'
import { monitorModeOf } from './trackActions'
import type { InputChoice, Project, Track } from './types'

function project(...tracks: Track[]): Project {
  const value = createEmptyProject(); value.id = 'p'
  value.tracks = tracks
  return value
}
function audio(id: string, patch: Partial<Track> = {}): Track { return { ...createTrack('audio'), id, name: id, ...patch } }
const roundTrip = (value: unknown) => validateProject(JSON.parse(JSON.stringify(value)))

describe('schema 8 track input and monitor mode', () => {
  it('validates and saves input channels, label and mode', () => {
    const loaded = roundTrip(project(
      audio('mono', { input: { channels: [3], label: 'Mic/Inst 4' }, monitorMode: 'auto' }),
      audio('stereo', { input: { channels: [7, 2] }, monitorMode: 'in', monitor: true }),
    ))
    expect(loaded.schemaVersion).toBe(8)
    expect(loaded.tracks[0]).toMatchObject({ input: { channels: [3], label: 'Mic/Inst 4' }, monitorMode: 'auto', monitor: false })
    expect(loaded.tracks[1]).toMatchObject({ input: { channels: [7, 2] }, monitorMode: 'in', monitor: true })
    expect(loaded.tracks[1].input).not.toHaveProperty('label')
  })

  it('makes a saved mode authoritative over the legacy I flag', () => {
    expect(roundTrip(project(audio('a', { monitorMode: 'off', monitor: true }))).tracks[0].monitor).toBe(false)
    expect(roundTrip(project(audio('a', { monitorMode: 'in', monitor: false }))).tracks[0].monitor).toBe(true)
  })

  it.each([
    [{ channels: [] }, /one or two/], [{ channels: [0, 1, 2] }, /one or two/], [{ channels: [1, 1] }, /different/],
    [{ channels: [1.5] }, /integer/], [{ channels: [256] }, /between 0 and 255/], [{ channels: [-1] }, /between 0 and 255/],
    [{ channels: ['1'] }, /finite number/], [{}, /one or two/], [[0], /object/],
    [{ channels: [0], label: '' }, /label/], [{ channels: [0], label: 'x'.repeat(129) }, /label/],
  ])('rejects input %j', (input, message) => {
    expect(() => roundTrip(project(audio('a', { input: input as never })))).toThrow(message)
  })

  it('rejects unknown modes, inputs on instrument tracks, and schema 8 fields in older files', () => {
    expect(() => roundTrip(project(audio('a', { monitorMode: 'always' as never })))).toThrow(/off, auto or in/)
    expect(() => roundTrip(project({ ...createTrack('instrument'), id: 'i', input: { channels: [0] } }))).toThrow(/audio track/)
    expect(() => roundTrip({ ...project(audio('a', { input: { channels: [0] } })), schemaVersion: 7 })).toThrow(/schema version 8/)
    expect(() => roundTrip({ ...project(audio('a', { monitorMode: 'in' })), schemaVersion: 7 })).toThrow(/schema version 8/)
  })

  it('loads schema 7 tracks unchanged: default input and a mode derived from the I flag', () => {
    const legacy = { ...project(audio('on', { monitor: true }), audio('off')), schemaVersion: 7 }
    const loaded = roundTrip(legacy)
    expect(loaded.schemaVersion).toBe(8)
    expect(loaded.tracks.map(track => [track.input, track.monitorMode, monitorModeOf(track)])).toEqual([[undefined, undefined, 'in'], [undefined, undefined, 'auto']])
  })

  it('copies inputs into duplicates without sharing arrays; settings copies drop the I flag', () => {
    const source = audio('a', { input: { channels: [0, 1], label: 'Main' }, monitorMode: 'in', monitor: true, armed: true })
    const content = duplicateTrack(source), settings = duplicateTrackSettings(source)
    expect(content.input).toEqual(source.input)
    expect(content.input!.channels).not.toBe(source.input!.channels)
    expect(settings).toMatchObject({ input: { channels: [0, 1], label: 'Main' }, armed: false, monitor: false, monitorMode: 'off' })
    expect(duplicateTrackSettings(audio('b', { monitorMode: 'auto' })).monitorMode).toBe('auto')
  })
})

describe('numberedInputChoices (browser)', () => {
  it('numbers mono channels and adjacent pairs', () => {
    expect(numberedInputChoices(0)).toEqual([])
    expect(numberedInputChoices(1)).toEqual([{ channels: [0], label: '입력 1' }])
    expect(numberedInputChoices(3).map(choice => choice.label)).toEqual(['입력 1', '입력 2', '입력 3', '입력 1/2'])
  })
})

describe('planInputRemap (missing inputs on other hardware)', () => {
  const choices: InputChoice[] = [
    { channels: [0], label: 'Mic 1' }, { channels: [1], label: 'Mic 2' }, { channels: [4], label: 'Guitar DI' },
    { channels: [0, 1], label: 'Mic 1/2' }, { channels: [6, 7], label: 'Synth' },
  ]

  it('keeps present inputs, re-finds moved ones by name, and reports the rest', () => {
    const p = project(
      audio('same', { input: { channels: [1], label: 'Mic 2' } }),
      audio('unnamed', { input: { channels: [0] } }),
      audio('moved', { input: { channels: [2], label: 'Guitar DI' } }),
      audio('moved-stereo', { input: { channels: [2, 3], label: 'Synth' } }),
      audio('renamed', { input: { channels: [0], label: 'Vocal' } }),
      audio('missing', { input: { channels: [9], label: 'Talkback' } }),
      audio('default'),
    )
    expect(planInputRemap(p, choices)).toEqual({
      relinked: [
        { trackId: 'moved', input: { channels: [4], label: 'Guitar DI' } },
        { trackId: 'moved-stereo', input: { channels: [6, 7], label: 'Synth' } },
      ],
      missing: ['missing'],
    })
  })

  it('reports nothing while the engine does not know its inputs', () => {
    expect(planInputRemap(project(audio('a', { input: { channels: [9] } })), [])).toEqual({ relinked: [], missing: [] })
  })

  it('applies every remap as one undoable edit', () => {
    const session = new ProjectSession(project(audio('a', { input: { channels: [9], label: 'Talkback' } }), audio('b', { input: { channels: [2], label: 'Guitar DI' } })))
    const before = session.getSnapshot().history.present
    session.edit(p => applyTrackInputs(p, [{ trackId: 'a', input: null }, { trackId: 'b', input: { channels: [4], label: 'Guitar DI' } }]), '', '입력 다시 연결')
    const after = session.getSnapshot().history.present
    expect(after.tracks[0]).not.toHaveProperty('input')
    expect(after.tracks[1].input).toEqual({ channels: [4], label: 'Guitar DI' })
    expect(session.getSnapshot().history.past).toHaveLength(1)
    session.dispatch({ type: 'undo' })
    expect(session.getSnapshot().history.present).toBe(before)
    expect(applyTrackInputs(before, [{ trackId: 'b', input: { channels: [2], label: 'Guitar DI' } }])).toBe(before)
  })
})

describe('monitor mode is live state', () => {
  it('survives undo/redo like arm and the I flag', () => {
    const session = new ProjectSession(project(audio('a')))
    session.edit(p => ({ ...p, name: 'Edited' }))
    session.dispatch({ type: 'live', edit: p => ({ ...p, tracks: p.tracks.map(t => ({ ...t, monitorMode: 'off' as const })) }) })
    expect(session.getSnapshot().history.past).toHaveLength(1)
    session.dispatch({ type: 'undo' })
    expect(session.getSnapshot().history.present.tracks[0].monitorMode).toBe('off')
    expect(session.getSnapshot().history.present.name).not.toBe('Edited')
  })
})

describe('track.setInput command (automation/MCP)', () => {
  const run = (session: ProjectSession, input: unknown, trackId = 'a', operationId = 'op') => {
    const { history, revision } = session.getSnapshot()
    return session.execute({ projectId: history.present.id, expectedRevision: revision, operationId, commands: [{ type: 'track.setInput', trackId, input }] })
  }

  it('sets and clears an audio track input as one undoable edit', () => {
    const session = new ProjectSession(project(audio('a')))
    expect(run(session, { channels: [2, 3], label: 'Main' }).changed).toBe(true)
    expect(session.getSnapshot().history.present.tracks[0].input).toEqual({ channels: [2, 3], label: 'Main' })
    expect(run(session, null, 'a', 'op2').changed).toBe(true)
    expect(session.getSnapshot().history.present.tracks[0]).not.toHaveProperty('input')
    expect(run(session, null, 'a', 'op3').changed).toBe(false)
  })

  it('validates strictly and refuses instrument tracks', () => {
    for (const input of [{ channels: [1, 1] }, { channels: [] }, { channels: [256] }, { channels: [0], label: '' }, { channels: [0], extra: true }, 'in']) {
      expect(() => parseCommand({ type: 'track.setInput', trackId: 'a', input })).toThrow(DomainError)
    }
    const session = new ProjectSession(project({ ...createTrack('instrument'), id: 'i' }))
    expect(() => run(session, { channels: [0] }, 'i')).toThrow(/오디오 트랙/)
  })
})

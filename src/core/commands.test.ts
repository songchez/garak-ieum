import { describe, expect, it } from 'vitest'
import {
  COMMAND_LIMITS, COMMAND_METADATA, COMMAND_REQUEST_SCHEMA, HISTORY_REQUEST_SCHEMA,
  DomainError, parseCommand, parseCommandRequest, parseHistoryRequest, requestFingerprint,
} from './commands'

const note = { pitch: 60, start: 0, duration: 1, velocity: 0.7 }
const clip = { startBeat: 0, lengthBeats: 32, notes: [note] }
const envelope = { projectId: 'project', expectedRevision: 0, operationId: 'request-1' }
function fails(action: () => unknown, code = 'INVALID_ARGUMENT') {
  let error: unknown
  try { action() } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(DomainError)
  expect(error).toMatchObject({ code })
}

describe('external command contracts', () => {
  it('describes exactly the supported command discriminants and strict envelopes', () => {
    const types = COMMAND_METADATA.map(item => item.type)
    expect(new Set(types).size).toBe(types.length)
    expect(types).toHaveLength(21)
    expect(types).toContain('instrument.setParam'); expect(types).toContain('track.setInput')
    expect(COMMAND_REQUEST_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false, required: ['projectId', 'expectedRevision', 'operationId', 'commands'] })
    expect(HISTORY_REQUEST_SCHEMA).toMatchObject({ additionalProperties: false })
    for (const item of COMMAND_METADATA) expect(item.inputSchema).toMatchObject({ additionalProperties: false, properties: { type: { const: item.type } } })
  })

  it('accepts an editable eight-bar draft with normalized velocity and clip-relative notes', () => {
    expect(parseCommandRequest({ ...envelope, label: '  초안  ', commands: [{ type: 'track.create', kind: 'instrument', instrument: 'keys', name: ' 피아노 ', initialClip: clip }] })).toMatchObject({
      label: '초안', commands: [{ type: 'track.create', name: '피아노', initialClip: clip }],
    })
    expect(parseCommand({ type: 'clip.addMidi', trackId: 't', ...clip })).toMatchObject({ notes: [note] })
  })

  it.each([
    { type: 'track.setPan', trackId: 't', pan: 1.01 },
    { type: 'track.setPan', trackId: 't', pan: NaN },
    { type: 'track.setVolumeDb', trackId: 't', volumeDb: Infinity },
    { type: 'track.setVolumeDb', trackId: 't', volumeDb: -121 },
    { type: 'track.setVolumeDb', trackId: 't', volumeDb: 7 },
    { type: 'clip.setTranspose', clipId: 'c', semitones: 0.5 },
    { type: 'clip.repeat', clipId: 'c', count: 0 },
    { type: 'track.setMute', trackId: 't', mute: 'false' },
    { type: 'track.rename', trackId: 't', name: '   ' },
  ])('rejects invalid units/types rather than clamping: %j', command => fails(() => parseCommand(command)))

  it.each([
    { ...note, pitch: 128 }, { ...note, pitch: 60.5 }, { ...note, start: -1 },
    { ...note, duration: 0 }, { ...note, duration: Infinity },
    { ...note, start: 31.5, duration: 1 }, { ...note, velocity: 100 }, { ...note, velocity: -0.1 },
    { ...note, id: 'injected-id' },
  ])('rejects invalid note values and caller-assigned editing IDs: %j', value => {
    fails(() => parseCommand({ type: 'clip.addMidi', trackId: 't', ...clip, notes: [value] }))
  })

  it('rejects raw project/partial updates, unexpected nested fields, and arbitrary execution', () => {
    fails(() => parseCommand({ type: 'track.setMute', trackId: 't', mute: true, project: {} }))
    fails(() => parseCommand({ type: 'track.create', kind: 'instrument', initialClip: { ...clip, eval: 'evil' } }))
    fails(() => parseCommand({ type: 'eval', source: 'anything' }), 'UNSUPPORTED_COMMAND')
    fails(() => parseCommandRequest({ ...envelope, commands: [], project: {} }))
    fails(() => parseCommand(Object.assign(Object.create({ privileged: true }), { type: 'track.delete', trackId: 't' })))
    fails(() => parseCommand({ type: { toString: 5 } }))
  })

  it('rejects excessive commands/notes and unsafe revisions', () => {
    fails(() => parseCommandRequest({ ...envelope, commands: Array.from({ length: COMMAND_LIMITS.maxCommands + 1 }, () => ({ type: 'track.delete', trackId: 't' })) }))
    fails(() => parseCommand({ type: 'clip.addMidi', trackId: 't', ...clip, notes: Array.from({ length: COMMAND_LIMITS.maxNotesPerClip + 1 }, () => note) }))
    for (const expectedRevision of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) fails(() => parseHistoryRequest({ ...envelope, expectedRevision, action: 'undo' }))
  })

  it('bounds aggregate input notes before processing the rest of an oversized batch', () => {
    const notes = Array.from({ length: COMMAND_LIMITS.maxNotesPerClip }, () => note)
    const commands = Array.from({ length: 3 }, () => ({ type: 'clip.addMidi', trackId: 't', ...clip, notes }))
    fails(() => parseCommandRequest({ ...envelope, commands }), 'LIMIT_EXCEEDED')
  })

  it('keeps audio and MIDI creation separate and rejects clip end overflow', () => {
    fails(() => parseCommand({ type: 'track.create', kind: 'audio', initialClip: clip }))
    fails(() => parseCommand({ type: 'clip.addMidi', trackId: 't', ...clip, startBeat: COMMAND_LIMITS.maxBeat }))
    expect(parseCommand({ type: 'track.create', kind: 'audio' })).toEqual({ type: 'track.create', kind: 'audio' })
  })

  it('accepts explicit silence, booleans, and history no-op requests', () => {
    expect(parseCommand({ type: 'track.setVolumeDb', trackId: 't', volumeDb: null })).toMatchObject({ volumeDb: null })
    expect(parseCommand({ type: 'track.setSolo', trackId: 't', solo: false })).toMatchObject({ solo: false })
    expect(parseHistoryRequest({ ...envelope, action: 'undo' })).toEqual({ ...envelope, action: 'undo' })
  })

  it('does not treat JSON prototype keys as effect configuration or allow unknown envelope fields', () => {
    const params = JSON.parse('{"__proto__":12}') as Record<string, number>
    const command = parseCommand({ type: 'effect.add', trackId: 't', effectType: 'eq', params })
    expect(command.type).toBe('effect.add')
    if (command.type === 'effect.add') {
      expect(Object.hasOwn(command.params!, '__proto__')).toBe(true)
      expect(Object.getPrototypeOf(command.params!)).toBe(Object.prototype)
    }
    fails(() => parseHistoryRequest({ ...envelope, action: 'undo', allProjects: true }))
  })

  it('fingerprints JSON values without depending on object key order', () => {
    expect(requestFingerprint({ b: 2, a: [{ d: 4, c: 3 }] })).toBe(requestFingerprint({ a: [{ c: 3, d: 4 }], b: 2 }))
    expect(requestFingerprint({ a: 1 })).not.toBe(requestFingerprint({ a: 2 }))
    expect(requestFingerprint([1, 2])).not.toBe(requestFingerprint([2, 1]))
  })
})

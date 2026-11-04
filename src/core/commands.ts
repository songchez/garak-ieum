import type { EffectType } from './types'
import { EFFECT_TYPES } from '../devices/effects/registry.js'

/** The browser and Node MCP server share this contract and the side-effect-free built-in registry. */
export const COMMAND_LIMITS = Object.freeze({
  maxCommands: 100, maxNotesPerClip: 8192, maxCreatedNotes: 16384,
  maxCreatedTracks: 32, maxCreatedClips: 512, maxRepeatCount: 64,
  maxEffectsPerTrack: 64, maxBeat: 10_000_000, minClipBeats: 0.0625,
  minNoteBeats: 0.000001, minVolumeDb: -120, maxVolumeDb: 20 * Math.log10(2),
})

export type DomainErrorCode =
  | 'INVALID_ARGUMENT' | 'UNSUPPORTED_COMMAND' | 'NOT_FOUND' | 'TYPE_MISMATCH'
  | 'LIMIT_EXCEEDED' | 'PROJECT_MISMATCH' | 'REVISION_CONFLICT'
  | 'OPERATION_ID_REUSED' | 'INVALID_PROJECT' | 'UNKNOWN_INSTRUMENT' | 'UNKNOWN_PARAMETER'
  | 'INVALID_REQUEST' | 'DAW_NOT_READY' | 'READ_ONLY' | 'DAW_BUSY' | 'METHOD_NOT_SUPPORTED'

export class DomainError extends Error {
  readonly code: DomainErrorCode
  readonly details?: Record<string, unknown>
  constructor(code: DomainErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.details = details
  }
  toJSON() { return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } }
}

export interface NoteInput { pitch: number; start: number; duration: number; velocity: number }
export interface MidiClipInput { name?: string; startBeat: number; lengthBeats: number; notes: NoteInput[] }
export type DawCommand =
  | { type: 'track.create'; kind: 'instrument' | 'audio'; instrument?: string; name?: string; initialClip?: MidiClipInput }
  | { type: 'track.rename'; trackId: string; name: string }
  | { type: 'track.delete'; trackId: string }
  | { type: 'track.setVolumeDb'; trackId: string; volumeDb: number | null }
  | { type: 'track.adjustVolumeDb'; trackId: string; deltaDb: number }
  | { type: 'track.setPan'; trackId: string; pan: number }
  | { type: 'track.setMute'; trackId: string; mute: boolean }
  | { type: 'track.setSolo'; trackId: string; solo: boolean }
  | { type: 'instrument.setParam'; trackId: string; paramId: string; value: number }
  | { type: 'clip.addMidi'; trackId: string } & MidiClipInput
  | { type: 'clip.rename'; clipId: string; name: string }
  | { type: 'clip.move'; clipId: string; startBeat: number; toTrackId?: string }
  | { type: 'clip.delete'; clipId: string }
  | { type: 'clip.repeat'; clipId: string; count: number; startBeat?: number }
  | { type: 'clip.setMute'; clipId: string; mute: boolean }
  | { type: 'clip.setTranspose'; clipId: string; semitones: number }
  | { type: 'effect.add'; trackId: string; effectType: EffectType; params?: Record<string, number> }
  | { type: 'effect.setParam'; trackId: string; deviceId: string; paramId: string; value: number }
  | { type: 'effect.remove'; trackId: string; deviceId: string }
  | { type: 'effect.setEnabled'; trackId: string; deviceId: string; enabled: boolean }

export interface RequestIdentity { projectId: string; expectedRevision: number; operationId: string }
export interface CommandRequest extends RequestIdentity { label?: string; commands: DawCommand[] }
export interface HistoryRequest extends RequestIdentity { action: 'undo' | 'redo' }
export interface CreatedIds { trackIds: string[]; clipIds: string[]; deviceIds: string[] }
export interface CommandResult {
  index: number
  type: DawCommand['type']
  changed: boolean
  targetId?: string
  trackId?: string
  createdIds?: CreatedIds
  before?: Record<string, unknown>
  after?: Record<string, unknown>
}
export interface CommandSummary {
  label: string
  commandCount: number
  changedCommandCount: number
  created: { tracks: number; clips: number; notes: number; devices: number }
  deleted: { tracks: number; clips: number; notes: number; devices: number }
  updatedTrackIds: string[]
  updatedClipIds: string[]
  updatedDeviceIds: string[]
  projectLengthBefore: number
  projectLengthAfter: number
}
export interface CommandResponse {
  projectId: string
  revision: number
  operationId: string
  changed: boolean
  summary: string
  changes: CommandSummary
  results: CommandResult[]
}
export interface PreviewResponse extends CommandResponse { preview: true }
export interface HistoryResponse {
  projectId: string
  revision: number
  operationId: string
  action: 'undo' | 'redo'
  changed: boolean
  summary: string
}

type JsonSchema = Record<string, unknown>
const idSchema: JsonSchema = { type: 'string', minLength: 1, maxLength: 200 }
const nameSchema: JsonSchema = { type: 'string', minLength: 1, maxLength: 512 }
const beatSchema: JsonSchema = { type: 'number', minimum: 0, maximum: COMMAND_LIMITS.maxBeat }
const boolSchema: JsonSchema = { type: 'boolean' }
const effectTypes = EFFECT_TYPES
const objectSchema = (properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false })
const noteSchema = objectSchema({
  pitch: { type: 'integer', minimum: 0, maximum: 127 }, start: beatSchema,
  duration: { type: 'number', minimum: COMMAND_LIMITS.minNoteBeats, maximum: COMMAND_LIMITS.maxBeat },
  velocity: { type: 'number', minimum: 0, maximum: 1, description: 'Normalized note velocity, not MIDI 1–127.' },
})
const clipProperties: Record<string, JsonSchema> = {
  name: nameSchema, startBeat: beatSchema,
  lengthBeats: { type: 'number', minimum: COMMAND_LIMITS.minClipBeats, maximum: COMMAND_LIMITS.maxBeat },
  notes: { type: 'array', maxItems: COMMAND_LIMITS.maxNotesPerClip, items: noteSchema },
}
const clipSchema = objectSchema(clipProperties, ['startBeat', 'lengthBeats', 'notes'])
const descriptor = (type: DawCommand['type'], description: string, properties: Record<string, JsonSchema>, required = Object.keys(properties)) => ({
  type, description, inputSchema: objectSchema({ type: { const: type, type: 'string' }, ...properties }, ['type', ...required]),
})

export const COMMAND_METADATA = [
  descriptor('track.create', 'Create a track using a known instrument ID. An instrument track may contain one initial editable MIDI clip.', {
    kind: { type: 'string', enum: ['instrument', 'audio'] }, instrument: idSchema, name: nameSchema, initialClip: clipSchema,
  }, ['kind']),
  descriptor('track.rename', 'Rename the explicit track.', { trackId: idSchema, name: nameSchema }),
  descriptor('track.delete', 'Delete the explicit track and its clips/effects. The transaction can be undone.', { trackId: idSchema }),
  descriptor('track.setVolumeDb', 'Set the track fader in dB. null means silence; gain range is 0–2.', {
    trackId: idSchema, volumeDb: { anyOf: [{ type: 'number', minimum: COMMAND_LIMITS.minVolumeDb, maximum: COMMAND_LIMITS.maxVolumeDb }, { type: 'null' }] },
  }),
  descriptor('track.adjustVolumeDb', 'Apply a relative dB change. A silent fader stays silent; out-of-range results are rejected.', { trackId: idSchema, deltaDb: { type: 'number', minimum: -120, maximum: 120 } }),
  descriptor('track.setPan', 'Set pan from -1 (left) through 0 (center) to 1 (right).', { trackId: idSchema, pan: { type: 'number', minimum: -1, maximum: 1 } }),
  descriptor('track.setMute', 'Set mute explicitly; this is not a toggle.', { trackId: idSchema, mute: boolSchema }),
  descriptor('track.setSolo', 'Set solo explicitly; other tracks are not modified.', { trackId: idSchema, solo: boolSchema }),
  descriptor('instrument.setParam', 'Set an instrument parameter in its catalog unit. Waveform banks and modulation routes are preserved; native instruments still require a connected native audio host to sound.', { trackId: idSchema, paramId: idSchema, value: { type: 'number' } }),
  descriptor('clip.addMidi', 'Add editable MIDI notes to an instrument track. Note starts are clip-relative beats; pitch is MIDI 0–127 (60=C3).', { trackId: idSchema, ...clipProperties }, ['trackId', 'startBeat', 'lengthBeats', 'notes']),
  descriptor('clip.rename', 'Rename the explicit clip.', { clipId: idSchema, name: nameSchema }),
  descriptor('clip.move', 'Move a clip to an absolute project beat, optionally to a compatible track. Overlaps are preserved.', { clipId: idSchema, startBeat: beatSchema, toTrackId: idSchema }, ['clipId', 'startBeat']),
  descriptor('clip.delete', 'Delete the explicit clip.', { clipId: idSchema }),
  descriptor('clip.repeat', 'Create count additional copies, spaced by clip length. Default first position is the original clip end.', { clipId: idSchema, count: { type: 'integer', minimum: 1, maximum: COMMAND_LIMITS.maxRepeatCount }, startBeat: beatSchema }, ['clipId', 'count']),
  descriptor('clip.setMute', 'Set clip mute explicitly.', { clipId: idSchema, mute: boolSchema }),
  descriptor('clip.setTranspose', 'Set the non-destructive MIDI clip transposition in semitones; original note pitches remain unchanged.', { clipId: idSchema, semitones: { type: 'integer', minimum: -96, maximum: 96 } }),
  descriptor('effect.add', 'Append a built-in insert effect. Unknown parameter names or values outside the catalog are rejected.', { trackId: idSchema, effectType: { type: 'string', enum: effectTypes }, params: { type: 'object', additionalProperties: { type: 'number' }, maxProperties: 32 } }, ['trackId', 'effectType']),
  descriptor('effect.setParam', 'Set one parameter using its native catalog unit, not a normalized knob value.', { trackId: idSchema, deviceId: idSchema, paramId: idSchema, value: { type: 'number' } }),
  descriptor('effect.remove', 'Remove the explicit insert effect.', { trackId: idSchema, deviceId: idSchema }),
  descriptor('effect.setEnabled', 'Set insert enable/bypass explicitly.', { trackId: idSchema, deviceId: idSchema, enabled: boolSchema }),
] as const

const identityProperties: Record<string, JsonSchema> = {
  projectId: idSchema,
  expectedRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  operationId: { type: 'string', minLength: 1, maxLength: 128 },
}
export const COMMAND_REQUEST_SCHEMA = objectSchema({
  ...identityProperties, label: { type: 'string', minLength: 1, maxLength: 200 },
  commands: { type: 'array', minItems: 1, maxItems: COMMAND_LIMITS.maxCommands, items: { oneOf: COMMAND_METADATA.map(item => item.inputSchema) } },
}, ['projectId', 'expectedRevision', 'operationId', 'commands'])
export const HISTORY_REQUEST_SCHEMA = objectSchema({ ...identityProperties, action: { type: 'string', enum: ['undo', 'redo'] } })
export const COMMAND_UNSUPPORTED = ['transport', 'recording', 'audioDeviceMutation', 'automation', 'tempoMap', 'timeSignature', 'audioRendering', 'audioAnalysis', 'midiFileIO', 'codeEvaluation'] as const

function fail(path: string, message: string): never { throw new DomainError('INVALID_ARGUMENT', `${path}: ${message}`, { path }) }
function record(value: unknown, path: string, fields?: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'must be an object')
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) fail(path, 'must be a plain JSON object')
  if (Object.getOwnPropertySymbols(value).length) fail(path, 'symbol keys are not supported')
  const source = value as Record<string, unknown>
  if (fields) for (const key of Object.keys(source)) if (!fields.includes(key)) fail(`${path}.${key}`, 'unknown field')
  return source
}
function string(value: unknown, path: string, max = 200, trim = false): string {
  if (typeof value !== 'string') fail(path, 'must be a string')
  const result = trim ? value.trim() : value
  if (!result.length || result.length > max) fail(path, `must contain 1–${max} characters`)
  return result
}
function numeric(value: unknown, path: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) fail(path, `must be a finite ${integer ? 'integer' : 'number'} in ${min}–${max}`)
  return value
}
function boolean(value: unknown, path: string): boolean { if (typeof value !== 'boolean') fail(path, 'must be a boolean'); return value }

function parseMidiClip(value: unknown, path: string, fields = ['name', 'startBeat', 'lengthBeats', 'notes']): MidiClipInput {
  const c = record(value, path, fields)
  const lengthBeats = numeric(c.lengthBeats, `${path}.lengthBeats`, COMMAND_LIMITS.minClipBeats, COMMAND_LIMITS.maxBeat)
  const startBeat = numeric(c.startBeat, `${path}.startBeat`, 0, COMMAND_LIMITS.maxBeat)
  if (startBeat + lengthBeats > COMMAND_LIMITS.maxBeat) fail(path, 'clip end exceeds the project position limit')
  if (!Array.isArray(c.notes) || c.notes.length > COMMAND_LIMITS.maxNotesPerClip) fail(`${path}.notes`, `must be an array of at most ${COMMAND_LIMITS.maxNotesPerClip} notes`)
  const notes = c.notes.map((value, index): NoteInput => {
    const p = `${path}.notes[${index}]`, n = record(value, p, ['pitch', 'start', 'duration', 'velocity'])
    const note = {
      pitch: numeric(n.pitch, `${p}.pitch`, 0, 127, true), start: numeric(n.start, `${p}.start`, 0, COMMAND_LIMITS.maxBeat),
      duration: numeric(n.duration, `${p}.duration`, COMMAND_LIMITS.minNoteBeats, COMMAND_LIMITS.maxBeat),
      velocity: numeric(n.velocity, `${p}.velocity`, 0, 1),
    }
    if (note.start + note.duration > lengthBeats + 1e-9) fail(p, 'note end must be inside the clip')
    return note
  })
  return { startBeat, lengthBeats, notes, ...(c.name === undefined ? {} : { name: string(c.name, `${path}.name`, 512, true) }) }
}

export function parseCommand(value: unknown, index = 0): DawCommand {
  const path = `commands[${index}]`, base = record(value, path)
  const type = string(base.type, `${path}.type`, 80)
  const meta = COMMAND_METADATA.find(item => item.type === type)
  if (!meta) throw new DomainError('UNSUPPORTED_COMMAND', `Unknown command: ${type}`, { index, type })
  const fields = Object.keys(meta.inputSchema.properties as Record<string, unknown>)
  const c = record(base, path, fields)
  const trackId = () => string(c.trackId, `${path}.trackId`)
  const clipId = () => string(c.clipId, `${path}.clipId`)
  const deviceId = () => string(c.deviceId, `${path}.deviceId`)
  const name = () => string(c.name, `${path}.name`, 512, true)
  switch (c.type) {
    case 'track.create': {
      if (c.kind !== 'audio' && c.kind !== 'instrument') fail(`${path}.kind`, 'must be audio or instrument')
      if (c.kind === 'audio' && c.initialClip !== undefined) fail(`${path}.initialClip`, 'MIDI clips require an instrument track')
      return { type: c.type, kind: c.kind,
        ...(c.instrument === undefined ? {} : { instrument: string(c.instrument, `${path}.instrument`) }),
        ...(c.name === undefined ? {} : { name: name() }),
        ...(c.initialClip === undefined ? {} : { initialClip: parseMidiClip(c.initialClip, `${path}.initialClip`) }),
      }
    }
    case 'track.rename': return { type: c.type, trackId: trackId(), name: name() }
    case 'track.delete': return { type: c.type, trackId: trackId() }
    case 'track.setVolumeDb': return { type: c.type, trackId: trackId(), volumeDb: c.volumeDb === null ? null : numeric(c.volumeDb, `${path}.volumeDb`, COMMAND_LIMITS.minVolumeDb, COMMAND_LIMITS.maxVolumeDb) }
    case 'track.adjustVolumeDb': return { type: c.type, trackId: trackId(), deltaDb: numeric(c.deltaDb, `${path}.deltaDb`, -120, 120) }
    case 'track.setPan': return { type: c.type, trackId: trackId(), pan: numeric(c.pan, `${path}.pan`, -1, 1) }
    case 'track.setMute': return { type: c.type, trackId: trackId(), mute: boolean(c.mute, `${path}.mute`) }
    case 'track.setSolo': return { type: c.type, trackId: trackId(), solo: boolean(c.solo, `${path}.solo`) }
    case 'instrument.setParam': return { type: c.type, trackId: trackId(), paramId: string(c.paramId, `${path}.paramId`), value: numeric(c.value, `${path}.value`, -Number.MAX_VALUE, Number.MAX_VALUE) }
    case 'clip.addMidi': return { type: c.type, trackId: trackId(), ...parseMidiClip(c, path, fields) }
    case 'clip.rename': return { type: c.type, clipId: clipId(), name: name() }
    case 'clip.move': return { type: c.type, clipId: clipId(), startBeat: numeric(c.startBeat, `${path}.startBeat`, 0, COMMAND_LIMITS.maxBeat), ...(c.toTrackId === undefined ? {} : { toTrackId: string(c.toTrackId, `${path}.toTrackId`) }) }
    case 'clip.delete': return { type: c.type, clipId: clipId() }
    case 'clip.repeat': return { type: c.type, clipId: clipId(), count: numeric(c.count, `${path}.count`, 1, COMMAND_LIMITS.maxRepeatCount, true), ...(c.startBeat === undefined ? {} : { startBeat: numeric(c.startBeat, `${path}.startBeat`, 0, COMMAND_LIMITS.maxBeat) }) }
    case 'clip.setMute': return { type: c.type, clipId: clipId(), mute: boolean(c.mute, `${path}.mute`) }
    case 'clip.setTranspose': return { type: c.type, clipId: clipId(), semitones: numeric(c.semitones, `${path}.semitones`, -96, 96, true) }
    case 'effect.add': {
      if (!effectTypes.includes(c.effectType as EffectType)) fail(`${path}.effectType`, 'unknown built-in effect')
      let params: Record<string, number> | undefined
      if (c.params !== undefined) {
        const source = record(c.params, `${path}.params`)
        if (Object.keys(source).length > 32) fail(`${path}.params`, 'too many parameters')
        params = {}
        for (const [key, value] of Object.entries(source)) {
          string(key, `${path}.params key`)
          Object.defineProperty(params, key, { value: numeric(value, `${path}.params.${key}`, -Number.MAX_VALUE, Number.MAX_VALUE), enumerable: true, writable: true, configurable: true })
        }
      }
      return { type: c.type, trackId: trackId(), effectType: c.effectType as EffectType, ...(params ? { params } : {}) }
    }
    case 'effect.setParam': return { type: c.type, trackId: trackId(), deviceId: deviceId(), paramId: string(c.paramId, `${path}.paramId`), value: numeric(c.value, `${path}.value`, -Number.MAX_VALUE, Number.MAX_VALUE) }
    case 'effect.remove': return { type: c.type, trackId: trackId(), deviceId: deviceId() }
    case 'effect.setEnabled': return { type: c.type, trackId: trackId(), deviceId: deviceId(), enabled: boolean(c.enabled, `${path}.enabled`) }
    default: throw new DomainError('UNSUPPORTED_COMMAND', 'Unsupported command')
  }
}

function identity(value: Record<string, unknown>): RequestIdentity {
  return {
    projectId: string(value.projectId, 'projectId'), expectedRevision: numeric(value.expectedRevision, 'expectedRevision', 0, Number.MAX_SAFE_INTEGER, true),
    operationId: string(value.operationId, 'operationId', 128),
  }
}
export function parseCommandRequest(value: unknown): CommandRequest {
  const request = record(value, 'request', ['projectId', 'expectedRevision', 'operationId', 'label', 'commands'])
  if (!Array.isArray(request.commands) || !request.commands.length || request.commands.length > COMMAND_LIMITS.maxCommands) fail('commands', `must contain 1–${COMMAND_LIMITS.maxCommands} commands`)
  const ids = identity(request)
  let inputNotes = 0
  const commands = request.commands.map((value, index) => {
    const command = parseCommand(value, index)
    inputNotes += command.type === 'clip.addMidi' ? command.notes.length : command.type === 'track.create' ? command.initialClip?.notes.length ?? 0 : 0
    if (inputNotes > COMMAND_LIMITS.maxCreatedNotes) throw new DomainError('LIMIT_EXCEEDED', '한 번의 요청에 포함할 수 있는 음표 수를 초과했습니다.', { kind: 'notes', actual: inputNotes, limit: COMMAND_LIMITS.maxCreatedNotes, commandIndex: index })
    return command
  })
  return { ...ids, commands, ...(request.label === undefined ? {} : { label: string(request.label, 'label', 200, true) }) }
}
export function parseHistoryRequest(value: unknown): HistoryRequest {
  const request = record(value, 'request', ['projectId', 'expectedRevision', 'operationId', 'action'])
  if (request.action !== 'undo' && request.action !== 'redo') fail('action', 'must be undo or redo')
  return { ...identity(request), action: request.action }
}

/** Stable JSON comparison ignores object key order, but keeps arrays and all submitted values. */
export function requestFingerprint(value: unknown): string {
  const encode = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`
    if (item && typeof item === 'object') return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key])}`).join(',')}}`
    return JSON.stringify(item) ?? 'undefined'
  }
  return encode(value)
}

import { EFFECT_DEFS } from './devices'
import { instrumentDef, isInstrumentId } from './instruments'
import { createDevice, createTrack, fitProjectLength, validateProject } from './project'
import type { Clip, Device, EffectType, MidiClip, Project, Track } from './types'
import {
  COMMAND_LIMITS, DomainError, parseCommandRequest, parseHistoryRequest, requestFingerprint,
  type CommandRequest, type CommandResponse, type CommandResult, type CommandSummary,
  type CreatedIds, type HistoryRequest, type HistoryResponse, type MidiClipInput,
  type PreviewResponse, type RequestIdentity,
} from './commands'

export interface ProjectHistory { past: Project[]; present: Project; future: Project[] }
export interface SessionChange {
  source: 'ui' | 'mcp' | 'history' | 'reset'
  label: string
  summary: string
  revision: number
  operationId?: string
}
export interface ProjectSessionSnapshot { history: ProjectHistory; revision: number; undoLabel: string | null; redoLabel: string | null; lastChange?: SessionChange }
export type SessionAction =
  | { type: 'edit'; edit: (project: Project) => Project; merge: boolean; label?: string }
  | { type: 'live'; edit: (project: Project) => Project }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; project: Project }

/** Live record/monitor flags survive history changes exactly as they do in the UI. */
function carryLiveState(from: Project, to: Project): Project {
  const live = new Map(from.tracks.map(track => [track.id, track]))
  let changed = false
  const tracks = to.tracks.map(track => {
    const current = live.get(track.id)
    if (!current || (current.armed === track.armed && current.monitor === track.monitor)) return track
    changed = true
    return { ...track, armed: current.armed, monitor: current.monitor }
  })
  return changed ? { ...to, tracks } : to
}

function transition(history: ProjectHistory, action: 'undo' | 'redo'): ProjectHistory {
  if (action === 'undo') {
    const previous = history.past.at(-1)
    return previous ? { past: history.past.slice(0, -1), present: carryLiveState(history.present, previous), future: [history.present, ...history.future] } : history
  }
  const next = history.future[0]
  return next ? { past: [...history.past.slice(-49), history.present], present: carryLiveState(history.present, next), future: history.future.slice(1) } : history
}

const emptyCreatedIds = (): CreatedIds => ({ trackIds: [], clipIds: [], deviceIds: [] })
const emptyCounts = () => ({ tracks: 0, clips: 0, notes: 0, devices: 0 })
const noteCount = (clips: readonly Clip[]) => clips.reduce((sum, clip) => sum + (clip.kind === 'midi' ? clip.notes.length : 0), 0)
const gainDb = (gain: number) => gain === 0 ? null : 20 * Math.log10(gain)
function volumeGain(db: number | null): number {
  return db === null ? 0 : db === COMMAND_LIMITS.maxVolumeDb ? 2 : 10 ** (db / 20)
}
function checkGain(gain: number): number {
  // Permit only arithmetic rounding at the exact upper limit, never a user-visible clamp.
  if (!Number.isFinite(gain) || gain < 0 || gain > 2 + 1e-12) throw new DomainError('INVALID_ARGUMENT', '볼륨 변경 결과가 허용 범위(선형 gain 0–2)를 벗어납니다.', { gain, maxVolumeDb: COMMAND_LIMITS.maxVolumeDb })
  return gain > 2 ? 2 : gain
}
function knownTrack(project: Project, id: string): Track {
  const track = project.tracks.find(item => item.id === id)
  if (!track) throw new DomainError('NOT_FOUND', '트랙을 찾을 수 없습니다.', { trackId: id })
  return track
}
function knownClip(project: Project, id: string): { track: Track; clip: Clip } {
  for (const track of project.tracks) {
    const clip = track.clips.find(item => item.id === id)
    if (clip) return { track, clip }
  }
  throw new DomainError('NOT_FOUND', '리전을 찾을 수 없습니다.', { clipId: id })
}
function knownDevice(track: Track, id: string): Device {
  const device = track.devices.find(item => item.id === id)
  if (!device) throw new DomainError('NOT_FOUND', '지정한 트랙에서 이펙트를 찾을 수 없습니다.', { trackId: track.id, deviceId: id })
  return device
}
function checkParameter(type: EffectType, id: string, value: number): void {
  const def = EFFECT_DEFS[type].params.find(item => item.id === id)
  if (!def) throw new DomainError('UNKNOWN_PARAMETER', '이 이펙트에 없는 파라미터입니다.', { effectType: type, paramId: id })
  if (!Number.isFinite(value) || value < def.min || value > def.max || (def.options && !def.options.some(option => option.value === value))) {
    throw new DomainError('INVALID_ARGUMENT', '이펙트 파라미터의 값이나 단위가 허용 범위를 벗어납니다.', { effectType: type, paramId: id, value, min: def.min, max: def.max, unit: def.unit, ...(def.options ? { allowedValues: def.options.map(option => option.value) } : {}) })
  }
}
function checkEnd(start: number, length: number): void {
  if (!Number.isFinite(start + length) || start + length > COMMAND_LIMITS.maxBeat) throw new DomainError('INVALID_ARGUMENT', '리전 끝이 프로젝트 위치 한도를 벗어납니다.', { startBeat: start, lengthBeats: length })
}

/** IDs are deterministic for one request and its preview. They are editing IDs, not credentials. */
function idFactory(project: Project, operationId: string): () => string {
  const used = new Set<string>([project.id])
  for (const track of project.tracks) {
    used.add(track.id)
    for (const device of track.devices) used.add(device.id)
    for (const clip of track.clips) { used.add(clip.id); if (clip.kind === 'midi') for (const note of clip.notes) used.add(note.id) }
  }
  for (const marker of project.markers) used.add(marker.id)
  let hash = 2166136261
  for (const character of `${project.id}\0${operationId}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
  let sequence = 0
  return () => {
    let candidate: string
    do { candidate = `ai-${hash.toString(36)}-${(++sequence).toString(36)}` } while (used.has(candidate))
    used.add(candidate)
    return candidate
  }
}

interface PlannedCommands { project: Project; changes: CommandSummary; results: CommandResult[] }
function planCommands(project: Project, request: CommandRequest): PlannedCommands {
  let next = project
  let fitLength = false
  const nextId = idFactory(project, request.operationId)
  const changes: CommandSummary = {
    label: request.label ?? 'AI 편집', commandCount: request.commands.length, changedCommandCount: 0,
    created: emptyCounts(), deleted: emptyCounts(), updatedTrackIds: [], updatedClipIds: [], updatedDeviceIds: [],
    projectLengthBefore: project.lengthBeats, projectLengthAfter: project.lengthBeats,
  }
  const updatedTracks = new Set<string>(), updatedClips = new Set<string>(), updatedDevices = new Set<string>()
  const results: CommandResult[] = []
  const budget = () => {
    const checks = [
      ['tracks', changes.created.tracks, COMMAND_LIMITS.maxCreatedTracks],
      ['clips', changes.created.clips, COMMAND_LIMITS.maxCreatedClips],
      ['notes', changes.created.notes, COMMAND_LIMITS.maxCreatedNotes],
    ] as const
    for (const [kind, actual, limit] of checks) if (actual > limit) throw new DomainError('LIMIT_EXCEEDED', '한 번의 편집에서 생성할 수 있는 양을 초과했습니다.', { kind, actual, limit })
  }
  const replaceTrack = (track: Track) => { next = { ...next, tracks: next.tracks.map(item => item.id === track.id ? track : item) }; updatedTracks.add(track.id) }
  const replaceClip = (track: Track, clip: Clip) => { replaceTrack({ ...track, clips: track.clips.map(item => item.id === clip.id ? clip : item) }); updatedClips.add(clip.id) }
  const makeMidiClip = (input: MidiClipInput): MidiClip => {
    changes.created.clips += 1; changes.created.notes += input.notes.length; budget()
    return { id: nextId(), kind: 'midi', name: input.name ?? 'MIDI 리전', startBeat: input.startBeat, lengthBeats: input.lengthBeats, gain: 1, notes: input.notes.map(note => ({ id: nextId(), ...note })).sort((a, b) => a.start - b.start || a.pitch - b.pitch) }
  }

  for (const [index, command] of request.commands.entries()) {
    const beforeProject = next
    const result: CommandResult = { index, type: command.type, changed: false }
    try {
      switch (command.type) {
        case 'track.create': {
          const instrument = command.instrument ?? 'keys'
          if (!isInstrumentId(instrument)) throw new DomainError('UNKNOWN_INSTRUMENT', '등록되지 않은 악기입니다.', { instrument })
          changes.created.tracks += 1; budget()
          const track = { ...createTrack(command.kind, instrument), id: nextId() }
          if (command.name !== undefined) track.name = command.name
          if (command.initialClip) { track.clips = [makeMidiClip(command.initialClip)]; fitLength = true }
          next = { ...next, tracks: [...next.tracks, track] }
          result.targetId = track.id; result.trackId = track.id
          result.createdIds = { trackIds: [track.id], clipIds: track.clips.map(clip => clip.id), deviceIds: [] }
          result.after = { name: track.name, kind: track.kind, instrument: track.instrument, clipCount: track.clips.length, noteCount: noteCount(track.clips) }
          break
        }
        case 'track.rename': case 'track.delete': case 'track.setVolumeDb': case 'track.adjustVolumeDb': case 'track.setPan': case 'track.setMute': case 'track.setSolo': {
          const track = knownTrack(next, command.trackId)
          result.targetId = track.id; result.trackId = track.id
          if (command.type === 'track.delete') {
            changes.deleted.tracks += 1; changes.deleted.clips += track.clips.length; changes.deleted.notes += noteCount(track.clips); changes.deleted.devices += track.devices.length
            next = { ...next, tracks: next.tracks.filter(item => item.id !== track.id) }
            result.before = { name: track.name, clipCount: track.clips.length, deviceCount: track.devices.length }
          } else if (command.type === 'track.rename') {
            result.before = { name: track.name }; result.after = { name: command.name }
            if (track.name !== command.name) replaceTrack({ ...track, name: command.name })
          } else if (command.type === 'track.setVolumeDb' || command.type === 'track.adjustVolumeDb') {
            const gain = checkGain(command.type === 'track.setVolumeDb' ? volumeGain(command.volumeDb) : track.volume * 10 ** (command.deltaDb / 20))
            result.before = { volumeDb: gainDb(track.volume), gain: track.volume }; result.after = { volumeDb: gainDb(gain), gain }
            if (gain !== track.volume) replaceTrack({ ...track, volume: gain })
          } else if (command.type === 'track.setPan') {
            result.before = { pan: track.pan }; result.after = { pan: command.pan }
            if (track.pan !== command.pan) replaceTrack({ ...track, pan: command.pan })
          } else if (command.type === 'track.setMute') {
            result.before = { mute: track.mute }; result.after = { mute: command.mute }
            if (track.mute !== command.mute) replaceTrack({ ...track, mute: command.mute })
          } else {
            result.before = { solo: track.solo }; result.after = { solo: command.solo }
            if (track.solo !== command.solo) replaceTrack({ ...track, solo: command.solo })
          }
          break
        }
        case 'clip.addMidi': {
          const track = knownTrack(next, command.trackId)
          if (track.kind !== 'instrument') throw new DomainError('TYPE_MISMATCH', 'MIDI 리전은 소프트웨어 악기 트랙에만 추가할 수 있습니다.', { trackId: track.id })
          const clip = makeMidiClip(command)
          fitLength = true
          replaceTrack({ ...track, clips: [...track.clips, clip] })
          result.targetId = clip.id; result.trackId = track.id; result.createdIds = { ...emptyCreatedIds(), clipIds: [clip.id] }
          result.after = { startBeat: clip.startBeat, lengthBeats: clip.lengthBeats, noteCount: clip.notes.length }
          break
        }
        case 'clip.rename': case 'clip.move': case 'clip.delete': case 'clip.repeat': case 'clip.setMute': case 'clip.setTranspose': {
          const { track, clip } = knownClip(next, command.clipId)
          result.targetId = clip.id; result.trackId = track.id
          if (command.type === 'clip.rename') {
            result.before = { name: clip.name }; result.after = { name: command.name }
            if (clip.name !== command.name) replaceClip(track, { ...clip, name: command.name })
          } else if (command.type === 'clip.delete') {
            changes.deleted.clips += 1; changes.deleted.notes += noteCount([clip])
            replaceTrack({ ...track, clips: track.clips.filter(item => item.id !== clip.id) })
            result.before = { name: clip.name, startBeat: clip.startBeat, lengthBeats: clip.lengthBeats }
          } else if (command.type === 'clip.move') {
            const target = command.toTrackId ? knownTrack(next, command.toTrackId) : track
            if (target.kind !== (clip.kind === 'midi' ? 'instrument' : 'audio')) throw new DomainError('TYPE_MISMATCH', '같은 종류의 리전을 받을 수 있는 트랙으로만 이동할 수 있습니다.', { clipId: clip.id, toTrackId: target.id })
            checkEnd(command.startBeat, clip.lengthBeats)
            result.before = { trackId: track.id, startBeat: clip.startBeat }; result.after = { trackId: target.id, startBeat: command.startBeat }
            if (target.id !== track.id) {
              fitLength = true
              replaceTrack({ ...track, clips: track.clips.filter(item => item.id !== clip.id) })
              replaceTrack({ ...target, clips: [...target.clips, { ...clip, startBeat: command.startBeat }] })
              updatedClips.add(clip.id)
            } else if (clip.startBeat !== command.startBeat) { replaceClip(track, { ...clip, startBeat: command.startBeat }); fitLength = true }
          } else if (command.type === 'clip.repeat') {
            fitLength = true
            const first = command.startBeat ?? clip.startBeat + clip.lengthBeats
            checkEnd(first, clip.lengthBeats * command.count)
            changes.created.clips += command.count; changes.created.notes += noteCount([clip]) * command.count; budget()
            const copies = Array.from({ length: command.count }, (_, repeat): Clip => ({
              ...clip, id: nextId(), startBeat: first + clip.lengthBeats * repeat,
              ...(clip.kind === 'midi' ? { notes: clip.notes.map(note => ({ ...note, id: nextId() })) } : {}),
            }))
            replaceTrack({ ...track, clips: [...track.clips, ...copies] })
            result.createdIds = { ...emptyCreatedIds(), clipIds: copies.map(copy => copy.id) }
            result.after = { copies: command.count, firstStartBeat: first, lengthBeats: clip.lengthBeats }
          } else if (command.type === 'clip.setMute') {
            result.before = { mute: clip.mute ?? false }; result.after = { mute: command.mute }
            if ((clip.mute ?? false) !== command.mute) replaceClip(track, { ...clip, mute: command.mute })
          } else {
            if (clip.kind !== 'midi') throw new DomainError('TYPE_MISMATCH', '오디오 리전의 피치 변환은 이 명령에서 지원하지 않습니다.', { clipId: clip.id })
            result.before = { semitones: clip.transpose ?? 0 }; result.after = { semitones: command.semitones }
            if ((clip.transpose ?? 0) !== command.semitones) replaceClip(track, { ...clip, transpose: command.semitones })
          }
          break
        }
        case 'instrument.setParam': {
          const track = knownTrack(next, command.trackId)
          if (track.kind !== 'instrument') throw new DomainError('TYPE_MISMATCH', '악기 트랙이 필요합니다.', { trackId: track.id })
          const def = instrumentDef(track.instrument).params.find(param => param.id === command.paramId)
          if (!def) throw new DomainError('UNKNOWN_PARAMETER', '이 악기에 없는 파라미터입니다.', { instrument: track.instrument, paramId: command.paramId })
          if (command.value < def.min || command.value > def.max || (def.options && !def.options.some(option => option.value === command.value))) {
            throw new DomainError('INVALID_ARGUMENT', '악기 파라미터가 허용 범위를 벗어납니다.', { paramId: command.paramId, min: def.min, max: def.max, unit: def.unit })
          }
          const before = track.instrumentParams[command.paramId] ?? def.default
          result.trackId = track.id
          result.before = { paramId: command.paramId, value: before }
          result.after = { paramId: command.paramId, value: command.value }
          if (before !== command.value) replaceTrack({ ...track, instrumentParams: { ...track.instrumentParams, [command.paramId]: command.value } })
          break
        }
        case 'effect.add': case 'effect.setParam': case 'effect.remove': case 'effect.setEnabled': {
          const track = knownTrack(next, command.trackId)
          result.trackId = track.id
          if (command.type === 'effect.add') {
            if (track.devices.length >= COMMAND_LIMITS.maxEffectsPerTrack) throw new DomainError('LIMIT_EXCEEDED', '트랙당 이펙트 한도를 초과했습니다.', { trackId: track.id, limit: COMMAND_LIMITS.maxEffectsPerTrack })
            for (const [id, value] of Object.entries(command.params ?? {})) checkParameter(command.effectType, id, value)
            const device = { ...createDevice(command.effectType, command.params), id: nextId() }
            changes.created.devices += 1
            replaceTrack({ ...track, devices: [...track.devices, device] })
            result.targetId = device.id; result.createdIds = { ...emptyCreatedIds(), deviceIds: [device.id] }
            result.after = { effectType: device.type, params: { ...device.params }, enabled: device.enabled }
          } else {
            const device = knownDevice(track, command.deviceId)
            result.targetId = device.id
            if (command.type === 'effect.remove') {
              changes.deleted.devices += 1
              replaceTrack({ ...track, devices: track.devices.filter(item => item.id !== device.id) })
              result.before = { effectType: device.type }
            } else if (command.type === 'effect.setParam') {
              if (device.type === 'vst3') throw new DomainError('UNSUPPORTED_COMMAND', 'VST3 파라미터는 데스크톱 디바이스 창에서 조절해 주세요.', { deviceId: device.id })
              checkParameter(device.type, command.paramId, command.value)
              const before = device.params[command.paramId] ?? EFFECT_DEFS[device.type].params.find(item => item.id === command.paramId)!.default
              result.before = { paramId: command.paramId, value: before }; result.after = { paramId: command.paramId, value: command.value }
              if (before !== command.value) {
                replaceTrack({ ...track, devices: track.devices.map(item => item.id === device.id && item.type !== 'vst3' ? { ...item, params: { ...item.params, [command.paramId]: command.value } } : item) })
                updatedDevices.add(device.id)
              }
            } else {
              result.before = { enabled: device.enabled }; result.after = { enabled: command.enabled }
              if (device.enabled !== command.enabled) {
                replaceTrack({ ...track, devices: track.devices.map(item => item.id === device.id ? { ...item, enabled: command.enabled } : item) })
                updatedDevices.add(device.id)
              }
            }
          }
          break
        }
      }
    } catch (error) {
      if (error instanceof DomainError) throw new DomainError(error.code, error.message, { ...error.details, commandIndex: index, commandType: command.type })
      throw error
    }
    result.changed = next !== beforeProject
    if (result.changed) changes.changedCommandCount += 1
    results.push(result)
  }
  if (next !== project) {
    if (fitLength) next = fitProjectLength(next)
    // Constructor/reset normalize imported state, and commands create only validated native fields.
    // Validate without replacing every unchanged track/note reference and invalidating engine caches.
    try { validateProject(next) } catch (error) { throw new DomainError('INVALID_PROJECT', '명령 결과가 유효한 프로젝트를 만들지 못했습니다.', { reason: error instanceof Error ? error.message : String(error) }) }
  }
  changes.updatedTrackIds = [...updatedTracks]; changes.updatedClipIds = [...updatedClips]; changes.updatedDeviceIds = [...updatedDevices]
  changes.projectLengthAfter = next.lengthBeats
  return { project: next, changes, results }
}

type CachedResponse = { fingerprint: string; result: CommandResponse | HistoryResponse }

/** Synchronous shared project/history store. Audio devices and persistence remain separate services. */
export class ProjectSession {
  private snapshot: ProjectSessionSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly operations = new Map<string, CachedResponse>()
  private lastEdit = { key: '', time: 0 }
  private pastLabels: string[] = []
  private futureLabels: string[] = []
  private gesture: { id: string; label?: string; changed: boolean; base: ProjectHistory; pastLabels: string[]; futureLabels: string[] } | null = null

  constructor(project: Project) {
    this.snapshot = { history: { past: [], present: validateProject(project), future: [] }, revision: 0, undoLabel: null, redoLabel: null }
  }
  readonly getSnapshot = (): ProjectSessionSnapshot => this.snapshot
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  readonly breakMerge = (): void => { this.lastEdit = { key: '', time: 0 }; this.gesture = null }
  /** A pointer drag or held adjustment key is one edit, even when it pauses. */
  readonly beginGesture = (id: string, label?: string): void => {
    if (this.gesture?.id === id) return
    this.breakMerge()
    this.gesture = { id, label, changed: false, base: this.snapshot.history, pastLabels: this.pastLabels, futureLabels: this.futureLabels }
  }
  readonly endGesture = (id: string): void => { if (this.gesture?.id === id) this.breakMerge() }
  /** Cancel only this gesture; external edits terminate it before they publish. */
  readonly cancelGesture = (id: string): void => {
    const gesture = this.gesture
    if (!gesture || gesture.id !== id) return
    this.breakMerge()
    if (!gesture.changed) return
    this.pastLabels = gesture.pastLabels; this.futureLabels = gesture.futureLabels
    const present = carryLiveState(this.snapshot.history.present, gesture.base.present)
    this.publish({ ...gesture.base, present }, { source: 'ui', label: `${gesture.label ?? '편집'} 취소`, summary: '진행 중인 조절을 취소했습니다.' })
  }
  readonly isGestureActive = (): boolean => this.gesture !== null

  private publish(history: ProjectHistory, change: Omit<SessionChange, 'revision'>): void {
    const revision = this.snapshot.revision + 1
    this.snapshot = { history, revision, undoLabel: this.pastLabels.at(-1) ?? null, redoLabel: this.futureLabels[0] ?? null, lastChange: { ...change, revision } }
    for (const listener of [...this.listeners]) listener()
  }
  private edited(next: Project, merge: boolean, label: string): ProjectHistory {
    const { history } = this.snapshot
    merge = merge && history.past.length > 0
    if (!merge) this.pastLabels = [...this.pastLabels.slice(-49), label]
    this.futureLabels = []
    return { past: merge ? history.past : [...history.past.slice(-49), history.present], present: next, future: [] }
  }
  private historyTransition(action: 'undo' | 'redo'): ProjectHistory {
    const history = transition(this.snapshot.history, action)
    if (history === this.snapshot.history) return history
    if (action === 'undo') {
      this.futureLabels = [this.pastLabels.at(-1) ?? '프로젝트 편집', ...this.futureLabels]
      this.pastLabels = this.pastLabels.slice(0, -1)
    } else {
      this.pastLabels = [...this.pastLabels.slice(-49), this.futureLabels[0] ?? '프로젝트 편집']
      this.futureLabels = this.futureLabels.slice(1)
    }
    return history
  }
  readonly edit = (edit: (project: Project) => Project, key = '', label = '프로젝트 편집'): void => {
    const current = this.snapshot.history.present
    const next = edit(current)
    if (next === current) return
    const now = performance.now()
    const merge = this.gesture ? this.gesture.changed : !!key && this.lastEdit.key === key && now - this.lastEdit.time < 450
    label = this.gesture?.label ?? label
    if (this.gesture) this.gesture.changed = true
    this.lastEdit = { key, time: now }
    this.publish(this.edited(next, merge, label), { source: 'ui', label, summary: `${label}을(를) 적용했습니다.` })
  }
  readonly dispatch = (action: SessionAction): void => {
    const { history } = this.snapshot
    if (action.type === 'reset') {
      const project = validateProject(action.project)
      this.operations.clear(); this.breakMerge()
      this.pastLabels = []; this.futureLabels = []
      this.publish({ past: [], present: carryLiveState(history.present, project), future: [] }, { source: 'reset', label: '프로젝트 열기', summary: '프로젝트를 열었습니다.' })
      return
    }
    if (action.type === 'undo' || action.type === 'redo') {
      this.breakMerge()
      const next = this.historyTransition(action.type)
      if (next !== history) this.publish(next, { source: 'history', label: action.type === 'undo' ? '실행 취소' : '다시 실행', summary: action.type === 'undo' ? '프로젝트 편집을 실행 취소했습니다.' : '프로젝트 편집을 다시 실행했습니다.' })
      return
    }
    const next = action.edit(history.present)
    if (next === history.present) return
    if (action.type === 'live') {
      // Do not add an undo item, but a live change invalidates outstanding external edits.
      // A held control still owns its gesture; cancellation carries these live
      // arm/monitor flags onto the restored project instead of rolling them back.
      this.lastEdit = { key: '', time: 0 }
      this.publish({ ...history, present: next }, { source: 'ui', label: '라이브 상태', summary: '녹음 대기 또는 모니터링 상태를 변경했습니다.' })
    } else {
      const label = this.gesture?.label ?? action.label ?? '프로젝트 편집'
      const merge = this.gesture ? this.gesture.changed : action.merge
      if (this.gesture) this.gesture.changed = true
      this.publish(this.edited(next, merge, label), { source: 'ui', label, summary: `${label}을(를) 적용했습니다.` })
    }
  }

  private assertProject(request: RequestIdentity): void {
    const actual = this.snapshot.history.present.id
    if (request.projectId !== actual) throw new DomainError('PROJECT_MISMATCH', '요청한 프로젝트가 현재 열린 프로젝트와 다릅니다.', { requestedProjectId: request.projectId, currentProjectId: actual })
  }
  private assertRevision(request: RequestIdentity): void {
    if (request.expectedRevision !== this.snapshot.revision) throw new DomainError('REVISION_CONFLICT', '프로젝트가 변경되었습니다. 최신 상태를 읽은 뒤 다시 요청해주세요.', { expectedRevision: request.expectedRevision, actualRevision: this.snapshot.revision })
  }
  private cached(request: RequestIdentity, fingerprint: string): CommandResponse | HistoryResponse | undefined {
    this.assertProject(request)
    const previous = this.operations.get(request.operationId)
    if (previous && previous.fingerprint !== fingerprint) throw new DomainError('OPERATION_ID_REUSED', '같은 operationId를 다른 요청에 사용할 수 없습니다.', { operationId: request.operationId })
    return previous ? structuredClone(previous.result) : undefined
  }
  private remember(operationId: string, fingerprint: string, result: CommandResponse | HistoryResponse): void {
    this.operations.set(operationId, { fingerprint, result: structuredClone(result) })
    if (this.operations.size > 256) this.operations.delete(this.operations.keys().next().value!)
  }
  readonly preview = (input: unknown): PreviewResponse => {
    const request = parseCommandRequest(input), fingerprint = `edit:${requestFingerprint(input)}`
    this.cached(request, fingerprint)
    this.assertRevision(request)
    const planned = planCommands(this.snapshot.history.present, request)
    return {
      projectId: request.projectId, revision: this.snapshot.revision, operationId: request.operationId, preview: true,
      changed: planned.project !== this.snapshot.history.present,
      summary: planned.changes.changedCommandCount ? `미리보기: ${planned.changes.changedCommandCount}개 명령으로 프로젝트를 변경합니다.` : '미리보기: 변경할 내용이 없습니다.',
      changes: planned.changes, results: planned.results,
    }
  }
  readonly execute = (input: unknown): CommandResponse => {
    const request = parseCommandRequest(input), fingerprint = `edit:${requestFingerprint(input)}`
    const cached = this.cached(request, fingerprint)
    if (cached) return cached as CommandResponse
    this.assertRevision(request)
    const planned = planCommands(this.snapshot.history.present, request)
    const changed = planned.project !== this.snapshot.history.present
    const summary = changed ? `${planned.changes.label}: ${planned.changes.changedCommandCount}개 명령을 적용했습니다.` : `${planned.changes.label}: 변경할 내용이 없습니다.`
    const result: CommandResponse = { projectId: request.projectId, revision: this.snapshot.revision + (changed ? 1 : 0), operationId: request.operationId, changed, summary, changes: planned.changes, results: planned.results }
    this.breakMerge()
    // Remember before notifying subscribers, so an immediate retry cannot apply twice.
    this.remember(request.operationId, fingerprint, result)
    if (changed) this.publish(this.edited(planned.project, false, planned.changes.label), { source: 'mcp', label: planned.changes.label, summary, operationId: request.operationId })
    return result
  }
  readonly history = (input: unknown): HistoryResponse => {
    const request: HistoryRequest = parseHistoryRequest(input), fingerprint = `history:${requestFingerprint(input)}`
    const cached = this.cached(request, fingerprint)
    if (cached) return cached as HistoryResponse
    this.assertRevision(request)
    const history = this.historyTransition(request.action), changed = history !== this.snapshot.history
    const label = request.action === 'undo' ? '실행 취소' : '다시 실행'
    const summary = changed ? `${label}를 완료했습니다.` : `${label}할 편집 이력이 없습니다.`
    const result: HistoryResponse = { projectId: request.projectId, revision: this.snapshot.revision + (changed ? 1 : 0), operationId: request.operationId, action: request.action, changed, summary }
    this.breakMerge(); this.remember(request.operationId, fingerprint, result)
    if (changed) this.publish(history, { source: 'history', label, summary, operationId: request.operationId })
    return result
  }
}

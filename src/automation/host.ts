import { ProjectSession } from '../core/ProjectSession'
import { COMMAND_LIMITS, COMMAND_METADATA, COMMAND_REQUEST_SCHEMA, HISTORY_REQUEST_SCHEMA, DomainError, type CommandRequest, type HistoryRequest } from '../core/commands'
import { EFFECT_DEFS } from '../core/devices'
import { GM_KIT_NAMES, INSTRUMENTS } from '../core/instruments'
import type { Project, Track, TransportSnapshot } from '../core/types'
import { BRIDGE_PROTOCOL_VERSION, type BridgeParams, type DawMethod } from './protocol'

export interface DawSelection {
  focusedTrackId: string | null
  trackIds: string[]
  clipIds: string[]
}
export interface DawRuntime {
  ready: boolean
  editsAllowed: boolean
  blockedReason: string | null
  persistence: 'loading' | 'pending' | 'saved' | 'error'
}
export interface DawHostOptions {
  session: ProjectSession
  getSelection: () => DawSelection
  getTransport: () => TransportSnapshot
  getRuntime: () => DawRuntime
  /** Called after the project transaction has committed; audio/storage remain separate lifecycles. */
  onMutation?: (summary: string) => void
}

const units = {
  pitch: 'MIDI integer 0..127; displayed middle C is C3=60',
  position: 'Zero-based quarter-note beats. clip startBeat is absolute; stored note start is source-relative. Region-local note start = note.start - (clip.sourceOffsetBeats ?? 0); new MIDI clips use offset 0.',
  regionLoop: 'loop=true repeats the visible source window; loopLengthBeats optionally bounds the total span from startBeat. The next region or project end can stop repeats sooner. Missing loopLengthBeats means continuous.',
  meter: 'project.timeSignature is numerator/denominator (numerator 1..32; denominator 2, 4, 8 or 16). beatsPerBar is quarter-note length = numerator * 4 / denominator; user bar 1 starts at beat 0. BPM remains quarter notes per minute.',
  noteVelocity: '0..1 normalized; distinct from MIDI-unit region/track velocity offsets',
  volume: 'track volume is linear gain 0..2; volumeDb uses 20*log10(gain), null means silence',
  pan: '-1=left, 0=center, 1=right',
  delayTicks: '960 ticks per quarter note; notes themselves are stored in beats',
}
const unsupported = [
  'audio capture and device changes', 'transport control', 'audio asset transfer',
  'effective playback-note queries', 'piano-roll note selection', 'automation', 'tempo maps',
  'time-signature changes through MCP', 'send/return and sidechain', 'external VST/AU/CLAP',
  'audio analysis and audition/render jobs', 'composition-language execution',
  'selective undo of a non-latest transaction',
]

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('INVALID_REQUEST', '조회 조건은 객체여야 합니다.')
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new DomainError('INVALID_REQUEST', `지원하지 않는 조회 조건: ${key}`)
  return value as Record<string, unknown>
}
function identifier(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.length || value.length > 200) throw new DomainError('INVALID_REQUEST', `${name} 형식이 올바르지 않습니다.`)
  return value
}
function page(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new DomainError('INVALID_REQUEST', `${name}은 ${min}~${max} 정수여야 합니다.`)
  return value
}
function trackSummary(track: Track) {
  return {
    id: track.id, name: track.name, kind: track.kind, instrument: track.instrument,
    volume: track.volume, volumeDb: track.volume === 0 ? null : 20 * Math.log10(track.volume), pan: track.pan,
    mute: track.mute, solo: track.solo, soloSafe: track.soloSafe, enabled: track.enabled,
    armed: track.armed, monitor: track.monitor, hidden: track.hidden, color: track.color,
    clipCount: track.clips.length, effectCount: track.devices.length,
  }
}
/** Describe editable synth state without returning megabytes of raw frame samples in MCP reads. */
function instrumentStateSummary(track: Track) {
  const state = track.instrumentState
  if (!state) return {}
  return { instrumentStateSummary: {
    version: state.version, metadata: { ...state.metadata },
    routes: state.routes.map(route => ({ ...route })),
    customBanks: state.customBanks.map(bank => ({ slot: bank.slot, name: bank.name, frameCount: bank.frames.length, frameSize: bank.frames[0]?.length ?? 0 })),
    lfoCurveCount: state.lfoCurves.length,
  } }
}
function selection(project: Project, current: DawSelection): DawSelection {
  const tracks = new Set(project.tracks.map(track => track.id))
  const clips = new Set(project.tracks.flatMap(track => track.clips.map(clip => clip.id)))
  return {
    focusedTrackId: current.focusedTrackId && tracks.has(current.focusedTrackId) ? current.focusedTrackId : null,
    trackIds: [...new Set(current.trackIds)].filter(id => tracks.has(id)),
    clipIds: [...new Set(current.clipIds)].filter(id => clips.has(id)),
  }
}

/** Explicit, bounded reads and the same project transactions used by the UI. */
export function createDawRequestHandler(options: DawHostOptions) {
  return (method: DawMethod, params: BridgeParams): unknown => {
    const snapshot = options.session.getSnapshot()
    const project = snapshot.history.present
    const runtime = options.getRuntime()
    if (!runtime.ready) throw new DomainError('DAW_NOT_READY', '프로젝트 불러오기가 끝난 뒤 다시 요청해주세요.')
    const context = {
      projectId: project.id, revision: snapshot.revision,
      project: { id: project.id, name: project.name, bpm: project.bpm, timeSignature: { ...project.timeSignature }, beatsPerBar: project.beatsPerBar, lengthBeats: project.lengthBeats, sampleRate: project.sampleRate, masterVolume: project.masterVolume, loop: { ...project.loop }, markerCount: project.markers.length },
      selection: selection(project, options.getSelection()), transport: { ...options.getTransport() },
      history: { canUndo: snapshot.history.past.length > 0, canRedo: snapshot.history.future.length > 0, lastChange: snapshot.lastChange ?? null },
      persistence: runtime.persistence,
      editAccess: { allowed: runtime.editsAllowed && !runtime.blockedReason, reason: !runtime.editsAllowed ? '이 탭은 읽기만 허용합니다.' : runtime.blockedReason },
    }
    if (method === 'get_state') {
      const query = object(params, ['projectId', 'trackId', 'clipId', 'trackOffset', 'trackLimit', 'clipOffset', 'clipLimit', 'noteOffset', 'noteLimit'])
      const projectId = identifier(query.projectId, 'projectId')
      if (projectId !== undefined && projectId !== project.id) throw new DomainError('PROJECT_MISMATCH', '현재 열린 프로젝트가 요청한 프로젝트와 다릅니다.', { projectId: project.id, revision: snapshot.revision })
      const trackId = identifier(query.trackId, 'trackId'), clipId = identifier(query.clipId, 'clipId')
      if (trackId && clipId) throw new DomainError('INVALID_REQUEST', 'trackId와 clipId 중 하나만 지정해주세요.')
      const scopedKeys = clipId ? ['noteOffset', 'noteLimit'] : trackId ? ['clipOffset', 'clipLimit'] : ['trackOffset', 'trackLimit']
      for (const key of ['trackOffset', 'trackLimit', 'clipOffset', 'clipLimit', 'noteOffset', 'noteLimit']) {
        if (query[key] !== undefined && !scopedKeys.includes(key)) throw new DomainError('INVALID_REQUEST', `${key}은 현재 조회 범위에서 사용할 수 없습니다.`)
      }
      if (clipId) {
        const track = project.tracks.find(item => item.clips.some(clip => clip.id === clipId))
        const clip = track?.clips.find(item => item.id === clipId)
        if (!track || !clip) throw new DomainError('NOT_FOUND', '리전을 찾을 수 없습니다.', { clipId })
        const offset = page(query.noteOffset, 0, 0, Number.MAX_SAFE_INTEGER, 'noteOffset')
        const limit = page(query.noteLimit, 128, 1, 512, 'noteLimit')
        if (clip.kind === 'audio') {
          if (query.noteOffset !== undefined || query.noteLimit !== undefined) throw new DomainError('INVALID_REQUEST', '오디오 리전에는 음표 페이지가 없습니다.')
          return { ...context, scope: 'clip', track: trackSummary(track), clip: { ...clip } }
        }
        const { notes, ...metadata } = clip
        return { ...context, scope: 'clip', track: trackSummary(track), clip: metadata, noteView: 'source', notes: notes.slice(offset, offset + limit).map(note => ({ ...note })), noteCount: notes.length, noteOffset: offset, nextNoteOffset: offset + limit < notes.length ? offset + limit : null }
      }
      if (trackId) {
        const track = project.tracks.find(item => item.id === trackId)
        if (!track) throw new DomainError('NOT_FOUND', '트랙을 찾을 수 없습니다.', { trackId })
        const offset = page(query.clipOffset, 0, 0, Number.MAX_SAFE_INTEGER, 'clipOffset')
        const limit = page(query.clipLimit, 50, 1, 100, 'clipLimit')
        const clips = track.clips.slice(offset, offset + limit).map(clip => {
          if (clip.kind === 'audio') return { ...clip }
          const { notes, ...metadata } = clip
          return { ...metadata, noteCount: notes.length }
        })
        return { ...context, scope: 'track', track: { ...trackSummary(track), transpose: track.transpose, velocityOffset: track.velocityOffset, keyLimit: [...track.keyLimit], velocityLimit: [...track.velocityLimit], delayTicks: track.delayTicks, instrumentParams: { ...track.instrumentParams }, ...instrumentStateSummary(track), devices: track.devices.map(device => device.type === 'vst3' ? { id: device.id, type: device.type, name: device.name, enabled: device.enabled } : { ...device, params: { ...device.params } }) }, clips, clipOffset: offset, nextClipOffset: offset + limit < track.clips.length ? offset + limit : null }
      }
      const offset = page(query.trackOffset, 0, 0, Number.MAX_SAFE_INTEGER, 'trackOffset')
      const limit = page(query.trackLimit, 50, 1, 100, 'trackLimit')
      return { ...context, scope: 'project', trackCount: project.tracks.length, tracks: project.tracks.slice(offset, offset + limit).map(trackSummary), trackOffset: offset, nextTrackOffset: offset + limit < project.tracks.length ? offset + limit : null }
    }
    if (method === 'get_catalog') {
      const query = object(params, ['kind'])
      const kind = query.kind ?? 'all'
      if (typeof kind !== 'string' || !['all', 'instruments', 'effects'].includes(kind)) throw new DomainError('INVALID_REQUEST', 'kind는 all, instruments, effects 중 하나여야 합니다.')
      return {
        units,
        ...(kind === 'effects' ? {} : { instruments: INSTRUMENTS.map(def => ({ id: def.id, name: def.name, nameKo: def.nameKo, kind: def.kind, category: def.category, isKit: def.isKit, description: def.description, params: def.params.map(param => ({ ...param })), ...(def.isKit ? { padNames: { ...(def.padNames ?? GM_KIT_NAMES) } } : {}) })) }),
        ...(kind === 'instruments' ? {} : { effects: Object.entries(EFFECT_DEFS).map(([id, def]) => ({ id, name: def.name, params: def.params.map(param => ({ ...param })) })) }),
      }
    }
    if (method === 'get_capabilities') {
      object(params, [])
      return { protocol: BRIDGE_PROTOCOL_VERSION, projectId: project.id, revision: snapshot.revision, units, limits: COMMAND_LIMITS, commands: COMMAND_METADATA, commandRequestSchema: COMMAND_REQUEST_SCHEMA, historyRequestSchema: HISTORY_REQUEST_SCHEMA, editAccess: context.editAccess, unsupported, notes: ['프로젝트 상태 적용과 자동 저장 완료는 별개입니다. persistence를 확인하세요.', '마디 1은 beat 0입니다. 생성 결과는 일반 MIDI 리전이며 코드 원본 저장은 아직 지원하지 않습니다.', 'history는 가장 최근 프로젝트 편집을 되돌립니다. 임의의 과거 AI 작업만 선택해서 되돌리지는 않습니다.'] }
    }
    if (method === 'preview_edits') return options.session.preview(params as unknown as CommandRequest)
    if (method === 'apply_edits' || method === 'history') {
      if (!runtime.editsAllowed) throw new DomainError('READ_ONLY', 'AI 연결 창에서 편집 허용을 켜야 프로젝트를 바꿀 수 있습니다.')
      if (runtime.blockedReason) throw new DomainError('DAW_BUSY', runtime.blockedReason)
      const result = method === 'apply_edits' ? options.session.execute(params as unknown as CommandRequest) : options.session.history(params as unknown as HistoryRequest)
      const current = options.session.getSnapshot()
      const committed = current !== snapshot
      const warnings: string[] = []
      if (committed) {
        try { options.onMutation?.(result.summary) }
        catch { warnings.push('프로젝트 편집은 적용됐지만 후속 화면·오디오 갱신을 완료하지 못했습니다. 현재 상태를 다시 확인해주세요.') }
      }
      // A retry returns the original operation result. Report the current revision separately,
      // and do not repeat side effects or claim a new pending save for a cached response.
      return { ...result, currentRevision: current.revision, persistence: committed ? 'pending' : runtime.persistence, ...(warnings.length ? { warnings } : {}) }
    }
    throw new DomainError('METHOD_NOT_SUPPORTED', '지원하지 않는 DAW 명령입니다.')
  }
}

import type { AutomationLane, Project, Track, TrackFreeze } from './types'
import { validateProject } from './project'
import { tempoMapOf } from './tempoMap'

/**
 * Track freeze (docs/BOUNCE_FREEZE_STEMS.md). A frozen track's instrument and 시김새 chain were rendered pre-fader
 * (core/render: freezeRenderProject) into a project asset. While the track's content and the project timing still
 * match the stored signature, engines play that asset instead (playbackProject); fader, pan, mute, solo and
 * sends stay live. Content edits are refused (frozenEditViolation); unfreezing drops the record and its asset.
 */

export const FREEZE_ASSET_PREFIX = 'freeze-'

/** Track fields that shape the pre-fader sound. Everything else (volume, pan, mute, solo, sends, name...) stays live. */
const CONTENT_FIELDS = ['kind', 'instrument', 'transpose', 'velocityOffset', 'keyLimit', 'velocityLimit', 'delayTicks', 'clips',
  'instrumentParams', 'instrumentState', 'devices', 'pluginInstrument'] as const satisfies readonly (keyof Track)[]

/** Volume, pan and mute lanes and send levels are mixing, not content: they stay editable and play live. */
export const isLiveLane = (lane: AutomationLane): boolean => lane.target.kind === 'track' || lane.target.kind === 'send'

function contentOf(track: Track): Record<string, unknown> {
  const content: Record<string, unknown> = {}
  for (const field of CONTENT_FIELDS) content[field] = track[field]
  content.automation = (track.automation ?? []).filter(lane => !isLiveLane(lane))
  return content
}

/** Sorted-key JSON without undefined members, so key order and absent-vs-undefined never change a signature. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

/** Two independent 32-bit FNV-1a passes and the length: a change detector, not a security hash. */
export function hashText(text: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x9e3779b9
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code ^ (index & 0xff), 0x01000193) >>> 0
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}${text.length.toString(36)}`
}

/** Project timing every render depends on: rate, tempo map, length and meter (VST3 hosts read the meter). */
function contextOf(project: Project): Record<string, unknown> {
  return { sampleRate: project.sampleRate, tempo: tempoMapOf(project).points, lengthBeats: project.lengthBeats, timeSignature: project.timeSignature }
}

/** The validated form of a track, so a save/load round trip (which normalizes defaults) keeps the signature. */
function normalizedTrack(project: Project, track: Track): Track {
  const { sends: _sends, inputRoute: _route, freeze: _freeze, render: _render, ...rest } = track
  try {
    return validateProject({ ...project, tracks: [rest], markers: [], loop: { enabled: false, startBeat: 0, endBeat: project.lengthBeats } }).tracks[0]
  } catch { return rest }
}

const signatures = new WeakMap<Track, { context: string; signature: string }>()

/** Identifies what a frozen render was made from: the track's content and the project timing. */
export function freezeSignature(project: Project, track: Track): string {
  const context = canonicalJson(contextOf(project))
  const cached = signatures.get(track)
  if (cached?.context === context) return cached.signature
  const signature = hashText(canonicalJson({ context: contextOf(project), content: contentOf(normalizedTrack(project, track)) }))
  signatures.set(track, { context, signature })
  return signature
}

export type FreezeStatus = 'live' | 'frozen' | 'stale'

/**
 * frozen: the cached render plays. stale: the track is still marked frozen (locked) but its render no longer
 * matches (the tempo, length or rate changed, or the cache is missing), so it plays live until frozen again.
 */
export function freezeStatus(project: Project, track: Track, assets: { has(id: string): boolean }): FreezeStatus {
  if (!track.freeze) return 'live'
  return isFreezeCurrent(project, track, track.freeze, assets) ? 'frozen' : 'stale'
}

function isFreezeCurrent(project: Project, track: Track, freeze: TrackFreeze, assets: { has(id: string): boolean }): boolean {
  return track.kind !== 'return' && freeze.sampleRate === project.sampleRate && assets.has(freeze.assetId) && freezeSignature(project, track) === freeze.signature
}

/** What an engine plays for a frozen track: its cached render through the same fader, pan, mute and sends. */
export function frozenPlaybackTrack(track: Track, freeze: TrackFreeze): Track {
  const { freeze: _freeze, pluginInstrument: _plugin, instrumentState: _state, inputRoute: _route, midiInput: _midi, automation, ...rest } = track
  const live = (automation ?? []).filter(isLiveLane)
  return { ...rest, kind: 'audio', clips: [], devices: [], armed: false, monitor: false, monitorMode: 'off',
    ...(live.length ? { automation: live } : {}), render: { ...track.render, frozen: { assetId: freeze.assetId, tailSeconds: freeze.tailSeconds } } }
}

const playbackTracks = new WeakMap<Track, Track>()
const playbackProjects = new WeakMap<Project, { assets: unknown; size: number; result: Project }>()

/**
 * The project an engine renders: every currently frozen track replaced by its cached render. Identity is kept
 * per track (and per project while the asset map is unchanged), so engine diffs see no change between calls.
 */
export function playbackProject(project: Project, assets: ReadonlyMap<string, unknown>): Project {
  if (!project.tracks.some(track => track.freeze)) return project
  const cached = playbackProjects.get(project)
  if (cached && cached.assets === assets && cached.size === assets.size) return cached.result
  let changed = false
  const tracks = project.tracks.map(track => {
    if (!track.freeze || !isFreezeCurrent(project, track, track.freeze, assets)) return track
    changed = true
    let derived = playbackTracks.get(track)
    if (!derived) { derived = frozenPlaybackTrack(track, track.freeze); playbackTracks.set(track, derived) }
    return derived
  })
  const result = changed ? { ...project, tracks } : project
  playbackProjects.set(project, { assets, size: assets.size, result })
  return result
}

/**
 * The first frozen track whose content this edit changes (null when the edit is allowed). Freezing, unfreezing,
 * deleting and mixing a frozen track are allowed; changing its regions, instrument or chain is not.
 */
export function frozenEditViolation(previous: Project, next: Project): Track | null {
  if (previous === next) return null
  const before = new Map(previous.tracks.map(track => [track.id, track]))
  for (const track of next.tracks) {
    if (!track.freeze) continue
    const old = before.get(track.id)
    if (!old?.freeze || old === track) continue
    if (CONTENT_FIELDS.every(field => old[field] === track[field]) && old.automation === track.automation) continue
    if (canonicalJson(contentOf(old)) !== canonicalJson(contentOf(track))) return track
  }
  return null
}

export const FROZEN_EDIT_MESSAGE = (name: string): string => `"${name}" 트랙은 얼려져 있어 편집할 수 없습니다. 얼림을 해제한 뒤 편집해 주세요.`

/** Freeze assets no project in `projects` (the present and its undo/redo states) refers to. */
export function unusedFreezeAssets(projects: readonly Project[], assetIds: Iterable<string>): string[] {
  const used = new Set(projects.flatMap(project => project.tracks.flatMap(track => track.freeze ? [track.freeze.assetId] : [])))
  return [...assetIds].filter(id => id.startsWith(FREEZE_ASSET_PREFIX) && !used.has(id))
}

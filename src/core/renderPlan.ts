import type { AudioClip, AutomationLane, Clip, Project, RenderBitDepth, Track } from './types'
import type { SampleRate } from './audioSettings'
import { cloneDevice, createTrack, uid } from './project'
import { audibleTrackIds, isTrackEnabled, loopEnd } from './playback'
import { isReturnTrack } from './sends'
import { tempoMapOf } from './tempoMap'
import { isLiveLane } from './freeze'

/**
 * Offline render plans for bounce in place, freeze and stem export (docs/BOUNCE_FREEZE_STEMS.md). Each plan is a
 * derived project handed to an engine's renderAudio(); both engines render it with the same graph as WAV export,
 * so results are sample-aligned with the normal export.
 */

const strip = <T extends object>(value: T, ...keys: (keyof T)[]): T => {
  const copy = { ...value }
  for (const key of keys) delete copy[key]
  return copy
}

/** A project rendering only `track`, pre-fader (no pan, fader, mute or sends), with the cycle off. */
function soloPreFader(project: Project, track: Track, lengthBeats = project.lengthBeats): Project {
  const lanes = (track.automation ?? []).filter(lane => !isLiveLane(lane))
  const solo: Track = { ...strip(track, 'freeze', 'render', 'sends', 'automation'), volume: 1, pan: 0, mute: false, solo: false, soloSafe: false,
    ...(lanes.length ? { automation: lanes } : {}), render: { preFader: true } }
  return { ...project, lengthBeats, masterVolume: 1, loop: { enabled: false, startBeat: 0, endBeat: lengthBeats }, tracks: [solo], markers: [] }
}

/** Freeze render: the whole track over the whole project with its own tail (the render's trackTailSeconds). */
export function freezeRenderProject(project: Project, trackId: string): Project {
  const track = project.tracks.find(item => item.id === trackId)
  if (!track) throw new Error('얼릴 트랙을 찾을 수 없습니다.')
  if (isReturnTrack(track)) throw new Error('리턴 트랙은 얼릴 수 없습니다.')
  return soloPreFader(project, track)
}

export interface BounceOptions {
  /** Render the 시김새 chain into the audio (true) or bounce dry and copy the chain to the new track. */
  includeEffects: boolean
  /** Seconds rendered after the last region ends (release and effect tails), 0…30. */
  tailSeconds: number
  /** Raise the bounced region's gain so its peak reaches −0.3 dBFS (non-destructive). Off by default. */
  normalize: boolean
}
export const DEFAULT_BOUNCE_OPTIONS: BounceOptions = { includeEffects: true, tailSeconds: 2, normalize: false }
export const NORMALIZE_PEAK = 10 ** (-0.3 / 20)

export interface BouncePlan {
  trackId: string
  clipIds: string[]
  /** Musical range of the bounced regions; the new region starts at startBeat. */
  startBeat: number
  endBeat: number
  /** Derived project to render with { preMaster: true, tailSeconds, startFrame, bitDepth: 32 }. */
  project: Project
  tailSeconds: number
  startFrame: number
}

const clipEnd = (track: Track, clip: Clip, projectEnd: number): number => clip.loop ? loopEnd(track, clip, projectEnd) : clip.startBeat + clip.lengthBeats

/** Bounce in place of a whole track (clipIds omitted: every unmuted region) or of selected regions on one track. */
export function planBounce(project: Project, trackId: string, clipIds: readonly string[] | null, options: BounceOptions): BouncePlan {
  const track = project.tracks.find(item => item.id === trackId)
  if (!track) throw new Error('바운스할 트랙을 찾을 수 없습니다.')
  if (isReturnTrack(track)) throw new Error('리턴 트랙은 제자리 바운스할 수 없습니다. 스템 내보내기를 사용해 주세요.')
  const chosen = clipIds ? new Set(clipIds) : null
  const clips = track.clips.filter(clip => !clip.mute && (!chosen || chosen.has(clip.id)))
  if (!clips.length) throw new Error(chosen ? '바운스할 리전을 선택해 주세요. 뮤트된 리전은 바운스하지 않습니다.' : '바운스할 리전이 없습니다.')
  const startBeat = Math.max(0, Math.min(...clips.map(clip => clip.startBeat)))
  const endBeat = Math.min(project.lengthBeats, Math.max(...clips.map(clip => clipEnd(track, clip, project.lengthBeats))))
  if (!(endBeat > startBeat)) throw new Error('바운스할 범위가 프로젝트 길이 밖에 있습니다.')
  const source: Track = { ...track, clips, ...(options.includeEffects ? {} : { devices: [], automation: (track.automation ?? []).filter(lane => lane.target.kind !== 'device') }) }
  const tailSeconds = Math.min(30, Math.max(0, Number.isFinite(options.tailSeconds) ? options.tailSeconds : 0))
  const startFrame = Math.round(tempoMapOf(project).frameAt(startBeat, project.sampleRate))
  return { trackId, clipIds: clips.map(clip => clip.id), startBeat, endBeat, project: soloPreFader(project, source, endBeat), tailSeconds, startFrame }
}

/**
 * Applies a rendered bounce: a new audio track after the source with one region of the render, the source
 * track muted (whole-track bounce) or the bounced regions muted (region bounce). The new track keeps the
 * source's fader, pan, sends and volume/pan/send automation; a dry bounce also gets a copy of the chain.
 */
export function applyBounce(project: Project, plan: BouncePlan, asset: { id: string; name: string; seconds: number; peak: number }, options: BounceOptions, wholeTrack: boolean): { project: Project; trackId: string; clipId: string } {
  const track = project.tracks.find(item => item.id === plan.trackId)
  if (!track) throw new Error('바운스한 트랙이 사라졌습니다.')
  const tempo = tempoMapOf(project)
  const lengthBeats = Math.max(0.001, Math.min(project.lengthBeats, tempo.beatAfter(plan.startBeat, asset.seconds)) - plan.startBeat)
  const gain = options.normalize && asset.peak > 1e-9 ? Math.min(15.8, NORMALIZE_PEAK / asset.peak) : 1
  const clip: AudioClip = { id: uid(), name: asset.name, kind: 'audio', startBeat: plan.startBeat, lengthBeats, gain, assetId: asset.id, offsetSeconds: 0, fadeIn: 0, fadeOut: 0 }
  const lanes: AutomationLane[] = (track.automation ?? []).filter(isLiveLane).map(lane => ({ ...lane, id: uid(), points: lane.points.map(point => ({ ...point })) }))
  const base = createTrack('audio')
  const bounced: Track = {
    ...base, name: `${track.name} 바운스`.slice(0, 512), color: track.color, volume: track.volume, pan: track.pan,
    ...(track.icon ? { icon: track.icon } : {}),
    ...(track.sends?.length ? { sends: track.sends.map(send => ({ ...send })) } : {}),
    devices: options.includeEffects ? [] : track.devices.map(device => cloneDevice(device)),
    clips: [clip],
    ...(lanes.length ? { automation: lanes } : {}),
  }
  const chosen = new Set(plan.clipIds)
  const source: Track = wholeTrack ? { ...track, mute: true } : { ...track, clips: track.clips.map(item => chosen.has(item.id) ? { ...item, mute: true } : item) }
  const index = project.tracks.findIndex(item => item.id === track.id)
  const tracks = [...project.tracks.slice(0, index), source, bounced, ...project.tracks.slice(index + 1)]
  return { project: { ...project, tracks }, trackId: bounced.id, clipId: clip.id }
}

export type MasterTap = 'pre' | 'post'
export interface StemOptions {
  tracks: boolean
  returns: boolean
  /** pre: without master volume and master processor (stems then sum to the pre-master mix). */
  master: MasterTap
  /** Every stem starts here (beats) and lasts to the project end plus the mix's render tail. */
  startBeat: number
  sampleRate: SampleRate
  bitDepth: RenderBitDepth
  /** File name pattern: {n} (01, 02…), {track}, {project}, {type} (track | return). */
  pattern: string
}
export const DEFAULT_STEM_PATTERN = '{n} {track}'

export interface StemPlan {
  kind: 'track' | 'return'
  trackId: string
  name: string
  fileName: string
  /** Derived project to render with { preMaster, tailSeconds (shared), startFrame, bitDepth }. */
  project: Project
}
export interface StemSkip { trackId: string; name: string; reason: string }

/** Windows-safe file stem (no path separators, reserved names or trailing dots). */
export function safeFileStem(name: string): string {
  let stem = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').replace(/[. ]+$/g, '').trim().slice(0, 120)
  if (!stem || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `_${stem || 'stem'}`
  return stem
}

/** Expands the pattern for one stem; an empty result falls back to the track name. */
export function stemFileName(pattern: string, fields: { index: number; total: number; track: string; project: string; kind: 'track' | 'return' }): string {
  const width = Math.max(2, String(fields.total).length)
  const expanded = (pattern || DEFAULT_STEM_PATTERN)
    .replaceAll('{n}', String(fields.index).padStart(width, '0'))
    .replaceAll('{track}', fields.track)
    .replaceAll('{project}', fields.project)
    .replaceAll('{type}', fields.kind === 'return' ? 'return' : 'track')
  return safeFileStem(expanded.trim() ? expanded : fields.track)
}

/** Appends " (2)", " (3)"… to names already used (case-insensitively, as Windows and macOS compare them). */
export function uniqueNames(names: readonly string[], extension: string): string[] {
  const used = new Set<string>()
  return names.map(name => {
    let candidate = name, counter = 2
    while (used.has(`${candidate}.${extension}`.toLowerCase())) candidate = `${name} (${counter++})`
    used.add(`${candidate}.${extension}`.toLowerCase())
    return `${candidate}.${extension}`
  })
}

/**
 * One stem per audible track (alone, without its sends) and per audible return (fed by every audible sender,
 * whose own output stays out of the master). Pre-master stems sum to the pre-master mix. Audibility (mute, solo,
 * track on/off) is decided once on the full project: muted and solo-excluded tracks are skipped, not rendered.
 */
export function planStems(project: Project, options: StemOptions): { stems: StemPlan[]; skipped: StemSkip[] } {
  const audible = audibleTrackIds(project.tracks)
  const skipped: StemSkip[] = []
  // Solo is resolved above; each stem keeps the mix's audibility without depending on which tracks it contains.
  const fixed = project.tracks.map((track): Track => {
    const heard = audible.has(track.id)
    const automation = heard ? track.automation : track.automation?.filter(lane => !(lane.target.kind === 'track' && lane.target.param === 'mute'))
    return { ...strip(track, 'automation'), solo: false, soloSafe: false, mute: !heard, ...(automation?.length ? { automation } : {}) }
  })
  const base: Project = { ...project, sampleRate: options.sampleRate, masterVolume: options.master === 'pre' ? 1 : project.masterVolume,
    loop: { enabled: false, startBeat: 0, endBeat: project.lengthBeats }, markers: [] }
  const candidates: Omit<StemPlan, 'fileName'>[] = []
  for (const track of fixed) {
    const original = project.tracks.find(item => item.id === track.id)!
    const wanted = isReturnTrack(track) ? options.returns : options.tracks
    if (!wanted) continue
    if (!audible.has(track.id)) {
      skipped.push({ trackId: track.id, name: track.name, reason: !isTrackEnabled(original) ? '트랙이 꺼져 있음' : original.mute ? '뮤트됨' : '솔로에서 제외됨' })
      continue
    }
    if (!isReturnTrack(track)) {
      candidates.push({ kind: 'track', trackId: track.id, name: track.name, project: { ...base, tracks: [strip(track, 'sends')] } })
      continue
    }
    const senders = fixed.filter(item => !isReturnTrack(item)).map(item => ({ ...item, render: { ...item.render, directOut: false as const } }))
    candidates.push({ kind: 'return', trackId: track.id, name: track.name, project: { ...base, tracks: [...senders, track] } })
  }
  const names = candidates.map((stem, index) => stemFileName(options.pattern, { index: index + 1, total: candidates.length, track: stem.name, project: project.name, kind: stem.kind }))
  const files = uniqueNames(names, 'wav')
  return { stems: candidates.map((stem, index) => ({ ...stem, fileName: files[index] })), skipped }
}

/** The first frame every stem keeps (after plug-in delay compensation), at the stem rate. */
export function stemStartFrame(project: Project, startBeat: number, sampleRate: number): number {
  const beat = Math.min(Math.max(0, startBeat), project.lengthBeats)
  return Math.round(tempoMapOf(project).frameAt(beat, sampleRate))
}

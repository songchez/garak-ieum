import type { AudioClip, AudioWarp, Project } from '../../core/types'
import type { WarpDecision } from './tempo'
import { WARP_RENDER_LIMITS } from './limits'
import { assetScale, playOriginal, sameTransposeRender, transposeTarget } from '../region-pitch/state'

/** Same range as the project tempo, so "프로젝트 템포로 설정" is always valid. */
export const WARP_BPM = { min: 30, max: 300 } as const
const EPSILON = 1e-9

const fail = (message: string): never => { throw new Error(message) }
function finite(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${path} must be between ${min} and ${max}.`)
  return value as number
}

/** Parses into a fresh object; unknown fields are dropped like every other project field. */
export function validateWarp(input: unknown, path = 'Audio warp'): AudioWarp {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(`${path} must be an object.`)
  const value = input as Record<string, unknown>
  if (typeof value.enabled !== 'boolean') fail(`${path} enabled must be true or false.`)
  if (typeof value.originalAssetId !== 'string' || !value.originalAssetId || value.originalAssetId.length > 200) fail(`${path} original asset ID is invalid.`)
  return {
    enabled: value.enabled as boolean,
    sourceBpm: finite(value.sourceBpm, `${path} source tempo`, WARP_BPM.min, WARP_BPM.max),
    firstBeatSeconds: finite(value.firstBeatSeconds, `${path} first beat`, 0, 10_000_000),
    confidence: finite(value.confidence, `${path} confidence`, 0, 1),
    originalAssetId: value.originalAssetId as string,
    renderBpm: finite(value.renderBpm, `${path} render tempo`, WARP_BPM.min, WARP_BPM.max),
  }
}

/** Rules between the clip and its warp: which asset is audible in each state. */
export function checkWarpClip(clip: Pick<AudioClip, 'assetId' | 'pitch' | 'regionPitch'>, warp: AudioWarp, path: string): void {
  if (clip.pitch) fail(`${path} cannot combine pitch editing with warp.`)
  const identity = Math.abs(warp.renderBpm - warp.sourceBpm) < EPSILON
  // A region-pitch render may be audible while warp is off; checkTransposeClip owns that rule.
  const transposed = !!clip.regionPitch?.rendered
  if (!warp.enabled && !transposed && clip.assetId !== warp.originalAssetId) fail(`${path} keeps a warp render while warp is off.`)
  if (!warp.enabled && !identity) fail(`${path} records a render tempo while warp is off.`)
  if (warp.enabled && !identity && clip.assetId === warp.originalAssetId) fail(`${path} is missing its warp render.`)
}

const sameBpm = (a: number, b: number) => Math.abs(a - b) < 1e-6
const scaleLoop = (clip: AudioClip, factor: number) => clip.loopLengthBeats === undefined ? {} : { loopLengthBeats: clip.loopLengthBeats * factor }

/** Output length / input length for a render at projectBpm. */
export const warpRatio = (sourceBpm: number, projectBpm: number) => sourceBpm / projectBpm

export function warpRatioSupported(sourceBpm: number, projectBpm: number): boolean {
  const ratio = warpRatio(sourceBpm, projectBpm)
  return ratio >= WARP_RENDER_LIMITS.minRatio && ratio <= WARP_RENDER_LIMITS.maxRatio
}

/** Attach import analysis to a fresh clip that still plays its original file at project tempo. */
export function clipWithWarpDecision(clip: AudioClip, decision: WarpDecision, projectBpm: number): AudioClip {
  const warp: AudioWarp = {
    enabled: false, sourceBpm: decision.sourceBpm, firstBeatSeconds: decision.firstBeatSeconds,
    confidence: decision.confidence, originalAssetId: clip.assetId, renderBpm: decision.sourceBpm,
  }
  const detected = { ...clip, warp }
  return decision.enabled && warpRatioSupported(decision.sourceBpm, projectBpm) ? enableWarp(detected, projectBpm) : detected
}

/** Detected or typed tempo for a clip that has none yet. Warp stays off. */
export function attachWarpTempo(clip: AudioClip, tempo: { bpm: number; confidence: number; firstBeatSeconds: number }): AudioClip {
  if (clip.pitch) throw new Error('피치 편집을 초기화한 뒤 템포를 지정할 수 있습니다.')
  const sourceBpm = Math.min(WARP_BPM.max, Math.max(WARP_BPM.min, tempo.bpm))
  if (clip.warp) {
    const next = setWarpSourceBpm(clip, sourceBpm)
    return { ...next, warp: { ...next.warp!, confidence: tempo.confidence, firstBeatSeconds: tempo.firstBeatSeconds } }
  }
  const originalAssetId = clip.regionPitch?.originalAssetId ?? clip.assetId
  return { ...clip, warp: { enabled: false, sourceBpm, firstBeatSeconds: tempo.firstBeatSeconds, confidence: tempo.confidence, originalAssetId, renderBpm: sourceBpm } }
}

/**
 * Warp on: the visible source material keeps its place, and the clip length becomes
 * fixed in beats (source seconds × sourceBpm / 60). The original stays audible until the
 * renderer installs a stretched asset (renderBpm === sourceBpm marks that state).
 */
export function enableWarp(input: AudioClip, projectBpm: number): AudioClip {
  if (!input.warp || input.warp.enabled || input.pitch) return input
  // A region-pitch render is rebuilt together with the warp (one render).
  const clip = playOriginal(input), warp = clip.warp!
  const factor = warp.sourceBpm / projectBpm
  return {
    ...clip, assetId: warp.originalAssetId, lengthBeats: clip.lengthBeats * factor, ...scaleLoop(clip, factor),
    warp: { ...warp, enabled: true, renderBpm: warp.sourceBpm },
  }
}

/** Seconds in the current asset → seconds in the original file (warp and varispeed renders). */
const sourceOffset = (clip: AudioClip) => clip.offsetSeconds / assetScale(clip)
/** The original file plays again; any region-pitch render waits for the next combined render. */
const withoutTransposeRender = (clip: AudioClip): Pick<AudioClip, 'regionPitch'> => {
  if (!clip.regionPitch?.rendered) return clip.regionPitch ? { regionPitch: clip.regionPitch } : {}
  const { rendered: _rendered, ...rest } = clip.regionPitch
  return { regionPitch: rest }
}

/** Warp off: original asset, original timing at the current project tempo. */
export function disableWarp(clip: AudioClip, projectBpm: number): AudioClip {
  const warp = clip.warp
  if (!warp || !warp.enabled) return clip
  const factor = projectBpm / warp.sourceBpm
  return {
    ...clip, assetId: warp.originalAssetId, offsetSeconds: sourceOffset(clip), lengthBeats: clip.lengthBeats * factor, ...scaleLoop(clip, factor),
    ...withoutTransposeRender(clip),
    warp: { ...warp, enabled: false, renderBpm: warp.sourceBpm },
  }
}

/**
 * A corrected source tempo. While warped, the same source seconds stay visible and the
 * beat length follows the new tempo; the render is rebuilt. While off, nothing audible changes.
 */
export function setWarpSourceBpm(clip: AudioClip, sourceBpm: number): AudioClip {
  const warp = clip.warp
  if (!warp || !Number.isFinite(sourceBpm)) return clip
  const next = Math.round(Math.min(WARP_BPM.max, Math.max(WARP_BPM.min, sourceBpm)) * 1000) / 1000
  if (sameBpm(next, warp.sourceBpm)) return clip
  if (!warp.enabled) return { ...clip, warp: { ...warp, sourceBpm: next, renderBpm: next, confidence: 0 } }
  const factor = next / warp.sourceBpm
  return {
    ...clip, assetId: warp.originalAssetId, offsetSeconds: sourceOffset(clip), lengthBeats: clip.lengthBeats * factor, ...scaleLoop(clip, factor),
    ...withoutTransposeRender(clip),
    warp: { ...warp, sourceBpm: next, renderBpm: next, confidence: 0 },
  }
}

/** The region badge / context menu switch: on fits the project tempo, off restores the original timing. */
export function setClipWarp(clip: AudioClip, enabled: boolean, projectBpm: number): AudioClip {
  const warp = clip.warp
  if (!warp || clip.pitch || warp.enabled === enabled) return clip
  if (!enabled) return disableWarp(clip, projectBpm)
  return warpRatioSupported(warp.sourceBpm, projectBpm) ? enableWarp(clip, projectBpm) : clip
}

/**
 * A project-audio item placed again (library drag, "add") inherits the tempo its file
 * already has in this project: same detected tempo, warped if the existing region is.
 * A warp render placed directly is replaced by its original so it can follow the tempo.
 */
export function inheritWarp(clip: AudioClip, project: Pick<Project, 'bpm' | 'tracks'>, durationOf: (assetId: string) => number | undefined): AudioClip {
  if (clip.warp || clip.pitch || clip.regionPitch) return clip
  let source: AudioWarp | undefined
  for (const track of project.tracks) for (const other of track.clips) {
    if (source || other.kind !== 'audio' || !other.warp) continue
    if (other.warp.originalAssetId === clip.assetId || other.assetId === clip.assetId) source = other.warp
  }
  if (!source) return clip
  const duration = durationOf(source.originalAssetId)
  if (duration === undefined || !Number.isFinite(duration) || duration <= 0) return clip
  const plain: AudioClip = {
    ...clip, assetId: source.originalAssetId, offsetSeconds: 0, lengthBeats: duration * project.bpm / 60,
    warp: { ...source, enabled: false, renderBpm: source.sourceBpm },
  }
  return source.enabled ? setClipWarp(plain, true, project.bpm) : plain
}

/** Warped clips whose audible asset was not rendered for this tempo. */
export function warpNeedsRender(clip: AudioClip, projectBpm: number): boolean {
  return !!clip.warp?.enabled && !sameBpm(clip.warp.renderBpm, projectBpm)
}

/** True when the warp needs a stretch at projectBpm (enabled and the tempos differ). */
export const warpStretches = (clip: Pick<AudioClip, 'warp'>, projectBpm: number) => !!clip.warp?.enabled && !sameBpm(clip.warp.sourceBpm, projectBpm)

/** Warp tempo and/or region pitch differ from what the audible asset carries. */
export function clipNeedsRender(clip: AudioClip, projectBpm: number): boolean {
  return warpNeedsRender(clip, projectBpm) || !sameTransposeRender(clip.regionPitch?.rendered, transposeTarget(clip))
}

/** The audible asset should simply be the original file (no stretch, no transposition). */
export const clipRenderIsIdentity = (clip: AudioClip, projectBpm: number) => !warpStretches(clip, projectBpm) && !transposeTarget(clip)

/**
 * Install a render made for projectBpm and the clip's current pitch settings (or the
 * original when neither applies). offsetSeconds moves into the new asset's seconds.
 */
export function withClipRender(clip: AudioClip, projectBpm: number, assetId: string): AudioClip {
  const warp = clip.warp
  const target = transposeTarget(clip)
  const identity = clipRenderIsIdentity(clip, projectBpm)
  const original = clip.regionPitch?.originalAssetId ?? warp?.originalAssetId ?? clip.assetId
  const nextWarp = warp ? { ...warp, renderBpm: warpStretches(clip, projectBpm) ? projectBpm : warp.sourceBpm } : undefined
  let transpose = clip.regionPitch
  if (transpose) {
    const { rendered: _rendered, ...rest } = transpose
    transpose = target ? { ...rest, rendered: target } : rest
    if (!target && rest.semitones === 0 && rest.cents === 0 && rest.mode === 'keep' && !rest.formant) transpose = undefined
  }
  const nextAssetId = identity ? original : assetId
  const next: AudioClip = { ...clip, assetId: nextAssetId }
  if (nextWarp) next.warp = nextWarp
  if (transpose) next.regionPitch = transpose
  else delete next.regionPitch
  const unchanged = nextAssetId === clip.assetId && nextWarp?.renderBpm === warp?.renderBpm
    && sameTransposeRender(transpose?.rendered, clip.regionPitch?.rendered) && !!transpose === !!clip.regionPitch
  if (unchanged) return clip
  next.offsetSeconds = clip.offsetSeconds * assetScale(next) / assetScale(clip)
  return next
}

/** Warp-only install, kept for callers that predate region pitch. */
export function withWarpRender(clip: AudioClip, projectBpm: number, assetId: string): AudioClip {
  if (!clip.warp?.enabled) return clip
  return withClipRender(clip, projectBpm, assetId)
}

/** Key for the combined warp + pitch render a clip needs at projectBpm. */
export function clipRenderKey(clip: AudioClip, projectBpm: number): string {
  const original = clip.regionPitch?.originalAssetId ?? clip.warp?.originalAssetId ?? clip.assetId
  const tempo = warpStretches(clip, projectBpm) ? `${clip.warp!.sourceBpm}|${projectBpm}` : '1|1'
  const target = transposeTarget(clip)
  const pitch = target ? `${target.cents}|${target.mode}${target.formant ? '|f' : ''}` : '0'
  return `${original}|${tempo}|${pitch}`
}

/** Key for one stretched render shared by every clip of the same file and tempos. */
export const warpRenderKey = (warp: Pick<AudioWarp, 'originalAssetId' | 'sourceBpm'>, projectBpm: number) => `${warp.originalAssetId}|${warp.sourceBpm}|${projectBpm}`

/**
 * "프로젝트 템포로 설정": the project adopts the clip's source tempo. An unwarped clip is
 * rescaled so its material stays fully visible at the new tempo; a warped clip already
 * keeps its beats and simply plays its original file.
 */
export function adoptClipTempo(clip: AudioClip, projectBpm: number): { bpm: number; clip: AudioClip } | null {
  const warp = clip.warp
  if (!warp) return null
  const bpm = warp.sourceBpm
  if (warp.enabled) return { bpm, clip }
  const factor = bpm / projectBpm
  return { bpm, clip: { ...clip, lengthBeats: clip.lengthBeats * factor, ...scaleLoop(clip, factor) } }
}

/** Every asset a clip needs kept: the audible one and the warp original. */
export function clipAssetIds(clip: AudioClip): string[] {
  const ids = [clip.assetId]
  if (clip.pitch) ids.push(clip.pitch.sourceAssetId)
  if (clip.warp && clip.warp.originalAssetId !== clip.assetId) ids.push(clip.warp.originalAssetId)
  if (clip.regionPitch && clip.regionPitch.originalAssetId !== clip.assetId && !ids.includes(clip.regionPitch.originalAssetId)) ids.push(clip.regionPitch.originalAssetId)
  return ids
}

import type { AudioClip, AudioTranspose, AudioTransposeRender, TransposeMode } from '../../core/types'

/**
 * Region pitch (docs/REGION_PITCH.md). Two modes, like Ableton's Warp on/off or Reaper's
 * "preserve pitch":
 * - keep (템포 유지): pitch moves, length stays; an offline Signalsmith render.
 * - varispeed (자연스럽게): pitch and speed move together like tape, so the region gets
 *   shorter going up and longer going down (rate = 2^(cents/1200)). Also rendered offline,
 *   which keeps every offset, fade, loop and crossfade in timeline seconds in both engines.
 * While a render is pending, the previous asset keeps playing (same as warp).
 */
export const TRANSPOSE_LIMITS = { semitones: 24, cents: 50 } as const
export const TRANSPOSE_MODES: readonly TransposeMode[] = ['keep', 'varispeed']
export const TRANSPOSE_MODE_LABELS: Record<TransposeMode, string> = { keep: '템포 유지', varispeed: '자연스럽게' }

/** What the user can set on a region. */
export interface TransposeSettings { semitones: number; cents: number; mode: TransposeMode; formant: boolean }
export const DEFAULT_TRANSPOSE: TransposeSettings = { semitones: 0, cents: 0, mode: 'keep', formant: false }

const fail = (message: string): never => { throw new Error(message) }
const clampInt = (value: number, limit: number) => Math.max(-limit, Math.min(limit, Math.round(Number.isFinite(value) ? value : 0)))

export const transposeSettings = (clip: Pick<AudioClip, 'regionPitch'>): TransposeSettings => {
  const t = clip.regionPitch
  return t ? { semitones: t.semitones, cents: t.cents, mode: t.mode, formant: !!t.formant } : { ...DEFAULT_TRANSPOSE }
}
export const totalCents = (settings: Pick<TransposeSettings, 'semitones' | 'cents'>) => settings.semitones * 100 + settings.cents
export const isDefaultTranspose = (settings: Pick<TransposeSettings, 'semitones' | 'cents'>) => totalCents(settings) === 0
/** Pitch factor for a number of cents. */
export const pitchFactor = (cents: number) => 2 ** (cents / 1200)
/** Playback speed relative to the original: 1 in keep mode, the pitch factor in varispeed. */
export const transposeRate = (settings: Pick<TransposeSettings, 'semitones' | 'cents' | 'mode'>) => settings.mode === 'varispeed' ? pitchFactor(totalCents(settings)) : 1

export function normalizeTranspose(settings: TransposeSettings): TransposeSettings {
  let semitones = clampInt(settings.semitones, TRANSPOSE_LIMITS.semitones)
  let cents = clampInt(settings.cents, TRANSPOSE_LIMITS.cents)
  // ±24 semitones is the hard limit: +24 st +30 ct reads as +24 st.
  if (Math.abs(semitones) === TRANSPOSE_LIMITS.semitones && Math.sign(cents) === Math.sign(semitones)) cents = 0
  if (Object.is(semitones, -0)) semitones = 0
  if (Object.is(cents, -0)) cents = 0
  const mode: TransposeMode = settings.mode === 'varispeed' ? 'varispeed' : 'keep'
  return { semitones, cents, mode, formant: mode === 'keep' && !!settings.formant }
}

/** The transposition a clip's audible asset should carry; undefined = none (0 cents). */
export function transposeTarget(clip: Pick<AudioClip, 'regionPitch'>): AudioTransposeRender | undefined {
  const t = clip.regionPitch
  if (!t) return undefined
  const cents = totalCents(t)
  if (cents === 0) return undefined
  return { cents, mode: t.mode, formant: t.mode === 'keep' && !!t.formant }
}

export const sameTransposeRender = (a: AudioTransposeRender | undefined, b: AudioTransposeRender | undefined) =>
  a === b || (!!a && !!b && a.cents === b.cents && a.mode === b.mode && a.formant === b.formant)

/** Asset seconds per original-file second contributed by an installed transposition. */
export const transposeRenderScale = (render: AudioTransposeRender | undefined) => render?.mode === 'varispeed' ? 1 / pitchFactor(render.cents) : 1

/** Asset seconds per original-file second for the clip's current assetId (warp × varispeed). */
export function assetScale(clip: Pick<AudioClip, 'warp' | 'regionPitch'>): number {
  const warp = clip.warp
  const warpScale = warp?.enabled ? warp.sourceBpm / warp.renderBpm : 1
  return warpScale * transposeRenderScale(clip.regionPitch?.rendered)
}

/** The file every render of this clip starts from. */
export const originalAssetOf = (clip: Pick<AudioClip, 'assetId' | 'warp' | 'regionPitch'>) => clip.regionPitch?.originalAssetId ?? clip.warp?.originalAssetId ?? clip.assetId

/**
 * Plays the original file again, with offsetSeconds converted to original seconds. Length and
 * settings are unchanged; the renderer installs whatever render the settings now ask for.
 */
export function playOriginal(clip: AudioClip): AudioClip {
  const scale = assetScale(clip)
  const original = originalAssetOf(clip)
  const rendered = !!clip.regionPitch?.rendered
  const warpRendered = !!clip.warp && clip.warp.renderBpm !== clip.warp.sourceBpm
  if (clip.assetId === original && !rendered && !warpRendered) return clip
  const next: AudioClip = { ...clip, assetId: original, offsetSeconds: clip.offsetSeconds / scale }
  if (clip.warp) next.warp = { ...clip.warp, renderBpm: clip.warp.sourceBpm }
  if (clip.regionPitch) {
    const { rendered: _rendered, ...rest } = clip.regionPitch
    if (isDefaultTranspose(rest)) delete next.regionPitch
    else next.regionPitch = rest
  }
  return next
}

/**
 * New pitch settings for one region. In varispeed the region keeps its start and the same
 * source material, so its length (and manual loop end) scale by oldRate / newRate. The audible
 * asset stays until the renderer installs the new render. One call = one undo step.
 */
export function setClipTranspose(clip: AudioClip, input: TransposeSettings): AudioClip {
  if (clip.pitch) return clip
  const prev = transposeSettings(clip)
  const next = normalizeTranspose(input)
  if (prev.semitones === next.semitones && prev.cents === next.cents && prev.mode === next.mode && prev.formant === next.formant) return clip
  const factor = transposeRate(prev) / transposeRate(next)
  const scaled: AudioClip = Math.abs(factor - 1) < 1e-12 ? { ...clip } : {
    ...clip, lengthBeats: clip.lengthBeats * factor,
    ...(clip.loopLengthBeats === undefined ? {} : { loopLengthBeats: clip.loopLengthBeats * factor }),
  }
  const rendered = clip.regionPitch?.rendered
  const transpose: AudioTranspose = {
    semitones: next.semitones, cents: next.cents, mode: next.mode, ...(next.formant ? { formant: true } : {}),
    originalAssetId: originalAssetOf(clip), ...(rendered ? { rendered } : {}),
  }
  scaled.regionPitch = transpose
  // Back to 0 with nothing transposed in the asset (or only a warp render left): no render needed.
  if (isDefaultTranspose(next) && !next.formant && next.mode === 'keep') return playOriginalUnlessWarped(scaled)
  return scaled
}

function playOriginalUnlessWarped(clip: AudioClip): AudioClip {
  if (!clip.regionPitch) return clip
  if (!clip.regionPitch.rendered) { const { regionPitch: _t, ...rest } = clip; return rest }
  // A warped clip still needs its warp render; the renderer swaps it in (usually from cache).
  if (clip.warp?.enabled) return clip
  return playOriginal(clip)
}

/** Relative change used by the region menu and shortcuts: ±1 or ±12 semitones. */
export function shiftTranspose(settings: TransposeSettings, semitones: number): TransposeSettings {
  return normalizeTranspose({ ...settings, semitones: settings.semitones + semitones })
}

export const formatTranspose = (settings: Pick<TransposeSettings, 'semitones' | 'cents'>) => {
  const s = settings.semitones, c = settings.cents
  const semis = s > 0 ? `+${s}` : s < 0 ? `−${-s}` : '0'
  if (!c) return semis
  return `${semis}${c > 0 ? '+' : '−'}${Math.abs(c)}¢`
}

/* ---------- validation ---------- */

const integer = (value: unknown, path: string, limit: number) => {
  if (typeof value !== 'number' || !Number.isInteger(value) || Math.abs(value) > limit) fail(`${path} must be a whole number between −${limit} and ${limit}.`)
  return value as number
}
const mode = (value: unknown, path: string): TransposeMode => {
  if (value !== 'keep' && value !== 'varispeed') fail(`${path} mode must be keep or varispeed.`)
  return value as TransposeMode
}

export function validateTranspose(input: unknown, path = 'Region pitch'): AudioTranspose {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(`${path} must be an object.`)
  const value = input as Record<string, unknown>
  const semitones = integer(value.semitones, `${path} semitones`, TRANSPOSE_LIMITS.semitones)
  const cents = integer(value.cents, `${path} cents`, TRANSPOSE_LIMITS.cents)
  if (Math.abs(semitones * 100 + cents) > TRANSPOSE_LIMITS.semitones * 100) fail(`${path} is beyond ±${TRANSPOSE_LIMITS.semitones} semitones.`)
  if (value.formant !== undefined && typeof value.formant !== 'boolean') fail(`${path} formant must be true or false.`)
  if (typeof value.originalAssetId !== 'string' || !value.originalAssetId || value.originalAssetId.length > 200) fail(`${path} original asset ID is invalid.`)
  const result: AudioTranspose = { semitones, cents, mode: mode(value.mode, path), originalAssetId: value.originalAssetId as string }
  if (value.formant === true) result.formant = true
  if (value.rendered !== undefined) {
    if (!value.rendered || typeof value.rendered !== 'object' || Array.isArray(value.rendered)) fail(`${path} render must be an object.`)
    const r = value.rendered as Record<string, unknown>
    const renderedCents = integer(r.cents, `${path} render cents`, TRANSPOSE_LIMITS.semitones * 100)
    if (renderedCents === 0) fail(`${path} records an empty render.`)
    if (typeof r.formant !== 'boolean') fail(`${path} render formant must be true or false.`)
    result.rendered = { cents: renderedCents, mode: mode(r.mode, `${path} render`), formant: r.formant as boolean }
  }
  return result
}

/** Rules between a clip, its warp and its transposition: which asset is audible in each state. */
export function checkTransposeClip(clip: Pick<AudioClip, 'assetId' | 'pitch' | 'warp' | 'regionPitch'>, path: string): void {
  const t = clip.regionPitch
  if (!t) return
  if (clip.pitch) fail(`${path} cannot combine note pitch editing with region pitch.`)
  if (clip.warp && clip.warp.originalAssetId !== t.originalAssetId) fail(`${path} region pitch and warp disagree about the original file.`)
  const warpIdentity = !clip.warp?.enabled || Math.abs(clip.warp.renderBpm - clip.warp.sourceBpm) < 1e-9
  const identity = warpIdentity && !t.rendered
  if (identity && clip.assetId !== t.originalAssetId) fail(`${path} keeps a pitch render without a transposition.`)
  if (!identity && clip.assetId === t.originalAssetId) fail(`${path} is missing its pitch render.`)
}

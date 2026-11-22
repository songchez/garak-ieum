import type { AudioClip, Clip, FadeCurve, Project, Track } from './types'
import { spanBeats, spanSeconds, tempoMapOf, type Tempo } from './tempoMap.js'

/**
 * Region gain and fades (docs/REGION_GAIN_FADES.md). Both engines evaluate the same envelope:
 * gain × fadeIn(curve) × fadeOut(curve), fades in seconds of the audible (trimmed) region.
 */

export const FADE_CURVES: readonly FadeCurve[] = ['linear', 'equalPower', 'sCurve', 'exponential', 'logarithmic']
export const FADE_CURVE_LABELS: Readonly<Record<FadeCurve, string>> = {
  linear: '직선',
  equalPower: '등전력 (크로스페이드용)',
  sCurve: 'S 곡선',
  exponential: '지수 (천천히 시작)',
  logarithmic: '로그 (빠르게 시작)',
}
/** Wire codes for the native engine (native/src/protocol.hpp). */
export const FADE_CURVE_CODES: Readonly<Record<FadeCurve, number>> = { linear: 0, equalPower: 1, sCurve: 2, exponential: 3, logarithmic: 4 }

/** Region gain range: −∞…+24 dB for audio. MIDI region gain scales velocity, 0…2. */
export const CLIP_GAIN_MIN_DB = -60
export const AUDIO_CLIP_GAIN_MAX_DB = 24
export const AUDIO_CLIP_GAIN_MAX = 10 ** (AUDIO_CLIP_GAIN_MAX_DB / 20)
export const MIDI_CLIP_GAIN_MAX = 2
/** Normalize target for peak normalization. */
export const NORMALIZE_TARGET_DB = -0.1
/** Length given to a crossfade between regions that only touch ("create crossfade"). */
export const DEFAULT_CROSSFADE_SECONDS = 0.025

export const isFadeCurve = (value: unknown): value is FadeCurve => typeof value === 'string' && (FADE_CURVES as readonly string[]).includes(value)
export const fadeCurveOf = (value: FadeCurve | undefined): FadeCurve => isFadeCurve(value) ? value : 'linear'

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))

/** Gain of a fade at progress x (0 = silent end, 1 = full level). Equal power in/out sum to constant power. */
export function fadeShape(curve: FadeCurve | undefined, x: number): number {
  const t = clamp(x, 0, 1)
  switch (curve) {
    case 'equalPower': return Math.sin(t * Math.PI / 2)
    case 'sCurve': return (1 - Math.cos(t * Math.PI)) / 2
    case 'exponential': return t * t
    case 'logarithmic': return 1 - (1 - t) * (1 - t)
    default: return t
  }
}

/** Fades may not overlap: when they add up to more than the region, both shrink in proportion. */
export function fadeLengths(duration: number, fadeIn: number, fadeOut: number): [number, number] {
  const d = Math.max(0, Number.isFinite(duration) ? duration : 0)
  const a = clamp(fadeIn, 0, d), b = clamp(fadeOut, 0, d)
  const total = a + b
  return total > d && total > 0 ? [a * d / total, b * d / total] : [a, b]
}

/** Envelope without gain at `position` seconds inside the audible region; fades are already limited by fadeLengths. */
export function envelopeAt(position: number, duration: number, fadeIn: number, fadeOut: number, inCurve?: FadeCurve, outCurve?: FadeCurve): number {
  if (!(duration > 0) || position < 0 || position > duration) return 0
  const inGain = fadeIn > 0 ? fadeShape(inCurve, position / fadeIn) : 1
  const outGain = fadeOut > 0 ? fadeShape(outCurve, (duration - position) / fadeOut) : 1
  return Math.min(inGain, outGain)
}

/** Breakpoints (seconds) for a piecewise-linear schedule; curved fades get `segments` steps (< 0.05 dB error at 32). */
export function envelopeBreakpoints(duration: number, fadeIn: number, fadeOut: number, inCurve?: FadeCurve, outCurve?: FadeCurve, segments = 32): number[] {
  const points = new Set<number>([0, duration])
  const add = (from: number, length: number, curve: FadeCurve | undefined) => {
    if (!(length > 0)) return
    const steps = fadeCurveOf(curve) === 'linear' ? 1 : segments
    for (let i = 0; i <= steps; i += 1) points.add(from + length * i / steps)
  }
  add(0, fadeIn, inCurve)
  add(duration - fadeOut, fadeOut, outCurve)
  return [...points].filter(p => p >= 0 && p <= duration).sort((a, b) => a - b)
}

export const gainToDb = (gain: number): number => gain <= 0.001 ? CLIP_GAIN_MIN_DB : Math.max(CLIP_GAIN_MIN_DB, 20 * Math.log10(gain))
export const clipGainMax = (clip: Pick<Clip, 'kind'>): number => clip.kind === 'audio' ? AUDIO_CLIP_GAIN_MAX : MIDI_CLIP_GAIN_MAX
export const clipGainMaxDb = (clip: Pick<Clip, 'kind'>): number => clip.kind === 'audio' ? AUDIO_CLIP_GAIN_MAX_DB : 20 * Math.log10(MIDI_CLIP_GAIN_MAX)

/** −60 dB and below is silence, like the inspector field. */
export function withClipGainDb<T extends Clip>(clip: T, db: number): T {
  const max = clipGainMax(clip)
  const gain = !Number.isFinite(db) || db <= CLIP_GAIN_MIN_DB ? 0 : Math.min(max, 10 ** (db / 20))
  return Math.abs(gain - clip.gain) < 1e-9 ? clip : { ...clip, gain }
}

export type FadeEdge = 'in' | 'out'

/** Seconds of the region's audible length (trimmed to the source). */
export function clipSeconds(clip: AudioClip, tempo: Tempo, sourceSeconds = Infinity): number {
  return Math.max(0, Math.min(spanSeconds(tempo, clip.startBeat, clip.startBeat + clip.lengthBeats), sourceSeconds - Math.max(0, clip.offsetSeconds)))
}

/** Sets one fade; it can use whatever the other fade leaves of the region. */
export function withFade(clip: AudioClip, edge: FadeEdge, seconds: number, regionSeconds: number): AudioClip {
  const other = edge === 'in' ? clip.fadeOut : clip.fadeIn
  const value = clamp(seconds, 0, Math.max(0, regionSeconds - Math.min(other, regionSeconds)))
  const key = edge === 'in' ? 'fadeIn' : 'fadeOut'
  return Math.abs(clip[key] - value) < 1e-9 ? clip : { ...clip, [key]: value }
}

/** Linear is stored as an absent field so unchanged regions save exactly as before schema 10. */
export function withFadeCurve(clip: AudioClip, edge: FadeEdge, curve: FadeCurve): AudioClip {
  const key = edge === 'in' ? 'fadeInCurve' : 'fadeOutCurve'
  if (fadeCurveOf(clip[key]) === curve) return clip
  const { [key]: _old, ...rest } = clip
  return curve === 'linear' ? rest as AudioClip : { ...rest, [key]: curve } as AudioClip
}

/** Peak (0…1+) of the region's audible source range across all channels. */
export function regionPeak(channels: readonly Float32Array[], sampleRate: number, offsetSeconds: number, durationSeconds: number): number {
  let peak = 0
  const from = Math.max(0, Math.floor(offsetSeconds * sampleRate))
  for (const data of channels) {
    const to = Math.min(data.length, Math.ceil((offsetSeconds + durationSeconds) * sampleRate))
    for (let i = from; i < to; i += 1) { const v = Math.abs(data[i]); if (v > peak) peak = v }
  }
  return peak
}

/** Gain that brings `peak` to the normalize target; null for silence. */
export function normalizeGain(peak: number, targetDb = NORMALIZE_TARGET_DB): number | null {
  if (!(peak > 1e-6)) return null
  return Math.min(AUDIO_CLIP_GAIN_MAX, 10 ** (targetDb / 20) / peak)
}

const EPSILON = 1e-7
const endOf = (clip: Clip) => clip.startBeat + clip.lengthBeats

/** Both regions read the same file in one continuous take (a split edit): their audio is identical in the overlap. */
export function isContinuousSplice(a: AudioClip, b: AudioClip, tempo: Tempo): boolean {
  return a.assetId === b.assetId && Math.abs(b.offsetSeconds - a.offsetSeconds - spanSeconds(tempo, a.startBeat, b.startBeat)) < 1e-3
}

/**
 * Crossfades an earlier/later pair over `overlapBeats`. Different material gets equal power (constant loudness);
 * a continuous splice of one take gets equal gain (linear), which sums back to the original without a +3 dB bump
 * (equal gain vs equal power rule).
 */
function crossfadePair(a: AudioClip, b: AudioClip, overlapBeats: number, tempo: Tempo): [AudioClip, AudioClip] {
  const seconds = spanSeconds(tempo, b.startBeat, b.startBeat + overlapBeats)
  const curve: FadeCurve = isContinuousSplice(a, b, tempo) ? 'linear' : 'equalPower'
  const left = withFadeCurve({ ...a, fadeOut: seconds }, 'out', curve)
  const right = withFadeCurve({ ...b, fadeIn: seconds }, 'in', curve)
  return [left, right]
}

/**
 * "크로스페이드 만들기": for each pair of selected audio regions on one track that touch or overlap,
 * an overlap gets a crossfade across it (see crossfadePair for the curve); regions that only touch are first extended into
 * each other by up to DEFAULT_CROSSFADE_SECONDS of source handle (edit crossfade).
 * `sourceSeconds` returns an asset's length (Infinity when unknown).
 */
export function crossfadeClips(project: Project, clipIds: ReadonlySet<string>, sourceSeconds: (assetId: string) => number, lengthSeconds = DEFAULT_CROSSFADE_SECONDS): { project: Project; count: number } {
  const tempo = tempoMapOf(project)
  let count = 0
  const tracks = project.tracks.map(track => {
    const chosen = track.clips.filter((c): c is AudioClip => c.kind === 'audio' && clipIds.has(c.id)).sort((x, y) => x.startBeat - y.startBeat)
    if (chosen.length < 2) return track
    const replaced = new Map<string, AudioClip>()
    const current = (clip: AudioClip) => replaced.get(clip.id) ?? clip
    for (let i = 0; i + 1 < chosen.length; i += 1) {
      let a = current(chosen[i]), b = current(chosen[i + 1])
      if (b.startBeat > endOf(a) + EPSILON || endOf(b) <= endOf(a) + EPSILON) continue
      let overlap = endOf(a) - b.startBeat
      if (overlap <= EPSILON) {
        const joint = endOf(a)
        const want = spanBeats(tempo, joint, lengthSeconds / 2) - spanBeats(tempo, joint, -lengthSeconds / 2)
        const aRoom = Math.max(0, spanBeats(tempo, a.startBeat, sourceSeconds(a.assetId) - a.offsetSeconds) - a.lengthBeats)
        const bRoom = Math.max(0, Math.min(-spanBeats(tempo, b.startBeat, -b.offsetSeconds), b.startBeat))
        let aExt = Math.min(aRoom, want / 2), bExt = Math.min(bRoom, want / 2)
        aExt = Math.min(aRoom, aExt + (want / 2 - bExt)); bExt = Math.min(bRoom, bExt + (want / 2 - aExt))
        if (aExt + bExt <= EPSILON) continue
        a = { ...a, lengthBeats: a.lengthBeats + aExt, ...(a.loopLengthBeats === undefined ? {} : { loopLengthBeats: Math.max(a.loopLengthBeats, a.lengthBeats + aExt) }) }
        if (bExt > 0) b = { ...b, startBeat: b.startBeat - bExt, lengthBeats: b.lengthBeats + bExt, offsetSeconds: Math.max(0, b.offsetSeconds - spanSeconds(tempo, b.startBeat - bExt, b.startBeat)),
          ...(b.loopLengthBeats === undefined ? {} : { loopLengthBeats: b.loopLengthBeats + bExt }) }
        overlap = aExt + bExt
      }
      const [left, right] = crossfadePair(a, b, overlap, tempo)
      replaced.set(left.id, left); replaced.set(right.id, right)
      count += 1
    }
    if (!replaced.size) return track
    return { ...track, clips: track.clips.map(c => replaced.get(c.id) ?? c) }
  })
  return count ? { project: { ...project, tracks }, count } : { project, count }
}

/**
 * Drag mode "크로스페이드" (X-Fade): a moved audio region that partly overlaps another audio region
 * on its track crossfades with it over the overlap. MIDI and regions that cover each other are left
 * unchanged for the caller to resolve like "겹치지 않음".
 */
export function crossfadeOverlaps(track: Track, moved: ReadonlySet<string>, tempo: Tempo): Track {
  const replaced = new Map<string, AudioClip>()
  const current = (clip: AudioClip) => replaced.get(clip.id) ?? clip
  const audio = track.clips.filter((c): c is AudioClip => c.kind === 'audio')
  for (const mover of audio.filter(c => moved.has(c.id))) {
    for (const other of audio) {
      if (other.id === mover.id || moved.has(other.id)) continue
      const m = current(mover), o = current(other)
      const [a, b] = m.startBeat <= o.startBeat ? [m, o] : [o, m]
      const overlap = endOf(a) - b.startBeat
      if (overlap <= EPSILON || endOf(b) <= endOf(a) + EPSILON || b.startBeat <= a.startBeat + EPSILON) continue
      const [left, right] = crossfadePair(a, b, overlap, tempo)
      replaced.set(left.id, left); replaced.set(right.id, right)
    }
  }
  return replaced.size ? { ...track, clips: track.clips.map(c => replaced.get(c.id) ?? c) } : track
}

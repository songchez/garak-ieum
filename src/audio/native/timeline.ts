import { isSampleRate, type SampleRate } from '../../core/audioSettings'
import { EFFECT_DEFS, type ParamDef } from '../../core/devices'
import { instrumentDef, isInstrumentId } from '../../core/instruments'
import { quarterNotesPerBar, validateTimeSignature } from '../../core/meter'
import { meterMapOf } from '../../core/meterMap'
import { audibleTrackIds, audioWindows, clipOccurrences, isTrackEnabled, loopEnd, playbackControllers, playbackNotes, playbackSustain, type Occurrence } from '../../core/playback'
import { BEND_RANGE_NUMBER, controllerNumber, controllerSpec } from '../../core/controllers'
import type { EffectType, MidiClip, Project, TimeSignature, Track, TrackInputRoute, TrackInputTap } from '../../core/types'
import { reconcileTrackRoutes, routeOf } from '../../core/trackRouting'
import { reconcileSends, sendsOf } from '../../core/sends'
import { loopRange } from '../math'
import { tempoMapOf, type TempoMap } from '../../core/tempoMap'
import { AUDIO_CLIP_GAIN_MAX, FADE_CURVE_CODES, fadeCurveOf, fadeLengths } from '../../core/clipEnvelope.js'
import { combineWavetablePatch, type WavetablePatch } from '../../devices/wavetable-synth/model'
import type { NativePluginInstance } from './contracts'
import { automationShape, isActiveLane, isDiscrete, targetDef } from '../../core/automation'

/** Compilation limits, not promises about native device or plugin capacity. No PCM is allocated here. */
export const NATIVE_TIMELINE_LIMITS = {
  durationSeconds: 3600,
  tracks: 256,
  clips: 4096,
  sourceNotes: 100_000,
  expandedNotes: 100_000,
  audioWindows: 8192,
  audioWindowsPerTrack: 2048,
  occurrencesPerClip: 4096,
  insertsPerTrack: 64,
  /** Controller events per track (CC64 for VST3 instruments, controller lanes for every instrument). */
  controlsPerTrack: 100_000,
} as const

export type NativeTimelineErrorCode = 'INVALID_PROJECT' | 'INVALID_PCM_ASSET' | 'MISSING_PCM_ASSET' | 'LIMIT_EXCEEDED' | 'UNSUPPORTED_SOURCE' | 'INVALID_POSITION'
export class NativeTimelineError extends Error {
  constructor(readonly code: NativeTimelineErrorCode, message: string) { super(message); this.name = 'NativeTimelineError' }
}

/** Metadata for an already decoded PCM asset. Its rate can differ from the project rate. */
/** Same proportional fade limit as the Web Audio engine (core/clipEnvelope.ts fadeLengths). */
function fadeFrames(clipLengthFrames: number, fadeIn: number, fadeOut: number): { fadeInFrames: number; fadeOutFrames: number } {
  const [a, b] = fadeLengths(clipLengthFrames, fadeIn, fadeOut)
  const fadeInFrames = Math.min(clipLengthFrames, Math.round(a))
  return { fadeInFrames, fadeOutFrames: Math.min(clipLengthFrames - fadeInFrames, Math.round(b)) }
}

export interface NativePcmAsset {
  readonly id: string
  readonly sampleRate: number
  readonly frames: number
  readonly channels: number
}

export type NativeTrackSource =
  | { readonly kind: 'audio' }
  | { readonly kind: 'native-wavetable'; readonly instrumentId: 'wavetable'; readonly isKit: false; readonly patch: WavetablePatch }
  | { readonly kind: 'vst3'; readonly plugin: NativePluginInstance; readonly isKit: false }
  | { readonly kind: 'builtin-synth'; readonly instrumentId: string; readonly isKit: boolean; readonly params: Readonly<Record<string, number>> }
  | { readonly kind: 'builtin-sampled'; readonly instrumentId: string; readonly sampleSetId: string; readonly isKit: boolean; readonly params: Readonly<Record<string, number>> }

export interface NativeBuiltinInsert {
  readonly id: string
  readonly type: EffectType
  readonly enabled: boolean
  readonly params: Readonly<Record<string, number>>
}

export interface NativePluginInsert {
  readonly id: string
  readonly type: 'vst3'
  readonly enabled: boolean
  readonly params: Readonly<Record<string, number>>
  readonly plugin: NativePluginInstance
}

/**
 * One on/off pair, not raw MIDI bytes. IDs are unique within this compiled revision.
 * onFrame can be negative after a musical delay; offFrame and limitFrame are exclusive.
 * velocity retains clip gain (0..2), so consumers must not silently clamp it to MIDI velocity.
 * Schedule off events before on events at an equal frame; preserve IDs for overlapping pitches.
 */
export interface NativeNotePair {
  readonly id: number
  readonly clipId: string
  readonly occurrenceIndex: number
  readonly onFrame: number
  readonly offFrame: number
  readonly limitFrame: number
  readonly pitch: number
  readonly velocity: number
}

/**
 * A controller event delivered sample-accurately (docs/MIDI_CONTROLLERS.md). controller: 0–127 CC (value 0…127),
 * 128 channel aftertouch (0…127), 129 pitch bend (−8192…8191), 130 program change (0…127), 131 pitch-bend range in
 * semitones (0…48, built-in instruments only). VST3 receives everything including CC64; IEUM WAVE everything but
 * CC64 and 131; built-in synths/samplers everything but CC64 and 130 (the pedal is in their note-off frames).
 */
export interface NativeControlEvent {
  readonly frame: number
  readonly controller: number
  readonly value: number
}

export interface NativeAudioWindow {
  readonly id: number
  readonly clipId: string
  readonly assetId: string
  readonly startFrame: number
  readonly endFrame: number
  /** Source PCM coordinates, possibly fractional when trimmed/resampled. All other frames use project rate. */
  readonly sourceStartFrame: number
  readonly sourceSampleRate: number
  /** Envelope position inside the audible, trimmed clip; overlap cuts do not restart its fades. */
  readonly clipOffsetFrames: number
  readonly clipLengthFrames: number
  readonly gain: number
  readonly fadeInFrames: number
  readonly fadeOutFrames: number
  /** FADE_CURVE_CODES: 0 linear, 1 equal power, 2 S-curve, 3 exponential, 4 logarithmic. */
  readonly fadeInCurve: number
  readonly fadeOutCurve: number
  /** A frozen track's cached render (docs/BOUNCE_FREEZE_STEMS.md): no click guard, may run into the export tail. */
  readonly freeze?: true
  /** Frozen windows: the track's own tail, so the export keeps the unfrozen length. */
  readonly tailSeconds?: number
}

export interface NativeTrackInput {
  readonly channels: readonly [number] | readonly [number, number]
}

export type NativeTrackRoute =
  | { readonly kind: 'track'; readonly trackId: string; readonly tap: TrackInputTap }
  | { readonly kind: 'master' }
  | { readonly kind: 'none' }

/** One aux send (docs/SENDS_RETURNS.md): linear gain into a return track, after (default) or before the fader. */
export interface NativeTrackSend {
  readonly returnId: string
  readonly gain: number
  readonly pre: boolean
}

/** A compiled automation lane (docs/AUTOMATION.md). Values stay normalized; the host maps them with
 * minimum/maximum/logarithmic/options exactly like core/automation.ts automationValue(). */
export interface NativeAutomationLane {
  readonly target:
    | { readonly kind: 'volume' | 'pan' | 'mute' }
    | { readonly kind: 'insert'; readonly insertId: string; readonly param: string }
    | { readonly kind: 'instrument'; readonly param: string }
    | { readonly kind: 'send'; readonly returnId: string }
  readonly minimum: number
  readonly maximum: number
  readonly logarithmic?: boolean
  readonly options?: readonly number[]
  /** Fractional project frames, sorted. */
  readonly points: readonly { readonly frame: number; readonly value: number; readonly curve?: number }[]
}

export interface NativeTrackTimeline {
  readonly id: string
  /** A return (aux) track: an audio source with no windows, fed by other tracks' sends; it never sends. */
  readonly return?: boolean
  /** Only on audio/instrument tracks, only to existing return tracks (already reconciled here). */
  readonly sends?: readonly NativeTrackSend[]
  readonly source: NativeTrackSource
  readonly gain: number
  readonly pan: number
  readonly enabled: boolean
  readonly mute: boolean
  readonly solo: boolean
  readonly soloSafe: boolean
  /** Fader audibility; muted/unsoloed tracks still have events, but disabled sources must not run. */
  readonly audible: boolean
  /** Physical device input channels this track records and monitors; null is the device's first channel or pair. */
  readonly input: NativeTrackInput | null
  /** Internal input (docs/TRACK_INPUT_ROUTING.md): another track at a tap, the master feed, or silence.
   * When present the track records/monitors it instead of `input`. Loops and missing sources are already
   * resolved to `none` here; the host re-checks. */
  readonly route?: NativeTrackRoute
  readonly inserts: readonly (NativeBuiltinInsert | NativePluginInsert)[]
  /** Sorted by onset, then off frame and ID. Notes are cropped to the project, not the audition cycle. */
  readonly notes: readonly NativeNotePair[]
  /** Sorted by frame. Only VST3 instruments receive the pedal as events (docs/SUSTAIN_PEDAL.md); built-in and
   * IEUM WAVE sources get it applied to their note-off frames instead, identically to the Web Audio engine. */
  readonly controls: readonly NativeControlEvent[]
  readonly audio: readonly NativeAudioWindow[]
  /** Active lanes only; absent when the track has none. */
  readonly automation?: readonly NativeAutomationLane[]
  /** Offline render taps (TrackRenderTap): out of the master sum (return stems) / pre-fader (freeze, bounce). */
  readonly directOut?: false
  readonly preFader?: true
  /** Fader audibility with the track unmuted (solo applied); present when a mute lane is active. */
  readonly unmutedAudible?: boolean
}

export interface NativeProjectTimeline {
  readonly version: 1
  readonly projectId: string
  readonly revision: number
  readonly sampleRate: SampleRate
  /** Quarter-note tempo at beat 0, even in compound meters. */
  readonly bpm: number
  /** Tempo map (docs/TEMPO_MAP.md) when the tempo changes: points sorted by beat, the first at beat 0 with `bpm`.
   * Every frame in this timeline was already placed through it; the host uses it for the metronome, the
   * tempo-synced effects and plug-in transport (native/src/tempo.hpp mirrors core/tempoMap.ts). */
  readonly tempoMap?: readonly { readonly beat: number; readonly bpm: number; readonly curve: 'step' | 'ramp' }[]
  readonly timeSignature: Readonly<TimeSignature>
  readonly beatsPerBar: number
  /** Time-signature changes (docs/METER_MAP.md) when the meter changes: events sorted by bar, the first at bar 0 with
   * `timeSignature`; `beat` is the bar line in quarter notes (core/meterMap.ts). The host accents each bar's first
   * pulse (native/include/garak/meter.hpp recomputes `beat` from the bars and rejects a mismatch). */
  readonly meterMap?: readonly { readonly bar: number; readonly beat: number; readonly numerator: number; readonly denominator: number }[]
  readonly lengthFrames: number
  readonly cycle: { readonly startFrame: number; readonly endFrame: number } | null
  readonly masterGain: number
  readonly assets: readonly NativePcmAsset[]
  readonly tracks: readonly NativeTrackTimeline[]
}

function limit(condition: boolean, description: string): void {
  if (!condition) throw new NativeTimelineError('LIMIT_EXCEEDED', `Native timeline limit exceeded: ${description}.`)
}
function number(value: number, minimum: number, maximum: number, description: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new NativeTimelineError('INVALID_PROJECT', `Invalid ${description}.`)
  }
  return value
}
function id(value: string): string {
  if (typeof value !== 'string' || !value.length || value.length > 200) throw new NativeTimelineError('INVALID_PROJECT', 'Invalid editing object ID.')
  return value
}
function parameters(defs: readonly ParamDef[], values: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(defs.map(def => [def.id, number(values[def.id] ?? def.default, def.min, def.max, `parameter ${def.id}`)]))
}
function source(track: Track): NativeTrackSource {
  if (track.kind === 'audio' || track.kind === 'return') return { kind: 'audio' }
  if (track.pluginInstrument) return { kind: 'vst3', plugin: { ...track.pluginInstrument, parameters: { ...track.pluginInstrument.parameters }, ...(track.pluginInstrument.state ? { state: { ...track.pluginInstrument.state } } : {}) }, isKit: false }
  if (track.kind !== 'instrument' || !isInstrumentId(track.instrument)) {
    throw new NativeTimelineError('UNSUPPORTED_SOURCE', 'Only existing builtin instruments and audio tracks can be compiled.')
  }
  const def = instrumentDef(track.instrument)
  if (def.kind === 'native') {
    if (def.id !== 'wavetable') throw new NativeTimelineError('UNSUPPORTED_SOURCE', 'Unknown native instrument module.')
    try {
      return { kind: 'native-wavetable', instrumentId: 'wavetable', isKit: false, patch: combineWavetablePatch(track.instrumentParams, track.instrumentState) }
    } catch (error) {
      throw new NativeTimelineError('INVALID_PROJECT', `Invalid IEUM WAVE patch: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const common = { instrumentId: def.id, isKit: def.isKit, params: parameters(def.params, track.instrumentParams) }
  if (def.kind === 'sampled' && def.set) return { kind: 'builtin-sampled', ...common, sampleSetId: def.set }
  return { kind: 'builtin-synth', ...common }
}

/** Running totals of the expansion limits across tracks, in project track order. */
interface ExpansionBudget { sourceNotes: number; expandedNotes: number; audioWindows: number }

/** Project-wide identity checks: unique project/track/clip IDs, clip bounds and kinds. Cheap; never expands. */
function checkIdentities(project: Project): void {
  limit(project.tracks.length <= NATIVE_TIMELINE_LIMITS.tracks, 'tracks')
  const seen = new Set<string>([id(project.id)])
  const unique = (value: string) => {
    if (seen.has(id(value))) throw new NativeTimelineError('INVALID_PROJECT', 'Duplicate track or clip ID.')
    seen.add(value)
  }
  let clips = 0
  for (const track of project.tracks) {
    unique(track.id)
    limit(track.devices.length <= NATIVE_TIMELINE_LIMITS.insertsPerTrack, 'inserts per track')
    clips += track.clips.length
    limit(clips <= NATIVE_TIMELINE_LIMITS.clips, 'clips')
    for (const clip of track.clips) {
      unique(clip.id)
      number(clip.startBeat, 0, 10_000_000, 'clip start')
      number(clip.lengthBeats, 0.000001, 10_000_000, 'clip length')
      if ((clip.kind === 'midi') !== (track.kind === 'instrument')) {
        throw new NativeTimelineError('UNSUPPORTED_SOURCE', 'Clip and track source kinds must agree.')
      }
    }
  }
}

/** Preflight of one track before playbackNotes/audioWindows allocate expanded arrangements (audio overlap
 * resolution is quadratic). `budget` holds the totals of the tracks before it and is advanced here. */
function prepareOccurrences(track: Track, lengthBeats: number, budget: ExpansionBudget): Map<MidiClip, readonly Occurrence[]> {
  const prepared = new Map<MidiClip, readonly Occurrence[]>()
  let trackAudio = 0
  for (const clip of track.clips) {
    if (clip.kind === 'midi') {
      budget.sourceNotes += clip.notes.length
      limit(budget.sourceNotes <= NATIVE_TIMELINE_LIMITS.sourceNotes, 'source notes')
      if (!clip.notes.length && !clip.controllers) continue
    }
    if (clip.mute) continue
    const occurrences = clipOccurrences(track, clip, lengthBeats)
    // core/playback intentionally caps its helper at 4096; never silently compile a truncated loop.
    const end = loopEnd(track, clip, lengthBeats)
    limit(occurrences.length <= NATIVE_TIMELINE_LIMITS.occurrencesPerClip
      && !!occurrences.length && occurrences[occurrences.length - 1].end >= end - 1e-9, 'region repeat occurrences')
    if (clip.kind === 'midi') {
      budget.expandedNotes += occurrences.length * clip.notes.length
      limit(budget.expandedNotes <= NATIVE_TIMELINE_LIMITS.expandedNotes, 'expanded note candidates')
      prepared.set(clip, occurrences)
    } else {
      trackAudio += occurrences.length
      budget.audioWindows += occurrences.length
      limit(trackAudio <= NATIVE_TIMELINE_LIMITS.audioWindowsPerTrack, 'audio windows per track')
      limit(budget.audioWindows <= NATIVE_TIMELINE_LIMITS.audioWindows, 'audio windows')
    }
  }
  return prepared
}

function nativeRoute(route: TrackInputRoute | undefined): { route?: NativeTrackRoute } {
  if (!route) return {}
  return { route: route.kind === 'track' ? { kind: 'track', trackId: route.trackId, tap: route.tap } : { kind: route.kind } }
}

/** The host maps these physical channels to whatever the open device delivers; the label stays in the project. */
function trackInput(track: Track): NativeTrackInput | null {
  if (!track.input) return null
  const channels = track.input.channels
  if (!Array.isArray(channels) || (channels.length !== 1 && channels.length !== 2) || !channels.every(channel => Number.isSafeInteger(channel) && channel >= 0 && channel <= 255) || (channels.length === 2 && channels[0] === channels[1])) {
    throw new NativeTimelineError('INVALID_PROJECT', 'Invalid track input channels.')
  }
  return { channels: channels.length === 1 ? [channels[0]] : [channels[0], channels[1]] }
}

/** Track fields the expanded events (notes, controllers, audio windows) depend on; see core/playback.ts.
 * Mixer, insert, send, automation and instrument-parameter edits leave a track's events untouched. */
const EVENT_FIELDS = ['clips', 'kind', 'instrument', 'transpose', 'velocityOffset', 'keyLimit', 'velocityLimit', 'delayTicks', 'render'] as const

/** One track's expanded events. Note and window IDs are unique per track (they start at 0 in every track),
 * so an edit renumbers only its own track. */
interface TrackEvents {
  readonly notes: readonly NativeNotePair[]
  readonly controls: readonly NativeControlEvent[]
  readonly audio: readonly NativeAudioWindow[]
  readonly assets: readonly NativePcmAsset[]
  readonly sourceNotes: number
  readonly expandedNotes: number
  readonly audioWindows: number
}
interface CacheEntry<T> { readonly key: readonly unknown[]; readonly value: T }
const sameKey = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, index) => value === b[index])

/**
 * Incremental compilation for the native host (R3, docs/RENDER_DIFF_PROTOCOL.md). Produces exactly what
 * compileNativeTimeline() produces, but reuses a track's expanded events and automation lanes while their inputs
 * are unchanged: projects are immutable with structural sharing, so an untouched track keeps its `clips` array
 * and a volume edit never re-expands notes. Reused arrays are the same objects, which lets the sync layer send
 * only what changed.
 */
export class NativeTimelineCompiler {
  private readonly events = new Map<string, CacheEntry<TrackEvents>>()
  private readonly lanes = new Map<string, CacheEntry<{ automation?: NativeAutomationLane[]; muted: boolean }>>()
  /** Tracks whose events were expanded (not reused) by the last compile, for tests and diagnostics. */
  lastExpanded: string[] = []

  compile(project: Project, pcmAssets: ReadonlyMap<string, NativePcmAsset> = new Map(), revision = 0): NativeProjectTimeline {
    this.lastExpanded = []
    const timeline = compileTimeline(project, pcmAssets, revision, this)
    const live = new Set(project.tracks.map(track => track.id))
    for (const cache of [this.events, this.lanes]) for (const key of [...cache.keys()]) if (!live.has(key)) cache.delete(key)
    return timeline
  }

  /** @internal */ reusableEvents(trackId: string, key: readonly unknown[]): TrackEvents | undefined {
    const hit = this.events.get(trackId)
    return hit && sameKey(hit.key, key) ? hit.value : undefined
  }

  /** @internal */ storeEvents(trackId: string, key: readonly unknown[], value: TrackEvents): void {
    this.events.set(trackId, { key, value })
    this.lastExpanded.push(trackId)
  }

  /** @internal */ cachedLanes(trackId: string, key: readonly unknown[], build: () => { automation?: NativeAutomationLane[]; muted: boolean }) {
    const hit = this.lanes.get(trackId)
    if (hit && sameKey(hit.key, key)) return hit.value
    const value = build()
    this.lanes.set(trackId, { key, value })
    return value
  }
}

/**
 * Pure preparation for the native host; it allocates no realtime audio objects.
 * Input must be a normalized Project (external JSON still goes through validateProject first).
 * Musical endpoints use nearest-sample rounding, never accumulated interval rounding. Subsample
 * events that collapse to zero frames are omitted. Expansion limits reject instead of truncating.
 */
export function compileNativeTimeline(project: Project, pcmAssets: ReadonlyMap<string, NativePcmAsset> = new Map(), revision = 0): NativeProjectTimeline {
  return compileTimeline(project, pcmAssets, revision, null)
}

function compileTimeline(project: Project, pcmAssets: ReadonlyMap<string, NativePcmAsset>, revision: number, cache: NativeTimelineCompiler | null): NativeProjectTimeline {
  if (!isSampleRate(project.sampleRate)) throw new NativeTimelineError('INVALID_PROJECT', 'Invalid project sample rate.')
  if (!Number.isSafeInteger(revision) || revision < 0) throw new NativeTimelineError('INVALID_PROJECT', 'Invalid project revision.')
  const sampleRate = project.sampleRate
  const bpm = number(project.bpm, 20, 400, 'quarter-note tempo')
  // Musical positions → project frames through the tempo map, rounded once per endpoint.
  const tempo = tempoMapOf(project)
  const frameOf = (beat: number): number => Math.round(tempo.frameAt(beat, sampleRate))
  const lengthBeats = number(project.lengthBeats, 0.001, 10_000_000, 'project length')
  limit(tempo.secondsAt(lengthBeats) <= NATIVE_TIMELINE_LIMITS.durationSeconds, 'project duration')
  const lengthFrames = frameOf(lengthBeats)
  let timeSignature: TimeSignature
  try { timeSignature = validateTimeSignature(project.timeSignature) }
  catch { throw new NativeTimelineError('INVALID_PROJECT', 'Invalid time signature.') }
  if (project.beatsPerBar !== quarterNotesPerBar(timeSignature)) throw new NativeTimelineError('INVALID_PROJECT', 'Time signature and beats per bar disagree.')
  const meters = meterMapOf(project)
  number(project.loop.startBeat, 0, lengthBeats, 'cycle start')
  number(project.loop.endBeat, 0, lengthBeats, 'cycle end')
  const loop = loopRange(project)
  const roundedCycle = loop ? { startFrame: frameOf(loop.start), endFrame: frameOf(loop.end) } : null
  const cycle = roundedCycle && roundedCycle.endFrame > roundedCycle.startFrame ? roundedCycle : null
  checkIdentities(project)
  // Every cached expansion depends on the frame grid: rate, tempo map and project length.
  const timing = `${sampleRate}|${lengthBeats}|${tempo.isConstant ? bpm : JSON.stringify(tempo.points)}`
  const budget: ExpansionBudget = { sourceNotes: 0, expandedNotes: 0, audioWindows: 0 }
  const audible = audibleTrackIds(project.tracks)
  const metadata = (assetId: string): NativePcmAsset => {
    const asset = pcmAssets.get(assetId)
    if (!asset) throw new NativeTimelineError('MISSING_PCM_ASSET', `Missing PCM metadata for ${assetId}.`)
    if (asset.id !== assetId || !Number.isInteger(asset.sampleRate) || asset.sampleRate < 8000 || asset.sampleRate > 192000
      || !Number.isSafeInteger(asset.frames) || asset.frames < 1 || !Number.isInteger(asset.channels) || asset.channels < 1 || asset.channels > 32) {
      throw new NativeTimelineError('INVALID_PCM_ASSET', `Invalid PCM metadata for ${assetId}.`)
    }
    return { id: assetId, sampleRate: asset.sampleRate, frames: asset.frames, channels: asset.channels }
  }
  const routed = new Map(reconcileTrackRoutes(project.tracks).map(track => [track.id, routeOf(track)]))
  const sent = new Map(reconcileSends(project.tracks).map(track => [track.id, sendsOf(track)]))
  // Preflight every track before any expansion allocates: a reused track contributes its known totals,
  // another one its occurrences (checked against the running limits in track order).
  const plans = project.tracks.map(track => {
    // The PCM metadata a track's windows were cut against is part of its key (a re-decoded asset changes length).
    const pcmKey = (assetId: string): string => {
      const asset = pcmAssets.get(assetId)
      return asset ? `${asset.id}:${asset.sampleRate}:${asset.frames}:${asset.channels}` : `${assetId}:missing`
    }
    const assetKey = track.kind === 'audio' ? [...track.clips.map(clip => clip.kind === 'audio' ? pcmKey(clip.assetId) : ''), track.render?.frozen ? pcmKey(track.render.frozen.assetId) : ''].join('|') : ''
    const key = [timing, assetKey, !!track.pluginInstrument, ...EVENT_FIELDS.map(field => track[field])]
    const reused = cache?.reusableEvents(track.id, key)
    if (reused) {
      budget.sourceNotes += reused.sourceNotes; budget.expandedNotes += reused.expandedNotes; budget.audioWindows += reused.audioWindows
      limit(budget.sourceNotes <= NATIVE_TIMELINE_LIMITS.sourceNotes, 'source notes')
      limit(budget.expandedNotes <= NATIVE_TIMELINE_LIMITS.expandedNotes, 'expanded note candidates')
      limit(budget.audioWindows <= NATIVE_TIMELINE_LIMITS.audioWindows, 'audio windows')
      return { key, reused, prepared: null }
    }
    const before = { ...budget }
    const prepared = prepareOccurrences(track, lengthBeats, budget)
    return { key, reused: undefined, prepared, counts: { sourceNotes: budget.sourceNotes - before.sourceNotes, expandedNotes: budget.expandedNotes - before.expandedNotes, audioWindows: budget.audioWindows - before.audioWindows } }
  })
  const usedAssets = new Map<string, NativePcmAsset>()
  const tracks = project.tracks.map((track, index): NativeTrackTimeline => {
    const plan = plans[index]
    let events = plan.reused
    if (!events) {
      events = trackEvents(track, { frameOf, lengthFrames, lengthBeats, tempo, sampleRate, metadata }, plan.prepared!, plan.counts!)
      cache?.storeEvents(track.id, plan.key, events)
    }
    for (const asset of events.assets) usedAssets.set(asset.id, asset)
    const lanesKey = [timing, track.automation, track.devices, track.instrument, track.kind, track.sends, !!track.pluginInstrument]
    const lanes = cache ? cache.cachedLanes(track.id, lanesKey, () => nativeAutomation(track, tempo, sampleRate)) : nativeAutomation(track, tempo, sampleRate)
    const sends = sent.get(track.id) ?? []
    return { id: track.id, ...(track.kind === 'return' ? { return: true } : {}),
      ...(sends.length ? { sends: sends.map(send => ({ returnId: send.returnId, gain: number(send.level, 0, 2, 'send level'), pre: !!send.pre })) } : {}),
      source: source(track), gain: number(track.volume, 0, 2, 'track gain'), pan: number(track.pan, -1, 1, 'track pan'),
      enabled: isTrackEnabled(track) && track.pluginInstrument?.enabled !== false, mute: track.mute, solo: track.solo, soloSafe: track.soloSafe, audible: audible.has(track.id) && track.pluginInstrument?.enabled !== false,
      input: trackInput(track),
      ...nativeRoute(routed.get(track.id)),
      // One ordered chain: builtin and VST3 inserts interleave exactly as the project lists them.
      inserts: track.devices.map((device): NativeBuiltinInsert | NativePluginInsert => {
        if (device.type === 'vst3') {
          const { type: _type, ...plugin } = device
          return { id: id(plugin.id), type: 'vst3', enabled: plugin.enabled, params: { ...plugin.parameters }, plugin: { ...plugin, parameters: { ...plugin.parameters }, ...(plugin.state ? { state: { ...plugin.state } } : {}) } }
        }
        if (!Object.hasOwn(EFFECT_DEFS, device.type)) throw new NativeTimelineError('UNSUPPORTED_SOURCE', 'Unknown builtin insert.')
        return { id: id(device.id), type: device.type, enabled: device.enabled, params: parameters(EFFECT_DEFS[device.type].params, device.params) }
      }), notes: events.notes, controls: events.controls, audio: events.audio,
      ...(lanes.automation ? { automation: lanes.automation } : {}),
      ...(track.render?.directOut === false ? { directOut: false as const } : {}),
      ...(track.render?.preFader ? { preFader: true as const } : {}),
      ...(lanes.muted ? { unmutedAudible: audibleTrackIds(project.tracks.map(item => item.id === track.id ? { ...item, mute: false } : item)).has(track.id) && track.pluginInstrument?.enabled !== false } : {}) }
  })
  return { version: 1, projectId: project.id, revision, sampleRate, bpm, ...(tempo.isConstant ? {} : { tempoMap: tempo.points.map(point => ({ ...point })) }), timeSignature, beatsPerBar: project.beatsPerBar,
    ...(meters.segments.length > 1 ? { meterMap: meters.segments.map(({ bar, beat, numerator, denominator }) => ({ bar, beat, numerator, denominator })) } : {}),
    lengthFrames, cycle, masterGain: number(project.masterVolume, 0, 2, 'master gain'), assets: [...usedAssets.values()], tracks }
}

interface EventContext {
  readonly frameOf: (beat: number) => number
  readonly lengthFrames: number
  readonly lengthBeats: number
  readonly tempo: TempoMap
  readonly sampleRate: number
  readonly metadata: (assetId: string) => NativePcmAsset
}

/** Expands one track's regions (occurrences from its preflight) into note pairs, controller events and audio windows. */
function trackEvents(track: Track, context: EventContext, prepared: ReadonlyMap<MidiClip, readonly Occurrence[]>, counts: ExpansionBudget): TrackEvents {
  const { frameOf, lengthFrames, lengthBeats, tempo, sampleRate } = context
  const notes: NativeNotePair[] = []
  const controls: (NativeControlEvent & { reset: boolean; order: number })[] = []
  const audio: NativeAudioWindow[] = []
  const assets = new Map<string, NativePcmAsset>()
  let nextId = 0
  const pedalEvents = track.kind === 'instrument' && !!track.pluginInstrument
  const builtin = track.kind === 'instrument' && !track.pluginInstrument && instrumentDef(track.instrument).kind !== 'native'
  const pushControl = (beat: number, controller: number, value: number, reset: boolean, description: string): void => {
    const frame = frameOf(number(beat, -10_000_000, 20_000_000, `${description} position`))
    if (frame >= lengthFrames) return
    controls.push({ frame: Math.max(0, frame), controller, value, reset, order: controls.length })
    limit(controls.length <= NATIVE_TIMELINE_LIMITS.controlsPerTrack, 'controller events per track')
  }
  for (const clip of track.clips) {
    if (clip.kind !== 'midi' || clip.mute) continue
    for (const occurrence of prepared.get(clip) ?? []) {
      if (pedalEvents) {
        const events = playbackSustain(track, clip, occurrence)
        events.forEach((event, index) => pushControl(event.beat, 64, number(event.value, 0, 127, 'sustain value'), index === events.length - 1 && index > 0 && event.value === 0, 'sustain'))
      }
      // Built-in instruments take the region's bend range with the first bend event of every occurrence.
      let bendRange: number | null = null
      if (track.kind === 'instrument') for (const event of playbackControllers(track, clip, occurrence)) {
        if (builtin && event.key === 'program') continue
        const spec = controllerSpec(event.key)
        if (builtin && event.key === 'pitchBend' && event.range !== bendRange) {
          bendRange = event.range ?? 2
          pushControl(event.beat, BEND_RANGE_NUMBER, number(bendRange, 0, 48, 'pitch-bend range'), !!event.reset, 'pitch-bend range')
        }
        pushControl(event.beat, controllerNumber(event.key), number(event.value, spec.min, spec.max, 'controller value'), !!event.reset, 'controller')
      }
      for (const note of playbackNotes(track, clip, occurrence, !pedalEvents)) {
        const onFrame = frameOf(number(note.start, -10_000_000, 20_000_000, 'note onset'))
        const offFrame = Math.min(lengthFrames, frameOf(number(note.end, -10_000_000, 20_000_000, 'note end')))
        const limitFrame = Math.min(lengthFrames, frameOf(number(note.limit, -10_000_000, 20_000_000, 'note occurrence end')))
        if (offFrame <= 0 || onFrame >= lengthFrames || offFrame <= onFrame) continue
        if (!Number.isInteger(note.pitch)) throw new NativeTimelineError('INVALID_PROJECT', 'Invalid note pitch.')
        notes.push({ id: nextId++, clipId: clip.id, occurrenceIndex: occurrence.index, onFrame, offFrame, limitFrame,
          pitch: number(note.pitch, 0, 127, 'note pitch'), velocity: number(note.velocity, 0, 2, 'note velocity') })
      }
    }
  }
  for (const window of audioWindows(track, lengthBeats, tempo)) {
    const originFrame = frameOf(number(window.start, -10_000_000, 20_000_000, 'audio onset'))
    const windowEnd = Math.min(lengthFrames, frameOf(number(window.end, -10_000_000, 20_000_000, 'audio end')))
    if (windowEnd <= 0 || originFrame >= lengthFrames) continue
    const clip = window.clip
    const asset = assets.get(clip.assetId) ?? context.metadata(clip.assetId)
    assets.set(asset.id, asset)
    const sourceBase = number(clip.offsetSeconds, 0, 10_000_000, 'audio source offset') * asset.sampleRate
    // Audio plays at 1×: the region lasts its real duration through the tempo map.
    const occurrence = window.start - window.sourceOffsetBeats
    const clipLengthFrames = Math.max(0, Math.min(Math.round(tempo.secondsBetween(occurrence, occurrence + clip.lengthBeats) * sampleRate),
      Math.floor((asset.frames - sourceBase) * sampleRate / asset.sampleRate)))
    const startFrame = Math.max(0, originFrame)
    const clipOffsetFrames = startFrame - originFrame + Math.round(tempo.secondsBetween(occurrence, window.start) * sampleRate)
    const endFrame = Math.min(windowEnd, startFrame + clipLengthFrames - clipOffsetFrames)
    if (endFrame <= startFrame) continue
    audio.push({ id: nextId++, clipId: clip.id, assetId: asset.id, startFrame, endFrame,
      sourceStartFrame: sourceBase + clipOffsetFrames * asset.sampleRate / sampleRate, sourceSampleRate: asset.sampleRate,
      clipOffsetFrames, clipLengthFrames, gain: number(clip.gain, 0, AUDIO_CLIP_GAIN_MAX, 'audio gain'),
      ...fadeFrames(clipLengthFrames, number(clip.fadeIn, 0, 10_000_000, 'fade in') * sampleRate, number(clip.fadeOut, 0, 10_000_000, 'fade out') * sampleRate),
      fadeInCurve: FADE_CURVE_CODES[fadeCurveOf(clip.fadeInCurve)], fadeOutCurve: FADE_CURVE_CODES[fadeCurveOf(clip.fadeOutCurve)] })
  }
  const frozen = track.render?.frozen
  if (frozen) {
    // The cached render covers the project from frame 0 plus the track's own tail, at the project rate.
    const asset = assets.get(frozen.assetId) ?? context.metadata(frozen.assetId)
    assets.set(asset.id, asset)
    const frames = Math.floor(asset.frames * sampleRate / asset.sampleRate)
    const endFrame = Math.min(frames, lengthFrames + sampleRate * 31)
    if (endFrame > 0) audio.push({ id: nextId++, clipId: `freeze:${track.id}`, assetId: asset.id, startFrame: 0, endFrame, sourceStartFrame: 0, sourceSampleRate: asset.sampleRate,
      clipOffsetFrames: 0, clipLengthFrames: endFrame, gain: 1, fadeInFrames: 0, fadeOutFrames: 0, fadeInCurve: 0, fadeOutCurve: 0, freeze: true, tailSeconds: number(frozen.tailSeconds, 0, 3600, 'freeze tail') })
  }
  notes.sort((a, b) => a.onFrame - b.onFrame || a.offFrame - b.offFrame || a.id - b.id)
  // At equal frames a release/reset at a region end precedes the next region's chase; otherwise emission order.
  controls.sort((a, b) => a.frame - b.frame || (a.reset === b.reset ? a.order - b.order : a.reset ? -1 : 1))
  audio.sort((a, b) => a.startFrame - b.startFrame || a.id - b.id)
  return { notes, controls: controls.map(({ frame, controller, value }) => ({ frame, controller, value })), audio, assets: [...assets.values()], ...counts }
}

/** Native automation step inside tempo ramps (beats): frame-linear segments this short match beat-linear lanes. */
export const AUTOMATION_RAMP_STEP_BEATS = 1 / 16
const MAX_NATIVE_LANE_POINTS = 20_000

/**
 * Lane points in fractional project frames through the tempo map. Lanes are defined in beats (core/automation.ts
 * evaluates beat-linearly, like the Web Audio engine); the native host interpolates between frames. So a segment
 * whose tempo changes inside it is split at every tempo point and, inside ramps, every AUTOMATION_RAMP_STEP_BEATS.
 * A curved segment's pieces keep the exact shape: the exponential restricted to [f0, f1] is the same shape with
 * curve × (f1 − f0) (automationShape), so only the frame-vs-beat bend inside one ramp step is approximated.
 */
export function automationFrames(points: readonly { beat: number; value: number; curve?: number }[], discrete: boolean, tempo: TempoMap, sampleRate: number,
  rampStep = AUTOMATION_RAMP_STEP_BEATS): { frame: number; value: number; curve?: number }[] {
  const frame = (beat: number) => tempo.frameAt(beat, sampleRate)
  const plain = () => points.map(point => ({ frame: frame(point.beat), value: point.value, ...(point.curve ? { curve: point.curve } : {}) }))
  if (discrete || tempo.isConstant) return plain()
  const tempoPoints = tempo.points
  const cuts = (from: number, to: number): number[] => {
    const result: number[] = []
    for (let index = 0; index < tempoPoints.length; index += 1) {
      const point = tempoPoints[index], next = tempoPoints[index + 1]
      if (point.beat > from + 1e-9 && point.beat < to - 1e-9) result.push(point.beat)
      if (!next || point.curve !== 'ramp' || next.beat <= from || point.beat >= to) continue
      const lo = Math.max(from, point.beat), hi = Math.min(to, next.beat)
      for (let beat = Math.floor(lo / rampStep + 1) * rampStep; beat < hi - 1e-9; beat += rampStep) if (beat > from + 1e-9) result.push(beat)
    }
    return [...new Set(result)].sort((a, b) => a - b)
  }
  const out: { frame: number; value: number; curve?: number }[] = []
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index], b = points[index + 1]
    const span = b ? b.beat - a.beat : 0
    const inner = b && span > 1e-9 ? cuts(a.beat, b.beat) : []
    if (!inner.length) { out.push({ frame: frame(a.beat), value: a.value, ...(a.curve ? { curve: a.curve } : {}) }); continue }
    const xs = [a.beat, ...inner, b.beat]
    const curve = a.curve ?? 0
    for (let piece = 0; piece < xs.length - 1; piece += 1) {
      const f0 = (xs[piece] - a.beat) / span, f1 = (xs[piece + 1] - a.beat) / span
      const value = piece === 0 ? a.value : a.value + (b.value - a.value) * automationShape(f0, curve)
      const sub = curve * (f1 - f0)
      out.push({ frame: frame(xs[piece]), value, ...(Math.abs(sub) > 1e-6 ? { curve: sub } : {}) })
    }
    if (out.length > MAX_NATIVE_LANE_POINTS) return automationFrames(points, discrete, tempo, sampleRate, rampStep * 2)
  }
  return out
}

/** Active lanes of a track in project frames. Beats map through the project tempo map, like every other event here. */
function nativeAutomation(track: Track, tempo: TempoMap, sampleRate: number): { automation?: NativeAutomationLane[]; muted: boolean } {
  const lanes: NativeAutomationLane[] = []
  for (const lane of track.automation ?? []) {
    if (!isActiveLane(track, lane)) continue
    const def = targetDef(track, lane.target)!
    const target = lane.target
    const native: NativeAutomationLane['target'] = target.kind === 'track' ? { kind: target.param }
      : target.kind === 'device' ? { kind: 'insert', insertId: target.deviceId, param: target.param }
        : target.kind === 'send' ? { kind: 'send', returnId: target.returnId }
          : { kind: 'instrument', param: target.param }
    const points = lane.points.map(point => ({ beat: number(point.beat, 0, 10_000_000, 'automation position'), value: number(point.value, 0, 1, 'automation value'), ...(point.curve ? { curve: number(point.curve, -1, 1, 'automation curve') } : {}) }))
    lanes.push({
      target: native, minimum: def.min, maximum: def.max,
      ...(def.scale === 'log' && !def.options ? { logarithmic: true } : {}),
      ...(isDiscrete(def) ? { options: def.options!.map(option => option.value) } : {}),
      points: automationFrames(points, isDiscrete(def), tempo, sampleRate),
    })
  }
  if (!lanes.length) return { muted: false }
  return { automation: lanes, muted: lanes.some(lane => lane.target.kind === 'mute') }
}

export interface NativeTrackSeek {
  readonly trackId: string
  /** The first onset >= the requested position. Schedule these once; do not also chase equal onsets. */
  readonly nextNoteIndex: number
  readonly nextAudioIndex: number
  readonly chasedNotes: readonly NativeNotePair[]
  readonly chasedAudio: readonly NativeAudioWindow[]
}
export interface NativeSeekPlan {
  readonly frame: number
  readonly boundaryFrame: number
  readonly tracks: readonly NativeTrackSeek[]
}

function firstAtOrAfter<T>(items: readonly T[], frame: number, onset: (item: T) => number): number {
  let lo = 0, hi = items.length
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (onset(items[mid]) < frame) lo = mid + 1; else hi = mid }
  return lo
}

/**
 * A discontinuous start/seek: the host must stop prior voices before applying this plan.
 * Pitched sustained notes restart their envelope; past drum hits/tails are not retriggered.
 * 'seek' honors the audition cycle; 'play' also restarts at non-looping project end;
 * 'export' ignores the cycle. Future scheduling stops at boundaryFrame and uses half-open ranges.
 * This is a timeline contract only; DSP tails and a native device scheduler are not implemented here.
 */
export function planNativeSeek(timeline: NativeProjectTimeline, requestedFrame: number, mode: 'seek' | 'play' | 'export' = 'seek'): NativeSeekPlan {
  if (!Number.isFinite(requestedFrame)) throw new NativeTimelineError('INVALID_POSITION', 'Seek frame must be finite.')
  let frame = Math.max(0, Math.min(timeline.lengthFrames, Math.round(requestedFrame)))
  const cycle = mode === 'export' ? null : timeline.cycle
  if (cycle && frame >= cycle.endFrame) frame = cycle.startFrame
  if (mode === 'play' && !cycle && frame === timeline.lengthFrames) frame = 0
  const boundaryFrame = cycle?.endFrame ?? timeline.lengthFrames
  return { frame, boundaryFrame, tracks: timeline.tracks.map(track => {
    const nextNoteIndex = firstAtOrAfter(track.notes, frame, note => note.onFrame)
    const nextAudioIndex = firstAtOrAfter(track.audio, frame, window => window.startFrame)
    const chasedNotes: NativeNotePair[] = []
    const chasedAudio: NativeAudioWindow[] = []
    if (track.enabled && frame < boundaryFrame) {
      if (track.source.kind !== 'audio' && !track.source.isKit) {
        for (let index = 0; index < nextNoteIndex; index++) {
          const note = track.notes[index]
          if (note.offFrame > frame) chasedNotes.push({ ...note, onFrame: frame,
            offFrame: Math.min(note.offFrame, boundaryFrame), limitFrame: Math.min(note.limitFrame, boundaryFrame) })
        }
      }
      for (let index = 0; index < nextAudioIndex; index++) {
        const window = track.audio[index]
        if (window.endFrame > frame) chasedAudio.push({ ...window, startFrame: frame, endFrame: Math.min(window.endFrame, boundaryFrame),
          sourceStartFrame: window.sourceStartFrame + (frame - window.startFrame) * window.sourceSampleRate / timeline.sampleRate,
          clipOffsetFrames: window.clipOffsetFrames + frame - window.startFrame })
      }
    }
    return { trackId: track.id, nextNoteIndex, nextAudioIndex, chasedNotes, chasedAudio }
  }) }
}

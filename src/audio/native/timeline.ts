import { isSampleRate, type SampleRate } from '../../core/audioSettings'
import { EFFECT_DEFS, type ParamDef } from '../../core/devices'
import { instrumentDef, isInstrumentId } from '../../core/instruments'
import { quarterNotesPerBar, validateTimeSignature } from '../../core/meter'
import { audibleTrackIds, audioWindows, clipOccurrences, isTrackEnabled, loopEnd, playbackNotes, type Occurrence } from '../../core/playback'
import type { EffectType, MidiClip, Project, TimeSignature, Track } from '../../core/types'
import { loopRange } from '../math'
import { combineWavetablePatch, type WavetablePatch } from '../../devices/wavetable-synth/model'
import type { NativePluginInstance } from './contracts'

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
} as const

export type NativeTimelineErrorCode = 'INVALID_PROJECT' | 'INVALID_PCM_ASSET' | 'MISSING_PCM_ASSET' | 'LIMIT_EXCEEDED' | 'UNSUPPORTED_SOURCE' | 'INVALID_POSITION'
export class NativeTimelineError extends Error {
  constructor(readonly code: NativeTimelineErrorCode, message: string) { super(message); this.name = 'NativeTimelineError' }
}

/** Metadata for an already decoded PCM asset. Its rate can differ from the project rate. */
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
}

export interface NativeTrackInput {
  readonly channels: readonly [number] | readonly [number, number]
}

export interface NativeTrackTimeline {
  readonly id: string
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
  readonly inserts: readonly (NativeBuiltinInsert | NativePluginInsert)[]
  /** Sorted by onset, then off frame and ID. Notes are cropped to the project, not the audition cycle. */
  readonly notes: readonly NativeNotePair[]
  readonly audio: readonly NativeAudioWindow[]
}

export interface NativeProjectTimeline {
  readonly version: 1
  readonly projectId: string
  readonly revision: number
  readonly sampleRate: SampleRate
  /** Quarter-note tempo even in compound meters. */
  readonly bpm: number
  readonly timeSignature: Readonly<TimeSignature>
  readonly beatsPerBar: number
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
  if (track.kind === 'audio') return { kind: 'audio' }
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

/** Preflight before playbackNotes/audioWindows allocate expanded arrangements (audio overlap resolution is quadratic). */
function prepareOccurrences(project: Project): Map<MidiClip, readonly Occurrence[]> {
  limit(project.tracks.length <= NATIVE_TIMELINE_LIMITS.tracks, 'tracks')
  let clips = 0, sourceNotes = 0, expandedNotes = 0, totalAudio = 0
  const seen = new Set<string>([id(project.id)])
  const unique = (value: string) => {
    if (seen.has(id(value))) throw new NativeTimelineError('INVALID_PROJECT', 'Duplicate track or clip ID.')
    seen.add(value)
  }
  const prepared = new Map<MidiClip, readonly Occurrence[]>()
  for (const track of project.tracks) {
    unique(track.id)
    limit(track.devices.length <= NATIVE_TIMELINE_LIMITS.insertsPerTrack, 'inserts per track')
    let trackAudio = 0
    clips += track.clips.length
    limit(clips <= NATIVE_TIMELINE_LIMITS.clips, 'clips')
    for (const clip of track.clips) {
      unique(clip.id)
      number(clip.startBeat, 0, 10_000_000, 'clip start')
      number(clip.lengthBeats, 0.000001, 10_000_000, 'clip length')
      if ((clip.kind === 'midi') !== (track.kind === 'instrument')) {
        throw new NativeTimelineError('UNSUPPORTED_SOURCE', 'Clip and track source kinds must agree.')
      }
      if (clip.kind === 'midi') {
        sourceNotes += clip.notes.length
        limit(sourceNotes <= NATIVE_TIMELINE_LIMITS.sourceNotes, 'source notes')
        if (!clip.notes.length) continue
      }
      if (clip.mute) continue
      const occurrences = clipOccurrences(track, clip, project.lengthBeats)
      // core/playback intentionally caps its helper at 4096; never silently compile a truncated loop.
      const end = loopEnd(track, clip, project.lengthBeats)
      limit(occurrences.length <= NATIVE_TIMELINE_LIMITS.occurrencesPerClip
        && !!occurrences.length && occurrences[occurrences.length - 1].end >= end - 1e-9, 'region repeat occurrences')
      if (clip.kind === 'midi') {
        expandedNotes += occurrences.length * clip.notes.length
        limit(expandedNotes <= NATIVE_TIMELINE_LIMITS.expandedNotes, 'expanded note candidates')
        prepared.set(clip, occurrences)
      } else {
        trackAudio += occurrences.length
        totalAudio += occurrences.length
        limit(trackAudio <= NATIVE_TIMELINE_LIMITS.audioWindowsPerTrack, 'audio windows per track')
        limit(totalAudio <= NATIVE_TIMELINE_LIMITS.audioWindows, 'audio windows')
      }
    }
  }
  return prepared
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

/**
 * Pure preparation for the native host; it allocates no realtime audio objects.
 * Input must be a normalized Project (external JSON still goes through validateProject first).
 * Musical endpoints use nearest-sample rounding, never accumulated interval rounding. Subsample
 * events that collapse to zero frames are omitted. Expansion limits reject instead of truncating.
 */
export function compileNativeTimeline(project: Project, pcmAssets: ReadonlyMap<string, NativePcmAsset> = new Map(), revision = 0): NativeProjectTimeline {
  if (!isSampleRate(project.sampleRate)) throw new NativeTimelineError('INVALID_PROJECT', 'Invalid project sample rate.')
  if (!Number.isSafeInteger(revision) || revision < 0) throw new NativeTimelineError('INVALID_PROJECT', 'Invalid project revision.')
  const sampleRate = project.sampleRate
  const bpm = number(project.bpm, 20, 400, 'quarter-note tempo')
  const framesPerBeat = sampleRate * 60 / bpm
  const lengthBeats = number(project.lengthBeats, 0.001, 10_000_000, 'project length')
  limit(lengthBeats * 60 / bpm <= NATIVE_TIMELINE_LIMITS.durationSeconds, 'project duration')
  const lengthFrames = Math.round(lengthBeats * framesPerBeat)
  let timeSignature: TimeSignature
  try { timeSignature = validateTimeSignature(project.timeSignature) }
  catch { throw new NativeTimelineError('INVALID_PROJECT', 'Invalid time signature.') }
  if (project.beatsPerBar !== quarterNotesPerBar(timeSignature)) throw new NativeTimelineError('INVALID_PROJECT', 'Time signature and beats per bar disagree.')
  number(project.loop.startBeat, 0, lengthBeats, 'cycle start')
  number(project.loop.endBeat, 0, lengthBeats, 'cycle end')
  const loop = loopRange(project)
  const roundedCycle = loop ? { startFrame: Math.round(loop.start * framesPerBeat), endFrame: Math.round(loop.end * framesPerBeat) } : null
  const cycle = roundedCycle && roundedCycle.endFrame > roundedCycle.startFrame ? roundedCycle : null
  const prepared = prepareOccurrences(project)
  const audible = audibleTrackIds(project.tracks)
  const usedAssets = new Map<string, NativePcmAsset>()
  const assetFor = (assetId: string): NativePcmAsset => {
    const existing = usedAssets.get(assetId)
    if (existing) return existing
    const asset = pcmAssets.get(assetId)
    if (!asset) throw new NativeTimelineError('MISSING_PCM_ASSET', `Missing PCM metadata for ${assetId}.`)
    if (asset.id !== assetId || !Number.isInteger(asset.sampleRate) || asset.sampleRate < 8000 || asset.sampleRate > 192000
      || !Number.isSafeInteger(asset.frames) || asset.frames < 1 || !Number.isInteger(asset.channels) || asset.channels < 1 || asset.channels > 32) {
      throw new NativeTimelineError('INVALID_PCM_ASSET', `Invalid PCM metadata for ${assetId}.`)
    }
    const copy = { id: assetId, sampleRate: asset.sampleRate, frames: asset.frames, channels: asset.channels }
    usedAssets.set(assetId, copy)
    return copy
  }
  let nextId = 0
  const tracks = project.tracks.map((track): NativeTrackTimeline => {
    const notes: NativeNotePair[] = []
    const audio: NativeAudioWindow[] = []
    for (const clip of track.clips) {
      if (clip.kind !== 'midi' || clip.mute) continue
      for (const occurrence of prepared.get(clip) ?? []) {
        for (const note of playbackNotes(track, clip, occurrence)) {
          const onFrame = Math.round(number(note.start, -10_000_000, 20_000_000, 'note onset') * framesPerBeat)
          const offFrame = Math.min(lengthFrames, Math.round(number(note.end, -10_000_000, 20_000_000, 'note end') * framesPerBeat))
          const limitFrame = Math.min(lengthFrames, Math.round(number(note.limit, -10_000_000, 20_000_000, 'note occurrence end') * framesPerBeat))
          if (offFrame <= 0 || onFrame >= lengthFrames || offFrame <= onFrame) continue
          if (!Number.isInteger(note.pitch)) throw new NativeTimelineError('INVALID_PROJECT', 'Invalid note pitch.')
          notes.push({ id: nextId++, clipId: clip.id, occurrenceIndex: occurrence.index, onFrame, offFrame, limitFrame,
            pitch: number(note.pitch, 0, 127, 'note pitch'), velocity: number(note.velocity, 0, 2, 'note velocity') })
        }
      }
    }
    for (const window of audioWindows(track, lengthBeats)) {
      const originFrame = Math.round(number(window.start, -10_000_000, 20_000_000, 'audio onset') * framesPerBeat)
      const windowEnd = Math.min(lengthFrames, Math.round(number(window.end, -10_000_000, 20_000_000, 'audio end') * framesPerBeat))
      if (windowEnd <= 0 || originFrame >= lengthFrames) continue
      const clip = window.clip
      const asset = assetFor(clip.assetId)
      const sourceBase = number(clip.offsetSeconds, 0, 10_000_000, 'audio source offset') * asset.sampleRate
      const clipLengthFrames = Math.max(0, Math.min(Math.round(clip.lengthBeats * framesPerBeat),
        Math.floor((asset.frames - sourceBase) * sampleRate / asset.sampleRate)))
      const startFrame = Math.max(0, originFrame)
      const clipOffsetFrames = startFrame - originFrame + Math.round(window.sourceOffsetBeats * framesPerBeat)
      const endFrame = Math.min(windowEnd, startFrame + clipLengthFrames - clipOffsetFrames)
      if (endFrame <= startFrame) continue
      audio.push({ id: nextId++, clipId: clip.id, assetId: asset.id, startFrame, endFrame,
        sourceStartFrame: sourceBase + clipOffsetFrames * asset.sampleRate / sampleRate, sourceSampleRate: asset.sampleRate,
        clipOffsetFrames, clipLengthFrames, gain: number(clip.gain, 0, 2, 'audio gain'),
        fadeInFrames: Math.min(Math.round(number(clip.fadeIn, 0, 10_000_000, 'fade in') * sampleRate), Math.floor(clipLengthFrames / 2)),
        fadeOutFrames: Math.min(Math.round(number(clip.fadeOut, 0, 10_000_000, 'fade out') * sampleRate), Math.floor(clipLengthFrames / 2)) })
    }
    notes.sort((a, b) => a.onFrame - b.onFrame || a.offFrame - b.offFrame || a.id - b.id)
    audio.sort((a, b) => a.startFrame - b.startFrame || a.id - b.id)
    return { id: track.id, source: source(track), gain: number(track.volume, 0, 2, 'track gain'), pan: number(track.pan, -1, 1, 'track pan'),
      enabled: isTrackEnabled(track) && track.pluginInstrument?.enabled !== false, mute: track.mute, solo: track.solo, soloSafe: track.soloSafe, audible: audible.has(track.id) && track.pluginInstrument?.enabled !== false,
      input: trackInput(track),
      // One ordered chain: builtin and VST3 inserts interleave exactly as the project lists them.
      inserts: track.devices.map((device): NativeBuiltinInsert | NativePluginInsert => {
        if (device.type === 'vst3') {
          const { type: _type, ...plugin } = device
          return { id: id(plugin.id), type: 'vst3', enabled: plugin.enabled, params: { ...plugin.parameters }, plugin: { ...plugin, parameters: { ...plugin.parameters }, ...(plugin.state ? { state: { ...plugin.state } } : {}) } }
        }
        if (!Object.hasOwn(EFFECT_DEFS, device.type)) throw new NativeTimelineError('UNSUPPORTED_SOURCE', 'Unknown builtin insert.')
        return { id: id(device.id), type: device.type, enabled: device.enabled, params: parameters(EFFECT_DEFS[device.type].params, device.params) }
      }), notes, audio }
  })
  return { version: 1, projectId: project.id, revision, sampleRate, bpm, timeSignature, beatsPerBar: project.beatsPerBar,
    lengthFrames, cycle, masterGain: number(project.masterVolume, 0, 2, 'master gain'), assets: [...usedAssets.values()], tracks }
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

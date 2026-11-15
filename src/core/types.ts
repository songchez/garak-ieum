import type { SampleRate } from './audioSettings'
import type { PitchEditDocument } from '../devices/pitch-editor/model'
import type { WavetableState } from '../devices/wavetable-synth/model'
import type { WavetableNativeBridge } from '../devices/wavetable-synth/bridge'
import type { NativePluginInstance } from '../audio/native/contracts'
import type { MetronomeEngineState, PlayOptions } from './metronome'

/** A key of INSTRUMENTS in core/instruments.ts. Saved files store it as plain text. */
export type InstrumentId = string
export type SampleStatus = 'idle' | 'loading' | 'ready' | 'error'
export interface SampleAttribution {
  title: string
  author: string
  license: string
  url?: string
  licenseUrl?: string
  changes?: string
}
export interface MidiNote {
  id: string
  pitch: number
  /** Stored source beat; subtract MidiClip.sourceOffsetBeats for the visible region position. */
  start: number
  duration: number
  velocity: number
}
/** One MIDI CC64 (sustain pedal) event. Stored in source beats like MidiNote.start; see core/sustain.ts. */
export interface SustainEvent {
  beat: number
  /** 0…127; 64 or more is pedal down. */
  value: number
}
export interface ClipBase {
  id: string
  name: string
  startBeat: number
  lengthBeats: number
  gain: number
  /** Muted clips stay on the timeline but are not scheduled. Absent means false. */
  mute?: boolean
  /** Repeats the clip every lengthBeats until the next clip on the track or the project end. Absent = false. */
  loop?: boolean
  /** Total span from startBeat to a manual repeat endpoint; at least lengthBeats. Absent = continuous loop.
   * Relative to the clip so moving/copying it carries its endpoint. Ignored while loop is false. */
  loopLengthBeats?: number
  /** Playback offset in ticks at 960 PPQ (−1920…1920). Absent = 0. */
  delayTicks?: number
}
export interface MidiClip extends ClipBase {
  kind: 'midi'
  /** Source beat at the visible left edge. Notes keep their original source positions when trimmed.
   * Absent = 0, preserving projects written before non-destructive MIDI trimming. */
  sourceOffsetBeats?: number
  notes: MidiNote[]
  /** Sustain pedal (CC64) controller lane, sorted by beat (schema 13). Absent = no pedal. Never transposed or quantized. */
  sustain?: SustainEvent[]
  /** Non-destructive playback quantize grid in beats; one of QUANTIZE_VALUES. Absent/0 = off. */
  quantize?: number
  /** Swing 0…100 (50 = straight); only used when quantize is on. Absent = 50. */
  swing?: number
  /** Semitones −96…96. Absent = 0. */
  transpose?: number
  /** Velocity offset −99…99 (MIDI units). Absent = 0. */
  velocity?: number
}
export interface AudioClip extends ClipBase {
  kind: 'audio'
  assetId: string
  offsetSeconds: number
  /** Seconds of the audible region. fadeIn + fadeOut beyond the region shrink in proportion. */
  fadeIn: number
  fadeOut: number
  /** Fade shapes (schema 10). Absent = linear. */
  fadeInCurve?: FadeCurve
  fadeOutCurve?: FadeCurve
  /** Original/analysis/edit state. assetId is the committed, duration-preserving render. */
  pitch?: PitchEditDocument
  /** Detected tempo and warp state (schema 9). Never combined with pitch. */
  warp?: AudioWarp
  /** Region pitch (schema 12; docs/REGION_PITCH.md). Absent = 0 / keep tempo. Never combined with pitch. */
  regionPitch?: AudioTranspose
}
/** 템포 유지 (pitch shift, same length) or 자연스럽게 (varispeed: pitch and speed together). */
export type TransposeMode = 'keep' | 'varispeed'
/** What an installed pitch render carries: total cents, mode and formant preservation. */
export interface AudioTransposeRender { cents: number; mode: TransposeMode; formant: boolean }
/**
 * Region transposition. assetId is render(originalAssetId, warp ratio, rendered) once the
 * renderer installed it; offsetSeconds is in that asset's seconds (like warp).
 */
export interface AudioTranspose {
  /** −24…24 */
  semitones: number
  /** −50…50 */
  cents: number
  mode: TransposeMode
  /** Keep-tempo only: preserve formants. Absent = false. */
  formant?: boolean
  /** The file renders start from; equals warp.originalAssetId when the clip also has warp. */
  originalAssetId: string
  /** The transposition the current assetId carries. Absent = none. */
  rendered?: AudioTransposeRender
}
/**
 * Offline warp: while enabled, assetId is a render of originalAssetId stretched by
 * sourceBpm / renderBpm, so the clip keeps its length in beats. offsetSeconds is in
 * the render's seconds. While off (or when renderBpm === sourceBpm), assetId is the original.
 */
export interface AudioWarp {
  enabled: boolean
  /** Tempo of the original file (detected, from the file name, or typed). */
  sourceBpm: number
  /** First detected beat in original-file seconds (informational alignment hint). */
  firstBeatSeconds: number
  /** 0–1. 0 means typed by hand. */
  confidence: number
  originalAssetId: string
  /** Project tempo the current assetId was rendered for. */
  renderBpm: number
}
export type Clip = MidiClip | AudioClip
/** Region fade shapes; see core/clipEnvelope.ts. */
export type FadeCurve = 'linear' | 'equalPower' | 'sCurve' | 'exponential' | 'logarithmic'
export type EffectType = 'eq' | 'filter' | 'compressor' | 'drive' | 'delay' | 'reverb' | 'guitar-rig'
  | 'chorus' | 'phaser' | 'flanger' | 'tremolo' | 'limiter' | 'gate' | 'tape' | 'bitcrusher' | 'utility'
/** One builtin insert effect. */
export interface EffectDevice {
  id: string
  type: EffectType
  enabled: boolean
  params: Record<string, number>
  /** Display name chosen from a library variant or by the user; absent shows the module name. */
  name?: string
}
/** A native VST3 effect in the same chain as builtin effects (desktop engine only). */
export interface PluginDevice extends NativePluginInstance {
  type: 'vst3'
}
/** One insert. Track.devices is processed left to right, builtin and VST3 interleaved. Disabled devices are bypassed. */
export type Device = EffectDevice | PluginDevice
export const isPluginDevice = (device: Device): device is PluginDevice => device.type === 'vst3'
export const isEffectDevice = (device: Device): device is EffectDevice => device.type !== 'vst3'
/** Physical device input channels (zero based) a track records and monitors. See docs/AUDIO_CORE_PLAN.md. */
export interface TrackInput {
  channels: [number] | [number, number]
  /** Channel name when chosen, used to re-find the input on another computer or interface. */
  label?: string
}
/** Where a track-input route listens on its source track (Ableton Pre FX / Post FX / Post Mixer). */
export type TrackInputTap = 'preFx' | 'postFx' | 'postFader'
/**
 * Internal recording input (schema 11): another track's signal or the master mix (resampling) instead of a
 * physical input. `none` is a route whose source track was deleted: it records and monitors silence until
 * the user picks another input. See docs/TRACK_INPUT_ROUTING.md.
 */
export type TrackInputRoute =
  | { kind: 'track'; trackId: string; tap: TrackInputTap }
  | { kind: 'master' }
  | { kind: 'none' }
/** Ableton-style monitoring: `auto` hears the input while armed unless clips are playing back without recording. */
export type TrackMonitorMode = 'off' | 'auto' | 'in'
/** One selectable track input built from the enabled device channels. */
export interface InputChoice {
  channels: [number] | [number, number]
  label: string
}

export interface Track {
  id: string
  name: string
  kind: 'instrument' | 'audio'
  instrument: InstrumentId
  color: string
  volume: number
  pan: number
  mute: boolean
  solo: boolean
  /** Heard even when other tracks are soloed (Logic: ⌃-click S). */
  soloSafe: boolean
  /** Off = not scheduled, no fader, no preview (Logic: track on/off, ⌥M). */
  enabled: boolean
  /** Record-enabled. Live state: never enters undo history. */
  armed: boolean
  /** The I button: true exactly when monitorMode is `in`. Kept for schema ≤7 files and older readers.
   * Live state: never enters undo history. */
  monitor: boolean
  /** Hidden in the Tracks area while hide view is off; still plays. */
  hidden: boolean
  /** Track parameters applied at playback time (Logic Track inspector). Audio tracks store but ignore them. */
  transpose: number
  velocityOffset: number
  keyLimit: [number, number]
  velocityLimit: [number, number]
  /** Ticks at 960 PPQ, −1920…1920. */
  delayTicks: number
  /** Icon name from components/Icon.tsx. Absent = category default. */
  icon?: string
  clips: Clip[]
  /** Keys and ranges are defined by instrumentDef(instrument).params in core/instruments.ts. */
  instrumentParams: Record<string, number>
  /** Versioned waveforms and modulation; scalar values live only in instrumentParams. */
  instrumentState?: WavetableState
  devices: Device[]
  /** Native VST3 source; the builtin instrument selection remains available when removed. */
  pluginInstrument?: NativePluginInstance
  /** Audio tracks only. Absent: the engine's default input (first enabled channel or pair). A saved,
   * undoable setting (schema 8). */
  input?: TrackInput
  /** Absent: derived from `monitor` (`in` when on, else `auto`). Saved with the project like Ableton's
   * monitor switch, but live like arm/monitor: it never enters undo history (schema 8). */
  monitorMode?: TrackMonitorMode
  /** Audio tracks only. When present it replaces `input` (which is kept for switching back): the track
   * records and monitors another track or the master instead of a physical input. Undoable (schema 11). */
  inputRoute?: TrackInputRoute
}
export interface Marker {
  id: string
  name: string
  startBeat: number
}
export type TimeSignatureDenominator = 2 | 4 | 8 | 16
export interface TimeSignature {
  numerator: number
  denominator: TimeSignatureDenominator
}
export interface Project {
  /** 13: MIDI sustain pedal lane (MidiClip.sustain). 12: audio region pitch (AudioClip.transpose). 11: track-input routes (Track.inputRoute). 10: audio region fade curves and region gain up to +24 dB. 9: audio clip warp/tempo. 8: per-track input and monitor mode. 7: VST3 effects live in devices (schema 6 kept them in a separate pluginInserts list). */
  schemaVersion: 13
  id: string
  name: string
  bpm: number
  /** Project rendering rate; device preferences are stored separately in this browser. */
  sampleRate: SampleRate
  timeSignature: TimeSignature
  /** Derived quarter-note beats per bar, not the numerator: 6/8 has 3. */
  beatsPerBar: number
  lengthBeats: number
  masterVolume: number
  loop: { enabled: boolean; startBeat: number; endBeat: number }
  tracks: Track[]
  /** Sorted by startBeat. */
  markers: Marker[]
}
/** Playback quantize grids in beats (0 = off). Triplets are 2/3, 1/3, 1/6, 1/12. */
export const QUANTIZE_VALUES: readonly number[] = [0, 4, 2, 1, 0.5, 0.25, 0.125, 0.0625, 2 / 3, 1 / 3, 1 / 6, 1 / 12]
export interface AudioAsset {
  id: string
  name: string
  blob: Blob
  buffer: AudioBuffer
  peaks: number[]
}
export interface TransportSnapshot {
  playing: boolean
  beat: number
  ready: boolean
  sampleRate: number
}
export interface AudioEngine {
  readonly kind: 'web-audio' | 'native'
  /** Supplied only by a native host that actually loads the IEUM WAVE DSP module. */
  readonly wavetable?: WavetableNativeBridge
  setProject(project: Project): void
  setAssets(assets: Map<string, AudioAsset>): void
  resume(): Promise<void>
  /** countInBars clicks whole bars first; Web Audio resolves on the downbeat, native once the count-in is queued. */
  play(options?: PlayOptions): Promise<void>
  /** Monitor-only click track (never recorded or exported). */
  setMetronome?(state: MetronomeEngineState): void
  pause(): void
  stop(): void
  seek(beat: number): void
  /** With trackId, the note uses that track's instrumentParams and plays through its device chain. */
  previewNote(instrument: InstrumentId, pitch: number, velocity?: number, trackId?: string): Promise<void>
  decodeAsset(blob: Blob, name: string, id?: string): Promise<AudioAsset>
  exportWav(project?: Project): Promise<Blob>
  subscribe(callback: () => void): () => void
  getSnapshot(): TransportSnapshot
  /** Sample sets are keyed by InstrumentDef.set and load lazily; see audio/samples.ts. */
  sampleStatus(setId: string): SampleStatus
  preloadSamples(setId: string): Promise<void>
  subscribeSamples(callback: () => void): () => void
  sampleAttribution(setId: string): SampleAttribution | undefined
  getTrackLevel(trackId: string): number
  getMasterLevel(): number
  /** Native host only: a compressor/limiter/gate insert's live input peak and lowest gain (linear). */
  getDeviceMeter?(deviceId: string): { input: number; gain: number } | null
  /** Routes a live input stream into the given audio tracks' chains (input monitoring). null releases it. */
  setInputMonitor(stream: MediaStream | null, trackIds: readonly string[]): void
  /** Web Audio: monitor gates of tracks whose input is another track or the master (no stream needed). */
  setRouteMonitor?(trackIds: readonly string[]): void
  /** Mono/stereo inputs a track can choose, from the enabled device channels (WP3 implements). */
  getInputChoices?(): InputChoice[]
  /** How many tracks can record at once: 1 in a browser, more on the native engine (WP2 implements). */
  readonly maxSimultaneousRecordings?: number
  dispose(): void
}

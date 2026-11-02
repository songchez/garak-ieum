import type { SampleRate } from './audioSettings'
import type { PitchEditDocument } from '../devices/pitch-editor/model'

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
  start: number
  duration: number
  velocity: number
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
  /** Playback offset in ticks at 960 PPQ (−1920…1920). Absent = 0. */
  delayTicks?: number
}
export interface MidiClip extends ClipBase {
  kind: 'midi'
  notes: MidiNote[]
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
  fadeIn: number
  fadeOut: number
  /** Original/analysis/edit state. assetId is the committed, duration-preserving render. */
  pitch?: PitchEditDocument
}
export type Clip = MidiClip | AudioClip
export type EffectType = 'eq' | 'filter' | 'compressor' | 'drive' | 'delay' | 'reverb'
/** One insert effect. Track.devices is processed left to right. Disabled devices are bypassed. */
export interface Device {
  id: string
  type: EffectType
  enabled: boolean
  params: Record<string, number>
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
  /** Input monitoring for audio tracks. Live state: never enters undo history. */
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
  devices: Device[]
}
export interface Marker {
  id: string
  name: string
  startBeat: number
}
export interface Project {
  schemaVersion: 3
  id: string
  name: string
  bpm: number
  /** Project rendering rate; device preferences are stored separately in this browser. */
  sampleRate: SampleRate
  beatsPerBar: 4
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
  setProject(project: Project): void
  setAssets(assets: Map<string, AudioAsset>): void
  resume(): Promise<void>
  play(): Promise<void>
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
  /** Routes a live input stream into the given audio tracks' chains (input monitoring). null releases it. */
  setInputMonitor(stream: MediaStream | null, trackIds: readonly string[]): void
  dispose(): void
}

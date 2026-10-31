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
}
export interface MidiClip extends ClipBase {
  kind: 'midi'
  notes: MidiNote[]
}
export interface AudioClip extends ClipBase {
  kind: 'audio'
  assetId: string
  offsetSeconds: number
  fadeIn: number
  fadeOut: number
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
  clips: Clip[]
  /** Keys and ranges are defined by instrumentDef(instrument).params in core/instruments.ts. */
  instrumentParams: Record<string, number>
  devices: Device[]
}
export interface Project {
  schemaVersion: 2
  id: string
  name: string
  bpm: number
  beatsPerBar: 4
  lengthBeats: number
  masterVolume: number
  loop: { enabled: boolean; startBeat: number; endBeat: number }
  tracks: Track[]
}
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
  dispose(): void
}

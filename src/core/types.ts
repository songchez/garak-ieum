export type InstrumentId = 'drums' | 'bass' | 'keys' | 'pad' | 'pluck'
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
export interface TrackEffects {
  filter: number
  reverb: number
  delay: number
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
  effects: TrackEffects
}
export interface Project {
  schemaVersion: 1
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
  previewNote(instrument: InstrumentId, pitch: number, velocity?: number): Promise<void>
  decodeAsset(blob: Blob, name: string, id?: string): Promise<AudioAsset>
  exportWav(project?: Project): Promise<Blob>
  subscribe(callback: () => void): () => void
  getSnapshot(): TransportSnapshot
  getTrackLevel(trackId: string): number
  getMasterLevel(): number
  dispose(): void
}

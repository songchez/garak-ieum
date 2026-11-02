export interface SignalsmithModule {
  HEAP8: Int8Array
  _setBuffers(channels: number, frames: number): number
  _presetDefault(channels: number, sampleRate: number): void
  _reset(): void
  _inputLatency(): number
  _outputLatency(): number
  _setTransposeSemitones(semitones: number, tonalityLimit: number): void
  _setFormantSemitones(semitones: number, compensate: boolean): void
  _setFormantBase(relativeFrequency: number): void
  _process(inputFrames: number, outputFrames: number): void
}
declare function createSignalsmith(): Promise<SignalsmithModule>
export default createSignalsmith

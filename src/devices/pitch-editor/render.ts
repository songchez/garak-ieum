import { PITCH_LIMITS, type PitchNote, type PitchRenderSettings } from './model'
import { validatePitchPcm } from './analysis'
import createSignalsmith, { type SignalsmithModule } from './vendor/signalsmith-core.mjs'
export { PITCH_RENDERER_ID } from './metadata'

function validateEdits(segments: readonly PitchNote[], shifts: Readonly<Record<string, number>>, settings: PitchRenderSettings, duration: number, sampleRate: number): void {
  if (!Array.isArray(segments) || segments.length > PITCH_LIMITS.maxNotes) throw new Error('피치 음표 개수가 올바르지 않습니다.')
  const ids = new Set<string>()
  let previousEnd = 0
  // A saved source may be decoded at another supported rate. Its seconds can
  // round by up to two frames of the lower rate; the API has no old rate, so
  // bound the tolerance by 2 / 8000 = 0.25 ms. Rendering clamps to actual PCM.
  const endTolerance = 2 / Math.min(sampleRate, PITCH_LIMITS.minSampleRate)
  for (const note of segments) {
    if (!note || typeof note.id !== 'string' || !note.id || ids.has(note.id) || note.id.length > 200) throw new Error('피치 음표 ID가 올바르지 않습니다.')
    if (![note.start, note.end, note.midi, note.confidence].every(Number.isFinite) || note.start < previousEnd - 1e-8 || note.start < 0 || note.end > duration + endTolerance + 1e-8 || note.end <= note.start || note.midi < 0 || note.midi > 127 || note.confidence < 0 || note.confidence > 1) {
      throw new Error('피치 음표의 범위가 올바르지 않습니다.')
    }
    ids.add(note.id)
    previousEnd = note.end
  }
  if (!shifts || typeof shifts !== 'object' || Array.isArray(shifts) || Object.keys(shifts).length > PITCH_LIMITS.maxNotes) throw new Error('피치 변경값이 올바르지 않습니다.')
  for (const [id, cents] of Object.entries(shifts)) {
    if (!ids.has(id) || !Number.isFinite(cents) || cents < PITCH_LIMITS.minCents || cents > PITCH_LIMITS.maxCents) throw new Error('피치 변경은 선택한 음표에서 ±1옥타브까지 지원합니다.')
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || typeof settings.preserveFormants !== 'boolean' || !settings.formantShifts || typeof settings.formantShifts !== 'object' || Array.isArray(settings.formantShifts) || Object.keys(settings.formantShifts).length > PITCH_LIMITS.maxNotes) throw new Error('포먼트 설정이 올바르지 않습니다.')
  for (const [id, cents] of Object.entries(settings.formantShifts)) {
    if (!ids.has(id) || !Number.isFinite(cents) || cents < PITCH_LIMITS.minFormantCents || cents > PITCH_LIMITS.maxFormantCents) throw new Error('포먼트 변경은 선택한 음표에서 ±1옥타브까지 지원합니다.')
  }
  for (const note of segments) {
    const preShift = ownShift(settings.formantShifts, note.id) - (settings.preserveFormants ? ownShift(shifts, note.id) : 0)
    // Beyond an octave, measured envelope failures also perturb the dominant
    // harmonic's frequency. Reject instead of silently changing the target.
    if (Math.abs(preShift) > PITCH_LIMITS.maxFormantCents) throw new Error('피치와 포먼트의 보정 차이가 ±1200센트를 넘습니다. 이동량을 줄이거나 포먼트 보존을 꺼 주세요.')
  }
}

const ownShift = (shifts: Readonly<Record<string, number>>, id: string): number => Object.hasOwn(shifts, id) ? shifts[id] : 0

const RESAMPLE_HALF_TAPS = 32
const RESAMPLE_PHASES = 1024

/** Blackman-windowed sinc; cutoff removes frequencies that would alias upward. */
function resamplingKernel(ratio: number): Float32Array {
  const taps = RESAMPLE_HALF_TAPS * 2
  const cutoff = Math.min(1, 1 / ratio)
  const table = new Float32Array((RESAMPLE_PHASES + 1) * taps)
  for (let phase = 0; phase <= RESAMPLE_PHASES; phase += 1) {
    const fraction = phase / RESAMPLE_PHASES
    let sum = 0
    for (let tap = 0; tap < taps; tap += 1) {
      const distance = tap - RESAMPLE_HALF_TAPS + 1 - fraction
      const x = Math.PI * distance * cutoff
      const sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(x) / x
      const window = Math.abs(distance) >= RESAMPLE_HALF_TAPS ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * distance / RESAMPLE_HALF_TAPS) + 0.08 * Math.cos(2 * Math.PI * distance / RESAMPLE_HALF_TAPS)
      const weight = cutoff * sinc * window
      table[phase * taps + tap] = weight
      sum += weight
    }
    for (let tap = 0; tap < taps; tap += 1) table[phase * taps + tap] /= sum
  }
  return table
}

/** Stretch at neutral pitch, then resample at the requested exact ratio. */
function renderNote(
  module: SignalsmithModule, source: readonly Float32Array[], output: Float32Array[],
  sampleRate: number, note: PitchNote, cents: number, formantCents: number, kernel: Float32Array, onProgress: (fraction: number) => void,
): void {
  const blockSize = 512
  const ratio = 2 ** (cents / 1200)
  const noteStart = Math.max(0, Math.round(note.start * sampleRate))
  const noteEnd = Math.min(source[0].length, Math.round(note.end * sampleRate))
  // Trimming can leave a sub-frame/one-frame fragment. It has no pitch interval;
  // preserve it exactly instead of rejecting a valid region boundary.
  if (noteEnd - noteStart <= 1) { onProgress(1); return }
  const contextFrames = Math.ceil(sampleRate * 0.18)
  const windowStart = Math.max(0, noteStart - contextFrames)
  const windowEnd = Math.min(source[0].length, noteEnd + contextFrames)
  const windowFrames = windowEnd - windowStart
  const fadeFrames = Math.max(1, Math.min(Math.round(sampleRate * 0.008), Math.floor((noteEnd - noteStart) / 4)))
  module._reset()
  // Direct spectral transposition in this pinned release measured up to 10.54
  // cents of error on small shifts. Neutral stretching + resampling avoids that
  // bin-mapping error. Envelope shifting does not change this frequency map.
  module._setTransposeSemitones(0, 1)
  // Apply the requested envelope displacement before resampling. Preservation
  // subtracts the pitch delta here because resampling will add it back. The
  // upstream compensation flag only sees its own transpose map, which is neutral.
  module._setFormantSemitones(formantCents / 100, false)
  // The upstream analysis receives the original, untransposed PCM. Frequencies
  // are in cycles/sample (Hz/sampleRate), not relative to Nyquist or output F0.
  module._setFormantBase(440 * 2 ** ((note.midi - 69) / 12) / sampleRate)
  const latency = module._inputLatency() * ratio + module._outputLatency()
  const bufferFrames = Math.ceil(blockSize * Math.max(1, ratio)) + 1
  const base = module._setBuffers(source.length, bufferFrames) / Float32Array.BYTES_PER_ELEMENT
  // Keep only recent stretched frames, bounding memory even for 60 s / 192 kHz.
  const ringFrames = 2 ** Math.ceil(Math.log2(bufferFrames + RESAMPLE_HALF_TAPS * 2 + 2))
  const ringMask = ringFrames - 1
  const recent = source.map(() => new Float32Array(ringFrames))
  const framesToProcess = windowFrames + Math.ceil((latency + RESAMPLE_HALF_TAPS + 2) / ratio)
  const taps = RESAMPLE_HALF_TAPS * 2
  let nextFrame = noteStart
  for (let position = 0; position < framesToProcess && nextFrame < noteEnd; position += blockSize) {
    const count = Math.min(blockSize, framesToProcess - position)
    const outputStart = Math.round(position * ratio)
    const outputEnd = Math.round((position + count) * ratio)
    const outputCount = outputEnd - outputStart
    let heap = new Float32Array(module.HEAP8.buffer)
    for (let channel = 0; channel < source.length; channel += 1) {
      const offset = base + bufferFrames * channel
      heap.fill(0, offset, offset + bufferFrames)
      const available = Math.max(0, Math.min(count, windowFrames - position))
      if (available) heap.set(source[channel].subarray(windowStart + position, windowStart + position + available), offset)
    }
    module._process(count, outputCount)
    // Emscripten may grow memory during processing. Never reuse an old view.
    heap = new Float32Array(module.HEAP8.buffer)
    for (let channel = 0; channel < source.length; channel += 1) {
      const offset = base + bufferFrames * (source.length + channel)
      for (let i = 0; i < outputCount; i += 1) recent[channel][(outputStart + i) & ringMask] = heap[offset + i]
    }
    while (nextFrame < noteEnd) {
      const target = latency + (nextFrame - windowStart) * ratio
      const center = Math.floor(target)
      if (center + RESAMPLE_HALF_TAPS >= outputEnd) break
      const phase = Math.round((target - center) * RESAMPLE_PHASES)
      const kernelOffset = phase * taps
      const firstSample = center - RESAMPLE_HALF_TAPS + 1
      const edge = Math.min(1, (nextFrame - noteStart) / fadeFrames, (noteEnd - 1 - nextFrame) / fadeFrames)
      const mix = Math.sin(Math.max(0, edge) * Math.PI / 2) ** 2
      for (let channel = 0; channel < source.length; channel += 1) {
        let value = 0
        for (let tap = 0; tap < taps; tap += 1) value += recent[channel][(firstSample + tap) & ringMask] * kernel[kernelOffset + tap]
        if (!Number.isFinite(value)) throw new Error('피치 렌더링 중 유효하지 않은 오디오가 생성되었습니다.')
        // Retain the original endpoint exactly, including signed zero. Adding
        // a zero-valued processed term can otherwise change -0 into +0.
        if (mix !== 0) output[channel][nextFrame] = source[channel][nextFrame] * (1 - mix) + value * mix
      }
      nextFrame += 1
    }
    if (position % (blockSize * 16) === 0) onProgress(position / framesToProcess)
  }
  if (nextFrame !== noteEnd) throw new Error('피치 렌더링 길이가 원본과 일치하지 않습니다.')
  onProgress(1)
}

/** Duration-preserving, offline monophonic edits. Inputs are never mutated. */
export async function renderPitch(
  channels: readonly Float32Array[], sampleRate: number, segments: readonly PitchNote[],
  shifts: Readonly<Record<string, number>>, onProgress?: (progress: number) => void,
  settings: PitchRenderSettings = { preserveFormants: false, formantShifts: {} },
): Promise<Float32Array[]> {
  const frames = validatePitchPcm(channels, sampleRate)
  validateEdits(segments, shifts, settings, frames / sampleRate, sampleRate)
  const output = channels.map(channel => channel.slice())
  const changed = segments.filter(note => ownShift(shifts, note.id) !== 0 || ownShift(settings.formantShifts, note.id) !== 0)
  onProgress?.(0)
  if (!changed.length) { onProgress?.(1); return output }
  // One instance per operation: upstream's C binding stores a global stretcher.
  const module = await createSignalsmith()
  module._presetDefault(channels.length, sampleRate)
  const weights = changed.map(note => note.end - note.start + 0.36)
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  let completed = 0
  let lastCents = Number.NaN
  let kernel: Float32Array = new Float32Array(0)
  for (let index = 0; index < changed.length; index += 1) {
    const note = changed[index]
    const cents = ownShift(shifts, note.id)
    const formantCents = ownShift(settings.formantShifts, note.id) - (settings.preserveFormants ? cents : 0)
    if (cents !== lastCents) { kernel = resamplingKernel(2 ** (cents / 1200)); lastCents = cents }
    renderNote(module, channels, output, sampleRate, note, cents, formantCents, kernel, fraction => onProgress?.((completed + fraction * weights[index]) / totalWeight))
    completed += weights[index]
  }
  onProgress?.(1)
  return output
}

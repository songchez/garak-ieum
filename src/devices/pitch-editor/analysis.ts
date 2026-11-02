import { PITCH_LIMITS, type PitchAnalysis, type PitchNote, type PitchPoint } from './model'

/** Validate at the worker boundary as well as in project state validation. */
export function validatePitchPcm(channels: readonly Float32Array[], sampleRate: number): number {
  if (!Number.isInteger(sampleRate) || sampleRate < PITCH_LIMITS.minSampleRate || sampleRate > PITCH_LIMITS.maxSampleRate) {
    throw new Error('피치 편집은 8~192 kHz 오디오를 지원합니다.')
  }
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > PITCH_LIMITS.maxChannels) {
    throw new Error('피치 편집은 모노 또는 스테레오 음원을 지원합니다.')
  }
  const frames = channels[0]?.length ?? 0
  if (frames < 1 || frames / sampleRate > PITCH_LIMITS.maxDurationSeconds) {
    throw new Error('첫 피치 편집 버전은 60초 이하의 음원을 지원합니다.')
  }
  for (const channel of channels) {
    if (!(channel instanceof Float32Array) || channel.length !== frames) throw new Error('오디오 채널 길이가 올바르지 않습니다.')
    for (let i = 0; i < channel.length; i += 1) {
      if (!Number.isFinite(channel[i])) throw new Error('오디오에 유효하지 않은 샘플이 있습니다.')
    }
  }
  return frames
}

type Frame = { time: number; midi: number | null; confidence: number; rms: number }
const midiFromHz = (frequency: number) => 69 + 12 * Math.log2(frequency / 440)
const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** A loudest-channel analysis avoids cancelling an antiphase stereo recording. */
function analysisChannel(channels: readonly Float32Array[]): Float32Array {
  let selected = channels[0], highest = -1
  for (const channel of channels) {
    let energy = 0
    for (let i = 0; i < channel.length; i += 1) energy += channel[i] * channel[i]
    if (energy > highest) { selected = channel; highest = energy }
  }
  return selected
}

/** Area-average downsampling keeps DC stable and attenuates high-frequency aliases. */
function downsample(input: Float32Array, sampleRate: number, targetRate: number): Float32Array {
  if (sampleRate === targetRate) return input
  const ratio = sampleRate / targetRate
  const output = new Float32Array(Math.ceil(input.length / ratio))
  for (let i = 0; i < output.length; i += 1) {
    const start = i * ratio, end = Math.min(input.length, (i + 1) * ratio)
    let sum = 0
    for (let frame = Math.floor(start); frame < Math.ceil(end); frame += 1) {
      sum += input[frame] * (Math.min(frame + 1, end) - Math.max(frame, start))
    }
    output[i] = sum / (end - start)
  }
  return output
}

/** YIN cumulative mean normalized difference with parabolic period refinement. */
function estimateFrame(input: Float32Array, center: number, rate: number, difference: Float64Array, rawDifference: Float64Array): Frame {
  const minimumLag = Math.max(2, Math.floor(rate / 1600))
  const maximumLag = Math.min(difference.length - 2, Math.floor(rate / 55))
  const window = Math.ceil(rate * 0.043)
  const start = Math.round(center - (window + maximumLag) / 2)
  const at = (index: number) => index < 0 || index >= input.length ? 0 : input[index]
  let mean = 0, square = 0
  for (let j = 0; j < window; j += 1) { const value = at(start + j); mean += value; square += value * value }
  const rms = Math.sqrt(Math.max(0, square / window - (mean / window) ** 2))
  const result: Frame = { time: center / rate, midi: null, confidence: 0, rms }
  if (rms < 0.003) return result
  let cumulative = 0
  difference[0] = 1
  for (let lag = 1; lag <= maximumLag + 1; lag += 1) {
    let sum = 0
    for (let j = 0; j < window; j += 1) { const delta = at(start + j) - at(start + j + lag); sum += delta * delta }
    rawDifference[lag] = sum
    cumulative += sum
    difference[lag] = cumulative > 0 ? sum * lag / cumulative : 1
  }
  let chosen = -1
  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    if (difference[lag] < 0.15) {
      while (lag < maximumLag && difference[lag + 1] < difference[lag]) lag += 1
      chosen = lag
      break
    }
  }
  if (chosen < 0) return result
  // CMND selects the period; refining the original difference avoids its
  // normalization slope bias at short periods near the upper pitch limit.
  const a = rawDifference[chosen - 1], b = rawDifference[chosen], c = rawDifference[chosen + 1]
  const denominator = a - 2 * b + c
  const offset = Math.abs(denominator) > 1e-12 ? Math.max(-1, Math.min(1, 0.5 * (a - c) / denominator)) : 0
  const frequency = rate / (chosen + offset)
  // A tiny numerical guard keeps boundary tones from disappearing due to
  // fractional-period estimation; the measured pitch itself is not quantized.
  if (!Number.isFinite(frequency) || frequency < 54.8 || frequency > 1605) return result
  return { ...result, midi: midiFromHz(frequency), confidence: Math.max(0, Math.min(1, 1 - difference[chosen])) }
}

function segmentFrames(frames: readonly Frame[], duration: number, hopSeconds: number): PitchNote[] {
  const notes: PitchNote[] = []
  let group: Frame[] = []
  const finish = () => {
    if (!group.length) return
    const start = Math.max(0, group[0].time - hopSeconds / 2)
    const end = Math.min(duration, group[group.length - 1].time + hopSeconds / 2)
    if (end - start >= PITCH_LIMITS.minNoteSeconds) {
      notes.push({ id: `note-${notes.length + 1}`, start, end, midi: median(group.map(f => f.midi!)), confidence: group.reduce((sum, f) => sum + f.confidence, 0) / group.length })
    }
    group = []
  }
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i]
    if (frame.midi === null) { finish(); continue }
    if (group.length >= 3) {
      const recent = group.slice(-Math.min(9, group.length)).map(f => f.midi!)
      const next = frames.slice(i, i + 3)
      const stableNewPitch = next.length === 3 && next.every(f => f.midi !== null && Math.abs(f.midi! - frame.midi!) < 0.65)
      if (stableNewPitch && Math.abs(frame.midi - median(recent)) > 0.8) finish()
    }
    group.push(frame)
  }
  finish()
  return notes.slice(0, PITCH_LIMITS.maxNotes)
}

/** Initial monophonic detector: 55–1600 Hz, 10 ms hops, no speech recognition. */
export function analyzePitch(channels: readonly Float32Array[], sampleRate: number, onProgress?: (progress: number) => void): PitchAnalysis {
  const sourceFrames = validatePitchPcm(channels, sampleRate)
  const rate = Math.min(sampleRate, 12000)
  const signal = downsample(analysisChannel(channels), sampleRate, rate)
  const hop = Math.max(1, Math.round(rate * 0.01))
  const difference = new Float64Array(Math.ceil(rate / 55) + 4)
  const rawDifference = new Float64Array(difference.length)
  const frames: Frame[] = []
  const contour: PitchPoint[] = []
  const total = Math.ceil(signal.length / hop)
  onProgress?.(0)
  for (let index = 0; index < total; index += 1) {
    const frame = estimateFrame(signal, index * hop, rate, difference, rawDifference)
    frames.push(frame)
    if (frame.midi !== null && contour.length < PITCH_LIMITS.maxContourPoints) contour.push({ time: frame.time, midi: frame.midi, confidence: frame.confidence })
    if (index % 25 === 0) onProgress?.(index / total)
  }
  const notes = segmentFrames(frames, sourceFrames / sampleRate, hop / rate)
  onProgress?.(1)
  return { version: 1, algorithm: 'yin-v1', sampleRate, sourceFrames, notes, contour }
}

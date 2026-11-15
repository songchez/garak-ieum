/**
 * Offline tempo detection for audio clips.
 *
 * 1. Mono mixdown, box-filter decimation to ~11–12 kHz (onsets do not need more).
 * 2. Log-magnitude spectral flux (512-point Hann, hop 64) → onset-strength envelope,
 *    minus a 0.4 s moving average and half-wave rectified.
 * 3. Unbiased autocorrelation; every candidate tempo in 60–200 BPM scores the sum of
 *    its first four beat-period harmonics, weighted by a log-normal prior around 120.
 * 4. Octave check: if the onsets halfway between the winner's beats are nearly as strong
 *    as the beats (≥ 80 %), they are beats too and twice the tempo wins.
 * 5. Beat phase: comb sum over the winning period gives the first beat.
 */

export interface TempoAnalysis {
  bpm: number
  /** 0–1: normalized envelope correlation at the beat period. */
  confidence: number
  /** First beat in source seconds, at or after 0. */
  firstBeatSeconds: number
}

export const TEMPO_LIMITS = {
  minBpm: 60,
  maxBpm: 200,
  /** Longer files are analyzed from their start; minutes of material settle the tempo. */
  maxAnalysisSeconds: 360,
  minAnalysisSeconds: 1,
} as const

const TARGET_RATE = 11025
const FFT_SIZE = 512
const HOP = 64
const HARMONICS = 4
/** Off-beat/on-beat onset strength at which twice the tempo is the fundamental. */
const OCTAVE_RATIO = 0.8

export interface AnalysisSignal { signal: Float32Array; sampleRate: number }

/** Cheap enough for the UI thread: shrinks what a worker has to receive. */
export function prepareTempoSignal(channels: readonly Float32Array[], sampleRate: number): AnalysisSignal {
  if (!Array.isArray(channels) || !channels.length || !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 384000) throw new Error('템포 분석용 오디오 형식이 올바르지 않습니다.')
  const frames = Math.min(channels[0].length, Math.floor(TEMPO_LIMITS.maxAnalysisSeconds * sampleRate))
  const factor = Math.max(1, Math.floor(sampleRate / TARGET_RATE))
  const length = Math.floor(frames / factor)
  const signal = new Float32Array(length)
  const scale = 1 / (factor * channels.length)
  for (const channel of channels) {
    for (let i = 0, j = 0; i < length; i += 1) {
      let sum = 0
      for (let k = 0; k < factor; k += 1, j += 1) { const value = channel[j]; if (Number.isFinite(value)) sum += value }
      signal[i] += sum * scale
    }
  }
  return { signal, sampleRate: sampleRate / factor }
}

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const step = -2 * Math.PI / size, half = size >> 1
    const wr = Math.cos(step), wi = Math.sin(step)
    for (let start = 0; start < n; start += size) {
      let cr = 1, ci = 0
      for (let k = 0; k < half; k += 1) {
        const a = start + k, b = a + half
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti
        const next = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = next
      }
    }
  }
}

/** Frame i is centred on time i / frameRate. */
export function onsetEnvelope({ signal, sampleRate }: AnalysisSignal, onProgress?: (fraction: number) => void): { envelope: Float32Array; frameRate: number } {
  const half = FFT_SIZE / 2
  const frameCount = Math.max(0, Math.floor(signal.length / HOP) + 1)
  const raw = new Float32Array(frameCount)
  const window = Float64Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FFT_SIZE))
  const re = new Float64Array(FFT_SIZE), im = new Float64Array(FFT_SIZE)
  let previous = new Float64Array(half), current = new Float64Array(half)
  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * HOP - half
    for (let i = 0; i < FFT_SIZE; i += 1) {
      const index = start + i
      re[i] = index >= 0 && index < signal.length ? signal[index] * window[i] : 0
      im[i] = 0
    }
    fft(re, im)
    let flux = 0
    for (let bin = 1; bin < half; bin += 1) {
      const value = Math.log1p(100 * Math.hypot(re[bin], im[bin]))
      current[bin] = value
      const rise = value - previous[bin]
      if (frame > 0 && rise > 0) flux += rise
    }
    raw[frame] = flux
    const swap = previous; previous = current; current = swap
    if (onProgress && frame % 4096 === 0) onProgress(0.8 * frame / frameCount)
  }
  const frameRate = sampleRate / HOP
  // Remove slow loudness changes so the autocorrelation sees onsets, not level.
  const radius = Math.max(1, Math.round(frameRate * 0.2))
  const envelope = new Float32Array(frameCount)
  let sum = 0, left = 0, right = 0
  for (let i = 0; i < frameCount; i += 1) {
    while (right < Math.min(frameCount, i + radius + 1)) sum += raw[right++]
    while (left < i - radius) sum -= raw[left++]
    const mean = sum / (right - left)
    envelope[i] = Math.max(0, raw[i] - mean)
  }
  return { envelope, frameRate }
}

const prior = (bpm: number) => Math.exp(-0.5 * Math.log2(bpm / 120) ** 2)

/** Analyze a prepared mono signal. Returns null for silence or material too short to measure. */
export function analyzeTempoSignal(input: AnalysisSignal, onProgress?: (fraction: number) => void): TempoAnalysis | null {
  if (!(input.signal instanceof Float32Array) || !Number.isFinite(input.sampleRate) || input.sampleRate <= 0) throw new Error('템포 분석용 오디오 형식이 올바르지 않습니다.')
  if (input.signal.length / input.sampleRate < TEMPO_LIMITS.minAnalysisSeconds) return null
  const { envelope, frameRate } = onsetEnvelope(input, onProgress)
  const n = envelope.length
  let mean = 0
  for (const value of envelope) mean += value
  mean /= n
  if (!(mean > 1e-9)) return null
  const minLag = 60 * frameRate / TEMPO_LIMITS.maxBpm
  const maxPeriod = 60 * frameRate / TEMPO_LIMITS.minBpm
  // Unbiased estimates need overlap; short clips use fewer harmonics.
  const maxLag = Math.min(Math.ceil(maxPeriod * HARMONICS) + 2, Math.floor(n * 0.75))
  if (maxLag < minLag + 2) return null
  const ac = new Float64Array(maxLag + 2)
  for (let lag = 0; lag < ac.length; lag += 1) {
    let sum = 0
    for (let i = 0; i + lag < n; i += 1) sum += envelope[i] * envelope[i + lag]
    ac[lag] = sum / (n - lag)
  }
  onProgress?.(0.9)
  const at = (lag: number) => {
    if (lag > maxLag) return Number.NaN
    const i = Math.floor(lag), f = lag - i
    return ac[i] * (1 - f) + ac[i + 1] * f
  }
  const raw = (bpm: number) => {
    const period = 60 * frameRate / bpm
    let score = 0, weights = 0
    for (let k = 1; k <= HARMONICS; k += 1) {
      const value = at(period * k)
      if (Number.isNaN(value)) break
      score += value / Math.sqrt(k); weights += 1 / Math.sqrt(k)
    }
    // Missing harmonics (short clips) are scored by the mean of those measured.
    return weights ? score / weights : 0
  }
  const step = 0.05
  let best = 0, bestScore = -Infinity
  for (let bpm = TEMPO_LIMITS.minBpm; bpm <= TEMPO_LIMITS.maxBpm + 1e-9; bpm += step) {
    const score = raw(bpm) * prior(bpm)
    if (score > bestScore) { bestScore = score; best = bpm }
  }
  // Mean onset strength on a beat grid; a ±2-frame peak search tolerates jitter.
  const comb = (periodFrames: number, start: number) => {
    let sum = 0, count = 0
    for (let position = start; position < n; position += periodFrames, count += 1) {
      const center = Math.round(position)
      let peak = 0
      for (let i = Math.max(0, center - 2); i <= Math.min(n - 1, center + 2); i += 1) peak = Math.max(peak, envelope[i])
      sum += peak
    }
    return count ? sum / count : 0
  }
  const phaseOf = (periodFrames: number) => {
    let phase = 0, score = -Infinity
    for (let start = 0; start < periodFrames; start += 1) {
      const value = comb(periodFrames, start)
      if (value > score + 1e-12) { score = value; phase = start }
    }
    return { phase, score }
  }
  // Every beat at T is also periodic at T/2. If the off-beats between the winner's
  // beats are as strong as the beats, they are beats too: the faster tempo wins.
  if (best * 2 <= TEMPO_LIMITS.maxBpm + 0.5) {
    const periodFrames = 60 * frameRate / best
    const onBeat = phaseOf(periodFrames)
    const offBeat = comb(periodFrames, onBeat.phase + periodFrames / 2)
    if (offBeat >= OCTAVE_RATIO * onBeat.score) best *= 2
  }
  const rounded = Math.abs(best - Math.round(best)) < 0.25 ? Math.round(best) : Math.round(best * 100) / 100
  const bpm = Math.min(TEMPO_LIMITS.maxBpm, Math.max(TEMPO_LIMITS.minBpm, rounded))
  const period = 60 * frameRate / bpm
  // Mean-removed, normalized correlation at the first two beat periods.
  const zero = ac[0] - mean * mean
  let correlation = 0, counted = 0
  for (let k = 1; k <= 2; k += 1) {
    const value = at(period * k)
    if (Number.isNaN(value)) break
    correlation += (value - mean * mean) / zero; counted += 1
  }
  const confidence = zero > 0 && counted ? Math.round(Math.min(1, Math.max(0, correlation / counted)) * 1000) / 1000 : 0
  let phase = 0, phaseScore = -Infinity
  for (let start = 0; start < period; start += 0.5) {
    let sum = 0, count = 0
    for (let position = start; position < n - 1; position += period, count += 1) {
      const i = Math.floor(position), f = position - i
      sum += envelope[i] * (1 - f) + envelope[i + 1] * f
    }
    const score = count ? sum / count : 0
    if (score > phaseScore + 1e-12) { phaseScore = score; phase = start }
  }
  onProgress?.(1)
  // Log-compressed flux peaks while an attack enters the window, ~¾ of a half window early.
  const lead = 0.75 * (FFT_SIZE / 2) / input.sampleRate
  let first = phase / frameRate + lead
  const periodSeconds = 60 / bpm
  if (first > periodSeconds - 2 * lead) first -= periodSeconds
  return { bpm, confidence, firstBeatSeconds: Math.round(Math.max(0, first) * 10000) / 10000 }
}

export function analyzeTempo(channels: readonly Float32Array[], sampleRate: number, onProgress?: (fraction: number) => void): TempoAnalysis | null {
  return analyzeTempoSignal(prepareTempoSignal(channels, sampleRate), onProgress)
}

/** "loop_120bpm", "Drums 92 BPM", "kit_128_Am" → tempo in 60–200, else null. */
export function tempoFromFilename(name: string): number | null {
  const base = name.replace(/\.[^.]+$/, '')
  const explicit = /(\d{2,3}(?:\.\d+)?)\s*-?\s*bpm/i.exec(base) ?? /bpm\s*-?\s*(\d{2,3}(?:\.\d+)?)/i.exec(base)
  const candidates = explicit ? [explicit[1]] : [...base.matchAll(/(?:^|[_\-\s.])(\d{2,3})(?=$|[_\-\s.])/g)].map(match => match[1])
  for (const text of candidates) {
    const value = Number(text)
    if (Number.isFinite(value) && value >= TEMPO_LIMITS.minBpm && value <= TEMPO_LIMITS.maxBpm) return value
  }
  return null
}

export const LOOP_LIMITS = { maxSeconds: 30, minSeconds: 1, minBpm: 70, maxBpm: 180, bars: [1, 2, 4, 8] } as const

/** Tempos at which the clip is exactly 1, 2, 4 or 8 bars long, within 70–180 BPM. */
export function loopTempoCandidates(durationSeconds: number, beatsPerBar = 4): Array<{ bpm: number; bars: number }> {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isFinite(beatsPerBar) || beatsPerBar <= 0) return []
  return LOOP_LIMITS.bars
    .map(bars => ({ bars, bpm: Math.round(bars * beatsPerBar * 60 / durationSeconds * 1000) / 1000 }))
    .filter(item => item.bpm >= LOOP_LIMITS.minBpm && item.bpm <= LOOP_LIMITS.maxBpm)
}

/** Short-loop estimate without spectral analysis: the file name, else the bar count nearest 120. */
export function estimateLoopTempo(name: string, durationSeconds: number, beatsPerBar = 4): { bpm: number; source: 'filename' | 'length'; bars?: number } | null {
  const named = tempoFromFilename(name)
  if (named !== null) return { bpm: named, source: 'filename' }
  const candidates = loopTempoCandidates(durationSeconds, beatsPerBar)
  if (!candidates.length) return null
  const best = candidates.reduce((a, b) => Math.abs(Math.log2(b.bpm / 120)) < Math.abs(Math.log2(a.bpm / 120)) ? b : a)
  return { bpm: best.bpm, source: 'length', bars: best.bars }
}

export interface WarpDecision {
  sourceBpm: number
  confidence: number
  firstBeatSeconds: number
  /** Auto-warp to the project tempo on import. */
  enabled: boolean
  source: 'filename' | 'length' | 'analysis'
}

/** longMinConfidence: a steadily grooving song measures about 0.5; ambient or rubato material stays well below. */
export const AUTO_WARP = { minConfidence: 0.2, longMinConfidence: 0.4, tolerance: 0.04 } as const

/**
 * Import policy (Ableton's Auto-Warp, long samples included). Short loop-like files warp
 * when the file name, or the analysis together with a whole bar count, agrees on a tempo.
 * Longer files warp when the name gives a tempo or the analysis hears a clear beat;
 * otherwise the detected tempo is only stored and warp stays off.
 */
export function decideWarp(input: { name: string; durationSeconds: number; beatsPerBar?: number; analysis: TempoAnalysis | null }): WarpDecision | null {
  const { name, durationSeconds, analysis } = input
  if (!Number.isFinite(durationSeconds) || durationSeconds < LOOP_LIMITS.minSeconds) return null
  const loopLike = durationSeconds <= LOOP_LIMITS.maxSeconds
  const firstBeatSeconds = analysis?.firstBeatSeconds ?? 0
  const named = tempoFromFilename(name)
  if (named !== null) return { sourceBpm: named, confidence: Math.max(0.9, analysis?.confidence ?? 0), firstBeatSeconds, enabled: true, source: 'filename' }
  if (!analysis) return null
  if (loopLike && analysis.confidence >= AUTO_WARP.minConfidence) {
    const candidates = loopTempoCandidates(durationSeconds, input.beatsPerBar ?? 4)
    for (const factor of [1, 2, 0.5]) {
      const match = candidates.find(candidate => Math.abs(candidate.bpm / (analysis.bpm * factor) - 1) <= AUTO_WARP.tolerance)
      if (match) return { sourceBpm: match.bpm, confidence: Math.max(analysis.confidence, 0.75), firstBeatSeconds, enabled: true, source: 'length' }
    }
  }
  return { sourceBpm: analysis.bpm, confidence: analysis.confidence, firstBeatSeconds, enabled: !loopLike && analysis.confidence >= AUTO_WARP.longMinConfidence, source: 'analysis' }
}

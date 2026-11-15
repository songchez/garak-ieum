import { describe, expect, it } from 'vitest'
import { analyzeTempo, decideWarp, estimateLoopTempo, loopTempoCandidates, prepareTempoSignal, tempoFromFilename } from './tempo'

const RATE = 44100

/** Deterministic noise so tests never flake. */
function noise(seed = 1): () => number {
  let state = seed >>> 0
  return () => { state = Math.imul(state ^ (state >>> 15), 2246822507) + 0x9e3779b9 >>> 0; return state / 2 ** 32 * 2 - 1 }
}

function addClick(out: Float32Array, at: number, gain: number, rate: number, random: () => number, hz = 1800): void {
  const start = Math.round(at * rate), length = Math.round(rate * 0.03)
  for (let i = 0; i < length && start + i < out.length; i += 1) {
    const decay = Math.exp(-i / (rate * 0.005))
    out[start + i] += gain * decay * (0.6 * Math.sin(2 * Math.PI * hz * i / rate) + 0.4 * random())
  }
}

/** Quarter-note clicks; optional softer off-beat eighths (hi-hat style). */
function clickTrack(bpm: number, seconds: number, options: { offset?: number; eighths?: number; accent?: number; rate?: number } = {}): Float32Array {
  const rate = options.rate ?? RATE
  const out = new Float32Array(Math.round(seconds * rate))
  const random = noise(Math.round(bpm * 10))
  const period = 60 / bpm
  let beat = 0
  for (let t = options.offset ?? 0; t < seconds; t += period, beat += 1) {
    addClick(out, t, beat % 4 === 0 ? options.accent ?? 0.8 : 0.8, rate, random)
    if (options.eighths) addClick(out, t + period / 2, options.eighths, rate, random, 6000)
  }
  return out
}

describe('tempo analysis', () => {
  it.each([90, 100, 120, 128, 140, 174])('finds %i BPM in a quarter-note click track', bpm => {
    const result = analyzeTempo([clickTrack(bpm, 20)], RATE)!
    expect(result.bpm).toBeCloseTo(bpm, 0)
    expect(result.confidence).toBeGreaterThan(0.5)
  })

  it('prefers the fundamental over half or double tempo for pure clicks', () => {
    expect(analyzeTempo([clickTrack(65, 30)], RATE)!.bpm).toBeCloseTo(65, 0)
    expect(analyzeTempo([clickTrack(190, 20)], RATE)!.bpm).toBeCloseTo(190, 0)
  })

  it('folds tempos outside 60–200 BPM by octaves', () => {
    expect(analyzeTempo([clickTrack(50, 40)], RATE)!.bpm).toBeCloseTo(100, 0)
    expect(analyzeTempo([clickTrack(240, 20)], RATE)!.bpm).toBeCloseTo(120, 0)
  })

  it('keeps the quarter-note tempo when softer off-beat eighths double the onset rate', () => {
    expect(analyzeTempo([clickTrack(100, 20, { eighths: 0.3 })], RATE)!.bpm).toBeCloseTo(100, 0)
    expect(analyzeTempo([clickTrack(85, 24, { eighths: 0.35, accent: 1 })], RATE)!.bpm).toBeCloseTo(85, 0)
  })

  it('locates the first beat', () => {
    const result = analyzeTempo([clickTrack(120, 12, { offset: 0.23 })], RATE)!
    expect(result.bpm).toBe(120)
    expect(Math.abs(result.firstBeatSeconds - 0.23)).toBeLessThan(0.02)
    expect(analyzeTempo([clickTrack(120, 12)], RATE)!.firstBeatSeconds).toBeLessThan(0.02)
  })

  it('works on stereo input at other sample rates', () => {
    const left = clickTrack(132, 15, { rate: 48000 }), right = left.map(value => value * 0.5)
    expect(analyzeTempo([left, right], 48000)!.bpm).toBe(132)
  })

  it('reports low confidence for noise and null for silence or very short audio', () => {
    const random = noise(7)
    const hiss = Float32Array.from({ length: RATE * 10 }, () => random() * 0.3)
    expect(analyzeTempo([hiss], RATE)!.confidence).toBeLessThan(0.25)
    expect(analyzeTempo([new Float32Array(RATE * 5)], RATE)).toBeNull()
    expect(analyzeTempo([clickTrack(120, 0.5)], RATE)).toBeNull()
  })

  it('limits long files to the analysis window and decimates before a worker sees them', () => {
    const prepared = prepareTempoSignal([new Float32Array(48000 * 400)], 48000)
    expect(prepared.sampleRate).toBe(12000)
    expect(prepared.signal.length).toBe(12000 * 360)
  })
})

describe('loop tempo estimation', () => {
  it('reads tempo hints from file names', () => {
    expect(tempoFromFilename('drums_120bpm.wav')).toBe(120)
    expect(tempoFromFilename('Funky Kit 92 BPM.aif')).toBe(92)
    expect(tempoFromFilename('bass_128_Am.wav')).toBe(128)
    expect(tempoFromFilename('BPM-140 hats.wav')).toBe(140)
    expect(tempoFromFilename('take 2.wav')).toBeNull()
    expect(tempoFromFilename('track_808_kick.wav')).toBeNull()
    expect(tempoFromFilename('song2024.wav')).toBeNull()
  })

  it('guesses whole-bar tempos from the length', () => {
    expect(loopTempoCandidates(2)).toEqual([{ bars: 1, bpm: 120 }])
    expect(loopTempoCandidates(8).map(item => item.bpm)).toEqual([120])
    expect(loopTempoCandidates(6).map(item => item.bpm)).toEqual([80, 160])
    expect(estimateLoopTempo('loop.wav', 6)).toEqual({ bpm: 160, source: 'length', bars: 4 })
    expect(estimateLoopTempo('loop 95bpm.wav', 6)).toEqual({ bpm: 95, source: 'filename' })
    expect(estimateLoopTempo('hit.wav', 0.2)).toBeNull()
  })
})

describe('import warp decision', () => {
  const analysis = (bpm: number, confidence = 0.7) => ({ bpm, confidence, firstBeatSeconds: 0 })

  it('auto-warps loops whose analysis agrees with a whole bar count, snapping to the exact length tempo', () => {
    expect(decideWarp({ name: 'groove.wav', durationSeconds: 4 * 60 / 98, analysis: analysis(97.6) })).toMatchObject({ enabled: true, sourceBpm: 98, source: 'length' })
    // Half-time analysis still lines up with a 1-bar 120 BPM loop (60 BPM is no bar-count candidate).
    expect(decideWarp({ name: 'groove.wav', durationSeconds: 2, analysis: analysis(61) })).toMatchObject({ enabled: true, sourceBpm: 120 })
    // Several bar counts fit: the one the analysis heard wins.
    expect(decideWarp({ name: 'groove.wav', durationSeconds: 6, analysis: analysis(80.5) })).toMatchObject({ enabled: true, sourceBpm: 80 })
  })

  it('trusts file names, and warps long files only when the beat is clear', () => {
    expect(decideWarp({ name: 'loop_90bpm.wav', durationSeconds: 5, analysis: null })).toMatchObject({ enabled: true, sourceBpm: 90, source: 'filename' })
    expect(decideWarp({ name: 'song 128bpm.wav', durationSeconds: 200, analysis: analysis(128, 0.1) })).toMatchObject({ enabled: true, sourceBpm: 128, source: 'filename' })
    expect(decideWarp({ name: 'song.wav', durationSeconds: 200, analysis: analysis(123.5, 0.4) })).toEqual({ enabled: true, sourceBpm: 123.5, confidence: 0.4, firstBeatSeconds: 0, source: 'analysis' })
    expect(decideWarp({ name: 'ambient.wav', durationSeconds: 200, analysis: analysis(97, 0.25) })).toEqual({ enabled: false, sourceBpm: 97, confidence: 0.25, firstBeatSeconds: 0, source: 'analysis' })
  })

  it('leaves unclear or one-shot material unwarped', () => {
    expect(decideWarp({ name: 'pad.wav', durationSeconds: 5.3, analysis: analysis(111) })).toMatchObject({ enabled: false })
    expect(decideWarp({ name: 'crash.wav', durationSeconds: 2, analysis: analysis(120, 0.05) })).toMatchObject({ enabled: false })
    expect(decideWarp({ name: 'kick.wav', durationSeconds: 0.4, analysis: null })).toBeNull()
    expect(decideWarp({ name: 'noise.wav', durationSeconds: 12, analysis: null })).toBeNull()
  })
})

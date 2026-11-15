import type { MetronomeLevel, MetronomeSoundId } from '../core/metronome'

/**
 * Procedural metronome strokes (no samples, no licensing): modal synthesis
 * (sums of exponentially decaying partials, with pitch glide for membranes)
 * plus short filtered noise for stick/hand contact. Deterministic: the same
 * sound, level and rate always render the same PCM, in both engines (the
 * native host receives this PCM over its control protocol).
 */

type Buffer = Float32Array<ArrayBuffer>

function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Mode {
  /** Hz; with `from`, the pitch glides from `from` to `freq` with time constant `glide` seconds. */
  freq: number
  amp: number
  /** Decay time constant, seconds. */
  decay: number
  from?: number
  glide?: number
  /** Second decay stage: amp*(fast*exp(-t/fastDecay) + (1-fast)*exp(-t/decay)). */
  fast?: number
  fastDecay?: number
  /** Start offset, seconds. */
  at?: number
  /** Beating partner detune, Hz. */
  beat?: number
}

function addModes(out: Buffer, rate: number, modes: readonly Mode[]): void {
  for (const mode of modes) {
    const start = Math.round((mode.at ?? 0) * rate)
    const voices = mode.beat ? [[-mode.beat / 2, 0.5], [mode.beat / 2, 0.5]] : [[0, 1]]
    for (const [detune, share] of voices) {
      let phase = 0
      for (let i = start; i < out.length; i += 1) {
        const t = (i - start) / rate
        const freq = (mode.from !== undefined && mode.glide ? mode.freq + (mode.from - mode.freq) * Math.exp(-t / mode.glide) : mode.freq) + detune
        if (freq >= rate * 0.45) break
        const fast = mode.fast ?? 0
        const env = fast ? fast * Math.exp(-t / (mode.fastDecay ?? 0.01)) + (1 - fast) * Math.exp(-t / mode.decay) : Math.exp(-t / mode.decay)
        if (env < 1e-5 && t > 0.01) break
        out[i] += mode.amp * share * env * Math.sin(phase)
        phase += 2 * Math.PI * freq / rate
      }
    }
  }
}

type FilterKind = 'bandpass' | 'highpass' | 'lowpass'
/** RBJ biquad, applied in place. */
function biquad(data: Buffer, rate: number, kind: FilterKind, freq: number, q: number): void {
  const w = 2 * Math.PI * Math.min(freq, rate * 0.45) / rate
  const cos = Math.cos(w), alpha = Math.sin(w) / (2 * q)
  let b0: number, b1: number, b2: number
  if (kind === 'bandpass') { b0 = alpha; b1 = 0; b2 = -alpha }
  else if (kind === 'highpass') { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2 }
  else { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2 }
  const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < data.length; i += 1) {
    const x = data[i]
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0
    x2 = x1; x1 = x; y2 = y1; y1 = y
    data[i] = y
  }
}

interface Noise { amp: number; decay: number; filter: FilterKind; freq: number; q?: number; at?: number; attack?: number }
function addNoise(out: Buffer, rate: number, random: () => number, noise: Noise): void {
  const start = Math.round((noise.at ?? 0) * rate)
  const length = Math.min(out.length - start, Math.ceil(noise.decay * 9 * rate))
  if (length <= 0) return
  const burst = new Float32Array(length)
  const attack = Math.max(1, Math.round((noise.attack ?? 0.0003) * rate))
  for (let i = 0; i < length; i += 1) burst[i] = (random() * 2 - 1) * Math.exp(-i / rate / noise.decay) * Math.min(1, (i + 1) / attack)
  biquad(burst, rate, noise.filter, noise.freq, noise.q ?? 0.8)
  if (noise.filter === 'bandpass') biquad(burst, rate, 'bandpass', noise.freq, noise.q ?? 0.8)
  for (let i = 0; i < length; i += 1) out[start + i] += noise.amp * burst[i]
}

interface Stroke { modes?: readonly Mode[]; noise?: readonly Noise[]; gain?: number }

/** Builds the stroke(s) of one level, finishing with a gentle tone filter. */
function render(rate: number, seconds: number, seed: number, strokes: readonly Stroke[], toneHz = 9000): Buffer {
  const out = new Float32Array(Math.ceil(seconds * rate))
  const random = rng(seed)
  for (const stroke of strokes) {
    const part = new Float32Array(out.length)
    if (stroke.modes) addModes(part, rate, stroke.modes)
    for (const noise of stroke.noise ?? []) addNoise(part, rate, random, noise)
    const gain = stroke.gain ?? 1
    for (let i = 0; i < out.length; i += 1) out[i] += gain * part[i]
  }
  biquad(out, rate, 'lowpass', toneHz, 0.6)
  biquad(out, rate, 'highpass', 35, 0.7)
  return out
}

// --- Instruments ---------------------------------------------------------

/** Membrane modes of an ideal circular drum head (ratios of Bessel zeros). */
const MEMBRANE = [1, 1.594, 2.136, 2.296, 2.653, 2.918] as const

function membrane(freq: number, amp: number, decay: number, options: { from?: number; glide?: number; count?: number; damping?: number } = {}): Mode[] {
  const count = options.count ?? 4, damping = options.damping ?? 1.6
  return MEMBRANE.slice(0, count).map((ratio, index) => ({
    freq: freq * ratio, amp: amp * [1, 0.5, 0.32, 0.22, 0.16, 0.1][index], decay: decay / Math.pow(ratio, damping),
    ...(options.from ? { from: options.from * ratio, glide: options.glide ?? 0.04 } : {}),
  }))
}

// 장구 궁편(왼쪽, 굵고 낮은 가죽): 궁굴채/손바닥의 둥근 저음.
const jangguKung = (amp: number): Stroke => ({
  modes: membrane(96, amp, 0.32, { from: 128, glide: 0.035, count: 4, damping: 1.9 }),
  noise: [{ amp: amp * 0.35, decay: 0.012, filter: 'lowpass', freq: 380, q: 0.7 }],
})
// 장구 채편(오른쪽, 얇고 팽팽한 가죽): 열채의 또렷한 '덕'.
const jangguDeok = (amp: number): Stroke => ({
  modes: [...membrane(352, amp * 0.75, 0.11, { from: 392, glide: 0.02, count: 5, damping: 1.4 }), { freq: 2150, amp: amp * 0.12, decay: 0.012 }],
  noise: [{ amp: amp * 0.9, decay: 0.0045, filter: 'bandpass', freq: 3300, q: 0.9 }],
})
// 소리북 궁(왼손 손바닥으로 가죽): 깊고 무거운 울림.
const bukGung = (amp: number): Stroke => ({
  modes: [...membrane(74, amp, 0.38, { from: 104, glide: 0.04, count: 3, damping: 2 }), { freq: 165, amp: amp * 0.18, decay: 0.07 }],
  noise: [{ amp: amp * 0.4, decay: 0.016, filter: 'lowpass', freq: 300, q: 0.7 }],
})
// 소리북 딱(북채로 나무 통): 둔탁하고 건조한 나무 소리.
const bukTtak = (amp: number): Stroke => ({
  modes: [
    { freq: 905, amp: amp, decay: 0.028 }, { freq: 2240, amp: amp * 0.38, decay: 0.011 },
    { freq: 3720, amp: amp * 0.14, decay: 0.006 }, { freq: 190, amp: amp * 0.22, decay: 0.04 },
  ],
  noise: [{ amp: amp * 0.45, decay: 0.003, filter: 'bandpass', freq: 2100, q: 0.8 }],
})
// 박: 여섯 장의 단단한 나무판이 거의 동시에 맞부딪는 '짝'.
const bakClap = (amp: number, slabs: number): Stroke[] => Array.from({ length: slabs }, (_, index) => ({
  gain: amp * [1, 0.72, 0.5, 0.36][index],
  modes: [
    { freq: 1180 * (1 + index * 0.031), amp: 0.55, decay: 0.022, at: index * 0.0007 },
    { freq: 1930 * (1 - index * 0.018), amp: 0.42, decay: 0.014, at: index * 0.0007 },
    { freq: 2960 * (1 + index * 0.012), amp: 0.28, decay: 0.009, at: index * 0.0007 },
    { freq: 4350, amp: 0.12, decay: 0.005, at: index * 0.0007 },
  ],
  noise: [{ amp: 0.95, decay: 0.0028, filter: 'bandpass', freq: 1750, q: 0.7, at: index * 0.0007 }],
}))
// 꽹과리: 놋쇠 징류의 비조화 배음. 열면 '갱', 손으로 막으면 '짓'.
const kkwaenggwari = (amp: number, sustain: number, muted: boolean): Stroke => {
  const partials: Array<[number, number]> = [[1, 1], [1.505, 0.72], [2.02, 0.55], [2.46, 0.42], [2.94, 0.3], [3.43, 0.2], [4.07, 0.12]]
  return {
    modes: partials.map(([ratio, level], index) => ({
      freq: 1010 * ratio, amp: amp * level * (muted ? Math.pow(0.7, index) : 1),
      decay: sustain / (1 + index * 0.45), fast: muted ? 0 : 0.45, fastDecay: 0.025, beat: 2.5 + index * 1.7,
    })),
    noise: [{ amp: amp * 0.35, decay: 0.003, filter: 'highpass', freq: 3200, q: 0.7 }],
  }
}
// 목탁: 속이 빈 나무의 맑은 '똑'.
const moktak = (amp: number): Stroke => ({
  modes: [
    { freq: 690, amp: amp, decay: 0.075, fast: 0.25, fastDecay: 0.012 }, { freq: 1752, amp: amp * 0.22, decay: 0.024 },
    { freq: 2930, amp: amp * 0.08, decay: 0.01 },
  ],
  noise: [{ amp: amp * 0.25, decay: 0.002, filter: 'bandpass', freq: 2900, q: 0.9 }],
})

function stroke(sound: MetronomeSoundId, level: MetronomeLevel, rate: number): Buffer {
  const seed = 1009 * (sound.length + 7) + level * 31
  switch (sound) {
    case 'beep': {
      const freq = [1760, 1318.5, 880][level]
      return render(rate, 0.09, seed, [{ modes: [{ freq, amp: 1, decay: 0.022, fast: 0, fastDecay: 0.01 }, { freq: freq * 2, amp: 0.08, decay: 0.01 }] }], 12000)
    }
    case 'woodblock': {
      const freq = [1180, 960, 960][level]
      return render(rate, 0.12, seed, [{
        modes: [{ freq, amp: 1, decay: 0.038 }, { freq: freq * 2.66, amp: 0.3, decay: 0.014 }, { freq: freq * 4.42, amp: 0.1, decay: 0.007 }],
        noise: [{ amp: 0.35, decay: 0.002, filter: 'bandpass', freq: 2600, q: 0.9 }],
      }])
    }
    case 'rim':
      return render(rate, 0.1, seed, [{
        modes: [{ freq: 470, amp: 0.45, decay: 0.022 }, { freq: [1720, 1650, 1650][level], amp: 0.6, decay: 0.012 }, { freq: 3380, amp: 0.32, decay: 0.006 }],
        noise: [{ amp: level === 0 ? 0.85 : 0.65, decay: 0.006, filter: 'highpass', freq: 1900, q: 0.7 }],
      }], 10000)
    case 'cowbell': {
      const decay = [0.16, 0.12, 0.07][level]
      return render(rate, 0.35, seed, [{
        modes: [[562, 1], [845, 0.8], [1350, 0.32], [1690, 0.28], [2350, 0.12]].map(([freq, amp], index) => ({ freq, amp, decay: decay / (1 + index * 0.4), fast: 0.6, fastDecay: 0.012 })),
        noise: [{ amp: 0.2, decay: 0.002, filter: 'bandpass', freq: 2600, q: 1 }],
      }], 7000)
    }
    case 'janggu':
      // 덩 = 궁편과 채편을 함께, 쿵 = 궁편, 덕 = 채편.
      if (level === 0) return render(rate, 0.5, seed, [jangguKung(1), jangguDeok(0.8)], 8000)
      if (level === 1) return render(rate, 0.45, seed, [jangguKung(1)], 6000)
      return render(rate, 0.2, seed, [jangguDeok(1)], 8000)
    case 'buk':
      if (level === 0) return render(rate, 0.55, seed, [bukGung(1), bukTtak(0.75)], 7000)
      if (level === 1) return render(rate, 0.5, seed, [bukGung(1)], 5000)
      return render(rate, 0.12, seed, [bukTtak(1)], 7000)
    case 'bak':
      return render(rate, 0.12, seed, bakClap(1, level === 2 ? 2 : level === 1 ? 3 : 4), 8500)
    case 'kkwaenggwari':
      if (level === 0) return render(rate, 0.48, seed, [kkwaenggwari(1, 0.32, false)], 7500)
      if (level === 1) return render(rate, 0.3, seed, [kkwaenggwari(1, 0.16, false)], 7000)
      return render(rate, 0.1, seed, [kkwaenggwari(1, 0.032, true)], 6000)
    case 'moktak':
      return render(rate, 0.2, seed, [moktak(1)], 8000)
  }
}

/** Loudness relative to the downbeat (before the user's volume). */
const LEVEL_GAIN: Record<MetronomeLevel, number> = { 0: 1, 1: 0.78, 2: 0.62 }
const TARGET_WEIGHTED_RMS = 0.16
const PEAK_CEILING = 0.89

/**
 * Crude loudness: high-passed (the ear hears little below ~200 Hz) RMS over the
 * 80 ms after the start, so a deep drum and a bright bell feel about as loud.
 */
function weightedRms(data: Buffer, rate: number): number {
  const weighted = data.slice(0, Math.min(data.length, Math.ceil(rate * 0.08)))
  biquad(weighted, rate, 'highpass', 220, 0.6)
  biquad(weighted, rate, 'lowpass', 6500, 0.6)
  let sum = 0
  for (const value of weighted) sum += value * value
  return Math.sqrt(sum / Math.max(1, weighted.length))
}

const cache = new Map<string, Buffer>()

/** Mono PCM of one stroke at `rate`, normalized for loudness; ends in silence (2 ms fade). */
export function metronomeStroke(sound: MetronomeSoundId, level: MetronomeLevel, rate: number): Buffer {
  const key = `${sound}:${level}:${rate}`
  const cached = cache.get(key)
  if (cached) return cached
  const data = stroke(sound, level, rate)
  const fade = Math.min(data.length, Math.ceil(rate * 0.002))
  for (let i = 0; i < fade; i += 1) data[data.length - 1 - i] *= i / fade
  const rms = weightedRms(data, rate)
  let peak = 0
  for (const value of data) peak = Math.max(peak, Math.abs(value))
  const gain = rms > 0 && peak > 0 ? Math.min(TARGET_WEIGHTED_RMS * LEVEL_GAIN[level] / rms, PEAK_CEILING * LEVEL_GAIN[level] / peak) : 0
  for (let i = 0; i < data.length; i += 1) data[i] = Math.fround(data[i] * gain)
  if (cache.size > 64) cache.clear()
  cache.set(key, data)
  return data
}

/** The three level strokes, with the accent preference applied (off = plain stroke everywhere). */
export function metronomeStrokes(sound: MetronomeSoundId, accent: boolean, rate: number): [Buffer, Buffer, Buffer] {
  const plain = metronomeStroke(sound, 2, rate)
  return accent ? [metronomeStroke(sound, 0, rate), metronomeStroke(sound, 1, rate), plain] : [plain, plain, plain]
}

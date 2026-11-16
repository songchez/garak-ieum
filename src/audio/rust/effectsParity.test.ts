import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { eqBandSections, filterSections, readEqBands, sectionCoefficients, type BiquadSection } from '../../devices/effects/eqModel'
import { reverbImpulse } from '../../devices/effects/reverb'
import { EFFECT_DEFS } from '../../devices/effects/registry'
import { createRustKernel } from './sigimsaeRust'
import { instantiateGarakWasm, type GarakWasm, type RustEffectType } from './garakWasm'

// Stage 3 moved the web EQ, filter, compressor, drive and reverb from built-in Web Audio nodes to the
// Rust kernels the desktop engine runs (docs/RUST.md). Node has no Web Audio, and the C++ engine is
// not part of `pnpm test`, so these compare the WASM effects with straight TypeScript transcriptions
// of the C++ reference (native/src/dsp.cpp, eq_effects.inc), which `garak-rust-parity-test` already
// proves bit-identical to the same Rust on Windows. Gate: residual <= -90 dBFS (relative to the
// signal for the reverb, whose impulse response is ~-58 dBFS).
const artifact = fileURLToPath(new URL('../../../public/wasm/garak-dsp.wasm', import.meta.url))
const built = existsSync(artifact)
const wasmModule: WebAssembly.Module | null = built ? new WebAssembly.Module(readFileSync(artifact)) : null
const dsp: GarakWasm | null = wasmModule ? instantiateGarakWasm(wasmModule) : null

const SR = 48_000
const GATE = 10 ** (-90 / 20)
const f32 = Math.fround
const dbToGain = (db: number) => Math.pow(10, db / 20)

function programme(frames: number, seed: number): [Float32Array, Float32Array] {
  const l = new Float32Array(frames), r = new Float32Array(frames)
  let s = seed >>> 0
  const rand = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s / 2 ** 32) * 2 - 1 }
  for (let i = 0; i < frames; i += 1) {
    const t = i / SR, env = (t % 0.4) < 0.25 ? Math.min(1, (t % 0.4) / 0.003) : Math.exp(-((t % 0.4) - 0.25) * 25)
    const tone = 0.4 * Math.sin(2 * Math.PI * (60 + 3000 * t) * t)
    l[i] = env * (0.5 * rand() + tone) * (t > 0.5 ? 1.6 : 0.5)
    r[i] = env * (0.5 * rand() - tone) * (t > 0.5 ? 1.6 : 0.5)
  }
  return [l, r]
}
const maxDiff = (a: Float32Array, b: Float32Array) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0)
const peak = (a: Float32Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0)

/** dsp.cpp Biquad::sample with coefficients from eqModel.sectionCoefficients (equal to Biquad::configure). */
class RefBiquad {
  private z1 = [0, 0]; private z2 = [0, 0]
  private readonly k: { b0: number; b1: number; b2: number; a1: number; a2: number }
  constructor(section: BiquadSection) { this.k = sectionCoefficients(section, SR) }
  sample(x: number, c: number): number {
    const { b0, b1, b2, a1, a2 } = this.k
    const y = b0 * x + this.z1[c]
    this.z1[c] = b1 * x - a1 * y + this.z2[c]; this.z2[c] = b2 * x - a2 * y
    if (Math.abs(this.z1[c]) < 1e-30) this.z1[c] = 0
    if (Math.abs(this.z2[c]) < 1e-30) this.z2[c] = 0
    return f32(y)
  }
}

/** eq_effects.inc BiquadChain: the stages in order, then the output gain. */
function refChain(sections: BiquadSection[], outputDb: number, l: Float32Array, r: Float32Array): void {
  const gain = dbToGain(outputDb)
  for (const section of sections) {
    const q = new RefBiquad(section)
    for (let i = 0; i < l.length; i += 1) { l[i] = q.sample(l[i], 0); r[i] = q.sample(r[i], 1) }
  }
  if (gain !== 1) for (let i = 0; i < l.length; i += 1) { l[i] = f32(l[i] * gain); r[i] = f32(r[i] * gain) }
}

/** dsp.cpp Compressor::process (6 dB knee), returning the per-block meter like DynamicsTap. */
function refCompressor(p: Record<string, number>, l: Float32Array, r: Float32Array): void {
  const strength = 1 - 1 / p.ratio
  const attack = Math.exp(-1 / (Math.max(0.00001, p.attack * 0.001) * SR)), release = Math.exp(-1 / (Math.max(0.00001, p.release * 0.001) * SR))
  const makeup = dbToGain(p.makeup), knee = 6
  let envelope = 0
  for (let i = 0; i < l.length; i += 1) {
    const level = Math.max(Math.abs(l[i]), Math.abs(r[i]))
    envelope = level + (level > envelope ? attack : release) * (envelope - level)
    const above = 20 * Math.log10(Math.max(1e-12, envelope)) - p.threshold
    const over = above < -knee / 2 ? 0 : above < knee / 2 ? (above + knee / 2) * (above + knee / 2) / (2 * knee) : above
    const gain = f32(dbToGain(-strength * over) * makeup)
    l[i] = f32(l[i] * gain); r[i] = f32(r[i] * gain)
  }
}

/** dsp.cpp Saturator (17-tap half-band 2x oversampling around tanh) + Drive. */
function refDrive(p: Record<string, number>, l: Float32Array, r: Float32Array): void {
  const amount = 2.5, normal = Math.tanh(amount)
  const taps: number[] = []
  for (let i = 0; i < 17; i += 1) {
    const x = i - 8
    taps.push((x === 0 ? 0.5 : Math.sin(Math.PI * 0.5 * x) / (Math.PI * x)) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / 16)))
  }
  const sum = taps.reduce((a, b) => a + b, 0)
  for (let i = 0; i < 17; i += 1) taps[i] /= sum
  const state = [0, 1, 2, 3].map(() => ({ data: new Array<number>(17).fill(0), write: 0 }))
  const fir = (x: number, s: { data: number[]; write: number }) => {
    s.data[s.write] = x
    let out = 0
    for (let i = 0; i < 17; i += 1) out += taps[i] * s.data[(s.write + 17 - i) % 17]
    s.write = (s.write + 1) % 17
    return out
  }
  const shape = (x: number) => Math.tanh(amount * Math.max(-1, Math.min(1, x))) / normal
  const saturate = (x: number, c: number) => {
    const up = state[c * 2], down = state[c * 2 + 1]
    const a = fir(shape(fir(2 * x, up)), down)
    fir(shape(fir(0, up)), down)
    return f32(a)
  }
  const pre = dbToGain(p.drive), wet = p.mix, output = dbToGain(p.output), post = output / Math.sqrt(pre * 2.53)
  const tone = new RefBiquad({ type: 'lowpass', freq: p.tone, q: 1, gain: 0 })
  const dry = [new Float32Array(l), new Float32Array(r)]
  for (let i = 0; i < l.length; i += 1) {
    for (const [c, s] of [[0, l], [1, r]] as const) {
      const shaped = tone.sample(saturate(f32(s[i] * pre), c), c)
      const delayed = i >= 8 ? dry[c][i - 8] : 0
      s[i] = f32(delayed * (1 - wet) * output + shaped * wet * post)
    }
  }
}

/** dsp.cpp impulse() normalisation over reverb.ts reverbImpulse, blended by size like the Reverb constructor. */
function refReverbIr(space: number, size: number): [Float32Array, Float32Array] {
  const normalised = (kind: 'short' | 'long') => {
    const channels = reverbImpulse(SR, space, kind)
    let power = 0
    for (const ch of channels) for (const v of ch) power += v * v
    const scale = f32(0.00125 / Math.max(0.000125, Math.sqrt(power / (channels[0].length * 2))) * 44100 / SR)
    return channels.map(ch => ch.map(v => f32(v * scale)))
  }
  const long = normalised('long'), short = normalised('short'), s = f32(size), rest = f32(1 - s)
  return long.map((ch, c) => ch.map((v, i) => f32(f32(v * s) + (i < short[c].length ? f32(short[c][i] * rest) : 0)))) as [Float32Array, Float32Array]
}

function render(type: RustEffectType, params: Record<string, number>, l: Float32Array, r: Float32Array, block = 128): void {
  const fx = dsp!.createEffect(type, SR, params, 120)!
  expect(fx, type).not.toBeNull()
  for (let offset = 0; offset < l.length; offset += block) {
    const n = Math.min(block, l.length - offset)
    fx.process(l.subarray(offset, offset + n), r.subarray(offset, offset + n), n)
  }
  fx.free()
}

const withDefaults = (type: 'compressor' | 'drive' | 'reverb' | 'filter' | 'eq', params: Record<string, number>) =>
  Object.fromEntries(EFFECT_DEFS[type].params.map(def => [def.id, params[def.id] ?? def.default]))

describe.skipIf(!built)('Rust EQ, filter, compressor, drive and reverb vs the C++ reference', () => {
  const report: Record<string, number> = {}
  const gate = (name: string, residual: number) => {
    report[name] = Math.max(report[name] ?? -Infinity, residual > 0 ? 20 * Math.log10(residual) : -Infinity)
    expect(residual, `${name} residual ${report[name].toFixed(1)} dBFS`).toBeLessThan(GATE)
  }

  it.each<Record<string, number>>([
    {},
    { low: 6, mid: -9, midFreq: 700, high: 4, output: -3 },
    { b1On: 1, b1Type: 4, b1Freq: 80, b1Q: 2, b1Slope: 3, b4On: 1, b4Type: 0, b4Freq: 3000, b4Gain: 12, b4Q: 6, b8On: 1, b8Type: 5, b8Freq: 12000, b8Slope: 2, output: 5 },
    { b2Type: 3, b5On: 1, b5Type: 2, b5Freq: 9000, b5Gain: -18, b6On: 1, b6Type: 1, b6Freq: 150, b6Gain: 8, b7On: 2, b7Type: 3, b7Freq: 400 },
  ])('eq %#: matches the eq_effects.inc stage chain', raw => {
    const params = withDefaults('eq', raw)
    const [l, r] = programme(24_000, 3)
    const rl = l.slice(), rr = r.slice()
    render('eq', params, l, r)
    const sections = readEqBands(id => params[id]).flatMap(band => eqBandSections(band, SR))
    refChain(sections, params.output, rl, rr)
    gate('eq', Math.max(maxDiff(l, rl), maxDiff(r, rr)))
  })

  it.each([[0, 1200, 0.7, 0], [1, 300, 6, 2], [2, 2500, 12, 1], [0, 18000, 0.1, 2]])('filter mode %d %d Hz q %d slope %d: matches the sweep chain', (mode, cutoff, resonance, slope) => {
    const params = withDefaults('filter', { mode, cutoff, resonance, slope })
    const [l, r] = programme(24_000, 5)
    const rl = l.slice(), rr = r.slice()
    render('filter', params, l, r, 77)
    refChain(filterSections(mode, cutoff, resonance, slope, SR), 0, rl, rr)
    gate('filter', Math.max(maxDiff(l, rl), maxDiff(r, rr)))
  })

  it.each<Record<string, number>>([{}, { threshold: -40, ratio: 20, attack: 0.1, release: 10, makeup: 18 }, { threshold: -6, ratio: 1.5, attack: 80, release: 900, makeup: 3 }])('compressor %#: matches dsp.cpp Compressor and meters', raw => {
    const params = withDefaults('compressor', raw)
    const [l, r] = programme(48_000, 7)
    const rl = l.slice(), rr = r.slice()
    const fx = dsp!.createEffect('compressor', SR, params, 120)!
    const meter = new Float32Array(2)
    let lowest = 1
    for (let offset = 0; offset < l.length; offset += 128) {
      fx.process(l.subarray(offset, offset + 128), r.subarray(offset, offset + 128), 128)
      if (fx.meter(meter)) lowest = Math.min(lowest, meter[1])
    }
    fx.free()
    refCompressor(params, rl, rr)
    gate('compressor', Math.max(maxDiff(l, rl), maxDiff(r, rr)))
    // The view's gain-reduction meter comes from the same detector.
    expect(lowest).toBeLessThan(params.threshold < -30 ? 0.5 : 1.0001)
  })

  it.each<Record<string, number>>([{}, { drive: 36, tone: 1500, mix: 0.4, output: -12 }, { drive: 0, tone: 20000, mix: 1, output: 6 }])('drive %#: matches dsp.cpp Drive (2x oversampling, 8 frames latency)', raw => {
    const params = withDefaults('drive', raw)
    const [l, r] = programme(24_000, 9)
    const rl = l.slice(), rr = r.slice()
    render('drive', params, l, r, 61)
    refDrive(params, rl, rr)
    gate('drive', Math.max(maxDiff(l, rl), maxDiff(r, rr)))
    const probe = dsp!.createEffect('drive', SR, params, 120)!
    expect(probe.latencyFrames()).toBe(8)
    probe.free()
  })

  it.each([[0, 0.35, 9000], [1, 1, 20000], [2, 0, 4000], [3, 0.6, 12000]])('reverb space %d size %d tone %d: impulse response equals reverb.ts reverbImpulse through the tone filter', (space, size, tone) => {
    const params = withDefaults('reverb', { type: space, size, tone, amount: 1, dry: 0, predelay: 0, lowcut: 20 })
    const [irL, irR] = refReverbIr(space, size)
    const frames = irL.length + 512
    const l = new Float32Array(frames), r = new Float32Array(frames)
    l[0] = 1; r[0] = 1
    render('reverb', params, l, r)
    const toneFilter = new RefBiquad({ type: 'lowpass', freq: tone, q: 1, gain: 0 })
    const rl = new Float32Array(frames), rr = new Float32Array(frames)
    for (let i = 0; i < frames; i += 1) {
      rl[i] = f32(0.5 * toneFilter.sample(irL[i] ?? 0, 0))
      rr[i] = f32(0.5 * toneFilter.sample(irR[i] ?? 0, 1))
    }
    gate('reverb (relative)', Math.max(maxDiff(l, rl), maxDiff(r, rr)) / peak(rl))
  })

  it('builds the same reverb from main-thread kernels (the worklet path) as from its own IR, and rebuilds without a gap', () => {
    const params = withDefaults('reverb', { type: 2, size: 0.8, predelay: 30, lowcut: 200, amount: 0.7, dry: 0.6 })
    const kernels = dsp!.buildReverbKernels(SR, 2, 0.8)!
    expect(kernels).toBeInstanceOf(Float32Array)
    const [l, r] = programme(24_000, 11)
    const a = [l.slice(), r.slice()], b = [l.slice(), r.slice()]
    render('reverb', params, a[0], a[1])
    const kernel = createRustKernel(wasmModule!, 'reverb', SR, params, 120, kernels)!
    for (let offset = 0; offset < l.length; offset += 128) {
      const n = Math.min(128, l.length - offset)
      kernel.process(b[0].subarray(offset, offset + n), b[1].subarray(offset, offset + n), n)
    }
    expect(maxDiff(a[0], b[0]) + maxDiff(a[1], b[1])).toBe(0)
    // A size edit swaps in a new impulse response and keeps the running tail (takeStateFrom).
    const tail = new Float32Array(4096), tailR = new Float32Array(4096)
    kernel.rebuild({ ...params, size: 0.2 }, 120, dsp!.buildReverbKernels(SR, 2, 0.2))
    kernel.process(tail, tailR, 4096)
    expect(peak(tail)).toBeGreaterThan(1e-4)
    kernel.free()
  })

  it('reports the residuals', () => {
    console.info(Object.entries(report).map(([k, v]) => `${k}: ${Number.isFinite(v) ? v.toFixed(1) : '-inf'} dBFS`).join('\n'))
    expect(Object.keys(report).length).toBe(5)
  })
})

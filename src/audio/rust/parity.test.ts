import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sectionCoefficients, type BiquadSection } from '../../devices/effects/eqModel'
import { Biquad, createKernel, kernelTailSeconds, UtilityKernel, type BiquadType } from '../../devices/effects/kernels'
import { KERNEL_DEFS, type KernelType } from '../../devices/effects/sigimsaeDefs'
import { createRustKernel } from './sigimsaeRust'
import { rustDspRequested, RUST_DSP_STORAGE_KEY } from './flag'
import { instantiateGarakWasm, loadGarakWasmModule, RUST_EFFECT, RUST_FILTER, type GarakWasm, type RustEffectType, type RustFilterType } from './garakWasm'

// Behavioural parity between the Rust kernels (rust/garak-dsp via WASM) and the existing TS kernels
// on identical input. The artifact comes from `pnpm rust:wasm`; without it the parity suite is
// skipped so web-only contributors never need Rust (CI's rust.yml always builds and runs it).
const artifact = fileURLToPath(new URL('../../../public/wasm/garak-dsp.wasm', import.meta.url))
const built = existsSync(artifact)
const wasmModule: WebAssembly.Module | null = built ? new WebAssembly.Module(readFileSync(artifact)) : null
const dsp: GarakWasm | null = wasmModule ? instantiateGarakWasm(wasmModule) : null

const SR = 48_000
function noise(frames: number, seed: number): Float32Array {
  const out = new Float32Array(frames)
  let s = seed >>> 0
  for (let i = 0; i < frames; i += 1) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; out[i] = (s / 2 ** 32) * 2 - 1 }
  return out
}
function maxDiff(a: Float32Array, b: Float32Array): number {
  let m = 0
  for (let i = 0; i < a.length; i += 1) m = Math.max(m, Math.abs(a[i] - b[i]))
  return m
}

describe.skipIf(!built)('Rust DSP parity (WASM vs TypeScript kernels)', () => {
  it('designs the same biquad coefficients as eqModel.sectionCoefficients for every filter type', () => {
    const types = Object.keys(RUST_FILTER) as RustFilterType[]
    for (const type of types) {
      for (const freq of [20, 120, 1000, 6000, 19_000, 30_000]) {
        for (const q of type === 'lowpass' || type === 'highpass' ? [-12, 0, 3, 18] : [0.1, 0.707, 4, 30]) {
          for (const gain of [-18, 0, 9]) {
            const ts = sectionCoefficients({ type, freq, q, gain } as BiquadSection, SR)
            const rs = dsp!.designBiquad(type, SR, freq, q, gain)
            for (const k of ['b0', 'b1', 'b2', 'a1', 'a2'] as const) {
              expect(Math.abs(rs[k] - ts[k]), `${type} ${freq} Hz q ${q} gain ${gain} ${k}`).toBeLessThan(1e-9 * Math.max(1, Math.abs(ts[k])))
            }
          }
        }
      }
    }
  })

  it('filters audio like the worklet Biquad, including the coefficient glide after a retarget', () => {
    for (const type of ['lowpass', 'highpass', 'lowshelf'] as BiquadType[]) {
      const frames = 9600
      const inL = noise(frames, 1), inR = noise(frames, 2)
      const ts = new Biquad(SR)
      const tsL = new Float32Array(frames), tsR = new Float32Array(frames)
      const rsL = inL.slice(), rsR = inR.slice()
      const rust = dsp!.createBiquad()!
      ts.configure(type, 800, 2, 6, true)
      rust.configure(type, SR, 800, 2, 6)
      const half = frames / 2
      for (let i = 0; i < half; i += 1) { tsL[i] = ts.sample(inL[i], 0); tsR[i] = ts.sample(inR[i], 1) }
      rust.process(rsL.subarray(0, half), rsR.subarray(0, half))
      ts.configure(type, 5000, 0.5, -4, false)
      rust.retarget(type, SR, 5000, 0.5, -4)
      for (let i = half; i < frames; i += 1) { tsL[i] = ts.sample(inL[i], 0); tsR[i] = ts.sample(inR[i], 1) }
      rust.process(rsL.subarray(half), rsR.subarray(half))
      rust.free()
      expect(maxDiff(tsL, rsL), type).toBeLessThan(1e-5)
      expect(maxDiff(tsR, rsR), type).toBeLessThan(1e-5)
    }
  })

  it('matches UtilityKernel (gain, balance, width, mono, polarity) through a parameter glide', () => {
    const cases: [Record<string, number>, Record<string, number>][] = [
      [{ gain: -6, pan: 0.4, width: 1.6 }, { gain: 3, pan: -0.8, width: 0.2, phase: 2 }],
      [{ mono: 1, phase: 1 }, { mono: 0, width: 2, pan: 1, gain: -36 }],
    ]
    for (const [first, second] of cases) {
      const frames = 4800 // > maxFrames, exercises chunking
      const l = noise(frames, 3), r = noise(frames, 4)
      const tsL = l.slice(), tsR = r.slice(), rsL = l.slice(), rsR = r.slice()
      const ts = new UtilityKernel(SR)
      const rust = dsp!.createUtility(SR)!
      ts.configure(first, 120); rust.configure(first)
      ts.process(tsL.subarray(0, 1000), tsR.subarray(0, 1000), 1000); rust.process(rsL.subarray(0, 1000), rsR.subarray(0, 1000))
      ts.configure(second, 120); rust.configure(second)
      ts.process(tsL.subarray(1000), tsR.subarray(1000), frames - 1000); rust.process(rsL.subarray(1000), rsR.subarray(1000))
      rust.free()
      expect(maxDiff(tsL, rsL)).toBeLessThan(1e-6)
      expect(maxDiff(tsR, rsR)).toBeLessThan(1e-6)
    }
  })

  // Every kernels.ts kernel against the Rust effect behind the worklet adapter (sigimsaeRust.ts):
  // random parameter sets, configure() changes with tempo changes mid-stream (incl. the delay's
  // mode switch), resets, odd block sizes. Gate: residual <= -90 dBFS, identical meters and tails.
  const KERNEL_LIST: KernelType[] = ['delay', 'chorus', 'phaser', 'flanger', 'tremolo', 'limiter', 'gate', 'tape', 'bitcrusher', 'utility']
  const report: Record<string, number> = {}
  function programme(frames: number, seed: number): [Float32Array, Float32Array] {
    const l = noise(frames, seed), r = noise(frames, seed + 1)
    for (let i = 0; i < frames; i += 1) {
      const t = i / SR, cycle = t % 0.5
      const env = cycle < 0.2 ? Math.min(1, cycle / 0.004) : cycle < 0.3 ? Math.exp(-(cycle - 0.2) * 30) : 0
      const gain = t > 0.6 && t < 0.8 ? 1.7 : 0.6
      const tone = 0.3 * Math.sin(2 * Math.PI * (100 + 2000 * t) * t)
      l[i] = env * gain * (0.6 * l[i] + tone) + (i % 7919 === 0 ? 0.9 : 0)
      r[i] = env * gain * (0.6 * r[i] - tone)
    }
    return [l, r]
  }
  function randomParams(type: KernelType, rng: () => number): Record<string, number> {
    const out: Record<string, number> = {}
    for (const def of KERNEL_DEFS[type].params) if (rng() < 0.75) out[def.id] = def.min + (def.max - def.min) * rng()
    return out
  }

  it.each(KERNEL_LIST)('%s: WASM effect matches the TS kernel (configure, tempo, reset, meter, tail)', type => {
    let worst = 0
    for (let seed = 1; seed <= 4; seed += 1) {
      let s = seed * 104729
      const rng = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 }
      const frames = 48_000
      const [inL, inR] = programme(frames, seed)
      const tsL = inL.slice(), tsR = inR.slice(), rsL = inL.slice(), rsR = inR.slice()
      let params = seed === 1 ? {} : randomParams(type, rng)
      let bpm = 80 + 100 * rng()
      const ts = createKernel(type, SR, params, bpm)
      // One instance per kernel, as one per worklet node (slots are per instance).
      const rust = createRustKernel(wasmModule!, type, SR, params, bpm)!
      expect(rust).not.toBeNull()
      if (seed === 1) {
        // Tail at construction equals kernelTailSeconds (the export tail allowance).
        const probe = dsp!.createEffect(type, SR, params, bpm)!
        expect(Math.abs(probe.tailSeconds() - kernelTailSeconds(type, params, bpm))).toBeLessThan(1e-9)
        probe.free()
      }
      const meterTs = new Float32Array(2), meterRs = new Float32Array(2)
      for (let offset = 0, block = 0; offset < frames; block += 1) {
        const n = Math.min(frames - offset, block % 5 === 0 ? 1 + Math.floor(rng() * 300) : 128)
        if (block % 23 === 11) {
          params = rng() < 0.3 ? {} : { ...params, ...randomParams(type, rng) }
          if (rng() < 0.5) bpm = 60 + 140 * rng()
          ts.configure(params, bpm); rust.configure(params, bpm)
        }
        if (block === 200) { ts.reset(); rust.reset() }
        ts.process(tsL.subarray(offset, offset + n), tsR.subarray(offset, offset + n), n)
        rust.process(rsL.subarray(offset, offset + n), rsR.subarray(offset, offset + n), n)
        if (ts.meter) {
          ts.meter(meterTs); rust.meter!(meterRs)
          expect(Math.abs(meterTs[0] - meterRs[0]) + Math.abs(meterTs[1] - meterRs[1]), `${type} meter`).toBeLessThan(1e-5)
        }
        offset += n
      }
      worst = Math.max(worst, maxDiff(tsL, rsL), maxDiff(tsR, rsR))
      expect(rsL.every(Number.isFinite) && rsR.every(Number.isFinite)).toBe(true)
    }
    report[type] = worst > 0 ? 20 * Math.log10(worst) : -Infinity
    expect(worst, `${type} residual ${report[type].toFixed(1)} dBFS`).toBeLessThan(10 ** (-90 / 20))
  })

  it('reports the per-kernel residuals', () => {
    // Printed for docs/RUST.md; `it.each` above enforces the gate.
    console.info(Object.entries(report).map(([k, v]) => `${k}: ${Number.isFinite(v) ? v.toFixed(1) : '-inf'} dBFS`).join('\n'))
    expect(Object.keys(report).length).toBe(KERNEL_LIST.length)
  })

  it('builds every native effect (EQ, filter, compressor, drive, reverb too) and grows memory only on create', () => {
    const before = dsp!.heapBytes().used
    for (const type of Object.keys(RUST_EFFECT) as RustEffectType[]) {
      const fx = dsp!.createEffect(type, SR, {}, 120)!
      expect(fx, type).not.toBeNull()
      expect(fx.params.length).toBeGreaterThan(0)
      const l = noise(1024, 9), r = noise(1024, 10)
      fx.process(l, r)
      fx.configure({ [fx.params[0].id]: fx.params[0].max }, 140)
      fx.process(l, r)
      expect(l.every(Number.isFinite) && r.every(Number.isFinite), type).toBe(true)
      expect(fx.latencyFrames()).toBe(type === 'drive' ? 8 : 0)
      fx.free()
    }
    expect(dsp!.heapBytes().used).toBe(before)
  })

  it('bounds kernel slots per instance instead of allocating', () => {
    const taken = Array.from({ length: dsp!.maxSlots }, () => dsp!.createBiquad())
    expect(taken.every(Boolean)).toBe(true)
    expect(dsp!.createBiquad()).toBeNull()
    taken.forEach(k => k!.free())
    expect(dsp!.dbToGain(-20)).toBeCloseTo(0.1, 12)
  })
})

describe('Rust DSP loader fallbacks', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('is off unless explicitly requested', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null })
    expect(rustDspRequested()).toBe(false)
    store.set(RUST_DSP_STORAGE_KEY, '1')
    expect(rustDspRequested()).toBe(true)
  })

  it('resolves to null when the artifact was not built, so the TS kernels stay in use', async () => {
    const missing = vi.fn(async () => new Response('', { status: 404 }))
    await expect(loadGarakWasmModule('/', missing as unknown as typeof fetch)).resolves.toBeNull()
    const broken = vi.fn(async () => new Response(new Uint8Array([0, 1, 2, 3])))
    await expect(loadGarakWasmModule('/', broken as unknown as typeof fetch)).resolves.toBeNull()
  })

  it.skipIf(!built)('compiles and ABI-checks the built artifact', async () => {
    const ok = vi.fn(async (_url: string) => new Response(readFileSync(artifact)))
    const module = await loadGarakWasmModule('/', ok as unknown as typeof fetch)
    expect(module).toBeInstanceOf(WebAssembly.Module)
    expect(String(ok.mock.calls[0]?.[0])).toMatch(/\/wasm\/garak-dsp\.wasm$/)
  })
})

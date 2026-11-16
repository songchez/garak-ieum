import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createKernel, type SigimsaeKernel } from '../../devices/effects/kernels'
import { KERNEL_DEFS, type KernelType } from '../../devices/effects/sigimsaeDefs'
import { instantiateGarakWasm, type RustEffectType } from './garakWasm'

// Worklet CPU baseline: the TS kernels vs the Rust kernels in WASM, both driven exactly like the
// AudioWorklet drives them (planar 128-frame blocks, 48 kHz). Opt-in, prints a Markdown table:
//   pnpm rust:wasm && GARAK_WASM_BENCH=1 pnpm exec vitest run src/audio/rust/bench.test.ts
// Optional GARAK_WASM_BENCH_SECONDS (audio seconds per kernel and backend, default 20).
const artifact = fileURLToPath(new URL('../../../public/wasm/garak-dsp.wasm', import.meta.url))
const enabled = !!process.env.GARAK_WASM_BENCH && existsSync(artifact)

const SR = 48_000
const BLOCK = 128
const ROUNDS = 5
// Busy settings, like native/tests/rust_bench.cpp.
const PARAMS: Partial<Record<KernelType, Record<string, number>>> = {
  tremolo: { shape: 0.5, pan: 1 }, limiter: { gain: 12 }, gate: { threshold: -20 },
  utility: { width: 1.4, pan: 0.3 }, delay: { age: 0.5, lowcut: 200, mode: 1 },
}

function framesPerSecond(kernel: Pick<SigimsaeKernel, 'process'>, frames: number, inL: Float32Array, inR: Float32Array): number {
  const l = new Float32Array(BLOCK), r = new Float32Array(BLOCK)
  const run = (total: number) => {
    let sink = 0
    for (let done = 0; done < total; done += BLOCK) {
      const at = done % (inL.length - BLOCK)
      l.set(inL.subarray(at, at + BLOCK)); r.set(inR.subarray(at, at + BLOCK))
      kernel.process(l, r, BLOCK)
      sink += l[0]
    }
    return sink
  }
  run(SR) // warm-up: JIT tiers, caches
  const start = performance.now()
  const sink = run(frames)
  const seconds = (performance.now() - start) / 1000
  expect(Number.isFinite(sink)).toBe(true)
  return frames / Math.max(seconds, 1e-9)
}

describe.skipIf(!enabled)('worklet CPU: TS kernels vs Rust WASM', () => {
  it('prints frames/s per kernel', () => {
    const dsp = instantiateGarakWasm(new WebAssembly.Module(readFileSync(artifact)))
    const seconds = Number(process.env.GARAK_WASM_BENCH_SECONDS ?? 20)
    const frames = Math.round((SR * seconds) / ROUNDS / BLOCK) * BLOCK
    const inL = new Float32Array(SR), inR = new Float32Array(SR)
    let s = 1
    for (let i = 0; i < SR; i += 1) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0; inL[i] = ((s / 2 ** 32) * 2 - 1) * 0.5
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0; inR[i] = ((s / 2 ** 32) * 2 - 1) * 0.5
    }
    const rows = [`${seconds} s of 48 kHz stereo per backend (best of ${ROUNDS} alternating rounds), planar ${BLOCK}-frame blocks, Node ${process.versions.node}.`, '',
      '| kernel | TS (Mframes/s) | Rust WASM (Mframes/s) | WASM / TS |', '|---|---:|---:|---:|']
    for (const type of Object.keys(KERNEL_DEFS) as KernelType[]) {
      const params = PARAMS[type] ?? {}
      let ts = 0, rust = 0
      for (let round = 0; round < ROUNDS; round += 1) {
        ts = Math.max(ts, framesPerSecond(createKernel(type, SR, params), frames, inL, inR))
        // The same RustEffect the worklet adapter (sigimsaeRust.ts) wraps; freed so slots recycle.
        const effect = dsp.createEffect(type, SR, params)
        expect(effect, type).not.toBeNull()
        rust = Math.max(rust, framesPerSecond(effect!, frames, inL, inR))
        effect!.free()
      }
      rows.push(`| ${type} | ${(ts / 1e6).toFixed(2)} | ${(rust / 1e6).toFixed(2)} | ${(rust / ts).toFixed(2)} |`)
    }
    // Rust-only on the web (they replaced built-in Web Audio nodes, which run natively and cannot be timed here).
    const busy: Partial<Record<RustEffectType, Record<string, number>>> = {
      eq: { b4On: 1, b5On: 1, b6On: 1, b7On: 1, b8On: 1, b1Slope: 3 }, filter: { slope: 2 }, reverb: { size: 1, lowcut: 200 },
    }
    for (const type of ['eq', 'filter', 'compressor', 'drive', 'reverb'] as RustEffectType[]) {
      let rust = 0
      for (let round = 0; round < ROUNDS; round += 1) {
        const effect = dsp.createEffect(type, SR, busy[type] ?? {})!
        expect(effect, type).not.toBeNull()
        rust = Math.max(rust, framesPerSecond(effect, frames, inL, inR))
        effect.free()
      }
      rows.push(`| ${type} | (Web Audio node) | ${(rust / 1e6).toFixed(2)} | — |`)
    }
    console.log(rows.join('\n'))
  }, 600_000)
})

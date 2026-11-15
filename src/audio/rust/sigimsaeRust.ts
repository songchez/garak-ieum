import type { SigimsaeKernel } from '../../devices/effects/kernels.js'
import type { KernelType } from '../../devices/effects/sigimsaeDefs.js'
import { instantiateGarakWasm, type GarakWasm, type RustEffect } from './garakWasm.js'

/**
 * Worklet-side adapter: a Rust/WASM effect behind the `SigimsaeKernel` interface of kernels.ts, so
 * sigimsae.worklet.ts can swap kernels without other changes. Used only when the main thread passed
 * a compiled module in `processorOptions.garakWasm` (off by default, see ./flag.ts); any failure
 * returns null and the worklet keeps the TypeScript kernel.
 *
 * Semantics match the TS kernels: the first configuration applies immediately, later `configure()`
 * calls re-read every parameter and glide. The delay's stereo / ping-pong mode is fixed per Rust
 * effect (as in the native engine), so a mode change builds a new effect that takes over the old
 * one's audio history (`takeStateFrom`), which renders exactly like the TS kernel's live switch.
 */

/** Kernels whose device views show input level and gain reduction (sigimsae.ts METERED). */
const METERED = new Set<KernelType>(['limiter', 'gate'])

export function createRustKernel(source: WebAssembly.Module | GarakWasm, type: KernelType, sampleRate: number,
  params?: Record<string, number>, bpm = 120): SigimsaeKernel | null {
  let dsp: GarakWasm
  try { dsp = source instanceof WebAssembly.Module ? instantiateGarakWasm(source) : source } catch { return null }
  const first = dsp.createEffect(type, sampleRate, params, bpm)
  if (!first) return null
  let effect: RustEffect = first
  const modeOf = (p: Record<string, number> | undefined) => (p?.mode ?? 0) >= 0.5
  let pingPong = type === 'delay' && modeOf(params)
  const kernel: SigimsaeKernel = {
    configure(next, tempo) {
      if (type === 'delay' && modeOf(next) !== pingPong) {
        const rebuilt: RustEffect | null = dsp.createEffect(type, sampleRate, next, tempo)
        if (rebuilt) {
          rebuilt.takeStateFrom(effect)
          effect.free()
          effect = rebuilt
          pingPong = !pingPong
          return
        }
      }
      effect.configure(next, tempo)
    },
    process(left, right, frames) { effect.process(left, right, frames) },
    reset() { effect.reset() },
  }
  if (METERED.has(type)) kernel.meter = out => { if (!effect.meter(out)) { out[0] = 0; out[1] = 1 } }
  return kernel
}

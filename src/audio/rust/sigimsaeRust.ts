import type { SigimsaeKernel } from '../../devices/effects/kernels.js'
import { instantiateGarakWasm, type GarakWasm, type RustEffect, type RustEffectType } from './garakWasm.js'

/**
 * Worklet-side adapter: a Rust/WASM effect behind the `SigimsaeKernel` interface of kernels.ts, so
 * sigimsae.worklet.ts can swap kernels without other changes. Used whenever the main thread passed
 * a compiled module in `processorOptions.garakWasm` (the default, see ./flag.ts); any failure
 * returns null and the worklet keeps the TypeScript kernel (or, for the effects that only exist in
 * Rust on this path, passes audio through).
 *
 * Semantics match the TS kernels and the native engine: the first configuration applies
 * immediately, later `configure()` calls re-read every parameter and glide (`automate`). Parameters
 * the Rust effect fixes at construction (the delay's stereo / ping-pong mode; the reverb's space,
 * size and pre-delay, which shape its impulse response) take a rebuild that adopts the old
 * effect's audio history (`takeStateFrom`), as the native engine does on a parameter edit. The
 * delay rebuilds inside `configure()` (cheap); the reverb rebuilds on `rebuild()` with kernels the
 * main thread prepared, so no IR synthesis runs on the audio thread. Automation of those reverb
 * parameters does not rebuild, exactly like the native engine's automation lanes.
 */

/** Effects whose device views show input level and gain reduction (sigimsae.ts METERED). */
const METERED = new Set<RustEffectType>(['limiter', 'gate', 'compressor'])

export interface RustSigimsaeKernel extends SigimsaeKernel {
  /** Reverb: rebuild with kernels from `GarakWasm.buildReverbKernels` for the new space / size. */
  rebuild(params: Record<string, number> | undefined, bpm: number, reverbKernels?: Float32Array | null): void
  latencyFrames(): number
  /** Returns the effect's slot to its instance (the node was disposed). */
  free(): void
}

/**
 * One AudioWorkletGlobalScope (one audio context) runs every processor on the same thread, so the
 * nodes share wasm instances instead of instantiating ~1 MiB each: a new instance is only made
 * when the existing ones have no free slot (32 per effect kind) or cannot grow.
 */
const instances = new WeakMap<WebAssembly.Module, GarakWasm[]>()

function createShared(module: WebAssembly.Module, create: (dsp: GarakWasm) => RustEffect | null): [GarakWasm, RustEffect] | null {
  let pool = instances.get(module)
  if (!pool) instances.set(module, pool = [])
  for (const dsp of pool) {
    const effect = create(dsp)
    if (effect) return [dsp, effect]
  }
  let dsp: GarakWasm
  try { dsp = instantiateGarakWasm(module) } catch { return null }
  const effect = create(dsp)
  if (!effect) return null
  pool.push(dsp)
  return [dsp, effect]
}

export function createRustKernel(source: WebAssembly.Module | GarakWasm, type: RustEffectType, sampleRate: number,
  params?: Record<string, number>, bpm = 120, reverbKernels?: Float32Array | null): RustSigimsaeKernel | null {
  const build = (dsp: GarakWasm) => dsp.createEffect(type, sampleRate, params, bpm, reverbKernels)
  let created: [GarakWasm, RustEffect] | null
  if (source instanceof WebAssembly.Module) created = createShared(source, build)
  else { const effect = build(source); created = effect ? [source, effect] : null }
  if (!created) return null
  const dsp = created[0]
  let effect: RustEffect = created[1]
  const modeOf = (p: Record<string, number> | undefined) => (p?.mode ?? 0) >= 0.5
  let pingPong = type === 'delay' && modeOf(params)
  let freed = false
  // Rebuilt in the same instance, since takeStateFrom works within one instance only.
  const replace = (next: Record<string, number> | undefined, tempo: number, kernels?: Float32Array | null) => {
    const rebuilt = dsp.createEffect(type, sampleRate, next, tempo, kernels)
    if (!rebuilt) return false
    rebuilt.takeStateFrom(effect)
    effect.free()
    effect = rebuilt
    return true
  }
  const kernel: RustSigimsaeKernel = {
    configure(next, tempo) {
      if (freed) return
      if (type === 'delay' && modeOf(next) !== pingPong && replace(next, tempo)) { pingPong = !pingPong; return }
      effect.configure(next, tempo)
    },
    rebuild(next, tempo, kernels) {
      if (freed) return
      // Without kernels (or memory for a second reverb) keep the current impulse response.
      if (type !== 'reverb' || !kernels || !replace(next, tempo, kernels)) effect.configure(next, tempo)
    },
    process(left, right, frames) { if (!freed) effect.process(left, right, frames) },
    reset() { if (!freed) effect.reset() },
    latencyFrames: () => freed ? 0 : effect.latencyFrames(),
    // The slot may be reused by another node right away: nothing touches it after this.
    free() { if (!freed) { freed = true; effect.free() } },
  }
  if (METERED.has(type)) kernel.meter = out => { if (freed || !effect.meter(out)) { out[0] = 0; out[1] = 1 } }
  return kernel
}

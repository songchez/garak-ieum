import { instantiateGarakWasm, type GarakWasm, type RustGuitarRig } from './garakWasm.js'

/**
 * Worklet-side adapter for the guitar rig on the Rust core (docs/RUST.md, "기타 랙"): the same garak-dsp
 * rig the desktop engine runs, so web and desktop sound the same. Used by the `garak-guitar-rig-v1`
 * processor (src/devices/guitar-rig/processors.worklet.ts) whenever the main thread passed a module that
 * has the rig exports; otherwise the main thread keeps the Web Audio rig (src/devices/guitar-rig/index.ts).
 *
 * Semantics follow the native engine: knobs and automation re-read every parameter in place and glide
 * (`configure`); the rack layout and each reverb's Decay / switch shape the rig, so a direct edit of those
 * builds a new rig that adopts the old one's state module by module (`rebuild`, with plate kernels the main
 * thread prepared, so no impulse synthesis runs on the audio thread). Automation never rebuilds, as on desktop.
 */
export interface RustRigKernel {
  configure(params: Record<string, number> | undefined): void
  /** Structural edit: a new rig (kernels from `GarakWasm.buildReverbKernels(rate, 0, decay)` per reverb copy). */
  rebuild(params: Record<string, number> | undefined, kernels?: readonly (Float32Array | null)[] | null): void
  /** Planar stereo in place; `tap` receives the mono signal at the tuner's rack position. */
  process(left: Float32Array, right: Float32Array, frames: number, tap?: Float32Array): void
  reset(): void
  latencyFrames(): number
  tailSeconds(): number
  /** Returns the rig's slot to its instance (the node was disposed). */
  free(): void
}

/**
 * Nodes of one audio context run on the same thread, so they share wasm instances; a new instance is only
 * made when the existing ones have no free rig slot (16 each) or cannot grow.
 */
const instances = new WeakMap<WebAssembly.Module, GarakWasm[]>()

function createShared(module: WebAssembly.Module, create: (dsp: GarakWasm) => RustGuitarRig | null): [GarakWasm, RustGuitarRig] | null {
  let pool = instances.get(module)
  if (!pool) instances.set(module, pool = [])
  for (const dsp of pool) {
    const rig = create(dsp)
    if (rig) return [dsp, rig]
  }
  let dsp: GarakWasm
  try { dsp = instantiateGarakWasm(module) } catch { return null }
  if (!dsp.hasGuitarRig()) return null
  const rig = create(dsp)
  if (!rig) return null
  pool.push(dsp)
  return [dsp, rig]
}

export function createRustRigKernel(source: WebAssembly.Module | GarakWasm, sampleRate: number, params?: Record<string, number>,
  kernels?: readonly (Float32Array | null)[] | null): RustRigKernel | null {
  const build = (dsp: GarakWasm, p: Record<string, number> | undefined, k?: readonly (Float32Array | null)[] | null) => dsp.createGuitarRig(sampleRate, p, k)
  let created: [GarakWasm, RustGuitarRig] | null
  if (source instanceof WebAssembly.Module) created = createShared(source, dsp => build(dsp, params, kernels))
  else { const rig = source.hasGuitarRig() ? build(source, params, kernels) : null; created = rig ? [source, rig] : null }
  if (!created) return null
  const dsp = created[0]
  let rig = created[1]
  let freed = false
  return {
    configure(next) { if (!freed) rig.configure(next) },
    rebuild(next, prepared) {
      if (freed) return
      // In the same instance: takeStateFrom works within one instance only. Without memory for a second
      // rig, keep the current structure and just follow the knobs.
      const rebuilt = build(dsp, next, prepared)
      if (!rebuilt) { rig.configure(next); return }
      rebuilt.takeStateFrom(rig)
      rig.free()
      rig = rebuilt
    },
    process(left, right, frames, tap) { if (!freed) rig.process(left, right, frames, tap) },
    reset() { if (!freed) rig.reset() },
    latencyFrames: () => freed ? 0 : rig.latencyFrames(),
    tailSeconds: () => freed ? 0 : rig.tailSeconds(),
    // The slot may be reused by another node right away: nothing touches it after this.
    free() { if (!freed) { freed = true; rig.free() } },
  }
}

/**
 * The parameters that shape a rig (garak-dsp `fx::guitar`, dsp.cpp `liveEffectParameter`): the rack slots
 * and every reverb copy's Decay and switch. Edits to them rebuild; everything else glides in place.
 */
export function rigStructureKey(params: Readonly<Record<string, number>>, defs: readonly { id: string; default: number; min: number; max: number }[]): string {
  const parts: number[] = []
  for (const def of defs) {
    if (!/^(rackSlot\d+|reverbDecay(_\d)?|reverbEnabled(_\d)?)$/.test(def.id)) continue
    const value = params[def.id]
    parts.push(Math.min(def.max, Math.max(def.min, typeof value === 'number' && Number.isFinite(value) ? value : def.default)))
  }
  return parts.join(',')
}

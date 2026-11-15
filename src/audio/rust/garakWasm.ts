/**
 * Loader for the Rust DSP core compiled to WebAssembly (rust/garak-wasm, docs/RUST.md).
 *
 * Worklet-friendly by construction: no `fetch`, `TextDecoder`, DOM or wasm-bindgen glue here, so
 * this module can be bundled into an AudioWorklet. The intended flow:
 *   main thread:  const module = await loadGarakWasmModule()      // null -> keep the TS kernels
 *                 new AudioWorkletNode(ctx, name, { processorOptions: { garakWasm: module } })
 *   worklet:      const dsp = instantiateGarakWasm(options.processorOptions.garakWasm)
 * `WebAssembly.Module` is structured-cloneable, and the module is ~25 KiB, so synchronous
 * instantiation inside the worklet is fine. The module has no allocator: its memory never grows,
 * so the Float32Array views below stay valid for the instance's lifetime.
 *
 * Nothing uses this by default yet; see `rustDspRequested()` in ./flag.ts.
 */

export const GARAK_WASM_ABI = 1
/** Served by Vite from public/ once `pnpm rust:wasm` has run (never committed). */
export const GARAK_WASM_PATH = 'wasm/garak-dsp.wasm'

/** Same order as `garak::dsp::Filter` and Rust `FilterType`. */
export const RUST_FILTER = {
  lowpass: 0, highpass: 1, bandpass: 2, peaking: 3, lowshelf: 4, highshelf: 5, notch: 6,
} as const
export type RustFilterType = keyof typeof RUST_FILTER

interface Exports {
  memory: WebAssembly.Memory
  garak_abi_version(): number
  garak_max_frames(): number
  garak_max_slots(): number
  garak_left_ptr(): number
  garak_right_ptr(): number
  garak_db_to_gain(db: number): number
  garak_biquad_design(kind: number, rate: number, hz: number, q: number, gain: number): number
  garak_biquad_create(): number
  garak_biquad_free(slot: number): void
  garak_biquad_configure(slot: number, kind: number, rate: number, hz: number, q: number, gain: number): void
  garak_biquad_retarget(slot: number, kind: number, rate: number, hz: number, q: number, gain: number): void
  garak_biquad_reset(slot: number): void
  garak_biquad_process(slot: number, frames: number): void
  garak_utility_create(rate: number): number
  garak_utility_free(slot: number): void
  garak_utility_configure(slot: number, gain: number, pan: number, width: number, mono: number, phase: number): void
  garak_utility_process(slot: number, frames: number): void
}

export interface RustCoefficients { b0: number; b1: number; b2: number; a1: number; a2: number }
export interface RustUtilityParams { gain?: number; pan?: number; width?: number; mono?: number; phase?: number }

export interface RustKernel {
  /** Planar stereo in place; any length (processed in chunks of `maxFrames`). */
  process(left: Float32Array, right: Float32Array, frames?: number): void
  free(): void
}
export interface RustBiquad extends RustKernel {
  /** Jump to the response (C++ `Biquad::configure`). */
  configure(type: RustFilterType, sampleRate: number, hz: number, q: number, gainDb?: number): void
  /** Glide (~12 ms) to the response (TS `Biquad.configure(..., immediate=false)`). */
  retarget(type: RustFilterType, sampleRate: number, hz: number, q: number, gainDb?: number): void
  reset(): void
}
export interface RustUtility extends RustKernel {
  /** First call applies immediately, later calls glide (kernels.ts semantics). */
  configure(params: RustUtilityParams): void
}

export class GarakWasm {
  readonly maxFrames: number
  readonly maxSlots: number
  private readonly left: Float32Array
  private readonly right: Float32Array

  constructor(private readonly x: Exports) {
    const abi = x.garak_abi_version()
    if (abi !== GARAK_WASM_ABI) throw new Error(`garak-dsp.wasm ABI ${abi}, loader expects ${GARAK_WASM_ABI}`)
    this.maxFrames = x.garak_max_frames()
    this.maxSlots = x.garak_max_slots()
    this.left = new Float32Array(x.memory.buffer, x.garak_left_ptr(), this.maxFrames)
    this.right = new Float32Array(x.memory.buffer, x.garak_right_ptr(), this.maxFrames)
  }

  dbToGain(db: number): number { return this.x.garak_db_to_gain(db) }

  designBiquad(type: RustFilterType, sampleRate: number, hz: number, q: number, gainDb = 0): RustCoefficients {
    const at = this.x.garak_biquad_design(RUST_FILTER[type], sampleRate, hz, q, gainDb)
    const c = new Float64Array(this.x.memory.buffer, at, 5)
    return { b0: c[0], b1: c[1], b2: c[2], a1: c[3], a2: c[4] }
  }

  /** Null when every slot is taken (`maxSlots` per instance): fall back to the TS kernel. */
  createBiquad(): RustBiquad | null {
    const x = this.x, slot = x.garak_biquad_create()
    if (slot < 0) return null
    return {
      configure: (type, sr, hz, q, gain = 0) => x.garak_biquad_configure(slot, RUST_FILTER[type], sr, hz, q, gain),
      retarget: (type, sr, hz, q, gain = 0) => x.garak_biquad_retarget(slot, RUST_FILTER[type], sr, hz, q, gain),
      reset: () => x.garak_biquad_reset(slot),
      process: (l, r, frames) => this.run(n => x.garak_biquad_process(slot, n), l, r, frames),
      free: () => x.garak_biquad_free(slot),
    }
  }

  createUtility(sampleRate: number): RustUtility | null {
    const x = this.x, slot = x.garak_utility_create(sampleRate)
    if (slot < 0) return null
    return {
      configure: p => x.garak_utility_configure(slot, p.gain ?? 0, p.pan ?? 0, p.width ?? 1, p.mono ?? 0, p.phase ?? 0),
      process: (l, r, frames) => this.run(n => x.garak_utility_process(slot, n), l, r, frames),
      free: () => x.garak_utility_free(slot),
    }
  }

  // Copies through the static scratch buffers; no allocation per call.
  private run(kernel: (frames: number) => void, l: Float32Array, r: Float32Array, frames = Math.min(l.length, r.length)): void {
    for (let offset = 0; offset < frames; offset += this.maxFrames) {
      const n = Math.min(this.maxFrames, frames - offset)
      this.left.set(l.subarray(offset, offset + n))
      this.right.set(r.subarray(offset, offset + n))
      kernel(n)
      l.set(this.left.subarray(0, n), offset)
      r.set(this.right.subarray(0, n), offset)
    }
  }
}

/** Synchronous instantiation (works inside AudioWorkletGlobalScope). The module imports nothing. */
export function instantiateGarakWasm(source: WebAssembly.Module | BufferSource): GarakWasm {
  const module = source instanceof WebAssembly.Module ? source : new WebAssembly.Module(source)
  const instance = new WebAssembly.Instance(module, {})
  return new GarakWasm(instance.exports as unknown as Exports)
}

/**
 * Main thread: fetch + compile the module. Resolves to null (never throws) when the artifact was
 * not built or fails to compile, so callers keep the existing TypeScript / C++ paths.
 */
export async function loadGarakWasmModule(baseUrl = '/', fetchImpl: typeof fetch = fetch): Promise<WebAssembly.Module | null> {
  try {
    const response = await fetchImpl(new URL(GARAK_WASM_PATH, new URL(baseUrl, globalThis.location?.href ?? 'http://localhost/')).href)
    if (!response.ok) return null
    const module = await WebAssembly.compile(await response.arrayBuffer())
    // Check the ABI before anyone ships the module to a worklet.
    instantiateGarakWasm(module)
    return module
  } catch {
    return null
  }
}

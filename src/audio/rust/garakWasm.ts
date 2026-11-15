/**
 * Loader for the Rust DSP core compiled to WebAssembly (rust/garak-wasm, docs/RUST.md).
 *
 * Worklet-friendly by construction: no `fetch`, `TextDecoder`, DOM or wasm-bindgen glue here, so
 * this module can be bundled into an AudioWorklet. The intended flow:
 *   main thread:  const module = await loadGarakWasmModule()      // null -> keep the TS kernels
 *                 new AudioWorkletNode(ctx, name, { processorOptions: { garakWasm: module } })
 *   worklet:      const dsp = instantiateGarakWasm(options.processorOptions.garakWasm)
 * `WebAssembly.Module` is structured-cloneable, and the module is ~100 KiB, so synchronous
 * instantiation inside the worklet is fine (engines allow synchronous compilation of a module that
 * was already compiled on the main thread). The module has no general allocator: memory only grows
 * when an effect with delay lines / reverb kernels is created (never in `process`), and the views
 * below are re-created after that.
 *
 * Nothing uses this by default yet; see `rustDspRequested()` in ./flag.ts and ./sigimsaeRust.ts.
 */

export const GARAK_WASM_ABI = 2
/** Served by Vite from public/ once `pnpm rust:wasm` has run (never committed). */
export const GARAK_WASM_PATH = 'wasm/garak-dsp.wasm'

/** Same order as `garak::dsp::Filter` and Rust `FilterType`. */
export const RUST_FILTER = {
  lowpass: 0, highpass: 1, bandpass: 2, peaking: 3, lowshelf: 4, highshelf: 5, notch: 6,
} as const
export type RustFilterType = keyof typeof RUST_FILTER

/** Built-in effect kinds (`garak_dsp::EffectKind`, `GarakRsEffect`): native `makeEffect` type ids. */
export const RUST_EFFECT = {
  delay: 0, chorus: 1, phaser: 2, flanger: 3, tremolo: 4, limiter: 5, gate: 6, tape: 7, bitcrusher: 8, utility: 9,
  eq: 10, filter: 11, compressor: 12, drive: 13, reverb: 14,
} as const
export type RustEffectType = keyof typeof RUST_EFFECT

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
  garak_params_ptr(): number
  garak_meter_ptr(): number
  garak_text_ptr(): number
  garak_fx_param_count(kind: number): number
  garak_fx_param_id(kind: number, index: number): number
  garak_fx_param_range(kind: number, index: number): number
  garak_fx_create(kind: number, rate: number, bpm: number, count: number): number
  garak_fx_free(slot: number): void
  garak_fx_automate(slot: number, count: number): void
  garak_fx_set_param(slot: number, index: number, value: number): void
  garak_fx_commit(slot: number): void
  garak_fx_set_tempo(slot: number, bpm: number): void
  garak_fx_reset(slot: number): void
  garak_fx_process(slot: number, frames: number): void
  garak_fx_latency(slot: number): number
  garak_fx_tail(slot: number): number
  garak_fx_meter(slot: number): number
  garak_fx_take_state(slot: number, previous: number): number
  garak_heap_used(): number
  garak_heap_reserved(): number
}

export interface RustCoefficients { b0: number; b1: number; b2: number; a1: number; a2: number }
export interface RustUtilityParams { gain?: number; pan?: number; width?: number; mono?: number; phase?: number }
export interface RustParamDef { id: string; default: number; min: number; max: number }

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
/** One built-in effect (native `makeEffect` semantics, C++ parameter catalog order). */
export interface RustEffect extends RustKernel {
  readonly type: RustEffectType
  readonly params: readonly RustParamDef[]
  /**
   * kernels.ts `configure()` semantics: every parameter is re-read (missing / non-finite ones take
   * their default, the rest is clamped), the tempo applies first, and new targets glide.
   */
  configure(params: Record<string, number> | undefined, bpm: number): void
  setTempo(bpm: number): void
  reset(): void
  latencyFrames(): number
  tailSeconds(): number
  /** Writes [detector peak, lowest gain] since the last call; false for effects without a meter. */
  meter(out: Float32Array): boolean
  /** Adopts `previous`'s audio history and glide state (C++ `takeStateFrom`); free `previous` after. */
  takeStateFrom(previous: RustEffect): void
  /** Slot index inside this instance (diagnostics). */
  readonly slot: number
}

const clampValue = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export class GarakWasm {
  readonly maxFrames: number
  readonly maxSlots: number
  private left!: Float32Array
  private right!: Float32Array
  private paramsView!: Float64Array
  private meterView!: Float32Array
  private textView!: Uint8Array
  private readonly defs = new Map<RustEffectType, RustParamDef[]>()

  constructor(private readonly x: Exports) {
    const abi = x.garak_abi_version()
    if (abi !== GARAK_WASM_ABI) throw new Error(`garak-dsp.wasm ABI ${abi}, loader expects ${GARAK_WASM_ABI}`)
    this.maxFrames = x.garak_max_frames()
    this.maxSlots = x.garak_max_slots()
    this.refreshViews()
  }

  /** Effect creation may grow the memory, which detaches every view of the old buffer. */
  private refreshViews(): void {
    const buffer = this.x.memory.buffer
    if (this.left?.buffer === buffer) return
    this.left = new Float32Array(buffer, this.x.garak_left_ptr(), this.maxFrames)
    this.right = new Float32Array(buffer, this.x.garak_right_ptr(), this.maxFrames)
    this.paramsView = new Float64Array(buffer, this.x.garak_params_ptr(), 64)
    this.meterView = new Float32Array(buffer, this.x.garak_meter_ptr(), 2)
    this.textView = new Uint8Array(buffer, this.x.garak_text_ptr(), 64)
  }

  /** Bytes the module's effect arena uses / has reserved (diagnostics). */
  heapBytes(): { used: number; reserved: number } {
    return { used: this.x.garak_heap_used(), reserved: this.x.garak_heap_reserved() }
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

  /** Parameter catalog of an effect, read from the module (C++ `effectDefs` order). */
  paramDefs(type: RustEffectType): RustParamDef[] {
    const cached = this.defs.get(type)
    if (cached) return cached
    const x = this.x, kind = RUST_EFFECT[type], defs: RustParamDef[] = []
    for (let i = 0; i < x.garak_fx_param_count(kind); i += 1) {
      const length = x.garak_fx_param_id(kind, i)
      this.refreshViews()
      const id = String.fromCharCode(...this.textView.subarray(0, length))
      x.garak_fx_param_range(kind, i)
      defs.push({ id, default: this.paramsView[0], min: this.paramsView[1], max: this.paramsView[2] })
    }
    this.defs.set(type, defs)
    return defs
  }

  /** Writes kernels.ts-style sanitised values (missing -> default, clamped) to the params buffer. */
  private stage(defs: readonly RustParamDef[], params: Record<string, number> | undefined): void {
    this.refreshViews()
    defs.forEach((def, i) => {
      const value = params?.[def.id]
      this.paramsView[i] = clampValue(typeof value === 'number' && Number.isFinite(value) ? value : def.default, def.min, def.max)
    })
  }

  /**
   * A built-in effect configured immediately with `params` at `bpm` (kernels.ts `createKernel`).
   * Null when every slot is taken, the arguments are invalid, or the memory cannot grow.
   * Call on the control path (constructor, structural edits), never inside `process()`.
   */
  createEffect(type: RustEffectType, sampleRate: number, params?: Record<string, number>, bpm = 120): RustEffect | null {
    const x = this.x, defs = this.paramDefs(type)
    const tempo = (value: number) => clampValue(Number.isFinite(value) ? value : 120, 20, 400)
    this.stage(defs, params)
    const slot = x.garak_fx_create(RUST_EFFECT[type], sampleRate, tempo(bpm), defs.length)
    this.refreshViews()
    if (slot < 0) return null
    const meter = (out: Float32Array) => {
      if (!x.garak_fx_meter(slot)) return false
      this.refreshViews()
      out[0] = this.meterView[0]; out[1] = this.meterView[1]
      return true
    }
    return {
      type, params: defs, slot,
      configure: (p, beats) => {
        x.garak_fx_set_tempo(slot, tempo(beats))
        this.stage(defs, p)
        x.garak_fx_automate(slot, defs.length)
      },
      setTempo: beats => x.garak_fx_set_tempo(slot, tempo(beats)),
      reset: () => x.garak_fx_reset(slot),
      latencyFrames: () => x.garak_fx_latency(slot),
      tailSeconds: () => x.garak_fx_tail(slot),
      meter,
      takeStateFrom: previous => { x.garak_fx_take_state(slot, previous.slot) },
      process: (l, r, frames) => this.run(n => x.garak_fx_process(slot, n), l, r, frames),
      free: () => x.garak_fx_free(slot),
    }
  }

  // Copies through the static scratch buffers; no allocation per call.
  private run(kernel: (frames: number) => void, l: Float32Array, r: Float32Array, frames = Math.min(l.length, r.length)): void {
    this.refreshViews()
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

/**
 * The vintage instruments (옥구슬 EP, 한밤 106) of the Rust core inside garak-dsp.wasm
 * (rust/garak-wasm/src/instruments.rs). Worklet-safe like ./garakWasm.ts: no fetch, no DOM, no
 * TextDecoder, synchronous instantiation of an already compiled module. The same Rust code runs in
 * the native engine (garak-ffi), with deterministic math, so both render identical samples
 * (./vintage.test.ts checks the shared checksums in rust/garak-dsp/src/instruments/parity.golden).
 */

/** `InstrumentEvent::kind` (garak_dsp::instruments::event). */
export const VINTAGE_EVENT = { noteOn: 0, noteOff: 1, allNotesOff: 2, controller: 3, param: 4, reset: 5 } as const

export interface VintageEvent {
  /** Frame inside the block; events must be sorted by offset. */
  offset: number
  kind: number
  id: number
  pitch: number
  value: number
  param: number
}

export interface VintageParamDef { id: string; default: number; min: number; max: number }

interface Exports {
  memory: WebAssembly.Memory
  garak_abi_version(): number
  garak_max_frames(): number
  garak_left_ptr(): number
  garak_right_ptr(): number
  garak_instrument_params_ptr(): number
  garak_instrument_events_ptr(): number
  garak_instrument_text_ptr(): number
  garak_instrument_max_events(): number
  garak_instrument_param_count(kind: number): number
  garak_instrument_param_id(kind: number, index: number): number
  garak_instrument_param_range(kind: number, index: number): number
  garak_instrument_create(kind: number, rate: number, count: number): number
  garak_instrument_free(slot: number): void
  garak_instrument_set_param(slot: number, index: number, value: number): void
  garak_instrument_process(slot: number, frames: number, events: number): void
  garak_instrument_reset(slot: number): void
  garak_instrument_take_state(slot: number, previous: number): void
  garak_instrument_tail(slot: number): number
  garak_instrument_active_voices(slot: number): number
}

const REQUIRED: readonly (keyof Exports)[] = [
  'memory', 'garak_abi_version', 'garak_max_frames', 'garak_left_ptr', 'garak_right_ptr', 'garak_instrument_params_ptr',
  'garak_instrument_events_ptr', 'garak_instrument_text_ptr', 'garak_instrument_max_events', 'garak_instrument_param_count',
  'garak_instrument_param_id', 'garak_instrument_param_range', 'garak_instrument_create', 'garak_instrument_free',
  'garak_instrument_set_param', 'garak_instrument_process', 'garak_instrument_reset', 'garak_instrument_take_state',
  'garak_instrument_tail', 'garak_instrument_active_voices',
]

/** Whether a compiled garak-dsp module carries the instrument exports (older artifacts do not). */
export function hasInstrumentExports(module: WebAssembly.Module): boolean {
  try {
    const names = new Set(WebAssembly.Module.exports(module).map(entry => entry.name))
    return REQUIRED.every(name => names.has(name))
  } catch {
    return false
  }
}

export interface VintageInstance {
  readonly slot: number
  setParam(index: number, value: number): void
  /** Renders `frames` (any length) into planar `left` / `right`, applying `events` (sorted, block-relative). */
  process(left: Float32Array, right: Float32Array, frames: number, events?: readonly VintageEvent[]): void
  reset(): void
  takeStateFrom(previous: VintageInstance): void
  tailSeconds(): number
  activeVoices(): number
  free(): void
}

export class VintageWasm {
  readonly maxFrames: number
  readonly maxEvents: number
  private left!: Float32Array
  private right!: Float32Array
  private params!: Float64Array
  private text!: Uint8Array
  private eventU32!: Uint32Array
  private eventI32!: Int32Array
  private eventF32!: Float32Array

  private constructor(private readonly x: Exports) {
    this.maxFrames = x.garak_max_frames()
    this.maxEvents = x.garak_instrument_max_events()
    this.refresh()
  }

  /** Null when the module lacks the instrument exports or fails to instantiate. */
  static instantiate(source: WebAssembly.Module | BufferSource): VintageWasm | null {
    try {
      const module = source instanceof WebAssembly.Module ? source : new WebAssembly.Module(source)
      if (!hasInstrumentExports(module)) return null
      const instance = new WebAssembly.Instance(module, {})
      return new VintageWasm(instance.exports as unknown as Exports)
    } catch {
      return null
    }
  }

  private refresh(): void {
    const buffer = this.x.memory.buffer
    if (this.left?.buffer === buffer) return
    this.left = new Float32Array(buffer, this.x.garak_left_ptr(), this.maxFrames)
    this.right = new Float32Array(buffer, this.x.garak_right_ptr(), this.maxFrames)
    this.params = new Float64Array(buffer, this.x.garak_instrument_params_ptr(), 32)
    this.text = new Uint8Array(buffer, this.x.garak_instrument_text_ptr(), 64)
    const events = this.x.garak_instrument_events_ptr()
    this.eventU32 = new Uint32Array(buffer, events, this.maxEvents * 6)
    this.eventI32 = new Int32Array(buffer, events, this.maxEvents * 6)
    this.eventF32 = new Float32Array(buffer, events, this.maxEvents * 6)
  }

  /** Catalog read from the module (ids, defaults, ranges in Rust order). */
  paramDefs(kind: number): VintageParamDef[] {
    const out: VintageParamDef[] = []
    for (let i = 0; i < this.x.garak_instrument_param_count(kind); i += 1) {
      const length = this.x.garak_instrument_param_id(kind, i)
      this.refresh()
      const id = String.fromCharCode(...this.text.subarray(0, length))
      this.x.garak_instrument_param_range(kind, i)
      out.push({ id, default: this.params[0], min: this.params[1], max: this.params[2] })
    }
    return out
  }

  /** An instrument with `params` in catalog order (shorter arrays keep the remaining defaults). */
  create(kind: number, sampleRate: number, params: readonly number[] = []): VintageInstance | null {
    const x = this.x
    this.refresh()
    const count = Math.min(params.length, this.params.length)
    for (let i = 0; i < count; i += 1) this.params[i] = params[i]
    const slot = x.garak_instrument_create(kind, sampleRate, count)
    if (slot < 0) return null
    return {
      slot,
      setParam: (index, value) => x.garak_instrument_set_param(slot, index, value),
      process: (left, right, frames, events = []) => this.run(slot, left, right, frames, events),
      reset: () => x.garak_instrument_reset(slot),
      takeStateFrom: previous => x.garak_instrument_take_state(slot, previous.slot),
      tailSeconds: () => x.garak_instrument_tail(slot),
      activeVoices: () => x.garak_instrument_active_voices(slot),
      free: () => x.garak_instrument_free(slot),
    }
  }

  private run(slot: number, left: Float32Array, right: Float32Array, frames: number, events: readonly VintageEvent[]): void {
    this.refresh()
    let next = 0
    for (let done = 0; done < frames; done += this.maxFrames) {
      const n = Math.min(this.maxFrames, frames - done)
      let count = 0
      while (next < events.length && events[next].offset < done + n && count < this.maxEvents) {
        const e = events[next++], at = count * 6
        this.eventU32[at] = Math.max(0, e.offset - done)
        this.eventU32[at + 1] = e.kind
        this.eventI32[at + 2] = e.id
        this.eventU32[at + 3] = e.pitch
        this.eventF32[at + 4] = e.value
        this.eventU32[at + 5] = e.param
        count += 1
      }
      this.x.garak_instrument_process(slot, n, count)
      left.set(this.left.subarray(0, n), done)
      right.set(this.right.subarray(0, n), done)
    }
  }
}

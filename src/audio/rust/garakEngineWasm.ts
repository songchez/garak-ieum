// Loader for the Rust render engine's WASM build (rust/garak-engine-wasm, docs/RUST_ENGINE.md 5).
// Not used by the app yet: stage 5 hosts it in an AudioWorklet. Plain TS over the raw exports (no
// wasm-bindgen glue), so it runs unchanged in AudioWorkletGlobalScope, Node and tests.
//
// Memory rule: control calls (putAsset, set, patch, transport) may grow the module's memory, which
// detaches existing views; every method here re-creates its views after them. render() never
// allocates, so the output view returned by render() stays valid until the next control call.

import { MATH_IMPORTS } from './garakWasm.js'

interface EngineExports {
  memory: WebAssembly.Memory
  garak_engine_abi_version(): number
  garak_engine_alloc(len: number): number
  garak_engine_free(ptr: number, len: number): void
  garak_engine_create(sampleRate: number, maxBlock: number, offline: number): number
  garak_engine_destroy(): void
  garak_engine_error_ptr(): number
  garak_engine_error_len(): number
  garak_engine_put_asset(id: number, idLen: number, sampleRate: number, channels: number, samples: number, count: number): number
  garak_engine_set(json: number, jsonLen: number, blob: number, blobLen: number): number
  garak_engine_patch(json: number, jsonLen: number, blob: number, blobLen: number): number
  garak_engine_transport(command: number, frame: number): number
  garak_engine_collect(): void
  garak_engine_latency(): number
  garak_engine_tail(): number
  garak_engine_frame(): number
  garak_engine_output_ptr(): number
  garak_engine_render(frames: number): number
}

export const ENGINE_ABI_VERSION = 1
/** Applied kinds of set/patch (docs/RENDER_DIFF_PROTOCOL.md 3.3). */
export type EngineApplied = 'none' | 'diff' | 'tracks' | 'full'
const APPLIED: EngineApplied[] = ['none', 'diff', 'tracks', 'full']
const TRANSPORT = { play: 0, pause: 1, stop: 2, seek: 3 } as const

export interface GarakEngine {
  /** Registers interleaved PCM under `id` (replaces an asset with the same id). */
  putAsset(id: string, sampleRate: number, channels: number, samples: Float32Array): void
  /** project.set: the timeline JSON text and the optional binary frame. */
  set(timelineJson: string, binary?: Uint8Array): EngineApplied
  /** project.patch against the current project. */
  patch(patchJson: string, binary?: Uint8Array): EngineApplied
  transport(command: keyof typeof TRANSPORT, frame?: number): void
  /** Frees retired graphs (call after edits, off the render path). */
  collect(): void
  /** Plug-in delay (frames) and tail (seconds) of the last submitted graph. */
  readonly latencyFrames: number
  readonly tailSeconds: number
  readonly frame: number
  /** Renders `frames` (<= maxBlock) and returns a view of the interleaved stereo output. */
  render(frames: number): Float32Array
  destroy(): void
}

const encoder = new TextEncoder()

export function instantiateGarakEngine(module: WebAssembly.Module, sampleRate: number, maxBlock: number, offline = false): GarakEngine {
  // garak-dsp on wasm32 imports the Math.* transcendentals (rust/garak-dsp/src/math.rs), like garak-dsp.wasm.
  const instance = new WebAssembly.Instance(module, MATH_IMPORTS)
  const x = instance.exports as unknown as EngineExports
  if (x.garak_engine_abi_version() !== ENGINE_ABI_VERSION) throw new Error('garak-engine.wasm ABI mismatch')
  const error = (): Error => {
    const bytes = new Uint8Array(x.memory.buffer, x.garak_engine_error_ptr(), x.garak_engine_error_len())
    return new Error(new TextDecoder().decode(bytes.slice()))
  }
  const check = (code: number): number => { if (code < 0) throw error(); return code }
  // Copies `bytes` into a fresh module buffer, runs `use`, frees the buffer.
  const withBytes = <T>(bytes: Uint8Array, use: (ptr: number) => T): T => {
    const ptr = x.garak_engine_alloc(bytes.length)
    new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes)
    try { return use(ptr) } finally { x.garak_engine_free(ptr, bytes.length) }
  }
  check(x.garak_engine_create(sampleRate, maxBlock, offline ? 1 : 0))
  const update = (call: 'garak_engine_set' | 'garak_engine_patch', json: string, binary?: Uint8Array): EngineApplied => {
    const text = encoder.encode(json)
    const blob = binary ?? new Uint8Array(0)
    return withBytes(text, (t) => withBytes(blob, (b) => APPLIED[check(x[call](t, text.length, b, blob.length))]))
  }
  return {
    putAsset(id, rate, channels, samples) {
      const name = encoder.encode(id)
      const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
      withBytes(name, (n) => withBytes(bytes, (s) => check(x.garak_engine_put_asset(n, name.length, rate, channels, s, samples.length))))
    },
    set: (json, binary) => update('garak_engine_set', json, binary),
    patch: (json, binary) => update('garak_engine_patch', json, binary),
    transport(command, frame = 0) { check(x.garak_engine_transport(TRANSPORT[command], frame)) },
    collect() { x.garak_engine_collect() },
    get latencyFrames() { return x.garak_engine_latency() },
    get tailSeconds() { return x.garak_engine_tail() },
    get frame() { return x.garak_engine_frame() },
    render(frames) {
      const n = x.garak_engine_render(frames)
      return new Float32Array(x.memory.buffer, x.garak_engine_output_ptr(), n * 2)
    },
    destroy() { x.garak_engine_destroy() },
  }
}

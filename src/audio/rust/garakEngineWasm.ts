// Loader for the Rust render engine's WASM build (rust/garak-engine-wasm, docs/RUST_ENGINE.md 5).
// Used by the engine worklet (engine.worklet.ts), the export worker (engineRender.worker.ts) and the
// Node tests. Plain TS over the raw exports (no wasm-bindgen glue), and no TextEncoder/TextDecoder
// requirement, so it runs unchanged in AudioWorkletGlobalScope, workers and Node.
//
// Memory rule: control calls (putAsset, set, patch, transport) may grow the module's memory, which
// detaches existing views; every method here re-creates its views after them. render() never
// allocates, so the output views returned by render()/renderPlanar() stay valid until the next
// control call.

import { MATH_IMPORTS } from './garakWasm.js'

interface EngineExports {
  memory: WebAssembly.Memory
  garak_engine_abi_version(): number
  garak_engine_alloc(len: number): number
  garak_engine_free(ptr: number, len: number): void
  garak_engine_alloc_f32(count: number): number
  garak_engine_free_f32(ptr: number, count: number): void
  garak_engine_create(sampleRate: number, maxBlock: number, offline: number): number
  garak_engine_destroy(): void
  garak_engine_error_ptr(): number
  garak_engine_error_len(): number
  garak_engine_put_asset_owned(id: number, idLen: number, sampleRate: number, channels: number, samples: number, count: number): number
  garak_engine_remove_asset(id: number, idLen: number): void
  garak_engine_set(json: number, jsonLen: number, blob: number, blobLen: number): number
  garak_engine_patch(json: number, jsonLen: number, blob: number, blobLen: number): number
  garak_engine_transport(command: number, frame: number): number
  garak_engine_collect(): void
  garak_engine_latency(): number
  garak_engine_tail(): number
  garak_engine_frame(): number
  garak_engine_playing(): number
  garak_engine_master_peak(): number
  garak_engine_output_ptr(): number
  garak_engine_planar_ptr(): number
  garak_engine_render(frames: number): number
  garak_engine_render_planar(frames: number): number
}

export const ENGINE_ABI_VERSION = 2
/** Applied kinds of set/patch (docs/RENDER_DIFF_PROTOCOL.md 3.3). */
export type EngineApplied = 'none' | 'diff' | 'tracks' | 'full'
const APPLIED: EngineApplied[] = ['none', 'diff', 'tracks', 'full']
export const ENGINE_TRANSPORT = { play: 0, pause: 1, stop: 2, seek: 3 } as const
export type EngineTransport = keyof typeof ENGINE_TRANSPORT

/** A refusal of the engine itself (project.set/patch/asset.put), as opposed to a host failure. */
export class GarakEngineError extends Error {
  readonly engine = true
}

export interface GarakEngine {
  /** Registers interleaved PCM under `id` (replaces an asset with the same id). One copy into the module. */
  putAsset(id: string, sampleRate: number, channels: number, samples: Float32Array): void
  removeAsset(id: string): void
  /** project.set: the timeline JSON (text or UTF-8 bytes) and the optional binary frame. */
  set(timelineJson: string | Uint8Array, binary?: Uint8Array): EngineApplied
  /** project.patch against the current project. */
  patch(patchJson: string | Uint8Array, binary?: Uint8Array): EngineApplied
  transport(command: EngineTransport, frame?: number): void
  /** Frees retired graphs (call after edits, off the render path). */
  collect(): void
  /** Plug-in delay (frames) and tail (seconds) of the last submitted graph. */
  readonly latencyFrames: number
  readonly tailSeconds: number
  /** Transport frame, playing state and master peak (linear) published by the last render. */
  readonly frame: number
  readonly playing: boolean
  readonly masterPeak: number
  /** Renders `frames` (<= maxBlock) and returns a view of the interleaved stereo output. */
  render(frames: number): Float32Array
  /** Renders `frames` (<= maxBlock) and returns views of the left and right output. */
  renderPlanar(frames: number): readonly [Float32Array, Float32Array]
  destroy(): void
}

/** UTF-8 without TextEncoder (absent from some AudioWorkletGlobalScope implementations). */
export function utf8Encode(text: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text)
  const out: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i)
    if (code >= 0xd800 && code < 0xdc00 && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1)
      if (low >= 0xdc00 && low < 0xe000) { code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00); i += 1 }
    }
    if (code < 0x80) out.push(code)
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63))
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
  }
  return new Uint8Array(out)
}

function utf8Decode(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes)
  // Engine messages are ASCII; anything else is replaced.
  let text = ''
  for (const byte of bytes) text += byte < 0x80 ? String.fromCharCode(byte) : '�'
  return text
}

export function instantiateGarakEngine(module: WebAssembly.Module, sampleRate: number, maxBlock: number, offline = false): GarakEngine {
  // garak-dsp on wasm32 imports the Math.* transcendentals (rust/garak-dsp/src/math.rs), like garak-dsp.wasm.
  const instance = new WebAssembly.Instance(module, MATH_IMPORTS)
  const x = instance.exports as unknown as EngineExports
  if (x.garak_engine_abi_version() !== ENGINE_ABI_VERSION) throw new Error('garak-engine.wasm ABI mismatch')
  const error = (): Error => {
    const bytes = new Uint8Array(x.memory.buffer, x.garak_engine_error_ptr(), x.garak_engine_error_len())
    return new GarakEngineError(utf8Decode(bytes.slice()))
  }
  const check = (code: number): number => { if (code < 0) throw error(); return code }
  // Copies `bytes` into a fresh module buffer, runs `use`, frees the buffer.
  const withBytes = <T>(bytes: Uint8Array, use: (ptr: number) => T): T => {
    const ptr = x.garak_engine_alloc(bytes.length)
    new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes)
    try { return use(ptr) } finally { x.garak_engine_free(ptr, bytes.length) }
  }
  check(x.garak_engine_create(sampleRate, maxBlock, offline ? 1 : 0))
  const update = (call: 'garak_engine_set' | 'garak_engine_patch', json: string | Uint8Array, binary?: Uint8Array): EngineApplied => {
    const text = typeof json === 'string' ? utf8Encode(json) : json
    const blob = binary ?? new Uint8Array(0)
    return withBytes(text, (t) => withBytes(blob, (b) => APPLIED[check(x[call](t, text.length, b, blob.length))]))
  }
  // Output views: rebuilt when memory grew (a control call), otherwise reused every quantum.
  let viewBuffer: ArrayBuffer | null = null
  let interleaved = new Float32Array(0), left = new Float32Array(0), right = new Float32Array(0)
  const views = () => {
    if (viewBuffer === x.memory.buffer) return
    viewBuffer = x.memory.buffer as ArrayBuffer
    interleaved = new Float32Array(viewBuffer, x.garak_engine_output_ptr(), maxBlock * 2)
    const planar = x.garak_engine_planar_ptr()
    left = new Float32Array(viewBuffer, planar, maxBlock)
    right = new Float32Array(viewBuffer, planar + maxBlock * 4, maxBlock)
  }
  return {
    putAsset(id, rate, channels, samples) {
      const name = utf8Encode(id)
      const ptr = samples.length ? x.garak_engine_alloc_f32(samples.length) : 0
      if (ptr) new Float32Array(x.memory.buffer, ptr, samples.length).set(samples)
      // The module owns the buffer from here on (also when it refuses the asset).
      withBytes(name, (n) => check(x.garak_engine_put_asset_owned(n, name.length, rate, channels, ptr, samples.length)))
    },
    removeAsset(id) {
      const name = utf8Encode(id)
      withBytes(name, (n) => x.garak_engine_remove_asset(n, name.length))
    },
    set: (json, binary) => update('garak_engine_set', json, binary),
    patch: (json, binary) => update('garak_engine_patch', json, binary),
    transport(command, frame = 0) { check(x.garak_engine_transport(ENGINE_TRANSPORT[command], frame)) },
    collect() { x.garak_engine_collect() },
    get latencyFrames() { return x.garak_engine_latency() },
    get tailSeconds() { return x.garak_engine_tail() },
    get frame() { return x.garak_engine_frame() },
    get playing() { return x.garak_engine_playing() !== 0 },
    get masterPeak() { return x.garak_engine_master_peak() },
    render(frames) {
      const n = x.garak_engine_render(frames)
      views()
      return n === maxBlock ? interleaved : interleaved.subarray(0, n * 2)
    },
    renderPlanar(frames) {
      const n = x.garak_engine_render_planar(frames)
      views()
      return n === maxBlock ? [left, right] : [left.subarray(0, n), right.subarray(0, n)]
    },
    destroy() { x.garak_engine_destroy(); viewBuffer = null },
  }
}

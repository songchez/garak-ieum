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
  garak_engine_alloc_f32_uninit(count: number): number
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
  // ABI 3 (docs/RUST_ENGINE.md 5.7)
  garak_engine_counting_in(): number
  garak_engine_revision(): number
  garak_engine_live_count(which: number): number
  garak_engine_master_bypass(on: number): number
  garak_engine_metronome(on: number, gain: number, strokes: number, len0: number, len1: number, len2: number): number
  garak_engine_monitor(tracks: number, count: number): number
  garak_engine_taps(tracks: number, count: number): number
  garak_engine_tap_ptr(): number
  garak_engine_max_taps(): number
  garak_engine_live(track: number, kind: number, pitch: number, value: number, id: number): number
  garak_engine_input_ptr(): number
  garak_engine_max_input_channels(): number
  garak_engine_peaks_ptr(): number
  garak_engine_track_count(): number
  garak_engine_clear_peaks(): void
  garak_engine_take_dynamics(): number
  garak_engine_dynamics_ptr(): number
  garak_engine_render_planar_io(frames: number, channels: number): number
  garak_engine_stage(patch: number, json: number, jsonLen: number, blob: number, blobLen: number): number
  garak_engine_step(): number
  garak_engine_commit(): number
  garak_engine_reverb_kernel_json(json: number, len: number): number
  garak_engine_kernel_param(which: number): number
  garak_engine_kernel_ptr(): number
  garak_engine_import_kernel(type: number, size: number, data: number, count: number): number
  // ABI 4 (docs/RUST_ENGINE.md 6)
  garak_engine_register_samples(json: number, jsonLen: number): number
  garak_engine_note_on(track: number, pitch: number, velocity: number, id: number): number
  garak_engine_note_off(track: number, pitch: number, id: number): number
  garak_engine_preview_note(track: number, pitch: number, velocity: number, frames: number): number
  garak_engine_control_change(track: number, controller: number, value: number): number
  garak_engine_all_notes_off(track: number): number
}

/**
 * ABI 3: count-in, metronome, meters, monitoring input, route taps, live events, staged updates, kernels.
 * ABI 4: built-in instruments (sample set registration, per-call live MIDI exports; live events play them).
 */
export const ENGINE_ABI_VERSION = 4
/** Applied kinds of set/patch (docs/RENDER_DIFF_PROTOCOL.md 3.3). */
export type EngineApplied = 'none' | 'diff' | 'tracks' | 'full'
const APPLIED: EngineApplied[] = ['none', 'diff', 'tracks', 'full']
/** `countIn`: play after a count-in of `frame` frames (the metronome clicks it; offline engines start at once). */
export const ENGINE_TRANSPORT = { play: 0, pause: 1, stop: 2, seek: 3, countIn: 4 } as const
/** Live event kinds (garak_engine_live). */
export const LIVE_EVENT = { noteOn: 0, noteOff: 1, allNotesOff: 2, control: 3 } as const
export type LiveEventKind = keyof typeof LIVE_EVENT

/** One dynamics meter reading: graph track index, plan insert index, detector peak and lowest gain (linear). */
export interface EngineDynamicsReading { track: number; insert: number; input: number; gain: number }

/** A reverb kernel computed by a helper instance (`reverbKernel`), for `importKernel`. */
export interface EngineKernel { type: number; size: number; data: Float32Array }
export type EngineTransport = keyof typeof ENGINE_TRANSPORT

/** A refusal of the engine itself (project.set/patch/asset.put), as opposed to a host failure. */
export class GarakEngineError extends Error {
  readonly engine = true
}

export interface GarakEngine {
  /** Registers interleaved PCM under `id` (replaces an asset with the same id). One copy into the module. */
  putAsset(id: string, sampleRate: number, channels: number, samples: Float32Array): void
  /** The same in pieces (long PCM across render quanta): a module buffer, writes at sample offsets, then the handover. */
  beginAsset(count: number): number
  writeAsset(buffer: number, offset: number, samples: Float32Array): void
  finishAsset(id: string, sampleRate: number, channels: number, buffer: number, count: number): void
  removeAsset(id: string): void
  /** samples.register params as JSON (`{ id, manifest, files, startOffset }`); the zones' PCM is registered first. */
  registerSamples(json: string | Uint8Array): void
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
  /** Like renderPlanar, hearing `channels` of live input written to `inputView()` (interleaved). */
  renderPlanarInput(frames: number, channels: number): readonly [Float32Array, Float32Array]
  /** The live input buffer (`maxBlock` frames of `maxInputChannels` interleaved slots); valid until a control call. */
  inputView(): Float32Array
  readonly maxInputChannels: number
  /** A count-in is running (`playing` is true meanwhile; the frame stays at the start). */
  readonly countingIn: boolean
  /** Revision of the running graph. */
  readonly revision: number
  /** Live events a track played / no track could play. */
  readonly liveCounts: { played: number; ignored: number }
  /** Offline stems/freeze: no master gain or master processor. */
  masterBypass(on: boolean): void
  /** Metronome on/off and gain; strokes per level (downbeat, group start, pulse) at the engine rate, or kept. */
  setMetronome(on: boolean, gain: number, strokes?: readonly [Float32Array, Float32Array, Float32Array]): void
  /** Monitored tracks (graph indices). */
  monitor(tracks: readonly number[]): void
  /** Route recording taps (graph indices, at most `maxTaps`). */
  taps(tracks: readonly number[]): void
  readonly maxTaps: number
  /** The route taps of the last render: `maxTaps` slots of `maxBlock` interleaved stereo frames. */
  tapView(): Float32Array
  live(track: number, kind: LiveEventKind, pitch?: number, value?: number, id?: number): void
  /** Each track's highest peak since `clearPeaks` (graph order); `count` tracks. */
  peaks(): { values: Float32Array; count: number }
  clearPeaks(): void
  /** Dynamics meters since the previous call. */
  takeDynamics(): EngineDynamicsReading[]
  /** project.set / project.patch in stages: returns how many tracks `step` builds. */
  stage(json: string | Uint8Array, binary: Uint8Array | undefined, patch: boolean): number
  /** Builds the next staged track; true once all are built. */
  step(): boolean
  commit(): EngineApplied
  /** The reverb kernel for a reverb insert's parameter map (a helper instance; the result is a copy). */
  reverbKernel(params: Record<string, number>): EngineKernel
  importKernel(kernel: EngineKernel): void
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
  let input = new Float32Array(0), taps = new Float32Array(0), peakView = new Float32Array(0), dynamics = new DataView(new ArrayBuffer(0))
  const maxInputChannels = x.garak_engine_max_input_channels(), maxTaps = x.garak_engine_max_taps()
  const views = () => {
    if (viewBuffer === x.memory.buffer) return
    viewBuffer = x.memory.buffer as ArrayBuffer
    interleaved = new Float32Array(viewBuffer, x.garak_engine_output_ptr(), maxBlock * 2)
    const planar = x.garak_engine_planar_ptr()
    left = new Float32Array(viewBuffer, planar, maxBlock)
    right = new Float32Array(viewBuffer, planar + maxBlock * 4, maxBlock)
    input = new Float32Array(viewBuffer, x.garak_engine_input_ptr(), maxBlock * maxInputChannels)
    taps = new Float32Array(viewBuffer, x.garak_engine_tap_ptr(), maxBlock * 2 * maxTaps)
    peakView = new Float32Array(viewBuffer, x.garak_engine_peaks_ptr(), 256)
    dynamics = new DataView(viewBuffer, x.garak_engine_dynamics_ptr(), 256 * 12)
  }
  const withIndices = (list: readonly number[], call: (ptr: number, count: number) => number, signed: boolean) => {
    const bytes = new Uint8Array(list.length * 4)
    const view = new DataView(bytes.buffer)
    list.forEach((value, k) => signed ? view.setInt32(k * 4, value, true) : view.setUint32(k * 4, value, true))
    check(withBytes(bytes, (p) => call(p, list.length)))
  }
  const ownedF32 = (data: Float32Array): number => {
    const ptr = data.length ? x.garak_engine_alloc_f32(data.length) : 0
    if (ptr) new Float32Array(x.memory.buffer, ptr, data.length).set(data)
    return ptr
  }
  return {
    putAsset(id, rate, channels, samples) {
      const name = utf8Encode(id)
      const ptr = samples.length ? x.garak_engine_alloc_f32(samples.length) : 0
      if (ptr) new Float32Array(x.memory.buffer, ptr, samples.length).set(samples)
      // The module owns the buffer from here on (also when it refuses the asset).
      withBytes(name, (n) => check(x.garak_engine_put_asset_owned(n, name.length, rate, channels, ptr, samples.length)))
    },
    beginAsset(count) { return count ? x.garak_engine_alloc_f32_uninit(count) : 0 },
    writeAsset(buffer, offset, samples) { new Float32Array(x.memory.buffer, buffer + offset * 4, samples.length).set(samples) },
    finishAsset(id, rate, channels, buffer, count) {
      const name = utf8Encode(id)
      withBytes(name, (n) => check(x.garak_engine_put_asset_owned(n, name.length, rate, channels, buffer, count)))
    },
    removeAsset(id) {
      const name = utf8Encode(id)
      withBytes(name, (n) => x.garak_engine_remove_asset(n, name.length))
    },
    registerSamples(json) {
      const text = typeof json === 'string' ? utf8Encode(json) : json
      withBytes(text, (t) => check(x.garak_engine_register_samples(t, text.length)))
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
    renderPlanarInput(frames, channels) {
      const n = x.garak_engine_render_planar_io(frames, Math.min(channels, maxInputChannels))
      views()
      return n === maxBlock ? [left, right] : [left.subarray(0, n), right.subarray(0, n)]
    },
    inputView() { views(); return input },
    maxInputChannels,
    maxTaps,
    get countingIn() { return x.garak_engine_counting_in() !== 0 },
    get revision() { return x.garak_engine_revision() },
    get liveCounts() { return { played: x.garak_engine_live_count(0), ignored: x.garak_engine_live_count(1) } },
    masterBypass(on) { check(x.garak_engine_master_bypass(on ? 1 : 0)) },
    setMetronome(on, gain, strokes) {
      if (!strokes) { check(x.garak_engine_metronome(on ? 1 : 0, gain, 0, 0, 0, 0)); return }
      const all = new Float32Array(strokes[0].length + strokes[1].length + strokes[2].length)
      all.set(strokes[0], 0); all.set(strokes[1], strokes[0].length); all.set(strokes[2], strokes[0].length + strokes[1].length)
      // The module owns the buffer from here on.
      check(x.garak_engine_metronome(on ? 1 : 0, gain, ownedF32(all), strokes[0].length, strokes[1].length, strokes[2].length))
    },
    monitor(tracks) { withIndices(tracks, (p, n) => x.garak_engine_monitor(p, n), false) },
    taps(list) { withIndices(list, (p, n) => x.garak_engine_taps(p, n), true) },
    tapView() { views(); return taps },
    live(track, kind, pitch = 0, value = 0, id = 0) { check(x.garak_engine_live(track, LIVE_EVENT[kind], pitch, value, id)) },
    peaks() { views(); return { values: peakView, count: x.garak_engine_track_count() } },
    clearPeaks() { x.garak_engine_clear_peaks() },
    takeDynamics() {
      const count = x.garak_engine_take_dynamics()
      views()
      const out: EngineDynamicsReading[] = []
      for (let k = 0; k < count; k += 1) {
        const at = k * 12
        out.push({ track: dynamics.getUint16(at, true), insert: dynamics.getUint16(at + 2, true), input: dynamics.getFloat32(at + 4, true), gain: dynamics.getFloat32(at + 8, true) })
      }
      return out
    },
    stage(json, binary, patch) {
      const text = typeof json === 'string' ? utf8Encode(json) : json
      const blob = binary ?? new Uint8Array(0)
      return withBytes(text, (t) => withBytes(blob, (b) => check(x.garak_engine_stage(patch ? 1 : 0, t, text.length, b, blob.length))))
    },
    step() { return check(x.garak_engine_step()) === 1 },
    commit() { return APPLIED[check(x.garak_engine_commit())] },
    reverbKernel(params) {
      const text = utf8Encode(JSON.stringify(params))
      const len = withBytes(text, (t) => check(x.garak_engine_reverb_kernel_json(t, text.length)))
      const data = new Float32Array(x.memory.buffer, x.garak_engine_kernel_ptr(), len).slice()
      return { type: x.garak_engine_kernel_param(0), size: x.garak_engine_kernel_param(1), data }
    },
    importKernel(kernel) { check(x.garak_engine_import_kernel(kernel.type, kernel.size, ownedF32(kernel.data), kernel.data.length)) },
    destroy() { x.garak_engine_destroy(); viewBuffer = null },
  }
}

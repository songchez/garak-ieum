/// <reference path="../worklet-assets.d.ts" />
// Main-thread side of the Rust engine worklet (docs/RUST_ENGINE.md 5): module loading, the
// AudioWorkletNode bridge (PCM, project.set/patch, transport, status) and the export worker.

import { packAudioBuffer } from '../native/pcmTransfer'
import { GarakEngineError, utf8Encode, type EngineApplied, type EngineKernel, type EngineTransport, ENGINE_TRANSPORT, ENGINE_ABI_VERSION, LIVE_EVENT, type LiveEventKind } from './garakEngineWasm'
import {
  CommandRing, createSharedChannel, emptyStatus, ENGINE_PROCESSOR, MeterReader, RING_LIVE, StatusReader, TAP_CHANNELS,
  type EngineMeters, type EngineProcessorOptions, type EngineReply, type EngineRequest, type EngineStatus, type SharedChannel,
} from './engineChannel'
import type { EngineRenderRequest, EngineRenderResult } from './engineOffline'

/** Served by Vite from public/ once `pnpm rust:wasm` has run (never committed). */
export const GARAK_ENGINE_WASM_PATH = 'wasm/garak-engine.wasm'

const baseUrl = (): string => (import.meta as { env?: Record<string, string | undefined> }).env?.BASE_URL ?? '/'

/** Fetch + compile; null (never throws) when the artifact is missing or does not match this loader. */
export async function loadGarakEngineModule(base = baseUrl(), fetchImpl: typeof fetch = fetch): Promise<WebAssembly.Module | null> {
  try {
    const response = await fetchImpl(new URL(GARAK_ENGINE_WASM_PATH, new URL(base, globalThis.location?.href ?? 'http://localhost/')).href)
    if (!response.ok) return null
    const module = await WebAssembly.compile(await response.arrayBuffer())
    // Checked without instantiating (every instance reserves its own memory): ABI 3 adds the count-in,
    // meters, monitoring input, route taps, live events and staged updates; ABI 4 the built-in instruments.
    // The worklet still verifies garak_engine_abi_version().
    const exports = new Set(WebAssembly.Module.exports(module).map(entry => entry.name))
    return ENGINE_ABI_VERSION === 4 && exports.has('garak_engine_render_planar_io') && exports.has('garak_engine_stage') && exports.has('garak_engine_register_samples') ? module : null
  } catch {
    return null
  }
}

let shared: Promise<WebAssembly.Module | null> | null = null
/** The page's garak-engine module, fetched once; a failed load is fetched again by the next caller. */
export function sharedGarakEngineModule(): Promise<WebAssembly.Module | null> {
  if (!shared) {
    const task = loadGarakEngineModule()
    shared = task
    void task.then(module => { if (!module && shared === task) shared = null })
  }
  return shared
}

/** Shown when the browser cannot run the engine worklet at all (no AudioWorklet, e.g. an insecure origin). */
export const ENGINE_WORKLET_UNSUPPORTED = '이 브라우저는 오디오 엔진에 필요한 AudioWorklet을 지원하지 않습니다. 최신 Chrome, Edge, Firefox 또는 Safari에서 보안 연결(https)로 열어 주세요.'

const registered = new WeakMap<BaseAudioContext, Promise<void>>()
function registerProcessor(context: BaseAudioContext): Promise<void> {
  let task = registered.get(context)
  if (!task) {
    task = import('./engineWorkletUrl').then(({ default: url }) => context.audioWorklet.addModule(url))
    task.catch(() => { if (registered.get(context) === task) registered.delete(context) })
    registered.set(context, task)
  }
  return task
}

interface Pending { resolve(reply: { applied?: string; latency: number; tail: number }): void; reject(error: Error): void }

export interface EngineUpdateResult { applied: EngineApplied; latencyFrames: number; tailSeconds: number }

/**
 * Benchmarks only (scripts/rust-engine-smoke.mjs): a worker spins writing performance.now() into a
 * SharedArrayBuffer the worklet reads, so render times are measured in microseconds instead of the
 * 1 ms Date.now() steps of AudioWorkletGlobalScope. Costs one busy core; isolated pages only.
 */
export const engineBenchmark = { preciseClock: false }

let clockWorker: { buffer: SharedArrayBuffer; worker: Worker } | null = null
function preciseClock(): SharedArrayBuffer | null {
  if (!engineBenchmark.preciseClock || typeof SharedArrayBuffer === 'undefined' || !(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated) return null
  if (!clockWorker) {
    const buffer = new SharedArrayBuffer(8)
    const source = 'onmessage=e=>{const v=new Float64Array(e.data);for(;;)v[0]=performance.now()}'
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })))
    worker.postMessage(buffer)
    clockWorker = { buffer, worker }
  }
  return clockWorker.buffer
}

/**
 * One engine worklet node on a realtime context. Every request is ordered (sequence numbers);
 * transport commands use the shared ring when the page is cross-origin isolated.
 */
export class RustEngineNode {
  readonly node: AudioWorkletNode
  readonly sharedChannel: boolean
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  private readonly status: EngineStatus = emptyStatus()
  private readonly reader: StatusReader | null
  private readonly meterReader: MeterReader | null
  private meters: EngineMeters | null = null
  private readonly ring: CommandRing | null
  private fatal: string | null = null
  private disposed = false

  private constructor(readonly context: AudioContext, module: WebAssembly.Module, channel: SharedChannel | null) {
    const quantum = (context as AudioContext & { renderQuantumSize?: number }).renderQuantumSize
    const options: EngineProcessorOptions & { clock?: SharedArrayBuffer } = { module, maxBlock: Math.max(128, typeof quantum === 'number' ? quantum : 128), shared: channel }
    const clock = channel ? preciseClock() : null
    if (clock) options.clock = clock
    // Input 0: the live input monitored tracks hear. Output 0: the mix; output 1: route recording taps.
    this.node = new AudioWorkletNode(context, ENGINE_PROCESSOR, {
      numberOfInputs: 1, numberOfOutputs: 2, outputChannelCount: [2, TAP_CHANNELS], channelCountMode: 'max', processorOptions: options,
    })
    this.reader = channel ? new StatusReader(channel.status) : null
    this.meterReader = channel ? new MeterReader(channel.meters) : null
    this.ring = channel ? new CommandRing(channel.ring) : null
    this.sharedChannel = !!channel
    this.node.port.onmessage = event => this.receive(event.data as EngineReply)
    this.node.onprocessorerror = () => this.fail('The engine worklet stopped (processor error)')
    this.node.connect(context.destination, 0)
  }

  static async create(context: AudioContext, module: WebAssembly.Module): Promise<RustEngineNode> {
    if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') throw new Error(ENGINE_WORKLET_UNSUPPORTED)
    await registerProcessor(context)
    return new RustEngineNode(context, module, createSharedChannel())
  }

  get error(): string | null { return this.fatal }

  private fail(message: string): void {
    this.fatal ??= message
    for (const [, pending] of this.pending) pending.reject(new Error(message))
    this.pending.clear()
  }

  private receive(reply: EngineReply): void {
    switch (reply.type) {
      case 'status':
        Object.assign(this.status, reply.status, { peak: Math.max(this.status.peak, reply.status.peak) })
        if (reply.meters) this.meters = mergeMeters(this.meters, reply.meters)
        return
      case 'fatal': this.fail(reply.message); return
      case 'ack': case 'error': {
        const pending = this.pending.get(reply.seq)
        if (!pending) return
        this.pending.delete(reply.seq)
        if (reply.type === 'ack') pending.resolve(reply)
        else pending.reject(reply.engine ? new GarakEngineError(reply.message) : new Error(reply.message))
      }
    }
  }

  private send(message: EngineRequest, transfer: Transferable[] = []): Promise<{ applied?: string; latency: number; tail: number }> {
    if (this.disposed) return Promise.reject(new Error('The engine worklet was disposed'))
    if (this.fatal) return Promise.reject(new Error(this.fatal))
    return new Promise((resolve, reject) => {
      this.pending.set(message.seq, { resolve, reject })
      this.node.port.postMessage(message, transfer)
    })
  }

  /** Interleaves the buffer once and transfers that copy: the main thread keeps none. */
  putAsset(id: string, buffer: AudioBuffer): Promise<void> {
    const pcm = packAudioBuffer(buffer)
    const samples = new Float32Array(pcm.data.buffer, pcm.data.byteOffset, pcm.frames * pcm.channels)
    return this.send({ type: 'asset', seq: ++this.seq, id, sampleRate: pcm.sampleRate, channels: pcm.channels, samples }, [samples.buffer]).then(() => undefined)
  }

  /** A sample set (`samples.register` JSON, as the desktop host sends it); its zone PCM goes first with putAsset. */
  registerSamples(json: string): Promise<void> {
    const bytes = utf8Encode(json)
    return this.send({ type: 'samples', seq: ++this.seq, json: bytes }, [bytes.buffer]).then(() => undefined)
  }

  removeAsset(id: string): Promise<void> {
    return this.send({ type: 'remove-asset', seq: ++this.seq, id }).then(() => undefined)
  }

  /** `project.set` (the timeline object) or `project.patch` (header/order/tracks), with the binary frame. */
  async update(method: 'project.set' | 'project.patch', params: unknown, binary: Uint8Array | null): Promise<EngineUpdateResult> {
    const json = utf8Encode(JSON.stringify(params))
    const transfer: Transferable[] = [json.buffer]
    if (binary && binary.byteOffset === 0 && binary.byteLength === binary.buffer.byteLength) transfer.push(binary.buffer)
    const reply = await this.send({ type: method === 'project.set' ? 'set' : 'patch', seq: ++this.seq, json, binary }, transfer)
    return { applied: (reply.applied ?? 'none') as EngineApplied, latencyFrames: reply.latency, tailSeconds: reply.tail }
  }

  /** Reverb kernels computed by the helper worker, so the worklet never generates one. */
  importKernels(kernels: EngineKernel[]): Promise<void> {
    if (!kernels.length) return Promise.resolve()
    return this.send({ type: 'kernels', seq: ++this.seq, kernels }, kernels.map(k => k.data.buffer)).then(() => undefined)
  }

  /** Metronome on/off and gain; click strokes per level at the context rate (sent once per sound/rate). */
  metronome(on: boolean, gain: number, strokes: Float32Array[] | null): Promise<void> {
    return this.send({ type: 'metronome', seq: ++this.seq, on, gain, strokes }, strokes ? strokes.map(s => s.buffer) : []).then(() => undefined)
  }

  /** Monitored tracks (graph indices of the last applied project). */
  monitor(tracks: number[]): Promise<void> {
    return this.send({ type: 'monitor', seq: ++this.seq, tracks }).then(() => undefined)
  }

  /** Route recording taps (graph indices): slot k plays on channels 2k, 2k+1 of output 1. */
  taps(tracks: number[]): Promise<void> {
    return this.send({ type: 'taps', seq: ++this.seq, tracks }).then(() => undefined)
  }

  /** A live note/controller event for a track (graph index); next quantum through the shared ring. */
  live(track: number, kind: LiveEventKind, pitch = 0, value = 0, id = 0): number {
    const seq = ++this.seq
    if (this.disposed || this.fatal) return seq
    const code = LIVE_EVENT[kind]
    if (this.ring?.push({ command: RING_LIVE, frame: id, afterSeq: seq - 1, seq, a: track, b: code, c: pitch, d: value })) return seq
    void this.send({ type: 'live', seq, track, kind: code, pitch, value, id }).catch(() => undefined)
    return seq
  }

  /** Track peaks and dynamics readings since the previous call (null before the first). */
  readMeters(): EngineMeters | null {
    if (this.meterReader) {
      const read = this.meterReader.read()
      if (read) this.meters = mergeMeters(this.meters, read)
    }
    const meters = this.meters
    this.meters = null
    return meters
  }

  /** Returns the command's sequence number (compare with `readStatus().appliedSeq`). */
  transport(command: EngineTransport, frame = 0): number {
    const seq = ++this.seq
    if (this.disposed || this.fatal) return seq
    const code = ENGINE_TRANSPORT[command]
    if (this.ring?.push({ command: code, frame, afterSeq: seq - 1, seq })) return seq
    void this.send({ type: 'transport', seq, command: code, frame }).catch(() => undefined)
    return seq
  }

  /** The latest status; the master peak is the highest since the previous call. */
  readStatus(): EngineStatus {
    if (this.reader) this.reader.read(this.status)
    const status = { ...this.status }
    this.status.peak = 0
    return status
  }

  dispose(): void {
    if (this.disposed) return
    void this.send({ type: 'dispose', seq: ++this.seq }).catch(() => undefined)
    this.disposed = true
    this.fail('The engine worklet was disposed')
    try { this.node.disconnect() } catch { /* Already disconnected. */ }
    this.node.port.onmessage = null
  }
}

/** Unread meters: louder peaks, lower gains; a new revision replaces the old graph's. */
function mergeMeters(old: EngineMeters | null, next: EngineMeters): EngineMeters {
  if (!old || old.revision !== next.revision || old.peaks.length !== next.peaks.length) return next
  const peaks = next.peaks.map((p, k) => Math.max(p, old.peaks[k]))
  const dynamics = [...old.dynamics]
  for (const d of next.dynamics) {
    const at = dynamics.findIndex(o => o.track === d.track && o.insert === d.insert)
    if (at < 0) dynamics.push(d)
    else dynamics[at] = { ...d, input: Math.max(d.input, dynamics[at].input), gain: Math.min(d.gain, dynamics[at].gain) }
  }
  return { revision: next.revision, peaks, dynamics }
}

/**
 * Reverb kernels off the audio thread (docs/RUST_ENGINE.md 5.7): a worker with its own engine instance
 * generates them (tens of milliseconds each) and the worklet only imports the data. One per sample rate.
 */
export class KernelHelper {
  private worker: Worker | null = null
  private seq = 0
  private readonly pending = new Map<number, { resolve(kernels: EngineKernel[]): void; reject(error: Error): void }>()
  constructor(private readonly module: WebAssembly.Module, readonly sampleRate: number) {}

  compute(params: Record<string, number>[]): Promise<EngineKernel[]> {
    if (!params.length) return Promise.resolve([])
    if (!this.worker) {
      this.worker = new Worker(new URL('./engineKernel.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (event: MessageEvent<{ seq: number; kernels?: EngineKernel[]; message?: string; engine?: boolean }>) => {
        const pending = this.pending.get(event.data.seq)
        if (!pending) return
        this.pending.delete(event.data.seq)
        if (event.data.kernels) pending.resolve(event.data.kernels)
        else pending.reject(event.data.engine ? new GarakEngineError(event.data.message ?? '') : new Error(event.data.message ?? 'kernel worker failed'))
      }
      this.worker.onerror = event => { for (const [, p] of this.pending) p.reject(new Error(event.message || 'kernel worker failed')); this.pending.clear() }
    }
    const seq = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject })
      this.worker!.postMessage({ seq, module: this.module, sampleRate: this.sampleRate, params })
    })
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
    for (const [, p] of this.pending) p.reject(new Error('kernel worker disposed'))
    this.pending.clear()
  }
}

/** Renders on garak-engine.wasm in a dedicated worker (export, bounce, freeze, stems). Asset buffers are transferred. */
export function renderInEngineWorker(module: WebAssembly.Module, request: EngineRenderRequest): Promise<EngineRenderResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./engineRender.worker.ts', import.meta.url), { type: 'module' })
    const finish = () => worker.terminate()
    worker.onmessage = (event: MessageEvent<{ ok: true; result: EngineRenderResult } | { ok: false; message: string; engine: boolean }>) => {
      finish()
      const data = event.data
      if (data.ok) resolve(data.result)
      else reject(data.engine ? new GarakEngineError(data.message) : new Error(data.message))
    }
    worker.onerror = event => { finish(); reject(new Error(event.message || 'The export worker failed')) }
    const transfer: Transferable[] = request.assets.map(asset => asset.samples.buffer)
    if (typeof request.timeline !== 'string') transfer.push(request.timeline.buffer)
    if (request.binary && request.binary.byteOffset === 0 && request.binary.byteLength === request.binary.buffer.byteLength) transfer.push(request.binary.buffer)
    worker.postMessage({ module, request }, transfer)
  })
}

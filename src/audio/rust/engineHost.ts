/// <reference path="../../devices/guitar-rig/worklet-assets.d.ts" />
// Main-thread side of the Rust engine worklet (docs/RUST_ENGINE.md 5): module loading, the
// AudioWorkletNode bridge (PCM, project.set/patch, transport, status) and the export worker.

import { packAudioBuffer } from '../native/pcmTransfer'
import { GarakEngineError, utf8Encode, type EngineApplied, type EngineTransport, ENGINE_TRANSPORT, ENGINE_ABI_VERSION } from './garakEngineWasm'
import {
  CommandRing, createSharedChannel, emptyStatus, ENGINE_PROCESSOR, StatusReader,
  type EngineProcessorOptions, type EngineReply, type EngineRequest, type EngineStatus, type SharedChannel,
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
    // Checked without instantiating (every instance reserves its own memory): ABI 2 is the first
    // with the planar render export. The worklet still verifies garak_engine_abi_version().
    const exports = new Set(WebAssembly.Module.exports(module).map(entry => entry.name))
    return ENGINE_ABI_VERSION === 2 && exports.has('garak_engine_render_planar') && exports.has('garak_engine_put_asset_owned') ? module : null
  } catch {
    return null
  }
}

let shared: Promise<WebAssembly.Module | null> | null = null
/** The page's garak-engine module, fetched once (only when the flag is on). */
export function sharedGarakEngineModule(): Promise<WebAssembly.Module | null> {
  shared ??= loadGarakEngineModule()
  return shared
}

const registered = new WeakMap<BaseAudioContext, Promise<void>>()
function registerProcessor(context: BaseAudioContext): Promise<void> {
  let task = registered.get(context)
  if (!task) {
    task = import('./engineWorkletUrl').then(({ default: url }) => context.audioWorklet.addModule(url))
    registered.set(context, task)
  }
  return task
}

interface Pending { resolve(reply: { applied?: string; latency: number; tail: number }): void; reject(error: Error): void }

export interface EngineUpdateResult { applied: EngineApplied; latencyFrames: number; tailSeconds: number }

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
  private readonly ring: CommandRing | null
  private fatal: string | null = null
  private disposed = false

  private constructor(readonly context: AudioContext, module: WebAssembly.Module, channel: SharedChannel | null) {
    const quantum = (context as AudioContext & { renderQuantumSize?: number }).renderQuantumSize
    const options: EngineProcessorOptions = { module, maxBlock: Math.max(128, typeof quantum === 'number' ? quantum : 128), shared: channel }
    this.node = new AudioWorkletNode(context, ENGINE_PROCESSOR, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: options })
    this.reader = channel ? new StatusReader(channel.status) : null
    this.ring = channel ? new CommandRing(channel.ring) : null
    this.sharedChannel = !!channel
    this.node.port.onmessage = event => this.receive(event.data as EngineReply)
    this.node.onprocessorerror = () => this.fail('The engine worklet stopped (processor error)')
    this.node.connect(context.destination)
  }

  static async create(context: AudioContext, module: WebAssembly.Module): Promise<RustEngineNode> {
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
      case 'status': Object.assign(this.status, reply.status, { peak: Math.max(this.status.peak, reply.status.peak) }); return
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

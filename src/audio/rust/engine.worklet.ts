import { GarakEngineError, instantiateGarakEngine, type EngineApplied, type GarakEngine } from './garakEngineWasm.js'
import { CommandRing, emptyStatus, ENGINE_PROCESSOR, StatusWriter, type EngineProcessorOptions, type EngineReply, type EngineRequest, type RingCommand } from './engineChannel.js'

declare const sampleRate: number
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
}
declare function registerProcessor(name: string, constructor: typeof AudioWorkletProcessor): void

const TRANSPORT = ['play', 'pause', 'stop', 'seek'] as const
/** Without a SharedArrayBuffer, status is posted every this many quanta (~37 ms at 48 kHz). */
const STATUS_EVERY = 14
/** Retired graphs are freed this many quanta after the last edit (never inside the edit's quantum). */
const COLLECT_AFTER = 8
// AudioWorkletGlobalScope has no `performance` in some engines; Date.now() still averages out over many quanta.
const clock: () => number = typeof performance !== 'undefined' && typeof performance.now === 'function' ? () => performance.now() : () => Date.now()

/**
 * The unified Rust render engine (garak-engine.wasm) as one AudioWorklet node: the whole project —
 * clips, effect chains, sends/returns, automation, master — renders here, the same code the native
 * engine runs (docs/RUST_ENGINE.md 5). Control messages arrive on the port and run between render
 * quanta; `process()` only drains transport commands and renders, which never allocates.
 */
class GarakEngineProcessor extends AudioWorkletProcessor {
  private engine: GarakEngine | null = null
  private readonly ring: CommandRing | null
  private readonly writer: StatusWriter | null
  private readonly status = emptyStatus()
  private appliedSeq = 0
  private pendingPeak = 0
  private sinceStatus = 0
  private collectIn = -1
  private alive = true
  private readonly maxBlock: number

  constructor(options?: unknown) {
    super(options)
    const init = (options as { processorOptions?: EngineProcessorOptions } | undefined)?.processorOptions
    this.maxBlock = Math.max(128, init?.maxBlock ?? 128)
    this.ring = init?.shared ? new CommandRing(init.shared.ring) : null
    this.writer = init?.shared ? new StatusWriter(init.shared.status) : null
    try {
      if (!init || !(init.module instanceof WebAssembly.Module)) throw new Error('garak-engine.wasm was not passed to the worklet')
      this.engine = instantiateGarakEngine(init.module, sampleRate, this.maxBlock, false)
    } catch (error) {
      this.post({ type: 'fatal', message: error instanceof Error ? error.message : String(error) })
    }
    this.port.onmessage = event => this.receive(event.data as EngineRequest)
  }

  private post(reply: EngineReply): void { this.port.postMessage(reply) }

  private receive(message: EngineRequest): void {
    const engine = this.engine
    if (!engine) { this.post({ type: 'error', seq: message.seq, message: 'garak-engine.wasm is not running', engine: false }); return }
    try {
      let applied: EngineApplied | undefined
      switch (message.type) {
        case 'asset':
          // One copy into the module; the transferred buffer is dropped with this message.
          engine.putAsset(message.id, message.sampleRate, message.channels, message.samples)
          break
        case 'remove-asset': engine.removeAsset(message.id); break
        case 'set': applied = engine.set(message.json, message.binary ?? undefined); break
        case 'patch': applied = engine.patch(message.json, message.binary ?? undefined); break
        case 'transport': this.transport(message.command, message.frame); break
        case 'dispose':
          engine.destroy()
          this.engine = null
          this.alive = false
          break
      }
      if (message.type === 'set' || message.type === 'patch' || message.type === 'remove-asset') this.collectIn = COLLECT_AFTER
      this.post({ type: 'ack', seq: message.seq, applied, latency: this.engine?.latencyFrames ?? 0, tail: this.engine?.tailSeconds ?? 0 })
    } catch (error) {
      this.post({ type: 'error', seq: message.seq, message: error instanceof Error ? error.message : String(error), engine: error instanceof GarakEngineError })
    } finally {
      this.appliedSeq = Math.max(this.appliedSeq, message.seq)
    }
  }

  private transport(command: number, frame: number): void {
    const name = TRANSPORT[command]
    if (name) this.engine?.transport(name, frame)
  }

  private readonly applyRing = (command: RingCommand): void => {
    try { this.transport(command.command, command.frame) } catch { /* A full engine queue: the next command retries. */ }
    this.appliedSeq = Math.max(this.appliedSeq, command.seq)
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const engine = this.engine
    const out = outputs[0]
    if (!engine || !out?.length) return this.alive
    this.ring?.drain(this.appliedSeq, this.applyRing)
    const frames = out[0].length
    const began = clock()
    // A render quantum larger than the engine block (renderSizeHint) renders in pieces.
    for (let at = 0; at < frames;) {
      const [left, right] = engine.renderPlanar(Math.min(this.maxBlock, frames - at))
      if (!left.length) break
      out[0].set(left, at)
      out[1]?.set(right, at)
      at += left.length
    }
    const elapsed = clock() - began
    const s = this.status
    s.quanta += 1
    s.renderMs += elapsed
    if (elapsed > s.renderMaxMs) s.renderMaxMs = elapsed
    if (elapsed > frames / sampleRate * 1000) s.budgetMisses += 1
    this.pendingPeak = Math.max(this.pendingPeak, engine.masterPeak)
    if (this.collectIn >= 0 && this.collectIn-- === 0) engine.collect()
    s.frame = engine.frame
    s.playing = engine.playing
    s.appliedSeq = this.appliedSeq
    s.latency = engine.latencyFrames
    if (this.writer) {
      s.peak = this.pendingPeak
      this.pendingPeak = 0
      this.writer.write(s)
    } else if (++this.sinceStatus >= STATUS_EVERY) {
      this.sinceStatus = 0
      s.peak = this.pendingPeak
      this.pendingPeak = 0
      this.post({ type: 'status', status: { ...s } })
    }
    return this.alive
  }
}

registerProcessor(ENGINE_PROCESSOR, GarakEngineProcessor)

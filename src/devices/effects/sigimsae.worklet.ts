import { createKernel, type SigimsaeKernel } from './kernels.js'
import { createRustKernel } from '../../audio/rust/sigimsaeRust.js'
import { KERNEL_TYPES, type KernelType } from './sigimsaeDefs.js'

declare const sampleRate: number
declare const currentTime: number
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
}
declare function registerProcessor(name: string, constructor: typeof AudioWorkletProcessor): void

interface Options { processorOptions?: { type?: string; params?: Record<string, number>; bpm?: number; garakWasm?: unknown } }

/** One processor for every kernel-backed 시김새; the kernel type and first parameters arrive with construction. */
class SigimsaeProcessor extends AudioWorkletProcessor {
  private readonly kernel: SigimsaeKernel
  private readonly left = new Float32Array(128)
  private readonly right = new Float32Array(128)
  private left2 = this.left
  private right2 = this.right
  private disposed = false
  /** Dynamics metering for the device views: off until the main thread asks (~30 Hz posts). */
  private metering = false
  private meterFrames = 0
  private readonly meterValues = new Float32Array(2)
  /** Automation scheduled ahead (docs/AUTOMATION.md): applied at the first block at or after `at`, sorted by time. */
  private pending: { at: number; params: Record<string, number>; bpm: number }[] = []

  constructor(options?: unknown) {
    super(options)
    const init = (options as Options | undefined)?.processorOptions ?? {}
    const type = KERNEL_TYPES.includes(init.type as KernelType) ? init.type as KernelType : 'utility'
    // Rust/WASM kernel when the main thread opted in (docs/RUST.md; off by default), else TypeScript.
    const rust = typeof WebAssembly !== 'undefined' && init.garakWasm instanceof WebAssembly.Module
      ? createRustKernel(init.garakWasm, type, sampleRate, init.params, init.bpm) : null
    this.kernel = rust ?? createKernel(type, sampleRate, init.params, init.bpm)
    this.port.onmessage = event => {
      const data = event.data as { type?: string; params?: Record<string, number>; bpm?: number } | undefined
      if (data?.type === 'dispose') this.disposed = true
      else if (data?.type === 'meter') this.metering = (data as { on?: boolean }).on === true && typeof this.kernel.meter === 'function'
      else if (data?.type === 'params') {
        // A direct edit cancels what was scheduled after it, like AudioParam.cancelScheduledValues.
        const at = (data as { at?: number }).at
        if (typeof at === 'number' && at > currentTime + 1 / sampleRate) this.queue([{ at, params: data.params ?? {}, bpm: data.bpm ?? 120 }])
        else { this.pending = []; this.kernel.configure(data.params, data.bpm ?? 120) }
      } else if (data?.type === 'schedule') {
        const events = (data as { events?: { at: number; params: Record<string, number>; bpm?: number }[] }).events ?? []
        // Each event may carry the tempo at its beat (tempo map); otherwise the message's tempo applies.
        this.queue(events.map(event => ({ at: event.at, params: event.params, bpm: event.bpm ?? data.bpm ?? 120 })))
      }
    }
  }

  private queue(events: { at: number; params: Record<string, number>; bpm: number }[]): void {
    if (!events.length) return
    const first = events[0].at
    // Rescheduling from a time replaces what was queued from that time on.
    this.pending = this.pending.filter(event => event.at < first).concat(events.filter(event => Number.isFinite(event.at)))
    if (this.pending.length > 100_000) this.pending.splice(0, this.pending.length - 100_000)
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.pending.length) {
      let applied = 0
      while (applied < this.pending.length && this.pending[applied].at <= currentTime + 0.5 / sampleRate) applied++
      if (applied) { const event = this.pending[applied - 1]; this.kernel.configure(event.params, event.bpm); this.pending.splice(0, applied) }
    }
    const output = outputs[0]
    if (this.disposed) {
      for (const channel of output) channel.fill(0)
      return false
    }
    const frames = output[0]?.length ?? 0
    if (this.left2.length < frames) { this.left2 = new Float32Array(frames); this.right2 = new Float32Array(frames) }
    const l = this.left2, r = this.right2
    const input = inputs[0] ?? []
    const a = input[0], b = input[1] ?? input[0]
    for (let i = 0; i < frames; i += 1) {
      const x = a?.[i] ?? 0, y = b?.[i] ?? 0
      l[i] = Number.isFinite(x) ? Math.max(-32, Math.min(32, x)) : 0
      r[i] = Number.isFinite(y) ? Math.max(-32, Math.min(32, y)) : 0
    }
    this.kernel.process(l, r, frames)
    if (this.metering && (this.meterFrames += frames) >= sampleRate / 30) {
      this.meterFrames = 0
      this.kernel.meter!(this.meterValues)
      this.port.postMessage({ type: 'meter', input: this.meterValues[0], gain: this.meterValues[1] })
    }
    output[0]?.set(l.subarray(0, frames))
    if (output[1]) output[1].set(r.subarray(0, frames))
    return true
  }
}

registerProcessor('garak-sigimsae-v1', SigimsaeProcessor)

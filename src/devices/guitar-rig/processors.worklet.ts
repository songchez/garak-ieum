import { GuitarCompressor } from './compressor.js'
import { GuitarChorus } from './chorus.js'
import { GuitarMaster } from './master.js'
import { GuitarPhaser, GuitarTremolo } from './modulation.js'
import { createRustRigKernel, type RustRigKernel } from '../../audio/rust/guitarRigRust.js'

declare const sampleRate: number
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
}
declare function registerProcessor(name: string, constructor: typeof AudioWorkletProcessor): void

class CompressorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'sustain', defaultValue: 0.35, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 10, minValue: 0.5, maxValue: 50, automationRate: 'k-rate' },
      { name: 'level', defaultValue: 0, minValue: -18, maxValue: 18, automationRate: 'k-rate' },
      { name: 'enabled', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ]
  }
  private readonly compressor = new GuitarCompressor(sampleRate)
  private disposed = false
  private initialized = false
  private sustain = NaN
  private attack = NaN
  private level = NaN
  private enabled = NaN

  constructor(options?: unknown) {
    super(options)
    this.port.onmessage = event => { if (event.data?.type === 'dispose') this.disposed = true }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean {
    const output = outputs[0]
    if (this.disposed) {
      for (const channel of output) channel.fill(0)
      return false
    }
    const input = inputs[0]
    const sustain = params.sustain[0], attack = params.attack[0], level = params.level[0], enabled = params.enabled[0]
    if (sustain !== this.sustain || attack !== this.attack || level !== this.level || enabled !== this.enabled) {
      this.compressor.configure(sustain, attack, level, enabled >= 0.5, !this.initialized)
      this.sustain = sustain; this.attack = attack; this.level = level; this.enabled = enabled
      this.initialized = true
    }
    if (!input?.length) {
      for (const channel of output) channel.fill(0)
      this.compressor.reset()
      return true
    }
    const frames = output[0]?.length ?? 0
    for (let frame = 0; frame < frames; frame += 1) {
      let peak = 0
      for (let channel = 0; channel < input.length; channel += 1) {
        const value = input[channel][frame]
        if (Number.isFinite(value)) peak = Math.max(peak, Math.abs(value))
      }
      const gain = this.compressor.gain(peak)
      for (let channel = 0; channel < output.length; channel += 1) {
        const source = input[channel] ?? input[0]
        const value = source[frame]
        output[channel][frame] = Number.isFinite(value) ? Math.max(-32, Math.min(32, value)) * gain : 0
      }
    }
    return true
  }
}

class ChorusProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rate', defaultValue: 0.8, minValue: 0.1, maxValue: 5, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0.35, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0.25, minValue: 0, maxValue: 0.6, automationRate: 'k-rate' },
      { name: 'enabled', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ]
  }
  private readonly chorus = new GuitarChorus(sampleRate)
  private disposed = false
  private initialized = false
  constructor(options?: unknown) {
    super(options)
    this.port.onmessage = event => { if (event.data?.type === 'dispose') this.disposed = true }
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean {
    if (this.disposed) {
      for (const channel of outputs[0]) channel.fill(0)
      return false
    }
    this.chorus.configure(params.rate[0], params.depth[0], params.mix[0], params.enabled[0] >= 0.5, !this.initialized)
    this.initialized = true
    this.chorus.process(inputs[0] ?? [], outputs[0])
    return true
  }
}

class PhaserProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rate', defaultValue: 0.45, minValue: 0.05, maxValue: 4, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 0.35, minValue: 0, maxValue: 0.85, automationRate: 'k-rate' },
      { name: 'enabled', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ]
  }
  private readonly phaser = new GuitarPhaser(sampleRate)
  private readonly frame = new Float64Array(2)
  private disposed = false
  private initialized = false
  constructor(options?: unknown) {
    super(options)
    this.port.onmessage = event => { if (event.data?.type === 'dispose') this.disposed = true }
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean {
    const output = outputs[0]
    if (this.disposed) {
      for (const channel of output) channel.fill(0)
      return false
    }
    this.phaser.configure(params.rate[0], params.depth[0], params.feedback[0], params.enabled[0] >= 0.5, !this.initialized)
    this.initialized = true
    const input = inputs[0] ?? []
    const a = input[0], b = input[1] ?? a
    const frames = output[0]?.length ?? 0
    for (let i = 0; i < frames; i += 1) {
      const l = a && Number.isFinite(a[i]) ? Math.max(-32, Math.min(32, a[i])) : 0
      const r = b && Number.isFinite(b[i]) ? Math.max(-32, Math.min(32, b[i])) : 0
      this.phaser.sample(l, r, this.frame)
      output[0][i] = this.frame[0]
      if (output[1]) output[1][i] = this.frame[1]
    }
    return true
  }
}

class TremoloProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rate', defaultValue: 4.5, minValue: 0.5, maxValue: 12, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'shape', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'enabled', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ]
  }
  private readonly tremolo = new GuitarTremolo(sampleRate)
  private disposed = false
  private initialized = false
  constructor(options?: unknown) {
    super(options)
    this.port.onmessage = event => { if (event.data?.type === 'dispose') this.disposed = true }
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean {
    const output = outputs[0]
    if (this.disposed) {
      for (const channel of output) channel.fill(0)
      return false
    }
    this.tremolo.configure(params.rate[0], params.depth[0], params.shape[0], params.enabled[0] >= 0.5, !this.initialized)
    this.initialized = true
    const input = inputs[0] ?? []
    const frames = output[0]?.length ?? 0
    for (let i = 0; i < frames; i += 1) {
      const gain = this.tremolo.gain()
      for (let channel = 0; channel < output.length; channel += 1) {
        const value = (input[channel] ?? input[0])?.[i] ?? 0
        output[channel][i] = Number.isFinite(value) ? Math.max(-32, Math.min(32, value)) * gain : 0
      }
    }
    return true
  }
}

registerProcessor('garak-guitar-compressor-v1', CompressorProcessor)
registerProcessor('garak-guitar-chorus-v1', ChorusProcessor)
registerProcessor('garak-guitar-phaser-v1', PhaserProcessor)
registerProcessor('garak-guitar-tremolo-v1', TremoloProcessor)

class MasterProcessor extends AudioWorkletProcessor {
  private readonly master = new GuitarMaster(sampleRate)
  private disposed = false
  constructor(options?: unknown) {
    super(options)
    this.port.onmessage = event => { if (event.data?.type === 'dispose') this.disposed = true }
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]
    if (this.disposed) {
      for (const channel of output) channel.fill(0)
      return false
    }
    const input = inputs[0]
    const frames = output[0]?.length ?? 0
    for (let frame = 0; frame < frames; frame += 1) {
      let peak = 0
      for (let channel = 0; channel < (input?.length ?? 0); channel += 1) {
        const value = input[channel][frame]
        if (Number.isFinite(value)) peak = Math.max(peak, Math.abs(value))
      }
      const gain = this.master.gain(peak)
      for (let channel = 0; channel < output.length; channel += 1) {
        output[channel][frame] = this.master.sample((input?.[channel] ?? input?.[0])?.[frame] ?? 0, gain)
      }
    }
    return true
  }
}
registerProcessor('garak-guitar-master-v1', MasterProcessor)

/** The worklet's clock (a global of AudioWorkletGlobalScope; absent in unit tests). */
const now = () => (globalThis as { currentTime?: number }).currentTime ?? 0
type Kernels = (Float32Array | null)[]
const kernelList = (value: unknown): Kernels | null => Array.isArray(value) ? value.map(k => k instanceof Float32Array ? k : null) : null

/**
 * The whole rig on the Rust core (src/audio/rust/guitarRigRust.ts): the desktop's garak-dsp rig, so the web
 * sounds the same. Output 0 is the rig (stereo), output 1 the mono signal at the tuner's rack position for
 * the tuner's analyser. Knobs arrive as `params` (applied at `at`, like the 시김새 processor), automation as
 * `schedule`, structural edits (rack layout, reverb Decay / switch) as `rebuild` with plate kernels the main
 * thread prepared. Posts `{ type: 'backend', rust }` once; without a Rust rig it passes audio through and the
 * main thread switches to the Web Audio rig.
 */
class RustRigProcessor extends AudioWorkletProcessor {
  private readonly rig: RustRigKernel | null
  private left = new Float32Array(128)
  private right = new Float32Array(128)
  private tap = new Float32Array(128)
  private disposed = false
  /** Automation and knob edits scheduled ahead: applied at the first block at or after `at`, sorted by time. */
  private pending: { at: number; params: Record<string, number> }[] = []

  constructor(options?: unknown) {
    super(options)
    const init = (options as { processorOptions?: { garakWasm?: unknown; params?: Record<string, number>; kernels?: unknown } } | undefined)?.processorOptions ?? {}
    this.rig = typeof WebAssembly !== 'undefined' && init.garakWasm instanceof WebAssembly.Module
      ? createRustRigKernel(init.garakWasm, sampleRate, init.params, kernelList(init.kernels)) : null
    this.port.postMessage?.({ type: 'backend', rust: !!this.rig, latency: this.rig?.latencyFrames() ?? 0 })
    this.port.onmessage = event => {
      const data = event.data as { type?: string; params?: Record<string, number>; at?: number; kernels?: unknown; events?: { at: number; params: Record<string, number> }[] } | undefined
      if (data?.type === 'dispose') { this.disposed = true; this.pending = []; this.rig?.free() }
      else if (data?.type === 'rebuild') { this.pending = []; this.rig?.rebuild(data.params, kernelList(data.kernels)) }
      else if (data?.type === 'params') {
        // A direct edit cancels what was scheduled after it, like AudioParam.cancelScheduledValues.
        if (typeof data.at === 'number' && data.at > now() + 1 / sampleRate) this.queue([{ at: data.at, params: data.params ?? {} }])
        else { this.pending = []; this.rig?.configure(data.params) }
      } else if (data?.type === 'schedule') this.queue(data.events ?? [])
    }
  }

  private queue(events: { at: number; params: Record<string, number> }[]): void {
    if (!events.length) return
    const first = events[0].at
    // Rescheduling from a time replaces what was queued from that time on.
    this.pending = this.pending.filter(event => event.at < first).concat(events.filter(event => Number.isFinite(event.at)))
    if (this.pending.length > 100_000) this.pending.splice(0, this.pending.length - 100_000)
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0] ?? [], tapOutput = outputs[1]?.[0]
    if (this.disposed) {
      for (const channel of output) channel.fill(0)
      tapOutput?.fill(0)
      return false
    }
    if (this.pending.length) {
      let applied = 0
      while (applied < this.pending.length && this.pending[applied].at <= now() + 0.5 / sampleRate) applied++
      if (applied) { this.rig?.configure(this.pending[applied - 1].params); this.pending.splice(0, applied) }
    }
    const frames = output[0]?.length ?? 0
    if (this.left.length < frames) { this.left = new Float32Array(frames); this.right = new Float32Array(frames); this.tap = new Float32Array(frames) }
    const input = inputs[0] ?? []
    const a = input[0], b = input[1] ?? input[0]
    for (let i = 0; i < frames; i += 1) {
      const x = a?.[i] ?? 0, y = b?.[i] ?? 0
      this.left[i] = Number.isFinite(x) ? Math.max(-32, Math.min(32, x)) : 0
      this.right[i] = Number.isFinite(y) ? Math.max(-32, Math.min(32, y)) : 0
    }
    if (this.rig) this.rig.process(this.left, this.right, frames, this.tap)
    else for (let i = 0; i < frames; i += 1) this.tap[i] = 0.5 * (this.left[i] + this.right[i])
    output[0]?.set(this.left.subarray(0, frames))
    output[1]?.set(this.right.subarray(0, frames))
    tapOutput?.set(this.tap.subarray(0, frames))
    return true
  }
}
registerProcessor('garak-guitar-rig-v1', RustRigProcessor)

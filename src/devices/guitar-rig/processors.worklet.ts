import { GuitarCompressor } from './compressor.js'
import { GuitarChorus } from './chorus.js'
import { GuitarMaster } from './master.js'

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

registerProcessor('garak-guitar-compressor-v1', CompressorProcessor)
registerProcessor('garak-guitar-chorus-v1', ChorusProcessor)

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

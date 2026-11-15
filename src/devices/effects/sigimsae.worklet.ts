import { createKernel, type SigimsaeKernel } from './kernels.js'
import { KERNEL_TYPES, type KernelType } from './sigimsaeDefs.js'

declare const sampleRate: number
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
}
declare function registerProcessor(name: string, constructor: typeof AudioWorkletProcessor): void

interface Options { processorOptions?: { type?: string; params?: Record<string, number>; bpm?: number } }

/** One processor for every kernel-backed 시김새; the kernel type and first parameters arrive with construction. */
class SigimsaeProcessor extends AudioWorkletProcessor {
  private readonly kernel: SigimsaeKernel
  private readonly left = new Float32Array(128)
  private readonly right = new Float32Array(128)
  private left2 = this.left
  private right2 = this.right
  private disposed = false

  constructor(options?: unknown) {
    super(options)
    const init = (options as Options | undefined)?.processorOptions ?? {}
    const type = KERNEL_TYPES.includes(init.type as KernelType) ? init.type as KernelType : 'utility'
    this.kernel = createKernel(type, sampleRate, init.params, init.bpm)
    this.port.onmessage = event => {
      const data = event.data as { type?: string; params?: Record<string, number>; bpm?: number } | undefined
      if (data?.type === 'dispose') this.disposed = true
      else if (data?.type === 'params') this.kernel.configure(data.params, data.bpm ?? 120)
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
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
    output[0]?.set(l.subarray(0, frames))
    if (output[1]) output[1].set(r.subarray(0, frames))
    return true
  }
}

registerProcessor('garak-sigimsae-v1', SigimsaeProcessor)

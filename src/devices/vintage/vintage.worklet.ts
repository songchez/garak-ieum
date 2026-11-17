import { VintageWasm, VINTAGE_EVENT, type VintageInstance } from '../../audio/rust/vintageWasm.js'
import { EventQueue, type TimedEvent, type VintageMessage } from './queue.js'

declare const sampleRate: number
declare const currentTime: number
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
}
declare function registerProcessor(name: string, constructor: typeof AudioWorkletProcessor): void

interface Options { processorOptions?: { module?: unknown; kind?: number; params?: number[]; events?: TimedEvent[] } }

/**
 * One vintage instrument (옥구슬 EP or 한밤 106) per node, rendered by the Rust core in
 * garak-dsp.wasm — the same code the native engine links. Notes, controllers and parameter
 * changes arrive as timed events and are applied sample-accurately inside each render quantum.
 * Without a usable module the node outputs silence (the main thread greys the instrument out).
 */
class VintageProcessor extends AudioWorkletProcessor {
  private instance: VintageInstance | null = null
  private readonly queue = new EventQueue()
  private disposed = false

  constructor(options?: unknown) {
    super(options)
    const init = (options as Options | undefined)?.processorOptions ?? {}
    const dsp = typeof WebAssembly !== 'undefined' && init.module instanceof WebAssembly.Module ? VintageWasm.instantiate(init.module) : null
    this.instance = dsp?.create(init.kind ?? 0, sampleRate, init.params ?? []) ?? null
    for (const event of init.events ?? []) this.queue.push(event)
    this.port.onmessage = event => this.receive(event.data as VintageMessage | undefined)
  }

  private receive(data: VintageMessage | undefined): void {
    if (!data) return
    switch (data.type) {
      case 'events': for (const event of data.events) this.queue.push(event); break
      case 'off': this.queue.off(data.id, data.at); break
      case 'params':
        if (typeof data.at === 'number' && data.at > currentTime + 1 / sampleRate) {
          data.values.forEach((value, param) => this.queue.push({ at: data.at!, kind: VINTAGE_EVENT.param, id: -1, pitch: 0, value, param }))
        } else data.values.forEach((value, index) => this.instance?.setParam(index, value))
        break
      case 'dispose':
        this.disposed = true
        this.instance?.free()
        this.instance = null
        break
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]
    const left = out?.[0]
    if (!left) return !this.disposed
    const right = out[1] ?? left
    const frames = left.length
    const events = this.queue.drain(currentTime, currentTime + frames / sampleRate, sampleRate, frames)
    if (!this.instance) { left.fill(0); right.fill(0); return !this.disposed }
    this.instance.process(left, right, frames, events)
    return !this.disposed
  }
}

registerProcessor('garak-vintage', VintageProcessor)

// Reverb kernels for the engine worklet, off the audio thread (docs/RUST_ENGINE.md 5.7): a helper
// instance of garak-engine.wasm generates the impulse and its FFT partitions (tens of milliseconds
// each); the worklet only imports the data (KernelHelper in engineHost.ts).
import { GarakEngineError, instantiateGarakEngine, type EngineKernel, type GarakEngine } from './garakEngineWasm'

let engine: { rate: number; instance: GarakEngine } | null = null

self.onmessage = (event: MessageEvent<{ seq: number; module: WebAssembly.Module; sampleRate: number; params: Record<string, number>[] }>) => {
  const { seq, module, sampleRate, params } = event.data
  try {
    if (!engine || engine.rate !== sampleRate) {
      engine?.instance.destroy()
      engine = { rate: sampleRate, instance: instantiateGarakEngine(module, sampleRate, 128, true) }
    }
    const kernels: EngineKernel[] = params.map(p => engine!.instance.reverbKernel(p))
    ;(self as unknown as Worker).postMessage({ seq, kernels }, kernels.map(k => k.data.buffer))
  } catch (error) {
    ;(self as unknown as Worker).postMessage({ seq, message: error instanceof Error ? error.message : String(error), engine: error instanceof GarakEngineError })
  }
}

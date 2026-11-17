// Export worker for the Rust engine: renders a timeline with garak-engine.wasm off the main thread
// and transfers the two output channels back (no copy). One request per worker.

import { GarakEngineError } from './garakEngineWasm.js'
import { renderEngineOffline, type EngineRenderRequest } from './engineOffline.js'

interface WorkerRequest { module: WebAssembly.Module; request: EngineRenderRequest }

const scope = self as unknown as { onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null; postMessage(message: unknown, transfer?: Transferable[]): void }

scope.onmessage = (event) => {
  try {
    const result = renderEngineOffline(event.data.module, event.data.request)
    scope.postMessage({ ok: true, result }, [result.left.buffer, result.right.buffer])
  } catch (error) {
    scope.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error), engine: error instanceof GarakEngineError })
  }
}

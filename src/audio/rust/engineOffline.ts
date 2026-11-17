// Offline render on the Rust engine (export, bounce, freeze, stems): the same loop as
// rust/garak-engine/src/offline.rs and native/src/host.cpp `renderStopped`. Pure (no DOM), so the
// export worker (engineRender.worker.ts) and the Node A/B tests run exactly this code.

import { instantiateGarakEngine } from './garakEngineWasm.js'

export interface EngineRenderAsset {
  id: string
  sampleRate: number
  channels: number
  /** Interleaved PCM; transferred to the worker and released once the module has its copy. */
  samples: Float32Array
}

export interface EngineRenderRequest {
  /** The `project.set` timeline (JSON text or UTF-8 bytes) and its binary frame. */
  timeline: string | Uint8Array
  binary?: Uint8Array
  sampleRate: number
  lengthFrames: number
  assets: EngineRenderAsset[]
  /** Replaces the graph's own tail (0…30 s), like render.wav `tailSeconds`. */
  tailSeconds?: number
  /** Frames dropped from the start after plug-in delay compensation. */
  startFrame?: number
  /** Engine block (the C++ host renders offline in 4096-frame blocks). */
  block?: number
}

export interface EngineRenderResult {
  left: Float32Array
  right: Float32Array
  frames: number
  sampleRate: number
  latencyFrames: number
  tailSeconds: number
  /** Wall time of the render loop only (milliseconds), for CPU comparisons. */
  renderMs: number
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

export function renderEngineOffline(module: WebAssembly.Module, request: EngineRenderRequest): EngineRenderResult {
  const block = request.block ?? 4096
  const rate = request.sampleRate
  const engine = instantiateGarakEngine(module, rate, block, true)
  try {
    for (const asset of request.assets) engine.putAsset(asset.id, asset.sampleRate, asset.channels, asset.samples)
    engine.set(request.timeline, request.binary)
    engine.transport('play')
    const latency = engine.latencyFrames
    const tail = Math.min(30, Math.max(0, request.tailSeconds ?? engine.tailSeconds))
    const total = request.lengthFrames + Math.ceil(tail * rate)
    if (!Number.isFinite(total) || total < 1) throw new Error('프로젝트의 내보내기 길이가 올바르지 않습니다.')
    if (total * 4 > 512 * 1024 * 1024) throw new Error('WAV export exceeds 512 MiB')
    const start = Math.min(total - 1, Math.max(0, Math.round(request.startFrame ?? 0)))
    const frames = total - start
    const left = new Float32Array(frames), right = new Float32Array(frames)
    const skip = latency + start
    const began = now()
    let written = 0
    for (let done = 0; done < total + latency;) {
      const count = Math.min(block, total + latency - done)
      const [l, r] = engine.renderPlanar(count)
      const from = done < skip ? Math.min(count, skip - done) : 0
      if (from < count) {
        left.set(l.subarray(from, count), written)
        right.set(r.subarray(from, count), written)
        written += count - from
      }
      done += count
    }
    const renderMs = now() - began
    engine.collect()
    return { left, right, frames, sampleRate: rate, latencyFrames: latency, tailSeconds: tail, renderMs }
  } finally {
    engine.destroy()
  }
}

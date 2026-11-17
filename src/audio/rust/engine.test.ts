import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { instantiateGarakEngine } from './garakEngineWasm'

// The Rust render engine's WASM build (rust/garak-engine-wasm) against the native Rust engine on the
// same project (docs/RUST_ENGINE.md 7). `cargo test -p garak-engine` writes the parity project
// (timeline JSON + PCM) and its native offline render to rust/target/engine-parity/; the module
// comes from `pnpm rust:wasm` (public/wasm/garak-engine.wasm).
// Without either the suite is skipped (CI's rust.yml always builds both and runs it).
const root = new URL('../../../rust/target/', import.meta.url)
// `pnpm rust:wasm` (scripts/rust.mjs) builds it with the `wasm-engine` profile and copies it to public/wasm.
const wasmPath = fileURLToPath(new URL('../../../public/wasm/garak-engine.wasm', import.meta.url))
const dir = new URL('engine-parity/', root)
const files = ['project.json', 'assets.json', 'assets.f32', 'native.f32'].map((f) => fileURLToPath(new URL(f, dir)))
const ready = existsSync(wasmPath) && files.every((f) => existsSync(f))

function floats(path: string): Float32Array {
  const bytes = readFileSync(path)
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

describe.skipIf(!ready)('Rust render engine: WASM vs native', () => {
  it('renders the parity project like the native engine (offline export)', () => {
    const [projectPath, manifestPath, pcmPath, nativePath] = files
    const json = readFileSync(projectPath, 'utf8')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { id: string; sampleRate: number; channels: number; offset: number; count: number }[]
    const pcm = readFileSync(pcmPath)
    const native = floats(nativePath)
    const { sampleRate, lengthFrames } = JSON.parse(json) as { sampleRate: number; lengthFrames: number }

    const block = 4096
    const engine = instantiateGarakEngine(new WebAssembly.Module(readFileSync(wasmPath)), sampleRate, block, true)
    for (const a of manifest) {
      const samples = new Float32Array(pcm.buffer.slice(pcm.byteOffset + a.offset, pcm.byteOffset + a.offset + a.count * 4))
      engine.putAsset(a.id, a.sampleRate, a.channels, samples)
    }
    expect(engine.set(json)).toBe('full')
    engine.transport('play')
    // native/src/host.cpp renderStopped: length + tail (<= 30 s), plug-in delay trimmed.
    const latency = engine.latencyFrames
    const total = lengthFrames + Math.ceil(Math.min(30, engine.tailSeconds) * sampleRate)
    expect(total * 2).toBe(native.length)
    const out = new Float32Array(total * 2)
    let written = 0
    for (let done = 0; done < total + latency;) {
      const frames = Math.min(block, total + latency - done)
      const view = engine.render(frames)
      const skip = done < latency ? Math.min(frames, latency - done) : 0
      out.set(view.subarray(skip * 2, frames * 2), written)
      written += (frames - skip) * 2
      done += frames
    }
    engine.collect()
    engine.destroy()

    let diff = 0
    let peak = 0
    for (let i = 0; i < out.length; i += 1) {
      diff = Math.max(diff, Math.abs(out[i] - native[i]))
      peak = Math.max(peak, Math.abs(native[i]))
    }
    const residualDb = diff > 0 ? 20 * Math.log10(diff) : -Infinity
    console.info(`garak-engine WASM vs native: residual ${diff === 0 ? 'bit-identical' : `${residualDb.toFixed(1)} dBFS`}, peak ${(20 * Math.log10(peak)).toFixed(2)} dBFS`)
    expect(peak).toBeGreaterThan(0.05)
    expect(residualDb).toBeLessThanOrEqual(-90)
  })
})

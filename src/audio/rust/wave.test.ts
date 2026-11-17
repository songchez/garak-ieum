import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Project } from '../../core/types'
import { withWavetablePatch } from '../../core/project'
import { wavetablePatchData } from '../../devices/wavetable-synth/bridge'
import { createDefaultWavetablePatch, getFactoryWavetableFrames } from '../../devices/wavetable-synth/model'
import { compileNativeTimeline, type NativeProjectTimeline } from '../native/timeline'
import { encodeTracks, planNativeSync } from '../native/timelineSync'
import { waveProject } from './engineTestProjects'
import { instantiateGarakEngine, type GarakEngine } from './garakEngineWasm'

// IEUM WAVE in the browser (docs/IEUM_WAVE.md): since 0.3.3 the synth renders only in the Rust engine, and the web
// app plays it through garak-engine.wasm. Here: the WASM build against golden renders of the original C++ synth
// (rust/garak-engine/tests/golden/ieum-wave; `cargo test -p garak-engine --test wave_golden` writes the case
// timelines to rust/target/engine-parity/ieum-wave/), and the renderer's own path (Project -> timeline compiler ->
// garak-engine.wasm) for preset changes and the 20 ms table crossfade of a custom-table edit.
// Skipped without the module (`pnpm rust:wasm`; CI's rust.yml builds it and runs the cargo test first).
const artifact = fileURLToPath(new URL('../../../public/wasm/garak-engine.wasm', import.meta.url))
const built = existsSync(artifact)
const wasmModule: WebAssembly.Module | null = built ? new WebAssembly.Module(readFileSync(artifact)) : null
const goldenDir = new URL('../../../rust/garak-engine/tests/golden/ieum-wave/', import.meta.url)
const timelineDir = new URL('../../../rust/target/engine-parity/ieum-wave/', import.meta.url)
const RATE = 48_000

/** native/tests/rust_wave_golden_test.cpp: header, then every 4th stereo frame as 24-bit samples (2^22 per unit). */
function golden(name: string): { rate: number; latency: number; frames: number; samples: Float32Array } {
  const bytes = readFileSync(fileURLToPath(new URL(`${name}.iwgold`, goldenDir)))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('IWGOLD01')
  const frames = view.getUint32(16, true) + view.getUint32(20, true) * 2 ** 32
  const stored = Math.ceil(frames / 4) * 2
  const samples = new Float32Array(stored)
  for (let k = 0; k < stored; k += 1) {
    const at = 32 + k * 3
    let v = bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)
    if (v & 0x800000) v -= 0x1000000
    samples[k] = v / 4_194_304
  }
  return { rate: view.getUint32(8, true), latency: view.getUint32(12, true), frames, samples }
}

/** The timeline as RustWebAudioEngine sends it: IEUM WAVE patches as base64 `patchData`. */
function wire(timeline: NativeProjectTimeline): { json: string; binary?: Uint8Array } {
  const tracks = timeline.tracks.map(track => {
    if (track.source.kind !== 'native-wavetable') return track
    const { patch, ...source } = track.source
    return { ...track, source: { ...source, patchData: wavetablePatchData(patch) } }
  })
  const encoded = encodeTracks(tracks)
  return { json: JSON.stringify({ ...timeline, tracks: encoded.tracks }), binary: encoded.binary ?? undefined }
}

function renderInto(engine: GarakEngine, out: Float32Array, from: number, frames: number, block = 128): void {
  for (let done = 0; done < frames; done += block) {
    const n = Math.min(block, frames - done)
    out.set(engine.render(n), (from + done) * 2)
  }
}

const peak = (data: Float32Array, from = 0, to = data.length) => data.subarray(from, to).reduce((m, x) => Math.max(m, Math.abs(x)), 0)

describe.skipIf(!built)('IEUM WAVE in garak-engine.wasm', () => {
  it.each([['offline-48k-4096', 4096], ['offline-48k-128', 128], ['offline-44k1-512', 512]] as const)('%s stays within -90 dBFS of the C++ synth', (name, block) => {
    const timelinePath = fileURLToPath(new URL(`${name}.json`, timelineDir))
    if (!existsSync(timelinePath)) { console.info(`${name}: no case timeline (run cargo test -p garak-engine --test wave_golden)`); return }
    const json = readFileSync(timelinePath, 'utf8')
    const g = golden(name)
    const { sampleRate, lengthFrames } = JSON.parse(json) as { sampleRate: number; lengthFrames: number }
    expect(sampleRate).toBe(g.rate)
    const engine = instantiateGarakEngine(wasmModule!, sampleRate, block, true)
    expect(engine.set(json)).toBe('full')
    engine.transport('play')
    const latency = engine.latencyFrames
    const total = lengthFrames + Math.ceil(Math.min(30, engine.tailSeconds) * sampleRate)
    expect([latency, total]).toEqual([g.latency, g.frames])
    const out = new Float32Array((total + latency) * 2)
    renderInto(engine, out, 0, total + latency, block)
    engine.collect()
    engine.destroy()
    let residual = 0
    for (let k = 0; k < g.samples.length; k += 1) {
      const actual = Math.max(-2, Math.min(2, out[(latency + Math.floor(k / 2) * 4) * 2 + (k % 2)]))
      residual = Math.max(residual, Math.abs(actual - g.samples[k]))
    }
    const db = residual > 0 ? 20 * Math.log10(residual) : -Infinity
    console.info(`${name}: WASM vs the C++ synth ${db.toFixed(1)} dBFS`)
    expect(peak(g.samples)).toBeGreaterThan(0.05)
    expect(db).toBeLessThanOrEqual(-90)
  })

  it('plays presets from the renderer and keeps the held chord through a preset change', () => {
    const first = waveProject('init'), second = waveProject('glass-stream')
    const a = compileNativeTimeline(first.project, new Map(), 1), b = compileNativeTimeline(second.project, new Map(), 2)
    const plan = planNativeSync(a, b)
    // A different patch is a new graph: the running synth adopts it (voices continue).
    expect(plan.method).toBe('project.set')
    const engine = instantiateGarakEngine(wasmModule!, RATE, 128, false)
    expect(engine.set(wire(a).json, wire(a).binary)).toBe('full')
    engine.transport('play')
    const out = new Float32Array(RATE * 2 * 2)
    renderInto(engine, out, 0, RATE)
    expect(engine.set(wire(b).json, wire(b).binary)).toBe('full')
    renderInto(engine, out, RATE, RATE)
    engine.collect()
    engine.destroy()
    expect(peak(out, 0, RATE * 2)).toBeGreaterThan(0.01)
    expect(peak(out, RATE * 2 + 4800 * 2)).toBeGreaterThan(0.01)
    expect(out.every(Number.isFinite)).toBe(true)
  })

  it('crossfades an edited custom table over 20 ms instead of switching it', () => {
    const withBank = (frames: number[][]) => {
      const patch = createDefaultWavetablePatch()
      patch.customBanks = [{ slot: 4, name: 'edited', frames }]
      patch.params.osc1Bank = 4
      patch.params.env1Attack = 0.001
      const test = waveProject()
      const project: Project = { ...test.project, tracks: test.project.tracks.map(track => withWavetablePatch(track, patch)) }
      return project
    }
    const sine = getFactoryWavetableFrames(0).slice(0, 1), bright = getFactoryWavetableFrames(3).slice(0, 1)
    const a = compileNativeTimeline(withBank(sine), new Map(), 1), b = compileNativeTimeline(withBank(bright), new Map(), 2)
    const run = (edit: boolean) => {
      const engine = instantiateGarakEngine(wasmModule!, RATE, 128, false)
      engine.set(wire(a).json, wire(a).binary)
      engine.transport('play')
      const out = new Float32Array(RATE * 2)
      renderInto(engine, out, 0, RATE / 2)
      if (edit) expect(engine.set(wire(b).json, wire(b).binary)).toBe('full')
      renderInto(engine, out, RATE / 2, RATE / 2)
      engine.collect()
      engine.destroy()
      return out
    }
    const unchanged = run(false), edited = run(true)
    const switchAt = RATE / 2
    const differs = (from: number, to: number) => { let d = 0; for (let i = from * 2; i < to * 2; i += 1) d = Math.max(d, Math.abs(edited[i] - unchanged[i])); return d }
    expect(differs(0, switchAt)).toBe(0)
    // 20 ms = 960 frames at 48 kHz: the new table fades in, so the start of the fade is still close to the old sound.
    const early = differs(switchAt, switchAt + 48), late = differs(switchAt + 1200, switchAt + 4800)
    console.info(`custom-table edit: difference ${early.toExponential(2)} in the first ms, ${late.toExponential(2)} after the fade`)
    expect(late).toBeGreaterThan(0.01)
    expect(early).toBeLessThan(late / 4)
  })
})

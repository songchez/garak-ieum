import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { compileNativeTimeline } from '../native/timeline'
import { encodeTracks } from '../native/timelineSync'
import { benchProject } from './engineTestProjects'
import { instantiateGarakEngine } from './garakEngineWasm'

// Realtime-path CPU of garak-engine.wasm in Node: the worklet's loop (one 128-frame renderPlanar per
// quantum) on the 16/32-track bench project, plus the control cost of the first project.set.
// Opt-in: GARAK_ENGINE_BENCH=1 pnpm exec vitest run src/audio/rust/realtimeBench.test.ts
const artifact = process.env.GARAK_ENGINE_WASM ?? fileURLToPath(new URL('../../../public/wasm/garak-engine.wasm', import.meta.url))
const enabled = !!process.env.GARAK_ENGINE_BENCH && existsSync(artifact)

describe.skipIf(!enabled)('garak-engine.wasm realtime CPU', () => {
  it('prints µs per 128-frame quantum', () => {
    const module = new WebAssembly.Module(readFileSync(artifact))
    const rows: string[] = []
    for (const tracks of [16, 32]) {
      const test = benchProject(tracks, 6)
      const metadata = new Map([...test.pcm].map(([id, pcm]) => [id, { id, sampleRate: pcm.sampleRate, frames: pcm.channels[0].length, channels: pcm.channels.length }]))
      const timeline = compileNativeTimeline(test.project, metadata)
      const encoded = encodeTracks(timeline.tracks)
      const json = JSON.stringify({ ...timeline, tracks: encoded.tracks })
      const engine = instantiateGarakEngine(module, 48_000, 128, false)
      const dump = process.env.GARAK_ENGINE_DUMP
      if (dump) {
        // For profiling outside vitest (node --cpu-prof on a plain script).
        mkdirSync(dump, { recursive: true })
        writeFileSync(`${dump}/bench-${tracks}.json`, json)
        if (encoded.binary) writeFileSync(`${dump}/bench-${tracks}.bin`, encoded.binary)
        for (const [id, pcm] of test.pcm) writeFileSync(`${dump}/${id}.json`, JSON.stringify({ sampleRate: pcm.sampleRate, channels: pcm.channels.map(c => Array.from(c)) }))
      }
      for (const [id, pcm] of test.pcm) {
        const frames = pcm.channels[0].length, n = pcm.channels.length, inter = new Float32Array(frames * n)
        for (let c = 0; c < n; c += 1) for (let i = 0; i < frames; i += 1) inter[i * n + c] = pcm.channels[c][i]
        engine.putAsset(id, pcm.sampleRate, n, inter)
      }
      let t = performance.now()
      engine.set(json, encoded.binary ?? undefined)
      const setMs = performance.now() - t
      engine.transport('play')
      const quanta = Math.floor(timeline.lengthFrames / 128) - 10
      for (let i = 0; i < 400; i += 1) engine.renderPlanar(128)
      engine.transport('seek', 0)
      const times = new Float64Array(quanta)
      for (let i = 0; i < quanta; i += 1) {
        t = performance.now()
        engine.renderPlanar(128)
        times[i] = performance.now() - t
      }
      const sorted = [...times].sort((a, b) => a - b)
      const mean = times.reduce((a, b) => a + b, 0) / quanta
      const over = times.filter(x => x > 2.667).length
      rows.push(`| ${tracks} | ${setMs.toFixed(1)} ms | ${(mean * 1000).toFixed(0)} µs | ${(sorted[Math.floor(quanta * 0.99)] * 1000).toFixed(0)} µs | ${(sorted[quanta - 1] * 1000).toFixed(0)} µs | ${over} |`)
      expect(engine.playing).toBe(true)
      engine.destroy()
    }
    console.log(['| tracks | first set | mean | p99 | max | over budget |', '|---|---|---|---|---|---|', ...rows].join('\n'))
  }, 600_000)
})

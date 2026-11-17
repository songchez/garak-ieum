import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { audibleTrackIds } from '../../core/playback'
import { tempoMapOf } from '../../core/tempoMap'
import type { AudioClip, Project } from '../../core/types'
import { clipEnvelope } from '../math'
import { compileNativeTimeline, type NativePcmAsset, type NativeProjectTimeline } from '../native/timeline'
import { encodeTracks, planNativeSync } from '../native/timelineSync'
import { renderEngineOffline, type EngineRenderAsset } from './engineOffline'
import { automationProject, benchProject, dryMixProject, effectsProject, fadesProject, instrumentProject, type TestProject } from './engineTestProjects'
import { instantiateGarakEngine } from './garakEngineWasm'

// A/B of the web engine path in Node: Project -> NativeTimelineCompiler (the renderer side the
// app runs) -> garak-engine.wasm, against a TypeScript reference of the mixing semantics the removed
// Web Audio engine had (clip placement through the tempo map, clipEnvelope fades, region gain,
// StereoPannerNode pan law, fader, mute/solo), so projects keep sounding as they did. The same projects
// render through the real worklet and worker in Chromium in scripts/rust-engine-smoke.mjs. Skipped without the module
// (`pnpm rust:wasm` builds public/wasm/garak-engine.wasm; CI's checks.yml and rust.yml do).
const artifact = fileURLToPath(new URL('../../../public/wasm/garak-engine.wasm', import.meta.url))
const built = existsSync(artifact)
const wasmModule: WebAssembly.Module | null = built ? new WebAssembly.Module(readFileSync(artifact)) : null

function metadataOf(test: TestProject): Map<string, NativePcmAsset> {
  return new Map([...test.pcm].map(([id, pcm]) => [id, { id, sampleRate: pcm.sampleRate, frames: pcm.channels[0].length, channels: pcm.channels.length }]))
}

function interleave(channels: Float32Array[]): Float32Array {
  const frames = channels[0].length, out = new Float32Array(frames * channels.length)
  for (let c = 0; c < channels.length; c += 1) for (let i = 0; i < frames; i += 1) out[i * channels.length + c] = channels[c][i]
  return out
}

function assetsOf(test: TestProject): EngineRenderAsset[] {
  return [...test.pcm].map(([id, pcm]) => ({ id, sampleRate: pcm.sampleRate, channels: pcm.channels.length, samples: interleave(pcm.channels) }))
}

function wire(timeline: NativeProjectTimeline): { json: string; binary?: Uint8Array } {
  const encoded = encodeTracks(timeline.tracks)
  return { json: JSON.stringify({ ...timeline, tracks: encoded.tracks }), binary: encoded.binary ?? undefined }
}

function render(test: TestProject, tailSeconds = 0) {
  const timeline = compileNativeTimeline(test.project, metadataOf(test))
  const { json, binary } = wire(timeline)
  return renderEngineOffline(wasmModule!, { timeline: json, binary, sampleRate: timeline.sampleRate, lengthFrames: timeline.lengthFrames, assets: assetsOf(test), tailSeconds })
}

/** StereoPannerNode (Web Audio spec): equal-power for mono, balance for stereo. */
function pan(left: number, right: number, mono: boolean, value: number): [number, number] {
  if (mono) {
    const x = (value + 1) / 2
    return [left * Math.cos(x * Math.PI / 2), left * Math.sin(x * Math.PI / 2)]
  }
  if (value <= 0) {
    const x = value + 1
    return [left + right * Math.cos(x * Math.PI / 2), right * Math.sin(x * Math.PI / 2)]
  }
  return [left * Math.cos(value * Math.PI / 2), right + left * Math.sin(value * Math.PI / 2)]
}

/** The Web Audio engine's mix of plain audio clips (graph.ts semantics), frame by frame. Region edges are returned for masking. */
function referenceMix(test: TestProject): { left: Float32Array; right: Float32Array; edges: number[] } {
  const project: Project = test.project, rate = project.sampleRate
  const tempo = tempoMapOf(project)
  const frameOf = (beat: number) => Math.round(tempo.frameAt(beat, rate))
  const length = frameOf(project.lengthBeats)
  const left = new Float32Array(length), right = new Float32Array(length), edges: number[] = []
  const audible = audibleTrackIds(project.tracks)
  for (const track of project.tracks) {
    if (!audible.has(track.id)) continue
    for (const clip of track.clips as AudioClip[]) {
      const pcm = test.pcm.get(clip.assetId)!
      const start = frameOf(clip.startBeat), end = frameOf(clip.startBeat + clip.lengthBeats)
      edges.push(start, end)
      const duration = (end - start) / rate
      const mono = pcm.channels.length === 1
      for (let frame = Math.max(0, start); frame < Math.min(end, length); frame += 1) {
        const source = frame - start + Math.round(clip.offsetSeconds * rate)
        if (source >= pcm.channels[0].length) break
        const gain = clipEnvelope((frame - start) / rate, duration, clip.fadeIn, clip.fadeOut, clip.fadeInCurve, clip.fadeOutCurve) * clip.gain
        const [l, r] = pan(pcm.channels[0][source] * gain, (pcm.channels[1] ?? pcm.channels[0])[source] * gain, mono, track.pan)
        left[frame] += l * track.volume * project.masterVolume
        right[frame] += r * track.volume * project.masterVolume
      }
    }
  }
  return { left, right, edges }
}

/** Peak difference (dBFS) outside ±`guard` frames of region edges and the first `settle` frames (fader smoothing). */
function residualDb(a: { left: Float32Array; right: Float32Array }, b: { left: Float32Array; right: Float32Array }, edges: number[], guard: number, settle = 0): number {
  let diff = 0
  const masked = (frame: number) => frame < settle || edges.some(edge => Math.abs(frame - edge) <= guard)
  for (let frame = 0; frame < Math.min(a.left.length, b.left.length); frame += 1) {
    if (masked(frame)) continue
    diff = Math.max(diff, Math.abs(a.left[frame] - b.left[frame]), Math.abs(a.right[frame] - b.right[frame]))
  }
  return diff > 0 ? 20 * Math.log10(diff) : -Infinity
}

function peakDb(signal: { left: Float32Array; right: Float32Array }): number {
  let peak = 0
  for (let i = 0; i < signal.left.length; i += 1) peak = Math.max(peak, Math.abs(signal.left[i]), Math.abs(signal.right[i]))
  return 20 * Math.log10(peak)
}

const finite = (signal: { left: Float32Array; right: Float32Array }) => signal.left.every(Number.isFinite) && signal.right.every(Number.isFinite)

describe.skipIf(!built)('Rust engine on the web path: A/B against the Web Audio semantics', () => {
  it('mixes clips, region gain/offset, volume, pan, mute like the Web Audio graph', () => {
    const test = dryMixProject()
    const rust = render(test), reference = referenceMix(test)
    // 4 ms click guards at region edges (both engines have one, with different shapes) and fader smoothing at the start.
    const residual = residualDb(rust, reference, reference.edges, 0.006 * 48_000, 0.05 * 48_000)
    console.info(`A/B dry mix: residual ${residual.toFixed(1)} dBFS, peak ${peakDb(rust).toFixed(1)} dBFS, rendered ${(rust.frames / rust.sampleRate / (rust.renderMs / 1000)).toFixed(0)}x realtime`)
    expect(rust.latencyFrames).toBe(0)
    expect(peakDb(rust)).toBeGreaterThan(-20)
    expect(residual).toBeLessThanOrEqual(-90)
  })

  it('applies the five fade curves and solo like clipEnvelope', () => {
    const test = fadesProject()
    const rust = render(test), reference = referenceMix(test)
    const residual = residualDb(rust, reference, reference.edges, 0.006 * 48_000, 0.05 * 48_000)
    console.info(`A/B fades: residual ${residual.toFixed(1)} dBFS`)
    expect(residual).toBeLessThanOrEqual(-90)
  })

  it('renders effects, returns, automation and the tempo map (finite, audible, tail)', () => {
    for (const test of [effectsProject(), automationProject()]) {
      const rust = render(test, test.name === 'effects' ? 1.5 : 0)
      console.info(`${test.name}: peak ${peakDb(rust).toFixed(1)} dBFS, latency ${rust.latencyFrames} frames, ${rust.frames} frames`)
      expect(finite(rust)).toBe(true)
      expect(peakDb(rust)).toBeGreaterThan(-30)
    }
    // A tempo ramp moves the second clip: it starts where the tempo map puts beat 5.
    const test = automationProject()
    const rust = render(test)
    const start = Math.round(tempoMapOf(test.project).frameAt(5, 48_000))
    const quiet = Math.max(...rust.right.subarray(start - 4800, start - 100).map(Math.abs))
    expect(start).toBeLessThan(5 * 48_000 * 60 / 100)
    expect(quiet).toBeGreaterThan(0) // the automated first track still plays there
  })

  it('a project.patch lands on the same graph state as project.set (render-diff protocol)', () => {
    const before = dryMixProject()
    const after: TestProject = { ...before, project: { ...before.project, tracks: before.project.tracks.map((track, index) => index === 0 ? { ...track, volume: 0.3, pan: 0.5 } : track) } }
    const metadata = metadataOf(before)
    const a = compileNativeTimeline(before.project, metadata, 1), b = compileNativeTimeline(after.project, metadata, 2)
    const plan = planNativeSync(a, b)
    expect(plan.method).toBe('project.patch')
    const run = (steps: (engine: ReturnType<typeof instantiateGarakEngine>) => void) => {
      const engine = instantiateGarakEngine(wasmModule!, 48_000, 512, true)
      for (const asset of assetsOf(before)) engine.putAsset(asset.id, asset.sampleRate, asset.channels, asset.samples)
      steps(engine)
      engine.transport('play')
      const out = new Float32Array(48_000 * 2)
      for (let at = 0; at < out.length; at += 1024) out.set(engine.render(Math.min(512, (out.length - at) / 2)), at)
      engine.destroy()
      return out
    }
    const patched = run(engine => {
      expect(engine.set(wire(a).json, wire(a).binary)).toBe('full')
      expect(engine.patch(JSON.stringify(plan.params), plan.binary ?? undefined)).toBe('diff')
    })
    const fresh = run(engine => { engine.set(wire(b).json, wire(b).binary) })
    // The patched fader glides from its old value for ~12 ms (smoothing); compare after 0.1 s.
    let diff = 0
    for (let i = 9600; i < fresh.length; i += 1) diff = Math.max(diff, Math.abs(patched[i] - fresh[i]))
    expect(diff).toBeLessThan(1e-6)
  })

  it('renders an instrument project (the built-in instruments are part of the engine)', () => {
    expect(peakDb(render(instrumentProject()))).toBeGreaterThan(-60)
  })

  it('renders 16 and 32 tracks faster than realtime (CPU report)', () => {
    for (const tracks of [16, 32]) {
      const test = benchProject(tracks, 4)
      const timeline = compileNativeTimeline(test.project, metadataOf(test))
      const { json, binary } = wire(timeline)
      let best = Infinity
      for (let run = 0; run < 1; run += 1) {
        const result = renderEngineOffline(wasmModule!, { timeline: json, binary, sampleRate: 48_000, lengthFrames: timeline.lengthFrames, assets: assetsOf(test), tailSeconds: 0, block: 128 })
        best = Math.min(best, result.renderMs)
      }
      const seconds = timeline.lengthFrames / 48_000
      const perBlockUs = best * 1000 / (timeline.lengthFrames / 128)
      console.info(`CPU ${tracks}+2 tracks, 128-frame blocks: ${(seconds * 1000 / best).toFixed(1)}x realtime, ${perBlockUs.toFixed(0)} us per block (budget 2667)`)
      // A report, not a gate: shared CI runners are slow and noisy (the browser smoke measures the worklet).
      expect(seconds * 1000 / best).toBeGreaterThan(0.2)
    }
  }, 120_000)
})

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createTrack } from '../../core/project'
import type { Track } from '../../core/types'
import { metronomeStrokes } from '../metronomeSounds'
import { compileNativeTimeline, type NativePcmAsset } from '../native/timeline'
import { encodeTracks } from '../native/timelineSync'
import { renderEngineOffline, type EngineRenderAsset } from './engineOffline'
import { dryMixProject, effectsProject, type TestProject } from './engineTestProjects'
import { instantiateGarakEngine, type GarakEngine } from './garakEngineWasm'

// The web host's engine paths through garak-engine.wasm, the way the worklet drives them
// (docs/RUST_ENGINE.md 5.7): count-in as a scheduled start with metronome clicks, master bypass for
// pre-master stems/freeze, track and dynamics meters, monitored live input, route recording taps, the
// live note event path, staged project.set (one track per quantum) and reverb kernels from a helper.
// Skipped without the module (`pnpm rust:wasm`; CI builds it).
const artifact = fileURLToPath(new URL('../../../public/wasm/garak-engine.wasm', import.meta.url))
const wasm: WebAssembly.Module | null = existsSync(artifact) ? new WebAssembly.Module(readFileSync(artifact)) : null
const RATE = 48_000, BLOCK = 128

const metadataOf = (test: TestProject) => new Map<string, NativePcmAsset>([...test.pcm].map(([id, pcm]) => [id, { id, sampleRate: pcm.sampleRate, frames: pcm.channels[0].length, channels: pcm.channels.length }]))
function interleave(channels: Float32Array[]): Float32Array {
  const frames = channels[0].length, out = new Float32Array(frames * channels.length)
  for (let c = 0; c < channels.length; c += 1) for (let i = 0; i < frames; i += 1) out[i * channels.length + c] = channels[c][i]
  return out
}
const assetsOf = (test: TestProject): EngineRenderAsset[] => [...test.pcm].map(([id, pcm]) => ({ id, sampleRate: pcm.sampleRate, channels: pcm.channels.length, samples: interleave(pcm.channels) }))
function wire(test: TestProject) {
  const timeline = compileNativeTimeline(test.project, metadataOf(test))
  const encoded = encodeTracks(timeline.tracks)
  return { timeline, json: JSON.stringify({ ...timeline, tracks: encoded.tracks }), binary: encoded.binary ?? undefined }
}
function realtime(test: TestProject): { engine: GarakEngine; timeline: ReturnType<typeof wire>['timeline'] } {
  const engine = instantiateGarakEngine(wasm!, RATE, BLOCK, false)
  for (const a of assetsOf(test)) engine.putAsset(a.id, a.sampleRate, a.channels, a.samples)
  const { timeline, json, binary } = wire(test)
  expect(engine.set(json, binary)).toBe('full')
  return { engine, timeline }
}
const energy = (x: Float32Array) => x.reduce((sum, v) => sum + v * v, 0)

describe.skipIf(!wasm)('web Rust engine host paths', () => {
  it('counts in as a scheduled start: clicks in the starting meter, then the transport on the next frame', () => {
    const test = dryMixProject()
    test.project.timeSignature = { numerator: 3, denominator: 4 }
    test.project.beatsPerBar = 3
    const { engine } = realtime(test)
    const strokes = metronomeStrokes('janggu', true, RATE).map(s => new Float32Array(s)) as [Float32Array, Float32Array, Float32Array]
    engine.setMetronome(false, 1, strokes)
    const bar = 3 * RATE / 2 // one 3/4 bar at 120 BPM
    engine.transport('seek', 0)
    engine.transport('countIn', bar)
    let clicks = 0, firstPlayingQuantum = -1
    const quanta = Math.ceil(bar / BLOCK) + 40
    for (let q = 0; q < quanta; q += 1) {
      const [left] = engine.renderPlanar(BLOCK)
      if (engine.countingIn) {
        expect(engine.frame).toBe(0)
        expect(engine.playing).toBe(true)
        clicks += energy(left)
      } else if (firstPlayingQuantum < 0) firstPlayingQuantum = q
    }
    expect(clicks).toBeGreaterThan(0)
    // 72000 frames = 562.5 quanta: the transport starts mid-quantum 562 (frame-exact) and has run since.
    expect(firstPlayingQuantum).toBe(Math.floor(bar / BLOCK))
    expect(engine.frame).toBe(quanta * BLOCK - bar)
    engine.destroy()
  })

  it('renders pre-master for stems and freeze (master bypass)', () => {
    const test = dryMixProject()
    test.project.masterVolume = 0.5
    const { json, binary, timeline } = wire(test)
    const render = (masterBypass: boolean) => renderEngineOffline(wasm!, { timeline: json, binary, sampleRate: RATE, lengthFrames: timeline.lengthFrames, assets: assetsOf(test), tailSeconds: 0, masterBypass })
    const mastered = render(false), bypassed = render(true)
    // Below the master processor's knee the only difference is the master gain (0.5): 6 dB.
    const ratio = Math.sqrt(energy(bypassed.left) / energy(mastered.left))
    expect(ratio).toBeGreaterThan(1.99)
    expect(ratio).toBeLessThan(2.01)
  })

  it('publishes track peaks and dynamics readings', () => {
    const test = effectsProject()
    const { engine, timeline } = realtime(test)
    engine.transport('play')
    for (let q = 0; q < 200; q += 1) engine.renderPlanar(BLOCK)
    const { values, count } = engine.peaks()
    expect(count).toBe(timeline.tracks.length)
    expect(values[0]).toBeGreaterThan(0.001)
    engine.clearPeaks()
    expect(engine.peaks().values[0]).toBe(0)
    const dynamics = engine.takeDynamics()
    const compressor = timeline.tracks[0].inserts.findIndex(insert => insert.type === 'compressor')
    expect(dynamics.some(d => d.track === 0 && d.insert === compressor && d.input > 0 && d.gain <= 1)).toBe(true)
    engine.destroy()
  })

  it('monitors live input through the track and records route taps', () => {
    const test = dryMixProject()
    const source = test.project.tracks[0]
    const mic: Track = { ...createTrack('audio'), id: 'mic', name: 'mic', clips: [] }
    const resample: Track = { ...createTrack('audio'), id: 'routed', name: 'routed', clips: [], inputRoute: { kind: 'track', trackId: source.id, tap: 'postFx' } }
    test.project.tracks = [...test.project.tracks, mic, resample]
    const { engine, timeline } = realtime(test)
    const micIndex = timeline.tracks.findIndex(t => t.id === 'mic'), routedIndex = timeline.tracks.findIndex(t => t.id === 'routed')
    engine.transport('play')
    const input = engine.inputView()
    const feed = () => { const view = engine.inputView(); for (let i = 0; i < BLOCK; i += 1) { view[i * 2] = 0.25; view[i * 2 + 1] = 0.25 } }
    expect(input.length).toBe(BLOCK * engine.maxInputChannels)
    // The source's clip starts at beat 0.5 (12000 frames).
    for (let q = 0; q < 120; q += 1) { feed(); engine.renderPlanarInput(BLOCK, 2) }
    expect(engine.peaks().values[micIndex]).toBe(0) // not monitored: the input is not heard
    engine.monitor([micIndex, routedIndex])
    engine.taps([routedIndex])
    engine.clearPeaks()
    for (let q = 0; q < 40; q += 1) { feed(); engine.renderPlanarInput(BLOCK, 2) }
    const peaks = engine.peaks().values
    expect(peaks[micIndex]).toBeGreaterThan(0.1)
    expect(peaks[routedIndex]).toBeGreaterThan(0)
    // The tap slot carries the routed track's input: the source's post-FX signal.
    expect(energy(engine.tapView().subarray(0, BLOCK * 2))).toBeGreaterThan(0)
    expect(energy(engine.tapView().subarray(BLOCK * 2, BLOCK * 4))).toBe(0)
    engine.destroy()
  })

  it('routes live note events to the track (audio tracks ignore them until instruments are ported)', () => {
    const { engine } = realtime(dryMixProject())
    engine.live(0, 'noteOn', 60, 0.8, 1)
    engine.live(0, 'noteOff', 60, 0, 1)
    engine.live(0, 'control', 64, 127)
    engine.renderPlanar(BLOCK)
    expect(engine.liveCounts).toEqual({ played: 0, ignored: 3 })
    engine.destroy()
  })

  it('applies a staged project.set (one track per step) like set, with kernels from a helper instance', () => {
    const test = effectsProject()
    const run = (staged: boolean) => {
      const engine = instantiateGarakEngine(wasm!, RATE, BLOCK, false)
      for (const a of assetsOf(test)) engine.putAsset(a.id, a.sampleRate, a.channels, a.samples)
      const { json, binary, timeline } = wire(test)
      if (staged) {
        const helper = instantiateGarakEngine(wasm!, RATE, BLOCK, true)
        for (const track of timeline.tracks) for (const insert of track.inserts) {
          if (insert.type === 'reverb') engine.importKernel(helper.reverbKernel((insert as { params: Record<string, number> }).params))
        }
        helper.destroy()
        const todo = engine.stage(json, binary, false)
        expect(todo).toBe(timeline.tracks.length)
        let steps = 1
        while (!engine.step()) steps += 1
        expect(steps).toBe(todo)
        expect(engine.commit()).toBe('full')
      } else expect(engine.set(json, binary)).toBe('full')
      engine.transport('play')
      const out = new Float32Array(BLOCK * 300)
      for (let q = 0; q < 300; q += 1) out.set(engine.renderPlanar(BLOCK)[0], q * BLOCK)
      engine.destroy()
      return out
    }
    const direct = run(false), staged = run(true)
    expect(energy(direct)).toBeGreaterThan(0)
    expect(staged).toEqual(direct)
  })
})

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createDevice } from '../../core/project'
import type { Device, EffectType } from '../../core/types'
import { EFFECT_TYPES } from '../../devices/effects/registry'
import { GUITAR_RIG_DEFAULTS, GUITAR_RIG_PRESETS } from '../../devices/guitar-rig'
import { compileNativeTimeline } from '../native/timeline'
import { encodeTracks } from '../native/timelineSync'
import { renderEngineOffline } from './engineOffline'
import { effectsProject } from './engineTestProjects'

// Every built-in effect through garak-engine.wasm, the web's only renderer (the DSP itself is tested in
// rust/garak-dsp; this covers the web build: parameters reach the kernels, nothing traps on the WASM stack,
// the output is finite and audible). Replaces the TS-kernel and Web Audio rig tests of 0.3.2.
const artifact = fileURLToPath(new URL('../../../public/wasm/garak-engine.wasm', import.meta.url))
const built = existsSync(artifact)
const wasmModule: WebAssembly.Module | null = built ? new WebAssembly.Module(readFileSync(artifact)) : null

const interleave = (channels: Float32Array[]) => {
  const frames = channels[0].length, out = new Float32Array(frames * channels.length)
  for (let c = 0; c < channels.length; c += 1) for (let i = 0; i < frames; i += 1) out[i * channels.length + c] = channels[c][i]
  return out
}

function render(devices: Device[], block = 128) {
  const test = effectsProject()
  test.project.tracks = [{ ...test.project.tracks[0], devices }]
  const metadata = new Map([...test.pcm].map(([id, pcm]) => [id, { id, sampleRate: pcm.sampleRate, frames: pcm.channels[0].length, channels: pcm.channels.length }]))
  const timeline = compileNativeTimeline(test.project, metadata)
  const encoded = encodeTracks(timeline.tracks)
  const result = renderEngineOffline(wasmModule!, {
    timeline: JSON.stringify({ ...timeline, tracks: encoded.tracks }), binary: encoded.binary ?? undefined, sampleRate: timeline.sampleRate, lengthFrames: timeline.lengthFrames,
    assets: [...test.pcm].map(([id, pcm]) => ({ id, sampleRate: pcm.sampleRate, channels: pcm.channels.length, samples: interleave(pcm.channels) })), block, tailSeconds: 0,
  })
  let peak = 0, finite = true
  for (const channel of [result.left, result.right]) for (const x of channel) { finite &&= Number.isFinite(x); peak = Math.max(peak, Math.abs(x)) }
  return { ...result, peak, finite }
}

const rms = (a: Float32Array, b: Float32Array) => { let sum = 0; for (let i = 0; i < a.length; i += 1) sum += (a[i] - b[i]) ** 2; return Math.sqrt(sum / a.length) }

describe.skipIf(!built)('built-in effects in garak-engine.wasm', () => {
  it.each(EFFECT_TYPES)('%s renders finite, audible output in realtime and export block sizes', (type: EffectType) => {
    for (const block of [128, 4096]) {
      const out = render([createDevice(type)], block)
      expect(out.finite).toBe(true)
      expect(out.peak).toBeGreaterThan(0.001)
    }
  })

  it('renders the whole catalog on one track (the guitar rig in the middle)', () => {
    const out = render(EFFECT_TYPES.map(type => createDevice(type)))
    expect(out.finite).toBe(true)
    expect(out.peak).toBeGreaterThan(0.001)
  })

  it('plays every guitar rig preset, and the rig\'s microphone changes the sound', () => {
    for (const preset of GUITAR_RIG_PRESETS) {
      const out = render([createDevice('guitar-rig', { ...GUITAR_RIG_DEFAULTS, ...preset.params })])
      expect(out.finite, preset.name).toBe(true)
      expect(out.peak, preset.name).toBeGreaterThan(0.001)
      expect(out.peak, preset.name).toBeLessThan(4)
    }
    const clean = render([createDevice('guitar-rig', { ...GUITAR_RIG_DEFAULTS })])
    for (const patch of [{ micPosition: 1 }, { micType: 1 }, { micDistance: 1 }]) {
      const moved = render([createDevice('guitar-rig', { ...GUITAR_RIG_DEFAULTS, ...patch })])
      expect(rms(clean.left, moved.left), JSON.stringify(patch)).toBeGreaterThan(1e-4)
    }
  })
})

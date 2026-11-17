// Deterministic projects for the Rust engine A/B tests (engineAB.test.ts in Node, and
// scripts/rust-engine-smoke.mjs in Chromium against the Web Audio engine). Test support only: the
// app never imports this file.

import { createDevice, createEmptyProject, createTrack, withWavetablePatch } from '../../core/project'
import type { AudioClip, Project, Track } from '../../core/types'
import { createDefaultWavetablePatch } from '../../devices/wavetable-synth/model'
import { getWavetablePreset } from '../../devices/wavetable-synth/presets'

/** Planar PCM by asset id (a Node test has no AudioBuffer; the browser builds one from this). */
export type TestPcm = Map<string, { sampleRate: number; channels: Float32Array[] }>

export interface TestProject { name: string; project: Project; pcm: TestPcm; note: string }

/** Sums of sines plus a little noise, decaying every half second: only arithmetic, same everywhere. */
export function syntheticPcm(seconds: number, sampleRate: number, channels: number, seed: number, level = 0.2): Float32Array[] {
  const frames = Math.round(seconds * sampleRate)
  return Array.from({ length: channels }, (_, c) => {
    const data = new Float32Array(frames)
    let noise = (seed * 7919 + c * 104729 + 1) >>> 0
    const f1 = 110 * (1 + ((seed + c) % 5) * 0.25), f2 = 1760 / (1 + (seed % 3))
    for (let i = 0; i < frames; i += 1) {
      const t = i / sampleRate
      noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0
      data[i] = level * Math.exp(-(t % 0.5) * 4) * (Math.sin(2 * Math.PI * f1 * t) + 0.4 * Math.sin(2 * Math.PI * f2 * t) + 0.1 * (noise / 2147483648 - 1))
    }
    return data
  })
}

let ids = 0
const id = (prefix: string) => `${prefix}-${++ids}`

function audioClip(assetId: string, startBeat: number, lengthBeats: number, extra: Partial<AudioClip> = {}): AudioClip {
  return { id: id('clip'), name: assetId, kind: 'audio', assetId, startBeat, lengthBeats, gain: 1, offsetSeconds: 0, fadeIn: 0, fadeOut: 0, ...extra } as AudioClip
}

function audioTrack(name: string, clips: AudioClip[], extra: Partial<Track> = {}): Track {
  return { ...createTrack('audio'), id: id('track'), name, clips, ...extra }
}

function base(name: string, bpm = 120, lengthBeats = 8): Project {
  return { ...createEmptyProject(), id: id('project'), name, bpm, lengthBeats, masterVolume: 1, loop: { enabled: false, startBeat: 0, endBeat: lengthBeats } }
}

/**
 * Clip placement, region gain/offset, track volume, pan (mono equal-power and stereo balance), mute and
 * solo, at levels below the master processor's knee (it is then exactly transparent in both engines).
 */
export function dryMixProject(): TestProject {
  const rate = 48_000
  const pcm: TestPcm = new Map([
    ['mono', { sampleRate: rate, channels: syntheticPcm(4, rate, 1, 1, 0.12) }],
    ['stereo', { sampleRate: rate, channels: syntheticPcm(4, rate, 2, 2, 0.12) }],
  ])
  const project = base('A/B dry mix')
  project.tracks = [
    audioTrack('mono panned', [audioClip('mono', 0.5, 6, { gain: 0.8 })], { volume: 0.9, pan: -0.6 }),
    audioTrack('stereo balanced', [audioClip('stereo', 1, 5, { offsetSeconds: 0.25 })], { volume: 0.5, pan: 0.4 }),
    audioTrack('muted', [audioClip('mono', 0, 8)], { mute: true }),
    audioTrack('second clip', [audioClip('stereo', 4, 3, { gain: 0.6 })], { volume: 0.7 }),
  ]
  return { name: 'dry-mix', project, pcm, note: 'clips, region gain/offset, volume, pan, mute' }
}

/** Long fades of every curve and a crossfade-free gap, plus a soloed track. */
export function fadesProject(): TestProject {
  const rate = 48_000
  const pcm: TestPcm = new Map([['a', { sampleRate: rate, channels: syntheticPcm(4, rate, 2, 3, 0.15) }]])
  const project = base('A/B fades')
  const curves = ['linear', 'equalPower', 'sCurve', 'exponential', 'logarithmic'] as const
  project.tracks = [
    ...curves.map((curve, index) => audioTrack(`fade ${curve}`, [audioClip('a', index * 0.25, 6, { fadeIn: 0.8, fadeOut: 1.2, fadeInCurve: curve, fadeOutCurve: curve })], { volume: 0.3, solo: index < 3 })),
  ]
  return { name: 'fades', project, pcm, note: 'fade curves, solo' }
}

/** Every common built-in effect on one track, sends into two returns (reverb, delay). */
export function effectsProject(): TestProject {
  const rate = 48_000
  const pcm: TestPcm = new Map([['a', { sampleRate: rate, channels: syntheticPcm(4, rate, 2, 4, 0.2) }]])
  const project = base('A/B effects')
  const reverb = { ...createTrack('return'), id: id('return'), name: 'reverb', devices: [createDevice('reverb', { amount: 1, size: 0.5 })] }
  const delay = { ...createTrack('return'), id: id('return'), name: 'delay', devices: [createDevice('delay', { amount: 1 })] }
  project.tracks = [
    audioTrack('chain', [audioClip('a', 0, 6)], {
      volume: 0.6,
      devices: [createDevice('eq', { low: 3, high: -2 }), createDevice('filter', { cutoff: 8000 }), createDevice('compressor', { threshold: -20, ratio: 3 }), createDevice('drive', { drive: 6, mix: 0.5 }), createDevice('chorus', {})],
      sends: [{ returnId: reverb.id, level: 0.4 }, { returnId: delay.id, level: 0.3, pre: true }],
    }),
    reverb, delay,
  ]
  return { name: 'effects', project, pcm, note: 'eq, filter, compressor, drive, chorus, reverb/delay returns' }
}

/** Track volume and pan automation, and a tempo ramp moving the second clip. */
export function automationProject(): TestProject {
  const rate = 48_000
  const pcm: TestPcm = new Map([['a', { sampleRate: rate, channels: syntheticPcm(5, rate, 1, 5, 0.15) }]])
  const project = base('A/B automation', 100, 8)
  project.tempoMap = [{ beat: 0, bpm: 100, curve: 'ramp' }, { beat: 4, bpm: 140, curve: 'step' }]
  project.tracks = [
    audioTrack('automated', [audioClip('a', 0, 7)], {
      automation: [
        { id: id('lane'), target: { kind: 'track', param: 'volume' }, points: [{ beat: 0, value: 0.2 }, { beat: 6, value: 0.45 }] },
        { id: id('lane'), target: { kind: 'track', param: 'pan' }, points: [{ beat: 0, value: 0.1 }, { beat: 6, value: 0.9 }] },
      ],
    } as Partial<Track>),
    audioTrack('after the ramp', [audioClip('a', 5, 2)], { volume: 0.5 }),
  ]
  return { name: 'automation', project, pcm, note: 'volume/pan automation, tempo ramp' }
}

/** A built-in synth track (the engine renders built-in instruments since the instrument port). */
export function instrumentProject(): TestProject {
  const project = base('A/B instrument')
  const track = { ...createTrack('instrument', 'keys'), id: id('track') }
  track.clips = [{ id: id('clip'), name: 'notes', kind: 'midi', startBeat: 0, lengthBeats: 4, gain: 1, notes: [{ id: id('note'), pitch: 60, start: 0, duration: 2, velocity: 0.8 }] } as unknown as Track['clips'][number]]
  project.tracks = [track]
  return { name: 'instrument', project, pcm: new Map(), note: 'built-in synth' }
}

/**
 * IEUM WAVE (docs/IEUM_WAVE.md): a held chord and a melody on one WAVE track (fixed project and track ids, so a preset change
 * edits the same track: the engine crossfades its table sets over 20 ms). `preset`: a WAVE_PRESETS id, else
 * the default patch. The synth exists only in the engine (no Web Audio fallback).
 */
export function waveProject(preset?: string): TestProject {
  const project = { ...base('IEUM WAVE', 120, 8), id: 'wave-project' }
  const patch = preset ? getWavetablePreset(preset) : createDefaultWavetablePatch()
  const track = { ...withWavetablePatch(createTrack('instrument', 'wavetable'), patch), id: 'wave-track', name: 'IEUM WAVE' }
  const notes = [
    ...[48, 55, 64].map(pitch => ({ id: `wave-chord-${pitch}`, pitch, start: 0, duration: 7.5, velocity: 0.8 })),
    ...[72, 74, 76, 79, 76, 74].map((pitch, k) => ({ id: `wave-melody-${k}`, pitch, start: 0.5 + k, duration: 0.75, velocity: 0.7 })),
  ]
  track.clips = [{ id: 'wave-clip', name: 'wave', kind: 'midi', startBeat: 0, lengthBeats: 8, gain: 1, notes } as unknown as Track['clips'][number]]
  project.tracks = [track]
  return { name: 'wave', project, pcm: new Map(), note: `IEUM WAVE (${preset ?? 'default patch'})` }
}

/**
 * A sampled instrument (the 808 kit): the web host decodes its sample set and sends it to the engine
 * (`samples.register`, like the desktop host), so it plays on the engine.
 */
export function sampledProject(): TestProject {
  const project = base('A/B sampled kit')
  const track = { ...createTrack('instrument', 'kit-808'), id: id('track') }
  const notes = [36, 38, 42, 38].map((pitch, k) => ({ id: id('note'), pitch, start: k, duration: 0.5, velocity: 0.9 }))
  track.clips = [{ id: id('clip'), name: 'beat', kind: 'midi', startBeat: 0, lengthBeats: 4, gain: 1, notes } as unknown as Track['clips'][number]]
  project.tracks = [track]
  return { name: 'sampled', project, pcm: new Map(), note: 'sampled kit (sample set registered with the engine)' }
}

/**
 * The CPU benchmark shape of native/tests/rust_engine_bench.cpp: `tracks` audio tracks with 2-3
 * effects each (phaser/chorus, oversampled drive, delay) and two returns (reverb, delay).
 */
export function benchProject(tracks: number, seconds = 10): TestProject {
  const rate = 48_000
  const pcm: TestPcm = new Map([0, 1, 2, 3].map(k => [`bench-${k}`, { sampleRate: rate, channels: syntheticPcm(Math.min(4, seconds), rate, k % 2 ? 2 : 1, 10 + k, 0.05) }]))
  const bpm = 120, lengthBeats = seconds * bpm / 60
  const project = base(`bench ${tracks}`, bpm, lengthBeats)
  const reverb = { ...createTrack('return'), id: id('return'), name: 'reverb', devices: [createDevice('reverb', { amount: 1 })] }
  const delay = { ...createTrack('return'), id: id('return'), name: 'delay', devices: [createDevice('delay', { amount: 1 })] }
  const clipBeats = Math.min(4, seconds) * bpm / 60
  project.tracks = [
    ...Array.from({ length: tracks }, (_, k) => audioTrack(`bench ${k}`,
      Array.from({ length: Math.ceil(lengthBeats / clipBeats) }, (_, n) => audioClip(`bench-${k % 4}`, n * clipBeats, Math.min(clipBeats, lengthBeats - n * clipBeats))), {
        volume: 0.5, pan: ((k % 5) - 2) / 4,
        devices: [createDevice(k % 2 ? 'chorus' : 'phaser', {}), createDevice('drive', { drive: 4, mix: 0.4 }), ...(k % 3 === 0 ? [createDevice('delay', { amount: 0.2 })] : [])],
        sends: [{ returnId: reverb.id, level: 0.2 }, { returnId: delay.id, level: 0.1, pre: k % 2 === 0 }],
      })),
    reverb, delay,
  ]
  return { name: `bench-${tracks}`, project, pcm, note: `${tracks} tracks + 2 returns` }
}

export const abProjects = (): TestProject[] => [dryMixProject(), fadesProject(), effectsProject(), automationProject()]

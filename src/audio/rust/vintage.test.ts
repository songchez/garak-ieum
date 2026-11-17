import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { VintageWasm, VINTAGE_EVENT, type VintageEvent } from './vintageWasm'
import { HANBAM_106_ID, OKGU_EP_ID, VINTAGE_KIND, VINTAGE_PARAMS, type VintageInstrumentId } from '../../devices/vintage/params'
import { VINTAGE_PRESETS, presetParams } from '../../devices/vintage/presets'
import { EventQueue } from '../../devices/vintage/queue'

// The vintage instruments through garak-dsp.wasm (`pnpm rust:wasm`; CI's rust.yml always builds it).
// The parity scene mirrors parity_scene in rust/garak-dsp/src/instruments/mod.rs and
// native/tests/rust_instrument_test.cpp: all three must hash to rust/garak-dsp/src/instruments/
// parity.golden, which makes the browser and the native engine bit-identical.
const artifact = fileURLToPath(new URL('../../../public/wasm/garak-dsp.wasm', import.meta.url))
const golden = fileURLToPath(new URL('../../../rust/garak-dsp/src/instruments/parity.golden', import.meta.url))
const built = existsSync(artifact)
const dsp = built ? VintageWasm.instantiate(readFileSync(artifact)) : null
const RATE = 48_000
const FRAMES = 96_000

interface Timed { frame: number; e: VintageEvent }

function sceneEvents(id: VintageInstrumentId): Timed[] {
  const list: Timed[] = []
  const ev = (kind: number, eventId: number, pitch: number, value: number, param: number): VintageEvent => ({ offset: 0, kind, id: eventId, pitch, value, param })
  for (let i = 0; i < 12; i += 1) {
    const pitch = 36 + (i * 7) % 40
    list.push({ frame: i * 3001, e: ev(VINTAGE_EVENT.noteOn, i, pitch, Math.fround(0.3 + 0.05 * i), 0) })
    list.push({ frame: i * 3001 + 9000, e: ev(VINTAGE_EVENT.noteOff, i, pitch, 0, 0) })
  }
  list.push({ frame: 20_000, e: ev(VINTAGE_EVENT.controller, -1, 0, 0.75, 129) })
  list.push({ frame: 25_000, e: ev(VINTAGE_EVENT.controller, -1, 0, 0.5, 1) })
  list.push({ frame: 30_000, e: ev(VINTAGE_EVENT.controller, -1, 0, 1, 64) })
  list.push({ frame: 50_000, e: ev(VINTAGE_EVENT.controller, -1, 0, 0, 64) })
  list.push({ frame: 40_000, e: ev(VINTAGE_EVENT.param, -1, 0, VINTAGE_PARAMS[id][0].max, 0) })
  list.push({ frame: 60_000, e: ev(VINTAGE_EVENT.controller, -1, 0, 0.6, 7) })
  return list.sort((a, b) => a.frame - b.frame)
}

const SCENE_PARAMS: Record<VintageInstrumentId, Record<string, number>> = {
  [OKGU_EP_ID]: { bark: 0.8, tremDepth: 0.6, autopan: 0.7, drive: 0.4, tremRate: 5.5 },
  [HANBAM_106_ID]: { pulse: 0.6, noise: 0.1, resonance: 0.6, chorus: 3, glide: 0.05, voices: 4, lfoFilter: 0.2, vibrato: 0.3, lfoDelay: 0.2 },
}

function fnv(l: Float32Array, r: Float32Array, frames: number, state: { h: bigint }): void {
  const bits = new Uint32Array(1), f = new Float32Array(bits.buffer)
  for (let i = 0; i < frames; i += 1) {
    for (const v of [l[i], r[i]]) {
      f[0] = v
      state.h ^= BigInt(bits[0])
      state.h = (state.h * 0x100000001b3n) & 0xffffffffffffffffn
    }
  }
}

function renderScene(id: VintageInstrumentId, block: number): bigint {
  const params = VINTAGE_PARAMS[id].map(def => SCENE_PARAMS[id][def.id] ?? def.default)
  const inst = dsp!.create(VINTAGE_KIND[id], RATE, params)!
  const events = sceneEvents(id)
  const l = new Float32Array(block), r = new Float32Array(block)
  const state = { h: 0xcbf29ce484222325n }
  let next = 0
  for (let at = 0; at < FRAMES; at += block) {
    const n = Math.min(block, FRAMES - at)
    const blockEvents: VintageEvent[] = []
    while (next < events.length && events[next].frame < at + n) { blockEvents.push({ ...events[next].e, offset: events[next].frame - at }); next += 1 }
    inst.process(l, r, n, blockEvents)
    fnv(l, r, n, state)
  }
  inst.free()
  return state.h
}

function goldenSums(): Map<string, bigint> {
  return new Map(readFileSync(golden, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
    const [id, hex] = line.trim().split(/\s+/)
    return [id, BigInt(`0x${hex}`)]
  }))
}

describe.skipIf(!built)('vintage instruments in garak-dsp.wasm', () => {
  it('exposes the same parameter catalogs as src/devices/vintage/params.ts', () => {
    for (const id of [OKGU_EP_ID, HANBAM_106_ID] as const) {
      const rust = dsp!.paramDefs(VINTAGE_KIND[id])
      expect(rust.map(def => def.id)).toEqual(VINTAGE_PARAMS[id].map(def => def.id))
      for (const [i, def] of VINTAGE_PARAMS[id].entries()) {
        expect([rust[i].default, rust[i].min, rust[i].max], def.id).toEqual([def.default, def.min, def.max])
        for (const option of def.options ?? []) expect(option.value >= def.min && option.value <= def.max, `${def.id} option`).toBe(true)
      }
    }
  })

  it('renders the parity scene bit-identically to the native engine (parity.golden) and independently of block size', () => {
    const expected = goldenSums()
    for (const id of [OKGU_EP_ID, HANBAM_106_ID] as const) {
      const sum = renderScene(id, 128)
      expect(sum.toString(16).padStart(16, '0'), `${id} checksum`).toBe(expected.get(id)!.toString(16).padStart(16, '0'))
      expect(renderScene(id, 71), `${id} block size`).toBe(sum)
    }
  })

  it('plays every factory preset audibly, without blowing up', () => {
    for (const id of [OKGU_EP_ID, HANBAM_106_ID] as const) {
      for (const preset of VINTAGE_PRESETS[id]) {
        const full = presetParams(id, preset)
        const inst = dsp!.create(VINTAGE_KIND[id], RATE, VINTAGE_PARAMS[id].map(def => full[def.id]))!
        const frames = RATE / 2
        const l = new Float32Array(frames), r = new Float32Array(frames)
        const chord = [48, 55, 60, 64].map((pitch, i) => ({ offset: i * 7, kind: VINTAGE_EVENT.noteOn, id: i, pitch, value: 0.8, param: 0 }))
        inst.process(l, r, frames, chord)
        let peak = 0, energy = 0
        for (let i = 0; i < frames; i += 1) { peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i])); energy += l[i] * l[i] }
        expect(Number.isFinite(peak) && peak < 3, `${id} ${preset.name} peak ${peak}`).toBe(true)
        expect(Math.sqrt(energy / frames), `${id} ${preset.name} level`).toBeGreaterThan(0.005)
        inst.free()
      }
    }
  })

  it('reports the worklet CPU load of 8 voices (informational; native CI enforces < 3 %)', () => {
    for (const id of [OKGU_EP_ID, HANBAM_106_ID] as const) {
      const params = VINTAGE_PARAMS[id].map(def => def.id === 'voices' ? 8 : def.id === 'sustain' ? 1 : def.default)
      const inst = dsp!.create(VINTAGE_KIND[id], RATE, params)!
      const l = new Float32Array(128), r = new Float32Array(128)
      inst.process(l, r, 128, Array.from({ length: 8 }, (_, i) => ({ offset: 0, kind: VINTAGE_EVENT.noteOn, id: i, pitch: 40 + i * 5, value: 0.8, param: 0 })))
      const blocks = (2 * RATE) / 128
      const start = performance.now()
      for (let b = 0; b < blocks; b += 1) inst.process(l, r, 128)
      const percent = (performance.now() - start) / 1000 / 2 * 100
      console.log(`${id}: 8 voices in WASM = ${percent.toFixed(2)} % of one core`)
      expect(inst.activeVoices()).toBe(8)
      inst.free()
    }
  })
})

// Listening material: GARAK_VINTAGE_DEMO=<dir> pnpm exec vitest run src/audio/rust/vintage.test.ts
// writes one 16-bit WAV per factory preset (a short phrase played through the WASM build).
const demoDir = process.env.GARAK_VINTAGE_DEMO
describe.skipIf(!built || !demoDir)('vintage demo renders', () => {
  it('writes a WAV per factory preset', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { encodePcm16Wav } = await import('../math')
    mkdirSync(demoDir!, { recursive: true })
    const phrase = (id: VintageInstrumentId): Timed[] => {
      const out: Timed[] = []
      const chords = id === OKGU_EP_ID ? [[50, 57, 60, 65], [48, 55, 59, 64], [45, 52, 55, 60], [53, 60, 64, 69]] : [[45, 52, 57, 60], [41, 48, 53, 57], [43, 50, 55, 59], [40, 47, 52, 56]]
      chords.forEach((chord, c) => chord.forEach((pitch, i) => {
        const on = Math.round((c * 1.0 + i * 0.012) * RATE), off = Math.round((c * 1.0 + 0.9) * RATE)
        const velocity = 0.45 + 0.13 * ((i + c) % 4)
        out.push({ frame: on, e: { offset: 0, kind: VINTAGE_EVENT.noteOn, id: c * 10 + i, pitch, value: velocity, param: 0 } })
        out.push({ frame: off, e: { offset: 0, kind: VINTAGE_EVENT.noteOff, id: c * 10 + i, pitch, value: 0, param: 0 } })
      }))
      ;[72, 74, 76, 79, 81, 79, 76, 74].forEach((pitch, n) => {
        const on = Math.round((4.2 + n * 0.22) * RATE)
        out.push({ frame: on, e: { offset: 0, kind: VINTAGE_EVENT.noteOn, id: 100 + n, pitch: id === HANBAM_106_ID ? pitch - 12 : pitch, value: 0.35 + 0.08 * (n % 5), param: 0 } })
        out.push({ frame: on + Math.round(0.2 * RATE), e: { offset: 0, kind: VINTAGE_EVENT.noteOff, id: 100 + n, pitch: id === HANBAM_106_ID ? pitch - 12 : pitch, value: 0, param: 0 } })
      })
      return out.sort((a, b) => a.frame - b.frame)
    }
    for (const id of [OKGU_EP_ID, HANBAM_106_ID] as const) {
      for (const preset of VINTAGE_PRESETS[id]) {
        const full = presetParams(id, preset)
        const inst = dsp!.create(VINTAGE_KIND[id], RATE, VINTAGE_PARAMS[id].map(def => full[def.id]))!
        const frames = 8 * RATE
        const l = new Float32Array(frames), r = new Float32Array(frames)
        const events = phrase(id).map(item => ({ ...item.e, offset: item.frame }))
        inst.process(l, r, frames, events)
        writeFileSync(join(demoDir!, `${id}-${preset.id}.wav`), new Uint8Array(encodePcm16Wav([l, r], RATE)))
        inst.free()
      }
    }
  })
})

describe('vintage event queue', () => {
  it('moves a note-off, cancels a note that has not started, and drains block offsets in order', () => {
    const q = new EventQueue()
    q.push({ at: 1, kind: VINTAGE_EVENT.noteOn, id: 1, pitch: 60, value: 1, param: 0 })
    q.push({ at: 3, kind: VINTAGE_EVENT.noteOff, id: 1, pitch: 60, value: 0, param: 0 })
    q.push({ at: 2, kind: VINTAGE_EVENT.noteOn, id: 2, pitch: 62, value: 1, param: 0 })
    q.push({ at: 4, kind: VINTAGE_EVENT.noteOff, id: 2, pitch: 62, value: 0, param: 0 })
    q.off(1, 1.5) // started earlier: the off moves to 1.5
    q.off(2, 1.8) // not started yet at 1.8: never plays
    expect(q.all().map(e => [e.at, e.kind, e.id])).toEqual([[1, 0, 1], [1.5, 1, 1]])
    const block = q.drain(1, 1 + 128 / 48_000, 48_000, 128)
    expect(block.map(e => [e.offset, e.kind])).toEqual([[0, 0]])
    // A late note-off for a delivered note is still sent (at the requested time).
    q.off(1, 1.2)
    expect(q.drain(1.1, 1.3, 48_000, 9600).map(e => [e.offset, e.kind, e.pitch])).toEqual([[4800, 1, 60]])
    expect(q.size).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import { GuitarCompressor } from './compressor'
import { GuitarChorus } from './chorus'
import { GuitarMaster } from './master'
import { ampVoicing, cabinetFilters, saturationCurve } from './voicing'

const compressorSignal = (sustain: number, attack: number, level = 0, rate = 48000) => {
  const processor = new GuitarCompressor(rate)
  processor.configure(sustain, attack, level, true, true)
  const output = new Float32Array(rate)
  for (let i = 0; i < output.length; i += 1) output[i] = 0.5 * processor.gain(0.5)
  return output
}
const average = (samples: Float32Array, start: number, end: number) => samples.subarray(start, end).reduce((a, b) => a + b, 0) / (end - start)

// These tests measure causal behavior and signal stability, not perceptual amp fidelity.
describe('guitar compressor signal behavior', () => {
  it('passes the very first sample without a lookahead delay and leaves silence silent', () => {
    const compressor = new GuitarCompressor(48000)
    expect(0.25 * compressor.gain(0.25)).toBeGreaterThan(0)
    for (let i = 0; i < 48000; i += 1) expect(0 * compressor.gain(0)).toBe(0)
  })
  it('Sustain reduces sustained loud input; Attack changes initial transient, Level changes gain', () => {
    const low = compressorSignal(0.2, 10), high = compressorSignal(0.8, 10)
    expect(average(high, 24000, 48000)).toBeLessThan(average(low, 24000, 48000) * 0.5)
    const fast = compressorSignal(0.8, 0.5), slow = compressorSignal(0.8, 50)
    expect(average(fast, 0, 100)).toBeLessThan(average(slow, 0, 100) * 0.6)
    const louder = compressorSignal(0.8, 10, 6)
    expect(louder[47000] / high[47000]).toBeCloseTo(Math.pow(10, 6 / 20), 5)
  })
  it('keeps time constants consistent at 44.1, 48 and 96 kHz', () => {
    const response = [44100, 48000, 96000].map(rate => compressorSignal(0.65, 15, 0, rate)[Math.round(0.02 * rate)])
    expect(Math.max(...response) - Math.min(...response)).toBeLessThan(0.0002)
  })
  it('returns to unity on bypass and remains finite with corrupt/large values', () => {
    const compressor = new GuitarCompressor(48000)
    compressor.configure(NaN, Infinity, NaN, true)
    for (let i = 0; i < 1000; i += 1) expect(Number.isFinite(compressor.gain(i % 2 ? Infinity : 1e30))).toBe(true)
    compressor.configure(1, 1, 18, false)
    for (let i = 0; i < 500; i += 1) compressor.gain(1)
    expect(compressor.gain(1)).toBe(1)
  })
})

function chorusSignal(rate: number, depth: number, mix: number, enabled = true, impulse = false) {
  const processor = new GuitarChorus(48000)
  processor.configure(rate, depth, mix, enabled, true)
  const length = 48000
  const result = [new Float32Array(length), new Float32Array(length)]
  for (let start = 0; start < length; start += 128) {
    const frames = Math.min(128, length - start)
    const input = new Float32Array(frames)
    for (let i = 0; i < frames; i += 1) input[i] = impulse ? (start + i === 0 ? 1 : 0) : Math.sin((start + i) * 440 * 2 * Math.PI / 48000)
    const output = [new Float32Array(frames), new Float32Array(frames)]
    processor.process([input], output)
    result[0].set(output[0], start); result[1].set(output[1], start)
  }
  return result
}
const difference = (a: Float32Array, b: Float32Array) => a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length

describe('guitar chorus signal behavior', () => {
  it('has an immediate dry impulse and a later stereo wet component', () => {
    const [left, right] = chorusSignal(0.8, 0.5, 0.6, true, true)
    expect(left[0]).toBeCloseTo(0.7, 6)
    expect(right[0]).toBeCloseTo(0.7, 6)
    expect(left.subarray(1, 300).every(v => v === 0)).toBe(true)
    expect(left.subarray(300, 1400).some(v => v > 0)).toBe(true)
    expect(right.subarray(300, 1400).some(v => v > 0)).toBe(true)
    expect(difference(left, right)).toBeGreaterThan(0)
    expect(left.subarray(2400).every(v => v === 0)).toBe(true)
  })
  it('Rate, Depth and Mix each change samples; bypass is transparent', () => {
    const normal = chorusSignal(0.8, 0.5, 0.6)[0]
    expect(difference(normal, chorusSignal(2, 0.5, 0.6)[0])).toBeGreaterThan(0.05)
    expect(difference(normal, chorusSignal(0.8, 0.1, 0.6)[0])).toBeGreaterThan(0.05)
    expect(difference(normal, chorusSignal(0.8, 0.5, 0.2)[0])).toBeGreaterThan(0.05)
    const bypass = chorusSignal(0.8, 0.5, 0.6, false)[0]
    const dry = chorusSignal(0.8, 0.5, 0)[0]
    expect(bypass).toEqual(dry)
    expect(Math.max(...normal.map(Math.abs))).toBeLessThanOrEqual(1)
  })
  it('produces no self-generated signal without input, including after reconfiguration', () => {
    const processor = new GuitarChorus(96000)
    processor.configure(5, 1, 0.6, true, true)
    const output = [new Float32Array(128), new Float32Array(128)]
    for (let i = 0; i < 200; i += 1) processor.process([], output)
    expect(output[0].every(value => value === 0)).toBe(true)
    expect(output[1].every(value => value === 0)).toBe(true)
  })
})

describe('original amp/cab voicings', () => {
  it('saturation preserves exact digital silence and bounded, continuous curves', () => {
    for (const kind of ['amp', 'drive'] as const) for (const model of [0, 1, 2]) {
      const curve = saturationCurve(kind, model)
      expect(curve[(curve.length - 1) / 2]).toBe(0)
      for (let i = 1; i < curve.length; i += 1) {
        expect(Number.isFinite(curve[i])).toBe(true)
        expect(Math.abs(curve[i])).toBeLessThanOrEqual(1)
        expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1])
        expect(curve[i] - curve[i - 1]).toBeLessThan(0.01)
      }
    }
  })
  it('each cabinet/mic axis changes stable filter settings within audible bounds', () => {
    const base = cabinetFilters(1, 0, 0.35, 0.15)
    for (const changed of [cabinetFilters(0, 0, 0.35, 0.15), cabinetFilters(2, 0, 0.35, 0.15), cabinetFilters(1, 1, 0.35, 0.15), cabinetFilters(1, 2, 0.35, 0.15), cabinetFilters(1, 0, 1, 0.15), cabinetFilters(1, 0, 0.35, 1)]) {
      expect(changed).not.toEqual(base)
      for (const setting of changed) {
        expect(setting.frequency).toBeGreaterThan(20)
        expect(setting.frequency).toBeLessThan(12000)
        expect(setting.Q).toBeGreaterThan(0)
        expect(setting.Q).toBeLessThan(2)
        expect(Math.abs(setting.gain)).toBeLessThan(12)
      }
    }
    expect(ampVoicing(2).preGain).toBeGreaterThan(ampVoicing(1).preGain)
    expect(ampVoicing(1).preGain).toBeGreaterThan(ampVoicing(0).preGain)
  })
})

describe('causal guitar safety master', () => {
  it('passes small signals exactly at the same sample and produces silence from silence', () => {
    const master = new GuitarMaster(48000)
    for (const input of [0, 0.2, -0.4, 0.1]) expect(master.sample(input, master.gain(Math.abs(input)))).toBe(input)
  })
  it('keeps sustained and transient overload finite below the safety ceiling', () => {
    const master = new GuitarMaster(48000)
    for (const input of [1e30, -1e30, NaN, Infinity, -Infinity, 0, 1, -1, 5]) {
      const output = master.sample(input, master.gain(Math.abs(input)))
      expect(Number.isFinite(output)).toBe(true)
      expect(Math.abs(output)).toBeLessThanOrEqual(0.98)
    }
    const sustained = new GuitarMaster(48000)
    for (let frame = 0; frame < 48000; frame += 1) sustained.gain(1)
    expect(sustained.sample(1, sustained.gain(1))).toBeCloseTo(10 ** (-2.75 / 20), 5)
  })
  it('links stereo gain and recovers after a loud transient', () => {
    const master = new GuitarMaster(48000)
    for (let frame = 0; frame < 4800; frame += 1) master.gain(2)
    const linked = master.gain(2)
    expect(master.sample(0.2, linked) / master.sample(0.1, linked)).toBeCloseTo(2, 8)
    for (let frame = 0; frame < 96000; frame += 1) master.gain(0.1)
    expect(master.sample(0.1, master.gain(0.1))).toBe(0.1)
  })
})

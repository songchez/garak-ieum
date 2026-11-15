import { describe, expect, it } from 'vitest'
import { GuitarPhaser, GuitarTremolo } from './modulation'
import { reverbImpulse, reverbImpulses, reverbTailSeconds } from './reverb'
import { detectPitch, tunerReading } from './tuner'
import { saturationCurve } from './voicing'
import { GUITAR_RIG_DEFAULT_ORDER, GUITAR_RIG_DEFAULTS, GUITAR_RIG_MODULES, GUITAR_RIG_PARAMS, GUITAR_RIG_PRESETS, GUITAR_RIG_SECTIONS, GUITAR_RIG_MODULE_PARAMS, guitarRigMaxInstances, guitarRigOrder, guitarRigOrderParams, nextRigInstance, parseRigSlot, rigParam } from './definition'

const RATE = 48000
const sine = (frequency: number, length = RATE / 2, amplitude = 0.3, rate = RATE) => Float32Array.from({ length }, (_, i) => amplitude * Math.sin(2 * Math.PI * frequency * i / rate))
const mean = (a: Float32Array, b: Float32Array) => a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length

function phaserRun(rate: number, depth: number, feedback: number, enabled = true, input = sine(440)) {
  const phaser = new GuitarPhaser(RATE)
  phaser.configure(rate, depth, feedback, enabled, true)
  const out = new Float64Array(2), left = new Float32Array(input.length), right = new Float32Array(input.length)
  for (let i = 0; i < input.length; i += 1) { phaser.sample(input[i], input[i], out); left[i] = out[0]; right[i] = out[1] }
  return { left, right }
}
function tremoloRun(rate: number, depth: number, shape: number, enabled = true, input = sine(440)) {
  const tremolo = new GuitarTremolo(RATE)
  tremolo.configure(rate, depth, shape, enabled, true)
  return input.map(value => value * tremolo.gain())
}

describe('rack pedal definitions', () => {
  it('keeps codes stable and unique, and the default rack free of the new pedals', () => {
    expect(GUITAR_RIG_MODULES.map(m => [m.code, m.id])).toEqual([[1, 'comp'], [2, 'drive'], [3, 'amp'], [4, 'cabinet'], [5, 'chorus'], [6, 'delay'], [7, 'fuzz'], [8, 'phaser'], [9, 'tremolo'], [10, 'reverb'], [11, 'tuner']])
    expect(GUITAR_RIG_DEFAULT_ORDER).toEqual(['comp', 'drive', 'amp', 'cabinet', 'chorus', 'delay'])
    expect(guitarRigOrder(GUITAR_RIG_DEFAULTS)).toEqual(GUITAR_RIG_DEFAULT_ORDER)
    // Old projects stored slots 0–5 only; missing new params fall back to defaults, which keep the pedals off.
    for (const id of ['fuzzEnabled', 'phaserEnabled', 'tremoloEnabled', 'reverbEnabled', 'tunerEnabled']) expect(GUITAR_RIG_DEFAULTS[id]).toBe(0)
    // A slot stores code + 16 × instance: up to three copies of a pedal, one tuner.
    expect(GUITAR_RIG_PARAMS.find(p => p.id === 'rackSlot0')!.max).toBe(11 + 32)
    expect(guitarRigOrder(guitarRigOrderParams(['tuner', 'fuzz', 'reverb', 'fuzz']))).toEqual(['tuner', 'fuzz', 'reverb'])
    expect(guitarRigOrder(guitarRigOrderParams(['drive', 'drive_2', 'amp', 'drive_3']))).toEqual(['drive', 'drive_2', 'amp', 'drive_3'])
    expect(guitarRigOrderParams(['drive_2']).rackSlot0).toBe(2 + 16)
    expect(guitarRigOrder({ ...guitarRigOrderParams([]), rackSlot0: 11 + 16, rackSlot1: 2 + 48, rackSlot2: 7 + 32 })).toEqual(['fuzz_3'])
    expect(nextRigInstance(['drive', 'drive_3'], 'drive')).toBe('drive_2')
    expect(nextRigInstance(['tuner'], 'tuner')).toBeNull()
  })
  it('gives each extra copy its own controls with the base ranges and defaults', () => {
    for (const id of GUITAR_RIG_MODULES.map(m => m.id)) for (let instance = 1; instance < guitarRigMaxInstances(id); instance += 1) {
      for (const base of GUITAR_RIG_MODULE_PARAMS[id]) {
        const def = GUITAR_RIG_PARAMS.find(p => p.id === rigParam(base, instance))!, original = GUITAR_RIG_PARAMS.find(p => p.id === base)!
        expect(def, rigParam(base, instance)).toMatchObject({ min: original.min, max: original.max, default: original.default, unit: original.unit })
      }
    }
    expect(GUITAR_RIG_PARAMS.some(p => p.id === 'tunerEnabled_2')).toBe(false)
    expect(parseRigSlot('reverb_3')).toEqual({ key: 'reverb_3', id: 'reverb', instance: 2 })
  })
  it('gives every new pedal a bypass and exactly three knobs, within the command parameter limit', () => {
    for (const id of ['fuzz', 'phaser', 'tremolo', 'reverb'] as const) {
      const section = GUITAR_RIG_SECTIONS.find(s => s.id === id)!
      expect(section.params).toHaveLength(3)
      for (const param of [section.enabledParam, ...section.params]) expect(GUITAR_RIG_PARAMS.some(p => p.id === param)).toBe(true)
    }
    expect(GUITAR_RIG_SECTIONS.map(s => s.id).sort()).toEqual(GUITAR_RIG_MODULES.map(m => m.id).sort())
    // A preset or effect.add carries every control at once (src/core/commands.ts allows 256).
    expect(GUITAR_RIG_PARAMS.length).toBeLessThanOrEqual(256)
    expect(new Set(GUITAR_RIG_PARAMS.map(p => p.id)).size).toBe(GUITAR_RIG_PARAMS.length)
  })
  it('ships presets that use the new pedals', () => {
    const used = new Set(GUITAR_RIG_PRESETS.flatMap(preset => guitarRigOrder(preset.params).filter(id => preset.params[GUITAR_RIG_SECTIONS.find(s => s.id === id)!.enabledParam] >= 0.5)))
    for (const id of ['fuzz', 'phaser', 'tremolo', 'reverb']) expect(used.has(id as never)).toBe(true)
    for (const preset of GUITAR_RIG_PRESETS) for (const def of GUITAR_RIG_PARAMS) {
      expect(preset.params[def.id]).toBeGreaterThanOrEqual(def.min)
      expect(preset.params[def.id]).toBeLessThanOrEqual(def.max)
    }
  })
})

describe('fuzz, phaser and tremolo signal behavior', () => {
  it('fuzz curve is bounded, monotonic, asymmetric and silent at zero', () => {
    const curve = saturationCurve('fuzz')
    expect(curve[(curve.length - 1) / 2]).toBe(0)
    for (let i = 1; i < curve.length; i += 1) {
      expect(Math.abs(curve[i])).toBeLessThanOrEqual(1)
      expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1])
      expect(curve[i] - curve[i - 1]).toBeLessThan(0.01)
    }
    expect(curve[curve.length - 1]).not.toBeCloseTo(-curve[0], 2)
  })
  it('phaser: bypass is transparent; rate, depth and feedback each change the sound; stays bounded', () => {
    const input = sine(440)
    expect(phaserRun(0.45, 0.7, 0.35, false, input).left).toEqual(input)
    const normal = phaserRun(0.45, 0.7, 0.35).left
    expect(mean(normal, input)).toBeGreaterThan(0.01)
    expect(mean(normal, phaserRun(2, 0.7, 0.35).left)).toBeGreaterThan(0.005)
    expect(mean(normal, phaserRun(0.45, 0.1, 0.35).left)).toBeGreaterThan(0.005)
    expect(mean(normal, phaserRun(0.45, 0.7, 0.8).left)).toBeGreaterThan(0.005)
    const loud = phaserRun(4, 1, 0.85, true, sine(200, RATE, 1))
    expect(loud.left.every(value => Number.isFinite(value) && Math.abs(value) < 8)).toBe(true)
    expect(mean(loud.left, loud.right)).toBeGreaterThan(0)
  })
  it('tremolo: bypass is transparent; depth sets the trough; shape squares the wave', () => {
    const input = sine(440)
    expect(tremoloRun(4.5, 0.5, 0, false, input)).toEqual(input)
    const ones = new Float32Array(RATE).fill(1)
    const full = tremoloRun(4, 1, 0, true, ones)
    expect(Math.min(...full)).toBeLessThan(0.001)
    expect(Math.max(...full)).toBeCloseTo(1, 3)
    expect(Math.min(...tremoloRun(4, 0.5, 0, true, ones))).toBeCloseTo(0.5, 3)
    // A squarer wave spends more time near the extremes.
    const extremes = (gains: Float32Array) => gains.filter(g => g > 0.95 || g < 0.05).length
    expect(extremes(tremoloRun(4, 1, 1, true, ones))).toBeGreaterThan(extremes(full) * 2)
    expect(mean(tremoloRun(4, 1, 0, true, input), tremoloRun(8, 1, 0, true, input))).toBeGreaterThan(0.01)
  })
})

describe('plate reverb impulse', () => {
  it('matches the native generator: deterministic, decaying, stereo-decorrelated, rate-normalised', () => {
    const [left, right] = reverbImpulse(RATE, 1.7, 9183)
    expect(left.length).toBe(Math.ceil(RATE * 1.7))
    expect(reverbImpulse(RATE, 1.7, 9183)[0]).toEqual(left)
    expect(mean(left, right)).toBeGreaterThan(0)
    const energy = (a: Float32Array, from: number, to: number) => a.subarray(from, to).reduce((sum, v) => sum + v * v, 0)
    expect(energy(left, 0, 8000)).toBeGreaterThan(energy(left, left.length - 8000, left.length) * 100)
    // Same RMS scaling as native impulse(): 0.00125 at 44.1 kHz.
    const rms = Math.sqrt((energy(left, 0, left.length) + energy(right, 0, right.length)) / (left.length * 2))
    expect(rms).toBeCloseTo(0.00125 * 44100 / RATE, 6)
    expect(reverbImpulses(RATE)).toBe(reverbImpulses(RATE))
    expect(reverbTailSeconds(0)).toBeCloseTo(1.95)
    expect(reverbTailSeconds(0.5)).toBeCloseTo(4.45)
  })
})

describe('rack tuner pitch detection', () => {
  it.each([[82.41, 'E', 2], [110, 'A', 2], [146.83, 'D', 3], [196, 'G', 3], [246.94, 'B', 3], [329.63, 'E', 4], [440, 'A', 4]])('finds %s Hz as %s%s within a cent', (frequency, note, octave) => {
    for (const rate of [44100, 48000, 96000]) {
      const length = rate > 50000 ? 8192 : 4096
      const hz = detectPitch(sine(frequency, length, 0.2, rate), rate)
      expect(hz).not.toBeNull()
      const reading = tunerReading(hz!)
      expect(reading.note).toBe(note)
      expect(reading.octave).toBe(octave)
      expect(Math.abs(1200 * Math.log2(hz! / frequency))).toBeLessThan(1)
    }
  })
  it('reads a detuned guitar-like tone (harmonics) and reports cents against A4 = 440 Hz', () => {
    const f = 110 * Math.pow(2, 15 / 1200)
    const tone = Float32Array.from({ length: 4096 }, (_, i) => [1, 0.6, 0.4, 0.25].reduce((sum, amp, h) => sum + 0.1 * amp * Math.sin(2 * Math.PI * f * (h + 1) * i / RATE), 0))
    const reading = tunerReading(detectPitch(tone, RATE)!)
    expect(reading.note).toBe('A')
    expect(reading.cents).toBeGreaterThan(13)
    expect(reading.cents).toBeLessThan(17)
    expect(tunerReading(440).cents).toBe(0)
    expect(tunerReading(440 * Math.pow(2, -20 / 1200))).toMatchObject({ note: 'A', octave: 4, cents: -20 })
  })
  it('returns no reading for silence or noise-floor input', () => {
    expect(detectPitch(new Float32Array(4096), RATE)).toBeNull()
    expect(detectPitch(sine(220, 4096, 0.001), RATE)).toBeNull()
  })
})

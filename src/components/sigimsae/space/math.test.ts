import { describe, expect, it } from 'vitest'
import { DELAY_DEF, TREMOLO_DEF, UTILITY_DEF, BITCRUSHER_DEF } from '../../../devices/effects/sigimsaeDefs'
import { readParams } from '../../../devices/effects/kernels'
import type { ParamDef } from '../../../devices/contracts'
import {
  chorusDelays, crushSequence, delayParamsForTime, delayReadout, delayTime, delayWindow, driveTransfer, echoTaps,
  flangerDelays, flangerResponse, harmonics, lfoRate, logFrequencies, phaserFrequency, phaserResponse, reverbEnvelopeDb,
  reverbRt60, sizeForRt60, snapBeats, tapeTransfer, tremoloGains, utilityCorrelation, utilityLevelDb, utilityMatrix,
} from './math'

const reader = (defs: readonly ParamDef[], params: Record<string, number> = {}) => readParams(defs, params)
const driveDefs: ParamDef[] = [
  { id: 'drive', label: '', min: 0, max: 36, default: 9, unit: 'db' }, { id: 'mix', label: '', min: 0, max: 1, default: 1, unit: 'pct' },
  { id: 'output', label: '', min: -24, max: 6, default: 0, unit: 'db' }, { id: 'warmth', label: '', min: 0, max: 1, default: 0.5, unit: 'pct' },
]

describe('delay display', () => {
  it('converts synced note values (dotted, triplet) to seconds at the tempo', () => {
    expect(delayTime(reader(DELAY_DEF.params, { time: 0.75 }), 120)).toBeCloseTo(0.375)
    expect(delayTime(reader(DELAY_DEF.params, { time: 1 / 3 }), 120)).toBeCloseTo(1 / 6)
    expect(delayTime(reader(DELAY_DEF.params, { sync: 0, ms: 80 }), 120)).toBeCloseTo(0.08)
    expect(delayReadout(reader(DELAY_DEF.params, { time: 0.75 }), 120)).toEqual({ main: '1/8.', hint: '375 ms' })
    expect(delayReadout(reader(DELAY_DEF.params, { sync: 0, ms: 250 }), 120).hint).toBe('≈ 1/8')
  })
  it('snaps dragged times to the nearest note value', () => {
    expect(snapBeats(0.74)).toBeCloseTo(0.75)
    expect(snapBeats(0.36)).toBeCloseTo(0.375)
    expect(delayParamsForTime(0.25, true, 120)).toEqual({ time: 0.5 })
    expect(delayParamsForTime(0.3333, false, 120)).toEqual({ ms: 333.3 })
    expect(delayParamsForTime(9, false, 120)).toEqual({ ms: 2000 })
  })
  it('lays out taps with feedback decay, alternating lanes in ping-pong', () => {
    const p = reader(DELAY_DEF.params, { time: 0.5, feedback: 0.5, amount: 1, mode: 1 })
    const taps = echoTaps(p, 120, 2)
    expect(taps.map(t => t.time)).toEqual([0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2])
    expect(taps[1].gain).toBeCloseTo(0.5); expect(taps[2].gain).toBeCloseTo(0.25)
    expect(taps.slice(0, 3).map(t => t.lane)).toEqual(['L', 'R', 'L'])
    expect(taps[3].brightness).toBeLessThanOrEqual(taps[0].brightness)
    expect(echoTaps(reader(DELAY_DEF.params, { feedback: 0 }), 120, 4)).toHaveLength(1)
    expect(echoTaps(reader(DELAY_DEF.params, { mode: 0 }), 120, 4)[0].lane).toBe('LR')
  })
  it('picks a window that shows several repeats', () => {
    expect(delayWindow(0.375, 0.32)).toBeGreaterThanOrEqual(0.375 * 3)
    expect(delayWindow(2, 0.9)).toBe(8)
  })
})

describe('reverb display', () => {
  it('longer size means a longer RT60, and the inverse recovers size', () => {
    const short = reverbRt60(0, 0), long = reverbRt60(0, 1)
    expect(long).toBeGreaterThan(short)
    // (1-u)^3.6 reaches -60 dB at u = 1 - 10^(-3/3.6)
    expect(short).toBeCloseTo(1.7 * (1 - Math.pow(10, -3 / 3.6)), 2)
    expect(sizeForRt60(0, reverbRt60(0, 0.4))).toBeCloseTo(0.4, 2)
    expect(sizeForRt60(1, 100)).toBe(1)
    expect(reverbRt60(1, 0.5)).toBeLessThan(reverbRt60(0, 0.5))
  })
  it('envelope starts at the Amount level and decays', () => {
    expect(reverbEnvelopeDb(2, 0.5, 1, 0)).toBeCloseTo(0)
    expect(reverbEnvelopeDb(2, 0.5, 0.5, 0)).toBeCloseTo(-6.02, 1)
    expect(reverbEnvelopeDb(2, 0.5, 1, 1)).toBeLessThan(reverbEnvelopeDb(2, 0.5, 1, 0.2))
  })
})

describe('modulation display', () => {
  it('tremolo follows the tempo when synced', () => {
    expect(lfoRate('tremolo', reader(TREMOLO_DEF.params, { sync: 0.25 }), 120)).toBeCloseTo(8)
    expect(lfoRate('tremolo', reader(TREMOLO_DEF.params, { sync: 0, rate: 3 }), 120)).toBe(3)
  })
  it('auto-pan moves level between the sides, tremolo keeps them equal', () => {
    const [l, r] = tremoloGains(Math.PI / 2, 1, 0, true)
    expect(l).toBeCloseTo(0); expect(r).toBeCloseTo(1)
    const [a, b] = tremoloGains(-Math.PI / 2, 1, 0, false)
    expect(a).toBeCloseTo(0); expect(b).toBeCloseTo(0)
  })
  it('modulated delays stay in the kernel ranges', () => {
    expect(chorusDelays(Math.PI / 2, 1)).toEqual([19, 12])
    expect(flangerDelays(Math.PI / 2, 1)[0]).toBeCloseTo(6.3)
    expect(phaserFrequency(-Math.PI / 2, 1, 0)).toBeCloseTo(200)
    expect(phaserFrequency(Math.PI / 2, 1, 0)).toBeCloseTo(3200)
  })
  it('flanger notches sit at odd multiples of 1/(2D); phaser cuts somewhere and passes DC', () => {
    const freqs = new Float64Array([250, 500]), out = new Float64Array(2)
    flangerResponse(freqs, 0.002, 0, 1, out)
    expect(out[0]).toBeLessThan(-30) // 1/(2·2 ms) = 250 Hz notch
    expect(out[1]).toBeCloseTo(0, 1) // 500 Hz peak: |0.5 + 0.5| = 1
    const f = logFrequencies(200), ph = new Float64Array(200)
    phaserResponse(f, 800, 0, 1, 48000, ph)
    expect(Math.min(...ph)).toBeLessThan(-20)
    expect(ph[0]).toBeCloseTo(0, 0)
  })
})

describe('drive display', () => {
  it('more drive bends the curve and adds harmonics; mix 0 is a straight line', () => {
    const clean = driveTransfer(reader(driveDefs, { drive: 0, mix: 0 }))
    expect(clean(0.5)).toBeCloseTo(0.5)
    const soft = harmonics(driveTransfer(reader(driveDefs, { drive: 3 }))), hard = harmonics(driveTransfer(reader(driveDefs, { drive: 30 })))
    expect(hard[2]).toBeGreaterThan(soft[2]) // 3rd harmonic
    expect(soft[1]).toBeLessThan(-80) // symmetric curve: no 2nd harmonic
    expect(driveTransfer(reader(driveDefs, { drive: 36 }))(1)).toBeCloseTo(driveTransfer(reader(driveDefs, { drive: 36 }))(0.5), 3)
  })
  it('tape bias produces even harmonics and passes zero through zero', () => {
    const tape = tapeTransfer(reader(driveDefs, { drive: 12 }))
    expect(tape(0)).toBeCloseTo(0)
    expect(harmonics(tape)[1]).toBeGreaterThan(-60)
  })
  it('bitcrusher holds samples and quantises like the kernel', () => {
    const input = Float64Array.from({ length: 8 }, (_, i) => i / 8), out = new Float64Array(8)
    const p = reader(BITCRUSHER_DEF.params, { bits: 2, downsample: 4 })
    crushSequence(input, p('bits'), p('downsample'), out)
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5])
  })
})

describe('utility display', () => {
  it('width, mono and polarity change the correlation', () => {
    expect(utilityCorrelation(reader(UTILITY_DEF.params))).toBeCloseTo(0.6)
    expect(utilityCorrelation(reader(UTILITY_DEF.params, { mono: 1 }))).toBeCloseTo(1)
    expect(utilityCorrelation(reader(UTILITY_DEF.params, { phase: 1 }))).toBeCloseTo(-0.6)
    expect(utilityCorrelation(reader(UTILITY_DEF.params, { width: 2 }))!).toBeLessThan(0.6)
    expect(utilityCorrelation(reader(UTILITY_DEF.params, { mono: 1, phase: 2 }), 1)).toBeNull()
  })
  it('pan and gain scale the sides', () => {
    expect(utilityMatrix(reader(UTILITY_DEF.params, { pan: 1 }))[0]).toEqual([0, 0])
    expect(utilityLevelDb(reader(UTILITY_DEF.params, { gain: -6 }))).toBeCloseTo(-6, 5)
  })
})

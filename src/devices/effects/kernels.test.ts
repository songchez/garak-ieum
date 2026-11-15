import { describe, expect, it } from 'vitest'
import { createKernel, kernelTailSeconds } from './kernels'
import { KERNEL_DEFS, KERNEL_TYPES, type KernelType } from './sigimsaeDefs'
import { reverbImpulse } from './reverb'
import { EFFECT_DEFS, EFFECT_TYPES } from './registry'
import { MODULES_WITHOUT_DEFAULT, SIGIMSAE_CATEGORIES, SIGIMSAE_VARIANTS, defaultVariant, searchVariants, variantsIn } from '../../core/sigimsaeVariants'
import { deviceFromVariant, effectDeviceName } from '../../core/sigimsaeDevices'
import { createEmptyProject, createTrack, validateProject } from '../../core/project'

const SR = 48000
function render(type: KernelType, params: Record<string, number>, left: Float32Array, right = left.slice(), bpm = 120, block = 128) {
  const kernel = createKernel(type, SR, params, bpm)
  const l = left.slice(), r = right.slice()
  for (let at = 0; at < l.length; at += block) {
    const n = Math.min(block, l.length - at)
    kernel.process(l.subarray(at, at + n), r.subarray(at, at + n), n)
  }
  return { l, r }
}
const sine = (frames: number, hz: number, amplitude: number) => Float32Array.from({ length: frames }, (_, i) => amplitude * Math.sin(2 * Math.PI * hz * i / SR))
function noise(frames: number, seed = 3) {
  let state = seed
  return Float32Array.from({ length: frames }, () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0xffffffff * 2 - 1 })
}
const peak = (data: Float32Array) => data.reduce((max, v) => Math.max(max, Math.abs(v)), 0)

describe('시김새 kernels', () => {
  it('limiter never exceeds its ceiling, even driven hard', () => {
    const { l, r } = render('limiter', { gain: 12, ceiling: -3, release: 50 }, sine(24000, 97, 2), sine(24000, 211, 1.5))
    const ceiling = Math.pow(10, -3 / 20)
    expect(Math.max(peak(l), peak(r))).toBeLessThanOrEqual(ceiling + 1e-7)
    expect(peak(l)).toBeGreaterThan(ceiling * 0.9)
  })

  it('gate opens on a tone and closes to exact silence on low-level noise', () => {
    const input = new Float32Array(48000)
    input.set(sine(12000, 440, 0.08))
    for (let i = 24000; i < 48000; i += 1) input[i] = 1e-4 * Math.sin(i * 0.3)
    const { l } = render('gate', { threshold: -40, hold: 20, release: 40 }, input)
    expect(peak(l.subarray(4000, 12000))).toBeGreaterThan(0.07)
    expect(l.subarray(24000).every(v => v === 0)).toBe(true)
  })

  it('utility mono is the exact L/R average and polarity flips both sides', () => {
    const left = sine(4000, 300, 1), right = sine(4000, 700, 0.3)
    const mono = render('utility', { mono: 1 }, left, right)
    for (let i = 0; i < 4000; i += 1) {
      expect(mono.l[i]).toBeCloseTo(0.5 * (left[i] + right[i]), 6)
      expect(mono.r[i]).toBe(mono.l[i])
    }
    const flipped = render('utility', { phase: 3 }, left, right)
    expect(flipped.l[123]).toBeCloseTo(-left[123], 6)
    expect(flipped.r[321]).toBeCloseTo(-right[321], 6)
    const neutral = render('utility', {}, left, right)
    for (let i = 0; i < 4000; i += 1) { expect(neutral.l[i]).toBeCloseTo(left[i], 6); expect(neutral.r[i]).toBeCloseTo(right[i], 6) }
    const panned = render('utility', { pan: 1 }, left, right)
    expect(peak(panned.l)).toBe(0)
  })

  it('modulation and feedback stay finite and bounded at their extremes', () => {
    const input = noise(48000)
    const extremes: [KernelType, Record<string, number>][] = [
      ['chorus', { rate: 5, depth: 1, mix: 1 }], ['phaser', { rate: 5, depth: 1, feedback: 0.9, mix: 1 }],
      ['flanger', { rate: 5, depth: 1, feedback: 0.95, mix: 1 }], ['tremolo', { rate: 20, depth: 1, shape: 1, pan: 1 }],
      ['delay', { amount: 1, feedback: 0.95, age: 1, mode: 1, lowcut: 2000, time: 1 / 6 }], ['tape', { drive: 24, warmth: 1 }], ['bitcrusher', { bits: 1, downsample: 32 }],
    ]
    for (const [type, params] of extremes) {
      const { l, r } = render(type, params, input)
      let worst = 0
      for (const v of [...l, ...r]) worst = Number.isFinite(v) ? Math.max(worst, Math.abs(v)) : Infinity
      expect(worst, type).toBeLessThan(40)
    }
  })

  it('ping-pong delay starts left, answers right, and follows the tempo', () => {
    const click = new Float32Array(48000); click[0] = 1
    const { l, r } = render('delay', { mode: 1, amount: 1, feedback: 0.5, time: 0.5, tone: 16000 }, click)
    const argmax = (data: Float32Array, from: number, to: number) => { let best = from; for (let i = from; i < to; i += 1) if (Math.abs(data[i]) > Math.abs(data[best])) best = i; return best }
    expect(Math.abs(argmax(l, 100, 20000) - 12000)).toBeLessThan(100)
    expect(Math.abs(argmax(r, 100, 30000) - 24000)).toBeLessThan(100)
    const fast = render('delay', { amount: 1, feedback: 0, time: 1, tone: 16000 }, click, click.slice(), 240)
    expect(Math.abs(argmax(fast.l, 100, 48000) - 12000)).toBeLessThan(100)
    expect(Math.abs(argmax(render('delay', { amount: 1, feedback: 0, sync: 0, ms: 80, tone: 16000 }, click).l, 100, 20000) - 3840)).toBeLessThan(60)
  })

  it('tremolo syncs to the tempo and auto-pan moves level between the sides', () => {
    const dc = new Float32Array(48000).fill(0.5)
    const pan = render('tremolo', { pan: 1, depth: 1, sync: 1 }, dc)
    // One cycle per beat at 120 BPM: the left is loudest where the right is quietest.
    const quarter = 6000
    expect(pan.l[quarter] + pan.r[quarter]).toBeCloseTo(0.5, 2)
    expect(Math.abs(pan.l[quarter] - pan.r[quarter])).toBeGreaterThan(0.4)
    const trem = render('tremolo', { depth: 1 }, dc)
    expect(Math.min(...trem.l)).toBeLessThan(0.01)
  })

  it('applies the first parameters immediately and glides later edits', () => {
    const kernel = createKernel('utility', SR, { gain: -6 })
    const l = new Float32Array(4).fill(1), r = new Float32Array(4).fill(1)
    kernel.process(l, r, 4)
    expect(l[0]).toBeCloseTo(Math.pow(10, -6 / 20), 6)
    kernel.configure({ gain: 0 }, 120)
    const a = new Float32Array(2).fill(1)
    kernel.process(a, a.slice(), 1)
    expect(a[0]).toBeLessThan(0.6)
  })

  it('reports tails for time-based kernels only', () => {
    expect(kernelTailSeconds('delay', { amount: 1, feedback: 0.5, time: 1 }, 120)).toBeCloseTo(6.35)
    expect(kernelTailSeconds('delay', { amount: 0 }, 120)).toBe(0)
    expect(kernelTailSeconds('flanger', {}, 120)).toBeGreaterThan(0.05)
    expect(kernelTailSeconds('utility', {}, 120)).toBe(0)
  })

  it('keeps native-mirrored catalogs in range', () => {
    for (const type of KERNEL_TYPES) for (const param of KERNEL_DEFS[type].params) {
      expect(param.default).toBeGreaterThanOrEqual(param.min)
      expect(param.default).toBeLessThanOrEqual(param.max)
      if (param.options) expect(param.options.some(option => option.value === param.default)).toBe(true)
    }
  })
})

describe('reverb spaces', () => {
  it('builds deterministic, distinct impulses per space', () => {
    const hall = reverbImpulse(8000, 0, 'short'), again = reverbImpulse(8000, 0, 'short')
    expect(hall[0]).toEqual(again[0])
    expect(hall[0][0]).toBeCloseTo(0.5898486971855164)
    const lengths = [0, 1, 2, 3].map(space => reverbImpulse(8000, space, 'long')[0].length)
    expect(lengths).toEqual([33600, 9600, 25600, 20800])
    const spring = reverbImpulse(8000, 3, 'short')[0]
    expect(spring.every(Number.isFinite)).toBe(true)
  })
})

describe('시김새 library variants', () => {
  it('give every module a default variant and keep ids and names unique', () => {
    expect(MODULES_WITHOUT_DEFAULT).toEqual([])
    for (const type of EFFECT_TYPES) expect(defaultVariant(type).name).toBe(EFFECT_DEFS[type].name)
    expect(new Set(SIGIMSAE_VARIANTS.map(v => v.id)).size).toBe(SIGIMSAE_VARIANTS.length)
    expect(new Set(SIGIMSAE_VARIANTS.map(v => v.name)).size).toBe(SIGIMSAE_VARIANTS.length)
    expect(SIGIMSAE_CATEGORIES.every(category => variantsIn(category).length > 0)).toBe(true)
  })

  it('only use valid parameter values, so their devices survive project validation', () => {
    const track = createTrack('audio')
    track.devices = SIGIMSAE_VARIANTS.map(deviceFromVariant)
    const restored = validateProject(JSON.parse(JSON.stringify({ ...createEmptyProject(), tracks: [track] })))
    expect(restored.tracks[0].devices).toEqual(track.devices)
    for (const variant of SIGIMSAE_VARIANTS) {
      const defs = EFFECT_DEFS[variant.effectType].params
      for (const id of Object.keys(variant.params)) expect(defs.some(def => def.id === id)).toBe(true)
    }
    expect(effectDeviceName(deviceFromVariant(SIGIMSAE_VARIANTS.find(v => v.id === 'reverb-booth')!))).toBe('보컬 부스')
    expect(deviceFromVariant(defaultVariant('reverb'))).not.toHaveProperty('name')
  })

  it('make different-sounding variants of one module differ in their settings', () => {
    for (const type of EFFECT_TYPES) {
      const keys = SIGIMSAE_VARIANTS.filter(v => v.effectType === type).map(v => JSON.stringify(deviceFromVariant(v).params))
      expect(new Set(keys).size).toBe(keys.length)
    }
  })

  it('search names, use labels and English aliases', () => {
    expect(searchVariants('보컬').map(v => v.id)).toEqual(expect.arrayContaining(['reverb-booth', 'comp-vocal', 'eq-vocal-presence']))
    expect(searchVariants('hall').map(v => v.id)).toEqual(expect.arrayContaining(['reverb', 'reverb-temple']))
    expect(searchVariants('ping').map(v => v.id)).toContain('delay-pingpong')
    expect(searchVariants('zzzz')).toEqual([])
  })
})

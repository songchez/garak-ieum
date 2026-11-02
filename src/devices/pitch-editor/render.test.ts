import { describe, expect, it } from 'vitest'
import { renderPitch } from './render'
import type { PitchNote, PitchRenderSettings } from './model'

const sine = (hz: number, rate: number, seconds = 1) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => Math.sin(2 * Math.PI * hz * i / rate) * 0.4)
const note = (id = 'one', start = 0.1, end = 0.9, midi = 57): PitchNote => ({ id, start, end, midi, confidence: 0.98 })
function frequency(channel: Float32Array, rate: number, start = 0.3, end = 0.7): number {
  const crossings: number[] = []
  for (let i = Math.ceil(start * rate); i < Math.floor(end * rate); i += 1) {
    if (channel[i - 1] < 0 && channel[i] >= 0) crossings.push(i - channel[i] / (channel[i] - channel[i - 1]))
  }
  return (crossings.length - 1) * rate / (crossings.at(-1)! - crossings[0])
}
const rms = (channel: Float32Array) => Math.sqrt(channel.reduce((sum, value) => sum + value * value, 0) / channel.length)

function vowelEnvelope(hz: number, f0 = 120): number {
  const centers = [650, 1250, 2500], widths = [90, 110, 160], heights = [1, 0.8, 0.6]
  return (0.025 + centers.reduce((sum, center, i) => sum + heights[i] * Math.exp(-0.5 * ((hz - center) / widths[i]) ** 2), 0)) * Math.sqrt(f0 / Math.max(f0, hz))
}
function vowel(rate = 48000, f0 = 120): Float32Array {
  const result = new Float32Array(rate * 2)
  for (let h = 1; h * f0 < Math.min(7500, rate * 0.45); h += 1) {
    const amplitude = vowelEnvelope(h * f0, f0), omega = 2 * Math.PI * f0 * h / rate
    for (let i = 0; i < result.length; i += 1) result[i] += amplitude * Math.sin(omega * i + 0.23 * h * h)
  }
  const peak = result.reduce((value, sample) => Math.max(value, Math.abs(sample)), 0)
  return result.map(value => value * 0.65 / peak)
}
function weightedVowel(source: Float32Array, rate = 48000): Float64Array {
  const count = Math.round(rate * 0.8), from = Math.round(rate * 0.6)
  return Float64Array.from({ length: count }, (_, i) => source[from + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (count - 1))))
}
function magnitude(weighted: Float64Array, hz: number, rate = 48000): number {
  const step = 2 * Math.PI * hz / rate, cr = Math.cos(step), ci = Math.sin(step)
  let pr = 1, pi = 0, real = 0, imaginary = 0
  for (const value of weighted) {
    real += value * pr; imaginary += value * pi
    const next = pr * cr - pi * ci
    pi = pr * ci + pi * cr; pr = next
  }
  return Math.max(1e-15, Math.hypot(real, imaginary))
}
function vowelPitch(weighted: Float64Array, expectedHz: number): number {
  const values = Array.from({ length: 17 }, (_, i) => Math.log(magnitude(weighted, expectedHz + (i - 8) * 0.125)))
  const peak = values.indexOf(Math.max(...values))
  if (!peak || peak === values.length - 1) throw new Error('Fundamental peak is outside the independent measurement window')
  const offset = 0.5 * (values[peak - 1] - values[peak + 1]) / (values[peak - 1] - 2 * values[peak] + values[peak + 1])
  return expectedHz + (peak - 8 + offset) * 0.125
}
function envelopeResidualDb(weighted: Float64Array, outputF0: number, formantCents = 0): number {
  const ratio = 2 ** (formantCents / 1200)
  const residuals = Array.from({ length: Math.floor(4500 / outputF0) }, (_, i) => {
    const hz = (i + 1) * outputF0
    return 20 * Math.log10(magnitude(weighted, hz) / vowelEnvelope(hz / ratio))
  })
  const gain = residuals.reduce((sum, value) => sum + value, 0) / residuals.length
  return Math.sqrt(residuals.reduce((sum, value) => sum + (value - gain) ** 2, 0) / residuals.length)
}

describe('actual Signalsmith WASM note renderer', () => {
  it('bypasses absent/zero edits bit exactly without sharing mutable buffers', async () => {
    const source = sine(220, 48000)
    for (const shifts of [{}, { one: 0 }] as Record<string, number>[]) {
      const [output] = await renderPitch([source], 48000, [note()], shifts)
      expect(output).toEqual(source)
      expect(output).not.toBe(source)
      output[0] = 100
      expect(source[0]).toBe(0)
    }
    const [preserved] = await renderPitch([source], 48000, [note()], {}, undefined, { preserveFormants: true, formantShifts: { one: 0 } })
    expect(preserved).toEqual(source)
    expect(preserved).not.toBe(source)
  })

  it('reduces vowel-envelope displacement for upward and downward pitch edits without changing the pitch target', async () => {
    const source = vowel(), segment = note('one', 0.1, 1.9, 69 + 12 * Math.log2(120 / 440))
    for (const cents of [-600, 600]) {
      const [follow] = await renderPitch([source], 48000, [segment], { one: cents })
      const [preserve] = await renderPitch([source], 48000, [segment], { one: cents }, undefined, { preserveFormants: true, formantShifts: {} })
      const expectedHz = 120 * 2 ** (cents / 1200), weighted = weightedVowel(preserve)
      const error = envelopeResidualDb(weighted, expectedHz)
      // This measured synthetic case improves the broad envelope; individual
      // formants are approximate. Wider-register/extreme failures remain in the
      // checked-in formant matrix and must not be described as exact recovery.
      expect(error).toBeLessThan(6)
      expect(error).toBeLessThan(envelopeResidualDb(weightedVowel(follow), expectedHz) * 0.65)
      expect(Math.abs(1200 * Math.log2(vowelPitch(weighted, expectedHz) / expectedHz))).toBeLessThan(0.1)
      expect(preserve.length).toBe(source.length)
      expect(preserve.subarray(0, 4800)).toEqual(source.subarray(0, 4800))
      expect(preserve.subarray(91200)).toEqual(source.subarray(91200))
    }
  })

  it('renders formant-only offsets and keeps their direction independent from pitch', async () => {
    const source = vowel(), original = source.slice(), segment = note('one', 0.1, 1.9, 69 + 12 * Math.log2(120 / 440))
    for (const formantCents of [-300, 300]) {
      const [output] = await renderPitch([source], 48000, [segment], {}, undefined, { preserveFormants: true, formantShifts: { one: formantCents } })
      const weighted = weightedVowel(output), error = envelopeResidualDb(weighted, 120, formantCents)
      expect(error).toBeLessThan(6)
      expect(error).toBeLessThan(envelopeResidualDb(weightedVowel(source), 120, formantCents) * 0.65)
      expect(error).toBeLessThan(envelopeResidualDb(weighted, 120, -formantCents) * 0.65)
      expect(Math.abs(1200 * Math.log2(vowelPitch(weighted, 120) / 120))).toBeLessThan(0.1)
      expect(output.length).toBe(source.length)
      expect(output).not.toEqual(source)
      expect(source).toEqual(original)
    }
  })

  it('retains legacy output with empty settings and composes pitch and envelope offsets consistently', async () => {
    const source = vowel(), segment = note('one', 0.1, 1.9, 69 + 12 * Math.log2(120 / 440))
    const [legacy] = await renderPitch([source], 48000, [segment], { one: 300 })
    const [explicitLegacy] = await renderPitch([source], 48000, [segment], { one: 300 }, undefined, { preserveFormants: false, formantShifts: { one: 0 } })
    const [cancelCompensation] = await renderPitch([source], 48000, [segment], { one: 300 }, undefined, { preserveFormants: true, formantShifts: { one: 300 } })
    expect(explicitLegacy).toEqual(legacy)
    expect(cancelCompensation).toEqual(legacy)
    const [preserve] = await renderPitch([source], 48000, [segment], { one: 300 }, undefined, { preserveFormants: true, formantShifts: {} })
    const [manual] = await renderPitch([source], 48000, [segment], { one: 300 }, undefined, { preserveFormants: false, formantShifts: { one: -300 } })
    expect(manual).toEqual(preserve)
  })

  it('clears the previous note formant state before rendering an adjacent pitch-only note', async () => {
    const source = vowel(), midi = 69 + 12 * Math.log2(120 / 440)
    const first = note('first', 0.1, 0.9, midi), second = note('second', 0.9, 1.9, midi)
    const [together] = await renderPitch([source], 48000, [first, second], { second: 300 }, undefined, { preserveFormants: false, formantShifts: { first: -300 } })
    const [alone] = await renderPitch([source], 48000, [second], { second: 300 })
    expect(together.subarray(43200)).toEqual(alone.subarray(43200))
    expect(together[43199]).toBe(source[43199])
    expect(together[43200]).toBe(source[43200])
  })

  it('moves pitch up and down while keeping source duration and unedited samples', async () => {
    const source = sine(220, 48000), original = source.slice()
    for (const cents of [700, -1200, 1200]) {
      const [output] = await renderPitch([source], 48000, [note()], { one: cents })
      const expected = 220 * 2 ** (cents / 1200)
      const actual = frequency(output, 48000)
      expect(Math.abs(1200 * Math.log2(actual / expected))).toBeLessThan(0.2)
      expect(output.length).toBe(source.length)
      expect(output.subarray(0, 4800)).toEqual(source.subarray(0, 4800))
      expect(output.subarray(43200)).toEqual(source.subarray(43200))
      expect(rms(output)).toBeGreaterThan(0.15)
      expect(source).toEqual(original)
    }
  })

  it('resolves small corrections and octave shifts without direct spectral-bin bias', async () => {
    const rate = 48000, source = sine(220, rate, 4)
    for (const cents of [-1200, -50, -20, 20, 50, 1200]) {
      const [output] = await renderPitch([source], rate, [note('one', 0.1, 3.9)], { one: cents })
      const actual = frequency(output, rate, 1, 3)
      const expected = 220 * 2 ** (cents / 1200)
      // Independent interpolated zero crossings, over the central two seconds.
      expect(Math.abs(1200 * Math.log2(actual / expected))).toBeLessThan(0.1)
      expect(output.length).toBe(source.length)
    }
  })

  it('filters frequencies that would alias during upward resampling', async () => {
    const rate = 8000, source = sine(3500, rate)
    const [output] = await renderPitch([source], rate, [note('one', 0.1, 0.9, 105)], { one: 1200 })
    expect(rms(output.subarray(2400, 5600)) / rms(source.subarray(2400, 5600))).toBeLessThan(0.01)
  })

  it('preserves stereo channel ordering, relative amplitude and antiphase', async () => {
    const left = sine(220, 44100), right = left.map(value => -value * 0.5)
    const [outLeft, outRight] = await renderPitch([left, right], 44100, [note()], { one: 500 })
    expect(outLeft.length).toBe(left.length)
    expect(outRight.length).toBe(right.length)
    let residual = 0, energy = 0
    for (let i = 12000; i < 30000; i += 1) {
      residual += (outRight[i] + outLeft[i] * 0.5) ** 2
      energy += outLeft[i] ** 2
    }
    // Less than -60 dB relative stereo residual; not bit-identical nonlinear DSP.
    expect(Math.sqrt(residual / energy)).toBeLessThan(0.001)
    expect(Math.abs(frequency(outLeft, 44100) - 220 * 2 ** (5 / 12))).toBeLessThan(2)
  })

  it('keeps exact frame counts and finite audio across supported processing rates', async () => {
    for (const rate of [8000, 44100, 48000, 96000, 192000]) {
      const source = sine(440, rate, 0.35)
      const [output] = await renderPitch([source], rate, [note('one', 0.05, 0.3, 69)], { one: 300 })
      expect(output.length).toBe(source.length)
      expect(output.every(Number.isFinite)).toBe(true)
      expect(rms(output)).toBeGreaterThan(0.1)
      expect(output[0]).toBe(source[0])
      expect(output.at(-1)).toBe(source.at(-1))
    }
  })

  it('uses independent shifts for adjacent notes and leaves the rest untouched', async () => {
    const source = sine(220, 48000, 1.5)
    const notes = [note('a', 0.1, 0.6), note('b', 0.6, 1.3)]
    const [output] = await renderPitch([source], 48000, notes, { a: 1200, b: -1200 })
    expect(Math.abs(frequency(output, 48000, 0.25, 0.45) - 440)).toBeLessThan(3)
    expect(Math.abs(frequency(output, 48000, 0.85, 1.15) - 110)).toBeLessThan(3)
    expect(output.subarray(62400)).toEqual(source.subarray(62400))
    // Crossfade endpoints return to the original and prevent a hard edit boundary.
    expect(output[28800]).toBe(source[28800])
  })

  it('accepts trim fragments below the detection minimum and bypasses one-frame fragments', async () => {
    const rate = 48000, source = sine(220, rate)
    const tiny = note('tiny', 0.1, 0.1 + 0.4 / rate)
    const one = note('one', 0.2, 0.2 + 1 / rate)
    const short = note('short', 0.3, 0.31)
    const [output] = await renderPitch([source], rate, [tiny, one, short], { tiny: 100, one: 200, short: 300 })
    expect(output.length).toBe(source.length)
    expect(output[4800]).toBe(source[4800])
    expect(output[9600]).toBe(source[9600])
    expect(output.every(Number.isFinite)).toBe(true)
  })

  it('allows at most two lowest-rate frames of saved end-time rounding', async () => {
    for (const rate of [44100, 96000, 192000]) {
      const source = sine(220, rate, 0.4)
      const [output] = await renderPitch([source], rate, [note('one', 0, 0.4 + 1 / 8000)], { one: 20 })
      expect(output.length).toBe(source.length)
      expect(output.every(Number.isFinite)).toBe(true)
      expect(output[0]).toBe(source[0])
      expect(output.at(-1)).toBe(source.at(-1))
      await expect(renderPitch([source], rate, [note('one', 0, 0.4 + 3 / 8000)], { one: 20 })).rejects.toThrow()
    }
  })

  it('rejects invalid shifts/overlaps and reports monotonic progress', async () => {
    const source = sine(220, 48000)
    await expect(renderPitch([source], 48000, [note()], { missing: 100 })).rejects.toThrow()
    await expect(renderPitch([source], 48000, [note()], { one: Infinity })).rejects.toThrow()
    await expect(renderPitch([source], 48000, [note()], { one: 1201 })).rejects.toThrow()
    await expect(renderPitch([source], 48000, [note(), note('two', 0.5, 0.95)], {})).rejects.toThrow()
    for (const formantShifts of [{ missing: 100 }, { one: Infinity }, { one: 1201 }, { one: -1201 }] as Record<string, number>[]) {
      await expect(renderPitch([source], 48000, [note()], {}, undefined, { preserveFormants: true, formantShifts })).rejects.toThrow('포먼트')
    }
    for (const cents of [-1200, 1200]) {
      await expect(renderPitch([source], 48000, [note()], { one: cents }, undefined, { preserveFormants: true, formantShifts: { one: -Math.sign(cents) } })).rejects.toThrow('보정 차이')
      const [boundary] = await renderPitch([source], 48000, [note()], { one: cents }, undefined, { preserveFormants: true, formantShifts: {} })
      expect(boundary.length).toBe(source.length)
      expect(boundary.every(Number.isFinite)).toBe(true)
    }
    for (const settings of [null, {}, { preserveFormants: 'true', formantShifts: {} }, { preserveFormants: true, formantShifts: [] }]) {
      await expect(renderPitch([source], 48000, [note()], {}, undefined, settings as unknown as PitchRenderSettings)).rejects.toThrow('포먼트')
    }
    const values: number[] = []
    await renderPitch([source], 48000, [note()], { one: 100 }, value => values.push(value))
    expect(values[0]).toBe(0)
    expect(values.at(-1)).toBe(1)
    expect(values.every((value, i) => value >= 0 && value <= 1 && (!i || value >= values[i - 1]))).toBe(true)
  })
})

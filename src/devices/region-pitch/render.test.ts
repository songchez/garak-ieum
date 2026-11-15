import { describe, expect, it } from 'vitest'
import { renderPcm } from '../audio-warp/stretch'
import { renderJob } from '../audio-warp/renderPlan'

const RATE = 48000
const sine = (hz: number, seconds: number) => Float32Array.from({ length: Math.round(RATE * seconds) }, (_, i) => Math.sin(2 * Math.PI * hz * i / RATE) * 0.4)
/** Zero-crossing frequency between start and end seconds. */
function frequency(channel: Float32Array, start: number, end: number): number {
  const crossings: number[] = []
  for (let i = Math.max(1, Math.ceil(start * RATE)); i < Math.floor(end * RATE); i += 1) {
    if (channel[i - 1] < 0 && channel[i] >= 0) crossings.push(i - channel[i] / (channel[i] - channel[i - 1]))
  }
  return (crossings.length - 1) * RATE / (crossings.at(-1)! - crossings[0])
}
const cents = (measured: number, expected: number) => 1200 * Math.log2(measured / expected)
const middle = (out: Float32Array) => frequency(out, out.length / RATE * 0.25, out.length / RATE * 0.75)

describe('region pitch render', () => {
  it('varispeed +12: 440 Hz plays at 880 Hz in half the length (pure resampling)', async () => {
    const source = sine(440, 1)
    const [out] = await renderPcm([source], RATE, renderJob({ warpRatio: 1, cents: 1200, mode: 'varispeed', formant: false }))
    expect(out.length).toBe(RATE / 2)
    expect(Math.abs(cents(middle(out), 880))).toBeLessThan(0.5)
  })

  it('varispeed −7 lengthens by 2^(7/12)', async () => {
    const source = sine(440, 0.5)
    const [out] = await renderPcm([source], RATE, renderJob({ warpRatio: 1, cents: -700, mode: 'varispeed', formant: false }))
    expect(out.length).toBe(Math.round(source.length * 2 ** (7 / 12)))
    expect(Math.abs(cents(middle(out), 440 * 2 ** (-7 / 12)))).toBeLessThan(0.5)
  })

  it.each([[1200], [-500], [350], [50]])('keep tempo %i cents: same length, shifted pitch', async shift => {
    const source = sine(440, 1.2)
    const [out] = await renderPcm([source], RATE, renderJob({ warpRatio: 1, cents: shift, mode: 'keep', formant: false }))
    expect(out.length).toBe(source.length)
    expect(Math.abs(cents(middle(out), 440 * 2 ** (shift / 1200)))).toBeLessThan(3)
  })

  it('warp + keep tempo in one render: warp length, transposed pitch, stereo kept', async () => {
    const left = sine(440, 1), right = sine(220, 1)
    const out = await renderPcm([left, right], RATE, renderJob({ warpRatio: 100 / 125, cents: -300, mode: 'keep', formant: false }))
    expect(out).toHaveLength(2)
    expect(out[0].length).toBe(Math.round(RATE * 100 / 125))
    expect(Math.abs(cents(middle(out[0]), 440 * 2 ** (-3 / 12)))).toBeLessThan(3)
    expect(Math.abs(cents(middle(out[1]), 220 * 2 ** (-3 / 12)))).toBeLessThan(3)
  })

  it('formant preservation still lands on the requested pitch', async () => {
    const source = sine(220, 1)
    const [out] = await renderPcm([source], RATE, renderJob({ warpRatio: 1, cents: 400, mode: 'keep', formant: true }))
    expect(out.length).toBe(source.length)
    expect(Math.abs(cents(middle(out), 220 * 2 ** (4 / 12)))).toBeLessThan(5)
  })

  it('never mutates its input and rejects out-of-range jobs', async () => {
    const source = sine(100, 0.1), copy = source.slice()
    await renderPcm([source], RATE, { stretch: 1, pitch: 2, formantSemitones: null })
    expect(source).toEqual(copy)
    await expect(renderPcm([source], RATE, { stretch: 1, pitch: 8, formantSemitones: null })).rejects.toThrow(/24반음/)
  })
})

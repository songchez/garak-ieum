import { describe, expect, it } from 'vitest'
import { stretchPcm } from './stretch'
import { encodeFloatWav } from './wav'
import { analyzeTempo } from './tempo'

const RATE = 48000
const sine = (hz: number, seconds: number, rate = RATE) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => Math.sin(2 * Math.PI * hz * i / rate) * 0.4)
function frequency(channel: Float32Array, rate: number, start: number, end: number): number {
  const crossings: number[] = []
  for (let i = Math.ceil(start * rate); i < Math.floor(end * rate); i += 1) {
    if (channel[i - 1] < 0 && channel[i] >= 0) crossings.push(i - channel[i] / (channel[i] - channel[i - 1]))
  }
  return (crossings.length - 1) * rate / (crossings.at(-1)! - crossings[0])
}

describe('warp stretch', () => {
  it.each([0.5, 0.8, 1.25, 2])('stretches by %f while keeping pitch', async ratio => {
    const source = sine(440, 1.5)
    const [out] = await stretchPcm([source], RATE, ratio)
    expect(out.length).toBe(Math.round(source.length * ratio))
    const seconds = out.length / RATE
    expect(frequency(out, RATE, seconds * 0.25, seconds * 0.75)).toBeCloseTo(440, 0)
    expect(source[100]).toBeCloseTo(Math.sin(2 * Math.PI * 440 * 100 / RATE) * 0.4, 6)
  })

  it('keeps stereo layout and aligns transients after latency compensation', async () => {
    const left = new Float32Array(RATE * 2), right = new Float32Array(RATE * 2)
    for (let i = 0; i < 480; i += 1) left[RATE + i] = Math.exp(-i / 80) * Math.sin(i * 0.7)
    right.set(sine(220, 2))
    const out = await stretchPcm([left, right], RATE, 1.5)
    expect(out).toHaveLength(2)
    let peak = 0, at = 0
    out[0].forEach((value, i) => { if (Math.abs(value) > peak) { peak = Math.abs(value); at = i } })
    expect(Math.abs(at / RATE - 1.5)).toBeLessThan(0.03)
    expect(frequency(out[1], RATE, 0.5, 2.5)).toBeCloseTo(220, 0)
  })

  it('moves the beat grid of a click loop to the new tempo', async () => {
    const source = new Float32Array(RATE * 12)
    for (let t = 0; t < 11.9; t += 0.6) for (let i = 0; i < 600; i += 1) source[Math.round(t * RATE) + i] += 0.8 * Math.exp(-i / 200) * Math.sin(2 * Math.PI * 1500 * i / RATE)
    // 100 → 125 BPM shortens the audio by 100/125.
    const [out] = await stretchPcm([source], RATE, 100 / 125)
    expect(analyzeTempo([out], RATE)!.bpm).toBe(125)
  })

  it('rejects unsupported ratios and returns a copy for ratio 1', async () => {
    const source = sine(100, 0.2)
    await expect(stretchPcm([source], RATE, 8)).rejects.toThrow(/1\/4~4배/)
    const [copy] = await stretchPcm([source], RATE, 1)
    expect(copy).not.toBe(source)
    expect(copy).toEqual(source)
  })

  it('encodes float WAV with exact samples', async () => {
    const blob = encodeFloatWav([Float32Array.of(0.5, -1.25), Float32Array.of(0, 2)], 44100)
    const view = new DataView(await blob.arrayBuffer())
    expect(view.getUint16(20, true)).toBe(3)
    expect(view.getUint16(22, true)).toBe(2)
    expect([0, 1, 2, 3].map(i => view.getFloat32(56 + i * 4, true))).toEqual([0.5, 0, -1.25, 2])
  })
})

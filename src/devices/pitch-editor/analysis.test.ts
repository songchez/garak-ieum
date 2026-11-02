import { describe, expect, it } from 'vitest'
import { analyzePitch } from './analysis'

const sine = (frequency: number, seconds = 0.7, sampleRate = 48000) => Float32Array.from({ length: Math.round(seconds * sampleRate) }, (_, index) => 0.4 * Math.sin(2 * Math.PI * frequency * index / sampleRate))
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]
const centsError = (midi: number, hz: number) => Math.abs(midi - (69 + 12 * Math.log2(hz / 440))) * 100

describe('monophonic pitch analysis', () => {
  it('measures pitched PCM at different source rates and keeps source coordinates', () => {
    for (const [sampleRate, frequency] of [[8000, 110], [44100, 440], [48000, 220], [192000, 880]]) {
      const channel = sine(frequency, 0.5, sampleRate)
      const analysis = analyzePitch([channel], sampleRate)
      const center = analysis.contour.filter(point => point.time > 0.1 && point.time < 0.4)
      expect(center.length).toBeGreaterThan(20)
      expect(centsError(median(center.map(point => point.midi)), frequency)).toBeLessThan(10)
      expect(analysis.notes.length).toBeGreaterThan(0)
      expect(analysis.sampleRate).toBe(sampleRate)
      expect(analysis.sourceFrames).toBe(channel.length)
      expect(analysis.notes.every(note => note.start >= 0 && note.end <= 0.5)).toBe(true)
    }
  })

  it('does not cancel an antiphase stereo source or mutate its PCM', () => {
    const left = sine(330), right = left.map(value => -value)
    const original = left.slice()
    const analysis = analyzePitch([left, right], 48000)
    expect(centsError(median(analysis.contour.map(point => point.midi)), 330)).toBeLessThan(10)
    expect(left).toEqual(original)
    expect(right).toEqual(original.map(value => -value))
  })

  it('keeps supported boundary tones and rejects clearly out-of-range tones', () => {
    for (const frequency of [55, 1600]) {
      const result = analyzePitch([sine(frequency, 0.5)], 48000)
      const points = result.contour.filter(point => point.time > 0.1 && point.time < 0.4)
      expect(points.length).toBeGreaterThan(20)
      expect(centsError(median(points.map(point => point.midi)), frequency)).toBeLessThan(5)
    }
    for (const frequency of [54, 1610]) {
      expect(analyzePitch([sine(frequency, 0.5)], 48000).notes).toEqual([])
    }
  })

  it('detects pitch changes while preserving a continuous vibrato curve', () => {
    const rate = 12000
    const channel = new Float32Array(rate * 2)
    let phase = 0
    for (let i = 0; i < channel.length; i += 1) {
      const frequency = (i < rate ? 220 : 330) * 2 ** ((0.22 * Math.sin(2 * Math.PI * 5 * i / rate)) / 12)
      phase += 2 * Math.PI * frequency / rate
      channel[i] = 0.4 * Math.sin(phase)
    }
    const analysis = analyzePitch([channel], rate)
    expect(analysis.notes.length).toBe(2)
    expect(centsError(analysis.notes[0].midi, 220)).toBeLessThan(15)
    expect(centsError(analysis.notes[1].midi, 330)).toBeLessThan(15)
    const curve = analysis.contour.filter(point => point.time > 0.2 && point.time < 0.8).map(point => point.midi)
    expect(Math.max(...curve) - Math.min(...curve)).toBeGreaterThan(0.25)
  })

  it('separates equal notes around an unvoiced gap and ignores silence/noise', () => {
    const rate = 12000
    const channel = new Float32Array(rate)
    channel.set(sine(220, 0.3, rate), 0)
    channel.set(sine(220, 0.3, rate), rate * 0.6)
    const result = analyzePitch([channel], rate)
    expect(result.notes.length).toBe(2)
    expect(result.contour.some(point => point.time > 0.4 && point.time < 0.5)).toBe(false)
    expect(analyzePitch([new Float32Array(rate)], rate).notes).toEqual([])
    let state = 19
    const noise = Float32Array.from({ length: rate / 2 }, () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return (state / 0xffffffff - 0.5) * 0.5 })
    expect(analyzePitch([noise], rate).notes).toEqual([])
  })

  it('rejects unsupported/invalid PCM before doing DSP and bounds progress', () => {
    expect(() => analyzePitch([], 48000)).toThrow()
    expect(() => analyzePitch([new Float32Array(1)], 7999)).toThrow()
    expect(() => analyzePitch([new Float32Array(48000 * 60 + 1)], 48000)).toThrow()
    expect(() => analyzePitch([Float32Array.of(NaN)], 48000)).toThrow()
    expect(() => analyzePitch([Float32Array.of(0), Float32Array.of(0, 1)], 48000)).toThrow()
    const progress: number[] = []
    analyzePitch([sine(220, 0.2)], 48000, value => progress.push(value))
    expect(progress[0]).toBe(0)
    expect(progress.at(-1)).toBe(1)
    expect(progress.every((value, i) => value >= 0 && value <= 1 && (!i || value >= progress[i - 1]))).toBe(true)
  })
})

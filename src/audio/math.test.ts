import { describe, expect, it } from 'vitest'
import type { Project } from '../core/types'
import { clipEnvelope, encodePcm16Wav, normalizedStart, positionAfter } from './math'

const project: Project = {
  schemaVersion: 8, id: 'test', name: 'Test', bpm: 120, sampleRate: 48000, timeSignature: { numerator: 4, denominator: 4 }, beatsPerBar: 4,
  lengthBeats: 32, masterVolume: 0.8,
  loop: { enabled: true, startBeat: 8, endBeat: 16 }, tracks: [], markers: [],
}

describe('audio clock position', () => {
  it('keeps the pre-loop section and wraps repeatedly into a loop with a nonzero start', () => {
    expect(positionAfter(project, 4, 1)).toBe(6)
    expect(positionAfter(project, 4, 6)).toBe(8)
    expect(positionAfter(project, 4, 11.5)).toBe(11)
    expect(normalizedStart(project, 30)).toBe(8)
  })

  it('holds during the initial scheduled lead and clamps a non-looping end', () => {
    expect(positionAfter(project, 9, -0.025)).toBe(9)
    expect(positionAfter({ ...project, loop: { ...project.loop, enabled: false } }, 30, 5)).toBe(32)
  })
})

describe('clip fades', () => {
  it('computes the right gain when a seek lands inside a fade', () => {
    expect(clipEnvelope(0.25, 4, 1, 1)).toBeCloseTo(0.25)
    expect(clipEnvelope(3.75, 4, 1, 1)).toBeCloseTo(0.25)
    expect(clipEnvelope(2, 4, 1, 1)).toBe(1)
  })

  it('keeps overlong fades nonoverlapping after a short trim', () => {
    expect(clipEnvelope(0.1, 0.4, 5, 5)).toBeCloseTo(0.5)
    expect(clipEnvelope(0.2, 0.4, 5, 5)).toBe(1)
    expect(clipEnvelope(0.4, 0.4, 5, 5)).toBe(0)
  })
})

describe('PCM16 WAV export', () => {
  it('writes valid RIFF sizes and preserves stereo order, signed samples and clipping', () => {
    const encoded = encodePcm16Wav([new Float32Array([-1, 0.5, 2]), new Float32Array([1, -0.5, -2])], 48000)
    const view = new DataView(encoded)
    const text = (start: number, length: number): string => new TextDecoder().decode(new Uint8Array(encoded, start, length))
    expect(text(0, 4)).toBe('RIFF')
    expect(text(8, 4)).toBe('WAVE')
    expect(view.getUint32(4, true)).toBe(encoded.byteLength - 8)
    expect(view.getUint16(22, true)).toBe(2)
    expect(view.getUint32(24, true)).toBe(48000)
    expect(view.getUint32(28, true)).toBe(192000)
    expect(view.getUint32(40, true)).toBe(12)
    expect(Array.from({ length: 6 }, (_, index) => view.getInt16(44 + index * 2, true))).toEqual([-32768, 32767, 16384, -16384, 32767, -32768])
  })

  it('turns invalid samples into silence and rejects mismatched channels', () => {
    const encoded = encodePcm16Wav([new Float32Array([Number.NaN, Infinity])], 44100)
    expect(new DataView(encoded).getInt16(44, true)).toBe(0)
    expect(new DataView(encoded).getInt16(46, true)).toBe(0)
    expect(() => encodePcm16Wav([new Float32Array(2), new Float32Array(1)], 48000)).toThrow()
  })
})

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

type Processor = {
  port: { onmessage: ((event: { data: unknown }) => void) | null }
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean
}
const constructors = new Map<string, new () => Processor>()
const params = {
  sustain: Float32Array.of(0.35), attack: Float32Array.of(10), level: Float32Array.of(0), enabled: Float32Array.of(1),
  rate: Float32Array.of(0.8), depth: Float32Array.of(0.35), mix: Float32Array.of(0.25),
}
beforeAll(async () => {
  vi.stubGlobal('sampleRate', 48000)
  vi.stubGlobal('AudioWorkletProcessor', class { port = { onmessage: null } })
  vi.stubGlobal('registerProcessor', (name: string, factory: new () => Processor) => constructors.set(name, factory))
  await import('./processors.worklet')
})
afterAll(() => vi.unstubAllGlobals())

describe('worklet processor lifecycle and mono/stereo behavior', () => {
  it.each(['compressor', 'chorus', 'master'])('%s survives initially absent input, emits finite stereo audio, and ends after dispose', name => {
    const Factory = constructors.get(`garak-guitar-${name}-v1`)!
    const processor = new Factory()
    const output = [[new Float32Array(128), new Float32Array(128)]]
    expect(processor.process([[]], output, params)).toBe(true)
    expect(output[0].every(channel => channel.every(value => value === 0))).toBe(true)
    const impulse = new Float32Array(128); impulse[0] = 0.2
    expect(processor.process([[impulse]], output, params)).toBe(true)
    expect(output[0][0][0]).toBeGreaterThan(0)
    expect(output[0][1][0]).toBeGreaterThan(0)
    expect(output[0].every(channel => channel.every(Number.isFinite))).toBe(true)
    processor.port.onmessage!({ data: { type: 'dispose' } })
    expect(processor.process([[impulse]], output, params)).toBe(false)
    expect(output[0].every(channel => channel.every(value => value === 0))).toBe(true)
  })
})

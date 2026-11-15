import { describe, expect, it } from 'vitest'
import { createKernel } from './kernels'
import { bindDynamicsMeter, dynamicsReadingFrom, webDynamicsReading, type DynamicsMeterSource } from './dynamicsMeter'
import type { DeviceGraph } from '../contracts'

const SR = 48000
const sine = (frames: number, amplitude: number) => Float32Array.from({ length: frames }, (_, i) => amplitude * Math.sin(2 * Math.PI * 220 * i / SR))
function run(type: 'limiter' | 'gate', params: Record<string, number>, input: Float32Array) {
  const kernel = createKernel(type, SR, params)
  const l = input.slice(), r = input.slice()
  for (let at = 0; at < l.length; at += 128) kernel.process(l.subarray(at, at + 128), r.subarray(at, at + 128), Math.min(128, l.length - at))
  const out = new Float32Array(2)
  kernel.meter!(out)
  return { out, kernel }
}

describe('dynamics meter plumbing', () => {
  it('limiter kernel reports raw input peak and its lowest gain, then restarts the window', () => {
    const { out, kernel } = run('limiter', { gain: 12, ceiling: -6 }, sine(9600, 0.5))
    expect(out[0]).toBeCloseTo(0.5, 2)                       // raw input, before the input gain
    // 0.5 · 4 (12 dB) into 0.5 (−6 dB): about −12 dB of reduction.
    expect(20 * Math.log10(out[1])).toBeCloseTo(-12, 0)
    const again = new Float32Array(2); kernel.meter!(again)
    expect(again[0]).toBe(0); expect(again[1]).toBe(1)
  })

  it('gate kernel reports open (gain≈1) on a loud tone and closed on silence', () => {
    const loud = new Float32Array(9600); loud.set(sine(9600, 0.3))
    const { kernel } = run('gate', { threshold: -40, attack: 0.1 }, loud)
    const l = sine(4800, 0.3), r = l.slice(), out = new Float32Array(2)
    kernel.process(l, r, l.length); kernel.meter!(out)
    expect(out[1]).toBeGreaterThan(0.99)
    const quiet = new Float32Array(48000)
    for (let at = 0; at < quiet.length; at += 128) kernel.process(quiet.subarray(at, at + 128), quiet.slice(at, at + 128), 128)
    kernel.meter!(out); expect(out[1]).toBe(0)
  })

  it('kernels without dynamics have no meter', () => {
    expect(createKernel('delay', SR).meter).toBeUndefined()
  })

  it('binds realtime sources by device id, ignores offline contexts and forgets disposed sources', () => {
    const source: DynamicsMeterSource = { read: () => ({ input: 0.4, gain: 0.7 }) }
    const graph = { dynamicsMeter: source } as unknown as DeviceGraph
    bindDynamicsMeter(graph, 'offline-dev', { startRendering() {} } as unknown as BaseAudioContext)
    expect(webDynamicsReading('offline-dev')).toBeNull()
    bindDynamicsMeter(graph, 'dev-1', {} as BaseAudioContext)
    expect(webDynamicsReading('dev-1')).toEqual({ input: 0.4, gain: 0.7 })
    source.disposed = true
    expect(webDynamicsReading('dev-1')).toBeNull()
  })

  it('validates native IPC readings', () => {
    expect(dynamicsReadingFrom({ input: 0.5, gain: 0.25 })).toEqual({ input: 0.5, gain: 0.25 })
    expect(dynamicsReadingFrom({ input: 2, gain: 3 })).toEqual({ input: 2, gain: 1 })
    expect(dynamicsReadingFrom({ input: 'x', gain: 1 })).toBeNull()
    expect(dynamicsReadingFrom({ input: Number.NaN, gain: 1 })).toBeNull()
    expect(dynamicsReadingFrom(null)).toBeNull()
  })
})

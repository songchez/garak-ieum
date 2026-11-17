import { describe, expect, it } from 'vitest'
import { requestedDeviceAnalysis, deviceAnalysisTap } from '../devices/effects/analysis'
import { guitarTunerTap, requestedGuitarTuners } from '../devices/guitar-rig/tuner'
import { detectPitch } from '../devices/guitar-rig'
import { EngineAnalyser } from './engineAnalyser'
import { ANALYSIS_FRAMES, AnalysisRings } from './rust/engineChannel'

const RATE = 48_000
/** Interleaved stereo history: a sine on the left, its inverse at half level on the right. */
function history(hz: number, frames = ANALYSIS_FRAMES): Float32Array {
  const data = new Float32Array(frames * 2)
  for (let i = 0; i < frames; i += 1) {
    const x = 0.5 * Math.sin((2 * Math.PI * hz * i) / RATE)
    data[2 * i] = x
    data[2 * i + 1] = -0.5 * x
  }
  return data
}

describe('engine analysis readers', () => {
  it('read the newest frames of the chosen channel, and silence before data', () => {
    let data: Float32Array | null = null
    const source = { latest: () => data }
    const left = new EngineAnalyser(source, 1024, 'left'), right = new EngineAnalyser(source, 1024, 'right'), mono = new EngineAnalyser(source, 1024, 'mono')
    const out = new Float32Array(1024).fill(9)
    left.getFloatTimeDomainData(out)
    expect(out.every(v => v === 0)).toBe(true)
    data = history(1000)
    left.getFloatTimeDomainData(out)
    const newest = data.length / 2 - 1
    expect(out[1023]).toBe(data[2 * newest])
    right.getFloatTimeDomainData(out)
    expect(out[1023]).toBe(data[2 * newest + 1])
    mono.getFloatTimeDomainData(out)
    expect(out[1023]).toBeCloseTo(0.5 * (data[2 * newest] + data[2 * newest + 1]), 7)
  })

  it('put a sine\'s energy in its frequency bin like an AnalyserNode (|X| / N, Blackman window, dB)', () => {
    const hz = 1500
    const analyser = new EngineAnalyser({ latest: () => history(hz) }, 4096, 'left')
    analyser.smoothingTimeConstant = 0
    const bins = new Float32Array(analyser.frequencyBinCount)
    analyser.getFloatFrequencyData(bins)
    let peak = 0
    for (let k = 1; k < bins.length; k += 1) if (bins[k] > bins[peak]) peak = k
    expect(Math.abs(peak * RATE / 4096 - hz)).toBeLessThan(RATE / 4096)
    // A 0.5 sine through a Blackman window (coherent gain 0.42) at |X| / N: 0.5 * 0.42 / 2 ≈ -19.6 dB.
    expect(bins[peak]).toBeGreaterThan(-23)
    expect(bins[peak]).toBeLessThan(-18)
    expect(bins[Math.round(8000 * 4096 / RATE)]).toBeLessThan(bins[peak] - 60)
  })

  it('feed the tuner: its YIN estimator finds the pitch in an engine tap', () => {
    const analyser = new EngineAnalyser({ latest: () => history(110) }, 4096, 'mono')
    const buffer = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(buffer)
    expect(detectPitch(buffer, RATE)).toBeCloseTo(110, 0)
  })
})

describe('analysis requests', () => {
  it('a lookup is a request that expires when the editor stops looking', () => {
    expect(deviceAnalysisTap('eq-1')).toBeUndefined()
    expect(guitarTunerTap('rig-1')).toBeUndefined()
    expect(requestedDeviceAnalysis()).toContain('eq-1')
    expect(requestedGuitarTuners()).toContain('rig-1')
    const later = performance.now() + 5000
    expect(requestedDeviceAnalysis(1500, later)).not.toContain('eq-1')
    expect(requestedGuitarTuners(1500, later)).not.toContain('rig-1')
  })
})

describe('worklet analysis rings', () => {
  it('keep each tap\'s newest frames oldest first across render calls', () => {
    const rings = new AnalysisRings()
    const slotFrames = 128
    const view = new Float32Array(4 * slotFrames * 2)
    let t = 0
    for (let call = 0; call < 100; call += 1) {
      for (let i = 0; i < slotFrames; i += 1) { view[2 * i] = t; view[2 * i + 1] = -t; view[slotFrames * 2 + 2 * i] = 2 * t; t += 1 }
      rings.append(view, slotFrames, 2, slotFrames)
    }
    const out = new Float32Array(ANALYSIS_FRAMES * 2)
    rings.copySlot(0, out)
    expect(out[out.length - 2]).toBe(t - 1)
    expect(out[out.length - 1]).toBe(-(t - 1))
    expect(out[0]).toBe(t - ANALYSIS_FRAMES)
    rings.copySlot(1, out)
    expect(out[out.length - 2]).toBe(2 * (t - 1))
    rings.clear()
    rings.copySlot(0, out)
    expect(out.every(v => v === 0)).toBe(true)
  })
})

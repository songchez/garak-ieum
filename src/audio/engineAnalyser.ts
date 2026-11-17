import type { AnalysisReader } from '../devices/effects/analysis'

/** Where an engine analysis tap's latest history comes from: interleaved stereo frames, oldest first. */
export interface AnalysisSource {
  /** The latest history, or null before the first publication. */
  latest(): Float32Array | null
}

/**
 * An AnalyserNode-shaped reader over an engine analysis tap (the editors read it exactly as they read the
 * Web Audio analysers of 0.3.2): the newest `fftSize` frames as time-domain data, and a Blackman-windowed
 * FFT smoothed over time in dB for the spectrum, with AnalyserNode's defaults and scaling (|X[k]| / N).
 */
export class EngineAnalyser implements AnalysisReader {
  smoothingTimeConstant = 0.72
  minDecibels = -110
  maxDecibels = 0
  private readonly re: Float64Array
  private readonly im: Float64Array
  private readonly smooth: Float64Array
  private readonly window: Float64Array
  private readonly reverse: Uint32Array
  private readonly samples: Float32Array

  constructor(private readonly source: AnalysisSource, readonly fftSize: number, private readonly channel: 'mono' | 'left' | 'right') {
    if (!Number.isInteger(Math.log2(fftSize)) || fftSize < 32) throw new Error(`fftSize must be a power of two (${fftSize})`)
    this.re = new Float64Array(fftSize)
    this.im = new Float64Array(fftSize)
    this.smooth = new Float64Array(fftSize / 2)
    this.samples = new Float32Array(fftSize)
    this.window = Float64Array.from({ length: fftSize }, (_, i) => {
      const x = (2 * Math.PI * i) / fftSize
      return 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x)
    })
    const bits = Math.log2(fftSize)
    this.reverse = Uint32Array.from({ length: fftSize }, (_, i) => {
      let r = 0
      for (let b = 0; b < bits; b += 1) r |= ((i >> b) & 1) << (bits - 1 - b)
      return r
    })
  }

  get frequencyBinCount(): number { return this.fftSize / 2 }

  /** The newest `min(out.length, fftSize)` frames of the chosen channel (silence before data arrives). */
  getFloatTimeDomainData(out: Float32Array): void {
    const data = this.source.latest()
    const n = Math.min(out.length, this.fftSize)
    out.fill(0)
    if (!data) return
    const frames = data.length / 2
    const start = frames - n
    for (let i = 0; i < n; i += 1) {
      const at = (start + i) * 2
      if (at < 0) continue
      const l = data[at], r = data[at + 1]
      out[i] = this.channel === 'left' ? l : this.channel === 'right' ? r : 0.5 * (l + r)
    }
  }

  /** Smoothed magnitude spectrum in dB, `min(out.length, frequencyBinCount)` bins. */
  getFloatFrequencyData(out: Float32Array): void {
    const n = this.fftSize, re = this.re, im = this.im
    this.getFloatTimeDomainData(this.samples)
    for (let i = 0; i < n; i += 1) { re[this.reverse[i]] = this.samples[i] * this.window[i]; im[this.reverse[i]] = 0 }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2, step = (-2 * Math.PI) / size
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k += 1) {
          const wr = Math.cos(step * k), wi = Math.sin(step * k)
          const a = start + k, b = a + half
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr
          re[b] = re[a] - tr; im[b] = im[a] - ti
          re[a] += tr; im[a] += ti
        }
      }
    }
    const tau = Math.min(1, Math.max(0, this.smoothingTimeConstant))
    const bins = Math.min(out.length, n / 2)
    for (let k = 0; k < n / 2; k += 1) {
      const magnitude = Math.hypot(re[k], im[k]) / n
      const value = tau * this.smooth[k] + (1 - tau) * magnitude
      this.smooth[k] = Number.isFinite(value) ? value : 0
      if (k < bins) out[k] = this.smooth[k] > 0 ? 20 * Math.log10(this.smooth[k]) : -Infinity
    }
  }
}

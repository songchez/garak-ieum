/**
 * Phaser and tremolo shared by the Web Audio worklet and mirrored sample-for-sample by the
 * native GuitarRig (native/src/dsp.cpp, classes Phaser and Tremolo). Keep the two in sync.
 */
const finite = (value: number, fallback: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : fallback))
export const PHASER_STAGES = 6

/** Six first-order allpass stages swept exponentially 200 Hz – 3.2 kHz, summed 50/50 with the dry signal. */
export class GuitarPhaser {
  private readonly state = [new Float64Array(PHASER_STAGES), new Float64Array(PHASER_STAGES)]
  private readonly last = new Float64Array(2)
  private phase = 0
  private rate = 0.45
  private depth = 0.7
  private feedback = 0.35
  private mix = 0
  private targetMix = 0
  private readonly smoothing: number

  constructor(private readonly sampleRate: number) {
    this.smoothing = 1 - Math.exp(-1 / (0.012 * sampleRate))
  }

  configure(rate: number, depth: number, feedback: number, enabled: boolean, immediate = false): void {
    this.rate = finite(rate, 0.45, 0.05, 4)
    this.depth = finite(depth, 0.7, 0, 1)
    this.feedback = finite(feedback, 0.35, 0, 0.85)
    this.targetMix = enabled ? 1 : 0
    if (immediate) this.mix = this.targetMix
  }

  /** One stereo frame in place. The right channel's sweep is a quarter cycle ahead. */
  sample(left: number, right: number, out: Float64Array): void {
    if (this.targetMix === 0 && this.mix < 1e-6) {
      this.mix = 0
      out[0] = left; out[1] = right
      return
    }
    this.mix += (this.targetMix - this.mix) * this.smoothing
    for (let c = 0; c < 2; c += 1) {
      const x = c ? right : left
      const lfo = 0.5 + 0.5 * Math.sin(this.phase + (c ? Math.PI / 2 : 0))
      const frequency = 200 * Math.pow(16, 0.5 + (lfo - 0.5) * this.depth)
      const t = Math.tan(Math.PI * Math.min(frequency, this.sampleRate * 0.45) / this.sampleRate)
      const a = (t - 1) / (t + 1)
      const z = this.state[c]
      let y = x + this.feedback * this.last[c]
      for (let stage = 0; stage < PHASER_STAGES; stage += 1) {
        const output = a * y + z[stage]
        z[stage] = y - a * output
        if (Math.abs(z[stage]) < 1e-30) z[stage] = 0
        y = output
      }
      this.last[c] = y
      out[c] = x * (1 - this.mix) + this.mix * 0.5 * (x + y)
    }
    this.phase += 2 * Math.PI * this.rate / this.sampleRate
    if (this.phase >= 2 * Math.PI) this.phase -= 2 * Math.PI
  }
}

/** Amplitude LFO. Shape morphs a sine into a soft square; depth 1 reaches silence at the trough. */
export class GuitarTremolo {
  private phase = 0
  private rate = 4.5
  private depth = 0.5
  private shape = 0
  private enabled = 0
  private targetEnabled = 0
  private readonly smoothing: number

  constructor(private readonly sampleRate: number) {
    this.smoothing = 1 - Math.exp(-1 / (0.012 * sampleRate))
  }

  configure(rate: number, depth: number, shape: number, enabled: boolean, immediate = false): void {
    this.rate = finite(rate, 4.5, 0.5, 12)
    this.depth = finite(depth, 0.5, 0, 1)
    this.shape = finite(shape, 0, 0, 1)
    this.targetEnabled = enabled ? 1 : 0
    if (immediate) this.enabled = this.targetEnabled
  }

  /** Gain for the next frame (1 when bypassed). */
  gain(): number {
    if (this.targetEnabled === 0 && this.enabled < 1e-6) { this.enabled = 0; return 1 }
    this.enabled += (this.targetEnabled - this.enabled) * this.smoothing
    const k = 0.01 + this.shape * 9
    const wave = Math.tanh(k * Math.sin(this.phase)) / Math.tanh(k)
    this.phase += 2 * Math.PI * this.rate / this.sampleRate
    if (this.phase >= 2 * Math.PI) this.phase -= 2 * Math.PI
    return 1 - this.enabled * this.depth * 0.5 * (1 - wave)
  }
}

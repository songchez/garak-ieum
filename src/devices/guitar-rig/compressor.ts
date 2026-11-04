/** Original causal peak compressor. No delay line, lookahead, FFT, or allocations per sample. */
export class GuitarCompressor {
  private envelope = 0
  private attack = 0
  private release = 0
  private threshold = -24
  private strength = 0.75
  private makeup = 1
  private enabled = true
  private wet = 1
  private readonly switchStep: number

  constructor(private readonly rate: number) {
    this.switchStep = 1 / (0.005 * rate)
    this.configure(0.35, 10, 0, true, true)
  }

  configure(sustain: number, attackMs: number, levelDb: number, enabled: boolean, immediate = false): void {
    const amount = Math.min(1, Math.max(0, Number.isFinite(sustain) ? sustain : 0.35))
    this.threshold = -12 - amount * 30
    const ratio = 1 + amount * 7
    this.strength = 1 - 1 / ratio
    this.attack = Math.exp(-1 / (Math.max(0.5, Math.min(50, Number.isFinite(attackMs) ? attackMs : 10)) * 0.001 * this.rate))
    this.release = Math.exp(-1 / ((0.09 + amount * 0.1) * this.rate))
    // Modest automatic compensation makes Sustain useful without overwhelming the amp.
    this.makeup = Math.pow(10, (Math.min(18, Math.max(-18, Number.isFinite(levelDb) ? levelDb : 0)) + amount * 6) / 20)
    this.enabled = enabled
    if (immediate) this.wet = enabled ? 1 : 0
  }

  /** Linked detector returns one gain for all channels, preserving stereo image. */
  gain(peak: number): number {
    const target = this.enabled ? 1 : 0
    if (this.wet !== target) this.wet += Math.max(-this.switchStep, Math.min(this.switchStep, target - this.wet))
    if (this.wet === 0) { this.envelope = 0; return 1 }
    const sample = Number.isFinite(peak) ? Math.min(32, Math.abs(peak)) : 0
    const coefficient = sample > this.envelope ? this.attack : this.release
    this.envelope = sample + coefficient * (this.envelope - sample)
    if (sample === 0 && this.envelope < 1e-12) { this.envelope = 0; return 1 + this.wet * (this.makeup - 1) }
    const level = 20 * Math.log10(Math.max(1e-12, this.envelope))
    const above = level - this.threshold
    const knee = 6
    const over = above < -knee / 2 ? 0 : above < knee / 2 ? (above + knee / 2) ** 2 / (2 * knee) : above
    const compressed = Math.pow(10, -this.strength * over / 20) * this.makeup
    return 1 + this.wet * (compressed - 1)
  }

  reset(): void { this.envelope = 0 }
}

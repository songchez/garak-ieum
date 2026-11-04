/** Causal safety master for guitar projects: peak-linked gain reduction plus a final soft ceiling. */
export class GuitarMaster {
  private envelope = 0
  private readonly attack: number
  private readonly release: number
  constructor(sampleRate: number) {
    this.attack = Math.exp(-1 / (sampleRate * 0.003))
    this.release = Math.exp(-1 / (sampleRate * 0.12))
  }

  gain(peak: number): number {
    const finite = Number.isFinite(peak) ? Math.min(32, Math.abs(peak)) : 0
    const coefficient = finite > this.envelope ? this.attack : this.release
    this.envelope = finite + coefficient * (this.envelope - finite)
    if (this.envelope <= 0.5956621435) return 1 // -4.5 dB: the beginning of the soft knee.
    const above = 20 * Math.log10(this.envelope) + 3
    const over = above < 1.5 ? (above + 1.5) ** 2 / 6 : above
    return Math.pow(10, -(11 / 12) * over / 20)
  }

  /** No delayed limiter promise: very large peaks are smoothly saturated in the same sample. */
  sample(input: number, gain: number): number {
    if (!Number.isFinite(input)) return 0
    const value = Math.max(-32, Math.min(32, input)) * gain
    const magnitude = Math.abs(value)
    if (magnitude <= 0.9) return value
    return Math.sign(value) * (0.9 + 0.08 * Math.tanh((magnitude - 0.9) / 0.08))
  }
}

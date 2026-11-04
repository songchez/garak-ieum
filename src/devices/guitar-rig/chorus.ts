/** Small causal stereo chorus. The dry path has no deliberate delay. */
export class GuitarChorus {
  private readonly left: Float32Array
  private readonly right: Float32Array
  private write = 0
  private phase = 0
  private rate = 0.8
  private depth = 0.35
  private mix = 0
  private targetMix = 0
  private readonly smoothing: number
  private silentFrames: number

  constructor(private readonly sampleRate: number) {
    this.left = new Float32Array(Math.ceil(sampleRate * 0.05) + 4)
    this.right = new Float32Array(this.left.length)
    this.silentFrames = this.left.length
    this.smoothing = 1 - Math.exp(-1 / (0.012 * sampleRate))
  }

  configure(rate: number, depth: number, mix: number, enabled: boolean, immediate = false): void {
    this.rate = Math.min(5, Math.max(0.1, Number.isFinite(rate) ? rate : 0.8))
    this.depth = Math.min(1, Math.max(0, Number.isFinite(depth) ? depth : 0.35))
    this.targetMix = enabled ? Math.min(0.6, Math.max(0, Number.isFinite(mix) ? mix : 0.25)) : 0
    if (immediate) this.mix = this.targetMix
  }

  process(input: readonly Float32Array[], output: readonly Float32Array[]): void {
    const a = input[0]
    const b = input[1] ?? a
    const outL = output[0]
    const outR = output[1]
    if (!outL) return
    const size = this.left.length
    // Modulator is suspended at a stable bypass. Keep writing history for a clean re-enable.
    const active = this.targetMix > 0 || this.mix > 1e-7
    for (let i = 0; i < outL.length; i += 1) {
      const l = a && Number.isFinite(a[i]) ? a[i] : 0
      const r = b && Number.isFinite(b[i]) ? b[i] : 0
      this.silentFrames = l === 0 && r === 0 ? Math.min(size, this.silentFrames + 1) : 0
      this.left[this.write] = l
      this.right[this.write] = r
      if (active) this.mix += (this.targetMix - this.mix) * this.smoothing
      if (active && this.silentFrames < size) {
        const modulation = Math.sin(this.phase) * this.depth * 0.005
        const leftDelay = (0.014 + modulation) * this.sampleRate
        const rightDelay = (0.017 - modulation) * this.sampleRate
        const wetL = this.read(this.left, leftDelay)
        const wetR = this.read(this.right, rightDelay)
        outL[i] = l * (1 - this.mix * 0.5) + wetL * this.mix * 0.5
        if (outR) outR[i] = r * (1 - this.mix * 0.5) + wetR * this.mix * 0.5
        this.phase += 2 * Math.PI * this.rate / this.sampleRate
        if (this.phase >= 2 * Math.PI) this.phase -= 2 * Math.PI
      } else {
        if (!active) this.mix = 0
        outL[i] = l
        if (outR) outR[i] = r
      }
      this.write += 1
      if (this.write === size) this.write = 0
    }
  }

  private read(buffer: Float32Array, delay: number): number {
    let position = this.write - delay
    if (position < 0) position += buffer.length
    const index = Math.floor(position)
    const fraction = position - index
    const next = index + 1 === buffer.length ? 0 : index + 1
    return buffer[index] + fraction * (buffer[next] - buffer[index])
  }
}

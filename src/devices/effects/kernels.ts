import type { ParamDef } from '../contracts.js'
import { KERNEL_DEFS, type KernelType } from './sigimsaeDefs.js'

/**
 * Sample-processed 시김새 kernels for the Web Audio worklet. native/src/sigimsae_effects.inc mirrors
 * every class here line for line (same state, same order of operations); keep the two in sync.
 * Kernels never allocate after construction. configure() sets targets: the first call is applied
 * immediately, later calls glide over ~12 ms so knob moves do not click.
 */
export interface SigimsaeKernel {
  configure(params: Record<string, number> | undefined, bpm: number): void
  /** Stereo in place. */
  process(left: Float32Array, right: Float32Array, frames: number): void
  reset(): void
}

const TAU = 2 * Math.PI
const dbToGain = (db: number) => Math.pow(10, db / 20)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function readParams(defs: readonly ParamDef[], params: Record<string, number> | undefined): (id: string) => number {
  return id => {
    const def = defs.find(d => d.id === id)!
    const value = params?.[id]
    return clamp(typeof value === 'number' && Number.isFinite(value) ? value : def.default, def.min, def.max)
  }
}

/** Float32 ring; read(age) interpolates `age` frames behind the newest pushed frame. */
export class Ring {
  private readonly data: Float32Array
  private write = 0
  constructor(readonly size: number) { this.data = new Float32Array(size) }
  push(x: number): void { this.write = this.write + 1 === this.size ? 0 : this.write + 1; this.data[this.write] = x }
  read(age: number): number {
    age = clamp(age, 0, this.size - 2)
    const whole = Math.floor(age), fraction = age - whole
    let a = this.write - whole; if (a < 0) a += this.size
    const b = a === 0 ? this.size - 1 : a - 1
    return this.data[a] + fraction * (this.data[b] - this.data[a])
  }
  reset(): void { this.data.fill(0); this.write = 0 }
}

export type BiquadType = 'lowpass' | 'highpass' | 'lowshelf'
/** RBJ biquad matching native dsp::Biquad (low/high-pass Q in dB, as BiquadFilterNode). */
export class Biquad {
  private b0 = 1; private b1 = 0; private b2 = 0; private a1 = 0; private a2 = 0
  private t0 = 1; private t1 = 0; private t2 = 0; private ta1 = 0; private ta2 = 0
  private readonly z1 = new Float64Array(2); private readonly z2 = new Float64Array(2)
  private readonly smoothing: number
  constructor(private readonly sampleRate: number) { this.smoothing = 1 - Math.exp(-1 / (sampleRate * 0.012)) }
  configure(type: BiquadType, hz: number, q: number, gain: number, immediate: boolean): void {
    const sr = this.sampleRate
    hz = clamp(hz, 1, sr * 0.45); q = clamp(q, 0.0001, 40)
    const omega = TAU * hz / sr, cosine = Math.cos(omega), sine = Math.sin(omega)
    const quality = type === 'lowshelf' ? q : dbToGain(q)
    const a = Math.pow(10, gain / 40), alpha = sine / (2 * quality)
    let b0, b1, b2, a0, a1, a2
    if (type === 'lowpass') { b0 = (1 - cosine) / 2; b1 = 1 - cosine; b2 = b0; a0 = 1 + alpha; a1 = -2 * cosine; a2 = 1 - alpha }
    else if (type === 'highpass') { b0 = (1 + cosine) / 2; b1 = -(1 + cosine); b2 = b0; a0 = 1 + alpha; a1 = -2 * cosine; a2 = 1 - alpha }
    else {
      const beta = Math.sqrt(2 * a) * sine
      b0 = a * ((a + 1) - (a - 1) * cosine + beta); b1 = 2 * a * ((a - 1) - (a + 1) * cosine); b2 = a * ((a + 1) - (a - 1) * cosine - beta)
      a0 = (a + 1) + (a - 1) * cosine + beta; a1 = -2 * ((a - 1) + (a + 1) * cosine); a2 = (a + 1) + (a - 1) * cosine - beta
    }
    this.t0 = b0 / a0; this.t1 = b1 / a0; this.t2 = b2 / a0; this.ta1 = a1 / a0; this.ta2 = a2 / a0
    if (immediate) { this.b0 = this.t0; this.b1 = this.t1; this.b2 = this.t2; this.a1 = this.ta1; this.a2 = this.ta2 }
  }
  sample(x: number, c: number): number {
    if (!c) {
      const s = this.smoothing
      this.b0 += (this.t0 - this.b0) * s; this.b1 += (this.t1 - this.b1) * s; this.b2 += (this.t2 - this.b2) * s
      this.a1 += (this.ta1 - this.a1) * s; this.a2 += (this.ta2 - this.a2) * s
    }
    const y = this.b0 * x + this.z1[c]
    this.z1[c] = this.b1 * x - this.a1 * y + this.z2[c]; this.z2[c] = this.b2 * x - this.a2 * y
    if (Math.abs(this.z1[c]) < 1e-30) this.z1[c] = 0
    if (Math.abs(this.z2[c]) < 1e-30) this.z2[c] = 0
    return y
  }
  reset(): void { this.z1.fill(0); this.z2.fill(0) }
}

/** A parameter that glides to its target (one-pole, ~12 ms). */
class Smooth {
  value = 0; target = 0
  set(target: number, immediate: boolean): void { this.target = target; if (immediate) this.value = target }
  next(k: number): number { this.value += (this.target - this.value) * k; return this.value }
}

abstract class Kernel implements SigimsaeKernel {
  protected configured = false
  protected readonly k: number
  constructor(protected readonly sampleRate: number, private readonly defs: readonly ParamDef[]) { this.k = 1 - Math.exp(-1 / (0.012 * sampleRate)) }
  configure(params: Record<string, number> | undefined, bpm: number): void {
    this.apply(readParams(this.defs, params), clamp(Number.isFinite(bpm) ? bpm : 120, 20, 400), !this.configured)
    this.configured = true
  }
  protected abstract apply(p: (id: string) => number, bpm: number, immediate: boolean): void
  abstract process(left: Float32Array, right: Float32Array, frames: number): void
  abstract reset(): void
}

/** Two modulated delay taps (14 / 17 ms ± 5 ms·depth), quadrature-free opposite sweep per side. */
export class ChorusKernel extends Kernel {
  private readonly lines: [Ring, Ring]
  private readonly depth = new Smooth(); private readonly mix = new Smooth()
  private rate = 0.8; private phase = 0
  constructor(sr: number) { super(sr, KERNEL_DEFS.chorus.params); const n = Math.ceil(sr * 0.05) + 4; this.lines = [new Ring(n), new Ring(n)] }
  protected apply(p: (id: string) => number, _bpm: number, now: boolean): void { this.rate = p('rate'); this.depth.set(p('depth'), now); this.mix.set(p('mix'), now) }
  process(l: Float32Array, r: Float32Array, frames: number): void {
    const sr = this.sampleRate, step = TAU * this.rate / sr
    for (let i = 0; i < frames; i += 1) {
      const depth = this.depth.next(this.k), mix = this.mix.next(this.k)
      this.lines[0].push(l[i]); this.lines[1].push(r[i])
      const modulation = Math.sin(this.phase) * depth * 0.005
      const wl = this.lines[0].read((0.014 + modulation) * sr), wr = this.lines[1].read((0.017 - modulation) * sr)
      l[i] = l[i] * (1 - mix) + wl * mix; r[i] = r[i] * (1 - mix) + wr * mix
      this.phase += step; if (this.phase >= TAU) this.phase -= TAU
    }
  }
  reset(): void { this.lines[0].reset(); this.lines[1].reset(); this.phase = 0 }
}

/** Short swept delay (0.3–6.3 ms) with feedback; right side a quarter cycle ahead. */
export class FlangerKernel extends Kernel {
  private readonly lines: [Ring, Ring]
  private readonly depth = new Smooth(); private readonly feedback = new Smooth(); private readonly mix = new Smooth()
  private rate = 0.25; private phase = 0
  constructor(sr: number) { super(sr, KERNEL_DEFS.flanger.params); const n = Math.ceil(sr * 0.012) + 4; this.lines = [new Ring(n), new Ring(n)] }
  protected apply(p: (id: string) => number, _bpm: number, now: boolean): void { this.rate = p('rate'); this.depth.set(p('depth'), now); this.feedback.set(p('feedback'), now); this.mix.set(p('mix'), now) }
  process(l: Float32Array, r: Float32Array, frames: number): void {
    const sr = this.sampleRate, step = TAU * this.rate / sr
    for (let i = 0; i < frames; i += 1) {
      const depth = this.depth.next(this.k), feedback = this.feedback.next(this.k), mix = this.mix.next(this.k)
      const yl = this.lines[0].read((0.0003 + depth * (0.5 + 0.5 * Math.sin(this.phase)) * 0.006) * sr)
      const yr = this.lines[1].read((0.0003 + depth * (0.5 + 0.5 * Math.sin(this.phase + Math.PI / 2)) * 0.006) * sr)
      this.lines[0].push(l[i] + feedback * yl); this.lines[1].push(r[i] + feedback * yr)
      const wet = 0.5 * mix * (1 - 0.5 * feedback)
      l[i] = l[i] * (1 - 0.5 * mix) + wet * yl; r[i] = r[i] * (1 - 0.5 * mix) + wet * yr
      this.phase += step; if (this.phase >= TAU) this.phase -= TAU
    }
  }
  reset(): void { this.lines[0].reset(); this.lines[1].reset(); this.phase = 0 }
}

/** Six first-order allpasses swept 200 Hz – 3.2 kHz (as the guitar rig phaser), with a mix control. */
export class PhaserKernel extends Kernel {
  private readonly state = [new Float64Array(6), new Float64Array(6)]
  private readonly last = new Float64Array(2)
  private readonly depth = new Smooth(); private readonly feedback = new Smooth(); private readonly mix = new Smooth()
  private rate = 0.5; private phase = 0
  constructor(sr: number) { super(sr, KERNEL_DEFS.phaser.params) }
  protected apply(p: (id: string) => number, _bpm: number, now: boolean): void { this.rate = p('rate'); this.depth.set(p('depth'), now); this.feedback.set(p('feedback'), now); this.mix.set(p('mix'), now) }
  process(l: Float32Array, r: Float32Array, frames: number): void {
    const sr = this.sampleRate, step = TAU * this.rate / sr
    for (let i = 0; i < frames; i += 1) {
      const depth = this.depth.next(this.k), feedback = this.feedback.next(this.k), mix = this.mix.next(this.k)
      for (let c = 0; c < 2; c += 1) {
        const x = c ? r[i] : l[i]
        const lfo = 0.5 + 0.5 * Math.sin(this.phase + (c ? Math.PI / 2 : 0))
        const frequency = 200 * Math.pow(16, 0.5 + (lfo - 0.5) * depth)
        const t = Math.tan(Math.PI * Math.min(frequency, sr * 0.45) / sr), a = (t - 1) / (t + 1)
        const z = this.state[c]
        let y = x + feedback * this.last[c]
        for (let s = 0; s < 6; s += 1) {
          const out = a * y + z[s]
          z[s] = y - a * out; if (Math.abs(z[s]) < 1e-30) z[s] = 0
          y = out
        }
        this.last[c] = y
        const v = x * (1 - 0.5 * mix) + 0.5 * mix * y
        if (c) r[i] = v; else l[i] = v
      }
      this.phase += step; if (this.phase >= TAU) this.phase -= TAU
    }
  }
  reset(): void { this.state[0].fill(0); this.state[1].fill(0); this.last.fill(0); this.phase = 0 }
}

/** Amplitude LFO (sine → soft square). Auto-pan moves the level between the sides instead. */
export class TremoloKernel extends Kernel {
  private readonly depth = new Smooth(); private readonly shape = new Smooth(); private readonly pan = new Smooth()
  private rate = 4; private phase = 0
  constructor(sr: number) { super(sr, KERNEL_DEFS.tremolo.params) }
  protected apply(p: (id: string) => number, bpm: number, now: boolean): void {
    const sync = p('sync')
    this.rate = sync > 0 ? bpm / 60 / sync : p('rate')
    this.depth.set(p('depth'), now); this.shape.set(p('shape'), now); this.pan.set(p('pan') >= 0.5 ? 1 : 0, now)
  }
  process(l: Float32Array, r: Float32Array, frames: number): void {
    const step = TAU * this.rate / this.sampleRate
    for (let i = 0; i < frames; i += 1) {
      const depth = this.depth.next(this.k), shape = this.shape.next(this.k), pan = this.pan.next(this.k)
      const kk = 0.01 + shape * 9
      const wave = Math.tanh(kk * Math.sin(this.phase)) / Math.tanh(kk)
      const trem = 1 - depth * 0.5 * (1 - wave)
      const gl = trem * (1 - pan) + (1 - depth * 0.5 * (1 + wave)) * pan
      const gr = trem * (1 - pan) + (1 - depth * 0.5 * (1 - wave)) * pan
      l[i] *= gl; r[i] *= gr
      this.phase += step; if (this.phase >= TAU) this.phase -= TAU
    }
  }
  reset(): void { this.phase = 0 }
}

/** Zero-latency peak limiter: instant attack, exponential release, hard ceiling guarantee. */
export class LimiterKernel extends Kernel {
  private readonly pre = new Smooth(); private ceiling = 0.89; private release = 0; private gain = 1
  constructor(sr: number) { super(sr, KERNEL_DEFS.limiter.params) }
  protected apply(p: (id: string) => number, _bpm: number, now: boolean): void {
    this.pre.set(dbToGain(p('gain')), now); this.ceiling = dbToGain(p('ceiling'))
    this.release = 1 - Math.exp(-1 / (p('release') * 0.001 * this.sampleRate))
  }
  process(l: Float32Array, r: Float32Array, frames: number): void {
    const c = this.ceiling
    for (let i = 0; i < frames; i += 1) {
      const pre = this.pre.next(this.k)
      const xl = l[i] * pre, xr = r[i] * pre
      const peak = Math.max(Math.abs(xl), Math.abs(xr))
      const target = peak > c ? c / peak : 1
      if (target < this.gain) this.gain = target
      else this.gain += (target - this.gain) * this.release
      l[i] = clamp(xl * this.gain, -c, c); r[i] = clamp(xr * this.gain, -c, c)
    }
  }
  reset(): void { this.gain = 1 }
}

/** Noise gate: peak detector, 4 dB hysteresis, hold, then attack/release ramps of the gain. */
export class GateKernel extends Kernel {
  private open = 0; private close = 0; private attack = 0; private release = 0; private holdFrames = 0
  private readonly detector: number
  private envelope = 0; private gain = 0; private held = 0; private isOpen = false
  constructor(sr: number) { super(sr, KERNEL_DEFS.gate.params); this.detector = Math.exp(-1 / (0.01 * sr)) }
  protected apply(p: (id: string) => number): void {
    const sr = this.sampleRate
    this.open = dbToGain(p('threshold')); this.close = this.open * dbToGain(-4)
    this.attack = 1 - Math.exp(-1 / (p('attack') * 0.001 * sr))
    // Release is the time to fall 60 dB (time constant release / 6.9).
    this.release = 1 - Math.exp(-6.9 / (p('release') * 0.001 * sr))
    this.holdFrames = Math.round(p('hold') * 0.001 * sr)
  }
  process(l: Float32Array, r: Float32Array, frames: number): void {
    for (let i = 0; i < frames; i += 1) {
      const peak = Math.max(Math.abs(l[i]), Math.abs(r[i]))
      this.envelope = peak > this.envelope ? peak : this.envelope * this.detector
      if (this.envelope >= this.open) { this.isOpen = true; this.held = this.holdFrames }
      else if (this.envelope < this.close) { if (this.held > 0) this.held -= 1; else this.isOpen = false }
      if (this.isOpen) this.gain += (1 - this.gain) * this.attack
      else { this.gain -= this.gain * this.release; if (this.gain < 1e-4) this.gain = 0 }
      l[i] *= this.gain; r[i] *= this.gain
    }
  }
  reset(): void { this.envelope = 0; this.gain = 0; this.held = 0; this.isOpen = false }
}

/** Asymmetric tanh saturation, head bump and a warmth-controlled high roll-off. */
export class TapeKernel extends Kernel {
  private readonly pre = new Smooth(); private readonly post = new Smooth(); private readonly mix = new Smooth(); private readonly out = new Smooth()
  private readonly lowpass: Biquad; private readonly bump: Biquad; private readonly dc: Biquad
  private static readonly BIAS = 0.15
  constructor(sr: number) { super(sr, KERNEL_DEFS.tape.params); this.lowpass = new Biquad(sr); this.bump = new Biquad(sr); this.dc = new Biquad(sr) }
  protected apply(p: (id: string) => number, _bpm: number, now: boolean): void {
    const pre = dbToGain(p('drive')), warmth = p('warmth')
    this.pre.set(pre, now); this.post.set(Math.pow(pre, -0.8), now); this.mix.set(p('mix'), now); this.out.set(dbToGain(p('output')), now)
    this.lowpass.configure('lowpass', 20000 * Math.pow(0.25, warmth), 0.5, 0, now)
    this.bump.configure('lowshelf', 110, 0.707, 3 * warmth, now)
    this.dc.configure('highpass', 20, 0.5, 0, now)
  }
  process(l: Float32Array, r: Float32Array, frames: number): void {
    const bias = TapeKernel.BIAS, origin = Math.tanh(bias)
    for (let i = 0; i < frames; i += 1) {
      const pre = this.pre.next(this.k), post = this.post.next(this.k), mix = this.mix.next(this.k), out = this.out.next(this.k)
      for (let c = 0; c < 2; c += 1) {
        const x = c ? r[i] : l[i]
        let y = (Math.tanh(x * pre + bias) - origin) * post
        y = this.dc.sample(this.bump.sample(this.lowpass.sample(y, c), c), c)
        const v = (x * (1 - mix) + y * mix) * out
        if (c) r[i] = v; else l[i] = v
      }
    }
  }
  reset(): void { this.lowpass.reset(); this.bump.reset(); this.dc.reset() }
}

/** Sample-and-hold downsampling followed by mid-tread quantisation to `bits`. */
export class BitcrusherKernel extends Kernel {
  private readonly mix = new Smooth(); private levels = 128; private factor = 4
  private countdown = 0; private holdL = 0; private holdR = 0
  constructor(sr: number) { super(sr, KERNEL_DEFS.bitcrusher.params) }
  protected apply(p: (id: string) => number, _bpm: number, now: boolean): void { this.levels = Math.pow(2, p('bits') - 1); this.factor = p('downsample'); this.mix.set(p('mix'), now) }
  process(l: Float32Array, r: Float32Array, frames: number): void {
    const levels = this.levels
    for (let i = 0; i < frames; i += 1) {
      const mix = this.mix.next(this.k)
      if (this.countdown <= 0) { this.holdL = l[i]; this.holdR = r[i]; this.countdown += this.factor }
      this.countdown -= 1
      const ql = Math.floor(this.holdL * levels + 0.5) / levels, qr = Math.floor(this.holdR * levels + 0.5) / levels
      l[i] = l[i] * (1 - mix) + ql * mix; r[i] = r[i] * (1 - mix) + qr * mix
    }
  }
  reset(): void { this.countdown = 0; this.holdL = this.holdR = 0 }
}

/** Gain, balance, mid/side width, mono sum and per-side polarity. */
export class UtilityKernel extends Kernel {
  private readonly gain = new Smooth(); private readonly pan = new Smooth(); private readonly width = new Smooth()
  private readonly signL = new Smooth(); private readonly signR = new Smooth()
  constructor(sr: number) { super(sr, KERNEL_DEFS.utility.params) }
  protected apply(p: (id: string) => number, _bpm: number, now: boolean): void {
    const phase = Math.round(p('phase'))
    this.gain.set(dbToGain(p('gain')), now); this.pan.set(p('pan'), now)
    this.width.set(p('mono') >= 0.5 ? 0 : p('width'), now)
    this.signL.set(phase & 1 ? -1 : 1, now); this.signR.set(phase & 2 ? -1 : 1, now)
  }
  process(l: Float32Array, r: Float32Array, frames: number): void {
    for (let i = 0; i < frames; i += 1) {
      const gain = this.gain.next(this.k), pan = this.pan.next(this.k), width = this.width.next(this.k)
      const a = l[i] * this.signL.next(this.k), b = r[i] * this.signR.next(this.k)
      const mid = 0.5 * (a + b), side = 0.5 * (a - b) * width
      l[i] = (mid + side) * (pan > 0 ? 1 - pan : 1) * gain
      r[i] = (mid - side) * (pan < 0 ? 1 + pan : 1) * gain
    }
  }
  reset(): void {}
}

export const DELAY_MAX_SECONDS = 3.9
export function delaySeconds(p: (id: string) => number, bpm: number): number {
  return Math.min(DELAY_MAX_SECONDS, p('sync') >= 0.5 ? p('time') * 60 / bpm : p('ms') * 0.001)
}

/**
 * Studio delay: stereo or ping-pong; the feedback path is band-limited (high/low cut) and, with
 * Tape (age), wobbles (0.7 Hz wow, 7.3 Hz flutter) and saturates. Every repeat, the first included,
 * passes through the filters. Delay-time changes glide (~80 ms) like a tape machine.
 */
export class DelayKernel extends Kernel {
  private readonly lines: [Ring, Ring]
  private readonly low: Biquad; private readonly high: Biquad
  private readonly wet = new Smooth(); private readonly feedback = new Smooth(); private readonly age = new Smooth(); private readonly time = new Smooth()
  private readonly glide: number
  private lowcut = false; private pingPong = false
  private wow = 0; private flutter = 0
  constructor(sr: number) {
    super(sr, KERNEL_DEFS.delay.params)
    const n = Math.ceil(sr * 4.1) + 4
    this.lines = [new Ring(n), new Ring(n)]
    this.low = new Biquad(sr); this.high = new Biquad(sr)
    this.glide = 1 - Math.exp(-1 / (0.08 * sr))
  }
  protected apply(p: (id: string) => number, bpm: number, now: boolean): void {
    this.wet.set(p('amount') * 0.45, now); this.feedback.set(p('feedback'), now); this.age.set(p('age'), now)
    this.time.set(delaySeconds(p, bpm) * this.sampleRate, now)
    this.low.configure('lowpass', p('tone'), 1, 0, now)
    this.lowcut = p('lowcut') > 20.5
    this.high.configure('highpass', p('lowcut'), 0.5, 0, now)
    this.pingPong = p('mode') >= 0.5
  }
  process(l: Float32Array, r: Float32Array, frames: number): void {
    const sr = this.sampleRate, wowStep = TAU * 0.7 / sr, flutterStep = TAU * 7.3 / sr
    for (let i = 0; i < frames; i += 1) {
      const wet = this.wet.next(this.k), feedback = this.feedback.next(this.k), age = this.age.next(this.k)
      const time = this.time.next(this.glide)
      const wobble = age * sr * (0.0014 + 0.0012 * Math.sin(this.wow) + 0.00015 * Math.sin(this.flutter))
      const read = Math.max(0, time + wobble - 1)
      const drive = 1 + 2 * age
      let fl = this.low.sample(this.lines[0].read(read), 0), fr = this.low.sample(this.lines[1].read(read), 1)
      if (this.lowcut) { fl = this.high.sample(fl, 0); fr = this.high.sample(fr, 1) }
      if (age > 1e-4) { fl = Math.tanh(fl * drive) / drive; fr = Math.tanh(fr * drive) / drive }
      const xl = l[i], xr = r[i]
      if (this.pingPong) { this.lines[0].push(0.5 * (xl + xr) + feedback * fr); this.lines[1].push(feedback * fl) }
      else { this.lines[0].push(xl + feedback * fl); this.lines[1].push(xr + feedback * fr) }
      l[i] = xl + wet * fl; r[i] = xr + wet * fr
      this.wow += wowStep; if (this.wow >= TAU) this.wow -= TAU
      this.flutter += flutterStep; if (this.flutter >= TAU) this.flutter -= TAU
    }
  }
  reset(): void { this.lines[0].reset(); this.lines[1].reset(); this.low.reset(); this.high.reset(); this.wow = this.flutter = 0 }
}

const KERNELS: Record<KernelType, new (sampleRate: number) => Kernel> = {
  delay: DelayKernel, chorus: ChorusKernel, phaser: PhaserKernel, flanger: FlangerKernel, tremolo: TremoloKernel,
  limiter: LimiterKernel, gate: GateKernel, tape: TapeKernel, bitcrusher: BitcrusherKernel, utility: UtilityKernel,
}

export function createKernel(type: KernelType, sampleRate: number, params?: Record<string, number>, bpm = 120): SigimsaeKernel {
  const KernelClass = KERNELS[type]
  if (!KernelClass) throw new Error(`Unknown 시김새 kernel: ${String(type)}`)
  const kernel = new KernelClass(sampleRate)
  kernel.configure(params, bpm)
  return kernel
}

/** Export tail allowance for the kernel-backed effects (seconds), including the 0.85 s guard. */
export function kernelTailSeconds(type: KernelType, params: Record<string, number>, bpm: number): number {
  const p = readParams(KERNEL_DEFS[type].params, params)
  switch (type) {
    case 'delay': {
      if (p('amount') <= 0) return 0
      const feedback = p('feedback')
      const repeats = feedback > 0.01 ? Math.ceil(Math.log(0.001) / Math.log(feedback)) : 1
      return Math.min(30, (delaySeconds(p, bpm) + p('age') * 0.0026) * (repeats + 1) + 0.85)
    }
    case 'chorus': return 0.05
    case 'flanger': {
      const feedback = p('feedback')
      const repeats = feedback > 0.01 ? Math.ceil(Math.log(0.001) / Math.log(feedback)) : 1
      return 0.0065 * (repeats + 1) + 0.05
    }
    case 'phaser': return 0.05
    case 'gate': return (p('hold') + p('release') * 1.5) * 0.001
    case 'limiter': return p('release') * 0.007
    default: return 0
  }
}

//! Chorus, flanger, phaser and tremolo / auto-pan: `ChorusFx`, `FlangerFx`, `PhaserFx`,
//! `TremoloFx` in native/src/sigimsae_effects.inc (= kernels.ts `*Kernel`).

use super::{
    Kernel, SettledFrame, TAU, feedback_repeats, process_interleaved_settled, process_planar_settled,
};
use crate::lines::{Carver, Ring};
use crate::math;
use crate::params::{CHORUS, FLANGER, PHASER, ParamSet, TREMOLO, index_of};
use crate::simd::F2;
use crate::smooth::{Smooth, smoothing_coefficient};
use crate::{PI, std_min};

fn advance(phase: &mut f64, step: f64) {
    *phase += step;
    if *phase >= TAU {
        *phase -= TAU;
    }
}

const C_RATE: usize = index_of(CHORUS, "rate");
const C_DEPTH: usize = index_of(CHORUS, "depth");
const C_MIX: usize = index_of(CHORUS, "mix");

/// Two modulated taps (14 / 17 ms ± 5 ms·depth) swept in opposite directions.
#[derive(Debug)]
pub struct Chorus<'a> {
    sample_rate: f64,
    k: f64,
    l: Ring<'a>,
    r: Ring<'a>,
    rate: f64,
    step: f64,
    phase: f64,
    depth: Smooth,
    mix: Smooth,
}

impl<'a> Chorus<'a> {
    fn ring_size(sample_rate: f64) -> usize {
        math::ceil(sample_rate * 0.05) as usize + 4
    }

    pub fn storage_len(sample_rate: f64) -> usize {
        2 * Ring::len_for(Self::ring_size(sample_rate))
    }

    pub fn new(sample_rate: f64, p: &ParamSet, carver: &mut Carver<'a>) -> Self {
        let n = Self::ring_size(sample_rate);
        let mut s = Self {
            sample_rate,
            k: smoothing_coefficient(sample_rate),
            l: Ring::new(carver, n),
            r: Ring::new(carver, n),
            rate: p.get(C_RATE),
            step: 0.0,
            phase: 0.0,
            depth: Smooth::default(),
            mix: Smooth::default(),
        };
        s.depth.set(p.get(C_DEPTH));
        s.mix.set(p.get(C_MIX));
        s.step = 2.0 * PI * s.rate / sample_rate;
        s
    }

    pub fn take_state_from(&mut self, p: &mut Self) -> bool {
        let swapped = self.l.same_size(&p.l) && self.l.swap_with(&mut p.l) && self.r.swap_with(&mut p.r);
        self.phase = p.phase;
        self.depth.follow(&p.depth);
        self.mix.follow(&p.mix);
        swapped
    }
}

impl Kernel for Chorus<'_> {
    fn automate(&mut self, p: &ParamSet) {
        self.rate = p.get(C_RATE);
        self.step = 2.0 * PI * self.rate / self.sample_rate;
        self.depth.target = p.get(C_DEPTH);
        self.mix.target = p.get(C_MIX);
    }

    #[inline(always)]
    fn frame(&mut self, xl: f32, xr: f32) -> (f32, f32) {
        self.frame_if::<false>(xl, xr)
    }

    fn process_interleaved(&mut self, s: &mut [f32]) {
        process_interleaved_settled(self, s);
    }

    fn process_planar(&mut self, left: &mut [f32], right: &mut [f32]) {
        process_planar_settled(self, left, right);
    }

    fn reset(&mut self) {
        self.l.reset();
        self.r.reset();
        self.phase = 0.0;
    }

    fn tail_seconds(&self) -> f64 {
        0.05
    }
}

impl SettledFrame for Chorus<'_> {
    fn settled(&self) -> bool {
        self.depth.settled() && self.mix.settled()
    }

    #[inline(always)]
    fn frame_if<const SETTLED: bool>(&mut self, xl: f32, xr: f32) -> (f32, f32) {
        let depth = self.depth.next_if::<SETTLED>(self.k);
        let mix = self.mix.next_if::<SETTLED>(self.k);
        self.l.push(xl);
        self.r.push(xr);
        let modulation = math::sin(self.phase) * depth * 0.005;
        let wl = f64::from(self.l.read((0.014 + modulation) * self.sample_rate));
        let wr = f64::from(self.r.read((0.017 - modulation) * self.sample_rate));
        let out = (
            math::mul_add(f64::from(xl), 1.0 - mix, wl * mix) as f32,
            math::mul_add(f64::from(xr), 1.0 - mix, wr * mix) as f32,
        );
        advance(&mut self.phase, self.step);
        out
    }
}

const F_RATE: usize = index_of(FLANGER, "rate");
const F_DEPTH: usize = index_of(FLANGER, "depth");
const F_FEEDBACK: usize = index_of(FLANGER, "feedback");
const F_MIX: usize = index_of(FLANGER, "mix");

/// Short swept delay (0.3-6.3 ms) with feedback; right side a quarter cycle ahead.
#[derive(Debug)]
pub struct Flanger<'a> {
    sample_rate: f64,
    k: f64,
    l: Ring<'a>,
    r: Ring<'a>,
    rate: f64,
    step: f64,
    phase: f64,
    tail: f64,
    depth: Smooth,
    feedback: Smooth,
    mix: Smooth,
}

impl<'a> Flanger<'a> {
    fn ring_size(sample_rate: f64) -> usize {
        math::ceil(sample_rate * 0.012) as usize + 4
    }

    pub fn storage_len(sample_rate: f64) -> usize {
        2 * Ring::len_for(Self::ring_size(sample_rate))
    }

    pub fn new(sample_rate: f64, p: &ParamSet, carver: &mut Carver<'a>) -> Self {
        let n = Self::ring_size(sample_rate);
        let rate = p.get(F_RATE);
        let mut s = Self {
            sample_rate,
            k: smoothing_coefficient(sample_rate),
            l: Ring::new(carver, n),
            r: Ring::new(carver, n),
            rate,
            step: 2.0 * PI * rate / sample_rate,
            phase: 0.0,
            tail: 0.0065 * (feedback_repeats(p.get(F_FEEDBACK)) + 1.0) + 0.05,
            depth: Smooth::default(),
            feedback: Smooth::default(),
            mix: Smooth::default(),
        };
        s.depth.set(p.get(F_DEPTH));
        s.feedback.set(p.get(F_FEEDBACK));
        s.mix.set(p.get(F_MIX));
        s
    }

    pub fn take_state_from(&mut self, p: &mut Self) -> bool {
        let swapped = self.l.same_size(&p.l) && self.l.swap_with(&mut p.l) && self.r.swap_with(&mut p.r);
        self.phase = p.phase;
        self.depth.follow(&p.depth);
        self.feedback.follow(&p.feedback);
        self.mix.follow(&p.mix);
        swapped
    }
}

impl Kernel for Flanger<'_> {
    fn automate(&mut self, p: &ParamSet) {
        self.rate = p.get(F_RATE);
        self.step = 2.0 * PI * self.rate / self.sample_rate;
        self.depth.target = p.get(F_DEPTH);
        self.feedback.target = p.get(F_FEEDBACK);
        self.mix.target = p.get(F_MIX);
    }

    #[inline(always)]
    fn frame(&mut self, xl: f32, xr: f32) -> (f32, f32) {
        self.frame_if::<false>(xl, xr)
    }

    fn process_interleaved(&mut self, s: &mut [f32]) {
        process_interleaved_settled(self, s);
    }

    fn process_planar(&mut self, left: &mut [f32], right: &mut [f32]) {
        process_planar_settled(self, left, right);
    }

    fn reset(&mut self) {
        self.l.reset();
        self.r.reset();
        self.phase = 0.0;
    }

    fn tail_seconds(&self) -> f64 {
        self.tail
    }
}

impl SettledFrame for Flanger<'_> {
    fn settled(&self) -> bool {
        self.depth.settled() && self.feedback.settled() && self.mix.settled()
    }

    #[inline(always)]
    fn frame_if<const SETTLED: bool>(&mut self, xl: f32, xr: f32) -> (f32, f32) {
        let depth = self.depth.next_if::<SETTLED>(self.k);
        let feedback = self.feedback.next_if::<SETTLED>(self.k);
        let mix = self.mix.next_if::<SETTLED>(self.k);
        let sr = self.sample_rate;
        // C++ `.0003 + depth * (.5 + .5 * sin) * .006` (contracted on Apple arm64; .5 * sin is exact).
        let yl = f64::from(
            self.l.read(math::mul_add(depth * (0.5 + 0.5 * math::sin(self.phase)), 0.006, 0.0003) * sr),
        );
        let yr =
            f64::from(self.r.read(
                math::mul_add(depth * (0.5 + 0.5 * math::sin(self.phase + PI / 2.0)), 0.006, 0.0003) * sr,
            ));
        self.l.push(math::mul_add(feedback, yl, f64::from(xl)) as f32);
        self.r.push(math::mul_add(feedback, yr, f64::from(xr)) as f32);
        let wet = 0.5 * mix * (1.0 - 0.5 * feedback);
        let out = (
            math::mul_add(f64::from(xl), 1.0 - 0.5 * mix, wet * yl) as f32,
            math::mul_add(f64::from(xr), 1.0 - 0.5 * mix, wet * yr) as f32,
        );
        advance(&mut self.phase, self.step);
        out
    }
}

const P_RATE: usize = index_of(PHASER, "rate");
const P_DEPTH: usize = index_of(PHASER, "depth");
const P_FEEDBACK: usize = index_of(PHASER, "feedback");
const P_MIX: usize = index_of(PHASER, "mix");

/// Six first-order allpasses swept 200 Hz - 3.2 kHz with feedback and a mix control.
#[derive(Clone, Debug)]
pub struct Phaser {
    sample_rate: f64,
    k: f64,
    rate: f64,
    step: f64,
    phase: f64,
    depth: Smooth,
    feedback: Smooth,
    mix: Smooth,
    /// All-pass states and the feedback sample, left and right in the two lanes ([`F2`]).
    state: [F2; 6],
    last: F2,
}

impl Phaser {
    pub fn new(sample_rate: f64, p: &ParamSet) -> Self {
        let rate = p.get(P_RATE);
        let mut s = Self {
            sample_rate,
            k: smoothing_coefficient(sample_rate),
            rate,
            step: 2.0 * PI * rate / sample_rate,
            phase: 0.0,
            depth: Smooth::default(),
            feedback: Smooth::default(),
            mix: Smooth::default(),
            state: [F2::splat(0.0); 6],
            last: F2::splat(0.0),
        };
        s.depth.set(p.get(P_DEPTH));
        s.feedback.set(p.get(P_FEEDBACK));
        s.mix.set(p.get(P_MIX));
        s
    }

    pub fn take_state_from(&mut self, p: &mut Self) -> bool {
        self.state = p.state;
        self.last = p.last;
        self.phase = p.phase;
        self.depth.follow(&p.depth);
        self.feedback.follow(&p.feedback);
        self.mix.follow(&p.mix);
        false
    }
}

impl Kernel for Phaser {
    fn automate(&mut self, p: &ParamSet) {
        self.rate = p.get(P_RATE);
        self.step = 2.0 * PI * self.rate / self.sample_rate;
        self.depth.target = p.get(P_DEPTH);
        self.feedback.target = p.get(P_FEEDBACK);
        self.mix.target = p.get(P_MIX);
    }

    #[inline(always)]
    fn frame(&mut self, xl: f32, xr: f32) -> (f32, f32) {
        let depth = self.depth.next(self.k);
        let feedback = self.feedback.next(self.k);
        let mix = self.mix.next(self.k);
        let sr = self.sample_rate;
        // Per channel (lane): the LFO-swept coefficient, then the same six-stage all-pass ladder.
        let coefficient = |offset: f64| {
            let lfo = 0.5 + 0.5 * math::sin(self.phase + offset);
            let frequency = 200.0 * math::pow(16.0, 0.5 + (lfo - 0.5) * depth);
            let t = math::tan(PI * std_min(frequency, sr * 0.45) / sr);
            (t - 1.0) / (t + 1.0)
        };
        let a = F2::new(coefficient(0.0), coefficient(PI / 2.0));
        let x = F2::new(f64::from(xl), f64::from(xr));
        let mut y = x.add(F2::splat(feedback).mul(self.last));
        for zs in &mut self.state {
            let output = a.mul(y).add(*zs);
            *zs = y.sub(a.mul(output)).flush_below(1e-30);
            y = output;
        }
        self.last = y;
        let [l, r] = x.mul(F2::splat(1.0 - 0.5 * mix)).add(F2::splat(0.5 * mix).mul(y)).lanes();
        let out = [l as f32, r as f32];
        advance(&mut self.phase, self.step);
        (out[0], out[1])
    }

    fn reset(&mut self) {
        self.state = [F2::splat(0.0); 6];
        self.last = F2::splat(0.0);
        self.phase = 0.0;
    }

    fn tail_seconds(&self) -> f64 {
        0.05
    }
}

const T_RATE: usize = index_of(TREMOLO, "rate");
const T_DEPTH: usize = index_of(TREMOLO, "depth");
const T_SHAPE: usize = index_of(TREMOLO, "shape");
const T_SYNC: usize = index_of(TREMOLO, "sync");
const T_PAN: usize = index_of(TREMOLO, "pan");

/// Amplitude LFO (sine -> soft square); auto-pan moves the level between the sides instead.
/// `sync` > 0 locks the rate to `sync` beats per cycle at the current tempo.
#[derive(Clone, Debug)]
pub struct Tremolo {
    sample_rate: f64,
    k: f64,
    bpm: f64,
    rate: f64,
    step: f64,
    phase: f64,
    sync: f64,
    depth: Smooth,
    shape: Smooth,
    pan: Smooth,
    /// `tanh(norm_k)` for the last `norm_k`. The normaliser only changes while `shape` glides, so
    /// recomputing it on a change gives the same value as calling `tanh` every frame.
    norm_k: f64,
    norm: f64,
}

impl Tremolo {
    pub fn new(sample_rate: f64, bpm: f64, p: &ParamSet) -> Self {
        let mut s = Self {
            sample_rate,
            k: smoothing_coefficient(sample_rate),
            bpm,
            rate: 4.0,
            step: 0.0,
            phase: 0.0,
            sync: 0.0,
            depth: Smooth::default(),
            shape: Smooth::default(),
            pan: Smooth::default(),
            norm_k: f64::NAN,
            norm: f64::NAN,
        };
        s.read_rate(p);
        s.depth.set(p.get(T_DEPTH));
        s.shape.set(p.get(T_SHAPE));
        s.pan.set(if p.get(T_PAN) >= 0.5 { 1.0 } else { 0.0 });
        s
    }

    fn read_rate(&mut self, p: &ParamSet) {
        let sync = p.get(T_SYNC);
        self.sync = sync;
        self.rate = if sync > 0.0 { self.bpm / 60.0 / sync } else { p.get(T_RATE) };
        self.step = 2.0 * PI * self.rate / self.sample_rate;
    }

    pub fn take_state_from(&mut self, p: &mut Self) -> bool {
        self.phase = p.phase;
        self.depth.follow(&p.depth);
        self.shape.follow(&p.shape);
        self.pan.follow(&p.pan);
        false
    }
}

impl Kernel for Tremolo {
    fn automate(&mut self, p: &ParamSet) {
        self.read_rate(p);
        self.depth.target = p.get(T_DEPTH);
        self.shape.target = p.get(T_SHAPE);
        self.pan.target = if p.get(T_PAN) >= 0.5 { 1.0 } else { 0.0 };
    }

    fn set_tempo(&mut self, bpm: f64) {
        if bpm.is_finite() && bpm > 0.0 {
            self.bpm = bpm;
            if self.sync > 0.0 {
                self.rate = bpm / 60.0 / self.sync;
                self.step = 2.0 * PI * self.rate / self.sample_rate;
            }
        }
    }

    #[inline(always)]
    fn frame(&mut self, xl: f32, xr: f32) -> (f32, f32) {
        let depth = self.depth.next(self.k);
        let shape = self.shape.next(self.k);
        let pan = self.pan.next(self.k);
        let kk = 0.01 + shape * 9.0;
        if kk != self.norm_k {
            self.norm_k = kk;
            self.norm = math::tanh(kk);
        }
        let wave = math::tanh(kk * math::sin(self.phase)) / self.norm;
        let trem = 1.0 - depth * 0.5 * (1.0 - wave);
        let gl = trem * (1.0 - pan) + (1.0 - depth * 0.5 * (1.0 + wave)) * pan;
        let gr = trem * (1.0 - pan) + (1.0 - depth * 0.5 * (1.0 - wave)) * pan;
        advance(&mut self.phase, self.step);
        ((f64::from(xl) * gl) as f32, (f64::from(xr) * gr) as f32)
    }

    fn reset(&mut self) {
        self.phase = 0.0;
    }
}

//! Chorus, flanger, phaser and tremolo / auto-pan: `ChorusFx`, `FlangerFx`, `PhaserFx`,
//! `TremoloFx` in native/src/sigimsae_effects.inc (= kernels.ts `*Kernel`).

use super::{Kernel, TAU, feedback_repeats};
use crate::lines::{Carver, Ring};
use crate::params::{CHORUS, FLANGER, PHASER, ParamSet, TREMOLO, index_of};
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
        libm::ceil(sample_rate * 0.05) as usize + 4
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

    #[inline]
    fn frame(&mut self, xl: f32, xr: f32) -> (f32, f32) {
        let depth = self.depth.next(self.k);
        let mix = self.mix.next(self.k);
        self.l.push(xl);
        self.r.push(xr);
        let modulation = libm::sin(self.phase) * depth * 0.005;
        let wl = f64::from(self.l.read((0.014 + modulation) * self.sample_rate));
        let wr = f64::from(self.r.read((0.017 - modulation) * self.sample_rate));
        let out = (
            (f64::from(xl) * (1.0 - mix) + wl * mix) as f32,
            (f64::from(xr) * (1.0 - mix) + wr * mix) as f32,
        );
        advance(&mut self.phase, self.step);
        out
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
        libm::ceil(sample_rate * 0.012) as usize + 4
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

    #[inline]
    fn frame(&mut self, xl: f32, xr: f32) -> (f32, f32) {
        let depth = self.depth.next(self.k);
        let feedback = self.feedback.next(self.k);
        let mix = self.mix.next(self.k);
        let sr = self.sample_rate;
        let yl = f64::from(self.l.read((0.0003 + depth * (0.5 + 0.5 * libm::sin(self.phase)) * 0.006) * sr));
        let yr = f64::from(
            self.r.read((0.0003 + depth * (0.5 + 0.5 * libm::sin(self.phase + PI / 2.0)) * 0.006) * sr),
        );
        self.l.push((f64::from(xl) + feedback * yl) as f32);
        self.r.push((f64::from(xr) + feedback * yr) as f32);
        let wet = 0.5 * mix * (1.0 - 0.5 * feedback);
        let out = (
            (f64::from(xl) * (1.0 - 0.5 * mix) + wet * yl) as f32,
            (f64::from(xr) * (1.0 - 0.5 * mix) + wet * yr) as f32,
        );
        advance(&mut self.phase, self.step);
        out
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
    state: [[f64; 6]; 2],
    last: [f64; 2],
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
            state: [[0.0; 6]; 2],
            last: [0.0; 2],
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

    #[inline]
    fn frame(&mut self, xl: f32, xr: f32) -> (f32, f32) {
        let depth = self.depth.next(self.k);
        let feedback = self.feedback.next(self.k);
        let mix = self.mix.next(self.k);
        let sr = self.sample_rate;
        let mut out = [xl, xr];
        for (c, ((o, z), last)) in
            out.iter_mut().zip(self.state.iter_mut()).zip(self.last.iter_mut()).enumerate()
        {
            let x = f64::from(*o);
            let lfo = 0.5 + 0.5 * libm::sin(self.phase + if c != 0 { PI / 2.0 } else { 0.0 });
            let frequency = 200.0 * libm::pow(16.0, 0.5 + (lfo - 0.5) * depth);
            let t = libm::tan(PI * std_min(frequency, sr * 0.45) / sr);
            let a = (t - 1.0) / (t + 1.0);
            let mut y = x + feedback * *last;
            for zs in z.iter_mut() {
                let output = a * y + *zs;
                *zs = y - a * output;
                if zs.abs() < 1e-30 {
                    *zs = 0.0;
                }
                y = output;
            }
            *last = y;
            *o = (x * (1.0 - 0.5 * mix) + 0.5 * mix * y) as f32;
        }
        advance(&mut self.phase, self.step);
        (out[0], out[1])
    }

    fn reset(&mut self) {
        self.state = [[0.0; 6]; 2];
        self.last = [0.0; 2];
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

    #[inline]
    fn frame(&mut self, xl: f32, xr: f32) -> (f32, f32) {
        let depth = self.depth.next(self.k);
        let shape = self.shape.next(self.k);
        let pan = self.pan.next(self.k);
        let kk = 0.01 + shape * 9.0;
        let wave = libm::tanh(kk * libm::sin(self.phase)) / libm::tanh(kk);
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

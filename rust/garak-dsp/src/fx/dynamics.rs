//! Compressor (native/src/dsp.cpp `Compressor`), limiter and gate (sigimsae_effects.inc
//! `LimiterFx`, `GateFx` = kernels.ts `LimiterKernel`, `GateKernel`), with the dynamics meter tap
//! (detector peak and lowest applied gain since the last read, both linear).

use super::{Kernel, SettledFrame, process_interleaved_settled, process_planar_settled};
use crate::gain::db_to_gain;
use crate::math;
use crate::params::{COMPRESSOR, GATE, LIMITER, ParamSet, index_of};
use crate::smooth::{Smooth, smoothing_coefficient};
use crate::{std_clamp, std_max, std_min};

/// Accumulates `DynamicsTap::add` inputs until read (peak max, gain min).
#[derive(Clone, Copy, Debug)]
pub struct Meter {
    loudest: f64,
    lowest: f64,
}

impl Default for Meter {
    fn default() -> Self {
        Self { loudest: 0.0, lowest: 1.0 }
    }
}

impl Meter {
    #[inline]
    fn add(&mut self, peak: f64, gain: f64) {
        self.loudest = std_max(self.loudest, peak);
        self.lowest = std_min(self.lowest, gain);
    }

    /// (peak, lowest gain) since the previous take; restarts the window.
    pub fn take(&mut self) -> (f32, f32) {
        let out = (self.loudest as f32, self.lowest as f32);
        *self = Self::default();
        out
    }
}

const C_THRESHOLD: usize = index_of(COMPRESSOR, "threshold");
const C_RATIO: usize = index_of(COMPRESSOR, "ratio");
const C_ATTACK: usize = index_of(COMPRESSOR, "attack");
const C_RELEASE: usize = index_of(COMPRESSOR, "release");
const C_MAKEUP: usize = index_of(COMPRESSOR, "makeup");

/// Linked-channel peak compressor with a 6 dB soft knee; no lookahead.
#[derive(Clone, Debug)]
pub struct Compressor {
    rate: f64,
    threshold: f64,
    strength: f64,
    attack: f64,
    release: f64,
    makeup: f64,
    knee: f64,
    envelope: f64,
    meter: Meter,
}

impl Compressor {
    pub fn new(sample_rate: f64, p: &ParamSet) -> Self {
        let mut s = Self {
            rate: sample_rate,
            threshold: 0.0,
            strength: 0.0,
            attack: 0.0,
            release: 0.0,
            makeup: 1.0,
            knee: 6.0,
            envelope: 0.0,
            meter: Meter::default(),
        };
        s.automate(p);
        s
    }

    /// dsp.cpp `Compressor(rate, threshold, ratio, attack, release, makeup)` with the 6 dB knee
    /// (attack / release in seconds, makeup linear): the guitar rig's compressor pedal.
    pub(crate) fn with_settings(
        sample_rate: f64,
        threshold: f64,
        ratio: f64,
        attack: f64,
        release: f64,
        makeup: f64,
    ) -> Self {
        let mut s = Self {
            rate: sample_rate,
            threshold: 0.0,
            strength: 0.0,
            attack: 0.0,
            release: 0.0,
            makeup: 1.0,
            knee: 6.0,
            envelope: 0.0,
            meter: Meter::default(),
        };
        s.set(threshold, ratio, attack, release, makeup);
        s
    }

    /// `Compressor::set` (seconds, linear makeup).
    pub(crate) fn set(&mut self, threshold: f64, ratio: f64, attack: f64, release: f64, makeup: f64) {
        self.threshold = threshold;
        self.strength = 1.0 - 1.0 / ratio;
        self.attack = math::exp(-1.0 / (attack.max(0.00001) * self.rate));
        self.release = math::exp(-1.0 / (release.max(0.00001) * self.rate));
        self.makeup = makeup;
    }

    pub fn take_state_from(&mut self, p: &mut Self) -> bool {
        self.envelope = p.envelope;
        false
    }
}

impl Kernel for Compressor {
    fn automate(&mut self, p: &ParamSet) {
        self.set(
            p.get(C_THRESHOLD),
            p.get(C_RATIO),
            p.get(C_ATTACK) * 0.001,
            p.get(C_RELEASE) * 0.001,
            db_to_gain(p.get(C_MAKEUP)),
        );
    }

    #[inline(always)]
    fn frame(&mut self, l: f32, r: f32) -> (f32, f32) {
        let peak = f64::from(std_max(l.abs(), r.abs()));
        let c = if peak > self.envelope { self.attack } else { self.release };
        self.envelope = peak + c * (self.envelope - peak);
        let above = 20.0 * math::log10(std_max(1e-12, self.envelope)) - self.threshold;
        let half = self.knee / 2.0;
        let over = if above < -half {
            0.0
        } else if above < half {
            (above + half) * (above + half) / (2.0 * self.knee)
        } else {
            above
        };
        // pow(10, 0) is exactly 1: skip it below the knee (bit-identical, saves a pow per frame).
        let reduction = if over == 0.0 { 1.0 } else { db_to_gain(-self.strength * over) };
        let gain = (reduction * self.makeup) as f32;
        self.meter.add(peak, reduction);
        (l * gain, r * gain)
    }

    fn reset(&mut self) {
        self.envelope = 0.0;
    }

    fn take_meter(&mut self) -> Option<(f32, f32)> {
        Some(self.meter.take())
    }
}

const L_GAIN: usize = index_of(LIMITER, "gain");
const L_CEILING: usize = index_of(LIMITER, "ceiling");
const L_RELEASE: usize = index_of(LIMITER, "release");

/// Zero-latency peak limiter: instant attack, exponential release, hard ceiling guarantee.
#[derive(Clone, Debug)]
pub struct Limiter {
    sample_rate: f64,
    k: f64,
    ceiling: f64,
    release: f64,
    tail: f64,
    gain: f64,
    pre: Smooth,
    meter: Meter,
    /// Settled blocks: the loudest `peak` of the block, divided by the constant `pre` once at the
    /// end. Division by a positive constant is monotonic under rounding, so max(peak) / pre equals
    /// the per-frame max(peak / pre) the C++ meter takes.
    block_peak: f64,
}

impl Limiter {
    pub fn new(sample_rate: f64, p: &ParamSet) -> Self {
        let mut pre = Smooth::default();
        pre.set(db_to_gain(p.get(L_GAIN)));
        Self {
            sample_rate,
            k: smoothing_coefficient(sample_rate),
            ceiling: db_to_gain(p.get(L_CEILING)),
            release: 1.0 - math::exp(-1.0 / (p.get(L_RELEASE) * 0.001 * sample_rate)),
            tail: p.get(L_RELEASE) * 0.007,
            gain: 1.0,
            pre,
            meter: Meter::default(),
            block_peak: 0.0,
        }
    }

    pub fn take_state_from(&mut self, p: &mut Self) -> bool {
        self.gain = p.gain;
        self.pre.follow(&p.pre);
        false
    }
}

impl Kernel for Limiter {
    fn automate(&mut self, p: &ParamSet) {
        self.ceiling = db_to_gain(p.get(L_CEILING));
        self.release = 1.0 - math::exp(-1.0 / (p.get(L_RELEASE) * 0.001 * self.sample_rate));
        self.pre.target = db_to_gain(p.get(L_GAIN));
    }

    #[inline(always)]
    fn frame(&mut self, l: f32, r: f32) -> (f32, f32) {
        self.frame_if::<false>(l, r)
    }

    fn process_interleaved(&mut self, s: &mut [f32]) {
        process_interleaved_settled(self, s);
    }

    fn process_planar(&mut self, left: &mut [f32], right: &mut [f32]) {
        process_planar_settled(self, left, right);
    }

    fn reset(&mut self) {
        self.gain = 1.0;
    }

    fn tail_seconds(&self) -> f64 {
        self.tail
    }

    fn take_meter(&mut self) -> Option<(f32, f32)> {
        Some(self.meter.take())
    }
}

impl SettledFrame for Limiter {
    fn settled(&self) -> bool {
        self.pre.settled()
    }

    #[inline(always)]
    fn frame_if<const SETTLED: bool>(&mut self, l: f32, r: f32) -> (f32, f32) {
        let c = self.ceiling;
        let pre = self.pre.next_if::<SETTLED>(self.k);
        let xl = f64::from(l) * pre;
        let xr = f64::from(r) * pre;
        let peak = std_max(xl.abs(), xr.abs());
        let target = if peak > c { c / peak } else { 1.0 };
        // Both sides computed, then an explicit select: as an if / else, the (opaque) fused form on
        // Apple arm64 became a data-dependent branch that noise mispredicts, instead of fcsel.
        let released = math::mul_add(target - self.gain, self.release, self.gain);
        self.gain = core::hint::select_unpredictable(target < self.gain, target, released);
        if SETTLED {
            self.block_peak = std_max(self.block_peak, peak);
            self.meter.lowest = std_min(self.meter.lowest, self.gain);
        } else {
            self.meter.add(peak / pre, self.gain);
        }
        (std_clamp(xl * self.gain, -c, c) as f32, std_clamp(xr * self.gain, -c, c) as f32)
    }

    fn end_block<const SETTLED: bool>(&mut self) {
        if SETTLED {
            self.meter.loudest = std_max(self.meter.loudest, self.block_peak / self.pre.value);
            self.block_peak = 0.0;
        }
    }
}

const G_THRESHOLD: usize = index_of(GATE, "threshold");
const G_ATTACK: usize = index_of(GATE, "attack");
const G_HOLD: usize = index_of(GATE, "hold");
const G_RELEASE: usize = index_of(GATE, "release");

/// Noise gate: peak detector, 4 dB hysteresis, hold, then attack/release ramps of the gain.
#[derive(Clone, Debug)]
pub struct Gate {
    sample_rate: f64,
    open_level: f64,
    close_level: f64,
    attack: f64,
    release: f64,
    detector: f64,
    hold_frames: i64,
    tail: f64,
    envelope: f64,
    gain: f64,
    held: i64,
    open: bool,
    meter: Meter,
}

impl Gate {
    pub fn new(sample_rate: f64, p: &ParamSet) -> Self {
        let mut s = Self {
            sample_rate,
            open_level: 0.0,
            close_level: 0.0,
            attack: 0.0,
            release: 0.0,
            detector: math::exp(-1.0 / (0.01 * sample_rate)),
            hold_frames: 0,
            tail: (p.get(G_HOLD) + p.get(G_RELEASE) * 1.5) * 0.001,
            envelope: 0.0,
            gain: 0.0,
            held: 0,
            open: false,
            meter: Meter::default(),
        };
        s.automate(p);
        s
    }

    pub fn take_state_from(&mut self, p: &mut Self) -> bool {
        self.envelope = p.envelope;
        self.gain = p.gain;
        self.held = p.held;
        self.open = p.open;
        false
    }
}

impl Kernel for Gate {
    fn automate(&mut self, p: &ParamSet) {
        let sr = self.sample_rate;
        self.open_level = db_to_gain(p.get(G_THRESHOLD));
        self.close_level = self.open_level * db_to_gain(-4.0);
        self.attack = 1.0 - math::exp(-1.0 / (p.get(G_ATTACK) * 0.001 * sr));
        self.release = 1.0 - math::exp(-6.9 / (p.get(G_RELEASE) * 0.001 * sr));
        self.hold_frames = math::floor(p.get(G_HOLD) * 0.001 * sr + 0.5) as i64;
    }

    #[inline(always)]
    fn frame(&mut self, l: f32, r: f32) -> (f32, f32) {
        let peak = f64::from(std_max(l.abs(), r.abs()));
        self.envelope = if peak > self.envelope { peak } else { self.envelope * self.detector };
        if self.envelope >= self.open_level {
            self.open = true;
            self.held = self.hold_frames;
        } else if self.envelope < self.close_level {
            if self.held > 0 {
                self.held -= 1;
            } else {
                self.open = false;
            }
        }
        if self.open {
            self.gain += (1.0 - self.gain) * self.attack;
        } else {
            self.gain -= self.gain * self.release;
            if self.gain < 1e-4 {
                self.gain = 0.0;
            }
        }
        self.meter.add(peak, self.gain);
        ((f64::from(l) * self.gain) as f32, (f64::from(r) * self.gain) as f32)
    }

    fn reset(&mut self) {
        self.envelope = 0.0;
        self.gain = 0.0;
        self.held = 0;
        self.open = false;
    }

    fn tail_seconds(&self) -> f64 {
        self.tail
    }

    fn take_meter(&mut self) -> Option<(f32, f32)> {
        Some(self.meter.take())
    }
}

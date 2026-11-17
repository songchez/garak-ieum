//! IEUM WAVE voice and master DSP (the former C++ DSP (0.3.2)): the exponential
//! AHDSR envelope, the two-integrator TPT state-variable filter, and the drive / chorus / delay
//! effects. Delay lines are sized once (`Effects::new`, control thread).

use alloc::vec;
use alloc::vec::Vec;

use super::math::advance_phase;
use super::math::{
    LinearSmoother, PI, TAU, ceil, clampd, clampf, cos, cubic, exp, lerp, log, round, sin, sqrtf, tan,
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EnvelopeSettings {
    pub attack: f32,
    pub hold: f32,
    pub decay: f32,
    pub sustain: f32,
    pub release: f32,
}

impl Default for EnvelopeSettings {
    fn default() -> Self {
        Self { attack: 0.005, hold: 0.0, decay: 0.3, sustain: 0.75, release: 0.25 }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Stage {
    #[default]
    Idle,
    Attack,
    Hold,
    Decay,
    Sustain,
    Release,
}

#[derive(Clone, Copy, Debug)]
pub struct Envelope {
    sample_rate: f64,
    settings: EnvelopeSettings,
    stage: Stage,
    value: f32,
    target: f32,
    coefficient: f32,
    sustain_coefficient: f32,
    remaining: u32,
}

impl Default for Envelope {
    fn default() -> Self {
        Self {
            sample_rate: 48_000.0,
            settings: EnvelopeSettings::default(),
            stage: Stage::Idle,
            value: 0.0,
            target: 0.0,
            coefficient: 0.0,
            sustain_coefficient: 0.002,
            remaining: 0,
        }
    }
}

impl Envelope {
    pub fn prepare(&mut self, sample_rate: f64) {
        self.sample_rate = sample_rate;
        self.sustain_coefficient = (1.0 - exp(-1.0 / (sample_rate * 0.01))) as f32;
        self.reset();
    }

    pub fn reset(&mut self) {
        self.stage = Stage::Idle;
        self.value = 0.0;
        self.target = 0.0;
        self.coefficient = 0.0;
        self.remaining = 0;
    }

    pub fn configure(&mut self, settings: EnvelopeSettings) {
        self.settings = settings;
    }

    pub fn note_on(&mut self) {
        self.value = 0.0;
        self.enter(Stage::Attack);
    }

    pub fn note_off(&mut self) {
        if self.stage != Stage::Idle && self.stage != Stage::Release {
            self.enter(Stage::Release);
        }
    }

    #[inline]
    pub fn value(&self) -> f32 {
        self.value
    }

    #[inline]
    pub fn active(&self) -> bool {
        self.stage != Stage::Idle
    }

    fn enter(&mut self, stage: Stage) {
        self.stage = stage;
        let s = self.settings;
        let seconds;
        match stage {
            Stage::Idle => {
                self.reset();
                return;
            }
            Stage::Attack => {
                seconds = s.attack;
                self.target = 1.5;
            }
            Stage::Hold => {
                self.value = 1.0;
                if s.hold <= 0.0 {
                    self.enter(Stage::Decay);
                    return;
                }
                seconds = s.hold;
                self.target = self.value;
            }
            Stage::Decay => {
                seconds = s.decay;
                self.target = s.sustain - 0.001;
            }
            Stage::Sustain => {
                self.value = s.sustain;
                self.remaining = 0;
                return;
            }
            Stage::Release => {
                seconds = s.release;
                self.target = -0.001;
            }
        }
        let r = round(f64::from(seconds) * self.sample_rate);
        self.remaining = (if 1.0 < r { r } else { 1.0 }) as u32;
        let endpoint = match stage {
            Stage::Attack | Stage::Hold => 1.0f32,
            Stage::Decay => s.sustain,
            _ => 0.0,
        };
        let max = |a: f64, b: f64| if a < b { b } else { a };
        let distance = max(1.0e-8, f64::from((self.value - self.target).abs()));
        let end_distance = max(1.0e-8, f64::from((endpoint - self.target).abs()));
        let ratio = end_distance / distance;
        let ratio = if ratio < 1.0 { ratio } else { 1.0 };
        self.coefficient = (1.0 - exp(log(ratio) / f64::from(self.remaining))) as f32;
    }

    #[inline]
    pub fn next(&mut self) -> f32 {
        match self.stage {
            Stage::Idle => return 0.0,
            Stage::Sustain => {
                self.value += (self.settings.sustain - self.value) * self.sustain_coefficient;
                return self.value;
            }
            _ => {}
        }
        self.value += self.coefficient * (self.target - self.value);
        self.remaining = self.remaining.wrapping_sub(1);
        if self.remaining == 0 {
            match self.stage {
                Stage::Attack => {
                    self.value = 1.0;
                    self.enter(Stage::Hold);
                }
                Stage::Hold => self.enter(Stage::Decay),
                Stage::Decay => self.enter(Stage::Sustain),
                Stage::Release => self.reset(),
                _ => {}
            }
        }
        clampf(self.value, 0.0, 1.0)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Stereo {
    pub left: f32,
    pub right: f32,
}

/// Two-integrator TPT state-variable filter with ramped coefficients and output type.
#[derive(Clone, Copy, Debug, Default)]
pub struct StereoFilter {
    sample_rate: f64,
    ic1: [f64; 2],
    ic2: [f64; 2],
    g: LinearSmoother,
    k: LinearSmoother,
    kind: LinearSmoother,
    mix: LinearSmoother,
}

impl StereoFilter {
    pub fn prepare(&mut self, sample_rate: f64) {
        self.sample_rate = sample_rate;
        self.g.reset(0.1);
        self.k.reset(1.8);
        self.kind.reset(0.0);
        self.mix.reset(0.0);
        self.ic1 = [0.0; 2];
        self.ic2 = [0.0; 2];
    }

    pub fn configure(&mut self, cutoff: f32, resonance: f32, kind: f32, mix: f32, ramp: u32) {
        let frequency = clampd(f64::from(cutoff), 20.0, self.sample_rate * 0.45);
        self.g.set(tan(PI * frequency / self.sample_rate) as f32, ramp);
        self.k.set(2.0 * (1.0 - clampf(resonance, 0.0, 0.95)), ramp);
        self.kind.set(clampf(kind, 0.0, 3.0), ramp);
        self.mix.set(clampf(mix, 0.0, 1.0), ramp);
    }

    #[inline]
    pub fn process(&mut self, input: Stereo) -> Stereo {
        let g = f64::from(self.g.next());
        let k = f64::from(self.k.next());
        let a1 = 1.0 / (1.0 + g * (g + k));
        let a2 = g * a1;
        let a3 = g * a2;
        let kind = self.kind.next();
        let mix = self.mix.next();
        let first = kind as u32;
        let second = (first + 1).min(3);
        let fraction = kind - first as f32;
        let mut data = [input.left, input.right];
        for (ch, d) in data.iter_mut().enumerate() {
            let (Some(i1), Some(i2)) = (self.ic1.get(ch).copied(), self.ic2.get(ch).copied()) else {
                continue;
            };
            let x = f64::from(*d);
            let v3 = x - i2;
            let v1 = a1 * i1 + a2 * v3;
            let v2 = i2 + a2 * i1 + a3 * v3;
            let mut n1 = 2.0 * v1 - i1;
            let mut n2 = 2.0 * v2 - i2;
            if n1.abs() < 1.0e-20 {
                n1 = 0.0;
            }
            if n2.abs() < 1.0e-20 {
                n2 = 0.0;
            }
            if let Some(s) = self.ic1.get_mut(ch) {
                *s = n1;
            }
            if let Some(s) = self.ic2.get_mut(ch) {
                *s = n2;
            }
            let high = x - k * v1 - v2;
            // Schema: 0 LP, 1 HP, 2 BP, 3 notch. BP is unity normalized at its center.
            let outputs = [v2 as f32, high as f32, (k * v1) as f32, (high + v2) as f32];
            let pick = |i: u32| outputs.get(i as usize).copied().unwrap_or(0.0);
            *d = lerp(*d, lerp(pick(first), pick(second), fraction), mix);
        }
        Stereo { left: data[0], right: data[1] }
    }
}

/// Drive (ADAA soft clip), stereo chorus and a ping-pong delay with filtered feedback.
#[derive(Clone, Debug)]
pub struct Effects {
    sample_rate: f64,
    chorus_phase: f64,
    chorus_l: Vec<f32>,
    chorus_r: Vec<f32>,
    delay_l: Vec<f32>,
    delay_r: Vec<f32>,
    chorus_write: usize,
    delay_write: usize,
    previous_drive_l: f32,
    previous_drive_r: f32,
    delay_low_l: f32,
    delay_low_r: f32,
    delay_dc_l: f32,
    delay_dc_r: f32,
    low_coefficient: f32,
    dc_coefficient: f32,
}

impl Effects {
    /// the former C++ DSP (0.3.2) `Effects::prepare` (allocates the lines).
    pub fn new(sample_rate: f64) -> Self {
        let chorus = ceil(0.05 * sample_rate) as usize + 8;
        let delay = ceil(2.01 * sample_rate) as usize + 8;
        Self {
            sample_rate,
            chorus_phase: 0.0,
            chorus_l: vec![0.0; chorus],
            chorus_r: vec![0.0; chorus],
            delay_l: vec![0.0; delay],
            delay_r: vec![0.0; delay],
            chorus_write: 0,
            delay_write: 0,
            previous_drive_l: 0.0,
            previous_drive_r: 0.0,
            delay_low_l: 0.0,
            delay_low_r: 0.0,
            delay_dc_l: 0.0,
            delay_dc_r: 0.0,
            low_coefficient: (1.0 - exp(-TAU * 6500.0 / sample_rate)) as f32,
            dc_coefficient: (1.0 - exp(-TAU * 35.0 / sample_rate)) as f32,
        }
    }

    pub fn reset(&mut self) {
        self.chorus_l.fill(0.0);
        self.chorus_r.fill(0.0);
        self.delay_l.fill(0.0);
        self.delay_r.fill(0.0);
        self.chorus_write = 0;
        self.delay_write = 0;
        self.chorus_phase = 0.0;
        self.previous_drive_l = 0.0;
        self.previous_drive_r = 0.0;
        self.delay_low_l = 0.0;
        self.delay_low_r = 0.0;
        self.delay_dc_l = 0.0;
        self.delay_dc_r = 0.0;
    }

    #[inline]
    fn read(data: &[f32], write: usize, delay: f64) -> f32 {
        let n = data.len();
        let mut position = write as f64 - clampd(delay, 2.0, (n - 4) as f64);
        if position < 0.0 {
            position += n as f64;
        }
        let i = position as usize;
        let frac = (position - i as f64) as f32;
        let at = |k: usize| data.get(k % n).copied().unwrap_or(0.0);
        cubic(at(i + n - 1), at(i), at(i + 1), at(i + 2), frac)
    }

    #[allow(clippy::too_many_arguments)]
    #[inline]
    pub fn process(
        &mut self,
        input: Stereo,
        drive: f32,
        drive_mix: f32,
        chorus_rate: f32,
        chorus_depth: f32,
        chorus_mix: f32,
        delay_seconds: f32,
        feedback: f32,
        delay_mix: f32,
    ) -> Stereo {
        // First-order antiderivative antialiasing for f(x) = x / sqrt(1 + x * x).
        let gain = 1.0 + 24.0 * drive * drive;
        let compensation = 1.0 / sqrtf(1.0 + 4.0 * drive);
        let saturate = |x: f32, previous: f32| {
            let a = gain * x;
            let b = gain * previous;
            (a + b) / (sqrtf(1.0 + a * a) + sqrtf(1.0 + b * b)) * compensation
        };
        let mut driven = input;
        if drive_mix > 0.0 {
            driven.left = lerp(input.left, saturate(input.left, self.previous_drive_l), drive_mix);
            driven.right = lerp(input.right, saturate(input.right, self.previous_drive_r), drive_mix);
        }
        self.previous_drive_l = input.left;
        self.previous_drive_r = input.right;
        if let Some(s) = self.chorus_l.get_mut(self.chorus_write) {
            *s = driven.left;
        }
        if let Some(s) = self.chorus_r.get_mut(self.chorus_write) {
            *s = driven.right;
        }
        let motion = sin(TAU * self.chorus_phase);
        let motion_r = cos(TAU * self.chorus_phase);
        let sr = self.sample_rate;
        let wet_l = Self::read(
            &self.chorus_l,
            self.chorus_write,
            sr * (0.014 + 0.006 * f64::from(chorus_depth) * motion),
        );
        let wet_r = Self::read(
            &self.chorus_r,
            self.chorus_write,
            sr * (0.017 + 0.006 * f64::from(chorus_depth) * motion_r),
        );
        self.chorus_write = (self.chorus_write + 1) % self.chorus_l.len().max(1);
        self.chorus_phase = advance_phase(self.chorus_phase, f64::from(chorus_rate) / sr);
        let modulated = Stereo {
            left: lerp(driven.left, wet_l, chorus_mix),
            right: lerp(driven.right, wet_r, chorus_mix),
        };
        let delayed_l = Self::read(&self.delay_l, self.delay_write, f64::from(delay_seconds) * sr);
        let delayed_r = Self::read(&self.delay_r, self.delay_write, f64::from(delay_seconds) * sr);
        self.delay_low_l += self.low_coefficient * (delayed_l - self.delay_low_l);
        self.delay_low_r += self.low_coefficient * (delayed_r - self.delay_low_r);
        self.delay_dc_l += self.dc_coefficient * (self.delay_low_l - self.delay_dc_l);
        self.delay_dc_r += self.dc_coefficient * (self.delay_low_r - self.delay_dc_r);
        let clean = |v: f32| if v.abs() < 1.0e-20 { 0.0 } else { v };
        self.delay_low_l = clean(self.delay_low_l);
        self.delay_low_r = clean(self.delay_low_r);
        self.delay_dc_l = clean(self.delay_dc_l);
        self.delay_dc_r = clean(self.delay_dc_r);
        let returned_l = self.delay_low_l - self.delay_dc_l;
        let returned_r = self.delay_low_r - self.delay_dc_r;
        if let Some(s) = self.delay_l.get_mut(self.delay_write) {
            *s = clean(clampf(modulated.left + feedback * returned_r, -16.0, 16.0));
        }
        if let Some(s) = self.delay_r.get_mut(self.delay_write) {
            *s = clean(clampf(modulated.right + feedback * returned_l, -16.0, 16.0));
        }
        self.delay_write = (self.delay_write + 1) % self.delay_l.len().max(1);
        Stereo {
            left: lerp(modulated.left, returned_l, delay_mix),
            right: lerp(modulated.right, returned_r, delay_mix),
        }
    }
}

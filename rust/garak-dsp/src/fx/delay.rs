//! Studio delay: sigimsae_effects.inc `StudioDelay` (= kernels.ts `DelayKernel`). Stereo or
//! ping-pong; band-limited feedback path; Tape (age) adds 0.7 Hz wow, 7.3 Hz flutter and loop
//! saturation. Every repeat passes through the filters. Tempo-synced times follow `set_tempo`.

use super::{Kernel, TAU, feedback_repeats};
use crate::biquad::{Biquad, FilterType};
use crate::lines::{Carver, Ring};
use crate::params::{DELAY, ParamSet, index_of};
use crate::smooth::{Smooth, smoothing_coefficient};
use crate::std_max;

const AMOUNT: usize = index_of(DELAY, "amount");
const TIME: usize = index_of(DELAY, "time");
const FEEDBACK: usize = index_of(DELAY, "feedback");
const TONE: usize = index_of(DELAY, "tone");
const LOWCUT: usize = index_of(DELAY, "lowcut");
const AGE: usize = index_of(DELAY, "age");
const SYNC: usize = index_of(DELAY, "sync");
const MS: usize = index_of(DELAY, "ms");
const MODE: usize = index_of(DELAY, "mode");
const DRY: usize = index_of(DELAY, "dry");

/// Longest delay time (kernels.ts `DELAY_MAX_SECONDS`).
pub const DELAY_MAX_SECONDS: f64 = 3.9;

fn seconds(p: &ParamSet, bpm: f64) -> f64 {
    let s = if p.get(SYNC) >= 0.5 { p.get(TIME) * 60.0 / bpm } else { p.get(MS) * 0.001 };
    s.min(DELAY_MAX_SECONDS)
}

#[derive(Debug)]
pub struct StudioDelay<'a> {
    sample_rate: f64,
    k: f64,
    l: Ring<'a>,
    r: Ring<'a>,
    low: Biquad,
    high: Biquad,
    wet: Smooth,
    dry: Smooth,
    feedback: Smooth,
    age: Smooth,
    time: Smooth,
    glide: f64,
    tail: f64,
    wow: f64,
    flutter: f64,
    wow_step: f64,
    flutter_step: f64,
    sync_beats: f64,
    bpm: f64,
    lowcut: bool,
    ping_pong: bool,
}

impl<'a> StudioDelay<'a> {
    fn ring_size(sample_rate: f64) -> usize {
        libm::ceil(sample_rate * 4.1) as usize + 4
    }

    pub fn storage_len(sample_rate: f64) -> usize {
        2 * Ring::len_for(Self::ring_size(sample_rate))
    }

    pub fn new(sample_rate: f64, bpm: f64, p: &ParamSet, carver: &mut Carver<'a>) -> Self {
        let n = Self::ring_size(sample_rate);
        let secs = seconds(p, bpm);
        let mut s = Self {
            sample_rate,
            k: smoothing_coefficient(sample_rate),
            l: Ring::new(carver, n),
            r: Ring::new(carver, n),
            low: Biquad::new(),
            high: Biquad::new(),
            wet: Smooth::default(),
            dry: Smooth::default(),
            feedback: Smooth::default(),
            age: Smooth::default(),
            time: Smooth::default(),
            glide: 1.0 - libm::exp(-1.0 / (0.08 * sample_rate)),
            tail: 0.0,
            wow: 0.0,
            flutter: 0.0,
            wow_step: TAU * 0.7 / sample_rate,
            flutter_step: TAU * 7.3 / sample_rate,
            sync_beats: if p.get(SYNC) >= 0.5 { p.get(TIME) } else { 0.0 },
            bpm,
            lowcut: p.get(LOWCUT) > 20.5,
            ping_pong: p.get(MODE) >= 0.5,
        };
        s.wet.set(p.get(AMOUNT) * 0.45);
        s.dry.set(p.get(DRY));
        s.feedback.set(p.get(FEEDBACK));
        s.age.set(p.get(AGE));
        s.time.set(secs * sample_rate);
        s.low.configure(FilterType::Lowpass, sample_rate, p.get(TONE), 1.0, 0.0);
        s.high.configure(FilterType::Highpass, sample_rate, p.get(LOWCUT), 0.5, 0.0);
        let repeats = feedback_repeats(p.get(FEEDBACK));
        s.tail = if p.get(AMOUNT) > 0.0 {
            ((secs + p.get(AGE) * 0.0026) * (repeats + 1.0) + 0.85).min(30.0)
        } else {
            0.0
        };
        s
    }

    pub fn take_state_from(&mut self, p: &mut Self) -> bool {
        let swapped = self.l.same_size(&p.l) && self.l.swap_with(&mut p.l) && self.r.swap_with(&mut p.r);
        self.low.take_history_from(&p.low);
        self.high.take_history_from(&p.high);
        self.wet.follow(&p.wet);
        self.dry.follow(&p.dry);
        self.feedback.follow(&p.feedback);
        self.age.follow(&p.age);
        self.time.follow(&p.time);
        self.wow = p.wow;
        self.flutter = p.flutter;
        swapped
    }

    /// Whether the delay runs in ping-pong mode (fixed at construction).
    pub fn ping_pong(&self) -> bool {
        self.ping_pong
    }
}

impl Kernel for StudioDelay<'_> {
    /// Mode (stereo / ping-pong) changes the routing and the track's stereo layout, so it keeps
    /// its prepared value.
    fn automate(&mut self, p: &ParamSet) {
        let secs = seconds(p, self.bpm);
        self.sync_beats = if p.get(SYNC) >= 0.5 { p.get(TIME) } else { 0.0 };
        self.wet.target = p.get(AMOUNT) * 0.45;
        self.dry.target = p.get(DRY);
        self.feedback.target = p.get(FEEDBACK);
        self.age.target = p.get(AGE);
        self.time.target = secs * self.sample_rate;
        self.lowcut = p.get(LOWCUT) > 20.5;
        self.low.retarget(FilterType::Lowpass, self.sample_rate, p.get(TONE), 1.0, 0.0);
        self.high.retarget(FilterType::Highpass, self.sample_rate, p.get(LOWCUT), 0.5, 0.0);
    }

    /// A synced delay time glides to the new tempo like a time edit does.
    fn set_tempo(&mut self, bpm: f64) {
        if !bpm.is_finite() || bpm <= 0.0 || (bpm - self.bpm).abs() < 1e-6 {
            return;
        }
        self.bpm = bpm;
        if self.sync_beats > 0.0 {
            self.time.target = (self.sync_beats * 60.0 / bpm).min(DELAY_MAX_SECONDS) * self.sample_rate;
        }
    }

    #[inline]
    fn frame(&mut self, xl: f32, xr: f32) -> (f32, f32) {
        let sr = self.sample_rate;
        let wet = self.wet.next(self.k);
        let dry = self.dry.next(self.k);
        let feedback = self.feedback.next(self.k);
        let age = self.age.next(self.k);
        let time = self.time.next(self.glide);
        let wobble = age * sr * (0.0014 + 0.0012 * libm::sin(self.wow) + 0.00015 * libm::sin(self.flutter));
        let read = std_max(0.0, time + wobble - 1.0);
        let drive = 1.0 + 2.0 * age;
        let mut fl = f64::from(self.low.sample(self.l.read(read), 0));
        let mut fr = f64::from(self.low.sample(self.r.read(read), 1));
        if self.lowcut {
            fl = f64::from(self.high.sample(fl as f32, 0));
            fr = f64::from(self.high.sample(fr as f32, 1));
        }
        if age > 1e-4 {
            fl = libm::tanh(fl * drive) / drive;
            fr = libm::tanh(fr * drive) / drive;
        }
        let (xl, xr) = (f64::from(xl), f64::from(xr));
        if self.ping_pong {
            self.l.push((0.5 * (xl + xr) + feedback * fr) as f32);
            self.r.push((feedback * fl) as f32);
        } else {
            self.l.push((xl + feedback * fl) as f32);
            self.r.push((xr + feedback * fr) as f32);
        }
        self.wow += self.wow_step;
        if self.wow >= TAU {
            self.wow -= TAU;
        }
        self.flutter += self.flutter_step;
        if self.flutter >= TAU {
            self.flutter -= TAU;
        }
        ((dry * xl + wet * fl) as f32, (dry * xr + wet * fr) as f32)
    }

    fn reset(&mut self) {
        self.l.reset();
        self.r.reset();
        self.low.reset();
        self.high.reset();
        self.wow = 0.0;
        self.flutter = 0.0;
    }

    fn tail_seconds(&self) -> f64 {
        self.tail
    }
}

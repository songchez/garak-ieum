//! The rig's modules, one per dsp.cpp class: `RigComp`, `RigDrive` / `RigFuzz` ([`Clipper`]),
//! `RigAmp`, `RigCabinet`, `RigChorus`, `RigDelay`, `RigPhaser`, `RigTremolo`, `RigReverb`,
//! `RigTuner`, with the shared `Chorus`, `Delay`, `Phaser` and `Tremolo` classes folded in. Same
//! state, same operation order and the same float rounding points as the C++.

use super::catalog::MODULE_PARAMS_MAX;
use crate::biquad::{Biquad, FilterType};
use crate::fx::color::ChannelSaturator as Saturator;
use crate::fx::dynamics::Compressor;
use crate::fx::reverb::StereoConvolver;
use crate::fx::{Kernel, TAU, feedback_repeats};
use crate::gain::db_to_gain;
use crate::lines::{Carver, DelayLine};
use crate::{PI, math, std_min};

/// One module instance's parameters: `get(k)` is dsp.cpp `RigParams(base)` for the `k`-th id of
/// `MODULE_PARAMS[code]` (the instance's own `_2` / `_3` id when it is a copy).
#[derive(Clone, Copy, Debug)]
pub(crate) struct P<'v> {
    pub values: &'v [f64],
    pub index: &'static [u16; MODULE_PARAMS_MAX],
}

impl P<'_> {
    #[inline]
    pub fn get(&self, k: usize) -> f64 {
        self.index.get(k).and_then(|&i| self.values.get(usize::from(i))).copied().unwrap_or(0.0)
    }

    /// `RigParams::on`.
    #[inline]
    pub fn on(&self, k: usize) -> bool {
        self.get(k) >= 0.5
    }
}

/// The per-frame body of a module; `active` decides per block whether it runs at all.
pub(crate) trait Stage {
    /// False when the module leaves this block untouched (bypassed pedal, faded-out modulation).
    fn active(&mut self) -> bool {
        true
    }
    fn frame(&mut self, l: f32, r: f32) -> (f32, f32);
}

/// One out-of-line loop per module type, so `frame` inlines and its state stays in registers.
#[inline(never)]
pub(crate) fn run_interleaved<S: Stage>(stage: &mut S, s: &mut [f32]) {
    if !stage.active() {
        return;
    }
    for [l, r] in s.as_chunks_mut::<2>().0 {
        (*l, *r) = stage.frame(*l, *r);
    }
}

#[inline(never)]
pub(crate) fn run_planar<S: Stage>(stage: &mut S, left: &mut [f32], right: &mut [f32]) {
    if !stage.active() {
        return;
    }
    for (l, r) in left.iter_mut().zip(right.iter_mut()) {
        (*l, *r) = stage.frame(*l, *r);
    }
}

// The rig's building blocks: inlined natively (speed), out of line on wasm32, where inlining
// ~50 biquads, eight oversampled shapers and two convolvers into every module loop cost ~60 KiB
// of the worklet module's size budget (docs/RUST.md) for no audible gain.

#[cfg_attr(target_arch = "wasm32", inline(never))]
#[cfg_attr(not(target_arch = "wasm32"), inline(always))]
fn bq(f: &mut Biquad, x: f32, c: usize) -> f32 {
    f.sample(x, c)
}

#[cfg_attr(target_arch = "wasm32", inline(never))]
#[cfg_attr(not(target_arch = "wasm32"), inline(always))]
fn sat(s: &mut Saturator, x: f32, c: usize) -> f32 {
    s.sample(x, c)
}

#[cfg_attr(target_arch = "wasm32", inline(never))]
#[cfg_attr(not(target_arch = "wasm32"), inline(always))]
fn convolve(conv: &mut StereoConvolver<'_>, x: f32, c: usize) -> f32 {
    conv.sample(x, c)
}

/// Control path only (construction, automation): kept out of line so the ~25 call sites share one
/// copy of the coefficient design.
#[inline(never)]
fn set_filter(f: &mut Biquad, glide: bool, kind: FilterType, sr: f64, hz: f64, q: f64, gain: f64) {
    if glide { f.retarget(kind, sr, hz, q, gain) } else { f.configure(kind, sr, hz, q, gain) }
}

// ---- 1 comp -------------------------------------------------------------------------------------

/// `RigComp`: the dsp.cpp compressor with settings derived from Sustain.
#[derive(Clone, Debug)]
pub(crate) struct Comp {
    comp: Compressor,
    enabled: bool,
}

/// (threshold dB, ratio, attack s, release s, makeup linear).
fn comp_settings(p: &P<'_>) -> (f64, f64, f64, f64, f64) {
    let sustain = p.get(1);
    (
        -12.0 - sustain * 30.0,
        1.0 + sustain * 7.0,
        p.get(2) * 0.001,
        0.09 + sustain * 0.1,
        db_to_gain(p.get(3) + sustain * 6.0),
    )
}

impl Comp {
    pub fn new(sr: f64, p: &P<'_>) -> Self {
        let (t, r, a, rel, m) = comp_settings(p);
        Self { comp: Compressor::with_settings(sr, t, r, a, rel, m), enabled: p.on(0) }
    }

    pub fn automate(&mut self, p: &P<'_>) {
        let (t, r, a, rel, m) = comp_settings(p);
        self.comp.set(t, r, a, rel, m);
        self.enabled = p.on(0);
    }

    pub fn reset(&mut self) {
        self.comp.reset();
    }

    pub fn take_state_from(&mut self, p: &mut Self) {
        self.comp.take_state_from(&mut p.comp);
    }
}

impl Stage for Comp {
    fn active(&mut self) -> bool {
        self.enabled
    }

    #[inline(always)]
    fn frame(&mut self, l: f32, r: f32) -> (f32, f32) {
        self.comp.frame(l, r)
    }
}

// ---- 2 drive, 7 fuzz ----------------------------------------------------------------------------

/// `RigDrive` (`fuzz == false`) and `RigFuzz`: input high-pass, 2x oversampled shaper, tone
/// low-pass, DC blocker. Eight frames of latency while enabled.
#[derive(Clone, Debug)]
pub(crate) struct Clipper {
    fuzz: bool,
    sample_rate: f64,
    shaper: Saturator,
    input: Biquad,
    tone: Biquad,
    dc: Biquad,
    pre: f64,
    post: f64,
    enabled: bool,
}

impl Clipper {
    pub fn new(fuzz: bool, sr: f64, p: &P<'_>) -> Self {
        let mut s = Self {
            fuzz,
            sample_rate: sr,
            shaper: if fuzz { Saturator::new(4.5, 0.3) } else { Saturator::new(2.8, 0.12) },
            input: Biquad::new(),
            tone: Biquad::new(),
            dc: Biquad::new(),
            pre: 1.0,
            post: 1.0,
            enabled: p.on(0),
        };
        s.levels(p);
        set_filter(&mut s.input, false, FilterType::Highpass, sr, if fuzz { 40.0 } else { 95.0 }, 0.707, 0.0);
        set_filter(&mut s.dc, false, FilterType::Highpass, sr, 25.0, 0.707, 0.0);
        s.tone_filter(p, false);
        s
    }

    fn levels(&mut self, p: &P<'_>) {
        self.pre = db_to_gain(p.get(1));
        self.post =
            if self.fuzz { db_to_gain(p.get(3)) } else { db_to_gain(p.get(3)) / math::pow(self.pre, 0.4) };
    }

    /// Drive: 1.2-9.6 kHz; fuzz: 500 Hz - 5 kHz.
    fn tone_filter(&mut self, p: &P<'_>, glide: bool) {
        let hz =
            if self.fuzz { 500.0 * math::pow(10.0, p.get(2)) } else { 1200.0 * math::pow(8.0, p.get(2)) };
        set_filter(&mut self.tone, glide, FilterType::Lowpass, self.sample_rate, hz, 0.707, 0.0);
    }

    pub fn automate(&mut self, p: &P<'_>) {
        self.levels(p);
        self.enabled = p.on(0);
        self.tone_filter(p, true);
    }

    pub fn reset(&mut self) {
        self.shaper.reset();
        self.input.reset();
        self.tone.reset();
        self.dc.reset();
    }

    pub fn take_state_from(&mut self, p: &Self) {
        self.shaper.take_state_from(&p.shaper);
        self.input.take_history_from(&p.input);
        self.tone.take_history_from(&p.tone);
        self.dc.take_history_from(&p.dc);
    }

    pub fn latency(&self) -> u32 {
        if self.enabled { 8 } else { 0 }
    }

    #[inline(always)]
    fn channel(&mut self, x: f32, c: usize) -> f32 {
        let x = bq(&mut self.input, x, c);
        let x = sat(&mut self.shaper, (f64::from(x) * self.pre) as f32, c);
        (f64::from(bq(&mut self.dc, bq(&mut self.tone, x, c), c)) * self.post) as f32
    }
}

impl Stage for Clipper {
    fn active(&mut self) -> bool {
        self.enabled
    }

    #[inline(always)]
    fn frame(&mut self, l: f32, r: f32) -> (f32, f32) {
        let l = self.channel(l, 0);
        (l, self.channel(r, 1))
    }
}

// ---- 3 amp --------------------------------------------------------------------------------------

/// Model voicing (src/devices/guitar-rig/voicing.ts): 0 clean, 1 crunch, 2 lead, 3 chime, 4 jazz.
const AMP_PRE: [f64; 5] = [0.55, 1.5, 3.5, 1.0, 0.4];
const AMP_INTER: [f64; 5] = [0.8, 1.2, 1.65, 1.05, 0.7];
const AMP_HIGHPASS: [f64; 5] = [45.0, 75.0, 100.0, 90.0, 40.0];
const AMP_LOWPASS: [f64; 5] = [9500.0, 6600.0, 5200.0, 8200.0, 6000.0];
const AMP_COMPENSATION: [f64; 5] = [0.9, 0.55, 0.42, 0.7, 1.0];

/// `std::clamp(static_cast<int>(std::round(v)), 0, 4)` as an index.
fn model(v: f64) -> usize {
    (math::round(v) as i64).clamp(0, 4) as usize
}

fn pick(table: &[f64; 5], i: usize) -> f64 {
    table.get(i).copied().unwrap_or(0.0)
}

/// `RigAmp`: preamp shaper, interstage low-pass, power shaper, DC blocker, four-band tone stack.
/// Sixteen frames of latency (two oversampled shapers) while enabled.
#[derive(Clone, Debug)]
pub(crate) struct Amp {
    sample_rate: f64,
    shaper: Saturator,
    power: Saturator,
    input: Biquad,
    inter_filter: Biquad,
    dc: Biquad,
    eq: [Biquad; 4],
    pre: f64,
    inter: f64,
    post: f64,
    enabled: bool,
}

impl Amp {
    pub fn new(sr: f64, p: &P<'_>) -> Self {
        let mut s = Self {
            sample_rate: sr,
            shaper: Saturator::new(2.4, 0.08),
            power: Saturator::new(2.4 * 0.65, -0.08),
            input: Biquad::new(),
            inter_filter: Biquad::new(),
            dc: Biquad::new(),
            eq: [Biquad::new(), Biquad::new(), Biquad::new(), Biquad::new()],
            pre: 1.0,
            inter: 1.0,
            post: 1.0,
            enabled: p.on(0),
        };
        s.configure(p, false);
        s
    }

    fn configure(&mut self, p: &P<'_>, glide: bool) {
        let sr = self.sample_rate;
        let m = model(p.get(7));
        let gain = db_to_gain(p.get(1));
        self.pre = gain * pick(&AMP_PRE, m);
        self.inter = pick(&AMP_INTER, m);
        self.post = db_to_gain(p.get(6)) * pick(&AMP_COMPENSATION, m) / math::pow(gain, 0.15);
        set_filter(&mut self.input, glide, FilterType::Highpass, sr, pick(&AMP_HIGHPASS, m), 0.707, 0.0);
        set_filter(&mut self.inter_filter, glide, FilterType::Lowpass, sr, pick(&AMP_LOWPASS, m), 0.707, 0.0);
        set_filter(&mut self.dc, glide, FilterType::Highpass, sr, 25.0, 0.707, 0.0);
        let [bass, mid, treble, presence] = &mut self.eq;
        set_filter(bass, glide, FilterType::LowShelf, sr, 150.0, 0.707, p.get(2));
        set_filter(mid, glide, FilterType::Peak, sr, 750.0, 0.8, p.get(3));
        set_filter(treble, glide, FilterType::HighShelf, sr, 2600.0, 0.707, p.get(4));
        set_filter(presence, glide, FilterType::HighShelf, sr, 4200.0, 0.707, p.get(5));
    }

    pub fn automate(&mut self, p: &P<'_>) {
        self.enabled = p.on(0);
        self.configure(p, true);
    }

    pub fn reset(&mut self) {
        self.shaper.reset();
        self.power.reset();
        self.input.reset();
        self.inter_filter.reset();
        self.dc.reset();
        for f in &mut self.eq {
            f.reset();
        }
    }

    pub fn take_state_from(&mut self, p: &Self) {
        self.shaper.take_state_from(&p.shaper);
        self.power.take_state_from(&p.power);
        self.input.take_history_from(&p.input);
        self.inter_filter.take_history_from(&p.inter_filter);
        self.dc.take_history_from(&p.dc);
        for (f, pf) in self.eq.iter_mut().zip(&p.eq) {
            f.take_history_from(pf);
        }
    }

    pub fn latency(&self) -> u32 {
        if self.enabled { 16 } else { 0 }
    }

    #[inline(always)]
    fn channel(&mut self, x: f32, c: usize) -> f32 {
        let x = bq(&mut self.input, x, c);
        let x = sat(&mut self.shaper, (f64::from(x) * self.pre) as f32, c);
        let x = sat(&mut self.power, (f64::from(bq(&mut self.inter_filter, x, c)) * self.inter) as f32, c);
        let mut x = bq(&mut self.dc, x, c);
        for f in &mut self.eq {
            x = bq(f, x, c);
        }
        (f64::from(x) * self.post) as f32
    }
}

impl Stage for Amp {
    fn active(&mut self) -> bool {
        self.enabled
    }

    #[inline(always)]
    fn frame(&mut self, l: f32, r: f32) -> (f32, f32) {
        let l = self.channel(l, 0);
        (l, self.channel(r, 1))
    }
}

// ---- 4 cabinet ----------------------------------------------------------------------------------

/// Cabinet models (index = `cabinet`): 0 tweed 1x12, 1 open 2x12, 2 4x12 stack, 3 1x10, 4 chime 2x12.
const CAB_HIGHPASS: [f64; 5] = [95.0, 75.0, 62.0, 120.0, 85.0];
const CAB_RESONANCE: [f64; 5] = [145.0, 118.0, 95.0, 175.0, 125.0];
const CAB_CUTOFF: [f64; 5] = [6500.0, 7200.0, 5700.0, 5600.0, 7800.0];
const CAB_Q: [f64; 5] = [0.9, 0.75, 1.1, 1.0, 0.8];
const CAB_RESONANT_GAIN: [f64; 5] = [2.4, 1.5, 3.4, 1.8, 1.6];
const CAB_MIDS: [f64; 5] = [620.0, 750.0, 480.0, 800.0, 900.0];
const CAB_MID_GAIN: [f64; 5] = [-1.5, -2.3, -3.4, -0.8, -1.2];
/// Microphones (index = `micType`): 0 dynamic, 1 ribbon, 2 condenser, 3 large dynamic, 4 pencil.
const MIC_CUTOFF: [f64; 5] = [1.0, 0.76, 1.15, 0.92, 1.25];
const MIC_PROXIMITY: [f64; 5] = [2.0, 3.0, 1.0, 2.5, 0.5];
const MIC_PRESENCE_FREQ: [f64; 5] = [3200.0, 2300.0, 4200.0, 2800.0, 5500.0];
const MIC_PRESENCE_GAIN: [f64; 5] = [3.4, -0.6, 2.2, 2.0, 2.8];
const MIC_SHELF_GAIN: [f64; 5] = [0.0, -2.0, 1.0, -1.0, 2.0];

/// `RigCabinet`: the speaker cabinet and microphone as seven minimum-phase IIR sections (no IR,
/// no latency), voiced by cabinet model, microphone type, position (edge) and distance.
#[derive(Clone, Debug)]
pub(crate) struct Cabinet {
    sample_rate: f64,
    cab: [Biquad; 7],
    enabled: bool,
}

impl Cabinet {
    pub fn new(sr: f64, p: &P<'_>) -> Self {
        let mut s = Self { sample_rate: sr, cab: core::array::from_fn(|_| Biquad::new()), enabled: p.on(0) };
        s.configure(p, false);
        s
    }

    fn configure(&mut self, p: &P<'_>, glide: bool) {
        let sr = self.sample_rate;
        let cab = model(p.get(1));
        let mic = model(p.get(2));
        let (edge, far) = (p.get(3), p.get(4));
        let cutoff =
            pick(&CAB_CUTOFF, cab) * pick(&MIC_CUTOFF, mic) * (1.0 - 0.33 * edge) * (1.0 - 0.12 * far);
        let [hp, resonance, mids, presence, shelf, low1, low2] = &mut self.cab;
        set_filter(hp, glide, FilterType::Highpass, sr, pick(&CAB_HIGHPASS, cab), 0.72, 0.0);
        let resonant = pick(&CAB_RESONANT_GAIN, cab) + (1.0 - far) * pick(&MIC_PROXIMITY, mic);
        set_filter(
            resonance,
            glide,
            FilterType::Peak,
            sr,
            pick(&CAB_RESONANCE, cab),
            pick(&CAB_Q, cab),
            resonant,
        );
        set_filter(mids, glide, FilterType::Peak, sr, pick(&CAB_MIDS, cab), 0.8, pick(&CAB_MID_GAIN, cab));
        let presence_gain = pick(&MIC_PRESENCE_GAIN, mic) * (1.0 - edge) - 2.2 * edge;
        set_filter(
            presence,
            glide,
            FilterType::Peak,
            sr,
            pick(&MIC_PRESENCE_FREQ, mic),
            0.8 + edge * 0.4,
            presence_gain,
        );
        let shelf_gain = -1.5 - edge * 5.0 - far * 1.5 + pick(&MIC_SHELF_GAIN, mic);
        set_filter(shelf, glide, FilterType::HighShelf, sr, 2400.0 - 500.0 * edge, 0.707, shelf_gain);
        set_filter(low1, glide, FilterType::Lowpass, sr, cutoff, 0.68, 0.0);
        set_filter(low2, glide, FilterType::Lowpass, sr, cutoff * 1.15, 0.55, 0.0);
    }

    pub fn automate(&mut self, p: &P<'_>) {
        self.enabled = p.on(0);
        self.configure(p, true);
    }

    pub fn reset(&mut self) {
        for f in &mut self.cab {
            f.reset();
        }
    }

    pub fn take_state_from(&mut self, p: &Self) {
        for (f, pf) in self.cab.iter_mut().zip(&p.cab) {
            f.take_history_from(pf);
        }
    }
}

impl Stage for Cabinet {
    fn active(&mut self) -> bool {
        self.enabled
    }

    // C++ runs each section over the whole block; per frame through all seven is the same result
    // (every section's state, glide included, only depends on its own input sequence).
    #[inline(always)]
    fn frame(&mut self, mut l: f32, mut r: f32) -> (f32, f32) {
        for f in &mut self.cab {
            l = bq(f, l, 0);
            r = bq(f, r, 1);
        }
        (l, r)
    }
}

// ---- 5 chorus -----------------------------------------------------------------------------------

/// Delay-line frames of the chorus (`static_cast<std::size_t>(sr * .05) + 4`).
pub(crate) fn chorus_frames(sr: f64) -> usize {
    (sr * 0.05) as usize + 4
}

/// `RigChorus` + dsp.cpp `Chorus`: one LFO, 14 / 17 ms taps moving in opposite directions.
#[derive(Debug)]
pub(crate) struct RigChorus<'a> {
    line: DelayLine<'a>,
    sample_rate: f64,
    step: f64,
    depth: f64,
    mix: f64,
    phase: f64,
    enabled: bool,
}

impl<'a> RigChorus<'a> {
    pub fn storage_len(sr: f64) -> usize {
        DelayLine::len_for(chorus_frames(sr))
    }

    pub fn new(sr: f64, p: &P<'_>, carver: &mut Carver<'a>) -> Self {
        Self {
            line: DelayLine::new(carver, chorus_frames(sr)),
            sample_rate: sr,
            step: TAU * p.get(1) / sr,
            depth: p.get(2),
            mix: p.get(3),
            phase: 0.0,
            enabled: p.on(0),
        }
    }

    pub fn automate(&mut self, p: &P<'_>) {
        self.step = TAU * p.get(1) / self.sample_rate;
        self.depth = p.get(2);
        self.mix = p.get(3);
        self.enabled = p.on(0);
    }

    pub fn reset(&mut self) {
        self.line.reset();
        self.phase = 0.0;
    }

    pub fn same_storage(&self, p: &Self) -> bool {
        self.line.same_size(&p.line)
    }

    pub fn take_state_from(&mut self, p: &mut Self, whole: bool) {
        if whole {
            self.line.swap_with(&mut p.line);
        } else {
            self.line.copy_from(&p.line);
        }
        self.phase = p.phase;
    }

    pub fn tail(&self) -> f64 {
        if self.enabled { 0.04 } else { 0.0 }
    }
}

impl Stage for RigChorus<'_> {
    fn active(&mut self) -> bool {
        self.enabled
    }

    #[inline(always)]
    fn frame(&mut self, l: f32, r: f32) -> (f32, f32) {
        self.line.put(l, r);
        let modulation = math::sin(self.phase) * self.depth * 0.005;
        let (dry, wet) = (1.0 - self.mix * 0.5, self.mix);
        let tap_l = self.line.read((0.014 + modulation) * self.sample_rate, 0);
        let tap_r = self.line.read((0.017 - modulation) * self.sample_rate, 1);
        let out_l = (f64::from(l) * dry + f64::from(tap_l) * wet * 0.5) as f32;
        let out_r = (f64::from(r) * dry + f64::from(tap_r) * wet * 0.5) as f32;
        self.phase += self.step;
        if self.phase >= TAU {
            self.phase -= TAU;
        }
        self.line.advance();
        (out_l, out_r)
    }
}

// ---- 6 delay ------------------------------------------------------------------------------------

/// Delay-line frames of the rig delay (`static_cast<std::size_t>(sr * 4.1)`).
pub(crate) fn delay_frames(sr: f64) -> usize {
    (sr * 4.1) as usize
}

/// `RigDelay` + dsp.cpp `Delay(sr, time, mix, feedback, 4400, bandLimited = true)`: band-limited
/// feedback (4.4 kHz low-pass, 120 Hz high-pass), filtered repeats added to the dry signal.
#[derive(Debug)]
pub(crate) struct RigDelay<'a> {
    line: DelayLine<'a>,
    low: Biquad,
    high: Biquad,
    sample_rate: f64,
    frames: f64,
    wet: f64,
    feedback: f64,
    tail: f64,
    enabled: bool,
}

impl<'a> RigDelay<'a> {
    pub fn storage_len(sr: f64) -> usize {
        DelayLine::len_for(delay_frames(sr))
    }

    pub fn new(sr: f64, p: &P<'_>, carver: &mut Carver<'a>) -> Self {
        let seconds = p.get(1) * 0.001;
        let (wet, feedback) = (p.get(3), p.get(2));
        let repeats = feedback_repeats(feedback);
        let mut s = Self {
            line: DelayLine::new(carver, delay_frames(sr)),
            low: Biquad::new(),
            high: Biquad::new(),
            sample_rate: sr,
            frames: seconds * sr,
            wet,
            feedback,
            tail: if wet > 0.0 { std_min(30.0, seconds * (repeats + 1.0) + 0.85) } else { 0.0 },
            enabled: p.on(0),
        };
        set_filter(&mut s.low, false, FilterType::Lowpass, sr, 4400.0, 0.5, 0.0);
        set_filter(&mut s.high, false, FilterType::Highpass, sr, 120.0, 0.5, 0.0);
        s
    }

    /// `Delay::set`: time, mix and feedback follow automation; the tail keeps its first estimate.
    pub fn automate(&mut self, p: &P<'_>) {
        self.frames = p.get(1) * 0.001 * self.sample_rate;
        self.wet = p.get(3);
        self.feedback = p.get(2);
        self.enabled = p.on(0);
    }

    pub fn reset(&mut self) {
        self.line.reset();
        self.low.reset();
        self.high.reset();
    }

    pub fn same_storage(&self, p: &Self) -> bool {
        self.line.same_size(&p.line)
    }

    pub fn take_state_from(&mut self, p: &mut Self, whole: bool) {
        if whole {
            self.line.swap_with(&mut p.line);
        } else {
            self.line.copy_from(&p.line);
        }
        self.low.take_history_from(&p.low);
        self.high.take_history_from(&p.high);
    }

    pub fn tail(&self) -> f64 {
        if self.enabled { self.tail } else { 0.0 }
    }
}

impl Stage for RigDelay<'_> {
    fn active(&mut self) -> bool {
        self.enabled
    }

    #[inline(always)]
    fn frame(&mut self, l: f32, r: f32) -> (f32, f32) {
        let mut io = [l, r];
        let mut next = [0.0f32; 2];
        for (c, (s, n)) in io.iter_mut().zip(next.iter_mut()).enumerate() {
            let delayed = self.line.read(self.frames, c);
            let filtered = bq(&mut self.high, bq(&mut self.low, delayed, c), c);
            *n = (f64::from(*s) + self.feedback * f64::from(filtered)) as f32;
            *s += (self.wet * f64::from(filtered)) as f32;
        }
        self.line.put(next[0], next[1]);
        self.line.advance();
        (io[0], io[1])
    }
}

// ---- 8 phaser -----------------------------------------------------------------------------------

/// `RigPhaser` + dsp.cpp `Phaser` (src/devices/guitar-rig/modulation.ts): six all-pass stages
/// swept by a quadrature LFO, with feedback; the switch fades over ~12 ms.
#[derive(Clone, Debug)]
pub(crate) struct RigPhaser {
    sample_rate: f64,
    step: f64,
    depth: f64,
    feedback: f64,
    target: f64,
    mix: f64,
    smoothing: f64,
    phase: f64,
    state: [[f64; 6]; 2],
    last: [f64; 2],
}

impl RigPhaser {
    pub fn new(sr: f64, p: &P<'_>) -> Self {
        let target = if p.on(0) { 1.0 } else { 0.0 };
        Self {
            sample_rate: sr,
            step: TAU * p.get(1) / sr,
            depth: p.get(2),
            feedback: p.get(3),
            target,
            mix: target,
            smoothing: 1.0 - math::exp(-1.0 / (0.012 * sr)),
            phase: 0.0,
            state: [[0.0; 6]; 2],
            last: [0.0; 2],
        }
    }

    pub fn automate(&mut self, p: &P<'_>) {
        self.step = TAU * p.get(1) / self.sample_rate;
        self.depth = p.get(2);
        self.feedback = p.get(3);
        self.target = if p.on(0) { 1.0 } else { 0.0 };
    }

    pub fn reset(&mut self) {
        self.state = [[0.0; 6]; 2];
        self.last = [0.0; 2];
        self.phase = 0.0;
    }

    pub fn take_state_from(&mut self, p: &Self) {
        self.state = p.state;
        self.last = p.last;
        self.phase = p.phase;
        self.mix = p.mix;
    }
}

impl Stage for RigPhaser {
    fn active(&mut self) -> bool {
        // `if (target_ == 0 && mix_ < 1e-6) { mix_ = 0; continue; }` holds for the whole block.
        if self.target == 0.0 && self.mix < 1e-6 {
            self.mix = 0.0;
            return false;
        }
        true
    }

    #[inline(always)]
    fn frame(&mut self, l: f32, r: f32) -> (f32, f32) {
        if self.target == 0.0 && self.mix < 1e-6 {
            self.mix = 0.0;
            return (l, r);
        }
        self.mix = math::mul_add(self.target - self.mix, self.smoothing, self.mix);
        let mut io = [l, r];
        let limit = self.sample_rate * 0.45;
        for (c, ((s, state), last)) in
            io.iter_mut().zip(self.state.iter_mut()).zip(self.last.iter_mut()).enumerate()
        {
            let x = f64::from(*s);
            let lfo = 0.5 + 0.5 * math::sin(self.phase + if c == 1 { PI / 2.0 } else { 0.0 });
            let frequency = 200.0 * math::pow(16.0, 0.5 + (lfo - 0.5) * self.depth);
            let t = math::tan(PI * std_min(frequency, limit) / self.sample_rate);
            let a = (t - 1.0) / (t + 1.0);
            let mut y = x + self.feedback * *last;
            for z in state.iter_mut() {
                let output = a * y + *z;
                *z = y - a * output;
                if z.abs() < 1e-30 {
                    *z = 0.0;
                }
                y = output;
            }
            *last = y;
            *s = (x * (1.0 - self.mix) + self.mix * 0.5 * (x + y)) as f32;
        }
        self.phase += self.step;
        if self.phase >= TAU {
            self.phase -= TAU;
        }
        (io[0], io[1])
    }
}

// ---- 9 tremolo ----------------------------------------------------------------------------------

/// `RigTremolo` + dsp.cpp `Tremolo`: sine to near-square (tanh-shaped) amplitude modulation.
#[derive(Clone, Debug)]
pub(crate) struct RigTremolo {
    step: f64,
    sample_rate: f64,
    depth: f64,
    k: f64,
    target: f64,
    enabled: f64,
    smoothing: f64,
    phase: f64,
}

impl RigTremolo {
    pub fn new(sr: f64, p: &P<'_>) -> Self {
        let target = if p.on(0) { 1.0 } else { 0.0 };
        Self {
            step: TAU * p.get(1) / sr,
            sample_rate: sr,
            depth: p.get(2),
            k: 0.01 + p.get(3) * 9.0,
            target,
            enabled: target,
            smoothing: 1.0 - math::exp(-1.0 / (0.012 * sr)),
            phase: 0.0,
        }
    }

    pub fn automate(&mut self, p: &P<'_>) {
        self.step = TAU * p.get(1) / self.sample_rate;
        self.depth = p.get(2);
        self.k = 0.01 + p.get(3) * 9.0;
        self.target = if p.on(0) { 1.0 } else { 0.0 };
    }

    pub fn reset(&mut self) {
        self.phase = 0.0;
    }

    pub fn take_state_from(&mut self, p: &Self) {
        self.phase = p.phase;
        self.enabled = p.enabled;
    }
}

impl Stage for RigTremolo {
    fn active(&mut self) -> bool {
        if self.target == 0.0 && self.enabled < 1e-6 {
            self.enabled = 0.0;
            return false;
        }
        true
    }

    #[inline(always)]
    fn frame(&mut self, l: f32, r: f32) -> (f32, f32) {
        if self.target == 0.0 && self.enabled < 1e-6 {
            self.enabled = 0.0;
            return (l, r);
        }
        self.enabled = math::mul_add(self.target - self.enabled, self.smoothing, self.enabled);
        let wave = math::tanh(self.k * math::sin(self.phase)) / math::tanh(self.k);
        self.phase += self.step;
        if self.phase >= TAU {
            self.phase -= TAU;
        }
        let gain = (1.0 - self.enabled * self.depth * 0.5 * (1.0 - wave)) as f32;
        (l * gain, r * gain)
    }
}

// ---- 10 reverb ----------------------------------------------------------------------------------

/// `RigReverb` (src/devices/guitar-rig/reverb.ts): the hall impulse blended by Decay (short 1.7 s
/// / long 4.2 s), 180 Hz high-pass and a tone low-pass on the wet path, added to the dry signal.
/// The convolvers exist only when the reverb was switched on at construction (C++ builds them
/// only then, so other rig edits stay cheap); Decay and the switch are structural.
#[derive(Debug)]
pub(crate) struct RigReverb<'a> {
    convolver: Option<StereoConvolver<'a>>,
    sample_rate: f64,
    highpass: Biquad,
    tone: Biquad,
    wet: f64,
    tail: f64,
}

impl<'a> RigReverb<'a> {
    /// `kernels` (for this instance's Decay, `prepare_kernels` of the hall IR) when switched on.
    pub fn new(sr: f64, p: &P<'_>, kernels: Option<(&'a [f32], usize)>, carver: &mut Carver<'a>) -> Self {
        let mut s = Self {
            convolver: None,
            sample_rate: sr,
            highpass: Biquad::new(),
            tone: Biquad::new(),
            wet: 0.0,
            tail: 0.0,
        };
        if let (true, Some((kernels, ir_len))) = (p.on(0), kernels) {
            let decay = p.get(1) as f32;
            s.convolver = Some(StereoConvolver::new(ir_len, kernels, carver));
            s.wet = p.get(3);
            s.tail = (if f64::from(decay) > 0.001 { 4.2 } else { 1.7 }) + 0.25;
        }
        set_filter(&mut s.highpass, false, FilterType::Highpass, sr, 180.0, 0.5, 0.0);
        set_filter(&mut s.tone, false, FilterType::Lowpass, sr, 1500.0 * math::pow(8.0, p.get(2)), 0.5, 0.0);
        s
    }

    pub fn automate(&mut self, p: &P<'_>) {
        if self.convolver.is_some() {
            self.wet = if p.on(0) { p.get(3) } else { 0.0 };
        }
        let hz = 1500.0 * math::pow(8.0, p.get(2));
        set_filter(&mut self.tone, true, FilterType::Lowpass, self.sample_rate, hz, 0.5, 0.0);
    }

    pub fn reset(&mut self) {
        if let Some(c) = &mut self.convolver {
            c.reset();
        }
        self.highpass.reset();
        self.tone.reset();
    }

    pub fn has_storage(&self) -> bool {
        self.convolver.is_some()
    }

    pub fn same_storage(&self, p: &Self) -> bool {
        match (&self.convolver, &p.convolver) {
            (Some(a), Some(b)) => a.same_layout(b),
            (None, None) => true,
            _ => false,
        }
    }

    pub fn take_state_from(&mut self, p: &mut Self, whole: bool) {
        if let (Some(c), Some(pc)) = (&mut self.convolver, &mut p.convolver) {
            c.take_state_from(pc, whole);
        }
        self.highpass.take_history_from(&p.highpass);
        self.tone.take_history_from(&p.tone);
    }

    pub fn tail(&self) -> f64 {
        if self.convolver.is_some() && self.wet > 0.0 { self.tail } else { 0.0 }
    }
}

impl Stage for RigReverb<'_> {
    fn active(&mut self) -> bool {
        self.convolver.is_some()
    }

    #[inline(always)]
    fn frame(&mut self, l: f32, r: f32) -> (f32, f32) {
        let Some(conv) = &mut self.convolver else { return (l, r) };
        let mut io = [l, r];
        for (c, s) in io.iter_mut().enumerate() {
            let wet = bq(&mut self.tone, bq(&mut self.highpass, convolve(conv, *s, c), c), c);
            *s += (self.wet * f64::from(wet)) as f32;
        }
        (io[0], io[1])
    }
}

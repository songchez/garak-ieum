//! Saturation and lo-fi: tape and bitcrusher (sigimsae_effects.inc `TapeFx`, `BitcrusherFx` =
//! kernels.ts) and the oversampled drive (native/src/dsp.cpp `Saturator`, `Drive`).

use super::{Kernel, SettledFrame, process_interleaved_settled, process_planar_settled};
use crate::biquad::{Biquad, FilterType};
use crate::gain::db_to_gain;
use crate::lines::{Carver, DelayLine};
use crate::math;
use crate::params::{BITCRUSHER, DRIVE, ParamSet, TAPE, index_of};
use crate::smooth::{Smooth, smoothing_coefficient};
use crate::{PI, std_clamp};

const T_DRIVE: usize = index_of(TAPE, "drive");
const T_WARMTH: usize = index_of(TAPE, "warmth");
const T_MIX: usize = index_of(TAPE, "mix");
const T_OUTPUT: usize = index_of(TAPE, "output");
const TAPE_BIAS: f64 = 0.15;

/// Asymmetric tanh saturation, head bump and a warmth-controlled high roll-off.
#[derive(Clone, Debug)]
pub struct Tape {
    sample_rate: f64,
    k: f64,
    origin: f64,
    pre: Smooth,
    post: Smooth,
    mix: Smooth,
    out: Smooth,
    lowpass: Biquad,
    bump: Biquad,
    dc: Biquad,
}

impl Tape {
    pub fn new(sample_rate: f64, p: &ParamSet) -> Self {
        let pre = db_to_gain(p.get(T_DRIVE));
        let warmth = p.get(T_WARMTH);
        let mut s = Self {
            sample_rate,
            k: smoothing_coefficient(sample_rate),
            origin: math::tanh(TAPE_BIAS),
            pre: Smooth::default(),
            post: Smooth::default(),
            mix: Smooth::default(),
            out: Smooth::default(),
            lowpass: Biquad::new(),
            bump: Biquad::new(),
            dc: Biquad::new(),
        };
        s.pre.set(pre);
        s.post.set(math::pow(pre, -0.8));
        s.mix.set(p.get(T_MIX));
        s.out.set(db_to_gain(p.get(T_OUTPUT)));
        s.lowpass.configure(FilterType::Lowpass, sample_rate, 20000.0 * math::pow(0.25, warmth), 0.5, 0.0);
        s.bump.configure(FilterType::LowShelf, sample_rate, 110.0, 0.707, 3.0 * warmth);
        s.dc.configure(FilterType::Highpass, sample_rate, 20.0, 0.5, 0.0);
        s
    }

    pub fn take_state_from(&mut self, p: &mut Self) -> bool {
        self.lowpass.take_history_from(&p.lowpass);
        self.bump.take_history_from(&p.bump);
        self.dc.take_history_from(&p.dc);
        self.pre.follow(&p.pre);
        self.post.follow(&p.post);
        self.mix.follow(&p.mix);
        self.out.follow(&p.out);
        false
    }
}

impl Kernel for Tape {
    fn automate(&mut self, p: &ParamSet) {
        let pre = db_to_gain(p.get(T_DRIVE));
        let warmth = p.get(T_WARMTH);
        self.pre.target = pre;
        self.post.target = math::pow(pre, -0.8);
        self.mix.target = p.get(T_MIX);
        self.out.target = db_to_gain(p.get(T_OUTPUT));
        let sr = self.sample_rate;
        self.lowpass.retarget(FilterType::Lowpass, sr, 20000.0 * math::pow(0.25, warmth), 0.5, 0.0);
        self.bump.retarget(FilterType::LowShelf, sr, 110.0, 0.707, 3.0 * warmth);
    }

    #[inline(always)]
    fn frame(&mut self, l: f32, r: f32) -> (f32, f32) {
        let pre = self.pre.next(self.k);
        let post = self.post.next(self.k);
        let mix = self.mix.next(self.k);
        let out = self.out.next(self.k);
        let mut io = [l, r];
        for (c, s) in io.iter_mut().enumerate() {
            let x = f64::from(*s);
            let shaped = ((math::tanh(x * pre + TAPE_BIAS) - self.origin) * post) as f32;
            let y = f64::from(self.dc.sample(self.bump.sample(self.lowpass.sample(shaped, c), c), c));
            *s = ((x * (1.0 - mix) + y * mix) * out) as f32;
        }
        (io[0], io[1])
    }

    fn reset(&mut self) {
        self.lowpass.reset();
        self.bump.reset();
        self.dc.reset();
    }
}

const B_BITS: usize = index_of(BITCRUSHER, "bits");
const B_DOWNSAMPLE: usize = index_of(BITCRUSHER, "downsample");
const B_MIX: usize = index_of(BITCRUSHER, "mix");

/// Sample-and-hold downsampling followed by mid-tread quantisation to `bits`.
///
/// The quantised hold `q = floor(hold * levels + 0.5) / levels` only changes when a new sample is
/// held or `bits` changes, so it is computed then instead of every frame (the C++ recomputes it
/// per frame; same operations on the same values, so the same result, without two divisions and
/// two floors per frame).
#[derive(Clone, Debug)]
pub struct Bitcrusher {
    k: f64,
    levels: f64,
    factor: f64,
    countdown: f64,
    hold_l: f64,
    hold_r: f64,
    q_l: f64,
    q_r: f64,
    mix: Smooth,
}

impl Bitcrusher {
    pub fn new(sample_rate: f64, p: &ParamSet) -> Self {
        let mut mix = Smooth::default();
        mix.set(p.get(B_MIX));
        let mut s = Self {
            k: smoothing_coefficient(sample_rate),
            levels: math::pow(2.0, p.get(B_BITS) - 1.0),
            factor: p.get(B_DOWNSAMPLE),
            countdown: 0.0,
            hold_l: 0.0,
            hold_r: 0.0,
            q_l: 0.0,
            q_r: 0.0,
            mix,
        };
        s.quantise();
        s
    }

    #[inline(always)]
    fn quantise(&mut self) {
        let levels = self.levels;
        self.q_l = math::floor(self.hold_l * levels + 0.5) / levels;
        self.q_r = math::floor(self.hold_r * levels + 0.5) / levels;
    }

    pub fn take_state_from(&mut self, p: &mut Self) -> bool {
        self.countdown = p.countdown;
        self.hold_l = p.hold_l;
        self.hold_r = p.hold_r;
        self.quantise();
        self.mix.follow(&p.mix);
        false
    }
}

impl Kernel for Bitcrusher {
    fn automate(&mut self, p: &ParamSet) {
        self.levels = math::pow(2.0, p.get(B_BITS) - 1.0);
        self.factor = p.get(B_DOWNSAMPLE);
        self.mix.target = p.get(B_MIX);
        self.quantise();
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
        self.countdown = 0.0;
        self.hold_l = 0.0;
        self.hold_r = 0.0;
        self.quantise();
    }
}

impl SettledFrame for Bitcrusher {
    fn settled(&self) -> bool {
        self.mix.settled()
    }

    #[inline(always)]
    fn frame_if<const SETTLED: bool>(&mut self, l: f32, r: f32) -> (f32, f32) {
        let mix = self.mix.next_if::<SETTLED>(self.k);
        if self.countdown <= 0.0 {
            self.hold_l = f64::from(l);
            self.hold_r = f64::from(r);
            self.countdown += self.factor;
            self.quantise();
        }
        self.countdown -= 1.0;
        let (ql, qr) = (self.q_l, self.q_r);
        ((f64::from(l) * (1.0 - mix) + ql * mix) as f32, (f64::from(r) * (1.0 - mix) + qr * mix) as f32)
    }
}

/// 17-tap half-band interpolator and decimator around a tanh shaper (2x oversampling). Together
/// they delay the signal by eight base-rate frames, which the drive reports as latency.
#[derive(Clone, Debug)]
pub struct Saturator {
    amount: f64,
    bias: f64,
    origin: f64,
    normal: f64,
    coefficients: [f64; 17],
    up: [[f64; 17]; 2],
    down: [[f64; 17]; 2],
    up_write: [usize; 2],
    down_write: [usize; 2],
}

fn fir(coefficients: &[f64; 17], x: f64, state: &mut [f64; 17], write: &mut usize) -> f64 {
    let w = *write % 17;
    if let Some(slot) = state.get_mut(w) {
        *slot = x;
    }
    // state[(write + 17 - i) % 17] for i = 0..17: newest first, walking backwards and wrapping.
    let (upto, after) = state.split_at(w + 1);
    let mut output = 0.0;
    for (c, s) in coefficients.iter().zip(upto.iter().rev().chain(after.iter().rev())) {
        output += c * s;
    }
    *write = (w + 1) % 17;
    output
}

impl Saturator {
    pub fn new(amount: f64, bias: f64) -> Self {
        let origin = math::tanh(bias);
        let normal = (math::tanh(amount + bias) - origin).max(origin - math::tanh(-amount + bias));
        let mut coefficients = [0.0; 17];
        let mut sum = 0.0;
        for (i, c) in coefficients.iter_mut().enumerate() {
            let x = i as f64 - 8.0;
            let sinc = if x == 0.0 { 0.5 } else { math::sin(PI * 0.5 * x) / (PI * x) };
            *c = sinc * (0.5 - 0.5 * math::cos(2.0 * PI * i as f64 / 16.0));
            sum += *c;
        }
        for c in &mut coefficients {
            *c /= sum;
        }
        Self {
            amount,
            bias,
            origin,
            normal,
            coefficients,
            up: [[0.0; 17]; 2],
            down: [[0.0; 17]; 2],
            up_write: [0; 2],
            down_write: [0; 2],
        }
    }

    #[inline(always)]
    pub fn sample(&mut self, input: f32, channel: usize) -> f32 {
        let c = channel.min(1);
        let (Some(up), Some(down), Some(uw), Some(dw)) =
            (self.up.get_mut(c), self.down.get_mut(c), self.up_write.get_mut(c), self.down_write.get_mut(c))
        else {
            return 0.0;
        };
        let up_a = fir(&self.coefficients, 2.0 * f64::from(input), up, uw);
        let a =
            fir(&self.coefficients, shape(self.amount, self.bias, self.origin, self.normal, up_a), down, dw);
        let up_b = fir(&self.coefficients, 0.0, up, uw);
        let _ =
            fir(&self.coefficients, shape(self.amount, self.bias, self.origin, self.normal, up_b), down, dw);
        a as f32
    }

    pub fn reset(&mut self) {
        self.up = [[0.0; 17]; 2];
        self.down = [[0.0; 17]; 2];
        self.up_write = [0; 2];
        self.down_write = [0; 2];
    }

    pub fn take_state_from(&mut self, previous: &Saturator) {
        self.up = previous.up;
        self.down = previous.down;
        self.up_write = previous.up_write;
        self.down_write = previous.down_write;
    }

    /// The shaping curve (for tests and plots).
    pub fn curve(&self, x: f64) -> f64 {
        shape(self.amount, self.bias, self.origin, self.normal, x)
    }
}

#[inline]
fn shape(amount: f64, bias: f64, origin: f64, normal: f64, x: f64) -> f64 {
    (math::tanh(amount * std_clamp(x, -1.0, 1.0) + bias) - origin) / normal
}

const D_DRIVE: usize = index_of(DRIVE, "drive");
const D_TONE: usize = index_of(DRIVE, "tone");
const D_MIX: usize = index_of(DRIVE, "mix");
const D_OUTPUT: usize = index_of(DRIVE, "output");
const DRIVE_LATENCY: usize = 8;

/// Oversampled drive with a tone low-pass; the dry path is delayed to stay aligned with the wet.
#[derive(Debug)]
pub struct Drive<'a> {
    sample_rate: f64,
    shaper: Saturator,
    tone: Biquad,
    dry: DelayLine<'a>,
    pre: f64,
    wet: f64,
    output: f64,
    post: f64,
}

impl<'a> Drive<'a> {
    pub const fn storage_len() -> usize {
        DelayLine::len_for(DRIVE_LATENCY)
    }

    pub fn new(sample_rate: f64, p: &ParamSet, carver: &mut Carver<'a>) -> Self {
        let mut s = Self {
            sample_rate,
            shaper: Saturator::new(2.5, 0.0),
            tone: Biquad::new(),
            dry: DelayLine::new(carver, DRIVE_LATENCY),
            pre: 1.0,
            wet: 1.0,
            output: 1.0,
            post: 1.0,
        };
        s.configure(p, false);
        s
    }

    fn configure(&mut self, p: &ParamSet, glide: bool) {
        self.pre = db_to_gain(p.get(D_DRIVE));
        self.wet = p.get(D_MIX);
        self.output = db_to_gain(p.get(D_OUTPUT));
        if glide {
            self.tone.retarget(FilterType::Lowpass, self.sample_rate, p.get(D_TONE), 1.0, 0.0);
        } else {
            self.tone.configure(FilterType::Lowpass, self.sample_rate, p.get(D_TONE), 1.0, 0.0);
        }
        self.post = self.output / math::sqrt(self.pre * 2.53);
    }

    pub fn take_state_from(&mut self, p: &mut Self) -> bool {
        self.shaper.take_state_from(&p.shaper);
        self.tone.take_history_from(&p.tone);
        self.dry.swap_with(&mut p.dry)
    }
}

impl Kernel for Drive<'_> {
    fn automate(&mut self, p: &ParamSet) {
        self.configure(p, true);
    }

    #[inline(always)]
    fn frame(&mut self, l: f32, r: f32) -> (f32, f32) {
        self.dry.put(l, r);
        let mut io = [l, r];
        for (c, s) in io.iter_mut().enumerate() {
            let wet = self.tone.sample(self.shaper.sample((f64::from(*s) * self.pre) as f32, c), c);
            *s = (f64::from(self.dry.read(DRIVE_LATENCY as f64, c)) * (1.0 - self.wet) * self.output
                + f64::from(wet) * self.wet * self.post) as f32;
        }
        self.dry.advance();
        (io[0], io[1])
    }

    fn reset(&mut self) {
        self.shaper.reset();
        self.tone.reset();
        self.dry.reset();
    }

    fn latency_frames(&self) -> u32 {
        DRIVE_LATENCY as u32
    }
}

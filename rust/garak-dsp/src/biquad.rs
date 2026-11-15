//! RBJ biquad matching `garak::dsp::Biquad` (native/src/dsp.cpp `Biquad::configure/sample`) and
//! the W3C `BiquadFilterNode` formulas (src/devices/effects/eqModel.ts `sectionCoefficients`).
//!
//! Units follow Web Audio: low/high-pass Q is in dB (and may be negative), band-pass, notch and
//! peaking Q is linear, shelf slope is fixed at one. Coefficients glide over ~12 ms after a
//! retarget so knob moves do not click; the glide advances once per frame (on channel 0).

use crate::{PI, clamp, gain::db_to_gain, smooth::smoothing_coefficient};

#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilterType {
    Lowpass = 0,
    Highpass = 1,
    Bandpass = 2,
    Peak = 3,
    LowShelf = 4,
    HighShelf = 5,
    Notch = 6,
}

impl FilterType {
    /// Same order as `garak::dsp::Filter`. Unknown values fall back to low-pass (never panics).
    pub fn from_u32(v: u32) -> Self {
        match v {
            1 => Self::Highpass,
            2 => Self::Bandpass,
            3 => Self::Peak,
            4 => Self::LowShelf,
            5 => Self::HighShelf,
            6 => Self::Notch,
            _ => Self::Lowpass,
        }
    }
}

/// Normalised (a0 = 1) coefficients.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Coefficients {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
}

impl Coefficients {
    pub const IDENTITY: Self = Self { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0 };

    pub fn design(kind: FilterType, sample_rate: f64, frequency: f64, q: f64, gain_db: f64) -> Self {
        let pass_q = matches!(kind, FilterType::Lowpass | FilterType::Highpass);
        let hz = clamp(frequency, 1.0, sample_rate * 0.45);
        let q = if pass_q { clamp(q, -60.0, 60.0) } else { clamp(q, 0.0001, 40.0) };
        let omega = 2.0 * PI * hz / sample_rate;
        let cosine = libm::cos(omega);
        let sine = libm::sin(omega);
        let quality = if pass_q { db_to_gain(q) } else { q };
        let a = libm::pow(10.0, gain_db / 40.0);
        let alpha = sine / (2.0 * quality);
        let (b0, b1, b2, a0, a1, a2) = match kind {
            FilterType::Lowpass => {
                let b0 = (1.0 - cosine) / 2.0;
                (b0, 1.0 - cosine, b0, 1.0 + alpha, -2.0 * cosine, 1.0 - alpha)
            }
            FilterType::Highpass => {
                let b0 = (1.0 + cosine) / 2.0;
                (b0, -(1.0 + cosine), b0, 1.0 + alpha, -2.0 * cosine, 1.0 - alpha)
            }
            FilterType::Bandpass => (alpha, 0.0, -alpha, 1.0 + alpha, -2.0 * cosine, 1.0 - alpha),
            FilterType::Notch => (1.0, -2.0 * cosine, 1.0, 1.0 + alpha, -2.0 * cosine, 1.0 - alpha),
            FilterType::Peak => (
                1.0 + alpha * a,
                -2.0 * cosine,
                1.0 - alpha * a,
                1.0 + alpha / a,
                -2.0 * cosine,
                1.0 - alpha / a,
            ),
            FilterType::LowShelf => {
                let beta = libm::sqrt(2.0 * a) * sine;
                (
                    a * ((a + 1.0) - (a - 1.0) * cosine + beta),
                    2.0 * a * ((a - 1.0) - (a + 1.0) * cosine),
                    a * ((a + 1.0) - (a - 1.0) * cosine - beta),
                    (a + 1.0) + (a - 1.0) * cosine + beta,
                    -2.0 * ((a - 1.0) + (a + 1.0) * cosine),
                    (a + 1.0) + (a - 1.0) * cosine - beta,
                )
            }
            FilterType::HighShelf => {
                let beta = libm::sqrt(2.0 * a) * sine;
                (
                    a * ((a + 1.0) + (a - 1.0) * cosine + beta),
                    -2.0 * a * ((a - 1.0) + (a + 1.0) * cosine),
                    a * ((a + 1.0) + (a - 1.0) * cosine - beta),
                    (a + 1.0) - (a - 1.0) * cosine + beta,
                    2.0 * ((a - 1.0) - (a + 1.0) * cosine),
                    (a + 1.0) - (a - 1.0) * cosine - beta,
                )
            }
        };
        Self { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
    }

    /// |H(e^jw)| in dB at `frequency` (same as eqModel.ts `sectionsResponseDb` for one section).
    pub fn response_db(&self, sample_rate: f64, frequency: f64) -> f64 {
        let w = 2.0 * PI * frequency / sample_rate;
        let (c1, s1, c2, s2) = (libm::cos(w), libm::sin(w), libm::cos(2.0 * w), libm::sin(2.0 * w));
        let nr = self.b0 + self.b1 * c1 + self.b2 * c2;
        let ni = -(self.b1 * s1 + self.b2 * s2);
        let dr = 1.0 + self.a1 * c1 + self.a2 * c2;
        let di = -(self.a1 * s1 + self.a2 * s2);
        10.0 * libm::log10((nr * nr + ni * ni) / (dr * dr + di * di))
    }
}

/// Stereo transposed direct-form II biquad with coefficient glide. Plain data: `Copy`-free but
/// trivially movable, no heap, safe to place in caller-owned (C++ / wasm) storage.
#[derive(Clone, Debug)]
pub struct Biquad {
    current: Coefficients,
    target: Coefficients,
    smoothing: f64,
    z1: [f64; 2],
    z2: [f64; 2],
}

impl Default for Biquad {
    fn default() -> Self {
        Self {
            current: Coefficients::IDENTITY,
            target: Coefficients::IDENTITY,
            smoothing: 1.0,
            z1: [0.0; 2],
            z2: [0.0; 2],
        }
    }
}

impl Biquad {
    pub fn new() -> Self {
        Self::default()
    }

    /// `Biquad::configure`: design and jump to the new response (history is kept).
    pub fn configure(&mut self, kind: FilterType, sample_rate: f64, frequency: f64, q: f64, gain_db: f64) {
        let c = Coefficients::design(kind, sample_rate, frequency, q, gain_db);
        self.current = c;
        self.target = c;
        self.smoothing = smoothing_coefficient(sample_rate);
    }

    /// Glide to a new response from the current one. Equals C++ `configure()` on a fresh filter
    /// followed by `takeHistoryFrom(old)`, and the TS kernel's `configure(..., immediate=false)`.
    pub fn retarget(&mut self, kind: FilterType, sample_rate: f64, frequency: f64, q: f64, gain_db: f64) {
        self.target = Coefficients::design(kind, sample_rate, frequency, q, gain_db);
        self.smoothing = smoothing_coefficient(sample_rate);
    }

    /// `Biquad::takeHistoryFrom`: adopt another filter's state and current coefficients.
    pub fn take_history_from(&mut self, previous: &Biquad) {
        self.z1 = previous.z1;
        self.z2 = previous.z2;
        self.current = previous.current;
    }

    pub fn reset(&mut self) {
        self.z1 = [0.0; 2];
        self.z2 = [0.0; 2];
    }

    pub fn coefficients(&self) -> Coefficients {
        self.current
    }

    /// One sample on `channel` (0 = left; anything else = right). Channel 0 advances the glide,
    /// so call channel 0 first in each frame, as the C++ and TS kernels do.
    #[inline]
    pub fn sample(&mut self, x: f32, channel: usize) -> f32 {
        if channel == 0 {
            let (c, t, s) = (&mut self.current, &self.target, self.smoothing);
            c.b0 += (t.b0 - c.b0) * s;
            c.b1 += (t.b1 - c.b1) * s;
            c.b2 += (t.b2 - c.b2) * s;
            c.a1 += (t.a1 - c.a1) * s;
            c.a2 += (t.a2 - c.a2) * s;
        }
        let [l1, r1] = &mut self.z1;
        let [l2, r2] = &mut self.z2;
        let (z1, z2) = if channel == 0 { (l1, l2) } else { (r1, r2) };
        let c = &self.current;
        let x = f64::from(x);
        let y = c.b0 * x + *z1;
        *z1 = c.b1 * x - c.a1 * y + *z2;
        *z2 = c.b2 * x - c.a2 * y;
        if z1.abs() < 1e-30 {
            *z1 = 0.0;
        }
        if z2.abs() < 1e-30 {
            *z2 = 0.0;
        }
        y as f32
    }

    /// Interleaved stereo in place (`native` buffer layout). A trailing odd sample is ignored.
    pub fn process_interleaved(&mut self, stereo: &mut [f32]) {
        for [l, r] in stereo.as_chunks_mut::<2>().0 {
            *l = self.sample(*l, 0);
            *r = self.sample(*r, 1);
        }
    }

    /// Planar stereo in place (Web Audio layout); processes `min(left.len(), right.len())` frames.
    pub fn process_planar(&mut self, left: &mut [f32], right: &mut [f32]) {
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            *l = self.sample(*l, 0);
            *r = self.sample(*r, 1);
        }
    }

    /// Mono in place on channel 0.
    pub fn process_mono(&mut self, samples: &mut [f32]) {
        for x in samples {
            *x = self.sample(*x, 0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 48_000.0;

    #[test]
    fn lowpass_is_unity_at_dc_and_minus_3db_at_cutoff_with_zero_db_q() {
        // Q = 0 dB -> linear Q 1 is not Butterworth; Q = -3.0103 dB -> 1/sqrt(2) gives -3 dB.
        let c = Coefficients::design(FilterType::Lowpass, SR, 1000.0, -3.010_299_956_639_812, 0.0);
        assert!(c.response_db(SR, 1.0).abs() < 1e-6);
        assert!((c.response_db(SR, 1000.0) + 3.0103).abs() < 1e-3);
        assert!(c.response_db(SR, 10_000.0) < -35.0);
    }

    #[test]
    fn peak_and_shelves_hit_their_gain() {
        let peak = Coefficients::design(FilterType::Peak, SR, 2000.0, 1.0, 6.0);
        assert!((peak.response_db(SR, 2000.0) - 6.0).abs() < 1e-9);
        let low = Coefficients::design(FilterType::LowShelf, SR, 200.0, 1.0, -9.0);
        assert!((low.response_db(SR, 5.0) + 9.0).abs() < 0.05);
        let high = Coefficients::design(FilterType::HighShelf, SR, 5000.0, 1.0, 4.0);
        assert!((high.response_db(SR, 20_000.0) - 4.0).abs() < 0.2);
        let notch = Coefficients::design(FilterType::Notch, SR, 1000.0, 4.0, 0.0);
        assert!(notch.response_db(SR, 1000.0) < -100.0);
    }

    #[test]
    fn processing_matches_the_designed_response() {
        let mut f = Biquad::new();
        f.configure(FilterType::Highpass, SR, 500.0, 0.0, 0.0);
        let mut peak = 0.0f32;
        for i in 0..48_000 {
            let x = libm::sin(2.0 * PI * 50.0 * f64::from(i) / SR) as f32;
            let y = f.sample(x, 0);
            if i > 24_000 {
                peak = peak.max(y.abs());
            }
        }
        let expected = libm::pow(
            10.0,
            Coefficients::design(FilterType::Highpass, SR, 500.0, 0.0, 0.0).response_db(SR, 50.0) / 20.0,
        );
        assert!((f64::from(peak) - expected).abs() < 1e-3, "{peak} vs {expected}");
    }

    #[test]
    fn retarget_glides_and_settles() {
        let mut f = Biquad::new();
        f.configure(FilterType::Lowpass, SR, 200.0, 0.0, 0.0);
        f.retarget(FilterType::Lowpass, SR, 8000.0, 0.0, 0.0);
        let target = Coefficients::design(FilterType::Lowpass, SR, 8000.0, 0.0, 0.0);
        f.sample(0.0, 0);
        assert!((f.coefficients().b0 - target.b0).abs() > 1e-4);
        for _ in 0..SR as usize {
            f.sample(0.0, 0);
        }
        assert!((f.coefficients().b0 - target.b0).abs() < 1e-12);
    }

    #[test]
    fn hostile_parameters_stay_finite() {
        for kind in 0..8 {
            let c = Coefficients::design(FilterType::from_u32(kind), SR, f64::NAN, f64::INFINITY, 0.0);
            assert!(c.b0.is_finite() && c.a1.is_finite() && c.a2.is_finite());
        }
    }
}

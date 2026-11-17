//! Deterministic scalar math for the built-in instruments.
//!
//! The effect kernels take their transcendentals from the platform C library natively and from the
//! `libm` crate on wasm32 (see [`crate::math`]), so the native and web builds may differ in the
//! last bits. The instruments are new code with no C++ / TS twin to match, so they use only the
//! functions below: polynomials over `+ - * /` and exact bit tricks. IEEE-754 makes those
//! identical on every target Rust supports here (x86-64 SSE2, aarch64, wasm32; Rust never fuses or
//! reassociates floating-point operations on its own), so the C++ host (garak-ffi) and the browser
//! worklet (garak-wasm) render the very same samples.

/// `floor` for |x| < 2^62 (larger values are integral already and pass through).
#[inline(always)]
pub fn floor(x: f64) -> f64 {
    if x.is_nan() || x.abs() >= 4.0e18 {
        return x;
    }
    let t = x as i64 as f64;
    if t > x { t - 1.0 } else { t }
}

/// Fractional part in [0, 1).
#[inline(always)]
pub fn fract(x: f64) -> f64 {
    let f = x - floor(x);
    if f >= 1.0 { 0.0 } else { f }
}

const TAU: f64 = core::f64::consts::TAU;

/// Clamp without `f64::clamp`'s `min <= max` assertion (whose panic message would link the float
/// formatter into the worklet module). NaN passes through.
#[inline(always)]
pub fn clampf(x: f64, lo: f64, hi: f64) -> f64 {
    if x < lo {
        lo
    } else if x > hi {
        hi
    } else {
        x
    }
}

/// Square root: correctly rounded in every implementation (IEEE-754 requires it), so exact here.
#[inline(always)]
pub fn sqrt(x: f64) -> f64 {
    crate::math::sqrt(x)
}

/// `sin(2π·p)` for a phase in cycles. Odd Taylor series to x^11 on a quarter wave: |error| < 1e-7.
#[inline]
pub fn sin_cycles(p: f64) -> f64 {
    let mut r = p - floor(p + 0.5); // [-0.5, 0.5)
    if r > 0.25 {
        r = 0.5 - r;
    } else if r < -0.25 {
        r = -0.5 - r;
    }
    let x = r * TAU;
    let x2 = x * x;
    x * (1.0
        + x2 * (-1.0 / 6.0
            + x2 * (1.0 / 120.0
                + x2 * (-1.0 / 5040.0 + x2 * (1.0 / 362_880.0 + x2 * (-1.0 / 39_916_800.0))))))
}

/// `cos(2π·p)`.
#[inline]
pub fn cos_cycles(p: f64) -> f64 {
    sin_cycles(p + 0.25)
}

/// `2^x`, clamped to the normal f64 range. Relative error < 1e-11.
#[inline(never)]
pub fn exp2(x: f64) -> f64 {
    let x = if x.is_nan() { 0.0 } else { clampf(x, -1000.0, 1000.0) };
    let i = floor(x);
    // 2^(f - 0.5) for f in [0, 1): e^y with |y| <= ln2 / 2, Taylor to y^10.
    let y = (x - i - 0.5) * core::f64::consts::LN_2;
    let e = 1.0
        + y * (1.0
            + y * (1.0 / 2.0
                + y * (1.0 / 6.0
                    + y * (1.0 / 24.0
                        + y * (1.0 / 120.0
                            + y * (1.0 / 720.0
                                + y * (1.0 / 5040.0
                                    + y * (1.0 / 40_320.0
                                        + y * (1.0 / 362_880.0 + y * (1.0 / 3_628_800.0))))))))));
    let n = (i as i64).clamp(-1022, 1023);
    let scale = f64::from_bits(((n + 1023) as u64) << 52);
    e * core::f64::consts::SQRT_2 * scale
}

/// `e^x`.
#[inline(never)]
pub fn exp(x: f64) -> f64 {
    exp2(x * core::f64::consts::LOG2_E)
}

/// `tanh`: Lambert continued fraction (7/6), |error| < 2e-6 inside ±4.97, then clamped to ±1.
#[inline]
pub fn tanh(x: f64) -> f64 {
    let x = if x.is_nan() { 0.0 } else { clampf(x, -4.97, 4.97) };
    let x2 = x * x;
    let y = x * (135_135.0 + x2 * (17_325.0 + x2 * (378.0 + x2)))
        / (135_135.0 + x2 * (62_370.0 + x2 * (3_150.0 + 28.0 * x2)));
    clampf(y, -1.0, 1.0)
}

/// `tan(π·f)` for a normalised frequency f in [0, 0.499].
#[inline(never)]
pub fn tan_pi(f: f64) -> f64 {
    let f = clampf(f, 0.0, 0.499);
    sin_cycles(0.5 * f) / cos_cycles(0.5 * f)
}

/// Per-sample multiplier that decays by 60 dB in `seconds`.
#[inline(never)]
pub fn t60_multiplier(seconds: f64, sample_rate: f64) -> f64 {
    let n = (seconds * sample_rate).max(1.0);
    exp(-6.907_755_278_982_137 / n)
}

/// One-pole smoothing step `1 - e^(-1/(seconds·rate))`.
#[inline(never)]
pub fn one_pole(seconds: f64, sample_rate: f64) -> f64 {
    let n = (seconds * sample_rate).max(1.0e-9);
    1.0 - exp(-1.0 / n)
}

/// MIDI note (fractional) to Hz, A4 = 440.
#[inline(never)]
pub fn note_hz(note: f64) -> f64 {
    440.0 * exp2((note - 69.0) / 12.0)
}

/// `a^b` for a > 0.
#[inline(never)]
pub fn powf(a: f64, b: f64) -> f64 {
    if a <= 0.0 { 0.0 } else { exp2(b * log2(a)) }
}

/// `log2` for x > 0 (0 and below map to -1000). |error| < 1e-9.
#[inline(never)]
pub fn log2(x: f64) -> f64 {
    if x.is_nan() || x <= 0.0 || !x.is_finite() {
        return if x == f64::INFINITY { 1024.0 } else { -1000.0 };
    }
    let bits = x.to_bits();
    let mut e = ((bits >> 52) & 0x7ff) as i64;
    let mut m = f64::from_bits((bits & 0x000f_ffff_ffff_ffff) | 0x3ff0_0000_0000_0000);
    if e == 0 {
        // Subnormal: renormalise.
        let y = x * f64::from_bits(0x4350_0000_0000_0000); // 2^54
        let b = y.to_bits();
        e = ((b >> 52) & 0x7ff) as i64 - 54;
        m = f64::from_bits((b & 0x000f_ffff_ffff_ffff) | 0x3ff0_0000_0000_0000);
    }
    let mut exponent = (e - 1023) as f64;
    if m > core::f64::consts::SQRT_2 {
        m *= 0.5;
        exponent += 1.0;
    }
    // ln(m) = 2 atanh(s), s = (m - 1) / (m + 1), |s| <= 0.1716.
    let s = (m - 1.0) / (m + 1.0);
    let s2 = s * s;
    let ln = 2.0
        * s
        * (1.0
            + s2 * (1.0 / 3.0
                + s2 * (1.0 / 5.0
                    + s2 * (1.0 / 7.0 + s2 * (1.0 / 9.0 + s2 * (1.0 / 11.0 + s2 * (1.0 / 13.0)))))));
    exponent + ln * core::f64::consts::LOG2_E
}

/// Deterministic white noise (xorshift32), uniform in [-1, 1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Noise(pub u32);

impl Noise {
    #[inline(always)]
    pub fn sample(&mut self) -> f64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        (x as f64) * (2.0 / 4_294_967_296.0) - 1.0
    }
}

/// Flushes values that would decay into the subnormal range (hosts may or may not set FTZ/DAZ;
/// flushing ourselves keeps both engines on the same samples and the CPU off slow paths).
#[inline(always)]
pub fn flush(x: f64) -> f64 {
    if x.abs() < 1.0e-20 { 0.0 } else { x }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approximations_are_accurate() {
        for i in -2000..2000 {
            let p = i as f64 * 0.001_37;
            assert!((sin_cycles(p) - (p * TAU).sin()).abs() < 2e-7, "sin {p}");
            assert!((cos_cycles(p) - (p * TAU).cos()).abs() < 2e-7, "cos {p}");
            let x = i as f64 * 0.01;
            assert!(((exp2(x) - x.exp2()) / x.exp2()).abs() < 1e-10, "exp2 {x}");
            assert!((tanh(x * 0.3) - (x * 0.3).tanh()).abs() < 1.2e-4, "tanh {x}");
            if x.abs() < 10.0 {
                assert!((tanh(x * 0.3) - (x * 0.3).tanh()).abs() < 2e-6, "tanh {x}");
            }
            let y = (i + 2001) as f64 * 0.731;
            assert!((log2(y) - y.log2()).abs() < 1e-9, "log2 {y}");
        }
        for i in 1..499 {
            let f = i as f64 * 0.001;
            let t = (core::f64::consts::PI * f).tan();
            assert!(((tan_pi(f) - t) / t).abs() < 1e-5, "tan {f}");
        }
        assert_eq!(floor(-0.5), -1.0);
        assert_eq!(floor(2.0), 2.0);
        assert!((note_hz(69.0) - 440.0).abs() < 1e-9);
        assert!((powf(2.0, 0.5) - core::f64::consts::SQRT_2).abs() < 1e-9);
    }
}

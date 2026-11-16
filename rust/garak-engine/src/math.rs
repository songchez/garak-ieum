//! Scalar math of the engine: garak-dsp's [`garak_dsp::math`] (platform libm natively with
//! `platform-math`, the `libm` crate on wasm32) plus the two functions the tempo map needs, and
//! the `a * b + c` helpers that mirror where AppleClang contracts the C++ expression into an FMA.

pub use garak_dsp::math::{cos, exp, log10, mul_add, pow, round, sin, tanh};

#[cfg(all(feature = "platform-math", not(target_arch = "wasm32")))]
mod imp {
    // SAFETY: plain C99 `<math.h>` functions: pure, thread-safe, defined for every input.
    #[cfg_attr(target_os = "linux", link(name = "m"))]
    unsafe extern "C" {
        pub safe fn log1p(x: f64) -> f64;
        pub safe fn expm1(x: f64) -> f64;
    }
}

#[cfg(not(all(feature = "platform-math", not(target_arch = "wasm32"))))]
mod imp {
    pub use libm::{expm1, log1p};
}

pub use imp::{expm1, log1p};

/// `a * b + c` in float, contracted like AppleClang on Apple arm64 (see [`mul_add`]).
#[inline(always)]
pub fn mul_add_f32(a: f32, b: f32, c: f32) -> f32 {
    #[cfg(all(feature = "platform-math", target_arch = "aarch64", target_vendor = "apple"))]
    {
        libm::fmaf(a, b, c)
    }
    #[cfg(not(all(feature = "platform-math", target_arch = "aarch64", target_vendor = "apple")))]
    {
        a * b + c
    }
}

/// `std::clamp(v, lo, hi)` exactly (NaN passes through).
#[inline(always)]
pub fn std_clamp(v: f64, lo: f64, hi: f64) -> f64 {
    let t = if v < lo { lo } else { v };
    if hi < t { hi } else { t }
}

/// `std::min(a, b)`: `b < a ? b : a`.
#[inline(always)]
pub fn std_min(a: f64, b: f64) -> f64 {
    if b < a { b } else { a }
}

/// `std::max(a, b)`: `a < b ? b : a`.
#[inline(always)]
pub fn std_max(a: f64, b: f64) -> f64 {
    if a < b { b } else { a }
}

/// `1 - exp(-1 / (rate * seconds))`: the one-pole smoothing coefficient of faders and sends.
#[inline]
pub fn smoothing(rate: f64, seconds: f64) -> f64 {
    1.0 - exp(-1.0 / (rate * seconds))
}

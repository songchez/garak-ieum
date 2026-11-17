//! the former C++ IEUM WAVE math (0.3.2) in Rust, plus the float libm functions the synth calls (`std::exp2(float)`
//! is `exp2f`, …): natively the platform C library like the rest of the engine
//! (`platform-math`), the `libm` crate on wasm32.

#[cfg(all(feature = "platform-math", not(target_arch = "wasm32")))]
mod imp {
    // SAFETY: plain C99 `<math.h>` functions: pure, thread-safe, defined for every input.
    #[cfg_attr(target_os = "linux", link(name = "m"))]
    unsafe extern "C" {
        pub safe fn expf(x: f32) -> f32;
        pub safe fn logf(x: f32) -> f32;
        pub safe fn powf(x: f32, y: f32) -> f32;
        pub safe fn exp2f(x: f32) -> f32;
        pub safe fn asin(x: f64) -> f64;
        pub safe fn fmod(x: f64, y: f64) -> f64;
    }
}

#[cfg(not(all(feature = "platform-math", not(target_arch = "wasm32"))))]
mod imp {
    pub use libm::{asin, exp2f, expf, fmod, logf, powf};
}

pub use garak_dsp::math::{ceil, cos, exp, exp2, floor, log, round, sin, tan};
pub use imp::{asin, exp2f, expf, fmod, logf, powf};

pub const PI: f64 = core::f64::consts::PI;
pub const TAU: f64 = 2.0 * PI;

/// IEEE square root (exact everywhere).
#[inline(always)]
pub fn sqrtf(x: f32) -> f32 {
    libm::sqrtf(x)
}

/// `std::min(high, std::max(low, x))` (NaN maps to `low`).
#[inline(always)]
pub fn clampf(x: f32, low: f32, high: f32) -> f32 {
    let m = if low < x { x } else { low };
    if m < high { m } else { high }
}

#[inline(always)]
pub fn clampd(x: f64, low: f64, high: f64) -> f64 {
    let m = if low < x { x } else { low };
    if m < high { m } else { high }
}

#[inline(always)]
pub fn finite_or(x: f32, fallback: f32) -> f32 {
    if x.is_finite() { x } else { fallback }
}

#[inline(always)]
pub fn wrap_phase(phase: f64) -> f64 {
    phase - floor(phase)
}

/// One wrap for internal phases in [0, 1) with a non-negative increment below one.
#[inline(always)]
pub fn advance_phase(phase: f64, increment: f64) -> f64 {
    let p = phase + increment;
    if p >= 1.0 { p - 1.0 } else { p }
}

#[inline(always)]
pub fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + t * (b - a)
}

/// Local deterministic xorshift.
#[inline(always)]
pub fn random_bits(state: &mut u32) -> u32 {
    *state ^= *state << 13;
    *state ^= *state >> 17;
    *state ^= *state << 5;
    *state
}

#[inline(always)]
pub fn random_unit(state: &mut u32) -> f32 {
    (random_bits(state) >> 8) as f32 * (1.0 / 16_777_216.0)
}

/// Linear ramp to a target over a number of samples (the former C++ IEUM WAVE math (0.3.2) `LinearSmoother`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LinearSmoother {
    pub value: f32,
    pub target: f32,
    pub step: f32,
    pub remaining: u32,
}

impl LinearSmoother {
    #[inline]
    pub fn reset(&mut self, v: f32) {
        self.value = v;
        self.target = v;
        self.step = 0.0;
        self.remaining = 0;
    }

    #[inline]
    pub fn set(&mut self, v: f32, samples: u32) {
        if samples == 0 {
            self.reset(v);
            return;
        }
        if v == self.target {
            return;
        }
        self.target = v;
        self.remaining = samples;
        self.step = (self.target - self.value) / samples as f32;
    }

    #[inline(always)]
    pub fn next(&mut self) -> f32 {
        if self.remaining != 0 {
            self.remaining -= 1;
            if self.remaining == 0 {
                self.value = self.target;
            } else {
                self.value += self.step;
            }
        }
        self.value
    }
}

#[inline(always)]
pub fn cubic(a: f32, b: f32, c: f32, d: f32, fraction: f32) -> f32 {
    let c1 = 0.5 * (c - a);
    let c2 = a - 2.5 * b + 2.0 * c - 0.5 * d;
    let c3 = 0.5 * (d - a) + 1.5 * (b - c);
    ((c3 * fraction + c2) * fraction + c1) * fraction + b
}

/// Transparent below the knee; emergency peak safety (the former C++ IEUM WAVE math (0.3.2) `safetyCeiling`).
#[inline(always)]
pub fn safety_ceiling(x: f32) -> f32 {
    let x = finite_or(x, 0.0);
    let magnitude = x.abs();
    if magnitude <= 0.94 {
        return x;
    }
    let excess = magnitude - 0.94;
    (0.94 + 0.04 * excess / (0.04 + excess)).copysign(x)
}

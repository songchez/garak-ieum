//! Scalar math used by the kernels: one place that decides where transcendentals come from.
//!
//! - **Native with the `platform-math` feature** (what `garak-ffi` enables): the C library's own
//!   `exp`/`log`/`pow`/`sin`/`tanh`/… (UCRT on MSVC, the MinGW CRT, libSystem on macOS, glibc on
//!   Linux). These are the very functions the C++ kernels call through `std::exp` etc. in the same
//!   linked binary, so Rust and C++ get identical values and the platform's tuned implementations.
//!   Nothing extra is linked: the symbols resolve against the CRT the C++ host already links.
//! - **wasm32, or without the feature**: the pure-Rust `libm` crate (musl port). The browser
//!   worklet has no C library; `libm` keeps the crate `no_std` and dependency-light. On wasm32,
//!   `floor` / `ceil` / `sqrt` use the wasm instructions instead (exact either way).
//!
//! `sqrt` and the rounding functions are exact (correctly rounded / integral) in every
//! implementation, so they only differ in speed.

#[cfg(all(feature = "platform-math", not(target_arch = "wasm32")))]
mod imp {
    // `libm` stays a dependency for wasm32 and featureless builds (Cargo cannot express
    // "unless feature"); this keeps the unused-dependency lint quiet on native.
    use libm as _;

    // SAFETY: plain C99 `<math.h>` functions: pure, thread-safe, no pointers, defined for every
    // input (NaN / inf in, NaN / inf out). Declared `safe` so call sites need no `unsafe`.
    // glibc keeps them in libm (only Rust test binaries link here; CMake links C++ with -lm).
    #[cfg_attr(target_os = "linux", link(name = "m"))]
    unsafe extern "C" {
        pub safe fn exp(x: f64) -> f64;
        pub safe fn log(x: f64) -> f64;
        pub safe fn log10(x: f64) -> f64;
        pub safe fn pow(x: f64, y: f64) -> f64;
        pub safe fn sin(x: f64) -> f64;
        pub safe fn cos(x: f64) -> f64;
        pub safe fn tan(x: f64) -> f64;
        pub safe fn tanh(x: f64) -> f64;
        pub safe fn sqrt(x: f64) -> f64;
        pub safe fn floor(x: f64) -> f64;
        pub safe fn ceil(x: f64) -> f64;
        pub safe fn round(x: f64) -> f64;
        pub safe fn sinf(x: f32) -> f32;
        pub safe fn cosf(x: f32) -> f32;
    }
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod imp {
    use core::arch::wasm32::{f64x2_ceil, f64x2_extract_lane, f64x2_floor, f64x2_splat, f64x2_sqrt};
    pub use libm::{cos, cosf, exp, log, log10, pow, round, sin, sinf, tan, tanh};

    // The exact operations wasm has as instructions. `libm` only uses them behind a nightly-only
    // switch and otherwise falls back to integer bit manipulation (the bitcrusher's per-sample
    // floor, for one, was half as fast as `Math.floor` in the TS kernel). One lane of the SIMD
    // form (simd128 is a baseline feature here, .cargo/config.toml) gives the same exact result.
    #[inline(always)]
    pub fn floor(x: f64) -> f64 {
        f64x2_extract_lane::<0>(f64x2_floor(f64x2_splat(x)))
    }

    #[inline(always)]
    pub fn ceil(x: f64) -> f64 {
        f64x2_extract_lane::<0>(f64x2_ceil(f64x2_splat(x)))
    }

    #[inline(always)]
    pub fn sqrt(x: f64) -> f64 {
        f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(x)))
    }
}

#[cfg(not(any(
    all(feature = "platform-math", not(target_arch = "wasm32")),
    all(target_arch = "wasm32", target_feature = "simd128")
)))]
mod imp {
    pub use libm::{ceil, cos, cosf, exp, floor, log, log10, pow, round, sin, sinf, sqrt, tan, tanh};
}

pub use imp::{ceil, cos, cosf, exp, floor, log, log10, pow, round, sin, sinf, sqrt, tan, tanh};

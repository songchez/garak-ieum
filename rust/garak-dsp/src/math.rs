//! Scalar math used by the kernels: one place that decides where transcendentals come from.
//!
//! - **Native with the `platform-math` feature** (what `garak-ffi` enables): the C library's own
//!   `exp`/`log`/`pow`/`sin`/`tanh`/… (UCRT on MSVC, the MinGW CRT, libSystem on macOS, glibc on
//!   Linux). These are the very functions the C++ kernels call through `std::exp` etc. in the same
//!   linked binary, so Rust and C++ get identical values and the platform's tuned implementations.
//!   Nothing extra is linked: the symbols resolve against the CRT the C++ host already links.
//! - **wasm32** (the browser worklet, which has no C library): `tan`/`exp`/`log`/`pow` are imported
//!   from the host (`"math"` import module, `Math.*` in garakWasm.ts). Engines call imported `Math`
//!   builtins directly as native code (no JS frame), which beats the same musl code compiled to
//!   wasm (the phaser's per-sample `pow` + `tan` ran at 0.75x the TS kernel) and matches the
//!   `Math.*` the TS kernels call. `sin`/`cos` stay in `libm`: inlined, they are cheaper than the
//!   import call (chorus/flanger measured faster that way). `floor` / `ceil` / `sqrt` are wasm
//!   instructions (exact either way); the rest is `libm`.
//! - **without the feature** (host tests of garak-dsp alone): the pure-Rust `libm` crate (musl
//!   port), keeping the crate `no_std` and dependency-light.
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
    pub use libm::{cos, cosf, log10, round, sin, sinf};

    // Host `Math` functions (garakWasm.ts `MATH_IMPORTS`). Only builtins V8 lowers to a direct call
    // of its own C implementation when imported (`tanh` and `log10` are not on that list, so they
    // stay in wasm; `sin`/`cos` are faster inlined, see the module docs). The import names differ from the C
    // names so wasm-ld cannot resolve them against compiler-builtins' own `sin`/`exp` symbols.
    // SAFETY: pure functions of their f64 arguments, defined for every input (NaN in, NaN out).
    #[link(wasm_import_module = "math")]
    unsafe extern "C" {
        #[link_name = "garak_tan"]
        pub safe fn tan(x: f64) -> f64;
        #[link_name = "garak_exp"]
        pub safe fn exp(x: f64) -> f64;
        #[link_name = "garak_log"]
        pub safe fn log(x: f64) -> f64;
        #[link_name = "garak_pow"]
        pub safe fn pow(x: f64, y: f64) -> f64;
    }

    /// Cephes `tanh` (S. Moshier; relative error <= 2.5e-16 in IEEE double): `1 - 2 / (e^2|x| + 1)`
    /// with the imported `exp` above 0.625, a rational approximation below. `libm::tanh` goes
    /// through a software `expm1` and was ~40 % of the 2x-oversampled drive in the worklet (two
    /// calls per sample and channel); this is the drive's hot path on the web. Native builds keep
    /// the C library's `tanh` (what the C++ kernels call), so only the WASM build changes, by
    /// rounding-level amounts (the WASM-vs-native gates are -90 dBFS).
    #[inline]
    pub fn tanh(x: f64) -> f64 {
        const P: [f64; 3] = [-9.643_991_794_250_522e-1, -9.928_772_310_019_186e1, -1.614_687_684_417_084_5e3];
        const Q: [f64; 3] = [1.128_116_784_916_329_3e2, 2.235_488_390_601_004_5e3, 4.844_063_053_251_255e3];
        let z = x.abs();
        if z > 0.625 {
            // tanh(22) rounds to 1; exp(2|x|) stays finite there.
            let r = if z > 22.0 { 1.0 } else { 1.0 - 2.0 / (exp(2.0 * z) + 1.0) };
            r.copysign(x)
        } else if z == 0.0 {
            x
        } else {
            let s = x * x;
            let p = (P[0] * s + P[1]) * s + P[2];
            let q = ((s + Q[0]) * s + Q[1]) * s + Q[2];
            x + x * s * (p / q)
        }
    }

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

/// `a * b + c` the way the native C++ build evaluates that expression. AppleClang contracts it into
/// one fused multiply-add by default (`-ffp-contract=on`), so on Apple arm64 this is `fmadd`
/// (one rounding, and a shorter loop-carried chain in the glides); MSVC and GCC on x86-64 do not
/// contract, and neither does wasm32, so everywhere else it is the plain two-rounding expression.
/// Used where the C++ source has exactly this shape (e.g. `value += (target - value) * k`).
#[inline(always)]
pub fn mul_add(a: f64, b: f64, c: f64) -> f64 {
    #[cfg(all(feature = "platform-math", target_arch = "aarch64", target_vendor = "apple"))]
    {
        libm::fma(a, b, c)
    }
    #[cfg(not(all(feature = "platform-math", target_arch = "aarch64", target_vendor = "apple")))]
    {
        a * b + c
    }
}

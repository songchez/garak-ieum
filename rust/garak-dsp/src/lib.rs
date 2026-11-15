//! 가락이음 real-time DSP kernels.
//!
//! Every kernel here mirrors an existing C++ (`native/`) and TypeScript (`src/`) kernel line for
//! line: same state, same order of operations, same parameter units. The parity tests
//! (`native/tests/rust_parity_test.cpp`, `src/audio/rust/parity.test.ts`) hold them together.
//!
//! Real-time contract (docs/RUST.md):
//! - `#![no_std]` without the `alloc` crate: nothing in this crate can allocate.
//! - No locks, no I/O, no panics: `unwrap`/`expect`/`panic!`/indexing are denied by workspace lints;
//!   out-of-range inputs are clamped, never rejected.
//! - Transcendentals come from `libm`, so native and wasm32 compute bit-identical results.
#![no_std]

#[cfg(test)]
extern crate std;

pub mod biquad;
pub mod fx;
pub mod gain;
pub mod lines;
pub mod params;
pub mod smooth;
pub mod utility;

pub use biquad::{Biquad, Coefficients, FilterType};
pub use fx::{Fx, FxError, Kernel};
pub use gain::{ChannelStrip, db_to_gain, pan_mono, pan_stereo};
pub use params::{EffectKind, MAX_PARAMS, ParamDef, ParamSet};
pub use smooth::{Smooth, smoothing_coefficient};
pub use utility::{Utility, UtilityParams};

/// Same constant as `garak::dsp::pi`.
pub const PI: f64 = core::f64::consts::PI;

#[inline]
pub(crate) fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    // std::clamp semantics for finite bounds; NaN maps to `lo` instead of propagating.
    if v.is_nan() || v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

/// `std::max(a, b)` exactly (`a < b ? b : a`): hot paths mirror the C++ comparison, NaN included.
#[inline]
pub(crate) fn std_max<T: PartialOrd>(a: T, b: T) -> T {
    if a < b { b } else { a }
}

/// `std::min(a, b)` exactly (`b < a ? b : a`).
#[inline]
pub(crate) fn std_min<T: PartialOrd>(a: T, b: T) -> T {
    if b < a { b } else { a }
}

/// `std::clamp(v, lo, hi)` exactly (NaN passes through, unlike [`clamp`]).
#[inline]
pub(crate) fn std_clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if v < lo {
        lo
    } else if hi < v {
        hi
    } else {
        v
    }
}

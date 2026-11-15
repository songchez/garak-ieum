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
pub mod gain;
pub mod smooth;
pub mod utility;

pub use biquad::{Biquad, Coefficients, FilterType};
pub use gain::{ChannelStrip, db_to_gain, pan_mono, pan_stereo};
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

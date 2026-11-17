//! Two `f64` lanes, one per channel, for kernels whose left and right paths are independent chains
//! of the same operations (the drive's oversampling filters, the phaser's all-pass ladder).
//!
//! Each lane computes exactly what the scalar code computes for its channel: the same operations in
//! the same order, IEEE `mul` / `add` / `sub` / `div` with one rounding each and never fused, so the
//! output is bit-identical to running the channels one after the other (the C++ kernels' order). On
//! wasm32 (simd128 is a baseline target feature, rust/.cargo/config.toml) one `f64x2` instruction
//! does both channels; elsewhere it is two scalar operations, which is what the kernels did before.
#![allow(clippy::should_implement_trait)]

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod imp {
    use core::arch::wasm32::{
        f64x2, f64x2_abs, f64x2_add, f64x2_div, f64x2_extract_lane, f64x2_lt, f64x2_mul, f64x2_splat,
        f64x2_sub, v128, v128_andnot,
    };

    #[derive(Clone, Copy)]
    pub struct F2(v128);

    impl F2 {
        #[inline(always)]
        pub fn new(a: f64, b: f64) -> Self {
            Self(f64x2(a, b))
        }
        #[inline(always)]
        pub fn splat(x: f64) -> Self {
            Self(f64x2_splat(x))
        }
        #[inline(always)]
        pub fn lanes(self) -> [f64; 2] {
            [f64x2_extract_lane::<0>(self.0), f64x2_extract_lane::<1>(self.0)]
        }
        #[inline(always)]
        pub fn add(self, o: Self) -> Self {
            Self(f64x2_add(self.0, o.0))
        }
        #[inline(always)]
        pub fn sub(self, o: Self) -> Self {
            Self(f64x2_sub(self.0, o.0))
        }
        #[inline(always)]
        pub fn mul(self, o: Self) -> Self {
            Self(f64x2_mul(self.0, o.0))
        }
        #[inline(always)]
        pub fn div(self, o: Self) -> Self {
            Self(f64x2_div(self.0, o.0))
        }
        /// Each lane, or 0.0 where `|lane| < limit` (the kernels' denormal flush).
        #[inline(always)]
        pub fn flush_below(self, limit: f64) -> Self {
            Self(v128_andnot(self.0, f64x2_lt(f64x2_abs(self.0), f64x2_splat(limit))))
        }
    }
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
mod imp {
    #[derive(Clone, Copy)]
    pub struct F2([f64; 2]);

    impl F2 {
        #[inline(always)]
        pub fn new(a: f64, b: f64) -> Self {
            Self([a, b])
        }
        #[inline(always)]
        pub fn splat(x: f64) -> Self {
            Self([x, x])
        }
        #[inline(always)]
        pub fn lanes(self) -> [f64; 2] {
            self.0
        }
        #[inline(always)]
        pub fn add(self, o: Self) -> Self {
            Self([self.0[0] + o.0[0], self.0[1] + o.0[1]])
        }
        #[inline(always)]
        pub fn sub(self, o: Self) -> Self {
            Self([self.0[0] - o.0[0], self.0[1] - o.0[1]])
        }
        #[inline(always)]
        pub fn mul(self, o: Self) -> Self {
            Self([self.0[0] * o.0[0], self.0[1] * o.0[1]])
        }
        #[inline(always)]
        pub fn div(self, o: Self) -> Self {
            Self([self.0[0] / o.0[0], self.0[1] / o.0[1]])
        }
        #[inline(always)]
        pub fn flush_below(self, limit: f64) -> Self {
            let f = |x: f64| if x.abs() < limit { 0.0 } else { x };
            Self([f(self.0[0]), f(self.0[1])])
        }
    }
}

pub use imp::F2;

impl Default for F2 {
    fn default() -> Self {
        Self::splat(0.0)
    }
}

impl core::fmt::Debug for F2 {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_tuple("F2").field(&self.lanes()).finish()
    }
}

#[cfg(test)]
mod tests {
    use super::F2;

    #[test]
    fn lanes_are_the_scalar_operations() {
        let (a, b) = (F2::new(0.1, -3.7), F2::new(1.3, 2.9));
        assert_eq!(a.add(b).lanes(), [0.1 + 1.3, -3.7 + 2.9]);
        assert_eq!(a.sub(b).lanes(), [0.1 - 1.3, -3.7 - 2.9]);
        assert_eq!(a.mul(b).lanes(), [0.1 * 1.3, -3.7 * 2.9]);
        assert_eq!(a.div(b).lanes(), [0.1 / 1.3, -3.7 / 2.9]);
        assert_eq!(F2::new(1e-31, -2.0).flush_below(1e-30).lanes(), [0.0, -2.0]);
        assert_eq!(F2::new(-1e-31, 1e-29).flush_below(1e-30).lanes(), [0.0, 1e-29]);
    }
}

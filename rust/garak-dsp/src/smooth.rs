//! One-pole parameter glide (~12 ms), as `Smooth` in the former C++ 시김새 effects (0.3.2) and
//! src/devices/effects/the former TS kernels (0.3.2).

use crate::math;
/// `1 - exp(-1 / (0.012 * rate))`: the per-sample step every glide in the engine uses.
#[inline]
pub fn smoothing_coefficient(sample_rate: f64) -> f64 {
    1.0 - math::exp(-1.0 / (0.012 * sample_rate))
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Smooth {
    pub value: f64,
    pub target: f64,
}

impl Smooth {
    /// Jump to `target` (first configuration).
    #[inline]
    pub fn set(&mut self, target: f64) {
        self.value = target;
        self.target = target;
    }

    /// Glide to `target` from the current value (later configurations).
    #[inline]
    pub fn glide_to(&mut self, target: f64) {
        self.target = target;
    }

    /// `Smooth::follow`: continue from another glide's current value (state hand-over).
    #[inline]
    pub fn follow(&mut self, previous: &Smooth) {
        self.value = previous.value;
    }

    /// At its target, where [`Self::next`] returns `value` unchanged: `value + 0 * k` is exact
    /// (except for -0.0, which one step turns into +0.0). Kernels check this once per block to
    /// run a loop without the update; a per-frame check in `next` itself made LLVM's code slower.
    #[inline]
    pub fn settled(&self) -> bool {
        self.value == self.target && !(self.value == 0.0 && self.value.is_sign_negative())
    }

    /// [`Self::next`], or just `value` in a block known to be [`Self::settled`].
    #[inline(always)]
    pub fn next_if<const SETTLED: bool>(&mut self, k: f64) -> f64 {
        if SETTLED { self.value } else { self.next(k) }
    }

    #[inline(always)]
    pub fn next(&mut self, k: f64) -> f64 {
        // C++ `value += (target - value) * k` (fused on Apple arm64, see math::mul_add).
        self.value = math::mul_add(self.target - self.value, k, self.value);
        self.value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glides_toward_target_and_reaches_it() {
        let k = smoothing_coefficient(48_000.0);
        let mut s = Smooth::default();
        s.set(0.0);
        s.glide_to(1.0);
        let first = s.next(k);
        assert!(first > 0.0 && first < 0.01);
        for _ in 0..48_000 {
            s.next(k);
        }
        assert!((s.value - 1.0).abs() < 1e-9);
    }
}

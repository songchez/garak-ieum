//! One-pole parameter glide (~12 ms), as `Smooth` in native/src/sigimsae_effects.inc and
//! src/devices/effects/kernels.ts.

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

    #[inline(always)]
    pub fn next(&mut self, k: f64) -> f64 {
        self.value += (self.target - self.value) * k;
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

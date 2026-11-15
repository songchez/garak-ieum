//! Utility 시김새: gain, balance, mid/side width, mono sum and per-side polarity.
//! Mirrors `UtilityFx` (native/src/sigimsae_effects.inc) and `UtilityKernel`
//! (src/devices/effects/kernels.ts); parameter ranges from src/devices/effects/sigimsaeDefs.ts.

use crate::math;
use crate::{
    clamp,
    fx::Kernel,
    gain::db_to_gain,
    params::{ParamSet, UTILITY, index_of},
    smooth::{Smooth, smoothing_coefficient},
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UtilityParams {
    /// dB, -36..24.
    pub gain_db: f64,
    /// -1..1 balance.
    pub pan: f64,
    /// 0..2 side scale (1 = unchanged).
    pub width: f64,
    /// >= 0.5 sums to mono (width 0).
    pub mono: f64,
    /// Polarity bit mask: 1 = flip left, 2 = flip right (0..3).
    pub phase: f64,
}

impl Default for UtilityParams {
    fn default() -> Self {
        Self { gain_db: 0.0, pan: 0.0, width: 1.0, mono: 0.0, phase: 0.0 }
    }
}

impl UtilityParams {
    /// Same clamping as `readParams` in kernels.ts (non-finite falls back to the default).
    pub fn sanitized(self) -> Self {
        let d = Self::default();
        let pick =
            |v: f64, fallback: f64, lo: f64, hi: f64| if v.is_finite() { clamp(v, lo, hi) } else { fallback };
        Self {
            gain_db: pick(self.gain_db, d.gain_db, -36.0, 24.0),
            pan: pick(self.pan, d.pan, -1.0, 1.0),
            width: pick(self.width, d.width, 0.0, 2.0),
            mono: pick(self.mono, d.mono, 0.0, 1.0),
            phase: pick(self.phase, d.phase, 0.0, 3.0),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Utility {
    k: f64,
    configured: bool,
    gain: Smooth,
    pan: Smooth,
    width: Smooth,
    sign_l: Smooth,
    sign_r: Smooth,
}

impl Utility {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            k: smoothing_coefficient(sample_rate),
            configured: false,
            gain: Smooth::default(),
            pan: Smooth::default(),
            width: Smooth::default(),
            sign_l: Smooth::default(),
            sign_r: Smooth::default(),
        }
    }

    /// The first call applies immediately; later calls glide over ~12 ms (kernels.ts semantics;
    /// the C++ equivalent is a rebuilt processor + `takeStateFrom`).
    pub fn configure(&mut self, params: UtilityParams) {
        let p = params.sanitized();
        // lround of a value in 0..3: round half away from zero.
        let phase = math::round(p.phase) as i32;
        let targets = [
            db_to_gain(p.gain_db),
            p.pan,
            if p.mono >= 0.5 { 0.0 } else { p.width },
            if phase & 1 != 0 { -1.0 } else { 1.0 },
            if phase & 2 != 0 { -1.0 } else { 1.0 },
        ];
        let immediate = !self.configured;
        let smooths = [&mut self.gain, &mut self.pan, &mut self.width, &mut self.sign_l, &mut self.sign_r];
        for (s, t) in smooths.into_iter().zip(targets) {
            if immediate { s.set(t) } else { s.glide_to(t) }
        }
        self.configured = true;
    }

    /// One frame. `SIDE` is the balance branch when it is known for the whole block (see
    /// [`Self::pan_side`]): `1` pan > 0, `-1` pan < 0, `2` pan == 0, `0` test every frame.
    /// Leaving out a factor that is exactly 1 changes no bits, so every `SIDE` gives the C++
    /// result `(mid + side) * (pan > 0 ? 1 - pan : 1) * gain`.
    #[inline(always)]
    fn frame_side<const SIDE: i8>(&mut self, a: f32, b: f32) -> (f32, f32) {
        let k = self.k;
        let gain = self.gain.next(k);
        let pan = self.pan.next(k);
        let width = self.width.next(k);
        let a = f64::from(a) * self.sign_l.next(k);
        let b = f64::from(b) * self.sign_r.next(k);
        let mid = 0.5 * (a + b);
        let side = 0.5 * (a - b) * width;
        let (l, r) = match SIDE {
            1 => ((mid + side) * (1.0 - pan) * gain, (mid - side) * gain),
            -1 => ((mid + side) * gain, (mid - side) * (1.0 + pan) * gain),
            2 => ((mid + side) * gain, (mid - side) * gain),
            _ => (
                (mid + side) * (if pan > 0.0 { 1.0 - pan } else { 1.0 }) * gain,
                (mid - side) * (if pan < 0.0 { 1.0 + pan } else { 1.0 }) * gain,
            ),
        };
        (l as f32, r as f32)
    }

    #[inline(always)]
    fn frame(&mut self, a: f32, b: f32) -> (f32, f32) {
        self.frame_side::<0>(a, b)
    }

    /// The balance branch for a whole block, when the pan glide cannot cross zero during it: the
    /// glide stays between its current value and its target, so equal signs at both ends hold for
    /// every frame. Hoisting it removes a per-frame select (GCC branches on it, which predicts
    /// perfectly; LLVM's branchless blend cost ~15% of this very light kernel).
    fn pan_side(&self) -> i8 {
        let (v, t) = (self.pan.value, self.pan.target);
        if v > 0.0 && t > 0.0 {
            1
        } else if v < 0.0 && t < 0.0 {
            -1
        } else if v == 0.0 && t == 0.0 {
            2
        } else {
            0
        }
    }

    #[inline(never)]
    fn interleaved<const SIDE: i8>(&mut self, stereo: &mut [f32]) {
        for [l, r] in stereo.as_chunks_mut::<2>().0 {
            (*l, *r) = self.frame_side::<SIDE>(*l, *r);
        }
    }

    #[inline(never)]
    fn planar<const SIDE: i8>(&mut self, left: &mut [f32], right: &mut [f32]) {
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            (*l, *r) = self.frame_side::<SIDE>(*l, *r);
        }
    }

    pub fn process_interleaved(&mut self, stereo: &mut [f32]) {
        match self.pan_side() {
            1 => self.interleaved::<1>(stereo),
            -1 => self.interleaved::<-1>(stereo),
            2 => self.interleaved::<2>(stereo),
            _ => self.interleaved::<0>(stereo),
        }
    }

    pub fn process_planar(&mut self, left: &mut [f32], right: &mut [f32]) {
        match self.pan_side() {
            1 => self.planar::<1>(left, right),
            -1 => self.planar::<-1>(left, right),
            2 => self.planar::<2>(left, right),
            _ => self.planar::<0>(left, right),
        }
    }

    pub fn reset(&mut self) {}

    /// Configured from a catalog-order parameter set (the `Fx` path).
    pub fn with_params(sample_rate: f64, p: &ParamSet) -> Self {
        let mut u = Self::new(sample_rate);
        u.configure(UtilityParams::from_set(p));
        u
    }

    /// `UtilityFx::takeStateFrom`: continue the glides from the previous processor.
    pub fn take_state_from(&mut self, p: &mut Self) -> bool {
        self.gain.follow(&p.gain);
        self.pan.follow(&p.pan);
        self.width.follow(&p.width);
        self.sign_l.follow(&p.sign_l);
        self.sign_r.follow(&p.sign_r);
        false
    }
}

impl UtilityParams {
    pub fn from_set(p: &ParamSet) -> Self {
        Self {
            gain_db: p.get(index_of(UTILITY, "gain")),
            pan: p.get(index_of(UTILITY, "pan")),
            width: p.get(index_of(UTILITY, "width")),
            mono: p.get(index_of(UTILITY, "mono")),
            phase: p.get(index_of(UTILITY, "phase")),
        }
    }
}

impl Kernel for Utility {
    fn automate(&mut self, p: &ParamSet) {
        self.configure(UtilityParams::from_set(p));
    }

    #[inline(always)]
    fn frame(&mut self, l: f32, r: f32) -> (f32, f32) {
        Utility::frame(self, l, r)
    }

    fn process_interleaved(&mut self, s: &mut [f32]) {
        Utility::process_interleaved(self, s);
    }

    fn process_planar(&mut self, left: &mut [f32], right: &mut [f32]) {
        Utility::process_planar(self, left, right);
    }

    fn reset(&mut self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_sums_and_phase_flips() {
        let mut u = Utility::new(48_000.0);
        u.configure(UtilityParams { mono: 1.0, ..Default::default() });
        let mut buf = [1.0f32, 0.0, 0.25, 0.75];
        u.process_interleaved(&mut buf);
        assert_eq!(buf, [0.5, 0.5, 0.5, 0.5]);

        let mut u = Utility::new(48_000.0);
        u.configure(UtilityParams { phase: 3.0, ..Default::default() });
        let mut buf = [0.5f32, -0.25];
        u.process_interleaved(&mut buf);
        assert_eq!(buf, [-0.5, 0.25]);
    }

    #[test]
    fn later_configuration_glides() {
        let mut u = Utility::new(48_000.0);
        u.configure(UtilityParams::default());
        u.configure(UtilityParams { gain_db: -36.0, ..Default::default() });
        let mut l = [1.0f32; 4800];
        let mut r = [1.0f32; 4800];
        u.process_planar(&mut l, &mut r);
        assert!(l[0] > 0.99 && l[0] < 1.0);
        assert!((f64::from(l[4799]) - db_to_gain(-36.0)).abs() < 1e-3);
    }

    #[test]
    fn hostile_params_fall_back() {
        let p = UtilityParams { gain_db: f64::NAN, pan: 9.0, width: -1.0, mono: f64::INFINITY, phase: 7.0 }
            .sanitized();
        assert_eq!(p, UtilityParams { gain_db: 0.0, pan: 1.0, width: 0.0, mono: 0.0, phase: 3.0 });
    }
}

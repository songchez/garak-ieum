//! Gain and pan laws of the track channel strip (native/src/engine.cpp, track mix loop), which
//! follow the W3C `StereoPannerNode` used by the web engine (src/audio/graph.ts).

use crate::math;
use crate::{PI, clamp, smooth::smoothing_coefficient};

/// `garak::dsp::dbToGain`.
#[inline]
pub fn db_to_gain(db: f64) -> f64 {
    math::pow(10.0, db / 20.0)
}

/// Equal-power mono pan: a mono voice placed at `pan` in [-1, 1] (centre = -3 dB per side).
#[inline]
pub fn pan_mono(pan: f64, x: f64) -> (f64, f64) {
    let angle = (clamp(pan, -1.0, 1.0) + 1.0) * PI / 4.0;
    (x * math::cos(angle), x * math::sin(angle))
}

/// Stereo balance pan: centre is unity; moving left folds the right channel into the left with
/// an equal-power law (and vice versa).
#[inline]
pub fn pan_stereo(pan: f64, l: f64, r: f64) -> (f64, f64) {
    let pan = clamp(pan, -1.0, 1.0);
    if pan < 0.0 {
        let angle = (pan + 1.0) * PI / 2.0;
        (l + r * math::cos(angle), r * math::sin(angle))
    } else if pan > 0.0 {
        let angle = pan * PI / 2.0;
        (l * math::cos(angle), r + l * math::sin(angle))
    } else {
        (l, r)
    }
}

/// Track fader + pan with the engine's 12 ms glide, non-finite scrub and ±32 safety clamp.
#[derive(Clone, Debug)]
pub struct ChannelStrip {
    fader: f64,
    pan: f64,
    target_gain: f64,
    target_pan: f64,
    smoothing: f64,
    stereo: bool,
}

impl ChannelStrip {
    pub fn new(sample_rate: f64, gain: f64, pan: f64, stereo: bool) -> Self {
        let (gain, pan) = (clamp(gain, 0.0, 2.0), clamp(pan, -1.0, 1.0));
        Self {
            fader: gain,
            pan,
            target_gain: gain,
            target_pan: pan,
            smoothing: smoothing_coefficient(sample_rate),
            stereo,
        }
    }

    /// New targets glide in; `stereo == false` means a mono source duplicated into both channels.
    pub fn set(&mut self, gain: f64, pan: f64, stereo: bool) {
        self.target_gain = clamp(gain, 0.0, 2.0);
        self.target_pan = clamp(pan, -1.0, 1.0);
        self.stereo = stereo;
    }

    /// Interleaved stereo in place. Returns the number of non-finite samples replaced by 0.
    pub fn process_interleaved(&mut self, stereo: &mut [f32]) -> u32 {
        let mut invalid = 0u32;
        for [left, right] in stereo.as_chunks_mut::<2>().0 {
            self.fader += (self.target_gain - self.fader) * self.smoothing;
            self.pan += (self.target_pan - self.pan) * self.smoothing;
            let (l, r) = if self.stereo {
                pan_stereo(self.pan, f64::from(*left), f64::from(*right))
            } else {
                pan_mono(self.pan, f64::from(*left))
            };
            let (mut l, mut r) = (l * self.fader, r * self.fader);
            if !l.is_finite() {
                l = 0.0;
                invalid += 1;
            }
            if !r.is_finite() {
                r = 0.0;
                invalid += 1;
            }
            *left = clamp(l, -32.0, 32.0) as f32;
            *right = clamp(r, -32.0, 32.0) as f32;
        }
        invalid
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_pan_is_equal_power() {
        for i in 0..=20 {
            let pan = -1.0 + f64::from(i) * 0.1;
            let (l, r) = pan_mono(pan, 1.0);
            assert!((l * l + r * r - 1.0).abs() < 1e-12);
        }
        let (l, r) = pan_mono(0.0, 1.0);
        assert!((l - r).abs() < 1e-12 && (20.0 * math::log10(l) + 3.0103).abs() < 1e-3);
        let (l, r) = pan_mono(-1.0, 1.0);
        assert!((l - 1.0).abs() < 1e-12 && r.abs() < 1e-12);
    }

    #[test]
    fn stereo_pan_keeps_centre_unity_and_folds_hard_sides() {
        assert_eq!(pan_stereo(0.0, 0.3, -0.2), (0.3, -0.2));
        let (l, r) = pan_stereo(-1.0, 0.5, 0.25);
        assert!((l - 0.75).abs() < 1e-12 && r.abs() < 1e-12);
        let (l, r) = pan_stereo(1.0, 0.5, 0.25);
        assert!(l.abs() < 1e-12 && (r - 0.75).abs() < 1e-12);
    }

    #[test]
    fn strip_scrubs_non_finite_and_clamps() {
        let mut strip = ChannelStrip::new(48_000.0, 1.0, 0.0, true);
        let mut buf = [f32::NAN, 100.0, 0.5, f32::INFINITY];
        assert_eq!(strip.process_interleaved(&mut buf), 2);
        assert_eq!(buf, [0.0, 32.0, 0.5, 0.0]);
    }
}

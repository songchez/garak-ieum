//! Audio region windows: engine.cpp `pcmChannel`, `pcmSample`, `fadeShape` and the window loop of
//! `TrackRuntime::render` (gain, fades of five shapes, the 4 ms click guard, resampling by linear
//! interpolation, speaker downmix). Crossfades are two overlapping windows with complementary fades,
//! summed in the track buffer exactly like the C++ loop.

use alloc::sync::Arc;

use crate::math;
use crate::plan::{AudioWindow, PcmAsset};

/// A window with its PCM resolved on the control thread.
#[derive(Debug)]
pub(crate) struct Window {
    pub w: AudioWindow,
    pub asset: Arc<PcmAsset>,
}

/// Gain of a region fade at progress x (0 = silent end, 1 = full level); clipEnvelope.ts fadeShape().
pub fn fade_shape(curve: i32, x: f64) -> f64 {
    let t = x.clamp(0.0, 1.0);
    const PI: f64 = core::f64::consts::PI;
    match curve {
        1 => math::sin(t * PI / 2.0),
        2 => (1.0 - math::cos(t * PI)) / 2.0,
        3 => t * t,
        4 => math::mul_add(-(1.0 - t), 1.0 - t, 1.0),
        _ => t,
    }
}

#[inline]
fn pcm_channel(a: &PcmAsset, frames: u64, position: f64, channel: u32) -> f32 {
    if position < 0.0 || position >= frames as f64 {
        return 0.0;
    }
    let index = position as u64;
    let c = channel.min(a.channels.saturating_sub(1)) as usize;
    let stride = a.channels as usize;
    let at = index as usize * stride + c;
    let left = a.samples.get(at).copied().unwrap_or(0.0);
    let right = if index + 1 < frames { a.samples.get(at + stride).copied().unwrap_or(0.0) } else { 0.0 };
    math::mul_add_f32((position - index as f64) as f32, right - left, left)
}

#[inline]
fn pcm_sample(a: &PcmAsset, frames: u64, position: f64, channel: u32) -> f32 {
    match a.channels {
        4 => {
            0.5 * (pcm_channel(a, frames, position, channel) + pcm_channel(a, frames, position, channel + 2))
        }
        6 => math::mul_add_f32(
            0.707_106_77,
            pcm_channel(a, frames, position, 2) + pcm_channel(a, frames, position, channel + 4),
            pcm_channel(a, frames, position, channel),
        ),
        _ => pcm_channel(a, frames, position, channel),
    }
}

impl Window {
    /// Adds this window's samples for project frames `[frame, frame + count)` into `buffer`
    /// (interleaved stereo). `sample_rate` is the engine rate.
    pub fn render(&self, buffer: &mut [f32], frame: i64, count: u32, sample_rate: f64) {
        let w = &self.w;
        let start = frame.max(w.start_frame);
        let end = (frame + i64::from(count)).min(w.end_frame);
        if start >= end {
            return;
        }
        let click = math::std_min(sample_rate * 0.004, (w.end_frame - w.start_frame) as f64 / 4.0);
        let gain0 = f64::from(w.gain);
        let frames = self.asset.frames();
        let first = (start - frame) as usize;
        let span = (end - start) as usize;
        let Some(out) = buffer.get_mut(first * 2..(first + span) * 2) else { return };
        for (k, [a, b]) in out.as_chunks_mut::<2>().0.iter_mut().enumerate() {
            let absolute = start + k as i64;
            let delta = absolute - w.start_frame;
            let envelope = (w.clip_offset_frames + delta) as f64;
            let mut gain = gain0;
            if w.fade_in_frames > 0 {
                gain *= fade_shape(w.fade_in_curve, envelope / w.fade_in_frames as f64);
            }
            if w.fade_out_frames > 0 {
                let out_gain = gain0
                    * fade_shape(
                        w.fade_out_curve,
                        (w.clip_length_frames as f64 - envelope) / w.fade_out_frames as f64,
                    );
                gain = math::std_min(gain, out_gain);
            }
            if click > 0.0 {
                // std::min({1.0, a, b}): the first smallest.
                let mut m = 1.0;
                let a = delta as f64 / click;
                if a < m {
                    m = a;
                }
                let b = (w.end_frame - absolute) as f64 / click;
                if b < m {
                    m = b;
                }
                gain *= m;
            }
            let position = w.source_start_frame + delta as f64 * w.source_sample_rate / sample_rate;
            let l = (f64::from(pcm_sample(&self.asset, frames, position, 0)) * gain) as f32;
            let r = (f64::from(pcm_sample(&self.asset, frames, position, 1)) * gain) as f32;
            *a += l;
            *b += r;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::String;
    use alloc::vec;

    fn window(gain: f32, fade_in: i64, fade_out: i64, curve: i32) -> Window {
        Window {
            w: AudioWindow {
                id: 0,
                asset_id: String::from("a"),
                start_frame: 100,
                end_frame: 1100,
                source_start_frame: 0.0,
                source_sample_rate: 48_000.0,
                clip_offset_frames: 0,
                clip_length_frames: 1000,
                gain,
                fade_in_frames: fade_in,
                fade_out_frames: fade_out,
                fade_in_curve: curve,
                fade_out_curve: curve,
            },
            asset: Arc::new(PcmAsset { sample_rate: 48_000, channels: 1, samples: vec![0.5; 2000] }),
        }
    }

    #[test]
    fn gain_fades_and_click_guard() {
        let w = window(2.0, 0, 0, 0);
        let mut buf = vec![0.0f32; 2 * 2000];
        w.render(&mut buf, 0, 2000, 48_000.0);
        assert_eq!(buf[2 * 99], 0.0);
        assert_eq!(buf[2 * 100], 0.0); // click guard starts at zero
        assert_eq!(buf[2 * 600], 1.0);
        assert_eq!(buf[2 * 600 + 1], 1.0); // mono duplicated
        assert_eq!(buf[2 * 1100], 0.0);
        let f = window(1.0, 500, 500, 1);
        let mut buf = vec![0.0f32; 2 * 2000];
        f.render(&mut buf, 0, 2000, 48_000.0);
        assert!(buf[2 * 350] < buf[2 * 599]);
        for curve in 0..5 {
            assert_eq!(fade_shape(curve, 0.0), 0.0);
            assert!((fade_shape(curve, 1.0) - 1.0).abs() < 1e-15);
        }
    }
}

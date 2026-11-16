//! Tempo map (docs/TEMPO_MAP.md): native/include/garak/tempo.hpp, which mirrors
//! src/core/tempoMap.ts. Event frames arrive already compiled through the TS map; the engine needs
//! it for the tempo at the playhead (tempo-synced effects) and, later, the plug-in transport.

use alloc::vec::Vec;

use crate::math;
use crate::plan::TempoPoint;

#[derive(Clone, Debug)]
pub struct TempoMap {
    points: Vec<TempoPoint>,
    seconds: Vec<f64>,
    slopes: Vec<f64>,
}

fn clamp_bpm(bpm: f64) -> f64 {
    if bpm.is_finite() { math::std_clamp(bpm, 20.0, 400.0) } else { 120.0 }
}

fn segment_seconds(bpm: f64, slope: f64, beats: f64) -> f64 {
    if slope == 0.0 { beats * 60.0 / bpm } else { 60.0 / slope * math::log1p(slope * beats / bpm) }
}

fn segment_beats(bpm: f64, slope: f64, seconds: f64) -> f64 {
    if slope == 0.0 { seconds * bpm / 60.0 } else { bpm / slope * math::expm1(slope * seconds / 60.0) }
}

impl TempoMap {
    /// Control thread (allocates). Points after the first must be sorted and unique; others are dropped.
    pub fn new(bpm: f64, input: &[TempoPoint]) -> Self {
        let mut points = Vec::with_capacity(input.len().max(1));
        let first = input.first();
        points.push(TempoPoint {
            beat: 0.0,
            bpm: clamp_bpm(first.map_or(bpm, |p| p.bpm)),
            ramp: first.is_some_and(|p| p.ramp),
        });
        let mut last_beat = 0.0;
        for p in input.iter().skip(1) {
            if !p.beat.is_finite() || p.beat <= last_beat {
                continue;
            }
            last_beat = p.beat;
            points.push(TempoPoint { beat: p.beat, bpm: clamp_bpm(p.bpm), ramp: p.ramp });
        }
        let mut seconds = Vec::with_capacity(points.len());
        let mut slopes = Vec::with_capacity(points.len());
        seconds.push(0.0);
        for (i, p) in points.iter().enumerate() {
            let next = points.get(i + 1);
            let slope = match next {
                Some(n) if p.ramp => (n.bpm - p.bpm) / (n.beat - p.beat),
                _ => 0.0,
            };
            slopes.push(slope);
            if let Some(n) = next {
                let at = seconds.last().copied().unwrap_or(0.0);
                seconds.push(at + segment_seconds(p.bpm, slope, n.beat - p.beat));
            }
        }
        Self { points, seconds, slopes }
    }

    fn first(&self) -> TempoPoint {
        self.points.first().copied().unwrap_or(TempoPoint { beat: 0.0, bpm: 120.0, ramp: false })
    }

    fn segment_at(&self, beat: f64) -> usize {
        // Last point with point.beat <= beat (binary search exactly like tempo.hpp).
        let (mut lo, mut hi) = (0usize, self.points.len().saturating_sub(1));
        while lo < hi {
            let mid = (lo + hi).div_ceil(2);
            if self.points.get(mid).is_some_and(|p| p.beat <= beat) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        lo
    }

    pub fn bpm_at(&self, beat: f64) -> f64 {
        if beat.is_nan() || beat <= 0.0 {
            return self.first().bpm;
        }
        let i = self.segment_at(beat);
        let p = self.points.get(i).copied().unwrap_or(self.first());
        p.bpm + self.slopes.get(i).copied().unwrap_or(0.0) * (beat - p.beat)
    }

    pub fn seconds_at(&self, beat: f64) -> f64 {
        if beat <= 0.0 {
            return beat * 60.0 / self.first().bpm;
        }
        let i = self.segment_at(beat);
        let p = self.points.get(i).copied().unwrap_or(self.first());
        self.seconds.get(i).copied().unwrap_or(0.0)
            + segment_seconds(p.bpm, self.slopes.get(i).copied().unwrap_or(0.0), beat - p.beat)
    }

    pub fn beat_at(&self, seconds: f64) -> f64 {
        if seconds <= 0.0 {
            return seconds * self.first().bpm / 60.0;
        }
        let (mut lo, mut hi) = (0usize, self.points.len().saturating_sub(1));
        while lo < hi {
            let mid = (lo + hi).div_ceil(2);
            if self.seconds.get(mid).is_some_and(|&s| s <= seconds) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        let p = self.points.get(lo).copied().unwrap_or(self.first());
        p.beat
            + segment_beats(
                p.bpm,
                self.slopes.get(lo).copied().unwrap_or(0.0),
                seconds - self.seconds.get(lo).copied().unwrap_or(0.0),
            )
    }

    pub fn frame_at(&self, beat: f64, sample_rate: f64) -> f64 {
        self.seconds_at(beat) * sample_rate
    }

    pub fn beat_at_frame(&self, frame: f64, sample_rate: f64) -> f64 {
        self.beat_at(frame / sample_rate)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_ramp_and_step_segments_round_trip() {
        let map = TempoMap::new(
            120.0,
            &[
                TempoPoint { beat: 0.0, bpm: 120.0, ramp: true },
                TempoPoint { beat: 8.0, bpm: 180.0, ramp: false },
                TempoPoint { beat: 16.0, bpm: 90.0, ramp: false },
            ],
        );
        assert_eq!(map.bpm_at(0.0), 120.0);
        assert!((map.bpm_at(4.0) - 150.0).abs() < 1e-12);
        assert_eq!(map.bpm_at(10.0), 180.0);
        assert_eq!(map.bpm_at(20.0), 90.0);
        for beat in [0.5, 3.0, 7.9, 8.0, 12.5, 30.0] {
            let s = map.seconds_at(beat);
            assert!((map.beat_at(s) - beat).abs() < 1e-9, "{beat}");
        }
        let flat = TempoMap::new(100.0, &[]);
        assert!((flat.frame_at(4.0, 48_000.0) - 115_200.0).abs() < 1e-9);
    }
}

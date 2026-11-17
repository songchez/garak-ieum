//! Parametric EQ ("Curve 8") and sweep filter: the former C++ EQ (0.3.2) `BiquadChain`,
//! `configureEq`, `configureSweep` (= src/devices/effects/eqModel.ts stage layout).

use super::Kernel;
use crate::biquad::{Biquad, FilterType};
use crate::gain::db_to_gain;
use crate::math;
use crate::params::{EQ, FILTER, ParamSet, index_of};
use crate::{PI, clamp};

pub const SLOTS: usize = 32;
const BANDS: usize = 8;
const STAGES_PER_BAND: usize = 4;

#[derive(Clone, Copy, Debug)]
struct Stage {
    kind: FilterType,
    hz: f64,
    q: f64,
    gain: f64,
}

const IDLE: Stage = Stage { kind: FilterType::Peak, hz: 1000.0, q: 1.0, gain: 0.0 };

/// Butterworth stage Qs (ascending) for 1..=4 cascaded biquads.
fn butterworth(stages: usize) -> [f64; 4] {
    let n = stages.clamp(1, 4);
    let mut q = [0.0; 4];
    for (k, v) in q.iter_mut().take(n).enumerate() {
        *v = 1.0 / (2.0 * math::cos((2 * k + 1) as f64 * PI / (4.0 * n as f64)));
    }
    // Insertion sort of the first n (std::sort in the C++).
    for i in 1..n {
        let mut j = i;
        while j > 0 {
            let (Some(&a), Some(&b)) = (q.get(j - 1), q.get(j)) else { break };
            if a <= b {
                break;
            }
            q.swap(j - 1, j);
            j -= 1;
        }
    }
    q
}

/// Low/high-pass cascade; Q is passed in dB (the persisted Web Audio unit).
fn pass_stages(
    out: &mut [Stage; STAGES_PER_BAND],
    kind: FilterType,
    hz: f64,
    resonance_q: f64,
    stages: usize,
) -> usize {
    let stages = stages.clamp(1, STAGES_PER_BAND);
    let q = butterworth(stages);
    for (k, (stage, &qk)) in out.iter_mut().zip(q.iter()).take(stages).enumerate() {
        let linear = if k + 1 == stages { qk * resonance_q / math::sqrt(0.5) } else { qk };
        *stage = Stage { kind, hz, q: 20.0 * math::log10(linear.max(1e-4)), gain: 0.0 };
    }
    stages
}

/// Parameter indices per band and field (On, Type, Freq, Gain, Q, Slope), resolved at compile time.
const fn band_ids(names: [&str; 6]) -> [usize; 6] {
    [
        index_of(EQ, names[0]),
        index_of(EQ, names[1]),
        index_of(EQ, names[2]),
        index_of(EQ, names[3]),
        index_of(EQ, names[4]),
        index_of(EQ, names[5]),
    ]
}
const EQ_IDS: [[usize; 6]; BANDS] = [
    band_ids(["b1On", "b1Type", "b1Freq", "low", "b1Q", "b1Slope"]),
    band_ids(["b2On", "b2Type", "midFreq", "mid", "b2Q", "b2Slope"]),
    band_ids(["b3On", "b3Type", "b3Freq", "high", "b3Q", "b3Slope"]),
    band_ids(["b4On", "b4Type", "b4Freq", "b4Gain", "b4Q", "b4Slope"]),
    band_ids(["b5On", "b5Type", "b5Freq", "b5Gain", "b5Q", "b5Slope"]),
    band_ids(["b6On", "b6Type", "b6Freq", "b6Gain", "b6Q", "b6Slope"]),
    band_ids(["b7On", "b7Type", "b7Freq", "b7Gain", "b7Q", "b7Slope"]),
    band_ids(["b8On", "b8Type", "b8Freq", "b8Gain", "b8Q", "b8Slope"]),
];
// Compile-time check (indexing here can only fail the build).
#[allow(clippy::indexing_slicing)]
const _: () = {
    let mut b = 0;
    while b < BANDS {
        let mut f = 0;
        while f < 6 {
            assert!(EQ_IDS[b][f] < EQ.len(), "EQ parameter id missing from the catalog");
            f += 1;
        }
        b += 1;
    }
};
const EQ_OUTPUT: usize = index_of(EQ, "output");
const F_CUTOFF: usize = index_of(FILTER, "cutoff");
const F_RESONANCE: usize = index_of(FILTER, "resonance");
const F_MODE: usize = index_of(FILTER, "mode");
const F_SLOPE: usize = index_of(FILTER, "slope");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Layout {
    Eq,
    Sweep,
}

/// A fixed number of biquad slots processed in order; only the used ones run. Slots keep their
/// history across parameter edits; running stages glide, newly used stages start on their response.
#[derive(Clone, Debug)]
pub struct BiquadChain {
    sample_rate: f64,
    layout: Layout,
    filters: [Biquad; SLOTS],
    used: [bool; SLOTS],
    output_gain: f64,
}

impl BiquadChain {
    fn empty(sample_rate: f64, layout: Layout) -> Self {
        Self {
            sample_rate,
            layout,
            filters: core::array::from_fn(|_| Biquad::new()),
            used: [false; SLOTS],
            output_gain: 1.0,
        }
    }

    pub fn eq(sample_rate: f64, p: &ParamSet) -> Self {
        let mut s = Self::empty(sample_rate, Layout::Eq);
        s.configure_eq(p, false);
        s
    }

    pub fn sweep(sample_rate: f64, p: &ParamSet) -> Self {
        let mut s = Self::empty(sample_rate, Layout::Sweep);
        s.configure_sweep(p, false);
        s
    }

    fn set_stage(&mut self, slot: usize, stage: Stage, glide: bool) {
        let sr = self.sample_rate;
        let running = self.used.get(slot).copied().unwrap_or(false);
        if let Some(f) = self.filters.get_mut(slot) {
            if glide && running {
                f.retarget(stage.kind, sr, stage.hz, stage.q, stage.gain);
            } else {
                f.configure(stage.kind, sr, stage.hz, stage.q, stage.gain);
            }
        }
    }

    fn configure_eq(&mut self, p: &ParamSet, glide: bool) {
        let sr = self.sample_rate;
        let mut used = [false; SLOTS];
        for (b, ids) in EQ_IDS.iter().enumerate() {
            let [on, kind, freq, gain, q, slope] = *ids;
            if math::round(p.get(on)) != 1.0 {
                continue; // 0 unused, 2 bypassed
            }
            let hz = clamp(p.get(freq), 10.0, sr * 0.45);
            let (gain, q) = (p.get(gain), p.get(q));
            let slope = math::round(p.get(slope)) as usize;
            let mut stages = [IDLE; STAGES_PER_BAND];
            let mut count = 1;
            match math::round(p.get(kind)) as i32 {
                0 => stages[0] = Stage { kind: FilterType::Peak, hz, q, gain },
                1 => stages[0] = Stage { kind: FilterType::LowShelf, hz, q: 1.0, gain },
                2 => stages[0] = Stage { kind: FilterType::HighShelf, hz, q: 1.0, gain },
                3 => count = pass_stages(&mut stages, FilterType::Highpass, hz, q, slope + 1),
                4 => count = pass_stages(&mut stages, FilterType::Lowpass, hz, q, slope + 1),
                _ => stages[0] = Stage { kind: FilterType::Notch, hz, q, gain: 0.0 },
            }
            for (s, stage) in stages.iter().take(count).enumerate() {
                let slot = b * STAGES_PER_BAND + s;
                self.set_stage(slot, *stage, glide);
                if let Some(u) = used.get_mut(slot) {
                    *u = true;
                }
            }
        }
        self.used = used;
        self.output_gain = db_to_gain(p.get(EQ_OUTPUT));
    }

    fn configure_sweep(&mut self, p: &ParamSet, glide: bool) {
        let stages = [1usize, 2, 4].get(math::round(p.get(F_SLOPE)) as usize).copied().unwrap_or(1);
        let mode = math::round(p.get(F_MODE)) as u32;
        let (hz, resonance) = (p.get(F_CUTOFF), p.get(F_RESONANCE));
        let mut s = [IDLE; STAGES_PER_BAND];
        let kind = if mode == 0 { FilterType::Lowpass } else { FilterType::Highpass };
        if mode == 2 {
            for stage in s.iter_mut().take(stages) {
                *stage = Stage { kind: FilterType::Bandpass, hz, q: resonance, gain: 0.0 };
            }
        } else if stages == 1 {
            s[0] = Stage { kind, hz, q: resonance, gain: 0.0 };
        } else {
            // The default resonance 0.7 is flat.
            pass_stages(&mut s, kind, hz, math::sqrt(0.5) * db_to_gain(resonance - 0.7), stages);
        }
        for k in 0..SLOTS {
            if k < stages
                && let Some(stage) = s.get(k)
            {
                self.set_stage(k, *stage, glide);
            }
            if let Some(u) = self.used.get_mut(k) {
                *u = k < stages;
            }
        }
    }

    pub fn take_state_from(&mut self, p: &mut Self) -> bool {
        for ((f, used), (pf, pused)) in
            self.filters.iter_mut().zip(self.used.iter()).zip(p.filters.iter().zip(p.used.iter()))
        {
            if *used && *pused {
                f.take_history_from(pf);
            }
        }
        false
    }

    /// Filters in use (for tests).
    pub fn active_stages(&self) -> usize {
        self.used.iter().filter(|u| **u).count()
    }
}

impl Kernel for BiquadChain {
    fn automate(&mut self, p: &ParamSet) {
        match self.layout {
            Layout::Eq => self.configure_eq(p, true),
            Layout::Sweep => self.configure_sweep(p, true),
        }
    }

    #[inline(always)]
    fn frame(&mut self, mut l: f32, mut r: f32) -> (f32, f32) {
        for (f, used) in self.filters.iter_mut().zip(self.used.iter()) {
            if *used {
                l = f.sample(l, 0);
                r = f.sample(r, 1);
            }
        }
        if self.output_gain != 1.0 {
            l = (f64::from(l) * self.output_gain) as f32;
            r = (f64::from(r) * self.output_gain) as f32;
        }
        (l, r)
    }

    /// Filter-major like the C++ chain (same result as frame-major; each stage is independent).
    #[inline(never)]
    fn process_interleaved(&mut self, s: &mut [f32]) {
        let frames = s.as_chunks_mut::<2>().0;
        for (f, used) in self.filters.iter_mut().zip(self.used.iter()) {
            if *used {
                for [l, r] in frames.iter_mut() {
                    *l = f.sample(*l, 0);
                    *r = f.sample(*r, 1);
                }
            }
        }
        if self.output_gain != 1.0 {
            for x in frames.as_flattened_mut() {
                *x = (f64::from(*x) * self.output_gain) as f32;
            }
        }
    }

    #[inline(never)]
    fn process_planar(&mut self, left: &mut [f32], right: &mut [f32]) {
        for (f, used) in self.filters.iter_mut().zip(self.used.iter()) {
            if *used {
                for (l, r) in left.iter_mut().zip(right.iter_mut()) {
                    *l = f.sample(*l, 0);
                    *r = f.sample(*r, 1);
                }
            }
        }
        if self.output_gain != 1.0 {
            let n = left.len().min(right.len());
            for x in left.iter_mut().take(n).chain(right.iter_mut().take(n)) {
                *x = (f64::from(*x) * self.output_gain) as f32;
            }
        }
    }

    fn reset(&mut self) {
        for f in &mut self.filters {
            f.reset();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::params::EffectKind;

    #[test]
    fn butterworth_table_is_ascending() {
        let q = butterworth(4);
        assert!(q[0] < q[1] && q[1] < q[2] && q[2] < q[3]);
        assert!((butterworth(1)[0] - math::sqrt(0.5)).abs() < 1e-12);
    }

    #[test]
    fn default_eq_uses_three_bands_and_sweep_follows_slope() {
        let eq = BiquadChain::eq(48_000.0, &ParamSet::defaults(EffectKind::Eq));
        assert_eq!(eq.active_stages(), 3);
        let mut p = ParamSet::defaults(EffectKind::Filter);
        p.set(F_SLOPE, 2.0);
        assert_eq!(BiquadChain::sweep(48_000.0, &p).active_stages(), 4);
    }
}

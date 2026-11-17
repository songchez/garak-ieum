//! IEUM WAVE wavetables (native/devices/wavetable-synth/src/wavetable.cpp): band-limited mip
//! levels made once on the control thread with the original radix-2 FFT (same operation order as
//! `std::complex<double>`), mip selection, and the cubic table reader of the audio thread.

use alloc::vec;
use alloc::vec::Vec;

use super::math::{PI, TAU, asin, clampd, clampf, cos, cubic, finite_or, lerp, sin, wrap_phase};
use super::schema as g;
use crate::error::Error;

pub const PLAYBACK_TABLE_SIZE: usize = 4096;
pub const MIP_LEVELS: usize = 10;
pub const HARMONIC_LIMITS: [u32; MIP_LEVELS] = [1023, 511, 255, 127, 63, 31, 15, 7, 3, 1];
const STRIDE: usize = PLAYBACK_TABLE_SIZE + 3;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MipSelection {
    pub level: u32,
    pub blend: f32,
}

/// wavetable.cpp `selectMip`.
pub fn select_mip(frequency: f64, sample_rate: f64) -> MipSelection {
    let f = frequency.abs() / sample_rate;
    let limit = |l: u32| f64::from(HARMONIC_LIMITS.get(l as usize).copied().unwrap_or(1));
    let mut level = 0u32;
    while (level as usize) + 1 < MIP_LEVELS && f * limit(level) > 0.46 {
        level += 1;
    }
    if level as usize + 1 == MIP_LEVELS {
        return MipSelection { level, blend: 0.0 };
    }
    let upper = 0.46 / limit(level);
    let lower = if level == 0 { upper * 0.5 } else { 0.46 / limit(level - 1) };
    MipSelection { level, blend: clampd((f - lower) / (upper - lower), 0.0, 1.0) as f32 }
}

#[derive(Clone, Copy, Debug, Default)]
struct Complex {
    re: f64,
    im: f64,
}

impl Complex {
    #[inline(always)]
    fn mul(self, o: Complex) -> Complex {
        Complex { re: self.re * o.re - self.im * o.im, im: self.re * o.im + self.im * o.re }
    }
}

/// The original iterative radix-2 transform (control thread only).
fn fft(values: &mut [Complex], inverse: bool) {
    let count = values.len();
    let mut j = 0usize;
    for i in 1..count {
        let mut bit = count >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            values.swap(i, j);
        }
    }
    let mut length = 2;
    while length <= count {
        let angle = (if inverse { TAU } else { -TAU }) / length as f64;
        let rotation = Complex { re: cos(angle), im: sin(angle) };
        let mut start = 0;
        while start < count {
            let mut phase = Complex { re: 1.0, im: 0.0 };
            for k in 0..length / 2 {
                let (a, b) = (start + k, start + k + length / 2);
                let (Some(&even), Some(&o)) = (values.get(a), values.get(b)) else { break };
                let odd = o.mul(phase);
                if let Some(v) = values.get_mut(a) {
                    *v = Complex { re: even.re + odd.re, im: even.im + odd.im };
                }
                if let Some(v) = values.get_mut(b) {
                    *v = Complex { re: even.re - odd.re, im: even.im - odd.im };
                }
                phase = phase.mul(rotation);
            }
            start += length;
        }
        length <<= 1;
    }
    if inverse {
        let n = count as f64;
        for v in values.iter_mut() {
            v.re /= n;
            v.im /= n;
        }
    }
}

/// Two adjacent frames of one mip set and the crossfade between them (`FrameView`).
#[derive(Clone, Copy, Debug, Default)]
pub struct FrameView {
    /// Offsets into the table data (None: no table).
    pub first: Option<usize>,
    pub second: usize,
    pub mix: f32,
}

/// One bank: frames x mip levels of 4096 + 3 guard samples (wavetable.hpp `PreparedWavetable`).
#[derive(Clone, Debug, Default)]
pub struct PreparedWavetable {
    frames: usize,
    data: Vec<f32>,
}

impl PreparedWavetable {
    pub fn empty(&self) -> bool {
        self.frames == 0
    }

    /// wavetable.cpp `PreparedWavetable::prepare`: DC removal, one peak gain for the bank, then
    /// band-limited mips by zero-padded inverse FFT.
    pub fn prepare(frames: &[f32], frame_count: usize) -> Result<Self, Error> {
        const SIZE: usize = g::WAVETABLE_SIZE;
        if frame_count == 0 || frame_count > g::MAX_FRAMES || frames.len() < frame_count * SIZE {
            return Err(Error::new("Wavetable requires 1..16 frames of 2048 finite samples"));
        }
        let mut source = vec![0.0f64; frame_count * SIZE];
        let mut peak = 0.0f64;
        for frame in 0..frame_count {
            let input = frames.get(frame * SIZE..(frame + 1) * SIZE).unwrap_or(&[]);
            let mut mean = 0.0f64;
            for &sample in input {
                if !sample.is_finite() || sample.abs() > 32.0 {
                    return Err(Error::new("Invalid wavetable sample"));
                }
                mean += f64::from(sample);
            }
            mean /= SIZE as f64;
            for (out, &sample) in
                source.get_mut(frame * SIZE..(frame + 1) * SIZE).unwrap_or(&mut []).iter_mut().zip(input)
            {
                let value = f64::from(sample) - mean;
                *out = value;
                peak = if peak < value.abs() { value.abs() } else { peak };
            }
        }
        let gain = if peak > 1.0e-12 { 1.0 / peak } else { 0.0 };
        let mut prepared = vec![0.0f32; frame_count * MIP_LEVELS * STRIDE];
        let mut spectrum = vec![Complex::default(); SIZE];
        let mut work = vec![Complex::default(); PLAYBACK_TABLE_SIZE];
        for frame in 0..frame_count {
            for (s, &v) in
                spectrum.iter_mut().zip(source.get(frame * SIZE..(frame + 1) * SIZE).unwrap_or(&[]))
            {
                *s = Complex { re: v * gain, im: 0.0 };
            }
            fft(&mut spectrum, false);
            for (level, &limit) in HARMONIC_LIMITS.iter().enumerate() {
                work.fill(Complex::default());
                for h in 1..=limit as usize {
                    // Zero-padding doubles the cycle resolution without changing its spectrum.
                    if let (Some(w), Some(s)) = (work.get_mut(h), spectrum.get(h)) {
                        *w = Complex { re: s.re * 2.0, im: s.im * 2.0 };
                    }
                    if let (Some(w), Some(s)) =
                        (work.get_mut(PLAYBACK_TABLE_SIZE - h), spectrum.get(SIZE - h))
                    {
                        *w = Complex { re: s.re * 2.0, im: s.im * 2.0 };
                    }
                }
                fft(&mut work, true);
                let base = (frame * MIP_LEVELS + level) * STRIDE;
                if let Some(table) = prepared.get_mut(base..base + STRIDE) {
                    for (t, w) in table.iter_mut().skip(1).zip(work.iter()) {
                        *t = w.re as f32;
                    }
                    let wrap = |t: &[f32], i: usize| t.get(i).copied().unwrap_or(0.0);
                    let (end, one, two) = (wrap(table, PLAYBACK_TABLE_SIZE), wrap(table, 1), wrap(table, 2));
                    if let Some(t) = table.get_mut(0) {
                        *t = end;
                    }
                    if let Some(t) = table.get_mut(PLAYBACK_TABLE_SIZE + 1) {
                        *t = one;
                    }
                    if let Some(t) = table.get_mut(PLAYBACK_TABLE_SIZE + 2) {
                        *t = two;
                    }
                }
            }
        }
        Ok(Self { frames: frame_count, data: prepared })
    }

    /// `frameView`: the two frames around `position` (0..1).
    #[inline]
    pub fn frame_view(&self, position: f32) -> FrameView {
        if self.frames == 0 {
            return FrameView::default();
        }
        let point = clampf(position, 0.0, 1.0) * (self.frames - 1) as f32;
        let first = point as usize;
        let second = (first + 1).min(self.frames - 1);
        FrameView {
            first: Some(first * MIP_LEVELS * STRIDE),
            second: second * MIP_LEVELS * STRIDE,
            mix: point - first as f32,
        }
    }

    /// `readView` (phase in [0, 1), mip from `select_mip`).
    #[inline]
    pub fn read_view(&self, view: FrameView, phase: f64, mip: MipSelection) -> f32 {
        let Some(first) = view.first else { return 0.0 };
        let point = phase * PLAYBACK_TABLE_SIZE as f64;
        let index = point as usize;
        let frac = (point - index as f64) as f32;
        let level_offset = mip.level as usize * STRIDE + index;
        let d = &self.data;
        let sample = |at: usize| match d.get(at..at + 4) {
            Some(&[p0, p1, p2, p3]) => cubic(p0, p1, p2, p3, frac),
            _ => 0.0,
        };
        let mut a = sample(first + level_offset);
        if view.mix != 0.0 {
            a = lerp(a, sample(view.second + level_offset), view.mix);
        }
        if mip.blend <= 0.0 || mip.level as usize + 1 == MIP_LEVELS {
            return a;
        }
        let mut b = sample(first + level_offset + STRIDE);
        if view.mix != 0.0 {
            b = lerp(b, sample(view.second + level_offset + STRIDE), view.mix);
        }
        lerp(a, b, mip.blend)
    }

    /// `read`: arbitrary phase / position inputs.
    pub fn read(&self, phase: f64, position: f32, mut mip: MipSelection) -> f32 {
        if !phase.is_finite() || !position.is_finite() {
            return 0.0;
        }
        mip.level = mip.level.min(MIP_LEVELS as u32 - 1);
        mip.blend = clampf(finite_or(mip.blend, 0.0), 0.0, 1.0);
        self.read_view(self.frame_view(position), wrap_phase(phase), mip)
    }
}

/// Every bank a synth may read: four factory banks, four user slots, two sub shapes (immutable
/// once prepared; shared between instances).
#[derive(Debug)]
pub struct PreparedWavetableSet {
    banks: [PreparedWavetable; g::FACTORY_BANK_COUNT + g::MAX_USER_BANKS],
    sub: [PreparedWavetable; 2],
}

impl PreparedWavetableSet {
    /// The factory banks from their harmonic tables, and the sine / triangle sub (wavetable.cpp).
    #[inline(never)]
    pub fn new() -> Result<Self, Error> {
        let mut banks: [PreparedWavetable; 8] = Default::default();
        let mut samples = vec![0.0f32; g::FACTORY_FRAMES * g::WAVETABLE_SIZE];
        for (bank, slot) in banks.iter_mut().take(g::FACTORY_BANK_COUNT).enumerate() {
            let harmonics = g::FACTORY_HARMONICS.get(bank).ok_or_else(|| Error::new("factory bank"))?;
            for (frame, h) in harmonics.iter().enumerate() {
                for i in 0..g::WAVETABLE_SIZE {
                    let mut value = 0.0f64;
                    let phase = TAU * i as f64 / g::WAVETABLE_SIZE as f64;
                    for (k, &amp) in h.iter().enumerate() {
                        value += f64::from(amp) * sin(phase * (k + 1) as f64);
                    }
                    if let Some(s) = samples.get_mut(frame * g::WAVETABLE_SIZE + i) {
                        *s = value as f32;
                    }
                }
            }
            *slot = PreparedWavetable::prepare(&samples, g::FACTORY_FRAMES)?;
        }
        let mut sub: [PreparedWavetable; 2] = Default::default();
        for (shape, slot) in sub.iter_mut().enumerate() {
            for (i, s) in samples.iter_mut().take(g::WAVETABLE_SIZE).enumerate() {
                let sine = sin(TAU * i as f64 / g::WAVETABLE_SIZE as f64);
                *s = (if shape == 0 { sine } else { (2.0 / PI) * asin(sine) }) as f32;
            }
            *slot = PreparedWavetable::prepare(&samples, 1)?;
        }
        Ok(Self { banks, sub })
    }

    pub fn set_custom(&mut self, slot: u32, samples: &[f32], frames: usize) -> Result<(), Error> {
        let s = slot as usize;
        if s < g::FACTORY_BANK_COUNT || s >= self.banks.len() {
            return Err(Error::new("Custom wavetable slot must be 4..7"));
        }
        if let Some(b) = self.banks.get_mut(s) {
            *b = PreparedWavetable::prepare(samples, frames)?;
        }
        Ok(())
    }

    pub fn has_bank(&self, slot: u32) -> bool {
        self.banks.get(slot as usize).is_some_and(|b| !b.empty())
    }

    /// The bank in `slot` (bank 0 when missing, like the C++ defensive fallback).
    pub fn bank(&self, slot: u32) -> &PreparedWavetable {
        match self.banks.get(slot as usize) {
            Some(b) if !b.empty() => b,
            _ => self.banks.first().unwrap_or(&EMPTY),
        }
    }

    pub fn sub(&self, triangle: bool) -> &PreparedWavetable {
        self.sub.get(usize::from(triangle)).unwrap_or(&EMPTY)
    }
}

static EMPTY: PreparedWavetable = PreparedWavetable { frames: 0, data: Vec::new() };

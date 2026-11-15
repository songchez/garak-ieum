//! Built-in effects (native `makeEffect` types): the 시김새 kernels (delay, chorus, phaser,
//! flanger, tremolo, limiter, gate, tape, bitcrusher, utility), parametric EQ and sweep filter,
//! compressor, drive and reverb. Each mirrors its C++ class structure (state, order of operations,
//! float rounding points); see the module docs for the source of each.
//!
//! Real-time contract: [`Fx::new`] runs on the control thread and only *borrows* caller storage
//! (sized by [`Fx::storage_len`]); every other method is allocation-free and panic-free.
//! Parameters live in a [`ParamSet`] in catalog order: [`Fx::automate`] re-reads them in place
//! (new targets glide like the worklet's `configure()` / C++ `automate()`).

pub mod color;
pub mod delay;
pub mod dynamics;
pub mod eq;
pub mod modulation;
pub mod reverb;

use crate::Utility;
use crate::lines::Carver;
use crate::params::{EffectKind, ParamSet};
use color::{Bitcrusher, Drive, Tape};
use delay::StudioDelay;
use dynamics::{Compressor, Gate, Limiter};
use eq::BiquadChain;
use modulation::{Chorus, Flanger, Phaser, Tremolo};
use reverb::Reverb;

pub(crate) const TAU: f64 = 2.0 * crate::PI;

/// `repeats` of the tail estimates: echoes until -60 dB.
pub(crate) fn feedback_repeats(feedback: f64) -> f64 {
    if feedback > 0.01 { libm::ceil(libm::log(0.001) / libm::log(feedback)) } else { 1.0 }
}

/// What every effect implements. `frame` is the per-frame body; the block methods default to it.
pub trait Kernel {
    /// Re-read the parameters in place (C++ `StereoProcessor::automate`). Real-time safe.
    fn automate(&mut self, p: &ParamSet);
    /// Tempo at the playhead (tempo-synced delay and tremolo).
    fn set_tempo(&mut self, _bpm: f64) {}
    fn frame(&mut self, l: f32, r: f32) -> (f32, f32);
    fn reset(&mut self);
    fn latency_frames(&self) -> u32 {
        0
    }
    fn tail_seconds(&self) -> f64 {
        0.0
    }
    /// Dynamics tap: (detector peak, lowest gain) since the last call.
    fn take_meter(&mut self) -> Option<(f32, f32)> {
        None
    }
    /// Interleaved stereo in place (native layout); a trailing odd sample is left alone.
    fn process_interleaved(&mut self, s: &mut [f32]) {
        for [l, r] in s.as_chunks_mut::<2>().0 {
            (*l, *r) = self.frame(*l, *r);
        }
    }
    /// Planar stereo in place (Web Audio layout), `min(left.len(), right.len())` frames.
    fn process_planar(&mut self, left: &mut [f32], right: &mut [f32]) {
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            (*l, *r) = self.frame(*l, *r);
        }
    }
}

#[derive(Debug)]
enum Inner<'a> {
    Delay(StudioDelay<'a>),
    Chorus(Chorus<'a>),
    Phaser(Phaser),
    Flanger(Flanger<'a>),
    Tremolo(Tremolo),
    Limiter(Limiter),
    Gate(Gate),
    Tape(Tape),
    Bitcrusher(Bitcrusher),
    Utility(Utility),
    Eq(BiquadChain),
    Filter(BiquadChain),
    Compressor(Compressor),
    Drive(Drive<'a>),
    Reverb(Reverb<'a>),
}

macro_rules! each {
    ($inner:expr, $k:ident => $body:expr) => {
        match $inner {
            Inner::Delay($k) => $body,
            Inner::Chorus($k) => $body,
            Inner::Phaser($k) => $body,
            Inner::Flanger($k) => $body,
            Inner::Tremolo($k) => $body,
            Inner::Limiter($k) => $body,
            Inner::Gate($k) => $body,
            Inner::Tape($k) => $body,
            Inner::Bitcrusher($k) => $body,
            Inner::Utility($k) => $body,
            Inner::Eq($k) => $body,
            Inner::Filter($k) => $body,
            Inner::Compressor($k) => $body,
            Inner::Drive($k) => $body,
            Inner::Reverb($k) => $body,
        }
    };
}

/// Why [`Fx::new`] refused (C++ `makeEffect` throws for the same conditions).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FxError {
    /// Sample rate outside 8-192 kHz or tempo outside 20-400 BPM.
    Rate,
    /// Caller storage shorter than [`Fx::storage_len`].
    Storage,
    /// Reverb kernels missing or shorter than `reverb::kernel_len(ir_len)`.
    Kernels,
}

/// One built-in effect over caller storage.
#[derive(Debug)]
pub struct Fx<'a> {
    kind: EffectKind,
    params: ParamSet,
    dirty: bool,
    inner: Inner<'a>,
}

impl<'a> Fx<'a> {
    /// State storage floats for `kind` at `sample_rate` (`ir_len`: reverb impulse frames, else
    /// ignored). Zero for kinds without delay lines.
    pub fn storage_len(kind: EffectKind, sample_rate: f64, ir_len: usize) -> usize {
        match kind {
            EffectKind::Delay => StudioDelay::storage_len(sample_rate),
            EffectKind::Chorus => Chorus::storage_len(sample_rate),
            EffectKind::Flanger => Flanger::storage_len(sample_rate),
            EffectKind::Drive => Drive::storage_len(),
            EffectKind::Reverb => reverb::state_len(sample_rate, ir_len),
            _ => 0,
        }
    }

    /// C++ `makeEffect(kind.id(), params, sample_rate, bpm)`. `values` are in catalog order
    /// (`kind.params()`); missing ones take the default, non-finite ones are ignored, the rest is
    /// clamped. `kernels` / `ir_len`: reverb only (see [`reverb::prepare_kernels`]).
    pub fn new(
        kind: EffectKind,
        sample_rate: f64,
        bpm: f64,
        values: &[f64],
        storage: &'a mut [f32],
        kernels: &'a [f32],
        ir_len: usize,
    ) -> Result<Self, FxError> {
        if !(8000.0..=192_000.0).contains(&sample_rate) || !(20.0..=400.0).contains(&bpm) {
            return Err(FxError::Rate);
        }
        let params = ParamSet::from_values(kind, values);
        let p = &params;
        let sr = sample_rate;
        if storage.len() < Self::storage_len(kind, sr, ir_len) {
            return Err(FxError::Storage);
        }
        if kind == EffectKind::Reverb && (ir_len == 0 || !Reverb::kernels_fit(kernels, ir_len)) {
            return Err(FxError::Kernels);
        }
        let mut carver = Carver::new(storage);
        let c = &mut carver;
        let inner = match kind {
            EffectKind::Delay => Inner::Delay(StudioDelay::new(sr, bpm, p, c)),
            EffectKind::Chorus => Inner::Chorus(Chorus::new(sr, p, c)),
            EffectKind::Phaser => Inner::Phaser(Phaser::new(sr, p)),
            EffectKind::Flanger => Inner::Flanger(Flanger::new(sr, p, c)),
            EffectKind::Tremolo => Inner::Tremolo(Tremolo::new(sr, bpm, p)),
            EffectKind::Limiter => Inner::Limiter(Limiter::new(sr, p)),
            EffectKind::Gate => Inner::Gate(Gate::new(sr, p)),
            EffectKind::Tape => Inner::Tape(Tape::new(sr, p)),
            EffectKind::Bitcrusher => Inner::Bitcrusher(Bitcrusher::new(sr, p)),
            EffectKind::Utility => Inner::Utility(Utility::with_params(sr, p)),
            EffectKind::Eq => Inner::Eq(BiquadChain::eq(sr, p)),
            EffectKind::Filter => Inner::Filter(BiquadChain::sweep(sr, p)),
            EffectKind::Compressor => Inner::Compressor(Compressor::new(sr, p)),
            EffectKind::Drive => Inner::Drive(Drive::new(sr, p, c)),
            EffectKind::Reverb => Inner::Reverb(Reverb::new(sr, p, kernels, ir_len, c)),
        };
        if !carver.ok() {
            return Err(FxError::Storage);
        }
        Ok(Self { kind, params, dirty: false, inner })
    }

    pub fn kind(&self) -> EffectKind {
        self.kind
    }

    pub fn param(&self, index: usize) -> f64 {
        self.params.get(index)
    }

    /// Stage one parameter (clamped; non-finite ignored). [`Fx::commit`] applies staged changes.
    pub fn set_param(&mut self, index: usize, value: f64) {
        self.dirty |= self.params.set(index, value);
    }

    /// Applies staged parameter changes (EffectControl::apply: only when something changed).
    pub fn commit(&mut self) {
        if self.dirty {
            self.dirty = false;
            let p = &self.params;
            each!(&mut self.inner, k => k.automate(p));
        }
    }

    /// All parameters at once, then `automate` (C++ `StereoProcessor::automate(Reader)`).
    pub fn automate(&mut self, values: &[f64]) {
        for (i, &v) in values.iter().enumerate() {
            self.params.set(i, v);
        }
        self.dirty = false;
        let p = &self.params;
        each!(&mut self.inner, k => k.automate(p));
    }

    pub fn set_tempo(&mut self, bpm: f64) {
        each!(&mut self.inner, k => k.set_tempo(bpm));
    }

    pub fn process_interleaved(&mut self, stereo: &mut [f32]) {
        each!(&mut self.inner, k => k.process_interleaved(stereo));
    }

    pub fn process_planar(&mut self, left: &mut [f32], right: &mut [f32]) {
        each!(&mut self.inner, k => k.process_planar(left, right));
    }

    pub fn reset(&mut self) {
        each!(&mut self.inner, k => k.reset());
    }

    pub fn latency_frames(&self) -> u32 {
        each!(&self.inner, k => k.latency_frames())
    }

    pub fn tail_seconds(&self) -> f64 {
        each!(&self.inner, k => k.tail_seconds())
    }

    /// (peak, lowest gain) since the last call for compressor, limiter and gate.
    pub fn take_meter(&mut self) -> Option<(f32, f32)> {
        each!(&mut self.inner, k => k.take_meter())
    }

    /// C++ `takeStateFrom`: adopt `previous`'s audio history and current (smoothed) values so the
    /// new targets glide in. Returns true when the two effects swapped their *entire* state
    /// storage (O(1) hand-over); the owner must then swap the storage buffers as well. Different
    /// kinds are ignored (false).
    pub fn take_state_from(&mut self, previous: &mut Fx<'a>) -> bool {
        match (&mut self.inner, &mut previous.inner) {
            (Inner::Delay(a), Inner::Delay(b)) => a.take_state_from(b),
            (Inner::Chorus(a), Inner::Chorus(b)) => a.take_state_from(b),
            (Inner::Phaser(a), Inner::Phaser(b)) => a.take_state_from(b),
            (Inner::Flanger(a), Inner::Flanger(b)) => a.take_state_from(b),
            (Inner::Tremolo(a), Inner::Tremolo(b)) => a.take_state_from(b),
            (Inner::Limiter(a), Inner::Limiter(b)) => a.take_state_from(b),
            (Inner::Gate(a), Inner::Gate(b)) => a.take_state_from(b),
            (Inner::Tape(a), Inner::Tape(b)) => a.take_state_from(b),
            (Inner::Bitcrusher(a), Inner::Bitcrusher(b)) => a.take_state_from(b),
            (Inner::Utility(a), Inner::Utility(b)) => a.take_state_from(b),
            (Inner::Eq(a), Inner::Eq(b)) | (Inner::Filter(a), Inner::Filter(b)) => a.take_state_from(b),
            (Inner::Compressor(a), Inner::Compressor(b)) => a.take_state_from(b),
            (Inner::Drive(a), Inner::Drive(b)) => a.take_state_from(b),
            (Inner::Reverb(a), Inner::Reverb(b)) => a.take_state_from(b),
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::vec;
    use std::vec::Vec;

    fn make(kind: EffectKind, storage: &mut Vec<f32>) -> Fx<'_> {
        storage.resize(Fx::storage_len(kind, 48_000.0, 0), 0.0);
        Fx::new(kind, 48_000.0, 120.0, &[], storage, &[], 0).unwrap()
    }

    #[test]
    fn every_kind_but_reverb_builds_with_defaults_and_stays_finite() {
        for kind in EffectKind::ALL {
            if kind == EffectKind::Reverb {
                continue;
            }
            let mut storage = Vec::new();
            let mut fx = make(kind, &mut storage);
            let mut buf: Vec<f32> = (0..2048).map(|i| libm::sinf(i as f32 * 0.05) * 0.8).collect();
            fx.process_interleaved(&mut buf);
            fx.set_param(0, fx.param(0) * 0.5 + 0.1);
            fx.commit();
            fx.set_tempo(97.0);
            fx.process_interleaved(&mut buf);
            assert!(buf.iter().all(|x| x.is_finite()), "{}", kind.id());
            fx.reset();
        }
    }

    #[test]
    fn short_storage_and_bad_rates_are_refused() {
        let mut storage = vec![0.0f32; 16];
        assert_eq!(
            Fx::new(EffectKind::Delay, 48_000.0, 120.0, &[], &mut storage, &[], 0).unwrap_err(),
            FxError::Storage
        );
        assert_eq!(
            Fx::new(EffectKind::Phaser, 1000.0, 120.0, &[], &mut storage, &[], 0).unwrap_err(),
            FxError::Rate
        );
        assert_eq!(
            Fx::new(EffectKind::Reverb, 48_000.0, 120.0, &[], &mut storage, &[], 0).unwrap_err(),
            FxError::Storage
        );
    }

    #[test]
    fn reverb_from_generated_ir() {
        let sr = 16_000.0;
        let space = 1;
        let len = reverb::ir_len(sr, space);
        let (mut l, mut r) = (vec![0.0f32; len], vec![0.0f32; len]);
        let mut scratch = vec![0.0f32; reverb::ir_scratch_len(sr, space)];
        assert!(reverb::generate_ir(sr, space, 0.5, &mut l, &mut r, &mut scratch));
        let mut kernels = vec![0.0f32; reverb::kernel_len(len)];
        assert!(reverb::prepare_kernels(&l, &r, len, &mut kernels));
        let mut state = vec![0.0f32; Fx::storage_len(EffectKind::Reverb, sr, len)];
        let values = [1.0, 0.5, 9000.0, 1.0, 0.0, 20.0, 0.0];
        let mut fx = Fx::new(EffectKind::Reverb, sr, 120.0, &values, &mut state, &kernels, len).unwrap();
        let mut buf = vec![0.0f32; 2 * 4000];
        buf[0] = 1.0;
        buf[1] = 1.0;
        fx.process_interleaved(&mut buf);
        let energy: f32 = buf.iter().map(|x| x * x).sum();
        assert!(energy > 0.0 && buf.iter().all(|x| x.is_finite()));
        assert!(fx.tail_seconds() > 1.0);
    }

    #[test]
    fn dynamics_report_their_meter() {
        let mut storage = Vec::new();
        let mut fx = make(EffectKind::Limiter, &mut storage);
        let mut buf = vec![2.0f32; 256];
        fx.process_interleaved(&mut buf);
        let (peak, gain) = fx.take_meter().unwrap();
        assert!(peak >= 2.0 && gain < 0.5);
        assert_eq!(fx.take_meter(), Some((0.0, 1.0)));
        let mut storage = Vec::new();
        assert_eq!(make(EffectKind::Chorus, &mut storage).take_meter(), None);
    }

    #[test]
    fn drive_reports_latency_and_delay_its_tail() {
        let mut storage = Vec::new();
        assert_eq!(make(EffectKind::Drive, &mut storage).latency_frames(), 8);
        let mut storage = Vec::new();
        assert!(make(EffectKind::Delay, &mut storage).tail_seconds() > 1.0);
    }
}

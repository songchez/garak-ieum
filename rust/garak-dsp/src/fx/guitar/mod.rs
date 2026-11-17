//! The guitar rig (`makeEffect("guitar-rig")`, native/src/dsp.cpp `GuitarRig`): a user-arranged
//! rack of up to 18 modules (compressor, drive, amp, cabinet + microphone, chorus, delay, fuzz,
//! phaser, tremolo, plate reverb, tuner), each module up to three times, run in rack order.
//!
//! Real-time contract, as for [`crate::Fx`]: [`GuitarRig::new`] runs on the control thread and
//! borrows caller storage (delay lines and reverb state, sized by [`GuitarRig::storage_len`]) and
//! reverb kernels; everything else is allocation-free and panic-free. The 18 rack positions are
//! preallocated inside the struct, so no layout can need more than the struct holds.
//!
//! The rack layout (`rackSlot*`) and each reverb's Decay and switch are structural, as in C++
//! (`liveEffectParameter`): changing them builds a new rig that adopts the old one's state with
//! [`GuitarRig::take_state_from`] (by module code and instance, so moved or added modules keep the
//! others ringing). Every other parameter follows [`GuitarRig::automate`] / `set_param` + `commit`.
//!
//! Reverb impulse responses: the plate is the reverb's hall impulse (space 0) cross-faded by
//! Decay, generated and FFT-partitioned on the control thread like a reverb's
//! ([`generate_reverb_ir`] + [`crate::fx::reverb::prepare_kernels`]); [`reverb_decays`] says which
//! reverb instances need kernels. A cached IR can be handed in the same way.

pub mod catalog;
mod modules;

use catalog::{
    CABINET, CHORUS, DELAY, FIRST_SLOT, INDEX, INSTANCE_STRIDE, MODULE_CODES, NO_OWNER, OWNER, REVERB, SLOTS,
};
pub use catalog::{MAX_INSTANCES, PARAM_COUNT, PARAMS};
use modules::{
    Amp, Cabinet, Clipper, Comp, P, RigChorus, RigDelay, RigPhaser, RigReverb, RigTremolo, run_interleaved,
    run_planar,
};

use super::FxError;
use super::reverb;
use crate::lines::Carver;
use crate::{clamp, math};

/// Reverb instances a rig can hold (one kernel set each).
pub const MAX_REVERBS: usize = MAX_INSTANCES;

/// Frames of the plate's impulse response at `sample_rate` (the hall's long variant).
pub fn reverb_ir_len(sample_rate: f64) -> usize {
    reverb::ir_len(sample_rate, 0)
}

/// Scratch floats [`generate_reverb_ir`] needs.
pub fn reverb_ir_scratch_len(sample_rate: f64) -> usize {
    reverb::ir_scratch_len(sample_rate, 0)
}

/// The plate's impulse response for `decay` (dsp.cpp `RigReverb`: `blendedKernel(sr, hall,
/// float(decay))`). `left` / `right` hold [`reverb_ir_len`] frames. False when a buffer is short.
pub fn generate_reverb_ir(
    sample_rate: f64,
    decay: f64,
    left: &mut [f32],
    right: &mut [f32],
    scratch: &mut [f32],
) -> bool {
    reverb::generate_ir(sample_rate, 0, clamp(decay, 0.0, 1.0), left, right, scratch)
}

/// `values` in catalog order: missing entries take the default, non-finite ones are ignored and
/// the rest is clamped (EffectControl / ParamSet semantics).
#[inline(never)]
pub fn sanitize(values: &[f64]) -> [f64; PARAM_COUNT] {
    let mut out = [0.0; PARAM_COUNT];
    for ((o, def), v) in out.iter_mut().zip(PARAMS).zip(values.iter().chain(core::iter::repeat(&f64::NAN))) {
        *o = if v.is_finite() { clamp(*v, def.min, def.max) } else { def.default };
    }
    out
}

/// The modules of a rack in signal order: (code, instance) per occupied slot. Empty, unknown,
/// over-limit and repeated entries are skipped (dsp.cpp `GuitarRig` constructor).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Layout {
    modules: [(u8, u8); SLOTS],
    len: usize,
}

impl Layout {
    #[inline(never)]
    pub fn from_values(values: &[f64; PARAM_COUNT]) -> Self {
        let mut seen = [[false; MAX_INSTANCES]; MODULE_CODES];
        let mut layout = Self { modules: [(0, 0); SLOTS], len: 0 };
        for slot in 0..SLOTS {
            let raw = values.get(FIRST_SLOT + slot).copied().unwrap_or(0.0);
            let value = math::round(raw) as i64;
            if value <= 0 {
                continue;
            }
            let (code, instance) =
                ((value % INSTANCE_STRIDE as i64) as usize, (value / INSTANCE_STRIDE as i64) as usize);
            if !(1..MODULE_CODES).contains(&code) || instance >= catalog::max_instances(code) {
                continue;
            }
            let Some(flag) = seen.get_mut(code).and_then(|s| s.get_mut(instance)) else { continue };
            if *flag {
                continue;
            }
            *flag = true;
            if let Some(m) = layout.modules.get_mut(layout.len) {
                *m = (code as u8, instance as u8);
                layout.len += 1;
            }
        }
        layout
    }

    /// (code, instance) in signal order.
    pub fn modules(&self) -> &[(u8, u8)] {
        self.modules.get(..self.len).unwrap_or(&[])
    }

    fn position(&self, code: usize, instance: usize) -> Option<usize> {
        self.modules().iter().position(|&(c, i)| usize::from(c) == code && usize::from(i) == instance)
    }
}

fn params<'v>(values: &'v [f64; PARAM_COUNT], code: usize, instance: usize) -> P<'v> {
    let index =
        INDEX.get(code).and_then(|t| t.get(instance)).unwrap_or(&[u16::MAX; catalog::MODULE_PARAMS_MAX]);
    P { values, index }
}

/// Decay of every reverb instance the rig builds convolvers for (in the rack and switched on),
/// indexed by instance; `None` needs no kernels.
#[inline(never)]
pub fn reverb_decays(values: &[f64]) -> [Option<f64>; MAX_REVERBS] {
    let v = sanitize(values);
    let layout = Layout::from_values(&v);
    let mut out = [None; MAX_REVERBS];
    for (instance, o) in out.iter_mut().enumerate() {
        let p = params(&v, REVERB, instance);
        if layout.position(REVERB, instance).is_some() && p.on(0) {
            *o = Some(p.get(1));
        }
    }
    out
}

/// Storage regions are carved in this order (by code, then instance), not in rack order, so
/// reordering the rack keeps the layout and the hand-over stays an O(1) swap.
const STORAGE_CODES: [usize; 3] = [CHORUS, DELAY, REVERB];

/// One rack position. Every position is sized for the largest module (the amp, ~2.4 KiB): the
/// slots are preallocated in place, so a layout never needs memory the rig does not have.
#[derive(Debug)]
#[allow(clippy::large_enum_variant)]
enum Module<'a> {
    Empty,
    Comp(Comp),
    Drive(Clipper),
    Amp(Amp),
    Cabinet(Cabinet),
    Chorus(RigChorus<'a>),
    Delay(RigDelay<'a>),
    Fuzz(Clipper),
    Phaser(RigPhaser),
    Tremolo(RigTremolo),
    Reverb(RigReverb<'a>),
    Tuner(bool),
}

#[derive(Debug)]
struct Slot<'a> {
    code: u8,
    instance: u8,
    module: Module<'a>,
}

/// One guitar rig over caller storage.
#[derive(Debug)]
pub struct GuitarRig<'a> {
    sample_rate: f64,
    values: [f64; PARAM_COUNT],
    /// Modules (bit `code * MAX_INSTANCES + instance`) with staged parameter changes.
    stale: u64,
    slots: [Slot<'a>; SLOTS],
    count: usize,
    storage_used: usize,
}

impl<'a> GuitarRig<'a> {
    /// State storage floats for the rack in `values` (catalog order, sanitised like `new`) at
    /// `sample_rate`; `ir_len`: frames of the reverb kernels' impulse ([`reverb_ir_len`]).
    #[inline(never)]
    pub fn storage_len(sample_rate: f64, values: &[f64], ir_len: usize) -> usize {
        let v = sanitize(values);
        let layout = Layout::from_values(&v);
        let decays = reverb_decays(values);
        let mut total = 0;
        for &(code, instance) in layout.modules() {
            total += match usize::from(code) {
                CHORUS => RigChorus::storage_len(sample_rate),
                DELAY => RigDelay::storage_len(sample_rate),
                REVERB if decays.get(usize::from(instance)).copied().flatten().is_some() => {
                    reverb::StereoConvolver::state_len(ir_len)
                }
                _ => 0,
            };
        }
        total
    }

    /// C++ `makeEffect("guitar-rig", params, sample_rate)`. `values` in catalog order ([`PARAMS`];
    /// missing -> default, clamped). `kernels[i]`: `prepare_kernels` output of the impulse for
    /// reverb instance `i`'s Decay (`kernel_len(ir_len)` floats) when [`reverb_decays`] lists it,
    /// else ignored (may be empty).
    pub fn new(
        sample_rate: f64,
        values: &[f64],
        storage: &'a mut [f32],
        kernels: [&'a [f32]; MAX_REVERBS],
        ir_len: usize,
    ) -> Result<Self, FxError> {
        let mut rig = Self::empty(sample_rate);
        rig.build(values, storage, kernels, ir_len)?;
        Ok(rig)
    }

    /// A rig with an empty rack (passes audio through) at `sample_rate`: the first half of
    /// [`Self::new`]. With [`Self::build`] it lets a host construct the ~40 KiB rig in place (the
    /// worklet's 64 KiB stack cannot hold the copies `new` moves around).
    pub fn empty(sample_rate: f64) -> Self {
        Self {
            sample_rate,
            values: sanitize(&[]),
            stale: 0,
            slots: core::array::from_fn(|_| Slot { code: 0, instance: 0, module: Module::Empty }),
            count: 0,
            storage_used: 0,
        }
    }

    /// Builds the rack of `values` in place (the second half of [`Self::new`], same arguments).
    /// On error the rig is left with an empty rack.
    pub fn build(
        &mut self,
        values: &[f64],
        storage: &'a mut [f32],
        kernels: [&'a [f32]; MAX_REVERBS],
        ir_len: usize,
    ) -> Result<(), FxError> {
        let sample_rate = self.sample_rate;
        self.count = 0;
        self.storage_used = 0;
        for slot in &mut self.slots {
            *slot = Slot { code: 0, instance: 0, module: Module::Empty };
        }
        if !(8000.0..=192_000.0).contains(&sample_rate) {
            return Err(FxError::Rate);
        }
        let v = sanitize(values);
        let layout = Layout::from_values(&v);
        let decays = reverb_decays(values);
        for (decay, k) in decays.iter().zip(kernels) {
            if decay.is_some() && (ir_len == 0 || k.len() < reverb::kernel_len(ir_len)) {
                return Err(FxError::Kernels);
            }
        }
        let need = Self::storage_len(sample_rate, values, ir_len);
        if storage.len() < need {
            return Err(FxError::Storage);
        }
        let sr = sample_rate;
        let slots = &mut self.slots;
        let mut carver = Carver::new(storage);
        // Modules with storage first, in canonical order (see STORAGE_CODES), then the rest.
        let mut build = |code: usize, instance: usize, carver: &mut Carver<'a>| {
            let Some(position) = layout.position(code, instance) else { return };
            let p = params(&v, code, instance);
            let module = match code {
                catalog::COMP => Module::Comp(Comp::new(sr, &p)),
                catalog::DRIVE => Module::Drive(Clipper::new(false, sr, &p)),
                catalog::AMP => Module::Amp(Amp::new(sr, &p)),
                CABINET => Module::Cabinet(Cabinet::new(sr, &p)),
                CHORUS => Module::Chorus(RigChorus::new(sr, &p, carver)),
                DELAY => Module::Delay(RigDelay::new(sr, &p, carver)),
                catalog::FUZZ => Module::Fuzz(Clipper::new(true, sr, &p)),
                catalog::PHASER => Module::Phaser(RigPhaser::new(sr, &p)),
                catalog::TREMOLO => Module::Tremolo(RigTremolo::new(sr, &p)),
                REVERB => {
                    let k = kernels.get(instance).copied().unwrap_or(&[]);
                    Module::Reverb(RigReverb::new(sr, &p, Some((k, ir_len)), carver))
                }
                _ => Module::Tuner(p.on(0)),
            };
            if let Some(slot) = slots.get_mut(position) {
                *slot = Slot { code: code as u8, instance: instance as u8, module };
            }
        };
        for code in STORAGE_CODES {
            for instance in 0..MAX_INSTANCES {
                build(code, instance, &mut carver);
            }
        }
        for code in 1..MODULE_CODES {
            if STORAGE_CODES.contains(&code) {
                continue;
            }
            for instance in 0..catalog::max_instances(code) {
                build(code, instance, &mut carver);
            }
        }
        if !carver.ok() {
            for slot in &mut self.slots {
                *slot = Slot { code: 0, instance: 0, module: Module::Empty };
            }
            return Err(FxError::Storage);
        }
        self.storage_used = carver.used();
        self.values = v;
        self.stale = 0;
        self.count = layout.len;
        Ok(())
    }

    pub fn sample_rate(&self) -> f64 {
        self.sample_rate
    }

    /// (code, instance) of the modules in signal order.
    pub fn modules(&self) -> impl Iterator<Item = (u8, u8)> + '_ {
        self.slots.iter().take(self.count).map(|s| (s.code, s.instance))
    }

    pub fn param(&self, index: usize) -> f64 {
        self.values.get(index).copied().unwrap_or(0.0)
    }

    /// Stage one parameter (clamped; non-finite ignored). [`Self::commit`] applies staged changes.
    /// Structural parameters are stored but keep the built layout (as in C++).
    pub fn set_param(&mut self, index: usize, value: f64) {
        let (Some(def), Some(slot)) = (PARAMS.get(index), self.values.get_mut(index)) else { return };
        if !value.is_finite() {
            return;
        }
        let v = clamp(value, def.min, def.max);
        if *slot != v {
            *slot = v;
            if let Some(&owner) = OWNER.get(index)
                && owner != NO_OWNER
            {
                self.stale |= 1 << owner;
            }
        }
    }

    /// EffectControl::apply: re-reads the parameters of the modules whose values changed.
    pub fn commit(&mut self) {
        if self.stale != 0 {
            self.automate_modules();
        }
    }

    /// All parameters at once, then automate (C++ `GuitarRig::automate(Reader)`).
    pub fn automate(&mut self, values: &[f64]) {
        for (i, &v) in values.iter().enumerate().take(PARAM_COUNT) {
            self.set_param(i, v);
        }
        self.automate_modules();
    }

    /// C++ `GuitarRig::automate` re-reads every module; re-reading a module whose values did not
    /// change is a no-op there (same targets, same coefficients), so only stale ones are visited.
    fn automate_modules(&mut self) {
        let (values, stale) = (&self.values, self.stale);
        self.stale = 0;
        for slot in self.slots.iter_mut().take(self.count) {
            let (code, instance) = (usize::from(slot.code), usize::from(slot.instance));
            if stale >> (code * MAX_INSTANCES + instance) & 1 == 0 {
                continue;
            }
            let p = params(values, code, instance);
            match &mut slot.module {
                Module::Comp(m) => m.automate(&p),
                Module::Drive(m) | Module::Fuzz(m) => m.automate(&p),
                Module::Amp(m) => m.automate(&p),
                Module::Cabinet(m) => m.automate(&p),
                Module::Chorus(m) => m.automate(&p),
                Module::Delay(m) => m.automate(&p),
                Module::Phaser(m) => m.automate(&p),
                Module::Tremolo(m) => m.automate(&p),
                Module::Reverb(m) => m.automate(&p),
                Module::Tuner(on) => *on = p.on(0),
                Module::Empty => {}
            }
        }
    }

    /// Interleaved stereo in place (native layout).
    pub fn process_interleaved(&mut self, s: &mut [f32]) {
        for slot in self.slots.iter_mut().take(self.count) {
            match &mut slot.module {
                Module::Comp(m) => run_interleaved(m, s),
                Module::Drive(m) | Module::Fuzz(m) => run_interleaved(m, s),
                Module::Amp(m) => run_interleaved(m, s),
                Module::Cabinet(m) => run_interleaved(m, s),
                Module::Chorus(m) => run_interleaved(m, s),
                Module::Delay(m) => run_interleaved(m, s),
                Module::Phaser(m) => run_interleaved(m, s),
                Module::Tremolo(m) => run_interleaved(m, s),
                Module::Reverb(m) => run_interleaved(m, s),
                Module::Tuner(on) => {
                    if *on {
                        s.fill(0.0);
                    }
                }
                Module::Empty => {}
            }
        }
    }

    /// [`Self::process_interleaved`], also writing the signal arriving at the tuner (mono, `(l + r) / 2`,
    /// one value per frame) into `tap` (silence without a tuner): the editor's tuner readout.
    pub fn process_interleaved_tap(&mut self, s: &mut [f32], tap: &mut [f32]) {
        tap.fill(0.0);
        for slot in self.slots.iter_mut().take(self.count) {
            match &mut slot.module {
                Module::Comp(m) => run_interleaved(m, s),
                Module::Drive(m) | Module::Fuzz(m) => run_interleaved(m, s),
                Module::Amp(m) => run_interleaved(m, s),
                Module::Cabinet(m) => run_interleaved(m, s),
                Module::Chorus(m) => run_interleaved(m, s),
                Module::Delay(m) => run_interleaved(m, s),
                Module::Phaser(m) => run_interleaved(m, s),
                Module::Tremolo(m) => run_interleaved(m, s),
                Module::Reverb(m) => run_interleaved(m, s),
                Module::Tuner(on) => {
                    for (t, [l, r]) in tap.iter_mut().zip(s.as_chunks::<2>().0) {
                        *t = 0.5 * (l + r);
                    }
                    if *on {
                        s.fill(0.0);
                    }
                }
                Module::Empty => {}
            }
        }
    }

    /// Planar stereo in place (Web Audio layout), `min(left.len(), right.len())` frames.
    pub fn process_planar(&mut self, left: &mut [f32], right: &mut [f32]) {
        self.process_planar_tap(left, right, &mut []);
    }

    /// [`Self::process_planar`], also writing the signal arriving at the tuner (mono,
    /// `(l + r) / 2` like a Web Audio analyser's down-mix) into `tap` (silence without a tuner).
    pub fn process_planar_tap(&mut self, left: &mut [f32], right: &mut [f32], tap: &mut [f32]) {
        let n = left.len().min(right.len());
        let (Some(left), Some(right)) = (left.get_mut(..n), right.get_mut(..n)) else { return };
        tap.fill(0.0);
        for slot in self.slots.iter_mut().take(self.count) {
            match &mut slot.module {
                Module::Comp(m) => run_planar(m, left, right),
                Module::Drive(m) | Module::Fuzz(m) => run_planar(m, left, right),
                Module::Amp(m) => run_planar(m, left, right),
                Module::Cabinet(m) => run_planar(m, left, right),
                Module::Chorus(m) => run_planar(m, left, right),
                Module::Delay(m) => run_planar(m, left, right),
                Module::Phaser(m) => run_planar(m, left, right),
                Module::Tremolo(m) => run_planar(m, left, right),
                Module::Reverb(m) => run_planar(m, left, right),
                Module::Tuner(on) => {
                    for ((t, l), r) in tap.iter_mut().zip(left.iter()).zip(right.iter()) {
                        *t = 0.5 * (l + r);
                    }
                    if *on {
                        left.fill(0.0);
                        right.fill(0.0);
                    }
                }
                Module::Empty => {}
            }
        }
    }

    pub fn reset(&mut self) {
        for slot in self.slots.iter_mut().take(self.count) {
            match &mut slot.module {
                Module::Comp(m) => m.reset(),
                Module::Drive(m) | Module::Fuzz(m) => m.reset(),
                Module::Amp(m) => m.reset(),
                Module::Cabinet(m) => m.reset(),
                Module::Chorus(m) => m.reset(),
                Module::Delay(m) => m.reset(),
                Module::Phaser(m) => m.reset(),
                Module::Tremolo(m) => m.reset(),
                Module::Reverb(m) => m.reset(),
                Module::Tuner(_) | Module::Empty => {}
            }
        }
    }

    /// Sum of the modules' latencies (drive / fuzz 8 and amp 16 frames while switched on).
    pub fn latency_frames(&self) -> u32 {
        self.slots
            .iter()
            .take(self.count)
            .map(|s| match &s.module {
                Module::Drive(m) | Module::Fuzz(m) => m.latency(),
                Module::Amp(m) => m.latency(),
                _ => 0,
            })
            .sum()
    }

    /// Sum of the modules' tails (chorus, delay, reverb).
    pub fn tail_seconds(&self) -> f64 {
        let mut total = 0.0;
        for s in self.slots.iter().take(self.count) {
            total += match &s.module {
                Module::Chorus(m) => m.tail(),
                Module::Delay(m) => m.tail(),
                Module::Reverb(m) => m.tail(),
                _ => 0.0,
            };
        }
        total
    }

    fn find(&self, code: u8, instance: u8) -> Option<usize> {
        self.slots.iter().take(self.count).position(|s| s.code == code && s.instance == instance)
    }

    /// True when both rigs carve the same storage regions (same modules with storage, same sizes),
    /// so every storage-bearing module can swap its view with its counterpart.
    fn same_storage(&self, p: &GuitarRig<'_>) -> bool {
        if self.storage_used != p.storage_used {
            return false;
        }
        for code in STORAGE_CODES {
            for instance in 0..MAX_INSTANCES as u8 {
                let a = self.find(code as u8, instance).and_then(|i| self.slots.get(i));
                let b = p.find(code as u8, instance).and_then(|i| p.slots.get(i));
                let same = match (a.map(|s| &s.module), b.map(|s| &s.module)) {
                    (None, None) => true,
                    (Some(Module::Chorus(x)), Some(Module::Chorus(y))) => x.same_storage(y),
                    (Some(Module::Delay(x)), Some(Module::Delay(y))) => x.same_storage(y),
                    (Some(Module::Reverb(x)), Some(Module::Reverb(y))) => x.same_storage(y),
                    (Some(Module::Reverb(x)), None) | (None, Some(Module::Reverb(x))) => !x.has_storage(),
                    _ => false,
                };
                if !same {
                    return false;
                }
            }
        }
        true
    }

    /// C++ `GuitarRig::takeStateFrom`: each module adopts the audio history and current
    /// (smoothed) values of the previous rig's module with the same code and instance. Returns
    /// true when the two rigs swapped their *entire* state storage (O(1)); the owner must then
    /// swap the storage buffers as well. Otherwise matching delay lines / reverb state are copied.
    pub fn take_state_from(&mut self, previous: &mut GuitarRig<'a>) -> bool {
        let whole = self.same_storage(previous);
        for slot in self.slots.iter_mut().take(self.count) {
            let Some(j) = previous.find(slot.code, slot.instance) else { continue };
            let Some(old) = previous.slots.get_mut(j) else { continue };
            match (&mut slot.module, &mut old.module) {
                (Module::Comp(a), Module::Comp(b)) => a.take_state_from(b),
                (Module::Drive(a), Module::Drive(b)) | (Module::Fuzz(a), Module::Fuzz(b)) => {
                    a.take_state_from(b)
                }
                (Module::Amp(a), Module::Amp(b)) => a.take_state_from(b),
                (Module::Cabinet(a), Module::Cabinet(b)) => a.take_state_from(b),
                (Module::Chorus(a), Module::Chorus(b)) => a.take_state_from(b, whole),
                (Module::Delay(a), Module::Delay(b)) => a.take_state_from(b, whole),
                (Module::Phaser(a), Module::Phaser(b)) => a.take_state_from(b),
                (Module::Tremolo(a), Module::Tremolo(b)) => a.take_state_from(b),
                (Module::Reverb(a), Module::Reverb(b)) => a.take_state_from(b, whole),
                _ => {}
            }
        }
        whole && self.storage_used > 0
    }
}

#[cfg(test)]
mod tests;

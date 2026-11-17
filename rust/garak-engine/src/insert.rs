//! A built-in insert: one garak-dsp [`Fx`] over storage this struct owns (C++ `makeEffect` +
//! `EffectControl`). Built on the control thread; the audio thread only calls `process`,
//! `set_param` / `commit`, `set_tempo` and `reset`.

use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::format;
use alloc::string::String;
use alloc::sync::Arc;
use alloc::vec;

use alloc::vec::Vec;

use garak_dsp::fx::guitar::{self, GuitarRig};
use garak_dsp::fx::reverb;
use garak_dsp::{EffectKind, Fx, MAX_PARAMS, ParamDef};

use crate::error::Error;
use crate::plan::InsertPlan;

/// Prepared reverb kernels and the impulse length they were made for.
type Kernels = (Arc<[f32]>, usize);

/// Reverb kernels shared by every reverb with the same (rate, type, size): the C++ IR cache
/// (docs/RENDER_DIFF_PROTOCOL.md 5). Control thread only.
#[derive(Debug, Default)]
pub(crate) struct KernelCache {
    kernels: BTreeMap<(u64, u64, u64), Kernels>,
}

impl KernelCache {
    fn reverb(&mut self, sample_rate: f64, type_param: f64, size: f64) -> Result<(Arc<[f32]>, usize), Error> {
        let space = reverb::space_of(type_param);
        // `size` is clamped like the C ABI does before generating.
        let size = size.clamp(0.0, 1.0);
        let key = (sample_rate.to_bits(), space as u64, size.to_bits());
        if let Some(found) = self.kernels.get(&key) {
            return Ok(found.clone());
        }
        let len = reverb::ir_len(sample_rate, space);
        let (mut l, mut r) = (vec![0.0f32; len], vec![0.0f32; len]);
        let mut scratch = vec![0.0f32; reverb::ir_scratch_len(sample_rate, space)];
        if !reverb::generate_ir(sample_rate, space, size, &mut l, &mut r, &mut scratch) {
            return Err(Error::new("Reverb impulse generation failed"));
        }
        let mut kernels = vec![0.0f32; reverb::kernel_len(len)];
        if !reverb::prepare_kernels(&l, &r, len, &mut kernels) {
            return Err(Error::new("Reverb kernel preparation failed"));
        }
        let entry: (Arc<[f32]>, usize) = (Arc::from(kernels), len);
        self.kernels.insert(key, entry.clone());
        Ok(entry)
    }

    /// Drops kernels no live insert uses any more.
    pub fn trim(&mut self) {
        self.kernels.retain(|_, (k, _)| Arc::strong_count(k) > 1);
    }
}

/// Stereo-widening inserts (engine.cpp buildTrack `stereoEffects`): a track with one pans as stereo.
pub(crate) fn widens(plan: &InsertPlan) -> bool {
    matches!(
        plan.kind.as_str(),
        "reverb" | "guitar-rig" | "chorus" | "phaser" | "flanger" | "tremolo" | "utility"
    ) || (plan.kind == "delay" && plan.param("mode").is_some_and(|m| m >= 0.5))
}

/// The guitar rig's type id (garak-dsp `fx::guitar`, not an [`EffectKind`]).
pub(crate) const GUITAR_RIG: &str = "guitar-rig";

/// Parameter catalog of a built-in insert type (C++ `effectDefs`), or None when unsupported.
pub(crate) fn catalog(kind: &str) -> Option<&'static [ParamDef]> {
    if kind == GUITAR_RIG {
        return Some(guitar::PARAMS);
    }
    EffectKind::from_id(kind.as_bytes()).map(EffectKind::params)
}

/// dsp.cpp `liveEffectParameter`: true when set + commit fully applies a new value in place.
pub(crate) fn live_parameter(kind: &str, id: &str) -> bool {
    let Some(defs) = catalog(kind) else { return false };
    if !defs.iter().any(|d| d.id == id) {
        return false;
    }
    // Instance parameters of the rig read "<base>_<n>".
    let base = |name: &str| {
        id == name
            || (id.len() == name.len() + 2
                && id.starts_with(name)
                && id.as_bytes().get(name.len()) == Some(&b'_'))
    };
    match kind {
        "reverb" => id != "size" && id != "type" && id != "predelay",
        "delay" => id != "mode",
        GUITAR_RIG => !id.starts_with("rackSlot") && !base("reverbDecay") && !base("reverbEnabled"),
        _ => true,
    }
}

/// dsp.cpp `estimateEffectMemory`.
pub(crate) fn estimate_memory(kind: &str, sample_rate: f64) -> usize {
    match kind {
        "reverb" => (sample_rate * 4.2 * 36.0) as usize + 1024 * 1024,
        "guitar-rig" => (sample_rate * 4.2 * (24.0 + 36.0)) as usize * 3 + 3 * 1024 * 1024 + 65536,
        "delay" => (sample_rate * 4.2 * 24.0) as usize + 65536,
        "chorus" | "flanger" => (sample_rate * 0.06 * 16.0) as usize + 65536,
        _ => 4096,
    }
}

/// Catalog-order values of `plan` (missing -> default), refusing unknown ids and out-of-range or
/// non-finite values exactly like the C++ `Reader`.
pub(crate) fn validated_values(kind: EffectKind, plan: &InsertPlan) -> Result<[f64; MAX_PARAMS], Error> {
    let mut values = [0.0; MAX_PARAMS];
    validate_into(kind.params(), plan, &mut values)?;
    Ok(values)
}

/// [`validated_values`] for any catalog (the rig has more than `MAX_PARAMS`). Control thread.
pub(crate) fn validated(defs: &[ParamDef], plan: &InsertPlan) -> Result<Vec<f64>, Error> {
    let mut values = vec![0.0; defs.len()];
    validate_into(defs, plan, &mut values)?;
    Ok(values)
}

fn validate_into(defs: &[ParamDef], plan: &InsertPlan, values: &mut [f64]) -> Result<(), Error> {
    for (v, d) in values.iter_mut().zip(defs) {
        *v = d.default;
    }
    for (name, value) in &plan.params {
        let Some(index) = defs.iter().position(|d| d.id == name) else {
            return Err(Error::new(format!("Unknown effect parameter: {name}")));
        };
        let def = defs.get(index).copied();
        if !value.is_finite() || def.is_some_and(|d| *value < d.min || *value > d.max) {
            return Err(Error::new(format!("Invalid effect parameter: {name}")));
        }
        if let Some(slot) = values.get_mut(index) {
            *slot = *value;
        }
    }
    Ok(())
}

/// The processor of an insert: a garak-dsp effect, or the guitar rig (boxed: ~40 KiB of
/// preallocated rack modules). The effect stays inline: its hot path is unchanged by the rig.
#[allow(clippy::large_enum_variant)]
enum Unit {
    Fx(Fx<'static>),
    Rig(Box<GuitarRig<'static>>),
}

pub(crate) struct Insert {
    pub id: String,
    /// The plan's type id ("reverb", "guitar-rig").
    pub kind: &'static str,
    /// Index in the track plan's `inserts` (disabled inserts have no runtime).
    pub source: u16,
    /// An automation lane drives it (chunked rendering).
    pub automated: bool,
    // Declared before the storage it borrows, so it is dropped first.
    unit: Unit,
    defs: &'static [ParamDef],
    storage: Box<[f32]>,
    /// Owners of the reverb kernels `unit` borrows (never read directly).
    _kernels: [Option<Arc<[f32]>>; guitar::MAX_REVERBS],
}

impl core::fmt::Debug for Insert {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Insert").field("id", &self.id).field("kind", &self.kind).finish_non_exhaustive()
    }
}

impl Insert {
    /// C++ `makeEffect(type, params, sampleRate, bpm)`. Control thread.
    pub fn new(
        plan: &InsertPlan,
        source: u16,
        sample_rate: f64,
        bpm: f64,
        cache: &mut KernelCache,
    ) -> Result<Self, Error> {
        if plan.kind == GUITAR_RIG {
            return Self::rig(plan, source, sample_rate, cache);
        }
        let kind = EffectKind::from_id(plan.kind.as_bytes())
            .ok_or_else(|| Error::new(format!("Unsupported native effect: {}", plan.kind)))?;
        let values = validated_values(kind, plan)?;
        let count = kind.params().len();
        let (kernels, ir_len) = if kind == EffectKind::Reverb {
            let p = |id: &str| {
                let index = kind.params().iter().position(|d| d.id == id).unwrap_or(0);
                values.get(index).copied().unwrap_or(0.0)
            };
            let (k, len) = cache.reverb(sample_rate, p("type"), p("size"))?;
            (Some(k), len)
        } else {
            (None, 0)
        };
        let mut storage: Box<[f32]> =
            vec![0.0f32; Fx::storage_len(kind, sample_rate, ir_len)].into_boxed_slice();
        // SAFETY: `storage` and `kernels` are heap allocations owned by the returned struct and never
        // reallocated or exposed; their addresses are stable when the struct moves. `unit` is declared
        // first, so it is dropped before either. `take_state_from` swaps the owners whenever the
        // kernels swap their views. Hence the borrows live exactly as long as the data.
        let storage_view: &'static mut [f32] =
            unsafe { core::slice::from_raw_parts_mut(storage.as_mut_ptr(), storage.len()) };
        let kernel_view: &'static [f32] = match &kernels {
            // SAFETY: as above; an `Arc<[f32]>` allocation is immutable and outlives `unit`.
            Some(k) => unsafe { core::slice::from_raw_parts(k.as_ptr(), k.len()) },
            None => &[],
        };
        let values = values.get(..count).unwrap_or(&[]);
        let mut fx = Fx::new(kind, sample_rate, bpm, values, storage_view, kernel_view, ir_len)
            .map_err(|e| Error::new(format!("Effect initialisation failed ({e:?}): {}", plan.kind)))?;
        fx.reset();
        Ok(Self {
            id: plan.id.clone(),
            kind: kind.id(),
            source,
            automated: false,
            unit: Unit::Fx(fx),
            defs: kind.params(),
            storage,
            _kernels: [kernels, None, None],
        })
    }

    /// C++ `makeEffect("guitar-rig", ...)`. Plate kernels per switched-on reverb come from the
    /// cache: the same hall impulse a type-0 reverb of that size uses, so the two share entries
    /// (as C++ `blendedKernel` does).
    fn rig(plan: &InsertPlan, source: u16, sample_rate: f64, cache: &mut KernelCache) -> Result<Self, Error> {
        let values = validated(guitar::PARAMS, plan)?;
        let mut kernels: [Option<Arc<[f32]>>; guitar::MAX_REVERBS] = [None, None, None];
        let mut ir_len = 0;
        for (k, decay) in kernels.iter_mut().zip(guitar::reverb_decays(&values)) {
            if let Some(decay) = decay {
                let (arc, len) = cache.reverb(sample_rate, 0.0, decay)?;
                *k = Some(arc);
                ir_len = len;
            }
        }
        let mut storage: Box<[f32]> =
            vec![0.0f32; GuitarRig::storage_len(sample_rate, &values, ir_len)].into_boxed_slice();
        // SAFETY: as in `new`: heap buffers owned by the returned struct, outliving `unit`.
        let storage_view: &'static mut [f32] =
            unsafe { core::slice::from_raw_parts_mut(storage.as_mut_ptr(), storage.len()) };
        let mut views: [&'static [f32]; guitar::MAX_REVERBS] = [&[]; guitar::MAX_REVERBS];
        for (view, k) in views.iter_mut().zip(&kernels) {
            if let Some(k) = k {
                // SAFETY: as in `new`; the `Arc` is kept in `_kernels`.
                *view = unsafe { core::slice::from_raw_parts(k.as_ptr(), k.len()) };
            }
        }
        let mut rig = GuitarRig::new(sample_rate, &values, storage_view, views, ir_len)
            .map_err(|e| Error::new(format!("Effect initialisation failed ({e:?}): {}", plan.kind)))?;
        rig.reset();
        Ok(Self {
            id: plan.id.clone(),
            kind: GUITAR_RIG,
            source,
            automated: false,
            unit: Unit::Rig(Box::new(rig)),
            defs: guitar::PARAMS,
            storage,
            _kernels: kernels,
        })
    }

    #[inline]
    pub fn process(&mut self, stereo: &mut [f32]) {
        match &mut self.unit {
            Unit::Fx(fx) => fx.process_interleaved(stereo),
            Unit::Rig(rig) => rig.process_interleaved(stereo),
        }
    }

    #[inline]
    pub fn set_tempo(&mut self, bpm: f64) {
        if let Unit::Fx(fx) = &mut self.unit {
            fx.set_tempo(bpm);
        }
    }

    /// EffectControl::set (clamped; staged until `commit`).
    #[inline]
    pub fn set_param(&mut self, index: usize, value: f64) {
        match &mut self.unit {
            Unit::Fx(fx) => fx.set_param(index, value),
            Unit::Rig(rig) => rig.set_param(index, value),
        }
    }

    /// EffectControl::apply: pushes staged values when something changed.
    #[inline]
    pub fn commit(&mut self) {
        match &mut self.unit {
            Unit::Fx(fx) => fx.commit(),
            Unit::Rig(rig) => rig.commit(),
        }
    }

    pub fn reset(&mut self) {
        match &mut self.unit {
            Unit::Fx(fx) => fx.reset(),
            Unit::Rig(rig) => rig.reset(),
        }
    }

    pub fn latency(&self) -> u32 {
        match &self.unit {
            Unit::Fx(fx) => fx.latency_frames(),
            Unit::Rig(rig) => rig.latency_frames(),
        }
    }

    pub fn tail(&self) -> f64 {
        match &self.unit {
            Unit::Fx(fx) => fx.tail_seconds(),
            Unit::Rig(rig) => rig.tail_seconds(),
        }
    }

    pub fn param_index(&self, id: &str) -> Option<usize> {
        self.defs.iter().position(|d| d.id == id)
    }

    /// C++ `takeStateFrom` between inserts of the same id and type (audio thread; O(1), except a
    /// rig whose storage layout changed, which copies the matching delay lines / reverb state).
    pub fn take_state_from(&mut self, previous: &mut Insert) {
        if self.kind != previous.kind {
            return;
        }
        let swapped = match (&mut self.unit, &mut previous.unit) {
            (Unit::Fx(a), Unit::Fx(b)) => a.take_state_from(b),
            (Unit::Rig(a), Unit::Rig(b)) => a.take_state_from(b),
            _ => false,
        };
        if swapped {
            core::mem::swap(&mut self.storage, &mut previous.storage);
        }
    }
}

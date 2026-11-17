//! Built-in instruments over the C ABI: `garak_rs_instrument_*` (옥구슬 EP, 한밤 106). The C++
//! engine wraps them as a `PluginProcessor` (the former C++ instrument adapter (0.3.2)). Declarations:
//! `include/garak_rust.h`.
//!
//! Memory: the caller allocates `garak_rs_instrument_size()` bytes aligned to
//! `garak_rs_instrument_align()`. The state is plain data (fixed voice pools, the chorus line): no
//! pointers, no destructor, so it may be freed without calling into Rust. Nothing here allocates.

use core::ptr;

use garak_dsp::instruments::{Instrument, InstrumentEvent, InstrumentKind};

use crate::samples;

/// Opaque instrument state (`GarakRsInstrument` in the header).
#[repr(C)]
#[derive(Debug)]
pub struct GarakRsInstrument {
    _opaque: [u8; 0],
}

const _: () = assert!(!core::mem::needs_drop::<Instrument>());
const _: () = assert!(size_of::<InstrumentEvent>() == 24);

/// # Safety
/// `p` is null or was initialised by [`garak_rs_instrument_init`].
unsafe fn instrument<'a>(p: *mut GarakRsInstrument) -> Option<&'a mut Instrument> {
    // SAFETY: forwarded caller contract; alignment was checked by `garak_rs_instrument_init`.
    unsafe { p.cast::<Instrument>().as_mut() }
}

/// # Safety
/// As [`instrument`].
unsafe fn instrument_ref<'a>(p: *const GarakRsInstrument) -> Option<&'a Instrument> {
    // SAFETY: forwarded caller contract.
    unsafe { p.cast::<Instrument>().as_ref() }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rs_instrument_size() -> usize {
    size_of::<Instrument>()
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rs_instrument_align() -> usize {
    align_of::<Instrument>()
}

/// Kind of a project instrument id ("okgu-ep", "hanbam-106"), or -1.
///
/// # Safety
/// `id` is null or valid for `len` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_instrument_kind(id: *const u8, len: usize) -> i32 {
    if id.is_null() || len == 0 {
        return -1;
    }
    // SAFETY: caller contract.
    let id = unsafe { core::slice::from_raw_parts(id, len) };
    InstrumentKind::from_id(id).map_or(-1, |k| k as i32)
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rs_instrument_param_count(kind: u32) -> u32 {
    InstrumentKind::from_u32(kind).map_or(0, |k| k.params().len() as u32)
}

/// Copies parameter `index`'s id (no terminator) into `out`; returns its full length (0 when out
/// of range).
///
/// # Safety
/// `out` is null or valid for `capacity` byte writes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_instrument_param_id(
    kind: u32,
    index: u32,
    out: *mut u8,
    capacity: usize,
) -> usize {
    let Some(def) = InstrumentKind::from_u32(kind).and_then(|k| k.params().get(index as usize)) else {
        return 0;
    };
    if !out.is_null() && capacity > 0 {
        // SAFETY: caller contract.
        let out = unsafe { core::slice::from_raw_parts_mut(out, capacity) };
        for (o, b) in out.iter_mut().zip(def.id.bytes()) {
            *o = b;
        }
    }
    def.id.len()
}

/// Default and range of parameter `index`; returns 0 when out of range.
///
/// # Safety
/// The out pointers are null or valid for one `double` write each.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_instrument_param_range(
    kind: u32,
    index: u32,
    out_default: *mut f64,
    out_min: *mut f64,
    out_max: *mut f64,
) -> i32 {
    let Some(def) = InstrumentKind::from_u32(kind).and_then(|k| k.params().get(index as usize)) else {
        return 0;
    };
    // SAFETY: caller contract.
    unsafe {
        for (p, v) in [(out_default, def.default), (out_min, def.min), (out_max, def.max)] {
            if let Some(o) = p.as_mut() {
                *o = v;
            }
        }
    }
    1
}

/// Initialises `inst` (any previous contents are overwritten without being read) with the first
/// `count` parameters in catalog order (the rest keep their defaults). Returns `GARAK_RS_OK`,
/// `GARAK_RS_ERR_ARGUMENT` (null / misaligned), `GARAK_RS_ERR_KIND` or `GARAK_RS_ERR_RATE`.
///
/// # Safety
/// `inst` is null or valid for `garak_rs_instrument_size()` byte writes; `params` is null or valid
/// for `count` reads.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_instrument_init(
    inst: *mut GarakRsInstrument,
    kind: u32,
    sample_rate: f64,
    params: *const f64,
    count: u32,
) -> i32 {
    if inst.is_null() || !(inst as usize).is_multiple_of(align_of::<Instrument>()) {
        return crate::fx::GARAK_RS_ERR_ARGUMENT;
    }
    let Some(kind) = InstrumentKind::from_u32(kind) else { return crate::fx::GARAK_RS_ERR_KIND };
    if !(8000.0..=192_000.0).contains(&sample_rate) {
        return crate::fx::GARAK_RS_ERR_RATE;
    }
    let mut value = Instrument::new(kind, sample_rate);
    if !params.is_null() && count > 0 {
        // SAFETY: caller contract.
        value.set_params(unsafe { core::slice::from_raw_parts(params, count as usize) });
    }
    // SAFETY: caller contract; alignment checked above.
    unsafe { ptr::write(inst.cast::<Instrument>(), value) };
    crate::fx::GARAK_RS_OK
}

/// Parameter `index` to `value` (catalog units, clamped; non-finite ignored). Continuous
/// parameters glide.
///
/// # Safety
/// `inst` is null or initialised.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_instrument_set_param(inst: *mut GarakRsInstrument, index: u32, value: f64) {
    // SAFETY: caller contract.
    if let Some(i) = unsafe { instrument(inst) } {
        i.set_param(index as usize, value);
    }
}

/// # Safety
/// `inst` is null or initialised.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_instrument_param(inst: *const GarakRsInstrument, index: u32) -> f64 {
    // SAFETY: caller contract.
    unsafe { instrument_ref(inst) }.map_or(0.0, |i| i.param(index as usize))
}

/// Renders `frames` planar stereo frames (overwritten), applying `events` (sorted by offset) on
/// time.
///
/// # Safety
/// `inst` is null or initialised; `left` / `right` are null or valid for `frames` writes;
/// `events` is null or valid for `count` reads.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_instrument_process(
    inst: *mut GarakRsInstrument,
    left: *mut f32,
    right: *mut f32,
    frames: u32,
    events: *const InstrumentEvent,
    count: u32,
) {
    // SAFETY: caller contract.
    let (i, l, r) =
        unsafe { (instrument(inst), samples(left, frames as usize), samples(right, frames as usize)) };
    let events = if events.is_null() || count == 0 {
        &[][..]
    } else {
        // SAFETY: caller contract.
        unsafe { core::slice::from_raw_parts(events, count as usize) }
    };
    if let Some(i) = i
        && l.len() == r.len()
    {
        i.process(l, r, events);
    }
}

/// # Safety
/// `inst` is null or initialised.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_instrument_reset(inst: *mut GarakRsInstrument) {
    // SAFETY: caller contract.
    if let Some(i) = unsafe { instrument(inst) } {
        i.reset();
    }
}

/// `inst` takes over `previous`'s voices and delay lines, keeping its own parameters (an edit that
/// rebuilt the track keeps ringing). Ignored across kinds / sample rates.
///
/// # Safety
/// Both are null or initialised, and distinct.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_instrument_take_state(
    inst: *mut GarakRsInstrument,
    previous: *const GarakRsInstrument,
) {
    if ptr::eq(inst.cast_const(), previous) {
        return;
    }
    // SAFETY: caller contract.
    if let (Some(i), Some(p)) = unsafe { (instrument(inst), instrument_ref(previous)) } {
        i.take_state(p);
    }
}

/// # Safety
/// `inst` is null or initialised.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_instrument_tail(inst: *const GarakRsInstrument) -> f64 {
    // SAFETY: caller contract.
    unsafe { instrument_ref(inst) }.map_or(0.0, Instrument::tail_seconds)
}

/// # Safety
/// `inst` is null or initialised.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_instrument_active_voices(inst: *const GarakRsInstrument) -> u32 {
    // SAFETY: caller contract.
    unsafe { instrument_ref(inst) }.map_or(0, |i| i.active_voices() as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use garak_dsp::instruments::event;
    use std::vec::Vec;

    #[test]
    fn round_trip_through_the_c_abi() {
        let kind = unsafe { garak_rs_instrument_kind(b"hanbam-106".as_ptr(), 10) };
        assert_eq!(kind, 1);
        assert_eq!(unsafe { garak_rs_instrument_kind(b"nope".as_ptr(), 4) }, -1);
        let mut id = [0u8; 32];
        let n = unsafe { garak_rs_instrument_param_id(0, 0, id.as_mut_ptr(), id.len()) };
        assert_eq!(&id[..n], b"tone");
        let words = garak_rs_instrument_size().div_ceil(8);
        let mut storage: Vec<u64> = std::vec![0; words];
        assert!(garak_rs_instrument_align() <= 8);
        let inst = storage.as_mut_ptr().cast::<GarakRsInstrument>();
        assert_eq!(unsafe { garak_rs_instrument_init(inst, 0, 48_000.0, ptr::null(), 0) }, 0);
        assert_eq!(unsafe { garak_rs_instrument_init(inst, 9, 48_000.0, ptr::null(), 0) }, -2);
        assert_eq!(unsafe { garak_rs_instrument_init(inst, 0, 1.0, ptr::null(), 0) }, -3);
        assert_eq!(unsafe { garak_rs_instrument_init(inst, 0, 48_000.0, ptr::null(), 0) }, 0);
        let events =
            [InstrumentEvent { offset: 0, kind: event::NOTE_ON, id: 1, pitch: 60, value: 0.9, param: 0 }];
        let (mut l, mut r) = ([0.0f32; 256], [0.0f32; 256]);
        unsafe { garak_rs_instrument_process(inst, l.as_mut_ptr(), r.as_mut_ptr(), 256, events.as_ptr(), 1) };
        assert!(l.iter().any(|v| v.abs() > 1e-3));
        assert_eq!(unsafe { garak_rs_instrument_active_voices(inst) }, 1);
        // Nulls are ignored.
        unsafe {
            garak_rs_instrument_process(ptr::null_mut(), l.as_mut_ptr(), r.as_mut_ptr(), 256, ptr::null(), 0);
            garak_rs_instrument_process(inst, ptr::null_mut(), r.as_mut_ptr(), 256, ptr::null(), 0);
            garak_rs_instrument_take_state(inst, inst);
        }
    }
}

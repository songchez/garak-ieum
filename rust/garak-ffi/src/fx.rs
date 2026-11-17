//! Built-in effects over the C ABI: `garak_rs_fx_*` (every `makeEffect` type ported to
//! `garak-dsp`) and `garak_rs_reverb_*` (impulse response synthesis / kernel preparation, so a
//! cached IR can be passed in). Declarations: `include/garak_rust.h`.
//!
//! Memory: the caller allocates the opaque state (`garak_rs_fx_size` / `garak_rs_fx_align`), the
//! state storage (`garak_rs_fx_storage_len` floats) and, for the reverb, the kernel storage. Rust
//! only borrows them; they must outlive the effect. Nothing here allocates.

use core::ptr;

use garak_dsp::fx::reverb;
use garak_dsp::{EffectKind, Fx, FxError};

use crate::samples;

/// Opaque effect state (`GarakRsFx` in the header).
#[repr(C)]
#[derive(Debug)]
pub struct GarakRsFx {
    _opaque: [u8; 0],
}

type FxState = Fx<'static>;
// The C++ side frees the bytes without running Rust code.
const _: () = assert!(!core::mem::needs_drop::<FxState>());

pub const GARAK_RS_OK: i32 = 0;
pub const GARAK_RS_ERR_ARGUMENT: i32 = -1;
pub const GARAK_RS_ERR_KIND: i32 = -2;
pub const GARAK_RS_ERR_RATE: i32 = -3;
pub const GARAK_RS_ERR_STORAGE: i32 = -4;
pub const GARAK_RS_ERR_KERNELS: i32 = -5;

/// # Safety
/// `p` is null or was initialised by [`garak_rs_fx_init`] (the state may be moved: it holds no
/// self-references, only pointers into the caller's buffers).
unsafe fn fx<'a>(p: *mut GarakRsFx) -> Option<&'a mut FxState> {
    // SAFETY: forwarded caller contract; alignment was checked by `garak_rs_fx_init`.
    unsafe { p.cast::<FxState>().as_mut() }
}

/// # Safety
/// As [`fx`].
unsafe fn fx_ref<'a>(p: *const GarakRsFx) -> Option<&'a FxState> {
    // SAFETY: forwarded caller contract.
    unsafe { p.cast::<FxState>().as_ref() }
}

/// # Safety
/// `p` is null or valid for `len` reads.
unsafe fn read_only<'a, T>(p: *const T, len: usize) -> &'a [T] {
    if p.is_null() || len == 0 {
        &[]
    } else {
        // SAFETY: forwarded caller contract.
        unsafe { core::slice::from_raw_parts(p, len) }
    }
}

/// # Safety
/// `p` is null or valid for `len` reads and writes.
unsafe fn read_write<'a, T>(p: *mut T, len: usize) -> &'a mut [T] {
    if p.is_null() || len == 0 {
        &mut []
    } else {
        // SAFETY: forwarded caller contract.
        unsafe { core::slice::from_raw_parts_mut(p, len) }
    }
}

fn valid_rate(sample_rate: f64) -> bool {
    (8000.0..=192_000.0).contains(&sample_rate)
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rs_fx_size() -> usize {
    size_of::<FxState>()
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rs_fx_align() -> usize {
    align_of::<FxState>()
}

/// Effect kind of a project effect type id ("chorus"), or -1.
///
/// # Safety
/// `id` is null or valid for `len` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_fx_kind(id: *const u8, len: usize) -> i32 {
    // SAFETY: caller contract.
    let id = unsafe { read_only(id, len) };
    EffectKind::from_id(id).map_or(-1, |k| k as i32)
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rs_fx_param_count(kind: u32) -> u32 {
    EffectKind::from_u32(kind).map_or(0, |k| k.params().len() as u32)
}

/// Copies parameter `index`'s id (no terminator) into `out` and returns its full length (0 when
/// out of range).
///
/// # Safety
/// `out` is null or valid for `capacity` byte writes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_fx_param_id(kind: u32, index: u32, out: *mut u8, capacity: usize) -> usize {
    let Some(def) = EffectKind::from_u32(kind).and_then(|k| k.params().get(index as usize)) else { return 0 };
    // SAFETY: caller contract.
    let out = unsafe { read_write(out, capacity) };
    for (o, b) in out.iter_mut().zip(def.id.bytes()) {
        *o = b;
    }
    def.id.len()
}

/// Default and range of parameter `index`; returns 0 when out of range.
///
/// # Safety
/// The out pointers are null or valid for one `double` write each.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_fx_param_range(
    kind: u32,
    index: u32,
    out_default: *mut f64,
    out_min: *mut f64,
    out_max: *mut f64,
) -> i32 {
    let Some(def) = EffectKind::from_u32(kind).and_then(|k| k.params().get(index as usize)) else { return 0 };
    for (p, v) in [(out_default, def.default), (out_min, def.min), (out_max, def.max)] {
        // SAFETY: caller contract.
        if let Some(o) = unsafe { p.as_mut() } {
            *o = v;
        }
    }
    1
}

/// State storage floats (`ir_len`: reverb impulse frames; ignored by other kinds).
#[unsafe(no_mangle)]
pub extern "C" fn garak_rs_fx_storage_len(kind: u32, sample_rate: f64, ir_len: usize) -> usize {
    match EffectKind::from_u32(kind) {
        Some(k) if valid_rate(sample_rate) => Fx::storage_len(k, sample_rate, ir_len),
        _ => 0,
    }
}

/// Impulse response frames for the reverb `type` parameter at `sample_rate`.
#[unsafe(no_mangle)]
pub extern "C" fn garak_rs_reverb_ir_len(sample_rate: f64, type_param: f64) -> usize {
    if valid_rate(sample_rate) { reverb::ir_len(sample_rate, reverb::space_of(type_param)) } else { 0 }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rs_reverb_scratch_len(sample_rate: f64, type_param: f64) -> usize {
    if valid_rate(sample_rate) {
        reverb::ir_scratch_len(sample_rate, reverb::space_of(type_param))
    } else {
        0
    }
}

/// Synthesises the impulse response (the former C++ DSP (0.3.2) `impulse` + the size cross-fade). Returns 1 on
/// success, 0 when an argument or buffer is invalid.
///
/// # Safety
/// Each pointer is null or valid for its length in floats.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_reverb_generate_ir(
    sample_rate: f64,
    type_param: f64,
    size: f64,
    left: *mut f32,
    right: *mut f32,
    ir_len: usize,
    scratch: *mut f32,
    scratch_len: usize,
) -> i32 {
    if !valid_rate(sample_rate) || !size.is_finite() {
        return 0;
    }
    // SAFETY: caller contract.
    let (l, r, s) =
        unsafe { (read_write(left, ir_len), read_write(right, ir_len), read_write(scratch, scratch_len)) };
    i32::from(reverb::generate_ir(sample_rate, reverb::space_of(type_param), size.clamp(0.0, 1.0), l, r, s))
}

/// Kernel storage floats for an impulse response of `ir_len` frames.
#[unsafe(no_mangle)]
pub extern "C" fn garak_rs_reverb_kernel_len(ir_len: usize) -> usize {
    reverb::kernel_len(ir_len)
}

/// FFTs an impulse response (generated or cached) into kernel storage. Control thread only.
/// Returns 1 on success.
///
/// # Safety
/// Each pointer is null or valid for its length in floats.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_reverb_prepare_kernels(
    left: *const f32,
    right: *const f32,
    ir_len: usize,
    kernels: *mut f32,
    kernels_len: usize,
) -> i32 {
    // SAFETY: caller contract.
    let (l, r, k) =
        unsafe { (read_only(left, ir_len), read_only(right, ir_len), read_write(kernels, kernels_len)) };
    i32::from(reverb::prepare_kernels(l, r, ir_len, k))
}

/// Builds an effect in `fx` (C++ `makeEffect`). `params`: `count` values in catalog order
/// (missing -> default, out of range -> clamped). `storage` and `kernels` must outlive the effect
/// and keep their address. Returns `GARAK_RS_OK` or a negative `GARAK_RS_ERR_*`.
///
/// # Safety
/// `fx` is null or valid for `garak_rs_fx_size()` byte writes; the other pointers are null or
/// valid for their lengths.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_fx_init(
    fx: *mut GarakRsFx,
    kind: u32,
    sample_rate: f64,
    bpm: f64,
    params: *const f64,
    count: u32,
    storage: *mut f32,
    storage_len: usize,
    kernels: *const f32,
    kernels_len: usize,
    ir_len: usize,
) -> i32 {
    if fx.is_null() || !(fx as usize).is_multiple_of(align_of::<FxState>()) {
        return GARAK_RS_ERR_ARGUMENT;
    }
    let Some(kind) = EffectKind::from_u32(kind) else { return GARAK_RS_ERR_KIND };
    // SAFETY: caller contract; the buffers outlive the effect, hence 'static.
    let (values, storage, kernels) = unsafe {
        (read_only(params, count as usize), read_write(storage, storage_len), read_only(kernels, kernels_len))
    };
    match Fx::new(kind, sample_rate, bpm, values, storage, kernels, ir_len) {
        Ok(state) => {
            // SAFETY: non-null, aligned (checked above), valid for the size (caller contract).
            unsafe { ptr::write(fx.cast::<FxState>(), state) };
            GARAK_RS_OK
        }
        Err(FxError::Rate) => GARAK_RS_ERR_RATE,
        Err(FxError::Storage) => GARAK_RS_ERR_STORAGE,
        Err(FxError::Kernels) => GARAK_RS_ERR_KERNELS,
    }
}

/// Interleaved stereo in place.
///
/// # Safety
/// `fx` is null or initialised; `stereo` is null or valid for `2 * frames` floats.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_fx_process(fx: *mut GarakRsFx, stereo: *mut f32, frames: u32) {
    // SAFETY: caller contract.
    let (f, s) = unsafe { (self::fx(fx), samples(stereo, frames as usize * 2)) };
    if let Some(f) = f {
        f.process_interleaved(s);
    }
}

/// Planar stereo in place.
///
/// # Safety
/// `fx` is null or initialised; `left` / `right` are null or valid for `frames` floats.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_fx_process_planar(
    fx: *mut GarakRsFx,
    left: *mut f32,
    right: *mut f32,
    frames: u32,
) {
    // SAFETY: caller contract.
    let (f, l, r) =
        unsafe { (self::fx(fx), samples(left, frames as usize), samples(right, frames as usize)) };
    if let Some(f) = f {
        f.process_planar(l, r);
    }
}

/// Every parameter at once, then automate in place (C++ `StereoProcessor::automate`).
///
/// # Safety
/// `fx` is null or initialised; `params` is null or valid for `count` doubles.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_fx_automate(fx: *mut GarakRsFx, params: *const f64, count: u32) {
    // SAFETY: caller contract.
    let (f, v) = unsafe { (self::fx(fx), read_only(params, count as usize)) };
    if let Some(f) = f {
        f.automate(v);
    }
}

/// Stages one parameter; `garak_rs_fx_commit` applies the staged changes.
///
/// # Safety
/// `fx` is null or initialised.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_fx_set_param(fx: *mut GarakRsFx, index: u32, value: f64) {
    // SAFETY: caller contract.
    if let Some(f) = unsafe { self::fx(fx) } {
        f.set_param(index as usize, value);
    }
}

/// # Safety
/// `fx` is null or initialised.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_fx_commit(fx: *mut GarakRsFx) {
    // SAFETY: caller contract.
    if let Some(f) = unsafe { self::fx(fx) } {
        f.commit();
    }
}

/// # Safety
/// `fx` is null or initialised.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_fx_param(fx: *const GarakRsFx, index: u32) -> f64 {
    // SAFETY: caller contract.
    unsafe { fx_ref(fx) }.map_or(0.0, |f| f.param(index as usize))
}

/// # Safety
/// `fx` is null or initialised.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_fx_set_tempo(fx: *mut GarakRsFx, bpm: f64) {
    // SAFETY: caller contract.
    if let Some(f) = unsafe { self::fx(fx) } {
        f.set_tempo(bpm);
    }
}

/// # Safety
/// `fx` is null or initialised.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_fx_reset(fx: *mut GarakRsFx) {
    // SAFETY: caller contract.
    if let Some(f) = unsafe { self::fx(fx) } {
        f.reset();
    }
}

/// # Safety
/// `fx` is null or initialised.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_fx_latency(fx: *const GarakRsFx) -> u32 {
    // SAFETY: caller contract.
    unsafe { fx_ref(fx) }.map_or(0, Fx::latency_frames)
}

/// # Safety
/// `fx` is null or initialised.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_fx_tail(fx: *const GarakRsFx) -> f64 {
    // SAFETY: caller contract.
    unsafe { fx_ref(fx) }.map_or(0.0, Fx::tail_seconds)
}

/// Dynamics tap (compressor, limiter, gate): writes the detector peak and lowest gain since the
/// last call and returns 1; returns 0 for effects without one.
///
/// # Safety
/// `fx` is null or initialised; the out pointers are null or valid for one float write.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_fx_meter(
    fx: *mut GarakRsFx,
    out_peak: *mut f32,
    out_gain: *mut f32,
) -> i32 {
    // SAFETY: caller contract.
    let Some((peak, gain)) = (unsafe { self::fx(fx) }).and_then(Fx::take_meter) else { return 0 };
    for (p, v) in [(out_peak, peak), (out_gain, gain)] {
        // SAFETY: caller contract.
        if let Some(o) = unsafe { p.as_mut() } {
            *o = v;
        }
    }
    1
}

/// C++ `takeStateFrom`. Returns 1 when the two effects exchanged their whole state storage; the
/// caller must then swap the two storage buffers as well (each effect now points into the other's).
///
/// # Safety
/// Both are null or initialised.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_fx_take_state(fx: *mut GarakRsFx, previous: *mut GarakRsFx) -> i32 {
    if fx == previous {
        return 0;
    }
    // SAFETY: caller contract; the pointers are distinct (checked above).
    match unsafe { (self::fx(fx), self::fx(previous)) } {
        (Some(a), Some(b)) => i32::from(a.take_state_from(b)),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::vec;

    #[test]
    fn effects_through_the_c_abi() {
        let sr = 48_000.0;
        let kind = EffectKind::Chorus as u32;
        let id = b"chorus";
        assert_eq!(unsafe { garak_rs_fx_kind(id.as_ptr(), id.len()) }, kind as i32);
        assert_eq!(garak_rs_fx_param_count(kind), 3);
        let mut name = [0u8; 16];
        let n = unsafe { garak_rs_fx_param_id(kind, 1, name.as_mut_ptr(), name.len()) };
        assert_eq!(&name[..n], b"depth");
        let mut storage = vec![0.0f32; garak_rs_fx_storage_len(kind, sr, 0)];
        let mut state = vec![0u64; garak_rs_fx_size().div_ceil(8)];
        let fx = state.as_mut_ptr().cast::<GarakRsFx>();
        let params = [1.0, 0.5, 0.5];
        let rc = unsafe {
            garak_rs_fx_init(
                fx,
                kind,
                sr,
                120.0,
                params.as_ptr(),
                3,
                storage.as_mut_ptr(),
                storage.len(),
                ptr::null(),
                0,
                0,
            )
        };
        assert_eq!(rc, GARAK_RS_OK);
        let mut buf = vec![0.25f32; 2 * 512];
        unsafe {
            garak_rs_fx_process(fx, buf.as_mut_ptr(), 512);
            garak_rs_fx_set_param(fx, 2, 0.0);
            garak_rs_fx_commit(fx);
            assert_eq!(garak_rs_fx_param(fx, 2), 0.0);
            assert!((garak_rs_fx_tail(fx) - 0.05).abs() < 1e-12);
            assert_eq!(garak_rs_fx_meter(fx, ptr::null_mut(), ptr::null_mut()), 0);
            assert_eq!(
                garak_rs_fx_init(
                    fx,
                    kind,
                    sr,
                    120.0,
                    ptr::null(),
                    0,
                    storage.as_mut_ptr(),
                    8,
                    ptr::null(),
                    0,
                    0
                ),
                GARAK_RS_ERR_STORAGE
            );
            assert_eq!(
                garak_rs_fx_init(fx, 99, sr, 120.0, ptr::null(), 0, ptr::null_mut(), 0, ptr::null(), 0, 0),
                GARAK_RS_ERR_KIND
            );
            // Null handles are ignored.
            garak_rs_fx_process(ptr::null_mut(), buf.as_mut_ptr(), 512);
            garak_rs_fx_automate(ptr::null_mut(), ptr::null(), 0);
        }
        assert!(buf.iter().all(|x| x.is_finite()));
    }
}

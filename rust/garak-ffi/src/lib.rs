//! C ABI over `garak-dsp` for the C++ host. Header: `include/garak_rust.h` (hand-written; a unit
//! test below fails when an exported symbol is missing from it).
//!
//! Design:
//! - `#![no_std]` staticlib: links into MinGW, MSVC and Apple toolchains without Rust's std
//!   runtime libraries (`--print native-static-libs` is empty), so CMake needs no per-platform
//!   system-library lists. The only libc symbol used is `abort` (panic handler).
//! - Caller-owned storage: C++ embeds `GarakRsBiquad` / `GarakRsUtility` by value (fixed size,
//!   8-byte aligned); Rust never allocates. Compile-time asserts keep the sizes honest.
//! - Every entry point tolerates null pointers (no-op) and never unwinds.
#![no_std]

#[cfg(test)]
extern crate std;

use core::ptr;

use garak_dsp::{Biquad, Coefficients, FilterType, Utility, UtilityParams};

/// Built-in effects (`garak_rs_fx_*`, `garak_rs_reverb_*`).
pub mod fx;

/// Bumped on any incompatible change to `garak_rust.h`.
pub const GARAK_RS_ABI_VERSION: u32 = 2;

/// Opaque, caller-allocated storage for a `garak_dsp::Biquad`.
#[repr(C, align(8))]
#[derive(Debug)]
pub struct GarakRsBiquad {
    opaque: [u64; 16],
}

/// Opaque, caller-allocated storage for a `garak_dsp::Utility`.
#[repr(C, align(8))]
#[derive(Debug)]
pub struct GarakRsUtility {
    opaque: [u64; 16],
}

const _: () = assert!(size_of::<Biquad>() <= size_of::<GarakRsBiquad>());
const _: () = assert!(align_of::<Biquad>() <= align_of::<GarakRsBiquad>());
const _: () = assert!(size_of::<Utility>() <= size_of::<GarakRsUtility>());
const _: () = assert!(align_of::<Utility>() <= align_of::<GarakRsUtility>());
const _: () = assert!(size_of::<Coefficients>() == 5 * 8);
const _: () = assert!(size_of::<UtilityParams>() == 5 * 8);

#[cfg(not(test))]
#[panic_handler]
fn on_panic(_: &core::panic::PanicInfo) -> ! {
    unsafe extern "C" {
        fn abort() -> !;
    }
    // SAFETY: C `abort` takes no arguments and never returns. Lints deny every panicking
    // construct, so this is only reachable through a bug; aborting matches std::terminate.
    unsafe { abort() }
}

/// # Safety
/// `p` is null or points to storage the caller initialised with the matching `*_init`.
unsafe fn biquad<'a>(p: *mut GarakRsBiquad) -> Option<&'a mut Biquad> {
    // SAFETY: forwarded caller contract; size/alignment asserted above.
    unsafe { p.cast::<Biquad>().as_mut() }
}

/// # Safety
/// As [`biquad`].
unsafe fn utility<'a>(p: *mut GarakRsUtility) -> Option<&'a mut Utility> {
    // SAFETY: forwarded caller contract; size/alignment asserted above.
    unsafe { p.cast::<Utility>().as_mut() }
}

/// # Safety
/// `p` is null or valid for `len` reads and writes of `f32`.
unsafe fn samples<'a>(p: *mut f32, len: usize) -> &'a mut [f32] {
    if p.is_null() || len == 0 {
        &mut []
    } else {
        // SAFETY: forwarded caller contract.
        unsafe { core::slice::from_raw_parts_mut(p, len) }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rs_abi_version() -> u32 {
    GARAK_RS_ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rs_db_to_gain(db: f64) -> f64 {
    garak_dsp::db_to_gain(db)
}

/// # Safety
/// `out_left` / `out_right` are null or valid for one `double` write.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_pan_mono(pan: f64, x: f64, out_left: *mut f64, out_right: *mut f64) {
    let (l, r) = garak_dsp::pan_mono(pan, x);
    // SAFETY: caller contract.
    unsafe {
        if let Some(o) = out_left.as_mut() {
            *o = l;
        }
        if let Some(o) = out_right.as_mut() {
            *o = r;
        }
    }
}

/// # Safety
/// As [`garak_rs_pan_mono`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_pan_stereo(
    pan: f64,
    left: f64,
    right: f64,
    out_left: *mut f64,
    out_right: *mut f64,
) {
    let (l, r) = garak_dsp::pan_stereo(pan, left, right);
    // SAFETY: caller contract.
    unsafe {
        if let Some(o) = out_left.as_mut() {
            *o = l;
        }
        if let Some(o) = out_right.as_mut() {
            *o = r;
        }
    }
}

/// # Safety
/// `out` is null or valid for one `GarakRsCoefficients` write.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_biquad_design(
    kind: u32,
    sample_rate: f64,
    frequency: f64,
    q: f64,
    gain_db: f64,
    out: *mut Coefficients,
) {
    // SAFETY: caller contract.
    if let Some(o) = unsafe { out.as_mut() } {
        *o = Coefficients::design(FilterType::from_u32(kind), sample_rate, frequency, q, gain_db);
    }
}

/// # Safety
/// `filter` is null or valid, writable `GarakRsBiquad` storage (contents may be uninitialised).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_biquad_init(filter: *mut GarakRsBiquad) {
    if !filter.is_null() {
        // SAFETY: caller contract; size/alignment asserted at compile time.
        unsafe { ptr::write(filter.cast::<Biquad>(), Biquad::new()) }
    }
}

/// # Safety
/// `filter` is null or was initialised with [`garak_rs_biquad_init`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_biquad_configure(
    filter: *mut GarakRsBiquad,
    kind: u32,
    sample_rate: f64,
    frequency: f64,
    q: f64,
    gain_db: f64,
) {
    // SAFETY: caller contract.
    if let Some(f) = unsafe { biquad(filter) } {
        f.configure(FilterType::from_u32(kind), sample_rate, frequency, q, gain_db);
    }
}

/// # Safety
/// As [`garak_rs_biquad_configure`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_biquad_retarget(
    filter: *mut GarakRsBiquad,
    kind: u32,
    sample_rate: f64,
    frequency: f64,
    q: f64,
    gain_db: f64,
) {
    // SAFETY: caller contract.
    if let Some(f) = unsafe { biquad(filter) } {
        f.retarget(FilterType::from_u32(kind), sample_rate, frequency, q, gain_db);
    }
}

/// # Safety
/// As [`garak_rs_biquad_configure`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_biquad_reset(filter: *mut GarakRsBiquad) {
    // SAFETY: caller contract.
    if let Some(f) = unsafe { biquad(filter) } {
        f.reset();
    }
}

/// # Safety
/// `filter` as [`garak_rs_biquad_configure`]; `stereo` is null or valid for `2 * frames` floats.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_biquad_process_interleaved(
    filter: *mut GarakRsBiquad,
    stereo: *mut f32,
    frames: u32,
) {
    // SAFETY: caller contract.
    let (f, s) = unsafe { (biquad(filter), samples(stereo, frames as usize * 2)) };
    if let Some(f) = f {
        f.process_interleaved(s);
    }
}

/// # Safety
/// `utility` is null or valid, writable `GarakRsUtility` storage (contents may be uninitialised).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_utility_init(utility: *mut GarakRsUtility, sample_rate: f64) {
    if !utility.is_null() {
        // SAFETY: caller contract; size/alignment asserted at compile time.
        unsafe { ptr::write(utility.cast::<Utility>(), Utility::new(sample_rate)) }
    }
}

/// # Safety
/// `utility` was initialised with [`garak_rs_utility_init`] (or is null); `params` is null or
/// valid for one read.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_utility_configure(
    utility: *mut GarakRsUtility,
    params: *const UtilityParams,
) {
    // SAFETY: caller contract.
    if let (Some(u), Some(p)) = unsafe { (self::utility(utility), params.as_ref()) } {
        u.configure(*p);
    }
}

/// # Safety
/// `utility` as [`garak_rs_utility_configure`]; `stereo` is null or valid for `2 * frames` floats.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_utility_process_interleaved(
    utility: *mut GarakRsUtility,
    stereo: *mut f32,
    frames: u32,
) {
    // SAFETY: caller contract.
    let (u, s) = unsafe { (self::utility(utility), samples(stereo, frames as usize * 2)) };
    if let Some(u) = u {
        u.process_interleaved(s);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::string::String;
    use std::vec::Vec;

    const HEADER: &str = include_str!("../include/garak_rust.h");
    const SOURCE: &str = include_str!("lib.rs");
    const FX_SOURCE: &str = include_str!("fx.rs");

    fn exported() -> Vec<String> {
        SOURCE
            .lines()
            .chain(FX_SOURCE.lines())
            .filter_map(|l| l.split("extern \"C\" fn ").nth(1))
            .filter_map(|rest| rest.split('(').next())
            .filter(|name| name.starts_with("garak_rs_"))
            .map(String::from)
            .collect()
    }

    #[test]
    fn header_declares_every_export() {
        let names = exported();
        assert!(names.len() >= 38, "{names:?}");
        for name in names {
            assert!(HEADER.contains(&std::format!("{name}(")), "garak_rust.h is missing {name}");
        }
        assert!(HEADER.contains(&std::format!("GARAK_RS_ABI_VERSION {GARAK_RS_ABI_VERSION}")));
        assert!(HEADER.contains("uint64_t opaque[16]"));
        for k in garak_dsp::EffectKind::ALL {
            let line = std::format!("GARAK_RS_FX_{} = {}", k.id().to_uppercase(), k as u32);
            assert!(HEADER.contains(&line), "garak_rust.h is missing {line}");
        }
    }

    #[test]
    fn round_trip_through_the_c_abi() {
        let mut storage = core::mem::MaybeUninit::<GarakRsBiquad>::uninit();
        let f = storage.as_mut_ptr();
        unsafe {
            garak_rs_biquad_init(f);
            garak_rs_biquad_configure(f, 0, 48_000.0, 1000.0, 0.0, 0.0);
            let mut buf = [1.0f32; 2 * 4800];
            garak_rs_biquad_process_interleaved(f, buf.as_mut_ptr(), 4800);
            assert!((buf[2 * 4799] - 1.0).abs() < 1e-4 && (buf[2 * 4799 + 1] - 1.0).abs() < 1e-4);
            // Null pointers are ignored.
            garak_rs_biquad_process_interleaved(ptr::null_mut(), buf.as_mut_ptr(), 4800);
            garak_rs_biquad_process_interleaved(f, ptr::null_mut(), 4800);
        }
        let mut u = core::mem::MaybeUninit::<GarakRsUtility>::uninit();
        unsafe {
            garak_rs_utility_init(u.as_mut_ptr(), 48_000.0);
            let p = UtilityParams { phase: 1.0, ..Default::default() };
            garak_rs_utility_configure(u.as_mut_ptr(), &p);
            let mut buf = [0.5f32, 0.5];
            garak_rs_utility_process_interleaved(u.as_mut_ptr(), buf.as_mut_ptr(), 1);
            assert_eq!(buf, [-0.5, 0.5]);
        }
    }
}

//! The guitar rig over the C ABI: `garak_rs_rig_*` (`garak_dsp::fx::guitar`, C++ `GuitarRig`).
//! Declarations: `include/garak_rust.h`.
//!
//! Memory, as for `garak_rs_fx_*`: the caller allocates the opaque state (`garak_rs_rig_size` /
//! `garak_rs_rig_align`), the state storage (`garak_rs_rig_storage_len` floats, which depends on
//! the rack layout) and one kernel buffer per switched-on reverb (`garak_rs_rig_reverb_decays`
//! says which; impulse from `garak_rs_rig_reverb_generate_ir`, kernels from
//! `garak_rs_reverb_prepare_kernels`). Rust only borrows them. Nothing here allocates.

use core::ptr;

use garak_dsp::FxError;
use garak_dsp::fx::guitar::{self, GuitarRig, MAX_REVERBS, PARAM_COUNT, PARAMS};

use crate::fx::{
    GARAK_RS_ERR_ARGUMENT, GARAK_RS_ERR_KERNELS, GARAK_RS_ERR_RATE, GARAK_RS_ERR_STORAGE, GARAK_RS_OK,
};
use crate::samples;

/// Opaque rig state (`GarakRsRig` in the header).
#[repr(C)]
#[derive(Debug)]
pub struct GarakRsRig {
    _opaque: [u8; 0],
}

type RigState = GuitarRig<'static>;
// The C++ side frees the bytes without running Rust code.
const _: () = assert!(!core::mem::needs_drop::<RigState>());

/// # Safety
/// `p` is null or was initialised by [`garak_rs_rig_init`] (movable: no self-references).
unsafe fn rig<'a>(p: *mut GarakRsRig) -> Option<&'a mut RigState> {
    // SAFETY: forwarded caller contract; alignment was checked by `garak_rs_rig_init`.
    unsafe { p.cast::<RigState>().as_mut() }
}

/// # Safety
/// As [`rig`].
unsafe fn rig_ref<'a>(p: *const GarakRsRig) -> Option<&'a RigState> {
    // SAFETY: forwarded caller contract.
    unsafe { p.cast::<RigState>().as_ref() }
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

fn valid_rate(sample_rate: f64) -> bool {
    (8000.0..=192_000.0).contains(&sample_rate)
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rs_rig_size() -> usize {
    size_of::<RigState>()
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rs_rig_align() -> usize {
    align_of::<RigState>()
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rs_rig_param_count() -> u32 {
    PARAM_COUNT as u32
}

/// Copies parameter `index`'s id (no terminator) into `out`; returns its full length (0 when out
/// of range).
///
/// # Safety
/// `out` is null or valid for `capacity` byte writes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_rig_param_id(index: u32, out: *mut u8, capacity: usize) -> usize {
    let Some(def) = PARAMS.get(index as usize) else { return 0 };
    if !out.is_null() {
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
pub unsafe extern "C" fn garak_rs_rig_param_range(
    index: u32,
    out_default: *mut f64,
    out_min: *mut f64,
    out_max: *mut f64,
) -> i32 {
    let Some(def) = PARAMS.get(index as usize) else { return 0 };
    for (p, v) in [(out_default, def.default), (out_min, def.min), (out_max, def.max)] {
        // SAFETY: caller contract.
        if let Some(o) = unsafe { p.as_mut() } {
            *o = v;
        }
    }
    1
}

/// Impulse frames of the plate reverb at `sample_rate` (0 for an invalid rate).
#[unsafe(no_mangle)]
pub extern "C" fn garak_rs_rig_reverb_ir_len(sample_rate: f64) -> usize {
    if valid_rate(sample_rate) { guitar::reverb_ir_len(sample_rate) } else { 0 }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rs_rig_reverb_scratch_len(sample_rate: f64) -> usize {
    if valid_rate(sample_rate) { guitar::reverb_ir_scratch_len(sample_rate) } else { 0 }
}

/// The plate's impulse for `decay` (dsp.cpp `RigReverb`: the hall impulse blended by Decay).
/// Returns 1 on success, 0 when an argument or buffer is invalid.
///
/// # Safety
/// Each pointer is null or valid for its length in floats.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_rig_reverb_generate_ir(
    sample_rate: f64,
    decay: f64,
    left: *mut f32,
    right: *mut f32,
    ir_len: usize,
    scratch: *mut f32,
    scratch_len: usize,
) -> i32 {
    if !valid_rate(sample_rate) || !decay.is_finite() {
        return 0;
    }
    // SAFETY: caller contract.
    let (l, r, s) = unsafe { (samples(left, ir_len), samples(right, ir_len), samples(scratch, scratch_len)) };
    i32::from(guitar::generate_reverb_ir(sample_rate, decay, l, r, s))
}

/// Which reverb instances of the rack in `params` need kernels: bit `i` set for instance `i`, and
/// its Decay written to `out_decays[i]` (`out_decays` holds 3 doubles, or is null).
///
/// # Safety
/// `params` is null or valid for `count` doubles; `out_decays` null or valid for 3 writes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_rig_reverb_decays(
    params: *const f64,
    count: u32,
    out_decays: *mut f64,
) -> u32 {
    // SAFETY: caller contract.
    let values = unsafe { read_only(params, count as usize) };
    let mut mask = 0;
    for (i, decay) in guitar::reverb_decays(values).iter().enumerate() {
        if let Some(d) = decay {
            mask |= 1 << i;
            if !out_decays.is_null() {
                // SAFETY: caller contract (3 doubles), i < 3.
                unsafe { *out_decays.add(i) = *d };
            }
        }
    }
    mask
}

/// State storage floats for the rack in `params` (`ir_len`: the reverb impulse frames).
///
/// # Safety
/// `params` is null or valid for `count` doubles.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_rig_storage_len(
    sample_rate: f64,
    params: *const f64,
    count: u32,
    ir_len: usize,
) -> usize {
    // SAFETY: caller contract.
    let values = unsafe { read_only(params, count as usize) };
    if valid_rate(sample_rate) { GuitarRig::storage_len(sample_rate, values, ir_len) } else { 0 }
}

/// Builds a rig in `rig` (C++ `makeEffect("guitar-rig")`). `params`: `count` values in catalog
/// order (missing -> default, out of range -> clamped). `kernels` / `kernel_lens`: 3 entries, one
/// per reverb instance (null / 0 where `garak_rs_rig_reverb_decays` has no bit). All buffers must
/// outlive the rig and keep their address. Returns `GARAK_RS_OK` or a negative `GARAK_RS_ERR_*`.
///
/// # Safety
/// `rig` is null or valid for `garak_rs_rig_size()` byte writes; `kernels` / `kernel_lens` are
/// null or valid for 3 reads, each kernel pointer null or valid for its length; the other
/// pointers are null or valid for their lengths.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_rig_init(
    rig: *mut GarakRsRig,
    sample_rate: f64,
    params: *const f64,
    count: u32,
    storage: *mut f32,
    storage_len: usize,
    kernels: *const *const f32,
    kernel_lens: *const usize,
    ir_len: usize,
) -> i32 {
    if rig.is_null() || !(rig as usize).is_multiple_of(align_of::<RigState>()) {
        return GARAK_RS_ERR_ARGUMENT;
    }
    // SAFETY: caller contract; the buffers outlive the rig, hence 'static.
    let (values, storage, pointers, lens) = unsafe {
        (
            read_only(params, count as usize),
            samples(storage, storage_len),
            read_only(kernels, MAX_REVERBS),
            read_only(kernel_lens, MAX_REVERBS),
        )
    };
    let mut views: [&'static [f32]; MAX_REVERBS] = [&[]; MAX_REVERBS];
    for (i, view) in views.iter_mut().enumerate() {
        let (Some(&p), Some(&len)) = (pointers.get(i), lens.get(i)) else { continue };
        // SAFETY: caller contract (null or valid for `len` floats, outliving the rig).
        *view = unsafe { read_only(p, len) };
    }
    match GuitarRig::new(sample_rate, values, storage, views, ir_len) {
        Ok(state) => {
            // SAFETY: non-null, aligned (checked above), valid for the size (caller contract).
            unsafe { ptr::write(rig.cast::<RigState>(), state) };
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
/// `rig` is null or initialised; `stereo` is null or valid for `2 * frames` floats.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_rig_process(rig: *mut GarakRsRig, stereo: *mut f32, frames: u32) {
    // SAFETY: caller contract.
    let (r, s) = unsafe { (self::rig(rig), samples(stereo, frames as usize * 2)) };
    if let Some(r) = r {
        r.process_interleaved(s);
    }
}

/// Planar stereo in place.
///
/// # Safety
/// `rig` is null or initialised; `left` / `right` are null or valid for `frames` floats.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_rig_process_planar(
    rig: *mut GarakRsRig,
    left: *mut f32,
    right: *mut f32,
    frames: u32,
) {
    // SAFETY: caller contract.
    let (r, l, rr) =
        unsafe { (self::rig(rig), samples(left, frames as usize), samples(right, frames as usize)) };
    if let Some(r) = r {
        r.process_planar(l, rr);
    }
}

/// Every parameter at once, then automate in place (C++ `StereoProcessor::automate`).
///
/// # Safety
/// `rig` is null or initialised; `params` is null or valid for `count` doubles.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_rig_automate(rig: *mut GarakRsRig, params: *const f64, count: u32) {
    // SAFETY: caller contract.
    let (r, v) = unsafe { (self::rig(rig), read_only(params, count as usize)) };
    if let Some(r) = r {
        r.automate(v);
    }
}

/// Stages one parameter; `garak_rs_rig_commit` applies the staged changes.
///
/// # Safety
/// `rig` is null or initialised.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_rig_set_param(rig: *mut GarakRsRig, index: u32, value: f64) {
    // SAFETY: caller contract.
    if let Some(r) = unsafe { self::rig(rig) } {
        r.set_param(index as usize, value);
    }
}

/// # Safety
/// `rig` is null or initialised.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_rig_commit(rig: *mut GarakRsRig) {
    // SAFETY: caller contract.
    if let Some(r) = unsafe { self::rig(rig) } {
        r.commit();
    }
}

/// # Safety
/// `rig` is null or initialised.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_rig_param(rig: *const GarakRsRig, index: u32) -> f64 {
    // SAFETY: caller contract.
    unsafe { rig_ref(rig) }.map_or(0.0, |r| r.param(index as usize))
}

/// # Safety
/// `rig` is null or initialised.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_rig_reset(rig: *mut GarakRsRig) {
    // SAFETY: caller contract.
    if let Some(r) = unsafe { self::rig(rig) } {
        r.reset();
    }
}

/// # Safety
/// `rig` is null or initialised.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_rig_latency(rig: *const GarakRsRig) -> u32 {
    // SAFETY: caller contract.
    unsafe { rig_ref(rig) }.map_or(0, GuitarRig::latency_frames)
}

/// # Safety
/// `rig` is null or initialised.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_rig_tail(rig: *const GarakRsRig) -> f64 {
    // SAFETY: caller contract.
    unsafe { rig_ref(rig) }.map_or(0.0, GuitarRig::tail_seconds)
}

/// C++ `GuitarRig::takeStateFrom` (by module code and instance). Returns 1 when the two rigs
/// exchanged their whole state storage; the caller must then swap the two storage buffers too.
///
/// # Safety
/// Both are null or initialised.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_rig_take_state(rig: *mut GarakRsRig, previous: *mut GarakRsRig) -> i32 {
    if rig == previous {
        return 0;
    }
    // SAFETY: caller contract; the pointers are distinct (checked above).
    match unsafe { (self::rig(rig), self::rig(previous)) } {
        (Some(a), Some(b)) => i32::from(a.take_state_from(b)),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::vec;

    #[test]
    fn rig_through_the_c_abi() {
        let sr = 48_000.0;
        assert_eq!(garak_rs_rig_param_count(), 154);
        let mut name = [0u8; 32];
        let n = unsafe { garak_rs_rig_param_id(0, name.as_mut_ptr(), name.len()) };
        assert_eq!(&name[..n], b"compSustain");
        let mut params: vec::Vec<f64> = PARAMS.iter().map(|d| d.default).collect();
        let slot = PARAMS.iter().position(|d| d.id == "rackSlot6").unwrap();
        params[slot] = 10.0;
        params[PARAMS.iter().position(|d| d.id == "reverbEnabled").unwrap()] = 1.0;
        let mut decays = [0.0; 3];
        assert_eq!(unsafe { garak_rs_rig_reverb_decays(params.as_ptr(), 154, decays.as_mut_ptr()) }, 1);
        assert_eq!(decays[0], 0.45);
        let ir_len = garak_rs_rig_reverb_ir_len(sr);
        let (mut l, mut r) = (vec![0.0f32; ir_len], vec![0.0f32; ir_len]);
        let mut scratch = vec![0.0f32; garak_rs_rig_reverb_scratch_len(sr)];
        let ok = unsafe {
            garak_rs_rig_reverb_generate_ir(
                sr,
                decays[0],
                l.as_mut_ptr(),
                r.as_mut_ptr(),
                ir_len,
                scratch.as_mut_ptr(),
                scratch.len(),
            )
        };
        assert_eq!(ok, 1);
        let mut kernels = vec![0.0f32; crate::fx::garak_rs_reverb_kernel_len(ir_len)];
        let ok = unsafe {
            crate::fx::garak_rs_reverb_prepare_kernels(
                l.as_ptr(),
                r.as_ptr(),
                ir_len,
                kernels.as_mut_ptr(),
                kernels.len(),
            )
        };
        assert_eq!(ok, 1);
        let mut storage = vec![0.0f32; unsafe { garak_rs_rig_storage_len(sr, params.as_ptr(), 154, ir_len) }];
        let mut state = vec![0u64; garak_rs_rig_size().div_ceil(8)];
        let rig = state.as_mut_ptr().cast::<GarakRsRig>();
        let pointers = [kernels.as_ptr(), ptr::null(), ptr::null()];
        let lens = [kernels.len(), 0, 0];
        let rc = unsafe {
            garak_rs_rig_init(
                rig,
                sr,
                params.as_ptr(),
                154,
                storage.as_mut_ptr(),
                storage.len(),
                pointers.as_ptr(),
                lens.as_ptr(),
                ir_len,
            )
        };
        assert_eq!(rc, GARAK_RS_OK);
        let mut buf = vec![0.25f32; 2 * 512];
        unsafe {
            garak_rs_rig_process(rig, buf.as_mut_ptr(), 512);
            assert_eq!(garak_rs_rig_latency(rig), 16);
            assert!((garak_rs_rig_tail(rig) - 4.45).abs() < 1e-12);
            garak_rs_rig_set_param(rig, 2, 6.0);
            garak_rs_rig_commit(rig);
            assert_eq!(garak_rs_rig_param(rig, 2), 6.0);
            // No kernels for a switched-on reverb.
            let rc = garak_rs_rig_init(
                rig,
                sr,
                params.as_ptr(),
                154,
                storage.as_mut_ptr(),
                storage.len(),
                ptr::null(),
                ptr::null(),
                ir_len,
            );
            assert_eq!(rc, GARAK_RS_ERR_KERNELS);
            garak_rs_rig_process(ptr::null_mut(), buf.as_mut_ptr(), 512);
            garak_rs_rig_automate(ptr::null_mut(), ptr::null(), 0);
        }
        assert!(buf.iter().all(|x| x.is_finite()));
    }

    /// The web's parity scene (src/audio/rust/guitarRig.test.ts): a full rack with the plate reverb
    /// and a tuner, live knob changes, then a structural rebuild (rack reorder, new Decay) that adopts
    /// the old rig's state, rendered here with the desktop's platform math. Writes the scene, its
    /// input and this native render to `target/rig-parity/`; the TS test renders the same scene on
    /// the WASM rig and compares.
    #[test]
    fn writes_the_web_parity_scene() {
        use std::string::String;
        use std::vec::Vec;
        const SR: f64 = 48_000.0;
        const BLOCK: usize = 128;
        const BLOCKS: usize = 600;
        type Step = (usize, &'static str, Vec<(&'static str, f64)>);
        let full = |extra: &[(&'static str, f64)]| {
            let mut p: Vec<(&'static str, f64)> = std::vec![
                ("driveEnabled", 1.0),
                ("fuzzEnabled", 1.0),
                ("phaserEnabled", 1.0),
                ("chorusEnabled", 1.0),
                ("delayEnabled", 1.0),
                ("tremoloEnabled", 1.0),
                ("reverbEnabled", 1.0),
                ("driveEnabled_2", 1.0),
                ("ampEnabled_2", 1.0),
                ("ampModel", 1.0),
                ("ampModel_2", 3.0),
                ("delayTime", 210.0),
                ("fuzzLevel", -24.0),
                ("rackSlot0", 1.0),
                ("rackSlot1", 2.0),
                ("rackSlot2", 7.0),
                ("rackSlot3", 8.0),
                ("rackSlot4", 3.0),
                ("rackSlot5", 11.0),
                ("rackSlot6", 4.0),
                ("rackSlot7", 5.0),
                ("rackSlot8", 6.0),
                ("rackSlot9", 9.0),
                ("rackSlot10", 10.0),
                ("rackSlot11", 18.0),
                ("rackSlot12", 19.0),
            ];
            for &(k, v) in extra {
                match p.iter_mut().find(|(id, _)| *id == k) {
                    Some(slot) => slot.1 = v,
                    None => p.push((k, v)),
                }
            }
            p
        };
        let steps: Vec<Step> = std::vec![
            (0, "create", full(&[])),
            (
                200,
                "configure",
                full(&[
                    ("ampGain", 25.0),
                    ("cabinet", 3.0),
                    ("micPosition", 0.8),
                    ("delayTime", 90.0),
                    ("chorusMix", 0.6)
                ])
            ),
            (
                400,
                "rebuild",
                full(&[
                    ("ampGain", 25.0),
                    ("rackSlot7", 6.0),
                    ("rackSlot8", 5.0),
                    ("reverbDecay", 0.8),
                    ("rackSlot13", 22.0),
                    ("delayEnabled_2", 1.0)
                ])
            ),
        ];
        let values = |p: &[(&str, f64)]| -> Vec<f64> {
            PARAMS
                .iter()
                .map(|d| p.iter().find(|(id, _)| *id == d.id).map_or(d.default, |(_, v)| *v))
                .collect()
        };
        let ir_len = guitar::reverb_ir_len(SR);
        let kernels_for = |v: &[f64]| -> [Vec<f32>; 3] {
            let mut out: [Vec<f32>; 3] = Default::default();
            for (o, decay) in out.iter_mut().zip(guitar::reverb_decays(v)) {
                let Some(decay) = decay else { continue };
                let (mut l, mut r) = (std::vec![0.0f32; ir_len], std::vec![0.0f32; ir_len]);
                let mut scratch = std::vec![0.0f32; guitar::reverb_ir_scratch_len(SR)];
                assert!(guitar::generate_reverb_ir(SR, decay, &mut l, &mut r, &mut scratch));
                *o = std::vec![0.0f32; garak_dsp::fx::reverb::kernel_len(ir_len)];
                assert!(garak_dsp::fx::reverb::prepare_kernels(&l, &r, ir_len, o));
            }
            out
        };
        // Owned buffers outlive the rigs (leaked: a test process).
        let build = |v: &[f64]| -> GuitarRig<'static> {
            let kernels: &'static [Vec<f32>; 3] = std::boxed::Box::leak(std::boxed::Box::new(kernels_for(v)));
            let storage: &'static mut [f32] = std::boxed::Box::leak(
                std::vec![0.0f32; GuitarRig::storage_len(SR, v, ir_len)].into_boxed_slice(),
            );
            GuitarRig::new(SR, v, storage, [&kernels[0], &kernels[1], &kernels[2]], ir_len).unwrap()
        };
        let input: Vec<f32> = (0..BLOCKS * BLOCK)
            .flat_map(|i| {
                let t = i as f32 / SR as f32;
                let env = if (i / 6000) % 2 == 0 { 0.6 } else { 0.15 };
                let l = env
                    * (0.7 * (t * 2.0 * 196.0 * core::f32::consts::PI).sin()
                        + 0.3 * (t * 2.0 * 523.0 * core::f32::consts::PI).sin());
                [l, l * 0.8 + if i % 7919 == 0 { 0.5 } else { 0.0 }]
            })
            .collect();
        let mut rig = build(&values(&steps[0].2));
        let (mut out, mut tap_out) = (Vec::with_capacity(input.len()), Vec::with_capacity(BLOCKS * BLOCK));
        let (mut l, mut r, mut tap) = ([0.0f32; BLOCK], [0.0f32; BLOCK], [0.0f32; BLOCK]);
        for b in 0..BLOCKS {
            for (block, kind, params) in &steps[1..] {
                if *block == b {
                    let v = values(params);
                    if *kind == "configure" {
                        rig.automate(&v);
                    } else {
                        let mut next = build(&v);
                        next.take_state_from(&mut rig);
                        rig = next;
                    }
                }
            }
            for i in 0..BLOCK {
                l[i] = input[2 * (b * BLOCK + i)];
                r[i] = input[2 * (b * BLOCK + i) + 1];
            }
            rig.process_planar_tap(&mut l, &mut r, &mut tap);
            for i in 0..BLOCK {
                out.extend_from_slice(&[l[i], r[i]]);
            }
            tap_out.extend_from_slice(&tap);
        }
        assert!(out.iter().all(|x| x.is_finite()) && out.iter().any(|x| x.abs() > 0.05));
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/rig-parity");
        std::fs::create_dir_all(&dir).unwrap();
        let mut json =
            std::format!("{{\"sampleRate\":{SR},\"block\":{BLOCK},\"blocks\":{BLOCKS},\"steps\":[");
        for (i, (block, kind, params)) in steps.iter().enumerate() {
            let body: Vec<String> = params.iter().map(|(k, v)| std::format!("\"{k}\":{v:?}")).collect();
            json += &std::format!(
                "{}{{\"block\":{block},\"kind\":\"{kind}\",\"params\":{{{}}}}}",
                if i == 0 { "" } else { "," },
                body.join(",")
            );
        }
        json += "]}";
        let bytes = |v: &[f32]| -> Vec<u8> { v.iter().flat_map(|x| x.to_le_bytes()).collect() };
        std::fs::write(dir.join("scene.json"), json).unwrap();
        std::fs::write(dir.join("input.f32"), bytes(&input)).unwrap();
        std::fs::write(dir.join("native.f32"), bytes(&out)).unwrap();
        std::fs::write(dir.join("tap.f32"), bytes(&tap_out)).unwrap();
    }
}

//! Instrument additions to the engine C ABI (header `include/garak_engine_instruments.h`): sample
//! set registration (`samples.register`), live MIDI to instrument tracks, IEUM WAVE's handshake and
//! patch validation (the synth renders only in this engine since 0.3.3, docs/IEUM_WAVE.md), and the
//! instrument parity projects of `garak_engine::testkit::instruments`. Same thread rules as the rest of
//! `garak_rs_engine_*`: every function here is the control half.

use alloc::boxed::Box;

use garak_engine::testkit::instrument_project;

use super::{GARAK_RS_ENGINE_ERROR, GarakRsEngine, GarakRsTestProject, bytes, control, ticket};

fn status(result: Result<(), garak_engine::Error>, error: &mut alloc::string::String) -> i32 {
    match result {
        Ok(()) => 0,
        Err(e) => {
            error.clear();
            error.push_str(e.message());
            GARAK_RS_ENGINE_ERROR
        }
    }
}

/// Registers (or replaces) a sample instrument / kit: the host's `samples.register` params as JSON
/// (`{ id, manifest, files, startOffset }`). Every zone's PCM must be registered first. Returns 0 or -1.
///
/// # Safety
/// `e` is null or live; `json` is null or valid for `json_len` reads.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_register_samples(
    e: *mut GarakRsEngine,
    json: *const u8,
    json_len: usize,
) -> i32 {
    // SAFETY: caller contract.
    let Some((c, error)) = (unsafe { control(e) }) else { return GARAK_RS_ENGINE_ERROR };
    // SAFETY: caller contract.
    let text = unsafe { bytes(json, json_len) };
    status(c.register_samples_json(text), error)
}

/// Live note-on (rings until its note-off). Returns the command ticket or -1.
///
/// # Safety
/// `e` is null or live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_note_on(
    e: *mut GarakRsEngine,
    track: u32,
    pitch: i32,
    velocity: f32,
    id: i32,
) -> i64 {
    // SAFETY: caller contract.
    let Some((c, error)) = (unsafe { control(e) }) else { return i64::from(GARAK_RS_ENGINE_ERROR) };
    ticket(c.note_on(track, pitch, velocity, id), error)
}

/// Live note-off (`id` >= 0 matches that note-on, else every live note of `pitch`).
///
/// # Safety
/// `e` is null or live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_note_off(
    e: *mut GarakRsEngine,
    track: u32,
    pitch: i32,
    id: i32,
) -> i64 {
    // SAFETY: caller contract.
    let Some((c, error)) = (unsafe { control(e) }) else { return i64::from(GARAK_RS_ENGINE_ERROR) };
    ticket(c.note_off(track, pitch, id), error)
}

/// An editor audition note of `frames` frames.
///
/// # Safety
/// `e` is null or live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_preview_note(
    e: *mut GarakRsEngine,
    track: u32,
    pitch: i32,
    velocity: f32,
    frames: u32,
) -> i64 {
    // SAFETY: caller contract.
    let Some((c, error)) = (unsafe { control(e) }) else { return i64::from(GARAK_RS_ENGINE_ERROR) };
    ticket(c.preview_note(track, pitch, velocity, frames), error)
}

/// Live controller (0..127 CC, 128 channel pressure, 129 pitch bend -8192..8191, 130 program,
/// 131 bend range 0..48).
///
/// # Safety
/// `e` is null or live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_control_change(
    e: *mut GarakRsEngine,
    track: u32,
    controller: i32,
    value: i32,
) -> i64 {
    // SAFETY: caller contract.
    let Some((c, error)) = (unsafe { control(e) }) else { return i64::from(GARAK_RS_ENGINE_ERROR) };
    ticket(c.control_change(track, controller, value), error)
}

/// Live panic on one track.
///
/// # Safety
/// `e` is null or live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_all_notes_off(e: *mut GarakRsEngine, track: u32) -> i64 {
    // SAFETY: caller contract.
    let Some((c, error)) = (unsafe { control(e) }) else { return i64::from(GARAK_RS_ENGINE_ERROR) };
    ticket(c.all_notes_off(track), error)
}

/// Instrument parity project `case` (0 synths, 1 samples, 2 vintage, 3 all), or null. Destroy with
/// `garak_rs_testkit_destroy`; PCM through `garak_rs_testkit_asset`.
#[unsafe(no_mangle)]
pub extern "C" fn garak_rs_testkit_instruments_create(
    case: u32,
    seconds: f64,
    sample_rate: u32,
) -> *mut GarakRsTestProject {
    if case > 4 || !(0.05..=600.0).contains(&seconds) || !(8000..=192_000).contains(&sample_rate) {
        return core::ptr::null_mut();
    }
    Box::into_raw(Box::new(GarakRsTestProject { project: instrument_project(case, seconds, sample_rate) }))
}

/// Number of sample sets (`samples.register` JSON) of a test project.
///
/// # Safety
/// `p` is null or live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_testkit_sample_set_count(p: *const GarakRsTestProject) -> u32 {
    // SAFETY: caller contract.
    unsafe { p.as_ref() }.map_or(0, |p| p.project.sample_sets.len() as u32)
}

/// Sample set `index` as `samples.register` JSON (UTF-8, not terminated; valid until destroy), or null.
///
/// # Safety
/// `p` is null or live; `len` is null or valid for one write.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_testkit_sample_set(
    p: *const GarakRsTestProject,
    index: u32,
    len: *mut usize,
) -> *const u8 {
    // SAFETY: caller contract.
    let Some(s) = (unsafe { p.as_ref() }).and_then(|p| p.project.sample_sets.get(index as usize)) else {
        return core::ptr::null();
    };
    // SAFETY: caller contract.
    if let Some(out) = unsafe { len.as_mut() } {
        *out = s.len();
    }
    s.as_ptr()
}

/// IEUM WAVE's patch schema fingerprint (the `wavetable.schemaFingerprint` of the host handshake).
#[unsafe(no_mangle)]
pub extern "C" fn garak_rs_wave_schema_fingerprint() -> u32 {
    garak_engine::wave_host::SCHEMA_FINGERPRINT
}

/// Validates an IEUM WAVE patch (IEWAVE01 pack) on the control thread. Returns 0 and writes the
/// patch's export tail (seconds) to `tail_seconds`, or -1 and writes the reason (UTF-8, truncated to
/// `capacity`) to `error`. Either way returns through `error_len` the full reason length (0 on success).
///
/// # Safety
/// `patch` is null or valid for `len` reads; `tail_seconds` and `error_len` are null or valid for
/// one write; `error` is null or valid for `capacity` writes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_wave_check_patch(
    patch: *const u8,
    len: usize,
    tail_seconds: *mut f64,
    error: *mut u8,
    capacity: usize,
    error_len: *mut usize,
) -> i32 {
    // SAFETY: caller contract.
    let data = unsafe { bytes(patch, len) };
    let (status, tail, message) = match garak_engine::wave_host::check_patch(data) {
        Ok(tail) => (0, tail, alloc::string::String::new()),
        Err(e) => (GARAK_RS_ENGINE_ERROR, 0.0, e),
    };
    // SAFETY: caller contract.
    if let Some(out) = unsafe { tail_seconds.as_mut() } {
        *out = tail;
    }
    let n = message.len().min(capacity);
    if !error.is_null() && n > 0 {
        // SAFETY: `error` holds `capacity >= n` bytes; the regions cannot overlap.
        unsafe { core::ptr::copy_nonoverlapping(message.as_ptr(), error, n) };
    }
    // SAFETY: caller contract.
    if let Some(out) = unsafe { error_len.as_mut() } {
        *out = message.len();
    }
    status
}

/// The default IEUM WAVE patch as an IEWAVE01 pack (tests build patches from it). Writes up to
/// `capacity` bytes to `out` (null to query) and returns the pack's length.
///
/// # Safety
/// `out` is null or valid for `capacity` writes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_wave_default_patch(out: *mut u8, capacity: usize) -> usize {
    let pack = garak_engine::wave_host::default_patch();
    let n = pack.len().min(capacity);
    if !out.is_null() && n > 0 {
        // SAFETY: `out` holds `capacity >= n` bytes; the regions cannot overlap.
        unsafe { core::ptr::copy_nonoverlapping(pack.as_ptr(), out, n) };
    }
    pack.len()
}

/// The wire index of IEUM WAVE parameter `id` (schema.json `params[].id`, UTF-8), or -1.
///
/// # Safety
/// `id` is null or valid for `len` reads.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_wave_parameter_index(id: *const u8, len: usize) -> i32 {
    // SAFETY: caller contract.
    let name = unsafe { bytes(id, len) };
    core::str::from_utf8(name)
        .ok()
        .and_then(garak_engine::wave_host::parameter_index)
        .map_or(-1, |i| i as i32)
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use super::*;
    use std::string::String;
    use std::vec::Vec;

    const HEADER: &str = include_str!("../../include/garak_engine_instruments.h");
    const SOURCE: &str = include_str!("instruments.rs");

    #[test]
    fn header_declares_every_export() {
        let names: Vec<String> = SOURCE
            .lines()
            .filter_map(|l| l.split("extern \"C\" fn ").nth(1))
            .filter_map(|rest| rest.split('(').next())
            .filter(|name| name.starts_with("garak_rs_"))
            .map(String::from)
            .collect();
        assert!(names.len() >= 9, "{names:?}");
        for name in names {
            assert!(
                HEADER.contains(&std::format!("{name}(")),
                "garak_engine_instruments.h is missing {name}"
            );
        }
    }

    #[test]
    fn renders_the_instrument_projects_through_the_c_abi() {
        unsafe {
            for case in 0..5 {
                let p = garak_rs_testkit_instruments_create(case, 1.0, 48_000);
                let e = garak_rs_engine_create(48_000, 256, 1);
                assert!(!p.is_null() && !e.is_null());
                for i in 0..garak_rs_testkit_asset_count(p) {
                    let (mut id, mut id_len, mut rate, mut ch, mut s, mut n) =
                        (core::ptr::null(), 0, 0, 0, core::ptr::null(), 0);
                    assert_eq!(
                        garak_rs_testkit_asset(
                            p,
                            i,
                            &mut id,
                            &mut id_len,
                            &mut rate,
                            &mut ch,
                            &mut s,
                            &mut n
                        ),
                        1
                    );
                    assert_eq!(garak_rs_engine_put_asset(e, id, id_len, rate, ch, s, n), 0);
                }
                for i in 0..garak_rs_testkit_sample_set_count(p) {
                    let mut len = 0;
                    let json = garak_rs_testkit_sample_set(p, i, &mut len);
                    assert_eq!(garak_rs_engine_register_samples(e, json, len), 0);
                }
                let mut len = 0;
                let json = garak_rs_testkit_json(p, &mut len);
                let applied = garak_rs_engine_set(e, json, len, core::ptr::null(), 0);
                let mut msg = [0u8; 256];
                let n = garak_rs_engine_last_error(e, msg.as_mut_ptr(), msg.len());
                assert_eq!(applied, 3, "case {case}: {}", String::from_utf8_lossy(&msg[..n.min(256)]));
                assert!(garak_rs_engine_transport(e, 0, 0) > 0);
                let mut out = std::vec![0.0f32; 2 * 9600];
                garak_rs_engine_render(e, out.as_mut_ptr(), 9600);
                assert!(out.iter().any(|x| x.abs() > 1e-3), "case {case} silent");
                assert!(out.iter().all(|x| x.is_finite()));
                assert!(garak_rs_engine_note_on(e, 0, 60, 0.8, 1) > 0);
                assert!(garak_rs_engine_control_change(e, 0, 64, 127) > 0);
                assert!(garak_rs_engine_note_off(e, 0, 60, 1) > 0);
                assert!(garak_rs_engine_preview_note(e, 0, 64, 0.5, 4800) > 0);
                assert!(garak_rs_engine_all_notes_off(e, 0) > 0);
                assert_eq!(garak_rs_engine_control_change(e, 0, 129, 9000), -1);
                garak_rs_engine_render(e, out.as_mut_ptr(), 9600);
                garak_rs_engine_collect(e);
                garak_rs_engine_destroy(e);
                garak_rs_testkit_destroy(p);
            }
            assert!(garak_rs_testkit_instruments_create(9, 1.0, 48_000).is_null());
        }
    }
}

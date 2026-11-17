//! `garak-engine` for the browser AudioWorklet (docs/RUST_ENGINE.md 5). Not loaded by the app yet.
//!
//! Like `garak-wasm`: raw `extern "C"` exports, no wasm-bindgen glue, one engine per module
//! instance (one worklet node). Unlike it, the engine owns unbounded project data, so this module
//! uses std's allocator (dlmalloc on wasm32-unknown-unknown):
//! - Control exports (`*_alloc`, `put_asset`, `set`, `patch`, `transport`, `collect`) may allocate
//!   and grow memory. They run from the worklet's `port.onmessage`, between render quanta; the
//!   host re-creates its typed-array views after each one (memory may have grown).
//! - `garak_engine_render` never allocates (the counting-allocator test in garak-engine holds the
//!   renderer to that), so views stay valid across `process()` calls.
//!
//! Strings and PCM come in through buffers from `garak_engine_alloc` (freed by the caller with
//! `garak_engine_free`); output is an interleaved stereo buffer owned by the module.

use core::cell::RefCell;

use garak_engine::{Applied, Controller, EngineConfig, PcmAsset, Renderer, engine};

mod instruments;

struct Instance {
    control: Controller,
    render: Renderer,
    output: Vec<f32>,
}

thread_local! {
    // A wasm instance runs on exactly one thread (the audio rendering thread); on the host only
    // the unit tests below touch it.
    static INSTANCE: RefCell<Option<Instance>> = const { RefCell::new(None) };
    static ERROR: RefCell<String> = const { RefCell::new(String::new()) };
}

pub const ABI_VERSION: u32 = 1;
const ERROR_CODE: i32 = -1;

fn fail(message: &str) -> i32 {
    ERROR.with(|e| {
        let mut e = e.borrow_mut();
        e.clear();
        e.push_str(message);
    });
    ERROR_CODE
}

fn with<R>(f: impl FnOnce(&mut Instance) -> R) -> Option<R> {
    INSTANCE.with(|i| i.borrow_mut().as_mut().map(f))
}

/// # Safety
/// `p` is null or valid for `len` reads (a buffer from `garak_engine_alloc`).
unsafe fn bytes<'a>(p: *const u8, len: usize) -> &'a [u8] {
    if p.is_null() || len == 0 {
        &[]
    } else {
        // SAFETY: forwarded caller contract.
        unsafe { core::slice::from_raw_parts(p, len) }
    }
}

fn applied(result: Result<Applied, garak_engine::Error>) -> i32 {
    match result {
        Ok(Applied::None) => 0,
        Ok(Applied::Diff) => 1,
        Ok(Applied::Tracks) => 2,
        Ok(Applied::Full) => 3,
        Err(e) => fail(e.message()),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_abi_version() -> u32 {
    ABI_VERSION
}

/// A buffer of `len` bytes for inputs (8-byte aligned, so it can hold `f32` PCM).
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_alloc(len: usize) -> *mut u8 {
    let words = len.div_ceil(8).max(1);
    let mut v: Vec<u64> = vec![0; words];
    let p = v.as_mut_ptr().cast::<u8>();
    core::mem::forget(v);
    p
}

/// # Safety
/// `p` came from `garak_engine_alloc(len)` and is not used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_engine_free(p: *mut u8, len: usize) {
    if !p.is_null() {
        let words = len.div_ceil(8).max(1);
        // SAFETY: rebuilds the Vec<u64> `garak_engine_alloc` forgot (same pointer and capacity).
        drop(unsafe { Vec::from_raw_parts(p.cast::<u64>(), words, words) });
    }
}

/// (Re)creates the module's engine. Returns 0, or -1 for an invalid format.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_create(sample_rate: u32, max_block: u32, offline: i32) -> i32 {
    match engine(EngineConfig { sample_rate, max_block, offline: offline != 0 }) {
        Ok((control, render)) => {
            let output = vec![0.0; max_block as usize * 2];
            INSTANCE.with(|i| *i.borrow_mut() = Some(Instance { control, render, output }));
            0
        }
        Err(e) => fail(e.message()),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_destroy() {
    INSTANCE.with(|i| *i.borrow_mut() = None);
}

/// Last error message: pointer and length (UTF-8), valid until the next control call.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_error_ptr() -> *const u8 {
    ERROR.with(|e| e.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_error_len() -> usize {
    ERROR.with(|e| e.borrow().len())
}

/// Registers interleaved PCM (`count` samples). Returns 0 or -1.
///
/// # Safety
/// The pointers are null or valid for their lengths.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_engine_put_asset(
    id: *const u8,
    id_len: usize,
    sample_rate: u32,
    channels: u32,
    samples: *const f32,
    count: usize,
) -> i32 {
    // SAFETY: caller contract.
    let id = unsafe { bytes(id, id_len) };
    let samples: &[f32] =
        // SAFETY: caller contract.
        if samples.is_null() || count == 0 { &[] } else { unsafe { core::slice::from_raw_parts(samples, count) } };
    let Ok(id) = core::str::from_utf8(id) else { return fail("Invalid native PCM asset id") };
    let asset = PcmAsset { sample_rate, channels, samples: samples.to_vec() };
    match with(|i| i.control.put_asset(id, asset)) {
        Some(Ok(())) => 0,
        Some(Err(e)) => fail(e.message()),
        None => fail("No engine; call garak_engine_create"),
    }
}

/// `project.set`. Returns the applied kind (0 none, 1 diff, 2 tracks, 3 full) or -1.
///
/// # Safety
/// The pointers are null or valid for their lengths.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_engine_set(
    json: *const u8,
    json_len: usize,
    blob: *const u8,
    blob_len: usize,
) -> i32 {
    // SAFETY: caller contract.
    let (json, blob) = unsafe { (bytes(json, json_len), bytes(blob, blob_len)) };
    with(|i| applied(i.control.set_json(json, blob)))
        .unwrap_or_else(|| fail("No engine; call garak_engine_create"))
}

/// `project.patch`. Returns like `garak_engine_set`.
///
/// # Safety
/// The pointers are null or valid for their lengths.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_engine_patch(
    json: *const u8,
    json_len: usize,
    blob: *const u8,
    blob_len: usize,
) -> i32 {
    // SAFETY: caller contract.
    let (json, blob) = unsafe { (bytes(json, json_len), bytes(blob, blob_len)) };
    with(|i| applied(i.control.patch_json(json, blob)))
        .unwrap_or_else(|| fail("No engine; call garak_engine_create"))
}

/// 0 play, 1 pause, 2 stop, 3 seek to `frame` (a JS number). Returns 0 or -1.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_transport(command: u32, frame: f64) -> i32 {
    let result = with(|i| match command {
        0 => i.control.play(),
        1 => i.control.pause(),
        2 => i.control.stop(),
        3 => i.control.seek(frame as i64),
        _ => Err(garak_engine::Error::new("Unknown transport command")),
    });
    match result {
        Some(Ok(_)) => 0,
        Some(Err(e)) => fail(e.message()),
        None => fail("No engine; call garak_engine_create"),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_collect() {
    let _ = with(|i| i.control.collect());
}

/// Plug-in delay (frames) of the last submitted graph.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_latency() -> u32 {
    with(|i| i.control.graph_info().map_or(0, |g| g.0)).unwrap_or(0)
}

/// Release tail (seconds) of the last submitted graph.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_tail() -> f64 {
    with(|i| i.control.graph_info().map_or(0.0, |g| g.2)).unwrap_or(0.0)
}

/// Transport frame published by the last render.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_frame() -> f64 {
    with(|i| i.control.snapshot().frame as f64).unwrap_or(0.0)
}

/// The output buffer (`max_block` interleaved stereo frames); stable until the next create.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_output_ptr() -> *const f32 {
    with(|i| i.output.as_ptr()).unwrap_or(core::ptr::null())
}

/// Renders `frames` (at most `max_block`) into the output buffer. Real-time safe; returns the
/// frames rendered.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_render(frames: u32) -> u32 {
    with(|i| {
        let n = (frames as usize).min(i.output.len() / 2);
        if let Some(out) = i.output.get_mut(..n * 2) {
            i.render.render(out);
        }
        n as u32
    })
    .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use garak_engine::testkit::project;

    #[test]
    fn renders_through_the_exports() {
        let p = project(3, 0.5, 48_000);
        assert_eq!(garak_engine_create(48_000, 128, 1), 0);
        for (id, a) in &p.assets {
            let r = unsafe {
                garak_engine_put_asset(
                    id.as_ptr(),
                    id.len(),
                    a.sample_rate,
                    a.channels,
                    a.samples.as_ptr(),
                    a.samples.len(),
                )
            };
            assert_eq!(r, 0);
        }
        assert_eq!(unsafe { garak_engine_set(p.json.as_ptr(), p.json.len(), core::ptr::null(), 0) }, 3);
        assert_eq!(garak_engine_transport(0, 0.0), 0);
        assert_eq!(garak_engine_latency(), 16);
        let mut energy = 0.0f32;
        for _ in 0..100 {
            assert_eq!(garak_engine_render(128), 128);
            let out = unsafe { core::slice::from_raw_parts(garak_engine_output_ptr(), 256) };
            energy += out.iter().map(|x| x * x).sum::<f32>();
        }
        assert!(energy > 0.0);
        assert_eq!(garak_engine_frame(), 12_800.0);
        assert_eq!(unsafe { garak_engine_set(b"[".as_ptr(), 1, core::ptr::null(), 0) }, -1);
        assert!(garak_engine_error_len() > 0);
        let buf = garak_engine_alloc(13);
        unsafe { garak_engine_free(buf, 13) };
        garak_engine_destroy();
        assert_eq!(garak_engine_render(128), 0);
    }
}

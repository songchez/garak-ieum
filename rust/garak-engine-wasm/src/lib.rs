//! `garak-engine` for the browser AudioWorklet (docs/RUST_ENGINE.md 5): the web host behind the
//! `garak.rustEngine` flag (src/audio/rust/RustWebAudioEngine.ts) and its offline export worker.
//!
//! Like `garak-wasm`: raw `extern "C"` exports, no wasm-bindgen glue, one engine per module
//! instance (one worklet node, or one export worker). Unlike it, the engine owns unbounded project
//! data, so this module has a general allocator:
//! - std's allocator (dlmalloc on wasm32-unknown-unknown). A `no_std` build with dlmalloc as an
//!   explicit global allocator measured 3.7 KiB *larger* (std's copy is better tuned), so std stays.
//! - Control exports (`*_alloc*`, `put_asset*`, `set`, `patch`, `transport`, `collect`) may
//!   allocate and grow memory. They run from the worklet's `port.onmessage`, between render quanta;
//!   the host re-creates its typed-array views after each one (memory may have grown).
//! - `garak_engine_render*` never allocates (the counting-allocator test in garak-engine holds the
//!   renderer to that), so views stay valid across `process()` calls.
//!
//! Strings come in through buffers from `garak_engine_alloc` (freed by the caller with
//! `garak_engine_free`). PCM comes in through `garak_engine_alloc_f32` and is handed over without a
//! second copy by `garak_engine_put_asset_owned`. Output is module-owned: interleaved stereo
//! (`garak_engine_output_ptr`) and planar (`garak_engine_planar_ptr`, left then right).
extern crate alloc;

use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;
use core::cell::UnsafeCell;

use garak_engine::{Applied, Controller, EngineConfig, PcmAsset, Renderer, engine};

struct Instance {
    control: Controller,
    render: Renderer,
    output: Vec<f32>,
    /// `max_block` left samples, then `max_block` right samples.
    planar: Vec<f32>,
    max_block: usize,
}

struct State {
    instance: Option<Instance>,
    error: String,
}

struct Global(UnsafeCell<State>);
// SAFETY: a wasm instance runs on exactly one thread (the audio rendering thread or one worker),
// and on the host only the unit test below touches it.
unsafe impl Sync for Global {}

static STATE: Global = Global(UnsafeCell::new(State { instance: None, error: String::new() }));

fn state() -> &'static mut State {
    // SAFETY: single-threaded (see `Global`), and no export holds this reference across another
    // export call (exports never call each other re-entrantly).
    unsafe { &mut *STATE.0.get() }
}

pub const ABI_VERSION: u32 = 2;
const ERROR_CODE: i32 = -1;
const NO_ENGINE: &str = "No engine; call garak_engine_create";

fn fail(message: &str) -> i32 {
    let e = &mut state().error;
    e.clear();
    e.push_str(message);
    ERROR_CODE
}

fn with<R>(f: impl FnOnce(&mut Instance) -> R) -> Option<R> {
    state().instance.as_mut().map(f)
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

fn status(result: Option<Result<(), garak_engine::Error>>) -> i32 {
    match result {
        Some(Ok(())) => 0,
        Some(Err(e)) => fail(e.message()),
        None => fail(NO_ENGINE),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_abi_version() -> u32 {
    ABI_VERSION
}

/// A buffer of `len` bytes for inputs (8-byte aligned).
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

/// A buffer of `count` f32 for PCM, to be filled by the host and passed to
/// `garak_engine_put_asset_owned` (which takes it over) or freed with `garak_engine_free_f32`.
/// Null when `count` is 0.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_alloc_f32(count: usize) -> *mut f32 {
    if count == 0 {
        return core::ptr::null_mut();
    }
    let mut v: Vec<f32> = vec![0.0; count];
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

/// # Safety
/// `p` came from `garak_engine_alloc_f32(count)` and is not used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_engine_free_f32(p: *mut f32, count: usize) {
    if !p.is_null() && count > 0 {
        // SAFETY: rebuilds the Vec<f32> `garak_engine_alloc_f32` forgot.
        drop(unsafe { Vec::from_raw_parts(p, count, count) });
    }
}

/// (Re)creates the module's engine. Returns 0, or -1 for an invalid format.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_create(sample_rate: u32, max_block: u32, offline: i32) -> i32 {
    match engine(EngineConfig { sample_rate, max_block, offline: offline != 0 }) {
        Ok((control, render)) => {
            let max_block = max_block as usize;
            let output = vec![0.0; max_block * 2];
            let planar = vec![0.0; max_block * 2];
            state().instance = Some(Instance { control, render, output, planar, max_block });
            0
        }
        Err(e) => fail(e.message()),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_destroy() {
    state().instance = None;
}

/// Last error message: pointer and length (UTF-8), valid until the next control call.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_error_ptr() -> *const u8 {
    state().error.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_error_len() -> usize {
    state().error.len()
}

fn put(id: &[u8], sample_rate: u32, channels: u32, samples: Vec<f32>) -> i32 {
    let Ok(id) = core::str::from_utf8(id) else { return fail("Invalid native PCM asset id") };
    status(with(|i| i.control.put_asset(id, PcmAsset { sample_rate, channels, samples })))
}

/// Registers interleaved PCM (`count` samples, copied). Returns 0 or -1.
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
    put(id, sample_rate, channels, samples.to_vec())
}

/// Registers interleaved PCM in a buffer from `garak_engine_alloc_f32(count)`, taking it over
/// (no copy): the host must not use or free `samples` afterwards, whatever this returns.
///
/// # Safety
/// `id` is null or valid for `id_len` reads; `samples` came from `garak_engine_alloc_f32(count)`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_engine_put_asset_owned(
    id: *const u8,
    id_len: usize,
    sample_rate: u32,
    channels: u32,
    samples: *mut f32,
    count: usize,
) -> i32 {
    let samples = if samples.is_null() || count == 0 {
        Vec::new()
    } else {
        // SAFETY: the buffer is a Vec<f32> of length and capacity `count` (caller contract).
        unsafe { Vec::from_raw_parts(samples, count, count) }
    };
    // SAFETY: caller contract.
    let id = unsafe { bytes(id, id_len) };
    put(id, sample_rate, channels, samples)
}

/// Forgets the PCM registered under `id` (tracks still using it keep it until their rebuild).
///
/// # Safety
/// `id` is null or valid for `id_len` reads.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_engine_remove_asset(id: *const u8, id_len: usize) {
    // SAFETY: caller contract.
    let id = unsafe { bytes(id, id_len) };
    if let Ok(id) = core::str::from_utf8(id) {
        let _ = with(|i| i.control.remove_asset(id));
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
    with(|i| applied(i.control.set_json(json, blob))).unwrap_or_else(|| fail(NO_ENGINE))
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
    with(|i| applied(i.control.patch_json(json, blob))).unwrap_or_else(|| fail(NO_ENGINE))
}

/// 0 play, 1 pause, 2 stop, 3 seek to `frame` (a JS number). Returns 0 or -1.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_transport(command: u32, frame: f64) -> i32 {
    status(with(|i| {
        match command {
            0 => i.control.play(),
            1 => i.control.pause(),
            2 => i.control.stop(),
            3 => i.control.seek(frame as i64),
            _ => Err(garak_engine::Error::new("Unknown transport command")),
        }
        .map(|_| ())
    }))
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

/// 1 while the transport plays (after the last render), else 0.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_playing() -> u32 {
    with(|i| u32::from(i.control.snapshot().playing)).unwrap_or(0)
}

/// Peak of the master output during the last render call (linear).
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_master_peak() -> f32 {
    with(|i| i.control.snapshot().master_peak).unwrap_or(0.0)
}

/// The interleaved output buffer (`max_block` stereo frames); stable until the next create.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_output_ptr() -> *const f32 {
    with(|i| i.output.as_ptr()).unwrap_or(core::ptr::null())
}

/// The planar output buffer: `max_block` left samples, then `max_block` right samples.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_planar_ptr() -> *const f32 {
    with(|i| i.planar.as_ptr()).unwrap_or(core::ptr::null())
}

fn render_into(i: &mut Instance, frames: u32) -> usize {
    let n = (frames as usize).min(i.max_block);
    if let Some(out) = i.output.get_mut(..n * 2) {
        i.render.render(out);
    }
    n
}

/// Renders `frames` (at most `max_block`) into the interleaved buffer. Real-time safe; returns the
/// frames rendered.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_render(frames: u32) -> u32 {
    with(|i| render_into(i, frames) as u32).unwrap_or(0)
}

/// Like `garak_engine_render`, then splits the frames into the planar buffer (what an
/// AudioWorklet's output channels want). Real-time safe.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_render_planar(frames: u32) -> u32 {
    with(|i| {
        let n = render_into(i, frames);
        let (left, right) = i.planar.split_at_mut(i.max_block);
        let pairs = i.output.get(..n * 2).unwrap_or(&[]).as_chunks::<2>().0;
        for ((l, r), [a, b]) in left.iter_mut().zip(right.iter_mut()).zip(pairs) {
            *l = *a;
            *r = *b;
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
        for (index, (id, a)) in p.assets.iter().enumerate() {
            let r = if index % 2 == 0 {
                unsafe {
                    garak_engine_put_asset(
                        id.as_ptr(),
                        id.len(),
                        a.sample_rate,
                        a.channels,
                        a.samples.as_ptr(),
                        a.samples.len(),
                    )
                }
            } else {
                let buf = garak_engine_alloc_f32(a.samples.len());
                unsafe { core::slice::from_raw_parts_mut(buf, a.samples.len()) }.copy_from_slice(&a.samples);
                unsafe {
                    garak_engine_put_asset_owned(
                        id.as_ptr(),
                        id.len(),
                        a.sample_rate,
                        a.channels,
                        buf,
                        a.samples.len(),
                    )
                }
            };
            assert_eq!(r, 0);
        }
        assert_eq!(unsafe { garak_engine_set(p.json.as_ptr(), p.json.len(), core::ptr::null(), 0) }, 3);
        assert_eq!(garak_engine_transport(0, 0.0), 0);
        assert_eq!(garak_engine_latency(), 16);
        let mut energy = 0.0f32;
        for k in 0..100 {
            if k % 2 == 0 {
                assert_eq!(garak_engine_render(128), 128);
                let out = unsafe { core::slice::from_raw_parts(garak_engine_output_ptr(), 256) };
                energy += out.iter().map(|x| x * x).sum::<f32>();
            } else {
                assert_eq!(garak_engine_render_planar(128), 128);
                let out = unsafe { core::slice::from_raw_parts(garak_engine_output_ptr(), 256) };
                let planar = unsafe { core::slice::from_raw_parts(garak_engine_planar_ptr(), 256) };
                for f in 0..128 {
                    assert_eq!(planar[f], out[f * 2]);
                    assert_eq!(planar[128 + f], out[f * 2 + 1]);
                }
            }
        }
        assert!(energy > 0.0);
        assert!(garak_engine_master_peak() > 0.0);
        assert_eq!(garak_engine_playing(), 1);
        assert_eq!(garak_engine_frame(), 12_800.0);
        assert_eq!(unsafe { garak_engine_set(b"[".as_ptr(), 1, core::ptr::null(), 0) }, -1);
        assert!(garak_engine_error_len() > 0);
        let id = p.assets.first().map(|a| a.0.clone()).unwrap_or_default();
        unsafe { garak_engine_remove_asset(id.as_ptr(), id.len()) };
        let buf = garak_engine_alloc(13);
        unsafe { garak_engine_free(buf, 13) };
        let pcm = garak_engine_alloc_f32(7);
        unsafe { garak_engine_free_f32(pcm, 7) };
        garak_engine_destroy();
        assert_eq!(garak_engine_render(128), 0);
        assert_eq!(garak_engine_transport(0, 0.0), -1);
    }
}

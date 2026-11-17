//! `garak-engine` for the browser AudioWorklet (docs/RUST_ENGINE.md 5): the web's only renderer
//! (src/audio/WebAudioEngine.ts hosts it) and its offline export worker.
//!
//! Raw `extern "C"` exports, no wasm-bindgen glue, one engine per module instance (one worklet
//! node, or one export worker). The engine owns unbounded project data, so this module has a
//! general allocator:
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

use garak_engine::metronome::Clicks;
use garak_engine::{
    Applied, Controller, DynamicsReading, EngineConfig, LiveEvent, MAX_TAPS, PcmAsset, Renderer, engine,
};

/// Input channels a render call can carry (the worklet's live input: a MediaStream).
pub const MAX_INPUT_CHANNELS: usize = 8;
/// Tracks the engine accepts (Controller::prepare), so meters never reallocate.
const MAX_TRACKS: usize = 256;
const MAX_DYNAMICS: usize = 256;

mod instruments;

struct Instance {
    control: Controller,
    render: Renderer,
    output: Vec<f32>,
    /// `max_block` left samples, then `max_block` right samples.
    planar: Vec<f32>,
    max_block: usize,
    /// Live input of the next render call: `max_block` frames of `MAX_INPUT_CHANNELS` interleaved slots.
    input: Vec<f32>,
    /// Highest peak of each track (graph order) since the host last cleared them, and the last block's.
    peaks: Vec<f32>,
    block_peaks: Vec<f32>,
    tracks: usize,
    dynamics: Vec<DynamicsReading>,
    /// The last kernel `garak_engine_reverb_kernel*` produced (kept alive for the host to read) and the
    /// insert `type` / `size` it is for.
    kernel: Option<alloc::sync::Arc<[f32]>>,
    kernel_params: (f64, f64),
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

pub const ABI_VERSION: u32 = 4;
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

/// Like `garak_engine_alloc_f32` without zeroing (the host writes every sample before handing it to
/// `garak_engine_put_asset_owned`, in pieces across render quanta for long PCM). Null when `count` is 0.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_alloc_f32_uninit(count: usize) -> *mut f32 {
    if count == 0 {
        return core::ptr::null_mut();
    }
    let mut v: Vec<f32> = Vec::with_capacity(count);
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
            state().instance = Some(Instance {
                control,
                render,
                output,
                planar,
                max_block,
                input: vec![0.0; max_block * MAX_INPUT_CHANNELS],
                peaks: vec![0.0; MAX_TRACKS],
                block_peaks: vec![0.0; MAX_TRACKS],
                tracks: 0,
                dynamics: vec![DynamicsReading::default(); MAX_DYNAMICS],
                kernel: None,
                kernel_params: (0.0, 0.0),
            });
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

/// The first part of a `project.set` (`patch` 0) or `project.patch` (1) spread over control calls
/// (docs/RUST_ENGINE.md 5.7): parses and classifies it; returns how many tracks `garak_engine_step`
/// will build, or -1. Nothing changes until `garak_engine_commit`.
///
/// # Safety
/// The pointers are null or valid for their lengths.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_engine_stage(
    patch: i32,
    json: *const u8,
    json_len: usize,
    blob: *const u8,
    blob_len: usize,
) -> i32 {
    // SAFETY: caller contract.
    let (json, blob) = unsafe { (bytes(json, json_len), bytes(blob, blob_len)) };
    match with(|i| i.control.stage_json(patch != 0, json, blob)) {
        Some(Ok(count)) => count.min(i32::MAX as usize) as i32,
        Some(Err(e)) => fail(e.message()),
        None => fail(NO_ENGINE),
    }
}

/// Builds the next track of the staged update: 1 when every track is built, 0 when more remain, -1
/// when the update is refused (the stage is dropped).
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_step() -> i32 {
    match with(|i| i.control.step()) {
        Some(Ok(done)) => i32::from(done),
        Some(Err(e)) => fail(e.message()),
        None => fail(NO_ENGINE),
    }
}

/// Applies the staged update. Returns like `garak_engine_set`.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_commit() -> i32 {
    with(|i| applied(i.control.commit())).unwrap_or_else(|| fail(NO_ENGINE))
}

/// Generates (or finds) the reverb kernel for insert parameters `type` / `size` at the engine rate,
/// for another instance to import: returns its length in floats (data at `garak_engine_kernel_ptr`,
/// valid until the next call), or -1.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_reverb_kernel(type_param: f64, size: f64) -> i32 {
    match with(|i| i.control.reverb_kernel(type_param, size).map(|(k, _)| i.kernel.insert(k).len())) {
        Some(Ok(len)) => len.min(i32::MAX as usize) as i32,
        Some(Err(e)) => fail(e.message()),
        None => fail(NO_ENGINE),
    }
}

/// Like `garak_engine_reverb_kernel` for a reverb insert's parameter map (JSON, as in the timeline;
/// defaults filled in). The parameters used are `garak_engine_kernel_param(0)` (type) and `(1)` (size).
///
/// # Safety
/// `json` is null or valid for `len` reads.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_engine_reverb_kernel_json(json: *const u8, len: usize) -> i32 {
    // SAFETY: caller contract.
    let json = unsafe { bytes(json, len) };
    let made = with(|i| {
        i.control.reverb_kernel_for(json).map(|(t, s, k)| {
            i.kernel_params = (t, s);
            i.kernel.insert(k).len()
        })
    });
    match made {
        Some(Ok(len)) => len.min(i32::MAX as usize) as i32,
        Some(Err(e)) => fail(e.message()),
        None => fail(NO_ENGINE),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_kernel_param(which: u32) -> f64 {
    with(|i| if which == 0 { i.kernel_params.0 } else { i.kernel_params.1 }).unwrap_or(0.0)
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_kernel_ptr() -> *const f32 {
    with(|i| i.kernel.as_ref().map_or(core::ptr::null(), |k| k.as_ptr())).unwrap_or(core::ptr::null())
}

/// Imports a kernel from `garak_engine_reverb_kernel` of another instance (a buffer from
/// `garak_engine_alloc_f32(count)`, taken over). Returns 0 or -1.
///
/// # Safety
/// `data` came from `garak_engine_alloc_f32(count)` and is not used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_engine_import_kernel(
    type_param: f64,
    size: f64,
    data: *mut f32,
    count: usize,
) -> i32 {
    let data = if data.is_null() || count == 0 {
        Vec::new()
    } else {
        // SAFETY: a Vec<f32> of length and capacity `count` (caller contract).
        unsafe { Vec::from_raw_parts(data, count, count) }
    };
    status(with(|i| i.control.import_reverb_kernel(type_param, size, data)))
}

/// 0 play, 1 pause, 2 stop, 3 seek to `frame` (a JS number), 4 play after a count-in of `frame` frames.
/// Returns 0 or -1.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_transport(command: u32, frame: f64) -> i32 {
    status(with(|i| {
        match command {
            0 => i.control.play(),
            1 => i.control.pause(),
            2 => i.control.stop(),
            3 => i.control.seek(frame as i64),
            4 => i.control.play_count_in(frame as i64),
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

/// 1 while the transport plays or counts in (after the last render), else 0 (C++ `published.playing`).
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_playing() -> u32 {
    with(|i| {
        let s = i.control.snapshot();
        u32::from(s.playing || s.counting_in)
    })
    .unwrap_or(0)
}

/// Revision of the running graph (published by the last render).
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_revision() -> f64 {
    with(|i| i.control.snapshot().revision as f64).unwrap_or(0.0)
}

/// 1 while a count-in runs (the transport frame stays at the start until it ends).
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_counting_in() -> u32 {
    with(|i| u32::from(i.control.snapshot().counting_in)).unwrap_or(0)
}

/// Live events a track played (`which` 0) or that no track could play (`which` 1).
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_live_count(which: u32) -> f64 {
    with(|i| {
        let s = i.control.snapshot();
        (if which == 0 { s.live_played } else { s.live_ignored }) as f64
    })
    .unwrap_or(0.0)
}

/// Pre-master offline renders (stems, freeze; C++ `setMasterBypass`). Returns 0 or -1.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_master_bypass(on: i32) -> i32 {
    status(with(|i| i.control.set_master_bypass(on != 0).map(|_| ())))
}

/// The metronome: on/off and gain, and click strokes per level (downbeat, group start, pulse) at the
/// engine rate in one buffer from `garak_engine_alloc_f32(len0 + len1 + len2)`, taken over (copied into
/// the engine's own vectors, then freed). A null `strokes` keeps the current strokes. Returns 0 or -1.
///
/// # Safety
/// `strokes` is null or came from `garak_engine_alloc_f32(len0 + len1 + len2)` and is not used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_engine_metronome(
    on: i32,
    gain: f32,
    strokes: *mut f32,
    len0: usize,
    len1: usize,
    len2: usize,
) -> i32 {
    let total = len0 + len1 + len2;
    let clicks = if strokes.is_null() || total == 0 {
        None
    } else {
        // SAFETY: a Vec<f32> of length and capacity `total` (caller contract).
        let all = unsafe { Vec::from_raw_parts(strokes, total, total) };
        let rate = with(|i| i.control.config().sample_rate).unwrap_or(0);
        let (a, rest) = all.split_at(len0);
        let (b, c) = rest.split_at(len1);
        Some(Clicks { sample_rate: rate, levels: [a.to_vec(), b.to_vec(), c.to_vec()] })
    };
    status(with(|i| i.control.set_metronome(clicks, on != 0, gain).map(|_| ())))
}

/// Monitored tracks: `count` graph indices (u32) at `tracks` (a `garak_engine_alloc` buffer). 0 or -1.
///
/// # Safety
/// `tracks` is null or valid for `count` u32 reads.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_engine_monitor(tracks: *const u32, count: usize) -> i32 {
    // SAFETY: caller contract.
    let list = if tracks.is_null() || count == 0 {
        &[][..]
    } else {
        unsafe { core::slice::from_raw_parts(tracks, count) }
    };
    status(with(|i| i.control.set_monitoring(list).map(|_| ())))
}

/// Route recording taps: up to `MAX_TAPS` graph indices (i32, -1 = none). 0 or -1.
///
/// # Safety
/// `tracks` is null or valid for `count` i32 reads.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_engine_taps(tracks: *const i32, count: usize) -> i32 {
    // SAFETY: caller contract.
    let list = if tracks.is_null() || count == 0 {
        &[][..]
    } else {
        unsafe { core::slice::from_raw_parts(tracks, count) }
    };
    status(with(|i| i.control.set_taps(list).map(|_| ())))
}

/// The route taps of the last render call: `MAX_TAPS` slots of `max_block` interleaved stereo frames.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_tap_ptr() -> *const f32 {
    with(|i| i.render.tap_output().as_ptr()).unwrap_or(core::ptr::null())
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_max_taps() -> u32 {
    MAX_TAPS as u32
}

/// A live event for the track at graph index `track`: `kind` 0 note on (`pitch`, `value` = velocity
/// 0..1, `id`), 1 note off, 2 all notes off, 3 controller (`pitch` = controller, `value` = 0..127).
/// Returns 0 or -1 (control call; the worklet runs it between quanta).
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_live(track: u32, kind: u32, pitch: u32, value: f32, id: i32) -> i32 {
    let event = match kind {
        0 => LiveEvent::NoteOn { pitch: pitch.min(127) as u8, velocity: value.clamp(0.0, 1.0), id },
        1 => LiveEvent::NoteOff { pitch: pitch.min(127) as u8, id },
        2 => LiveEvent::AllNotesOff,
        3 => LiveEvent::Control { controller: pitch.min(u32::from(u16::MAX)) as u16, value: value as i32 },
        _ => return fail("Unknown live event"),
    };
    status(with(|i| i.control.live(track, event).map(|_| ())))
}

/// The live input buffer of the next `garak_engine_render_planar_io` call (`max_block` frames of
/// `MAX_INPUT_CHANNELS` interleaved slots); stable until the next create.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_input_ptr() -> *mut f32 {
    with(|i| i.input.as_mut_ptr()).unwrap_or(core::ptr::null_mut())
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_max_input_channels() -> u32 {
    MAX_INPUT_CHANNELS as u32
}

/// Track meters: each track's highest peak since `garak_engine_clear_peaks` (graph order, linear), and
/// how many tracks the running graph has.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_peaks_ptr() -> *const f32 {
    with(|i| i.peaks.as_ptr()).unwrap_or(core::ptr::null())
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_track_count() -> u32 {
    with(|i| i.tracks as u32).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_clear_peaks() {
    let _ = with(|i| i.peaks.fill(0.0));
}

/// Dynamics meters since the last call (compressor/limiter/gate inserts: track, plan insert index,
/// detector peak, lowest gain), written to `garak_engine_dynamics_ptr` as 12-byte records
/// (u16 track, u16 insert, f32 input, f32 gain). Returns how many. Real-time safe.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_take_dynamics() -> u32 {
    with(|i| i.render.take_dynamics(&mut i.dynamics) as u32).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_dynamics_ptr() -> *const DynamicsReading {
    with(|i| i.dynamics.as_ptr()).unwrap_or(core::ptr::null())
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

fn render_into(i: &mut Instance, frames: u32, channels: usize) -> usize {
    let n = (frames as usize).min(i.max_block);
    let channels = channels.min(MAX_INPUT_CHANNELS);
    if let Some(out) = i.output.get_mut(..n * 2) {
        let input = i.input.get(..n * channels).unwrap_or(&[]);
        i.render.render_io(out, input, channels);
    }
    i.tracks = i.render.track_peaks(&mut i.block_peaks);
    for (p, b) in i.peaks.iter_mut().zip(i.block_peaks.iter().take(i.tracks)) {
        if *p < *b {
            *p = *b;
        }
    }
    n
}

fn split_planar(i: &mut Instance, n: usize) {
    let (left, right) = i.planar.split_at_mut(i.max_block);
    let pairs = i.output.get(..n * 2).unwrap_or(&[]).as_chunks::<2>().0;
    for ((l, r), [a, b]) in left.iter_mut().zip(right.iter_mut()).zip(pairs) {
        *l = *a;
        *r = *b;
    }
}

/// Renders `frames` (at most `max_block`) into the interleaved buffer. Real-time safe; returns the
/// frames rendered.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_render(frames: u32) -> u32 {
    with(|i| render_into(i, frames, 0) as u32).unwrap_or(0)
}

/// Like `garak_engine_render`, then splits the frames into the planar buffer (what an
/// AudioWorklet's output channels want). Real-time safe.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_render_planar(frames: u32) -> u32 {
    with(|i| {
        let n = render_into(i, frames, 0);
        split_planar(i, n);
        n as u32
    })
    .unwrap_or(0)
}

/// Like `garak_engine_render_planar`, with `channels` of live input the host wrote to
/// `garak_engine_input_ptr` (interleaved, `frames` frames). Real-time safe.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_render_planar_io(frames: u32, channels: u32) -> u32 {
    with(|i| {
        let n = render_into(i, frames, channels as usize);
        split_planar(i, n);
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

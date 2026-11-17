//! C ABI of the Rust render engine (`garak-engine`, docs/RUST_ENGINE.md). Header:
//! `include/garak_engine.h` (hand-written; the test below fails when an export is missing).
//!
//! Threads: `garak_rs_engine_render` is the audio half (no allocation, no locks); every other
//! `garak_rs_engine_*` function is the control half and must be called from one control thread at
//! a time. The two halves may run concurrently on different threads. Nothing here is used by the
//! app yet: the C++ `RenderEngine` stays the default (stage 4 builds parity first).

use alloc::boxed::Box;
use alloc::string::String;
use alloc::vec::Vec;
use core::cell::UnsafeCell;

use garak_engine::testkit::{TestProject, project};
use garak_engine::{Ahead, Applied, Controller, EngineConfig, PcmAsset, Renderer, engine};

pub const GARAK_RS_ENGINE_ERROR: i32 = -1;

mod instruments;

/// Opaque engine handle (`GarakRsEngine*`).
#[derive(Debug)]
pub struct GarakRsEngine {
    control: UnsafeCell<Controller>,
    render: UnsafeCell<Renderer>,
    error: UnsafeCell<String>,
    /// Render-ahead producers (any thread, garak_rs_engine_render_ahead).
    ahead: Ahead,
}

/// Opaque test project (`GarakRsTestProject*`): garak_engine::testkit for the parity harness.
#[derive(Debug)]
pub struct GarakRsTestProject {
    project: TestProject,
}

/// # Safety
/// `p` is null or valid for `len` reads.
unsafe fn bytes<'a>(p: *const u8, len: usize) -> &'a [u8] {
    if p.is_null() || len == 0 {
        &[]
    } else {
        // SAFETY: forwarded caller contract.
        unsafe { core::slice::from_raw_parts(p, len) }
    }
}

/// # Safety
/// `e` is null or a live handle, used by one control thread at a time.
unsafe fn control<'a>(e: *mut GarakRsEngine) -> Option<(&'a mut Controller, &'a mut String)> {
    // SAFETY: caller contract; the control half and the error string are only touched here.
    unsafe { e.as_ref().map(|h| (&mut *h.control.get(), &mut *h.error.get())) }
}

fn applied(result: Result<Applied, garak_engine::Error>, error: &mut String) -> i32 {
    match result {
        Ok(Applied::None) => 0,
        Ok(Applied::Diff) => 1,
        Ok(Applied::Tracks) => 2,
        Ok(Applied::Full) => 3,
        Err(e) => {
            error.clear();
            error.push_str(e.message());
            GARAK_RS_ENGINE_ERROR
        }
    }
}

fn ticket(result: Result<u64, garak_engine::Error>, error: &mut String) -> i64 {
    match result {
        Ok(t) => t as i64,
        Err(e) => {
            error.clear();
            error.push_str(e.message());
            i64::from(GARAK_RS_ENGINE_ERROR)
        }
    }
}

/// A new engine (control thread), or null for an invalid format.
#[unsafe(no_mangle)]
pub extern "C" fn garak_rs_engine_create(
    sample_rate: u32,
    max_block: u32,
    offline: i32,
) -> *mut GarakRsEngine {
    match engine(EngineConfig { sample_rate, max_block, offline: offline != 0 }) {
        Ok((c, r)) => Box::into_raw(Box::new(GarakRsEngine {
            control: UnsafeCell::new(c),
            ahead: r.ahead(),
            render: UnsafeCell::new(r),
            error: UnsafeCell::new(String::new()),
        })),
        Err(_) => core::ptr::null_mut(),
    }
}

/// # Safety
/// `e` is null or a handle from `garak_rs_engine_create`; the audio thread no longer renders.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_destroy(e: *mut GarakRsEngine) {
    if !e.is_null() {
        // SAFETY: caller contract (created by Box::into_raw, not used afterwards).
        drop(unsafe { Box::from_raw(e) });
    }
}

/// Copies the last control-side error message (UTF-8, not terminated) and returns its length.
///
/// # Safety
/// `e` is null or live; `out` is null or valid for `capacity` writes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_last_error(
    e: *mut GarakRsEngine,
    out: *mut u8,
    capacity: usize,
) -> usize {
    // SAFETY: caller contract.
    let Some((_, error)) = (unsafe { control(e) }) else { return 0 };
    let n = error.len().min(capacity);
    if !out.is_null() && n > 0 {
        // SAFETY: `out` holds `capacity >= n` bytes; the regions cannot overlap.
        unsafe { core::ptr::copy_nonoverlapping(error.as_ptr(), out, n) };
    }
    error.len()
}

/// Registers interleaved PCM (`count` samples) under `id`. Returns 0, or -1 (see last_error).
///
/// # Safety
/// `e` is null or live; `id` / `samples` are null or valid for their lengths.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_put_asset(
    e: *mut GarakRsEngine,
    id: *const u8,
    id_len: usize,
    sample_rate: u32,
    channels: u32,
    samples: *const f32,
    count: usize,
) -> i32 {
    // SAFETY: caller contract.
    let Some((c, error)) = (unsafe { control(e) }) else { return GARAK_RS_ENGINE_ERROR };
    // SAFETY: caller contract.
    let (id, samples) = unsafe {
        let s: &[f32] =
            if samples.is_null() || count == 0 { &[] } else { core::slice::from_raw_parts(samples, count) };
        (bytes(id, id_len), s)
    };
    let Ok(id) = core::str::from_utf8(id) else {
        error.clear();
        error.push_str("Invalid native PCM asset id");
        return GARAK_RS_ENGINE_ERROR;
    };
    let asset = PcmAsset { sample_rate, channels, samples: Vec::from(samples) };
    match c.put_asset(id, asset) {
        Ok(()) => 0,
        Err(err) => {
            error.clear();
            error.push_str(err.message());
            GARAK_RS_ENGINE_ERROR
        }
    }
}

/// `project.set`: timeline JSON + binary frame. Returns the applied kind (0 none, 1 diff,
/// 2 tracks, 3 full) or -1.
///
/// # Safety
/// `e` is null or live; the buffers are null or valid for their lengths.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_set(
    e: *mut GarakRsEngine,
    json: *const u8,
    json_len: usize,
    blob: *const u8,
    blob_len: usize,
) -> i32 {
    // SAFETY: caller contract.
    let Some((c, error)) = (unsafe { control(e) }) else { return GARAK_RS_ENGINE_ERROR };
    // SAFETY: caller contract.
    let (json, blob) = unsafe { (bytes(json, json_len), bytes(blob, blob_len)) };
    applied(c.set_json(json, blob), error)
}

/// `project.patch` against the current project. Returns like `garak_rs_engine_set`.
///
/// # Safety
/// As `garak_rs_engine_set`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_patch(
    e: *mut GarakRsEngine,
    json: *const u8,
    json_len: usize,
    blob: *const u8,
    blob_len: usize,
) -> i32 {
    // SAFETY: caller contract.
    let Some((c, error)) = (unsafe { control(e) }) else { return GARAK_RS_ENGINE_ERROR };
    // SAFETY: caller contract.
    let (json, blob) = unsafe { (bytes(json, json_len), bytes(blob, blob_len)) };
    applied(c.patch_json(json, blob), error)
}

/// Transport: 0 play, 1 pause, 2 stop, 3 seek to `frame`. Returns the command ticket or -1.
///
/// # Safety
/// `e` is null or live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_transport(e: *mut GarakRsEngine, command: u32, frame: i64) -> i64 {
    // SAFETY: caller contract.
    let Some((c, error)) = (unsafe { control(e) }) else { return i64::from(GARAK_RS_ENGINE_ERROR) };
    let result = match command {
        0 => c.play(),
        1 => c.pause(),
        2 => c.stop(),
        3 => c.seek(frame),
        _ => Err(garak_engine::Error::new("Unknown transport command")),
    };
    ticket(result, error)
}

/// Frees what the renderer retired (control thread; call regularly, like `collectRetired`).
///
/// # Safety
/// `e` is null or live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_collect(e: *mut GarakRsEngine) {
    // SAFETY: caller contract.
    if let Some((c, _)) = unsafe { control(e) } {
        c.collect();
    }
}

/// Plug-in delay (frames) and tail (seconds) of the last submitted graph; 0 when none.
///
/// # Safety
/// `e` is null or live; the outputs are null or valid for one write.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_graph_info(
    e: *mut GarakRsEngine,
    latency: *mut u32,
    tail: *mut f64,
) {
    // SAFETY: caller contract.
    let Some((c, _)) = (unsafe { control(e) }) else { return };
    let (l, _, t) = c.graph_info().unwrap_or((0, 0, 0.0));
    // SAFETY: caller contract.
    unsafe {
        if let Some(out) = latency.as_mut() {
            *out = l;
        }
        if let Some(out) = tail.as_mut() {
            *out = t;
        }
    }
}

/// Last applied command ticket and transport frame, as published by the renderer.
///
/// # Safety
/// `e` is null or live; the outputs are null or valid for one write.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_snapshot(e: *mut GarakRsEngine, applied: *mut u64, frame: *mut i64) {
    // SAFETY: caller contract.
    let Some((c, _)) = (unsafe { control(e) }) else { return };
    let s = c.snapshot();
    // SAFETY: caller contract.
    unsafe {
        if let Some(out) = applied.as_mut() {
            *out = s.last_applied;
        }
        if let Some(out) = frame.as_mut() {
            *out = s.frame;
        }
    }
}

/// Audio thread: renders `frames` interleaved stereo frames into `out`. Real-time safe.
///
/// # Safety
/// `e` is null or live and rendered by one thread at a time; `out` is null or valid for
/// `2 * frames` writes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_render(e: *mut GarakRsEngine, out: *mut f32, frames: u32) {
    // SAFETY: caller contract: the render half is only touched by the audio thread.
    let Some(r) = (unsafe { e.as_ref() }).map(|h| unsafe { &mut *h.render.get() }) else { return };
    if out.is_null() || frames == 0 {
        return;
    }
    // SAFETY: caller contract.
    let out = unsafe { core::slice::from_raw_parts_mut(out, frames as usize * 2) };
    r.render(out);
}

/// The last command ticket the control half queued (`Controller::ticket`): what a host shell passes
/// to `garak_rs_engine_render_block` once its own matching command applies.
///
/// # Safety
/// `e` is null or live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_ticket(e: *mut GarakRsEngine) -> u64 {
    // SAFETY: caller contract.
    unsafe { control(e) }.map_or(0, |(c, _)| c.ticket())
}

/// The host's worker pool for `garak_rs_engine_render_block` (garak_engine.h `GarakRsParallelRun`).
pub type GarakRsParallelRun = unsafe extern "C" fn(
    host: *mut core::ffi::c_void,
    count: u32,
    task: garak_engine::HostTask,
    job: *mut core::ffi::c_void,
);

/// Audio thread, host-driven (the C++ shell owns the transport and master bus): applies commands
/// up to `allowed`, then writes the track mix of `frames` frames at project frame `position` into
/// `out`. `peaks` (null or `peak_capacity` floats) receives per-track block peaks. `run` (nullable)
/// renders independent tracks on the host's worker pool; the output is bit-identical without it.
///
/// # Safety
/// As `garak_rs_engine_render`; `peaks` is null or valid for `peak_capacity` writes; `run`, when
/// set, honours the `Parallel` contract (every task called once, returns after all completed).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_render_block(
    e: *mut GarakRsEngine,
    out: *mut f32,
    frames: u32,
    position: i64,
    playing: i32,
    allowed: u64,
    peaks: *mut f32,
    peak_capacity: u32,
    run: Option<GarakRsParallelRun>,
    host: *mut core::ffi::c_void,
) {
    // SAFETY: caller contract: the render half is only touched by the audio thread.
    let Some(r) = (unsafe { e.as_ref() }).map(|h| unsafe { &mut *h.render.get() }) else { return };
    if out.is_null() || frames == 0 {
        r.host_consume(allowed);
        return;
    }
    // SAFETY: caller contract.
    let (out, peaks) = unsafe {
        let peaks: &mut [f32] = if peaks.is_null() || peak_capacity == 0 {
            &mut []
        } else {
            core::slice::from_raw_parts_mut(peaks, peak_capacity as usize)
        };
        (core::slice::from_raw_parts_mut(out, frames as usize * 2), peaks)
    };
    let parallel = run.map(|run| garak_engine::Parallel { run, host });
    r.render_block(out, position, playing != 0, allowed, peaks, parallel.as_ref());
}

/// The shell's block (garak_engine.h `GarakRsBlock`).
#[repr(C)]
#[derive(Debug)]
pub struct GarakRsBlock {
    pub position: i64,
    pub playing: i32,
    pub allowed: u64,
    pub master_gain: f32,
    pub target_master_gain: f32,
    pub monitor: [u64; 4],
    /// Null: host nodes render silence (sources) or pass through (inserts).
    pub nodes: *const garak_engine::HostCallbacks,
    /// `ahead_count` per-track pointers (null entries allowed): the block's output of tracks the shell renders
    /// ahead (garak_rs_engine_render_ahead); the graph skips those tracks.
    pub ahead: *const *const f32,
    pub ahead_count: u32,
}

/// Audio thread: `garak_rs_engine_render_block` with the shell's master gain (master-resampling routes),
/// monitored tracks (device input through `nodes->input`, route inputs) and the host's VST3 / IEUM WAVE
/// callbacks (docs/RUST_ENGINE.md 4).
///
/// # Safety
/// As `garak_rs_engine_render_block`; `block` is valid; `block->nodes` is null or valid for the call, and its
/// callbacks honour the `HostCallbacks` contract.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_render_host(
    e: *mut GarakRsEngine,
    out: *mut f32,
    frames: u32,
    block: *const GarakRsBlock,
    peaks: *mut f32,
    peak_capacity: u32,
    run: Option<GarakRsParallelRun>,
    host: *mut core::ffi::c_void,
) {
    // SAFETY: caller contract: the render half is only touched by the audio thread.
    let Some(r) = (unsafe { e.as_ref() }).map(|h| unsafe { &mut *h.render.get() }) else { return };
    // SAFETY: caller contract.
    let Some(b) = (unsafe { block.as_ref() }) else { return };
    if out.is_null() || frames == 0 {
        r.host_consume(b.allowed);
        return;
    }
    // SAFETY: caller contract.
    let (out, peaks, nodes, ahead) = unsafe {
        let peaks: &mut [f32] = if peaks.is_null() || peak_capacity == 0 {
            &mut []
        } else {
            core::slice::from_raw_parts_mut(peaks, peak_capacity as usize)
        };
        let ahead: &[*const f32] = if b.ahead.is_null() || b.ahead_count == 0 {
            &[]
        } else {
            core::slice::from_raw_parts(b.ahead, b.ahead_count as usize)
        };
        (core::slice::from_raw_parts_mut(out, frames as usize * 2), peaks, b.nodes.as_ref(), ahead)
    };
    let info = garak_engine::BlockInfo {
        position: b.position,
        playing: b.playing != 0,
        allowed: b.allowed,
        master_gain: b.master_gain,
        target_master_gain: b.target_master_gain,
        monitor: b.monitor,
        host: nodes,
        ahead,
    };
    let parallel = run.map(|run| garak_engine::Parallel { run, host });
    r.render_host(out, &info, peaks, parallel.as_ref());
}

/// Audio thread, between blocks: a live event for track `track` that the shell applies itself (its live MIDI
/// ring and live commands) at the start of the track's next block. `kind`: 0 note on (`a` = note id), 1 note off
/// (`a` = note id), 2 all notes off, 3 controller (`pitch` = controller number, `a` = value), 4 preview (`a` =
/// frames). Returns 1 when a track takes it (a built-in instrument, or a host node through `nodes->live`), 0 when
/// none does, -1 for an invalid event.
///
/// # Safety
/// As `garak_rs_engine_render`; the track is not rendering ahead.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_live(
    e: *mut GarakRsEngine,
    track: u32,
    kind: u32,
    pitch: i32,
    a: i32,
    velocity: f32,
) -> i32 {
    // SAFETY: caller contract.
    unsafe { garak_rs_engine_live_at(e, track, kind, pitch, a, velocity, 0) }
}

/// [`garak_rs_engine_live`] `offset` frames into the track's next block (the device MIDI's sample offset; an
/// offset past that block lands in a later one, at the same distance from this block's start; at most
/// `GARAK_RS_MAX_LIVE_OFFSET`). Built-in instruments start the event on that exact sample; host nodes get it with
/// that offset through `nodes->live` (VST3 `sampleOffset`).
///
/// # Safety
/// As `garak_rs_engine_render`; the track is not rendering ahead.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_live_at(
    e: *mut GarakRsEngine,
    track: u32,
    kind: u32,
    pitch: i32,
    a: i32,
    velocity: f32,
    offset: u32,
) -> i32 {
    let Some(r) = (unsafe { e.as_ref() }).map(|h| unsafe { &mut *h.render.get() }) else { return -1 };
    let Some(event) = garak_engine::LiveEvent::decode(kind, pitch, a, velocity) else { return -1 };
    if !event.is_valid() || offset > garak_engine::MAX_LIVE_OFFSET {
        return -1;
    }
    i32::from(r.host_live(track as usize, event, offset))
}

/// Audio thread, after `garak_rs_engine_render_host`: the last block's input of routed track `track`
/// (interleaved stereo, `max_block` frames of storage), or null when it has no internal route.
///
/// # Safety
/// As `garak_rs_engine_render`. The pointer is valid until the next render or reset call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_route_input(e: *mut GarakRsEngine, track: u32) -> *const f32 {
    // SAFETY: caller contract.
    let Some(r) = (unsafe { e.as_ref() }).map(|h| unsafe { &*h.render.get() }) else {
        return core::ptr::null();
    };
    r.route_input(track as usize).map_or(core::ptr::null(), <[f32]>::as_ptr)
}

/// Render-ahead producer (a host worker, or the callback helping): renders `frames` frames of track `track` of
/// the active graph at project frame `frame` exactly as the graph would and returns its output (interleaved
/// stereo, valid until the track renders again; null when there is no such track). `peak` (nullable) gets the
/// block peak.
///
/// # Safety
/// `e` is live; the render-ahead contract of `garak_engine::Ahead`: the shell keeps this track out of
/// `garak_rs_engine_render_host` (in `ahead`) and its resets, renders it on one thread at a time, and keeps its
/// workers out while the renderer applies commands. `nodes` is null or valid (callbacks for this track may run on
/// this thread).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_render_ahead(
    e: *mut GarakRsEngine,
    track: u32,
    frame: i64,
    frames: u32,
    playing: i32,
    nodes: *const garak_engine::HostCallbacks,
    peak: *mut f32,
) -> *const f32 {
    // SAFETY: caller contract (`ahead` is immutable and shared; no `&mut` to the renderer is formed).
    let Some(h) = (unsafe { e.as_ref() }) else { return core::ptr::null() };
    // SAFETY: caller contract.
    let result = unsafe { h.ahead.render_track(track as usize, frame, frames, playing != 0, nodes.as_ref()) };
    let Some((mix, p)) = result else { return core::ptr::null() };
    if !peak.is_null() {
        // SAFETY: caller contract.
        unsafe { *peak = p };
    }
    mix.as_ptr()
}

/// The shell's reset of one track it takes back from a render-ahead ring out of sync (`effects != 0`: tails
/// and delay lines). Callback thread.
///
/// # Safety
/// As `garak_rs_engine_render_ahead` (the caller owns the track now).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_reset_track(
    e: *mut GarakRsEngine,
    track: u32,
    frame: i64,
    chase: i32,
    effects: i32,
) {
    // SAFETY: caller contract.
    if let Some(h) = unsafe { e.as_ref() } {
        // SAFETY: caller contract.
        unsafe { h.ahead.reset_track(track as usize, frame, chase != 0, effects != 0) };
    }
}

/// Audio thread: `garak_rs_engine_reset` leaving the tracks the shell renders ahead alone (`skip`: 4 words, bit
/// `i` of word `i / 64`).
///
/// # Safety
/// As `garak_rs_engine_render`; `skip` is valid for 4 reads.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_reset_skip(
    e: *mut GarakRsEngine,
    frame: i64,
    chase: i32,
    effects: i32,
    skip: *const u64,
) {
    // SAFETY: caller contract.
    let Some(r) = (unsafe { e.as_ref() }).map(|h| unsafe { &mut *h.render.get() }) else { return };
    let mut mask = [0u64; 4];
    if !skip.is_null() {
        // SAFETY: caller contract.
        mask.copy_from_slice(unsafe { core::slice::from_raw_parts(skip, 4) });
    }
    r.host_reset_skip(frame, chase != 0, effects != 0, &mask);
}

/// Audio thread, after `garak_rs_engine_render_block`: dynamics meter readings (compressor, limiter,
/// gate) since the last call into `out` (`capacity` entries). Returns how many were written.
///
/// # Safety
/// As `garak_rs_engine_render`; `out` is null or valid for `capacity` writes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_take_dynamics(
    e: *mut GarakRsEngine,
    out: *mut garak_engine::DynamicsReading,
    capacity: u32,
) -> u32 {
    // SAFETY: caller contract.
    let Some(r) = (unsafe { e.as_ref() }).map(|h| unsafe { &mut *h.render.get() }) else { return 0 };
    if out.is_null() || capacity == 0 {
        return 0;
    }
    // SAFETY: caller contract.
    let out = unsafe { core::slice::from_raw_parts_mut(out, capacity as usize) };
    r.take_dynamics(out) as u32
}

/// Audio thread: the host shell's transport reset (`effects != 0` also clears tails).
///
/// # Safety
/// As `garak_rs_engine_render`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_reset(e: *mut GarakRsEngine, frame: i64, chase: i32, effects: i32) {
    // SAFETY: caller contract.
    if let Some(r) = (unsafe { e.as_ref() }).map(|h| unsafe { &mut *h.render.get() }) {
        r.host_reset(frame, chase != 0, effects != 0);
    }
}

/// Audio thread: the shell's transport stopped at the project end (no cycle). Plug-in style Rust instruments
/// release their notes next block (C++ `requestReset`).
///
/// # Safety
/// As `garak_rs_engine_render`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_engine_stop_at_end(e: *mut GarakRsEngine) {
    // SAFETY: caller contract.
    if let Some(r) = (unsafe { e.as_ref() }).map(|h| unsafe { &mut *h.render.get() }) {
        r.host_stop_at_end();
    }
}

/// The parity test project (`garak_engine::testkit::project`), or null.
#[unsafe(no_mangle)]
pub extern "C" fn garak_rs_testkit_create(
    tracks: u32,
    seconds: f64,
    sample_rate: u32,
) -> *mut GarakRsTestProject {
    if !(0.05..=600.0).contains(&seconds) || !(8000..=192_000).contains(&sample_rate) || tracks > 254 {
        return core::ptr::null_mut();
    }
    Box::into_raw(Box::new(GarakRsTestProject { project: project(tracks as usize, seconds, sample_rate) }))
}

/// # Safety
/// `p` is null or from `garak_rs_testkit_create`, not used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_testkit_destroy(p: *mut GarakRsTestProject) {
    if !p.is_null() {
        // SAFETY: caller contract.
        drop(unsafe { Box::from_raw(p) });
    }
}

/// The project's timeline JSON (UTF-8, not terminated; valid until destroy).
///
/// # Safety
/// `p` is null or live; `len` is null or valid for one write.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_testkit_json(p: *const GarakRsTestProject, len: *mut usize) -> *const u8 {
    // SAFETY: caller contract.
    let Some(p) = (unsafe { p.as_ref() }) else { return core::ptr::null() };
    // SAFETY: caller contract.
    if let Some(out) = unsafe { len.as_mut() } {
        *out = p.project.json.len();
    }
    p.project.json.as_ptr()
}

/// Number of PCM assets of the project.
///
/// # Safety
/// `p` is null or live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_testkit_asset_count(p: *const GarakRsTestProject) -> u32 {
    // SAFETY: caller contract.
    unsafe { p.as_ref() }.map_or(0, |p| p.project.assets.len() as u32)
}

/// Asset `index`: id (UTF-8, not terminated), format and interleaved samples (valid until
/// destroy). Returns 1, or 0 for an invalid index.
///
/// # Safety
/// `p` is null or live; every output is null or valid for one write.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_testkit_asset(
    p: *const GarakRsTestProject,
    index: u32,
    id: *mut *const u8,
    id_len: *mut usize,
    sample_rate: *mut u32,
    channels: *mut u32,
    samples: *mut *const f32,
    count: *mut usize,
) -> i32 {
    // SAFETY: caller contract.
    let Some((name, a)) = (unsafe { p.as_ref() }).and_then(|p| p.project.assets.get(index as usize)) else {
        return 0;
    };
    // SAFETY: caller contract.
    unsafe {
        if let Some(o) = id.as_mut() {
            *o = name.as_ptr();
        }
        if let Some(o) = id_len.as_mut() {
            *o = name.len();
        }
        if let Some(o) = sample_rate.as_mut() {
            *o = a.sample_rate;
        }
        if let Some(o) = channels.as_mut() {
            *o = a.channels;
        }
        if let Some(o) = samples.as_mut() {
            *o = a.samples.as_ptr();
        }
        if let Some(o) = count.as_mut() {
            *o = a.samples.len();
        }
    }
    1
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::string::String;
    use std::vec::Vec;

    const HEADER: &str = include_str!("../include/garak_engine.h");
    const SOURCE: &str = include_str!("engine.rs");

    #[test]
    fn header_declares_every_export() {
        let names: Vec<String> = SOURCE
            .lines()
            .filter_map(|l| l.split("extern \"C\" fn ").nth(1))
            .filter_map(|rest| rest.split('(').next())
            .filter(|name| name.starts_with("garak_rs_"))
            .map(String::from)
            .collect();
        assert!(names.len() >= 16, "{names:?}");
        for name in names {
            assert!(HEADER.contains(&std::format!("{name}(")), "garak_engine.h is missing {name}");
        }
    }

    #[test]
    fn renders_the_test_project_through_the_c_abi() {
        unsafe {
            let p = garak_rs_testkit_create(4, 1.0, 48_000);
            let e = garak_rs_engine_create(48_000, 512, 1);
            assert!(!p.is_null() && !e.is_null());
            for i in 0..garak_rs_testkit_asset_count(p) {
                let (mut id, mut id_len, mut rate, mut ch, mut s, mut n) =
                    (core::ptr::null(), 0, 0, 0, core::ptr::null(), 0);
                assert_eq!(
                    garak_rs_testkit_asset(p, i, &mut id, &mut id_len, &mut rate, &mut ch, &mut s, &mut n),
                    1
                );
                assert_eq!(garak_rs_engine_put_asset(e, id, id_len, rate, ch, s, n), 0);
            }
            let mut len = 0;
            let json = garak_rs_testkit_json(p, &mut len);
            assert_eq!(garak_rs_engine_set(e, json, len, core::ptr::null(), 0), 3);
            assert!(garak_rs_engine_transport(e, 0, 0) > 0);
            let (mut latency, mut tail) = (0u32, 0.0f64);
            garak_rs_engine_graph_info(e, &mut latency, &mut tail);
            assert_eq!(latency, 16);
            let mut out = std::vec![0.0f32; 2 * 4800];
            garak_rs_engine_render(e, out.as_mut_ptr(), 4800);
            assert!(out.iter().any(|x| *x != 0.0) && out.iter().all(|x| x.is_finite()));
            // Errors are reported, not thrown.
            assert_eq!(garak_rs_engine_set(e, b"{".as_ptr(), 1, core::ptr::null(), 0), -1);
            let mut msg = [0u8; 128];
            let n = garak_rs_engine_last_error(e, msg.as_mut_ptr(), msg.len());
            assert!(n > 0);
            garak_rs_engine_collect(e);
            garak_rs_engine_destroy(e);
            garak_rs_testkit_destroy(p);
            // Null handles are ignored.
            garak_rs_engine_render(core::ptr::null_mut(), out.as_mut_ptr(), 1);
            assert_eq!(garak_rs_engine_set(core::ptr::null_mut(), json, len, core::ptr::null(), 0), -1);
        }
    }
}

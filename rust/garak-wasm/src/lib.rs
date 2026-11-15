//! `garak-dsp` for the browser AudioWorklet (`src/audio/rust/garakWasm.ts` loads it).
//!
//! Why raw `extern "C"` exports instead of wasm-bindgen:
//! - `AudioWorkletGlobalScope` has no `fetch`, and older engines lack `TextDecoder`; wasm-bindgen's
//!   generated glue assumes both and is an ES module that must be bundled into the worklet.
//! - The audio path only moves `f32` blocks and numbers. A fixed ABI of ~15 functions over two
//!   static sample buffers needs no glue at all: the loader is ~100 lines of plain TS.
//! - No allocator: the module's memory never grows, so `Float32Array` views created once on the
//!   worklet side are never detached, and nothing can allocate during `process()`.
//!
//! Memory model: one module instance per worklet node (single-threaded). Kernels live in fixed
//! slot pools; samples are exchanged through the planar `left`/`right` scratch buffers of
//! `MAX_FRAMES` frames (`garak_left_ptr`/`garak_right_ptr`).
#![cfg_attr(target_arch = "wasm32", no_std)]

use core::cell::UnsafeCell;

use garak_dsp::{Biquad, Coefficients, FilterType, Utility, UtilityParams};

mod arena;
/// Built-in effects (`garak_fx_*`).
pub mod fx;

/// Host unit tests share the static pools; they serialise through this lock.
#[cfg(test)]
pub(crate) static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub const ABI_VERSION: u32 = 2;
/// Frames per process call (a Web Audio render quantum is 128; larger blocks serve offline use).
pub const MAX_FRAMES: usize = 4096;
pub const MAX_SLOTS: usize = 32;

/// All-zero, so it lands in `.bss` and costs nothing in the .wasm file.
struct Samples {
    left: [f32; MAX_FRAMES],
    right: [f32; MAX_FRAMES],
}

struct State {
    coefficients: [f64; 5],
    biquads: [Option<Biquad>; MAX_SLOTS],
    utilities: [Option<Utility>; MAX_SLOTS],
}

struct Global<T>(UnsafeCell<T>);
// SAFETY: a wasm instance runs on exactly one thread (the audio rendering thread), and on the host
// the statics are only touched by tests that serialise through `TEST_LOCK`.
unsafe impl<T> Sync for Global<T> {}

static SAMPLES: Global<Samples> =
    Global(UnsafeCell::new(Samples { left: [0.0; MAX_FRAMES], right: [0.0; MAX_FRAMES] }));

static STATE: Global<State> = Global(UnsafeCell::new(State {
    coefficients: [0.0; 5],
    biquads: [const { None }; MAX_SLOTS],
    utilities: [const { None }; MAX_SLOTS],
}));

fn samples() -> &'static mut Samples {
    // SAFETY: single-threaded, and no export holds the reference across another export call.
    unsafe { &mut *SAMPLES.0.get() }
}

fn state() -> &'static mut State {
    // SAFETY: as `samples`; the two statics never alias.
    unsafe { &mut *STATE.0.get() }
}

#[cfg(all(target_arch = "wasm32", not(test)))]
#[panic_handler]
fn on_panic(_: &core::panic::PanicInfo) -> ! {
    // Lints deny every panicking construct; a bug traps the worklet instead of corrupting audio.
    core::arch::wasm32::unreachable()
}

fn frames(n: u32) -> usize {
    (n as usize).min(MAX_FRAMES)
}

fn slot<T>(pool: &mut [Option<T>], index: i32) -> Option<&mut T> {
    usize::try_from(index).ok().and_then(|i| pool.get_mut(i)).and_then(Option::as_mut)
}

fn claim<T>(pool: &mut [Option<T>], value: T) -> i32 {
    match pool.iter().position(Option::is_none) {
        Some(i) => {
            if let Some(entry) = pool.get_mut(i) {
                *entry = Some(value);
            }
            i32::try_from(i).unwrap_or(-1)
        }
        None => -1,
    }
}

fn release<T>(pool: &mut [Option<T>], index: i32) {
    if let Some(entry) = usize::try_from(index).ok().and_then(|i| pool.get_mut(i)) {
        *entry = None;
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_abi_version() -> u32 {
    ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_max_frames() -> u32 {
    MAX_FRAMES as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_max_slots() -> u32 {
    MAX_SLOTS as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_left_ptr() -> *mut f32 {
    samples().left.as_mut_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_right_ptr() -> *mut f32 {
    samples().right.as_mut_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_db_to_gain(db: f64) -> f64 {
    garak_dsp::db_to_gain(db)
}

/// Writes b0, b1, b2, a1, a2 to a static 5 x f64 array and returns its address.
#[unsafe(no_mangle)]
pub extern "C" fn garak_biquad_design(
    kind: u32,
    sample_rate: f64,
    frequency: f64,
    q: f64,
    gain_db: f64,
) -> *const f64 {
    let c = Coefficients::design(FilterType::from_u32(kind), sample_rate, frequency, q, gain_db);
    let s = state();
    s.coefficients = [c.b0, c.b1, c.b2, c.a1, c.a2];
    s.coefficients.as_ptr()
}

/// Returns a slot index, or -1 when all `MAX_SLOTS` are in use.
#[unsafe(no_mangle)]
pub extern "C" fn garak_biquad_create() -> i32 {
    claim(&mut state().biquads, Biquad::new())
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_biquad_free(slot_index: i32) {
    release(&mut state().biquads, slot_index);
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_biquad_configure(
    slot_index: i32,
    kind: u32,
    sample_rate: f64,
    frequency: f64,
    q: f64,
    gain_db: f64,
) {
    if let Some(f) = slot(&mut state().biquads, slot_index) {
        f.configure(FilterType::from_u32(kind), sample_rate, frequency, q, gain_db);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_biquad_retarget(
    slot_index: i32,
    kind: u32,
    sample_rate: f64,
    frequency: f64,
    q: f64,
    gain_db: f64,
) {
    if let Some(f) = slot(&mut state().biquads, slot_index) {
        f.retarget(FilterType::from_u32(kind), sample_rate, frequency, q, gain_db);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_biquad_reset(slot_index: i32) {
    if let Some(f) = slot(&mut state().biquads, slot_index) {
        f.reset();
    }
}

/// Filters the first `frames` frames of the scratch buffers in place.
#[unsafe(no_mangle)]
pub extern "C" fn garak_biquad_process(slot_index: i32, frame_count: u32) {
    let (s, b) = (state(), samples());
    let n = frames(frame_count);
    if let (Some(f), Some(l), Some(r)) =
        (slot(&mut s.biquads, slot_index), b.left.get_mut(..n), b.right.get_mut(..n))
    {
        f.process_planar(l, r);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_utility_create(sample_rate: f64) -> i32 {
    claim(&mut state().utilities, Utility::new(sample_rate))
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_utility_free(slot_index: i32) {
    release(&mut state().utilities, slot_index);
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_utility_configure(
    slot_index: i32,
    gain_db: f64,
    pan: f64,
    width: f64,
    mono: f64,
    phase: f64,
) {
    if let Some(u) = slot(&mut state().utilities, slot_index) {
        u.configure(UtilityParams { gain_db, pan, width, mono, phase });
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_utility_process(slot_index: i32, frame_count: u32) {
    let (s, b) = (state(), samples());
    let n = frames(frame_count);
    if let (Some(u), Some(l), Some(r)) =
        (slot(&mut s.utilities, slot_index), b.left.get_mut(..n), b.right.get_mut(..n))
    {
        u.process_planar(l, r);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slots_are_bounded_and_reusable() {
        let _guard = TEST_LOCK.lock().unwrap();
        let slots: std::vec::Vec<i32> = (0..MAX_SLOTS).map(|_| garak_biquad_create()).collect();
        assert!(slots.iter().all(|&s| s >= 0));
        assert_eq!(garak_biquad_create(), -1);
        garak_biquad_free(slots[3]);
        assert_eq!(garak_biquad_create(), slots[3]);
        for s in slots {
            garak_biquad_free(s);
        }
        // Out-of-range handles are ignored.
        garak_biquad_process(-5, 128);
        garak_biquad_process(MAX_SLOTS as i32, 128);
        garak_utility_configure(99, 0.0, 0.0, 1.0, 0.0, 0.0);
    }

    #[test]
    fn processes_the_scratch_buffers() {
        let _guard = TEST_LOCK.lock().unwrap();
        let u = garak_utility_create(48_000.0);
        garak_utility_configure(u, 0.0, 0.0, 1.0, 1.0, 0.0);
        let s = samples();
        s.left[..2].copy_from_slice(&[1.0, 0.0]);
        s.right[..2].copy_from_slice(&[0.0, 1.0]);
        garak_utility_process(u, 2);
        let s = samples();
        assert_eq!((&s.left[..2], &s.right[..2]), (&[0.5f32, 0.5][..], &[0.5f32, 0.5][..]));
        garak_utility_free(u);
        // Frame counts above MAX_FRAMES are clamped, not trusted.
        let f = garak_biquad_create();
        garak_biquad_configure(f, 0, 48_000.0, 1000.0, 0.0, 0.0);
        garak_biquad_process(f, u32::MAX);
        garak_biquad_free(f);
    }
}

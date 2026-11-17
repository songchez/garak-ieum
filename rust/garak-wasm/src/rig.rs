//! The guitar rig for the worklet: `garak_rig_*` (garak-dsp `fx::guitar`, the same code the
//! desktop runs through garak-ffi). Slot model as for `garak_fx_*`: `garak_rig_create*` returns a
//! slot (or -1), the other exports take it and ignore invalid ones. Parameters travel through
//! their own static buffer (`garak_rig_params_ptr`, 154 values in `garak_rig_param_id` order),
//! samples through the planar scratch buffers; the signal arriving at the tuner is written to
//! `garak_rig_tap_ptr` on every process call (the web tuner's analyser input). The rig state,
//! its delay lines / reverb state and the plate kernels live in the effect arena.

use core::cell::UnsafeCell;
use core::ptr;

use garak_dsp::fx::guitar::{self, GuitarRig, MAX_REVERBS, PARAM_COUNT, PARAMS};
use garak_dsp::fx::reverb;

use crate::fx::{build_kernels, floats, pool, release};
use crate::{MAX_FRAMES, frames, samples};

/// Rigs per module instance (the worklet makes another instance when they are taken).
pub const MAX_RIGS: usize = 16;

type RigState = GuitarRig<'static>;
const _: () = assert!(!core::mem::needs_drop::<RigState>());

#[derive(Clone, Copy, Debug)]
struct Slot {
    rig: *mut RigState,
    state: usize,
    storage: usize,
    kernels: [usize; MAX_REVERBS],
}

struct RigPool {
    slots: [Option<Slot>; MAX_RIGS],
    params: [f64; PARAM_COUNT],
    decays: [f64; MAX_REVERBS],
    tap: [f32; MAX_FRAMES],
    text: [u8; 64],
}

struct Global(UnsafeCell<RigPool>);
// SAFETY: one wasm instance runs on one thread; host tests serialise through `TEST_LOCK`.
unsafe impl Sync for Global {}

static POOL: Global = Global(UnsafeCell::new(RigPool {
    slots: [None; MAX_RIGS],
    params: [0.0; PARAM_COUNT],
    decays: [0.0; MAX_REVERBS],
    tap: [0.0; MAX_FRAMES],
    text: [0; 64],
}));

fn rigs() -> &'static mut RigPool {
    // SAFETY: single-threaded, and no export keeps the reference across another export call.
    unsafe { &mut *POOL.0.get() }
}

fn rig(slot: i32) -> Option<&'static mut RigState> {
    let s = usize::try_from(slot).ok().and_then(|i| rigs().slots.get(i).copied().flatten())?;
    // SAFETY: `s.rig` was written by `create` and stays valid until `garak_rig_free`.
    unsafe { s.rig.as_mut() }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rig_params_ptr() -> *mut f64 {
    rigs().params.as_mut_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rig_decays_ptr() -> *const f64 {
    rigs().decays.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rig_tap_ptr() -> *const f32 {
    rigs().tap.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rig_text_ptr() -> *const u8 {
    rigs().text.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rig_max_slots() -> u32 {
    MAX_RIGS as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rig_param_count() -> u32 {
    PARAM_COUNT as u32
}

/// Writes parameter `index`'s id to the rig text buffer; returns its length (0 when out of range).
#[unsafe(no_mangle)]
pub extern "C" fn garak_rig_param_id(index: u32) -> u32 {
    let Some(def) = PARAMS.get(index as usize) else { return 0 };
    let text = &mut rigs().text;
    for (o, b) in text.iter_mut().zip(def.id.bytes()) {
        *o = b;
    }
    def.id.len().min(text.len()) as u32
}

/// Default, minimum and maximum of a parameter, written to the rig params buffer slots 0..3.
#[unsafe(no_mangle)]
pub extern "C" fn garak_rig_param_range(index: u32) -> u32 {
    let Some(def) = PARAMS.get(index as usize) else { return 0 };
    if let Some(head) = rigs().params.first_chunk_mut::<3>() {
        *head = [def.default, def.min, def.max];
    }
    1
}

/// For the first `count` values of the params buffer: bit `i` set when reverb instance `i` is in
/// the rack and switched on (it needs kernels), its Decay written to the decays buffer.
#[unsafe(no_mangle)]
pub extern "C" fn garak_rig_reverb_decays(count: u32) -> u32 {
    let p = rigs();
    let values = p.params;
    let values = values.get(..(count as usize).min(PARAM_COUNT)).unwrap_or(&[]);
    let mut mask = 0;
    for (i, (decay, out)) in guitar::reverb_decays(values).iter().zip(p.decays.iter_mut()).enumerate() {
        if let Some(d) = decay {
            mask |= 1 << i;
            *out = *d;
        }
    }
    mask
}

/// Builds a rig from the first `count` values of the params buffer, synthesising the plate
/// kernels of every switched-on reverb here (~10-20 ms each: the worklet uses
/// `garak_rig_create_prepared` with kernels from the main thread instead). Returns a slot or -1.
#[unsafe(no_mangle)]
pub extern "C" fn garak_rig_create(sample_rate: f64, count: u32) -> i32 {
    create(sample_rate, count, None)
}

/// `garak_rig_create` with the plate kernels prepared elsewhere: `k0..k2` are regions from
/// `garak_region_alloc` holding `garak_reverb_build(rate, 0, decay)` output for each reverb
/// instance `garak_rig_reverb_decays` reports (0 for the others). The rig owns them from here on;
/// on failure (-1) they are freed. No IR synthesis happens here.
#[unsafe(no_mangle)]
pub extern "C" fn garak_rig_create_prepared(
    sample_rate: f64,
    count: u32,
    k0: usize,
    k1: usize,
    k2: usize,
) -> i32 {
    create(sample_rate, count, Some([k0, k1, k2]))
}

fn create(sample_rate: f64, count: u32, prepared: Option<[usize; MAX_REVERBS]>) -> i32 {
    let p = rigs();
    let arena = &mut pool().arena;
    let given = prepared.unwrap_or([0; MAX_REVERBS]);
    let fail = |arena: &mut crate::arena::Arena, regions: &[usize]| {
        release(arena, &given);
        release(arena, regions);
        -1
    };
    if !(8000.0..=192_000.0).contains(&sample_rate) {
        return fail(arena, &[]);
    }
    let Some(index) = p.slots.iter().position(Option::is_none) else { return fail(arena, &[]) };
    let values = p.params;
    let values = values.get(..(count as usize).min(PARAM_COUNT)).unwrap_or(&[]);
    let ir_len = guitar::reverb_ir_len(sample_rate);
    let kernel_floats = reverb::kernel_len(ir_len);
    // Regions the rig will own: the prepared ones, or kernels built here.
    let decays = guitar::reverb_decays(values);
    let mut owned = [0usize; MAX_REVERBS];
    if prepared.is_some() {
        let short = |region: usize| arena.len_of(region).is_none_or(|bytes| bytes < kernel_floats * 4);
        if decays.iter().zip(&given).any(|(d, &k)| d.is_some() && short(k)) {
            return fail(arena, &[]);
        }
        for ((o, d), &k) in owned.iter_mut().zip(&decays).zip(&given) {
            if d.is_some() {
                *o = k;
            } else if k != 0 {
                arena.free(k);
            }
        }
    } else {
        for (o, d) in owned.iter_mut().zip(&decays) {
            let Some(d) = d else { continue };
            match build_kernels(arena, sample_rate, 0, d.clamp(0.0, 1.0)) {
                Some((region, _, _)) => *o = region,
                None => {
                    release(arena, &owned);
                    return -1;
                }
            }
        }
    }
    let used_ir = if owned.iter().any(|&k| k != 0) { ir_len } else { 0 };
    let storage_len = GuitarRig::storage_len(sample_rate, values, used_ir);
    let storage = if storage_len > 0 { arena.alloc(storage_len * 4).unwrap_or(0) } else { 0 };
    let state = arena.alloc(size_of::<RigState>()).unwrap_or(0);
    if state == 0 || (storage_len > 0 && storage == 0) {
        release(arena, &owned);
        release(arena, &[state, storage]);
        return -1;
    }
    let mut views: [&'static [f32]; MAX_REVERBS] = [&[]; MAX_REVERBS];
    for (view, &k) in views.iter_mut().zip(&owned) {
        if k != 0 {
            // SAFETY: a live arena region of at least `kernel_floats` floats, owned by this rig.
            *view = unsafe { floats(k, kernel_floats) };
        }
    }
    // SAFETY: an arena region of `storage_len` floats, reserved until `garak_rig_free`.
    let storage_buf = unsafe { floats(storage, storage_len) };
    // Built in place: the rig is ~40 KiB, and moving it through `GuitarRig::new`'s return value
    // would overflow the module's 64 KiB stack.
    let rig = state as *mut RigState;
    // SAFETY: `state` is a 16-byte aligned region of `size_of::<RigState>()` bytes, reserved until
    // `garak_rig_free`; after the write it holds a valid rig (an empty rack) that `build` fills.
    let built = unsafe {
        ptr::write(rig, GuitarRig::empty(sample_rate));
        (*rig).build(values, storage_buf, views, used_ir)
    };
    match built {
        Ok(()) => {
            if let Some(s) = p.slots.get_mut(index) {
                *s = Some(Slot { rig, state, storage, kernels: owned });
            }
            i32::try_from(index).unwrap_or(-1)
        }
        Err(_) => {
            release(arena, &owned);
            release(arena, &[state, storage]);
            -1
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rig_free(slot: i32) {
    let Some(entry) = usize::try_from(slot).ok().and_then(|i| rigs().slots.get_mut(i)) else { return };
    if let Some(s) = entry.take() {
        let arena = &mut pool().arena;
        release(arena, &[s.state, s.storage]);
        release(arena, &s.kernels);
    }
}

/// Every parameter from the rig params buffer, then automate in place (glides).
#[unsafe(no_mangle)]
pub extern "C" fn garak_rig_automate(slot: i32, count: u32) {
    let values = rigs().params;
    if let Some(r) = rig(slot) {
        r.automate(values.get(..(count as usize).min(PARAM_COUNT)).unwrap_or(&[]));
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rig_set_param(slot: i32, index: u32, value: f64) {
    if let Some(r) = rig(slot) {
        r.set_param(index as usize, value);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rig_commit(slot: i32) {
    if let Some(r) = rig(slot) {
        r.commit();
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rig_reset(slot: i32) {
    if let Some(r) = rig(slot) {
        r.reset();
    }
}

/// Processes the first `frames` frames of the planar scratch buffers in place and writes the
/// tuner input (mono) to the tap buffer.
#[unsafe(no_mangle)]
pub extern "C" fn garak_rig_process(slot: i32, frame_count: u32) {
    let b = samples();
    let n = frames(frame_count);
    let tap = &mut rigs().tap;
    if let (Some(r), Some(l), Some(rr), Some(t)) =
        (rig(slot), b.left.get_mut(..n), b.right.get_mut(..n), tap.get_mut(..n))
    {
        r.process_planar_tap(l, rr, t);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rig_latency(slot: i32) -> u32 {
    rig(slot).map_or(0, |r| r.latency_frames())
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_rig_tail(slot: i32) -> f64 {
    rig(slot).map_or(0.0, |r| r.tail_seconds())
}

/// C++ `GuitarRig::takeStateFrom`: `slot` adopts `previous`'s module states (then free `previous`).
#[unsafe(no_mangle)]
pub extern "C" fn garak_rig_take_state(slot: i32, previous: i32) -> i32 {
    if slot == previous {
        return 0;
    }
    let p = rigs();
    let (Some(a), Some(b)) = (
        usize::try_from(slot).ok().and_then(|i| p.slots.get(i).copied().flatten()),
        usize::try_from(previous).ok().and_then(|i| p.slots.get(i).copied().flatten()),
    ) else {
        return 0;
    };
    // SAFETY: distinct live slots (checked above) point to distinct rigs.
    let swapped = match unsafe { (a.rig.as_mut(), b.rig.as_mut()) } {
        (Some(x), Some(y)) => x.take_state_from(y),
        _ => false,
    };
    if swapped {
        // Each rig now points into the other's storage: swap the ownership records too.
        for (i, storage) in [(slot, b.storage), (previous, a.storage)] {
            if let Some(Some(s)) = usize::try_from(i).ok().and_then(|i| p.slots.get_mut(i)) {
                s.storage = storage;
            }
        }
    }
    i32::from(swapped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TEST_LOCK;
    use crate::fx::{
        garak_heap_used, garak_region_alloc, garak_region_free, garak_reverb_build, garak_reverb_kernel_len,
    };

    fn defaults(changes: &[(&str, f64)]) -> u32 {
        for (i, def) in PARAMS.iter().enumerate() {
            rigs().params[i] = def.default;
        }
        for (id, v) in changes {
            let i = PARAMS.iter().position(|d| d.id == *id).unwrap();
            rigs().params[i] = *v;
        }
        PARAM_COUNT as u32
    }

    fn render(slot: i32, blocks: usize) -> std::vec::Vec<f32> {
        let mut out = std::vec::Vec::new();
        for block in 0..blocks {
            let s = samples();
            for i in 0..128 {
                s.left[i] = ((block * 128 + i) as f32 * 0.02).sin() * 0.5 + if i == 0 { 0.8 } else { 0.0 };
                s.right[i] = s.left[i] * 0.7;
            }
            garak_rig_process(slot, 128);
            let s = samples();
            out.extend_from_slice(&s.left[..128]);
            out.extend_from_slice(&s.right[..128]);
        }
        out
    }

    #[test]
    fn rigs_build_process_hand_over_and_free() {
        let _guard = TEST_LOCK.lock().unwrap();
        let before = garak_heap_used();
        assert_eq!(garak_rig_param_count(), 154);
        let n = garak_rig_param_id(0) as usize;
        assert_eq!(&rigs().text[..n], b"compSustain");
        let count = defaults(&[("driveEnabled", 1.0), ("chorusEnabled", 1.0), ("delayEnabled", 1.0)]);
        let a = garak_rig_create(22_050.0, count);
        assert!(a >= 0);
        assert_eq!(garak_rig_latency(a), 24);
        let first = render(a, 8);
        assert!(first.iter().all(|x| x.is_finite()) && first.iter().any(|x| x.abs() > 1e-3));
        // Reordered rack: whole-storage swap.
        let count = defaults(&[
            ("driveEnabled", 1.0),
            ("chorusEnabled", 1.0),
            ("delayEnabled", 1.0),
            ("rackSlot4", 6.0),
            ("rackSlot5", 5.0),
        ]);
        let b = garak_rig_create(22_050.0, count);
        assert_eq!(garak_rig_take_state(b, a), 1);
        garak_rig_free(a);
        render(b, 4);
        garak_rig_set_param(b, 12, 20.0);
        garak_rig_commit(b);
        garak_rig_automate(b, count);
        garak_rig_free(b);
        assert_eq!(garak_heap_used(), before);
        garak_rig_process(-1, 128);
        garak_rig_free(99);
        assert_eq!(garak_rig_create(100.0, count), -1);
    }

    #[test]
    fn prepared_plate_kernels_match_self_built_ones() {
        let _guard = TEST_LOCK.lock().unwrap();
        let before = garak_heap_used();
        let sr = 22_050.0;
        let count = defaults(&[
            ("rackSlot6", 10.0),
            ("rackSlot7", 26.0),
            ("reverbEnabled", 1.0),
            ("reverbDecay", 0.7),
        ]);
        assert_eq!(garak_rig_reverb_decays(count), 1);
        assert_eq!(rigs().decays[0], 0.7);
        let a = garak_rig_create(sr, count);
        let floats = garak_reverb_kernel_len(sr, 0.0) as usize;
        let built = garak_reverb_build(sr, 0.0, 0.7);
        let copy = garak_region_alloc(floats as u32);
        // SAFETY: both are live arena regions of `floats` floats.
        unsafe { core::ptr::copy_nonoverlapping(built as *const f32, copy as *mut f32, floats) };
        garak_region_free(built);
        let count = defaults(&[
            ("rackSlot6", 10.0),
            ("rackSlot7", 26.0),
            ("reverbEnabled", 1.0),
            ("reverbDecay", 0.7),
        ]);
        let b = garak_rig_create_prepared(sr, count, copy, 0, 0);
        assert!(a >= 0 && b >= 0);
        assert!((garak_rig_tail(b) - 4.45).abs() < 1e-12);
        assert_eq!(render(a, 30), render(b, 30));
        garak_rig_free(a);
        garak_rig_free(b);
        // Missing or short kernels are refused, and what was handed over is released.
        let small = garak_region_alloc(16);
        assert_eq!(garak_rig_create_prepared(sr, count, small, 0, 0), -1);
        assert_eq!(garak_rig_create_prepared(sr, count, 0, 0, 0), -1);
        assert_eq!(garak_heap_used(), before);
    }

    #[test]
    fn the_tuner_tap_sees_its_rack_position() {
        let _guard = TEST_LOCK.lock().unwrap();
        let count = defaults(&[
            ("rackSlot0", 11.0),
            ("rackSlot1", 0.0),
            ("rackSlot2", 0.0),
            ("rackSlot3", 0.0),
            ("rackSlot4", 0.0),
            ("rackSlot5", 0.0),
            ("tunerEnabled", 1.0),
        ]);
        let a = garak_rig_create(48_000.0, count);
        let s = samples();
        s.left[..64].fill(0.5);
        s.right[..64].fill(0.25);
        garak_rig_process(a, 64);
        assert!(rigs().tap[..64].iter().all(|&x| x == 0.375));
        assert!(samples().left[..64].iter().all(|&x| x == 0.0));
        garak_rig_free(a);
    }
}

//! Built-in effects for the worklet: `garak_fx_*`. Same slot model as the biquad / utility pools:
//! `garak_fx_create` returns a slot index (or -1), the other exports take it and ignore invalid
//! ones. Parameters travel through a static `f64` buffer (`garak_params_ptr`, catalog order of
//! `garak_fx_param_id`); samples through the planar scratch buffers. Effect buffers (delay lines,
//! reverb kernels) live in the arena (`arena.rs`), so creating an effect may grow the memory.

use core::cell::UnsafeCell;
use core::ptr;

use garak_dsp::fx::reverb;
use garak_dsp::{EffectKind, Fx, MAX_PARAMS};

use crate::arena::Arena;
use crate::{MAX_SLOTS, frames, samples};

type FxState = Fx<'static>;

#[derive(Clone, Copy, Debug)]
struct Slot {
    fx: *mut FxState,
    state: usize,
    storage: usize,
    kernels: usize,
}

pub(crate) struct FxPool {
    pub(crate) arena: Arena,
    slots: [Option<Slot>; MAX_SLOTS],
    params: [f64; MAX_PARAMS],
    meter: [f32; 2],
    text: [u8; 64],
}

struct Global(UnsafeCell<FxPool>);
// SAFETY: one wasm instance runs on one thread; host tests serialise through `TEST_LOCK`.
unsafe impl Sync for Global {}

static POOL: Global = Global(UnsafeCell::new(FxPool {
    arena: Arena::new(),
    slots: [None; MAX_SLOTS],
    params: [0.0; MAX_PARAMS],
    meter: [0.0; 2],
    text: [0; 64],
}));

pub(crate) fn pool() -> &'static mut FxPool {
    // SAFETY: single-threaded, and no export keeps the reference across another export call.
    unsafe { &mut *POOL.0.get() }
}

fn fx(slot: i32) -> Option<&'static mut FxState> {
    let s = usize::try_from(slot).ok().and_then(|i| pool().slots.get(i).copied().flatten())?;
    // SAFETY: `s.fx` was written by `garak_fx_create` and stays valid until `garak_fx_free`.
    unsafe { s.fx.as_mut() }
}

/// # Safety
/// `start` is 0 or an arena region of at least `len` floats that outlives every use.
pub(crate) unsafe fn floats(start: usize, len: usize) -> &'static mut [f32] {
    if start == 0 || len == 0 {
        &mut []
    } else {
        // SAFETY: caller contract; arena regions are 16-byte aligned.
        unsafe { core::slice::from_raw_parts_mut(start as *mut f32, len) }
    }
}

/// Releases whatever a failed create had reserved.
pub(crate) fn release(arena: &mut Arena, regions: &[usize]) {
    for &r in regions {
        if r != 0 {
            arena.free(r);
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_params_ptr() -> *mut f64 {
    pool().params.as_mut_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_meter_ptr() -> *const f32 {
    pool().meter.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_text_ptr() -> *const u8 {
    pool().text.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_fx_param_count(kind: u32) -> u32 {
    EffectKind::from_u32(kind).map_or(0, |k| k.params().len() as u32)
}

/// Writes parameter `index`'s id (UTF-8, no terminator) to the text buffer; returns its length.
#[unsafe(no_mangle)]
pub extern "C" fn garak_fx_param_id(kind: u32, index: u32) -> u32 {
    let Some(def) = EffectKind::from_u32(kind).and_then(|k| k.params().get(index as usize)) else { return 0 };
    let text = &mut pool().text;
    for (o, b) in text.iter_mut().zip(def.id.bytes()) {
        *o = b;
    }
    def.id.len().min(text.len()) as u32
}

/// Default, minimum and maximum of a parameter, written to the params buffer slots 0..3.
#[unsafe(no_mangle)]
pub extern "C" fn garak_fx_param_range(kind: u32, index: u32) -> u32 {
    let Some(def) = EffectKind::from_u32(kind).and_then(|k| k.params().get(index as usize)) else { return 0 };
    if let Some(head) = pool().params.first_chunk_mut::<3>() {
        *head = [def.default, def.min, def.max];
    }
    1
}

/// Creates an effect from the first `count` values of the params buffer (catalog order). Returns
/// a slot index, or -1 (no free slot, invalid kind or rate, out of memory). May grow memory.
/// A reverb synthesises its impulse response and FFT kernels here (~10-20 ms of work for a hall);
/// the worklet uses `garak_fx_create_reverb` with kernels prepared on the main thread instead.
#[unsafe(no_mangle)]
pub extern "C" fn garak_fx_create(kind: u32, sample_rate: f64, bpm: f64, count: u32) -> i32 {
    create(kind, sample_rate, bpm, count, None)
}

/// `garak_fx_create` for a reverb whose kernels were prepared elsewhere (`garak_reverb_build`,
/// usually in another instance on the main thread) and copied into `kernels`, a region from
/// `garak_region_alloc` of at least `garak_reverb_kernel_len` floats for the reverb's type and
/// rate. The effect owns the region from here on; on failure (-1) it is freed. No IR synthesis
/// or FFT work happens here, so this is cheap enough for the audio thread.
#[unsafe(no_mangle)]
pub extern "C" fn garak_fx_create_reverb(sample_rate: f64, bpm: f64, count: u32, kernels: usize) -> i32 {
    create(EffectKind::Reverb as u32, sample_rate, bpm, count, Some(kernels))
}

/// Floats of the prepared reverb kernels for `space` (the reverb `type` parameter) at `sample_rate`.
#[unsafe(no_mangle)]
pub extern "C" fn garak_reverb_kernel_len(sample_rate: f64, space: f64) -> u32 {
    if !(8000.0..=192_000.0).contains(&sample_rate) {
        return 0;
    }
    let ir_len = reverb::ir_len(sample_rate, reverb::space_of(space));
    u32::try_from(reverb::kernel_len(ir_len)).unwrap_or(0)
}

/// Synthesises the impulse response of (`space`, `size`) and prepares its partitioned kernels in a
/// new region (`garak_reverb_kernel_len` floats). Returns its address, or 0. Control path only;
/// free with `garak_region_free`.
#[unsafe(no_mangle)]
pub extern "C" fn garak_reverb_build(sample_rate: f64, space: f64, size: f64) -> usize {
    if !(8000.0..=192_000.0).contains(&sample_rate) {
        return 0;
    }
    let size = if size.is_nan() { 0.35 } else { size.clamp(0.0, 1.0) };
    build_kernels(&mut pool().arena, sample_rate, reverb::space_of(space), size)
        .map_or(0, |(region, _, _)| region)
}

/// A region of at least `floats` floats (16-byte aligned), or 0 when memory cannot grow. Control
/// path only; may grow memory.
#[unsafe(no_mangle)]
pub extern "C" fn garak_region_alloc(floats: u32) -> usize {
    pool().arena.alloc((floats as usize).saturating_mul(4)).unwrap_or(0)
}

/// Returns a region from `garak_region_alloc` / `garak_reverb_build`; other addresses are ignored.
#[unsafe(no_mangle)]
pub extern "C" fn garak_region_free(region: usize) {
    pool().arena.free(region);
}

/// IR synthesis + kernel preparation into a new region: (region, floats, ir_len).
pub(crate) fn build_kernels(
    arena: &mut Arena,
    sample_rate: f64,
    space: usize,
    size: f64,
) -> Option<(usize, usize, usize)> {
    let ir_len = reverb::ir_len(sample_rate, space);
    let scratch_len = reverb::ir_scratch_len(sample_rate, space);
    let kernel_floats = reverb::kernel_len(ir_len);
    let k = arena.alloc(kernel_floats * 4)?;
    let Some(ir) = arena.alloc((2 * ir_len + scratch_len) * 4) else {
        arena.free(k);
        return None;
    };
    // SAFETY: fresh, disjoint arena regions of the requested sizes.
    let (kernel_buf, ir_buf) = unsafe { (floats(k, kernel_floats), floats(ir, 2 * ir_len + scratch_len)) };
    let (left, rest) = ir_buf.split_at_mut(ir_len.min(ir_buf.len()));
    let (right, scratch) = rest.split_at_mut(ir_len.min(rest.len()));
    let ok = reverb::generate_ir(sample_rate, space, size, left, right, scratch)
        && reverb::prepare_kernels(left, right, ir_len, kernel_buf);
    arena.free(ir);
    if !ok {
        arena.free(k);
        return None;
    }
    Some((k, kernel_floats, ir_len))
}

/// Shared by both create exports. `prepared` (reverb only) is consumed: owned by the new effect,
/// or freed on any failure.
fn create(kind: u32, sample_rate: f64, bpm: f64, count: u32, prepared: Option<usize>) -> i32 {
    let p = pool();
    let fail = |p: &mut FxPool| {
        if let Some(region) = prepared {
            p.arena.free(region);
        }
        -1
    };
    let Some(kind) = EffectKind::from_u32(kind) else { return fail(p) };
    if !(8000.0..=192_000.0).contains(&sample_rate) {
        return fail(p);
    }
    let Some(index) = p.slots.iter().position(Option::is_none) else { return fail(p) };
    let values = p.params;
    let values = values.get(..(count as usize).min(MAX_PARAMS)).unwrap_or(&[]);
    let mut kernels = (0usize, 0usize, 0usize); // (region, floats, ir_len)
    if kind == EffectKind::Reverb {
        let type_index = kind.params().iter().position(|d| d.id == "type");
        let size_index = kind.params().iter().position(|d| d.id == "size");
        let pick =
            |i: Option<usize>, fallback: f64| i.and_then(|i| values.get(i)).copied().unwrap_or(fallback);
        let space = reverb::space_of(pick(type_index, 0.0));
        let size = pick(size_index, 0.35).clamp(0.0, 1.0);
        kernels = match prepared {
            Some(region) => {
                let ir_len = reverb::ir_len(sample_rate, space);
                let kernel_floats = reverb::kernel_len(ir_len);
                if p.arena.len_of(region).is_none_or(|bytes| bytes < kernel_floats * 4) {
                    return fail(p);
                }
                (region, kernel_floats, ir_len)
            }
            None => match build_kernels(&mut p.arena, sample_rate, space, size) {
                Some(k) => k,
                None => return -1,
            },
        };
    } else if prepared.is_some() {
        return fail(p);
    }
    let storage_len = Fx::storage_len(kind, sample_rate, kernels.2);
    let storage = if storage_len > 0 { p.arena.alloc(storage_len * 4).unwrap_or(0) } else { 0 };
    let state = p.arena.alloc(size_of::<FxState>()).unwrap_or(0);
    if state == 0 || (storage_len > 0 && storage == 0) {
        release(&mut p.arena, &[state, storage, kernels.0]);
        return -1;
    }
    // SAFETY: arena regions of the requested sizes; they stay reserved until `garak_fx_free`.
    let (storage_buf, kernel_buf) = unsafe { (floats(storage, storage_len), floats(kernels.0, kernels.1)) };
    match Fx::new(kind, sample_rate, bpm, values, storage_buf, kernel_buf, kernels.2) {
        Ok(effect) => {
            let fx = state as *mut FxState;
            // SAFETY: `state` is a 16-byte aligned region of `size_of::<FxState>()` bytes.
            unsafe { ptr::write(fx, effect) };
            if let Some(s) = p.slots.get_mut(index) {
                *s = Some(Slot { fx, state, storage, kernels: kernels.0 });
            }
            i32::try_from(index).unwrap_or(-1)
        }
        Err(_) => {
            release(&mut p.arena, &[state, storage, kernels.0]);
            -1
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_fx_free(slot: i32) {
    let p = pool();
    let Some(entry) = usize::try_from(slot).ok().and_then(|i| p.slots.get_mut(i)) else { return };
    if let Some(s) = entry.take() {
        // `Fx` has no destructor (asserted in garak-ffi); just return its regions.
        release(&mut p.arena, &[s.state, s.storage, s.kernels]);
    }
}

/// Every parameter from the params buffer, then automate in place (glides).
#[unsafe(no_mangle)]
pub extern "C" fn garak_fx_automate(slot: i32, count: u32) {
    let values = pool().params;
    if let Some(f) = fx(slot) {
        f.automate(values.get(..(count as usize).min(MAX_PARAMS)).unwrap_or(&[]));
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_fx_set_param(slot: i32, index: u32, value: f64) {
    if let Some(f) = fx(slot) {
        f.set_param(index as usize, value);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_fx_commit(slot: i32) {
    if let Some(f) = fx(slot) {
        f.commit();
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_fx_set_tempo(slot: i32, bpm: f64) {
    if let Some(f) = fx(slot) {
        f.set_tempo(bpm);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_fx_reset(slot: i32) {
    if let Some(f) = fx(slot) {
        f.reset();
    }
}

/// Processes the first `frames` frames of the planar scratch buffers in place.
#[unsafe(no_mangle)]
pub extern "C" fn garak_fx_process(slot: i32, frame_count: u32) {
    let b = samples();
    let n = frames(frame_count);
    if let (Some(f), Some(l), Some(r)) = (fx(slot), b.left.get_mut(..n), b.right.get_mut(..n)) {
        f.process_planar(l, r);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_fx_latency(slot: i32) -> u32 {
    fx(slot).map_or(0, |f| f.latency_frames())
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_fx_tail(slot: i32) -> f64 {
    fx(slot).map_or(0.0, |f| f.tail_seconds())
}

/// Compressor / limiter / gate: writes [peak, lowest gain] since the last call to the meter buffer
/// and returns 1; 0 for other effects.
#[unsafe(no_mangle)]
pub extern "C" fn garak_fx_meter(slot: i32) -> i32 {
    match fx(slot).and_then(|f| f.take_meter()) {
        Some((peak, gain)) => {
            pool().meter = [peak, gain];
            1
        }
        None => 0,
    }
}

/// C++ `takeStateFrom`: `slot` adopts `previous`'s audio history (then free `previous`).
#[unsafe(no_mangle)]
pub extern "C" fn garak_fx_take_state(slot: i32, previous: i32) -> i32 {
    if slot == previous {
        return 0;
    }
    let p = pool();
    let (Some(a), Some(b)) = (
        usize::try_from(slot).ok().and_then(|i| p.slots.get(i).copied().flatten()),
        usize::try_from(previous).ok().and_then(|i| p.slots.get(i).copied().flatten()),
    ) else {
        return 0;
    };
    // SAFETY: distinct live slots (checked above) point to distinct effects.
    let swapped = match unsafe { (a.fx.as_mut(), b.fx.as_mut()) } {
        (Some(x), Some(y)) => x.take_state_from(y),
        _ => false,
    };
    if swapped {
        // Each effect now points into the other's storage: swap the ownership records too.
        for (i, storage) in [(slot, b.storage), (previous, a.storage)] {
            if let Some(Some(s)) = usize::try_from(i).ok().and_then(|i| p.slots.get_mut(i)) {
                s.storage = storage;
            }
        }
    }
    i32::from(swapped)
}

/// Arena bytes in use (diagnostics).
#[unsafe(no_mangle)]
pub extern "C" fn garak_heap_used() -> u32 {
    u32::try_from(pool().arena.used()).unwrap_or(u32::MAX)
}

/// Arena bytes reserved from linear memory, used or free (diagnostics).
#[unsafe(no_mangle)]
pub extern "C" fn garak_heap_reserved() -> u32 {
    u32::try_from(pool().arena.reserved()).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TEST_LOCK;

    fn set_params(values: &[f64]) {
        pool().params[..values.len()].copy_from_slice(values);
    }

    #[test]
    fn create_process_and_free_every_kind() {
        let _guard = TEST_LOCK.lock().unwrap();
        let before = garak_heap_used();
        for kind in EffectKind::ALL {
            let n = garak_fx_param_count(kind as u32);
            let defaults: std::vec::Vec<f64> = (0..n)
                .map(|i| {
                    assert_eq!(garak_fx_param_range(kind as u32, i), 1);
                    pool().params[0]
                })
                .collect();
            let id_len = garak_fx_param_id(kind as u32, 0) as usize;
            assert_eq!(&pool().text[..id_len], kind.params()[0].id.as_bytes());
            set_params(&defaults);
            let slot = garak_fx_create(kind as u32, 22_050.0, 120.0, n);
            assert!(slot >= 0, "{}", kind.id());
            let s = samples();
            for i in 0..512 {
                s.left[i] = (i as f32 * 0.03).sin() * 0.7;
                s.right[i] = (i as f32 * 0.05).cos() * 0.7;
            }
            garak_fx_process(slot, 512);
            garak_fx_set_param(slot, 0, defaults[0]);
            garak_fx_commit(slot);
            garak_fx_set_tempo(slot, 90.0);
            garak_fx_automate(slot, n);
            garak_fx_process(slot, 512);
            let s = samples();
            assert!(s.left[..512].iter().chain(&s.right[..512]).all(|x| x.is_finite()), "{}", kind.id());
            let metered = matches!(kind, EffectKind::Compressor | EffectKind::Limiter | EffectKind::Gate);
            assert_eq!(garak_fx_meter(slot), i32::from(metered));
            garak_fx_free(slot);
        }
        assert_eq!(garak_heap_used(), before);
    }

    #[test]
    fn reverb_from_prepared_kernels_matches_a_self_built_reverb() {
        let _guard = TEST_LOCK.lock().unwrap();
        let before = garak_heap_used();
        let n = garak_fx_param_count(EffectKind::Reverb as u32);
        // amount, size, tone, type (plate), predelay, lowcut, dry
        let values = [0.8, 0.6, 12_000.0, 2.0, 12.0, 120.0, 0.5];
        let floats = garak_reverb_kernel_len(48_000.0, 2.0) as usize;
        assert!(floats > 0);
        let built = garak_reverb_build(48_000.0, 2.0, 0.6);
        assert_ne!(built, 0);
        let copy = garak_region_alloc(floats as u32);
        // SAFETY: both are live arena regions of `floats` floats.
        unsafe { core::ptr::copy_nonoverlapping(built as *const f32, copy as *mut f32, floats) };
        garak_region_free(built);
        set_params(&values);
        let a = garak_fx_create(EffectKind::Reverb as u32, 48_000.0, 120.0, n);
        set_params(&values);
        let b = garak_fx_create_reverb(48_000.0, 120.0, n, copy);
        assert!(a >= 0 && b >= 0);
        let mut outputs = [std::vec::Vec::new(), std::vec::Vec::new()];
        for (slot, out) in [a, b].into_iter().zip(&mut outputs) {
            for block in 0..20 {
                let s = samples();
                for i in 0..256 {
                    s.left[i] = if block == 0 && i == 3 {
                        1.0
                    } else {
                        ((block * 256 + i) as f32 * 0.01).sin() * 0.3
                    };
                    s.right[i] = s.left[i] * -0.5;
                }
                garak_fx_process(slot, 256);
                let s = samples();
                out.extend_from_slice(&s.left[..256]);
                out.extend_from_slice(&s.right[..256]);
            }
        }
        assert_eq!(outputs[0], outputs[1]);
        garak_fx_free(a);
        garak_fx_free(b);
        // Short regions, unknown addresses and other kinds are refused; a handed-over region is released.
        let small = garak_region_alloc(16);
        set_params(&values);
        assert_eq!(garak_fx_create_reverb(48_000.0, 120.0, n, small), -1);
        assert_eq!(garak_fx_create_reverb(48_000.0, 120.0, n, 12345), -1);
        assert_eq!(garak_heap_used(), before);
        assert_eq!(garak_reverb_kernel_len(100.0, 0.0), 0);
        assert_eq!(garak_reverb_build(100.0, 0.0, 0.5), 0);
    }

    #[test]
    fn take_state_swaps_storage_ownership() {
        let _guard = TEST_LOCK.lock().unwrap();
        let before = garak_heap_used();
        set_params(&[0.8, 0.5, 0.5]);
        let a = garak_fx_create(EffectKind::Chorus as u32, 48_000.0, 120.0, 3);
        set_params(&[2.0, 0.2, 1.0]);
        let b = garak_fx_create(EffectKind::Chorus as u32, 48_000.0, 120.0, 3);
        assert_eq!(garak_fx_take_state(b, a), 1);
        garak_fx_free(a);
        garak_fx_process(b, 128);
        garak_fx_free(b);
        assert_eq!(garak_heap_used(), before);
        assert_eq!(garak_fx_create(99, 48_000.0, 120.0, 0), -1);
        assert_eq!(garak_fx_create(0, 100.0, 120.0, 0), -1);
        garak_fx_process(-1, 128);
        garak_fx_free(77);
    }
}

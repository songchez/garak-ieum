//! Built-in instruments for the worklet: `garak_instrument_*` (옥구슬 EP, 한밤 106; the same
//! garak-dsp code garak-ffi links into the C++ engine, so both render identical samples).
//!
//! Slot model like the effects: `garak_instrument_create` returns a slot index (or -1) and the other
//! exports ignore invalid ones. Parameters travel through a static `f64` buffer
//! (`garak_instrument_params_ptr`, catalog order), block events through a static event buffer
//! (`garak_instrument_events_ptr`, 24-byte `InstrumentEvent`s sorted by offset), samples come back
//! in the planar scratch buffers (`garak_left_ptr` / `garak_right_ptr`). Instruments live in a
//! small fixed pool (a worklet node hosts one), so creating one never grows the memory.

use core::cell::UnsafeCell;
use core::mem::MaybeUninit;

use garak_dsp::instruments::{Instrument, InstrumentEvent, InstrumentKind, MAX_INSTRUMENT_PARAMS};

use crate::{frames, samples};

/// Instruments per module instance (one worklet node normally hosts exactly one).
pub const MAX_INSTRUMENTS: usize = 4;
/// Events per process call.
pub const MAX_EVENTS: usize = 512;

const NO_EVENT: InstrumentEvent =
    InstrumentEvent { offset: 0, kind: 0, id: 0, pitch: 0, value: 0.0, param: 0 };

struct Pool {
    // `MaybeUninit` + flags rather than `Option<Instrument>`: an all-zero static lands in `.bss`.
    // (`None` of a niche-optimised `Option` is not all zeros and would put ~40 KB of data into the
    // .wasm file.)
    slots: [MaybeUninit<Instrument>; MAX_INSTRUMENTS],
    used: [bool; MAX_INSTRUMENTS],
    params: [f64; MAX_INSTRUMENT_PARAMS],
    events: [InstrumentEvent; MAX_EVENTS],
    text: [u8; 64],
}

struct Global(UnsafeCell<Pool>);
// SAFETY: one wasm instance runs on one thread; host tests serialise through `TEST_LOCK`.
unsafe impl Sync for Global {}

static POOL: Global = Global(UnsafeCell::new(Pool {
    slots: [const { MaybeUninit::zeroed() }; MAX_INSTRUMENTS],
    used: [false; MAX_INSTRUMENTS],
    params: [0.0; MAX_INSTRUMENT_PARAMS],
    events: [NO_EVENT; MAX_EVENTS],
    text: [0; 64],
}));

fn pool() -> &'static mut Pool {
    // SAFETY: single-threaded, and no export keeps the reference across another export call.
    unsafe { &mut *POOL.0.get() }
}

impl Pool {
    fn get_mut(&mut self, index: i32) -> Option<&mut Instrument> {
        let i = usize::try_from(index).ok()?;
        if !self.used.get(i).copied().unwrap_or(false) {
            return None;
        }
        // SAFETY: `used[i]` is set only after `slots[i]` was written by `garak_instrument_create`.
        self.slots.get_mut(i).map(|s| unsafe { s.assume_init_mut() })
    }

    fn get(&self, index: i32) -> Option<&Instrument> {
        let i = usize::try_from(index).ok()?;
        if !self.used.get(i).copied().unwrap_or(false) {
            return None;
        }
        // SAFETY: as `get_mut`.
        self.slots.get(i).map(|s| unsafe { s.assume_init_ref() })
    }
}

fn slot(index: i32) -> Option<&'static mut Instrument> {
    pool().get_mut(index)
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_instrument_params_ptr() -> *mut f64 {
    pool().params.as_mut_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_instrument_events_ptr() -> *mut InstrumentEvent {
    pool().events.as_mut_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_instrument_text_ptr() -> *const u8 {
    pool().text.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_instrument_max_events() -> u32 {
    MAX_EVENTS as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_instrument_param_count(kind: u32) -> u32 {
    InstrumentKind::from_u32(kind).map_or(0, |k| k.params().len() as u32)
}

/// Writes parameter `index`'s id (UTF-8, no terminator) to the text buffer; returns its length.
#[unsafe(no_mangle)]
pub extern "C" fn garak_instrument_param_id(kind: u32, index: u32) -> u32 {
    let Some(def) = InstrumentKind::from_u32(kind).and_then(|k| k.params().get(index as usize)) else {
        return 0;
    };
    let text = &mut pool().text;
    for (o, b) in text.iter_mut().zip(def.id.bytes()) {
        *o = b;
    }
    def.id.len().min(text.len()) as u32
}

/// Default, minimum and maximum of a parameter, written to the params buffer slots 0..3.
#[unsafe(no_mangle)]
pub extern "C" fn garak_instrument_param_range(kind: u32, index: u32) -> u32 {
    let Some(def) = InstrumentKind::from_u32(kind).and_then(|k| k.params().get(index as usize)) else {
        return 0;
    };
    if let Some(head) = pool().params.first_chunk_mut::<3>() {
        *head = [def.default, def.min, def.max];
    }
    1
}

/// Creates an instrument from the first `count` values of the params buffer (catalog order).
/// Returns a slot index, or -1 (no free slot, invalid kind or rate).
#[unsafe(no_mangle)]
pub extern "C" fn garak_instrument_create(kind: u32, sample_rate: f64, count: u32) -> i32 {
    let Some(kind) = InstrumentKind::from_u32(kind) else { return -1 };
    if !(8000.0..=192_000.0).contains(&sample_rate) {
        return -1;
    }
    let p = pool();
    let Some(index) = p.used.iter().position(|u| !u) else { return -1 };
    let mut inst = Instrument::new(kind, sample_rate);
    inst.set_params(p.params.get(..(count as usize).min(MAX_INSTRUMENT_PARAMS)).unwrap_or(&[]));
    let (Some(s), Some(u)) = (p.slots.get_mut(index), p.used.get_mut(index)) else { return -1 };
    s.write(inst);
    *u = true;
    i32::try_from(index).unwrap_or(-1)
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_instrument_free(slot_index: i32) {
    // `Instrument` has no destructor (plain data): clearing the flag frees the slot.
    if let Some(u) = usize::try_from(slot_index).ok().and_then(|i| pool().used.get_mut(i)) {
        *u = false;
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_instrument_set_param(slot_index: i32, index: u32, value: f64) {
    if let Some(i) = slot(slot_index) {
        i.set_param(index as usize, value);
    }
}

/// Renders `frame_count` frames into the scratch buffers, applying the first `event_count` events
/// of the event buffer (sorted by offset).
#[unsafe(no_mangle)]
pub extern "C" fn garak_instrument_process(slot_index: i32, frame_count: u32, event_count: u32) {
    let n = frames(frame_count);
    let p = pool();
    let Ok(i) = usize::try_from(slot_index) else { return };
    if !p.used.get(i).copied().unwrap_or(false) {
        return;
    }
    let events = p.events.get(..(event_count as usize).min(MAX_EVENTS)).unwrap_or(&[]);
    let b = samples();
    let Some(cell) = p.slots.get_mut(i) else { return };
    // SAFETY: `used[i]` is set only after `slots[i]` was written.
    let inst = unsafe { cell.assume_init_mut() };
    if let (Some(l), Some(r)) = (b.left.get_mut(..n), b.right.get_mut(..n)) {
        inst.process(l, r, events);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_instrument_reset(slot_index: i32) {
    if let Some(i) = slot(slot_index) {
        i.reset();
    }
}

/// `slot_index` adopts `previous`'s voices and delay lines, keeping its own parameters.
#[unsafe(no_mangle)]
pub extern "C" fn garak_instrument_take_state(slot_index: i32, previous: i32) {
    if slot_index == previous {
        return;
    }
    let Some(prev) = pool().get(previous).cloned() else { return };
    if let Some(i) = slot(slot_index) {
        i.take_state(&prev);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_instrument_tail(slot_index: i32) -> f64 {
    slot(slot_index).map_or(0.0, |i| i.tail_seconds())
}

#[unsafe(no_mangle)]
pub extern "C" fn garak_instrument_active_voices(slot_index: i32) -> u32 {
    slot(slot_index).map_or(0, |i| i.active_voices() as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TEST_LOCK;
    use garak_dsp::instruments::event;

    #[test]
    fn creates_plays_and_frees() {
        let _guard = TEST_LOCK.lock().unwrap();
        let slots: std::vec::Vec<i32> =
            (0..MAX_INSTRUMENTS).map(|_| garak_instrument_create(1, 48_000.0, 0)).collect();
        assert!(slots.iter().all(|&s| s >= 0));
        assert_eq!(garak_instrument_create(1, 48_000.0, 0), -1);
        for &s in &slots[1..] {
            garak_instrument_free(s);
        }
        assert_eq!(garak_instrument_create(7, 48_000.0, 0), -1);
        let s = slots[0];
        pool().events[0] =
            InstrumentEvent { offset: 3, kind: event::NOTE_ON, id: 1, pitch: 60, value: 0.8, param: 0 };
        garak_instrument_process(s, 128, 1);
        assert!(samples().left[..128].iter().any(|v| v.abs() > 1e-4));
        assert_eq!(garak_instrument_active_voices(s), 1);
        garak_instrument_process(s, u32::MAX, u32::MAX);
        garak_instrument_process(-1, 128, 0);
        garak_instrument_free(s);
        assert_eq!(garak_instrument_param_id(0, 0), 4);
        assert_eq!(&pool().text[..4], b"tone");
    }
}

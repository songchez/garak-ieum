//! Instruments on the audio half never allocate or free (docs/RUST_ENGINE.md 3): the instrument
//! project (synths, samples, vintage) rendered through note-dense blocks, live MIDI, track
//! replacements that hand voices over, a new graph after a tempo change, seeks and cycle wraps,
//! all under a global allocator that counts heap events while armed. (Separate test binary: the
//! counter is process-wide.)
#![allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::std_instead_of_core)]

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use garak_engine::protocol::timeline_from_bytes;
use garak_engine::testkit::instruments::{ALL, instrument_project};
use garak_engine::{Applied, EngineConfig, engine};

struct Counting;
static ARMED: AtomicBool = AtomicBool::new(false);
static EVENTS: AtomicUsize = AtomicUsize::new(0);

// SAFETY: forwards to the system allocator; the counters are lock-free atomics.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if ARMED.load(Ordering::Relaxed) {
            EVENTS.fetch_add(1, Ordering::Relaxed);
        }
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        if ARMED.load(Ordering::Relaxed) {
            EVENTS.fetch_add(1, Ordering::Relaxed);
        }
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if ARMED.load(Ordering::Relaxed) {
            EVENTS.fetch_add(1, Ordering::Relaxed);
        }
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

#[test]
fn instruments_never_touch_the_heap() {
    let p = instrument_project(ALL, 2.0, 48_000);
    let mut plan = timeline_from_bytes(p.json.as_bytes(), &[]).unwrap();
    plan.cycle = Some((24_000, 80_000));
    let (mut c, mut r) =
        engine(EngineConfig { sample_rate: 48_000, max_block: 128, offline: false }).unwrap();
    for (id, a) in &p.assets {
        c.put_asset(id, a.clone()).unwrap();
    }
    for s in &p.sample_sets {
        c.register_samples_json(s.as_bytes()).unwrap();
    }
    let mut out = vec![0.0f32; 2 * 512];
    let render = |r: &mut garak_engine::Renderer, out: &mut [f32], blocks: usize| {
        for _ in 0..blocks {
            ARMED.store(true, Ordering::SeqCst);
            r.render(out);
            ARMED.store(false, Ordering::SeqCst);
        }
    };
    assert_eq!(c.update(plan.clone()).unwrap(), Applied::Full);
    c.play().unwrap();
    render(&mut r, &mut out, 60);
    // Live MIDI on a synth, a sampled instrument and a vintage instrument, with the pedal.
    for track in [0u32, 6, 9] {
        c.note_on(track, 64, 0.8, 3).unwrap();
        c.control_change(track, 64, 127).unwrap();
        c.control_change(track, 129, 2000).unwrap();
    }
    render(&mut r, &mut out, 10);
    for track in [0u32, 6, 9] {
        c.note_off(track, 64, 3).unwrap();
        c.preview_note(track, 67, 0.6, 2000).unwrap();
        c.control_change(track, 64, 0).unwrap();
    }
    render(&mut r, &mut out, 10);
    // Knob edits and note edits: track replacements that keep their voices.
    let mut edit = plan.clone();
    edit.revision = 2;
    for t in &mut edit.tracks {
        if let Some(n) = t.notes.get_mut(3) {
            n.velocity *= 0.9;
        }
        for (_, v) in t.source.params.iter_mut().take(1) {
            *v *= 0.9;
        }
    }
    assert_eq!(c.update(edit.clone()).unwrap(), Applied::Tracks);
    render(&mut r, &mut out, 40);
    // An IEUM WAVE patch change (new table set: the running synth crossfades), and an edit right
    // behind it that waits for the crossfade to finish.
    edit.revision = 20;
    let lead = edit.tracks.iter().position(|t| t.id == "wave-lead").unwrap();
    edit.tracks[lead].source.patch = garak_engine::testkit::instruments::wave_patch(false);
    assert_eq!(c.update(edit.clone()).unwrap(), Applied::Full);
    render(&mut r, &mut out, 1);
    edit.revision = 21;
    edit.master_gain = 0.6;
    edit.bpm = 101.0;
    assert_eq!(c.update(edit.clone()).unwrap(), Applied::Full);
    render(&mut r, &mut out, 10);
    // A tempo change: a new graph whose tracks continue.
    edit.revision = 3;
    edit.bpm = 120.0;
    assert_eq!(c.update(edit.clone()).unwrap(), Applied::Full);
    render(&mut r, &mut out, 120);
    c.seek(60_000).unwrap();
    render(&mut r, &mut out, 20);
    for track in 0..11u32 {
        c.all_notes_off(track).unwrap();
    }
    c.stop().unwrap();
    render(&mut r, &mut out, 10);
    assert_eq!(EVENTS.load(Ordering::SeqCst), 0, "the renderer touched the heap");
    c.collect();
    assert!(out.iter().all(|x| x.is_finite()));
}

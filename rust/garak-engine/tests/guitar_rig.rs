//! The guitar rig as an engine insert (garak-dsp `fx::guitar`): accepted, rendered, live knobs
//! as in-place diffs, structural edits (rack layout, reverb Decay / switch) as track rebuilds that
//! carry the rig's state over, and no heap traffic on the audio thread for any of it.
// Test code: helpers outside #[test] functions may unwrap and index (clippy.toml covers only the
// test functions themselves); the counting allocator needs std's System allocator.
#![allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::std_instead_of_core)]

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use garak_engine::protocol::timeline_from_bytes;
use garak_engine::testkit::project;
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

const RIG: &str = r#"{"id":"rig","type":"guitar-rig","params":{"driveEnabled":1,"ampModel":1,"chorusEnabled":1,"delayEnabled":1,"reverbEnabled":1,"rackSlot6":10}}"#;

fn rig_project() -> String {
    let p = project(2, 1.5, 48_000);
    // Track 1's chain is filter + chorus: the chorus becomes a rig.
    p.json.replacen(r#"{"id":"chorus","type":"chorus","params":{"rate":1.3,"depth":0.6,"mix":0.4}}"#, RIG, 1)
}

fn set_param(plan: &mut garak_engine::plan::Plan, id: &str, value: f64) {
    let insert = plan.tracks[1].inserts.iter_mut().find(|e| e.id == "rig").unwrap();
    match insert.params.iter_mut().find(|(k, _)| k == id) {
        Some((_, v)) => *v = value,
        None => insert.params.push((id.into(), value)),
    }
}

#[test]
fn rig_inserts_render_and_follow_edits_without_allocating() {
    let json = rig_project();
    assert!(json.contains("guitar-rig"));
    let p = project(2, 1.5, 48_000);
    let plan = timeline_from_bytes(json.as_bytes(), &[]).unwrap();
    let (mut c, mut r) =
        engine(EngineConfig { sample_rate: 48_000, max_block: 128, offline: false }).unwrap();
    for (id, a) in &p.assets {
        c.put_asset(id, a.clone()).unwrap();
    }
    let mut out = vec![0.0f32; 2 * 256];
    let render = |r: &mut garak_engine::Renderer, out: &mut [f32]| {
        ARMED.store(true, Ordering::SeqCst);
        r.render(out);
        ARMED.store(false, Ordering::SeqCst);
        out.iter().map(|x| x.abs()).fold(0.0f32, f32::max)
    };
    assert_eq!(c.update(plan.clone()).unwrap(), Applied::Full);
    c.play().unwrap();
    let mut loudest = 0.0f32;
    for _ in 0..40 {
        loudest = loudest.max(render(&mut r, &mut out));
    }
    assert!(loudest > 1e-3 && out.iter().all(|x| x.is_finite()));
    // A knob is a live parameter: applied in place.
    let mut edit = plan.clone();
    edit.revision = 2;
    set_param(&mut edit, "ampGain", 24.0);
    assert_eq!(c.update(edit.clone()).unwrap(), Applied::Diff);
    render(&mut r, &mut out);
    // The rack layout and the reverb's Decay are structural: the track is rebuilt and adopts state.
    edit.revision = 3;
    set_param(&mut edit, "rackSlot4", 6.0);
    set_param(&mut edit, "rackSlot5", 5.0);
    assert_eq!(c.update(edit.clone()).unwrap(), Applied::Tracks);
    render(&mut r, &mut out);
    edit.revision = 4;
    set_param(&mut edit, "reverbDecay", 0.9);
    assert_eq!(c.update(edit.clone()).unwrap(), Applied::Tracks);
    for _ in 0..8 {
        render(&mut r, &mut out);
    }
    c.collect();
    assert_eq!(EVENTS.load(Ordering::SeqCst), 0, "the audio thread touched the heap");
    // Out-of-range rig parameters are refused like the C++ Reader does.
    let mut bad = edit.clone();
    bad.revision = 5;
    set_param(&mut bad, "ampGain", 99.0);
    assert!(c.update(bad).is_err());
}

//! The audio half never allocates or frees (docs/RUST_ENGINE.md 3): every `Renderer::render`
//! call, including the ones that apply graph swaps, track replacements and in-place diffs, runs
//! under a global allocator that counts allocations and frees while armed.
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

#[test]
fn render_never_touches_the_heap() {
    let p = project(8, 2.0, 48_000);
    let plan = timeline_from_bytes(p.json.as_bytes(), &[]).unwrap();
    let (mut c, mut r) =
        engine(EngineConfig { sample_rate: 48_000, max_block: 128, offline: false }).unwrap();
    for (id, a) in &p.assets {
        c.put_asset(id, a.clone()).unwrap();
    }
    let mut out = vec![0.0f32; 2 * 512];
    let render = |r: &mut garak_engine::Renderer, out: &mut [f32]| {
        ARMED.store(true, Ordering::SeqCst);
        r.render(out);
        ARMED.store(false, Ordering::SeqCst);
    };
    assert_eq!(c.update(plan.clone()).unwrap(), Applied::Full);
    c.play().unwrap();
    for _ in 0..40 {
        render(&mut r, &mut out);
    }
    // Mix, send, live parameter and master diffs.
    let mut edit = plan.clone();
    edit.revision = 2;
    edit.tracks[0].gain = 0.2;
    edit.tracks[1].sends[0].gain = 1.5;
    for (k, v) in &mut edit.tracks[0].inserts[1].params {
        if k == "ratio" {
            *v = 9.0;
        }
    }
    edit.master_gain = 0.5;
    assert_eq!(c.update(edit.clone()).unwrap(), Applied::Diff);
    render(&mut r, &mut out);
    // A track replacement (its chain state carries over) and a new graph that continues the old.
    edit.revision = 3;
    edit.tracks[2].audio.pop();
    assert_eq!(c.update(edit.clone()).unwrap(), Applied::Tracks);
    render(&mut r, &mut out);
    edit.revision = 4;
    edit.tracks.swap(0, 1);
    assert_eq!(c.update(edit.clone()).unwrap(), Applied::Full);
    for _ in 0..40 {
        render(&mut r, &mut out);
    }
    // Transport.
    c.seek(12_345).unwrap();
    render(&mut r, &mut out);
    c.stop().unwrap();
    render(&mut r, &mut out);
    assert_eq!(EVENTS.load(Ordering::SeqCst), 0, "the renderer touched the heap");
    // The retired graph and track are freed here, on the control thread.
    c.collect();
    assert!(out.iter().all(|x| x.is_finite()));
}

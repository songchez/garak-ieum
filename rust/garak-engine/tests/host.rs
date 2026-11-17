//! Host-driven rendering (`Renderer::render_block`, docs/RUST_ENGINE.md 10): the shell's position
//! drives the graph exactly like the engine's own transport, commands wait for the shell's ticket,
//! senders on a worker pool are bit-identical to one thread, and none of it touches the heap.
// Test code: helpers may unwrap and index; the counting allocator and the pool need std.
#![allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::std_instead_of_core)]

use std::alloc::{GlobalAlloc, Layout, System};
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use garak_engine::protocol::timeline_from_bytes;
use garak_engine::testkit::project;
use garak_engine::{Applied, Controller, EngineConfig, HostTask, Parallel, Renderer, engine};

struct Counting;
static EVENTS: AtomicUsize = AtomicUsize::new(0);
// Per thread: the test harness runs the other tests (which allocate) concurrently.
thread_local! { static ARMED: AtomicBool = const { AtomicBool::new(false) }; }
fn armed() -> bool {
    ARMED.try_with(|a| a.load(Ordering::Relaxed)).unwrap_or(false)
}
fn arm(on: bool) {
    ARMED.with(|a| a.store(on, Ordering::SeqCst));
}

// SAFETY: forwards to the system allocator; the counters are lock-free atomics.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if armed() {
            EVENTS.fetch_add(1, Ordering::Relaxed);
        }
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        if armed() {
            EVENTS.fetch_add(1, Ordering::Relaxed);
        }
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

const BLOCK: u32 = 128;

fn setup(tracks: usize) -> (Controller, Renderer, garak_engine::Plan) {
    let p = project(tracks, 2.0, 48_000);
    let plan = timeline_from_bytes(p.json.as_bytes(), &[]).unwrap();
    let (mut c, r) = engine(EngineConfig { sample_rate: 48_000, max_block: BLOCK, offline: false }).unwrap();
    for (id, a) in &p.assets {
        c.put_asset(id, a.clone()).unwrap();
    }
    assert_eq!(c.update(plan.clone()).unwrap(), Applied::Full);
    (c, r, plan)
}

/// A scoped pool good enough for a test: one std thread per task (not real-time; the C++ host's
/// `WorkerPool` is). Only used outside the armed allocator window.
unsafe extern "C" fn spawn_all(_host: *mut c_void, count: u32, task: HostTask, job: *mut c_void) {
    let job = job as usize;
    std::thread::scope(|s| {
        for i in 0..count {
            s.spawn(move || unsafe { task(job as *mut c_void, i) });
        }
    });
}

/// Inline "pool": the calling thread runs every task (what a pool of zero workers does), allocation free.
unsafe extern "C" fn inline_all(_host: *mut c_void, count: u32, task: HostTask, job: *mut c_void) {
    for i in (0..count).rev() {
        unsafe { task(job, i) };
    }
}

#[test]
fn host_blocks_match_the_engine_transport() {
    let (mut c1, mut own, _) = setup(6);
    let (c2, mut host, _) = setup(6);
    c1.play().unwrap();
    let mut a = vec![0.0f32; 2 * BLOCK as usize];
    let mut b = a.clone();
    let mut peaks = [0.0f32; 16];
    let mut position = 0i64;
    for _ in 0..600 {
        own.render(&mut a);
        // The engine's own render adds the master gain and processor, which render_block leaves to
        // the host (bit parity with the C++ shell is native/tests/rust_engine_host_test.cpp); here the
        // two follow the same transport: sound and silence line up, all finite.
        host.render_block(&mut b, position, true, c2.ticket(), &mut peaks, None);
        position += i64::from(BLOCK);
        assert!(b.iter().all(|x| x.is_finite()));
        assert_eq!(a.iter().any(|x| *x != 0.0), b.iter().any(|x| *x != 0.0));
    }
    assert!(peaks.iter().any(|p| *p > 0.0));
    assert_eq!(host.position(), position);
}

#[test]
fn commands_wait_for_the_shell_ticket() {
    let (mut c, mut r, plan) = setup(4);
    let mut out = vec![0.0f32; 2 * BLOCK as usize];
    let mut peaks = [0.0f32; 8];
    let first = c.ticket();
    r.render_block(&mut out, 0, true, first, &mut peaks, None);
    let mut edit = plan.clone();
    edit.revision = 2;
    edit.tracks[0].gain = 0.0;
    assert_eq!(c.update(edit).unwrap(), Applied::Diff);
    // Not yet allowed: the old gain still renders and the revision stays.
    r.render_block(&mut out, 128, true, first, &mut peaks, None);
    assert_eq!(c.snapshot().revision, plan.revision);
    r.render_block(&mut out, 256, true, c.ticket(), &mut peaks, None);
    assert_eq!(c.snapshot().revision, 2);
    assert_eq!(c.snapshot().last_applied, c.ticket());
}

#[test]
fn parallel_senders_are_bit_identical_and_heap_free() {
    let (c1, mut one, _) = setup(12);
    let (c2, mut many, _) = setup(12);
    let (c3, mut inline, _) = setup(12);
    let spawn = Parallel { run: spawn_all, host: core::ptr::null_mut() };
    let same = Parallel { run: inline_all, host: core::ptr::null_mut() };
    let mut a = vec![0.0f32; 2 * BLOCK as usize];
    let mut b = a.clone();
    let mut d = a.clone();
    let mut peaks = [0.0f32; 16];
    for k in 0..400i64 {
        let position = k * i64::from(BLOCK);
        one.render_block(&mut a, position, true, c1.ticket(), &mut peaks, None);
        many.render_block(&mut b, position, true, c2.ticket(), &mut peaks, Some(&spawn));
        arm(true);
        inline.render_block(&mut d, position, true, c3.ticket(), &mut peaks, Some(&same));
        arm(false);
        assert_eq!(a, b, "parallel senders differ at block {k}");
        assert_eq!(a, d, "reordered senders differ at block {k}");
        if k == 200 {
            arm(true);
            one.host_reset(position, true, true);
            many.host_reset(position, true, true);
            inline.host_reset(position, true, true);
            arm(false);
        }
    }
    assert_eq!(EVENTS.load(Ordering::SeqCst), 0, "render_block touched the heap");
}

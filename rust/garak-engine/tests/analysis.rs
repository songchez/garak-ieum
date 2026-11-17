//! Analysis taps (the editors' spectrum analyser, the utility's stereo scope and the guitar rig's tuner):
//! requested per (track, insert), copied out every block, silent when off, and no heap traffic on the
//! audio thread for any of it.
#![allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::std_instead_of_core, clippy::float_cmp)]

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use garak_engine::protocol::timeline_from_bytes;
use garak_engine::testkit::project;
use garak_engine::{AnalysisTap, Applied, EngineConfig, MAX_ANALYSIS, engine};

struct Counting;
static ARMED: AtomicBool = AtomicBool::new(false);
static EVENTS: AtomicUsize = AtomicUsize::new(0);
/// The allocation counter is process-wide: the tests run one at a time.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

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

const BLOCK: usize = 128;
/// Track 1's chain is filter + rig; the rig's rack: amp, tuner (engaged: it mutes what follows), cabinet.
const RIG: &str = r#"{"id":"rig","type":"guitar-rig","params":{"rackSlot0":3,"rackSlot1":11,"rackSlot2":4,"rackSlot3":0,"rackSlot4":0,"rackSlot5":0,"tunerEnabled":1}}"#;

fn energy(x: &[f32]) -> f64 {
    x.iter().map(|v| f64::from(*v) * f64::from(*v)).sum()
}

#[test]
fn taps_carry_the_insert_output_and_the_rig_tuner_input_without_allocating() {
    let _serial = SERIAL.lock().unwrap();
    let p = project(2, 1.5, 48_000);
    let json = p.json.replacen(
        r#"{"id":"chorus","type":"chorus","params":{"rate":1.3,"depth":0.6,"mix":0.4}}"#,
        RIG,
        1,
    );
    assert!(json.contains("guitar-rig"));
    let plan = timeline_from_bytes(json.as_bytes(), &[]).unwrap();
    let (mut c, mut r) =
        engine(EngineConfig { sample_rate: 48_000, max_block: BLOCK as u32, offline: false }).unwrap();
    for (id, a) in &p.assets {
        c.put_asset(id, a.clone()).unwrap();
    }
    assert_eq!(c.update(plan).unwrap(), Applied::Full);
    c.play().unwrap();
    let mut out = vec![0.0f32; 2 * BLOCK];
    let render = |r: &mut garak_engine::Renderer, out: &mut [f32]| {
        ARMED.store(true, Ordering::SeqCst);
        r.render(out);
        ARMED.store(false, Ordering::SeqCst);
    };
    for _ in 0..8 {
        render(&mut r, &mut out);
    }
    // Off: every slot silent.
    assert!(r.analysis_output().iter().all(|v| *v == 0.0));
    // Slot 0: track 0's first insert output; slot 1: the rig's tuner input (track 1, insert 1);
    // slot 2: the rig's output (muted by the engaged tuner); slot 3: a track that does not exist.
    c.set_analysis(&[
        AnalysisTap { track: 0, insert: 0, tuner: false },
        AnalysisTap { track: 1, insert: 1, tuner: true },
        AnalysisTap { track: 1, insert: 1, tuner: false },
        AnalysisTap { track: 9, insert: 0, tuner: false },
    ])
    .unwrap();
    let slot = BLOCK * 2;
    let (mut a, mut tuner, mut muted) = (0.0, 0.0, 0.0);
    let mut mono = true;
    for _ in 0..40 {
        render(&mut r, &mut out);
        let taps = r.analysis_output();
        assert_eq!(taps.len(), MAX_ANALYSIS * slot);
        a += energy(&taps[..slot]);
        tuner += energy(&taps[slot..2 * slot]);
        muted += energy(&taps[2 * slot..3 * slot]);
        mono &= taps[slot..2 * slot].as_chunks::<2>().0.iter().all(|f| f[0] == f[1]);
        assert!(taps[3 * slot..].iter().all(|v| *v == 0.0), "a tap without a track is silent");
    }
    assert!(a > 1e-6, "the insert output reaches its tap");
    assert!(tuner > 1e-6, "the tuner tap hears the signal arriving at the tuner");
    assert!(mono, "the tuner tap is mono on both channels");
    assert_eq!(muted, 0.0, "the engaged tuner mutes the rig's output");
    assert_eq!(EVENTS.load(Ordering::SeqCst), 0, "the audio thread touched the heap");
    // Turned off again: silent from the next block.
    c.set_analysis(&[]).unwrap();
    render(&mut r, &mut out);
    assert!(r.analysis_output().iter().all(|v| *v == 0.0));
    assert!(c.set_analysis(&[AnalysisTap::OFF; MAX_ANALYSIS + 1]).is_err());
}

#[test]
fn the_desktop_shell_path_copies_the_same_taps() {
    let _serial = SERIAL.lock().unwrap();
    // render_host (garak-ffi / RenderEngine) places the probes per block like render does.
    let p = project(2, 1.5, 48_000);
    let plan = timeline_from_bytes(p.json.as_bytes(), &[]).unwrap();
    let (mut c, mut r) =
        engine(EngineConfig { sample_rate: 48_000, max_block: BLOCK as u32, offline: false }).unwrap();
    for (id, a) in &p.assets {
        c.put_asset(id, a.clone()).unwrap();
    }
    assert_eq!(c.update(plan).unwrap(), Applied::Full);
    let mut out = vec![0.0f32; 2 * BLOCK];
    let mut peaks = [0.0f32; 4];
    let mut position = 0i64;
    for _ in 0..8 {
        r.render_block(&mut out, position, true, u64::MAX, &mut peaks, None);
        position += BLOCK as i64;
    }
    assert!(r.analysis_output().iter().all(|v| *v == 0.0));
    c.set_analysis(&[AnalysisTap { track: 0, insert: 0, tuner: false }]).unwrap();
    let slot = BLOCK * 2;
    let mut a = 0.0;
    for _ in 0..40 {
        ARMED.store(true, Ordering::SeqCst);
        r.render_block(&mut out, position, true, u64::MAX, &mut peaks, None);
        ARMED.store(false, Ordering::SeqCst);
        position += BLOCK as i64;
        a += energy(&r.analysis_output()[..slot]);
    }
    assert!(a > 1e-6, "the insert output reaches its tap on the shell path");
    assert_eq!(EVENTS.load(Ordering::SeqCst), 0, "the shell path touched the heap");
    c.set_analysis(&[]).unwrap();
    r.render_block(&mut out, position, true, u64::MAX, &mut peaks, None);
    assert!(r.analysis_output().iter().all(|v| *v == 0.0));
}

//! Sample-accurate live MIDI (docs/RUST_ENGINE.md 5.8): a live event `k` frames into a render call starts on
//! frame `k` — bit-identical to a timeline note there for the built-in voices, identical to splitting the host's
//! block at `k` for every instrument (built-in, sampled, 옥구슬 EP / 한밤 106, IEUM WAVE) — across render calls
//! and inner blocks, through track replacements, and to host nodes as a per-block `offset` (VST3 sampleOffset).
// Test code: helpers outside #[test] functions may unwrap and index (clippy.toml covers only the test functions).
#![allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::std_instead_of_core)]

use std::ffi::c_void;
use std::sync::Mutex;

use garak_engine::plan::{HostNode, Note, SourceKind, TrackPlan};
use garak_engine::testkit::instruments::wave_patch;
use garak_engine::{
    Applied, BlockInfo, Controller, EngineConfig, HostCallbacks, LIVE_QUEUE, LiveEvent, Plan, Renderer,
    TimedLiveEvent, engine,
};

const RATE: u32 = 48_000;

fn project(tracks: Vec<TrackPlan>) -> Plan {
    Plan { project_id: "live".into(), sample_rate: RATE, length_frames: 96_000, tracks, ..Plan::default() }
}

fn instrument(kind: SourceKind, id: &str) -> TrackPlan {
    let mut t = TrackPlan { id: "inst".into(), ..TrackPlan::default() };
    t.source.kind = kind;
    t.source.instrument_id = id.into();
    if kind == SourceKind::NativeWavetable {
        t.source.patch = wave_patch(true);
    }
    t
}

/// Every instrument family the engine renders itself (sampled sets need registered PCM: tests/instruments.rs).
fn instruments() -> Vec<(&'static str, TrackPlan)> {
    vec![
        ("keys", instrument(SourceKind::BuiltinSynth, "keys")),
        ("pluck", instrument(SourceKind::BuiltinSynth, "pluck")),
        ("drums", {
            let mut t = instrument(SourceKind::BuiltinSynth, "drums");
            t.source.is_kit = true;
            t
        }),
        ("okgu-ep", instrument(SourceKind::BuiltinSynth, "okgu-ep")),
        ("hanbam-106", instrument(SourceKind::BuiltinSynth, "hanbam-106")),
        ("wave", instrument(SourceKind::NativeWavetable, "wavetable")),
    ]
}

fn started(p: &Plan, block: u32) -> (Controller, Renderer) {
    let (mut c, r) = engine(EngineConfig { sample_rate: RATE, max_block: block, offline: false }).unwrap();
    assert_eq!(c.update(p.clone()).unwrap(), Applied::Full);
    c.play().unwrap();
    (c, r)
}

/// `calls` render calls of the given sizes, concatenated.
fn render(r: &mut Renderer, calls: &[usize]) -> Vec<f32> {
    let mut out = Vec::new();
    for &n in calls {
        let mut block = vec![0.0f32; n * 2];
        r.render(&mut block);
        out.extend_from_slice(&block);
    }
    out
}

fn first_sound(out: &[f32]) -> Option<usize> {
    out.iter().position(|x| *x != 0.0).map(|i| i / 2)
}

fn bits(v: &[f32]) -> Vec<u32> {
    v.iter().map(|x| x.to_bits()).collect()
}

#[test]
fn a_live_note_at_offset_k_is_a_timeline_note_at_frame_k() {
    // Built-in voices: a preview `k` frames into the first render call equals a timeline note of the same length at
    // frame `k`, bit for bit — inside the first inner block, at its edges, in a later inner block of the call
    // (256-frame calls over 128-frame blocks) and in a later call.
    for (name, base) in [
        ("keys", instrument(SourceKind::BuiltinSynth, "keys")),
        ("pluck", instrument(SourceKind::BuiltinSynth, "pluck")),
    ] {
        for k in [0u32, 1, 77, 127, 128, 200, 255, 256, 300, 1000] {
            let mut timeline = base.clone();
            timeline.notes = vec![Note {
                id: 1,
                on_frame: i64::from(k),
                off_frame: i64::from(k) + 4800,
                limit_frame: i64::from(k) + 4800,
                pitch: 60,
                velocity: 0.8,
            }];
            let (_, mut a) = started(&project(vec![timeline]), 128);
            let (mut c, mut b) = started(&project(vec![base.clone()]), 128);
            c.live_at(0, LiveEvent::Preview { pitch: 60, velocity: 0.8, frames: 4800 }, k).unwrap();
            let calls = [256usize; 40];
            let x = render(&mut a, &calls);
            let y = render(&mut b, &calls);
            // The envelope starts from zero on the onset sample itself.
            assert_eq!(first_sound(&x), Some(k as usize + 1), "{name}: timeline note at {k}");
            assert_eq!(first_sound(&y), Some(k as usize + 1), "{name}: live note at offset {k}");
            assert!(bits(&x) == bits(&y), "{name}: live note at offset {k} differs from the timeline note");
            assert_eq!(c.snapshot().live_played, 1);
        }
    }
}

#[test]
fn every_instrument_honours_the_offset_like_a_split_block() {
    // An event at offset k in one call renders exactly as if the host had split its call at k and sent the event
    // at the start of the second part (the C++ engine's queueLiveMidi), for every instrument family: note-on,
    // controllers and the note-off at their own offsets. Nothing sounds before k.
    for (name, t) in instruments() {
        let p = project(vec![t]);
        for k in [0u32, 5, 64, 127, 191] {
            let (mut c, mut a) = started(&p, 256);
            let (mut d, mut b) = started(&p, 256);
            c.live_at(0, LiveEvent::NoteOn { pitch: 62, velocity: 0.9, id: 7 }, k).unwrap();
            c.live_at(0, LiveEvent::Control { controller: 1, value: 90 }, k + 40).unwrap();
            // Pitch bend and channel aftertouch (the live path of a keyboard's bend wheel and pressure).
            c.live_at(0, LiveEvent::Control { controller: 129, value: -3000 }, k + 300).unwrap();
            c.live_at(0, LiveEvent::Control { controller: 128, value: 100 }, k + 301).unwrap();
            c.live_at(0, LiveEvent::NoteOff { pitch: 62, id: 7 }, k + 2000).unwrap();
            let x = render(&mut a, &[256; 48]);
            let mut y = render(&mut b, &[k as usize]);
            d.live(0, LiveEvent::NoteOn { pitch: 62, velocity: 0.9, id: 7 }).unwrap();
            y.extend(render(&mut b, &[40]));
            d.live(0, LiveEvent::Control { controller: 1, value: 90 }).unwrap();
            y.extend(render(&mut b, &[260]));
            d.live(0, LiveEvent::Control { controller: 129, value: -3000 }).unwrap();
            y.extend(render(&mut b, &[1]));
            d.live(0, LiveEvent::Control { controller: 128, value: 100 }).unwrap();
            y.extend(render(&mut b, &[1699]));
            d.live(0, LiveEvent::NoteOff { pitch: 62, id: 7 }).unwrap();
            y.extend(render(&mut b, &[256 * 48 - k as usize - 2000]));
            assert!(x[..k as usize * 2].iter().all(|v| *v == 0.0), "{name}: sound before offset {k}");
            assert!(x.iter().any(|v| *v != 0.0), "{name}: silent");
            assert!(bits(&x) == bits(&y), "{name}: offset {k} differs from the split block");
            assert_eq!(c.snapshot().live_played, 5, "{name}");
            // The bend and the pressure are heard from their sample on (kits ignore both).
            let (mut e, mut plain) = started(&p, 256);
            e.live_at(0, LiveEvent::NoteOn { pitch: 62, velocity: 0.9, id: 7 }, k).unwrap();
            e.live_at(0, LiveEvent::Control { controller: 1, value: 90 }, k + 40).unwrap();
            e.live_at(0, LiveEvent::NoteOff { pitch: 62, id: 7 }, k + 2000).unwrap();
            let z = render(&mut plain, &[256; 48]);
            let bent = (k as usize + 300) * 2;
            assert!(bits(&x[..bent]) == bits(&z[..bent]), "{name}: the bend sounded before its offset {k}");
            assert_eq!(
                bits(&x[bent..]) != bits(&z[bent..]),
                name != "drums",
                "{name}: bend and pressure at offset {k}"
            );
        }
    }
}

#[test]
fn queued_events_survive_replacements_and_a_full_queue_refuses() {
    let keys = instrument(SourceKind::BuiltinSynth, "keys");
    let p = project(vec![keys.clone()]);
    let (mut c, mut r) = started(&p, 128);
    c.live_at(0, LiveEvent::Preview { pitch: 60, velocity: 0.8, frames: 2400 }, 700).unwrap();
    let head = render(&mut r, &[128]);
    // A knob edit rebuilds the track (Replace): the event still waiting moves to the successor.
    let mut edit = p.clone();
    edit.revision = 1;
    edit.tracks[0].source.params.push(("tone".into(), 0.3));
    assert_eq!(c.update(edit).unwrap(), Applied::Tracks);
    let rest = render(&mut r, &[128; 10]);
    assert!(head.iter().all(|v| *v == 0.0));
    assert_eq!(first_sound(&rest), Some(700 - 128 + 1), "the queued note moved or was lost");
    // LIVE_QUEUE events wait at most; the next is refused (counted as ignored) until the queue drains.
    for i in 0..LIVE_QUEUE as u32 + 1 {
        c.live_at(0, LiveEvent::Control { controller: 1, value: 1 }, 4000 + i).unwrap();
    }
    let _ = render(&mut r, &[128]);
    let s = c.snapshot();
    assert_eq!((s.live_played, s.live_ignored), (1 + LIVE_QUEUE as u64, 1));
    assert!(c.live_at(0, LiveEvent::AllNotesOff, garak_engine::MAX_LIVE_OFFSET + 1).is_err());
}

static SEEN: Mutex<Vec<(u32, TimedLiveEvent)>> = Mutex::new(Vec::new());

unsafe extern "C" fn record(_user: *mut c_void, track: u32, events: *const TimedLiveEvent, count: u32) {
    let events = unsafe { std::slice::from_raw_parts(events, count as usize) };
    SEEN.lock().unwrap().extend(events.iter().map(|e| (track, *e)));
}

unsafe extern "C" fn silent_source(_user: *mut c_void, _track: u32, _stereo: *mut f32, _frames: u32) {}

#[test]
fn host_nodes_get_live_events_with_their_block_offsets() {
    // A VST3 instrument the host renders: the shell's live MIDI at sample offsets arrives through `live` right
    // before the block's `source` call, offset relative to that block (the plug-in's sampleOffset).
    let mut vst = TrackPlan { id: "vst".into(), ..TrackPlan::default() };
    vst.source.kind = SourceKind::Vst3;
    vst.source.host = Some(HostNode { latency: 0, tail: 0.0, stereo: true });
    let mut audio = TrackPlan { id: "audio".into(), ..TrackPlan::default() };
    audio.gain = 0.5;
    let p = project(vec![vst, audio]);
    let (mut c, mut r) = engine(EngineConfig { sample_rate: RATE, max_block: 128, offline: false }).unwrap();
    assert_eq!(c.update(p).unwrap(), Applied::Full);
    let nodes = HostCallbacks {
        user: core::ptr::null_mut(),
        source: Some(silent_source),
        insert: None,
        input: None,
        live: Some(record),
    };
    let block = |r: &mut Renderer, position: i64, ticket: u64| {
        let mut out = vec![0.0f32; 256];
        let info = BlockInfo {
            position,
            playing: true,
            allowed: ticket,
            master_gain: 1.0,
            target_master_gain: 1.0,
            monitor: [0; 4],
            host: Some(&nodes),
            ahead: &[],
        };
        r.render_host(&mut out, &info, &mut [0.0; 4], None);
    };
    block(&mut r, 0, c.ticket());
    assert!(r.host_live(0, LiveEvent::NoteOn { pitch: 60, velocity: 0.5, id: 3 }, 5));
    assert!(r.host_live(0, LiveEvent::Control { controller: 129, value: -100 }, 5));
    assert!(r.host_live(0, LiveEvent::NoteOff { pitch: 60, id: 3 }, 300));
    assert!(!r.host_live(1, LiveEvent::NoteOn { pitch: 60, velocity: 0.5, id: 4 }, 0), "audio track");
    for k in 1..5 {
        block(&mut r, k * 128, c.ticket());
    }
    let seen = SEEN.lock().unwrap().clone();
    let on = LiveEvent::NoteOn { pitch: 60, velocity: 0.5, id: 3 }.encode(5);
    let bend = LiveEvent::Control { controller: 129, value: -100 }.encode(5);
    // 300 frames after the first block's start: the third block (frames 256..384), 44 into it.
    let off = LiveEvent::NoteOff { pitch: 60, id: 3 }.encode(44);
    assert_eq!(seen, vec![(0, on), (0, bend), (0, off)]);
    assert_eq!(on.event(), Some(LiveEvent::NoteOn { pitch: 60, velocity: 0.5, id: 3 }));
}

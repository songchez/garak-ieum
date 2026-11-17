//! The instrument cases of native/tests/engine_test.cpp, ported to the Rust engine (gate G2 in
//! docs/RUST_ENGINE.md 7.4): built-in synths and block-size independence, sample zones and missing
//! assets, piano release noise, live MIDI and the live sustain pedal, MIDI controllers (measured
//! pitch and level), controllers under a tempo map, edits that keep voices and tails, note diffs
//! that equal a rebuilt graph, graph changes that keep other tracks, offline == live rendering, and
//! the refusals. Bit parity with the C++ engine is native/tests/rust_engine_instrument_parity_test.cpp.
// Test code: helpers outside #[test] functions may unwrap and index (clippy.toml covers only the
// test functions themselves).
#![allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::std_instead_of_core)]

use garak_engine::plan::{
    AutomationLane, AutomationPoint, ControlEvent, InsertPlan, LaneTarget, Note, SourceKind, TrackPlan,
};
use garak_engine::{
    Applied, Controller, EngineConfig, PcmAsset, Plan, Renderer, SampleSet, SampleZone, UNLIMITED_FRAME,
    engine,
};

fn project(rate: u32, frames: i64) -> Plan {
    Plan { project_id: "test".into(), sample_rate: rate, length_frames: frames, ..Plan::default() }
}

fn synth_track(id: &str) -> TrackPlan {
    let mut t = TrackPlan { id: "track".into(), ..TrackPlan::default() };
    t.source.kind = SourceKind::BuiltinSynth;
    t.source.instrument_id = id.into();
    t.source.is_kit = id == "drums";
    t
}

fn sampled_track(set: &str, kit: bool) -> TrackPlan {
    let mut t = TrackPlan { id: "samples".into(), ..TrackPlan::default() };
    t.source.kind = SourceKind::BuiltinSampled;
    t.source.instrument_id = "test".into();
    t.source.sample_set_id = set.into();
    t.source.is_kit = kit;
    t
}

fn param(t: &mut TrackPlan, name: &str, value: f64) {
    match t.source.params.iter_mut().find(|(k, _)| k == name) {
        Some(slot) => slot.1 = value,
        None => {
            t.source.params.push((name.into(), value));
            t.source.params.sort_by(|a, b| a.0.cmp(&b.0));
        }
    }
}

fn note(id: i32, on: i64, off: i64, limit: i64, pitch: i32, velocity: f32) -> Note {
    Note { id, on_frame: on, off_frame: off, limit_frame: limit, pitch, velocity }
}

fn cc(frame: i64, controller: u16, value: i32) -> ControlEvent {
    ControlEvent { frame, controller, value }
}

fn zone(
    asset: &str,
    root: i32,
    lo: i32,
    hi: i32,
    vlo: f64,
    vhi: f64,
    looped: Option<[f64; 2]>,
    choke: i32,
) -> SampleZone {
    SampleZone { asset_id: asset.into(), root, lo, hi, vlo, vhi, gain_db: 0.0, tune: 0.0, looped, choke }
}

fn set(id: &str, kit: bool, zones: Vec<SampleZone>, releases: Vec<SampleZone>) -> SampleSet {
    SampleSet {
        id: id.into(),
        is_kit: kit,
        gain_db: 0.0,
        release: 0.25,
        start_offset: 0.0,
        zones,
        release_zones: releases,
    }
}

fn mono(rate: u32, samples: Vec<f32>) -> PcmAsset {
    PcmAsset { sample_rate: rate, channels: 1, samples }
}

fn eng(rate: u32, block: u32) -> (Controller, Renderer) {
    engine(EngineConfig { sample_rate: rate, max_block: block, offline: false }).unwrap()
}

fn render(r: &mut Renderer, frames: usize, block: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; frames * 2];
    let mut at = 0;
    while at < frames {
        let n = block.min(frames - at);
        r.render(&mut out[at * 2..(at + n) * 2]);
        at += n;
    }
    out
}

fn energy(d: &[f32]) -> f64 {
    d.iter()
        .map(|v| {
            assert!(v.is_finite(), "non-finite rendered PCM");
            f64::from(*v) * f64::from(*v)
        })
        .sum()
}

fn max_diff(a: &[f32], b: &[f32]) -> f64 {
    assert_eq!(a.len(), b.len(), "different rendered lengths");
    a.iter().zip(b).map(|(x, y)| f64::from((x - y).abs())).fold(0.0, f64::max)
}

fn same(a: &[f32], b: &[f32], tolerance: f64, message: &str) {
    let d = max_diff(a, b);
    assert!(d <= tolerance, "{message} (difference {d})");
}

fn near(a: f64, b: f64, tolerance: f64, message: &str) {
    assert!(a.is_finite() && (a - b).abs() <= tolerance, "{message}: actual {a}, expected {b}");
}

fn started(c: &mut Controller, p: &Plan) {
    assert_eq!(c.update(p.clone()).unwrap(), Applied::Full);
    c.play().unwrap();
}

#[test]
fn synths_and_block_independence() {
    for id in ["keys", "bass", "pad", "pluck", "rhodes", "drums"] {
        let mut p = project(48_000, 48_000);
        let mut t = synth_track(id);
        param(&mut t, "level", 0.25);
        t.notes.push(note(1, 37, 4000, 48_000, if id == "drums" { 38 } else { 60 }, 0.8));
        p.tracks.push(t);
        let (mut ca, mut ra) = eng(48_000, 512);
        let (mut cb, mut rb) = eng(48_000, 512);
        started(&mut ca, &p);
        started(&mut cb, &p);
        let x = render(&mut ra, 12_000, 31);
        let y = render(&mut rb, 12_000, 257);
        assert!(energy(&x) > 0.01, "{id} rendered silence");
        same(&x, &y, 1e-6, "synthesis changes with callback block size");
        assert!(x[..37 * 2].iter().all(|v| *v == 0.0), "{id}: a timeline note played before its exact onset");
    }
}

#[test]
fn sampled_zones_and_missing_assets() {
    let (mut c, mut r) = eng(48_000, 4096);
    c.put_asset("quiet", mono(48_000, vec![0.04; 20_000])).unwrap();
    c.put_asset("loud", mono(48_000, vec![0.12; 20_000])).unwrap();
    let kit = set(
        "set",
        true,
        vec![zone("quiet", 36, 36, 36, 0.0, 0.5, None, 1), zone("loud", 36, 36, 36, 0.5, 1.0, None, 1)],
        vec![],
    );
    c.put_sample_set(kit.clone()).unwrap();
    let mut p = project(48_000, 48_000);
    let mut t = sampled_track("set", true);
    t.notes = vec![note(1, 0, 10, 48_000, 36, 0.25)];
    p.tracks.push(t);
    started(&mut c, &p);
    let q = render(&mut r, 2000, 128);
    let (mut c2, mut r2) = eng(48_000, 4096);
    c2.put_asset("quiet", mono(48_000, vec![0.04; 20_000])).unwrap();
    c2.put_asset("loud", mono(48_000, vec![0.12; 20_000])).unwrap();
    c2.put_sample_set(kit.clone()).unwrap();
    p.tracks[0].notes[0].velocity = 0.75;
    started(&mut c2, &p);
    let l = render(&mut r2, 2000, 128);
    assert!(energy(&l) > energy(&q) * 5.0, "sample velocity layer selection is incorrect");
    assert!(q[1500 * 2].abs() > 0.001, "one-shot kit was incorrectly cut by MIDI note duration");
    // A missing sample set never falls back to a synth; a set whose PCM is gone is refused.
    let (mut none, _) = eng(48_000, 4096);
    none.put_asset("quiet", mono(48_000, vec![0.04; 20_000])).unwrap();
    assert!(none.update(p.clone()).is_err(), "missing sample set silently fell back to a synth");
    assert!(none.put_sample_set(kit.clone()).is_err(), "a set without its PCM was registered");
    let (mut gone, _) = eng(48_000, 4096);
    gone.put_asset("quiet", mono(48_000, vec![0.04; 20_000])).unwrap();
    gone.put_asset("loud", mono(48_000, vec![0.12; 20_000])).unwrap();
    gone.put_sample_set(kit).unwrap();
    gone.remove_asset("loud");
    assert!(gone.update(p.clone()).is_err(), "missing sample PCM silently succeeded");
    // A looped sample sustains past the PCM length.
    let (mut c3, mut r3) = eng(48_000, 4096);
    c3.put_asset("quiet", mono(48_000, vec![0.04; 20_000])).unwrap();
    c3.put_sample_set(set(
        "looped",
        false,
        vec![zone("quiet", 60, 0, 127, 0.0, 1.0, Some([0.02, 0.04]), -1)],
        vec![],
    ))
    .unwrap();
    let mut held = project(48_000, 48_000);
    let mut t = sampled_track("looped", false);
    t.notes = vec![note(1, 0, 48_000, 48_000, 60, 0.7)];
    held.tracks.push(t);
    started(&mut c3, &held);
    let h = render(&mut r3, 30_000, 129);
    assert!(h[29_000 * 2].abs() > 0.001, "a looped sample ended at the original PCM length");
}

#[test]
fn piano_release_noise() {
    use garak_dsp::instruments::builtin::release_noise_gain as gain;
    near(gain(1.0, 0.0, 5.0, 1.0, false), 1.0, 1e-12, "release noise ignored velocity 1");
    near(gain(0.5, 2.0, 5.0, 0.5, false), 0.25 * (-1.0f64).exp(), 1e-12, "velocity, amount and hold time");
    assert_eq!(gain(1.0, 0.5, 5.0, 0.0, false), 0.0, "amount 0 did not turn it off");
    assert_eq!(gain(1.0, 0.5, 5.0, 1.0, true), 0.0, "a cut-off note played a release noise");
    assert_eq!(gain(0.01, 0.5, 5.0, 1.0, false), 0.0, "a very soft note played a release noise");
    assert_eq!(gain(1.0, 5.0, 5.0, 1.0, false), 0.0, "a rang-out note played a release noise");
    let run = |n: Note, amount: f64, set_id: &str| {
        let (mut c, mut r) = eng(48_000, 4096);
        c.put_asset("tone", mono(48_000, vec![0.0; 20_000])).unwrap();
        c.put_asset("short", mono(48_000, vec![0.0; 2000])).unwrap();
        c.put_asset("release", mono(48_000, vec![0.01; 100])).unwrap();
        let releases = vec![zone("release", 60, 0, 127, 0.0, 1.0, None, -1)];
        c.put_sample_set(set(
            "piano",
            false,
            vec![zone("tone", 60, 0, 127, 0.0, 1.0, None, -1)],
            releases.clone(),
        ))
        .unwrap();
        c.put_sample_set(set("short", false, vec![zone("short", 60, 0, 127, 0.0, 1.0, None, -1)], releases))
            .unwrap();
        let mut p = project(48_000, 8000);
        let mut t = sampled_track(set_id, false);
        t.source.instrument_id = "grand".into();
        param(&mut t, "releaseNoise", amount);
        t.notes = vec![n];
        p.tracks.push(t);
        started(&mut c, &p);
        render(&mut r, 6000, 128)
    };
    let released = run(note(1, 0, 1000, 4000, 60, 0.8), 0.5, "piano");
    near(
        f64::from(released[1000 * 2]),
        10f64.powf(-6.0 / 20.0) * 0.01 * 0.5 * 0.8 * (-1000.0f64 / 48_000.0 / 2.0).exp() / 2f64.sqrt(),
        1e-8,
        "release noise missed the note-off or its level",
    );
    assert_eq!(
        energy(&run(note(1, 0, 4000, 4000, 60, 0.8), 0.5, "piano")),
        0.0,
        "a cut-off note played release noise"
    );
    assert_eq!(energy(&run(note(1, 0, 1000, 4000, 60, 0.8), 0.0, "piano")), 0.0, "amount 0 still played");
    assert_eq!(
        energy(&run(note(1, 0, 3000, 4000, 60, 0.8), 0.5, "short")),
        0.0,
        "a note held past its sample length played release noise"
    );
}

#[test]
fn live_midi_and_sample_release() {
    let live_set = |release: bool| {
        let mut s = set("live", false, vec![zone("tone", 60, 0, 127, 0.0, 1.0, None, -1)], vec![]);
        s.gain_db = 6.0;
        if release {
            s.release_zones = vec![zone("release", 60, 0, 127, 0.0, 1.0, None, -1)];
        }
        s
    };
    let mut p = project(48_000, 48_000);
    let mut t = sampled_track("live", false);
    t.id = "live".into();
    param(&mut t, "attack", 0.2);
    param(&mut t, "release", 0.1);
    p.tracks.push(t);
    let (mut c, mut r) = eng(48_000, 4096);
    c.put_asset("tone", mono(48_000, vec![0.02; 20_000])).unwrap();
    c.put_sample_set(live_set(false)).unwrap();
    assert_eq!(c.update(p.clone()).unwrap(), Applied::Full);
    c.note_on(0, 60, 0.8, 1).unwrap();
    let _ = render(&mut r, 200, 128);
    c.note_off(0, 60, 1).unwrap();
    let tail = render(&mut r, 10_000, 128);
    let level = 0.02 * (0.25 + 0.75 * 0.8) * (200.0 / 48_000.0 / 0.2) / 2f64.sqrt();
    near(f64::from(tail[0]), level, 1e-8, "a quick live note-off jumped from attack to full sustain");
    assert!(tail[9000 * 2..].iter().all(|v| *v == 0.0), "a live note-off did not retire its voice");

    let (mut c, mut r) = eng(48_000, 4096);
    c.put_asset("tone", mono(48_000, vec![0.0; 20_000])).unwrap();
    c.put_asset("release", mono(48_000, vec![0.01; 100])).unwrap();
    c.put_sample_set(live_set(true)).unwrap();
    assert_eq!(c.update(p).unwrap(), Applied::Full);
    c.note_on(0, 60, 0.8, 7).unwrap();
    let _ = render(&mut r, 200, 128);
    c.note_off(0, 60, 7).unwrap();
    let out = render(&mut r, 150, 128);
    near(
        f64::from(out[0]),
        0.01 * 0.5 * 0.8 * (-200.0f64 / 48_000.0 / 2.0).exp() / 2f64.sqrt(),
        1e-8,
        "a live sample release zone missed its exact note-off",
    );
    near(f64::from(out[99 * 2]), f64::from(out[0]), 1e-8, "the release zone was truncated");
    assert_eq!(out[100 * 2], 0.0, "the release zone extended past its PCM");
}

#[test]
fn live_sustain_pedal() {
    let mut live = project(48_000, 48_000);
    let mut t = synth_track("keys");
    t.id = "live".into();
    param(&mut t, "release", 0.1);
    live.tracks.push(t);
    let mk = || {
        let (mut c, r) = eng(48_000, 4096);
        assert_eq!(c.update(live.clone()).unwrap(), Applied::Full);
        (c, r)
    };
    let (mut pc, mut pr) = mk();
    let (mut hc, mut hr) = mk();
    let (mut rc, mut rr) = mk();
    for c in [&mut pc, &mut hc, &mut rc] {
        c.note_on(0, 60, 0.8, 1).unwrap();
    }
    let a = render(&mut pr, 300, 128);
    let b = render(&mut hr, 300, 128);
    let _ = render(&mut rr, 300, 128);
    same(&a, &b, 0.0, "live voices diverged before the pedal");
    pc.control_change(0, 64, 127).unwrap();
    pc.note_off(0, 60, 1).unwrap();
    let a = render(&mut pr, 4000, 128);
    let b = render(&mut hr, 4000, 128);
    let _ = render(&mut rr, 4000, 128);
    same(&a, &b, 0.0, "a note-off under the pedal was not deferred");
    assert!(energy(&a) > 1e-4, "the sustained live note went silent");
    pc.control_change(0, 64, 0).unwrap();
    rc.note_off(0, 60, 1).unwrap();
    let a = render(&mut pr, 8000, 128);
    let c = render(&mut rr, 8000, 128);
    same(&a, &c, 0.0, "pedal up did not release exactly like a note-off at that frame");
    assert!(
        a[7000 * 2..].iter().all(|v| *v == 0.0),
        "the released voice kept ringing after the pedal lifted"
    );
    // Re-striking a sustained key == releasing the first note at the second strike.
    let (mut sc, mut sr) = mk();
    let (mut fc, mut fr) = mk();
    sc.control_change(0, 64, 127).unwrap();
    sc.note_on(0, 64, 0.8, 5).unwrap();
    fc.note_on(0, 64, 0.8, 5).unwrap();
    let _ = (render(&mut sr, 500, 128), render(&mut fr, 500, 128));
    sc.note_off(0, 64, 5).unwrap();
    let _ = (render(&mut sr, 500, 128), render(&mut fr, 500, 128));
    sc.note_on(0, 64, 0.6, 6).unwrap();
    fc.note_off(0, 64, 5).unwrap();
    fc.note_on(0, 64, 0.6, 6).unwrap();
    same(
        &render(&mut sr, 6000, 128),
        &render(&mut fr, 6000, 128),
        0.0,
        "re-striking did not end the sustained note",
    );
    // A panic lifts the live pedal: the next note-off releases immediately.
    sc.all_notes_off(0).unwrap();
    fc.all_notes_off(0).unwrap();
    let _ = (render(&mut sr, 6000, 128), render(&mut fr, 6000, 128));
    sc.note_on(0, 67, 0.8, 9).unwrap();
    fc.note_on(0, 67, 0.8, 9).unwrap();
    let _ = (render(&mut sr, 300, 128), render(&mut fr, 300, 128));
    sc.note_off(0, 67, 9).unwrap();
    fc.note_off(0, 67, 9).unwrap();
    same(&render(&mut sr, 6000, 128), &render(&mut fr, 6000, 128), 0.0, "the pedal survived a panic");
    // Invalid controller numbers and values are refused on the control thread.
    assert!(pc.control_change(0, 64, 128).is_err(), "out-of-range controller value accepted");
    assert!(pc.control_change(0, 132, 0).is_err(), "out-of-range controller number accepted");
    assert!(pc.control_change(0, 129, 8192).is_err(), "out-of-range pitch bend accepted");
    assert!(pc.control_change(0, 131, 49).is_err(), "out-of-range bend range accepted");
}

/// Positive-going zero crossings of the left channel with sub-sample interpolation.
fn crossings(d: &[f32], first: usize, last: usize) -> Vec<f64> {
    let mut out = Vec::new();
    for i in first + 1..last {
        let (a, b) = (f64::from(d[(i - 1) * 2]), f64::from(d[i * 2]));
        if a < 0.0 && b >= 0.0 {
            out.push((i - 1) as f64 + a / (a - b));
        }
    }
    out
}

fn frequency_of(d: &[f32], first: usize, last: usize) -> f64 {
    let x = crossings(d, first, last);
    assert!(x.len() > 2, "no periodic signal to measure");
    (x.len() - 1) as f64 * 48_000.0 / (x[x.len() - 1] - x[0])
}

fn cycle_spread_cents(d: &[f32], first: usize, last: usize) -> f64 {
    let x = crossings(d, first, last);
    assert!(x.len() > 3, "no periodic signal to measure");
    let (mut shortest, mut longest) = (1e9f64, 0.0f64);
    for w in x.windows(2) {
        shortest = shortest.min(w[1] - w[0]);
        longest = longest.max(w[1] - w[0]);
    }
    1200.0 * (longest / shortest).log2()
}

fn rms_of(d: &[f32], first: usize, last: usize) -> f64 {
    (energy(&d[first * 2..last * 2]) / ((last - first) * 2) as f64).sqrt()
}

#[test]
fn midi_controllers() {
    let mut base = project(48_000, 96_000);
    let mut t = synth_track("keys");
    t.id = "keys".into();
    for (k, v) in [("bell", 0.0), ("sustain", 1.0), ("release", 0.05)] {
        param(&mut t, k, v);
    }
    t.notes = vec![note(1, 0, 96_000, 96_000, 69, 0.5)];
    base.tracks.push(t.clone());
    let play = |controls: Vec<ControlEvent>, frames: usize| {
        let mut p = base.clone();
        p.tracks[0].controls = controls;
        let (mut c, mut r) = eng(48_000, 256);
        started(&mut c, &p);
        render(&mut r, frames, 256)
    };
    let plain = play(vec![], 24_000);
    let f0 = frequency_of(&plain, 2400, 24_000);
    near(f0, 440.0, 0.5, "unbent built-in pitch");
    let ratio = |c: Vec<ControlEvent>| frequency_of(&play(c, 24_000), 2400, 24_000) / f0;
    near(ratio(vec![cc(0, 129, 8191)]), 2f64.powf(2.0 / 12.0), 0.001, "full bend up is not two semitones");
    near(
        ratio(vec![cc(0, 129, -8192)]),
        2f64.powf(-2.0 / 12.0),
        0.001,
        "full bend down is not two semitones",
    );
    near(ratio(vec![cc(0, 131, 12), cc(0, 129, 8191)]), 2.0, 0.002, "the bend range controller was ignored");
    near(ratio(vec![cc(0, 129, 4096)]), 2f64.powf(1.0 / 12.0), 0.001, "half bend is not one semitone");
    same(
        &play(vec![cc(0, 129, 0), cc(0, 7, 100), cc(0, 130, 5), cc(0, 74, 30)], 24_000),
        &plain,
        0.0,
        "neutral controllers changed the built-in sound",
    );
    let level = |c: Vec<ControlEvent>| rms_of(&play(c, 24_000), 2400, 24_000) / rms_of(&plain, 2400, 24_000);
    near(level(vec![cc(0, 11, 90)]), (90.0 / 127.0) * (90.0 / 127.0), 0.002, "CC11 expression level");
    near(level(vec![cc(0, 7, 50)]), 0.25, 0.002, "CC7 volume level");
    assert!(cycle_spread_cents(&plain, 2400, 24_000) < 2.0, "unmodulated pitch wobbles");
    let vibrato = cycle_spread_cents(&play(vec![cc(0, 1, 127)], 24_000), 2400, 24_000);
    assert!(vibrato > 80.0 && vibrato < 110.0, "mod wheel vibrato depth {vibrato}");
    let pressure = cycle_spread_cents(&play(vec![cc(0, 128, 64)], 24_000), 2400, 24_000);
    assert!(pressure > 35.0 && pressure < 60.0, "channel pressure vibrato depth {pressure}");
    // A bend glides: the first cycle after the event lies between the old and the new pitch.
    let glide = play(vec![cc(12_000, 129, 8191)], 24_000);
    let x = crossings(&glide, 12_000, 12_400);
    let first = 48_000.0 / (x[1] - x[0]);
    assert!(
        first > f0 * 1.01 && first < f0 * 2f64.powf(2.0 / 12.0) * 0.995,
        "pitch bend jumped instead of gliding"
    );
    near(
        frequency_of(&glide, 16_800, 24_000) / f0,
        2f64.powf(2.0 / 12.0),
        0.001,
        "pitch bend did not settle",
    );
    // Drum kits ignore bend and vibrato.
    let mut kit = project(48_000, 24_000);
    let mut d = synth_track("drums");
    d.id = "kit".into();
    d.notes = vec![note(1, 0, 2000, 24_000, 50, 0.8)];
    kit.tracks.push(d);
    let mut bent = kit.clone();
    bent.tracks[0].controls = vec![cc(0, 129, 8191), cc(0, 1, 127)];
    let (mut ca, mut ra) = eng(48_000, 4096);
    let (mut cb, mut rb) = eng(48_000, 4096);
    started(&mut ca, &kit);
    started(&mut cb, &bent);
    same(
        &render(&mut ra, 6000, 128),
        &render(&mut rb, 6000, 128),
        0.0,
        "a drum kit followed bend or vibrato",
    );
    // Seek chases the bend in effect; stop and replay from the start re-centres it.
    let mut p = base.clone();
    p.tracks[0].controls = vec![cc(1000, 129, 8191)];
    let (mut c, mut r) = eng(48_000, 256);
    started(&mut c, &p);
    let _ = render(&mut r, 2048, 256);
    c.seek(48_000).unwrap();
    let chased = render(&mut r, 4800, 256);
    near(
        frequency_of(&chased, 0, 4800) / f0,
        2f64.powf(2.0 / 12.0),
        0.001,
        "seek did not chase the pitch bend",
    );
    c.stop().unwrap();
    let _ = render(&mut r, 256, 256);
    c.play().unwrap();
    let again = render(&mut r, 960, 256);
    near(frequency_of(&again, 0, 960) / f0, 1.0, 0.003, "replay kept the chased bend before its event");
    // Live pitch bend bends a live note; a panic resets the mod wheel.
    let mut live = project(48_000, 48_000);
    let mut l = t.clone();
    l.notes.clear();
    live.tracks.push(l);
    let (mut c, mut r) = eng(48_000, 4096);
    assert_eq!(c.update(live).unwrap(), Applied::Full);
    c.note_on(0, 69, 0.5, 7).unwrap();
    c.control_change(0, 129, 8191).unwrap();
    near(
        frequency_of(&render(&mut r, 12_000, 128), 2400, 12_000) / f0,
        2f64.powf(2.0 / 12.0),
        0.001,
        "live bend",
    );
    c.control_change(0, 129, 0).unwrap();
    near(frequency_of(&render(&mut r, 12_000, 128), 2400, 12_000) / f0, 1.0, 0.001, "live bend centre");
    c.control_change(0, 1, 127).unwrap();
    c.all_notes_off(0).unwrap();
    let _ = render(&mut r, 6000, 128);
    c.note_on(0, 69, 0.5, 8).unwrap();
    assert!(
        cycle_spread_cents(&render(&mut r, 12_000, 128), 2400, 12_000) < 2.0,
        "panic did not reset the mod wheel"
    );
    // Timeline validation.
    let mut bad = base.clone();
    bad.tracks[0].controls = vec![cc(0, 129, 9000)];
    let (mut c, _) = eng(48_000, 4096);
    assert!(c.update(bad.clone()).is_err(), "out-of-range timeline pitch bend accepted");
    bad.tracks[0].controls = vec![cc(10, 1, 5), cc(5, 1, 6)];
    assert!(c.update(bad).is_err(), "unsorted timeline controls accepted");
}

#[test]
fn controllers_land_on_their_tempo_map_frames() {
    // A bend at beat 6 of a 90 -> 150 ramp: frame 155699 (garak tempo.hpp), not 6 beats of 90 BPM.
    let map = garak_engine::tempo::TempoMap::new(
        90.0,
        &[
            garak_engine::plan::TempoPoint { beat: 0.0, bpm: 90.0, ramp: true },
            garak_engine::plan::TempoPoint { beat: 8.0, bpm: 150.0, ramp: false },
        ],
    );
    near(map.frame_at(6.0, 48_000.0), 155_699.0, 1.0, "ramp frame for beat 6");
    let mut p = project(48_000, 240_000);
    p.bpm = 90.0;
    p.tempo_map = vec![
        garak_engine::plan::TempoPoint { beat: 0.0, bpm: 90.0, ramp: true },
        garak_engine::plan::TempoPoint { beat: 8.0, bpm: 150.0, ramp: false },
    ];
    let mut t = synth_track("keys");
    t.id = "keys".into();
    for (k, v) in [("bell", 0.0), ("sustain", 1.0), ("release", 0.05)] {
        param(&mut t, k, v);
    }
    t.notes = vec![note(1, 0, 240_000, 240_000, 69, 0.5)];
    t.controls = vec![cc(155_699, 129, 8191)];
    p.tracks.push(t);
    let (mut c, mut r) = eng(48_000, 256);
    started(&mut c, &p);
    let out = render(&mut r, 200_000, 256);
    let f0 = frequency_of(&out, 130_000, 155_000);
    near(f0, 440.0, 0.5, "pitch before the bend under a tempo map");
    near(frequency_of(&out, 160_500, 190_000) / f0, 2f64.powf(2.0 / 12.0), 0.001, "bend under a tempo ramp");
}

fn edit_project() -> Plan {
    let mut p = project(48_000, 96_000);
    let mut keys = synth_track("keys");
    keys.id = "keys".into();
    param(&mut keys, "level", 0.2);
    param(&mut keys, "release", 0.6);
    keys.notes = vec![
        note(1, 0, 60_000, 96_000, 60, 0.9),
        note(2, 30_000, 36_000, 96_000, 67, 0.7),
        note(3, 70_000, 80_000, 96_000, 64, 0.6),
    ];
    keys.inserts = vec![
        InsertPlan {
            id: "eq".into(),
            kind: "eq".into(),
            enabled: true,
            params: vec![("mid".into(), -3.0)],
            plugin_instance: String::new(),
        },
        InsertPlan {
            id: "verb".into(),
            kind: "reverb".into(),
            enabled: true,
            params: vec![("amount".into(), 0.6), ("size".into(), 0.4)],
            plugin_instance: String::new(),
        },
    ];
    let mut bass = synth_track("bass");
    bass.id = "bass".into();
    bass.gain = 0.5;
    bass.notes = vec![note(1, 5000, 20_000, 96_000, 36, 0.8), note(2, 50_000, 65_000, 96_000, 43, 0.8)];
    p.tracks = vec![keys, bass];
    p
}

#[test]
fn edits_preserve_voices_and_tails() {
    let mut p = project(48_000, 48_000);
    let mut t = synth_track("keys");
    param(&mut t, "level", 0.1);
    t.notes = vec![note(1, 0, 24_000, 48_000, 60, 1.0)];
    t.inserts = vec![InsertPlan {
        id: "delay".into(),
        kind: "delay".into(),
        enabled: true,
        params: vec![("amount".into(), 0.7), ("feedback".into(), 0.3), ("time".into(), 0.25)],
        plugin_instance: String::new(),
    }];
    p.tracks.push(t);
    let (mut ec, mut er) = eng(48_000, 256);
    let (mut fc, mut fr) = eng(48_000, 256);
    started(&mut ec, &p);
    started(&mut fc, &p);
    let _ = (render(&mut er, 7000, 128), render(&mut fr, 7000, 128));
    p.revision = 1;
    assert_eq!(ec.rebuild(p.clone()).unwrap(), Applied::Full);
    ec.play().unwrap();
    same(
        &render(&mut er, 10_000, 67),
        &render(&mut fr, 10_000, 67),
        2e-6,
        "a no-op graph update restarted voices",
    );
    param(&mut p.tracks[0], "bell", 0.5);
    param(&mut p.tracks[0], "release", 1.1);
    assert_eq!(ec.rebuild(p.clone()).unwrap(), Applied::Full);
    same(
        &render(&mut er, 1000, 67),
        &render(&mut fr, 1000, 67),
        2e-6,
        "a knob edit restarted an existing voice",
    );
}

#[test]
fn note_diffs_equal_a_rebuilt_graph() {
    let p = edit_project();
    let mut edited = p.clone();
    edited.revision = 7;
    edited.tracks[0].notes[2].on_frame = 72_000;
    edited.tracks[0].notes[2].pitch = 65;
    let (mut lc, mut lr) = eng(48_000, 256);
    let (mut rc, mut rr) = eng(48_000, 256);
    started(&mut lc, &p);
    started(&mut rc, &edited);
    let mut a = render(&mut lr, 10_000, 128);
    let mut b = render(&mut rr, 10_000, 128);
    assert_eq!(lc.update(edited.clone()).unwrap(), Applied::Tracks, "a note edit did not replace its track");
    a.extend(render(&mut lr, 80_000, 97));
    b.extend(render(&mut rr, 80_000, 97));
    same(&a, &b, 1e-6, "a note edit through update() differs from the edited graph");
    // Ids are renumbered against the running graph: equal notes are no edit.
    let mut renumbered = edited.clone();
    renumbered.revision = 8;
    for n in &mut renumbered.tracks[0].notes {
        n.id += 100;
    }
    assert_eq!(lc.update(renumbered).unwrap(), Applied::None, "renumbered but equal notes were an edit");
    // Tempo is a header change: a full graph whose tracks continue.
    let mut tempo = edited;
    tempo.revision = 9;
    tempo.bpm = 90.0;
    assert_eq!(lc.update(tempo.clone()).unwrap(), Applied::Full);
    let _ = render(&mut lr, 2000, 128);
    tempo.revision = 10;
    tempo.tracks[0].gain = 7.0;
    assert!(lc.update(tempo).is_err(), "an out-of-range diff value was accepted");
}

#[test]
fn updates_keep_voices_and_tails() {
    let p = edit_project();
    let (mut lc, mut lr) = eng(48_000, 256);
    let (mut rc, mut rr) = eng(48_000, 256);
    started(&mut lc, &p);
    started(&mut rc, &p);
    let mut a = render(&mut lr, 12_000, 128);
    let mut b = render(&mut rr, 12_000, 128);
    // Note 3 moves while note 1 sounds: note 1 is not retriggered and the reverb tail goes on.
    let mut edited = p.clone();
    edited.revision = 1;
    edited.tracks[0].notes[2].on_frame = 71_000;
    assert_eq!(lc.update(edited.clone()).unwrap(), Applied::Tracks);
    a.extend(render(&mut lr, 20_000, 101));
    b.extend(render(&mut rr, 20_000, 101));
    same(&a, &b, 1e-6, "a note edit restarted the held note or the reverb tail");
    // Delete note 2 while it sounds: only that note releases.
    let mut removed = edited.clone();
    removed.revision = 2;
    removed.tracks[0].notes.remove(1);
    let _ = (render(&mut lr, 1000, 128), render(&mut rr, 1000, 128));
    assert_eq!(lc.update(removed.clone()).unwrap(), Applied::Tracks);
    assert!(energy(&render(&mut lr, 4000, 128)) > 1e-3, "removing one note silenced the track");
    // A live parameter and another track's note edit keep everything ringing.
    let mut knob = removed;
    knob.revision = 3;
    knob.tracks[0].inserts[1].params[0].1 = 0.5;
    knob.tracks[1].notes[1].off_frame = 64_000;
    assert_eq!(lc.update(knob).unwrap(), Applied::Tracks);
    assert!(energy(&render(&mut lr, 4000, 128)) > 1e-3, "a parameter edit dropped the tail");
    // A note added later keeps the running reverb tail.
    let mut short = p.clone();
    short.tracks.truncate(1);
    short.tracks[0].notes = vec![note(1, 0, 4800, 96_000, 60, 0.9)];
    let (mut tc, mut tr) = eng(48_000, 256);
    let (mut uc, mut ur) = eng(48_000, 256);
    started(&mut tc, &short);
    started(&mut uc, &short);
    let mut x = render(&mut tr, 9000, 128);
    let mut y = render(&mut ur, 9000, 128);
    let mut later = short;
    later.revision = 1;
    later.tracks[0].notes.push(note(2, 80_000, 82_000, 96_000, 72, 0.5));
    assert_eq!(tc.update(later).unwrap(), Applied::Tracks);
    x.extend(render(&mut tr, 30_000, 89));
    y.extend(render(&mut ur, 30_000, 89));
    same(&x, &y, 1e-6, "a note edit cut the running reverb tail");
    assert!(energy(&x[x.len() - 20_000..]) > 1e-6, "the reverb tail had already ended");
}

#[test]
fn graph_changes_keep_other_tracks() {
    let p = edit_project();
    let (mut lc, mut lr) = eng(48_000, 256);
    let (mut rc, mut rr) = eng(48_000, 256);
    started(&mut lc, &p);
    started(&mut rc, &p);
    let mut a = render(&mut lr, 10_000, 128);
    let mut b = render(&mut rr, 10_000, 128);
    let mut grown = p.clone();
    grown.revision = 1;
    let mut extra = synth_track("pad");
    extra.id = "extra".into();
    extra.notes = vec![note(1, 90_000, 95_000, 96_000, 72, 0.5)];
    grown.tracks.insert(0, extra);
    assert_eq!(lc.update(grown.clone()).unwrap(), Applied::Full);
    a.extend(render(&mut lr, 40_000, 77));
    b.extend(render(&mut rr, 40_000, 77));
    same(&a, &b, 1e-6, "adding a silent track restarted the other tracks' voices or tails");
    let mut shrunk = grown;
    shrunk.revision = 2;
    shrunk.tracks.remove(2);
    assert_eq!(lc.update(shrunk).unwrap(), Applied::Full);
    assert!(energy(&render(&mut lr, 3000, 128)) > 1e-3, "removing another track cut the keys track");
}

#[test]
fn offline_matches_live_and_refusals() {
    let mut p = project(48_000, 4000);
    let mut t = synth_track("pluck");
    param(&mut t, "level", 0.15);
    t.notes = vec![note(1, 0, 3000, 4000, 64, 0.8)];
    t.inserts = vec![InsertPlan {
        id: "eq".into(),
        kind: "eq".into(),
        enabled: true,
        params: vec![("mid".into(), -4.0)],
        plugin_instance: String::new(),
    }];
    p.tracks.push(t);
    let (mut lc, mut lr) = eng(48_000, 512);
    let (mut oc, mut or) =
        engine(EngineConfig { sample_rate: 48_000, max_block: 512, offline: true }).unwrap();
    started(&mut lc, &p);
    started(&mut oc, &p);
    same(
        &render(&mut lr, 20_000, 127),
        &render(&mut or, 20_000, 311),
        2e-6,
        "realtime and offline rendering diverged",
    );
    let mut bad = p.clone();
    bad.tracks[0].source.instrument_id = "missing".into();
    assert!(lc.update(bad).is_err(), "an unknown instrument silently fell back");
    let mut bad = p.clone();
    param(&mut bad.tracks[0], "bell", 0.3);
    assert!(lc.update(bad).is_err(), "a parameter of another instrument was accepted");
    let mut bad = p.clone();
    param(&mut bad.tracks[0], "level", 9.0);
    assert!(lc.update(bad).is_err(), "an out-of-range instrument parameter was accepted");
    let mut bad = p.clone();
    bad.tracks[0].notes.push(note(1, 10, 20, 4000, 60, 0.5));
    // (A running graph renumbers ids first; a fresh one validates them.)
    assert!(eng(48_000, 512).0.update(bad).is_err(), "duplicate note ids were accepted");
    let mut bad = p;
    bad.tracks[0].notes[0].velocity = 3.0;
    assert!(lc.update(bad).is_err(), "an out-of-range velocity was accepted");
    assert!(
        lc.note_on(0, 128, 0.5, 1).is_err() && lc.note_on(0, 60, 2.5, 1).is_err(),
        "invalid live notes accepted"
    );
    assert!(lc.preview_note(0, 60, 0.5, 0).is_err(), "an empty preview was accepted");
}

#[test]
fn instrument_automation_shapes_new_notes() {
    // An automated instrument parameter changes later notes (voices copy it when they start).
    let mut p = project(48_000, 48_000);
    let mut t = synth_track("keys");
    param(&mut t, "level", 0.3);
    t.notes = vec![note(1, 0, 8000, 48_000, 60, 0.8), note(2, 24_000, 32_000, 48_000, 60, 0.8)];
    let mut plain = p.clone();
    plain.tracks.push(t.clone());
    t.automation = vec![AutomationLane {
        target: LaneTarget::Instrument,
        insert_id: String::new(),
        param: "level".into(),
        return_id: String::new(),
        minimum: 0.0,
        maximum: 2.0,
        logarithmic: false,
        options: vec![],
        points: vec![
            AutomationPoint { frame: 0.0, value: 0.15, curve: 0.0 },
            AutomationPoint { frame: 20_000.0, value: 0.6, curve: 0.0 },
        ],
    }];
    p.tracks.push(t);
    let (mut ac, mut ar) = eng(48_000, 256);
    let (mut bc, mut br) = eng(48_000, 256);
    started(&mut ac, &plain);
    started(&mut bc, &p);
    let a = render(&mut ar, 40_000, 256);
    let b = render(&mut br, 40_000, 256);
    near(
        rms_of(&b, 1000, 8000) / rms_of(&a, 1000, 8000),
        1.0,
        0.01,
        "automated level at 0.3 for the first note",
    );
    near(
        rms_of(&b, 25_000, 32_000) / rms_of(&a, 25_000, 32_000),
        4.0,
        0.02,
        "automated level at 1.2 for the second",
    );
    let _ = UNLIMITED_FRAME;
}

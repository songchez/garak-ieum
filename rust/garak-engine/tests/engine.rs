//! Engine behaviour: offline render of the parity project, diff paths against fresh graphs
//! (docs/RENDER_DIFF_PROTOCOL.md 8.5), transport, refusals. Also writes the parity project and
//! its native render to `target/engine-parity/` for the WASM test (src/audio/rust/engine.test.ts).
// Test code: helpers outside #[test] functions may unwrap and index (clippy.toml covers only the
// test functions themselves); the counting allocator needs std's System allocator.
#![allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::std_instead_of_core)]

use std::collections::BTreeMap;
use std::sync::Arc;

use garak_engine::protocol::timeline_from_bytes;
use garak_engine::testkit::{TestProject, project};
use garak_engine::{Applied, EngineConfig, PcmAsset, Plan, engine, render_offline};

fn assets(p: &TestProject) -> BTreeMap<String, Arc<PcmAsset>> {
    p.assets.iter().map(|(id, a)| (id.clone(), Arc::new(a.clone()))).collect()
}

fn max_diff(a: &[f32], b: &[f32]) -> f64 {
    assert_eq!(a.len(), b.len());
    a.iter().zip(b).map(|(x, y)| f64::from((x - y).abs())).fold(0.0, f64::max)
}

fn peak(a: &[f32]) -> f32 {
    a.iter().fold(0.0f32, |m, x| m.max(x.abs()))
}

/// Renders `frames` through a live (non-offline) engine; `edit` is applied at `edit_at` through
/// the diff paths (`update`) or as a new graph (`rebuild`).
fn live_render(
    plan: &Plan,
    a: &BTreeMap<String, Arc<PcmAsset>>,
    frames: usize,
    edit_at: usize,
    edit: Option<&Plan>,
    rebuild: bool,
) -> Vec<f32> {
    let (mut c, mut r) =
        engine(EngineConfig { sample_rate: plan.sample_rate, max_block: 128, offline: false }).unwrap();
    for (id, asset) in a {
        c.put_asset(id, PcmAsset::clone(asset)).unwrap();
    }
    assert_eq!(c.update(plan.clone()).unwrap(), Applied::Full);
    c.play().unwrap();
    let mut out = vec![0.0f32; frames * 2];
    let mut done = 0;
    while done < frames {
        if done == edit_at
            && let Some(e) = edit
        {
            if rebuild {
                assert_eq!(c.rebuild(e.clone()).unwrap(), Applied::Full);
            } else {
                c.update(e.clone()).unwrap();
            }
        }
        let n = 256.min(frames - done);
        r.render(&mut out[done * 2..(done + n) * 2]);
        done += n;
        c.collect();
    }
    out
}

#[test]
fn renders_the_parity_project_offline() {
    let p = project(8, 3.0, 48_000);
    let plan = timeline_from_bytes(p.json.as_bytes(), &[]).unwrap();
    let out = render_offline(&plan, &assets(&p), 4096).unwrap();
    assert_eq!(out.latency, 16); // drive oversamplers: 8 on the senders + 8 on a return
    assert!(out.tail_seconds > 1.0 && out.tail_seconds <= 30.0);
    assert_eq!(out.samples.len() as u64, out.frames * 2);
    assert!(out.samples.iter().all(|x| x.is_finite()));
    let level = peak(&out.samples);
    assert!(level > 0.05 && level <= 1.0, "{level}");
    // Deterministic, and block size only moves the 32-frame automation grid.
    let again = render_offline(&plan, &assets(&p), 4096).unwrap();
    assert_eq!(out.samples, again.samples);

    // Hand the project to the WASM test (same JSON, same PCM, this native render).
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/engine-parity");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("project.json"), &p.json).unwrap();
    let mut manifest = String::from("[");
    let mut blob: Vec<u8> = Vec::new();
    for (i, (id, a)) in p.assets.iter().enumerate() {
        manifest += &format!(
            "{}{{\"id\":\"{id}\",\"sampleRate\":{},\"channels\":{},\"offset\":{},\"count\":{}}}",
            if i == 0 { "" } else { "," },
            a.sample_rate,
            a.channels,
            blob.len(),
            a.samples.len()
        );
        blob.extend(a.samples.iter().flat_map(|x| x.to_le_bytes()));
    }
    manifest += "]";
    std::fs::write(dir.join("assets.json"), manifest).unwrap();
    std::fs::write(dir.join("assets.f32"), blob).unwrap();
    let rendered: Vec<u8> = out.samples.iter().flat_map(|x| x.to_le_bytes()).collect();
    std::fs::write(dir.join("native.f32"), rendered).unwrap();
}

#[test]
fn mix_send_and_master_diffs_match_a_fresh_graph() {
    let p = project(6, 1.0, 48_000);
    let a = assets(&p);
    let plan = timeline_from_bytes(p.json.as_bytes(), &[]).unwrap();
    let mut edited = plan.clone();
    edited.revision = 2;
    edited.tracks[0].gain = 0.3;
    edited.tracks[1].pan = -0.7;
    edited.tracks[2].sends[0].gain = 0.9;
    edited.master_gain = 0.6;
    let (mut c, _r) = engine(EngineConfig { sample_rate: 48_000, max_block: 128, offline: false }).unwrap();
    for (id, asset) in &a {
        c.put_asset(id, PcmAsset::clone(asset)).unwrap();
    }
    c.update(plan.clone()).unwrap();
    assert_eq!(c.update(edited.clone()).unwrap(), Applied::Diff);
    let mut same = edited.clone();
    same.revision = 3;
    assert_eq!(c.update(same).unwrap(), Applied::None);

    // Diffs applied mid-play sound exactly like the same edit as a new graph (which continues
    // every fader, send gain, effect tail and the master envelope).
    let frames = 36_000;
    let diffed = live_render(&plan, &a, frames, 12_032, Some(&edited), false);
    let rebuilt = live_render(&plan, &a, frames, 12_032, Some(&edited), true);
    let untouched = live_render(&plan, &a, frames, usize::MAX, None, false);
    assert!(max_diff(&diffed, &rebuilt) <= 1e-6, "{}", max_diff(&diffed, &rebuilt));
    assert!(max_diff(&diffed, &untouched) > 1e-3);
}

#[test]
fn track_replacement_keeps_effect_tails() {
    let p = project(4, 1.0, 48_000);
    let a = assets(&p);
    let plan = timeline_from_bytes(p.json.as_bytes(), &[]).unwrap();
    // Remove every window of the delay return's feeders mid-play: the delay tail keeps ringing.
    let mut edited = plan.clone();
    edited.revision = 2;
    edited.tracks[0].audio.truncate(1);
    let (mut c, _r) = engine(EngineConfig { sample_rate: 48_000, max_block: 128, offline: false }).unwrap();
    for (id, asset) in &a {
        c.put_asset(id, PcmAsset::clone(asset)).unwrap();
    }
    c.update(plan.clone()).unwrap();
    assert_eq!(c.update(edited.clone()).unwrap(), Applied::Tracks);
    // A live insert parameter is a Param diff; a structural one rebuilds the track.
    let mut param = edited.clone();
    for (k, v) in &mut param.tracks[0].inserts[1].params {
        if k == "ratio" {
            *v = 8.0;
        }
    }
    assert_eq!(c.update(param).unwrap(), Applied::Diff);
    let mut timing = edited.clone();
    timing.bpm = 100.0;
    timing.tempo_map[0].bpm = 100.0;
    assert_eq!(c.update(timing).unwrap(), Applied::Full);

    // Replacing a track mid-play == continuing: the replaced track's chain state carries over.
    let frames = 24_000;
    let replaced = live_render(&plan, &a, frames, 12_032, Some(&edited), false);
    let rebuilt = live_render(&plan, &a, frames, 12_032, Some(&edited), true);
    let reference = live_render(&plan, &a, frames, usize::MAX, None, false);
    assert!(max_diff(&replaced, &rebuilt) <= 1e-6, "{}", max_diff(&replaced, &rebuilt));
    // Before the edit both are identical; after it only track 0's removed windows differ.
    assert_eq!(&replaced[..12_032 * 2], &reference[..12_032 * 2]);
    assert!(replaced.iter().all(|x| x.is_finite()));
}

#[test]
fn transport_and_refusals() {
    let p = project(2, 0.5, 48_000);
    let a = assets(&p);
    let plan = timeline_from_bytes(p.json.as_bytes(), &[]).unwrap();
    // Schema 18/19 timelines: a meter map only drives the metronome (not ported) and is accepted; frozen
    // windows and offline render taps (docs/BOUNCE_FREEZE_STEMS.md) are refused until the engine ports them.
    let metered = p.json.replacen(
        r#""tracks":["#,
        r#""meterMap":[{"bar":0,"beat":0,"numerator":4,"denominator":4},{"bar":2,"beat":8,"numerator":3,"denominator":4}],"tracks":["#,
        1,
    );
    assert_eq!(timeline_from_bytes(metered.as_bytes(), &[]).unwrap().tracks.len(), plan.tracks.len());
    let frozen = p.json.replacen(r#""startFrame":"#, r#""freeze":true,"tailSeconds":1,"startFrame":"#, 1);
    assert!(timeline_from_bytes(frozen.as_bytes(), &[]).is_err());
    let tapped = p.json.replacen(r#""gain":"#, r#""preFader":true,"gain":"#, 1);
    assert!(timeline_from_bytes(tapped.as_bytes(), &[]).is_err());
    let (mut c, mut r) =
        engine(EngineConfig { sample_rate: 48_000, max_block: 512, offline: false }).unwrap();
    // Unknown PCM is refused and the engine stays empty.
    assert!(c.update(plan.clone()).is_err());
    for (id, asset) in &a {
        c.put_asset(id, PcmAsset::clone(asset)).unwrap();
    }
    let mut bad = plan.clone();
    bad.tracks[0].inserts[0].params.push(("nope".into(), 1.0));
    assert!(c.update(bad).is_err());
    let mut rig = plan.clone();
    rig.tracks[0].inserts[0].kind = "guitar-rig".into();
    assert!(c.update(rig).is_err());
    let mut wrong_rate = plan.clone();
    wrong_rate.sample_rate = 44_100;
    assert!(c.update(wrong_rate).is_err());
    c.update(plan.clone()).unwrap();
    c.play().unwrap();
    let mut buf = vec![0.0f32; 2 * 48_000];
    r.render(&mut buf);
    // Stops at the end (no cycle), position stays at the length.
    let s = c.snapshot();
    assert!(!s.playing && s.ready && s.frame == plan.length_frames && s.last_applied == c.ticket());
    c.seek(1000).unwrap();
    c.play().unwrap();
    r.render(&mut buf[..2000]);
    assert_eq!(c.snapshot().frame, 2000);
    c.stop().unwrap();
    r.render(&mut buf[..256]);
    assert_eq!(c.snapshot().frame, 0);
    assert!(buf[..256].iter().all(|x| x.abs() < 1.0));
    // A cycle loops.
    let mut cycled = plan.clone();
    cycled.cycle = Some((100, 4100));
    cycled.revision = 9;
    assert_eq!(c.update(cycled).unwrap(), Applied::Full);
    c.play().unwrap();
    r.render(&mut buf[..2 * 10_000]);
    let f = c.snapshot().frame;
    assert!((100..4100).contains(&f), "{f}");
}

#[test]
fn json_patch_merges_like_the_host() {
    let p = project(3, 0.5, 48_000);
    let (mut c, _r) = engine(EngineConfig::default()).unwrap();
    for (id, asset) in &p.assets {
        c.put_asset(id, asset.clone()).unwrap();
    }
    assert_eq!(c.set_json(p.json.as_bytes(), &[]).unwrap(), Applied::Full);
    let header = r#"{"version":1,"projectId":"rust-engine-parity","sampleRate":48000,"bpm":120,
        "tempoMap":[{"beat":0,"bpm":120,"curve":"ramp"},{"beat":8,"bpm":150,"curve":"step"},{"beat":12,"bpm":96}],
        "lengthFrames":24000,"masterGain":0.5}"#;
    let order = r#"["track-0","track-1","track-2","ret-verb","ret-delay"]"#;
    let fader = format!(
        r#"{{"revision":2,"header":{header},"order":{order},"tracks":[{{"id":"track-1","source":{{"kind":"audio"}},"gain":0.25,"pan":0,"inserts":[{{"id":"filter","type":"filter","params":{{"cutoff":2400,"resonance":2.5,"mode":0,"slope":1}}}},{{"id":"chorus","type":"chorus","params":{{"rate":1.3,"depth":0.6,"mix":0.4}}}}],"sends":[{{"returnId":"ret-verb","gain":0.25}},{{"returnId":"ret-delay","gain":0.35,"pre":false}}]}}]}}"#
    );
    assert_eq!(c.patch_json(fader.as_bytes(), &[]).unwrap(), Applied::Diff);
    let current = c.current().unwrap();
    assert_eq!(current.tracks[1].gain, 0.25);
    assert_eq!(current.master_gain, 0.5);
    assert!(!current.tracks[1].audio.is_empty()); // heavy fields kept
    let unknown = format!(r#"{{"revision":3,"header":{header},"order":["x"],"tracks":[]}}"#);
    assert!(c.patch_json(unknown.as_bytes(), &[]).is_err());
}

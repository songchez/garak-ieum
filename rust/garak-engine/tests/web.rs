//! What the web worklet host needs from the engine's own transport (docs/RUST_ENGINE.md 5.7): master
//! bypass for pre-master stems, a count-in as a scheduled start with metronome clicks (meter-map
//! accents), track peaks, live input monitoring, track-input routes and their recording taps, and the
//! live note/controller event path.
#![allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::float_cmp)]

use garak_engine::LiveEvent;
use garak_engine::metronome::{Clicks, MeterEvent};
use garak_engine::plan::{AudioWindow, RouteKind, RoutePlan, RouteTap, TrackPlan};
use garak_engine::protocol::timeline_from_bytes;
use garak_engine::testkit::project;
use garak_engine::{Applied, EngineConfig, PcmAsset, Plan, engine};

const RATE: u32 = 48_000;
const BLOCK: u32 = 128;

fn tone(frames: usize, channels: u32) -> PcmAsset {
    let mut samples = Vec::with_capacity(frames * channels as usize);
    for i in 0..frames {
        let x = ((i % 97) as f32 / 97.0 - 0.5) * 0.4;
        for c in 0..channels {
            samples.push(if c == 0 { x } else { -x * 0.5 });
        }
    }
    PcmAsset { sample_rate: RATE, channels, samples }
}

fn window(asset: &str, start: i64, end: i64) -> AudioWindow {
    AudioWindow {
        id: 1,
        asset_id: asset.into(),
        start_frame: start,
        end_frame: end,
        source_start_frame: 0.0,
        source_sample_rate: f64::from(RATE),
        clip_offset_frames: 0,
        clip_length_frames: end - start,
        gain: 1.0,
        fade_in_frames: 0,
        fade_out_frames: 0,
        fade_in_curve: 0,
        fade_out_curve: 0,
    }
}

fn plan(tracks: Vec<TrackPlan>, length: i64) -> Plan {
    Plan {
        project_id: "web".into(),
        revision: 1,
        sample_rate: RATE,
        length_frames: length,
        tracks,
        ..Plan::default()
    }
}

fn track(id: &str, audio: Vec<AudioWindow>) -> TrackPlan {
    TrackPlan { id: id.into(), audio, ..TrackPlan::default() }
}

fn energy(x: &[f32]) -> f64 {
    x.iter().map(|v| f64::from(*v) * f64::from(*v)).sum()
}

#[test]
fn master_bypass_renders_the_track_sum_before_the_master() {
    // The parity project has master gain 0.8 and a master processor; bypassed, the offline render is the
    // host path's track sum (Renderer::render_block renders exactly the tracks, no master).
    let p = project(4, 1.0, RATE);
    let parsed = timeline_from_bytes(p.json.as_bytes(), &[]).unwrap();
    let render = |bypass: bool| {
        let (mut c, mut r) =
            engine(EngineConfig { sample_rate: RATE, max_block: BLOCK, offline: true }).unwrap();
        for (id, a) in &p.assets {
            c.put_asset(id, a.clone()).unwrap();
        }
        c.update(parsed.clone()).unwrap();
        c.set_master_bypass(bypass).unwrap();
        c.play().unwrap();
        let mut out = vec![0.0f32; 48_000 * 2];
        for block in out.chunks_mut(BLOCK as usize * 2) {
            r.render(block);
        }
        out
    };
    let (bypassed, mastered) = (render(true), render(false));
    let (mut c, mut r) = engine(EngineConfig { sample_rate: RATE, max_block: BLOCK, offline: true }).unwrap();
    for (id, a) in &p.assets {
        c.put_asset(id, a.clone()).unwrap();
    }
    c.update(parsed).unwrap();
    let mut sum = vec![0.0f32; 48_000 * 2];
    let mut peaks = [0.0f32; 8];
    for (k, block) in sum.chunks_mut(BLOCK as usize * 2).enumerate() {
        r.render_block(block, k as i64 * i64::from(BLOCK), true, c.ticket(), &mut peaks, None);
    }
    assert!(energy(&bypassed) > 0.0);
    assert_eq!(bypassed, sum, "bypassed render = track sum");
    assert_ne!(bypassed, mastered);
    // Realtime engines ignore the bypass (C++: offline only).
    let (mut c, mut r) =
        engine(EngineConfig { sample_rate: RATE, max_block: BLOCK, offline: false }).unwrap();
    for (id, a) in &p.assets {
        c.put_asset(id, a.clone()).unwrap();
    }
    c.update(timeline_from_bytes(p.json.as_bytes(), &[]).unwrap()).unwrap();
    c.set_master_bypass(true).unwrap();
    c.play().unwrap();
    let mut live = vec![0.0f32; 48_000 * 2];
    for block in live.chunks_mut(BLOCK as usize * 2) {
        r.render(block);
    }
    assert_eq!(live, mastered);
}

fn clicks() -> Clicks {
    // Distinct strokes per level: a downbeat is a 4-sample pulse of 0.9, a group start 0.6, a pulse 0.3.
    Clicks { sample_rate: RATE, levels: [vec![0.9; 4], vec![0.6; 4], vec![0.3; 4]] }
}

/// Frames where a click stroke of `level` starts (the stroke is the only signal: an empty project).
fn onsets(out: &[f32]) -> Vec<(usize, f32)> {
    let mut found = Vec::new();
    let mut previous = 0.0;
    for (i, pair) in out.chunks(2).enumerate() {
        if pair[0] != 0.0 && previous == 0.0 {
            found.push((i, pair[0]));
        }
        previous = pair[0];
    }
    found
}

#[test]
fn count_in_is_a_scheduled_start_with_clicks_in_the_starting_meter() {
    // 6/8 at 120 BPM: an eighth-note pulse every 12000 frames, compound grouping (accent every three).
    let mut p = plan(vec![track("a", vec![window("tone", 0, 96_000)])], 96_000 * 2);
    p.time_sig_numerator = 6;
    p.time_sig_denominator = 8;
    let (mut c, mut r) =
        engine(EngineConfig { sample_rate: RATE, max_block: BLOCK, offline: false }).unwrap();
    c.put_asset("tone", tone(96_000, 1)).unwrap();
    c.update(p).unwrap();
    c.set_metronome(Some(clicks()), false, 1.0).unwrap();
    // One 6/8 bar = 3 quarter beats = 72000 frames.
    let bar = 72_000i64;
    c.play_count_in(bar).unwrap();
    let mut out = vec![0.0f32; (bar as usize + 4800) * 2];
    let mut snapshots = Vec::new();
    for block in out.chunks_mut(BLOCK as usize * 2) {
        r.render(block);
        snapshots.push(c.snapshot());
    }
    // During the count-in: transport frame held at 0, counting_in published, no track audio.
    assert!(snapshots[10].counting_in && snapshots[10].frame == 0);
    let count_in = &out[..bar as usize * 2];
    let strokes = onsets(count_in);
    let expected: Vec<(usize, f32)> = (0..6)
        .map(|k| {
            (
                k * 12_000,
                if k == 0 {
                    0.9
                } else if k == 3 {
                    0.6
                } else {
                    0.3
                },
            )
        })
        .collect();
    assert_eq!(strokes, expected, "6/8 count-in: downbeat, pulses, group start");
    // After it: the transport runs from frame 0 exactly at the end of the count-in, and the track plays.
    let last = snapshots.last().unwrap();
    assert!(!last.counting_in && last.playing);
    assert_eq!(last.frame, out.len() as i64 / 2 - bar);
    assert!(energy(&out[bar as usize * 2..]) > 0.0);
    // The metronome is off: no transport clicks, so the audio after the count-in is the track alone.
    assert!(count_in.chunks(2).all(|f| f[0] == 0.0 || f[0] == 0.9 || f[0] == 0.6 || f[0] == 0.3));
    // Pause cancels a running count-in.
    c.stop().unwrap();
    c.play_count_in(bar).unwrap();
    let mut block = vec![0.0f32; BLOCK as usize * 2];
    r.render(&mut block);
    c.pause().unwrap();
    r.render(&mut block);
    assert!(!c.snapshot().counting_in && !c.snapshot().playing);
}

#[test]
fn transport_clicks_follow_the_meter_map() {
    // 4/4 for one bar, then 3/4: downbeats at 0, 96000 (bar 1 starts at beat 4), then every 72000.
    let mut p = plan(Vec::new(), 96_000 * 4);
    p.meter_map = vec![
        MeterEvent { bar: 0, numerator: 4, denominator: 4, beat: 0.0 },
        MeterEvent { bar: 1, numerator: 3, denominator: 4, beat: 4.0 },
    ];
    let json = br#"{"version":1,"projectId":"m","revision":1,"sampleRate":48000,"bpm":120,"lengthFrames":384000,
        "timeSignature":{"numerator":4,"denominator":4},
        "meterMap":[{"bar":0,"beat":0,"numerator":4,"denominator":4},{"bar":1,"beat":4,"numerator":3,"denominator":4}],"tracks":[]}"#;
    let parsed = timeline_from_bytes(json, &[]).unwrap();
    assert_eq!(parsed.meter_map.len(), 2);
    assert_eq!(parsed.meter_map[1].beat, p.meter_map[1].beat);
    p.project_id = "m".into();
    let bad = br#"{"version":1,"projectId":"m","revision":1,"sampleRate":48000,"bpm":120,"lengthFrames":384000,
        "meterMap":[{"bar":0,"beat":0,"numerator":4,"denominator":4},{"bar":1,"beat":3,"numerator":3,"denominator":4}],"tracks":[]}"#;
    assert!(timeline_from_bytes(bad, &[]).is_err(), "beats that disagree with the bars are refused");
    let (mut c, mut r) =
        engine(EngineConfig { sample_rate: RATE, max_block: BLOCK, offline: false }).unwrap();
    c.update(parsed).unwrap();
    c.set_metronome(Some(clicks()), true, 1.0).unwrap();
    c.play().unwrap();
    let mut out = vec![0.0f32; 240_000 * 2];
    for block in out.chunks_mut(BLOCK as usize * 2) {
        r.render(block);
    }
    let downbeats: Vec<usize> = onsets(&out).into_iter().filter(|(_, v)| *v == 0.9).map(|(i, _)| i).collect();
    assert_eq!(downbeats, vec![0, 96_000, 168_000]);
    // Offline engines never click.
    let (mut c, mut r) = engine(EngineConfig { sample_rate: RATE, max_block: BLOCK, offline: true }).unwrap();
    c.update(timeline_from_bytes(json, &[]).unwrap()).unwrap();
    c.set_metronome(Some(clicks()), true, 1.0).unwrap();
    c.play().unwrap();
    let mut silent = vec![0.0f32; 4096];
    r.render(&mut silent);
    assert_eq!(energy(&silent), 0.0);
    assert!(
        c.set_metronome(Some(Clicks { sample_rate: 44_100, levels: Default::default() }), true, 1.0).is_err()
    );
}

#[test]
fn monitored_tracks_hear_their_input_and_routes_their_source() {
    // a: plays a tone; b: routed from a (post-FX); m: a monitored audio track on input channel 1.
    let mut b = track("b", Vec::new());
    b.route = Some(RoutePlan { kind: RouteKind::Track, track_id: "a".into(), tap: RouteTap::PostFx });
    let mut m = track("m", Vec::new());
    m.input = Some([1, -1]);
    m.pan = 0.0;
    let mut master = track("res", Vec::new());
    master.route =
        Some(RoutePlan { kind: RouteKind::Master, track_id: String::new(), tap: RouteTap::PostFx });
    let p = plan(vec![track("a", vec![window("tone", 0, 48_000)]), b, m, master], 48_000);
    let (mut c, mut r) =
        engine(EngineConfig { sample_rate: RATE, max_block: BLOCK, offline: false }).unwrap();
    c.put_asset("tone", tone(48_000, 2)).unwrap();
    assert_eq!(c.update(p).unwrap(), Applied::Full);
    c.set_taps(&[1, 3]).unwrap();
    c.play().unwrap();
    // Three input channels: channel 1 carries a constant 0.25.
    let input: Vec<f32> = (0..BLOCK as usize).flat_map(|_| [0.0, 0.25, 0.0]).collect();
    let mut out = vec![0.0f32; BLOCK as usize * 2];
    let mut peaks = [0.0f32; 4];
    for _ in 0..4 {
        r.render_io(&mut out, &input, 3);
    }
    r.track_peaks(&mut peaks);
    assert!(peaks[0] > 0.0, "the source plays");
    assert_eq!(peaks[1], 0.0, "an unmonitored routed track is silent");
    assert_eq!(peaks[2], 0.0, "an unmonitored track does not hear the input");
    // The route taps carry the routed inputs whether monitored or not: b = a's post-FX signal.
    let taps = r.tap_output();
    let slot = BLOCK as usize * 2;
    assert!(energy(&taps[..slot]) > 0.0);
    assert!(energy(&taps[slot..2 * slot]) > 0.0, "the master-resampling track records the master feed");
    assert!(taps[2 * slot..].iter().all(|v| *v == 0.0));
    c.set_monitoring(&[1, 2]).unwrap();
    for _ in 0..4 {
        r.render_io(&mut out, &input, 3);
    }
    r.track_peaks(&mut peaks);
    assert!(peaks[1] > 0.0, "a monitored routed track hears its source");
    // A mono input on a centred track: the mono pan law (cos 45 degrees) on the input.
    let expected = (0.25f64 * core::f64::consts::FRAC_PI_4.cos()) as f32;
    assert!((peaks[2] - expected).abs() < 1e-6, "monitored input level {} vs {expected}", peaks[2]);
    // A missing input channel is silence, never another channel.
    let narrow: Vec<f32> = vec![0.5; BLOCK as usize];
    for _ in 0..4 {
        r.render_io(&mut out, &narrow, 1);
    }
    r.track_peaks(&mut peaks);
    assert_eq!(peaks[2], 0.0);
}

#[test]
fn live_events_reach_the_track() {
    let p = plan(vec![track("a", vec![window("tone", 0, 48_000)])], 48_000);
    let (mut c, mut r) =
        engine(EngineConfig { sample_rate: RATE, max_block: BLOCK, offline: false }).unwrap();
    c.put_asset("tone", tone(48_000, 1)).unwrap();
    c.update(p).unwrap();
    c.live(0, LiveEvent::NoteOn { pitch: 60, velocity: 0.8, id: 1 }).unwrap();
    c.live(0, LiveEvent::NoteOff { pitch: 60, id: 1 }).unwrap();
    c.live(7, LiveEvent::AllNotesOff).unwrap();
    c.live(0, LiveEvent::Control { controller: 64, value: 127 }).unwrap();
    let mut out = vec![0.0f32; BLOCK as usize * 2];
    r.render(&mut out);
    // An audio track has no instrument and an unknown index has no track: counted, not played.
    let s = c.snapshot();
    assert_eq!((s.live_played, s.live_ignored), (0, 4));
}

#[test]
fn staged_updates_render_like_update_and_imported_kernels_are_used() {
    // The parity project has reverbs on its returns. One engine applies it with `set_json`; the other in
    // stages (parse, one track per step, commit) with the reverb kernels imported from a helper instance.
    let p = project(6, 1.0, RATE);
    let config = EngineConfig { sample_rate: RATE, max_block: BLOCK, offline: false };
    let run = |staged: bool| {
        let (mut c, mut r) = engine(config).unwrap();
        for (id, a) in &p.assets {
            c.put_asset(id, a.clone()).unwrap();
        }
        let plan = timeline_from_bytes(p.json.as_bytes(), &[]).unwrap();
        if staged {
            let (mut helper, _) = engine(config).unwrap();
            let mut imported = 0;
            for t in &plan.tracks {
                for e in t.inserts.iter().filter(|e| e.kind == "reverb") {
                    let (kind, size) = (e.param("type").unwrap_or(0.0), e.param("size").unwrap_or(0.5));
                    let (data, _) = helper.reverb_kernel(kind, size).unwrap();
                    c.import_reverb_kernel(kind, size, data.to_vec()).unwrap();
                    imported += 1;
                }
            }
            assert!(imported > 0);
            assert!(
                c.import_reverb_kernel(0.0, 0.5, vec![0.0; 3]).is_err(),
                "a kernel of the wrong shape is refused"
            );
            let todo = c.stage_json(false, p.json.as_bytes(), &[]).unwrap();
            assert_eq!(todo, plan.tracks.len());
            let mut steps = 1;
            while !c.step().unwrap() {
                steps += 1;
            }
            assert_eq!(steps, todo);
            assert_eq!(c.ticket(), 0, "nothing is queued before the commit");
            assert_eq!(c.commit().unwrap(), Applied::Full);
        } else {
            assert_eq!(c.set_json(p.json.as_bytes(), &[]).unwrap(), Applied::Full);
        }
        c.play().unwrap();
        let mut out = vec![0.0f32; 24_000 * 2];
        for block in out.chunks_mut(BLOCK as usize * 2) {
            r.render(block);
        }
        out
    };
    let (direct, staged) = (run(false), run(true));
    assert!(energy(&direct) > 0.0);
    assert_eq!(direct, staged);
    // A staged edit of one track builds that track only.
    let (mut c, _) = engine(config).unwrap();
    for (id, a) in &p.assets {
        c.put_asset(id, a.clone()).unwrap();
    }
    c.set_json(p.json.as_bytes(), &[]).unwrap();
    let edited =
        p.json.replacen("\"revision\":1", "\"revision\":2", 1).replacen("\"gain\":0.5", "\"gain\":0.25", 1);
    assert!(c.stage_json(false, edited.as_bytes(), &[]).unwrap() <= 1);
    while !c.step().unwrap() {}
    assert!(matches!(c.commit().unwrap(), Applied::Diff | Applied::Tracks | Applied::None));
    // A refused stage (an unregistered asset) drops the stage and changes nothing.
    let (mut c, _) = engine(config).unwrap();
    assert!(c.stage_json(false, p.json.as_bytes(), &[]).is_ok());
    assert!(c.step().is_err());
    assert!(c.commit().is_err(), "the refused stage is gone");
}

//! Deterministic test projects for the parity harnesses (docs/RUST_ENGINE.md 7): the same
//! `timeline` JSON and PCM feed the C++ engine (native/tests/rust_engine_parity_test.cpp, through
//! garak-ffi), the native Rust engine and the WASM build (src/audio/rust/engine.test.ts).
//!
//! Audio tracks only: overlapping windows with fades of every shape (crossfades), clip gain and
//! offsets, mono / stereo / 44.1 kHz PCM, every built-in effect but the guitar rig across the
//! chains (drive adds plug-in latency, also on a return), pre- and post-fader sends into two returns, volume / pan /
//! mute / send / insert-parameter automation and a tempo ramp for the synced effects. PCM is made
//! with + - * / only, so every platform generates identical samples.

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use core::fmt::Write;

use crate::plan::PcmAsset;

#[derive(Clone, Debug)]
pub struct TestProject {
    pub json: String,
    pub assets: Vec<(String, PcmAsset)>,
}

fn lcg(seed: &mut u32) -> f32 {
    *seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
    (f64::from(*seed) / 4_294_967_296.0 * 2.0 - 1.0) as f32
}

/// A few seconds of a band-limited-ish tone + filtered noise with an amplitude envelope.
fn pcm(index: usize, sample_rate: u32, channels: u32, seconds: f64) -> PcmAsset {
    let frames = (seconds * f64::from(sample_rate)) as usize;
    let mut seed = 0x9E37_79B9u32 ^ (index as u32).wrapping_mul(2_654_435_761);
    let period = 40.0 + (index % 7) as f64 * 13.0; // samples per cycle
    let mut samples = Vec::with_capacity(frames * channels as usize);
    let (mut low_l, mut low_r) = (0.0f32, 0.0f32);
    for i in 0..frames {
        let phase = (i as f64 / period) % 1.0;
        let tri = (if phase < 0.5 { 4.0 * phase - 1.0 } else { 3.0 - 4.0 * phase }) as f32;
        let beat = ((i / (sample_rate as usize / 4)) % 4) as f32;
        let env = 1.0 - ((i % (sample_rate as usize / 4)) as f32 / (sample_rate as f32 / 4.0)) * 0.7;
        low_l += 0.05 * (lcg(&mut seed) - low_l);
        low_r += 0.05 * (lcg(&mut seed) - low_r);
        let l = (0.45 * tri + 0.6 * low_l) * env * (0.6 + 0.1 * beat);
        samples.push(l);
        if channels == 2 {
            samples.push((0.4 * tri - 0.5 * low_r) * env * (0.7 - 0.05 * beat));
        }
    }
    PcmAsset { sample_rate, channels, samples }
}

/// Inserts of track `t`'s chain (rotates through every built-in type but the guitar rig).
fn inserts(t: usize) -> &'static str {
    match t % 6 {
        0 => {
            r#"[{"id":"eq","type":"eq","params":{"low":3,"mid":-4,"midFreq":900,"high":2,"b8On":1,"b8Freq":12000,"b8Gain":-3}},
               {"id":"comp","type":"compressor","params":{"threshold":-24,"ratio":5,"attack":4,"release":120,"makeup":3}}]"#
        }
        1 => {
            r#"[{"id":"filter","type":"filter","params":{"cutoff":2400,"resonance":2.5,"mode":0,"slope":1}},
               {"id":"chorus","type":"chorus","params":{"rate":1.3,"depth":0.6,"mix":0.4}}]"#
        }
        2 => {
            r#"[{"id":"drive","type":"drive","params":{"drive":14,"tone":7000,"mix":0.8,"output":-4}},
               {"id":"tape","type":"tape","params":{"drive":8,"warmth":0.6}}]"#
        }
        3 => {
            r#"[{"id":"util","type":"utility","params":{"gain":-2,"pan":0.3,"width":1.4}},
               {"id":"delay","type":"delay","params":{"amount":0.35,"time":0.5,"feedback":0.4,"mode":1,"age":0.3}},
               {"id":"lim","type":"limiter","params":{"gain":4,"ceiling":-3}}]"#
        }
        4 => {
            r#"[{"id":"phaser","type":"phaser","params":{"rate":0.7,"depth":0.8,"feedback":0.5}},
               {"id":"gate","type":"gate","params":{"threshold":-40,"hold":20}},
               {"id":"trem","type":"tremolo","params":{"rate":5,"depth":0.4,"sync":2,"pan":1}}]"#
        }
        _ => {
            r#"[{"id":"flanger","type":"flanger","params":{"rate":0.4,"depth":0.5,"feedback":0.5,"mix":0.6}},
               {"id":"crush","type":"bitcrusher","params":{"bits":10,"downsample":2,"mix":0.3}},
               {"id":"off","type":"compressor","enabled":false,"params":{}}]"#
        }
    }
}

/// `tracks` audio tracks (plus two returns) of `seconds` at `sample_rate`.
pub fn project(tracks: usize, seconds: f64, sample_rate: u32) -> TestProject {
    let sr = f64::from(sample_rate);
    let length = (seconds * sr) as i64;
    let mut assets = Vec::new();
    let mut json = String::new();
    let _ = write!(
        json,
        r#"{{"version":1,"projectId":"rust-engine-parity","revision":1,"sampleRate":{sample_rate},"bpm":120,
"tempoMap":[{{"beat":0,"bpm":120,"curve":"ramp"}},{{"beat":8,"bpm":150,"curve":"step"}},{{"beat":12,"bpm":96}}],
"timeSignature":{{"numerator":4,"denominator":4}},"lengthFrames":{length},"masterGain":0.8,"tracks":["#
    );
    for t in 0..tracks {
        let stereo = t % 2 == 0;
        let rate = if t % 4 == 3 { 44_100 } else { sample_rate };
        let id = format!("pcm-{t}");
        let asset = pcm(t, rate, if stereo { 2 } else { 1 }, seconds * 0.7);
        let asset_frames = asset.frames() as f64;
        assets.push((id.clone(), asset));
        // Two overlapping windows (a crossfade) and a short third one near the end.
        let a_start = (t as i64 * 2399) % (length / 8).max(1);
        let mid = length / 2 + (t as i64 * 997) % (length / 10).max(1);
        let xfade = (sr * (0.05 + 0.01 * (t % 5) as f64)) as i64;
        let a_end = (mid + xfade).min(length);
        let b_end = (length - length / 6).max(mid + 1);
        let c_start = (length - length / 7).max(b_end - xfade / 2);
        let c_end = (c_start + (sr * 0.4) as i64).min(length);
        let ratio = f64::from(rate) / sr;
        let src = |frames: i64| (frames as f64 * ratio).min(asset_frames - 1.0);
        let fade_in = (t % 5) as i32;
        let gain = 0.5 + 0.1 * (t % 6) as f64;
        let pan = ((t % 9) as f64 - 4.0) / 5.0;
        let al = a_end - a_start;
        let bl = b_end - mid + xfade / 3;
        let mut windows = String::new();
        let _ = write!(
            windows,
            r#"{{"id":0,"assetId":"{id}","startFrame":{a_start},"endFrame":{a_end},"sourceStartFrame":0,"sourceSampleRate":{rate},
"clipOffsetFrames":0,"clipLengthFrames":{al},"gain":{g1},"fadeInFrames":{fi},"fadeOutFrames":{xa},"fadeInCurve":{fade_in},"fadeOutCurve":1}},
{{"id":1,"assetId":"{id}","startFrame":{mid},"endFrame":{b_end},"sourceStartFrame":{s2},"sourceSampleRate":{rate},
"clipOffsetFrames":{co},"clipLengthFrames":{bl},"gain":{g2},"fadeInFrames":{xb},"fadeOutFrames":{fo},"fadeInCurve":1,"fadeOutCurve":{foc}}}"#,
            g1 = 0.9,
            fi = ((sr * 0.2) as i64).min(al),
            xa = xfade.min(al),
            xb = xfade.min(bl),
            s2 = src(mid - a_start) * 0.5,
            co = xfade / 3,
            g2 = 1.1 + 0.05 * (t % 3) as f64,
            fo = ((sr * 0.3) as i64).min(bl),
            foc = (t + 2) % 5,
        );
        if c_end > c_start {
            let _ = write!(
                windows,
                r#",{{"id":2,"assetId":"{id}","startFrame":{c_start},"endFrame":{c_end},"sourceStartFrame":{s3},"sourceSampleRate":{rate},
"clipLengthFrames":{cl},"gain":1.3,"fadeOutFrames":{cfo},"fadeOutCurve":3}}"#,
                s3 = src(1234 + t as i64 * 77),
                cl = c_end - c_start,
                cfo = (c_end - c_start) / 2,
            );
        }
        let mut automation = Vec::new();
        let at = |f: f64| garak_dsp::math::floor(f * length as f64);
        if t % 3 == 0 {
            automation.push(format!(
                r#"{{"target":{{"kind":"volume"}},"minimum":0,"maximum":2,"points":[{{"frame":{},"value":0.5}},{{"frame":{},"value":0.2,"curve":0.6}},{{"frame":{},"value":0.45}},{{"frame":{},"value":0.45}},{{"frame":{},"value":0.3,"curve":-0.4}}]}}"#,
                at(0.1),
                at(0.3),
                at(0.55),
                at(0.55),
                at(0.8)
            ));
        }
        if t % 3 == 1 {
            automation.push(format!(
                r#"{{"target":{{"kind":"pan"}},"minimum":-1,"maximum":1,"points":[{{"frame":0,"value":0.1}},{{"frame":{},"value":0.9,"curve":0.3}},{{"frame":{},"value":0.5}}]}}"#,
                at(0.4),
                at(0.7)
            ));
        }
        if t % 5 == 2 {
            automation.push(format!(
                r#"{{"target":{{"kind":"mute"}},"minimum":0,"maximum":1,"points":[{{"frame":{},"value":0}},{{"frame":{},"value":1}},{{"frame":{},"value":1}},{{"frame":{},"value":0}}]}}"#,
                at(0.2),
                at(0.2),
                at(0.35),
                at(0.35)
            ));
        }
        if t % 6 == 1 {
            automation.push(format!(
                r#"{{"target":{{"kind":"insert","insertId":"filter","param":"cutoff"}},"minimum":20,"maximum":20000,"logarithmic":true,"points":[{{"frame":0,"value":0.4}},{{"frame":{},"value":0.85,"curve":0.5}},{{"frame":{},"value":0.3}}]}}"#,
                at(0.5),
                at(0.9)
            ));
        }
        if t % 6 == 0 {
            automation.push(format!(
                r#"{{"target":{{"kind":"insert","insertId":"comp","param":"threshold"}},"minimum":-60,"maximum":0,"points":[{{"frame":{},"value":0.7}},{{"frame":{},"value":0.4}}]}}"#,
                at(0.25),
                at(0.75)
            ));
        }
        let pre = t % 3 == 2;
        if pre {
            automation.push(format!(
                r#"{{"target":{{"kind":"send","returnId":"ret-delay"}},"minimum":0,"maximum":2,"points":[{{"frame":{},"value":0.1}},{{"frame":{},"value":0.4,"curve":-0.5}}]}}"#,
                at(0.15),
                at(0.6)
            ));
        }
        let mut sends = format!(r#"{{"returnId":"ret-verb","gain":{}}}"#, 0.2 + 0.05 * (t % 4) as f64);
        if pre || t % 4 == 1 {
            let _ = write!(sends, r#",{{"returnId":"ret-delay","gain":0.35,"pre":{pre}}}"#);
        }
        // Track 5 (when present) is muted by solo elsewhere: audible false keeps pre sends silent.
        let audible = t != 5;
        let _ = write!(
            json,
            r#"{}{{"id":"track-{t}","source":{{"kind":"audio"}},"gain":{gain},"pan":{pan},"audible":{audible},"unmutedAudible":{audible},
"inserts":{ins},"sends":[{sends}],"notes":[],"audio":[{windows}],"automation":[{auto}]}}"#,
            if t == 0 { "" } else { "," },
            ins = inserts(t),
            auto = automation.join(","),
        );
    }
    let _ = write!(
        json,
        r#"{}{{"id":"ret-verb","return":true,"source":{{"kind":"audio"}},"gain":0.9,"pan":0,"notes":[],"audio":[],
"inserts":[{{"id":"verb","type":"reverb","params":{{"amount":0.6,"size":0.5,"type":1,"predelay":12,"lowcut":120,"dry":0}}}}]}},
{{"id":"ret-delay","return":true,"source":{{"kind":"audio"}},"gain":0.8,"pan":-0.2,"notes":[],"audio":[],
"inserts":[{{"id":"echo","type":"delay","params":{{"amount":0.7,"time":0.75,"feedback":0.45,"dry":0}}}},{{"id":"eq","type":"eq","params":{{"low":-6,"high":-3}}}},{{"id":"grit","type":"drive","params":{{"drive":6,"mix":0.5}}}}]}}]}}"#,
        if tracks == 0 { "" } else { "," }
    );
    TestProject { json, assets }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::timeline_from_bytes;

    #[test]
    fn the_test_project_parses() {
        let p = project(8, 2.0, 48_000);
        let plan = timeline_from_bytes(p.json.as_bytes(), &[]).unwrap();
        assert_eq!(plan.tracks.len(), 10);
        assert_eq!(plan.tempo_map.len(), 3);
        assert!(
            plan.tracks
                .iter()
                .any(|t| t.automation.iter().any(|l| l.target == crate::plan::LaneTarget::Send))
        );
        assert_eq!(p.assets.len(), 8);
    }
}

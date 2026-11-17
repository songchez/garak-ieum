//! Deterministic instrument projects for the engine parity harnesses (docs/RUST_ENGINE.md 7):
//! every built-in instrument with chords, overlapping and cut-off notes, MIDI controllers
//! (pitch bend + range, mod wheel, channel pressure, CC7 / CC11, the sustain pedal), instrument
//! parameter automation, inserts and a send into a reverb return. Sample instruments get
//! synthesized PCM (+ - * / only, identical on every platform) laid out like the shipped
//! manifests: a four-layer grand with release ("damper") zones and a codec start offset, a looped
//! bowed string at 44.1 kHz in stereo, and a drum kit with velocity layers and a choke group.
//!
//! Cases: [`SYNTHS`] (keys, bass, pad, pluck, rhodes, drums), [`SAMPLES`] (grand, haegeum-like,
//! kit), [`VINTAGE`] (옥구슬 EP, 한밤 106) and [`ALL`] (every instrument at once, denser notes:
//! the CPU benchmark project).

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use core::fmt::Write;

use super::TestProject;
use crate::plan::PcmAsset;

pub const SYNTHS: u32 = 0;
pub const SAMPLES: u32 = 1;
pub const VINTAGE: u32 = 2;
pub const ALL: u32 = 3;

struct Rng(u32);

impl Rng {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        self.0 >> 8
    }
    fn below(&mut self, n: u32) -> u32 {
        self.next() % n.max(1)
    }
    fn unit(&mut self) -> f64 {
        f64::from(self.next()) / 16_777_216.0
    }
}

/// A decaying, slightly inharmonic tone with a noisy attack (a struck / plucked / bowed note).
/// `sustain`: amplitude floor of a looped (bowed) sample.
fn tone(seed: u32, rate: u32, channels: u32, seconds: f64, period: f64, sustain: f32) -> PcmAsset {
    let frames = (seconds * f64::from(rate)) as usize;
    let mut rng = Rng(seed);
    let mut samples = Vec::with_capacity(frames * channels as usize);
    let (mut env, mut noise_env) = (1.0f32, 1.0f32);
    let decay = 1.0 - 3.0 / f64::from(rate) as f32;
    let (mut lp_l, mut lp_r) = (0.0f32, 0.0f32);
    for i in 0..frames {
        let phase = (i as f64 / period) % 1.0;
        let tri = (if phase < 0.5 { 4.0 * phase - 1.0 } else { 3.0 - 4.0 * phase }) as f32;
        let phase2 = (i as f64 / (period * 0.4987)) % 1.0;
        let tri2 = (if phase2 < 0.5 { 4.0 * phase2 - 1.0 } else { 3.0 - 4.0 * phase2 }) as f32;
        let n = (rng.unit() * 2.0 - 1.0) as f32;
        lp_l += 0.3 * (n - lp_l);
        lp_r += 0.25 * (-n - lp_r);
        env *= decay;
        noise_env *= 0.996;
        let body = env.max(sustain);
        let l = 0.5 * body * (tri + 0.3 * tri2) + 0.4 * noise_env * lp_l;
        samples.push(l);
        if channels == 2 {
            samples.push(0.5 * body * (0.9 * tri - 0.2 * tri2) + 0.4 * noise_env * lp_r);
        }
    }
    PcmAsset { sample_rate: rate, channels, samples }
}

/// A short noise burst with a pitched body (drum pads).
fn hit(seed: u32, rate: u32, seconds: f64, period: f64) -> PcmAsset {
    let frames = (seconds * f64::from(rate)) as usize;
    let mut rng = Rng(seed);
    let mut samples = Vec::with_capacity(frames);
    let mut env = 1.0f32;
    let mut lp = 0.0f32;
    for i in 0..frames {
        let phase = (i as f64 / (period * (1.0 + i as f64 / f64::from(rate)))) % 1.0;
        let tri = (if phase < 0.5 { 4.0 * phase - 1.0 } else { 3.0 - 4.0 * phase }) as f32;
        let n = (rng.unit() * 2.0 - 1.0) as f32;
        lp += 0.5 * (n - lp);
        env *= 0.9993;
        samples.push(env * (0.6 * tri + 0.5 * lp));
    }
    PcmAsset { sample_rate: rate, channels: 1, samples }
}

struct Notes {
    json: String,
    count: usize,
    next_id: u32,
}

impl Notes {
    fn new() -> Self {
        Self { json: String::new(), count: 0, next_id: 0 }
    }
    fn push(&mut self, on: i64, off: i64, limit: i64, pitch: i32, velocity: f64) {
        if self.count > 0 {
            self.json.push(',');
        }
        let _ = write!(
            self.json,
            r#"{{"id":{},"onFrame":{on},"offFrame":{off},"limitFrame":{limit},"pitch":{pitch},"velocity":{velocity}}}"#,
            self.next_id
        );
        self.next_id += 1;
        self.count += 1;
    }
}

/// Chords, a melody and a few edge notes over `length` frames: a note starting before the
/// project (chased at play), notes cut at their clip end (`limit == off`), overlapping
/// repeated pitches, soft and loud velocities (clip gain may push velocity above 1).
fn phrase(seed: u32, length: i64, rate: f64, low: i32, high: i32, density: u32) -> Notes {
    let mut rng = Rng(seed);
    let mut n = Notes::new();
    let beat = (rate * 0.3) as i64;
    n.push(-beat, beat * 2, beat * 3, (low + high) / 2, 0.7);
    let mut at = beat / 3;
    let span = (high - low).max(1) as u32;
    while at < length - beat {
        let root = low + rng.below(span) as i32;
        let voices = 1 + rng.below(density);
        let hold = beat / 2 + i64::from(rng.below(4)) * beat / 2;
        for v in 0..voices {
            let pitch = (root + [0, 4, 7, 11, 14].get(v as usize % 5).copied().unwrap_or(0)).min(127);
            let off = (at + hold + i64::from(v) * 37).min(length);
            let limit = if rng.below(5) == 0 { off } else { (off + beat * 2).min(length) };
            let velocity = 0.15 + 0.95 * rng.unit();
            n.push(
                at + i64::from(v) * 11,
                off,
                limit.max(off),
                pitch,
                (velocity * 1000.0) as i64 as f64 / 1000.0,
            );
        }
        at += beat / 2 + i64::from(rng.below(3)) * beat / 3;
    }
    // A note held to the project end (cut there).
    n.push(length - beat * 2, length, length, low + 5, 0.9);
    n
}

fn drum_phrase(seed: u32, length: i64, rate: f64, pads: &[i32]) -> Notes {
    let mut rng = Rng(seed);
    let mut n = Notes::new();
    let step = (rate * 0.125) as i64;
    let mut at = 0;
    let mut k = 0usize;
    while at < length - step {
        for (i, &pad) in pads.iter().enumerate() {
            if (k + i).is_multiple_of(i + 1) || rng.below(4) == 0 {
                let velocity = 0.3 + 0.7 * rng.unit();
                n.push(
                    at,
                    (at + step / 2).min(length),
                    length,
                    pad,
                    (velocity * 1000.0) as i64 as f64 / 1000.0,
                );
            }
        }
        at += step;
        k += 1;
    }
    n
}

/// Controller events: a bend range, a pitch bend sweep, mod wheel / pressure, CC7 / CC11 rides,
/// and (`pedal`) sustain pedal presses.
fn controls(seed: u32, length: i64, pedal: bool) -> String {
    let mut rng = Rng(seed);
    let mut events: Vec<(i64, i32, i32)> = Vec::new();
    events.push((0, 131, 7));
    let at = |f: f64| (f * length as f64) as i64;
    for k in 0..12 {
        let f = at(0.2 + 0.02 * f64::from(k));
        events.push((f, 129, -8192 + (k * 1500).min(16383 - 1)));
    }
    events.push((at(0.48), 129, 0));
    events.push((at(0.3), 1, 90));
    events.push((at(0.45), 1, 0));
    events.push((at(0.5), 128, 70));
    events.push((at(0.6), 128, 0));
    events.push((at(0.55), 7, 80));
    events.push((at(0.7), 11, 60));
    events.push((at(0.85), 11, 127));
    events.push((at(0.9), 7, 100));
    events.push((at(0.65), 131, 2));
    if pedal {
        for k in 0..4 {
            let start = at(0.1 + 0.22 * f64::from(k)) + i64::from(rng.below(500));
            events.push((start, 64, 127));
            events.push((start + at(0.12), 64, 0));
        }
    }
    events.sort_by_key(|e| e.0);
    let mut s = String::new();
    for (i, (frame, controller, value)) in events.iter().enumerate() {
        let _ = write!(
            s,
            r#"{}{{"frame":{frame},"controller":{controller},"value":{value}}}"#,
            if i == 0 { "" } else { "," }
        );
    }
    s
}

fn instrument_lane(param: &str, minimum: f64, maximum: f64, length: i64) -> String {
    let at = |f: f64| (f * length as f64) as i64;
    format!(
        r#"{{"target":{{"kind":"instrument","param":"{param}"}},"minimum":{minimum},"maximum":{maximum},"points":[{{"frame":{},"value":0.2}},{{"frame":{},"value":0.9,"curve":0.4}},{{"frame":{},"value":0.5}}]}}"#,
        at(0.1),
        at(0.5),
        at(0.8)
    )
}

struct Builder {
    json: String,
    tracks: usize,
    assets: Vec<(String, PcmAsset)>,
    sets: Vec<String>,
    rate: u32,
}

impl Builder {
    fn track(&mut self, id: &str, source: &str, notes: &Notes, controls: &str, extra: &str) {
        let _ = write!(
            self.json,
            r#"{}{{"id":"{id}","source":{source},"notes":[{}],"controls":[{controls}],"audio":[]{}{extra}}}"#,
            if self.tracks == 0 { "" } else { "," },
            notes.json,
            if extra.contains("\"inserts\"") { "" } else { r#","inserts":[]"# }
        );
        self.tracks += 1;
    }

    /// A pitched set: zones every `step` semitones from `low` to `high`, `layers` velocity layers,
    /// optional loops, optional release zones (one per octave).
    #[allow(clippy::too_many_arguments)]
    fn pitched_set(
        &mut self,
        id: &str,
        low: i32,
        high: i32,
        step: i32,
        layers: u32,
        looped: bool,
        rate: u32,
        channels: u32,
        releases: bool,
        start_offset: f64,
        gain_db: f64,
    ) {
        let mut zones = String::new();
        let mut files = String::new();
        let mut root = low;
        let mut k = 0u32;
        while root <= high {
            for layer in 0..layers {
                let file = format!("{id}-{root}-{layer}");
                let asset = format!("{id}/{file}");
                let period = f64::from(rate) / (440.0 * pow2((f64::from(root) - 69.0) / 12.0));
                let seconds = if looped { 1.2 } else { 1.6 - 0.01 * f64::from(root - low) };
                let pcm =
                    tone(k * 7919 + layer, rate, channels, seconds, period, if looped { 0.3 } else { 0.0 });
                self.assets.push((asset.clone(), pcm));
                let vlo = f64::from(layer) / f64::from(layers);
                let vhi = f64::from(layer + 1) / f64::from(layers);
                let lo = (root - step / 2).max(0);
                let hi = (root + (step - 1) / 2).min(127);
                let tune = (f64::from(k % 5) - 2.0) * 1.3;
                let mut zone = format!(
                    r#"{{"file":"{file}","root":{root},"lo":{lo},"hi":{hi},"vlo":{vlo},"vhi":{vhi},"tune":{tune},"gainDb":{}"#,
                    -f64::from(layer) * 0.5
                );
                if looped {
                    let _ = write!(
                        zone,
                        r#","loop":[{},{}]"#,
                        0.35 + 0.01 * f64::from(k % 3),
                        0.8 + 0.013 * f64::from(layer)
                    );
                }
                zone.push('}');
                if !zones.is_empty() {
                    zones.push(',');
                    files.push(',');
                }
                zones.push_str(&zone);
                let _ = write!(files, r#""{file}":"{asset}""#);
                k += 1;
            }
            root += step;
        }
        let mut release_zones = String::new();
        if releases {
            let mut root = low;
            while root <= high {
                let file = format!("{id}-rel-{root}");
                let asset = format!("{id}/{file}");
                self.assets.push((asset.clone(), hit(root as u32 * 31, rate, 0.25, 40.0 + f64::from(root))));
                if !release_zones.is_empty() {
                    release_zones.push(',');
                }
                let _ = write!(
                    release_zones,
                    r#"{{"file":"{file}","root":{root},"lo":{},"hi":{},"gainDb":-4}}"#,
                    (root - 6).max(0),
                    (root + 5).min(127)
                );
                let _ = write!(files, r#","{file}":"{asset}""#);
                root += 12;
            }
        }
        self.sets.push(format!(
            r#"{{"id":"{id}","manifest":{{"kind":"pitched","gainDb":{gain_db},"release":0.3,"zones":[{zones}]{}}},"files":{{{files}}},"startOffset":{start_offset}}}"#,
            if releases { format!(r#","releaseZones":[{release_zones}]"#) } else { String::new() }
        ));
    }

    fn kit_set(&mut self, id: &str, pads: &[(i32, i32)]) {
        let mut zones = String::new();
        let mut files = String::new();
        for (i, &(pad, choke)) in pads.iter().enumerate() {
            for layer in 0..3u32 {
                let file = format!("{id}-{pad}-{layer}");
                let asset = format!("{id}/{file}");
                let seconds = if choke >= 0 { 1.0 } else { 0.4 + 0.1 * (i % 3) as f64 };
                self.assets.push((
                    asset.clone(),
                    hit(pad as u32 * 101 + layer, self.rate, seconds, 30.0 + 7.0 * i as f64),
                ));
                if !zones.is_empty() {
                    zones.push(',');
                    files.push(',');
                }
                let _ = write!(
                    zones,
                    r#"{{"file":"{file}","root":{pad},"lo":{pad},"hi":{pad},"vlo":{},"vhi":{},"gainDb":{},"choke":{choke}}}"#,
                    f64::from(layer) / 3.0,
                    f64::from(layer + 1) / 3.0,
                    f64::from(layer) - 2.0
                );
                let _ = write!(files, r#""{file}":"{asset}""#);
            }
        }
        self.sets.push(format!(
            r#"{{"id":"{id}","manifest":{{"kind":"kit","gainDb":-2,"release":0.1,"zones":[{zones}]}},"files":{{{files}}}}}"#
        ));
    }
}

/// 2^x with + - * / only (rational approximation good to ~1e-9 for |x| < 6), so the synthesized
/// sample pitches are identical everywhere.
fn pow2(x: f64) -> f64 {
    let whole = garak_dsp::math::floor(x);
    let f = x - whole;
    // exp(f ln2) by Taylor series.
    let y = f * core::f64::consts::LN_2;
    let mut term = 1.0;
    let mut sum = 1.0;
    for k in 1..20 {
        term *= y / f64::from(k);
        sum += term;
    }
    let mut scale = 1.0;
    let mut w = whole as i32;
    while w > 0 {
        scale *= 2.0;
        w -= 1;
    }
    while w < 0 {
        scale /= 2.0;
        w += 1;
    }
    sum * scale
}

/// Instrument test project `case` of `seconds` at `sample_rate`.
pub fn instrument_project(case: u32, seconds: f64, sample_rate: u32) -> TestProject {
    let rate = f64::from(sample_rate);
    let length = (seconds * rate) as i64;
    let mut b =
        Builder { json: String::new(), tracks: 0, assets: Vec::new(), sets: Vec::new(), rate: sample_rate };
    let _ = write!(
        b.json,
        r#"{{"version":1,"projectId":"rust-engine-instruments","revision":1,"sampleRate":{sample_rate},"bpm":100,
"timeSignature":{{"numerator":4,"denominator":4}},"lengthFrames":{length},"masterGain":0.7,"tracks":["#
    );
    let send = r#","sends":[{"returnId":"ret","gain":0.3}]"#;
    let dense = if case == ALL { 4 } else { 3 };
    if case == SYNTHS || case == ALL {
        let synths: [(&str, &str, i32, i32, &str); 5] = [
            ("keys", r#"{"level":0.6,"bell":0.35,"tone":0.2,"release":0.4}"#, 55, 80, "tone"),
            ("bass", r#"{"level":0.7,"sub":0.5,"tone":-0.3}"#, 28, 48, "sub"),
            ("pad", r#"{"level":0.5,"detune":12,"attack":0.05,"release":0.9}"#, 48, 72, "detune"),
            ("pluck", r#"{"level":0.6,"sweep":0.4,"tone":0.5}"#, 60, 84, "sweep"),
            ("rhodes", r#"{"level":0.6,"bark":0.7,"decay":3,"tone":-0.2}"#, 45, 76, "bark"),
        ];
        for (i, (id, params, low, high, lane)) in synths.iter().enumerate() {
            let notes = phrase(11 + i as u32, length, rate, *low, *high, dense);
            let ctl = controls(3 + i as u32, length, false);
            let (minimum, maximum) = match *lane {
                "tone" => (-1.0, 1.0),
                "sub" => (0.0, 1.0),
                "detune" => (0.0, 40.0),
                "sweep" => (0.02, 1.0),
                _ => (0.0, 1.0),
            };
            let release = instrument_lane("release", 0.01, 2.0, length);
            let extra = format!(
                r#",{}"gain":0.6,"pan":{},"automation":[{},{}]{}"#,
                if i == 1 {
                    r#""inserts":[{"id":"eq","type":"eq","params":{"low":3,"mid":-2}}],"#
                } else {
                    ""
                },
                (i as f64 - 2.0) / 3.0,
                instrument_lane(lane, minimum, maximum, length),
                release,
                send
            );
            b.track(
                &format!("synth-{id}"),
                &format!(
                    r#"{{"kind":"builtin-synth","instrumentId":"{id}","isKit":false,"params":{params}}}"#
                ),
                &notes,
                &ctl,
                &extra,
            );
        }
        let drums = drum_phrase(29, length, rate, &[36, 38, 42, 46, 39, 49, 50, 44, 40, 35, 51, 47]);
        let extra =
            format!(r#","gain":0.5,"automation":[{}]{send}"#, instrument_lane("punch", 0.5, 2.0, length));
        b.track(
            "synth-drums",
            r#"{"kind":"builtin-synth","instrumentId":"drums","isKit":true,"params":{"level":0.7,"tune":2,"decay":1.4,"punch":1.3,"tone":0.3}}"#,
            &drums,
            &controls(41, length, false),
            &extra,
        );
    }
    if case == SAMPLES || case == ALL {
        b.pitched_set("grand", 33, 93, 3, 4, false, sample_rate, 2, true, 0.012, -1.0);
        b.pitched_set("haegeum", 52, 84, 4, 3, true, 44_100, 2, false, 0.0, 2.0);
        b.kit_set("kit", &[(36, -1), (38, -1), (42, 1), (44, 1), (46, 1), (49, -1), (51, -1)]);
        let grand = phrase(51, length, rate, 36, 90, dense + 1);
        let extra = format!(
            r#","gain":0.7,"automation":[{}]{send}"#,
            instrument_lane("releaseNoise", 0.0, 1.0, length)
        );
        b.track(
            "grand",
            r#"{"kind":"builtin-sampled","instrumentId":"grand","sampleSetId":"grand","isKit":false,"params":{"level":0.8,"releaseNoise":0.7,"release":0.6,"tone":0.25}}"#,
            &grand,
            &controls(53, length, false),
            &extra,
        );
        let bowed = phrase(57, length, rate, 54, 82, 2);
        b.track(
            "haegeum",
            r#"{"kind":"builtin-sampled","instrumentId":"haegeum","sampleSetId":"haegeum","isKit":false,"params":{"attack":0.06,"release":0.4,"tone":-0.35}}"#,
            &bowed,
            &controls(59, length, false),
            r#","gain":0.6,"pan":-0.3,"inserts":[{"id":"chorus","type":"chorus","params":{"rate":0.8,"depth":0.4,"mix":0.3}}]"#,
        );
        let kit = drum_phrase(61, length, rate, &[36, 38, 42, 44, 46, 49, 51, 37]);
        let extra = format!(r#","gain":0.6,"automation":[{}]"#, instrument_lane("decay", 0.1, 1.0, length));
        b.track(
            "kit",
            r#"{"kind":"builtin-sampled","instrumentId":"kit-acoustic","sampleSetId":"kit","isKit":true,"params":{"tune":-1.5,"decay":0.8,"level":0.9}}"#,
            &kit,
            &controls(63, length, false),
            &extra,
        );
    }
    if case == VINTAGE || case == ALL {
        let ep = phrase(71, length, rate, 40, 84, dense);
        let extra =
            format!(r#","gain":0.6,"automation":[{}]{send}"#, instrument_lane("tremDepth", 0.0, 1.0, length));
        b.track(
            "okgu-ep",
            r#"{"kind":"builtin-synth","instrumentId":"okgu-ep","isKit":false,"params":{"bark":0.6,"tremDepth":0.3,"drive":0.2}}"#,
            &ep,
            &controls(73, length, true),
            &extra,
        );
        let poly = phrase(77, length, rate, 36, 79, dense);
        let extra = format!(
            r#","gain":0.5,"pan":0.25,"automation":[{}]{send}"#,
            instrument_lane("cutoff", 300.0, 6000.0, length)
        );
        b.track(
            "hanbam-106",
            r#"{"kind":"builtin-synth","instrumentId":"hanbam-106","isKit":false,"params":{"chorus":2,"resonance":0.35,"envAmount":0.5,"voices":8}}"#,
            &poly,
            &controls(79, length, true),
            &extra,
        );
    }
    let _ = write!(
        b.json,
        r#"{}{{"id":"ret","return":true,"source":{{"kind":"audio"}},"gain":0.8,"notes":[],"audio":[],
"inserts":[{{"id":"verb","type":"reverb","params":{{"amount":0.5,"size":0.4,"dry":0}}}}]}}]}}"#,
        if b.tracks == 0 { "" } else { "," }
    );
    TestProject { json: b.json, assets: b.assets, sample_sets: b.sets }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{parse_sample_set, timeline_from_bytes};

    #[test]
    fn instrument_projects_parse() {
        for case in [SYNTHS, SAMPLES, VINTAGE, ALL] {
            let p = instrument_project(case, 2.0, 48_000);
            let plan = timeline_from_bytes(p.json.as_bytes(), &[]).unwrap();
            assert!(plan.tracks.len() >= 3, "case {case}");
            for s in &p.sample_sets {
                parse_sample_set(&crate::json::Json::parse(s.as_bytes()).unwrap()).unwrap();
            }
        }
        assert!((pow2(1.5) - 2.828_427_124_746_19).abs() < 1e-9);
    }
}

//! The render-diff protocol's parsing half (docs/RENDER_DIFF_PROTOCOL.md 3), line for line
//! native/src/protocol.hpp: `project.set` timelines (`parse_timeline`), `project.patch` merges
//! (`parse_patch`), JSON or binary event arrays (3.4), the same ranges and the same refusals.

use alloc::collections::BTreeMap;
use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use crate::error::Error;
use crate::json::Json;
use crate::plan::{
    AudioWindow, AutomationLane, AutomationPoint, ControlEvent, InsertPlan, LaneTarget, Note, Plan,
    RouteKind, RoutePlan, RouteTap, SendPlan, Source, SourceKind, TempoPoint, TrackPlan,
};

pub const NOTE_RECORD_BYTES: usize = 24;
pub const CONTROL_RECORD_BYTES: usize = 12;
const CONTROLLER_COUNT: i64 = 132;
const PITCH_BEND: i64 = 129;
const BEND_RANGE: i64 = 131;

fn err(message: impl Into<String>) -> Error {
    Error::new(message)
}

fn string(value: &Json, key: &str, maximum: usize, empty: bool) -> Result<String, Error> {
    let s = value.get(key).and_then(Json::as_str).ok_or_else(|| err(format!("Missing string: {key}")))?;
    if (!empty && s.is_empty()) || s.len() > maximum || s.contains('\0') {
        return Err(err(format!("Invalid string: {key}")));
    }
    Ok(s.to_string())
}

fn id_string(value: &Json, key: &str) -> Result<String, Error> {
    string(value, key, 512, false)
}

fn number(value: &Json, key: &str, minimum: f64, maximum: f64, fallback: f64) -> Result<f64, Error> {
    let Some(v) = value.get(key) else { return Ok(fallback) };
    let n = v.as_f64().ok_or_else(|| err(format!("Invalid number: {key}")))?;
    if !n.is_finite() || n < minimum || n > maximum {
        return Err(err(format!("Number out of range: {key}")));
    }
    Ok(n)
}

fn integer(value: &Json, key: &str, minimum: i64, maximum: i64, fallback: i64) -> Result<i64, Error> {
    let n = number(value, key, minimum as f64, maximum as f64, fallback as f64)?;
    if garak_dsp::math::floor(n) != n {
        return Err(err(format!("Expected integer: {key}")));
    }
    Ok(n as i64)
}

/// nlohmann `value(key, default)` for booleans: absent -> default, wrong type -> error.
fn boolean(value: &Json, key: &str, fallback: bool) -> Result<bool, Error> {
    match value.get(key) {
        None => Ok(fallback),
        Some(v) => v.as_bool().ok_or_else(|| err(format!("Invalid boolean: {key}"))),
    }
}

fn array<'a>(value: &'a Json, key: &str) -> Result<&'a [Json], Error> {
    value.get(key).and_then(Json::as_array).ok_or_else(|| err(format!("Missing array: {key}")))
}

fn parameters(value: Option<&Json>) -> Result<Vec<(String, f64)>, Error> {
    let Some(value) = value else { return Ok(Vec::new()) };
    let members = value.as_object().ok_or_else(|| err("Invalid parameter map"))?;
    if members.len() > 1024 {
        return Err(err("Invalid parameter map"));
    }
    // std::map: sorted, unique keys (the last duplicate wins, like Json::get).
    let mut map: BTreeMap<String, f64> = BTreeMap::new();
    for (k, v) in members {
        let n = v.as_f64().ok_or_else(|| err("Invalid parameter"))?;
        if k.len() > 128 {
            return Err(err("Invalid parameter"));
        }
        if !n.is_finite() {
            return Err(err("Non-finite parameter"));
        }
        map.insert(k.clone(), n);
    }
    Ok(map.into_iter().collect())
}

fn plugin_instance(value: &Json) -> Result<String, Error> {
    let plugin = value.get("plugin").ok_or_else(|| err("Missing plugin"))?;
    string(plugin, "instanceId", 512, false)
}

fn source(value: &Json) -> Result<Source, Error> {
    let kind = string(value, "kind", 32, false)?;
    let mut s = Source::default();
    match kind.as_str() {
        "audio" => s.kind = SourceKind::Audio,
        "builtin-synth" => s.kind = SourceKind::BuiltinSynth,
        "builtin-sampled" => s.kind = SourceKind::BuiltinSampled,
        "vst3" => {
            s.kind = SourceKind::Vst3;
            s.plugin_instance = plugin_instance(value)?;
        }
        "native-wavetable" => {
            s.kind = SourceKind::NativeWavetable;
            s.instrument_id = id_string(value, "instrumentId")?;
            if s.instrument_id != "wavetable" || boolean(value, "isKit", false)? {
                return Err(err("Invalid IEUM WAVE source"));
            }
            s.patch = string(value, "patchData", 4 * 1024 * 1024, false)?;
        }
        other => return Err(err(format!("Unsupported native track source: {other}"))),
    }
    if matches!(s.kind, SourceKind::BuiltinSynth | SourceKind::BuiltinSampled) {
        s.instrument_id = id_string(value, "instrumentId")?;
        s.is_kit = boolean(value, "isKit", false)?;
        s.params = parameters(value.get("params"))?;
        if s.kind == SourceKind::BuiltinSampled {
            s.sample_set_id = id_string(value, "sampleSetId")?;
        }
    }
    Ok(s)
}

fn binary_records<'a>(
    reference: &Json,
    blob: &'a [u8],
    record: usize,
    maximum: usize,
) -> Result<(&'a [u8], usize), Error> {
    if reference.as_object().is_none() {
        return Err(err("Invalid binary reference"));
    }
    let offset = integer(reference, "offset", 0, 1i64 << 32, 0)? as usize;
    let count = integer(reference, "count", 0, maximum as i64, 0)? as usize;
    if !offset.is_multiple_of(4) || offset > blob.len() || count * record > blob.len() - offset {
        return Err(err("Binary reference exceeds the request frame"));
    }
    let bytes = blob
        .get(offset..offset + count * record)
        .ok_or_else(|| err("Binary reference exceeds the request frame"))?;
    Ok((bytes, count))
}

fn i32_at(b: &[u8], at: usize) -> i64 {
    let mut w = [0u8; 4];
    if let Some(s) = b.get(at..at + 4) {
        w.copy_from_slice(s);
    }
    i64::from(i32::from_le_bytes(w))
}

fn f32_at(b: &[u8], at: usize) -> f32 {
    let mut w = [0u8; 4];
    if let Some(s) = b.get(at..at + 4) {
        w.copy_from_slice(s);
    }
    f32::from_le_bytes(w)
}

fn valid_controller_value(controller: i64, value: i64) -> bool {
    if !(0..CONTROLLER_COUNT).contains(&controller) {
        return false;
    }
    if controller == PITCH_BEND {
        return (-8192..=8191).contains(&value);
    }
    if controller == BEND_RANGE {
        return (0..=48).contains(&value);
    }
    (0..=127).contains(&value)
}

#[allow(clippy::too_many_arguments)]
fn read_note(
    id: i64,
    on: i64,
    off: i64,
    limit: i64,
    pitch: i64,
    velocity: f64,
    length: i64,
) -> Result<Note, Error> {
    if !(0..=2_000_000_000).contains(&id)
        || on < -length
        || on > length - 1
        || off < 1.max(on + 1)
        || off > length
        || limit < off
        || limit > length
        || !(0..=127).contains(&pitch)
        || !velocity.is_finite()
        || !(0.0..=4.0).contains(&velocity)
    {
        return Err(err("Invalid native note"));
    }
    Ok(Note {
        id: id as i32,
        on_frame: on,
        off_frame: off,
        limit_frame: limit,
        pitch: pitch as i32,
        velocity: velocity as f32,
    })
}

fn read_control(
    frame: i64,
    controller: i64,
    value: i64,
    length: i64,
    previous: &mut i64,
) -> Result<ControlEvent, Error> {
    if frame < 0 || frame > length || !valid_controller_value(controller, value) {
        return Err(err("Invalid track control value"));
    }
    if frame < *previous {
        return Err(err("Track controls must be sorted by frame"));
    }
    *previous = frame;
    Ok(ControlEvent { frame, controller: controller as u16, value: value as i32 })
}

/// Header fields of a timeline (protocol.hpp `timelineHeader`).
pub fn parse_header(value: &Json) -> Result<Plan, Error> {
    let mut p = Plan::default();
    if integer(value, "version", 1, 1, 0)? != 1 {
        return Err(err("Unsupported timeline version"));
    }
    p.project_id = id_string(value, "projectId")?;
    p.revision = integer(value, "revision", 0, 9_007_199_254_740_991, 0)? as u64;
    p.sample_rate = integer(value, "sampleRate", 8000, 192_000, 48_000)? as u32;
    p.bpm = number(value, "bpm", 20.0, 400.0, 120.0)?;
    p.beats_per_bar = number(value, "beatsPerBar", 0.25, 64.0, 4.0)?;
    p.length_frames = integer(value, "lengthFrames", 1, i64::from(p.sample_rate) * 3600, 1)?;
    if let Some(points) = value.get("tempoMap").filter(|v| !v.is_null()) {
        let points = points.as_array().filter(|a| a.len() <= 4096).ok_or_else(|| err("Invalid tempo map"))?;
        for point in points {
            let beat = number(point, "beat", 0.0, 10_000_000.0, 0.0)?;
            let bpm = number(point, "bpm", 20.0, 400.0, p.bpm)?;
            let curve = match point.get("curve") {
                None => "step",
                Some(c) => c.as_str().ok_or_else(|| err("Invalid tempo curve"))?,
            };
            if curve != "step" && curve != "ramp" {
                return Err(err("Invalid tempo curve"));
            }
            let bad = match p.tempo_map.last() {
                None => beat != 0.0 || (bpm - p.bpm).abs() > 1e-6,
                Some(last) => beat <= last.beat || beat.is_nan(),
            };
            if bad {
                return Err(err("Invalid tempo map order"));
            }
            p.tempo_map.push(TempoPoint { beat, bpm, ramp: curve == "ramp" });
        }
        if p.tempo_map.len() < 2 {
            p.tempo_map.clear();
        }
    }
    p.master_gain = number(value, "masterGain", 0.0, 4.0, 1.0)? as f32;
    p.low_latency_monitoring = boolean(value, "lowLatencyMonitoring", true)?;
    let empty = Json::Object(Vec::new());
    let signature = value.get("timeSignature").unwrap_or(&empty);
    p.time_sig_numerator = integer(signature, "numerator", 1, 32, 4)? as i32;
    p.time_sig_denominator = integer(signature, "denominator", 2, 16, 4)? as i32;
    if ![2, 4, 8, 16].contains(&p.time_sig_denominator) {
        return Err(err("Invalid meter denominator"));
    }
    if let Some(cycle) = value.get("cycle").filter(|v| !v.is_null()) {
        let start = integer(cycle, "startFrame", 0, p.length_frames - 1, 0)?;
        let end = integer(cycle, "endFrame", start + 1, p.length_frames, p.length_frames)?;
        p.cycle = Some((start, end));
    }
    Ok(p)
}

/// Which heavy fields a track message carried (`project.patch` keeps the others).
#[derive(Clone, Copy, Debug, Default)]
pub struct TrackFields {
    pub notes: bool,
    pub controls: bool,
    pub audio: bool,
    pub automation: bool,
}

fn lane(value: &Json, total_points: &mut usize) -> Result<AutomationLane, Error> {
    let target = value.get("target").ok_or_else(|| err("Missing automation target"))?;
    let kind = string(target, "kind", 16, false)?;
    let mut lane = AutomationLane {
        target: LaneTarget::Volume,
        insert_id: String::new(),
        param: String::new(),
        return_id: String::new(),
        minimum: 0.0,
        maximum: 1.0,
        logarithmic: false,
        options: Vec::new(),
        points: Vec::new(),
    };
    match kind.as_str() {
        "volume" => lane.target = LaneTarget::Volume,
        "pan" => lane.target = LaneTarget::Pan,
        "mute" => lane.target = LaneTarget::Mute,
        "insert" => {
            lane.target = LaneTarget::Insert;
            lane.insert_id = id_string(target, "insertId")?;
            lane.param = string(target, "param", 120, false)?;
        }
        "instrument" => {
            lane.target = LaneTarget::Instrument;
            lane.param = string(target, "param", 120, false)?;
        }
        "send" => {
            lane.target = LaneTarget::Send;
            lane.return_id = id_string(target, "returnId")?;
        }
        _ => return Err(err("Invalid automation target")),
    }
    lane.minimum = number(value, "minimum", -1e9, 1e9, 0.0)?;
    lane.maximum = number(value, "maximum", -1e9, 1e9, 1.0)?;
    lane.logarithmic = boolean(value, "logarithmic", false)?;
    if lane.logarithmic && !(lane.minimum > 0.0 && lane.maximum > 0.0) {
        return Err(err("Invalid logarithmic automation range"));
    }
    if let Some(options) = value.get("options") {
        let options =
            options.as_array().filter(|o| o.len() <= 64).ok_or_else(|| err("Invalid automation options"))?;
        for o in options {
            lane.options.push(o.as_f64().ok_or_else(|| err("Invalid automation option"))?);
        }
    }
    let points = array(value, "points")?;
    *total_points += points.len();
    if points.len() > 20_000 || *total_points > 100_000 {
        return Err(err("Automation point limit exceeded"));
    }
    let mut previous = 0.0;
    for item in points {
        let frame = number(item, "frame", previous, 1e13, previous)?;
        let value = number(item, "value", 0.0, 1.0, 0.0)?;
        let curve = number(item, "curve", -1.0, 1.0, 0.0)?;
        previous = frame;
        lane.points.push(AutomationPoint { frame, value, curve });
    }
    Ok(lane)
}

/// One track message (protocol.hpp `timelineTrack`).
pub fn parse_track(
    item: &Json,
    p: &Plan,
    blob: &[u8],
    present: &mut TrackFields,
) -> Result<TrackPlan, Error> {
    let length = p.length_frames;
    let mut t = TrackPlan { id: id_string(item, "id")?, ..TrackPlan::default() };
    t.enabled = boolean(item, "enabled", true)?;
    t.source = source(item.get("source").ok_or_else(|| err("Missing source"))?)?;
    t.gain = number(item, "gain", 0.0, 4.0, 1.0)? as f32;
    t.pan = number(item, "pan", -1.0, 1.0, 0.0)? as f32;
    t.mute = boolean(item, "mute", false)?;
    t.solo = boolean(item, "solo", false)?;
    t.solo_safe = boolean(item, "soloSafe", false)?;
    t.audible = boolean(item, "audible", true)?;
    if let Some(input) = item.get("input").filter(|v| !v.is_null()) {
        let channels = input
            .get("channels")
            .and_then(Json::as_array)
            .filter(|c| !c.is_empty() && c.len() <= 2)
            .ok_or_else(|| err("Invalid track input channels"))?;
        let mut pair = [-1i16, -1];
        for (slot, c) in pair.iter_mut().zip(channels) {
            match c {
                Json::Number { value, integer: true } if (0.0..=255.0).contains(value) => {
                    *slot = *value as i16
                }
                _ => return Err(err("Invalid track input channel")),
            }
        }
        if pair[1] == pair[0] {
            return Err(err("A stereo track input needs two different channels"));
        }
        t.input = Some(pair);
    }
    if let Some(value) = item.get("route").filter(|v| !v.is_null()) {
        let kind = string(value, "kind", 16, false)?;
        let mut route = RoutePlan { kind: RouteKind::None, track_id: String::new(), tap: RouteTap::PostFx };
        match kind.as_str() {
            "track" => {
                route.kind = RouteKind::Track;
                route.track_id = id_string(value, "trackId")?;
                route.tap = match string(value, "tap", 16, false)?.as_str() {
                    "preFx" => RouteTap::PreFx,
                    "postFx" => RouteTap::PostFx,
                    "postFader" => RouteTap::PostFader,
                    _ => return Err(err("Invalid track route tap")),
                };
            }
            "master" => route.kind = RouteKind::Master,
            "none" => route.kind = RouteKind::None,
            _ => return Err(err("Invalid track route")),
        }
        t.route = Some(route);
    }
    t.is_return = boolean(item, "return", false)?;
    if let Some(sends) = item.get("sends").filter(|v| !v.is_null()) {
        let sends = sends.as_array().filter(|s| s.len() <= 256).ok_or_else(|| err("Invalid track sends"))?;
        if t.is_return && !sends.is_empty() {
            return Err(err("A return track cannot have sends"));
        }
        for value in sends {
            let send = SendPlan {
                return_id: id_string(value, "returnId")?,
                gain: number(value, "gain", 0.0, 4.0, 0.0)? as f32,
                pre: boolean(value, "pre", false)?,
            };
            if t.sends.iter().any(|o| o.return_id == send.return_id) {
                return Err(err("Duplicate track send"));
            }
            t.sends.push(send);
        }
    }
    let inserts = array(item, "inserts").map_err(|_| err("Too many inserts"))?;
    if inserts.len() > 64 {
        return Err(err("Too many inserts"));
    }
    for insert in inserts {
        let mut b = InsertPlan {
            id: id_string(insert, "id")?,
            kind: id_string(insert, "type")?,
            enabled: boolean(insert, "enabled", true)?,
            params: Vec::new(),
            plugin_instance: String::new(),
        };
        if b.kind == "vst3" {
            b.plugin_instance = plugin_instance(insert)?;
        } else {
            b.params = parameters(insert.get("params"))?;
        }
        t.inserts.push(b);
    }
    if let Some(reference) = item.get("notesBinary") {
        let (bytes, count) = binary_records(reference, blob, NOTE_RECORD_BYTES, 100_000)?;
        for i in 0..count {
            let at = i * NOTE_RECORD_BYTES;
            t.notes.push(read_note(
                i32_at(bytes, at),
                i32_at(bytes, at + 4),
                i32_at(bytes, at + 8),
                i32_at(bytes, at + 12),
                i32_at(bytes, at + 16),
                f64::from(f32_at(bytes, at + 20)),
                length,
            )?);
        }
        present.notes = true;
    } else if let Some(notes) = item.get("notes") {
        let notes = notes
            .as_array()
            .filter(|n| n.len() <= 100_000)
            .ok_or_else(|| err("Timeline event limit exceeded"))?;
        for n in notes {
            let id = integer(n, "id", 0, 2_000_000_000, 0)?;
            let on = integer(n, "onFrame", -length, length - 1, 0)?;
            let off = integer(n, "offFrame", 1.max(on + 1), length, 1.max(on + 1))?;
            let limit = integer(n, "limitFrame", off, length, off)?;
            let pitch = integer(n, "pitch", 0, 127, 60)?;
            let velocity = number(n, "velocity", 0.0, 4.0, 1.0)?;
            t.notes.push(read_note(id, on, off, limit, pitch, velocity, length)?);
        }
        present.notes = true;
    }
    if let Some(reference) = item.get("controlsBinary") {
        let (bytes, count) = binary_records(reference, blob, CONTROL_RECORD_BYTES, 100_000)?;
        let mut previous = -1;
        for i in 0..count {
            let at = i * CONTROL_RECORD_BYTES;
            t.controls.push(read_control(
                i32_at(bytes, at),
                i32_at(bytes, at + 4),
                i32_at(bytes, at + 8),
                length,
                &mut previous,
            )?);
        }
        present.controls = true;
    } else if let Some(controls) = item.get("controls") {
        let controls = controls
            .as_array()
            .filter(|c| c.len() <= 100_000)
            .ok_or_else(|| err("Invalid track controls"))?;
        let mut previous = -1;
        for c in controls {
            let frame = integer(c, "frame", 0, length, 0)?;
            let controller = integer(c, "controller", 0, CONTROLLER_COUNT - 1, 64)?;
            let value = integer(c, "value", -8192, 8191, 0)?;
            t.controls.push(read_control(frame, controller, value, length, &mut previous)?);
        }
        present.controls = true;
    }
    t.unmuted_audible = boolean(item, "unmutedAudible", t.audible)?;
    if let Some(lanes) = item.get("automation") {
        present.automation = true;
        let lanes =
            lanes.as_array().filter(|l| l.len() <= 256).ok_or_else(|| err("Invalid track automation"))?;
        let mut total = 0usize;
        for value in lanes {
            t.automation.push(lane(value, &mut total)?);
        }
    }
    if item.contains("audio") {
        present.audio = true;
    }
    let audio = match item.get("audio") {
        None => &[][..],
        Some(a) => {
            a.as_array().filter(|a| a.len() <= 8192).ok_or_else(|| err("Timeline event limit exceeded"))?
        }
    };
    let rate = i64::from(p.sample_rate);
    for a in audio {
        let start = integer(a, "startFrame", 0, length, 0)?;
        let end = integer(a, "endFrame", start + 1, length, start + 1)?;
        let clip_length = integer(a, "clipLengthFrames", 1, rate * 3600, end - start)?;
        // Evaluation order of protocol.hpp (each field's range depends on the ones before).
        let id = integer(a, "id", 0, 2_000_000_000, 0)?;
        let asset_id = id_string(a, "assetId")?;
        let source_start_frame = number(a, "sourceStartFrame", 0.0, 1e9, 0.0)?;
        let source_sample_rate = number(a, "sourceSampleRate", 8000.0, 192_000.0, f64::from(p.sample_rate))?;
        let clip_offset_frames = integer(a, "clipOffsetFrames", 0, rate * 3600, 0)?;
        t.audio.push(AudioWindow {
            id: id as i32,
            asset_id,
            start_frame: start,
            end_frame: end,
            source_start_frame,
            source_sample_rate,
            clip_offset_frames,
            clip_length_frames: clip_length,
            gain: number(a, "gain", 0.0, 16.0, 1.0)? as f32,
            fade_in_frames: integer(a, "fadeInFrames", 0, clip_length, 0)?,
            fade_out_frames: integer(a, "fadeOutFrames", 0, clip_length, 0)?,
            fade_in_curve: integer(a, "fadeInCurve", 0, 4, 0)? as i32,
            fade_out_curve: integer(a, "fadeOutCurve", 0, 4, 0)? as i32,
        });
    }
    Ok(t)
}

/// A complete timeline (`project.set` / `render.wav`). `blob` is the request's binary frame.
pub fn parse_timeline(value: &Json, blob: &[u8]) -> Result<Plan, Error> {
    let mut p = parse_header(value)?;
    let tracks = value.get("tracks").and_then(Json::as_array).filter(|t| t.len() <= 256);
    let tracks = tracks.ok_or_else(|| err("Invalid track count"))?;
    let (mut notes, mut audio) = (0usize, 0usize);
    for item in tracks {
        let mut present = TrackFields::default();
        let t = parse_track(item, &p, blob, &mut present)?;
        if !present.notes || !present.audio {
            return Err(err("A timeline track needs notes and audio"));
        }
        notes += t.notes.len();
        audio += t.audio.len();
        if notes > 100_000 || audio > 8192 {
            return Err(err("Timeline event limit exceeded"));
        }
        p.tracks.push(t);
    }
    Ok(p)
}

/// `project.patch`: the next timeline from `current` (protocol.hpp `patchTimeline`).
pub fn parse_patch(current: &Plan, value: &Json, blob: &[u8]) -> Result<Plan, Error> {
    let mut p = parse_header(value.get("header").ok_or_else(|| err("Missing patch header"))?)?;
    if p.project_id != current.project_id || p.sample_rate != current.sample_rate {
        return Err(err("A patch must target the current project; send project.set"));
    }
    p.revision = integer(value, "revision", 0, 9_007_199_254_740_991, 0)? as u64;
    let order = value.get("order").and_then(Json::as_array);
    let changed = value.get("tracks").and_then(Json::as_array);
    let (Some(order), Some(changed)) = (order, changed) else { return Err(err("Invalid track patch")) };
    if order.len() > 256 || changed.len() > order.len() {
        return Err(err("Invalid track patch"));
    }
    let mut patched: BTreeMap<String, &Json> = BTreeMap::new();
    for item in changed {
        if patched.insert(id_string(item, "id")?, item).is_some() {
            return Err(err("Duplicate patched track"));
        }
    }
    let (mut notes, mut audio) = (0usize, 0usize);
    for entry in order {
        let id = entry.as_str().ok_or_else(|| err("Invalid track order"))?;
        let before = current.tracks.iter().find(|t| t.id == id);
        match patched.remove(id) {
            None => p.tracks.push(before.ok_or_else(|| err("Patch order names an unknown track"))?.clone()),
            Some(item) => {
                let mut present = TrackFields::default();
                let mut t = parse_track(item, &p, blob, &mut present)?;
                match before {
                    None if !present.notes || !present.audio => {
                        return Err(err("A new track needs notes and audio"));
                    }
                    None => {}
                    Some(b) => {
                        if !present.notes {
                            t.notes = b.notes.clone();
                        }
                        if !present.controls {
                            t.controls = b.controls.clone();
                        }
                        if !present.audio {
                            t.audio = b.audio.clone();
                        }
                        if !present.automation {
                            t.automation = b.automation.clone();
                        }
                    }
                }
                p.tracks.push(t);
            }
        }
        if let Some(t) = p.tracks.last() {
            notes += t.notes.len();
            audio += t.audio.len();
        }
        if notes > 100_000 || audio > 8192 {
            return Err(err("Timeline event limit exceeded"));
        }
    }
    if !patched.is_empty() {
        return Err(err("A patched track is missing from the order"));
    }
    Ok(p)
}

/// Parses `text` as JSON and then as a timeline (convenience for hosts).
pub fn timeline_from_bytes(text: &[u8], blob: &[u8]) -> Result<Plan, Error> {
    parse_timeline(&Json::parse(text)?, blob)
}

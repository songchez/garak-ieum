//! The render plan: the engine's input data model, field for field the C++ `ProjectTimeline`
//! (native/include/garak/engine.hpp) that the renderer's `NativeTimelineCompiler` produces
//! (docs/RENDER_DIFF_PROTOCOL.md 1). Frames are project frames at the engine rate; the TS
//! compiler has already applied the tempo map to every note, window, automation point and cycle.

use alloc::string::String;
use alloc::vec::Vec;

/// One tempo change (docs/TEMPO_MAP.md). `ramp`: the tempo moves linearly in beats to the next.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TempoPoint {
    pub beat: f64,
    pub bpm: f64,
    pub ramp: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceKind {
    Audio,
    BuiltinSynth,
    BuiltinSampled,
    Vst3,
    NativeWavetable,
}

/// The track's sound source. Only `Audio` renders in this milestone (instruments: later stages,
/// docs/RUST_ENGINE.md 6); the other fields are kept so diffs can compare identities.
#[derive(Clone, Debug, PartialEq)]
pub struct Source {
    pub kind: SourceKind,
    pub instrument_id: String,
    pub sample_set_id: String,
    pub is_kit: bool,
    pub params: Vec<(String, f64)>,
    /// VST3 instance id (identity only; VST3 processing stays in the C++ host).
    pub plugin_instance: String,
    /// Raw IEUM WAVE patch (base64 text as received).
    pub patch: String,
}

impl Default for Source {
    fn default() -> Self {
        Self {
            kind: SourceKind::Audio,
            instrument_id: String::new(),
            sample_set_id: String::new(),
            is_kit: false,
            params: Vec::new(),
            plugin_instance: String::new(),
            patch: String::new(),
        }
    }
}

/// One insert of a track's chain: a built-in effect type id ("eq", "reverb", ...) or "vst3".
#[derive(Clone, Debug, PartialEq)]
pub struct InsertPlan {
    pub id: String,
    pub kind: String,
    pub enabled: bool,
    /// Parameter map in the order received (keys are unique per protocol.hpp's std::map).
    pub params: Vec<(String, f64)>,
    pub plugin_instance: String,
}

impl InsertPlan {
    pub fn param(&self, id: &str) -> Option<f64> {
        self.params.iter().find(|(k, _)| k == id).map(|(_, v)| *v)
    }
}

/// Aux send into a return track (docs/SENDS_RETURNS.md).
#[derive(Clone, Debug, PartialEq)]
pub struct SendPlan {
    pub return_id: String,
    pub gain: f32,
    pub pre: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteKind {
    None,
    Track,
    Master,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteTap {
    PreFx,
    PostFx,
    PostFader,
}

/// Internal recording/monitoring input (docs/TRACK_INPUT_ROUTING.md). Parsed and compared; it is
/// only audible while monitoring, which the offline slice never does.
#[derive(Clone, Debug, PartialEq)]
pub struct RoutePlan {
    pub kind: RouteKind,
    pub track_id: String,
    pub tap: RouteTap,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Note {
    pub id: i32,
    pub on_frame: i64,
    pub off_frame: i64,
    pub limit_frame: i64,
    pub pitch: i32,
    pub velocity: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ControlEvent {
    pub frame: i64,
    pub controller: u16,
    pub value: i32,
}

/// One audio region window (C++ `AudioWindow`).
#[derive(Clone, Debug, PartialEq)]
pub struct AudioWindow {
    pub id: i32,
    pub asset_id: String,
    pub start_frame: i64,
    pub end_frame: i64,
    pub source_start_frame: f64,
    pub source_sample_rate: f64,
    pub clip_offset_frames: i64,
    pub clip_length_frames: i64,
    pub gain: f32,
    pub fade_in_frames: i64,
    pub fade_out_frames: i64,
    /// 0 linear, 1 equal power, 2 S-curve, 3 exponential, 4 logarithmic (clipEnvelope.ts).
    pub fade_in_curve: i32,
    pub fade_out_curve: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaneTarget {
    Volume,
    Pan,
    Mute,
    Insert,
    Instrument,
    Send,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AutomationPoint {
    pub frame: f64,
    pub value: f64,
    pub curve: f64,
}

/// Track automation lane (docs/AUTOMATION.md): normalized points mapped into the target's range.
#[derive(Clone, Debug, PartialEq)]
pub struct AutomationLane {
    pub target: LaneTarget,
    pub insert_id: String,
    pub param: String,
    pub return_id: String,
    pub minimum: f64,
    pub maximum: f64,
    pub logarithmic: bool,
    pub options: Vec<f64>,
    pub points: Vec<AutomationPoint>,
}

/// One track (C++ `TrackTimeline`).
#[derive(Clone, Debug, PartialEq)]
pub struct TrackPlan {
    pub id: String,
    pub is_return: bool,
    pub sends: Vec<SendPlan>,
    pub source: Source,
    /// Physical input channels (monitoring only; ignored offline).
    pub input: Option<[i16; 2]>,
    pub route: Option<RoutePlan>,
    pub gain: f32,
    pub pan: f32,
    pub enabled: bool,
    pub mute: bool,
    pub solo: bool,
    pub solo_safe: bool,
    pub audible: bool,
    pub unmuted_audible: bool,
    pub inserts: Vec<InsertPlan>,
    pub notes: Vec<Note>,
    pub controls: Vec<ControlEvent>,
    pub audio: Vec<AudioWindow>,
    pub automation: Vec<AutomationLane>,
}

impl Default for TrackPlan {
    fn default() -> Self {
        Self {
            id: String::new(),
            is_return: false,
            sends: Vec::new(),
            source: Source::default(),
            input: None,
            route: None,
            gain: 1.0,
            pan: 0.0,
            enabled: true,
            mute: false,
            solo: false,
            solo_safe: false,
            audible: true,
            unmuted_audible: true,
            inserts: Vec::new(),
            notes: Vec::new(),
            controls: Vec::new(),
            audio: Vec::new(),
            automation: Vec::new(),
        }
    }
}

/// The whole project (C++ `ProjectTimeline`).
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub project_id: String,
    pub revision: u64,
    pub sample_rate: u32,
    pub bpm: f64,
    pub beats_per_bar: f64,
    /// Empty = constant `bpm` (a parsed map with fewer than two points is dropped, like the host).
    pub tempo_map: Vec<TempoPoint>,
    pub time_sig_numerator: i32,
    pub time_sig_denominator: i32,
    pub length_frames: i64,
    pub cycle: Option<(i64, i64)>,
    pub master_gain: f32,
    pub low_latency_monitoring: bool,
    pub tracks: Vec<TrackPlan>,
}

impl Default for Plan {
    fn default() -> Self {
        Self {
            project_id: String::new(),
            revision: 0,
            sample_rate: 48_000,
            bpm: 120.0,
            beats_per_bar: 4.0,
            tempo_map: Vec::new(),
            time_sig_numerator: 4,
            time_sig_denominator: 4,
            length_frames: 1,
            cycle: None,
            master_gain: 1.0,
            low_latency_monitoring: true,
            tracks: Vec::new(),
        }
    }
}

impl Plan {
    /// Header fields every track's frames or the transport depend on (sameTiming in engine.cpp).
    pub fn same_timing(&self, other: &Plan) -> bool {
        self.bpm == other.bpm
            && self.beats_per_bar == other.beats_per_bar
            && self.time_sig_numerator == other.time_sig_numerator
            && self.time_sig_denominator == other.time_sig_denominator
            && self.length_frames == other.length_frames
            && self.cycle == other.cycle
            && self.tempo_map == other.tempo_map
    }
}

/// Registered PCM (C++ `PcmAsset`): interleaved, immutable once registered.
#[derive(Clone, Debug, PartialEq)]
pub struct PcmAsset {
    pub sample_rate: u32,
    pub channels: u32,
    pub samples: Vec<f32>,
}

impl PcmAsset {
    pub fn frames(&self) -> u64 {
        if self.channels == 0 { 0 } else { (self.samples.len() / self.channels as usize) as u64 }
    }
}

/// One zone of a registered sample set (C++ `SampleZone`).
#[derive(Clone, Debug, PartialEq)]
pub struct SampleZone {
    pub asset_id: String,
    pub root: i32,
    pub lo: i32,
    pub hi: i32,
    pub vlo: f64,
    pub vhi: f64,
    pub gain_db: f64,
    pub tune: f64,
    /// Loop in seconds, before the codec start offset.
    pub looped: Option<[f64; 2]>,
    pub choke: i32,
}

/// A registered sample instrument or kit (C++ `SampleSet`, the host's `samples.register`):
/// zones and release ("damper") zones over PCM registered with `put_asset`.
#[derive(Clone, Debug, PartialEq)]
pub struct SampleSet {
    pub id: String,
    pub is_kit: bool,
    pub gain_db: f64,
    pub release: f64,
    pub start_offset: f64,
    pub zones: Vec<SampleZone>,
    pub release_zones: Vec<SampleZone>,
}

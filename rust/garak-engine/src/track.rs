//! One track at runtime (engine.cpp `TrackRuntime`) and its control-thread construction
//! (`buildTrack` + `prepareAutomation`): windows (frozen ones included) -> the source (a built-in instrument,
//! instrument.rs, or a host source: VST3 / IEUM WAVE through the host callback) -> monitored input (device
//! input, route input or a return's send mix) -> inserts (built-in or host VST3) -> plug-in delay
//! compensation -> fader/pan/mute (smoothed or automated per sample) -> output delay, with the pre-FX,
//! post-FX and post-fader taps sends and routes read.

use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::sync::Arc;
use alloc::vec;
use alloc::vec::Vec;

use crate::automation;
use crate::clip::Window;
use crate::delay::CompensationDelay;
use crate::error::{Error, require};
use crate::external::{Io, Stage};
use crate::insert::{Insert, KernelCache, estimate_memory, widens};
use crate::instrument::{self, Cursors, RemovedNote, Source};
use crate::math;
use crate::plan::{
    AutomationLane, HostNode, LaneTarget, PcmAsset, Plan, RouteKind, RouteTap, SampleSet, SourceKind,
    TrackPlan,
};

/// Live note and controller events for a track (docs/RUST_ENGINE.md 5.7): what live MIDI, the computer
/// keyboard and note previews send while the engine plays. Instrument tracks consume them; audio tracks
/// ignore them (`Track::live_event` returns false).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LiveEvent {
    /// Rings until its note-off (`id` matches it; ids < 0 match by pitch).
    NoteOn {
        pitch: u8,
        velocity: f32,
        id: i32,
    },
    NoteOff {
        pitch: u8,
        id: i32,
    },
    /// An editor audition note of `frames` frames (C++ `previewNote`).
    Preview {
        pitch: u8,
        velocity: f32,
        frames: u32,
    },
    AllNotesOff,
    Control {
        controller: u16,
        value: i32,
    },
}

impl LiveEvent {
    /// The ranges the C++ engine accepts (`noteOn`, `previewNote`, `controlChange`).
    pub fn is_valid(&self) -> bool {
        match *self {
            LiveEvent::NoteOn { pitch, velocity, .. } => pitch <= 127 && (0.0..=2.0).contains(&velocity),
            LiveEvent::Preview { pitch, velocity, frames } => {
                pitch <= 127 && (0.0..=2.0).contains(&velocity) && frames > 0
            }
            LiveEvent::NoteOff { pitch, .. } => pitch <= 127,
            LiveEvent::Control { controller, value } => {
                instrument::valid_controller_value(i32::from(controller), value)
            }
            LiveEvent::AllNotesOff => true,
        }
    }

    /// The C form (`GarakRsLiveEvent`, garak_engine.h): `kind` 0 note on (`a` = note id), 1 note off (`a` = note
    /// id), 2 all notes off, 3 controller (`pitch` = controller number, `a` = value), 4 preview (`a` = frames).
    pub fn encode(self, offset: u32) -> TimedLiveEvent {
        let (kind, pitch, a, velocity) = match self {
            LiveEvent::NoteOn { pitch, velocity, id } => (0, i32::from(pitch), id, velocity),
            LiveEvent::NoteOff { pitch, id } => (1, i32::from(pitch), id, 0.0),
            LiveEvent::AllNotesOff => (2, 0, 0, 0.0),
            LiveEvent::Control { controller, value } => (3, i32::from(controller), value, 0.0),
            LiveEvent::Preview { pitch, velocity, frames } => {
                (4, i32::from(pitch), i32::try_from(frames).unwrap_or(i32::MAX), velocity)
            }
        };
        TimedLiveEvent { offset, kind, pitch, a, velocity }
    }

    /// The event of a C form (`encode`), or None for an unknown kind or a field out of its type's range
    /// (`is_valid` checks the musical ranges).
    pub fn decode(kind: u32, pitch: i32, a: i32, velocity: f32) -> Option<LiveEvent> {
        let note = u8::try_from(pitch).ok();
        Some(match kind {
            0 => LiveEvent::NoteOn { pitch: note?, velocity, id: a },
            1 => LiveEvent::NoteOff { pitch: note?, id: a },
            2 => LiveEvent::AllNotesOff,
            3 => LiveEvent::Control { controller: u16::try_from(pitch).ok()?, value: a },
            4 => LiveEvent::Preview { pitch: note?, velocity, frames: u32::try_from(a).ok()? },
            _ => return None,
        })
    }
}

/// Live events one track holds for its coming blocks (docs/RUST_ENGINE.md 5.8); a full queue refuses more.
pub const LIVE_QUEUE: usize = 128;
/// The latest a live event may be scheduled: frames after the start of the next render call.
pub const MAX_LIVE_OFFSET: u32 = 1 << 16;

/// A live event with its frame offset, in the C layout (`GarakRsLiveEvent` in garak_engine.h): what a track's
/// queue holds and what a host node receives. `offset` counts frames from the start of the next render call
/// (queued) or of the block (host callback).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TimedLiveEvent {
    pub offset: u32,
    pub kind: u32,
    pub pitch: i32,
    pub a: i32,
    pub velocity: f32,
}

impl TimedLiveEvent {
    pub fn event(&self) -> Option<LiveEvent> {
        LiveEvent::decode(self.kind, self.pitch, self.a, self.velocity)
    }
}

/// A track's pending live events, sorted by offset (equal offsets keep arrival order). Fixed storage, allocated
/// with the track on the control thread (on the heap: the worklet's stack is 64 KiB): queueing, rendering and
/// dropping events never allocate, and a successor takes the queue by swapping the pointer.
#[derive(Clone, Debug)]
pub(crate) struct LiveQueue {
    events: Box<[TimedLiveEvent]>,
    len: usize,
}

impl Default for LiveQueue {
    fn default() -> Self {
        Self { events: vec![TimedLiveEvent::default(); LIVE_QUEUE].into_boxed_slice(), len: 0 }
    }
}

impl LiveQueue {
    /// Queues `e` after every queued event at or before its offset. False when full.
    pub fn push(&mut self, e: TimedLiveEvent) -> bool {
        let len = self.len;
        let Some(queued) = self.events.get_mut(..=len) else { return false };
        let at = queued.get(..len).map_or(0, |q| q.partition_point(|x| x.offset <= e.offset));
        queued.copy_within(at..len, at + 1);
        if let Some(slot) = queued.get_mut(at) {
            *slot = e;
        }
        self.len += 1;
        true
    }

    /// The events due in a block of `count` frames (offset < count), in order.
    pub fn due(&self, count: u32) -> &[TimedLiveEvent] {
        let queued = self.events.get(..self.len).unwrap_or(&[]);
        queued.get(..queued.partition_point(|x| x.offset < count)).unwrap_or(&[])
    }

    /// After a block of `count` frames: its events are done, the rest move `count` frames closer.
    pub fn advance(&mut self, count: u32) {
        if self.len == 0 {
            return;
        }
        let due = self.due(count).len();
        self.events.copy_within(due..self.len, 0);
        self.len -= due;
        for e in self.events.iter_mut().take(self.len) {
            e.offset -= count;
        }
    }

    pub fn len(&self) -> usize {
        self.len
    }
}

/// Built-in insert parameters follow automation every 32 frames, then glide (engine.cpp).
pub(crate) const AUTOMATION_CHUNK: u32 = 32;

/// One prepared automation lane: what it drives in this graph, resolved once.
#[derive(Debug, Clone, Copy)]
pub(crate) struct LaneRuntime {
    /// Index in `TrackPlan::automation`.
    pub lane: usize,
    pub insert: Option<usize>,
    pub control: Option<usize>,
    /// Built-in instrument parameter (garak-dsp `SYNTH_FIELDS` index).
    pub synth_field: Option<usize>,
    /// Vintage instrument parameter (catalog index).
    pub vintage_param: Option<usize>,
    pub hint: usize,
}

/// One send feeding a return (owned by the return; engine.cpp `TrackRuntime::Feed`).
#[derive(Debug, Clone, Copy)]
pub(crate) struct Feed {
    pub sender: usize,
    pub pre: bool,
    pub target: f32,
    pub gain: f64,
    /// The sender's Send automation lane for this return (index in its plan's automation).
    pub lane: Option<usize>,
    pub hint: usize,
}

/// Control-thread facts about a built track (engine.cpp `ControlTrack`).
#[derive(Debug, Clone, Default)]
pub(crate) struct TrackInfo {
    pub latency: u32,
    pub tail: f64,
    pub memory: usize,
    /// Identities of the resolved PCM (a re-registered asset under the same id rebuilds the track):
    /// sample zones, then release zones, then windows (engine.cpp resolution order).
    pub assets: Vec<usize>,
    /// The sample set the track resolved (a re-registered set rebuilds it).
    pub set: Option<Arc<SampleSet>>,
    /// The instrument's own tail (IEUM WAVE: a rebuilt track that keeps its processor reuses it).
    pub instrument_tail: f64,
}

#[derive(Debug)]
pub(crate) struct Track {
    pub plan: TrackPlan,
    /// Index in the graph (the host callbacks name tracks by it).
    pub index: usize,
    pub windows: Vec<Window>,
    pub inserts: Vec<Stage>,
    /// The host renders this track's instrument (VST3, IEUM WAVE).
    host_source: Option<HostNode>,
    pub lanes: Vec<LaneRuntime>,
    volume_lane: Option<usize>,
    pan_lane: Option<usize>,
    mute_lane: Option<usize>,
    pub latency: u32,
    pub compensation: CompensationDelay,
    pub output_delay: CompensationDelay,
    pub buffer: Vec<f32>,
    pub pre_tap: Vec<f32>,
    pub post_tap: Vec<f32>,
    pub fader_tap: Vec<f32>,
    pub return_input: Vec<f32>,
    pub feeds: Vec<Feed>,
    pub fader: f64,
    pub pan_value: f64,
    pub mute_gain: f64,
    pub peak: f32,
    stereo_source: bool,
    stereo_effects: bool,
    pub is_return: bool,
    sample_rate: f64,
    project_length: i64,
    low_latency: bool,
    /// Track-input routing (docs/TRACK_INPUT_ROUTING.md), resolved by the graph (engine.cpp `prepareRoutes`).
    /// `route_input` exists only on routed tracks and is filled every block (recordings read it).
    pub routed: bool,
    pub route_kind: RouteKind,
    pub route_tap: RouteTap,
    pub route_source: Option<usize>,
    pub in_master_feed: bool,
    pub route_input: Vec<f32>,
    pub output_delay_frames: u32,
    /// Continuation (filled on the control thread, consumed by `adopt`): per runtime insert, the
    /// predecessor's runtime insert with the same id and type.
    pub insert_origin: Vec<Option<usize>>,
    pub predecessor: Option<usize>,
    /// Same events, source and enabled flag as the predecessor: cursors carry over.
    pub identical: bool,
    /// Same instrument identity: voices, samples, controllers and live notes carry over.
    pub same_source: bool,
    /// Predecessor notes absent here: released if sounding.
    pub removed: Vec<RemovedNote>,
    /// The instrument (or `Audio`).
    pub source: Source,
    pub cursors: Cursors,
    /// Constant tempo (IEUM WAVE LFO sync without a tempo map).
    bpm: f64,
    /// Voice / event overflows (diagnostics).
    pub overflows: u64,
    /// Live events for the coming blocks, at their sample offsets (`queue_live`).
    live: LiveQueue,
}

/// Value of a lane (in its units) at a project frame.
#[inline]
fn lane_value(plans: &[AutomationLane], l: &mut LaneRuntime, frame: f64) -> f64 {
    match plans.get(l.lane) {
        Some(lane) => automation::value(lane, automation::evaluate(lane, frame, &mut l.hint)),
        None => 0.0,
    }
}

fn resolve_asset(assets: &BTreeMap<String, Arc<PcmAsset>>, id: &str) -> Result<Arc<PcmAsset>, Error> {
    let a = assets.get(id).ok_or_else(|| Error::new("Native PCM asset is not registered"))?;
    require(
        (1..=32).contains(&a.channels) && (8000..=192_000).contains(&a.sample_rate),
        "Invalid native PCM asset format",
    )?;
    require(
        !a.samples.is_empty() && a.samples.len().is_multiple_of(a.channels as usize),
        "Invalid native PCM asset length",
    )?;
    Ok(a.clone())
}

fn checked(value: f64, minimum: f64, maximum: f64, message: &str) -> Result<f64, Error> {
    require(value.is_finite() && value >= minimum && value <= maximum, message)?;
    Ok(value)
}

impl Track {
    /// engine.cpp `buildTrack` for audio-source tracks. Control thread.
    pub fn build(
        p: &Plan,
        t: &TrackPlan,
        assets: &BTreeMap<String, Arc<PcmAsset>>,
        max_block: u32,
        sets: &BTreeMap<String, Arc<SampleSet>>,
        cache: &mut KernelCache,
        wave: &mut crate::wave::WaveCache,
        reuse: Option<f64>,
    ) -> Result<(Track, TrackInfo), Error> {
        let mut info = TrackInfo::default();
        require(
            !t.is_return
                || (t.source.kind == SourceKind::Audio
                    && t.notes.is_empty()
                    && t.audio.is_empty()
                    && t.sends.is_empty()),
            "Return tracks are audio buses without events or sends",
        )?;
        require(t.sends.len() <= 256, "Native track exceeds send limit")?;
        for s in &t.sends {
            checked(f64::from(s.gain), 0.0, 4.0, "Invalid native send gain")?;
        }
        checked(f64::from(t.gain), 0.0, 2.0, "Invalid native track gain")?;
        checked(f64::from(t.pan), -1.0, 1.0, "Invalid native pan")?;
        require(
            t.source.kind != SourceKind::Audio || t.notes.is_empty(),
            "Audio tracks cannot contain instrument notes",
        )?;
        require(
            t.source.kind == SourceKind::Audio || t.audio.is_empty(),
            "Instrument tracks cannot contain audio windows",
        )?;
        let sample_rate = f64::from(p.sample_rate);
        let mut track = Track {
            plan: t.clone(),
            windows: Vec::new(),
            index: 0,
            inserts: Vec::new(),
            host_source: None,
            lanes: Vec::new(),
            volume_lane: None,
            pan_lane: None,
            mute_lane: None,
            latency: 0,
            compensation: CompensationDelay::default(),
            output_delay: CompensationDelay::default(),
            buffer: vec![0.0; max_block as usize * 2],
            pre_tap: Vec::new(),
            post_tap: Vec::new(),
            fader_tap: Vec::new(),
            return_input: Vec::new(),
            feeds: Vec::new(),
            fader: if t.audible { f64::from(t.gain) } else { 0.0 },
            pan_value: f64::from(t.pan),
            mute_gain: 1.0,
            peak: 0.0,
            stereo_source: false,
            stereo_effects: false,
            is_return: t.is_return,
            sample_rate,
            project_length: p.length_frames,
            low_latency: p.low_latency_monitoring,
            routed: false,
            route_kind: RouteKind::None,
            route_tap: RouteTap::PostFx,
            route_source: None,
            in_master_feed: true,
            route_input: Vec::new(),
            output_delay_frames: 0,
            insert_origin: Vec::new(),
            predecessor: None,
            identical: false,
            same_source: false,
            removed: Vec::new(),
            source: Source::Audio,
            cursors: Cursors::default(),
            bpm: p.bpm,
            overflows: 0,
            live: LiveQueue::default(),
        };
        // A host-rendered source (the plan carries its node) needs no instrument here.
        let hosted = if t.source.kind == SourceKind::Audio { None } else { t.source.host };
        let mut built = match hosted {
            Some(_) => instrument::Built::default(),
            None => instrument::build(p, &mut track.plan, assets, sets, max_block, wave, reuse)?,
        };
        track.source = core::mem::take(&mut built.source);
        // A disabled source needs neither its PCM nor its effects.
        if !t.enabled {
            return Ok((track, info));
        }
        for e in t.inserts.iter().filter(|e| e.enabled) {
            info.memory += estimate_memory(&e.kind, sample_rate);
        }
        let mut tail = built.tail;
        if let Some(host) = hosted {
            // Instruments the host renders (VST3, IEUM WAVE on the desktop, built-in instruments with
            // GARAK_RUST_ENGINE_HOST_INSTRUMENTS): its processor's delay and tail come with the plan.
            require(
                f64::from(host.latency) <= sample_rate * 30.0,
                "Plugin latency exceeds native memory budget",
            )?;
            track.host_source = Some(host);
            track.latency = host.latency;
            track.stereo_source = host.stereo;
            tail = host.tail;
        } else {
            track.stereo_source |= built.stereo;
            info.assets = built.assets;
            info.set = built.set;
            info.instrument_tail = built.instrument_tail;
        }
        for w in &t.audio {
            require(
                w.start_frame >= 0
                    && w.end_frame > w.start_frame
                    && (w.end_frame <= p.length_frames || w.freeze)
                    && w.clip_length_frames > 0
                    && w.clip_offset_frames >= 0
                    && w.fade_in_frames >= 0
                    && w.fade_out_frames >= 0
                    && (0..=4).contains(&w.fade_in_curve)
                    && (0..=4).contains(&w.fade_out_curve),
                "Invalid native audio window",
            )?;
            checked(f64::from(w.gain), 0.0, 16.0, "Invalid audio window gain")?;
            checked(w.source_start_frame, 0.0, 1e15, "Invalid audio source offset")?;
            checked(w.source_sample_rate, 8000.0, 192_000.0, "Invalid source sample rate")?;
            let asset = resolve_asset(assets, &w.asset_id)?;
            require(
                w.source_sample_rate == f64::from(asset.sample_rate)
                    && w.source_start_frame < asset.frames() as f64,
                "Audio window does not match registered PCM",
            )?;
            track.stereo_source |= asset.channels > 1;
            // A frozen render already carries its track's release and effect tails: the window states that tail.
            if w.freeze {
                tail = math::std_max(tail, w.tail_seconds);
            }
            info.assets.push(Arc::as_ptr(&asset) as usize);
            track.windows.push(Window { w: w.clone(), asset });
        }
        // Stable: equal starts keep plan order (the C++ std::stable_sort).
        track.windows.sort_by_key(|w| w.w.start_frame);
        let mut ids: Vec<&str> = Vec::new();
        for (index, e) in t.inserts.iter().enumerate() {
            require(!e.id.is_empty() && !ids.contains(&e.id.as_str()), "Duplicate native insert ID")?;
            ids.push(&e.id);
            if !e.enabled {
                continue;
            }
            let insert = if e.kind == "vst3" {
                // The host processes the plug-in (docs/RUST_ENGINE.md 4) and reported its delay and tail.
                let Some(host) = e.host else {
                    return Err(Error::new("VST3 inserts need the desktop host's plug-in callback"));
                };
                track.stereo_effects = true;
                Stage::Host { source: index as u16, latency: host.latency, tail: host.tail }
            } else {
                track.stereo_effects |= widens(e);
                Stage::Fx(Box::new(Insert::new(e, index as u16, sample_rate, p.bpm, cache)?))
            };
            track.latency += insert.latency();
            tail += insert.tail();
            require(
                f64::from(track.latency) <= sample_rate * 30.0,
                "Plugin latency exceeds native memory budget",
            )?;
            track.inserts.push(insert);
        }
        track.prepare_automation()?;
        info.tail = tail;
        info.latency = track.latency;
        Ok((track, info))
    }

    /// engine.cpp `prepareAutomation`: validate lanes, bind each to what it drives here. Lanes
    /// whose target is absent (disabled insert, unknown parameter) are ignored.
    fn prepare_automation(&mut self) -> Result<(), Error> {
        require(self.plan.automation.len() <= 256, "Too many automation lanes")?;
        for (index, lane) in self.plan.automation.iter().enumerate() {
            require(lane.points.len() <= 20_000, "Too many automation points")?;
            let mut previous = -1.0;
            for point in &lane.points {
                require(
                    point.frame.is_finite()
                        && point.frame >= 0.0
                        && point.frame >= previous
                        && (0.0..=1.0).contains(&point.value)
                        && (-1.0..=1.0).contains(&point.curve),
                    "Invalid automation point",
                )?;
                previous = point.frame;
            }
            require(
                lane.minimum.is_finite()
                    && lane.maximum.is_finite()
                    && (!lane.logarithmic || (lane.minimum > 0.0 && lane.maximum > 0.0)),
                "Invalid automation range",
            )?;
            if lane.points.is_empty() {
                continue;
            }
            let mut l = LaneRuntime {
                lane: index,
                insert: None,
                control: None,
                synth_field: None,
                vintage_param: None,
                hint: 0,
            };
            match lane.target {
                LaneTarget::Volume => self.volume_lane = Some(self.lanes.len()),
                LaneTarget::Pan => self.pan_lane = Some(self.lanes.len()),
                LaneTarget::Mute => self.mute_lane = Some(self.lanes.len()),
                // Send lanes are evaluated by the fed return.
                LaneTarget::Send => continue,
                LaneTarget::Instrument => {
                    match &self.source {
                        Source::Vintage(_) => l.vintage_param = self.source.vintage_param(&lane.param),
                        Source::Builtin(_) => {
                            l.synth_field = garak_dsp::instruments::builtin::Synth::field_index(&lane.param)
                        }
                        Source::Audio => {}
                    }
                    if l.synth_field.is_none() && l.vintage_param.is_none() {
                        continue;
                    }
                }
                LaneTarget::Insert => {
                    let Some(source) = self.plan.inserts.iter().position(|e| e.id == lane.insert_id) else {
                        continue;
                    };
                    let Some(runtime) = self.inserts.iter().position(|i| usize::from(i.source()) == source)
                    else {
                        continue;
                    };
                    // A host VST3 insert takes its automation as parameter events from the host.
                    let Some(insert) = self.inserts.get_mut(runtime).and_then(Stage::fx_mut) else {
                        continue;
                    };
                    let Some(control) = insert.param_index(&lane.param) else { continue };
                    insert.automated = true;
                    l.insert = Some(runtime);
                    l.control = Some(control);
                }
            }
            self.lanes.push(l);
        }
        Ok(())
    }

    /// engine.cpp `TrackRuntime::reset`: voices off, controllers chased at `frame` (`chase`) or
    /// returned to rest, cursors at `frame`, sounding notes restarted (`chase`); effect state and
    /// the PDC line when `effects` (seek, stop, a new graph).
    pub fn reset(&mut self, frame: i64, chase: bool, effects: bool) {
        let mut overflows = 0;
        self.source.reset(&self.plan, &mut self.cursors, frame, chase, self.sample_rate, &mut overflows);
        if effects {
            for i in &mut self.inserts {
                i.reset();
            }
            self.compensation.reset();
        }
        self.overflows += overflows;
    }

    /// The transport stopped at the project end (engine.cpp `requestReset` of plug-in instruments).
    pub fn request_instrument_reset(&mut self) {
        self.source.request_reset();
    }

    /// engine.cpp `TrackRuntime::adopt`: continue from `previous` (the same track id) at a block
    /// boundary at project frame `frame`. `same_events`: cursors carry over unchanged; otherwise
    /// they are recomputed at `frame` and the predecessor's removed notes release. `routing`: a
    /// single-track replacement keeps the graph, so the graph-derived send state moves too.
    /// Audio thread: swaps and copies only.
    pub fn adopt(&mut self, previous: &mut Track, frame: i64, same_events: bool, routing: bool) {
        self.peak = previous.peak;
        self.fader = previous.fader;
        self.pan_value = previous.pan_value;
        self.mute_gain = previous.mute_gain;
        if self.same_source {
            self.source.take_from(&mut previous.source);
        }
        // Live events still waiting for their offset play on the successor.
        if previous.live.len() > 0 {
            core::mem::swap(&mut self.live, &mut previous.live);
        }
        for (i, origin) in self.insert_origin.iter().enumerate() {
            let (Some(from), Some(insert)) = (origin, self.inserts.get_mut(i)) else { continue };
            if let Some(old) = previous.inserts.get_mut(*from) {
                insert.take_state_from(old);
            }
        }
        self.compensation.take_state_from(&mut previous.compensation);
        self.output_delay.take_state_from(&mut previous.output_delay);
        if routing {
            self.is_return = previous.is_return;
            self.index = previous.index;
            self.routed = previous.routed;
            self.route_kind = previous.route_kind;
            self.route_tap = previous.route_tap;
            self.route_source = previous.route_source;
            self.in_master_feed = previous.in_master_feed;
            self.output_delay_frames = previous.output_delay_frames;
            core::mem::swap(&mut self.pre_tap, &mut previous.pre_tap);
            core::mem::swap(&mut self.route_input, &mut previous.route_input);
            core::mem::swap(&mut self.post_tap, &mut previous.post_tap);
            core::mem::swap(&mut self.fader_tap, &mut previous.fader_tap);
            core::mem::swap(&mut self.return_input, &mut previous.return_input);
            core::mem::swap(&mut self.feeds, &mut previous.feeds);
        } else {
            for f in &mut self.feeds {
                if let Some(o) = previous.feeds.iter().find(|o| o.sender == f.sender && o.pre == f.pre) {
                    f.gain = o.gain;
                }
            }
        }
        if same_events {
            self.cursors = previous.cursors;
            return;
        }
        self.source.seek_cursors(&self.plan, &mut self.cursors, frame);
        self.source.release_removed(&self.plan, &self.removed, frame, self.sample_rate);
    }

    /// A live event `offset` frames after the start of this track's next render (audio thread): a built-in
    /// instrument plays it at that sample (the source renders up to it, takes the event, renders on), a host
    /// node (VST3, IEUM WAVE on the desktop) receives it with that offset through the host's `live` callback.
    /// Returns false for tracks that play no live events (audio tracks, returns) and when the queue is full.
    pub fn queue_live(&mut self, event: LiveEvent, offset: u32) -> bool {
        if !self.source.is_instrument() && self.host_source.is_none() {
            return false;
        }
        // A block-start event with nothing waiting plays now, in command order: before a replacement, reset or
        // seek queued behind it, exactly like a block-boundary live event of the C++ engine.
        if offset == 0 && self.live.len() == 0 && self.source.is_instrument() {
            let mut overflows = 0;
            apply_live(&mut self.source, &self.plan, event, self.sample_rate, &mut overflows);
            self.overflows += overflows;
            return true;
        }
        self.live.push(event.encode(offset.min(MAX_LIVE_OFFSET)))
    }

    /// One block of `count` frames at project frame `frame` (engine.cpp `TrackRuntime::render`). The graph
    /// fills `return_input` (returns) and `route_input` (routed tracks) first. `tempo`: the tempo at the block
    /// start when the project has a tempo map (synced effects follow it). `io`: host callbacks, monitoring.
    pub fn render(&mut self, frame: i64, count: u32, playing: bool, tempo: Option<f64>, io: &Io) {
        let n = count as usize * 2;
        let index = self.index;
        let Track {
            plan,
            windows,
            inserts,
            lanes,
            buffer,
            pre_tap,
            post_tap,
            fader_tap,
            return_input,
            route_input,
            compensation,
            output_delay,
            source,
            cursors,
            live,
            ..
        } = self;
        let Some(buf) = buffer.get_mut(..n) else { return };
        buf.fill(0.0);
        if !plan.enabled {
            self.peak = 0.0;
            for tap in [pre_tap, post_tap, fader_tap] {
                if let Some(t) = tap.get_mut(..n) {
                    t.fill(0.0);
                }
            }
            // A disabled instrument still follows its live notes' ends and controllers (it plays nothing).
            let mut overflows = 0;
            for e in live.due(count) {
                if let Some(event) = e.event() {
                    apply_live(source, plan, event, self.sample_rate, &mut overflows);
                }
            }
            live.advance(count);
            self.overflows += overflows;
            return;
        }
        // Offline engines keep reading frozen windows after the project end: that part is the frozen tail.
        let freeze_tail = !playing && io.offline && frame >= self.project_length;
        if playing || freeze_tail {
            let end = frame + i64::from(count);
            for w in windows.iter() {
                if w.w.start_frame >= end {
                    break;
                }
                if w.w.end_frame <= frame || (freeze_tail && !w.w.freeze) {
                    continue;
                }
                w.render(buf, frame, count, self.sample_rate);
            }
        }
        if self.host_source.is_some()
            && let Some(host) = io.host
        {
            // The host node takes this block's live events at their sample offsets (VST3 `sampleOffset`).
            host.live(index, live.due(count));
            host.source(index, buf);
        }
        if source.is_instrument() {
            let at = frame as f64;
            for l in lanes.iter_mut() {
                if let Some(field) = l.synth_field {
                    let v = lane_value(&plan.automation, l, at);
                    if let Some(synth) = source.synth_mut() {
                        synth.set_field(field, v);
                    }
                }
            }
            for l in lanes.iter_mut() {
                if let Some(index) = l.vintage_param {
                    let v = lane_value(&plan.automation, l, at);
                    source.set_vintage_param(index, v);
                }
            }
            let mut overflows = 0;
            let bpm = tempo.unwrap_or(self.bpm);
            // Live events split the source's block at their offsets: each lands on its exact sample, with
            // the same voice code a block-start event uses (a block without live events renders in one piece).
            let mut cursor = 0u32;
            for e in live.due(count) {
                if e.offset > cursor
                    && let Some(part) = buf.get_mut(cursor as usize * 2..e.offset as usize * 2)
                {
                    source.render(
                        plan,
                        cursors,
                        part,
                        frame + i64::from(cursor),
                        e.offset - cursor,
                        playing,
                        self.project_length,
                        self.sample_rate,
                        bpm,
                        &mut overflows,
                    );
                    cursor = e.offset;
                }
                if let Some(event) = e.event() {
                    apply_live(source, plan, event, self.sample_rate, &mut overflows);
                }
            }
            if let Some(part) = buf.get_mut(cursor as usize * 2..n) {
                source.render(
                    plan,
                    cursors,
                    part,
                    frame + i64::from(cursor),
                    count - cursor,
                    playing,
                    self.project_length,
                    self.sample_rate,
                    bpm,
                    &mut overflows,
                );
            }
            self.overflows += overflows;
        }
        live.advance(count);
        // The monitored input: a return's send mix (always "monitored", stereo), a routed track's route input,
        // or the device input the host adds.
        let monitored = io.monitored(index);
        let (monitor, stereo_input) = if self.is_return {
            for (b, x) in buf.iter_mut().zip(return_input.iter()) {
                *b += *x;
            }
            (true, true)
        } else if self.routed {
            if monitored {
                for (b, x) in buf.iter_mut().zip(route_input.iter()) {
                    *b += *x;
                }
            }
            (monitored, monitored)
        } else if monitored {
            // The desktop host adds its device input; the browser host passes the input block instead.
            let stereo = match (io.host, io.input) {
                (Some(h), _) => h.input(index, buf),
                (None, Some(input)) => input.add(plan.input, buf),
                (None, None) => false,
            };
            (true, stereo)
        } else {
            (false, false)
        };
        if let Some(t) = pre_tap.get_mut(..n) {
            t.copy_from_slice(buf);
        }
        for (stage_index, stage) in inserts.iter_mut().enumerate() {
            let insert = match stage {
                Stage::Fx(insert) => insert,
                Stage::Host { source, .. } => {
                    if let Some(host) = io.host {
                        host.insert(index, *source, buf);
                    }
                    continue;
                }
            };
            if let Some(bpm) = tempo {
                insert.set_tempo(bpm);
            }
            if !insert.automated {
                insert.process(buf);
                continue;
            }
            let mut offset = 0u32;
            while offset < count {
                let chunk = AUTOMATION_CHUNK.min(count - offset);
                let at = (frame + i64::from(offset)) as f64;
                for l in lanes.iter_mut() {
                    if l.insert == Some(stage_index)
                        && let Some(control) = l.control
                    {
                        let v = lane_value(&plan.automation, l, at);
                        insert.set_param(control, v);
                    }
                }
                insert.commit();
                if let Some(part) = buf.get_mut(offset as usize * 2..(offset + chunk) as usize * 2) {
                    insert.process(part);
                }
                offset += chunk;
            }
        }
        // A reduced-latency monitor deliberately avoids waiting for unrelated tracks. A return's input is its
        // sends, never a live input: it always stays compensated.
        let low_latency_monitor = monitor && !self.is_return && playing && !io.offline && self.low_latency;
        if !low_latency_monitor {
            compensation.process(buf);
        }
        if let Some(t) = post_tap.get_mut(..n) {
            t.copy_from_slice(buf);
        }
        if plan.pre_fader {
            self.peak = pre_fader_output(buf, !(self.stereo_source || self.stereo_effects));
            if let Some(t) = fader_tap.get_mut(..n) {
                t.copy_from_slice(buf);
            }
            if !low_latency_monitor {
                output_delay.process(buf);
            }
            return;
        }
        let target_pan = f64::from(plan.pan);
        let target_gain = if plan.audible { f64::from(plan.gain) } else { 0.0 };
        let smoothing = math::smoothing(self.sample_rate, 0.012);
        let automated = self.volume_lane.is_some() || self.pan_lane.is_some() || self.mute_lane.is_some();
        let mute_smoothing = math::smoothing(self.sample_rate, 0.003);
        let mono = !(self.stereo_source || self.stereo_effects || (monitor && stereo_input));
        let mut peak = 0.0f32;
        let (mut fader, mut pan_value, mut mute_gain) = (self.fader, self.pan_value, self.mute_gain);
        // (pan bits, sin, cos) of the last pan law evaluated; NaN bits never match a pan.
        let mut law = (f64::NAN.to_bits() | 1, 0.0, 0.0);
        for (i, [lo, ro]) in buf.as_chunks_mut::<2>().0.iter_mut().enumerate() {
            let (gain, pan) = if !automated {
                fader = math::mul_add(target_gain - fader, smoothing, fader);
                pan_value = math::mul_add(target_pan - pan_value, smoothing, pan_value);
                (fader, pan_value)
            } else {
                let at = (frame + i as i64) as f64;
                let heard = if self.mute_lane.is_some() { plan.unmuted_audible } else { plan.audible };
                match self.volume_lane.and_then(|v| lanes.get_mut(v)) {
                    Some(l) => {
                        fader = if heard {
                            math::std_clamp(lane_value(&plan.automation, l, at), 0.0, 2.0)
                        } else {
                            0.0
                        };
                    }
                    None => {
                        let goal = if heard { f64::from(plan.gain) } else { 0.0 };
                        fader = math::mul_add(goal - fader, smoothing, fader);
                    }
                }
                match self.pan_lane.and_then(|v| lanes.get_mut(v)) {
                    Some(l) => pan_value = math::std_clamp(lane_value(&plan.automation, l, at), -1.0, 1.0),
                    None => pan_value = math::mul_add(target_pan - pan_value, smoothing, pan_value),
                }
                let muted = match self.mute_lane.and_then(|v| lanes.get_mut(v)) {
                    Some(l) => lane_value(&plan.automation, l, at) >= 0.5,
                    None => false,
                };
                let mute_target = if muted { 0.0 } else { 1.0 };
                mute_gain = math::mul_add(mute_target - mute_gain, mute_smoothing, mute_gain);
                if mute_target == 0.0 && mute_gain < 1e-4 {
                    mute_gain = 0.0;
                }
                (fader * mute_gain, pan_value)
            };
            let (mut l, mut r) = (f64::from(*lo), f64::from(*ro));
            // The pan law's sin/cos only change with the (smoothed) pan: once it settles they are
            // reused (same values, two transcendentals per sample fewer).
            if pan.to_bits() != law.0 {
                let angle = if mono {
                    (pan + 1.0) * garak_dsp::PI / 4.0
                } else if pan < 0.0 {
                    (pan + 1.0) * garak_dsp::PI / 2.0
                } else {
                    pan * garak_dsp::PI / 2.0
                };
                law = (pan.to_bits(), math::sin(angle), math::cos(angle));
            }
            let (_, sin, cos) = law;
            // Equal-power mono panning; stereo sources and widened chains pan as a balance.
            if mono {
                r = l * sin;
                l *= cos;
            } else if pan < 0.0 {
                l = math::mul_add(r, cos, l);
                r *= sin;
            } else if pan > 0.0 {
                r = math::mul_add(l, sin, r);
                l *= cos;
            }
            l *= gain;
            r *= gain;
            if !l.is_finite() {
                l = 0.0;
            }
            if !r.is_finite() {
                r = 0.0;
            }
            *lo = math::std_clamp(l, -32.0, 32.0) as f32;
            *ro = math::std_clamp(r, -32.0, 32.0) as f32;
            let louder = math::std_max(l.abs(), r.abs()) as f32;
            if peak < louder {
                peak = louder;
            }
        }
        self.fader = fader;
        self.pan_value = pan_value;
        self.mute_gain = mute_gain;
        self.peak = peak;
        if let Some(t) = fader_tap.get_mut(..n) {
            t.copy_from_slice(buf);
        }
        if !low_latency_monitor {
            output_delay.process(buf);
        }
    }

    /// Whether this track joins the master sum (C++ `TrackTimeline::directOut`).
    pub fn direct_out(&self) -> bool {
        self.plan.direct_out
    }

    /// This block's output (after `render`).
    pub fn mix(&self, count: u32) -> &[f32] {
        self.buffer.get(..count as usize * 2).unwrap_or(&[])
    }
}

/// One live event into a built-in instrument now (instrument.rs; C++ `spawn` / `noteOff` / `controlChange` /
/// `allNotesOff` of a live event): notes ring until their note-off (UNLIMITED_FRAME), previews for their frames.
fn apply_live(
    source: &mut Source,
    plan: &TrackPlan,
    event: LiveEvent,
    sample_rate: f64,
    overflows: &mut u64,
) {
    match event {
        LiveEvent::NoteOn { pitch, velocity, id } => {
            let length = instrument::UNLIMITED_FRAME;
            source.spawn(plan, i32::from(pitch), velocity, length, length, id, true, sample_rate, overflows);
        }
        LiveEvent::Preview { pitch, velocity, frames } => {
            let length = i64::from(frames);
            source.spawn(plan, i32::from(pitch), velocity, length, length, -2, true, sample_rate, overflows);
        }
        LiveEvent::NoteOff { pitch, id } => {
            source.note_off(plan, i32::from(pitch), id, sample_rate, overflows)
        }
        LiveEvent::Control { controller, value } => {
            source.control_change(plan, i32::from(controller), value, sample_rate, overflows);
        }
        LiveEvent::AllNotesOff => source.all_notes_off(plan, sample_rate, overflows),
    }
}

/// Freeze/bounce output (C++ `TrackRuntime::render` with `timeline.preFader`): the compensated post-insert
/// signal without pan, fader or mute; a mono track keeps its render mono (right channel silent). Returns the
/// block peak after non-finite samples are zeroed.
fn pre_fader_output(buf: &mut [f32], mono: bool) -> f32 {
    let mut peak = 0.0f32;
    for [l, r] in buf.as_chunks_mut::<2>().0 {
        if mono {
            *r = 0.0;
        }
        for x in [l, r] {
            if !x.is_finite() {
                *x = 0.0;
            }
            if peak < x.abs() {
                peak = x.abs();
            }
        }
    }
    peak
}

//! The engine: a control half ([`Controller`]) that prepares graphs and classifies diffs, and an
//! audio half ([`Renderer`]) that applies commands at block boundaries and renders. Mirrors
//! native/src/engine.cpp `RenderEngine` (prepare / submit / update / render): audio and built-in
//! instrument tracks, live MIDI to built-in instruments.

use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::sync::Arc;
use alloc::vec;
use alloc::vec::Vec;
use core::sync::atomic::{AtomicBool, AtomicI64, AtomicPtr, AtomicU32, AtomicU64, Ordering};

use crate::delay::CompensationDelay;
use crate::error::{Error, require};
use crate::external::{DeviceInput, Io, Stage};
use crate::insert::{KernelCache, catalog, live_parameter, validated, validated_values};
use crate::instrument::{self, removed_notes, renumber_notes, same_notes};
use crate::json::Json;
use crate::master::Master;
use crate::math;
use crate::metronome::{Clicks, MeterEvent, MeterMap, Metronome, clicks, grid, meter_clicks};
use crate::plan::{LaneTarget, PcmAsset, Plan, RouteKind, RouteTap, SampleSet, SourceKind, TrackPlan};
use crate::protocol;
use crate::queue::{Consumer, Producer, channel};
use crate::routes::{self, Levels};
use crate::tempo::TempoMap;
use crate::track::{Feed, LiveEvent, MAX_LIVE_OFFSET, PROBES, Probe, Track, TrackInfo};

/// Route recording taps the renderer copies out per block (docs/RUST_ENGINE.md 5.7).
pub const MAX_TAPS: usize = 8;
/// Analysis taps (editor spectrum / stereo scope / rig tuner) the renderer copies out per block.
pub const MAX_ANALYSIS: usize = 4;

/// One analysis tap: the signal after the insert at plan index `insert` of graph track `track`, or with
/// `tuner` a guitar rig's tuner input there (mono on both channels). `track < 0`: off.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AnalysisTap {
    pub track: i32,
    pub insert: i32,
    pub tuner: bool,
}

impl AnalysisTap {
    pub const OFF: AnalysisTap = AnalysisTap { track: -1, insert: -1, tuner: false };
}
/// Longest metronome stroke (C++ `setMetronome`: 4 s at the engine rate).
const MAX_STROKE_SECONDS: usize = 4;

const MEMORY_LIMIT: usize = 512 * 1024 * 1024;
const COMMAND_CAPACITY: usize = 1024;
const RETIRE_CAPACITY: usize = 2 * COMMAND_CAPACITY + 8;

/// Fixed engine format (C++ `RenderEngine(sampleRate, maxBlockFrames)` + `setOffline`).
#[derive(Clone, Copy, Debug)]
pub struct EngineConfig {
    pub sample_rate: u32,
    /// Render calls are subdivided at this size; automation chunks restart at each block.
    pub max_block: u32,
    /// Offline instances ignore the cycle and keep rendering past the project end (tails).
    pub offline: bool,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self { sample_rate: 48_000, max_block: 4096, offline: false }
    }
}

/// What an update did (C++ `UpdateResult::Kind`, the protocol's `applied`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Applied {
    /// Only the revision changed.
    None,
    /// In-place diff commands only (mix, sends, live insert parameters, master gain).
    Diff,
    /// One or more tracks were rebuilt and swapped in (state continues).
    Tracks,
    /// A new graph replaced the running one (tracks continue their predecessors by id).
    Full,
}

/// Published by the renderer after every call (C++ `EngineSnapshot`, subset).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Snapshot {
    pub revision: u64,
    pub last_applied: u64,
    pub frame: i64,
    pub playing: bool,
    pub ready: bool,
    pub master_peak: f32,
    pub leaked: u64,
    /// A count-in is running (the transport starts when it ends).
    pub counting_in: bool,
    /// Live events a track played, and events no track could play (audio tracks, unknown index).
    pub live_played: u64,
    pub live_ignored: u64,
}

#[derive(Debug, Default)]
struct Published {
    revision: AtomicU64,
    ticket: AtomicU64,
    frame: AtomicI64,
    playing: AtomicBool,
    ready: AtomicBool,
    peak: AtomicU32,
    leaked: AtomicU64,
    counting_in: AtomicBool,
    live_played: AtomicU64,
    live_ignored: AtomicU64,
}

/// A prepared graph (C++ `PreparedProject::Impl`).
#[derive(Debug)]
pub(crate) struct Graph {
    project_id: String,
    revision: u64,
    length_frames: i64,
    cycle: Option<(i64, i64)>,
    master_gain: f32,
    tempo: Option<TempoMap>,
    /// Boxed: a track replacement is a pointer swap and a retired track never moves.
    #[allow(clippy::vec_box)]
    tracks: Vec<Box<Track>>,
    /// Metronome grid inputs (C++ `PreparedProject::Impl::meters` + timeline header).
    meters: MeterMap,
    meter_mapped: bool,
    bpm: f64,
    meter: (i32, i32),
    /// Processing levels: route sources and senders before the tracks that read them (engine.cpp
    /// `levelOrder`/`levelStart`/`masterLevel`).
    levels: Levels,
    master: Master,
    latency: u32,
    sender_latency: u32,
    tail: f64,
    /// Continues the running graph (same project): tracks adopt their predecessors.
    continues: bool,
    /// Tempo / length / cycle changed: every continuing track recomputes its cursors.
    header_changed: bool,
}

enum Command {
    Graph(Box<Graph>),
    /// Play after a count-in of this many frames (0: now).
    Play(i64),
    Pause,
    Stop,
    Seek(i64),
    Mix {
        track: u32,
        gain: f32,
        pan: f32,
        audible: bool,
        unmuted_audible: bool,
    },
    Send {
        ret: u32,
        sender: u32,
        pre: bool,
        gain: f32,
    },
    Param {
        track: u32,
        insert: u32,
        index: u32,
        value: f64,
    },
    Replace {
        track: u32,
        runtime: Box<Track>,
    },
    Master(f32),
    Revision(u64),
    MasterBypass(bool),
    Metronome {
        clicks: Option<Arc<Clicks>>,
        /// Drop the current strokes (silence; `clicks` is None).
        clear: bool,
        on: bool,
        gain: f32,
    },
    Monitor([u64; 4]),
    Taps([i32; MAX_TAPS]),
    Analysis([AnalysisTap; MAX_ANALYSIS]),
    Live {
        track: u32,
        event: LiveEvent,
        offset: u32,
    },
}

enum Retired {
    Graph(#[allow(dead_code)] Box<Graph>),
    Track(#[allow(dead_code)] Box<Track>),
    Clicks(#[allow(dead_code)] Arc<Clicks>),
}

struct Ticketed {
    ticket: u64,
    command: Command,
}

/// Control-thread record of the running graph (C++ `ControlRecipe`). `plan` holds the notes as
/// renumbered against the running graph (unchanged notes keep their ids).
#[derive(Debug, Clone)]
struct Recipe {
    plan: Plan,
    tracks: Vec<TrackInfo>,
    sender_latency: u32,
    return_latency: u32,
    tail: f64,
}

/// Control half. Owns registered PCM, the IR cache and the recipe; allocates freely.
pub struct Controller {
    config: EngineConfig,
    assets: BTreeMap<String, Arc<PcmAsset>>,
    sets: BTreeMap<String, Arc<SampleSet>>,
    cache: KernelCache,
    /// Prepared IEUM WAVE table sets, shared by patches with the same user banks.
    wave: crate::wave::WaveCache,
    recipe: Option<Recipe>,
    /// The host's merged copy of the project (what `project.patch` applies to).
    current: Option<Plan>,
    commands: Producer<Ticketed>,
    retired: Consumer<Retired>,
    published: Arc<Published>,
    ticket: u64,
    staged: Option<Staged>,
    /// Tracks of the staged plan built by `step`, by plan index (consumed by the commit).
    prebuilt: Vec<Option<(Track, TrackInfo)>>,
    /// Tracks the last update rebuilt and swapped in (C++ `UpdateResult::replacedTracks`).
    replaced: u32,
}

impl core::fmt::Debug for Controller {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Controller").field("config", &self.config).finish_non_exhaustive()
    }
}

/// Audio half. Never allocates, frees, locks or panics.
pub struct Renderer {
    config: EngineConfig,
    commands: Consumer<Ticketed>,
    retired: Producer<Retired>,
    published: Arc<Published>,
    active: Option<Box<Graph>>,
    /// A graph swap waiting for an IEUM WAVE table crossfade of the running graph (engine.cpp
    /// `deferred`): retried at the next render, before any later command.
    deferred: Option<Ticketed>,
    playing: bool,
    position: i64,
    master_gain: f32,
    target_master_gain: f32,
    last_ticket: u64,
    leaked: u64,
    /// Offline stems/freeze (C++ `setMasterBypass`): no master gain, no master processor.
    master_bypass: bool,
    metronome: Metronome,
    metronome_on: bool,
    metronome_gain: f32,
    count_in_remaining: i64,
    count_in_elapsed: i64,
    count_in_length: i64,
    /// Monitored tracks by graph index (C++ `monitor`).
    monitor: [u64; 4],
    /// Route recording taps: graph indices (-1 none) and their route inputs of the last render call,
    /// `MAX_TAPS` interleaved stereo slots of `max_block` frames.
    taps: [i32; MAX_TAPS],
    tap_out: Vec<f32>,
    /// Analysis taps and their signals of the last render call, `MAX_ANALYSIS` interleaved stereo slots of
    /// `max_block` frames. `probed`: tracks may still carry probes from the previous block.
    analysis: [AnalysisTap; MAX_ANALYSIS],
    analysis_out: Vec<f32>,
    probed: bool,
    live_played: u64,
    live_ignored: u64,
    /// The master feed of the current block for master-resampling routes.
    master_feed: Vec<f32>,
    /// The active graph for render-ahead producers on the host's workers (`ahead.rs`).
    shared: Arc<AtomicPtr<Graph>>,
}

impl core::fmt::Debug for Renderer {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Renderer")
            .field("config", &self.config)
            .field("position", &self.position)
            .finish_non_exhaustive()
    }
}

/// A connected controller / renderer pair (control thread). Refuses rates outside 8-192 kHz and
/// blocks outside 1-65536 frames, like the C++ constructor.
pub fn engine(config: EngineConfig) -> Result<(Controller, Renderer), Error> {
    require(
        (8000..=192_000).contains(&config.sample_rate) && (1..=65_536).contains(&config.max_block),
        "Invalid native engine format",
    )?;
    let (cp, cc) = channel(COMMAND_CAPACITY);
    let (rp, rc) = channel(RETIRE_CAPACITY);
    let published = Arc::new(Published::default());
    Ok((
        Controller {
            config,
            assets: BTreeMap::new(),
            sets: BTreeMap::new(),
            cache: KernelCache::default(),
            wave: crate::wave::WaveCache::default(),
            recipe: None,
            current: None,
            commands: cp,
            retired: rc,
            published: published.clone(),
            ticket: 0,
            staged: None,
            prebuilt: Vec::new(),
            replaced: 0,
        },
        Renderer {
            config,
            commands: cc,
            retired: rp,
            published,
            active: None,
            deferred: None,
            playing: false,
            position: 0,
            master_gain: 1.0,
            target_master_gain: 1.0,
            last_ticket: 0,
            leaked: 0,
            master_bypass: false,
            metronome: Metronome::default(),
            metronome_on: false,
            metronome_gain: 0.0,
            count_in_remaining: 0,
            count_in_elapsed: 0,
            count_in_length: 0,
            monitor: [0; 4],
            taps: [-1; MAX_TAPS],
            tap_out: vec![0.0; config.max_block as usize * 2 * MAX_TAPS],
            analysis: [AnalysisTap::OFF; MAX_ANALYSIS],
            analysis_out: vec![0.0; config.max_block as usize * 2 * MAX_ANALYSIS],
            probed: false,
            live_played: 0,
            live_ignored: 0,
            master_feed: vec![0.0; config.max_block as usize * 2],
            shared: Arc::new(AtomicPtr::new(core::ptr::null_mut())),
        },
    ))
}

fn checked(value: f64, minimum: f64, maximum: f64, message: &str) -> Result<(), Error> {
    require(value.is_finite() && value >= minimum && value <= maximum, message)
}

fn send_lane(t: &TrackPlan, return_id: &str) -> Option<usize> {
    t.automation
        .iter()
        .position(|l| l.target == LaneTarget::Send && l.return_id == return_id && !l.points.is_empty())
}

/// Runtime insert index of each plan insert (enabled inserts of an enabled track), or None.
fn runtime_inserts(t: &TrackPlan) -> Vec<Option<usize>> {
    let mut next = 0;
    t.inserts
        .iter()
        .map(|e| {
            if t.enabled && e.enabled {
                next += 1;
                Some(next - 1)
            } else {
                None
            }
        })
        .collect()
}

/// Instrument identity (engine.cpp `sameSourceIdentity` + the resolved set and PCM objects): equal
/// sources keep their voices across an edit, parameters may differ.
fn same_source(old: &TrackPlan, neu: &TrackPlan, old_info: &TrackInfo, new_info: &TrackInfo) -> bool {
    old.enabled
        && neu.enabled
        && old.source.kind == neu.source.kind
        && old.source.instrument_id == neu.source.instrument_id
        && old.source.sample_set_id == neu.source.sample_set_id
        && old.source.is_kit == neu.source.is_kit
        && old.source.plugin_instance == neu.source.plugin_instance
        && old_info.set == new_info.set
        && (neu.source.kind != SourceKind::BuiltinSampled || old_info.assets == new_info.assets)
}

/// Per runtime insert of `next`: the runtime insert of `old` with the same id and type.
fn insert_origins(old: &TrackPlan, next: &TrackPlan) -> Vec<Option<usize>> {
    let from = runtime_inserts(old);
    if !next.enabled {
        return Vec::new();
    }
    next.inserts
        .iter()
        .filter(|e| e.enabled)
        .map(|e| {
            old.inserts
                .iter()
                .zip(&from)
                .find(|(o, f)| o.id == e.id && o.kind == e.kind && f.is_some())
                .and_then(|(_, f)| *f)
        })
        .collect()
}

/// One track's classified edit (engine.cpp `update`).
#[derive(Default)]
struct Edit {
    replace: bool,
    mix: bool,
    sends: Vec<usize>,
    params: Vec<(u32, u32, f64)>,
}

/// A staged update (`Controller::stage_json`): the parsed plan and the tracks it will build.
struct Staged {
    plan: Plan,
    todo: Vec<usize>,
    next: usize,
}

/// Track `i` of `p`: the one `Controller::step` built for this plan, else built now.
#[allow(clippy::too_many_arguments)]
fn take_built(
    prebuilt: &mut [Option<(Track, TrackInfo)>],
    i: usize,
    p: &Plan,
    t: &TrackPlan,
    assets: &BTreeMap<String, Arc<PcmAsset>>,
    max_block: u32,
    sets: &BTreeMap<String, Arc<SampleSet>>,
    cache: &mut KernelCache,
    wave: &mut crate::wave::WaveCache,
    reuse: Option<f64>,
) -> Result<(Track, TrackInfo), Error> {
    match prebuilt.get_mut(i).and_then(Option::take) {
        // A track that keeps its IEUM WAVE processor is built here (the prebuilt one made its own).
        Some(built) if reuse.is_none() => Ok(built),
        _ => Track::build(p, t, assets, max_block, sets, cache, wave, reuse),
    }
}

impl Controller {
    pub fn config(&self) -> EngineConfig {
        self.config
    }

    /// Registers (or replaces) PCM under `id` (`asset.put`). Tracks already using the old PCM keep
    /// it until their next rebuild; the next update rebuilds them (C++: same rule).
    pub fn put_asset(&mut self, id: &str, asset: PcmAsset) -> Result<(), Error> {
        require(!id.is_empty() && id.len() <= 512, "Invalid native PCM asset id")?;
        require(
            (1..=32).contains(&asset.channels)
                && (8000..=192_000).contains(&asset.sample_rate)
                && !asset.samples.is_empty()
                && asset.samples.len().is_multiple_of(asset.channels as usize),
            "Invalid native PCM asset",
        )?;
        self.assets.insert(String::from(id), Arc::new(asset));
        Ok(())
    }

    pub fn remove_asset(&mut self, id: &str) {
        self.assets.remove(id);
    }

    /// Registers (or replaces) a sample instrument / kit (the host's `samples.register`). Every
    /// zone's PCM must already be registered. Tracks using a replaced set rebuild on the next update.
    pub fn put_sample_set(&mut self, set: SampleSet) -> Result<(), Error> {
        require(!set.id.is_empty() && set.id.len() <= 512, "Invalid sample set id")?;
        for z in &set.zones {
            require(self.assets.contains_key(&z.asset_id), "Sample asset is missing")?;
        }
        for z in &set.release_zones {
            require(self.assets.contains_key(&z.asset_id), "Release sample asset is missing")?;
        }
        self.sets.insert(set.id.clone(), Arc::new(set));
        Ok(())
    }

    /// `samples.register` params as JSON text (see [`protocol::parse_sample_set`]).
    pub fn register_samples_json(&mut self, text: &[u8]) -> Result<(), Error> {
        let set = protocol::parse_sample_set(&Json::parse(text)?)?;
        self.put_sample_set(set)
    }

    pub fn remove_sample_set(&mut self, id: &str) {
        self.sets.remove(id);
    }

    /// Live note-on to an instrument track (C++ `noteOn`): rings until its note-off.
    pub fn note_on(&mut self, track: u32, pitch: i32, velocity: f32, id: i32) -> Result<u64, Error> {
        require((0..=127).contains(&pitch), "Invalid live MIDI note")?;
        checked(f64::from(velocity), 0.0, 2.0, "Invalid MIDI velocity")?;
        self.live(track, LiveEvent::NoteOn { pitch: pitch as u8, velocity, id })
    }

    /// An editor audition note of `duration` frames (C++ `previewNote`).
    pub fn preview_note(
        &mut self,
        track: u32,
        pitch: i32,
        velocity: f32,
        duration: u32,
    ) -> Result<u64, Error> {
        require(
            (0..=127).contains(&pitch) && duration > 0 && duration <= self.config.sample_rate * 30,
            "Invalid preview note",
        )?;
        checked(f64::from(velocity), 0.0, 2.0, "Invalid preview velocity")?;
        self.live(track, LiveEvent::Preview { pitch: pitch as u8, velocity, frames: duration })
    }

    /// Live note-off (`id` >= 0 matches that note-on's id, else every live note of `pitch`).
    pub fn note_off(&mut self, track: u32, pitch: i32, id: i32) -> Result<u64, Error> {
        require((0..=127).contains(&pitch), "Invalid live MIDI note")?;
        self.live(track, LiveEvent::NoteOff { pitch: pitch as u8, id })
    }

    /// Live controller (ControlEvent numbering: 0..127 CC, 128 pressure, 129 bend, 130 program,
    /// 131 bend range). CC64 defers live note-offs of built-in instruments.
    pub fn control_change(&mut self, track: u32, controller: i32, value: i32) -> Result<u64, Error> {
        require(instrument::valid_controller_value(controller, value), "Invalid live MIDI controller")?;
        self.live(track, LiveEvent::Control { controller: controller as u16, value })
    }

    /// Live panic on one track: lifts the live pedal, releases live notes, centres bend / modulation.
    pub fn all_notes_off(&mut self, track: u32) -> Result<u64, Error> {
        self.live(track, LiveEvent::AllNotesOff)
    }

    /// Latency (frames), sender latency and tail (seconds) of the last submitted graph.
    pub fn graph_info(&self) -> Option<(u32, u32, f64)> {
        self.recipe.as_ref().map(|r| (r.sender_latency + r.return_latency, r.sender_latency, r.tail))
    }

    /// The longest own tail of a non-return track of the last submitted graph (instrument release plus insert
    /// tails, without the render floor; C++ `PreparedProject::trackTailSeconds`, used for freeze renders).
    pub fn track_tail(&self) -> f64 {
        self.recipe.as_ref().map_or(0.0, |r| {
            r.plan
                .tracks
                .iter()
                .zip(&r.tracks)
                .filter(|(t, _)| !t.is_return)
                .fold(0.0, |tail, (_, info)| math::std_max(tail, info.tail))
        })
    }

    /// The host's current project (after the last accepted set/patch).
    pub fn current(&self) -> Option<&Plan> {
        self.current.as_ref()
    }

    pub fn snapshot(&self) -> Snapshot {
        let p = &self.published;
        Snapshot {
            revision: p.revision.load(Ordering::Relaxed),
            last_applied: p.ticket.load(Ordering::Acquire),
            frame: p.frame.load(Ordering::Relaxed),
            playing: p.playing.load(Ordering::Relaxed),
            ready: p.ready.load(Ordering::Relaxed),
            master_peak: f32::from_bits(p.peak.load(Ordering::Relaxed)),
            leaked: p.leaked.load(Ordering::Relaxed),
            counting_in: p.counting_in.load(Ordering::Relaxed),
            live_played: p.live_played.load(Ordering::Relaxed),
            live_ignored: p.live_ignored.load(Ordering::Relaxed),
        }
    }

    /// The last ticket queued (compare with `Snapshot::last_applied` to await application).
    pub fn ticket(&self) -> u64 {
        self.ticket
    }

    /// Frees graphs and tracks the renderer retired (C++ `collectRetired`).
    pub fn collect(&mut self) {
        while self.retired.pop().is_some() {}
        self.cache.trim();
    }

    fn enqueue(&mut self, command: Command) -> Result<u64, Error> {
        self.ticket += 1;
        let ticket = self.ticket;
        if self.commands.push(Ticketed { ticket, command }).is_err() {
            // The renderer stopped draining: the next update rebuilds the whole graph.
            self.recipe = None;
            return Err(Error::new("Native graph command queue is full"));
        }
        Ok(ticket)
    }

    pub fn play(&mut self) -> Result<u64, Error> {
        self.enqueue(Command::Play(0))
    }

    /// Plays after a count-in of `frames` (C++ `RenderEngine::play(countIn)`): the metronome clicks it at the
    /// tempo and meter where the transport starts, then the transport starts on the next frame. Offline
    /// engines start at once.
    pub fn play_count_in(&mut self, frames: i64) -> Result<u64, Error> {
        require(
            frames >= 0 && frames <= i64::from(self.config.sample_rate) * 120,
            "Invalid count-in length",
        )?;
        self.enqueue(Command::Play(frames))
    }

    /// Offline stems/freeze render pre-master (C++ `setMasterBypass`; realtime engines ignore it).
    pub fn set_master_bypass(&mut self, on: bool) -> Result<u64, Error> {
        self.enqueue(Command::MasterBypass(on))
    }

    /// The metronome (C++ `setMetronome`): click strokes per level (bar downbeat, group start, pulse) at the
    /// engine rate, synthesized by the host (docs/METRONOME.md); `None` keeps the current strokes.
    pub fn set_metronome(&mut self, strokes: Option<Clicks>, on: bool, gain: f32) -> Result<u64, Error> {
        require(gain.is_finite() && (0.0..=4.0).contains(&gain), "Invalid metronome gain")?;
        if let Some(c) = &strokes {
            require(c.sample_rate == self.config.sample_rate, "Metronome strokes must use the engine rate")?;
            for level in &c.levels {
                require(
                    level.len() <= self.config.sample_rate as usize * MAX_STROKE_SECONDS,
                    "Metronome stroke is too long",
                )?;
                require(
                    level.iter().all(|v| v.is_finite() && v.abs() <= 4.0),
                    "Invalid metronome stroke sample",
                )?;
            }
        }
        self.collect();
        self.enqueue(Command::Metronome { clicks: strokes.map(Arc::new), clear: false, on, gain })
    }

    /// The metronome without strokes (C++ `setMetronome` with no or unusable strokes): silence until a later
    /// `set_metronome` brings strokes; ringing strokes stop.
    pub fn clear_metronome(&mut self, on: bool, gain: f32) -> Result<u64, Error> {
        require(gain.is_finite() && (0.0..=4.0).contains(&gain), "Invalid metronome gain")?;
        self.collect();
        self.enqueue(Command::Metronome { clicks: None, clear: true, on, gain })
    }

    /// The master gain (C++ `setMasterGain`; the output glides to it like a project `masterGain` change).
    pub fn set_master_gain(&mut self, gain: f32) -> Result<u64, Error> {
        checked(f64::from(gain), 0.0, 2.0, "Invalid master gain")?;
        self.enqueue(Command::Master(gain))
    }

    /// Tracks the last `update` / `set_json` rebuilt and swapped into the running graph (0 for a new graph).
    pub fn replaced_tracks(&self) -> u32 {
        self.replaced
    }

    /// Monitored tracks by graph index (C++ `setMonitoring`): their live input (routed tracks: their route
    /// input) plays through their chain.
    pub fn set_monitoring(&mut self, tracks: &[u32]) -> Result<u64, Error> {
        let mut mask = [0u64; 4];
        for &t in tracks {
            require(t < 256, "Invalid monitor track index")?;
            if let Some(word) = mask.get_mut(t as usize / 64) {
                *word |= 1u64 << (t % 64);
            }
        }
        self.enqueue(Command::Monitor(mask))
    }

    /// Route recording taps: the route input of these graph indices is copied out every block.
    pub fn set_taps(&mut self, tracks: &[i32]) -> Result<u64, Error> {
        require(tracks.len() <= MAX_TAPS, "Too many route taps")?;
        let mut taps = [-1i32; MAX_TAPS];
        for (slot, &t) in taps.iter_mut().zip(tracks) {
            *slot = t;
        }
        self.enqueue(Command::Taps(taps))
    }

    /// Analysis taps (at most `MAX_ANALYSIS`; the editors that are open ask for them): their signals are
    /// copied out every block (`Renderer::analysis_output`). An empty list turns them off.
    pub fn set_analysis(&mut self, taps: &[AnalysisTap]) -> Result<u64, Error> {
        require(taps.len() <= MAX_ANALYSIS, "Too many analysis taps")?;
        require(
            taps.iter()
                .all(|t| (-1..256).contains(&t.track) && (-1..=i32::from(u16::MAX)).contains(&t.insert)),
            "Invalid analysis tap",
        )?;
        let mut list = [AnalysisTap::OFF; MAX_ANALYSIS];
        for (slot, &t) in list.iter_mut().zip(taps) {
            *slot = t;
        }
        self.enqueue(Command::Analysis(list))
    }

    /// A live note / controller event for the track at graph index `track`, at the start of the next render
    /// call: what live MIDI, the computer keyboard and note previews send. Built-in instruments and host nodes
    /// play it (`Track::queue_live`); other tracks count it as ignored.
    pub fn live(&mut self, track: u32, event: LiveEvent) -> Result<u64, Error> {
        self.live_at(track, event, 0)
    }

    /// [`live`](Self::live) `offset` frames into the next render call (up to [`MAX_LIVE_OFFSET`]; past that
    /// call's frames it lands in a later one, at the same distance from the first call's start): the event
    /// sounds on that exact sample (docs/RUST_ENGINE.md 5.8).
    pub fn live_at(&mut self, track: u32, event: LiveEvent, offset: u32) -> Result<u64, Error> {
        require(track < 256 && event.is_valid() && offset <= MAX_LIVE_OFFSET, "Invalid live MIDI event")?;
        self.enqueue(Command::Live { track, event, offset })
    }

    pub fn pause(&mut self) -> Result<u64, Error> {
        self.enqueue(Command::Pause)
    }

    pub fn stop(&mut self) -> Result<u64, Error> {
        self.enqueue(Command::Stop)
    }

    pub fn seek(&mut self, frame: i64) -> Result<u64, Error> {
        self.enqueue(Command::Seek(frame))
    }

    /// `project.set`: a complete timeline (JSON text + optional binary frame).
    pub fn set_json(&mut self, text: &[u8], blob: &[u8]) -> Result<Applied, Error> {
        let plan = protocol::parse_timeline(&Json::parse(text)?, blob)?;
        self.update(plan)
    }

    /// `project.patch`: header + order + changed tracks against the current project.
    pub fn patch_json(&mut self, text: &[u8], blob: &[u8]) -> Result<Applied, Error> {
        let current =
            self.current.as_ref().ok_or_else(|| Error::new("No project to patch; send project.set"))?;
        let plan = protocol::parse_patch(current, &Json::parse(text)?, blob)?;
        self.update(plan)
    }

    /// The first part of a `project.set` (`patch` false) or `project.patch` spread over several control
    /// calls (docs/RUST_ENGINE.md 5.7: the worklet does one per render quantum, so a large project never
    /// stalls the audio thread): parses and classifies it and returns how many tracks `step` will build.
    /// Nothing changes until `commit`; a new stage replaces an unfinished one.
    pub fn stage_json(&mut self, patch: bool, text: &[u8], blob: &[u8]) -> Result<usize, Error> {
        self.staged = None;
        self.prebuilt.clear();
        self.collect();
        let json = Json::parse(text)?;
        let plan = if patch {
            let current =
                self.current.as_ref().ok_or_else(|| Error::new("No project to patch; send project.set"))?;
            protocol::parse_patch(current, &json, blob)?
        } else {
            protocol::parse_timeline(&json, blob)?
        };
        let todo: Vec<usize> = match self.classify(&plan)? {
            None => (0..plan.tracks.len()).collect(),
            Some(edits) => edits.iter().enumerate().filter(|(_, e)| e.replace).map(|(i, _)| i).collect(),
        };
        let count = todo.len();
        self.prebuilt = (0..plan.tracks.len()).map(|_| None).collect();
        self.staged = Some(Staged { plan, todo, next: 0 });
        Ok(count)
    }

    /// Builds the next track of the staged update. `Ok(true)` once every track is built (or nothing is
    /// staged); an error drops the stage (the update is refused, as `update` would refuse it).
    pub fn step(&mut self) -> Result<bool, Error> {
        let Some(st) = &mut self.staged else { return Ok(true) };
        let Some(&i) = st.todo.get(st.next) else { return Ok(true) };
        st.next += 1;
        let done = st.next >= st.todo.len();
        let Some(t) = st.plan.tracks.get(i) else { return Ok(done) };
        // Unchanged notes keep their running ids (`full` and the replacement path renumber the same way).
        let mut t = t.clone();
        if let Some(last) = &self.recipe
            && last.plan.project_id == st.plan.project_id
            && let Some(old) = last.plan.tracks.iter().find(|o| o.id == t.id)
        {
            let _ = renumber_notes(&old.notes, &mut t.notes);
        }
        match Track::build(
            &st.plan,
            &t,
            &self.assets,
            self.config.max_block,
            &self.sets,
            &mut self.cache,
            &mut self.wave,
            None,
        ) {
            Ok(built) => {
                if let Some(slot) = self.prebuilt.get_mut(i) {
                    *slot = Some(built);
                }
                Ok(done)
            }
            Err(e) => {
                self.staged = None;
                self.prebuilt.clear();
                Err(e)
            }
        }
    }

    /// Applies the staged update (tracks `step` did not build are built now).
    pub fn commit(&mut self) -> Result<Applied, Error> {
        let st = self.staged.take().ok_or_else(|| Error::new("No staged update"))?;
        let result = self.update(st.plan);
        self.prebuilt.clear();
        result
    }

    /// A reverb kernel (FFT partitions of the generated impulse) for the insert parameters `type` and
    /// `size`, from the cache or generated now: what a helper worker computes so the worklet never
    /// generates one (`import_reverb_kernel`). Returns the kernel data and the impulse length.
    pub fn reverb_kernel(&mut self, type_param: f64, size: f64) -> Result<(Arc<[f32]>, usize), Error> {
        self.cache.reverb(f64::from(self.config.sample_rate), type_param, size)
    }

    /// `reverb_kernel` for a reverb insert's parameter map as the timeline carries it (`{"type":..,
    /// "size":..}`, defaults filled in and validated like the insert): returns the `type` and `size` the
    /// kernel was made for, and the kernel.
    pub fn reverb_kernel_for(&mut self, params_json: &[u8]) -> Result<(f64, f64, Arc<[f32]>), Error> {
        let json = Json::parse(params_json)?;
        let members = json.as_object().ok_or_else(|| Error::new("Invalid parameter map"))?;
        let mut params = Vec::with_capacity(members.len());
        for (k, v) in members {
            params.push((k.clone(), v.as_f64().ok_or_else(|| Error::new("Invalid parameter"))?));
        }
        let plan = crate::plan::InsertPlan {
            id: String::from("kernel"),
            kind: String::from("reverb"),
            enabled: true,
            params,
            plugin_instance: String::new(),
            host: None,
        };
        let kind = garak_dsp::EffectKind::Reverb;
        let values = validated_values(kind, &plan)?;
        let value = |id: &str| {
            let index = kind.params().iter().position(|d| d.id == id).unwrap_or(0);
            values.get(index).copied().unwrap_or(0.0)
        };
        let (type_param, size) = (value("type"), value("size"));
        let (kernel, _) = self.reverb_kernel(type_param, size)?;
        Ok((type_param, size, kernel))
    }

    /// Adds a kernel computed elsewhere (`reverb_kernel` of another instance at this rate). It is kept
    /// through the next update, then while an insert uses it.
    pub fn import_reverb_kernel(&mut self, type_param: f64, size: f64, data: Vec<f32>) -> Result<(), Error> {
        self.cache.import(f64::from(self.config.sample_rate), type_param, size, data)
    }

    /// engine.cpp `prepare`: validates `p` and builds a graph (control thread).
    fn prepare(&mut self, p: &Plan) -> Result<(Box<Graph>, Recipe), Error> {
        let rate = self.config.sample_rate;
        require(p.sample_rate == rate, "Native project/device sample rates must agree")?;
        require(
            p.tracks.len() <= 256
                && p.length_frames > 0
                && p.length_frames <= i64::from(p.sample_rate) * 3600,
            "Native project exceeds track/duration limits",
        )?;
        require(!p.project_id.is_empty() && p.project_id.len() <= 200, "Invalid native project ID")?;
        checked(p.bpm, 20.0, 400.0, "Invalid native tempo")?;
        checked(f64::from(p.master_gain), 0.0, 2.0, "Invalid native master gain")?;
        require(
            (1..=32).contains(&p.time_sig_numerator) && [2, 4, 8, 16].contains(&p.time_sig_denominator),
            "Invalid native meter",
        )?;
        if let Some((start, end)) = p.cycle {
            require(start >= 0 && end <= p.length_frames && end > start, "Invalid native cycle")?;
        }
        let sr = f64::from(rate);
        let (mut estimated, mut notes, mut windows) = (0usize, 0usize, 0usize);
        let mut ids: Vec<&str> = Vec::new();
        for t in &p.tracks {
            require(
                !t.id.is_empty() && t.id.len() <= 200 && !ids.contains(&t.id.as_str()),
                "Invalid or duplicate native track ID",
            )?;
            ids.push(&t.id);
            notes += t.notes.len();
            windows += t.audio.len();
            require(t.inserts.len() <= 64 && t.audio.len() <= 2048, "Native track exceeds limits")?;
            if t.enabled {
                for e in t.inserts.iter().filter(|e| e.enabled) {
                    estimated += crate::insert::estimate_memory(&e.kind, sr);
                }
            }
        }
        require(
            notes <= 100_000 && windows <= 8192 && estimated <= MEMORY_LIMIT,
            "Native project exceeds bounded memory/event limits",
        )?;
        let mut tracks = Vec::with_capacity(p.tracks.len());
        let mut infos = Vec::with_capacity(p.tracks.len());
        for (i, t) in p.tracks.iter().enumerate() {
            let (track, info) = take_built(
                &mut self.prebuilt,
                i,
                p,
                t,
                &self.assets,
                self.config.max_block,
                &self.sets,
                &mut self.cache,
                &mut self.wave,
                None,
            )?;
            tracks.push(Box::new(track));
            infos.push(info);
        }
        let mut tail: f64 = 0.85;
        for info in &infos {
            tail = math::std_max(tail, info.tail + 0.15);
        }
        // Send/return plug-in delay compensation (docs/SENDS_RETURNS.md).
        let fed =
            |id: &str| p.tracks.iter().any(|t| !t.is_return && t.sends.iter().any(|s| s.return_id == id));
        let (mut sender_latency, mut return_latency) = (0u32, 0u32);
        for t in &tracks {
            if !t.is_return {
                sender_latency = sender_latency.max(t.latency);
            } else if fed(&t.plan.id) {
                return_latency = return_latency.max(t.latency);
            }
        }
        for (r, t) in p.tracks.iter().enumerate() {
            if !t.is_return || !t.enabled {
                continue;
            }
            let mut senders: f64 = 0.0;
            for (i, s) in p.tracks.iter().enumerate() {
                if !s.is_return && s.sends.iter().any(|x| x.return_id == t.id) {
                    senders = math::std_max(senders, infos.get(i).map_or(0.0, |x| x.tail));
                }
            }
            tail = math::std_max(tail, infos.get(r).map_or(0.0, |x| x.tail) + senders + 0.15);
        }
        estimated += (sender_latency + return_latency) as usize * p.tracks.len() * 16;
        require(estimated <= MEMORY_LIMIT, "Plugin compensation exceeds native memory budget")?;
        for (i, t) in tracks.iter_mut().enumerate() {
            t.index = i;
            if t.is_return {
                t.compensation = CompensationDelay::new(return_latency.saturating_sub(t.latency));
            } else {
                t.compensation = CompensationDelay::new(sender_latency - t.latency);
                t.output_delay = CompensationDelay::new(return_latency);
                t.output_delay_frames = return_latency;
            }
        }
        // Sends: each feeds an existing return (never itself; returns never send).
        let block = self.config.max_block as usize * 2;
        for i in 0..tracks.len() {
            let Some(sender) = p.tracks.get(i) else { continue };
            if sender.is_return {
                continue;
            }
            for send in &sender.sends {
                let Some(r) = p
                    .tracks
                    .iter()
                    .enumerate()
                    .position(|(r, t)| r != i && t.is_return && t.id == send.return_id)
                else {
                    continue;
                };
                let feed = Feed {
                    sender: i,
                    pre: send.pre,
                    target: send.gain,
                    gain: if sender.audible || !send.pre { f64::from(send.gain) } else { 0.0 },
                    lane: send_lane(sender, &send.return_id),
                    hint: 0,
                };
                if let Some(s) = tracks.get_mut(i) {
                    let tap = if send.pre { &mut s.post_tap } else { &mut s.fader_tap };
                    if tap.is_empty() {
                        *tap = vec![0.0; block];
                    }
                }
                if let Some(ret) = tracks.get_mut(r) {
                    ret.feeds.push(feed);
                }
            }
        }
        for t in &mut tracks {
            if t.is_return {
                t.return_input = vec![0.0; block];
            }
        }
        let levels = routes::prepare(&mut tracks, self.config.max_block);
        let graph = Graph {
            project_id: p.project_id.clone(),
            revision: p.revision,
            length_frames: p.length_frames,
            cycle: p.cycle,
            master_gain: p.master_gain,
            tempo: if p.tempo_map.is_empty() { None } else { Some(TempoMap::new(p.bpm, &p.tempo_map)) },
            tracks,
            meters: MeterMap::new(p.time_sig_numerator, p.time_sig_denominator, &p.meter_map),
            meter_mapped: !p.meter_map.is_empty(),
            bpm: p.bpm,
            meter: (p.time_sig_numerator, p.time_sig_denominator),
            levels,
            master: Master::new(sr),
            latency: sender_latency + return_latency,
            sender_latency,
            tail,
            continues: false,
            header_changed: false,
        };
        let recipe = Recipe { plan: p.clone(), tracks: infos, sender_latency, return_latency, tail };
        Ok((Box::new(graph), recipe))
    }

    /// Submits a new graph that continues the running one by track id (engine.cpp `update`'s full
    /// path + `submit` + `linkGraph`). Unchanged notes keep their ids.
    fn full(&mut self, p: Plan) -> Result<Applied, Error> {
        let mut staged = p.clone();
        if let Some(last) = &self.recipe
            && last.plan.project_id == p.project_id
        {
            for t in &mut staged.tracks {
                if let Some(old) = last.plan.tracks.iter().find(|o| o.id == t.id) {
                    let _ = renumber_notes(&old.notes, &mut t.notes);
                }
            }
        }
        let (mut graph, recipe) = self.prepare(&staged)?;
        if let Some(last) = &self.recipe
            && last.plan.project_id == p.project_id
            && last.plan.sample_rate == p.sample_rate
        {
            graph.continues = true;
            graph.header_changed = !staged.same_timing(&last.plan);
            for (i, (t, neu)) in graph.tracks.iter_mut().zip(&staged.tracks).enumerate() {
                let Some(prev) = last.plan.tracks.iter().position(|o| o.id == neu.id) else { continue };
                let (Some(old), Some(old_info), Some(new_info)) =
                    (last.plan.tracks.get(prev), last.tracks.get(prev), recipe.tracks.get(i))
                else {
                    continue;
                };
                t.predecessor = Some(prev);
                t.same_source = same_source(old, neu, old_info, new_info);
                let same_events = old.notes == neu.notes
                    && old.controls == neu.controls
                    && old.audio == neu.audio
                    && old.automation == neu.automation
                    && old_info.assets == new_info.assets
                    && old.inserts.len() == neu.inserts.len()
                    && old
                        .inserts
                        .iter()
                        .zip(&neu.inserts)
                        .all(|(a, b)| a.id == b.id && a.kind == b.kind && a.enabled == b.enabled);
                t.identical = same_events
                    && old.enabled == neu.enabled
                    && (t.same_source || !neu.enabled)
                    && old.is_return == neu.is_return;
                t.insert_origin = insert_origins(old, neu);
                if !t.identical && old.notes != neu.notes {
                    t.removed = removed_notes(&old.notes, &neu.notes);
                }
            }
        }
        self.enqueue(Command::Graph(graph))?;
        self.recipe = Some(recipe);
        self.current = Some(p);
        Ok(Applied::Full)
    }

    /// Always submits a new graph (its tracks continue the running ones by id). The diff paths
    /// must sound like this (docs/RENDER_DIFF_PROTOCOL.md 8.5); hosts also use it to recover.
    pub fn rebuild(&mut self, p: Plan) -> Result<Applied, Error> {
        self.collect();
        self.full(p)
    }

    /// Brings the running graph to `p` with the least work (engine.cpp `update`, audio tracks).
    pub fn update(&mut self, p: Plan) -> Result<Applied, Error> {
        self.collect();
        self.replaced = 0;
        let result = match self.classify(&p) {
            Ok(None) => self.full(p),
            Ok(Some(edits)) => self.apply_edits(p, edits),
            Err(e) => Err(e),
        };
        // Imported kernels were kept for this update; from now on live inserts hold the ones in use.
        self.cache.unpin();
        result
    }

    /// The update's classification (engine.cpp `update`): `None` for a new graph, else each track's edit.
    /// Builds nothing; validation errors refuse the update like `update` does.
    fn classify(&self, p: &Plan) -> Result<Option<Vec<Edit>>, Error> {
        let Some(last) = &self.recipe else { return Ok(None) };
        if p.project_id != last.plan.project_id
            || p.sample_rate != last.plan.sample_rate
            || !p.same_timing(&last.plan)
            || p.low_latency_monitoring != last.plan.low_latency_monitoring
            || p.tracks.len() != last.plan.tracks.len()
            || p.tracks.iter().zip(&last.plan.tracks).any(|(a, b)| a.id != b.id)
        {
            return Ok(None);
        }
        checked(f64::from(p.master_gain), 0.0, 2.0, "Invalid native master gain")?;
        let mut edits: Vec<Edit> = Vec::with_capacity(p.tracks.len());
        for (neu, (old, info)) in p.tracks.iter().zip(last.plan.tracks.iter().zip(&last.tracks)) {
            let mut e = Edit::default();
            if neu.is_return != old.is_return || neu.route != old.route || neu.sends.len() != old.sends.len()
            {
                return Ok(None);
            }
            for (s, (a, b)) in neu.sends.iter().zip(&old.sends).enumerate() {
                if a.return_id != b.return_id
                    || a.pre != b.pre
                    || send_lane(neu, &a.return_id) != send_lane(old, &b.return_id)
                {
                    return Ok(None);
                }
                if a.gain != b.gain {
                    checked(f64::from(a.gain), 0.0, 4.0, "Invalid native send gain")?;
                    e.sends.push(s);
                }
            }
            e.mix = neu.gain != old.gain
                || neu.pan != old.pan
                || neu.mute != old.mute
                || neu.solo != old.solo
                || neu.solo_safe != old.solo_safe
                || neu.audible != old.audible
                || neu.unmuted_audible != old.unmuted_audible;
            if e.mix {
                checked(f64::from(neu.gain), 0.0, 2.0, "Invalid native track gain")?;
                checked(f64::from(neu.pan), -1.0, 1.0, "Invalid native pan")?;
            }
            let mut replace = neu.enabled != old.enabled
                || neu.input != old.input
                || !same_notes(&neu.notes, &old.notes)
                || neu.controls != old.controls
                || neu.audio != old.audio
                || neu.automation != old.automation
                || neu.source != old.source
                || neu.inserts.len() != old.inserts.len();
            let runtime = runtime_inserts(neu);
            for (k, (a, b)) in neu.inserts.iter().zip(&old.inserts).enumerate() {
                if replace {
                    break;
                }
                if a.id != b.id
                    || a.kind != b.kind
                    || a.enabled != b.enabled
                    || a.plugin_instance != b.plugin_instance
                    || a.host != b.host
                {
                    replace = true;
                    break;
                }
                if a.params == b.params {
                    continue;
                }
                let Some(Some(insert)) = runtime.get(k) else { continue }; // disabled: recipe only
                let Some(defs) = catalog(&a.kind) else {
                    replace = true;
                    break;
                };
                validated(defs, a)?;
                let mut names: Vec<&str> = a.params.iter().map(|(k, _)| k.as_str()).collect();
                names.extend(b.params.iter().map(|(k, _)| k.as_str()));
                names.sort_unstable();
                names.dedup();
                for name in names {
                    let (x, y) = (a.param(name), b.param(name));
                    if x.is_some() && x == y {
                        continue;
                    }
                    let (Some(value), true) = (x, live_parameter(&a.kind, name)) else {
                        replace = true;
                        break;
                    };
                    let index = defs.iter().position(|d| d.id == name).unwrap_or(0);
                    e.params.push((*insert as u32, index as u32, value));
                }
            }
            if !replace && neu.enabled {
                // A re-registered PCM asset or sample set under the same id: the track resolves it
                // again (same order as the build: sample zones, release zones, windows).
                let ptr = |id: &str| self.assets.get(id).map_or(0, |a| Arc::as_ptr(a) as usize);
                let mut resolved: Vec<usize> = Vec::new();
                if neu.source.kind == SourceKind::BuiltinSampled {
                    match (self.sets.get(&neu.source.sample_set_id), &info.set) {
                        (Some(set), Some(old)) if set == old => {
                            resolved.extend(set.zones.iter().map(|z| ptr(&z.asset_id)));
                            resolved.extend(set.release_zones.iter().map(|z| ptr(&z.asset_id)));
                        }
                        _ => replace = true,
                    }
                }
                resolved.extend(neu.audio.iter().map(|w| ptr(&w.asset_id)));
                replace |= resolved != info.assets;
            }
            e.replace = replace;
            if replace {
                e.mix = false;
                e.params.clear();
            }
            edits.push(e);
        }
        Ok(Some(edits))
    }

    /// Applies classified edits: replacements, then diff commands (engine.cpp `update`, second half).
    fn apply_edits(&mut self, p: Plan, edits: Vec<Edit>) -> Result<Applied, Error> {
        let Some(last) = &self.recipe else { return self.full(p) };
        // Replacements (control thread); a latency change falls back to a full graph.
        let (sender_latency, return_latency) = (last.sender_latency, last.return_latency);
        let mut replacements: Vec<(usize, Box<Track>, TrackInfo, TrackPlan)> = Vec::new();
        for (i, e) in edits.iter().enumerate() {
            if !e.replace {
                continue;
            }
            let (Some(neu), Some(old), Some(info)) =
                (p.tracks.get(i), last.plan.tracks.get(i), last.tracks.get(i))
            else {
                continue;
            };
            // IEUM WAVE patch changes keep their table crossfade on the graph path; the same patch
            // keeps the running processor (engine.cpp `update`).
            let wave = neu.source.kind == SourceKind::NativeWavetable
                || old.source.kind == SourceKind::NativeWavetable;
            let same_wave = neu.source == old.source && neu.enabled && old.enabled;
            if wave && !same_wave {
                return self.full(p);
            }
            let reuse = if wave { Some(info.instrument_tail) } else { None };
            let mut neu = neu.clone();
            let removed = renumber_notes(&old.notes, &mut neu.notes);
            let (mut t, new_info) = take_built(
                &mut self.prebuilt,
                i,
                &p,
                &neu,
                &self.assets,
                self.config.max_block,
                &self.sets,
                &mut self.cache,
                &mut self.wave,
                reuse,
            )?;
            if new_info.latency != info.latency {
                return self.full(p);
            }
            t.predecessor = Some(i);
            t.index = i;
            t.same_source = same_source(old, &neu, info, &new_info);
            t.removed = removed;
            t.insert_origin = insert_origins(old, &neu);
            if old.is_return {
                t.compensation = CompensationDelay::new(return_latency.saturating_sub(t.latency));
            } else {
                t.compensation = CompensationDelay::new(sender_latency - t.latency);
                t.output_delay = CompensationDelay::new(return_latency);
            }
            replacements.push((i, Box::new(t), new_info, neu));
        }
        let mut commands: Vec<Command> = Vec::new();
        let mut infos: Vec<(usize, TrackInfo, TrackPlan)> = Vec::new();
        for (i, runtime, info, plan) in replacements {
            commands.push(Command::Replace { track: i as u32, runtime });
            infos.push((i, info, plan));
        }
        let replaced = infos.len();
        for (i, (neu, e)) in p.tracks.iter().zip(&edits).enumerate() {
            if e.mix {
                commands.push(Command::Mix {
                    track: i as u32,
                    gain: neu.gain,
                    pan: neu.pan,
                    audible: neu.audible,
                    unmuted_audible: neu.unmuted_audible,
                });
            }
            for &s in &e.sends {
                let Some(send) = neu.sends.get(s) else { continue };
                let Some(r) = p.tracks.iter().position(|t| t.id == send.return_id) else { continue };
                if !p.tracks.get(r).is_some_and(|t| t.is_return) || r == i {
                    continue; // silent send
                }
                commands.push(Command::Send {
                    ret: r as u32,
                    sender: i as u32,
                    pre: send.pre,
                    gain: send.gain,
                });
            }
            for &(insert, index, value) in &e.params {
                commands.push(Command::Param { track: i as u32, insert, index, value });
            }
        }
        if p.master_gain != last.plan.master_gain {
            commands.push(Command::Master(p.master_gain));
        }
        commands.push(Command::Revision(p.revision));
        let count = commands.len();
        for c in commands {
            self.enqueue(c)?;
        }
        // The recipe follows the running graph.
        if let Some(recipe) = &mut self.recipe {
            for (i, info, plan) in infos {
                if let Some(slot) = recipe.tracks.get_mut(i) {
                    *slot = info;
                    if let Some(pt) = recipe.plan.tracks.get_mut(i) {
                        *pt = plan;
                    }
                }
            }
            for (i, e) in edits.iter().enumerate() {
                if e.replace {
                    continue;
                }
                if let (Some(old), Some(neu)) = (recipe.plan.tracks.get_mut(i), p.tracks.get(i)) {
                    old.gain = neu.gain;
                    old.pan = neu.pan;
                    old.mute = neu.mute;
                    old.solo = neu.solo;
                    old.solo_safe = neu.solo_safe;
                    old.audible = neu.audible;
                    old.unmuted_audible = neu.unmuted_audible;
                    old.sends = neu.sends.clone();
                    old.source = neu.source.clone();
                    old.inserts = neu.inserts.clone();
                }
            }
            recipe.plan.master_gain = p.master_gain;
            recipe.plan.revision = p.revision;
        }
        self.current = Some(p);
        self.replaced = replaced as u32;
        Ok(if replaced > 0 {
            Applied::Tracks
        } else if count > 1 {
            Applied::Diff
        } else {
            Applied::None
        })
    }
}

impl Renderer {
    pub fn config(&self) -> EngineConfig {
        self.config
    }

    fn retire(&mut self, item: Retired) {
        if let Err(item) = self.retired.push(item) {
            // Never free on the audio thread: a full retire queue (controller not collecting)
            // leaks instead, counted in the snapshot.
            core::mem::forget(item);
            self.leaked += 1;
        }
    }

    fn reset(&mut self, chase: bool, effects: bool) {
        let position = self.position;
        if let Some(g) = &mut self.active {
            for t in &mut g.tracks {
                t.reset(position, chase, effects);
            }
            if effects {
                g.master.reset();
            }
        }
    }

    fn normalize(&mut self, starting: bool) {
        let Some(g) = &self.active else {
            self.position = 0;
            return;
        };
        self.position = self.position.clamp(0, g.length_frames);
        match g.cycle {
            Some((start, end)) if !self.config.offline && self.position >= end => self.position = start,
            _ if starting && self.position == g.length_frames => self.position = 0,
            _ => {}
        }
    }

    fn consume(&mut self) {
        self.consume_until(u64::MAX);
    }

    /// Applies queued commands up to ticket `limit` (a host shell keeps later ones for the block in
    /// which its own matching command applies; see `host.rs`). A graph swap deferred for an IEUM WAVE
    /// table crossfade goes first.
    fn consume_until(&mut self, limit: u64) {
        loop {
            let next = match self.deferred.take() {
                Some(d) => d,
                None if self.commands.peek().is_some_and(|c| c.ticket <= limit) => {
                    let Some(c) = self.commands.pop() else { break };
                    c
                }
                None => break,
            };
            let Ticketed { ticket, command } = next;
            match command {
                Command::Graph(mut next) => {
                    let continues = next.continues
                        && self.active.as_ref().is_some_and(|p| p.project_id == next.project_id);
                    if continues
                        && let Some(prev) = &mut self.active
                        && !prev.tracks.iter_mut().all(|t| t.source.ready_to_transfer())
                    {
                        self.deferred = Some(Ticketed { ticket, command: Command::Graph(next) });
                        break;
                    }
                    let previous = self.active.take();
                    let project_changed = previous.as_ref().is_none_or(|p| p.project_id != next.project_id);
                    let preserve = next.continues && !project_changed;
                    self.target_master_gain = next.master_gain;
                    let mut previous = previous;
                    if preserve && let Some(prev) = &mut previous {
                        let (position, playing) = (self.position, self.playing);
                        let header_changed = next.header_changed;
                        for t in &mut next.tracks {
                            match t.predecessor.and_then(|i| prev.tracks.get_mut(i)) {
                                Some(old) => {
                                    let same_events = t.identical && !header_changed;
                                    t.adopt(old, position, same_events, false);
                                }
                                None => t.reset(position, playing, true),
                            }
                        }
                        next.master.take_state_from(&prev.master);
                    } else {
                        self.master_gain = self.target_master_gain;
                    }
                    self.active = Some(next);
                    if project_changed {
                        self.position = 0;
                        self.playing = false;
                        self.monitor = [0; 4];
                        self.count_in_remaining = 0;
                    }
                    self.normalize(false);
                    if !preserve {
                        self.reset(self.playing, true);
                    }
                    if let Some(prev) = previous {
                        self.retire(Retired::Graph(prev));
                    }
                }
                Command::Play(count_in) => {
                    if !self.playing && self.count_in_remaining == 0 {
                        self.normalize(true);
                        if count_in > 0 && self.active.is_some() && !self.config.offline {
                            self.count_in_remaining = count_in;
                            self.count_in_length = count_in;
                            self.count_in_elapsed = 0;
                        } else {
                            self.playing = self.active.is_some();
                            self.reset(self.playing, false);
                        }
                    }
                }
                Command::Pause => {
                    self.count_in_remaining = 0;
                    self.playing = false;
                    self.reset(false, false);
                }
                Command::Stop => {
                    self.count_in_remaining = 0;
                    self.playing = false;
                    self.position = 0;
                    self.reset(false, true);
                }
                Command::Seek(frame) => {
                    self.position = frame;
                    self.normalize(false);
                    self.reset(self.playing, true);
                }
                Command::Mix { track, gain, pan, audible, unmuted_audible } => {
                    if let Some(t) = self.active.as_mut().and_then(|g| g.tracks.get_mut(track as usize)) {
                        t.plan.gain = gain;
                        t.plan.pan = pan;
                        t.plan.audible = audible;
                        t.plan.unmuted_audible = unmuted_audible;
                    }
                }
                Command::Send { ret, sender, pre, gain } => {
                    if let Some(t) = self.active.as_mut().and_then(|g| g.tracks.get_mut(ret as usize))
                        && let Some(f) =
                            t.feeds.iter_mut().find(|f| f.sender == sender as usize && f.pre == pre)
                    {
                        f.target = gain;
                    }
                }
                Command::Param { track, insert, index, value } => {
                    if let Some(i) = self
                        .active
                        .as_mut()
                        .and_then(|g| g.tracks.get_mut(track as usize))
                        .and_then(|t| t.inserts.get_mut(insert as usize))
                        .and_then(Stage::fx_mut)
                    {
                        i.set_param(index as usize, value);
                        i.commit();
                    }
                }
                Command::Replace { track, mut runtime } => {
                    let slot = self.active.as_mut().and_then(|g| g.tracks.get_mut(track as usize));
                    let position = self.position;
                    match slot {
                        Some(old) => {
                            runtime.adopt(old, position, false, true);
                            core::mem::swap(old, &mut runtime);
                            self.retire(Retired::Track(runtime));
                        }
                        None => self.retire(Retired::Track(runtime)),
                    }
                }
                Command::Master(gain) => self.target_master_gain = gain,
                Command::MasterBypass(on) => self.master_bypass = on,
                Command::Metronome { clicks, clear, on, gain } => {
                    self.metronome_on = on;
                    self.metronome_gain = gain;
                    if let Some(next) = clicks {
                        // Ringing strokes index the old set: they stop with it.
                        self.metronome.player.clear();
                        if let Some(old) = self.metronome.clicks.replace(next) {
                            self.retire(Retired::Clicks(old));
                        }
                    } else if clear {
                        self.metronome.player.clear();
                        if let Some(old) = self.metronome.clicks.take() {
                            self.retire(Retired::Clicks(old));
                        }
                    }
                }
                Command::Monitor(mask) => self.monitor = mask,
                Command::Taps(taps) => {
                    self.taps = taps;
                    self.tap_out.fill(0.0);
                }
                Command::Analysis(taps) => {
                    self.analysis = taps;
                    self.analysis_out.fill(0.0);
                }
                Command::Live { track, event, offset } => {
                    let played = self
                        .active
                        .as_mut()
                        .and_then(|g| g.tracks.get_mut(track as usize))
                        .is_some_and(|t| t.queue_live(event, offset));
                    if played {
                        self.live_played += 1;
                    } else {
                        self.live_ignored += 1;
                    }
                }
                Command::Revision(revision) => {
                    if let Some(g) = &mut self.active {
                        g.revision = revision;
                    }
                }
            }
            self.last_ticket = ticket;
        }
        let active = self.active.as_deref_mut().map_or(core::ptr::null_mut(), |g| g as *mut Graph);
        self.shared.store(active, Ordering::Release);
    }

    /// A return's input for this block: every feeding send's tap times its gain, smoothed like
    /// the fader or automated per sample (engine.cpp `fillReturnInput`).
    fn fill_return_input(g: &mut Graph, r: usize, position: i64, count: u32, smoothing: f64) {
        let Some(ret) = g.tracks.get_mut(r) else { return };
        let mut input = core::mem::take(&mut ret.return_input);
        let mut feeds = core::mem::take(&mut ret.feeds);
        let n = count as usize * 2;
        if let Some(inp) = input.get_mut(..n) {
            inp.fill(0.0);
            for f in &mut feeds {
                let Some(s) = g.tracks.get(f.sender) else { continue };
                let tap = if f.pre { &s.post_tap } else { &s.fader_tap };
                let Some(tap) = tap.get(..n) else { continue };
                let silent = f.pre && !s.plan.audible;
                if let Some(lane) = f.lane.and_then(|l| s.plan.automation.get(l)) {
                    for (i, ([a, b], [x, y])) in
                        inp.as_chunks_mut::<2>().0.iter_mut().zip(tap.as_chunks::<2>().0).enumerate()
                    {
                        let at = (position + i as i64) as f64;
                        f.gain = if silent {
                            0.0
                        } else {
                            math::std_clamp(
                                crate::automation::value(
                                    lane,
                                    crate::automation::evaluate(lane, at, &mut f.hint),
                                ),
                                0.0,
                                2.0,
                            )
                        };
                        let g2 = f.gain as f32;
                        *a = math::mul_add_f32(*x, g2, *a);
                        *b = math::mul_add_f32(*y, g2, *b);
                    }
                    continue;
                }
                let target = if silent { 0.0 } else { f64::from(f.target) };
                for ([a, b], [x, y]) in inp.as_chunks_mut::<2>().0.iter_mut().zip(tap.as_chunks::<2>().0) {
                    f.gain = math::mul_add(target - f.gain, smoothing, f.gain);
                    let g2 = f.gain as f32;
                    *a = math::mul_add_f32(*x, g2, *a);
                    *b = math::mul_add_f32(*y, g2, *b);
                }
            }
        }
        if let Some(ret) = g.tracks.get_mut(r) {
            ret.return_input = input;
            ret.feeds = feeds;
        }
    }

    /// A routed track's input for this block (engine.cpp `fillRouteInput`): its source's tap (rendered in an
    /// earlier level) or the master feed. Same frames as the source: an internal route adds no latency.
    fn fill_route_input(g: &mut Graph, i: usize, count: u32, feed: &[f32], io: &Io) {
        let n = count as usize * 2;
        let Some(t) = g.tracks.get_mut(i) else { return };
        let mut input = core::mem::take(&mut t.route_input);
        let (kind, tap, src) = (t.route_kind, t.route_tap, t.route_source);
        if let Some(dst) = input.get_mut(..n) {
            let from: Option<&[f32]> = match kind {
                RouteKind::Track => {
                    src.and_then(|x| g.tracks.get(x).map(|s| (x, s))).map(|(x, s)| match tap {
                        RouteTap::PreFx => s.pre_tap.as_slice(),
                        RouteTap::PostFx => s.post_tap.as_slice(),
                        // Without a return delay the output is the tap (a track rendering ahead: its ring's).
                        RouteTap::PostFader if s.fader_tap.is_empty() => {
                            io.ahead_mix(x, count).unwrap_or(&s.buffer)
                        }
                        RouteTap::PostFader => s.fader_tap.as_slice(),
                    })
                }
                RouteKind::Master => Some(feed),
                RouteKind::None => None,
            };
            match from.and_then(|f| f.get(..n)) {
                Some(f) => dst.copy_from_slice(f),
                None => dst.fill(0.0),
            }
        }
        if let Some(t) = g.tracks.get_mut(i) {
            t.route_input = input;
        }
    }

    /// The master feed before the master-resampling level (engine.cpp `fillMasterFeed`): the master gain over
    /// the tracks in the feed (before the master processor), smoothed exactly as the output mix of this block.
    fn fill_master_feed(g: &Graph, feed: &mut [f32], count: u32, rate: f64, gain: (f32, f32), io: &Io) {
        let Some(feed) = feed.get_mut(..count as usize * 2) else { return };
        feed.fill(0.0);
        for (i, t) in g.tracks.iter().enumerate().filter(|(_, t)| t.in_master_feed) {
            for (f, x) in feed.iter_mut().zip(io.ahead_mix(i, count).unwrap_or(t.mix(count))) {
                *f += *x;
            }
        }
        let s = math::smoothing(rate, 0.012) as f32;
        let (mut current, target) = gain;
        for pair in feed.as_chunks_mut::<2>().0 {
            current = math::mul_add_f32(target - current, s, current);
            for x in pair {
                *x *= current;
            }
        }
    }

    /// Every track of one block level by level, summed into `block` in track order (the master is applied by
    /// the caller). With `parallel`, the tracks of a level render on the host's workers (`host.rs`); the sum
    /// is the same either way. `gain`: the shell's master gain (current, target) for the master feed.
    #[allow(clippy::too_many_arguments)]
    fn render_tracks(
        g: &mut Graph,
        block: &mut [f32],
        position: i64,
        count: u32,
        playing: bool,
        rate: f64,
        parallel: Option<&host::Parallel>,
        io: &Io,
        feed: &mut [f32],
        gain: (f32, f32),
    ) {
        let tempo = g.tempo.as_ref().map(|t| t.bpm_at(t.beat_at_frame(position as f64, rate)));
        let smoothing = math::smoothing(rate, 0.012);
        for level in 0..g.levels.count() {
            if g.levels.master == Some(level) {
                Self::fill_master_feed(g, feed, count, rate, gain, io);
            }
            let size = g.levels.level(level).len();
            for k in 0..size {
                let Some(&index) = g.levels.level(level).get(k) else { continue };
                match g.tracks.get(index) {
                    Some(t) if t.is_return => Self::fill_return_input(g, index, position, count, smoothing),
                    Some(t) if t.routed => Self::fill_route_input(g, index, count, feed, io),
                    _ => {}
                }
            }
            if parallel.is_some_and(|p| host::render_level(g, p, level, position, count, playing, tempo, io))
            {
                continue;
            }
            for k in 0..size {
                let Some(&index) = g.levels.level(level).get(k) else { continue };
                if io.ahead_mix(index, count).is_some() {
                    continue; // The host renders it ahead.
                }
                if let Some(t) = g.tracks.get_mut(index) {
                    t.render(position, count, playing, tempo, io);
                }
            }
        }
        for (i, t) in g.tracks.iter().enumerate().filter(|(_, t)| t.direct_out()) {
            for (o, x) in block.iter_mut().zip(io.ahead_mix(i, count).unwrap_or(t.mix(count))) {
                *o += *x;
            }
        }
    }

    /// Renders `out.len() / 2` stereo frames (interleaved). Real-time safe.
    pub fn render(&mut self, out: &mut [f32]) {
        self.render_io(out, &[], 0);
    }

    /// Like `render`, with the live input block (`channels` interleaved, `out.len() / 2` frames) that
    /// monitored tracks hear (engine.cpp `render(output, input, frames, channels)`). Real-time safe.
    pub fn render_io(&mut self, out: &mut [f32], input: &[f32], channels: usize) {
        self.consume();
        let frames = (out.len() / 2) as u32;
        let rate = f64::from(self.config.sample_rate);
        let offline = self.config.offline;
        let mut cursor = 0u32;
        let mut master_peak = 0.0f32;
        let mut master_feed = core::mem::take(&mut self.master_feed);
        while cursor < frames {
            let mut count = self.config.max_block.min(frames - cursor);
            let counting_in = self.count_in_remaining > 0;
            if counting_in {
                count = count.min(self.count_in_remaining.min(i64::from(u32::MAX)) as u32);
            }
            if let Some(g) = &self.active
                && self.playing
            {
                let boundary = match g.cycle {
                    Some((_, end)) if !offline => end,
                    _ => g.length_frames,
                };
                if self.position >= boundary && !offline {
                    match g.cycle {
                        Some((start, _)) => {
                            self.position = start;
                            self.reset(true, false);
                        }
                        None => self.stop_at_end(),
                    }
                }
                if self.playing && self.position < boundary {
                    count = count.min((boundary - self.position) as u32);
                }
            }
            let Some(block) = out.get_mut(cursor as usize * 2..(cursor + count) as usize * 2) else { break };
            block.fill(0.0);
            let position = self.position;
            let bypass = offline && self.master_bypass;
            if let Some(g) = &mut self.active {
                let playing = self.playing && position < g.length_frames;
                let io = Io {
                    monitor: self.monitor,
                    offline,
                    input: Some(DeviceInput { data: input, channels, cursor: cursor as usize }),
                    ..Io::default()
                };
                let gain = (self.master_gain, self.target_master_gain);
                let placed = Self::place_probes(g, &self.analysis, &mut self.probed);
                Self::render_tracks(
                    g,
                    block,
                    position,
                    count,
                    playing,
                    rate,
                    None,
                    &io,
                    &mut master_feed,
                    gain,
                );
                if !bypass {
                    let s = math::smoothing(rate, 0.012) as f32;
                    for pair in block.as_chunks_mut::<2>().0 {
                        self.master_gain = math::mul_add_f32(
                            self.target_master_gain - self.master_gain,
                            s,
                            self.master_gain,
                        );
                        for x in pair {
                            *x *= self.master_gain;
                        }
                    }
                    g.master.process(block);
                }
                Self::copy_taps(g, &self.taps, &mut self.tap_out, self.config.max_block, cursor, count);
                Self::copy_analysis(g, &placed, &mut self.analysis_out, self.config.max_block, cursor, count);
            }
            for x in block.iter_mut() {
                if !x.is_finite() {
                    *x = 0.0;
                }
                if master_peak < x.abs() {
                    master_peak = x.abs();
                }
            }
            self.render_clicks(block, count, counting_in);
            if self.playing {
                self.position += i64::from(count);
            }
            if counting_in {
                self.count_in_remaining -= i64::from(count);
                if self.count_in_remaining <= 0 {
                    // The transport starts on the frame right after the count-in.
                    self.count_in_remaining = 0;
                    self.playing = self.active.is_some();
                    self.reset(self.playing, false);
                }
            }
            cursor += count;
        }
        self.master_feed = master_feed;
        if let Some(g) = &self.active
            && self.playing
            && !offline
        {
            match g.cycle {
                Some((start, end)) if self.position >= end => {
                    self.position = start;
                    self.reset(true, false);
                }
                None if self.position >= g.length_frames => self.stop_at_end(),
                _ => {}
            }
        }
        self.publish(master_peak);
    }

    /// The route inputs of the tapped tracks for frames `[cursor, cursor + count)` of this call.
    fn copy_taps(
        g: &Graph,
        taps: &[i32; MAX_TAPS],
        out: &mut [f32],
        max_block: u32,
        cursor: u32,
        count: u32,
    ) {
        let slot = max_block as usize * 2;
        for (k, &t) in taps.iter().enumerate() {
            if t < 0 {
                continue;
            }
            let from = k * slot + cursor as usize * 2;
            let Some(dst) = out.get_mut(from..from + count as usize * 2) else { continue };
            match g
                .tracks
                .get(t as usize)
                .filter(|x| x.routed)
                .and_then(|x| x.route_input.get(..count as usize * 2))
            {
                Some(src) => dst.copy_from_slice(src),
                None => dst.fill(0.0),
            }
        }
    }

    /// Puts this block's analysis probes on their tracks; returns (graph track, probe) per tap (-1: none).
    fn place_probes(
        g: &mut Graph,
        taps: &[AnalysisTap; MAX_ANALYSIS],
        probed: &mut bool,
    ) -> [(i32, usize); MAX_ANALYSIS] {
        let mut placed = [(-1i32, 0usize); MAX_ANALYSIS];
        let any = taps.iter().any(|t| t.track >= 0);
        if *probed || any {
            for t in &mut g.tracks {
                t.probes = [Probe::OFF; PROBES];
            }
        }
        *probed = any;
        for (k, tap) in taps.iter().enumerate() {
            let Some(t) = usize::try_from(tap.track).ok().and_then(|i| g.tracks.get_mut(i)) else { continue };
            if let Some((p, probe)) = t.probes.iter_mut().enumerate().find(|(_, p)| p.insert < 0)
                && let Some(out) = placed.get_mut(k)
            {
                *probe = Probe { insert: tap.insert, tuner: tap.tuner };
                *out = (tap.track, p);
            }
        }
        placed
    }

    /// The probed signals for frames `[cursor, cursor + count)` of this call (silence for a tap that found
    /// no track).
    fn copy_analysis(
        g: &Graph,
        placed: &[(i32, usize); MAX_ANALYSIS],
        out: &mut [f32],
        max_block: u32,
        cursor: u32,
        count: u32,
    ) {
        let slot = max_block as usize * 2;
        let n = count as usize * 2;
        for (k, &(track, probe)) in placed.iter().enumerate() {
            let from = k * slot + cursor as usize * 2;
            let Some(dst) = out.get_mut(from..from + n) else { continue };
            let src = usize::try_from(track).ok().and_then(|t| g.tracks.get(t)).and_then(|t| {
                let size = t.probe_out.len() / PROBES;
                t.probe_out.get(probe * size..probe * size + n)
            });
            match src {
                Some(src) => dst.copy_from_slice(src),
                None => dst.fill(0.0),
            }
        }
    }

    /// The analysis taps of the last render call (`MAX_ANALYSIS` stereo slots of `max_block` frames).
    pub fn analysis_output(&self) -> &[f32] {
        &self.analysis_out
    }

    /// The transport reached the project end (no cycle): plug-in style instruments release their
    /// notes next block, built-in voices ring out (engine.cpp `render`).
    fn stop_at_end(&mut self) {
        self.playing = false;
        if let Some(g) = &mut self.active {
            for t in &mut g.tracks {
                t.request_instrument_reset();
            }
        }
    }

    /// engine.cpp `renderClicks`: clicks after the master bus and meters, monitor only (offline engines
    /// never click). The count-in clicks evenly at the tempo and in the meter where the transport starts;
    /// the transport follows the tempo map and accents each bar's first pulse across meter changes.
    fn render_clicks(&mut self, out: &mut [f32], count: u32, counting_in: bool) {
        if self.config.offline {
            return;
        }
        let rate = f64::from(self.config.sample_rate);
        let Renderer { metronome, active, .. } = self;
        let gain = match &metronome.clicks {
            Some(c) if c.sample_rate == self.config.sample_rate => self.metronome_gain,
            _ => 0.0,
        };
        if gain <= 0.0 {
            if counting_in {
                self.count_in_elapsed += i64::from(count);
            }
            return;
        }
        let Metronome { clicks: Some(set), player } = metronome else { return };
        player.mix(set, out, count, gain);
        if let Some(g) = active {
            let position = self.position;
            if counting_in {
                let start = match &g.tempo {
                    Some(t) => t.beat_at_frame(position as f64, rate),
                    None => position as f64 * g.bpm / (60.0 * rate),
                };
                let meter = if g.meter_mapped {
                    g.meters.at(start)
                } else {
                    MeterEvent { bar: 0, numerator: g.meter.0, denominator: g.meter.1, beat: 0.0 }
                };
                let bpm = g.tempo.as_ref().map_or(g.bpm, |t| t.bpm_at(start));
                let pulses = grid(rate, bpm, meter.numerator, meter.denominator, None);
                clicks(&pulses, set, player, out, self.count_in_elapsed, count, gain, self.count_in_length);
            } else if self.metronome_on && self.playing && position < g.length_frames {
                if g.meter_mapped {
                    meter_clicks(
                        &g.meters,
                        rate,
                        g.bpm,
                        g.tempo.as_ref(),
                        set,
                        player,
                        out,
                        position,
                        count,
                        gain,
                    );
                } else {
                    let pulses = grid(rate, g.bpm, g.meter.0, g.meter.1, g.tempo.as_ref());
                    clicks(&pulses, set, player, out, position, count, gain, -1);
                }
            }
        }
        if counting_in {
            self.count_in_elapsed += i64::from(count);
        }
    }

    /// Each track's peak of the last block (graph order); returns how many it wrote.
    pub fn track_peaks(&self, out: &mut [f32]) -> usize {
        let Some(g) = &self.active else { return 0 };
        let mut n = 0;
        for (o, t) in out.iter_mut().zip(&g.tracks) {
            *o = t.peak;
            n += 1;
        }
        n
    }

    /// The route recording taps of the last render call (`MAX_TAPS` stereo slots of `max_block` frames).
    pub fn tap_output(&self) -> &[f32] {
        &self.tap_out
    }

    fn publish(&self, peak: f32) {
        let p = &self.published;
        p.frame.store(self.position, Ordering::Relaxed);
        p.playing.store(self.playing, Ordering::Relaxed);
        p.ready.store(self.active.is_some(), Ordering::Relaxed);
        p.revision.store(self.active.as_ref().map_or(0, |g| g.revision), Ordering::Relaxed);
        p.peak.store(peak.to_bits(), Ordering::Relaxed);
        p.leaked.store(self.leaked, Ordering::Relaxed);
        p.counting_in.store(self.count_in_remaining > 0, Ordering::Relaxed);
        p.live_played.store(self.live_played, Ordering::Relaxed);
        p.live_ignored.store(self.live_ignored, Ordering::Relaxed);
        p.ticket.store(self.last_ticket, Ordering::Release);
    }

    /// Plug-in delay of the running graph (frames).
    pub fn latency(&self) -> u32 {
        self.active.as_ref().map_or(0, |g| g.latency)
    }

    pub fn sender_latency(&self) -> u32 {
        self.active.as_ref().map_or(0, |g| g.sender_latency)
    }

    pub fn tail_seconds(&self) -> f64 {
        self.active.as_ref().map_or(0.0, |g| g.tail)
    }

    pub fn track_count(&self) -> usize {
        self.active.as_ref().map_or(0, |g| g.tracks.len())
    }

    pub fn position(&self) -> i64 {
        self.position
    }

    /// Voices sounding on track `index` of the running graph (diagnostics and tests).
    pub fn active_voices(&self, index: usize) -> usize {
        self.active.as_ref().and_then(|g| g.tracks.get(index)).map_or(0, |t| t.source.active_voices())
    }
}

mod ahead;
mod host;
pub use ahead::Ahead;
pub use host::{BlockInfo, DynamicsReading, HostTask, Parallel};

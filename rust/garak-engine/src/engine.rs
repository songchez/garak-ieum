//! The engine: a control half ([`Controller`]) that prepares graphs and classifies diffs, and an
//! audio half ([`Renderer`]) that applies commands at block boundaries and renders. Mirrors
//! native/src/engine.cpp `RenderEngine` (prepare / submit / update / render) for audio tracks.

use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::sync::Arc;
use alloc::vec;
use alloc::vec::Vec;
use core::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, Ordering};

use crate::delay::CompensationDelay;
use crate::error::{Error, require};
use crate::insert::{KernelCache, live_parameter, validated_values};
use crate::json::Json;
use crate::master::Master;
use crate::math;
use crate::plan::{LaneTarget, PcmAsset, Plan, TrackPlan};
use crate::protocol;
use crate::queue::{Consumer, Producer, channel};
use crate::tempo::TempoMap;
use crate::track::{Feed, Track, TrackInfo};

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
    /// Render order: senders first, then returns (the C++ processing levels without routes).
    order: Vec<usize>,
    master: Master,
    latency: u32,
    sender_latency: u32,
    tail: f64,
    /// Continues the running graph (same project): tracks adopt their predecessors.
    continues: bool,
}

enum Command {
    Graph(Box<Graph>),
    Play,
    Pause,
    Stop,
    Seek(i64),
    Mix { track: u32, gain: f32, pan: f32, audible: bool, unmuted_audible: bool },
    Send { ret: u32, sender: u32, pre: bool, gain: f32 },
    Param { track: u32, insert: u32, index: u32, value: f64 },
    Replace { track: u32, runtime: Box<Track> },
    Master(f32),
    Revision(u64),
}

enum Retired {
    Graph(#[allow(dead_code)] Box<Graph>),
    Track(#[allow(dead_code)] Box<Track>),
}

struct Ticketed {
    ticket: u64,
    command: Command,
}

/// Control-thread record of the running graph (C++ `ControlRecipe`).
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
    cache: KernelCache,
    recipe: Option<Recipe>,
    /// The host's merged copy of the project (what `project.patch` applies to).
    current: Option<Plan>,
    commands: Producer<Ticketed>,
    retired: Consumer<Retired>,
    published: Arc<Published>,
    ticket: u64,
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
    playing: bool,
    position: i64,
    master_gain: f32,
    target_master_gain: f32,
    last_ticket: u64,
    leaked: u64,
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
            cache: KernelCache::default(),
            recipe: None,
            current: None,
            commands: cp,
            retired: rc,
            published: published.clone(),
            ticket: 0,
        },
        Renderer {
            config,
            commands: cc,
            retired: rp,
            published,
            active: None,
            playing: false,
            position: 0,
            master_gain: 1.0,
            target_master_gain: 1.0,
            last_ticket: 0,
            leaked: 0,
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

    /// Latency (frames), sender latency and tail (seconds) of the last submitted graph.
    pub fn graph_info(&self) -> Option<(u32, u32, f64)> {
        self.recipe.as_ref().map(|r| (r.sender_latency + r.return_latency, r.sender_latency, r.tail))
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
        self.enqueue(Command::Play)
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
        for t in &p.tracks {
            let (track, info) = Track::build(p, t, &self.assets, self.config.max_block, &mut self.cache)?;
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
        for t in &mut tracks {
            if t.is_return {
                t.compensation = CompensationDelay::new(return_latency.saturating_sub(t.latency));
            } else {
                t.compensation = CompensationDelay::new(sender_latency - t.latency);
                t.output_delay = CompensationDelay::new(return_latency);
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
        let mut order: Vec<usize> =
            (0..tracks.len()).filter(|&i| !p.tracks.get(i).is_some_and(|t| t.is_return)).collect();
        order.extend((0..tracks.len()).filter(|&i| p.tracks.get(i).is_some_and(|t| t.is_return)));
        let graph = Graph {
            project_id: p.project_id.clone(),
            revision: p.revision,
            length_frames: p.length_frames,
            cycle: p.cycle,
            master_gain: p.master_gain,
            tempo: if p.tempo_map.is_empty() { None } else { Some(TempoMap::new(p.bpm, &p.tempo_map)) },
            tracks,
            order,
            master: Master::new(sr),
            latency: sender_latency + return_latency,
            sender_latency,
            tail,
            continues: false,
        };
        let recipe = Recipe { plan: p.clone(), tracks: infos, sender_latency, return_latency, tail };
        Ok((Box::new(graph), recipe))
    }

    /// Submits a new graph that continues the running one by track id (engine.cpp `submit`).
    fn full(&mut self, p: Plan) -> Result<Applied, Error> {
        let (mut graph, recipe) = self.prepare(&p)?;
        if let Some(last) = &self.recipe
            && last.plan.project_id == p.project_id
        {
            graph.continues = true;
            for (t, plan) in graph.tracks.iter_mut().zip(&p.tracks) {
                if let Some(prev) = last.plan.tracks.iter().position(|o| o.id == plan.id) {
                    t.predecessor = Some(prev);
                    if let Some(old) = last.plan.tracks.get(prev) {
                        t.insert_origin = insert_origins(old, plan);
                    }
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
        let Some(last) = &self.recipe else { return self.full(p) };
        if p.project_id != last.plan.project_id
            || p.sample_rate != last.plan.sample_rate
            || !p.same_timing(&last.plan)
            || p.low_latency_monitoring != last.plan.low_latency_monitoring
            || p.tracks.len() != last.plan.tracks.len()
            || p.tracks.iter().zip(&last.plan.tracks).any(|(a, b)| a.id != b.id)
        {
            return self.full(p);
        }
        checked(f64::from(p.master_gain), 0.0, 2.0, "Invalid native master gain")?;
        #[derive(Default)]
        struct Edit {
            replace: bool,
            mix: bool,
            sends: Vec<usize>,
            params: Vec<(u32, u32, f64)>,
        }
        let mut edits: Vec<Edit> = Vec::with_capacity(p.tracks.len());
        for (neu, (old, info)) in p.tracks.iter().zip(last.plan.tracks.iter().zip(&last.tracks)) {
            let mut e = Edit::default();
            if neu.is_return != old.is_return || neu.route != old.route || neu.sends.len() != old.sends.len()
            {
                return self.full(p);
            }
            for (s, (a, b)) in neu.sends.iter().zip(&old.sends).enumerate() {
                if a.return_id != b.return_id
                    || a.pre != b.pre
                    || send_lane(neu, &a.return_id) != send_lane(old, &b.return_id)
                {
                    return self.full(p);
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
                || neu.notes != old.notes
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
                {
                    replace = true;
                    break;
                }
                if a.params == b.params {
                    continue;
                }
                let Some(Some(insert)) = runtime.get(k) else { continue }; // disabled: recipe only
                let Some(kind) = garak_dsp::EffectKind::from_id(a.kind.as_bytes()) else {
                    replace = true;
                    break;
                };
                validated_values(kind, a)?;
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
                    let index = kind.params().iter().position(|d| d.id == name).unwrap_or(0);
                    e.params.push((*insert as u32, index as u32, value));
                }
            }
            if !replace && neu.enabled {
                // A re-registered PCM asset under the same id: the track resolves it again.
                let resolved: Vec<usize> = neu
                    .audio
                    .iter()
                    .map(|w| self.assets.get(&w.asset_id).map_or(0, |a| Arc::as_ptr(a) as usize))
                    .collect();
                replace = resolved != info.assets;
            }
            e.replace = replace;
            if replace {
                e.mix = false;
                e.params.clear();
            }
            edits.push(e);
        }
        // Replacements (control thread); a latency change falls back to a full graph.
        let (sender_latency, return_latency) = (last.sender_latency, last.return_latency);
        let mut replacements: Vec<(usize, Box<Track>, TrackInfo)> = Vec::new();
        for (i, e) in edits.iter().enumerate() {
            if !e.replace {
                continue;
            }
            let (Some(neu), Some(old), Some(info)) =
                (p.tracks.get(i), last.plan.tracks.get(i), last.tracks.get(i))
            else {
                continue;
            };
            let (mut t, new_info) =
                Track::build(&p, neu, &self.assets, self.config.max_block, &mut self.cache)?;
            if new_info.latency != info.latency {
                return self.full(p);
            }
            t.predecessor = Some(i);
            t.insert_origin = insert_origins(old, neu);
            if old.is_return {
                t.compensation = CompensationDelay::new(return_latency.saturating_sub(t.latency));
            } else {
                t.compensation = CompensationDelay::new(sender_latency - t.latency);
                t.output_delay = CompensationDelay::new(return_latency);
            }
            replacements.push((i, Box::new(t), new_info));
        }
        let mut commands: Vec<Command> = Vec::new();
        let mut infos: Vec<(usize, TrackInfo)> = Vec::new();
        for (i, runtime, info) in replacements {
            commands.push(Command::Replace { track: i as u32, runtime });
            infos.push((i, info));
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
            for (i, info) in infos {
                if let (Some(slot), Some(t)) = (recipe.tracks.get_mut(i), p.tracks.get(i)) {
                    *slot = info;
                    if let Some(pt) = recipe.plan.tracks.get_mut(i) {
                        *pt = t.clone();
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

    fn reset(&mut self, effects: bool) {
        if let Some(g) = &mut self.active {
            for t in &mut g.tracks {
                t.reset(effects);
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
    /// which its own matching command applies; see `host.rs`).
    fn consume_until(&mut self, limit: u64) {
        while self.commands.peek().is_some_and(|c| c.ticket <= limit) {
            let Some(Ticketed { ticket, command }) = self.commands.pop() else { break };
            match command {
                Command::Graph(mut next) => {
                    let previous = self.active.take();
                    let project_changed = previous.as_ref().is_none_or(|p| p.project_id != next.project_id);
                    let preserve = next.continues && !project_changed;
                    self.target_master_gain = next.master_gain;
                    let mut previous = previous;
                    if preserve && let Some(prev) = &mut previous {
                        for t in &mut next.tracks {
                            match t.predecessor.and_then(|i| prev.tracks.get_mut(i)) {
                                Some(old) => t.adopt(old, false),
                                None => t.reset(true),
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
                    }
                    self.normalize(false);
                    if !preserve {
                        self.reset(true);
                    }
                    if let Some(prev) = previous {
                        self.retire(Retired::Graph(prev));
                    }
                }
                Command::Play => {
                    if !self.playing {
                        self.normalize(true);
                        self.playing = self.active.is_some();
                        self.reset(false);
                    }
                }
                Command::Pause => {
                    self.playing = false;
                    self.reset(false);
                }
                Command::Stop => {
                    self.playing = false;
                    self.position = 0;
                    self.reset(true);
                }
                Command::Seek(frame) => {
                    self.position = frame;
                    self.normalize(false);
                    self.reset(true);
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
                    {
                        i.set_param(index as usize, value);
                        i.commit();
                    }
                }
                Command::Replace { track, mut runtime } => {
                    let slot = self.active.as_mut().and_then(|g| g.tracks.get_mut(track as usize));
                    match slot {
                        Some(old) => {
                            runtime.adopt(old, true);
                            core::mem::swap(old, &mut runtime);
                            self.retire(Retired::Track(runtime));
                        }
                        None => self.retire(Retired::Track(runtime)),
                    }
                }
                Command::Master(gain) => self.target_master_gain = gain,
                Command::Revision(revision) => {
                    if let Some(g) = &mut self.active {
                        g.revision = revision;
                    }
                }
            }
            self.last_ticket = ticket;
        }
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

    /// Every track of one block in render order, summed into `block` in track order (the master
    /// is applied by the caller). With `parallel`, independent tracks render on the host's workers
    /// (`host.rs`); the sum is the same either way.
    fn render_tracks(
        g: &mut Graph,
        block: &mut [f32],
        position: i64,
        count: u32,
        playing: bool,
        rate: f64,
        parallel: Option<&host::Parallel>,
    ) {
        let tempo = g.tempo.as_ref().map(|t| t.bpm_at(t.beat_at_frame(position as f64, rate)));
        let smoothing = math::smoothing(rate, 0.012);
        let senders = parallel.map_or(0, |p| host::render_parallel(g, p, position, count, playing, tempo));
        {
            for k in senders..g.order.len() {
                let Some(&index) = g.order.get(k) else { continue };
                if g.tracks.get(index).is_some_and(|t| t.is_return) {
                    Self::fill_return_input(g, index, position, count, smoothing);
                }
                if let Some(t) = g.tracks.get_mut(index) {
                    t.render(position, count, playing, tempo);
                }
            }
        }
        for t in g.tracks.iter().filter(|t| t.direct_out()) {
            for (o, x) in block.iter_mut().zip(t.mix(count)) {
                *o += *x;
            }
        }
    }

    /// Renders `out.len() / 2` stereo frames (interleaved). Real-time safe.
    pub fn render(&mut self, out: &mut [f32]) {
        self.consume();
        let frames = (out.len() / 2) as u32;
        let rate = f64::from(self.config.sample_rate);
        let offline = self.config.offline;
        let mut cursor = 0u32;
        let mut master_peak = 0.0f32;
        while cursor < frames {
            let mut count = self.config.max_block.min(frames - cursor);
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
                            self.reset(false);
                        }
                        None => self.playing = false,
                    }
                }
                if self.playing && self.position < boundary {
                    count = count.min((boundary - self.position) as u32);
                }
            }
            let Some(block) = out.get_mut(cursor as usize * 2..(cursor + count) as usize * 2) else { break };
            block.fill(0.0);
            let position = self.position;
            if let Some(g) = &mut self.active {
                let playing = self.playing && position < g.length_frames;
                Self::render_tracks(g, block, position, count, playing, rate, None);
                let s = math::smoothing(rate, 0.012) as f32;
                for pair in block.as_chunks_mut::<2>().0 {
                    self.master_gain =
                        math::mul_add_f32(self.target_master_gain - self.master_gain, s, self.master_gain);
                    for x in pair {
                        *x *= self.master_gain;
                    }
                }
                g.master.process(block);
            }
            for x in block.iter_mut() {
                if !x.is_finite() {
                    *x = 0.0;
                }
                if master_peak < x.abs() {
                    master_peak = x.abs();
                }
            }
            if self.playing {
                self.position += i64::from(count);
            }
            cursor += count;
        }
        if let Some(g) = &self.active
            && self.playing
            && !offline
        {
            match g.cycle {
                Some((start, end)) if self.position >= end => {
                    self.position = start;
                    self.reset(false);
                }
                None if self.position >= g.length_frames => self.playing = false,
                _ => {}
            }
        }
        self.publish(master_peak);
    }

    fn publish(&self, peak: f32) {
        let p = &self.published;
        p.frame.store(self.position, Ordering::Relaxed);
        p.playing.store(self.playing, Ordering::Relaxed);
        p.ready.store(self.active.is_some(), Ordering::Relaxed);
        p.revision.store(self.active.as_ref().map_or(0, |g| g.revision), Ordering::Relaxed);
        p.peak.store(peak.to_bits(), Ordering::Relaxed);
        p.leaked.store(self.leaked, Ordering::Relaxed);
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
}

mod host;
pub use host::{DynamicsReading, HostTask, Parallel};

//! One track at runtime (engine.cpp `TrackRuntime`) and its control-thread construction
//! (`buildTrack` + `prepareAutomation`). Audio sources only in this milestone: windows ->
//! (return input) -> inserts -> plug-in delay compensation -> fader/pan/mute (smoothed or
//! automated per sample) -> output delay, with the post-FX and post-fader taps sends read.

use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::sync::Arc;
use alloc::vec;
use alloc::vec::Vec;

use crate::automation;
use crate::clip::Window;
use crate::delay::CompensationDelay;
use crate::error::{Error, require};
use crate::insert::{Insert, KernelCache, estimate_memory, widens};
use crate::math;
use crate::plan::{AutomationLane, LaneTarget, PcmAsset, Plan, RouteKind, RouteTap, SourceKind, TrackPlan};

/// A track's live input for one block (engine.cpp `renderTrack` -> `TrackRuntime::render` arguments).
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct TrackInput<'a> {
    /// Interleaved stereo input (`count * 2`), added before the inserts while monitored.
    pub data: Option<&'a [f32]>,
    /// The track is monitored (returns: always, their input is the send mix).
    pub monitor: bool,
    /// The input is stereo (a mono input pans with the mono law).
    pub stereo: bool,
    /// Playing, realtime and the project's low-latency monitoring: a monitored track skips plug-in delay
    /// compensation (C++ `lowLatencyMonitor`).
    pub low_latency: bool,
}

/// Live note and controller events for a track (docs/RUST_ENGINE.md 5.7): what live MIDI, the computer
/// keyboard and note previews send while the engine plays. Instrument tracks consume them; audio tracks
/// ignore them (`Track::live_event` returns false).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LiveEvent {
    NoteOn { pitch: u8, velocity: f32, id: i32 },
    NoteOff { pitch: u8, id: i32 },
    AllNotesOff,
    Control { controller: u16, value: i32 },
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
    /// Identities of the resolved PCM (a re-registered asset under the same id rebuilds the track).
    pub assets: Vec<usize>,
}

#[derive(Debug)]
pub(crate) struct Track {
    pub plan: TrackPlan,
    pub windows: Vec<Window>,
    pub inserts: Vec<Insert>,
    pub lanes: Vec<LaneRuntime>,
    volume_lane: Option<usize>,
    pan_lane: Option<usize>,
    mute_lane: Option<usize>,
    pub latency: u32,
    pub compensation: CompensationDelay,
    pub output_delay: CompensationDelay,
    pub buffer: Vec<f32>,
    pub post_tap: Vec<f32>,
    pub fader_tap: Vec<f32>,
    pub return_input: Vec<f32>,
    /// Track-input routes (docs/TRACK_INPUT_ROUTING.md, engine.cpp `prepareRoutes`): the source's pre-FX tap,
    /// this track's route input, and where it comes from. Filled by the graph's preparation.
    pub pre_tap: Vec<f32>,
    pub route_input: Vec<f32>,
    pub routed: bool,
    pub route_kind: RouteKind,
    pub route_tap: RouteTap,
    pub route_source: Option<usize>,
    /// Heard by master-resampling tracks (false for them and everything downstream).
    pub in_master_feed: bool,
    pub feeds: Vec<Feed>,
    pub fader: f64,
    pub pan_value: f64,
    pub mute_gain: f64,
    pub peak: f32,
    stereo_source: bool,
    stereo_effects: bool,
    pub is_return: bool,
    sample_rate: f64,
    /// Continuation (filled on the control thread, consumed by `adopt`): per runtime insert, the
    /// predecessor's runtime insert with the same id and type.
    pub insert_origin: Vec<Option<usize>>,
    pub predecessor: Option<usize>,
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
        cache: &mut KernelCache,
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
            inserts: Vec::new(),
            lanes: Vec::new(),
            volume_lane: None,
            pan_lane: None,
            mute_lane: None,
            latency: 0,
            compensation: CompensationDelay::default(),
            output_delay: CompensationDelay::default(),
            buffer: vec![0.0; max_block as usize * 2],
            post_tap: Vec::new(),
            fader_tap: Vec::new(),
            return_input: Vec::new(),
            pre_tap: Vec::new(),
            route_input: Vec::new(),
            routed: false,
            route_kind: RouteKind::None,
            route_tap: RouteTap::PostFx,
            route_source: None,
            in_master_feed: true,
            feeds: Vec::new(),
            fader: if t.audible { f64::from(t.gain) } else { 0.0 },
            pan_value: f64::from(t.pan),
            mute_gain: 1.0,
            peak: 0.0,
            stereo_source: false,
            stereo_effects: false,
            is_return: t.is_return,
            sample_rate,
            insert_origin: Vec::new(),
            predecessor: None,
        };
        // A disabled source needs neither its PCM nor its effects.
        if !t.enabled {
            return Ok((track, info));
        }
        if t.source.kind != SourceKind::Audio {
            return Err(Error::new(
                "garak-engine renders audio tracks only (instrument sources: docs/RUST_ENGINE.md 6)",
            ));
        }
        for e in t.inserts.iter().filter(|e| e.enabled) {
            info.memory += estimate_memory(&e.kind, sample_rate);
        }
        let mut tail = 0.0;
        for w in &t.audio {
            require(
                w.start_frame >= 0
                    && w.end_frame > w.start_frame
                    && w.end_frame <= p.length_frames
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
            if e.kind == "vst3" {
                return Err(Error::new("VST3 inserts stay in the C++ host (docs/RUST_ENGINE.md 4)"));
            }
            let insert = Insert::new(e, index as u16, sample_rate, p.bpm, cache)?;
            track.latency += insert.latency();
            tail += insert.tail();
            track.stereo_effects |= widens(e);
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
            let mut l = LaneRuntime { lane: index, insert: None, control: None, hint: 0 };
            match lane.target {
                LaneTarget::Volume => self.volume_lane = Some(self.lanes.len()),
                LaneTarget::Pan => self.pan_lane = Some(self.lanes.len()),
                LaneTarget::Mute => self.mute_lane = Some(self.lanes.len()),
                // Send lanes are evaluated by the fed return; instrument lanes need an instrument.
                LaneTarget::Send | LaneTarget::Instrument => continue,
                LaneTarget::Insert => {
                    let Some(source) = self.plan.inserts.iter().position(|e| e.id == lane.insert_id) else {
                        continue;
                    };
                    let Some(runtime) = self.inserts.iter().position(|i| usize::from(i.source) == source)
                    else {
                        continue;
                    };
                    let Some(insert) = self.inserts.get_mut(runtime) else { continue };
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

    /// engine.cpp `TrackRuntime::reset` for audio tracks: effect state and the PDC line when
    /// `effects` (seek, stop, a new graph); transport-only resets keep everything.
    pub fn reset(&mut self, effects: bool) {
        if effects {
            for i in &mut self.inserts {
                i.reset();
            }
            self.compensation.reset();
        }
    }

    /// engine.cpp `TrackRuntime::adopt`: continue from `previous` (the same track id) at a block
    /// boundary. `routing`: a single-track replacement keeps the graph, so the graph-derived send
    /// state moves too. Audio thread: swaps and copies only.
    pub fn adopt(&mut self, previous: &mut Track, routing: bool) {
        self.peak = previous.peak;
        self.fader = previous.fader;
        self.pan_value = previous.pan_value;
        self.mute_gain = previous.mute_gain;
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
            self.routed = previous.routed;
            self.route_kind = previous.route_kind;
            self.route_tap = previous.route_tap;
            self.route_source = previous.route_source;
            self.in_master_feed = previous.in_master_feed;
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
    }

    /// One block of `count` frames at project frame `frame` (engine.cpp `TrackRuntime::render`,
    /// offline/not-monitored path). `return_input` must be filled first on returns. `tempo`: the
    /// tempo at the block start when the project has a tempo map (synced effects follow it).
    pub fn render(
        &mut self,
        frame: i64,
        count: u32,
        playing: bool,
        tempo: Option<f64>,
        input: TrackInput<'_>,
    ) {
        let n = count as usize * 2;
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
            compensation,
            output_delay,
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
            return;
        }
        if playing {
            let end = frame + i64::from(count);
            for w in windows.iter() {
                if w.w.start_frame >= end {
                    break;
                }
                if w.w.end_frame <= frame {
                    continue;
                }
                w.render(buf, frame, count, self.sample_rate);
            }
        }
        if self.is_return {
            // A return's "monitor" input is its send mix (always compensated, never low latency).
            for (b, x) in buf.iter_mut().zip(return_input.iter()) {
                *b += *x;
            }
        } else if input.monitor
            && let Some(live) = input.data
        {
            for (b, x) in buf.iter_mut().zip(live.iter()) {
                *b += *x;
            }
        }
        if let Some(t) = pre_tap.get_mut(..n) {
            t.copy_from_slice(buf);
        }
        for (index, insert) in inserts.iter_mut().enumerate() {
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
                    if l.insert == Some(index)
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
        // A reduced-latency monitor deliberately avoids waiting for unrelated tracks; a return always stays
        // compensated.
        let low_latency = input.monitor && input.low_latency && !self.is_return;
        if !low_latency {
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
            if !low_latency {
                output_delay.process(buf);
            }
            return;
        }
        let target_pan = f64::from(plan.pan);
        let target_gain = if plan.audible { f64::from(plan.gain) } else { 0.0 };
        let smoothing = math::smoothing(self.sample_rate, 0.012);
        let automated = self.volume_lane.is_some() || self.pan_lane.is_some() || self.mute_lane.is_some();
        let mute_smoothing = math::smoothing(self.sample_rate, 0.003);
        let mono =
            !(self.stereo_source || self.stereo_effects || self.is_return || (input.monitor && input.stereo));
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
        if !low_latency {
            output_delay.process(buf);
        }
    }

    /// A live event for this track (audio thread). Audio tracks have no instrument: false (ignored).
    /// The instrument port (docs/RUST_ENGINE.md 6) plays them through the track's voices.
    pub fn live_event(&mut self, event: LiveEvent) -> bool {
        let _ = event;
        false
    }

    /// The post-fader signal (before the return-latency delay), what a post-fader route records.
    pub fn post_fader(&self, count: u32) -> &[f32] {
        let n = count as usize * 2;
        match self.fader_tap.get(..n) {
            Some(t) => t,
            None => self.mix(count),
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

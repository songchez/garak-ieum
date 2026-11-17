//! Instrument sources of a track (engine.cpp `TrackRuntime`'s instrument half): the built-in
//! synthesizers, drum kit and sample players (garak-dsp `instruments::builtin`, rendered between
//! the timeline's note onsets and controller events), and the vintage instruments 옥구슬 EP / 한밤
//! 106 (garak-dsp `instruments::Instrument`, fed sample-accurate events exactly like the C++
//! `RustInstrumentProcessor` plug-in wrapper). Also: note / controller cursors, seek and cycle
//! chasing (pedal and controller state included), live MIDI, and the state hand-over of an edited
//! track (docs/RENDER_DIFF_PROTOCOL.md 4.2).
//!
//! Control thread: [`build`] validates the source, resolves the sample set and prepares the event
//! list. Audio thread: everything else, on preallocated storage only.

use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::format;
use alloc::string::String;
use alloc::sync::Arc;
use alloc::vec;
use alloc::vec::Vec;

use garak_dsp::instruments::builtin::{
    MAX_VOICES, NoSamples, Pcm, SampleBank, Synth, SynthKind, VoiceContext, Voices, Zone, controller,
};
use garak_dsp::instruments::{Instrument, InstrumentEvent, InstrumentKind, event};

use crate::error::{Error, require};
use crate::plan::{ControlEvent, Note, PcmAsset, Plan, SampleSet, SourceKind, TrackPlan};

/// Events per block of a plug-in style instrument (engine.cpp `maxPluginEvents`).
pub(crate) const MAX_PLUGIN_EVENTS: usize = 2048;
/// Frames of an "unlimited" live note (engine.cpp `unlimitedFrame`).
pub const UNLIMITED_FRAME: i64 = i64::MAX / 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EventType {
    NoteOn,
    NoteOff,
    Controller,
}

/// Same-sample order: (reset,) then controllers (a pedal-down catches a note-off at that sample),
/// then note-offs, then note-ons (engine.cpp `eventOrder`).
const fn event_order(kind: EventType) -> u8 {
    match kind {
        EventType::Controller => 1,
        EventType::NoteOff => 2,
        EventType::NoteOn => 3,
    }
}

/// engine.hpp `PluginEvent` (the fields the vintage instruments read).
#[derive(Clone, Copy, Debug, PartialEq)]
struct PluginEvent {
    kind: EventType,
    offset: u32,
    note_id: i32,
    pitch: u8,
    value: f32,
    parameter: u32,
    audition: bool,
}

impl PluginEvent {
    const fn new(
        kind: EventType,
        note_id: i32,
        pitch: u8,
        value: f32,
        parameter: u32,
        audition: bool,
    ) -> Self {
        Self { kind, offset: 0, note_id, pitch, value, parameter, audition }
    }
}

#[derive(Clone, Copy, Debug)]
struct TimedEvent {
    frame: i64,
    event: PluginEvent,
}

#[derive(Clone, Copy, Debug, Default)]
struct LiveNote {
    active: bool,
    id: i32,
    pitch: u8,
    remaining: i64,
}

#[derive(Clone, Copy, Debug, Default)]
struct DeferredOff {
    id: i32,
    pitch: u8,
}

/// A note of the predecessor that the edited track no longer has (released if sounding).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RemovedNote {
    pub id: i32,
    pub on_frame: i64,
    pub off_frame: i64,
    pub pitch: u8,
}

/// engine.hpp `normalizedControllerValue`.
fn normalized_controller(number: i32, value: i32) -> f32 {
    if number == controller::PITCH_BEND { (value + 8192) as f32 / 16383.0 } else { value as f32 / 127.0 }
}

/// engine.hpp `resetController`: the rest value of controllers that return to a default.
fn reset_controller(number: i32) -> Option<i32> {
    match number {
        controller::MOD_WHEEL
        | controller::SUSTAIN
        | controller::CHANNEL_PRESSURE
        | controller::PITCH_BEND => Some(0),
        controller::EXPRESSION => Some(127),
        _ => None,
    }
}

/// engine.hpp `validControllerValue`.
pub fn valid_controller_value(number: i32, value: i32) -> bool {
    if !(0..controller::COUNT).contains(&number) {
        return false;
    }
    match number {
        controller::PITCH_BEND => (-8192..=8191).contains(&value),
        controller::BEND_RANGE => (0..=48).contains(&value),
        _ => (0..=127).contains(&value),
    }
}

/// A sample set with its PCM resolved (C++ `ResolvedSet`).
#[derive(Debug, Default)]
pub(crate) struct ResolvedSet {
    is_kit: bool,
    gain_db: f64,
    start_offset: f64,
    zones: Vec<Zone>,
    zone_pcm: Vec<Arc<PcmAsset>>,
    releases: Vec<Zone>,
    release_pcm: Vec<Arc<PcmAsset>>,
}

impl SampleBank for ResolvedSet {
    fn is_kit(&self) -> bool {
        self.is_kit
    }
    fn gain_db(&self) -> f64 {
        self.gain_db
    }
    fn start_offset(&self) -> f64 {
        self.start_offset
    }
    fn zones(&self) -> &[Zone] {
        &self.zones
    }
    fn releases(&self) -> &[Zone] {
        &self.releases
    }
    #[inline]
    fn pcm(&self, release: bool, index: usize) -> Option<Pcm<'_>> {
        let a = if release { self.release_pcm.get(index) } else { self.zone_pcm.get(index) }?;
        Some(Pcm { samples: &a.samples, channels: a.channels, sample_rate: a.sample_rate })
    }
}

/// Built-in synthesizer / drum kit / sample player.
#[derive(Debug)]
pub(crate) struct Builtin {
    pub synth: Synth,
    sampled: bool,
    samples: ResolvedSet,
    voices: Box<Voices>,
}

/// 옥구슬 EP / 한밤 106 behind the plug-in event path (engine.cpp + rust_instrument.hpp).
#[derive(Debug)]
pub(crate) struct Vintage {
    instrument: Box<Instrument>,
    events: Vec<TimedEvent>,
    pending: [PluginEvent; MAX_VOICES],
    pending_count: usize,
    live_notes: [LiveNote; MAX_VOICES],
    deferred: [DeferredOff; MAX_VOICES],
    deferred_count: usize,
    live_pedal: bool,
    /// `RustInstrumentProcessor::requestReset`: release everything and rest the controllers next block.
    reset: bool,
    block: Vec<PluginEvent>,
    converted: Vec<InstrumentEvent>,
    left: Vec<f32>,
    right: Vec<f32>,
}

#[derive(Debug, Default)]
#[allow(clippy::large_enum_variant)] // One per track, built on the control thread.
pub(crate) enum Source {
    #[default]
    Audio,
    Builtin(Builtin),
    Vintage(Vintage),
}

/// Event cursors into the track's notes, controls and (vintage) plug-in events.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Cursors {
    pub note: usize,
    pub event: usize,
    pub control: usize,
}

/// What a built source adds to the track (control thread).
#[derive(Debug, Default)]
pub(crate) struct Built {
    pub source: Source,
    pub tail: f64,
    pub stereo: bool,
    pub assets: Vec<usize>,
    pub set: Option<Arc<SampleSet>>,
}

fn checked(value: f64, minimum: f64, maximum: f64, message: &str) -> Result<f64, Error> {
    require(value.is_finite() && value >= minimum && value <= maximum, message)?;
    Ok(value)
}

fn parameter(
    p: &[(String, f64)],
    name: &str,
    fallback: f64,
    minimum: f64,
    maximum: f64,
) -> Result<f64, Error> {
    let value = p.iter().find(|(k, _)| k == name).map_or(fallback, |(_, v)| *v);
    checked(value, minimum, maximum, "Invalid native instrument parameter")
}

/// engine.cpp `compileSynth`.
fn compile_synth(t: &TrackPlan) -> Result<Synth, Error> {
    let s = &t.source;
    let p = &s.params[..];
    let mut r = Synth::default();
    let mut permitted: Vec<&str> = vec!["level", "tone"];
    if s.kind == SourceKind::BuiltinSampled {
        r.kind = SynthKind::Sampled;
        if s.is_kit {
            permitted.extend(["tune", "decay"]);
            r.tune = parameter(p, "tune", 0.0, -12.0, 12.0)?;
            r.decay = parameter(p, "decay", 1.0, 0.1, 1.0)?;
        } else {
            permitted.extend(["attack", "release", "releaseNoise"]);
            r.attack = parameter(p, "attack", 0.001, 0.001, 2.0)?;
            r.release = parameter(p, "release", 0.25, 0.02, 5.0)?;
            r.release_noise = parameter(p, "releaseNoise", 0.5, 0.0, 1.0)?;
        }
    } else if s.instrument_id == "drums" {
        r.kind = SynthKind::Drums;
        permitted.extend(["tune", "decay", "punch"]);
        r.tune = parameter(p, "tune", 0.0, -12.0, 12.0)?;
        r.decay = parameter(p, "decay", 1.0, 0.3, 3.0)?;
        r.punch = parameter(p, "punch", 1.0, 0.5, 2.0)?;
    } else {
        permitted.extend(["attack", "decay", "sustain", "release"]);
        match s.instrument_id.as_str() {
            "bass" => {
                r.kind = SynthKind::Bass;
                (r.attack, r.decay, r.sustain, r.release) = (0.006, 0.09, 0.65, 0.13);
                permitted.push("sub");
                r.sub = parameter(p, "sub", 0.65, 0.0, 1.0)?;
            }
            "keys" => {
                r.kind = SynthKind::Keys;
                permitted.push("bell");
                r.bell = parameter(p, "bell", 0.2, 0.0, 0.6)?;
            }
            "pad" => {
                r.kind = SynthKind::Pad;
                (r.attack, r.decay, r.sustain, r.release) = (0.08, 0.24, 0.7, 0.7);
                permitted.push("detune");
                r.detune = parameter(p, "detune", 7.0, 0.0, 40.0)?;
            }
            "pluck" => {
                r.kind = SynthKind::Pluck;
                (r.attack, r.decay, r.sustain, r.release) = (0.003, 0.12, 0.08, 0.16);
                permitted.push("sweep");
                r.sweep = parameter(p, "sweep", 0.25, 0.02, 1.0)?;
            }
            "rhodes" => {
                r.kind = SynthKind::Rhodes;
                (r.attack, r.decay, r.sustain, r.release) = (0.003, 2.5, 0.0, 0.25);
                permitted.push("bark");
                r.bark = parameter(p, "bark", 0.5, 0.0, 1.0)?;
            }
            other => return Err(Error::new(format!("Unknown native synthesizer: {other}"))),
        }
        r.attack = parameter(p, "attack", r.attack, 0.001, 2.0)?;
        let rhodes = r.kind == SynthKind::Rhodes;
        r.decay =
            parameter(p, "decay", r.decay, if rhodes { 0.2 } else { 0.01 }, if rhodes { 6.0 } else { 3.0 })?;
        r.sustain = parameter(p, "sustain", r.sustain, 0.0, 1.0)?;
        r.release = parameter(p, "release", r.release, 0.01, 5.0)?;
    }
    r.level = parameter(p, "level", 1.0, 0.0, 2.0)?;
    r.tone = parameter(p, "tone", 0.0, -1.0, 1.0)?;
    for (name, _) in p {
        require(permitted.contains(&name.as_str()), "Unknown native instrument parameter")?;
    }
    Ok(r)
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

/// engine.cpp `resolveSet`.
fn resolve_set(set: &SampleSet, assets: &BTreeMap<String, Arc<PcmAsset>>) -> Result<ResolvedSet, Error> {
    let mut r = ResolvedSet {
        is_kit: set.is_kit,
        gain_db: checked(set.gain_db, -120.0, 48.0, "Invalid sample set gain")?,
        start_offset: checked(set.start_offset, 0.0, 10.0, "Invalid sample codec offset")?,
        ..ResolvedSet::default()
    };
    require(
        !set.zones.is_empty() && set.zones.len() <= 10_000 && set.release_zones.len() <= 10_000,
        "Invalid sample zone count",
    )?;
    let convert = |zones: &[crate::plan::SampleZone],
                   out: &mut Vec<Zone>,
                   pcm: &mut Vec<Arc<PcmAsset>>|
     -> Result<(), Error> {
        for z in zones {
            require(
                (0..=127).contains(&z.root) && z.lo >= 0 && z.hi <= 127 && z.lo <= z.hi,
                "Invalid sample key range",
            )?;
            checked(z.vlo, 0.0, 1.0, "Invalid velocity zone")?;
            checked(z.vhi, z.vlo, 1.0, "Invalid velocity zone")?;
            checked(z.gain_db, -120.0, 48.0, "Invalid sample gain")?;
            checked(z.tune, -4800.0, 4800.0, "Invalid sample tuning")?;
            let a = resolve_asset(assets, &z.asset_id)?;
            let rate = f64::from(a.sample_rate);
            require(set.start_offset * rate < a.frames() as f64, "Sample codec offset exceeds asset")?;
            if let Some([start, end]) = z.looped {
                let seconds = a.frames() as f64 / rate;
                checked(start, 0.0, seconds, "Invalid sample loop start")?;
                checked(end, start, seconds - set.start_offset, "Invalid sample loop end")?;
                require(end > start, "Empty sample loop")?;
            }
            out.push(Zone {
                root: z.root,
                lo: z.lo,
                hi: z.hi,
                vlo: z.vlo,
                vhi: z.vhi,
                gain_db: z.gain_db,
                tune: z.tune,
                looped: z.looped,
                choke: z.choke,
            });
            pcm.push(a);
        }
        Ok(())
    };
    convert(&set.zones, &mut r.zones, &mut r.zone_pcm)?;
    convert(&set.release_zones, &mut r.releases, &mut r.release_pcm)?;
    Ok(r)
}

/// Whether a `builtin-synth` instrument id is a vintage (Rust) instrument (rust_instrument.hpp).
pub fn vintage_kind(t: &TrackPlan) -> Option<InstrumentKind> {
    if t.source.kind == SourceKind::BuiltinSynth {
        InstrumentKind::from_id(t.source.instrument_id.as_bytes())
    } else {
        None
    }
}

/// Validates notes and controls, sorts the notes (engine.cpp `buildTrack`) and builds the
/// instrument source. `plan.notes` is sorted in place. Control thread.
pub(crate) fn build(
    p: &Plan,
    t: &mut TrackPlan,
    assets: &BTreeMap<String, Arc<PcmAsset>>,
    sets: &BTreeMap<String, Arc<SampleSet>>,
    max_block: u32,
) -> Result<Built, Error> {
    let mut built = Built::default();
    let kind = t.source.kind;
    let vintage = vintage_kind(t);
    let builtin = matches!(kind, SourceKind::BuiltinSynth | SourceKind::BuiltinSampled) && vintage.is_none();
    let synth = if builtin { Some(compile_synth(t)?) } else { None };
    // A disabled source needs neither its samples nor its instrument.
    if !t.enabled {
        if let Some(synth) = synth {
            built.source = Source::Builtin(Builtin {
                synth,
                sampled: kind == SourceKind::BuiltinSampled,
                samples: ResolvedSet::default(),
                voices: Box::new(Voices::new()),
            });
        }
        return Ok(built);
    }
    let rate = f64::from(p.sample_rate);
    match kind {
        SourceKind::NativeWavetable => {
            return Err(Error::new(
                "IEUM WAVE sources are not ported to the Rust engine yet (docs/RUST_ENGINE.md 6)",
            ));
        }
        SourceKind::Vst3 => {
            return Err(Error::new("VST3 instruments stay in the C++ host (docs/RUST_ENGINE.md 4)"));
        }
        _ => {}
    }
    let mut tail = 0.0f64;
    let mut instrument = None;
    if let Some(k) = vintage {
        require(!t.source.is_kit, "Invalid built-in instrument source")?;
        let mut inst = Box::new(Instrument::new(k, rate));
        let mut values: Vec<f64> = k.params().iter().map(|d| d.default).collect();
        for (name, value) in &t.source.params {
            let index = k
                .param_index(name.as_bytes())
                .ok_or_else(|| Error::new("Unknown native instrument parameter"))?;
            require(value.is_finite(), "Invalid native instrument parameter")?;
            if let Some(slot) = values.get_mut(index) {
                *slot = *value;
            }
        }
        inst.set_params(&values);
        tail = inst.tail_seconds();
        built.stereo = true;
        instrument = Some(inst);
    }
    let mut samples = ResolvedSet::default();
    if kind == SourceKind::BuiltinSampled {
        let set = sets
            .get(&t.source.sample_set_id)
            .ok_or_else(|| Error::new("Required native sample set is not registered"))?;
        require(set.is_kit == t.source.is_kit, "Sample kind differs from instrument")?;
        samples = resolve_set(set, assets)?;
        built.set = Some(set.clone());
        let synth = synth.unwrap_or_default();
        for (z, a) in samples.zones.iter().zip(&samples.zone_pcm) {
            built.assets.push(Arc::as_ptr(a) as usize);
            built.stereo |= a.channels > 1;
            if t.source.is_kit {
                let seconds = a.frames() as f64 / f64::from(a.sample_rate) - samples.start_offset;
                let speed = garak_dsp::math::pow(2.0, z.tune / 1200.0 + synth.tune / 12.0);
                tail = crate::math::std_max(tail, seconds / speed * synth.decay + 0.014);
            }
        }
        for (z, a) in samples.releases.iter().zip(&samples.release_pcm) {
            built.assets.push(Arc::as_ptr(a) as usize);
            built.stereo |= a.channels > 1;
            let seconds = a.frames() as f64 / f64::from(a.sample_rate) - samples.start_offset;
            let speed = garak_dsp::math::pow(2.0, f64::from(z.lo - z.root) / 12.0 + z.tune / 1200.0);
            tail = crate::math::std_max(tail, seconds / speed);
        }
    }
    if let Some(synth) = synth {
        let own = if t.source.is_kit {
            if synth.kind == SynthKind::Drums { 0.62 * synth.decay + 0.004 } else { 0.0 }
        } else {
            synth.release * 1.5 + 0.02
        };
        tail = crate::math::std_max(tail, own);
    }
    // Notes: unique ids, sane frames and velocities; then onset order (ties by id).
    let length = p.length_frames;
    let mut ids: Vec<i32> = t.notes.iter().map(|n| n.id).collect();
    ids.sort_unstable();
    require(ids.windows(2).all(|w| w.first() != w.get(1)), "Invalid native note event")?;
    let mut events: Vec<TimedEvent> = Vec::new();
    for n in &t.notes {
        require(
            (0..=127).contains(&n.pitch)
                && n.on_frame >= -length
                && n.off_frame > n.on_frame
                && n.off_frame > 0
                && n.off_frame <= length
                && n.limit_frame >= n.off_frame
                && n.limit_frame <= length,
            "Invalid native note event",
        )?;
        checked(f64::from(n.velocity), 0.0, 2.0, "Invalid native note velocity")?;
        if instrument.is_some() && n.velocity > 0.0 {
            let pitch = n.pitch as u8;
            events.push(TimedEvent {
                frame: n.on_frame,
                event: PluginEvent::new(EventType::NoteOn, n.id, pitch, n.velocity.min(1.0), 0, false),
            });
            events.push(TimedEvent {
                frame: n.off_frame,
                event: PluginEvent::new(EventType::NoteOff, n.id, pitch, 0.0, 0, false),
            });
        }
    }
    t.notes.sort_by(|a, b| a.on_frame.cmp(&b.on_frame).then(a.id.cmp(&b.id)));
    let mut previous = i64::MIN;
    for c in &t.controls {
        require(
            c.frame >= 0
                && c.frame <= length
                && valid_controller_value(i32::from(c.controller), c.value)
                && previous <= c.frame,
            "Invalid native control event",
        )?;
        previous = c.frame;
        if instrument.is_some() {
            let number = i32::from(c.controller);
            events.push(TimedEvent {
                frame: c.frame,
                event: PluginEvent::new(
                    EventType::Controller,
                    -1,
                    60,
                    normalized_controller(number, c.value),
                    u32::from(c.controller),
                    false,
                ),
            });
        }
    }
    // Stable: same-frame events keep their order within a type (std::stable_sort).
    events.sort_by(|a, b| {
        a.frame.cmp(&b.frame).then(event_order(a.event.kind).cmp(&event_order(b.event.kind)))
    });
    let mut begin = 0usize;
    for end in 0..events.len() {
        while let (Some(e), Some(b)) = (events.get(end), events.get(begin))
            && e.frame - b.frame >= i64::from(max_block)
        {
            begin += 1;
        }
        // Leave room for all queued live notes and their auto-release events.
        require(
            end - begin < MAX_PLUGIN_EVENTS - MAX_VOICES * 2 - 1,
            "Instrument note density exceeds the bounded event buffer",
        )?;
    }
    built.tail = tail;
    built.source = match (instrument, synth) {
        (Some(instrument), _) => Source::Vintage(Vintage {
            instrument,
            events,
            pending: [PluginEvent::new(EventType::NoteOn, -1, 60, 0.0, 0, false); MAX_VOICES],
            pending_count: 0,
            live_notes: [LiveNote::default(); MAX_VOICES],
            deferred: [DeferredOff::default(); MAX_VOICES],
            deferred_count: 0,
            live_pedal: false,
            reset: false,
            block: Vec::with_capacity(MAX_PLUGIN_EVENTS),
            converted: Vec::with_capacity(MAX_PLUGIN_EVENTS + 8),
            left: vec![0.0; max_block.max(1) as usize],
            right: vec![0.0; max_block.max(1) as usize],
        }),
        (None, Some(synth)) => Source::Builtin(Builtin {
            synth,
            sampled: kind == SourceKind::BuiltinSampled,
            samples,
            voices: Box::new(Voices::new()),
        }),
        (None, None) => Source::Audio,
    };
    Ok(built)
}

fn lower_bound_notes(notes: &[Note], frame: i64) -> usize {
    notes.partition_point(|n| n.on_frame < frame)
}

fn lower_bound_controls(controls: &[ControlEvent], frame: i64) -> usize {
    controls.partition_point(|c| c.frame < frame)
}

impl Vintage {
    fn lower_bound_events(&self, frame: i64) -> usize {
        self.events.partition_point(|e| e.frame < frame)
    }

    fn push_pending(&mut self, e: PluginEvent, overflows: &mut u64) -> bool {
        match self.pending.get_mut(self.pending_count) {
            Some(slot) => {
                *slot = e;
                self.pending_count += 1;
                true
            }
            None => {
                *overflows += 1;
                false
            }
        }
    }

    /// engine.cpp `noteOff` for a plug-in style instrument.
    fn note_off(&mut self, pitch: i32, id: i32, kit: bool, force: bool, overflows: &mut u64) {
        if self.live_pedal && !force && !kit {
            if self.deferred_count < MAX_VOICES {
                if let Some(slot) = self.deferred.get_mut(self.deferred_count) {
                    *slot = DeferredOff { id, pitch: pitch as u8 };
                }
                self.deferred_count += 1;
            } else {
                self.note_off(pitch, id, kit, true, overflows);
            }
            return;
        }
        let matches = |e_id: i32, e_pitch: u8| if id >= 0 { e_id == id } else { i32::from(e_pitch) == pitch };
        let mut cancelled = false;
        let mut i = 0;
        while i < self.pending_count {
            let Some(e) = self.pending.get(i).copied() else { break };
            if e.kind == EventType::NoteOn && e.audition && matches(e.note_id, e.pitch) {
                if let Some(rest) = self.pending.get_mut(i..self.pending_count) {
                    rest.rotate_left(1);
                }
                self.pending_count -= 1;
                cancelled = true;
            } else {
                i += 1;
            }
        }
        if !cancelled {
            let off = PluginEvent::new(EventType::NoteOff, id, pitch as u8, 0.0, 0, true);
            if self.pending_count < MAX_VOICES {
                self.push_pending(off, overflows);
            } else {
                *overflows += 1;
                self.reset = true;
                self.pending_count = 0;
                for n in &mut self.live_notes {
                    n.active = false;
                }
            }
        }
        for n in &mut self.live_notes {
            if n.active && matches(n.id, n.pitch) {
                n.active = false;
            }
        }
    }

    fn retrigger_sustained(&mut self, pitch: i32, kit: bool, overflows: &mut u64) {
        let mut i = 0;
        while i < self.deferred_count {
            let Some(d) = self.deferred.get(i).copied() else { break };
            if i32::from(d.pitch) == pitch {
                self.deferred_count -= 1;
                let last = self.deferred.get(self.deferred_count).copied().unwrap_or_default();
                if let Some(slot) = self.deferred.get_mut(i) {
                    *slot = last;
                }
                self.note_off(i32::from(d.pitch), d.id, kit, true, overflows);
            } else {
                i += 1;
            }
        }
    }

    fn release_sustained(&mut self, kit: bool, overflows: &mut u64) {
        let count = self.deferred_count;
        self.deferred_count = 0;
        for i in 0..count {
            let Some(d) = self.deferred.get(i).copied() else { break };
            self.note_off(i32::from(d.pitch), d.id, kit, true, overflows);
        }
    }

    fn control_change(&mut self, number: i32, value: i32, kit: bool, overflows: &mut u64) {
        if number != controller::SUSTAIN {
            let e = PluginEvent::new(
                EventType::Controller,
                -1,
                60,
                normalized_controller(number, value),
                number as u32,
                true,
            );
            self.push_pending(e, overflows);
            return;
        }
        let down = value >= 64;
        if down == self.live_pedal {
            return;
        }
        self.live_pedal = down;
        if !down {
            self.release_sustained(kit, overflows);
        }
    }

    /// One block: pending + timeline + live auto-off events, sorted, through the instrument
    /// (rust_instrument.hpp `RustInstrumentProcessor::process`). Overwrites `buf`.
    fn render(
        &mut self,
        buf: &mut [f32],
        cursors: &mut Cursors,
        frame: i64,
        frames: u32,
        timeline: bool,
        overflows: &mut u64,
    ) {
        self.block.clear();
        for e in self.pending.iter().take(self.pending_count) {
            if self.block.len() < MAX_PLUGIN_EVENTS {
                self.block.push(*e);
            }
        }
        self.pending_count = 0;
        if timeline {
            let end = frame + i64::from(frames);
            while let Some(e) = self.events.get(cursors.event)
                && e.frame < end
            {
                cursors.event += 1;
                if e.frame >= frame {
                    if self.block.len() < MAX_PLUGIN_EVENTS {
                        self.block.push(PluginEvent { offset: (e.frame - frame) as u32, ..e.event });
                    } else {
                        *overflows += 1;
                    }
                }
            }
        }
        for n in &mut self.live_notes {
            if !n.active {
                continue;
            }
            if n.remaining < i64::from(frames) {
                if self.block.len() < MAX_PLUGIN_EVENTS {
                    let mut off = PluginEvent::new(EventType::NoteOff, n.id, n.pitch, 0.0, 0, true);
                    off.offset = n.remaining.max(0) as u32;
                    self.block.push(off);
                } else {
                    *overflows += 1;
                }
                n.active = false;
            } else {
                n.remaining -= i64::from(frames);
            }
        }
        // Insertion sort (stable, allocation-free) by offset, then same-sample order.
        let key = |e: &PluginEvent| (e.offset, event_order(e.kind));
        for i in 1..self.block.len() {
            let mut j = i;
            while j > 0 && self.block.get(j - 1).zip(self.block.get(j)).is_some_and(|(a, b)| key(b) < key(a))
            {
                self.block.swap(j - 1, j);
                j -= 1;
            }
        }
        // RustInstrumentProcessor::process.
        self.converted.clear();
        if self.reset {
            self.reset = false;
            // Transport stop / seek: release (not cut) every voice and rest the controllers.
            self.converted.push(InstrumentEvent {
                offset: 0,
                kind: event::ALL_NOTES_OFF,
                id: -1,
                pitch: 0,
                value: 0.0,
                param: 0,
            });
            for (number, value) in [
                (controller::PITCH_BEND, 0.5f32),
                (controller::MOD_WHEEL, 0.0),
                (controller::CHANNEL_PRESSURE, 0.0),
                (controller::EXPRESSION, 1.0),
            ] {
                self.converted.push(InstrumentEvent {
                    offset: 0,
                    kind: event::CONTROLLER,
                    id: -1,
                    pitch: 0,
                    value,
                    param: number as u32,
                });
            }
        }
        let last = frames.saturating_sub(1);
        for e in &self.block {
            if self.converted.len() >= MAX_PLUGIN_EVENTS + 8 {
                break;
            }
            let mut out = InstrumentEvent {
                offset: e.offset.min(last),
                kind: 0,
                id: -1,
                pitch: u32::from(e.pitch),
                value: e.value,
                param: e.parameter,
            };
            // Timeline and audition (live / editor) notes may reuse ids: keep them apart.
            out.id = if e.note_id < 0 {
                -1
            } else if e.audition {
                e.note_id | 0x4000_0000
            } else {
                e.note_id & 0x3fff_ffff
            };
            match e.kind {
                EventType::NoteOn => {
                    out.kind = event::NOTE_ON;
                    out.value = e.value.clamp(0.0, 1.0);
                }
                EventType::NoteOff => out.kind = event::NOTE_OFF,
                EventType::Controller => {
                    out.kind = event::CONTROLLER;
                    // The host normalises every controller by 127; Rust reads the bend range / 48.
                    if e.parameter == controller::BEND_RANGE as u32 {
                        out.value = e.value * 127.0 / 48.0;
                    }
                }
            }
            self.converted.push(out);
        }
        let n = frames as usize;
        if let (Some(l), Some(r)) = (self.left.get_mut(..n), self.right.get_mut(..n)) {
            self.instrument.process(l, r, &self.converted);
            for (([o0, o1], a), b) in buf.as_chunks_mut::<2>().0.iter_mut().zip(l.iter()).zip(r.iter()) {
                *o0 = *a;
                *o1 = *b;
            }
        }
    }
}

impl Source {
    pub fn is_instrument(&self) -> bool {
        !matches!(self, Source::Audio)
    }

    /// The built-in synth parameters (automation targets), if any.
    pub fn synth_mut(&mut self) -> Option<&mut Synth> {
        match self {
            Source::Builtin(b) => Some(&mut b.synth),
            _ => None,
        }
    }

    /// Instrument parameter automation of a vintage instrument (glides inside the instrument).
    pub fn set_vintage_param(&mut self, index: usize, value: f64) {
        if let Source::Vintage(v) = self {
            v.instrument.set_param(index, value);
        }
    }

    /// Catalog index of a vintage instrument parameter.
    pub fn vintage_param(&self, name: &str) -> Option<usize> {
        match self {
            Source::Vintage(v) => v.instrument.kind().param_index(name.as_bytes()),
            _ => None,
        }
    }

    /// The transport stopped at the project end: plug-in style instruments release next block.
    pub fn request_reset(&mut self) {
        if let Source::Vintage(v) = self {
            v.reset = true;
        }
    }

    /// Takes the predecessor's voices, controllers, live notes and pending events (same
    /// instrument identity, engine.cpp `adopt` with `sameSource`). Audio thread: swaps / copies.
    pub fn take_from(&mut self, previous: &mut Source) {
        match (self, previous) {
            (Source::Builtin(a), Source::Builtin(b)) => {
                a.voices.take_from(&mut b.voices);
                core::mem::swap(&mut a.samples, &mut b.samples);
            }
            (Source::Vintage(a), Source::Vintage(b)) => {
                a.instrument.take_state(&b.instrument);
                a.reset = b.reset;
                a.pending = b.pending;
                a.pending_count = b.pending_count;
                a.live_notes = b.live_notes;
                a.deferred = b.deferred;
                a.deferred_count = b.deferred_count;
                a.live_pedal = b.live_pedal;
            }
            _ => {}
        }
    }

    /// Recomputes the cursors at `frame` (engine.cpp `adopt` / `reset`).
    pub fn seek_cursors(&self, plan: &TrackPlan, cursors: &mut Cursors, frame: i64) {
        cursors.note = lower_bound_notes(&plan.notes, frame);
        cursors.control = lower_bound_controls(&plan.controls, frame);
        cursors.event = match self {
            Source::Vintage(v) => v.lower_bound_events(frame),
            _ => 0,
        };
    }

    /// Releases notes the edited track no longer has (engine.cpp `adopt`).
    pub fn release_removed(
        &mut self,
        plan: &TrackPlan,
        removed: &[RemovedNote],
        frame: i64,
        sample_rate: f64,
    ) {
        match self {
            Source::Vintage(v) => {
                for r in removed {
                    if r.on_frame < frame && r.off_frame > frame && v.pending_count < MAX_VOICES {
                        let off = PluginEvent::new(EventType::NoteOff, r.id, r.pitch, 0.0, 0, false);
                        let mut ignored = 0;
                        v.push_pending(off, &mut ignored);
                    }
                }
            }
            Source::Builtin(b) => {
                let ctx = VoiceContext { sample_rate, kit: plan.source.is_kit, synth: &b.synth };
                for r in removed {
                    b.voices.release_note(&ctx, r.id);
                }
            }
            Source::Audio => {}
        }
    }

    /// engine.cpp `TrackRuntime::reset` (instrument half): voices off, controllers chased (or
    /// returned to rest), cursors at `frame`, and with `chase` the notes sounding across `frame`
    /// started again (not for kits).
    pub fn reset(
        &mut self,
        plan: &TrackPlan,
        cursors: &mut Cursors,
        frame: i64,
        chase: bool,
        sample_rate: f64,
        overflows: &mut u64,
    ) {
        cursors.control = lower_bound_controls(&plan.controls, frame);
        match self {
            Source::Audio => {
                cursors.note = lower_bound_notes(&plan.notes, frame);
                return;
            }
            Source::Builtin(b) => {
                b.voices.deactivate();
                b.voices.controllers = Default::default();
                if chase && plan.enabled {
                    for c in plan.controls.iter().take(cursors.control) {
                        b.voices.apply_controller(i32::from(c.controller), c.value);
                    }
                }
                b.voices.snap_controllers();
            }
            Source::Vintage(v) => {
                for n in &mut v.live_notes {
                    n.active = false;
                }
                v.pending_count = 0;
                v.deferred_count = 0;
                v.reset = true;
                if !plan.controls.is_empty() {
                    let mut values = [0i32; controller::COUNT as usize];
                    let mut present = [false; controller::COUNT as usize];
                    let mut known = [false; controller::COUNT as usize];
                    for c in &plan.controls {
                        let i = usize::from(c.controller);
                        if let Some(p) = present.get_mut(i) {
                            *p = true;
                        }
                        if chase && c.frame < frame {
                            if let Some(v) = values.get_mut(i) {
                                *v = c.value;
                            }
                            if let Some(k) = known.get_mut(i) {
                                *k = true;
                            }
                        }
                    }
                    for number in 0..controller::COUNT {
                        let i = number as usize;
                        if !present.get(i).copied().unwrap_or(false) {
                            continue;
                        }
                        let value = if chase && plan.enabled && known.get(i).copied().unwrap_or(false) {
                            values.get(i).copied().unwrap_or(0)
                        } else {
                            match reset_controller(number) {
                                Some(v) => v,
                                None => continue,
                            }
                        };
                        if v.pending_count >= MAX_VOICES {
                            *overflows += 1;
                            break;
                        }
                        let e = PluginEvent::new(
                            EventType::Controller,
                            -1,
                            60,
                            normalized_controller(number, value),
                            number as u32,
                            false,
                        );
                        v.push_pending(e, overflows);
                    }
                }
            }
        }
        cursors.note = lower_bound_notes(&plan.notes, frame);
        cursors.event = match self {
            Source::Vintage(v) => v.lower_bound_events(frame),
            _ => 0,
        };
        if chase && !plan.source.is_kit && plan.enabled {
            for i in 0..cursors.note {
                let Some(n) = plan.notes.get(i).copied() else { break };
                if n.off_frame > frame {
                    self.spawn(
                        plan,
                        n.pitch,
                        n.velocity,
                        n.off_frame - frame,
                        n.limit_frame - frame,
                        n.id,
                        false,
                        sample_rate,
                        overflows,
                    );
                }
            }
        }
    }

    /// engine.cpp `TrackRuntime::spawn`.
    pub fn spawn(
        &mut self,
        plan: &TrackPlan,
        pitch: i32,
        velocity: f32,
        duration: i64,
        available: i64,
        id: i32,
        live: bool,
        sample_rate: f64,
        overflows: &mut u64,
    ) {
        if velocity <= 0.0 || duration <= 0 || available <= 0 || !plan.enabled {
            return;
        }
        let kit = plan.source.is_kit;
        match self {
            Source::Audio => {}
            Source::Builtin(b) => {
                let ctx = VoiceContext { sample_rate, kit, synth: &b.synth };
                b.voices.spawn(
                    &ctx, &b.samples, b.sampled, pitch, velocity, duration, available, id, live, overflows,
                );
            }
            Source::Vintage(v) => {
                if live && !kit {
                    v.retrigger_sustained(pitch, kit, overflows);
                }
                if v.pending_count == MAX_VOICES {
                    *overflows += 1;
                    return;
                }
                if live {
                    let Some(slot) = v.live_notes.iter_mut().find(|n| !n.active) else {
                        *overflows += 1;
                        return;
                    };
                    *slot = LiveNote { active: true, id, pitch: pitch as u8, remaining: duration };
                }
                let on = PluginEvent::new(EventType::NoteOn, id, pitch as u8, velocity.min(1.0), 0, live);
                v.push_pending(on, overflows);
            }
        }
    }

    /// Live note-off (engine.cpp `noteOff`).
    pub fn note_off(&mut self, plan: &TrackPlan, pitch: i32, id: i32, sample_rate: f64, overflows: &mut u64) {
        let kit = plan.source.is_kit;
        match self {
            Source::Audio => {}
            Source::Builtin(b) => {
                let ctx = VoiceContext { sample_rate, kit, synth: &b.synth };
                b.voices.live_note_off(&ctx, pitch, id, false);
            }
            Source::Vintage(v) => v.note_off(pitch, id, kit, false, overflows),
        }
    }

    /// Live controller (engine.cpp `controlChange`).
    pub fn control_change(
        &mut self,
        plan: &TrackPlan,
        number: i32,
        value: i32,
        sample_rate: f64,
        overflows: &mut u64,
    ) {
        let kit = plan.source.is_kit;
        match self {
            Source::Audio => {}
            Source::Builtin(b) => {
                let ctx = VoiceContext { sample_rate, kit, synth: &b.synth };
                b.voices.control_change(&ctx, number, value);
            }
            Source::Vintage(v) => v.control_change(number, value, kit, overflows),
        }
    }

    /// Live panic (engine.cpp `allNotesOff`).
    pub fn all_notes_off(&mut self, plan: &TrackPlan, sample_rate: f64, overflows: &mut u64) {
        let kit = plan.source.is_kit;
        match self {
            Source::Audio => {}
            Source::Builtin(b) => {
                let ctx = VoiceContext { sample_rate, kit, synth: &b.synth };
                b.voices.all_notes_off(&ctx);
            }
            Source::Vintage(v) => {
                v.live_pedal = false;
                v.deferred_count = 0;
                for i in 0..MAX_VOICES {
                    let Some(n) = v.live_notes.get(i).copied() else { break };
                    if n.active {
                        v.note_off(i32::from(n.pitch), n.id, kit, true, overflows);
                    }
                }
                v.control_change(controller::PITCH_BEND, 0, kit, overflows);
                v.control_change(controller::MOD_WHEEL, 0, kit, overflows);
            }
        }
    }

    /// One block of the instrument into `buf` (zeroed by the caller). `playing`: the transport
    /// plays inside the project; `project_length`: the vintage instruments still receive the
    /// note-offs at the project end in the first tail block.
    pub fn render(
        &mut self,
        plan: &TrackPlan,
        cursors: &mut Cursors,
        buf: &mut [f32],
        frame: i64,
        frames: u32,
        playing: bool,
        project_length: i64,
        sample_rate: f64,
        overflows: &mut u64,
    ) {
        match self {
            Source::Audio => {}
            Source::Vintage(v) => {
                v.render(buf, cursors, frame, frames, playing || frame >= project_length, overflows);
            }
            Source::Builtin(b) => {
                let kit = plan.source.is_kit;
                let ctx = VoiceContext { sample_rate, kit, synth: &b.synth };
                let mut cursor = 0u32;
                let block_end = frame + i64::from(frames);
                // Controllers and note onsets in time order; a controller at an onset's sample first.
                if playing {
                    loop {
                        let note = plan.notes.get(cursors.note).filter(|n| n.on_frame < block_end);
                        let control = plan.controls.get(cursors.control).filter(|c| c.frame < block_end);
                        if note.is_none() && control.is_none() {
                            break;
                        }
                        if let Some(c) = control
                            && note.is_none_or(|n| c.frame <= n.on_frame)
                        {
                            cursors.control += 1;
                            if c.frame > frame {
                                let at = (c.frame - frame) as u32;
                                if at > cursor {
                                    if let Some(part) = buf.get_mut(cursor as usize * 2..at as usize * 2) {
                                        b.voices.render(part, &ctx, &b.samples, overflows);
                                    }
                                    cursor = at;
                                }
                            }
                            b.voices.apply_controller(i32::from(c.controller), c.value);
                            continue;
                        }
                        let Some(n) = note.copied() else { break };
                        cursors.note += 1;
                        if n.on_frame < frame {
                            continue;
                        }
                        let onset = (n.on_frame - frame) as u32;
                        if let Some(part) = buf.get_mut(cursor as usize * 2..onset as usize * 2) {
                            b.voices.render(part, &ctx, &b.samples, overflows);
                        }
                        cursor = onset;
                        if n.velocity > 0.0
                            && n.off_frame - n.on_frame > 0
                            && n.limit_frame - n.on_frame > 0
                            && plan.enabled
                        {
                            b.voices.spawn(
                                &ctx,
                                &b.samples,
                                b.sampled,
                                n.pitch,
                                n.velocity,
                                n.off_frame - n.on_frame,
                                n.limit_frame - n.on_frame,
                                n.id,
                                false,
                                overflows,
                            );
                        }
                    }
                }
                if let Some(part) = buf.get_mut(cursor as usize * 2..frames as usize * 2) {
                    b.voices.render(part, &ctx, &b.samples, overflows);
                }
            }
        }
    }

    /// Voices sounding (tests and diagnostics).
    pub fn active_voices(&self) -> usize {
        match self {
            Source::Audio => 0,
            Source::Builtin(b) => b.voices.active(),
            Source::Vintage(v) => v.instrument.active_voices(),
        }
    }
}

/// engine.cpp `removedNotes`: old notes absent (by value, ids included) from `next`.
pub(crate) fn removed_notes(old: &[Note], next: &[Note]) -> Vec<RemovedNote> {
    let key = |n: &Note| (n.id, n.on_frame, n.off_frame, n.limit_frame, n.pitch, n.velocity.to_bits());
    let mut a: Vec<&Note> = old.iter().collect();
    let mut b: Vec<&Note> = next.iter().collect();
    a.sort_by(|x, y| cmp_key(key(x), key(y)));
    b.sort_by(|x, y| cmp_key(key(x), key(y)));
    let mut removed = Vec::new();
    let mut j = 0;
    for n in a {
        while b.get(j).is_some_and(|m| cmp_key(key(m), key(n)).is_lt()) {
            j += 1;
        }
        if b.get(j).is_some_and(|m| cmp_key(key(m), key(n)).is_eq()) {
            j += 1;
            continue;
        }
        removed.push(RemovedNote {
            id: n.id,
            on_frame: n.on_frame,
            off_frame: n.off_frame,
            pitch: n.pitch as u8,
        });
    }
    removed
}

/// Orders note keys like the C++ tuple of (…, float velocity): velocities are non-negative finite
/// floats, so their bit patterns order like their values.
fn cmp_key<T: Ord>(a: T, b: T) -> core::cmp::Ordering {
    a.cmp(&b)
}

/// engine.cpp `renumberNotes`: notes of `next` equal (frames, pitch, velocity) to a note of `old`
/// take that note's id; the rest get fresh ids above every old id. Returns the old notes without
/// a match (removed or edited).
pub(crate) fn renumber_notes(old: &[Note], next: &mut [Note]) -> Vec<RemovedNote> {
    let key = |n: &Note| (n.on_frame, n.off_frame, n.limit_frame, n.pitch, n.velocity.to_bits());
    let mut a: Vec<usize> = (0..old.len()).collect();
    let mut b: Vec<usize> = (0..next.len()).collect();
    let note = |list: &[Note], i: usize| {
        list.get(i).copied().unwrap_or(Note {
            id: 0,
            on_frame: 0,
            off_frame: 0,
            limit_frame: 0,
            pitch: 0,
            velocity: 0.0,
        })
    };
    a.sort_by_key(|&x| (key(&note(old, x)), note(old, x).id));
    b.sort_by_key(|&x| (key(&note(next, x)), x));
    let top = old.iter().map(|n| i64::from(n.id)).max().unwrap_or(-1);
    let compact = top + next.len() as i64 + 1 > i64::from(i32::MAX / 2);
    let mut matched = vec![false; next.len()];
    let mut used = vec![false; old.len()];
    if !compact {
        let (mut i, mut j) = (0usize, 0usize);
        while let (Some(&ia), Some(&jb)) = (a.get(i), b.get(j)) {
            let (ka, kb) = (key(&note(old, ia)), key(&note(next, jb)));
            if ka < kb {
                i += 1;
            } else if kb < ka {
                j += 1;
            } else {
                let id = note(old, ia).id;
                if let Some(n) = next.get_mut(jb) {
                    n.id = id;
                }
                if let Some(m) = matched.get_mut(jb) {
                    *m = true;
                }
                if let Some(u) = used.get_mut(ia) {
                    *u = true;
                }
                i += 1;
                j += 1;
            }
        }
    }
    let mut fresh = if compact { 0 } else { (top + 1) as i32 };
    for (n, m) in next.iter_mut().zip(&matched) {
        if !*m {
            n.id = fresh;
            fresh += 1;
        }
    }
    old.iter()
        .zip(&used)
        .filter(|(_, u)| !**u)
        .map(|(n, _)| RemovedNote {
            id: n.id,
            on_frame: n.on_frame,
            off_frame: n.off_frame,
            pitch: n.pitch as u8,
        })
        .collect()
}

/// Notes compared without their ids (engine.cpp `sameNotes`).
pub(crate) fn same_notes(x: &[Note], y: &[Note]) -> bool {
    x.len() == y.len()
        && x.iter().zip(y).all(|(a, b)| {
            a.on_frame == b.on_frame
                && a.off_frame == b.off_frame
                && a.limit_frame == b.limit_frame
                && a.pitch == b.pitch
                && a.velocity == b.velocity
        })
}

/// The empty bank (synth tracks), for callers that need a `SampleBank` value.
#[allow(dead_code)]
pub(crate) const NO_SAMPLES: NoSamples = NoSamples;

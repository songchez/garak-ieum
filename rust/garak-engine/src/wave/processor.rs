//! The engine side of IEUM WAVE (native/src/wavetable.cpp): the prepared-table cache
//! (`WavetableResources`) and the processor that turns host events into synth events, applies
//! CC7 / CC11 as a smoothed output gain, resets on transport changes, and hands its synth over to
//! a rebuilt track (crossfading a changed table set).

use alloc::boxed::Box;
use alloc::string::String;
use alloc::sync::{Arc, Weak};
use alloc::vec;
use alloc::vec::Vec;

use super::math::{ceil, clampd, exp, log, round};
use super::patch::{CustomBank, Patch, decode_patch_bundle, unbase64};
use super::schema as g;
use super::synth::{Event, EventType, Synth, Transport};
use super::tables::PreparedWavetableSet;
use crate::error::Error;

/// Host event kinds the processor reads (a subset of engine.hpp `PluginEvent`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HostKind {
    NoteOn,
    NoteOff,
    AllNotesOff,
    Controller,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct HostEvent {
    pub kind: HostKind,
    pub offset: u32,
    pub note_id: i32,
    pub pitch: u8,
    pub value: f32,
    pub parameter: u32,
    pub audition: bool,
}

/// `WavetableResources`: prepared table sets shared by patches with the same user banks.
#[derive(Debug, Default)]
pub struct WaveCache {
    entries: Vec<(Vec<CustomBank>, Weak<PreparedWavetableSet>)>,
}

impl WaveCache {
    /// Decodes a base64 IEWAVE01 patch and finds or prepares its table set (control thread).
    pub fn prepare(&mut self, patch_data: &str) -> Result<(Patch, Arc<PreparedWavetableSet>), Error> {
        let bytes = unbase64(patch_data)
            .map_err(|e| Error::new(alloc::format!("Invalid IEUM WAVE patch encoding: {e}")))?;
        let (patch, mut banks) = decode_patch_bundle(&bytes)
            .map_err(|e: String| Error::new(alloc::format!("Invalid IEUM WAVE patch: {e}")))?;
        banks.sort_by_key(|b| b.slot);
        self.entries.retain(|(_, w)| w.strong_count() > 0);
        for (cached, weak) in &self.entries {
            if *cached == banks
                && let Some(tables) = weak.upgrade()
            {
                return Ok((patch, tables));
            }
        }
        let mut tables = PreparedWavetableSet::new()?;
        for b in &banks {
            tables.set_custom(b.slot, &b.samples, b.frame_count as usize)?;
        }
        let tables = Arc::new(tables);
        self.entries.push((banks, Arc::downgrade(&tables)));
        Ok((patch, tables))
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct GainChange {
    offset: u32,
    volume: f32,
    expression: f32,
}

const MAX_EVENTS: usize = 2048;

/// wavetable.cpp `WavetableProcessor`.
#[derive(Debug)]
pub struct Processor {
    desired_patch: Patch,
    desired_tables: Arc<PreparedWavetableSet>,
    tables: Option<Arc<PreparedWavetableSet>>,
    fading_tables: Option<Arc<PreparedWavetableSet>>,
    /// The retired set the synth handed back (kept, never dropped on the audio thread).
    retired: Option<Arc<PreparedWavetableSet>>,
    synth: Box<Synth>,
    left: Vec<f32>,
    right: Vec<f32>,
    events: Vec<Event>,
    gain_changes: [GainChange; 256],
    volume: f32,
    expression: f32,
    gain: f32,
    reset: bool,
    fade_complete: bool,
}

impl Processor {
    #[inline(never)]
    pub fn new(
        patch: Patch,
        tables: Arc<PreparedWavetableSet>,
        rate: f64,
        block: u32,
    ) -> Result<Box<Self>, Error> {
        let mut synth = Synth::new(rate, tables.clone())?;
        if !synth.apply_patch(&patch, true) {
            return Err(Error::new("IEUM WAVE patch cannot use the prepared tables"));
        }
        Ok(Box::new(Self {
            desired_patch: patch,
            desired_tables: tables.clone(),
            tables: Some(tables),
            fading_tables: None,
            retired: None,
            synth,
            left: vec![0.0; block.max(1) as usize],
            right: vec![0.0; block.max(1) as usize],
            events: Vec::with_capacity(MAX_EVENTS),
            gain_changes: [GainChange::default(); 256],
            volume: 1.0,
            expression: 1.0,
            gain: 1.0,
            reset: false,
            fade_complete: true,
        }))
    }

    pub fn request_reset(&mut self) {
        self.reset = true;
    }

    /// Callback only: the previous table crossfade finished (a graph may take this synth over).
    pub fn ready_to_transfer(&mut self) -> bool {
        if self.fade_complete || self.fading_tables.is_none() {
            return true;
        }
        if let Some(t) = self.synth.take_retired() {
            self.retired = Some(t);
            self.fade_complete = true;
        }
        self.fade_complete
    }

    /// Callback only: continue `previous`'s synth (voices, LFOs, delay) with this patch; a changed
    /// table set crossfades. The unused new synth stays in `previous` (freed on the control thread).
    pub fn take_state_from(&mut self, previous: &mut Processor) {
        core::mem::swap(&mut self.synth, &mut previous.synth);
        core::mem::swap(&mut self.tables, &mut previous.tables);
        core::mem::swap(&mut self.reset, &mut previous.reset);
        self.volume = previous.volume;
        self.expression = previous.expression;
        self.gain = previous.gain;
        let same = self.tables.as_ref().is_some_and(|t| Arc::ptr_eq(t, &self.desired_tables));
        if !same {
            core::mem::swap(&mut self.fading_tables, &mut self.tables);
            self.tables = Some(self.desired_tables.clone());
            self.fade_complete = false;
            let _ = self.synth.apply_prepared_patch(&self.desired_patch, &self.desired_tables);
        } else {
            let _ = self.synth.apply_patch(&self.desired_patch, false);
        }
    }

    /// One block into interleaved `stereo` (overwritten). `events` sorted by offset.
    pub fn process(
        &mut self,
        stereo: &mut [f32],
        frames: u32,
        input: &[HostEvent],
        bpm: f64,
        project_frame: i64,
        sample_rate: f64,
        playing: bool,
    ) {
        if self.reset {
            self.synth.reset(0x49e1_27ad);
            self.reset = false;
            // Controllers return to the patch: no bend, the macros at their patch values.
            let _ = self.synth.set_parameter(96, self.desired_patch.params[96], true);
            let _ = self.synth.set_parameter(97, self.desired_patch.params[97], true);
            self.volume = 1.0;
            self.expression = 1.0;
            self.gain = 1.0;
        }
        self.events.clear();
        let mut gains = 0usize;
        let before = self.volume * self.expression;
        for source in input {
            if self.events.len() >= MAX_EVENTS {
                break;
            }
            let channel = u8::from(source.audition);
            if source.kind == HostKind::Controller {
                let controller = source.parameter;
                let normalized = clampd(f64::from(source.value), 0.0, 1.0);
                if controller == 7 || controller == 11 {
                    let v = if controller == 7 { normalized * 127.0 / 100.0 } else { normalized };
                    if controller == 7 {
                        self.volume = (v * v) as f32;
                    } else {
                        self.expression = (v * v) as f32;
                    }
                    let change = GainChange {
                        offset: source.offset,
                        volume: self.volume,
                        expression: self.expression,
                    };
                    if gains < self.gain_changes.len() {
                        if let Some(slot) = self.gain_changes.get_mut(gains) {
                            *slot = change;
                        }
                        gains += 1;
                    } else if let Some(last) = self.gain_changes.get_mut(gains - 1) {
                        *last = GainChange { offset: last.offset, ..change };
                    }
                    continue;
                }
                let mut event = Event { offset: source.offset, channel, ..Event::default() };
                if controller == 129 {
                    let raw = round(normalized * 16383.0) - 8192.0;
                    event.kind = EventType::PitchBend;
                    event.value =
                        clampd(if raw > 0.0 { raw / 8191.0 } else { raw / 8192.0 }, -1.0, 1.0) as f32;
                } else if controller == 1 || controller == 128 {
                    event.kind = EventType::Parameter;
                    event.parameter = if controller == 1 { 96 } else { 97 };
                    event.value = normalized as f32;
                } else {
                    continue;
                }
                self.events.push(event);
                continue;
            }
            let kind = match source.kind {
                HostKind::NoteOn => EventType::NoteOn,
                HostKind::NoteOff => EventType::NoteOff,
                _ => EventType::AllNotesOff,
            };
            self.events.push(Event {
                offset: source.offset,
                kind,
                channel,
                note: source.pitch,
                note_id: if source.note_id >= 0 { source.note_id as u32 + 1 } else { 0 },
                value: source.value,
                ..Event::default()
            });
        }
        let transport = Transport {
            bpm,
            beat_position: project_frame as f64 * bpm / (60.0 * sample_rate),
            playing,
            has_beat_position: true,
        };
        let n = frames as usize;
        let (Some(l), Some(r)) = (self.left.get_mut(..n), self.right.get_mut(..n)) else { return };
        self.synth.process(l, r, &self.events, transport);
        let out = stereo.as_chunks_mut::<2>().0;
        if gains == 0 && self.gain == 1.0 && before == 1.0 {
            for ([o0, o1], (a, b)) in out.iter_mut().zip(l.iter().zip(r.iter())) {
                *o0 = *a;
                *o1 = *b;
            }
            return;
        }
        // The gain before this block's first change, then each change from its offset (~5 ms).
        let mut target = before;
        let smoothing = (1.0 - exp(-1.0 / (self.synth.sample_rate() * 0.005))) as f32;
        let mut next = 0usize;
        for (i, ([o0, o1], (a, b))) in out.iter_mut().zip(l.iter().zip(r.iter())).enumerate() {
            while next < gains
                && let Some(c) = self.gain_changes.get(next)
                && c.offset as usize <= i
            {
                target = c.volume * c.expression;
                next += 1;
            }
            self.gain += (target - self.gain) * smoothing;
            if (target - self.gain).abs() < 1e-6 {
                self.gain = target;
            }
            *o0 = *a * self.gain;
            *o1 = *b * self.gain;
        }
    }

    /// wavetable.cpp `tailSeconds` (export allowance of the desired patch).
    pub fn tail_seconds(&self) -> f64 {
        let p = &self.desired_patch;
        let maximum = |id: usize| -> f64 {
            if p.routes.iter().any(|r| r.enabled && r.amount != 0.0 && r.destination == id) {
                return f64::from(g::MAXIMUM.get(id).copied().unwrap_or(0.0));
            }
            f64::from(p.params.get(id).copied().unwrap_or(0.0))
        };
        let mut seconds = maximum(54);
        if maximum(90) > 0.0 {
            seconds += 0.05;
        }
        if maximum(93) > 0.0 {
            let feedback = maximum(92);
            let repeats = if feedback > 0.0 {
                let r = ceil(log(1e-5) / log(feedback));
                if 1.0 < r { r } else { 1.0 }
            } else {
                1.0
            };
            seconds += maximum(91) * repeats;
        }
        let total = seconds + 0.01;
        if total < 30.0 { total } else { 30.0 }
    }
}

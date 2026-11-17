//! The IEUM WAVE synthesizer (native/devices/wavetable-synth/src/synth.cpp): 16 voices of three
//! wavetable oscillators with unison, a sub and noise, two SVFs, four envelopes and LFOs, a
//! modulation matrix, voice stealing with a short tail fade, table-set crossfades, and the master
//! effects. Same state and operation order as the C++ `Synth::Impl`.

use alloc::boxed::Box;
use alloc::sync::Arc;

use super::dsp::{Effects, Envelope, EnvelopeSettings, Stereo, StereoFilter};
use super::math::{
    LinearSmoother, advance_phase, clampd, clampf, exp2, exp2f, expf, fmod, lerp, logf, powf, random_bits,
    random_unit, safety_ceiling, sqrtf, wrap_phase,
};
use super::patch::{Patch, validate_parameter, validate_patch};
use super::schema as g;
use super::tables::{FrameView, MipSelection, PreparedWavetable, PreparedWavetableSet, select_mip};
use crate::error::Error;

const CONTROL_PERIOD: u32 = 16;
const STEAL_FADE: u32 = 128;
const MAX_EVENTS: usize = 4096;
const VOICE_GAIN: f32 = 0.5;
const MOD_SOURCES: usize = 19;

#[inline(always)]
fn at<const N: usize>(a: &[f32; N], i: usize) -> f32 {
    a.get(i).copied().unwrap_or(0.0)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventType {
    NoteOn,
    NoteOff,
    Parameter,
    PitchBend,
    AllNotesOff,
}

/// synth.hpp `Event`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Event {
    pub offset: u32,
    pub kind: EventType,
    pub channel: u8,
    pub note: u8,
    pub parameter: usize,
    pub value: f32,
    pub note_id: u32,
}

impl Default for Event {
    fn default() -> Self {
        Self {
            offset: 0,
            kind: EventType::NoteOn,
            channel: 0,
            note: 60,
            parameter: 94,
            value: 0.8,
            note_id: 0,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Transport {
    pub bpm: f64,
    pub beat_position: f64,
    pub playing: bool,
    pub has_beat_position: bool,
}

fn discrete_parameter(i: usize) -> bool {
    if i < 36 {
        return i % 12 == 1 || i % 12 == 7;
    }
    i == 37 || ((70..86).contains(&i) && i % 4 != 2) || i == 95
}

fn has_selected_banks(patch: &Patch, tables: &PreparedWavetableSet) -> bool {
    (0..3).all(|osc| tables.has_bank(at(&patch.params, osc * 12 + 1) as u32))
}

fn unison_fraction(index: u32, count: u32) -> f32 {
    if count == 1 {
        return 0.0;
    }
    if count & 1 != 0 {
        if index == 0 {
            return 0.0;
        }
        let rank = index.div_ceil(2) as f32 / (count / 2) as f32;
        return if index & 1 != 0 { -rank } else { rank };
    }
    let rank = ((index / 2) as f32 + 0.5) / ((count / 2) as f32 - 0.5);
    if index & 1 != 0 { rank } else { -rank }
}

fn envelope_settings(values: &[f32; g::PARAM_COUNT], index: usize) -> EnvelopeSettings {
    let p = 50 + index * 5;
    EnvelopeSettings {
        attack: at(values, p),
        hold: at(values, p + 1),
        decay: at(values, p + 2),
        sustain: at(values, p + 3),
        release: at(values, p + 4),
    }
}

fn read_curve(values: &[f32; g::LFO_POINTS], phase: f64) -> f32 {
    let point = wrap_phase(phase) * g::LFO_POINTS as f64;
    let first = point as usize;
    lerp(
        at(values, first % g::LFO_POINTS),
        at(values, (first + 1) % g::LFO_POINTS),
        (point - first as f64) as f32,
    )
}

#[derive(Clone, Copy, Debug, Default)]
struct Unison {
    phase: f64,
    increment: LinearSmoother,
    gain_left: LinearSmoother,
    gain_right: LinearSmoother,
    mip: MipSelection,
}

#[derive(Clone, Copy, Debug, Default)]
struct Oscillator {
    unison: [Unison; g::MAX_UNISON],
    position: LinearSmoother,
    bank_fade: LinearSmoother,
    bank: u32,
    previous_bank: u32,
}

#[derive(Clone, Copy, Debug)]
struct Voice {
    active: bool,
    key_down: bool,
    sustained: bool,
    fresh: bool,
    channel: u8,
    note: u8,
    note_id: u32,
    rng: u32,
    control_remaining: u32,
    tail_remaining: u32,
    age: u64,
    velocity: f32,
    random: f32,
    envelopes: [Envelope; 4],
    lfo_phase: [f64; 4],
    oscillators: [Oscillator; 3],
    filters: [StereoFilter; 2],
    sub_phase: f64,
    sub_increment: LinearSmoother,
    sub_gain: LinearSmoother,
    sub_shape: LinearSmoother,
    noise_gain: LinearSmoother,
    fade_in: LinearSmoother,
    sub_mip: MipSelection,
}

impl Default for Voice {
    fn default() -> Self {
        Self {
            active: false,
            key_down: false,
            sustained: false,
            fresh: true,
            channel: 0,
            note: 60,
            note_id: 0,
            rng: 1,
            control_remaining: 0,
            tail_remaining: 0,
            age: 0,
            velocity: 0.0,
            random: 0.5,
            envelopes: [Envelope::default(); 4],
            lfo_phase: [0.0; 4],
            oscillators: [Oscillator::default(); 3],
            filters: [StereoFilter::default(); 2],
            sub_phase: 0.0,
            sub_increment: LinearSmoother::default(),
            sub_gain: LinearSmoother::default(),
            sub_shape: LinearSmoother::default(),
            noise_gain: LinearSmoother::default(),
            fade_in: LinearSmoother::default(),
            sub_mip: MipSelection::default(),
        }
    }
}

impl Voice {
    fn envelope_value(&self) -> f32 {
        self.envelopes.first().map_or(0.0, Envelope::value)
    }
}

/// A table view: frames of the current set and, while sets crossfade, of the previous one.
#[derive(Clone, Copy, Debug, Default)]
struct TableView {
    /// The `current` view reads the previous set (the current set lacks the bank).
    current_from_previous: bool,
    current: FrameView,
    previous: FrameView,
    fade: f32,
}

/// Everything a voice reads while rendering (all of `Synth::Impl` but the voices and effects).
#[derive(Debug)]
struct Core {
    rate: f64,
    prepared: bool,
    tables: Option<Arc<PreparedWavetableSet>>,
    previous_tables: Option<Arc<PreparedWavetableSet>>,
    retired_tables: Option<Arc<PreparedWavetableSet>>,
    table_fade: LinearSmoother,
    curve_fade: LinearSmoother,
    patch: Patch,
    previous_curves: [[f32; g::LFO_POINTS]; 4],
    parameters: [LinearSmoother; g::PARAM_COUNT],
    values: [f32; g::PARAM_COUNT],
    route_exponent: [f32; g::MAX_MOD_ROUTES],
    active_routes: [usize; g::MAX_MOD_ROUTES],
    route_count: usize,
    pitch_bend: [LinearSmoother; 16],
    sustain: [bool; 16],
    global_lfo_phase: [f64; 4],
    lfo_increment: [f64; 4],
    control_remaining: u32,
    random_state: u32,
    voice_age: u64,
    processed_frames: u64,
}

/// One IEUM WAVE instance. Table sets are shared and immutable; the synth only moves its Arcs and
/// never drops the last reference on the audio thread (the processor keeps the sets it hands over).
#[derive(Debug)]
pub struct Synth {
    core: Core,
    voices: [Voice; g::MAX_POLYPHONY],
    tails: [Voice; g::MAX_POLYPHONY],
    effects: Effects,
}

fn bank_of(set: Option<&PreparedWavetableSet>, bank: u32) -> Option<&PreparedWavetable> {
    set.filter(|t| t.has_bank(bank)).map(|t| t.bank(bank))
}

impl Core {
    fn smoothing_frames(&self) -> u32 {
        (self.rate * 0.012) as u32
    }

    fn lfo_value(&self, lfo: usize, phase: f64) -> f32 {
        let Some(curve) = self.patch.lfo_curves.get(lfo) else { return 0.0 };
        let current = read_curve(curve, phase);
        if self.curve_fade.value >= 1.0 {
            return current;
        }
        let previous = self.previous_curves.get(lfo).map_or(0.0, |c| read_curve(c, phase));
        lerp(previous, current, self.curve_fade.value)
    }

    fn update_voice(&self, voice: &mut Voice) {
        let values = &self.values;
        let params = &self.patch.params;
        let mut modulated = *values;
        let mut offsets = [0.0f32; g::PARAM_COUNT];
        let mut sources = [0.0f32; MOD_SOURCES];
        for (i, e) in voice.envelopes.iter_mut().enumerate() {
            if let Some(s) = sources.get_mut(i) {
                *s = e.value();
            }
            let retrigger = at(params, 73 + i * 4) >= 0.5;
            let phase = if retrigger {
                voice.lfo_phase.get(i).copied().unwrap_or(0.0)
            } else {
                self.global_lfo_phase.get(i).copied().unwrap_or(0.0)
            };
            if let Some(s) = sources.get_mut(4 + i) {
                *s = self.lfo_value(i, phase);
            }
            e.configure(envelope_settings(values, i));
        }
        for m in 0..8 {
            if let Some(s) = sources.get_mut(8 + m) {
                *s = at(values, 96 + m);
            }
        }
        sources[16] = clampf(voice.velocity, 0.0, 1.0);
        sources[17] = f32::from(voice.note) / 127.0;
        sources[18] = voice.random;
        for &index in self.active_routes.iter().take(self.route_count) {
            let Some(route) = self.patch.routes.get(index) else { continue };
            let mut source = sources.get(route.source as usize).copied().unwrap_or(0.0);
            if route.bipolar {
                source = 2.0 * source - 1.0;
            }
            if route.curve != 0.0 {
                source = powf(source.abs(), at(&self.route_exponent, index)).copysign(source);
            }
            if route.aux != g::NO_AUX_SOURCE {
                source *= sources.get(route.aux as usize).copied().unwrap_or(0.0);
            }
            if let Some(o) = offsets.get_mut(route.destination) {
                *o += source * route.amount;
            }
        }
        for (i, (m, &offset)) in modulated.iter_mut().zip(offsets.iter()).enumerate() {
            if !g::MODULATABLE.get(i).copied().unwrap_or(false) || offset == 0.0 {
                continue;
            }
            let (lo, hi) = (at(&g::MINIMUM, i), at(&g::MAXIMUM, i));
            if g::LOGARITHMIC.get(i).copied().unwrap_or(false) {
                let scale = logf(hi / lo);
                let floor = if lo < *m { *m } else { lo };
                let normalized = logf(floor / lo) / scale;
                *m = lo * expf(clampf(normalized + offset, 0.0, 1.0) * scale);
            } else {
                *m = lo + clampf((*m - lo) / (hi - lo) + offset, 0.0, 1.0) * (hi - lo);
            }
        }
        let ramp = if voice.fresh { 0 } else { CONTROL_PERIOD };
        let bend = self.pitch_bend.get(usize::from(voice.channel)).map_or(0.0, |b| b.value) * at(values, 95);
        let rate = self.rate;
        let fresh = voice.fresh;
        let note = f64::from(voice.note);
        for (osc, state) in voice.oscillators.iter_mut().enumerate() {
            let p = osc * 12;
            let count = at(params, p + 7) as u32;
            let bank = at(params, p + 1) as u32;
            if bank != state.bank {
                state.previous_bank = state.bank;
                state.bank = bank;
                state.bank_fade.reset(0.0);
                state.bank_fade.set(1.0, STEAL_FADE);
            }
            state.position.set(at(&modulated, p + 2), ramp);
            let level = at(&modulated, p + 3) * at(values, p) / sqrtf(count as f32);
            for (unison, u) in state.unison.iter_mut().enumerate() {
                let k = unison as u32;
                let fraction = if k < count { unison_fraction(k, count) } else { 0.0 };
                let semitones = note - 69.0
                    + f64::from(at(&modulated, p + 5))
                    + f64::from(at(values, p + 6)) * 0.01
                    + f64::from(bend)
                    + f64::from(fraction * at(values, p + 8)) * 0.01;
                let frequency = 440.0 * exp2(semitones / 12.0);
                let ratio = frequency / rate;
                let increment = (if 0.49 < ratio { 0.49 } else { ratio }) as f32;
                let held = f64::from(u.increment.value) * rate;
                u.mip = select_mip(if held < frequency { frequency } else { held }, rate);
                u.increment.set(increment, ramp);
                let pan = clampf(at(&modulated, p + 4) + fraction * at(values, p + 9), -1.0, 1.0);
                let amplitude = if k < count && frequency < rate * 0.46 { level } else { 0.0 };
                let gain_ramp = if fresh { 0 } else { STEAL_FADE };
                u.gain_left.set(amplitude * sqrtf(0.5 * (1.0 - pan)), gain_ramp);
                u.gain_right.set(amplitude * sqrtf(0.5 * (1.0 + pan)), gain_ramp);
            }
        }
        let sub_frequency =
            440.0 * exp2((note - 69.0 + f64::from(bend) + f64::from(at(values, 37)) * 12.0) / 12.0);
        let held = f64::from(voice.sub_increment.value) * rate;
        voice.sub_mip = select_mip(if held < sub_frequency { sub_frequency } else { held }, rate);
        let ratio = sub_frequency / rate;
        voice.sub_increment.set((if 0.49 < ratio { 0.49 } else { ratio }) as f32, ramp);
        // 0.70710678f in the C++ source (the same float as FRAC_1_SQRT_2).
        let sub_level = core::f32::consts::FRAC_1_SQRT_2;
        voice
            .sub_gain
            .set(if sub_frequency < rate * 0.46 { at(&modulated, 36) * sub_level } else { 0.0 }, ramp);
        voice.sub_shape.set(at(values, 38), ramp);
        voice.noise_gain.set(at(&modulated, 39) * 0.5, ramp);
        for (filter, f) in voice.filters.iter_mut().enumerate() {
            let p = 40 + filter * 4;
            f.configure(at(&modulated, p + 2), at(&modulated, p + 3), at(values, p + 1), at(values, p), ramp);
        }
        voice.fresh = false;
        voice.control_remaining = CONTROL_PERIOD;
    }

    fn table_view(&self, bank: u32, position: f32) -> TableView {
        let current = bank_of(self.tables.as_deref(), bank);
        let previous = bank_of(self.previous_tables.as_deref(), bank);
        match current {
            None => TableView {
                current_from_previous: true,
                current: previous.map(|p| p.frame_view(position)).unwrap_or_default(),
                previous: FrameView::default(),
                fade: 1.0,
            },
            Some(c) => TableView {
                current_from_previous: false,
                current: c.frame_view(position),
                previous: previous.map(|p| p.frame_view(position)).unwrap_or_default(),
                fade: self.table_fade.value,
            },
        }
    }

    fn read_view(&self, bank: u32, view: &TableView, phase: f64, mip: MipSelection) -> f32 {
        let set =
            if view.current_from_previous { self.previous_tables.as_deref() } else { self.tables.as_deref() };
        let current = bank_of(set, bank).map_or(0.0, |t| t.read_view(view.current, phase, mip));
        if view.previous.first.is_some() {
            let previous = bank_of(self.previous_tables.as_deref(), bank)
                .map_or(0.0, |t| t.read_view(view.previous, phase, mip));
            return lerp(previous, current, view.fade);
        }
        current
    }

    fn read_sub(&self, triangle: bool, phase: f64, mip: MipSelection) -> f32 {
        let current = self.tables.as_deref().map_or(0.0, |t| t.sub(triangle).read(phase, 0.0, mip));
        match self.previous_tables.as_deref() {
            Some(p) => lerp(p.sub(triangle).read(phase, 0.0, mip), current, self.table_fade.value),
            None => current,
        }
    }

    fn render_voice(&self, voice: &mut Voice, tail: bool) -> Stereo {
        if !voice.active {
            return Stereo::default();
        }
        for e in &mut voice.envelopes {
            e.next();
        }
        if !voice.envelopes.first().is_some_and(Envelope::active) {
            voice.active = false;
            return Stereo::default();
        }
        if voice.control_remaining == 0 {
            self.update_voice(voice);
        }
        voice.control_remaining = voice.control_remaining.wrapping_sub(1);
        let mut mixed = Stereo::default();
        for state in &mut voice.oscillators {
            let position = state.position.next();
            let bank_mix = state.bank_fade.next();
            let current_view = self.table_view(state.bank, position);
            let previous_view = if bank_mix < 1.0 {
                self.table_view(state.previous_bank, position)
            } else {
                TableView::default()
            };
            let (bank, previous_bank) = (state.bank, state.previous_bank);
            for u in &mut state.unison {
                let left = u.gain_left.next();
                let right = u.gain_right.next();
                if left != 0.0 || right != 0.0 {
                    let mut sample = self.read_view(bank, &current_view, u.phase, u.mip);
                    if bank_mix < 1.0 {
                        sample = lerp(
                            self.read_view(previous_bank, &previous_view, u.phase, u.mip),
                            sample,
                            bank_mix,
                        );
                    }
                    mixed.left += sample * left;
                    mixed.right += sample * right;
                }
                u.phase = advance_phase(u.phase, f64::from(u.increment.next()));
            }
        }
        let sub_gain = voice.sub_gain.next();
        let sub_shape = voice.sub_shape.next();
        if sub_gain != 0.0 {
            let a = self.read_sub(false, voice.sub_phase, voice.sub_mip);
            let shaped = if sub_shape == 0.0 {
                a
            } else {
                lerp(a, self.read_sub(true, voice.sub_phase, voice.sub_mip), sub_shape)
            };
            let sub = shaped * sub_gain;
            mixed.left += sub;
            mixed.right += sub;
        }
        voice.sub_phase = advance_phase(voice.sub_phase, f64::from(voice.sub_increment.next()));
        let noise = voice.noise_gain.next();
        if noise != 0.0 {
            mixed.left += (random_unit(&mut voice.rng) * 2.0 - 1.0) * noise;
            mixed.right += (random_unit(&mut voice.rng) * 2.0 - 1.0) * noise;
        }
        let [f0, f1] = &mut voice.filters;
        let first = f0.process(mixed);
        let routing = at(&self.values, 48);
        let blend = at(&self.values, 49);
        let second = f1.process(Stereo {
            left: lerp(first.left, mixed.left, routing),
            right: lerp(first.right, mixed.right, routing),
        });
        let parallel = Stereo {
            left: lerp(first.left, second.left, blend),
            right: lerp(first.right, second.right, blend),
        };
        let mut amplitude = VOICE_GAIN * voice.velocity * voice.envelope_value() * voice.fade_in.next();
        if tail {
            amplitude *= voice.tail_remaining as f32 / STEAL_FADE as f32;
            if voice.tail_remaining == 0 {
                voice.active = false;
            } else {
                voice.tail_remaining -= 1;
                if voice.tail_remaining == 0 {
                    voice.active = false;
                }
            }
        }
        for (p, inc) in voice.lfo_phase.iter_mut().zip(self.lfo_increment.iter()) {
            *p = advance_phase(*p, *inc);
        }
        Stereo {
            left: lerp(second.left, parallel.left, routing) * amplitude,
            right: lerp(second.right, parallel.right, routing) * amplitude,
        }
    }

    fn update_lfo_increments(&mut self, bpm: f64) {
        for (lfo, inc) in self.lfo_increment.iter_mut().enumerate() {
            let p = 70 + lfo * 4;
            let rate = if at(&self.patch.params, p + 1) >= 0.5 {
                bpm / (60.0 * f64::from(at(&self.patch.params, p + 2)))
            } else {
                f64::from(at(&self.values, p))
            };
            *inc = rate / self.rate;
        }
    }

    fn refresh(&mut self) {
        self.control_remaining = 0;
    }
}

impl Synth {
    /// `Synth()` + `prepare(rate, tables)` (control thread).
    #[inline(never)]
    pub fn new(rate: f64, tables: Arc<PreparedWavetableSet>) -> Result<Box<Self>, Error> {
        if !rate.is_finite() || !(22_050.0..=192_000.0).contains(&rate) {
            return Err(Error::new("Sample rate must be 22050..192000 Hz"));
        }
        let core = Core {
            rate: 48_000.0,
            prepared: false,
            tables: None,
            previous_tables: None,
            retired_tables: None,
            table_fade: LinearSmoother::default(),
            curve_fade: LinearSmoother::default(),
            patch: Patch::default(),
            previous_curves: [[0.0; g::LFO_POINTS]; 4],
            parameters: [LinearSmoother::default(); g::PARAM_COUNT],
            values: g::DEFAULTS,
            route_exponent: [0.0; g::MAX_MOD_ROUTES],
            active_routes: [0; g::MAX_MOD_ROUTES],
            route_count: 0,
            pitch_bend: [LinearSmoother::default(); 16],
            sustain: [false; 16],
            global_lfo_phase: [0.0; 4],
            lfo_increment: [0.0; 4],
            control_remaining: 0,
            random_state: 0x49e1_27ad,
            voice_age: 0,
            processed_frames: 0,
        };
        // Built in place: the voices are ~74 KB, larger than the 64 KiB WASM stack.
        let mut uninit = Box::<Self>::new_uninit();
        let dst = uninit.as_mut_ptr();
        // SAFETY: every field of the fresh, aligned allocation is written exactly once below
        // (the voice arrays element by element) before `assume_init`.
        let mut s = unsafe {
            core::ptr::addr_of_mut!((*dst).core).write(core);
            for array in [core::ptr::addr_of_mut!((*dst).voices), core::ptr::addr_of_mut!((*dst).tails)] {
                let first = array.cast::<Voice>();
                for i in 0..g::MAX_POLYPHONY {
                    first.add(i).write(Voice::default());
                }
            }
            core::ptr::addr_of_mut!((*dst).effects).write(Effects::new(rate));
            uninit.assume_init()
        };
        s.apply_patch(&Patch::default(), true);
        if !has_selected_banks(&s.core.patch, &tables) {
            return Err(Error::new("Prepared set is missing a selected wavetable bank"));
        }
        s.core.rate = rate;
        s.core.tables = Some(tables);
        s.core.prepared = true;
        s.reset(0x49e1_27ad);
        Ok(s)
    }

    pub fn sample_rate(&self) -> f64 {
        self.core.rate
    }

    pub fn reset(&mut self, seed: u32) {
        let c = &mut self.core;
        c.random_state = if seed == 0 { 1 } else { seed };
        // Element by element: no 74 KB temporary on the (small) audio-thread stack.
        for v in self.voices.iter_mut().chain(self.tails.iter_mut()) {
            *v = Voice::default();
        }
        for b in &mut c.pitch_bend {
            b.reset(0.0);
        }
        c.sustain = [false; 16];
        c.global_lfo_phase = [0.0; 4];
        c.lfo_increment = [0.0; 4];
        c.control_remaining = 0;
        c.voice_age = 0;
        c.processed_frames = 0;
        for ((p, v), &x) in c.parameters.iter_mut().zip(c.values.iter_mut()).zip(c.patch.params.iter()) {
            p.reset(x);
            *v = x;
        }
        c.previous_curves = c.patch.lfo_curves;
        c.curve_fade.reset(1.0);
        self.effects.reset();
        if c.previous_tables.is_some() {
            c.retired_tables = c.previous_tables.take();
        }
        c.table_fade.reset(1.0);
    }

    fn refresh_voices(&mut self) {
        for v in self.voices.iter_mut().chain(self.tails.iter_mut()) {
            v.control_remaining = 0;
        }
        self.core.refresh();
    }

    pub fn set_parameter(&mut self, index: usize, value: f32, immediate: bool) -> bool {
        if !validate_parameter(index, value) {
            return false;
        }
        let c = &mut self.core;
        if index < 36 && index % 12 == 1 && c.tables.as_ref().is_some_and(|t| !t.has_bank(value as u32)) {
            return false;
        }
        let smoothing = c.smoothing_frames();
        if let Some(p) = c.patch.params.get_mut(index) {
            *p = value;
        }
        let jump = immediate || discrete_parameter(index);
        if let Some(p) = c.parameters.get_mut(index) {
            p.set(value, if jump { 0 } else { smoothing });
        }
        if jump && let Some(v) = c.values.get_mut(index) {
            *v = value;
        }
        self.refresh_voices();
        true
    }

    pub fn apply_patch(&mut self, incoming: &Patch, immediate: bool) -> bool {
        let c = &mut self.core;
        if !validate_patch(incoming) || c.tables.as_ref().is_some_and(|t| !has_selected_banks(incoming, t)) {
            return false;
        }
        let now = immediate || c.processed_frames == 0;
        if incoming.lfo_curves != c.patch.lfo_curves {
            let fade = c.curve_fade.value;
            for (prev, cur) in c.previous_curves.iter_mut().zip(c.patch.lfo_curves.iter()) {
                for (p, x) in prev.iter_mut().zip(cur.iter()) {
                    *p = lerp(*p, *x, fade);
                }
            }
            c.curve_fade.reset(if now { 1.0 } else { 0.0 });
            if !now {
                c.curve_fade.set(1.0, (c.rate * 0.02) as u32);
            }
        }
        c.patch = incoming.clone();
        let smoothing = c.smoothing_frames();
        for (i, ((p, v), &x)) in
            c.parameters.iter_mut().zip(c.values.iter_mut()).zip(c.patch.params.iter()).enumerate()
        {
            let jump = now || discrete_parameter(i);
            p.set(x, if jump { 0 } else { smoothing });
            if jump {
                *v = x;
            }
        }
        c.route_count = 0;
        for (i, (r, e)) in c.patch.routes.iter().zip(c.route_exponent.iter_mut()).enumerate() {
            *e = exp2f(r.curve * 2.0);
            if r.enabled && r.amount != 0.0 {
                if let Some(slot) = c.active_routes.get_mut(c.route_count) {
                    *slot = i;
                }
                c.route_count += 1;
            }
        }
        self.refresh_voices();
        true
    }

    fn release(voice: &mut Voice) {
        voice.sustained = false;
        for e in &mut voice.envelopes {
            e.note_off();
        }
    }

    fn note_off(&mut self, event: &Event) {
        let mut chosen: Option<usize> = None;
        for (i, v) in self.voices.iter().enumerate() {
            if !v.active || !v.key_down || v.channel != event.channel {
                continue;
            }
            if if event.note_id != 0 { v.note_id != event.note_id } else { v.note != event.note } {
                continue;
            }
            if chosen.and_then(|c| self.voices.get(c)).is_none_or(|c| v.age < c.age) {
                chosen = Some(i);
            }
        }
        let sustained = self.core.sustain.get(usize::from(event.channel)).copied().unwrap_or(false);
        let Some(v) = chosen.and_then(|c| self.voices.get_mut(c)) else { return };
        v.key_down = false;
        if sustained {
            v.sustained = true;
        } else {
            Self::release(v);
        }
    }

    fn note_on(&mut self, event: &Event) {
        if event.value <= 0.0 {
            self.note_off(event);
            return;
        }
        let mut chosen = 0usize;
        let found = match self.voices.iter().position(|v| !v.active) {
            Some(i) => {
                chosen = i;
                true
            }
            None => false,
        };
        if !found {
            // Prefer the quietest released voice, then the oldest held voice.
            for i in 1..self.voices.len() {
                let (Some(a), Some(b)) = (self.voices.get(i), self.voices.get(chosen)) else { continue };
                let released_a = !a.key_down && !a.sustained;
                let released_b = !b.key_down && !b.sustained;
                let quieter =
                    if released_a { a.envelope_value() < b.envelope_value() } else { a.age < b.age };
                if (released_a && !released_b) || (released_a == released_b && quieter) {
                    chosen = i;
                }
            }
            if let Some(v) = self.voices.get(chosen).copied()
                && let Some(t) = self.tails.get_mut(chosen)
            {
                *t = v;
                t.tail_remaining = STEAL_FADE;
            }
        }
        let c = &mut self.core;
        let rate = c.rate;
        let values = c.values;
        c.voice_age += 1;
        let age = c.voice_age;
        let mut rng = random_bits(&mut c.random_state);
        if rng == 0 {
            rng = 1;
        }
        let banks = [at(&c.patch.params, 1), at(&c.patch.params, 13), at(&c.patch.params, 25)];
        let Some(voice) = self.voices.get_mut(chosen) else { return };
        *voice = Voice::default();
        voice.active = true;
        voice.key_down = true;
        voice.channel = event.channel;
        voice.note = event.note;
        voice.note_id = event.note_id;
        voice.velocity = event.value;
        voice.age = age;
        voice.rng = rng;
        voice.random = random_unit(&mut voice.rng);
        for (k, e) in voice.envelopes.iter_mut().enumerate() {
            e.prepare(rate);
            e.configure(envelope_settings(&values, k));
            e.note_on();
        }
        for f in &mut voice.filters {
            f.prepare(rate);
        }
        for ((osc, state), bank) in voice.oscillators.iter_mut().enumerate().zip(banks) {
            state.bank = bank as u32;
            state.previous_bank = bank as u32;
            state.bank_fade.reset(1.0);
            let (phase, random) = (at(&values, osc * 12 + 10), at(&values, osc * 12 + 11));
            for u in &mut state.unison {
                u.phase = wrap_phase(f64::from(phase + random * random_unit(&mut voice.rng)));
            }
        }
        voice.fade_in.reset(if found { 1.0 } else { 0.0 });
        if !found {
            voice.fade_in.set(1.0, STEAL_FADE);
        }
    }

    fn handle_event(&mut self, event: &Event) {
        if event.channel > 15 || event.note > 127 || !event.value.is_finite() {
            return;
        }
        let ch = usize::from(event.channel);
        match event.kind {
            EventType::NoteOn => {
                if (0.0..=2.0).contains(&event.value) {
                    self.note_on(event);
                }
            }
            EventType::NoteOff => self.note_off(event),
            EventType::Parameter => {
                let _ = self.set_parameter(event.parameter, event.value, false);
            }
            EventType::PitchBend => {
                if event.value.abs() > 1.0 {
                    return;
                }
                let frames = (self.core.rate * 0.005) as u32;
                if let Some(b) = self.core.pitch_bend.get_mut(ch) {
                    b.set(event.value, frames);
                }
                self.refresh_voices();
            }
            EventType::AllNotesOff => {
                if let Some(s) = self.core.sustain.get_mut(ch) {
                    *s = false;
                }
                for v in &mut self.voices {
                    if v.active && v.channel == event.channel {
                        v.key_down = false;
                        Self::release(v);
                    }
                }
            }
        }
    }

    /// Stereo planar overwrite of `left.len()` frames; `events` sorted, offsets < frames.
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32], events: &[Event], transport: Transport) {
        let frames = left.len().min(right.len());
        if !self.core.prepared || self.core.tables.is_none() {
            left.fill(0.0);
            right.fill(0.0);
            return;
        }
        let bpm = if transport.bpm.is_finite() { clampd(transport.bpm, 1.0, 999.0) } else { 120.0 };
        if transport.playing && transport.has_beat_position && transport.beat_position.is_finite() {
            let c = &mut self.core;
            for (lfo, phase) in c.global_lfo_phase.iter_mut().enumerate() {
                let p = 70 + lfo * 4;
                if at(&c.patch.params, p + 1) >= 0.5 && at(&c.patch.params, p + 3) < 0.5 {
                    let division = f64::from(at(&c.patch.params, p + 2));
                    *phase = wrap_phase(fmod(transport.beat_position, division) / division);
                }
            }
        }
        let count = events.len().min(MAX_EVENTS);
        let events = events.get(..count).unwrap_or(&[]);
        let mut next = 0usize;
        for (frame, (l, r)) in left.iter_mut().zip(right.iter_mut()).enumerate() {
            while let Some(&e) = events.get(next)
                && e.offset as usize <= frame
            {
                if e.offset as usize == frame {
                    self.handle_event(&e);
                }
                next += 1;
            }
            let c = &mut self.core;
            for (v, p) in c.values.iter_mut().zip(c.parameters.iter_mut()) {
                *v = p.next();
            }
            for b in &mut c.pitch_bend {
                b.next();
            }
            c.curve_fade.next();
            c.table_fade.next();
            if c.control_remaining == 0 {
                c.update_lfo_increments(bpm);
                c.control_remaining = CONTROL_PERIOD;
            }
            c.control_remaining -= 1;
            let mut sum = Stereo::default();
            for v in &mut self.voices {
                let s = self.core.render_voice(v, false);
                sum.left += s.left;
                sum.right += s.right;
            }
            for v in &mut self.tails {
                let s = self.core.render_voice(v, true);
                sum.left += s.left;
                sum.right += s.right;
            }
            let v = &self.core.values;
            let effected = self.effects.process(
                sum,
                at(v, 86),
                at(v, 87),
                at(v, 88),
                at(v, 89),
                at(v, 90),
                at(v, 91),
                at(v, 92),
                at(v, 93),
            );
            let level = at(v, 94);
            *l = safety_ceiling(effected.left * level);
            *r = safety_ceiling(effected.right * level);
            let c = &mut self.core;
            for (p, inc) in c.global_lfo_phase.iter_mut().zip(c.lfo_increment.iter()) {
                *p = advance_phase(*p, *inc);
            }
            if c.previous_tables.is_some() && c.table_fade.remaining == 0 {
                c.retired_tables = c.previous_tables.take();
            }
        }
        self.core.processed_frames += frames as u64;
    }

    /// `applyPreparedPatch`: a new patch on a new table set, crossfading the sets (20 ms).
    pub fn apply_prepared_patch(&mut self, patch: &Patch, tables: &Arc<PreparedWavetableSet>) -> bool {
        let c = &mut self.core;
        if !c.prepared || !validate_patch(patch) || !has_selected_banks(patch, tables) {
            return false;
        }
        if c.tables.as_ref().is_some_and(|t| Arc::ptr_eq(t, tables)) {
            return self.apply_patch(patch, false);
        }
        if c.previous_tables.is_some() || c.retired_tables.is_some() {
            return false;
        }
        c.previous_tables = c.tables.take();
        c.tables = Some(tables.clone());
        c.table_fade.reset(0.0);
        let frames = (c.rate * 0.02) as u32;
        c.table_fade.set(1.0, frames.max(128));
        self.apply_patch(patch, false)
    }

    /// `takeRetiredWavetables`: the old set after its last read.
    pub fn take_retired(&mut self) -> Option<Arc<PreparedWavetableSet>> {
        self.core.retired_tables.take()
    }
}

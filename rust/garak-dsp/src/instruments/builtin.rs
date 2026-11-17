//! The engine's built-in voices: the five synthesizers (`keys`, `bass`, `pad`, `pluck`, `rhodes`),
//! the synthesized drum kit (`drums`) and the sample player for `builtin-sampled` instruments and
//! kits (pianos, gugak instruments, drum kits). A line-for-line port of native/src/engine.cpp
//! (`Synth`, `Voice`, `pickZone`, `oscillator`, `TrackRuntime::spawn` / `envelope` /
//! `voicesInto` / `releaseLive` / the live pedal), so the Rust render engine (garak-engine) sounds
//! bit-identical to the C++ `RenderEngine` on the same platform libm.
//!
//! Real-time contract: a [`Voices`] pool is a fixed array of [`MAX_VOICES`] voices (no heap; the
//! engine boxes it on the control thread). Sample PCM is borrowed through [`SampleBank`] from the
//! caller, which owns the registered assets.

use crate::biquad::{Biquad, FilterType};
use crate::math;
use crate::{PI, std_max, std_min};

/// Voices per track (engine.cpp `maxVoices`).
pub const MAX_VOICES: usize = 128;
const EPSILON: f64 = 0.00001;
const NONE: u32 = u32::MAX;

/// Which built-in sound a track plays (engine.cpp `Synth::Kind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SynthKind {
    Keys,
    Bass,
    Pad,
    Pluck,
    Rhodes,
    Drums,
    Sampled,
}

/// Instrument parameters (engine.cpp `Synth`). Voices copy it when they start, so automation and
/// knob edits shape new notes only, like the C++ engine.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Synth {
    pub kind: SynthKind,
    pub level: f64,
    pub tone: f64,
    pub attack: f64,
    pub decay: f64,
    pub sustain: f64,
    pub release: f64,
    pub sub: f64,
    pub bell: f64,
    pub detune: f64,
    pub sweep: f64,
    pub bark: f64,
    pub tune: f64,
    pub punch: f64,
    pub release_noise: f64,
}

impl Default for Synth {
    fn default() -> Self {
        Self {
            kind: SynthKind::Keys,
            level: 1.0,
            tone: 0.0,
            attack: 0.004,
            decay: 0.22,
            sustain: 0.2,
            release: 0.3,
            sub: 0.65,
            bell: 0.2,
            detune: 7.0,
            sweep: 0.25,
            bark: 0.5,
            tune: 0.0,
            punch: 1.0,
            release_noise: 0.5,
        }
    }
}

/// Automatable fields (engine.cpp `synthField`), in that table's order.
pub const SYNTH_FIELDS: [&str; 14] = [
    "level",
    "tone",
    "attack",
    "decay",
    "sustain",
    "release",
    "sub",
    "bell",
    "detune",
    "sweep",
    "bark",
    "tune",
    "punch",
    "releaseNoise",
];

impl Synth {
    /// Index of an automatable field in [`SYNTH_FIELDS`].
    pub fn field_index(name: &str) -> Option<usize> {
        SYNTH_FIELDS.iter().position(|f| *f == name)
    }

    /// Writes field `index` (see [`SYNTH_FIELDS`]); unknown indices are ignored.
    pub fn set_field(&mut self, index: usize, value: f64) {
        let slot = match index {
            0 => &mut self.level,
            1 => &mut self.tone,
            2 => &mut self.attack,
            3 => &mut self.decay,
            4 => &mut self.sustain,
            5 => &mut self.release,
            6 => &mut self.sub,
            7 => &mut self.bell,
            8 => &mut self.detune,
            9 => &mut self.sweep,
            10 => &mut self.bark,
            11 => &mut self.tune,
            12 => &mut self.punch,
            13 => &mut self.release_noise,
            _ => return,
        };
        *slot = value;
    }
}

/// One sample zone (C++ `SampleZone` without its asset id): key range or kit pad, velocity layer,
/// gain, tuning in cents, optional loop in seconds (before the codec start offset), choke group.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Zone {
    pub root: i32,
    pub lo: i32,
    pub hi: i32,
    pub vlo: f64,
    pub vhi: f64,
    pub gain_db: f64,
    pub tune: f64,
    pub looped: Option<[f64; 2]>,
    pub choke: i32,
}

/// Borrowed interleaved PCM of one zone.
#[derive(Clone, Copy, Debug)]
pub struct Pcm<'a> {
    pub samples: &'a [f32],
    pub channels: u32,
    pub sample_rate: u32,
}

impl Pcm<'_> {
    #[inline]
    pub fn frames(&self) -> u64 {
        if self.channels == 0 { 0 } else { (self.samples.len() / self.channels as usize) as u64 }
    }

    /// engine.cpp `pcmChannel`: linear interpolation, silence outside the asset.
    #[inline]
    fn channel(&self, frames: u64, position: f64, channel: u32) -> f32 {
        if position < 0.0 || position >= frames as f64 {
            return 0.0;
        }
        let index = position as u64;
        let c = channel.min(self.channels.saturating_sub(1)) as usize;
        let stride = self.channels as usize;
        let at = index as usize * stride + c;
        let left = self.samples.get(at).copied().unwrap_or(0.0);
        let right =
            if index + 1 < frames { self.samples.get(at + stride).copied().unwrap_or(0.0) } else { 0.0 };
        math::mul_add_f32((position - index as f64) as f32, right - left, left)
    }

    /// engine.cpp `pcmSample`: the speaker downmix of 4- and 6-channel assets.
    #[inline]
    pub fn sample(&self, position: f64, channel: u32) -> f32 {
        let frames = self.frames();
        match self.channels {
            4 => {
                0.5 * (self.channel(frames, position, channel) + self.channel(frames, position, channel + 2))
            }
            6 => math::mul_add_f32(
                0.707_106_77,
                self.channel(frames, position, 2) + self.channel(frames, position, channel + 4),
                self.channel(frames, position, channel),
            ),
            _ => self.channel(frames, position, channel),
        }
    }
}

/// A track's resolved sample set (C++ `ResolvedSet`), implemented by the engine over its
/// registered assets. Synth tracks use [`NoSamples`].
pub trait SampleBank {
    fn is_kit(&self) -> bool;
    fn gain_db(&self) -> f64;
    fn start_offset(&self) -> f64;
    fn zones(&self) -> &[Zone];
    fn releases(&self) -> &[Zone];
    /// PCM of zone `index` (`release`: of the release zones).
    fn pcm(&self, release: bool, index: usize) -> Option<Pcm<'_>>;
}

/// No samples (synthesizer tracks).
#[derive(Clone, Copy, Debug, Default)]
pub struct NoSamples;

impl SampleBank for NoSamples {
    fn is_kit(&self) -> bool {
        false
    }
    fn gain_db(&self) -> f64 {
        0.0
    }
    fn start_offset(&self) -> f64 {
        0.0
    }
    fn zones(&self) -> &[Zone] {
        &[]
    }
    fn releases(&self) -> &[Zone] {
        &[]
    }
    fn pcm(&self, _: bool, _: usize) -> Option<Pcm<'_>> {
        None
    }
}

/// engine.cpp `pickZone`: the key's zone whose velocity layer holds `velocity` (the top layer is
/// inclusive), else the nearest layer, ties to the closest root.
pub fn pick_zone(zones: &[Zone], kit: bool, pitch: i32, velocity: f32) -> Option<usize> {
    let hit = |z: &Zone| if kit { z.root == pitch } else { pitch >= z.lo && pitch <= z.hi };
    let velocity = f64::from(velocity);
    let mut top = -1.0f64;
    for z in zones.iter().filter(|z| hit(z)) {
        top = std_max(top, z.vhi);
    }
    let mut best: Option<usize> = None;
    let mut best_distance = f64::MAX;
    let mut matched = false;
    for (i, z) in zones.iter().enumerate() {
        if !hit(z) {
            continue;
        }
        let layer = velocity >= z.vlo && (velocity < z.vhi || (z.vhi == top && velocity <= z.vhi));
        let distance = if layer { 0.0 } else { std_max(std_max(z.vlo - velocity, velocity - z.vhi), 0.0) };
        let better = match best.and_then(|b| zones.get(b)) {
            None => true,
            Some(b) => {
                (layer && !matched)
                    || (layer == matched
                        && (distance < best_distance
                            || (distance == best_distance
                                && (z.root - pitch).abs() < (b.root - pitch).abs())))
            }
        };
        if better {
            best = Some(i);
            best_distance = distance;
            matched = layer;
        }
    }
    best
}

/// Piano key-release ("damper") noise level, 0 = skip (dsp.hpp `releaseNoiseGain`).
// NaN-aware like the C++ `!(x > y)` tests.
#[allow(clippy::neg_cmp_op_on_partial_ord)]
pub fn release_noise_gain(velocity: f64, held: f64, natural: f64, amount: f64, cut: bool) -> f64 {
    if cut || !(amount > 0.0) || !(velocity > 0.02) || !(held < natural) {
        return 0.0;
    }
    let gain = std_min(1.0, amount) * std_min(1.0, velocity) * math::exp(-std_max(0.0, held) / 2.0);
    if gain >= 0.002 { gain } else { 0.0 }
}

#[inline]
fn db_to_gain(db: f64) -> f64 {
    math::pow(10.0, db / 20.0)
}

#[inline]
fn poly_blep(phase: f64, step: f64) -> f64 {
    if phase < step {
        let t = phase / step;
        return t + t - t * t - 1.0;
    }
    if phase > 1.0 - step {
        let t = (phase - 1.0) / step;
        return t * t + t + t + 1.0;
    }
    0.0
}

/// engine.cpp `oscillator`: 0 sine, 1 polyBLEP saw, 2 band-limited triangle series.
#[inline]
fn oscillator(phase: &mut f64, frequency: f64, sr: f64, waveform: i32) -> f64 {
    let step = crate::std_clamp(frequency / sr, 0.0, 0.45);
    let mut value = 0.0;
    if waveform == 1 {
        value = 2.0 * *phase - 1.0 - poly_blep(*phase, step);
    } else if waveform == 2 {
        let mut harmonic = 1i32;
        while harmonic <= 15 && frequency * f64::from(harmonic) < sr * 0.45 {
            let sign = if harmonic % 4 == 1 { 1.0 } else { -1.0 };
            value +=
                sign * math::sin(2.0 * PI * *phase * f64::from(harmonic)) / f64::from(harmonic * harmonic);
            harmonic += 2;
        }
        value *= 8.0 / (PI * PI);
    } else {
        value = math::sin(2.0 * PI * *phase);
    }
    *phase += step;
    if *phase >= 1.0 {
        *phase -= 1.0;
    }
    value
}

/// One voice (engine.cpp `Voice`).
#[derive(Clone, Debug)]
struct Voice {
    synth: Synth,
    active: bool,
    sampled: bool,
    release_sample: bool,
    release_spawned: bool,
    live: bool,
    forced_release: bool,
    cut: bool,
    /// Live note released while the live pedal is down: rings until the pedal lifts.
    sustained: bool,
    id: i32,
    pitch: i32,
    choke: i32,
    age: i64,
    note_frames: i64,
    end_frames: i64,
    velocity: f32,
    sample_position: f64,
    sample_step: f64,
    peak: f64,
    natural_frames: f64,
    release_gain: f64,
    frequency: f64,
    drum_decay: f64,
    drum_sweep: f64,
    drum_start: f64,
    drum_end: f64,
    phases: [f64; 4],
    tone: Biquad,
    noise_filter: Biquad,
    /// Zone index (into the release zones when `zone_release`), or NONE.
    zone: u32,
    zone_release: bool,
    release_zone: u32,
    noise: u32,
    choke_gain: f64,
    choking: bool,
}

impl Default for Voice {
    fn default() -> Self {
        Self {
            synth: Synth::default(),
            active: false,
            sampled: false,
            release_sample: false,
            release_spawned: false,
            live: false,
            forced_release: false,
            cut: false,
            sustained: false,
            id: 0,
            pitch: 60,
            choke: -1,
            age: 0,
            note_frames: 0,
            end_frames: 0,
            velocity: 1.0,
            sample_position: 0.0,
            sample_step: 1.0,
            peak: 1.0,
            natural_frames: 0.0,
            release_gain: 0.0,
            frequency: 440.0,
            drum_decay: 0.0,
            drum_sweep: 0.0,
            drum_start: 0.0,
            drum_end: 0.0,
            phases: [0.0; 4],
            tone: Biquad::default(),
            noise_filter: Biquad::default(),
            zone: NONE,
            zone_release: false,
            release_zone: NONE,
            noise: 47081,
            choke_gain: 1.0,
            choking: false,
        }
    }
}

/// MIDI controller numbers of the timeline / live input (engine.hpp).
pub mod controller {
    pub const MOD_WHEEL: i32 = 1;
    pub const VOLUME: i32 = 7;
    pub const EXPRESSION: i32 = 11;
    pub const SUSTAIN: i32 = 64;
    pub const CHANNEL_PRESSURE: i32 = 128;
    pub const PITCH_BEND: i32 = 129;
    pub const PROGRAM_CHANGE: i32 = 130;
    pub const BEND_RANGE: i32 = 131;
    pub const COUNT: i32 = 132;
}

/// The latest controller values (engine.cpp `TrackRuntime::Controllers`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Controllers {
    pub bend: i32,
    pub range: i32,
    pub modulation: i32,
    pub pressure: i32,
    pub volume: i32,
    pub expression: i32,
}

impl Default for Controllers {
    fn default() -> Self {
        Self { bend: 0, range: 2, modulation: 0, pressure: 0, volume: 100, expression: 127 }
    }
}

const VIBRATO_DEPTH_CENTS: f64 = 50.0;
const VIBRATO_RATE: f64 = 5.5;
const CONTROLLER_SMOOTHING_SECONDS: f64 = 0.005;

/// What a track tells its voices about itself.
#[derive(Clone, Copy, Debug)]
pub struct VoiceContext<'a> {
    pub sample_rate: f64,
    /// The track source's `isKit` (kits ignore bend / vibrato and the release rules).
    pub kit: bool,
    /// The track's current parameters (copied into new voices).
    pub synth: &'a Synth,
}

/// A track's voice pool and controller state (the built-in half of engine.cpp `TrackRuntime`).
#[derive(Clone, Debug)]
pub struct Voices {
    voices: [Voice; MAX_VOICES],
    pub controllers: Controllers,
    pub bend_cents: f64,
    pub vibrato_cents: f64,
    pub control_gain: f64,
    pub vibrato_phase: f64,
    /// Live sustain pedal (CC64 from live input).
    pub live_pedal: bool,
}

impl Default for Voices {
    fn default() -> Self {
        Self::new()
    }
}

impl Voices {
    pub fn new() -> Self {
        Self {
            voices: core::array::from_fn(|_| Voice::default()),
            controllers: Controllers::default(),
            bend_cents: 0.0,
            vibrato_cents: 0.0,
            control_gain: 1.0,
            vibrato_phase: 0.0,
            live_pedal: false,
        }
    }

    /// Voices currently sounding.
    pub fn active(&self) -> usize {
        self.voices.iter().filter(|v| v.active).count()
    }

    /// Silences every voice (a transport reset).
    pub fn deactivate(&mut self) {
        for v in &mut self.voices {
            v.active = false;
        }
    }

    /// Clears every sustained mark (a panic lifts the live pedal).
    pub fn clear_sustained(&mut self) {
        for v in &mut self.voices {
            v.sustained = false;
        }
    }

    /// engine.cpp `applyController`.
    pub fn apply_controller(&mut self, number: i32, value: i32) {
        let c = &mut self.controllers;
        match number {
            controller::PITCH_BEND => c.bend = value,
            controller::BEND_RANGE => c.range = value,
            controller::MOD_WHEEL => c.modulation = value,
            controller::CHANNEL_PRESSURE => c.pressure = value,
            controller::VOLUME => c.volume = value,
            controller::EXPRESSION => c.expression = value,
            _ => {}
        }
    }

    fn bend_target(&self) -> f64 {
        let c = &self.controllers;
        let normalized = if c.bend > 0 { f64::from(c.bend) / 8191.0 } else { f64::from(c.bend) / 8192.0 };
        normalized * f64::from(c.range) * 100.0
    }

    fn vibrato_target(&self) -> f64 {
        let c = &self.controllers;
        f64::from(c.modulation.max(c.pressure)) / 127.0 * VIBRATO_DEPTH_CENTS
    }

    fn gain_target(&self) -> f64 {
        let v = f64::from(self.controllers.volume) / 100.0;
        let e = f64::from(self.controllers.expression) / 127.0;
        v * v * e * e
    }

    /// Jumps the smoothed values to their targets (after a chase).
    pub fn snap_controllers(&mut self) {
        self.bend_cents = self.bend_target();
        self.vibrato_cents = self.vibrato_target();
        self.control_gain = self.gain_target();
    }

    /// Takes the predecessor's voices and controller state (an edited track keeps ringing).
    pub fn take_from(&mut self, previous: &mut Voices) {
        core::mem::swap(&mut self.voices, &mut previous.voices);
        self.controllers = previous.controllers;
        self.bend_cents = previous.bend_cents;
        self.vibrato_cents = previous.vibrato_cents;
        self.control_gain = previous.control_gain;
        self.vibrato_phase = previous.vibrato_phase;
        self.live_pedal = previous.live_pedal;
    }

    /// engine.cpp `availableVoice`: a free voice, else the oldest (counted as an overflow).
    fn available(&self, overflows: &mut u64) -> usize {
        if let Some(i) = self.voices.iter().position(|v| !v.active) {
            return i;
        }
        *overflows += 1;
        let mut best = 0usize;
        for (i, v) in self.voices.iter().enumerate() {
            if self.voices.get(best).is_some_and(|b| b.age < v.age) {
                best = i;
            }
        }
        best
    }

    /// The voice half of engine.cpp `TrackRuntime::spawn` (the caller checked velocity, durations,
    /// the enabled flag and the source kind). `sampled`: a `builtin-sampled` source.
    #[inline(never)]
    pub fn spawn<B: SampleBank>(
        &mut self,
        ctx: &VoiceContext<'_>,
        bank: &B,
        sampled: bool,
        pitch: i32,
        velocity: f32,
        duration: i64,
        available: i64,
        id: i32,
        live: bool,
        overflows: &mut u64,
    ) {
        if live && !ctx.kit {
            self.retrigger_sustained(ctx, pitch);
        }
        let sr = ctx.sample_rate;
        let synth = *ctx.synth;
        let clamped = velocity.clamp(0.0, 1.0);
        let mut zone: Option<(usize, Zone, Pcm<'_>)> = None;
        if sampled {
            let Some(index) = pick_zone(bank.zones(), bank.is_kit(), pitch, clamped) else { return };
            let (Some(z), Some(pcm)) = (bank.zones().get(index), bank.pcm(false, index)) else { return };
            zone = Some((index, *z, pcm));
        }
        let slot = self.available(overflows);
        let kit_voice = bank.is_kit();
        let Some(voice) = self.voices.get_mut(slot) else { return };
        *voice = Voice::default();
        voice.synth = synth;
        voice.active = true;
        voice.pitch = pitch;
        voice.velocity = velocity;
        voice.id = id;
        voice.live = live;
        voice.note_frames = 1i64.max(duration.min(available));
        voice.frequency = 440.0 * math::pow(2.0, f64::from(pitch - 69) / 12.0);
        voice.noise = 47081;
        let tone_factor = math::pow(2.0, synth.tone * 2.0);
        if let Some((index, z, pcm)) = zone {
            voice.sampled = true;
            voice.zone = index as u32;
            voice.choke = z.choke;
            let asset_rate = f64::from(pcm.sample_rate);
            voice.sample_position = bank.start_offset() * asset_rate;
            let semitones = if kit_voice { 0.0 } else { f64::from(pitch - z.root) / 12.0 };
            let ratio =
                math::pow(2.0, semitones + z.tune / 1200.0 + if kit_voice { synth.tune / 12.0 } else { 0.0 });
            voice.sample_step = ratio * asset_rate / sr;
            voice.natural_frames =
                std_max(1.0, (pcm.frames() as f64 - voice.sample_position) / voice.sample_step);
            voice.peak = db_to_gain(bank.gain_db() + z.gain_db - 6.0)
                * (0.25 + 0.75 * f64::from(velocity))
                * synth.level;
            if synth.tone < 0.0 {
                voice.tone.configure(
                    FilterType::Lowpass,
                    sr,
                    20000.0 * math::pow(2.0, synth.tone * 3.0),
                    0.5,
                    0.0,
                );
            } else {
                voice.tone.configure(FilterType::HighShelf, sr, 2500.0, 1.0, synth.tone * 6.0);
            }
            if kit_voice {
                voice.drum_decay = if synth.decay < 1.0 {
                    std_max(0.02 * sr, synth.decay * voice.natural_frames)
                } else {
                    voice.natural_frames
                };
                voice.end_frames = (voice.drum_decay + 0.004 * sr) as i64;
                let choke = voice.choke;
                if choke >= 0 {
                    for (i, previous) in self.voices.iter_mut().enumerate() {
                        if i != slot && previous.active && previous.choke == choke {
                            previous.choking = true;
                        }
                    }
                }
            } else {
                voice.end_frames = voice.note_frames + ((synth.release * 1.5 + 0.02) * sr) as i64;
                if z.looped.is_none() {
                    voice.end_frames = voice.end_frames.min((voice.natural_frames + 0.01 * sr) as i64);
                }
                // A timeline note that reaches its clip end, the loop boundary or the project end is
                // cut off, not released.
                voice.cut = !live && duration >= available;
                if !bank.releases().is_empty() && synth.release_noise > 0.0 && !voice.cut {
                    voice.release_zone =
                        pick_zone(bank.releases(), false, pitch, clamped).map_or(NONE, |r| r as u32);
                }
            }
            return;
        }
        voice.end_frames = voice.note_frames + ((synth.release + 0.005) * sr) as i64;
        let mut cutoff = 6800.0;
        let mut amplitude = 0.35;
        match synth.kind {
            SynthKind::Bass => {
                // `700+velocity*1700` with a float velocity: evaluated in float in the C++ source.
                cutoff = f64::from(700.0f32 + velocity * 1700.0f32);
                amplitude = 0.32;
            }
            SynthKind::Pad => {
                cutoff = 2600.0;
                amplitude = 0.25;
            }
            SynthKind::Pluck => {
                cutoff = 4800.0;
                amplitude = 0.35;
            }
            SynthKind::Rhodes => {
                cutoff = 9000.0;
                amplitude = 0.28 + 0.1 * f64::from(velocity.min(1.0));
                voice.end_frames = voice.note_frames + ((synth.release * 1.5 + 0.02) * sr) as i64;
            }
            SynthKind::Drums => {
                let tune = math::pow(2.0, synth.tune / 12.0);
                let mut decay = 0.23;
                if pitch == 35 || pitch == 36 {
                    decay = 0.32;
                    amplitude = 0.8;
                    voice.drum_start = (47.0 + 98.0 * synth.punch) * tune;
                    voice.drum_end = 47.0 * tune;
                    voice.drum_sweep = 0.12;
                } else if pitch == 38 || pitch == 40 || pitch == 39 {
                    decay = if pitch == 39 { 0.12 } else { 0.18 };
                    amplitude = 0.32;
                    voice.frequency = 185.0 * tune;
                    voice.noise_filter.configure(
                        FilterType::Highpass,
                        sr,
                        900.0 * math::pow(2.0, synth.tone * 1.5),
                        1.0,
                        0.0,
                    );
                } else if matches!(pitch, 42 | 44 | 46 | 49 | 51) {
                    decay = if pitch == 46 {
                        0.32
                    } else if pitch == 49 || pitch == 51 {
                        0.62
                    } else {
                        0.065
                    };
                    amplitude = if pitch == 42 || pitch == 44 { 0.18 } else { 0.16 };
                    voice.noise_filter.configure(
                        FilterType::Highpass,
                        sr,
                        6500.0 * math::pow(2.0, synth.tone * 1.5),
                        1.0,
                        0.0,
                    );
                } else {
                    amplitude = 0.5;
                    voice.drum_end =
                        440.0 * math::pow(2.0, f64::from(pitch.clamp(24, 84) - 69) / 12.0) * tune;
                    voice.drum_start = voice.drum_end * 1.8;
                    voice.drum_sweep = 0.1;
                }
                voice.drum_decay = std_max(0.008 * sr, std_min(decay * synth.decay * sr, available as f64));
                voice.end_frames = (voice.drum_decay + 0.004 * sr) as i64;
            }
            SynthKind::Keys | SynthKind::Sampled => {}
        }
        voice.peak = amplitude * f64::from(velocity) * synth.level;
        voice.tone.configure(FilterType::Lowpass, sr, cutoff * tone_factor, 0.7, 0.0);
    }

    /// engine.cpp `spawnRelease`: the release-noise sample of `source` (once, at its note-off).
    /// Returns the voice slot it started, if any.
    fn spawn_release<B: SampleBank>(
        &mut self,
        sr: f64,
        bank: &B,
        source: usize,
        overflows: &mut u64,
    ) -> Option<usize> {
        let v = self.voices.get_mut(source)?;
        if v.release_zone == NONE || v.release_spawned {
            return None;
        }
        v.release_spawned = true;
        let noise = release_noise_gain(
            f64::from(v.velocity),
            v.note_frames as f64 / sr,
            v.natural_frames / sr,
            v.synth.release_noise,
            v.cut,
        );
        if noise <= 0.0 {
            return None;
        }
        let (zone, pitch, synth) = (v.release_zone, v.pitch, v.synth);
        let (Some(z), Some(pcm)) = (bank.releases().get(zone as usize), bank.pcm(true, zone as usize)) else {
            return None;
        };
        let slot = self.available(overflows);
        let r = self.voices.get_mut(slot)?;
        *r = Voice::default();
        r.synth = synth;
        r.active = true;
        r.sampled = true;
        r.release_sample = true;
        r.zone = zone;
        r.zone_release = true;
        r.pitch = pitch;
        let asset_rate = f64::from(pcm.sample_rate);
        r.sample_position = bank.start_offset() * asset_rate;
        r.sample_step = math::pow(2.0, f64::from(pitch - z.root) / 12.0 + z.tune / 1200.0) * asset_rate / sr;
        r.peak = db_to_gain(bank.gain_db() + z.gain_db - 6.0) * noise * synth.level;
        r.end_frames = std_max(0.0, (pcm.frames() as f64 - r.sample_position) / r.sample_step) as i64;
        Some(slot)
    }

    /// engine.cpp `retriggerSustained` (voice half): re-striking a key that only rings because of the
    /// pedal ends that sustained note first.
    pub fn retrigger_sustained(&mut self, ctx: &VoiceContext<'_>, pitch: i32) {
        for i in 0..MAX_VOICES {
            let Some(v) = self.voices.get_mut(i) else { continue };
            if v.active && v.live && v.sustained && v.pitch == pitch {
                v.sustained = false;
                Self::release_voice(v, ctx);
            }
        }
    }

    /// engine.cpp `releaseLive`.
    fn release_voice(v: &mut Voice, ctx: &VoiceContext<'_>) {
        if !ctx.kit && !v.forced_release {
            v.release_gain = envelope(v, ctx.sample_rate, ctx.kit);
            v.forced_release = true;
        }
        v.note_frames = v.note_frames.min(v.age);
        if v.sampled && (v.age as f64) >= v.natural_frames {
            v.release_zone = NONE;
        }
        if !ctx.kit {
            v.end_frames =
                v.end_frames.min(v.age + ((v.synth.release * 1.5 + 0.02) * ctx.sample_rate) as i64);
        }
    }

    /// Releases the timeline voice of note `id` (a note removed or edited during playback).
    pub fn release_note(&mut self, ctx: &VoiceContext<'_>, id: i32) {
        for v in &mut self.voices {
            if v.active && !v.live && v.id == id {
                Self::release_voice(v, ctx);
            }
        }
    }

    /// The built-in half of engine.cpp `noteOff` for live notes (`id` >= 0 matches the id, else
    /// the pitch). While the live pedal is down (and not `force`) the voices are marked sustained.
    pub fn live_note_off(&mut self, ctx: &VoiceContext<'_>, pitch: i32, id: i32, force: bool) {
        let matches = |v: &Voice| v.active && v.live && if id >= 0 { v.id == id } else { v.pitch == pitch };
        if self.live_pedal && !force && !ctx.kit {
            for v in &mut self.voices {
                if matches(v) {
                    v.sustained = true;
                }
            }
            return;
        }
        for v in &mut self.voices {
            if matches(v) {
                v.sustained = false;
                Self::release_voice(v, ctx);
            }
        }
    }

    /// engine.cpp `releaseSustained` (voice half): the pedal lifted.
    pub fn release_sustained(&mut self, ctx: &VoiceContext<'_>) {
        for v in &mut self.voices {
            if v.active && v.live && v.sustained {
                v.sustained = false;
                Self::release_voice(v, ctx);
            }
        }
    }

    /// Live controller to built-in voices (engine.cpp `controlChange`, no instrument).
    pub fn control_change(&mut self, ctx: &VoiceContext<'_>, number: i32, value: i32) {
        if number != controller::SUSTAIN {
            self.apply_controller(number, value);
            return;
        }
        let down = value >= 64;
        if down == self.live_pedal {
            return;
        }
        self.live_pedal = down;
        if !down {
            self.release_sustained(ctx);
        }
    }

    /// Live panic (engine.cpp `allNotesOff`, built-in voices): lifts the pedal, releases every live
    /// note and returns bend / modulation / pressure to rest.
    pub fn all_notes_off(&mut self, ctx: &VoiceContext<'_>) {
        self.live_pedal = false;
        self.clear_sustained();
        for i in 0..MAX_VOICES {
            let Some(v) = self.voices.get(i) else { continue };
            if v.active && v.live {
                let (pitch, id) = (v.pitch, v.id);
                self.live_note_off(ctx, pitch, id, true);
            }
        }
        self.controllers.bend = 0;
        self.controllers.modulation = 0;
        self.controllers.pressure = 0;
    }

    /// engine.cpp `voicesInto`: adds `out.len() / 2` frames of every voice into `out`.
    #[inline(never)]
    pub fn render<B: SampleBank>(
        &mut self,
        out: &mut [f32],
        ctx: &VoiceContext<'_>,
        bank: &B,
        overflows: &mut u64,
    ) {
        let sr = ctx.sample_rate;
        let smoothing = 1.0 - math::exp(-1.0 / (sr * CONTROLLER_SMOOTHING_SECONDS));
        let (bend_goal, vibrato_goal, gain_goal) =
            (self.bend_target(), self.vibrato_target(), self.gain_target());
        let pitched = !ctx.kit;
        let glide = |value: &mut f64, goal: f64, snap: f64| {
            *value = math::mul_add(goal - *value, smoothing, *value);
            if (goal - *value).abs() < snap {
                *value = goal;
            }
        };
        let kit_bank = bank.is_kit();
        let start_offset = bank.start_offset();
        // Voices past the last active one contribute nothing: skipping them keeps the summation
        // order (and so the samples) of the C++ loop over every voice.
        let mut limit = self.voices.iter().rposition(|v| v.active).map_or(0, |i| i + 1);
        let releases = !bank.releases().is_empty();
        for frame in out.as_chunks_mut::<2>().0 {
            glide(&mut self.bend_cents, bend_goal, 1e-4);
            glide(&mut self.vibrato_cents, vibrato_goal, 1e-4);
            glide(&mut self.control_gain, gain_goal, 1e-7);
            let mut cents = self.bend_cents;
            if self.vibrato_cents > 0.0 {
                cents = math::mul_add(self.vibrato_cents, math::sin(2.0 * PI * self.vibrato_phase), cents);
            }
            self.vibrato_phase += VIBRATO_RATE / sr;
            if self.vibrato_phase >= 1.0 {
                self.vibrato_phase -= 1.0;
            }
            // Pitch bend and vibrato scale every pitched voice's frequency (samples: playback rate).
            let ratio = if pitched && cents != 0.0 { math::exp2(cents / 1200.0) } else { 1.0 };
            let level = self.control_gain;
            if releases {
                // A release voice started here has no release zone itself: scanning the voices
                // active before it is the C++ scan over every voice.
                let scan = limit;
                for i in 0..scan {
                    if self.voices.get(i).is_some_and(|v| {
                        v.active && v.release_zone != NONE && !v.release_spawned && v.age >= v.note_frames
                    }) && let Some(slot) = self.spawn_release(sr, bank, i, overflows)
                    {
                        limit = limit.max(slot + 1);
                    }
                }
            }
            for v in self.voices.iter_mut().take(limit) {
                if !v.active {
                    continue;
                }
                if v.age >= v.end_frames {
                    v.active = false;
                    continue;
                }
                let synth = v.synth;
                let frequency = v.frequency * ratio;
                let (l, r);
                if v.sampled {
                    let Some(pcm) = bank.pcm(v.zone_release, v.zone as usize) else {
                        v.active = false;
                        continue;
                    };
                    let zone =
                        if v.zone_release { bank.releases() } else { bank.zones() }.get(v.zone as usize);
                    if let Some([a, b]) = zone.and_then(|z| z.looped)
                        && !kit_bank
                        && !v.release_sample
                    {
                        let rate = f64::from(pcm.sample_rate);
                        let start = (a + start_offset) * rate;
                        let end = (b + start_offset) * rate;
                        if v.sample_position >= end {
                            v.sample_position = start + (v.sample_position - start) % (end - start);
                        }
                    }
                    if v.sample_position >= pcm.frames() as f64 {
                        v.active = false;
                        continue;
                    }
                    let mut x = f64::from(pcm.sample(v.sample_position, 0));
                    let mut y = f64::from(pcm.sample(v.sample_position, 1));
                    v.sample_position = math::mul_add(v.sample_step, ratio, v.sample_position);
                    if !v.release_sample {
                        x = f64::from(v.tone.sample(x as f32, 0));
                        y = f64::from(v.tone.sample(y as f32, 1));
                    }
                    l = x;
                    r = y;
                } else {
                    let t = v.age as f64 / sr;
                    let mut x;
                    let [p0, p1, p2, _] = &mut v.phases;
                    match synth.kind {
                        SynthKind::Drums => {
                            if v.drum_sweep > 0.0 {
                                let f = v.drum_start
                                    * math::pow(v.drum_end / v.drum_start, std_min(1.0, t / v.drum_sweep));
                                x = oscillator(p0, f, sr, 0);
                            } else {
                                v.noise = v.noise.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                                x = f64::from(
                                    v.noise_filter
                                        .sample((f64::from(v.noise) / 4_294_967_295.0 * 2.0 - 1.0) as f32, 0),
                                );
                                if v.pitch == 38 || v.pitch == 40 || v.pitch == 39 {
                                    x += 0.25 * oscillator(p0, frequency, sr, 2);
                                }
                            }
                        }
                        SynthKind::Bass => {
                            x = 0.45 * oscillator(p0, frequency, sr, 1)
                                + synth.sub * oscillator(p1, frequency, sr, 0);
                        }
                        SynthKind::Pad => {
                            x = 0.27
                                * oscillator(p0, frequency * math::pow(2.0, -synth.detune / 1200.0), sr, 1)
                                + 0.27
                                    * oscillator(
                                        p1,
                                        frequency * math::pow(2.0, synth.detune / 1200.0),
                                        sr,
                                        1,
                                    )
                                + 0.2 * oscillator(p2, frequency * 2.0, sr, 2);
                        }
                        SynthKind::Pluck => {
                            let sweep = std_max(0.03, std_min(v.note_frames as f64 / sr, synth.sweep));
                            if (v.age & 15) == 0 {
                                v.tone.configure(
                                    FilterType::Lowpass,
                                    sr,
                                    4800.0
                                        * math::pow(900.0 / 4800.0, std_min(1.0, t / sweep))
                                        * math::pow(2.0, synth.tone * 2.0),
                                    0.7,
                                    0.0,
                                );
                            }
                            x = 0.85 * oscillator(p0, frequency, sr, 2)
                                + 0.2 * oscillator(p1, frequency * 2.0, sr, 0);
                        }
                        SynthKind::Rhodes => {
                            let hit = f64::from(v.velocity.min(1.0));
                            let index = (0.3 + 2.4 * synth.bark)
                                * (0.35 + 0.65 * hit)
                                * math::pow(2.0, synth.tone * 1.2);
                            let depth = frequency
                                * index
                                * if t < 0.012 { 1.0 } else { 0.1 + 0.9 * math::exp(-(t - 0.012) / 0.13) };
                            let modulation = oscillator(p1, frequency, sr, 0) * depth;
                            // Frequency modulation can cross zero; reversing phase is part of the tine's
                            // original 1:1 FM sound, not a frequency clamp at zero.
                            x = 0.75 * math::sin(2.0 * PI * *p0);
                            *p0 += crate::std_clamp((frequency + modulation) / sr, -0.45, 0.45);
                            *p0 -= math::floor(*p0);
                            x += 0.12
                                * hit
                                * (0.3 + synth.bark)
                                * if t < 0.006 { 1.0 } else { math::exp(-(t - 0.006) / 0.03) }
                                * oscillator(p2, frequency * 7.0, sr, 0);
                            x = math::tanh(1.2 * x + 0.25 * x * x) / math::tanh(1.45);
                        }
                        SynthKind::Keys | SynthKind::Sampled => {
                            x = 0.8 * oscillator(p0, frequency, sr, 0)
                                + synth.bell * oscillator(p1, frequency * 2.0, sr, 2)
                                + synth.bell * 0.4 * oscillator(p2, frequency * 3.0, sr, 0);
                        }
                    }
                    if synth.kind != SynthKind::Drums {
                        x = f64::from(v.tone.sample(x as f32, 0));
                    }
                    l = x;
                    r = x;
                }
                let mut gain = envelope(v, sr, kit_bank);
                if v.choking {
                    v.choke_gain *= math::exp(-1.0 / (0.003 * sr));
                    gain *= v.choke_gain;
                    if v.choke_gain < 0.006 {
                        v.active = false;
                    }
                }
                if level != 1.0 {
                    gain *= level;
                }
                let [ol, or] = frame;
                *ol += (l * gain) as f32;
                *or += (r * gain) as f32;
                v.age += 1;
            }
        }
    }
}

/// engine.cpp `TrackRuntime::envelope`. `kit`: the sample set is a kit (sampled voices).
fn envelope(v: &Voice, sr: f64, kit: bool) -> f64 {
    let synth = &v.synth;
    let t = v.age as f64 / sr;
    let duration = v.note_frames as f64 / sr;
    if v.release_sample {
        return v.peak;
    }
    if v.forced_release {
        if v.sampled || synth.kind == SynthKind::Rhodes {
            return v.release_gain * math::exp(-(t - duration) / (synth.release / 4.0));
        }
        if t >= duration + synth.release || v.release_gain <= 0.0 {
            return 0.0;
        }
        return v.release_gain
            * math::pow(EPSILON / std_max(EPSILON, v.release_gain), (t - duration) / synth.release);
    }
    if v.sampled {
        if kit {
            if synth.decay >= 1.0 {
                return v.peak;
            }
            let end = v.drum_decay / sr;
            if t >= end {
                return 0.0;
            }
            return v.peak * math::pow(EPSILON / std_max(EPSILON, v.peak), t / end);
        }
        let attack = std_min(synth.attack, duration);
        if t < attack {
            return v.peak * t / std_max(1.0 / sr, attack);
        }
        return if t < duration {
            v.peak
        } else {
            v.peak * math::exp(-(t - duration) / (synth.release / 4.0))
        };
    }
    if synth.kind == SynthKind::Drums {
        let end = v.drum_decay / sr;
        let attack = std_min(0.002, end / 4.0);
        if t < attack {
            return v.peak * t / attack;
        }
        if t >= end {
            return 0.0;
        }
        return v.peak * math::pow(EPSILON / std_max(EPSILON, v.peak), (t - attack) / (end - attack));
    }
    if synth.kind == SynthKind::Rhodes {
        let attack = std_min(synth.attack, duration);
        let decay = synth.decay * math::pow(2.0, f64::from(-(v.pitch - 60)) / 24.0);
        let sustain = std_max(EPSILON, synth.sustain * v.peak);
        let before_off = |at: f64| {
            if at < attack {
                return v.peak * at / std_max(attack, 1.0 / sr);
            }
            let a = at - attack;
            if a < decay * 0.25 {
                return v.peak * 0.45 + v.peak * 0.55 * math::exp(-a / (decay * 0.1));
            }
            let initial = v.peak * 0.45 + v.peak * 0.55 * math::exp(-2.5);
            sustain + (initial - sustain) * math::exp(-(a - decay * 0.25) / (decay / 3.0))
        };
        return if t < duration {
            before_off(t)
        } else {
            before_off(duration) * math::exp(-(t - duration) / (synth.release / 4.0))
        };
    }
    let attack = std_min(synth.attack, duration * 0.3);
    let decay_end = std_min(attack + synth.decay, duration * 0.85);
    let sustain = std_max(EPSILON, v.peak * synth.sustain);
    if t < attack {
        return v.peak * t / std_max(attack, 1.0 / sr);
    }
    if t < decay_end && decay_end > attack {
        return v.peak * math::pow(sustain / std_max(EPSILON, v.peak), (t - attack) / (decay_end - attack));
    }
    if t < duration {
        return sustain;
    }
    if t >= duration + synth.release {
        return 0.0;
    }
    sustain * math::pow(EPSILON / sustain, (t - duration) / synth.release)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::vec;

    #[test]
    fn zones_pick_layers_and_nearest() {
        let z = |root, lo, hi, vlo, vhi| Zone {
            root,
            lo,
            hi,
            vlo,
            vhi,
            gain_db: 0.0,
            tune: 0.0,
            looped: None,
            choke: -1,
        };
        let zones = [z(36, 36, 36, 0.0, 0.5), z(36, 36, 36, 0.5, 1.0), z(60, 50, 70, 0.0, 1.0)];
        assert_eq!(pick_zone(&zones, true, 36, 0.25), Some(0));
        assert_eq!(pick_zone(&zones, true, 36, 0.75), Some(1));
        assert_eq!(pick_zone(&zones, true, 36, 1.0), Some(1));
        assert_eq!(pick_zone(&zones, true, 37, 0.5), None);
        assert_eq!(pick_zone(&zones, false, 55, 0.5), Some(2));
        assert_eq!(release_noise_gain(1.0, 0.0, 5.0, 1.0, false), 1.0);
        assert_eq!(release_noise_gain(1.0, 0.5, 5.0, 1.0, true), 0.0);
    }

    #[test]
    fn synth_voices_sound_and_end() {
        for kind in [SynthKind::Keys, SynthKind::Bass, SynthKind::Pad, SynthKind::Pluck, SynthKind::Rhodes] {
            let synth = Synth { kind, ..Synth::default() };
            let ctx = VoiceContext { sample_rate: 48_000.0, kit: false, synth: &synth };
            let mut voices = Voices::new();
            let mut overflows = 0;
            voices.spawn(&ctx, &NoSamples, false, 60, 0.8, 4800, 48_000, 1, false, &mut overflows);
            let mut out = vec![0.0f32; 48_000 * 2];
            voices.render(&mut out, &ctx, &NoSamples, &mut overflows);
            assert!(out.iter().take(9600).any(|x| x.abs() > 1e-3), "{kind:?} silent");
            assert_eq!(voices.active(), 0, "{kind:?} voice never ended");
        }
    }
}

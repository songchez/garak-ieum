//! 한밤 106: a one-oscillator-per-voice polysynth in the spirit of the early-80s Korean-night
//! studio classics.
//!
//! Per voice: one stable oscillator (band-limited saw, pulse with manual / LFO / envelope width
//! modulation, a square sub one octave down, white noise), a resonant 4-pole ladder low-pass
//! (zero-delay-feedback form with a saturating input), an ADSR shared by the filter and the
//! amplifier (or a gate for the amplifier), velocity, a delayed LFO for vibrato / PWM / filter, and
//! portamento from the last played note. Up to 8 voices with stealing that retriggers the envelope
//! from its current level (no clicks); 1 voice is legato mono with last-note priority.
//!
//! After the voices: a four-position high-pass (bass boost / flat / two cuts) and the two-tap
//! bucket-brigade-style stereo chorus (I, II and I+II), output level × CC7 × CC11.

use super::dmath::{self, Noise, clampf};
use super::{Controls, InstrumentEvent, ParamDef, cc, event};

const fn d(id: &'static str, default: f64, min: f64, max: f64) -> ParamDef {
    ParamDef { id, default, min, max }
}

/// Catalog (ids persist in projects; append only). src/devices/vintage/params.ts mirrors it.
pub const PARAMS: &[ParamDef] = &[
    d("range", 1.0, 0.0, 2.0),
    d("saw", 1.0, 0.0, 1.0),
    d("pulse", 0.0, 0.0, 1.0),
    d("pwm", 0.35, 0.0, 1.0),
    d("pwmSource", 1.0, 0.0, 2.0),
    d("sub", 0.3, 0.0, 1.0),
    d("noise", 0.0, 0.0, 1.0),
    d("hpf", 1.0, 0.0, 3.0),
    d("cutoff", 2400.0, 20.0, 18_000.0),
    d("resonance", 0.15, 0.0, 1.0),
    d("envAmount", 0.35, -1.0, 1.0),
    d("lfoFilter", 0.0, 0.0, 1.0),
    d("keyTrack", 0.5, 0.0, 1.0),
    d("velocity", 0.3, 0.0, 1.0),
    d("attack", 0.005, 0.001, 3.0),
    d("decay", 0.6, 0.002, 10.0),
    d("sustain", 0.6, 0.0, 1.0),
    d("release", 0.35, 0.002, 10.0),
    d("vcaMode", 0.0, 0.0, 1.0),
    d("lfoRate", 4.0, 0.05, 20.0),
    d("lfoDelay", 0.0, 0.0, 3.0),
    d("vibrato", 0.0, 0.0, 1.0),
    d("glide", 0.0, 0.0, 2.0),
    d("voices", 6.0, 1.0, 8.0),
    d("chorus", 1.0, 0.0, 3.0),
    d("drift", 0.15, 0.0, 1.0),
    d("level", 1.0, 0.0, 2.0),
];

const RANGE: usize = 0;
const SAW: usize = 1;
const PULSE: usize = 2;
const PWM: usize = 3;
const PWM_SOURCE: usize = 4;
const SUB: usize = 5;
const NOISE: usize = 6;
const HPF: usize = 7;
const CUTOFF: usize = 8;
const RESONANCE: usize = 9;
const ENV_AMOUNT: usize = 10;
const LFO_FILTER: usize = 11;
const KEY_TRACK: usize = 12;
const VELOCITY: usize = 13;
const ATTACK: usize = 14;
const DECAY: usize = 15;
const SUSTAIN: usize = 16;
const RELEASE: usize = 17;
const VCA_MODE: usize = 18;
const LFO_RATE: usize = 19;
const LFO_DELAY: usize = 20;
const VIBRATO: usize = 21;
const GLIDE: usize = 22;
const VOICE_COUNT: usize = 23;
const CHORUS: usize = 24;
const DRIFT: usize = 25;
const LEVEL: usize = 26;

pub const VOICES: usize = 8;
/// Control-rate interval (pitch, cutoff, LFO), frames.
const CONTROL: usize = 4;
const STACK: usize = 16;
/// Chorus delay line (power of two; 5.4 ms at 192 kHz fits with room to spare).
const LINE: usize = 2048;
const MASK: usize = LINE - 1;
/// Fixed per-voice component spread scaled by `drift` (cents, filter).
const SPREAD: [f64; VOICES] = [0.31, -0.72, 0.55, -0.18, 0.86, -0.47, 0.12, -0.93];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Stage {
    #[default]
    Idle,
    Attack,
    Decay,
    Release,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Voice {
    active: bool,
    held: bool,
    sustained: bool,
    id: i32,
    pitch: u8,
    order: u64,
    released_at: u64,
    velocity: f64,
    /// Current (gliding) and target note.
    note: f64,
    target: f64,
    phase: f64,
    sub_phase: f64,
    dt: f64,
    stage: Stage,
    env: f64,
    gate: f64,
    lfo_fade: f64,
    s: [f64; 4],
    g: f64,
    k: f64,
    width: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Coefficients {
    attack: f64,
    decay: f64,
    release: f64,
    gate_on: f64,
    gate_off: f64,
    glide: f64,
    lfo_fade: f64,
}

#[derive(Clone, Debug)]
pub struct Poly {
    rate: f64,
    p: [f64; PARAMS.len()],
    voices: [Voice; VOICES],
    order: u64,
    controls: Controls,
    /// One generator per voice: the stream a voice draws does not depend on block splits.
    noise: [Noise; VOICES],
    co: Coefficients,
    stack: [u8; STACK],
    stack_len: usize,
    last_note: Option<f64>,
    next_voice: usize,
    lfo_phase: f64,
    lfo: f64,
    bend: f64,
    // Smoothed controls.
    cutoff_log: f64,
    resonance: f64,
    mix: [f64; 4],
    level: f64,
    smooth: f64,
    // High-pass.
    hp_lp: f64,
    // Chorus.
    line: [f32; LINE],
    write: usize,
    chorus_phase: f64,
    chorus_rate: f64,
    chorus_center: f64,
    chorus_depth: f64,
    chorus_wet: f64,
    wet_lp: [f64; 2],
    until_control: usize,
}

/// PolyBLEP residual for a unit step at phase 0 (t in [0, 1), dt the phase increment).
#[inline(always)]
fn blep(t: f64, dt: f64) -> f64 {
    if t < dt {
        let x = t / dt;
        x + x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + x + x + 1.0
    } else {
        0.0
    }
}

/// Band-limited pulse (+1 for t < w), DC removed.
#[inline(always)]
fn pulse(t: f64, dt: f64, w: f64) -> f64 {
    let naive = if t < w { 1.0 } else { -1.0 };
    let mut u = t + 1.0 - w;
    if u >= 1.0 {
        u -= 1.0;
    }
    naive + blep(t, dt) - blep(u, dt) - (2.0 * w - 1.0)
}

fn chorus_setting(mode: f64) -> (f64, f64, f64, f64) {
    // (rate Hz, centre ms, depth ms, wet): I, II and I+II of the two-tap stereo chorus.
    match mode as i32 {
        1 => (0.513, 3.505, 1.845, 1.0),
        2 => (0.863, 3.505, 1.845, 1.0),
        3 => (9.75, 3.505, 0.28, 1.0),
        _ => (0.513, 3.505, 1.845, 0.0),
    }
}

impl Poly {
    pub fn new(rate: f64, params: &[f64]) -> Self {
        let mut p = [0.0; PARAMS.len()];
        for (i, (slot, def)) in p.iter_mut().zip(PARAMS).enumerate() {
            *slot = params.get(i).copied().unwrap_or(def.default);
        }
        let (chorus_rate, chorus_center, chorus_depth, chorus_wet) = chorus_setting(p[CHORUS]);
        let mut poly = Self {
            rate,
            p,
            voices: [Voice::default(); VOICES],
            order: 0,
            controls: Controls::new(),
            noise: core::array::from_fn(|i| Noise(0x2545_f491 ^ (i as u32).wrapping_mul(0x9e37_79b9))),
            co: Coefficients {
                attack: 0.0,
                decay: 0.0,
                release: 0.0,
                gate_on: 0.0,
                gate_off: 0.0,
                glide: 1.0,
                lfo_fade: 1.0,
            },
            stack: [0; STACK],
            stack_len: 0,
            last_note: None,
            next_voice: 0,
            lfo_phase: 0.0,
            lfo: 0.0,
            bend: 0.0,
            cutoff_log: dmath::log2(p[CUTOFF]),
            resonance: p[RESONANCE],
            mix: [p[SAW], p[PULSE], p[SUB], p[NOISE]],
            level: p[LEVEL],
            smooth: dmath::one_pole(0.01, rate / CONTROL as f64),
            hp_lp: 0.0,
            line: [0.0; LINE],
            write: 0,
            chorus_phase: 0.0,
            chorus_rate,
            chorus_center,
            chorus_depth,
            chorus_wet,
            wet_lp: [0.0; 2],
            until_control: 0,
        };
        poly.update_coefficients();
        poly
    }

    #[inline(never)]
    fn update_coefficients(&mut self) {
        let fs = self.rate;
        let control = fs / CONTROL as f64;
        self.co = Coefficients {
            // Attack aims at 1.25 and stops at 1 (reached after `attack` seconds).
            attack: dmath::one_pole(self.p[ATTACK] / 1.609_437_912_434_100_3, fs),
            decay: dmath::one_pole(self.p[DECAY] / 5.0, fs),
            release: dmath::one_pole(self.p[RELEASE] / 5.0, fs),
            gate_on: dmath::one_pole(0.0008, fs),
            gate_off: dmath::one_pole(0.0015, fs),
            glide: if self.p[GLIDE] <= 1.0e-4 { 1.0 } else { dmath::one_pole(self.p[GLIDE] / 3.0, control) },
            lfo_fade: if self.p[LFO_DELAY] <= 1.0e-4 { 1.0 } else { 1.0 / (self.p[LFO_DELAY] * control) },
        };
    }

    fn voice_count(&self) -> usize {
        ((self.p[VOICE_COUNT] + 0.5) as usize).clamp(1, VOICES)
    }

    pub fn set_param(&mut self, index: usize, value: f64) {
        let value = match index {
            RANGE | PWM_SOURCE | HPF | VCA_MODE | VOICE_COUNT | CHORUS => dmath::floor(value + 0.5),
            _ => value,
        };
        if let Some(slot) = self.p.get_mut(index) {
            *slot = value;
        }
        match index {
            ATTACK | DECAY | RELEASE | GLIDE | LFO_DELAY => self.update_coefficients(),
            VOICE_COUNT => {
                let n = self.voice_count();
                let order = self.order;
                for v in self.voices.iter_mut().skip(n).filter(|v| v.active) {
                    v.held = false;
                    v.sustained = false;
                    if v.stage != Stage::Release {
                        v.stage = Stage::Release;
                        v.released_at = order;
                    }
                }
                if n == 1 {
                    self.stack_len = 0;
                }
            }
            _ => {}
        }
    }

    #[inline(never)]
    pub fn reset(&mut self) {
        self.voices = [Voice::default(); VOICES];
        self.controls = Controls::new();
        self.stack_len = 0;
        self.last_note = None;
        self.bend = 0.0;
        self.lfo_phase = 0.0;
        self.hp_lp = 0.0;
        self.line = [0.0; LINE];
        self.wet_lp = [0.0; 2];
        self.chorus_phase = 0.0;
        self.until_control = 0;
        self.cutoff_log = dmath::log2(self.p[CUTOFF]);
        self.resonance = self.p[RESONANCE];
        self.mix = [self.p[SAW], self.p[PULSE], self.p[SUB], self.p[NOISE]];
        self.level = self.p[LEVEL];
        let (r, c, d, w) = chorus_setting(self.p[CHORUS]);
        (self.chorus_rate, self.chorus_center, self.chorus_depth, self.chorus_wet) = (r, c, d, w);
    }

    pub fn active_voices(&self) -> usize {
        self.voices.iter().filter(|v| v.active).count()
    }

    pub fn tail_seconds(&self) -> f64 {
        let vca = if self.p[VCA_MODE] >= 0.5 { 0.02 } else { self.p[RELEASE] * 2.0 };
        (vca + 0.02).min(30.0)
    }

    #[inline(never)]
    pub fn handle(&mut self, e: &InstrumentEvent) {
        match e.kind {
            event::NOTE_ON => {
                let pitch = e.pitch.min(127) as u8;
                if e.value > 0.0 {
                    self.note_on(pitch, f64::from(e.value).min(1.0), e.id);
                } else {
                    self.note_off(pitch, e.id);
                }
            }
            event::NOTE_OFF => self.note_off(e.pitch.min(127) as u8, e.id),
            event::ALL_NOTES_OFF => self.all_notes_off(),
            event::CONTROLLER => {
                if e.param == cc::ALL_SOUND_OFF {
                    self.voices = [Voice::default(); VOICES];
                    self.stack_len = 0;
                } else if e.param == cc::ALL_NOTES_OFF {
                    self.all_notes_off();
                } else if let Some(down) = self.controls.apply(e.param, f64::from(e.value))
                    && !down
                {
                    let order = self.order;
                    for v in self.voices.iter_mut().filter(|v| v.sustained) {
                        release(v, order);
                    }
                }
            }
            event::RESET => self.reset(),
            _ => {}
        }
    }

    #[inline(never)]
    fn all_notes_off(&mut self) {
        self.controls.sustain = false;
        self.stack_len = 0;
        let order = self.order;
        for v in self.voices.iter_mut().filter(|v| v.active) {
            release(v, order);
        }
    }

    #[inline(never)]
    fn pick_voice(&mut self) -> usize {
        let n = self.voice_count();
        if n == 1 {
            return 0;
        }
        // Round-robin over free voices lets release tails ring (as the hardware assigner does).
        for k in 0..n {
            let i = (self.next_voice + k) % n;
            if self.voices.get(i).is_some_and(|v| !v.active) {
                self.next_voice = (i + 1) % n;
                return i;
            }
        }
        let mut best: Option<(usize, u64)> = None;
        for (i, v) in self.voices.iter().enumerate().take(n) {
            if v.stage == Stage::Release && best.is_none_or(|(_, at)| v.released_at < at) {
                best = Some((i, v.released_at));
            }
        }
        if let Some((i, _)) = best {
            return i;
        }
        let mut oldest = (0, u64::MAX);
        for (i, v) in self.voices.iter().enumerate().take(n) {
            if v.order < oldest.1 {
                oldest = (i, v.order);
            }
        }
        oldest.0
    }

    #[inline(never)]
    fn note_on(&mut self, pitch: u8, velocity: f64, id: i32) {
        self.order += 1;
        let mono = self.voice_count() == 1;
        if mono {
            // Last-note priority: the stack remembers held keys for legato returns.
            if let Some(pos) = self.stack.iter().take(self.stack_len).position(|&p| p == pitch) {
                self.remove_stacked(pos);
            }
            if self.stack_len == STACK {
                self.remove_stacked(0);
            }
            if let Some(slot) = self.stack.get_mut(self.stack_len) {
                *slot = pitch;
                self.stack_len += 1;
            }
        }
        let i = self.pick_voice();
        let glide = self.co.glide < 1.0;
        let from = self.last_note;
        let order = self.order;
        let lfo_fade = if self.co.lfo_fade >= 1.0 { 1.0 } else { 0.0 };
        let Some(v) = self.voices.get_mut(i) else { return };
        let legato = mono && v.active && (v.held || v.sustained) && v.stage != Stage::Release;
        if !v.active {
            *v = Voice { phase: 0.0, sub_phase: 0.0, ..Voice::default() };
            v.note = f64::from(pitch);
        }
        v.active = true;
        v.held = true;
        v.sustained = false;
        v.id = id;
        v.pitch = pitch;
        v.order = order;
        v.target = f64::from(pitch);
        if glide {
            if let Some(from) = from
                && !legato
            {
                v.note = from;
            }
        } else {
            v.note = v.target;
        }
        if !legato {
            v.velocity = velocity;
            v.stage = Stage::Attack;
            v.lfo_fade = lfo_fade;
        }
        self.last_note = Some(f64::from(pitch));
    }

    #[inline(never)]
    fn remove_stacked(&mut self, pos: usize) {
        let len = self.stack_len;
        if pos >= len {
            return;
        }
        if let Some(tail) = self.stack.get_mut(pos..len) {
            tail.rotate_left(1);
        }
        self.stack_len -= 1;
    }

    #[inline(never)]
    fn note_off(&mut self, pitch: u8, id: i32) {
        if self.voice_count() == 1 {
            if let Some(pos) = self.stack.iter().take(self.stack_len).position(|&p| p == pitch) {
                self.remove_stacked(pos);
            }
            let top = self.stack_len.checked_sub(1).and_then(|i| self.stack.get(i).copied());
            let sustain = self.controls.sustain;
            let order = self.order;
            let glide = self.co.glide < 1.0;
            let Some(v) = self.voices.first_mut() else { return };
            if !(v.active && v.held && v.pitch == pitch) {
                return;
            }
            if let Some(next) = top {
                // Legato back to the newest key still held.
                v.pitch = next;
                v.target = f64::from(next);
                if !glide {
                    v.note = v.target;
                }
                self.last_note = Some(f64::from(next));
            } else if sustain {
                v.held = false;
                v.sustained = true;
            } else {
                release(v, order);
            }
            return;
        }
        let sustain = self.controls.sustain;
        let order = self.order;
        for v in self.voices.iter_mut() {
            let hit = v.active && v.held && if id >= 0 { v.id == id } else { v.pitch == pitch };
            if !hit {
                continue;
            }
            if sustain {
                v.held = false;
                v.sustained = true;
            } else {
                release(v, order);
            }
        }
    }

    /// Renders the voices and the effects into `left` / `right` (overwritten).
    pub fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        // Control ticks run on a persistent frame counter: block splits do not change the output.
        let n = left.len().min(right.len());
        let mut start = 0;
        let mut mono = [0.0f64; CONTROL];
        while start < n {
            if self.until_control == 0 {
                self.control();
                self.until_control = CONTROL;
            }
            let end = (start + self.until_control).min(n);
            let frames = end - start;
            mono.fill(0.0);
            self.render_voices(mono.get_mut(..frames).unwrap_or(&mut []));
            if let (Some(l), Some(r)) = (left.get_mut(start..end), right.get_mut(start..end)) {
                self.effects(&mono, l, r);
            }
            self.until_control -= frames;
            start = end;
        }
    }

    /// Retires silent voices and flushes tiny filter states (at control ticks).
    fn retire(&mut self) {
        let gate_mode = self.p[VCA_MODE] >= 0.5;
        for v in self.voices.iter_mut().filter(|v| v.active) {
            for s in v.s.iter_mut() {
                *s = dmath::flush(*s);
            }
            let vca = if gate_mode { v.gate } else { v.env };
            if v.stage == Stage::Release && vca < 1.0e-5 {
                *v = Voice::default();
            }
        }
        self.hp_lp = dmath::flush(self.hp_lp);
    }

    fn control(&mut self) {
        self.retire();
        let frames = CONTROL;
        let k = self.smooth;
        let p = &self.p;
        self.cutoff_log += (dmath::log2(p[CUTOFF]) - self.cutoff_log) * k;
        self.resonance += (p[RESONANCE] - self.resonance) * k;
        let targets = [p[SAW], p[PULSE], p[SUB], p[NOISE]];
        for (m, t) in self.mix.iter_mut().zip(targets) {
            *m += (t - *m) * k;
        }
        self.level += (p[LEVEL] - self.level) * k;
        let bend = self.bend + (self.controls.bend - self.bend) * 0.25;
        self.bend = if (bend - self.controls.bend).abs() < 1e-5 { self.controls.bend } else { bend };
        // Global triangle LFO.
        self.lfo_phase += p[LFO_RATE] * frames as f64 / self.rate;
        if self.lfo_phase >= 1.0 {
            self.lfo_phase -= dmath::floor(self.lfo_phase);
        }
        self.lfo = 4.0 * (self.lfo_phase - 0.5).abs() - 1.0;
        // Chorus mode glides (no zipper when switching I / II / I+II / off).
        let (rate, center, depth, wet) = chorus_setting(p[CHORUS]);
        self.chorus_rate = rate;
        self.chorus_center += (center - self.chorus_center) * k;
        self.chorus_depth += (depth - self.chorus_depth) * k;
        self.chorus_wet += (wet - self.chorus_wet) * k;
        if (self.chorus_wet - wet).abs() < 1e-6 {
            self.chorus_wet = wet;
        }

        let vib_depth = p[VIBRATO] * p[VIBRATO] * 1.5 + self.controls.modulation() * 0.6;
        let octave = (p[RANGE] - 1.0) * 12.0;
        let fs = self.rate;
        let nyquist = 0.45 * fs;
        let res_k = self.resonance * 4.05;
        let drift = p[DRIFT];
        let env_oct = p[ENV_AMOUNT] * 8.0;
        let lfo_oct = p[LFO_FILTER] * 3.0;
        let key = p[KEY_TRACK];
        let vel_sens = p[VELOCITY];
        let pwm = p[PWM];
        let pwm_source = p[PWM_SOURCE] as i32;
        let cutoff_log = self.cutoff_log;
        let co = self.co;
        let lfo = self.lfo;
        let bend = self.bend;
        for (v, spread) in self.voices.iter_mut().zip(SPREAD) {
            if !v.active {
                continue;
            }
            v.note += (v.target - v.note) * co.glide;
            if (v.note - v.target).abs() < 1e-6 {
                v.note = v.target;
            }
            if v.lfo_fade < 1.0 {
                v.lfo_fade = (v.lfo_fade + co.lfo_fade).min(1.0);
            }
            let vlfo = lfo * v.lfo_fade;
            let note = v.note + octave + bend + vlfo * vib_depth + drift * spread * 0.08;
            v.dt = (dmath::note_hz(note) / fs).min(0.45);
            let vel = 1.0 - vel_sens + vel_sens * v.velocity;
            let octaves = cutoff_log
                + env_oct * v.env * vel
                + lfo_oct * vlfo
                + key * (v.note + octave - 60.0) / 12.0
                + drift * spread * 0.12;
            let fc = clampf(dmath::exp2(octaves), 15.0, nyquist);
            let g = dmath::tan_pi(fc / fs);
            v.g = g / (1.0 + g);
            v.k = res_k;
            v.width = match pwm_source {
                0 => 0.5 - 0.45 * pwm,
                2 => 0.5 - 0.45 * pwm * v.env.min(1.0),
                _ => 0.5 - 0.45 * pwm * (0.5 + 0.5 * vlfo),
            };
        }
    }

    fn render_voices(&mut self, out: &mut [f64]) {
        let [saw_l, pulse_l, sub_l, noise_l] = self.mix;
        let sustain = self.p[SUSTAIN];
        let gate_mode = self.p[VCA_MODE] >= 0.5;
        let co = self.co;
        let order = self.order;
        let vel_sens = self.p[VELOCITY];
        for (v, noise) in self.voices.iter_mut().zip(self.noise.iter_mut()) {
            if !v.active {
                continue;
            }
            let g = v.g;
            let g2 = g * g;
            let g3 = g2 * g;
            let g4 = g2 * g2;
            let one_minus = 1.0 - g;
            let k = v.k;
            let comp = 1.0 + k * 0.35;
            let amp_vel = 1.0 - vel_sens * 0.6 + vel_sens * 0.6 * v.velocity;
            let dt = v.dt;
            let half = dt * 0.5;
            for o in out.iter_mut() {
                // Oscillator.
                let t = v.phase;
                let mut x = 0.0;
                if saw_l > 1.0e-4 {
                    x += (2.0 * t - 1.0 - blep(t, dt)) * saw_l;
                }
                if pulse_l > 1.0e-4 {
                    x += pulse(t, dt, v.width) * pulse_l;
                }
                if sub_l > 1.0e-4 {
                    x += pulse(v.sub_phase, half, 0.5) * sub_l;
                }
                if noise_l > 1.0e-4 {
                    x += noise.sample() * noise_l;
                }
                v.phase += dt;
                if v.phase >= 1.0 {
                    v.phase -= 1.0;
                }
                v.sub_phase += half;
                if v.sub_phase >= 1.0 {
                    v.sub_phase -= 1.0;
                }
                // Ladder: solve the feedback loop, saturate the input, run four TPT one-poles.
                let sigma = g3 * one_minus * v.s[0]
                    + g2 * one_minus * v.s[1]
                    + g * one_minus * v.s[2]
                    + one_minus * v.s[3];
                let u = dmath::tanh((x * 0.7 - k * sigma) / (1.0 + k * g4));
                let mut y = u;
                for s in v.s.iter_mut() {
                    let w = (y - *s) * g;
                    y = w + *s;
                    *s = y + w;
                }
                // Envelopes.
                match v.stage {
                    Stage::Attack => {
                        v.env += (1.25 - v.env) * co.attack;
                        if v.env >= 1.0 {
                            v.env = 1.0;
                            v.stage = Stage::Decay;
                        }
                    }
                    Stage::Decay => v.env += (sustain - v.env) * co.decay,
                    Stage::Release => v.env -= v.env * co.release,
                    Stage::Idle => {}
                }
                let gate_target = if v.stage == Stage::Release { 0.0 } else { 1.0 };
                v.gate +=
                    (gate_target - v.gate) * if gate_target > v.gate { co.gate_on } else { co.gate_off };
                let vca = if gate_mode { v.gate } else { v.env };
                *o += y * comp * vca * amp_vel * 0.32;
            }
            if v.stage == Stage::Idle {
                release(v, order);
            }
        }
    }

    fn effects(&mut self, mono: &[f64; CONTROL], left: &mut [f32], right: &mut [f32]) {
        let fs = self.rate;
        let hpf = self.p[HPF] as i32;
        let (hp_hz, boost) = match hpf {
            0 => (110.0, 0.8),
            2 => (240.0, 0.0),
            3 => (720.0, 0.0),
            _ => (0.0, 0.0),
        };
        let hp_k =
            if hp_hz > 0.0 { dmath::one_pole(1.0 / (core::f64::consts::TAU * hp_hz), fs) } else { 0.0 };
        let wet = self.chorus_wet;
        let ms = fs / 1000.0;
        let center = self.chorus_center * ms;
        let depth = self.chorus_depth * ms;
        let step = self.chorus_rate / fs;
        let wet_k = dmath::one_pole(1.0 / (core::f64::consts::TAU * 7_500.0), fs);
        let gain_target = self.controls.gain_target();
        let gain_k = 1.0 / (0.005 * fs).max(1.0);
        let level = self.level * 0.9;
        for ((x, l), r) in mono.iter().zip(left.iter_mut()).zip(right.iter_mut()) {
            let mut x = *x;
            if hp_k > 0.0 {
                self.hp_lp += (x - self.hp_lp) * hp_k;
                x = if hpf == 0 { x + self.hp_lp * boost } else { x - self.hp_lp };
            }
            let (mut yl, mut yr) = (x, x);
            if wet > 0.0 {
                if let Some(slot) = self.line.get_mut(self.write & MASK) {
                    *slot = x as f32;
                }
                self.chorus_phase += step;
                if self.chorus_phase >= 1.0 {
                    self.chorus_phase -= 1.0;
                }
                let tri = 4.0 * (self.chorus_phase - 0.5).abs() - 1.0;
                let taps = [center + depth * tri, center - depth * tri];
                let mut outs = [0.0f64; 2];
                for ((o, d), lp) in outs.iter_mut().zip(taps).zip(self.wet_lp.iter_mut()) {
                    let pos = self.write as f64 + LINE as f64 - d;
                    let i = dmath::floor(pos);
                    let frac = pos - i;
                    let i = i as usize;
                    let a = f64::from(self.line.get(i & MASK).copied().unwrap_or(0.0));
                    let b = f64::from(self.line.get((i + 1) & MASK).copied().unwrap_or(0.0));
                    *lp += (a + (b - a) * frac - *lp) * wet_k;
                    *lp = dmath::flush(*lp);
                    *o = *lp;
                }
                self.write = (self.write + 1) & MASK;
                yl = (x + outs[0] * wet) * (1.0 - 0.25 * wet);
                yr = (x + outs[1] * wet) * (1.0 - 0.25 * wet);
            }
            self.controls.gain += (gain_target - self.controls.gain) * gain_k;
            let g = level * self.controls.gain;
            *l = (yl * g) as f32;
            *r = (yr * g) as f32;
        }
    }
}

fn release(v: &mut Voice, order: u64) {
    v.held = false;
    v.sustained = false;
    if v.stage != Stage::Release {
        v.stage = Stage::Release;
        v.released_at = order;
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::super::{Instrument, InstrumentKind};
    use super::*;

    fn poly() -> Instrument {
        Instrument::new(InstrumentKind::Poly, 48_000.0)
    }

    #[test]
    fn plays_releases_and_is_stereo_with_chorus() {
        let mut inst = poly();
        let (l, r) = render(&mut inst, 1.5, &[(0, on(0, 57, 0.8, 1)), (24_000, off(0, 57, 1))]);
        let held = rms(&l[4800..24_000]);
        assert!(held > 0.02 && peak(&l) < 1.5, "{held}");
        assert!(l != r, "chorus makes the image stereo");
        assert!(peak(&l[24_000 + 36_000..]) < 1e-3, "released");
        assert_eq!(inst.active_voices(), 0);
    }

    #[test]
    fn chorus_off_is_mono_and_cutoff_darkens() {
        let brightness = |cutoff: f64| {
            let mut inst = poly();
            inst.set_param(CHORUS, 0.0);
            inst.set_param(ENV_AMOUNT, 0.0);
            inst.set_param(CUTOFF, cutoff);
            let (l, r) = render(&mut inst, 0.5, &[(0, on(0, 48, 1.0, 1))]);
            assert_eq!(l[9600..], r[9600..], "chorus faded out");
            let diff: std::vec::Vec<f32> = l.windows(2).map(|w| w[1] - w[0]).collect();
            rms(&diff[9600..]) / rms(&l[9600..])
        };
        assert!(brightness(400.0) * 3.0 < brightness(8000.0));
    }

    #[test]
    fn steals_the_oldest_voice_beyond_the_voice_count() {
        let mut inst = poly();
        inst.set_param(VOICE_COUNT, 4.0);
        let events: std::vec::Vec<_> =
            (0..6).map(|i| (i * 480, on(0, 60 + i as u32, 0.7, i as i32))).collect();
        let (l, _) = render(&mut inst, 0.2, &events);
        assert_eq!(inst.active_voices(), 4);
        assert!(l.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn mono_legato_returns_to_held_note() {
        let mut inst = poly();
        inst.set_param(VOICE_COUNT, 1.0);
        let events = [(0, on(0, 60, 0.8, 1)), (4800, on(0, 67, 0.8, 2)), (9600, off(0, 67, 2))];
        render(&mut inst, 0.3, &events);
        assert_eq!(inst.active_voices(), 1);
        let Some(super::super::Engine::Poly(p)) = Some(&inst.engine) else { panic!() };
        assert_eq!(p.voices[0].pitch, 60);
        assert!(p.voices[0].held);
    }

    #[test]
    fn resonance_self_oscillates_without_blowing_up() {
        let mut inst = poly();
        inst.set_param(RESONANCE, 1.0);
        inst.set_param(CUTOFF, 1000.0);
        inst.set_param(GLIDE, 0.3);
        let (l, _) = render(&mut inst, 1.0, &[(0, on(0, 36, 1.0, 1)), (100, on(0, 72, 1.0, 2))]);
        assert!(l.iter().all(|v| v.is_finite()) && peak(&l) < 3.0, "{}", peak(&l));
    }
}

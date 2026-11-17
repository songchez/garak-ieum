//! 옥구슬 EP: a tine electric piano.
//!
//! Model (original, after the published physics of tine pianos):
//! - Each key is a struck cantilever **tine** coupled to a **tonebar**: three damped modes per
//!   voice, run as complex rotators (one multiply-add chain per sample, exactly continuous when the
//!   pitch bends): the fundamental, a slightly detuned tonebar mode that makes the slow beating
//!   bloom, and the tine's inharmonic second bending mode (≈6.27×) that gives the glassy attack
//!   ("bell"), louder and brighter the harder the key is hit.
//! - The electromagnetic **pickup** sees the tine move past a magnet slightly off-centre: an
//!   asymmetric saturating curve normalised to unity small-signal gain. Soft notes stay round; hard
//!   notes drive it into the even-harmonic growl ("bark"). `bark` scales the drive with velocity,
//!   `pickup` sets the offset (asymmetry).
//! - A short filtered-noise **hammer** strike, the felt **damper** (release time; the top keys have
//!   none) and its low **thump** when it lands on the tine.
//! - Instrument chain: tilt tone, stage-amp drive with a speaker roll-off, tremolo blending into
//!   stereo auto-pan, DC blocker, output level × CC7 × CC11.

use super::dmath::{self, Noise, clampf};
use super::{Controls, InstrumentEvent, ParamDef, cc, event};

const fn d(id: &'static str, default: f64, min: f64, max: f64) -> ParamDef {
    ParamDef { id, default, min, max }
}

/// Catalog (ids persist in projects; append only). src/devices/vintage/params.ts mirrors it.
pub const PARAMS: &[ParamDef] = &[
    d("tone", 0.0, -1.0, 1.0),
    d("decay", 1.0, 0.25, 4.0),
    d("bark", 0.45, 0.0, 1.0),
    d("bell", 0.5, 0.0, 1.0),
    d("pickup", 0.35, 0.0, 1.0),
    d("hammer", 0.4, 0.0, 1.0),
    d("release", 0.12, 0.02, 1.5),
    d("thump", 0.35, 0.0, 1.0),
    d("dynamics", 0.7, 0.0, 1.0),
    d("tremRate", 4.5, 0.1, 12.0),
    d("tremDepth", 0.0, 0.0, 1.0),
    d("autopan", 0.0, 0.0, 1.0),
    d("drive", 0.0, 0.0, 1.0),
    d("tune", 0.0, -100.0, 100.0),
    d("level", 1.0, 0.0, 2.0),
];

const TONE: usize = 0;
const DECAY: usize = 1;
const BARK: usize = 2;
const BELL: usize = 3;
const PICKUP: usize = 4;
const HAMMER: usize = 5;
const RELEASE: usize = 6;
const THUMP: usize = 7;
const DYNAMICS: usize = 8;
const TREM_RATE: usize = 9;
const TREM_DEPTH: usize = 10;
const AUTOPAN: usize = 11;
const DRIVE: usize = 12;
const TUNE: usize = 13;
const LEVEL: usize = 14;

/// Polyphony (a sustained arpeggio rings on many tines at once).
pub const VOICES: usize = 16;
/// Tonebar mode detune and the tine's second cantilever mode.
const TONEBAR_RATIO: f64 = 1.000_7;
const BELL_RATIO: f64 = 6.267;
/// Keys from here up have no damper.
const UNDAMPED_FROM: u8 = 92;
const CONTROL: usize = 32;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Mode {
    re: f64,
    im: f64,
    c: f64,
    s: f64,
    /// Per-sample decay multiplier.
    r: f64,
}

impl Mode {
    #[inline(always)]
    fn tick(&mut self) -> f64 {
        let re = self.re * self.c - self.im * self.s;
        let im = self.re * self.s + self.im * self.c;
        self.re = re * self.r;
        self.im = im * self.r;
        self.im
    }

    #[inline(never)]
    fn tune(&mut self, cycles_per_sample: f64) {
        self.c = dmath::cos_cycles(cycles_per_sample);
        self.s = dmath::sin_cycles(cycles_per_sample);
    }

    #[inline(always)]
    fn energy(&self) -> f64 {
        self.re * self.re + self.im * self.im
    }

    fn flush(&mut self) {
        self.re = dmath::flush(self.re);
        self.im = dmath::flush(self.im);
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Voice {
    active: bool,
    held: bool,
    sustained: bool,
    released: bool,
    id: i32,
    pitch: u8,
    order: u64,
    velocity: f64,
    /// Pickup drive for this strike and its normalisation.
    drive: f64,
    makeup: f64,
    modes: [Mode; 3],
    thump: Mode,
    hammer: f64,
    hammer_k: f64,
    hammer_lp: f64,
}

#[derive(Clone, Debug)]
pub struct Ep {
    rate: f64,
    p: [f64; PARAMS.len()],
    voices: [Voice; VOICES],
    order: u64,
    controls: Controls,
    noise: Noise,
    /// Frequency factor last applied to the voices (tune × bend).
    pitch_factor: f64,
    bend: f64,
    // Smoothed instrument controls.
    tone: f64,
    drive: f64,
    depth: f64,
    level: f64,
    // Instrument chain state.
    tilt_lp: f64,
    tilt_k: f64,
    drive_lp: f64,
    trem_phase: f64,
    dc_x: f64,
    dc_y: f64,
    dc_r: f64,
    smooth: f64,
    pickup_q: f64,
    pickup_tq: f64,
    hammer_decay: f64,
    thump_decay: f64,
    until_control: usize,
}

/// Mode decay multipliers (held, released) for a key with the current parameters.
fn mode_rates(p: &[f64; PARAMS.len()], rate: f64, pitch: u8) -> ([f64; 3], [f64; 3]) {
    let k = f64::from(pitch);
    let t_fund = clampf(7.5 * p[DECAY] * dmath::exp2(-(k - 40.0) / 22.0), 0.3, 16.0);
    let t_bell = (0.06 + 0.5 * dmath::exp2(-(k - 48.0) / 24.0)) * p[DECAY].min(1.5);
    let held = [
        dmath::t60_multiplier(t_fund, rate),
        dmath::t60_multiplier(t_fund * 1.6, rate),
        dmath::t60_multiplier(t_bell, rate),
    ];
    let release = if pitch >= UNDAMPED_FROM {
        held
    } else {
        let t = p[RELEASE];
        [
            dmath::t60_multiplier(t.min(t_fund), rate),
            dmath::t60_multiplier(t.min(t_fund * 1.6), rate),
            dmath::t60_multiplier(t.min(t_bell), rate),
        ]
    };
    (held, release)
}

fn apply_decay(v: &mut Voice, p: &[f64; PARAMS.len()], rate: f64) {
    let (held, release) = mode_rates(p, rate, v.pitch);
    let r = if v.released { release } else { held };
    for (m, r) in v.modes.iter_mut().zip(r) {
        m.r = r;
    }
}

fn tune_voice(v: &mut Voice, factor: f64, rate: f64) {
    let f0 = dmath::note_hz(f64::from(v.pitch)) * factor / rate;
    v.modes[0].tune(f0);
    v.modes[1].tune(f0 * TONEBAR_RATIO);
    // Above ~0.45 fs the bell mode would alias: it is not excited there (see note_on).
    v.modes[2].tune((f0 * BELL_RATIO).min(0.45));
}

/// Damper down: the modes switch to their release decay, plus the felt's knock.
#[inline(never)]
fn release_voice(v: &mut Voice, p: &[f64; PARAMS.len()], rate: f64, factor: f64, thump_decay: f64) {
    v.held = false;
    v.sustained = false;
    if v.released {
        return;
    }
    v.released = true;
    let thump = p[THUMP];
    if v.pitch < UNDAMPED_FROM && thump > 0.0 {
        // The felt lands on the moving tine: a short low knock, louder on a ringing tine.
        let ring = dmath::sqrt(v.modes[0].energy()).min(1.0);
        v.thump.re += thump * 0.07 * (0.25 + ring);
        v.thump.tune((55.0 + f64::from(v.pitch) * 0.9) * factor / rate);
    }
    apply_decay(v, p, rate);
    v.thump.r = thump_decay;
}

impl Ep {
    pub fn new(rate: f64, params: &[f64]) -> Self {
        let mut p = [0.0; PARAMS.len()];
        for (i, (slot, def)) in p.iter_mut().zip(PARAMS).enumerate() {
            *slot = params.get(i).copied().unwrap_or(def.default);
        }
        let mut ep = Self {
            rate,
            p,
            voices: [Voice::default(); VOICES],
            order: 0,
            controls: Controls::new(),
            noise: Noise(0x9e37_79b9),
            pitch_factor: 1.0,
            bend: 0.0,
            tone: p[TONE],
            drive: p[DRIVE],
            depth: p[TREM_DEPTH],
            level: p[LEVEL],
            tilt_lp: 0.0,
            tilt_k: dmath::one_pole(1.0 / (core::f64::consts::TAU * 1200.0), rate),
            drive_lp: 0.0,
            trem_phase: 0.0,
            dc_x: 0.0,
            dc_y: 0.0,
            dc_r: 1.0 - core::f64::consts::TAU * 8.0 / rate,
            smooth: dmath::one_pole(0.012, rate / CONTROL as f64),
            pickup_q: 0.0,
            pickup_tq: 0.0,
            hammer_decay: dmath::t60_multiplier(0.012, rate),
            thump_decay: dmath::t60_multiplier(0.07, rate),
            until_control: 0,
        };
        ep.update_pickup();
        ep.pitch_factor = dmath::exp2(ep.p[TUNE] / 1200.0);
        ep
    }

    fn update_pickup(&mut self) {
        self.pickup_q = self.p[PICKUP] * 0.9;
        self.pickup_tq = dmath::tanh(self.pickup_q);
    }

    pub fn set_param(&mut self, index: usize, value: f64) {
        if let Some(slot) = self.p.get_mut(index) {
            *slot = value;
        }
        match index {
            PICKUP => self.update_pickup(),
            DECAY | RELEASE => {
                let (p, rate) = (self.p, self.rate);
                for v in self.voices.iter_mut().filter(|v| v.active) {
                    apply_decay(v, &p, rate);
                }
            }
            _ => {}
        }
    }

    #[inline(never)]
    pub fn reset(&mut self) {
        self.voices = [Voice::default(); VOICES];
        self.controls = Controls::new();
        self.bend = 0.0;
        self.tilt_lp = 0.0;
        self.drive_lp = 0.0;
        self.trem_phase = 0.0;
        self.dc_x = 0.0;
        self.dc_y = 0.0;
        self.tone = self.p[TONE];
        self.drive = self.p[DRIVE];
        self.depth = self.p[TREM_DEPTH];
        self.level = self.p[LEVEL];
        self.pitch_factor = dmath::exp2(self.p[TUNE] / 1200.0);
        self.until_control = 0;
    }

    pub fn active_voices(&self) -> usize {
        self.voices.iter().filter(|v| v.active).count()
    }

    pub fn tail_seconds(&self) -> f64 {
        // Undamped top keys ring with their natural decay; everything else stops with the damper.
        let natural = 7.5 * self.p[DECAY] * dmath::exp2(-(f64::from(UNDAMPED_FROM) - 40.0) / 22.0);
        (self.p[RELEASE].max(natural) + 0.15).min(30.0)
    }

    #[inline(never)]
    pub fn handle(&mut self, e: &InstrumentEvent) {
        match e.kind {
            event::NOTE_ON => {
                if e.value > 0.0 {
                    self.note_on(e.pitch.min(127) as u8, f64::from(e.value), e.id);
                } else {
                    self.note_off(e.pitch.min(127) as u8, e.id);
                }
            }
            event::NOTE_OFF => self.note_off(e.pitch.min(127) as u8, e.id),
            event::ALL_NOTES_OFF => {
                self.controls.sustain = false;
                self.release_where(|v| v.active);
            }
            event::CONTROLLER => {
                if e.param == cc::ALL_SOUND_OFF {
                    self.voices = [Voice::default(); VOICES];
                } else if e.param == cc::ALL_NOTES_OFF {
                    self.controls.sustain = false;
                    self.release_where(|v| v.active);
                } else if let Some(down) = self.controls.apply(e.param, f64::from(e.value))
                    && !down
                {
                    self.release_where(|v| v.sustained);
                }
            }
            event::RESET => self.reset(),
            _ => {}
        }
    }

    #[inline(never)]
    fn release_where(&mut self, pick: impl Fn(&Voice) -> bool) {
        let (p, rate, factor, thump) = (self.p, self.rate, self.pitch_factor, self.thump_decay);
        for v in self.voices.iter_mut().filter(|v| pick(v)) {
            release_voice(v, &p, rate, factor, thump);
        }
    }

    #[inline(never)]
    fn pick_voice(&self, pitch: u8) -> usize {
        // The same tine is struck again (it keeps ringing and takes the new energy).
        if let Some(i) = self.voices.iter().position(|v| v.active && v.pitch == pitch) {
            return i;
        }
        if let Some(i) = self.voices.iter().position(|v| !v.active) {
            return i;
        }
        // Quietest released voice, else the oldest one.
        let mut best: Option<(usize, f64)> = None;
        for (i, v) in self.voices.iter().enumerate() {
            if v.released {
                let e = v.modes[0].energy();
                if best.is_none_or(|(_, b)| e < b) {
                    best = Some((i, e));
                }
            }
        }
        if let Some((i, _)) = best {
            return i;
        }
        let mut oldest = (0, u64::MAX);
        for (i, v) in self.voices.iter().enumerate() {
            if v.order < oldest.1 {
                oldest = (i, v.order);
            }
        }
        oldest.0
    }

    #[inline(never)]
    fn note_on(&mut self, pitch: u8, velocity: f64, id: i32) {
        let vel = clampf(velocity, 0.0, 1.0);
        let i = self.pick_voice(pitch);
        self.order += 1;
        let (p, rate, factor, order) = (self.p, self.rate, self.pitch_factor, self.order);
        let dynamics = p[DYNAMICS];
        let amp = (1.0 - dynamics) * 0.6 + dynamics * dmath::powf(vel.max(1e-4), 1.6);
        let bell_ok = dmath::note_hz(f64::from(pitch)) * factor * BELL_RATIO < 0.45 * rate;
        let bell = if bell_ok { amp * p[BELL] * (0.12 + 0.55 * vel) } else { 0.0 };
        let hammer = p[HAMMER] * (0.15 + 0.85 * vel * vel) * 0.22;
        let hammer_hz = (1200.0 + 28.0 * f64::from(pitch)).min(0.4 * rate);
        let drive = 1.0 + p[BARK] * (0.4 + 4.6 * vel * vel);
        let Some(v) = self.voices.get_mut(i) else { return };
        if !v.active {
            *v = Voice::default();
        }
        v.active = true;
        v.held = true;
        v.sustained = false;
        v.released = false;
        v.id = id;
        v.pitch = pitch;
        v.order = order;
        v.velocity = vel;
        v.drive = drive;
        v.makeup = 1.0 + 0.55 * (drive - 1.0);
        // Strikes add energy in phase with the sine output (no step at the onset).
        v.modes[0].re += amp * 0.62;
        v.modes[1].re += amp * 0.62 * 0.22;
        v.modes[2].re += bell * 0.62;
        v.hammer = v.hammer.max(hammer);
        v.hammer_k = dmath::one_pole(1.0 / (core::f64::consts::TAU * hammer_hz), rate);
        tune_voice(v, factor, rate);
        apply_decay(v, &p, rate);
    }

    #[inline(never)]
    fn note_off(&mut self, pitch: u8, id: i32) {
        let hit = |v: &Voice| v.active && v.held && if id >= 0 { v.id == id } else { v.pitch == pitch };
        if self.controls.sustain {
            for v in self.voices.iter_mut().filter(|v| hit(v)) {
                v.held = false;
                v.sustained = true;
            }
        } else {
            self.release_where(hit);
        }
    }

    /// Renders voices and the instrument chain into `left` / `right` (overwritten).
    pub fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        // Control ticks run on a persistent frame counter, so the output does not depend on how
        // the host splits blocks (or where events fall).
        let n = left.len().min(right.len());
        let mut start = 0;
        while start < n {
            if self.until_control == 0 {
                self.control();
                self.until_control = CONTROL;
            }
            let end = (start + self.until_control).min(n);
            if let (Some(l), Some(r)) = (left.get_mut(start..end), right.get_mut(start..end)) {
                self.render_chunk(l, r);
            }
            self.until_control -= end - start;
            start = end;
        }
    }

    /// Flushes tiny states and retires silent voices (at control ticks).
    fn retire(&mut self) {
        for v in self.voices.iter_mut() {
            if !v.active {
                continue;
            }
            for m in v.modes.iter_mut() {
                m.flush();
            }
            v.thump.flush();
            v.hammer = dmath::flush(v.hammer);
            v.hammer_lp = dmath::flush(v.hammer_lp);
            let energy = v.modes[0].energy() + v.modes[1].energy() + v.modes[2].energy() + v.thump.energy();
            if v.released && energy < 1.0e-12 && v.hammer < 1.0e-6 {
                *v = Voice::default();
            }
        }
        self.tilt_lp = dmath::flush(self.tilt_lp);
        self.drive_lp = dmath::flush(self.drive_lp);
    }

    /// Control-rate updates: glides, pitch bend.
    fn control(&mut self) {
        self.retire();
        let k = self.smooth;
        self.tone += (self.p[TONE] - self.tone) * k;
        self.drive += (self.p[DRIVE] - self.drive) * k;
        let depth = (self.p[TREM_DEPTH] + self.controls.modulation()).min(1.0);
        self.depth += (depth - self.depth) * k;
        self.level += (self.p[LEVEL] - self.level) * k;
        // Bend glides at control rate; the rotators retune without any discontinuity.
        let bend = self.bend + (self.controls.bend - self.bend) * 0.35;
        self.bend = if (bend - self.controls.bend).abs() < 1e-4 { self.controls.bend } else { bend };
        let factor = dmath::exp2((self.bend + self.p[TUNE] / 100.0) / 12.0);
        if factor != self.pitch_factor {
            self.pitch_factor = factor;
            let rate = self.rate;
            for v in self.voices.iter_mut().filter(|v| v.active) {
                tune_voice(v, factor, rate);
            }
        }
    }

    fn render_chunk(&mut self, left: &mut [f32], right: &mut [f32]) {
        let q = self.pickup_q;
        let tq = self.pickup_tq;
        let slope = 1.0 - tq * tq;
        let hammer_decay = self.hammer_decay;
        let tone = self.tone;
        let low_gain = 1.0 - 0.3 * tone;
        let high_gain = dmath::exp2(1.3 * tone);
        let drive = self.drive;
        let drive_g = 1.0 + drive * 8.0;
        let drive_bias = 0.15 * drive;
        let drive_origin = dmath::tanh(drive_bias);
        let drive_norm = 1.0 / dmath::powf(drive_g, 0.5);
        let speaker_k =
            dmath::one_pole(1.0 / (core::f64::consts::TAU * (16_000.0 - 11_000.0 * drive)), self.rate);
        let trem_step = self.p[TREM_RATE] / self.rate;
        let depth = self.depth;
        let pan = self.p[AUTOPAN];
        let gain_target = self.controls.gain_target();
        let gain_k = 1.0 / (0.005 * self.rate).max(1.0);
        let out_level = self.level * 0.32;
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            let mut sum = 0.0;
            for v in self.voices.iter_mut() {
                if !v.active {
                    continue;
                }
                let x = v.modes[0].tick() + v.modes[1].tick() + v.modes[2].tick();
                let y = (dmath::tanh(v.drive * x + q) - tq) / (v.drive * slope) * v.makeup;
                let mut s = y + v.thump.tick();
                if v.hammer > 1.0e-6 {
                    v.hammer_lp += (self.noise.sample() - v.hammer_lp) * v.hammer_k;
                    s += v.hammer_lp * v.hammer;
                    v.hammer *= hammer_decay;
                }
                sum += s;
            }
            // Tilt tone around 1.2 kHz.
            self.tilt_lp += (sum - self.tilt_lp) * self.tilt_k;
            let mut x = self.tilt_lp * low_gain + (sum - self.tilt_lp) * high_gain;
            // Stage amp: asymmetric soft clip, then the speaker's roll-off.
            if drive > 1.0e-4 {
                x = (dmath::tanh(x * drive_g + drive_bias) - drive_origin) * drive_norm;
            }
            self.drive_lp += (x - self.drive_lp) * speaker_k;
            x = self.drive_lp;
            // DC blocker (the pickup and the amp are asymmetric).
            let y = x - self.dc_x + self.dc_r * self.dc_y;
            self.dc_x = x;
            self.dc_y = dmath::flush(y);
            // Tremolo blending into auto-pan.
            self.trem_phase += trem_step;
            if self.trem_phase >= 1.0 {
                self.trem_phase -= 1.0;
            }
            let s = dmath::sin_cycles(self.trem_phase);
            let trem = 1.0 - depth * 0.5 * (1.0 - s);
            let p = s * depth;
            let gl = trem + pan * (dmath::sqrt(1.0 - p) - trem);
            let gr = trem + pan * (dmath::sqrt(1.0 + p) - trem);
            self.controls.gain += (gain_target - self.controls.gain) * gain_k;
            let g = out_level * self.controls.gain;
            *l = (y * gl * g) as f32;
            *r = (y * gr * g) as f32;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::super::{Instrument, InstrumentKind};
    use super::*;

    fn ep() -> Instrument {
        Instrument::new(InstrumentKind::Ep, 48_000.0)
    }

    #[test]
    fn a_note_rings_decays_and_stops_after_release() {
        let mut inst = ep();
        let (l, r) = render(&mut inst, 2.0, &[(0, on(0, 60, 0.8, 1)), (48_000, off(0, 60, 1))]);
        let attack = peak(&l[..4800]);
        assert!(attack > 0.05 && attack < 1.0, "attack {attack}");
        assert!(rms(&l[24_000..48_000]) < rms(&l[..24_000]), "decays while held");
        assert!(peak(&l[48_000 + 30_000..]) < 1e-3, "damped after release");
        assert_eq!(l, r, "no tremolo: mono");
        assert_eq!(inst.active_voices(), 0);
    }

    #[test]
    fn print_levels() {
        for vel in [0.2f32, 0.5, 1.0] {
            let mut inst = ep();
            let (l, _) = render(&mut inst, 0.25, &[(0, on(0, 48, vel, 1))]);
            std::println!("vel {vel} peak {} rms {} first {:?}", peak(&l), rms(&l), &l[..8]);
        }
        std::println!("powf {}", dmath::powf(0.2, 1.6));
    }

    #[test]
    fn velocity_brightens_and_barks() {
        // Harder strikes: louder, and relatively more high-frequency energy (bell + pickup bark).
        let brightness = |vel: f32| {
            let mut inst = ep();
            let (l, _) = render(&mut inst, 0.25, &[(0, on(0, 48, vel, 1))]);
            let diff: std::vec::Vec<f32> = l.windows(2).map(|w| w[1] - w[0]).collect();
            (rms(&l), rms(&diff) / rms(&l))
        };
        let (soft, soft_b) = brightness(0.2);
        let (hard, hard_b) = brightness(1.0);
        assert!(hard > soft * 3.0, "{soft} {hard}");
        assert!(hard_b > soft_b * 1.15, "{soft_b} {hard_b}");
    }

    #[test]
    fn sustain_pedal_holds_released_notes() {
        let mut inst = ep();
        let events = [
            (0, controller(0, cc::SUSTAIN, 1.0)),
            (0, on(0, 64, 0.7, 1)),
            (4800, off(0, 64, 1)),
            (48_000, controller(0, cc::SUSTAIN, 0.0)),
        ];
        let (l, _) = render(&mut inst, 2.2, &events);
        assert!(rms(&l[40_000..47_000]) > 1e-3, "still ringing under the pedal");
        assert!(peak(&l[48_000 + 40_000..]) < 1e-3, "released at pedal up");
    }

    #[test]
    fn autopan_moves_between_channels() {
        let mut inst = ep();
        inst.set_param(TREM_DEPTH, 1.0);
        inst.set_param(AUTOPAN, 1.0);
        inst.set_param(TREM_RATE, 4.0);
        let (l, r) = render(&mut inst, 1.0, &[(0, on(0, 60, 0.8, 1))]);
        let diff: f64 = l.iter().zip(&r).map(|(a, b)| f64::from((a - b).abs())).sum();
        assert!(diff > 10.0, "{diff}");
    }

    #[test]
    fn steals_when_out_of_voices_and_bends() {
        let mut inst = ep();
        let mut events = std::vec::Vec::new();
        for i in 0..24 {
            events.push((i * 100, on(0, 40 + i as u32, 0.6, i as i32)));
        }
        events.push((5000, controller(0, cc::PITCH_BEND, 1.0)));
        let (l, _) = render(&mut inst, 0.5, &events);
        assert_eq!(inst.active_voices(), VOICES);
        assert!(l.iter().all(|v| v.is_finite()), "finite");
        assert!(peak(&l) < 8.0, "{}", peak(&l));
    }
}

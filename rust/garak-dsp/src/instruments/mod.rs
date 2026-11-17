//! Built-in vintage instruments: original synthesis, one implementation for both engines.
//!
//! - [`ep`]: 옥구슬 EP, a tine electric piano (modal tine + tonebar, velocity bark through an
//!   asymmetric pickup, hammer and damper noises, tremolo / auto-pan, stage-amp drive).
//! - [`poly`]: 한밤 106, a one-oscillator-per-voice polysynth (saw / PWM pulse / sub / noise, HPF,
//!   resonant 4-pole ladder, ADSR + LFO, env or gate VCA, the classic two-tap stereo chorus).
//!
//! Unlike the effect kernels these have no C++ / TypeScript twin: the C++ host reaches them through
//! garak-ffi (`garak_rs_instrument_*`) and the browser through the engine (garak-engine-wasm).
//! All arithmetic goes through [`dmath`], so both render bit-identical
//! samples (the parity tests compare checksums of the same scripted performance).
//!
//! Real-time contract as the rest of the crate: fixed voice pools inside the struct, no allocation,
//! no panics; out-of-range parameters and events are clamped or ignored.

pub mod builtin;
pub mod dmath;
use dmath::clampf;
pub mod ep;
pub mod poly;

pub use crate::params::ParamDef;

/// Instrument kinds of the C ABI / WASM exports. Values are part of the ABI: append only.
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstrumentKind {
    /// 옥구슬 EP (project instrument id `okgu-ep`).
    Ep = 0,
    /// 한밤 106 (project instrument id `hanbam-106`).
    Poly = 1,
}

impl InstrumentKind {
    pub const ALL: [InstrumentKind; 2] = [Self::Ep, Self::Poly];

    pub fn from_u32(v: u32) -> Option<Self> {
        match v {
            0 => Some(Self::Ep),
            1 => Some(Self::Poly),
            _ => None,
        }
    }

    /// Project instrument id (`Track.instrument`).
    pub fn id(self) -> &'static str {
        match self {
            Self::Ep => "okgu-ep",
            Self::Poly => "hanbam-106",
        }
    }

    pub fn from_id(id: &[u8]) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.id().as_bytes() == id)
    }

    /// Parameter catalog: persisted ids, defaults and ranges (src/devices/vintage/params.ts mirrors it).
    pub fn params(self) -> &'static [ParamDef] {
        match self {
            Self::Ep => ep::PARAMS,
            Self::Poly => poly::PARAMS,
        }
    }

    pub fn param_index(self, id: &[u8]) -> Option<usize> {
        self.params().iter().position(|p| p.id.as_bytes() == id)
    }
}

/// Largest instrument catalog.
pub const MAX_INSTRUMENT_PARAMS: usize = 32;

/// Event kinds (`InstrumentEvent::kind`). Part of the ABI.
pub mod event {
    /// `pitch` 0..127, `value` velocity 0..1 (0 is a note-off), `id` host note id (or -1).
    pub const NOTE_ON: u32 = 0;
    /// Releases the voice with `id` (or, when `id` < 0, every voice playing `pitch`).
    pub const NOTE_OFF: u32 = 1;
    /// Releases every voice (sustain pedal lifted as well).
    pub const ALL_NOTES_OFF: u32 = 2;
    /// MIDI controller `param` (0..127 CC, 128 channel pressure, 129 pitch bend, 131 bend range in
    /// semitones / 48), `value` normalised 0..1 (pitch bend: 0.5 = centre).
    pub const CONTROLLER: u32 = 3;
    /// Parameter `param` (catalog index) to `value` (catalog units, clamped).
    pub const PARAM: u32 = 4;
    /// Immediate silence: voices, delay lines and controllers return to rest.
    pub const RESET: u32 = 5;
}

/// One sample-accurate event inside a block. `#[repr(C)]`: shared with C++ and the worklet.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct InstrumentEvent {
    /// Frame inside the block (events must be sorted by offset; later offsets are clamped).
    pub offset: u32,
    pub kind: u32,
    pub id: i32,
    pub pitch: u32,
    pub value: f32,
    pub param: u32,
}

const _: () = assert!(size_of::<InstrumentEvent>() == 24);

/// MIDI controller numbers the instruments read.
pub mod cc {
    pub const MOD_WHEEL: u32 = 1;
    pub const VOLUME: u32 = 7;
    pub const EXPRESSION: u32 = 11;
    pub const SUSTAIN: u32 = 64;
    pub const ALL_SOUND_OFF: u32 = 120;
    pub const ALL_NOTES_OFF: u32 = 123;
    pub const CHANNEL_PRESSURE: u32 = 128;
    pub const PITCH_BEND: u32 = 129;
    pub const BEND_RANGE: u32 = 131;
}

/// Controller state both instruments share.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Controls {
    /// Pitch bend in semitones (already scaled by the range).
    pub bend: f64,
    pub bend_norm: f64,
    pub bend_range: f64,
    pub mod_wheel: f64,
    pub pressure: f64,
    pub volume: f64,
    pub expression: f64,
    pub sustain: bool,
    /// Smoothed output gain (CC7 × CC11).
    pub gain: f64,
}

impl Controls {
    pub const fn new() -> Self {
        Self {
            bend: 0.0,
            bend_norm: 0.0,
            bend_range: 2.0,
            mod_wheel: 0.0,
            pressure: 0.0,
            volume: 1.0,
            expression: 1.0,
            sustain: false,
            gain: 1.0,
        }
    }

    /// Applies a controller; returns `Some(down)` when the sustain pedal changed.
    pub fn apply(&mut self, controller: u32, value: f64) -> Option<bool> {
        let v = if value.is_nan() { 0.0 } else { clampf(value, 0.0, 1.0) };
        match controller {
            cc::PITCH_BEND => {
                let raw = (v * 16383.0 + 0.5) as i32 - 8192;
                self.bend_norm = if raw > 0 { raw as f64 / 8191.0 } else { raw as f64 / 8192.0 };
                self.bend = self.bend_norm * self.bend_range;
            }
            cc::BEND_RANGE => {
                self.bend_range = (v * 48.0 + 0.5) as i32 as f64;
                self.bend = self.bend_norm * self.bend_range;
            }
            cc::MOD_WHEEL => self.mod_wheel = v,
            cc::CHANNEL_PRESSURE => self.pressure = v,
            cc::VOLUME => {
                let x = v * 127.0 / 100.0;
                self.volume = x * x;
            }
            cc::EXPRESSION => self.expression = v * v,
            cc::SUSTAIN => {
                let down = v >= 64.0 / 127.0 - 1e-6;
                if down != self.sustain {
                    self.sustain = down;
                    return Some(down);
                }
            }
            _ => {}
        }
        None
    }

    /// Target of the CC7 × CC11 gain.
    #[inline]
    pub fn gain_target(&self) -> f64 {
        self.volume * self.expression
    }

    /// Modulation amount (mod wheel or channel pressure, whichever is higher).
    #[inline]
    pub fn modulation(&self) -> f64 {
        if self.mod_wheel > self.pressure { self.mod_wheel } else { self.pressure }
    }
}

/// Clamps `value` into a catalog entry (NaN takes the default).
#[inline]
pub(crate) fn sanitize(def: &ParamDef, value: f64) -> f64 {
    if !value.is_finite() { def.default } else { clampf(value, def.min, def.max) }
}

/// The synthesis engine of one instrument kind.
#[derive(Clone, Debug)]
#[allow(clippy::large_enum_variant)]
enum Engine {
    Ep(ep::Ep),
    Poly(poly::Poly),
}

/// One instrument instance (a track's source): fixed size, no heap.
#[derive(Clone, Debug)]
pub struct Instrument {
    kind: InstrumentKind,
    sample_rate: f64,
    params: [f64; MAX_INSTRUMENT_PARAMS],
    engine: Engine,
}

/// Longest stretch rendered between two looks at the event list (keeps control-rate work bounded).
const SEGMENT: usize = 256;

impl Instrument {
    /// A silent instrument at `sample_rate` (clamped to 8–192 kHz) with the catalog defaults.
    pub fn new(kind: InstrumentKind, sample_rate: f64) -> Self {
        let sample_rate =
            if sample_rate.is_finite() { clampf(sample_rate, 8_000.0, 192_000.0) } else { 48_000.0 };
        let mut params = [0.0; MAX_INSTRUMENT_PARAMS];
        for (slot, def) in params.iter_mut().zip(kind.params()) {
            *slot = def.default;
        }
        let engine = match kind {
            InstrumentKind::Ep => Engine::Ep(ep::Ep::new(sample_rate, &params)),
            InstrumentKind::Poly => Engine::Poly(poly::Poly::new(sample_rate, &params)),
        };
        Self { kind, sample_rate, params, engine }
    }

    pub fn kind(&self) -> InstrumentKind {
        self.kind
    }

    pub fn sample_rate(&self) -> f64 {
        self.sample_rate
    }

    /// Sets a parameter (catalog units, clamped; non-finite values are ignored). Out-of-range
    /// indices are ignored. Continuous parameters glide; switches apply immediately.
    pub fn set_param(&mut self, index: usize, value: f64) {
        let Some(def) = self.kind.params().get(index) else { return };
        if !value.is_finite() {
            return;
        }
        let v = sanitize(def, value);
        if let Some(slot) = self.params.get_mut(index) {
            *slot = v;
        }
        match &mut self.engine {
            Engine::Ep(e) => e.set_param(index, v),
            Engine::Poly(p) => p.set_param(index, v),
        }
    }

    /// All parameters at once in catalog order (`count` may be shorter than the catalog).
    pub fn set_params(&mut self, values: &[f64]) {
        for (i, &v) in values.iter().enumerate() {
            self.set_param(i, v);
        }
    }

    pub fn param(&self, index: usize) -> f64 {
        self.params.get(index).copied().unwrap_or(0.0)
    }

    /// Takes over `previous`'s voices, controllers and delay lines (an edited track keeps ringing),
    /// keeping this instance's parameters. Ignored across kinds or sample rates.
    pub fn take_state(&mut self, previous: &Instrument) {
        if previous.kind != self.kind || previous.sample_rate != self.sample_rate {
            return;
        }
        let params = self.params;
        self.engine = previous.engine.clone();
        self.params = previous.params;
        for (i, &v) in params.iter().enumerate().take(self.kind.params().len()) {
            self.set_param(i, v);
        }
    }

    /// Silence now (voices, delay lines, controllers).
    pub fn reset(&mut self) {
        match &mut self.engine {
            Engine::Ep(e) => e.reset(),
            Engine::Poly(p) => p.reset(),
        }
    }

    /// Voices currently sounding.
    pub fn active_voices(&self) -> usize {
        match &self.engine {
            Engine::Ep(e) => e.active_voices(),
            Engine::Poly(p) => p.active_voices(),
        }
    }

    /// Longest release tail of the current settings (export allowance), seconds.
    pub fn tail_seconds(&self) -> f64 {
        match &self.engine {
            Engine::Ep(e) => e.tail_seconds(),
            Engine::Poly(p) => p.tail_seconds(),
        }
    }

    /// Applies one event now.
    pub fn handle(&mut self, e: &InstrumentEvent) {
        match e.kind {
            event::PARAM => self.set_param(e.param as usize, f64::from(e.value)),
            _ => match &mut self.engine {
                Engine::Ep(x) => x.handle(e),
                Engine::Poly(x) => x.handle(e),
            },
        }
    }

    /// Renders `min(left.len(), right.len())` frames (overwriting the buffers), applying `events`
    /// at their offsets. Events must be sorted by offset; offsets past the block apply at its end.
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32], events: &[InstrumentEvent]) {
        let frames = left.len().min(right.len());
        let mut next = 0usize;
        let mut pos = 0usize;
        while pos < frames {
            while let Some(e) = events.get(next) {
                if (e.offset as usize) > pos {
                    break;
                }
                self.handle(e);
                next += 1;
            }
            let until = events.get(next).map_or(frames, |e| (e.offset as usize).min(frames));
            let end = until.min(pos + SEGMENT).max(pos + 1).min(frames);
            if let (Some(l), Some(r)) = (left.get_mut(pos..end), right.get_mut(pos..end)) {
                match &mut self.engine {
                    Engine::Ep(x) => x.render(l, r),
                    Engine::Poly(x) => x.render(l, r),
                }
            }
            pos = end;
        }
        for e in events.get(next..).unwrap_or(&[]) {
            self.handle(e);
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::vec::Vec;

    pub fn on(offset: u32, pitch: u32, velocity: f32, id: i32) -> InstrumentEvent {
        InstrumentEvent { offset, kind: event::NOTE_ON, id, pitch, value: velocity, param: 0 }
    }

    pub fn off(offset: u32, pitch: u32, id: i32) -> InstrumentEvent {
        InstrumentEvent { offset, kind: event::NOTE_OFF, id, pitch, value: 0.0, param: 0 }
    }

    pub fn controller(offset: u32, cc: u32, value: f32) -> InstrumentEvent {
        InstrumentEvent { offset, kind: event::CONTROLLER, id: -1, pitch: 0, value, param: cc }
    }

    /// Renders `seconds` in 128-frame blocks, delivering `events` (absolute frames) on time.
    pub fn render(
        inst: &mut Instrument,
        seconds: f64,
        events: &[(u64, InstrumentEvent)],
    ) -> (Vec<f32>, Vec<f32>) {
        render_blocks(inst, seconds, events, 128)
    }

    pub fn render_blocks(
        inst: &mut Instrument,
        seconds: f64,
        events: &[(u64, InstrumentEvent)],
        block_size: usize,
    ) -> (Vec<f32>, Vec<f32>) {
        let frames = (seconds * inst.sample_rate()) as usize;
        let (mut l, mut r) = (std::vec![0.0f32; frames], std::vec![0.0f32; frames]);
        let mut block = Vec::new();
        let mut at = 0usize;
        while at < frames {
            let n = block_size.min(frames - at);
            block.clear();
            for (frame, e) in events {
                if *frame >= at as u64 && *frame < (at + n) as u64 {
                    block.push(InstrumentEvent { offset: (*frame - at as u64) as u32, ..*e });
                }
            }
            inst.process(&mut l[at..at + n], &mut r[at..at + n], &block);
            at += n;
        }
        (l, r)
    }

    pub fn peak(x: &[f32]) -> f32 {
        x.iter().fold(0.0f32, |m, v| m.max(v.abs()))
    }

    pub fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| f64::from(*v) * f64::from(*v)).sum::<f64>() / x.len().max(1) as f64).sqrt()
    }

    /// FNV-1a over the sample bits (the cross-engine parity checksum).
    pub fn checksum(l: &[f32], r: &[f32]) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for (a, b) in l.iter().zip(r) {
            for v in [a.to_bits(), b.to_bits()] {
                h ^= u64::from(v);
                h = h.wrapping_mul(0x0000_0100_0000_01b3);
            }
        }
        h
    }
}

/// The cross-engine parity scene (docs/RUST.md "빈티지 악기"): native/tests/rust_instrument_test.cpp builds
/// the same performance and must reach the checksums in `parity.golden` through garak-ffi. Changing the DSP changes the checksums: update
/// the golden file (`cargo test -p garak-dsp parity_scene -- --nocapture` prints them).
#[cfg(test)]
pub(crate) mod parity_scene {
    use super::*;
    use std::vec::Vec;

    pub const RATE: f64 = 48_000.0;
    pub const FRAMES: usize = 96_000;
    pub const GOLDEN: &str = include_str!("parity.golden");

    pub fn overrides(kind: InstrumentKind) -> &'static [(&'static str, f64)] {
        match kind {
            InstrumentKind::Ep => {
                &[("bark", 0.8), ("tremDepth", 0.6), ("autopan", 0.7), ("drive", 0.4), ("tremRate", 5.5)]
            }
            InstrumentKind::Poly => &[
                ("pulse", 0.6),
                ("noise", 0.1),
                ("resonance", 0.6),
                ("chorus", 3.0),
                ("glide", 0.05),
                ("voices", 4.0),
                ("lfoFilter", 0.2),
                ("vibrato", 0.3),
                ("lfoDelay", 0.2),
            ],
        }
    }

    pub fn events(kind: InstrumentKind) -> Vec<(u64, InstrumentEvent)> {
        let mut list = Vec::new();
        let ev = |kind: u32, id: i32, pitch: u32, value: f32, param: u32| InstrumentEvent {
            offset: 0,
            kind,
            id,
            pitch,
            value,
            param,
        };
        for i in 0..12u32 {
            let pitch = 36 + (i * 7) % 40;
            let velocity = (0.3 + 0.05 * f64::from(i)) as f32;
            list.push((u64::from(i) * 3001, ev(event::NOTE_ON, i as i32, pitch, velocity, 0)));
            list.push((u64::from(i) * 3001 + 9000, ev(event::NOTE_OFF, i as i32, pitch, 0.0, 0)));
        }
        list.push((20_000, ev(event::CONTROLLER, -1, 0, 0.75, cc::PITCH_BEND)));
        list.push((25_000, ev(event::CONTROLLER, -1, 0, 0.5, cc::MOD_WHEEL)));
        list.push((30_000, ev(event::CONTROLLER, -1, 0, 1.0, cc::SUSTAIN)));
        list.push((50_000, ev(event::CONTROLLER, -1, 0, 0.0, cc::SUSTAIN)));
        let max = kind.params().first().map_or(0.0, |p| p.max) as f32;
        list.push((40_000, ev(event::PARAM, -1, 0, max, 0)));
        list.push((60_000, ev(event::CONTROLLER, -1, 0, 0.6, cc::VOLUME)));
        list.sort_by_key(|(frame, _)| *frame); // stable
        list
    }

    pub fn instrument(kind: InstrumentKind) -> Instrument {
        let mut params: Vec<f64> = kind.params().iter().map(|p| p.default).collect();
        for (id, value) in overrides(kind) {
            if let Some(i) = kind.param_index(id.as_bytes()) {
                params[i] = *value;
            }
        }
        let mut inst = Instrument::new(kind, RATE);
        inst.set_params(&params);
        inst
    }

    pub fn golden(kind: InstrumentKind) -> Option<u64> {
        GOLDEN.lines().find_map(|line| {
            let (id, hex) = line.split_once(' ')?;
            (id == kind.id()).then(|| u64::from_str_radix(hex.trim(), 16).ok())?
        })
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn parity_scene_matches_the_golden_checksums() {
        let mut changed = std::vec::Vec::new();
        for kind in InstrumentKind::ALL {
            let mut inst = parity_scene::instrument(kind);
            let seconds = parity_scene::FRAMES as f64 / parity_scene::RATE;
            let (l, r) = render(&mut inst, seconds, &parity_scene::events(kind));
            let sum = checksum(&l, &r);
            std::println!(
                "{} {sum:016x} (peak {:.3}, rms {:.4})",
                kind.id(),
                peak(&l).max(peak(&r)),
                rms(&l)
            );
            assert!(peak(&l) < 4.0 && rms(&l) > 0.01);
            if parity_scene::golden(kind) != Some(sum) {
                changed.push(std::format!("{} {sum:016x}", kind.id()));
            }
        }
        assert!(changed.is_empty(), "checksums changed, update parity.golden:\n{}", changed.join("\n"));
    }

    #[test]
    fn output_does_not_depend_on_block_size() {
        for kind in InstrumentKind::ALL {
            let events = parity_scene::events(kind);
            let (a, b) = render_blocks(&mut parity_scene::instrument(kind), 1.2, &events, 128);
            let (c, d) = render_blocks(&mut parity_scene::instrument(kind), 1.2, &events, 37);
            assert!(a == c && b == d, "{}", kind.id());
        }
    }

    #[test]
    fn catalogs_fit_and_ids_round_trip() {
        for k in InstrumentKind::ALL {
            assert!(k.params().len() <= MAX_INSTRUMENT_PARAMS);
            assert_eq!(InstrumentKind::from_id(k.id().as_bytes()), Some(k));
            assert_eq!(InstrumentKind::from_u32(k as u32), Some(k));
            for (i, p) in k.params().iter().enumerate() {
                assert!(p.min <= p.default && p.default <= p.max, "{} {}", k.id(), p.id);
                assert_eq!(k.param_index(p.id.as_bytes()), Some(i));
            }
        }
    }

    #[test]
    fn events_past_the_block_and_garbage_are_harmless() {
        for k in InstrumentKind::ALL {
            let mut inst = Instrument::new(k, 48_000.0);
            let mut l = [0.0f32; 64];
            let mut r = [0.0f32; 64];
            let events = [
                on(0, 60, 1.0, 1),
                on(10, 300, 2.0, 2),
                InstrumentEvent { offset: 20, kind: 99, ..Default::default() },
                InstrumentEvent {
                    offset: 30,
                    kind: event::PARAM,
                    param: 999,
                    value: f32::NAN,
                    ..Default::default()
                },
                off(500, 60, 1),
            ];
            inst.process(&mut l, &mut r, &events);
            inst.set_param(0, f64::NAN);
            inst.set_param(1000, 1.0);
            assert!(l.iter().chain(r.iter()).all(|v| v.is_finite()));
        }
    }

    #[test]
    fn take_state_keeps_ringing_with_new_params() {
        for k in InstrumentKind::ALL {
            let mut a = Instrument::new(k, 48_000.0);
            render(&mut a, 0.1, &[(0, on(0, 60, 0.9, 1))]);
            let mut b = Instrument::new(k, 48_000.0);
            b.set_param(0, k.params()[0].max);
            b.take_state(&a);
            assert_eq!(b.param(0), k.params()[0].max);
            assert!(b.active_voices() >= 1);
            let (l, _) = render(&mut b, 0.05, &[]);
            assert!(peak(&l) > 1e-3);
        }
    }
}

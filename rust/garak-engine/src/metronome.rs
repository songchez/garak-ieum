//! Metronome and count-in (line-by-line port of native/src/metronome.hpp and native/include/garak/meter.hpp;
//! docs/METRONOME.md, docs/METER_MAP.md). Monitor-only clicks: one mono stroke per level (0 bar downbeat,
//! 1 compound group start, 2 other pulses), synthesized by the UI (gugak or classic sounds) and handed over as
//! PCM; this module only schedules and mixes them. The grid follows the tempo map and, across time-signature
//! changes, restarts each meter on its first bar line. No allocation after construction.

use alloc::sync::Arc;
use alloc::vec::Vec;

use crate::math;
use crate::tempo::TempoMap;

/// A time-signature change on a bar line (C++ `MeterEvent`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MeterEvent {
    pub bar: i64,
    pub numerator: i32,
    pub denominator: i32,
    /// Derived: quarter-note beat of the event's first bar line.
    pub beat: f64,
}

/// Meter map (C++ `MeterMap`): the first event is bar 0 with the project meter; beats are recomputed from bars.
#[derive(Clone, Debug, PartialEq)]
pub struct MeterMap {
    events: Vec<MeterEvent>,
}

impl MeterMap {
    /// Control thread (allocates). Events after the first must be sorted by bar and unique; others are dropped.
    pub fn new(numerator: i32, denominator: i32, events: &[MeterEvent]) -> Self {
        let mut out = Vec::with_capacity(events.len().max(1));
        out.push(MeterEvent {
            bar: 0,
            numerator: numerator.max(1),
            denominator: denominator.max(1),
            beat: 0.0,
        });
        for e in events.iter().skip(1) {
            let Some(last) = out.last().copied() else { break };
            if !(e.bar > last.bar) || e.numerator < 1 || e.denominator < 1 {
                continue;
            }
            // `a * b + c` contracted like AppleClang on Apple arm64 (math::mul_add), as in meter.hpp.
            let beat = math::mul_add((e.bar - last.bar) as f64, Self::bar_beats(&last), last.beat);
            out.push(MeterEvent { bar: e.bar, numerator: e.numerator, denominator: e.denominator, beat });
        }
        Self { events: out }
    }

    pub fn events(&self) -> &[MeterEvent] {
        &self.events
    }

    pub fn constant(&self) -> bool {
        self.events.len() < 2
    }

    pub fn bar_beats(e: &MeterEvent) -> f64 {
        f64::from(e.numerator) * 4.0 / f64::from(e.denominator)
    }

    pub fn pulse_beats(e: &MeterEvent) -> f64 {
        4.0 / f64::from(e.denominator)
    }

    /// Index of the event at or before `beat`.
    pub fn segment_at(&self, beat: f64) -> usize {
        let (mut lo, mut hi) = (0usize, self.events.len().saturating_sub(1));
        while lo < hi {
            let mid = (lo + hi).div_ceil(2);
            if self.events.get(mid).is_some_and(|e| e.beat <= beat + 1e-7) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        lo
    }

    pub fn at(&self, beat: f64) -> MeterEvent {
        self.events.get(self.segment_at(beat)).copied().unwrap_or(MeterEvent {
            bar: 0,
            numerator: 4,
            denominator: 4,
            beat: 0.0,
        })
    }

    /// First beat of segment `index + 1` (infinity after the last).
    pub fn segment_end(&self, index: usize) -> f64 {
        self.events.get(index + 1).map_or(f64::INFINITY, |e| e.beat)
    }
}

/// The pulse grid of one meter (C++ `metronome::Grid`).
#[derive(Clone, Copy, Debug)]
pub struct Grid<'a> {
    pub pulse_frames: f64,
    pub pulse_beats: f64,
    pub sample_rate: f64,
    pub tempo: Option<&'a TempoMap>,
    pub pulses_per_bar: i32,
    pub group_pulses: i32,
}

impl Grid<'_> {
    pub fn level(&self, pulse: i64) -> usize {
        let per = i64::from(self.pulses_per_bar.max(1));
        let in_bar = ((pulse % per) + per) % per;
        if in_bar == 0 {
            0
        } else if in_bar % i64::from(self.group_pulses.max(1)) == 0 {
            1
        } else {
            2
        }
    }

    pub fn frame_of(&self, pulse: i64) -> i64 {
        let at = pulse as f64;
        math::llround(match self.tempo {
            Some(t) => t.frame_at(at * self.pulse_beats, self.sample_rate),
            None => at * self.pulse_frames,
        })
    }

    /// A pulse at or just before `frame` (never after it).
    pub fn pulse_before(&self, frame: i64) -> i64 {
        let at = frame as f64;
        let beats = match self.tempo {
            Some(t) => t.beat_at_frame(at, self.sample_rate) / self.pulse_beats,
            None => at / self.pulse_frames,
        };
        math::floor(beats) as i64 - 1
    }
}

/// C++ `metronome::grid`: one pulse per denominator note; compound meters (6/8, 9/8, 12/8 ...) group in threes.
pub fn grid(
    sample_rate: f64,
    bpm: f64,
    numerator: i32,
    denominator: i32,
    tempo: Option<&TempoMap>,
) -> Grid<'_> {
    let compound = denominator >= 8 && numerator > 3 && numerator % 3 == 0;
    let pulse_beats = 4.0 / f64::from(denominator.max(1));
    let pulses_per_bar = numerator.max(1);
    Grid {
        pulse_frames: sample_rate * 60.0 / math::std_max(1.0, bpm) * pulse_beats,
        pulse_beats,
        sample_rate,
        tempo,
        pulses_per_bar,
        group_pulses: if compound { 3 } else { pulses_per_bar },
    }
}

/// Click PCM, one mono stroke per level, at the engine rate. Immutable once handed over.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Clicks {
    pub sample_rate: u32,
    pub levels: [Vec<f32>; 3],
}

#[derive(Clone, Copy, Debug, Default)]
struct Voice {
    level: Option<usize>,
    position: usize,
}

/// Up to six ringing strokes (C++ `metronome::Player`).
#[derive(Clone, Debug, Default)]
pub struct Player {
    voices: [Voice; 6],
    next: usize,
}

impl Player {
    fn mix_voice(v: &mut Voice, set: &Clicks, stereo: &mut [f32], from: u32, frames: u32, gain: f32) {
        let Some(pcm) = v.level.and_then(|l| set.levels.get(l)) else { return };
        let block = stereo.get_mut(from as usize * 2..frames as usize * 2).unwrap_or(&mut []);
        for pair in block.as_chunks_mut::<2>().0 {
            let Some(&x) = pcm.get(v.position) else { break };
            v.position += 1;
            let s = x * gain;
            pair[0] += s;
            pair[1] += s;
        }
        if v.position >= pcm.len() {
            *v = Voice::default();
        }
    }

    /// Continues every ringing stroke for `frames` frames.
    pub fn mix(&mut self, set: &Clicks, stereo: &mut [f32], frames: u32, gain: f32) {
        for v in &mut self.voices {
            Self::mix_voice(v, set, stereo, 0, frames, gain);
        }
    }

    /// Starts a stroke of `level` at `offset` and mixes it to the block end.
    pub fn trigger(
        &mut self,
        set: &Clicks,
        level: usize,
        stereo: &mut [f32],
        offset: u32,
        frames: u32,
        gain: f32,
    ) {
        if set.levels.get(level).is_none_or(|p| p.is_empty()) || offset >= frames {
            return;
        }
        let slot = self.next;
        self.next = (self.next + 1) % self.voices.len();
        if let Some(v) = self.voices.get_mut(slot) {
            *v = Voice { level: Some(level), position: 0 };
            Self::mix_voice(v, set, stereo, offset, frames, gain);
        }
    }

    pub fn clear(&mut self) {
        self.voices = [Voice::default(); 6];
    }
}

/// Clicks of pulses whose frame lies in `[begin, begin + frames)` (C++ `metronome::clicks`); `limit` >= 0
/// excludes pulses at or after it (the count-in length).
pub fn clicks(
    g: &Grid<'_>,
    set: &Clicks,
    player: &mut Player,
    stereo: &mut [f32],
    begin: i64,
    frames: u32,
    gain: f32,
    limit: i64,
) {
    if g.pulse_frames <= 0.0 || frames == 0 {
        return;
    }
    let end = begin + i64::from(frames);
    let mut pulse = g.pulse_before(begin).max(0);
    let mut at = g.frame_of(pulse);
    while at < end {
        if at >= begin && !(limit >= 0 && at >= limit) {
            player.trigger(set, g.level(pulse), stereo, (at - begin) as u32, frames, gain);
        }
        pulse += 1;
        at = g.frame_of(pulse);
    }
}

/// Clicks across time-signature changes (C++ `metronome::meterClicks`): each meter's pulses restart on its
/// first bar line, so every bar's first pulse is the downbeat.
pub fn meter_clicks(
    meters: &MeterMap,
    sample_rate: f64,
    bpm: f64,
    tempo: Option<&TempoMap>,
    set: &Clicks,
    player: &mut Player,
    stereo: &mut [f32],
    begin: i64,
    frames: u32,
    gain: f32,
) {
    if frames == 0 {
        return;
    }
    let frames_per_beat = sample_rate * 60.0 / math::std_max(1.0, bpm);
    let frame_of = |beat: f64| {
        math::llround(match tempo {
            Some(t) => t.frame_at(beat, sample_rate),
            None => beat * frames_per_beat,
        })
    };
    let start_beat = math::std_max(
        0.0,
        match tempo {
            Some(t) => t.beat_at_frame(begin as f64, sample_rate),
            None => begin as f64 / frames_per_beat,
        },
    );
    let end = begin + i64::from(frames);
    for index in meters.segment_at(start_beat)..meters.events().len() {
        let Some(e) = meters.events().get(index).copied() else { return };
        let until = meters.segment_end(index);
        let pulse = MeterMap::pulse_beats(&e);
        let g = grid(sample_rate, bpm, e.numerator, e.denominator, None);
        let mut k = (math::floor((start_beat - e.beat) / pulse) as i64 - 1).max(0);
        loop {
            let beat = math::mul_add(k as f64, pulse, e.beat);
            if beat >= until - 1e-9 {
                break;
            }
            let at = frame_of(beat);
            if at >= end {
                return;
            }
            if at >= begin {
                player.trigger(set, g.level(k), stereo, (at - begin) as u32, frames, gain);
            }
            k += 1;
        }
        if until.is_infinite() || frame_of(until) >= end {
            return;
        }
    }
}

/// A metronome with its click set (the host keeps the `Arc` alive while the audio thread reads it).
#[derive(Clone, Debug, Default)]
pub struct Metronome {
    pub clicks: Option<Arc<Clicks>>,
    pub player: Player,
}

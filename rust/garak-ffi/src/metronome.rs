//! C ABI of the metronome port (`garak_engine::metronome`), for the parity harness against
//! native/src/metronome.hpp (native/tests/rust_engine_host_test.cpp). Header: include/garak_engine.h.

use alloc::vec::Vec;

use garak_engine::metronome::{Clicks, MeterEvent, MeterMap, Player, clicks, grid, meter_clicks};
use garak_engine::plan::TempoPoint;
use garak_engine::tempo::TempoMap;

/// # Safety
/// `p` is null or valid for `n` reads.
unsafe fn slice<'a, T>(p: *const T, n: usize) -> &'a [T] {
    if p.is_null() || n == 0 {
        &[]
    } else {
        // SAFETY: forwarded caller contract.
        unsafe { core::slice::from_raw_parts(p, n) }
    }
}

/// Renders `total` frames of clicks into `out` (interleaved stereo, `2 * total` floats, added to) in blocks of
/// `block`, the way the C++ `RenderEngine` mixes them: a count-in of `count_in` frames from transport frame
/// `start` (evenly at the tempo and meter there), else the transport from `start` (one meter: the pulse grid on
/// the tempo map; several: each meter restarts on its bar line). Returns 0, or -1 for invalid arguments.
///
/// # Safety
/// Every pointer is null or valid for its count (`levels` / `level_lengths`: 3 entries); `out` holds
/// `2 * total` floats.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_rs_metronome_render(
    sample_rate: u32,
    bpm: f64,
    numerator: i32,
    denominator: i32,
    tempo_beats: *const f64,
    tempo_bpms: *const f64,
    tempo_ramps: *const u8,
    tempo_count: u32,
    meter_bars: *const i64,
    meter_numerators: *const i32,
    meter_denominators: *const i32,
    meter_count: u32,
    levels: *const *const f32,
    level_lengths: *const usize,
    start: i64,
    count_in: i64,
    block: u32,
    total: u32,
    gain: f32,
    out: *mut f32,
) -> i32 {
    if out.is_null() || levels.is_null() || level_lengths.is_null() || block == 0 || sample_rate == 0 {
        return -1;
    }
    // SAFETY: caller contract.
    let (tb, tm, tr, mb, mn, md, lv, ll, out) = unsafe {
        (
            slice(tempo_beats, tempo_count as usize),
            slice(tempo_bpms, tempo_count as usize),
            slice(tempo_ramps, tempo_count as usize),
            slice(meter_bars, meter_count as usize),
            slice(meter_numerators, meter_count as usize),
            slice(meter_denominators, meter_count as usize),
            slice(levels, 3),
            slice(level_lengths, 3),
            core::slice::from_raw_parts_mut(out, total as usize * 2),
        )
    };
    let mut set = Clicks { sample_rate, levels: Default::default() };
    for ((target, &p), &n) in set.levels.iter_mut().zip(lv).zip(ll) {
        // SAFETY: caller contract.
        *target = Vec::from(unsafe { slice(p, n) });
    }
    let points: Vec<TempoPoint> = tb
        .iter()
        .zip(tm)
        .zip(tr)
        .map(|((&beat, &bpm), &ramp)| TempoPoint { beat, bpm, ramp: ramp != 0 })
        .collect();
    let mapped = points.len() >= 2;
    let tempo = TempoMap::new(bpm, &points);
    let events: Vec<MeterEvent> = mb
        .iter()
        .zip(mn)
        .zip(md)
        .map(|((&bar, &numerator), &denominator)| MeterEvent { bar, numerator, denominator, beat: 0.0 })
        .collect();
    let meters = MeterMap::new(numerator, denominator, &events);
    let rate = f64::from(sample_rate);
    let mut player = Player::default();
    let (mut done, mut position, mut elapsed) = (0u32, start, 0i64);
    while done < total {
        let frames = block.min(total - done);
        let Some(chunk) = out.get_mut(done as usize * 2..(done + frames) as usize * 2) else { return -1 };
        player.mix(&set, chunk, frames, gain);
        if count_in > 0 {
            let start_beat = if mapped {
                tempo.beat_at_frame(position as f64, rate)
            } else {
                position as f64 * bpm / (60.0 * rate)
            };
            let meter = if meters.constant() {
                MeterEvent { bar: 0, numerator, denominator, beat: 0.0 }
            } else {
                meters.at(start_beat)
            };
            let g = grid(
                rate,
                if mapped { tempo.bpm_at(start_beat) } else { bpm },
                meter.numerator,
                meter.denominator,
                None,
            );
            clicks(&g, &set, &mut player, chunk, elapsed, frames, gain, count_in);
            elapsed += i64::from(frames);
        } else if meters.constant() {
            let g = grid(rate, bpm, numerator, denominator, mapped.then_some(&tempo));
            clicks(&g, &set, &mut player, chunk, position, frames, gain, -1);
            position += i64::from(frames);
        } else {
            meter_clicks(
                &meters,
                rate,
                bpm,
                mapped.then_some(&tempo),
                &set,
                &mut player,
                chunk,
                position,
                frames,
                gain,
            );
            position += i64::from(frames);
        }
        done += frames;
    }
    0
}

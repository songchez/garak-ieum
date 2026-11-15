//! Delay lines over caller-provided storage (no allocation): `Ring` (sigimsae_effects.inc `Ring`,
//! kernels.ts `Ring`) and `DelayLine` (dsp.cpp `DelayLine`, stereo with O(1) reset).

use crate::{math, std_clamp};

/// Hands out consecutive regions of one caller-provided `f32` buffer. Running out is recorded
/// (`ok() == false`) instead of panicking; constructors then return `None`.
#[derive(Debug)]
pub struct Carver<'a> {
    rest: &'a mut [f32],
    ok: bool,
    used: usize,
}

impl<'a> Carver<'a> {
    pub fn new(storage: &'a mut [f32]) -> Self {
        Self { rest: storage, ok: true, used: 0 }
    }

    /// The next `n` floats, zeroed.
    pub fn take(&mut self, n: usize) -> &'a mut [f32] {
        match core::mem::take(&mut self.rest).split_at_mut_checked(n) {
            Some((head, tail)) => {
                self.rest = tail;
                self.used += n;
                head.fill(0.0);
                head
            }
            None => {
                self.ok = false;
                &mut []
            }
        }
    }

    pub fn ok(&self) -> bool {
        self.ok
    }

    pub fn used(&self) -> usize {
        self.used
    }
}

/// `(x as usize, that as f64)` for a read position already clamped to `[0, len - 2]` (NaN gives 0,
/// like `as usize`). Goes through `i64`: the signed conversions are single instructions
/// (cvttsd2si / cvtsi2sd), while `usize` <-> `f64` is a multi-instruction sequence on x86-64 that
/// sat on the critical path of every delay-line read. Identical values in this range.
#[inline(always)]
fn split_index(x: f64) -> (usize, f64) {
    let whole = x as i64;
    (whole as usize, whole as f64)
}

/// Float ring; `read(age)` interpolates `age` frames behind the newest pushed frame.
#[derive(Debug)]
pub struct Ring<'a> {
    data: &'a mut [f32],
    write: usize,
}

impl<'a> Ring<'a> {
    /// Storage of a ring of `size` frames (at least 4).
    pub const fn len_for(size: usize) -> usize {
        if size < 4 { 4 } else { size }
    }

    pub fn new(carver: &mut Carver<'a>, size: usize) -> Self {
        Self { data: carver.take(Self::len_for(size)), write: 0 }
    }

    #[inline]
    fn size(&self) -> usize {
        self.data.len()
    }

    #[inline(always)]
    pub fn push(&mut self, x: f32) {
        self.write = if self.write + 1 >= self.size() { 0 } else { self.write + 1 };
        if let Some(slot) = self.data.get_mut(self.write) {
            *slot = x;
        }
    }

    #[inline(always)]
    pub fn read(&self, age: f64) -> f32 {
        let size = self.size();
        if size < 2 {
            return 0.0;
        }
        let age = std_clamp(age, 0.0, (size - 2) as f64);
        let (whole, whole_f) = split_index(age);
        let fraction = age - whole_f;
        let a = (self.write + size - whole) % size;
        let b = if a == 0 { size - 1 } else { a - 1 };
        let av = self.data.get(a).copied().unwrap_or(0.0);
        let bv = self.data.get(b).copied().unwrap_or(0.0);
        math::mul_add(fraction, f64::from(bv - av), f64::from(av)) as f32
    }

    pub fn reset(&mut self) {
        self.data.fill(0.0);
        self.write = 0;
    }

    /// `Ring::takeStateFrom`: swaps buffers when the sizes match (the caller swaps ownership).
    pub fn swap_with(&mut self, previous: &mut Ring<'a>) -> bool {
        if self.size() != previous.size() {
            return false;
        }
        core::mem::swap(&mut self.data, &mut previous.data);
        core::mem::swap(&mut self.write, &mut previous.write);
        true
    }

    pub fn same_size(&self, other: &Ring<'_>) -> bool {
        self.size() == other.size()
    }
}

/// Generation stamps live in the same `f32` storage; integers stay exact below 2^24.
const STAMP_LIMIT: u32 = 1 << 24;

/// Interleaved stereo delay line with fractional reads. `reset` is O(1): frames written before it
/// read as silence (generation stamps), exactly as dsp.cpp `DelayLine`.
#[derive(Debug)]
pub struct DelayLine<'a> {
    data: &'a mut [f32],
    stamps: &'a mut [f32],
    write: usize,
    generation: u32,
}

impl<'a> DelayLine<'a> {
    /// Storage floats for a line of `frames` frames.
    pub const fn len_for(frames: usize) -> usize {
        (frames + 3) * 3
    }

    pub fn new(carver: &mut Carver<'a>, frames: usize) -> Self {
        let data = carver.take((frames + 3) * 2);
        let stamps = carver.take(frames + 3);
        Self { data, stamps, write: 0, generation: 1 }
    }

    #[inline(always)]
    pub fn read(&self, delay: f64, channel: usize) -> f32 {
        let size = self.stamps.len();
        if size < 2 {
            return 0.0;
        }
        let delay = std_clamp(delay, 0.0, (size - 2) as f64);
        let (whole, whole_f) = split_index(delay);
        let a = (self.write + size - whole) % size;
        let b = (a + size - 1) % size;
        let g = self.generation as f32;
        let value = |slot: usize| {
            if self.stamps.get(slot).copied() == Some(g) {
                self.data.get(slot * 2 + channel).copied().unwrap_or(0.0)
            } else {
                0.0
            }
        };
        let (av, bv) = (value(a), value(b));
        av + (delay - whole_f) as f32 * (bv - av)
    }

    #[inline(always)]
    pub fn put(&mut self, left: f32, right: f32) {
        let w = self.write;
        if let Some([l, r]) = self.data.get_mut(w * 2..w * 2 + 2).and_then(|s| s.first_chunk_mut::<2>()) {
            *l = left;
            *r = right;
        }
        if let Some(stamp) = self.stamps.get_mut(w) {
            *stamp = self.generation as f32;
        }
    }

    #[inline(always)]
    pub fn advance(&mut self) {
        self.write += 1;
        if self.write >= self.stamps.len() {
            self.write = 0;
        }
    }

    pub fn reset(&mut self) {
        self.generation += 1;
        if self.generation >= STAMP_LIMIT {
            self.stamps.fill(0.0);
            self.generation = 1;
        }
        self.write = 0;
    }

    pub fn same_size(&self, other: &DelayLine<'_>) -> bool {
        self.data.len() == other.data.len()
    }

    /// Same hand-over as `swap_with`, by copying (when the storage itself must stay put).
    pub fn copy_from(&mut self, previous: &DelayLine<'_>) {
        if self.same_size(previous) {
            self.data.copy_from_slice(previous.data);
            self.stamps.copy_from_slice(previous.stamps);
            self.write = previous.write;
            self.generation = previous.generation;
        }
    }

    /// `DelayLine::takeStateFrom`: swaps buffers when the sizes match.
    pub fn swap_with(&mut self, previous: &mut DelayLine<'a>) -> bool {
        if !self.same_size(previous) {
            return false;
        }
        core::mem::swap(&mut self.data, &mut previous.data);
        core::mem::swap(&mut self.stamps, &mut previous.stamps);
        core::mem::swap(&mut self.write, &mut previous.write);
        core::mem::swap(&mut self.generation, &mut previous.generation);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_reads_interpolated_history() {
        let mut storage = [9.0f32; 8];
        let mut c = Carver::new(&mut storage);
        let mut r = Ring::new(&mut c, 8);
        for x in [1.0, 2.0, 3.0] {
            r.push(x);
        }
        assert_eq!(r.read(0.0), 3.0);
        assert_eq!(r.read(1.0), 2.0);
        assert_eq!(r.read(1.5), 1.5);
        assert_eq!(r.read(3.0), 0.0);
    }

    #[test]
    fn delay_line_reset_silences_history() {
        let mut storage = [5.0f32; DelayLine::len_for(8)];
        let mut c = Carver::new(&mut storage);
        let mut d = DelayLine::new(&mut c, 8);
        assert!(c.ok());
        assert_eq!(d.read(3.0, 0), 0.0);
        for i in 0..4 {
            d.put(i as f32, -(i as f32));
            d.advance();
        }
        d.put(10.0, -10.0);
        assert_eq!(d.read(0.0, 0), 10.0);
        assert_eq!(d.read(2.0, 1), -2.0);
        d.reset();
        assert_eq!(d.read(2.0, 1), 0.0);
    }

    #[test]
    fn carver_reports_shortage() {
        let mut storage = [0.0f32; 4];
        let mut c = Carver::new(&mut storage);
        let _ = c.take(3);
        assert!(c.take(2).is_empty());
        assert!(!c.ok());
    }
}

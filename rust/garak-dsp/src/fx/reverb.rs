//! Convolution reverb: the former C++ DSP (0.3.2) `impulse`, `Fft`, `ConvolutionGroup`, `Convolver`,
//! `Reverb`. The impulse response is synthesised exactly like the C++ (and
//! src/devices/effects/reverb.ts `reverbImpulse`), so a precomputed / cached IR from either side can
//! be handed in instead (`prepare_kernels` takes any IR of `ir_len` frames).
//!
//! Memory: everything lives in caller storage. The *kernel* storage (FFT'd IR partitions + twiddle
//! tables) is immutable after `prepare_kernels` and may be shared by reverbs using the same IR; the
//! *state* storage (input history, overlap buffers, pre-delay) belongs to one reverb.

use super::Kernel;
use crate::biquad::{Biquad, FilterType};
use crate::lines::{Carver, DelayLine};
use crate::math;
use crate::params::{ParamSet, REVERB, index_of};
use crate::{PI, clamp};

const AMOUNT: usize = index_of(REVERB, "amount");
const SIZE: usize = index_of(REVERB, "size");
const TONE: usize = index_of(REVERB, "tone");
const TYPE: usize = index_of(REVERB, "type");
const PREDELAY: usize = index_of(REVERB, "predelay");
const LOWCUT: usize = index_of(REVERB, "lowcut");
const DRY: usize = index_of(REVERB, "dry");

/// Space 0 hall, 1 room, 2 plate, 3 spring: (short seconds, seed, long seconds, seed).
const SPACES: [(f64, u32, f64, u32); 4] =
    [(1.7, 9183, 4.2, 61427), (0.35, 4421, 1.2, 7717), (1.1, 3301, 3.2, 8803), (0.9, 5153, 2.6, 6007)];

/// `type` parameter -> space index (lround, clamped).
pub fn space_of(type_param: f64) -> usize {
    clamp(math::round(type_param), 0.0, 3.0) as usize
}

fn spec(space: usize) -> (f64, u32, f64, u32) {
    SPACES.get(space).copied().unwrap_or(SPACES[0])
}

fn impulse_len(sample_rate: f64, seconds: f64) -> usize {
    math::ceil(sample_rate * seconds) as usize
}

/// Frames of the impulse response of `space` (its long variant).
pub fn ir_len(sample_rate: f64, space: usize) -> usize {
    impulse_len(sample_rate, spec(space).2)
}

/// Scratch floats `generate_ir` needs (the short variant, both channels).
pub fn ir_scratch_len(sample_rate: f64, space: usize) -> usize {
    2 * impulse_len(sample_rate, spec(space).0)
}

/// the former C++ DSP (0.3.2) `impulse()`: seeded noise shaped per space, normalised to a fixed RMS.
fn impulse(sample_rate: f64, mut seed: u32, space: usize, left: &mut [f32], right: &mut [f32]) {
    let length = left.len().min(right.len());
    let comb = math::floor(0.0293 * sample_rate + 0.5) as usize;
    let mut power = 0.0f64;
    for channel in [&mut *left, &mut *right] {
        let (mut previous, mut dark) = (0.0f64, 0.0f64);
        for i in 0..length {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let noise = f64::from(seed) / 4_294_967_295.0 * 2.0 - 1.0;
            let t = i as f64 / length as f64;
            let value = match space {
                0 => (noise * math::pow(1.0 - t, 3.6)) as f32,
                1 => (noise * math::pow(1.0 - t, 4.5)) as f32,
                2 => ((noise - 0.65 * previous) * math::pow(1.0 - t, 2.4)) as f32,
                _ => {
                    dark += 0.45 * (noise - dark);
                    let echo = if i >= comb {
                        0.55 * f64::from(channel.get(i - comb).copied().unwrap_or(0.0))
                    } else {
                        0.0
                    };
                    (dark * math::pow(1.0 - t, 3.0) + echo) as f32
                }
            };
            if let Some(slot) = channel.get_mut(i) {
                *slot = value;
            }
            previous = noise;
            power += f64::from(value) * f64::from(value);
        }
    }
    let power = math::sqrt(power / (length * 2) as f64).max(0.000125);
    let scale = (0.00125 / power * 44100.0 / sample_rate) as f32;
    for v in left.iter_mut().take(length).chain(right.iter_mut().take(length)) {
        *v *= scale;
    }
}

/// The reverb's impulse response for `space` and `size` (the former C++ DSP (0.3.2) `Reverb` constructor): the long
/// and short variants cross-faded by size. `left` / `right` hold `ir_len` frames, `scratch`
/// `ir_scratch_len` floats. Returns false (and leaves the output untouched) when a buffer is short.
pub fn generate_ir(
    sample_rate: f64,
    space: usize,
    size: f64,
    left: &mut [f32],
    right: &mut [f32],
    scratch: &mut [f32],
) -> bool {
    let (short_seconds, short_seed, long_seconds, long_seed) = spec(space);
    let long = impulse_len(sample_rate, long_seconds);
    let short = impulse_len(sample_rate, short_seconds);
    let (Some(left), Some(right), Some((small_l, rest))) =
        (left.get_mut(..long), right.get_mut(..long), scratch.split_at_mut_checked(short))
    else {
        return false;
    };
    let Some(small_r) = rest.get_mut(..short) else { return false };
    impulse(sample_rate, long_seed, space, left, right);
    impulse(sample_rate, short_seed, space, small_l, small_r);
    let size = size as f32;
    for (large, small) in [(left, &*small_l), (right, &*small_r)] {
        for (i, v) in large.iter_mut().enumerate() {
            *v = *v * size + small.get(i).map_or(0.0, |s| s * (1.0 - size));
        }
    }
    true
}

type C32 = [f32; 2];

#[inline]
fn cmul(a: C32, b: C32) -> C32 {
    [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]]
}

/// Radix-2 FFT of `n = roots.len() * 2` points (the former C++ DSP (0.3.2) `Fft::run`).
fn fft(data: &mut [C32], roots: &[C32], inverse: bool) {
    let n = data.len();
    if n < 2 || !n.is_power_of_two() {
        return;
    }
    let bits = n.trailing_zeros();
    for i in 0..n {
        let j = (i as u32).reverse_bits().wrapping_shr(32 - bits) as usize;
        if j > i && j < n {
            data.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let half = len / 2;
        let stride = n / len;
        for chunk in data.chunks_exact_mut(len) {
            let (even, odd) = chunk.split_at_mut(half);
            for ((e, o), root) in even.iter_mut().zip(odd.iter_mut()).zip(roots.iter().step_by(stride)) {
                let root = if inverse { [root[0], -root[1]] } else { *root };
                let odd_v = cmul(*o, root);
                let even_v = *e;
                *e = [even_v[0] + odd_v[0], even_v[1] + odd_v[1]];
                *o = [even_v[0] - odd_v[0], even_v[1] - odd_v[1]];
            }
        }
        len <<= 1;
    }
    if inverse {
        let scale = n as f32;
        for x in data {
            x[0] /= scale;
            x[1] /= scale;
        }
    }
}

/// One uniformly partitioned FFT convolution group: IR frames `[offset, offset + len)` in
/// partitions of `block`, output scheduled `base` frames after the input (no added latency).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct GroupSpec {
    offset: usize,
    len: usize,
    base: usize,
    block: usize,
    count: usize,
}

impl GroupSpec {
    const fn n(&self) -> usize {
        self.block * 2
    }
    const fn kernel_floats(&self) -> usize {
        self.n() + self.count * self.n() * 2
    }
    const fn output_len(&self) -> usize {
        self.base + 3 * self.block
    }
    const fn state_floats(&self) -> usize {
        self.count * self.n() * 2 + self.count + 4 * self.n() + 2 * self.output_len()
    }
}

const HEAD: usize = 64;

/// the former C++ DSP (0.3.2) `Convolver`: 64-tap direct head, then groups at 64 / 512 / 4096 frames.
fn group_specs(ir_len: usize) -> [Option<GroupSpec>; 3] {
    let make = |offset: usize, max: usize, block: usize| {
        (ir_len > offset).then(|| {
            let len = (ir_len - offset).min(max);
            GroupSpec { offset, len, base: offset, block, count: len.div_ceil(block) }
        })
    };
    [make(64, 448, 64), make(512, 3584, 512), make(4096, usize::MAX, 2048)]
}

fn channel_kernel_floats(ir_len: usize) -> usize {
    HEAD + group_specs(ir_len).iter().flatten().map(GroupSpec::kernel_floats).sum::<usize>()
}

fn channel_state_floats(ir_len: usize) -> usize {
    group_specs(ir_len).iter().flatten().map(GroupSpec::state_floats).sum()
}

/// Kernel storage floats (both channels) for an IR of `ir_len` frames.
pub fn kernel_len(ir_len: usize) -> usize {
    2 * channel_kernel_floats(ir_len)
}

fn predelay_frames(sample_rate: f64) -> usize {
    (sample_rate * 0.25) as usize + 4
}

/// State storage floats of one reverb.
pub fn state_len(sample_rate: f64, ir_len: usize) -> usize {
    2 * channel_state_floats(ir_len) + DelayLine::len_for(predelay_frames(sample_rate))
}

/// FFTs the IR partitions and twiddles into `out` (`kernel_len(ir_len)` floats). Control thread
/// only (this is the reverb's heavy initialisation). False when a buffer is too short.
pub fn prepare_kernels(left: &[f32], right: &[f32], ir_len: usize, out: &mut [f32]) -> bool {
    let (Some(left), Some(right)) = (left.get(..ir_len), right.get(..ir_len)) else { return false };
    let per = channel_kernel_floats(ir_len);
    let Some((out_l, rest)) = out.split_at_mut_checked(per) else { return false };
    let Some(out_r) = rest.get_mut(..per) else { return false };
    for (ir, out) in [(left, out_l), (right, out_r)] {
        let (head, mut rest) = out.split_at_mut(HEAD.min(out.len()));
        head.fill(0.0);
        for (h, x) in head.iter_mut().zip(ir) {
            *h = *x;
        }
        for g in group_specs(ir_len).into_iter().flatten() {
            let n = g.n();
            let Some((region, tail)) = core::mem::take(&mut rest).split_at_mut_checked(g.kernel_floats())
            else {
                return false;
            };
            rest = tail;
            let (roots, kernels) = region.split_at_mut(n);
            for (i, root) in roots.as_chunks_mut::<2>().0.iter_mut().enumerate() {
                let theta = (-2.0 * PI * i as f64 / n as f64) as f32;
                *root = [math::cosf(theta), math::sinf(theta)];
            }
            let roots = roots.as_chunks::<2>().0;
            let segment = ir.get(g.offset..g.offset + g.len).unwrap_or(&[]);
            for (p, kernel) in kernels.as_chunks_mut::<2>().0.chunks_exact_mut(n).enumerate() {
                for (i, k) in kernel.iter_mut().enumerate() {
                    let source = if i < g.block { segment.get(p * g.block + i).copied() } else { None };
                    *k = [source.unwrap_or(0.0), 0.0];
                }
                fft(kernel, roots, false);
            }
        }
    }
    true
}

const STAMP_LIMIT: u32 = 1 << 24;

#[derive(Debug)]
struct Group<'a> {
    spec: GroupSpec,
    roots: &'a [C32],
    kernels: &'a [C32],
    history: &'a mut [C32],
    history_generation: &'a mut [f32],
    input: &'a mut [C32],
    sum: &'a mut [C32],
    output: &'a mut [f32],
    output_generation: &'a mut [f32],
    input_fill: usize,
    history_write: usize,
    output_read: usize,
    generation: u32,
}

fn take_complex<'a>(carver: &mut Carver<'a>, n: usize) -> &'a mut [C32] {
    carver.take(n * 2).as_chunks_mut::<2>().0
}

impl<'a> Group<'a> {
    fn new(spec: GroupSpec, kernel_region: &'a [f32], carver: &mut Carver<'a>) -> Self {
        let n = spec.n();
        let (roots, kernels) = kernel_region.split_at(n.min(kernel_region.len()));
        Self {
            spec,
            roots: roots.as_chunks::<2>().0,
            kernels: kernels.as_chunks::<2>().0,
            history: take_complex(carver, spec.count * n),
            history_generation: carver.take(spec.count),
            input: take_complex(carver, n),
            sum: take_complex(carver, n),
            output: carver.take(spec.output_len()),
            output_generation: carver.take(spec.output_len()),
            input_fill: 0,
            history_write: 0,
            output_read: 0,
            generation: 1,
        }
    }

    #[inline(always)]
    fn sample(&mut self, x: f32) -> f32 {
        let GroupSpec { block, base, count, .. } = self.spec;
        let n = self.spec.n();
        let size = self.output.len();
        if size == 0 || count == 0 {
            return 0.0;
        }
        let g = self.generation as f32;
        let read = self.output_read;
        let result = match (self.output_generation.get_mut(read), self.output.get(read)) {
            (Some(stamp), Some(value)) => {
                let r = if *stamp == g { *value } else { 0.0 };
                *stamp = 0.0;
                r
            }
            _ => 0.0,
        };
        if let Some(slot) = self.input.get_mut(self.input_fill) {
            *slot = [x, 0.0];
        }
        self.input_fill += 1;
        if self.input_fill == block {
            if let Some(upper) = self.input.get_mut(block..) {
                upper.fill([0.0, 0.0]);
            }
            fft(self.input, self.roots, false);
            let hw = self.history_write;
            if let Some(dest) = self.history.get_mut(hw * n..hw * n + n) {
                dest.copy_from_slice(self.input);
            }
            if let Some(stamp) = self.history_generation.get_mut(hw) {
                *stamp = g;
            }
            self.sum.fill([0.0, 0.0]);
            for p in 0..count {
                let slot = (hw + count - p) % count;
                if self.history_generation.get(slot).copied() != Some(g) {
                    continue;
                }
                let (Some(xs), Some(hs)) =
                    (self.history.get(slot * n..slot * n + n), self.kernels.get(p * n..p * n + n))
                else {
                    continue;
                };
                for ((s, x), h) in self.sum.iter_mut().zip(xs).zip(hs) {
                    let m = cmul(*x, *h);
                    s[0] += m[0];
                    s[1] += m[1];
                }
            }
            fft(self.sum, self.roots, true);
            let start = (read + 1 + base - block) % size;
            for (j, s) in self.sum.iter().enumerate() {
                let slot = (start + j) % size;
                if let (Some(stamp), Some(out)) =
                    (self.output_generation.get_mut(slot), self.output.get_mut(slot))
                {
                    if *stamp != g {
                        *out = 0.0;
                        *stamp = g;
                    }
                    *out += s[0];
                }
            }
            self.history_write = (hw + 1) % count;
            self.input_fill = 0;
        }
        self.output_read = (read + 1) % size;
        result
    }

    fn reset(&mut self) {
        self.generation += 1;
        if self.generation >= STAMP_LIMIT {
            self.history_generation.fill(0.0);
            self.output_generation.fill(0.0);
            self.generation = 1;
        }
        self.input_fill = 0;
        self.history_write = 0;
        self.output_read = 0;
    }

    fn counters_from(&mut self, p: &Group<'_>) {
        self.input_fill = p.input_fill;
        self.history_write = p.history_write;
        self.output_read = p.output_read;
        self.generation = p.generation;
    }

    fn swap_with(&mut self, p: &mut Group<'a>) {
        core::mem::swap(&mut self.history, &mut p.history);
        core::mem::swap(&mut self.history_generation, &mut p.history_generation);
        core::mem::swap(&mut self.input, &mut p.input);
        core::mem::swap(&mut self.sum, &mut p.sum);
        core::mem::swap(&mut self.output, &mut p.output);
        core::mem::swap(&mut self.output_generation, &mut p.output_generation);
        core::mem::swap(&mut self.input_fill, &mut p.input_fill);
        core::mem::swap(&mut self.history_write, &mut p.history_write);
        core::mem::swap(&mut self.output_read, &mut p.output_read);
        core::mem::swap(&mut self.generation, &mut p.generation);
    }

    fn copy_from(&mut self, p: &Group<'_>) {
        self.history.copy_from_slice(p.history);
        self.history_generation.copy_from_slice(p.history_generation);
        self.input.copy_from_slice(p.input);
        self.output.copy_from_slice(p.output);
        self.output_generation.copy_from_slice(p.output_generation);
        self.counters_from(p);
    }
}

#[derive(Debug)]
struct Convolver<'a> {
    head: [f32; HEAD],
    history: [f32; HEAD],
    write: usize,
    groups: [Option<Group<'a>>; 3],
}

impl<'a> Convolver<'a> {
    fn new(ir_len: usize, kernels: &'a [f32], carver: &mut Carver<'a>) -> Self {
        let mut head = [0.0; HEAD];
        let (h, mut rest) = kernels.split_at(HEAD.min(kernels.len()));
        for (d, s) in head.iter_mut().zip(h) {
            *d = *s;
        }
        let specs = group_specs(ir_len);
        let mut groups = [None, None, None];
        for (slot, spec) in groups.iter_mut().zip(specs) {
            if let Some(spec) = spec {
                let (region, tail) = rest.split_at(spec.kernel_floats().min(rest.len()));
                rest = tail;
                *slot = Some(Group::new(spec, region, carver));
            }
        }
        Self { head, history: [0.0; HEAD], write: 0, groups }
    }

    #[inline(always)]
    fn sample(&mut self, x: f32) -> f32 {
        let w = self.write;
        if let Some(slot) = self.history.get_mut(w) {
            *slot = x;
        }
        // history[(write + 64 - i) % 64] for i = 0..64: newest first.
        let (upto, after) = self.history.split_at(w + 1);
        let mut out = 0.0f64;
        for (h, s) in self.head.iter().zip(upto.iter().rev().chain(after.iter().rev())) {
            out += f64::from(h * s);
        }
        self.write = (w + 1) % HEAD;
        for g in self.groups.iter_mut().flatten() {
            out += f64::from(g.sample(x));
        }
        out as f32
    }

    fn reset(&mut self) {
        self.history = [0.0; HEAD];
        self.write = 0;
        for g in self.groups.iter_mut().flatten() {
            g.reset();
        }
    }

    fn same_layout(&self, p: &Convolver<'_>) -> bool {
        self.groups
            .iter()
            .zip(p.groups.iter())
            .all(|(a, b)| a.as_ref().map(|g| g.spec) == b.as_ref().map(|g| g.spec))
    }

    /// `Convolver::takeStateFrom` (only when the group layout matches). `whole`: swap the state
    /// views (the owner then swaps the storage), else copy.
    fn take_state_from(&mut self, pc: &mut Convolver<'a>, whole: bool) {
        let groups_match = self.groups.iter().flatten().count() == pc.groups.iter().flatten().count();
        if !groups_match {
            return;
        }
        self.history = pc.history;
        self.write = pc.write;
        for (g, pg) in self.groups.iter_mut().zip(pc.groups.iter_mut()) {
            if let (Some(g), Some(pg)) = (g, pg)
                && g.spec.block == pg.spec.block
                && g.spec.base == pg.spec.base
                && g.spec.count == pg.spec.count
            {
                if whole { g.swap_with(pg) } else { g.copy_from(pg) }
            }
        }
    }
}

/// A reverb's two convolvers without its pre-delay, filters and mix (the guitar rig's plate,
/// the former C++ DSP (0.3.2) `RigReverb`). Kernels from `prepare_kernels`, state from the caller's storage.
#[derive(Debug)]
pub(crate) struct StereoConvolver<'a> {
    channels: [Convolver<'a>; 2],
}

impl<'a> StereoConvolver<'a> {
    /// State floats of both channels for an IR of `ir_len` frames.
    pub(crate) fn state_len(ir_len: usize) -> usize {
        2 * channel_state_floats(ir_len)
    }

    pub(crate) fn new(ir_len: usize, kernels: &'a [f32], carver: &mut Carver<'a>) -> Self {
        let per = channel_kernel_floats(ir_len);
        let (kl, rest) = kernels.split_at(per.min(kernels.len()));
        let kr = rest.get(..per).unwrap_or(&[]);
        Self { channels: [Convolver::new(ir_len, kl, carver), Convolver::new(ir_len, kr, carver)] }
    }

    #[inline(always)]
    pub(crate) fn sample(&mut self, x: f32, channel: usize) -> f32 {
        let [l, r] = &mut self.channels;
        if channel == 0 { l.sample(x) } else { r.sample(x) }
    }

    pub(crate) fn reset(&mut self) {
        for c in &mut self.channels {
            c.reset();
        }
    }

    pub(crate) fn same_layout(&self, p: &StereoConvolver<'_>) -> bool {
        self.channels.iter().zip(p.channels.iter()).all(|(a, b)| a.same_layout(b))
    }

    /// Both channels' `Convolver::takeStateFrom`; `whole` as for the reverb.
    pub(crate) fn take_state_from(&mut self, p: &mut StereoConvolver<'a>, whole: bool) {
        for (c, pc) in self.channels.iter_mut().zip(p.channels.iter_mut()) {
            c.take_state_from(pc, whole);
        }
    }
}

/// Convolution reverb with pre-delay, tone low-pass and optional low cut. Size, type and
/// pre-delay shape the prepared impulse response; amount, dry, tone and low cut follow automation.
#[derive(Debug)]
pub struct Reverb<'a> {
    sample_rate: f64,
    channels: [Convolver<'a>; 2],
    tone: Biquad,
    highpass: Biquad,
    wet: f64,
    dry: f64,
    tail: f64,
    predelay: DelayLine<'a>,
    delay_frames: f64,
    lowcut: bool,
}

impl<'a> Reverb<'a> {
    /// `kernels` comes from `prepare_kernels` for an IR of `ir_len` frames (for this reverb's
    /// type, size and sample rate). `carver` provides `state_len(sample_rate, ir_len)` floats.
    pub fn new(
        sample_rate: f64,
        p: &ParamSet,
        kernels: &'a [f32],
        ir_len: usize,
        carver: &mut Carver<'a>,
    ) -> Self {
        let per = channel_kernel_floats(ir_len);
        let (kl, rest) = kernels.split_at(per.min(kernels.len()));
        let kr = rest.get(..per).unwrap_or(&[]);
        let channels = [Convolver::new(ir_len, kl, carver), Convolver::new(ir_len, kr, carver)];
        let predelay = DelayLine::new(carver, predelay_frames(sample_rate));
        let (short, _, long, _) = spec(space_of(p.get(TYPE)));
        let mut s = Self {
            sample_rate,
            channels,
            tone: Biquad::new(),
            highpass: Biquad::new(),
            wet: p.get(AMOUNT) * 0.5,
            dry: p.get(DRY),
            tail: 0.85 + short + p.get(SIZE) * (long - short) + p.get(PREDELAY) * 0.001,
            predelay,
            delay_frames: p.get(PREDELAY) * 0.001 * sample_rate,
            lowcut: p.get(LOWCUT) > 20.5,
        };
        s.tone.configure(FilterType::Lowpass, sample_rate, p.get(TONE), 1.0, 0.0);
        s.highpass.configure(FilterType::Highpass, sample_rate, p.get(LOWCUT), 0.5, 0.0);
        s
    }

    /// `kernels` must have been checked to hold `kernel_len(ir_len)` floats (for `Fx::new`).
    pub fn kernels_fit(kernels: &[f32], ir_len: usize) -> bool {
        kernels.len() >= kernel_len(ir_len)
    }

    pub fn take_state_from(&mut self, p: &mut Self) -> bool {
        let whole = self.channels.iter().zip(p.channels.iter()).all(|(a, b)| a.same_layout(b))
            && self.predelay.same_size(&p.predelay);
        for (c, pc) in self.channels.iter_mut().zip(p.channels.iter_mut()) {
            c.take_state_from(pc, whole);
        }
        self.tone.take_history_from(&p.tone);
        self.highpass.take_history_from(&p.highpass);
        if whole {
            self.predelay.swap_with(&mut p.predelay);
        } else {
            self.predelay.copy_from(&p.predelay);
        }
        whole
    }
}

impl Kernel for Reverb<'_> {
    fn automate(&mut self, p: &ParamSet) {
        self.wet = p.get(AMOUNT) * 0.5;
        self.dry = p.get(DRY);
        self.lowcut = p.get(LOWCUT) > 20.5;
        self.tone.retarget(FilterType::Lowpass, self.sample_rate, p.get(TONE), 1.0, 0.0);
        self.highpass.retarget(FilterType::Highpass, self.sample_rate, p.get(LOWCUT), 0.5, 0.0);
    }

    #[inline(always)]
    fn frame(&mut self, l: f32, r: f32) -> (f32, f32) {
        let mut input = [l, r];
        if self.delay_frames > 0.0 {
            self.predelay.put(l, r);
            input = [self.predelay.read(self.delay_frames, 0), self.predelay.read(self.delay_frames, 1)];
            self.predelay.advance();
        }
        let mut out = [l, r];
        for (c, ((o, x), conv)) in out.iter_mut().zip(input).zip(self.channels.iter_mut()).enumerate() {
            let mut wet = self.tone.sample(conv.sample(x), c);
            if self.lowcut {
                wet = self.highpass.sample(wet, c);
            }
            // dry = 1 must stay bit-identical to the former `s += wet` (float sum of the two terms).
            *o = (self.dry * f64::from(*o)) as f32 + (self.wet * f64::from(wet)) as f32;
        }
        (out[0], out[1])
    }

    fn reset(&mut self) {
        for c in &mut self.channels {
            c.reset();
        }
        self.tone.reset();
        self.highpass.reset();
        self.predelay.reset();
    }

    fn tail_seconds(&self) -> f64 {
        if self.wet > 0.0 { self.tail } else { 0.0 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::vec;

    #[test]
    fn fft_round_trips() {
        let n = 16;
        let mut roots = vec![[0.0f32; 2]; n / 2];
        for (i, r) in roots.iter_mut().enumerate() {
            let theta = (-2.0 * PI * i as f64 / n as f64) as f32;
            *r = [math::cosf(theta), math::sinf(theta)];
        }
        let original: std::vec::Vec<C32> = (0..n).map(|i| [i as f32 * 0.1 - 0.4, 0.0]).collect();
        let mut data = original.clone();
        fft(&mut data, &roots, false);
        // DC bin = sum.
        let sum: f32 = original.iter().map(|c| c[0]).sum();
        assert!((data[0][0] - sum).abs() < 1e-5);
        fft(&mut data, &roots, true);
        for (a, b) in data.iter().zip(&original) {
            assert!((a[0] - b[0]).abs() < 1e-5 && a[1].abs() < 1e-5);
        }
    }

    #[test]
    fn convolver_matches_direct_convolution() {
        // A short IR spanning the head and the first two groups.
        let ir_len: usize = 1200;
        let ir: std::vec::Vec<f32> =
            (0..ir_len).map(|i| math::sinf(i as f32 * 0.37) * 0.999f32.powi(i as i32)).collect();
        let mut kernels = vec![0.0f32; kernel_len(ir_len)];
        assert!(prepare_kernels(&ir, &ir, ir_len, &mut kernels));
        let mut state = vec![0.0f32; 2 * channel_state_floats(ir_len)];
        let mut carver = Carver::new(&mut state);
        let mut conv = Convolver::new(ir_len, &kernels[..channel_kernel_floats(ir_len)], &mut carver);
        assert!(carver.ok());
        let input: std::vec::Vec<f32> = (0..3000).map(|i| if i % 97 == 0 { 1.0 } else { 0.0 }).collect();
        let mut worst = 0.0f32;
        for (t, &x) in input.iter().enumerate() {
            let y = conv.sample(x);
            let mut expected = 0.0f32;
            for (k, h) in ir.iter().enumerate().take(t + 1) {
                expected += h * input[t - k];
            }
            worst = worst.max((y - expected).abs());
        }
        assert!(worst < 1e-4, "{worst}");
    }

    #[test]
    fn generated_ir_is_normalised() {
        let sr = 8000.0;
        let len = ir_len(sr, 1);
        let (mut l, mut r, mut scratch) =
            (vec![0.0f32; len], vec![0.0f32; len], vec![0.0f32; ir_scratch_len(sr, 1)]);
        assert!(generate_ir(sr, 1, 1.0, &mut l, &mut r, &mut scratch));
        let rms = math::sqrt(
            l.iter().chain(&r).map(|v| f64::from(*v) * f64::from(*v)).sum::<f64>() / (2 * len) as f64,
        );
        assert!((rms - 0.00125 * 44100.0 / sr).abs() < 1e-6, "{rms}");
        assert!(!generate_ir(sr, 1, 1.0, &mut l[..10], &mut r, &mut scratch));
    }
}

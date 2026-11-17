//! Host-driven rendering for the desktop C++ shell (`GARAK_RUST_ENGINE=1`, docs/RUST_ENGINE.md 10).
//!
//! The C++ `RenderEngine` keeps the transport (play/stop/seek, cycle wrap, count-in), metronome,
//! live MIDI, input capture, master bus and snapshot; for a graph the Rust engine accepted it asks
//! this renderer for the track mix of each block at the shell's position. Commands are applied up
//! to a ticket the shell names, so a Rust graph swap lands in the same block as the shell's own
//! graph command. Senders may render on the host's worker pool ([`Parallel`]): they are
//! independent, so each renders on one worker; returns follow on the calling thread, and the mix
//! is summed in track order — bit-identical to the single-threaded path.

use core::ffi::c_void;

use super::{Graph, Renderer};

/// One task of a parallel job: render item `index` of `job`.
pub type HostTask = unsafe extern "C" fn(job: *mut c_void, index: u32);

/// The host's worker pool. `run(host, count, task, job)` calls `task(job, i)` once for every
/// `i < count` (any thread, any order) and returns when all calls completed. It must not allocate
/// or lock on the audio thread (the C++ `WorkerPool::run` spins on atomics).
#[derive(Clone, Copy, Debug)]
pub struct Parallel {
    pub run: unsafe extern "C" fn(host: *mut c_void, count: u32, task: HostTask, job: *mut c_void),
    pub host: *mut c_void,
}

/// One dynamics meter reading (C++ `EngineSnapshot::DynamicsReading`; `#[repr(C)]` for the C ABI).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DynamicsReading {
    pub track: u16,
    /// Index of the insert in the track plan.
    pub insert: u16,
    pub input: f32,
    pub gain: f32,
}

struct Job {
    graph: *mut Graph,
    position: i64,
    count: u32,
    playing: bool,
    tempo: Option<f64>,
}

unsafe extern "C" fn render_sender(job: *mut c_void, index: u32) {
    // SAFETY: `job` is the `Job` on `render_parallel`'s stack, alive until `run` returns. Each index
    // names a distinct entry of `order` (a permutation of the tracks), so every call has exclusive
    // access to one boxed track, and nothing else touches the tracks while the job runs. Only raw
    // pointers are formed to the graph itself, so concurrent calls never alias a `&mut Graph`.
    unsafe {
        let job = &*(job as *const Job);
        let g = job.graph;
        let order = &(*g).order;
        let Some(&track) = order.get(index as usize) else { return };
        let tracks = &raw mut (*g).tracks;
        if track < (*tracks).len() {
            let t: *mut alloc::boxed::Box<crate::track::Track> = (*tracks).as_mut_ptr().add(track);
            (**t).render(job.position, job.count, job.playing, job.tempo);
        }
    }
}

/// Renders the leading senders of `g.order` on the host's workers and returns how many it rendered
/// (0 when fewer than two: the caller renders everything). Returns read the senders' taps, so they
/// stay on the calling thread afterwards.
pub(super) fn render_parallel(
    g: &mut Graph,
    p: &Parallel,
    position: i64,
    count: u32,
    playing: bool,
    tempo: Option<f64>,
) -> usize {
    let senders = g.order.iter().take_while(|&&i| g.tracks.get(i).is_some_and(|t| !t.is_return)).count();
    if senders < 2 {
        return 0;
    }
    let mut job = Job { graph: g as *mut Graph, position, count, playing, tempo };
    // SAFETY: the host contract above; `job` outlives the call.
    unsafe { (p.run)(p.host, senders as u32, render_sender, (&raw mut job).cast()) };
    senders
}

impl Renderer {
    /// One host-driven block (audio thread): applies queued commands up to `allowed` (a ticket from
    /// `Controller::ticket`), then renders the track mix of `out.len() / 2` frames at project frame
    /// `position` (already cycle-split by the host; `playing` as the shell decided it) into `out`,
    /// without the master gain or master processor (the shell owns the master bus). `peaks` receives
    /// each track's last block peak. Real-time safe like `render`.
    pub fn render_block(
        &mut self,
        out: &mut [f32],
        position: i64,
        playing: bool,
        allowed: u64,
        peaks: &mut [f32],
        parallel: Option<&Parallel>,
    ) {
        self.consume_until(allowed);
        let rate = f64::from(self.config.sample_rate);
        let step = (self.config.max_block as usize * 2).max(2);
        let mut at = position;
        let mut peak = 0.0f32;
        for block in out.chunks_mut(step) {
            block.fill(0.0);
            let count = (block.len() / 2) as u32;
            if let Some(g) = &mut self.active {
                let audible = playing && at < g.length_frames;
                Self::render_tracks(g, block, at, count, audible, rate, parallel);
            }
            for x in block.iter_mut() {
                if !x.is_finite() {
                    *x = 0.0;
                }
                if peak < x.abs() {
                    peak = x.abs();
                }
            }
            if playing {
                at += i64::from(count);
            }
        }
        if let Some(g) = &self.active {
            for (p, t) in peaks.iter_mut().zip(&g.tracks) {
                *p = t.peak;
            }
        }
        self.position = at;
        self.playing = playing;
        self.publish(peak);
    }

    /// The shell's transport reset (audio thread): automation cursors and fader state, and with
    /// `effects` also effect tails, delay lines and the master state (C++ `Impl::reset`).
    pub fn host_reset(&mut self, effects: bool) {
        self.reset(effects);
    }

    /// Dynamics meters (audio thread, after `render_block`): each compressor/limiter/gate insert's
    /// detector peak and lowest gain since the last call, in track then chain order (C++
    /// `publishDynamics`). Returns how many readings it wrote.
    pub fn take_dynamics(&mut self, out: &mut [DynamicsReading]) -> usize {
        let Some(g) = &mut self.active else { return 0 };
        let mut n = 0;
        for (index, t) in g.tracks.iter_mut().enumerate().take(65_535) {
            for insert in &mut t.inserts {
                let Some((peak, gain)) = insert.take_meter() else { continue };
                let Some(slot) = out.get_mut(n) else { return n };
                *slot = DynamicsReading { track: index as u16, insert: insert.source, input: peak, gain };
                n += 1;
            }
        }
        n
    }

    /// Applies queued commands up to `allowed` without rendering.
    pub fn host_consume(&mut self, allowed: u64) {
        self.consume_until(allowed);
    }
}

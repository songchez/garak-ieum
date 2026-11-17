//! Host-driven rendering for the desktop C++ shell (`GARAK_RUST_ENGINE=1`, docs/RUST_ENGINE.md 10).
//!
//! The C++ `RenderEngine` keeps the transport (play/stop/seek, cycle wrap, count-in), metronome,
//! live MIDI, input capture, master bus and snapshot; for a graph the Rust engine accepted it asks
//! this renderer for the track mix of each block at the shell's position. Commands are applied up
//! to a ticket the shell names, so a Rust graph swap lands in the same block as the shell's own
//! graph command. The tracks of one processing level may render on the host's worker pool
//! ([`Parallel`]): they are independent, so each renders on one worker; the next level (routed tracks,
//! returns) follows once they all finished, and the mix is summed in track order — bit-identical to
//! the single-threaded path.
//!
//! VST3 and IEUM WAVE stay host processors (docs/RUST_ENGINE.md 4): the graph calls the host back at
//! their place in each chain ([`HostCallbacks`]), and asks it for monitored device input.

use core::ffi::c_void;

use super::{Graph, Renderer};
use crate::external::{HostCallbacks, Io, Stage};

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

/// What the shell knows about one block besides its frames (`GarakRsBlock` in garak_engine.h).
#[derive(Clone, Copy, Debug)]
pub struct BlockInfo<'a> {
    /// Project frame of the block start (the shell already split it at the cycle end).
    pub position: i64,
    pub playing: bool,
    /// Apply queued commands up to this ticket first.
    pub allowed: u64,
    /// The shell's master gain at the block start and its target: master-resampling routes hear the tracks
    /// through it (the shell applies the same smoothing to the output afterwards).
    pub master_gain: f32,
    pub target_master_gain: f32,
    /// Monitored tracks (bit `i` of word `i / 64`).
    pub monitor: [u64; 4],
    /// VST3 / IEUM WAVE processors and device input; None renders host nodes as silence (sources) or
    /// pass-through (inserts).
    pub host: Option<&'a HostCallbacks>,
    /// Per track (may be shorter than the track list): this block's output of a track the shell renders ahead
    /// ([`Ahead`](super::Ahead)), or null. Each non-null entry must hold the block's frames and stay valid and
    /// unchanged for the call; the graph neither renders nor resets those tracks.
    pub ahead: &'a [*const f32],
}

struct Job {
    graph: *mut Graph,
    level: usize,
    position: i64,
    count: u32,
    playing: bool,
    tempo: Option<f64>,
    io: *const Io<'static>,
}

unsafe extern "C" fn render_item(job: *mut c_void, index: u32) {
    // SAFETY: `job` is the `Job` on `render_level`'s stack, alive until `run` returns. Each index names a
    // distinct entry of one level (a level lists each track once), so every call has exclusive access to one
    // boxed track, and nothing else touches the tracks while the job runs. Only raw pointers are formed to
    // the graph itself, so concurrent calls never alias a `&mut Graph`. `io` is read-only and outlives the job.
    unsafe {
        let job = &*(job as *const Job);
        let g = job.graph;
        let Some(&track) = (*g).levels.level(job.level).get(index as usize) else { return };
        if (*job.io).ahead_mix(track, job.count).is_some() {
            return; // The host renders it ahead.
        }
        let tracks = &raw mut (*g).tracks;
        if track < (*tracks).len() {
            let t: *mut alloc::boxed::Box<crate::track::Track> = (*tracks).as_mut_ptr().add(track);
            (**t).render(job.position, job.count, job.playing, job.tempo, &*job.io);
        }
    }
}

/// Renders the tracks of processing level `level` on the host's workers. Returns false (nothing rendered)
/// when the level holds fewer than two tracks: the caller renders it.
#[allow(clippy::too_many_arguments)]
pub(super) fn render_level(
    g: &mut Graph,
    p: &Parallel,
    level: usize,
    position: i64,
    count: u32,
    playing: bool,
    tempo: Option<f64>,
    io: &Io,
) -> bool {
    let size = g.levels.level(level).len();
    if size < 2 {
        return false;
    }
    let io: *const Io<'static> = (io as *const Io).cast();
    let mut job = Job { graph: g as *mut Graph, level, position, count, playing, tempo, io };
    // SAFETY: the host contract above; `job` (and the `Io` it points to) outlive the call.
    unsafe { (p.run)(p.host, size as u32, render_item, (&raw mut job).cast()) };
    true
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
        let info = BlockInfo {
            position,
            playing,
            allowed,
            master_gain: self.master_gain,
            target_master_gain: self.target_master_gain,
            monitor: [0; 4],
            host: None,
            ahead: &[],
        };
        self.render_host(out, &info, peaks, parallel);
    }

    /// [`render_block`](Self::render_block) with the shell's master gain, monitoring and host callbacks.
    pub fn render_host(
        &mut self,
        out: &mut [f32],
        info: &BlockInfo,
        peaks: &mut [f32],
        parallel: Option<&Parallel>,
    ) {
        // Graph swaps reset or continue tracks at the shell's position.
        self.position = info.position;
        self.playing = info.playing;
        self.consume_until(info.allowed);
        let rate = f64::from(self.config.sample_rate);
        let step = (self.config.max_block as usize * 2).max(2);
        let io = Io {
            host: info.host,
            monitor: info.monitor,
            offline: self.config.offline,
            ahead: info.ahead,
            input: None,
        };
        let playing = info.playing;
        let mut at = info.position;
        let mut peak = 0.0f32;
        for block in out.chunks_mut(step) {
            block.fill(0.0);
            let count = (block.len() / 2) as u32;
            if let Some(g) = &mut self.active {
                let audible = playing && at < g.length_frames;
                let gain = (info.master_gain, info.target_master_gain);
                Self::render_tracks(
                    g,
                    block,
                    at,
                    count,
                    audible,
                    rate,
                    parallel,
                    &io,
                    &mut self.master_feed,
                    gain,
                );
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

    /// A routed track's input of the last block (audio thread, after `render_host`): what a recording of
    /// that track captures. None when the track has no internal route.
    pub fn route_input(&self, track: usize) -> Option<&[f32]> {
        let t = self.active.as_ref()?.tracks.get(track)?;
        (t.routed && !t.route_input.is_empty()).then_some(t.route_input.as_slice())
    }

    /// The shell's transport reset at project frame `frame` (audio thread): instrument voices and cursors
    /// (`chase`: controllers chased, sounding notes restarted), and with `effects` also effect tails, delay
    /// lines and the master state (C++ `Impl::reset(chase, effects)`).
    pub fn host_reset(&mut self, frame: i64, chase: bool, effects: bool) {
        self.position = frame;
        self.reset(chase, effects);
    }

    /// A live event the shell applies itself (audio thread, at a block boundary; C++ live MIDI and its live
    /// commands): the track's built-in instrument plays it now. Returns whether a track played it (the
    /// snapshot counts it either way). The shell owns the track (it is not rendering ahead).
    pub fn host_live(&mut self, track: usize, event: crate::track::LiveEvent) -> bool {
        let played = event.is_valid()
            && self
                .active
                .as_mut()
                .and_then(|g| g.tracks.get_mut(track))
                .is_some_and(|t| t.live_event(event));
        if played {
            self.live_played += 1;
        } else {
            self.live_ignored += 1;
        }
        played
    }

    /// The shell's transport reached the project end without a cycle (audio thread): plug-in style
    /// instruments release their notes next block (C++ `requestReset`), built-in voices ring out.
    pub fn host_stop_at_end(&mut self) {
        self.stop_at_end();
    }

    /// Dynamics meters (audio thread, after `render_block`): each compressor/limiter/gate insert's
    /// detector peak and lowest gain since the last call, in track then chain order (C++
    /// `publishDynamics`). Returns how many readings it wrote.
    pub fn take_dynamics(&mut self, out: &mut [DynamicsReading]) -> usize {
        let Some(g) = &mut self.active else { return 0 };
        let mut n = 0;
        for (index, t) in g.tracks.iter_mut().enumerate().take(65_535) {
            for insert in t.inserts.iter_mut().filter_map(Stage::fx_mut) {
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

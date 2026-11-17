//! Host-driven rendering for the desktop C++ shell (docs/RUST_ENGINE.md 10).
//!
//! The C++ `RenderEngine` keeps the transport (play/stop/seek, cycle wrap, count-in), live MIDI, input
//! capture and snapshot; it asks this renderer for each block at the shell's position: the track mix and
//! the master bus (master gain and processor, [`BlockInfo::master`]), then the metronome and count-in
//! clicks after the shell's meters ([`Renderer::host_clicks`]). Commands are applied up
//! to a ticket the shell names, so a Rust graph swap lands in the same block as the shell's own
//! graph command. The tracks of one processing level may render on the host's worker pool
//! ([`Parallel`]): they are independent, so each renders on one worker; the next level (routed tracks,
//! returns) follows once they all finished, and the mix is summed in track order — bit-identical to
//! the single-threaded path.
//!
//! VST3 plug-ins stay host processors (docs/RUST_ENGINE.md 4): the graph calls the host back at
//! their place in each chain ([`HostCallbacks`]), and asks it for monitored device input. IEUM WAVE
//! renders here (since 0.3.3); the shell waits for its table crossfades ([`Renderer::host_settled`]).

use core::ffi::c_void;

use super::{Graph, Renderer};
use crate::external::{HostCallbacks, Io, Stage};
use crate::math;

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
    /// Apply the master bus after the mix: the master gain (smoothed towards its target, which project
    /// updates and [`Controller::set_master_gain`](super::Controller::set_master_gain) set) and the master
    /// processor; skipped for offline renders with the master bypass (stems, freeze). False: the bare track
    /// mix (`render_block`). Master-resampling routes hear the tracks through the same gain either way.
    pub master: bool,
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
        let info =
            BlockInfo { position, playing, allowed, master: false, monitor: [0; 4], host: None, ahead: &[] };
        self.render_host(out, &info, peaks, parallel);
    }

    /// [`render_block`](Self::render_block) with the master bus, monitoring and host callbacks.
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
        let master = info.master && !(self.config.offline && self.master_bypass);
        let smoothing = math::smoothing(rate, 0.012) as f32;
        for block in out.chunks_mut(step) {
            block.fill(0.0);
            let count = (block.len() / 2) as u32;
            if let Some(g) = &mut self.active {
                let audible = playing && at < g.length_frames;
                let gain = (self.master_gain, self.target_master_gain);
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
            // The master bus (engine.cpp before 0.3.3 applied it in the shell): gain, then the processor.
            if master && let Some(g) = &mut self.active {
                for pair in block.as_chunks_mut::<2>().0 {
                    self.master_gain = math::mul_add_f32(
                        self.target_master_gain - self.master_gain,
                        smoothing,
                        self.master_gain,
                    );
                    for x in pair {
                        *x *= self.master_gain;
                    }
                }
                g.master.process(block);
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

    /// A live event the shell applies itself (audio thread, between blocks; C++ live MIDI and its live commands)
    /// `offset` frames into the track's next block (its device-MIDI sample offset; later blocks when it is past
    /// that one): the track's built-in instrument plays it on that sample, a host node gets it with that offset
    /// through `HostCallbacks::live`. Returns whether a track takes it (the snapshot counts it either way). The
    /// shell owns the track (it is not rendering ahead).
    pub fn host_live(&mut self, track: usize, event: crate::track::LiveEvent, offset: u32) -> bool {
        let played = event.is_valid()
            && offset <= crate::track::MAX_LIVE_OFFSET
            && self
                .active
                .as_mut()
                .and_then(|g| g.tracks.get_mut(track))
                .is_some_and(|t| t.queue_live(event, offset));
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

    /// The metronome and count-in clicks of one shell block (audio thread, after `render_host`, the shell's
    /// meters and its recording), added to `out` (`count` stereo frames): monitor only, never offline
    /// (engine.cpp `renderClicks`, now this engine's `render_clicks`). The shell owns the transport: `position`
    /// and `playing` as it rendered the block; `counting_in` with `elapsed` frames of a count-in of `length`
    /// frames already clicked. Strokes, the enable switch and the gain come from
    /// [`Controller::set_metronome`](super::Controller::set_metronome), applied up to the shell's ticket.
    #[allow(clippy::too_many_arguments)]
    pub fn host_clicks(
        &mut self,
        out: &mut [f32],
        count: u32,
        position: i64,
        playing: bool,
        counting_in: bool,
        elapsed: i64,
        length: i64,
    ) {
        let Some(block) = out.get_mut(..count as usize * 2) else { return };
        let (saved_position, saved_playing) = (self.position, self.playing);
        self.position = position;
        self.playing = playing;
        self.count_in_elapsed = elapsed;
        self.count_in_length = length;
        self.render_clicks(block, count, counting_in);
        self.position = saved_position;
        self.playing = saved_playing;
    }

    /// Applies queued commands up to `allowed` without rendering.
    pub fn host_consume(&mut self, allowed: u64) {
        self.consume_until(allowed);
    }

    /// Whether the next graph of the same project could swap in now (audio thread): no graph waits in
    /// the queue and no IEUM WAVE track of the active graph is inside a table crossfade. The shell holds
    /// its own graph command until then, so both graphs swap in the same block.
    pub fn host_settled(&mut self) -> bool {
        self.deferred.is_none()
            && self.active.as_mut().is_none_or(|g| g.tracks.iter_mut().all(|t| t.source.ready_to_transfer()))
    }
}

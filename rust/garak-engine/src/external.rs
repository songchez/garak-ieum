//! Nodes the desktop host processes itself (docs/RUST_ENGINE.md 4): VST3 instruments and inserts, IEUM WAVE,
//! and the host's view of a block (monitored tracks, device input). The C++ shell owns those processors, their
//! editors and state; the graph calls it back at the node's place in the chain, on whatever thread renders the
//! track, so plug-in delay compensation, sends, routes and the mix stay in this engine.

use alloc::boxed::Box;
use core::ffi::c_void;

use crate::insert::Insert;
use crate::track::TimedLiveEvent;

/// External source: fill `stereo` (interleaved, `frames` frames, zeroed) with track `track`'s instrument
/// output for the current block (the host knows the block's position and transport).
pub type SourceFn = unsafe extern "C" fn(user: *mut c_void, track: u32, stereo: *mut f32, frames: u32);
/// External insert: process `stereo` in place through insert `insert` (index in the track plan's inserts).
pub type InsertFn =
    unsafe extern "C" fn(user: *mut c_void, track: u32, insert: u32, stereo: *mut f32, frames: u32);
/// Monitored device input: add track `track`'s physical input into `stereo`. Returns 1 when the input is a
/// stereo pair, 0 for mono (duplicated to both channels) or an unopened input (nothing added).
pub type InputFn = unsafe extern "C" fn(user: *mut c_void, track: u32, stereo: *mut f32, frames: u32) -> i32;
/// Live events for a host-rendered instrument (VST3, IEUM WAVE), called right before its `source` of the same
/// block with the block's `count` events in offset order (`offset` < the block's frames: the plug-in's
/// `sampleOffset`). Not called for a block without live events for that track.
pub type LiveFn =
    unsafe extern "C" fn(user: *mut c_void, track: u32, events: *const TimedLiveEvent, count: u32);

/// The host's callbacks (`#[repr(C)]`, `GarakRsHostNodes` in garak_engine.h). Each callback may run on any
/// render thread, concurrently for different tracks, never twice at once for one track.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct HostCallbacks {
    pub user: *mut c_void,
    pub source: Option<SourceFn>,
    pub insert: Option<InsertFn>,
    pub input: Option<InputFn>,
    /// Null: host-rendered instruments get no live events from the graph.
    pub live: Option<LiveFn>,
}

// SAFETY: the host contract above: the callbacks are thread-safe for distinct tracks, and `user` is only
// passed back to them.
unsafe impl Sync for HostCallbacks {}
// SAFETY: as above.
unsafe impl Send for HostCallbacks {}

impl HostCallbacks {
    pub(crate) fn source(&self, track: usize, stereo: &mut [f32]) {
        if let Some(f) = self.source {
            // SAFETY: `stereo` is a live, exclusive buffer of `len / 2` frames for the duration of the call.
            unsafe { f(self.user, track as u32, stereo.as_mut_ptr(), (stereo.len() / 2) as u32) }
        }
    }

    pub(crate) fn insert(&self, track: usize, insert: u16, stereo: &mut [f32]) {
        if let Some(f) = self.insert {
            // SAFETY: as in `source`.
            unsafe {
                f(self.user, track as u32, u32::from(insert), stereo.as_mut_ptr(), (stereo.len() / 2) as u32)
            }
        }
    }

    pub(crate) fn live(&self, track: usize, events: &[TimedLiveEvent]) {
        if let Some(f) = self.live
            && !events.is_empty()
        {
            // SAFETY: `events` is live and unchanged for the duration of the call.
            unsafe { f(self.user, track as u32, events.as_ptr(), events.len() as u32) }
        }
    }

    pub(crate) fn input(&self, track: usize, stereo: &mut [f32]) -> bool {
        match self.input {
            // SAFETY: as in `source`.
            Some(f) => unsafe {
                f(self.user, track as u32, stereo.as_mut_ptr(), (stereo.len() / 2) as u32) != 0
            },
            None => false,
        }
    }
}

/// Per-block facts every track render reads (shared by the render threads).
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Io<'a> {
    pub host: Option<&'a HostCallbacks>,
    /// Monitored tracks (bit `i` of word `i / 64`), C++ `RenderEngine::setMonitoring`.
    pub monitor: [u64; 4],
    /// Offline engine (export): frozen windows keep playing after the project end, no low-latency monitoring.
    pub offline: bool,
    /// Per track: this block's output from the host's render-ahead ring (null: the graph renders the track).
    pub ahead: &'a [*const f32],
    /// The browser host's input block (no host callbacks): what monitored tracks hear.
    pub input: Option<DeviceInput<'a>>,
}

/// The browser host's live input for one block (engine.cpp `render(output, input, frames, channels)`):
/// `channels` interleaved, this block starting at frame `cursor` of `data`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct DeviceInput<'a> {
    pub data: &'a [f32],
    pub channels: usize,
    pub cursor: usize,
}

impl DeviceInput<'_> {
    /// engine.cpp `routeInput` for the browser host: adds the track's input channels (`input`, plan order;
    /// None = channels 0 and 1, mono when the block has one) into `stereo`. Returns whether the input is a
    /// stereo pair; a missing channel adds nothing.
    pub fn add(&self, input: Option<[i16; 2]>, stereo: &mut [f32]) -> bool {
        let Some((left, right)) = input_channels(input, self.channels) else { return false };
        let sample = |frame: usize, c: usize| {
            let v = self.data.get((self.cursor + frame) * self.channels + c).copied().unwrap_or(0.0);
            if v.is_finite() { v } else { 0.0 }
        };
        for (i, pair) in stereo.as_chunks_mut::<2>().0.iter_mut().enumerate() {
            let a = sample(i, left);
            pair[0] += a;
            pair[1] += right.map_or(a, |r| sample(i, r));
        }
        right.is_some()
    }
}

/// Track input channels index the input block's channels directly; no input = channels 0 and 1 (mono when
/// the block has one). None when a channel is missing.
fn input_channels(input: Option<[i16; 2]>, channels: usize) -> Option<(usize, Option<usize>)> {
    let open = |c: i16| (c >= 0 && (c as usize) < channels).then_some(c as usize);
    match input {
        None => open(0).map(|l| (l, open(1))),
        Some([l, r]) => {
            let left = open(l)?;
            if r < 0 { Some((left, None)) } else { open(r).map(|r| (left, Some(r))) }
        }
    }
}

impl<'a> Io<'a> {
    pub fn monitored(&self, track: usize) -> bool {
        self.monitor.get(track / 64).is_some_and(|w| w & (1u64 << (track % 64)) != 0)
    }

    /// The ring output of a track the host renders ahead, or None.
    pub fn ahead_mix(&self, track: usize, count: u32) -> Option<&'a [f32]> {
        let p = *self.ahead.get(track)?;
        if p.is_null() {
            return None;
        }
        // SAFETY: `BlockInfo::ahead` contract: each non-null entry holds this block's `count` stereo frames and
        // stays valid and unchanged for the whole render call.
        Some(unsafe { core::slice::from_raw_parts(p, count as usize * 2) })
    }
}

/// One stage of a track's insert chain: a built-in effect, or a VST3 insert the host processes.
#[derive(Debug)]
pub(crate) enum Stage {
    /// Boxed: an effect's state is large and the chain moves as a vector.
    Fx(Box<Insert>),
    Host {
        /// Index in the track plan's inserts.
        source: u16,
        latency: u32,
        tail: f64,
    },
}

impl Stage {
    pub fn source(&self) -> u16 {
        match self {
            Stage::Fx(i) => i.source,
            Stage::Host { source, .. } => *source,
        }
    }

    pub fn latency(&self) -> u32 {
        match self {
            Stage::Fx(i) => i.latency(),
            Stage::Host { latency, .. } => *latency,
        }
    }

    pub fn tail(&self) -> f64 {
        match self {
            Stage::Fx(i) => i.tail(),
            Stage::Host { tail, .. } => *tail,
        }
    }

    pub fn fx_mut(&mut self) -> Option<&mut Insert> {
        match self {
            Stage::Fx(i) => Some(i),
            Stage::Host { .. } => None,
        }
    }

    /// Effect state (the host resets its own processors with the transport).
    pub fn reset(&mut self) {
        if let Stage::Fx(i) = self {
            i.reset();
        }
    }

    /// C++ `takeStateFrom` between inserts of the same id and type (a host insert keeps its processor).
    pub fn take_state_from(&mut self, previous: &mut Stage) {
        if let (Stage::Fx(a), Stage::Fx(b)) = (self, previous) {
            a.take_state_from(b);
        }
    }
}

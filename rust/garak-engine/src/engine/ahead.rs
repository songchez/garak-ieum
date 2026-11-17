//! Render-ahead for the desktop shell (C++ `RenderEngine` ASIO-Guard style rings, docs/RUST_ENGINE.md 10).
//!
//! The shell keeps its render-ahead machinery (rings, worker scheduling, live-track hand-back): a track it
//! moved into a ring is rendered by a worker through [`Ahead::render_track`], ahead of the callback, while the
//! callback's [`Renderer::render_host`](super::Renderer::render_host) skips it and mixes the ring's audio
//! instead (`BlockInfo::ahead`). Transport resets skip ahead tracks too; the shell resets one when it takes
//! it back out of sync ([`Ahead::reset_track`]).

use alloc::boxed::Box;
use alloc::sync::Arc;
use core::sync::atomic::{AtomicPtr, Ordering};

use super::{Graph, Renderer};
use crate::external::{HostCallbacks, Io};
use crate::track::Track;

/// A view of the renderer's active graph for render-ahead producers (any thread).
#[derive(Debug, Clone)]
pub struct Ahead {
    graph: Arc<AtomicPtr<Graph>>,
    sample_rate: f64,
    offline: bool,
}

impl Ahead {
    /// # Safety
    /// The render-ahead contract: the renderer does not render, reset or replace track `track` while this
    /// runs (the shell holds it in a ring and skips it), no other thread uses it at the same time, and the
    /// renderer applies no command that swaps or drops the graph meanwhile (the shell keeps its workers out
    /// while the renderer applies commands).
    unsafe fn track(&self, track: usize) -> Option<(*mut Graph, *mut Track)> {
        let g = self.graph.load(Ordering::Acquire);
        if g.is_null() {
            return None;
        }
        // SAFETY: caller contract: the graph is live and only this thread touches this track's box. Only raw
        // pointers are formed to the graph, so the callback's access to other tracks never aliases.
        unsafe {
            let tracks = &raw mut (*g).tracks;
            if track >= (*tracks).len() {
                return None;
            }
            let slot: *mut Box<Track> = (*tracks).as_mut_ptr().add(track);
            Some((g, &raw mut **slot))
        }
    }

    /// Renders `count` frames of track `track` at project frame `frame` as the callback would and returns its
    /// output and block peak (valid until the track renders again). None when there is no such track.
    ///
    /// # Safety
    /// As [`track`](Self::track); `host` callbacks for this track may run on this thread.
    pub unsafe fn render_track(
        &self,
        track: usize,
        frame: i64,
        count: u32,
        playing: bool,
        host: Option<&HostCallbacks>,
    ) -> Option<(&[f32], f32)> {
        // SAFETY: forwarded caller contract.
        let (g, t) = unsafe { self.track(track)? };
        // SAFETY: as above; the tempo map is immutable while the graph lives.
        unsafe {
            let tempo =
                (*g).tempo.as_ref().map(|m| m.bpm_at(m.beat_at_frame(frame as f64, self.sample_rate)));
            let io = Io { host, offline: self.offline, ..Io::default() };
            (*t).render(frame, count, playing, tempo, &io);
            Some(((*t).mix(count), (*t).peak))
        }
    }

    /// The shell's reset of one track it takes back from a ring out of sync (effects: tails and delay lines).
    ///
    /// # Safety
    /// As [`track`](Self::track) (the caller is the thread that owns the track now).
    pub unsafe fn reset_track(&self, track: usize, effects: bool) {
        // SAFETY: forwarded caller contract.
        if let Some((_, t)) = unsafe { self.track(track) } {
            // SAFETY: as above.
            unsafe { (*t).reset(effects) };
        }
    }
}

impl Renderer {
    /// The render-ahead view of this renderer (control thread, once).
    pub fn ahead(&self) -> Ahead {
        Ahead {
            graph: self.shared.clone(),
            sample_rate: f64::from(self.config.sample_rate),
            offline: self.config.offline,
        }
    }

    /// The shell's transport reset that leaves the tracks it renders ahead alone (`skip`: bit `i` of word
    /// `i / 64`), like C++ `Impl::reset`.
    pub fn host_reset_skip(&mut self, effects: bool, skip: &[u64; 4]) {
        if let Some(g) = &mut self.active {
            for (i, t) in g.tracks.iter_mut().enumerate() {
                if skip.get(i / 64).is_some_and(|w| w & (1u64 << (i % 64)) != 0) {
                    continue;
                }
                t.reset(effects);
            }
            if effects {
                g.master.reset();
            }
        }
    }
}

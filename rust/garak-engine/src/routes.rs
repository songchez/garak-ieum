//! Track-input routing (docs/TRACK_INPUT_ROUTING.md), engine.cpp `prepareRoutes`: resolves each route to a
//! graph index, turns loops and missing sources into silence, marks the master feed, allocates tap and
//! route buffers and orders the tracks in processing levels so every source renders before the tracks that
//! take it (returns after their senders). Control thread.

use alloc::boxed::Box;
use alloc::vec;
use alloc::vec::Vec;

use crate::plan::{RouteKind, RouteTap, SourceKind};
use crate::track::Track;

/// Track indices grouped by processing level: `order[start[l]..start[l + 1]]` is level `l`. `master` is the
/// first level holding a master-resampling track (the master feed is mixed just before it).
#[derive(Debug, Default)]
pub(crate) struct Levels {
    pub order: Vec<usize>,
    pub start: Vec<usize>,
    pub master: Option<usize>,
}

impl Levels {
    pub fn count(&self) -> usize {
        self.start.len().saturating_sub(1)
    }

    pub fn level(&self, l: usize) -> &[usize] {
        match (self.start.get(l), self.start.get(l + 1)) {
            (Some(&a), Some(&b)) => self.order.get(a..b).unwrap_or(&[]),
            _ => &[],
        }
    }
}

fn kind(tracks: &[Box<Track>], i: usize) -> RouteKind {
    tracks.get(i).map_or(RouteKind::None, |t| t.route_kind)
}

fn next(source: &[Option<usize>], at: usize) -> Option<usize> {
    source.get(at).copied().flatten()
}

/// Sends must already be resolved into the returns' feeds, and `output_delay_frames` set.
#[allow(clippy::vec_box)]
pub(crate) fn prepare(tracks: &mut [Box<Track>], max_block: u32) -> Levels {
    let count = tracks.len();
    let mut source: Vec<Option<usize>> = vec![None; count];
    for i in 0..count {
        let Some(t) = tracks.get(i) else { continue };
        let Some(route) = t.plan.route.clone() else { continue };
        if t.plan.source.kind != SourceKind::Audio || t.is_return {
            continue;
        }
        let mut found = None;
        if route.kind == RouteKind::Track {
            // Return tracks are never route sources (docs/SENDS_RETURNS.md): a route naming one records silence.
            found = (0..count).find(|&j| {
                j != i && tracks.get(j).is_some_and(|s| !s.is_return && s.plan.id == route.track_id)
            });
        }
        if let Some(t) = tracks.get_mut(i) {
            t.routed = true;
            t.route_kind = route.kind;
            t.route_tap = route.tap;
            if route.kind == RouteKind::Track && found.is_none() {
                t.route_kind = RouteKind::None;
            }
        }
        if let Some(s) = source.get_mut(i) {
            *s = found;
        }
    }
    // Each track has one input: a loop is a chain that returns to its start. Break it at that track.
    for i in 0..count {
        let mut steps = 0;
        let mut at = next(&source, i);
        while let Some(a) = at {
            if steps > count {
                break;
            }
            if a == i {
                if let Some(s) = source.get_mut(i) {
                    *s = None;
                }
                if let Some(t) = tracks.get_mut(i) {
                    t.route_kind = RouteKind::None;
                }
                break;
            }
            at = next(&source, a);
            steps += 1;
        }
    }
    for i in 0..count {
        if kind(tracks, i) != RouteKind::Track
            && let Some(s) = source.get_mut(i)
        {
            *s = None;
        }
        let s = next(&source, i);
        if let Some(t) = tracks.get_mut(i) {
            t.route_source = s;
        }
    }
    // Master-resampling tracks and everything downstream of them stay out of the master feed.
    for i in 0..count {
        let mut excluded = kind(tracks, i) == RouteKind::Master;
        let mut steps = 0;
        let mut at = next(&source, i);
        while let Some(a) = at {
            if excluded || steps > count {
                break;
            }
            excluded = kind(tracks, a) == RouteKind::Master;
            at = next(&source, a);
            steps += 1;
        }
        if let Some(t) = tracks.get_mut(i) {
            t.in_master_feed = !excluded;
        }
    }
    // A return fed by a track outside the master feed carries the resampled signal too.
    for r in 0..count {
        let outside = tracks.get(r).is_some_and(|t| {
            t.is_return && t.feeds.iter().any(|f| tracks.get(f.sender).is_some_and(|s| !s.in_master_feed))
        });
        if outside && let Some(t) = tracks.get_mut(r) {
            t.in_master_feed = false;
        }
    }
    // Levels: feed tracks by their chain depth, master resamplers above every feed track, then theirs.
    let mut level: Vec<Option<usize>> = vec![None; count];
    fn depth(
        i: usize,
        guard: usize,
        tracks: &[Box<Track>],
        source: &[Option<usize>],
        level: &mut [Option<usize>],
    ) -> usize {
        if let Some(Some(l)) = level.get(i) {
            return *l;
        }
        let count = tracks.len();
        if guard > count {
            return 0;
        }
        let mut value = 0;
        if let Some(s) = next(source, i) {
            value = depth(s, guard + 1, tracks, source, level) + 1;
        } else if kind(tracks, i) == RouteKind::Master {
            for j in 0..count {
                if tracks.get(j).is_some_and(|t| t.in_master_feed) {
                    value = value.max(depth(j, guard + 1, tracks, source, level) + 1);
                }
            }
        } else if let Some(t) = tracks.get(i)
            && t.is_return
        {
            for f in &t.feeds {
                value = value.max(depth(f.sender, guard + 1, tracks, source, level) + 1);
            }
        }
        if let Some(slot) = level.get_mut(i) {
            *slot = Some(value);
        }
        value
    }
    let mut top = 0;
    for i in 0..count {
        top = top.max(depth(i, 0, tracks, &source, &mut level));
    }
    let mut levels = Levels::default();
    for l in 0..=top {
        levels.start.push(levels.order.len());
        for (i, at) in level.iter().enumerate() {
            if *at == Some(l) {
                levels.order.push(i);
                if kind(tracks, i) == RouteKind::Master {
                    levels.master = Some(levels.master.map_or(l, |m: usize| m.min(l)));
                }
            }
        }
    }
    levels.start.push(levels.order.len());
    let samples = max_block as usize * 2;
    for i in 0..count {
        let (routed, tap) = match tracks.get(i) {
            Some(t) => (t.routed, t.route_tap),
            None => continue,
        };
        if routed && let Some(t) = tracks.get_mut(i) {
            t.route_input = vec![0.0; samples];
        }
        if let Some(src) = next(&source, i)
            && let Some(s) = tracks.get_mut(src)
        {
            match tap {
                RouteTap::PreFx if s.pre_tap.is_empty() => s.pre_tap = vec![0.0; samples],
                RouteTap::PostFx if s.post_tap.is_empty() => s.post_tap = vec![0.0; samples],
                // The post-fader tap is the output before the return-latency delay (the output itself when
                // there is none).
                RouteTap::PostFader if s.output_delay_frames > 0 && s.fader_tap.is_empty() => {
                    s.fader_tap = vec![0.0; samples];
                }
                _ => {}
            }
        }
    }
    levels
}

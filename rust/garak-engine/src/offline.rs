//! Offline render (WAV export): native/src/host.cpp `renderStopped` on the Rust engine. The
//! project renders from frame 0 through its length plus the release tail (capped at 30 s), with
//! the common plug-in delay removed from the front (those frames are rendered at the end).

use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::sync::Arc;
use alloc::vec;
use alloc::vec::Vec;

use crate::engine::{EngineConfig, engine};
use crate::error::{Error, require};
use crate::math;
use crate::plan::{PcmAsset, Plan};

/// Interleaved stereo float output of [`render_offline`].
#[derive(Clone, Debug, PartialEq)]
pub struct OfflineRender {
    pub samples: Vec<f32>,
    pub frames: u64,
    pub latency: u32,
    pub tail_seconds: f64,
}

/// Renders `plan` with `assets`, calling the engine in chunks of `block` frames (the C++ host
/// uses 4096 for both its engine block and its render calls). The cycle is ignored.
pub fn render_offline(
    plan: &Plan,
    assets: &BTreeMap<String, Arc<PcmAsset>>,
    block: u32,
) -> Result<OfflineRender, Error> {
    let mut plan = plan.clone();
    plan.cycle = None;
    let config = EngineConfig { sample_rate: plan.sample_rate, max_block: block, offline: true };
    let (mut control, mut renderer) = engine(config)?;
    for (id, asset) in assets {
        control.put_asset(id, PcmAsset::clone(asset))?;
    }
    let rate = plan.sample_rate;
    let length = plan.length_frames;
    control.update(plan)?;
    control.play()?;
    let (latency, _, tail) = control.graph_info().unwrap_or((0, 0, 0.0));
    let tail = math::std_min(30.0, tail);
    let total = length as u64 + garak_dsp::math::ceil(tail * f64::from(rate)) as u64;
    require(total * 4 <= 512 * 1024 * 1024, "WAV export exceeds 512 MiB")?;
    let mut samples = Vec::with_capacity(total as usize * 2);
    let mut scratch = vec![0.0f32; block as usize * 2];
    let latency64 = u64::from(latency);
    let mut done = 0u64;
    while done < total + latency64 {
        let frames = (total + latency64 - done).min(u64::from(block)) as usize;
        let Some(chunk) = scratch.get_mut(..frames * 2) else { break };
        renderer.render(chunk);
        let skip = if done < latency64 { (latency64 - done).min(frames as u64) as usize } else { 0 };
        samples.extend_from_slice(chunk.get(skip * 2..).unwrap_or(&[]));
        done += frames as u64;
    }
    drop(renderer);
    control.collect();
    Ok(OfflineRender { samples, frames: total, latency, tail_seconds: tail })
}

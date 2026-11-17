//! 가락이음 render engine (docs/RUST_ENGINE.md, stage 4).
//!
//! The engine half of the render-diff protocol (docs/RENDER_DIFF_PROTOCOL.md) in Rust: a project
//! timeline (the same `timeline` JSON + binary frame the C++ host parses) becomes a prepared
//! graph of tracks -> built-in effect chains (garak-dsp) -> sends/returns -> master, rendered
//! block by block with the C++ `RenderEngine` semantics (native/src/engine.cpp).
//!
//! # Threads and allocation
//! `#![no_std]` with `alloc`, split in two halves joined by bounded lock-free queues:
//! - [`Controller`] (control thread): parses plans, registers PCM, prepares graphs and tracks,
//!   classifies diffs, frees retired objects. Allocates freely.
//! - [`Renderer`] (audio thread): applies queued commands at block boundaries and renders. Never
//!   allocates, frees, locks or panics: everything it touches was sized on the control thread, and
//!   retired graphs/tracks travel back through a queue to be dropped by the controller. A test with
//!   a counting global allocator holds this (tests/realtime.rs).
//!
//! `alloc` is needed because a project is unbounded data (tracks, PCM, automation points) that the
//! control side builds; `garak-dsp` stays allocation-free. Hosts: C++ through `garak-ffi`
//! (CRT `malloc` as the global allocator), the browser through `garak-engine-wasm`.
#![no_std]

extern crate alloc;
#[cfg(test)]
extern crate std;

pub mod automation;
mod clip;
mod delay;
pub mod engine;
pub mod error;
mod insert;
pub mod json;
mod master;
pub mod math;
pub mod metronome;
pub mod offline;
pub mod plan;
pub mod protocol;
pub mod queue;
pub mod tempo;
pub mod testkit;
mod track;

pub use engine::{
    Applied, Controller, DynamicsReading, EngineConfig, HostTask, Parallel, Renderer, Snapshot, engine,
};
pub use error::Error;
pub use offline::{OfflineRender, render_offline};
pub use plan::{PcmAsset, Plan};

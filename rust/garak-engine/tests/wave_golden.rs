//! IEUM WAVE against golden renders of the original C++ synth (native/devices/wavetable-synth, removed in
//! 0.3.3), captured from the C++ RenderEngine before that removal: tests/golden/ieum-wave/*.iwgold (format in
//! native/tests/rust_wave_golden_test.cpp, which checks every case bit for bit on Windows x86-64 through
//! garak-ffi). Here the offline cases render through this crate as built for the test (the `libm` crate unless
//! the workspace enables `platform-math`) and must stay within -90 dBFS of the C++ render. Each case's timeline
//! is also written to `target/engine-parity/ieum-wave/` for the browser test (src/audio/rust/wave.test.ts).
// Test code: helpers outside #[test] functions may unwrap and index (clippy.toml covers only the
// test functions themselves).
#![allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::std_instead_of_core)]

use garak_engine::testkit::instruments::{WAVE, instrument_project};
use garak_engine::{Applied, EngineConfig, engine};

struct Golden {
    rate: u32,
    latency: u32,
    frames: u64,
    hash: u64,
    /// Every `STRIDE`-th stereo frame.
    samples: Vec<f32>,
}

const STRIDE: usize = 4;
const SCALE: f64 = 4_194_304.0;

fn golden(name: &str) -> Golden {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("tests/golden/ieum-wave/{name}.iwgold"));
    let b = std::fs::read(&path).unwrap();
    assert_eq!(&b[..8], b"IWGOLD01");
    let u32_at = |at: usize| u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]);
    let u64_at = |at: usize| u64::from(u32_at(at)) | (u64::from(u32_at(at + 4)) << 32);
    let frames = u64_at(16);
    let stored = (frames as usize).div_ceil(STRIDE);
    assert_eq!(b.len(), 32 + stored * 6, "{name}: truncated");
    let samples = (0..stored * 2)
        .map(|k| {
            let at = 32 + k * 3;
            let mut v = i32::from(b[at]) | (i32::from(b[at + 1]) << 8) | (i32::from(b[at + 2]) << 16);
            if v & 0x80_0000 != 0 {
                v -= 0x100_0000;
            }
            (f64::from(v) / SCALE) as f32
        })
        .collect();
    Golden { rate: u32_at(8), latency: u32_at(12), frames, hash: u64_at(24), samples }
}

fn float_hash(v: &[f32]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for x in v {
        for byte in x.to_bits().to_le_bytes() {
            h ^= u64::from(byte);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    }
    h
}

/// host.cpp renderStopped: an offline engine from frame 0, length + tail (<= 30 s), plug-in delay trimmed.
fn render(json: &str, rate: u32, block: u32) -> (Vec<f32>, u32) {
    let (mut c, mut r) = engine(EngineConfig { sample_rate: rate, max_block: block, offline: true }).unwrap();
    assert_eq!(c.set_json(json.as_bytes(), &[]).unwrap(), Applied::Full);
    c.play().unwrap();
    let (latency, _, tail) = c.graph_info().unwrap();
    let length: i64 =
        garak_engine::protocol::timeline_from_bytes(json.as_bytes(), &[]).unwrap().length_frames;
    let total = length as usize + (tail.min(30.0) * f64::from(rate)).ceil() as usize;
    let mut out = vec![0.0f32; (total + latency as usize) * 2];
    let mut done = 0;
    while done < total + latency as usize {
        let n = (block as usize).min(total + latency as usize - done);
        r.render(&mut out[done * 2..(done + n) * 2]);
        done += n;
    }
    c.collect();
    (out[latency as usize * 2..].to_vec(), latency)
}

#[test]
fn ieum_wave_matches_the_cpp_synth() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/engine-parity/ieum-wave");
    std::fs::create_dir_all(&dir).unwrap();
    for (name, seconds, rate, block) in [
        ("offline-48k-4096", 4.0, 48_000, 4096),
        ("offline-48k-128", 3.0, 48_000, 128),
        ("offline-44k1-512", 3.0, 44_100, 512),
    ] {
        let g = golden(name);
        let p = instrument_project(WAVE, seconds, rate);
        assert!(p.assets.is_empty() && p.sample_sets.is_empty());
        std::fs::write(dir.join(format!("{name}.json")), &p.json).unwrap();
        let (out, latency) = render(&p.json, rate, block);
        assert_eq!(
            (g.rate, g.latency, g.frames),
            (rate, latency, (out.len() / 2) as u64),
            "{name}: format/length"
        );
        let (mut residual, mut peak) = (0.0f64, 0.0f64);
        for (k, expected) in g.samples.iter().enumerate() {
            let actual = out[(k / 2) * STRIDE * 2 + k % 2].clamp(-2.0, 2.0);
            residual = residual.max(f64::from((actual - expected).abs()));
            peak = peak.max(f64::from(expected.abs()));
        }
        let db = if residual > 0.0 { 20.0 * residual.log10() } else { -400.0 };
        println!(
            "{name}: {} (residual vs the 24-bit golden {db:.1} dBFS, peak {:.2} dBFS)",
            if float_hash(&out) == g.hash { "bit-identical to the C++ synth" } else { "not bit-identical" },
            20.0 * peak.log10()
        );
        assert!(peak > 0.05, "{name}: silent golden");
        assert!(db <= -90.0, "{name}: {db:.1} dBFS from the C++ synth");
    }
}

//! IEUM WAVE (`native-wavetable`), the wavetable synth of docs/IEUM_WAVE.md. Since 0.3.3 this is its
//! only implementation, on the desktop (garak-ffi) and in the browser (garak-engine-wasm). It began
//! as a bit-identical port of the C++ library native/devices/wavetable-synth and of its engine
//! wrapper native/src/wavetable.cpp (both removed in 0.3.3; renders of the C++ synth are kept as
//! golden data in tests/golden/ieum-wave). Tables and delay lines are allocated on the control
//! thread; the synth renders from preallocated state only.

pub(crate) mod dsp;
pub(crate) mod math;
pub(crate) mod patch;
pub(crate) mod processor;
pub(crate) mod schema;
pub(crate) mod synth;
pub(crate) mod tables;

pub(crate) use processor::{HostEvent, HostKind, Processor, WaveCache};

/// What a host needs from IEUM WAVE besides rendering: the capability handshake (`engine.capabilities`
/// `wavetable`) and validating a patch before a project changes.
pub mod host {
    use alloc::string::String;
    use alloc::vec::Vec;

    /// `wavetable.protocolVersion` of the host handshake.
    pub const PROTOCOL_VERSION: u32 = 1;
    /// The generated schema identity the renderer checks (`WAVE_SCHEMA_FINGERPRINT`).
    pub const SCHEMA_FINGERPRINT: u32 = super::schema::SCHEMA_FINGERPRINT;
    /// Supported sample rates (Hz).
    pub const MINIMUM_SAMPLE_RATE: u32 = 22_050;
    pub const MAXIMUM_SAMPLE_RATE: u32 = 192_000;

    /// Decodes and validates an IEWAVE01 pack (control thread) and returns its export allowance in
    /// seconds: the release and delay tail rendered after the last note.
    pub fn check_patch(bytes: &[u8]) -> Result<f64, String> {
        let (patch, _) = super::patch::decode_patch_bundle(bytes)?;
        Ok(super::processor::patch_tail_seconds(&patch))
    }

    /// The default patch as an IEWAVE01 pack (no routes, no user banks).
    pub fn default_patch() -> Vec<u8> {
        let patch = super::patch::Patch::default();
        let mut bytes = Vec::with_capacity(32 + 4 * (super::schema::PARAM_COUNT + 4 * 128));
        bytes.extend_from_slice(b"IEWAVE01");
        for v in [1u32, SCHEMA_FINGERPRINT, super::schema::PARAM_COUNT as u32, 0, 0, 0] {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        for v in patch.params.iter().chain(patch.lfo_curves.iter().flatten()) {
            bytes.extend_from_slice(&v.to_bits().to_le_bytes());
        }
        bytes
    }

    /// The wire index of parameter `id` (schema.json `params[].id`), if there is one.
    pub fn parameter_index(id: &str) -> Option<usize> {
        super::schema::PARAMETER_NAMES.iter().position(|name| *name == id)
    }
}

#[cfg(test)]
mod tests {
    use alloc::format;

    /// Control-path values stay small: the WASM worklet stack is 64 KiB (rust/.cargo/config.toml),
    /// so pools and synths are built in place on the heap and tracks keep their sources boxed.
    #[test]
    fn values_fit_a_small_stack() {
        assert!(core::mem::size_of::<crate::instrument::Source>() <= 64);
        assert!(core::mem::size_of::<crate::track::Track>() <= 4096);
    }

    /// schema.rs and the renderer's schema.generated.ts come from the same manifest
    /// (`node src/devices/wavetable-synth/generate-schema.mjs --check` checks the text itself).
    #[test]
    fn schema_matches_the_renderer_schema() {
        let ts = include_str!("../../../../src/devices/wavetable-synth/schema.generated.ts");
        assert!(
            ts.contains(&format!("WAVE_SCHEMA_FINGERPRINT = {} as const", super::schema::SCHEMA_FINGERPRINT))
        );
        for name in super::schema::PARAMETER_NAMES {
            assert!(ts.contains(&format!("\"id\": \"{name}\"")), "{name}");
        }
    }

    /// The host surface: the default pack validates with the default release as its tail, and
    /// broken packs are refused.
    #[test]
    fn host_checks_patches() {
        use super::host::{check_patch, default_patch, parameter_index};
        let default = default_patch();
        let tail = check_patch(&default).unwrap();
        let release = super::schema::DEFAULTS[parameter_index("env1Release").unwrap()];
        assert!((tail - (f64::from(release) + 0.01)).abs() < 1e-9, "{tail}");
        assert!(check_patch(&default[..default.len() - 1]).is_err());
        let mut wrong = default.clone();
        wrong[12] ^= 1;
        assert!(check_patch(&wrong).is_err());
        assert_eq!(parameter_index("nope"), None);
    }
}

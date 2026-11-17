//! IEUM WAVE (`native-wavetable`): a port of native/devices/wavetable-synth (the C++ library the
//! desktop engine hosts) and of its engine wrapper native/src/wavetable.cpp. Tables and delay
//! lines are allocated on the control thread; the synth renders from preallocated state only.

pub(crate) mod dsp;
pub(crate) mod math;
pub(crate) mod patch;
pub(crate) mod processor;
pub(crate) mod schema;
pub(crate) mod synth;
pub(crate) mod tables;

pub(crate) use processor::{HostEvent, HostKind, Processor, WaveCache};

#[cfg(test)]
mod tests {
    use alloc::format;
    use alloc::vec::Vec;

    /// schema.rs is generated from the C++ header: both must describe the same schema.
    #[test]
    fn schema_matches_the_cpp_header() {
        let header = include_str!("../../../../native/devices/wavetable-synth/generated/patch_schema.hpp");
        assert!(header.contains(&format!("kSchemaFingerprint = {}u;", super::schema::SCHEMA_FINGERPRINT)));
        assert!(header.contains(&format!("kParamCount = {};", super::schema::PARAM_COUNT)));
        let defaults = header.split("kDefaults = {{").nth(1).and_then(|r| r.split("}}").next()).unwrap_or("");
        let parsed: Vec<f32> = defaults
            .split(',')
            .map(|v| v.trim().trim_end_matches('f').parse::<f32>().unwrap_or(f32::NAN))
            .collect();
        assert_eq!(parsed.as_slice(), super::schema::DEFAULTS.as_slice());
    }
}

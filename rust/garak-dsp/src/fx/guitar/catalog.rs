//! Parameter catalog of the guitar rig: native/src/dsp.cpp `guitarRigDefs()` (which mirrors
//! src/devices/guitar-rig/definition.ts) in the same order: the 46 base ids, then the `_2` / `_3`
//! copies of every module's ids (module by module, instance by instance), then `rackSlot0..17`.
//! The C++ adapter compares both catalogs id by id at construction.

use crate::params::{ParamDef, index_of};

const fn d(id: &'static str, default: f64, min: f64, max: f64) -> ParamDef {
    ParamDef { id, default, min, max }
}

/// Module codes stored in the rack slots (`code + 16 x instance`). Never renumbered.
pub const COMP: usize = 1;
pub const DRIVE: usize = 2;
pub const AMP: usize = 3;
pub const CABINET: usize = 4;
pub const CHORUS: usize = 5;
pub const DELAY: usize = 6;
pub const FUZZ: usize = 7;
pub const PHASER: usize = 8;
pub const TREMOLO: usize = 9;
pub const REVERB: usize = 10;
pub const TUNER: usize = 11;
/// `kRigModuleCodes`: codes 1..=11 (0 is an empty slot).
pub const MODULE_CODES: usize = 12;
pub const INSTANCE_STRIDE: usize = 16;
/// Copies of one module a rack may hold (the tuner allows one).
pub const MAX_INSTANCES: usize = 3;
/// Rack slots (`rackSlot0..17`): 8 pedals, amp, cabinet, 8 pedals.
pub const SLOTS: usize = 18;

pub const fn max_instances(code: usize) -> usize {
    if code == TUNER { 1 } else { MAX_INSTANCES }
}

/// `kRigModuleParams`: each module's parameter ids, enable switch first.
pub const MODULE_PARAMS: [&[&str]; MODULE_CODES] = [
    &[],
    &["compEnabled", "compSustain", "compAttack", "compLevel"],
    &["driveEnabled", "driveGain", "driveTone", "driveLevel"],
    &["ampEnabled", "ampGain", "ampBass", "ampMid", "ampTreble", "ampPresence", "ampLevel", "ampModel"],
    &["cabinetEnabled", "cabinet", "micType", "micPosition", "micDistance"],
    &["chorusEnabled", "chorusRate", "chorusDepth", "chorusMix"],
    &["delayEnabled", "delayTime", "delayFeedback", "delayMix"],
    &["fuzzEnabled", "fuzzGain", "fuzzTone", "fuzzLevel"],
    &["phaserEnabled", "phaserRate", "phaserDepth", "phaserFeedback"],
    &["tremoloEnabled", "tremoloRate", "tremoloDepth", "tremoloShape"],
    &["reverbEnabled", "reverbDecay", "reverbTone", "reverbMix"],
    &["tunerEnabled"],
];

/// Most parameters of one module (the amp's eight).
pub const MODULE_PARAMS_MAX: usize = 8;

const BASE: [ParamDef; 46] = [
    d("compSustain", 0.35, 0.0, 1.0),
    d("compAttack", 10.0, 0.5, 50.0),
    d("compLevel", 0.0, -18.0, 18.0),
    d("driveGain", 9.0, 0.0, 30.0),
    d("driveTone", 0.5, 0.0, 1.0),
    d("driveLevel", -3.0, -24.0, 12.0),
    d("chorusRate", 0.8, 0.1, 5.0),
    d("chorusDepth", 0.35, 0.0, 1.0),
    d("chorusMix", 0.25, 0.0, 0.6),
    d("delayTime", 320.0, 30.0, 1200.0),
    d("delayFeedback", 0.3, 0.0, 0.85),
    d("delayMix", 0.2, 0.0, 0.6),
    d("ampGain", 10.0, 0.0, 36.0),
    d("ampBass", 0.0, -12.0, 12.0),
    d("ampMid", 0.0, -12.0, 12.0),
    d("ampTreble", 0.0, -12.0, 12.0),
    d("ampPresence", 0.0, -9.0, 9.0),
    d("ampLevel", -6.0, -36.0, 6.0),
    d("compEnabled", 1.0, 0.0, 1.0),
    d("driveEnabled", 0.0, 0.0, 1.0),
    d("chorusEnabled", 0.0, 0.0, 1.0),
    d("delayEnabled", 0.0, 0.0, 1.0),
    d("ampEnabled", 1.0, 0.0, 1.0),
    d("cabinetEnabled", 1.0, 0.0, 1.0),
    d("ampModel", 0.0, 0.0, 4.0),
    d("cabinet", 1.0, 0.0, 4.0),
    d("micType", 0.0, 0.0, 4.0),
    d("micPosition", 0.35, 0.0, 1.0),
    d("micDistance", 0.15, 0.0, 1.0),
    d("fuzzGain", 26.0, 0.0, 40.0),
    d("fuzzTone", 0.45, 0.0, 1.0),
    d("fuzzLevel", -14.0, -36.0, 0.0),
    d("phaserRate", 0.45, 0.05, 4.0),
    d("phaserDepth", 0.7, 0.0, 1.0),
    d("phaserFeedback", 0.35, 0.0, 0.85),
    d("tremoloRate", 4.5, 0.5, 12.0),
    d("tremoloDepth", 0.5, 0.0, 1.0),
    d("tremoloShape", 0.0, 0.0, 1.0),
    d("reverbDecay", 0.45, 0.0, 1.0),
    d("reverbTone", 0.5, 0.0, 1.0),
    d("reverbMix", 0.25, 0.0, 0.8),
    d("fuzzEnabled", 0.0, 0.0, 1.0),
    d("phaserEnabled", 0.0, 0.0, 1.0),
    d("tremoloEnabled", 0.0, 0.0, 1.0),
    d("reverbEnabled", 0.0, 0.0, 1.0),
    d("tunerEnabled", 0.0, 0.0, 1.0),
];

/// A copy's id with the default and range of its base id (compile time only).
#[allow(clippy::indexing_slicing)]
const fn copy(id: &'static str, base: &str) -> ParamDef {
    let def = BASE[index_of(&BASE, base)];
    d(id, def.default, def.min, def.max)
}

macro_rules! copies {
    ($( [$($id:literal),*] ),* $(,)?) => {
        [$( $( copy(concat!($id, "_2"), $id), )* $( copy(concat!($id, "_3"), $id), )* )*]
    };
}

const COPIES: [ParamDef; 90] = copies![
    ["compEnabled", "compSustain", "compAttack", "compLevel"],
    ["driveEnabled", "driveGain", "driveTone", "driveLevel"],
    ["ampEnabled", "ampGain", "ampBass", "ampMid", "ampTreble", "ampPresence", "ampLevel", "ampModel"],
    ["cabinetEnabled", "cabinet", "micType", "micPosition", "micDistance"],
    ["chorusEnabled", "chorusRate", "chorusDepth", "chorusMix"],
    ["delayEnabled", "delayTime", "delayFeedback", "delayMix"],
    ["fuzzEnabled", "fuzzGain", "fuzzTone", "fuzzLevel"],
    ["phaserEnabled", "phaserRate", "phaserDepth", "phaserFeedback"],
    ["tremoloEnabled", "tremoloRate", "tremoloDepth", "tremoloShape"],
    ["reverbEnabled", "reverbDecay", "reverbTone", "reverbMix"],
];

/// Largest slot value: code 11, instance 2.
const MAX_SLOT: f64 = (MODULE_CODES - 1 + INSTANCE_STRIDE * (MAX_INSTANCES - 1)) as f64;

/// Default rack: comp, drive, amp, cabinet, chorus, delay.
const SLOT_PARAMS: [ParamDef; SLOTS] = [
    d("rackSlot0", 1.0, 0.0, MAX_SLOT),
    d("rackSlot1", 2.0, 0.0, MAX_SLOT),
    d("rackSlot2", 3.0, 0.0, MAX_SLOT),
    d("rackSlot3", 4.0, 0.0, MAX_SLOT),
    d("rackSlot4", 5.0, 0.0, MAX_SLOT),
    d("rackSlot5", 6.0, 0.0, MAX_SLOT),
    d("rackSlot6", 0.0, 0.0, MAX_SLOT),
    d("rackSlot7", 0.0, 0.0, MAX_SLOT),
    d("rackSlot8", 0.0, 0.0, MAX_SLOT),
    d("rackSlot9", 0.0, 0.0, MAX_SLOT),
    d("rackSlot10", 0.0, 0.0, MAX_SLOT),
    d("rackSlot11", 0.0, 0.0, MAX_SLOT),
    d("rackSlot12", 0.0, 0.0, MAX_SLOT),
    d("rackSlot13", 0.0, 0.0, MAX_SLOT),
    d("rackSlot14", 0.0, 0.0, MAX_SLOT),
    d("rackSlot15", 0.0, 0.0, MAX_SLOT),
    d("rackSlot16", 0.0, 0.0, MAX_SLOT),
    d("rackSlot17", 0.0, 0.0, MAX_SLOT),
];

/// Number of rig parameters (46 + 90 + 18).
pub const PARAM_COUNT: usize = BASE.len() + COPIES.len() + SLOTS;

#[allow(clippy::indexing_slicing)]
const fn concat() -> [ParamDef; PARAM_COUNT] {
    let mut out = [d("", 0.0, 0.0, 0.0); PARAM_COUNT];
    let mut i = 0;
    while i < BASE.len() {
        out[i] = BASE[i];
        i += 1;
    }
    let mut j = 0;
    while j < COPIES.len() {
        out[i] = COPIES[j];
        i += 1;
        j += 1;
    }
    let mut k = 0;
    while k < SLOTS {
        out[i] = SLOT_PARAMS[k];
        i += 1;
        k += 1;
    }
    out
}

static ALL: [ParamDef; PARAM_COUNT] = concat();
/// The whole catalog, in `guitarRigDefs()` order.
// Statics, not consts: one copy in the binary however many places read them.
pub static PARAMS: &[ParamDef] = &ALL;

/// Index of the first `rackSlot` parameter.
pub const FIRST_SLOT: usize = BASE.len() + COPIES.len();

/// Catalog index of module `code`'s `k`-th parameter (`MODULE_PARAMS` order) for `instance`.
#[allow(clippy::indexing_slicing)]
const fn param_index(code: usize, instance: usize, k: usize) -> usize {
    if instance == 0 {
        return index_of(&BASE, MODULE_PARAMS[code][k]);
    }
    let mut offset = BASE.len();
    let mut c = 1;
    while c < code {
        offset += (max_instances(c) - 1) * MODULE_PARAMS[c].len();
        c += 1;
    }
    offset + (instance - 1) * MODULE_PARAMS[code].len() + k
}

#[allow(clippy::indexing_slicing)]
const fn index_table() -> [[[u16; MODULE_PARAMS_MAX]; MAX_INSTANCES]; MODULE_CODES] {
    let mut t = [[[u16::MAX; MODULE_PARAMS_MAX]; MAX_INSTANCES]; MODULE_CODES];
    let mut code = 1;
    while code < MODULE_CODES {
        let mut instance = 0;
        while instance < max_instances(code) {
            let mut k = 0;
            while k < MODULE_PARAMS[code].len() {
                let index = param_index(code, instance, k);
                // A missing id is a build error, never a runtime fallback.
                assert!(index < PARAM_COUNT);
                t[code][instance][k] = index as u16;
                k += 1;
            }
            instance += 1;
        }
        code += 1;
    }
    t
}

/// `INDEX[code][instance][k]`: the catalog index behind `RigParams(base)` for that instance.
pub(crate) static INDEX: [[[u16; MODULE_PARAMS_MAX]; MAX_INSTANCES]; MODULE_CODES] = index_table();

/// No module reads the parameter (the rack slots).
pub(crate) const NO_OWNER: u8 = u8::MAX;

#[allow(clippy::indexing_slicing)]
const fn owner_table() -> [u8; PARAM_COUNT] {
    let index = index_table();
    let mut t = [NO_OWNER; PARAM_COUNT];
    let mut code = 1;
    while code < MODULE_CODES {
        let mut instance = 0;
        while instance < max_instances(code) {
            let mut k = 0;
            while k < MODULE_PARAMS[code].len() {
                t[index[code][instance][k] as usize] = (code * MAX_INSTANCES + instance) as u8;
                k += 1;
            }
            instance += 1;
        }
        code += 1;
    }
    t
}

/// `OWNER[i]`: `code * MAX_INSTANCES + instance` of the module that reads parameter `i`, or
/// [`NO_OWNER`].
pub(crate) static OWNER: [u8; PARAM_COUNT] = owner_table();

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_complete_and_consistent() {
        assert_eq!(PARAM_COUNT, 154);
        for def in PARAMS {
            assert!(def.min <= def.default && def.default <= def.max, "{}", def.id);
        }
        for (i, a) in PARAMS.iter().enumerate() {
            for b in &PARAMS[..i] {
                assert_ne!(a.id, b.id);
            }
        }
        // Every instance index points at "<base>" or "<base>_<n>".
        for code in 1..MODULE_CODES {
            for instance in 0..max_instances(code) {
                for (k, base) in MODULE_PARAMS[code].iter().enumerate() {
                    let def = PARAMS[usize::from(INDEX[code][instance][k])];
                    let expected = if instance == 0 {
                        std::string::String::from(*base)
                    } else {
                        std::format!("{base}_{}", instance + 1)
                    };
                    assert_eq!(def.id, expected);
                }
            }
        }
        assert_eq!(PARAMS[FIRST_SLOT].id, "rackSlot0");
        assert_eq!(PARAMS[PARAM_COUNT - 1].max, 43.0);
    }
}

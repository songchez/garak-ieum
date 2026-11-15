//! Parameter catalogs of the built-in effects: ids, defaults and ranges in the order of
//! `effectDefs()` / `sigimsaeDefs()` / `eqDefs()` in native/src/dsp.cpp (which mirror
//! src/devices/effects/sigimsaeDefs.ts and eqModel.ts). The C++ adapter checks at construction that
//! both sides list the same ids in the same order, so a drift fails loudly instead of mis-wiring.

use crate::clamp;

/// One parameter: persisted id, default and inclusive range.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ParamDef {
    pub id: &'static str,
    pub default: f64,
    pub min: f64,
    pub max: f64,
}

const fn d(id: &'static str, default: f64, min: f64, max: f64) -> ParamDef {
    ParamDef { id, default, min, max }
}

/// Largest catalog (the 8-band EQ has 49 parameters).
pub const MAX_PARAMS: usize = 64;

/// Effect kinds of the C ABI / WASM exports. Values are part of the ABI: append only.
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EffectKind {
    Delay = 0,
    Chorus = 1,
    Phaser = 2,
    Flanger = 3,
    Tremolo = 4,
    Limiter = 5,
    Gate = 6,
    Tape = 7,
    Bitcrusher = 8,
    Utility = 9,
    Eq = 10,
    Filter = 11,
    Compressor = 12,
    Drive = 13,
    Reverb = 14,
}

impl EffectKind {
    pub const ALL: [EffectKind; 15] = [
        Self::Delay,
        Self::Chorus,
        Self::Phaser,
        Self::Flanger,
        Self::Tremolo,
        Self::Limiter,
        Self::Gate,
        Self::Tape,
        Self::Bitcrusher,
        Self::Utility,
        Self::Eq,
        Self::Filter,
        Self::Compressor,
        Self::Drive,
        Self::Reverb,
    ];

    pub fn from_u32(v: u32) -> Option<Self> {
        Self::ALL.get(v as usize).copied()
    }

    /// The effect type id used by projects (`makeEffect("chorus", ...)`).
    pub fn id(self) -> &'static str {
        match self {
            Self::Delay => "delay",
            Self::Chorus => "chorus",
            Self::Phaser => "phaser",
            Self::Flanger => "flanger",
            Self::Tremolo => "tremolo",
            Self::Limiter => "limiter",
            Self::Gate => "gate",
            Self::Tape => "tape",
            Self::Bitcrusher => "bitcrusher",
            Self::Utility => "utility",
            Self::Eq => "eq",
            Self::Filter => "filter",
            Self::Compressor => "compressor",
            Self::Drive => "drive",
            Self::Reverb => "reverb",
        }
    }

    pub fn from_id(id: &[u8]) -> Option<Self> {
        Self::ALL.iter().copied().find(|k| k.id().as_bytes() == id)
    }

    pub fn params(self) -> &'static [ParamDef] {
        match self {
            Self::Delay => DELAY,
            Self::Chorus => CHORUS,
            Self::Phaser => PHASER,
            Self::Flanger => FLANGER,
            Self::Tremolo => TREMOLO,
            Self::Limiter => LIMITER,
            Self::Gate => GATE,
            Self::Tape => TAPE,
            Self::Bitcrusher => BITCRUSHER,
            Self::Utility => UTILITY,
            Self::Eq => EQ,
            Self::Filter => FILTER,
            Self::Compressor => COMPRESSOR,
            Self::Drive => DRIVE,
            Self::Reverb => REVERB,
        }
    }
}

pub const DELAY: &[ParamDef] = &[
    d("amount", 0.3, 0.0, 1.0),
    d("time", 0.75, 1.0 / 6.0, 4.0),
    d("feedback", 0.32, 0.0, 0.95),
    d("tone", 3800.0, 500.0, 16000.0),
    d("lowcut", 20.0, 20.0, 2000.0),
    d("age", 0.0, 0.0, 1.0),
    d("sync", 1.0, 0.0, 1.0),
    d("ms", 375.0, 1.0, 2000.0),
    d("mode", 0.0, 0.0, 1.0),
    d("dry", 1.0, 0.0, 1.0),
];
pub const CHORUS: &[ParamDef] =
    &[d("rate", 0.8, 0.05, 5.0), d("depth", 0.5, 0.0, 1.0), d("mix", 0.5, 0.0, 1.0)];
pub const PHASER: &[ParamDef] = &[
    d("rate", 0.5, 0.05, 5.0),
    d("depth", 0.7, 0.0, 1.0),
    d("feedback", 0.4, 0.0, 0.9),
    d("mix", 1.0, 0.0, 1.0),
];
pub const FLANGER: &[ParamDef] = &[
    d("rate", 0.25, 0.05, 5.0),
    d("depth", 0.7, 0.0, 1.0),
    d("feedback", 0.6, 0.0, 0.95),
    d("mix", 1.0, 0.0, 1.0),
];
pub const TREMOLO: &[ParamDef] = &[
    d("rate", 4.0, 0.1, 20.0),
    d("depth", 0.5, 0.0, 1.0),
    d("shape", 0.0, 0.0, 1.0),
    d("sync", 0.0, 0.0, 4.0),
    d("pan", 0.0, 0.0, 1.0),
];
pub const LIMITER: &[ParamDef] =
    &[d("gain", 0.0, 0.0, 24.0), d("ceiling", -1.0, -24.0, 0.0), d("release", 100.0, 10.0, 1000.0)];
pub const GATE: &[ParamDef] = &[
    d("threshold", -50.0, -80.0, 0.0),
    d("attack", 1.0, 0.1, 50.0),
    d("hold", 50.0, 0.0, 500.0),
    d("release", 150.0, 5.0, 2000.0),
];
pub const TAPE: &[ParamDef] = &[
    d("drive", 6.0, 0.0, 24.0),
    d("warmth", 0.5, 0.0, 1.0),
    d("mix", 1.0, 0.0, 1.0),
    d("output", 0.0, -24.0, 6.0),
];
pub const BITCRUSHER: &[ParamDef] =
    &[d("bits", 8.0, 1.0, 16.0), d("downsample", 4.0, 1.0, 32.0), d("mix", 1.0, 0.0, 1.0)];
pub const UTILITY: &[ParamDef] = &[
    d("gain", 0.0, -36.0, 24.0),
    d("pan", 0.0, -1.0, 1.0),
    d("width", 1.0, 0.0, 2.0),
    d("mono", 0.0, 0.0, 1.0),
    d("phase", 0.0, 0.0, 3.0),
];
pub const FILTER: &[ParamDef] = &[
    d("cutoff", 1200.0, 20.0, 20000.0),
    d("resonance", 0.7, 0.1, 18.0),
    d("mode", 0.0, 0.0, 2.0),
    d("slope", 0.0, 0.0, 2.0),
];
pub const COMPRESSOR: &[ParamDef] = &[
    d("threshold", -18.0, -60.0, 0.0),
    d("ratio", 4.0, 1.0, 20.0),
    d("attack", 10.0, 0.1, 100.0),
    d("release", 150.0, 10.0, 1000.0),
    d("makeup", 0.0, 0.0, 24.0),
];
pub const DRIVE: &[ParamDef] = &[
    d("drive", 9.0, 0.0, 36.0),
    d("tone", 9000.0, 500.0, 20000.0),
    d("mix", 1.0, 0.0, 1.0),
    d("output", 0.0, -24.0, 6.0),
];
pub const REVERB: &[ParamDef] = &[
    d("amount", 0.3, 0.0, 1.0),
    d("size", 0.35, 0.0, 1.0),
    d("tone", 9000.0, 1000.0, 20000.0),
    d("type", 0.0, 0.0, 3.0),
    d("predelay", 0.0, 0.0, 250.0),
    d("lowcut", 20.0, 20.0, 1000.0),
    d("dry", 1.0, 0.0, 1.0),
];

/// eq_effects.inc `eqDefs()`: five legacy ids, then per band On, Type, [Freq], [Gain], Q, Slope.
/// Band 2's frequency is `midFreq`; the gains of bands 1-3 are `low` / `mid` / `high`.
pub const EQ: &[ParamDef] = &[
    d("low", 0.0, -24.0, 24.0),
    d("mid", 0.0, -24.0, 24.0),
    d("midFreq", 1000.0, 20.0, 20000.0),
    d("high", 0.0, -24.0, 24.0),
    d("output", 0.0, -24.0, 24.0),
    d("b1On", 1.0, 0.0, 2.0),
    d("b1Type", 1.0, 0.0, 5.0),
    d("b1Freq", 220.0, 20.0, 20000.0),
    d("b1Q", 1.0, 0.1, 18.0),
    d("b1Slope", 0.0, 0.0, 3.0),
    d("b2On", 1.0, 0.0, 2.0),
    d("b2Type", 0.0, 0.0, 5.0),
    d("b2Q", 0.9, 0.1, 18.0),
    d("b2Slope", 0.0, 0.0, 3.0),
    d("b3On", 1.0, 0.0, 2.0),
    d("b3Type", 2.0, 0.0, 5.0),
    d("b3Freq", 4500.0, 20.0, 20000.0),
    d("b3Q", 1.0, 0.1, 18.0),
    d("b3Slope", 0.0, 0.0, 3.0),
    d("b4On", 0.0, 0.0, 2.0),
    d("b4Type", 3.0, 0.0, 5.0),
    d("b4Freq", 40.0, 20.0, 20000.0),
    d("b4Gain", 0.0, -24.0, 24.0),
    d("b4Q", 0.71, 0.1, 18.0),
    d("b4Slope", 0.0, 0.0, 3.0),
    d("b5On", 0.0, 0.0, 2.0),
    d("b5Type", 0.0, 0.0, 5.0),
    d("b5Freq", 180.0, 20.0, 20000.0),
    d("b5Gain", 0.0, -24.0, 24.0),
    d("b5Q", 1.0, 0.1, 18.0),
    d("b5Slope", 0.0, 0.0, 3.0),
    d("b6On", 0.0, 0.0, 2.0),
    d("b6Type", 0.0, 0.0, 5.0),
    d("b6Freq", 600.0, 20.0, 20000.0),
    d("b6Gain", 0.0, -24.0, 24.0),
    d("b6Q", 1.0, 0.1, 18.0),
    d("b6Slope", 0.0, 0.0, 3.0),
    d("b7On", 0.0, 0.0, 2.0),
    d("b7Type", 0.0, 0.0, 5.0),
    d("b7Freq", 2500.0, 20.0, 20000.0),
    d("b7Gain", 0.0, -24.0, 24.0),
    d("b7Q", 1.0, 0.1, 18.0),
    d("b7Slope", 0.0, 0.0, 3.0),
    d("b8On", 0.0, 0.0, 2.0),
    d("b8Type", 4.0, 0.0, 5.0),
    d("b8Freq", 16000.0, 20.0, 20000.0),
    d("b8Gain", 0.0, -24.0, 24.0),
    d("b8Q", 0.71, 0.1, 18.0),
    d("b8Slope", 0.0, 0.0, 3.0),
];

/// Index of `id` in `defs`, evaluated at compile time (usize::MAX when absent, which the
/// `const` assertions below turn into a build error). Compile-time only: an out-of-range index
/// here is a build error, never a runtime panic.
#[allow(clippy::indexing_slicing)]
pub const fn index_of(defs: &[ParamDef], id: &str) -> usize {
    let mut i = 0;
    while i < defs.len() {
        let a = defs[i].id.as_bytes();
        let b = id.as_bytes();
        if a.len() == b.len() {
            let mut j = 0;
            let mut same = true;
            while j < a.len() {
                if a[j] != b[j] {
                    same = false;
                }
                j += 1;
            }
            if same {
                return i;
            }
        }
        i += 1;
    }
    usize::MAX
}

/// A full, clamped parameter vector of one effect (control-side storage of `set_param`).
#[derive(Clone, Copy, Debug)]
pub struct ParamSet {
    values: [f64; MAX_PARAMS],
    defs: &'static [ParamDef],
}

impl ParamSet {
    /// Defaults of `kind`.
    pub fn defaults(kind: EffectKind) -> Self {
        let defs = kind.params();
        let mut values = [0.0; MAX_PARAMS];
        for (v, def) in values.iter_mut().zip(defs) {
            *v = def.default;
        }
        Self { values, defs }
    }

    /// `values` in catalog order; missing entries keep the default, non-finite values are ignored
    /// and the rest is clamped to the range (EffectControl::set semantics).
    pub fn from_values(kind: EffectKind, values: &[f64]) -> Self {
        let mut p = Self::defaults(kind);
        for (i, &v) in values.iter().enumerate() {
            p.set(i, v);
        }
        p
    }

    /// Returns true when the stored value changed.
    pub fn set(&mut self, index: usize, value: f64) -> bool {
        let (Some(def), Some(slot)) = (self.defs.get(index), self.values.get_mut(index)) else {
            return false;
        };
        if !value.is_finite() {
            return false;
        }
        let v = clamp(value, def.min, def.max);
        let changed = *slot != v;
        *slot = v;
        changed
    }

    #[inline]
    pub fn get(&self, index: usize) -> f64 {
        self.values.get(index).copied().unwrap_or(0.0)
    }

    pub fn len(&self) -> usize {
        self.defs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.defs.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogs_fit_and_defaults_are_in_range() {
        for kind in EffectKind::ALL {
            let defs = kind.params();
            assert!(defs.len() <= MAX_PARAMS);
            assert_eq!(EffectKind::from_id(kind.id().as_bytes()), Some(kind));
            assert_eq!(EffectKind::from_u32(kind as u32), Some(kind));
            for def in defs {
                assert!(def.min <= def.default && def.default <= def.max, "{} {}", kind.id(), def.id);
            }
        }
        assert_eq!(EQ.len(), 49);
    }

    #[test]
    fn param_set_clamps_and_ignores_non_finite() {
        let mut p = ParamSet::defaults(EffectKind::Chorus);
        assert!(p.set(0, 99.0));
        assert_eq!(p.get(0), 5.0);
        assert!(!p.set(0, f64::NAN));
        assert!(!p.set(7, 1.0));
        assert_eq!(p.get(0), 5.0);
    }
}

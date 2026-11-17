//! IEUM WAVE patches (the former C++ IEUM WAVE synth (0.3.2)): the patch model, parameter
//! and patch validation, and the strict IEWAVE01 bridge-pack decoder (plus the base64 the
//! timeline carries it in).

use alloc::string::String;
use alloc::vec::Vec;

use super::math::{TAU, cos, round};
use super::schema as g;

pub const MOD_SOURCE_COUNT: u32 = 19;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ModRoute {
    pub source: u32,
    pub destination: usize,
    pub aux: u32,
    pub amount: f32,
    pub curve: f32,
    pub bipolar: bool,
    pub enabled: bool,
}

impl Default for ModRoute {
    fn default() -> Self {
        // the former C++ IEUM WAVE synth (0.3.2) defaults: Env2 -> Filter1Cutoff, disabled.
        Self {
            source: 1,
            destination: 42,
            aux: g::NO_AUX_SOURCE,
            amount: 0.0,
            curve: 0.0,
            bipolar: false,
            enabled: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Patch {
    pub params: [f32; g::PARAM_COUNT],
    pub lfo_curves: [[f32; g::LFO_POINTS]; g::LFOS],
    pub routes: [ModRoute; g::MAX_MOD_ROUTES],
}

impl Default for Patch {
    fn default() -> Self {
        let mut lfo_curves = [[0.0f32; g::LFO_POINTS]; g::LFOS];
        for (lfo, curve) in lfo_curves.iter_mut().enumerate() {
            for (i, v) in curve.iter_mut().enumerate() {
                let phase = i as f64 / g::LFO_POINTS as f64;
                *v = (match lfo {
                    0 => 0.5 - 0.5 * cos(TAU * phase),
                    1 => 1.0 - (2.0 * phase - 1.0).abs(),
                    2 => phase,
                    _ => 1.0 - phase,
                }) as f32;
            }
        }
        Self { params: g::DEFAULTS, lfo_curves, routes: [ModRoute::default(); g::MAX_MOD_ROUTES] }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CustomBank {
    pub slot: u32,
    pub frame_count: u32,
    pub samples: Vec<f32>,
}

/// the former C++ IEUM WAVE synth (0.3.2) `validateParameter`.
pub fn validate_parameter(index: usize, value: f32) -> bool {
    let (Some(&min), Some(&max), Some(&integer), Some(&options), Some(values)) = (
        g::MINIMUM.get(index),
        g::MAXIMUM.get(index),
        g::INTEGER.get(index),
        g::OPTION_COUNT.get(index),
        g::OPTION_VALUES.get(index),
    ) else {
        return false;
    };
    if !value.is_finite()
        || value < min
        || value > max
        || (integer && f64::from(value) != round(f64::from(value)))
    {
        return false;
    }
    if options != 0 && !values.iter().take(usize::from(options)).any(|o| *o == value) {
        return false;
    }
    true
}

/// the former C++ IEUM WAVE synth (0.3.2) `validatePatch`.
pub fn validate_patch(patch: &Patch) -> bool {
    if !patch.params.iter().enumerate().all(|(i, v)| validate_parameter(i, *v)) {
        return false;
    }
    if !patch.lfo_curves.iter().flatten().all(|v| v.is_finite() && *v >= 0.0 && *v <= 1.0) {
        return false;
    }
    patch.routes.iter().all(|r| {
        r.source < MOD_SOURCE_COUNT
            && g::MODULATABLE.get(r.destination).copied().unwrap_or(false)
            && (r.aux == g::NO_AUX_SOURCE || r.aux < MOD_SOURCE_COUNT)
            && r.amount.is_finite()
            && r.amount.abs() <= 1.0
            && r.curve.is_finite()
            && r.curve.abs() <= 1.0
    })
}

/// Standard base64 (the renderer's `patchData`), strict: rejects other characters.
pub fn unbase64(text: &str) -> Result<Vec<u8>, String> {
    let value = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => u32::from(c - b'A'),
            b'a'..=b'z' => u32::from(c - b'a') + 26,
            b'0'..=b'9' => u32::from(c - b'0') + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        })
    };
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return Err(String::from("Invalid base64 length"));
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for (index, chunk) in bytes.chunks(4).enumerate() {
        let last = index + 1 == bytes.len() / 4;
        let pad = chunk.iter().rev().take_while(|c| **c == b'=').count();
        if pad > 2 || (pad > 0 && !last) {
            return Err(String::from("Invalid base64 padding"));
        }
        let mut word = 0u32;
        for (k, &c) in chunk.iter().enumerate() {
            let v = if k >= 4 - pad {
                0
            } else {
                value(c).ok_or_else(|| String::from("Invalid base64 character"))?
            };
            word = (word << 6) | v;
        }
        out.push((word >> 16) as u8);
        if pad < 2 {
            out.push((word >> 8) as u8);
        }
        if pad < 1 {
            out.push(word as u8);
        }
    }
    Ok(out)
}

/// the former C++ IEUM WAVE synth (0.3.2) `decodePatchBundle`: the IEWAVE01 pack (patch + user banks).
pub fn decode_patch_bundle(data: &[u8]) -> Result<(Patch, Vec<CustomBank>), String> {
    let err = |m: &str| Err(String::from(m));
    if data.len() < 32 || data.len() > 3 * 1024 * 1024 {
        return err("Invalid bridge pack size");
    }
    if data.get(..8) != Some(b"IEWAVE01".as_slice()) {
        return err("Invalid bridge pack magic");
    }
    struct Reader<'a> {
        data: &'a [u8],
        cursor: usize,
    }
    impl Reader<'_> {
        fn u32(&mut self) -> Result<u32, String> {
            let b = match self.data.get(self.cursor..self.cursor + 4) {
                Some(&[a, b, c, d]) => [a, b, c, d],
                _ => return Err(String::from("Truncated bridge pack")),
            };
            self.cursor += 4;
            Ok(u32::from_le_bytes(b))
        }
        fn f32(&mut self) -> Result<f32, String> {
            Ok(f32::from_bits(self.u32()?))
        }
    }
    let mut reader = Reader { data, cursor: 8 };
    if reader.u32()? != 1 {
        return err("Unsupported bridge version");
    }
    if reader.u32()? != g::SCHEMA_FINGERPRINT {
        return err("Parameter schema fingerprint mismatch");
    }
    if reader.u32()? as usize != g::PARAM_COUNT {
        return err("Parameter count mismatch");
    }
    let bank_count = reader.u32()? as usize;
    let route_count = reader.u32()? as usize;
    if reader.u32()? != 0 || bank_count > g::MAX_USER_BANKS || route_count > g::MAX_MOD_ROUTES {
        return err("Invalid bridge counts or reserved field");
    }
    let mut patch = Patch::default();
    for v in &mut patch.params {
        *v = reader.f32()?;
    }
    for v in patch.lfo_curves.iter_mut().flatten() {
        *v = reader.f32()?;
    }
    for i in 0..route_count {
        let (source, destination, aux, flags) = (reader.u32()?, reader.u32()?, reader.u32()?, reader.u32()?);
        if source >= MOD_SOURCE_COUNT || destination as usize >= g::PARAM_COUNT || (flags & !3) != 0 {
            return err("Invalid modulation route");
        }
        let amount = reader.f32()?;
        let curve = reader.f32()?;
        if let Some(r) = patch.routes.get_mut(i) {
            *r = ModRoute {
                source,
                destination: destination as usize,
                aux,
                amount,
                curve,
                bipolar: flags & 1 != 0,
                enabled: flags & 2 != 0,
            };
        }
    }
    if !validate_patch(&patch) {
        return err("Invalid patch parameter, curve, or routing value");
    }
    let mut seen = [false; 8];
    let mut banks = Vec::new();
    for _ in 0..bank_count {
        let slot = reader.u32()?;
        let frame_count = reader.u32()?;
        if !(4..=7).contains(&slot)
            || seen.get(slot as usize).copied().unwrap_or(true)
            || frame_count == 0
            || frame_count as usize > g::MAX_FRAMES
        {
            return err("Invalid or duplicate user wavetable bank");
        }
        if let Some(s) = seen.get_mut(slot as usize) {
            *s = true;
        }
        let count = frame_count as usize * g::WAVETABLE_SIZE;
        if count > (data.len() - reader.cursor) / 4 {
            return err("Truncated user wavetable bank");
        }
        let mut samples = Vec::with_capacity(count);
        for _ in 0..count {
            let s = reader.f32()?;
            if !s.is_finite() || !(-1.0..=1.0).contains(&s) {
                return err("Invalid user waveform sample");
            }
            samples.push(s);
        }
        banks.push(CustomBank { slot, frame_count, samples });
    }
    for osc in 0..g::OSCILLATORS {
        let bank = patch.params.get(osc * 12 + 1).copied().unwrap_or(0.0) as usize;
        if bank >= 4 && !seen.get(bank).copied().unwrap_or(false) {
            return err("Selected user wavetable bank is missing");
        }
    }
    if reader.cursor != data.len() {
        return err("Trailing bytes in bridge pack");
    }
    Ok((patch, banks))
}

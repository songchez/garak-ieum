use super::*;
use std::string::String;
use std::vec;
use std::vec::Vec;

const SR: f64 = 48_000.0;

fn index(id: &str) -> usize {
    PARAMS.iter().position(|d| d.id == id).unwrap()
}

/// Defaults with `changes` applied (by id).
fn values(changes: &[(&str, f64)]) -> Vec<f64> {
    let mut v: Vec<f64> = PARAMS.iter().map(|d| d.default).collect();
    for (id, x) in changes {
        v[index(id)] = *x;
    }
    v
}

fn kernels_for(v: &[f64], sr: f64) -> (Vec<Vec<f32>>, usize) {
    let len = reverb_ir_len(sr);
    let mut out = vec![Vec::new(), Vec::new(), Vec::new()];
    for (o, decay) in out.iter_mut().zip(reverb_decays(v)) {
        let Some(decay) = decay else { continue };
        let (mut l, mut r, mut s) = (vec![0.0; len], vec![0.0; len], vec![0.0; reverb_ir_scratch_len(sr)]);
        assert!(generate_reverb_ir(sr, decay, &mut l, &mut r, &mut s));
        let mut k = vec![0.0; reverb::kernel_len(len)];
        assert!(reverb::prepare_kernels(&l, &r, len, &mut k));
        *o = k;
    }
    (out, len)
}

fn programme(frames: usize) -> Vec<f32> {
    (0..frames * 2)
        .map(|i| math::sinf(i as f32 * 0.013) * 0.6 + if i % 4001 == 0 { 0.9 } else { 0.0 })
        .collect()
}

#[test]
fn default_rack_builds_reports_and_stays_finite() {
    let v = values(&[]);
    let layout = Layout::from_values(&sanitize(&v));
    assert_eq!(layout.modules(), &[(1, 0), (2, 0), (3, 0), (4, 0), (5, 0), (6, 0)]);
    let mut storage = vec![0.0; GuitarRig::storage_len(SR, &v, 0)];
    let mut rig = GuitarRig::new(SR, &v, &mut storage, [&[]; 3], 0).unwrap();
    // Drive is off by default: only the amp's two shapers delay the signal.
    assert_eq!(rig.latency_frames(), 16);
    assert_eq!(rig.tail_seconds(), 0.0);
    let mut buf = programme(4096);
    rig.process_interleaved(&mut buf);
    assert!(buf.iter().all(|x| x.is_finite()) && buf.iter().any(|x| x.abs() > 1e-3));
    rig.set_param(index("driveEnabled"), 1.0);
    rig.set_param(index("chorusEnabled"), 1.0);
    rig.commit();
    assert_eq!(rig.latency_frames(), 24);
    assert!((rig.tail_seconds() - 0.04).abs() < 1e-12);
}

#[test]
fn every_module_and_copy_runs() {
    // Every code, instances 0..2 where allowed, 18 slots full.
    let mut changes: Vec<(String, f64)> = Vec::new();
    let mut slot = 0;
    for code in 1..12usize {
        for instance in 0..catalog::max_instances(code) {
            if slot < 18 {
                changes.push((std::format!("rackSlot{slot}"), (code + 16 * instance) as f64));
                slot += 1;
            }
        }
    }
    for base in ["drive", "fuzz", "chorus", "delay", "phaser", "tremolo", "reverb"] {
        changes.push((std::format!("{base}Enabled"), 1.0));
    }
    let refs: Vec<(&str, f64)> = changes.iter().map(|(k, v)| (k.as_str(), *v)).collect();
    let v = values(&refs);
    let sr = 16_000.0;
    let (kernels, len) = kernels_for(&v, sr);
    let mut storage = vec![0.0; GuitarRig::storage_len(sr, &v, len)];
    let mut rig = GuitarRig::new(sr, &v, &mut storage, [&kernels[0], &kernels[1], &kernels[2]], len).unwrap();
    assert_eq!(rig.modules().count(), 18);
    let mut buf = programme(3000);
    rig.process_interleaved(&mut buf);
    assert!(buf.iter().all(|x| x.is_finite()));
    rig.reset();
}

#[test]
fn duplicates_unknown_and_over_limit_slots_are_skipped() {
    let v = values(&[
        ("rackSlot0", 3.0),
        ("rackSlot1", 3.0),
        ("rackSlot2", 12.0),
        ("rackSlot3", 27.0),
        ("rackSlot4", 19.0),
        ("rackSlot5", 0.4),
    ]);
    let layout = Layout::from_values(&sanitize(&v));
    // 3 amp, 3 again (skipped), 12 unknown, 27 = tuner copy 1 (skipped), 19 = amp copy 1.
    assert_eq!(layout.modules(), &[(3, 0), (3, 1)]);
}

#[test]
fn reverb_needs_kernels_and_reports_its_tail() {
    let v = values(&[("rackSlot6", 10.0), ("reverbEnabled", 1.0)]);
    assert_eq!(reverb_decays(&v), [Some(0.45), None, None]);
    let sr = 16_000.0;
    let len = reverb_ir_len(sr);
    let mut storage = vec![0.0; GuitarRig::storage_len(sr, &v, len)];
    assert_eq!(GuitarRig::new(sr, &v, &mut storage, [&[]; 3], len).unwrap_err(), FxError::Kernels);
    let (kernels, len) = kernels_for(&v, sr);
    let mut rig = GuitarRig::new(sr, &v, &mut storage, [&kernels[0], &[], &[]], len).unwrap();
    assert!((rig.tail_seconds() - 4.45).abs() < 1e-12);
    let mut buf = vec![0.0f32; 2 * 2000];
    buf[0] = 1.0;
    rig.process_interleaved(&mut buf);
    assert!(buf.iter().skip(2).any(|x| x.abs() > 1e-6));
    // A reverb that is off at construction holds nothing and needs no kernels.
    let off = values(&[("rackSlot6", 10.0)]);
    assert_eq!(GuitarRig::storage_len(sr, &off, len), GuitarRig::storage_len(sr, &values(&[]), len));
}

#[test]
fn reordered_rack_hands_over_by_swapping_storage() {
    let a = values(&[("chorusEnabled", 1.0), ("delayEnabled", 1.0)]);
    let b = values(&[("chorusEnabled", 1.0), ("delayEnabled", 1.0), ("rackSlot4", 6.0), ("rackSlot5", 5.0)]);
    let mut sa = vec![0.0; GuitarRig::storage_len(SR, &a, 0)];
    let mut sb = vec![0.0; GuitarRig::storage_len(SR, &b, 0)];
    let mut first = GuitarRig::new(SR, &a, &mut sa, [&[]; 3], 0).unwrap();
    let mut buf = programme(2048);
    first.process_interleaved(&mut buf);
    let mut second = GuitarRig::new(SR, &b, &mut sb, [&[]; 3], 0).unwrap();
    assert!(second.take_state_from(&mut first));
    // Adding a module changes the storage layout: copied instead.
    let c = values(&[("chorusEnabled", 1.0), ("delayEnabled", 1.0), ("rackSlot6", 22.0)]);
    let mut sc = vec![0.0; GuitarRig::storage_len(SR, &c, 0)];
    let mut third = GuitarRig::new(SR, &c, &mut sc, [&[]; 3], 0).unwrap();
    assert!(!third.take_state_from(&mut second));
}

#[test]
fn tuner_taps_and_mutes() {
    let v = values(&[
        ("rackSlot0", 11.0),
        ("rackSlot1", 0.0),
        ("rackSlot2", 0.0),
        ("rackSlot3", 0.0),
        ("rackSlot4", 0.0),
        ("rackSlot5", 0.0),
        ("tunerEnabled", 1.0),
    ]);
    let mut storage = vec![0.0; GuitarRig::storage_len(SR, &v, 0)];
    let mut rig = GuitarRig::new(SR, &v, &mut storage, [&[]; 3], 0).unwrap();
    let (mut l, mut r, mut tap) = (vec![0.5f32; 64], vec![0.25f32; 64], vec![9.0f32; 64]);
    rig.process_planar_tap(&mut l, &mut r, &mut tap);
    assert!(tap.iter().all(|&x| x == 0.375));
    assert!(l.iter().chain(&r).all(|&x| x == 0.0));
}

#[test]
fn short_storage_and_bad_rates_are_refused() {
    let v = values(&[]);
    let mut storage = vec![0.0; 16];
    assert_eq!(GuitarRig::new(SR, &v, &mut storage, [&[]; 3], 0).unwrap_err(), FxError::Storage);
    assert_eq!(GuitarRig::new(1000.0, &v, &mut storage, [&[]; 3], 0).unwrap_err(), FxError::Rate);
}

#[test]
fn hostile_values_are_sanitised() {
    let mut v = values(&[]);
    v[0] = f64::NAN;
    v[1] = 1e9;
    let s = sanitize(&v);
    assert_eq!(s[0], PARAMS[0].default);
    assert_eq!(s[1], PARAMS[1].max);
    // Shorter vectors take the defaults.
    assert_eq!(sanitize(&[])[index("rackSlot2")], 3.0);
}

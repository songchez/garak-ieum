//! Instrument exports of the worklet engine (docs/RUST_ENGINE.md 6): sample set registration and
//! live MIDI to instrument tracks. Control calls (from `port.onmessage`, between render quanta);
//! each returns 0, or -1 with the message in `garak_engine_error_*`.

use super::{bytes, fail, with};

fn status<T>(result: Option<Result<T, garak_engine::Error>>) -> i32 {
    match result {
        Some(Ok(_)) => 0,
        Some(Err(e)) => fail(e.message()),
        None => fail("No engine; call garak_engine_create"),
    }
}

/// `samples.register` params as JSON (`{ id, manifest, files, startOffset }`); the zones' PCM must
/// be registered first with `garak_engine_put_asset`.
///
/// # Safety
/// `json` is null or valid for `json_len` reads.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn garak_engine_register_samples(json: *const u8, json_len: usize) -> i32 {
    // SAFETY: caller contract.
    let text = unsafe { bytes(json, json_len) };
    status(with(|i| i.control.register_samples_json(text)))
}

/// Live note-on to instrument track `track` (rings until its note-off).
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_note_on(track: u32, pitch: i32, velocity: f32, id: i32) -> i32 {
    status(with(|i| i.control.note_on(track, pitch, velocity, id)))
}

/// Live note-off (`id` >= 0 matches that note-on, else every live note of `pitch`).
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_note_off(track: u32, pitch: i32, id: i32) -> i32 {
    status(with(|i| i.control.note_off(track, pitch, id)))
}

/// An editor audition note of `frames` frames.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_preview_note(track: u32, pitch: i32, velocity: f32, frames: u32) -> i32 {
    status(with(|i| i.control.preview_note(track, pitch, velocity, frames)))
}

/// Live controller (0..127 CC, 128 pressure, 129 bend -8192..8191, 130 program, 131 bend range).
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_control_change(track: u32, controller: i32, value: i32) -> i32 {
    status(with(|i| i.control.control_change(track, controller, value)))
}

/// Live panic on one track.
#[unsafe(no_mangle)]
pub extern "C" fn garak_engine_all_notes_off(track: u32) -> i32 {
    status(with(|i| i.control.all_notes_off(track)))
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use super::*;
    use garak_engine::testkit::instruments::{ALL, instrument_project};

    #[test]
    fn instruments_through_the_exports() {
        let p = instrument_project(ALL, 0.5, 48_000);
        assert_eq!(garak_engine_create(48_000, 128, 1), 0);
        for (id, a) in &p.assets {
            let r = unsafe {
                garak_engine_put_asset(
                    id.as_ptr(),
                    id.len(),
                    a.sample_rate,
                    a.channels,
                    a.samples.as_ptr(),
                    a.samples.len(),
                )
            };
            assert_eq!(r, 0);
        }
        for s in &p.sample_sets {
            assert_eq!(unsafe { garak_engine_register_samples(s.as_ptr(), s.len()) }, 0);
        }
        assert_eq!(unsafe { garak_engine_set(p.json.as_ptr(), p.json.len(), core::ptr::null(), 0) }, 3);
        assert_eq!(garak_engine_transport(0, 0.0), 0);
        assert_eq!(garak_engine_note_on(0, 60, 0.7, 1), 0);
        assert_eq!(garak_engine_control_change(0, 64, 127), 0);
        assert_eq!(garak_engine_note_off(0, 60, 1), 0);
        assert_eq!(garak_engine_preview_note(9, 62, 0.5, 4800), 0);
        assert_eq!(garak_engine_all_notes_off(0), 0);
        assert_eq!(garak_engine_control_change(0, 129, 9000), -1);
        let mut energy = 0.0f32;
        for _ in 0..100 {
            assert_eq!(garak_engine_render(128), 128);
            let out = unsafe { core::slice::from_raw_parts(garak_engine_output_ptr(), 256) };
            energy += out.iter().map(|x| x * x).sum::<f32>();
        }
        assert!(energy > 0.0);
        garak_engine_destroy();
    }
}

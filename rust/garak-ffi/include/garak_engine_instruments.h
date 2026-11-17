/* 가락이음 Rust render engine — instrument additions to the C ABI (rust/garak-ffi/src/engine/instruments.rs).
 * Hand-written; `cargo test -p garak-ffi` fails when an exported function is missing here.
 * See docs/RUST_ENGINE.md 6. Same thread rules as garak_engine.h: every function here is the control half. */
#ifndef GARAK_ENGINE_INSTRUMENTS_H
#define GARAK_ENGINE_INSTRUMENTS_H

#include "garak_engine.h"

#ifdef __cplusplus
extern "C" {
#endif

/* samples.register params as JSON ({ id, manifest, files, startOffset }); the zones' PCM must be
 * registered first (garak_rs_engine_put_asset). Returns 0 or -1. */
int32_t garak_rs_engine_register_samples(GarakRsEngine* engine, const uint8_t* json, size_t json_len);

/* Live MIDI to instrument track `track` (graph index). Each returns the command ticket or -1. */
int64_t garak_rs_engine_note_on(GarakRsEngine* engine, uint32_t track, int32_t pitch, float velocity, int32_t id);
int64_t garak_rs_engine_note_off(GarakRsEngine* engine, uint32_t track, int32_t pitch, int32_t id);
int64_t garak_rs_engine_preview_note(GarakRsEngine* engine, uint32_t track, int32_t pitch, float velocity, uint32_t frames);
/* 0..127 CC, 128 channel pressure, 129 pitch bend (-8192..8191), 130 program, 131 bend range (0..48). */
int64_t garak_rs_engine_control_change(GarakRsEngine* engine, uint32_t track, int32_t controller, int32_t value);
int64_t garak_rs_engine_all_notes_off(GarakRsEngine* engine, uint32_t track);

/* IEUM WAVE (docs/IEUM_WAVE.md; it renders only in this engine since 0.3.3). The schema fingerprint of the
 * host handshake; patch validation before a project changes (0: valid, its export tail in seconds in
 * `tail_seconds`; -1: the reason in `error`, truncated to `capacity`, full length in `error_len`); the default
 * patch as an IEWAVE01 pack (returns its length; writes up to `capacity` bytes, `out` may be null); a
 * parameter's wire index by schema id, or -1. */
uint32_t garak_rs_wave_schema_fingerprint(void);
int32_t garak_rs_wave_check_patch(const uint8_t* patch, size_t len, double* tail_seconds, uint8_t* error, size_t capacity,
                                  size_t* error_len);
size_t garak_rs_wave_default_patch(uint8_t* out, size_t capacity);
int32_t garak_rs_wave_parameter_index(const uint8_t* id, size_t len);

/* Instrument parity projects (rust/garak-engine/src/testkit/instruments.rs): 0 synths, 1 samples,
 * 2 vintage, 3 all, 4 IEUM WAVE. Destroy with garak_rs_testkit_destroy; PCM through garak_rs_testkit_asset. */
GarakRsTestProject* garak_rs_testkit_instruments_create(uint32_t case_index, double seconds, uint32_t sample_rate);
uint32_t garak_rs_testkit_sample_set_count(const GarakRsTestProject* project);
const uint8_t* garak_rs_testkit_sample_set(const GarakRsTestProject* project, uint32_t index, size_t* len);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* GARAK_ENGINE_INSTRUMENTS_H */

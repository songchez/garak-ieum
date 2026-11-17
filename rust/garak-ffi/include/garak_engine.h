/* 가락이음 Rust render engine — C ABI (rust/garak-ffi/src/engine.rs over rust/garak-engine).
 * Hand-written; `cargo test -p garak-ffi` fails when an exported function is missing here.
 * See docs/RUST_ENGINE.md. Not used by the app yet: the C++ RenderEngine stays the default.
 *
 * Threads: garak_rs_engine_render is the audio half (no allocation, no locks, no blocking). Every
 * other garak_rs_engine_* function is the control half: one control thread at a time. The halves
 * may run concurrently. Control functions return -1 on error (garak_rs_engine_last_error has the
 * message) and never throw; null handles are ignored. */
#ifndef GARAK_ENGINE_H
#define GARAK_ENGINE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct GarakRsEngine GarakRsEngine;
typedef struct GarakRsTestProject GarakRsTestProject;

/* Applied kinds returned by set/patch (docs/RENDER_DIFF_PROTOCOL.md 3.3). */
enum GarakRsApplied { GARAK_RS_APPLIED_NONE = 0, GARAK_RS_APPLIED_DIFF = 1, GARAK_RS_APPLIED_TRACKS = 2, GARAK_RS_APPLIED_FULL = 3 };
enum GarakRsTransport { GARAK_RS_PLAY = 0, GARAK_RS_PAUSE = 1, GARAK_RS_STOP = 2, GARAK_RS_SEEK = 3 };

/* offline != 0: ignore the cycle and keep rendering past the project end (export). Null when the
 * format is invalid (8..192 kHz, 1..65536 frames per block). */
GarakRsEngine* garak_rs_engine_create(uint32_t sample_rate, uint32_t max_block, int32_t offline);
/* The audio thread must have stopped rendering. */
void garak_rs_engine_destroy(GarakRsEngine* engine);
/* Copies the last error (UTF-8, not terminated) and returns its full length. */
size_t garak_rs_engine_last_error(GarakRsEngine* engine, uint8_t* out, size_t capacity);

/* Interleaved PCM, `count` samples. Copied; replaces an asset with the same id. */
int32_t garak_rs_engine_put_asset(GarakRsEngine* engine, const uint8_t* id, size_t id_len, uint32_t sample_rate,
                                  uint32_t channels, const float* samples, size_t count);
/* project.set / project.patch: the `timeline` (or patch params) JSON and the binary frame. */
int32_t garak_rs_engine_set(GarakRsEngine* engine, const uint8_t* json, size_t json_len, const uint8_t* blob,
                            size_t blob_len);
int32_t garak_rs_engine_patch(GarakRsEngine* engine, const uint8_t* json, size_t json_len, const uint8_t* blob,
                              size_t blob_len);
/* Returns the command ticket (awaitable through garak_rs_engine_snapshot) or -1. */
int64_t garak_rs_engine_transport(GarakRsEngine* engine, uint32_t command, int64_t frame);
/* Frees retired graphs and tracks; call regularly from the control thread. */
void garak_rs_engine_collect(GarakRsEngine* engine);
void garak_rs_engine_graph_info(GarakRsEngine* engine, uint32_t* latency_frames, double* tail_seconds);
void garak_rs_engine_snapshot(GarakRsEngine* engine, uint64_t* last_applied, int64_t* frame);

/* Audio thread: `frames` interleaved stereo frames. */
void garak_rs_engine_render(GarakRsEngine* engine, float* out, uint32_t frames);

/* ---- Host shell (docs/RUST_ENGINE.md 10, GARAK_RUST_ENGINE=1) ----------------------------------
 * The C++ RenderEngine keeps transport, count-in, metronome, live MIDI, capture and the master bus,
 * and asks the Rust graph for each block's track mix at its own position. */
/* Control: the last ticket queued by set/patch/transport. */
uint64_t garak_rs_engine_ticket(GarakRsEngine* engine);
/* The host's worker pool: calls task(job, i) once for every i < count (any thread) and returns when
 * all completed, without allocating or locking. */
typedef void (*GarakRsTask)(void* job, uint32_t index);
typedef void (*GarakRsParallelRun)(void* host, uint32_t count, GarakRsTask task, void* job);
/* Audio thread: apply commands up to `allowed`, then write the track mix (no master gain/processor)
 * of `frames` frames at project frame `position` into `out`. `peaks` gets per-track block peaks.
 * `run` may be null (single thread); the output is bit-identical either way. */
void garak_rs_engine_render_block(GarakRsEngine* engine, float* out, uint32_t frames, int64_t position, int32_t playing,
                                  uint64_t allowed, float* peaks, uint32_t peak_capacity, GarakRsParallelRun run,
                                  void* host);
/* Audio thread, after render_block: compressor/limiter/gate detector peak and lowest gain since the last
 * call, in track then chain order (`insert` indexes the track plan's inserts). Returns the count. */
typedef struct GarakRsDynamicsReading { uint16_t track, insert; float input, gain; } GarakRsDynamicsReading;
uint32_t garak_rs_engine_take_dynamics(GarakRsEngine* engine, GarakRsDynamicsReading* out, uint32_t capacity);
/* Audio thread: transport reset; effects != 0 also clears tails and delay lines. */
void garak_rs_engine_reset(GarakRsEngine* engine, int32_t effects);

/* The deterministic parity project (rust/garak-engine/src/testkit.rs): timeline JSON + PCM. */
GarakRsTestProject* garak_rs_testkit_create(uint32_t tracks, double seconds, uint32_t sample_rate);
void garak_rs_testkit_destroy(GarakRsTestProject* project);
const uint8_t* garak_rs_testkit_json(const GarakRsTestProject* project, size_t* len);
uint32_t garak_rs_testkit_asset_count(const GarakRsTestProject* project);
int32_t garak_rs_testkit_asset(const GarakRsTestProject* project, uint32_t index, const uint8_t** id, size_t* id_len,
                               uint32_t* sample_rate, uint32_t* channels, const float** samples, size_t* count);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* GARAK_ENGINE_H */

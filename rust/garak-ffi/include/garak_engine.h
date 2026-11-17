/* 가락이음 Rust render engine — C ABI (rust/garak-ffi/src/engine.rs over rust/garak-engine).
 * Hand-written; `cargo test -p garak-ffi` fails when an exported function is missing here.
 * See docs/RUST_ENGINE.md. The desktop host's C++ RenderEngine (native/src/engine.cpp) is the shell around it.
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
/* The last submitted graph's plug-in delay, its senders' delay (without the return tracks' extra delay), its
 * tail (with the render floor) and its longest non-return track tail (freeze renders). */
void garak_rs_engine_graph_details(GarakRsEngine* engine, uint32_t* latency_frames, uint32_t* sender_latency_frames,
                                   double* tail_seconds, double* track_tail_seconds);
void garak_rs_engine_snapshot(GarakRsEngine* engine, uint64_t* last_applied, int64_t* frame);

/* Audio thread: `frames` interleaved stereo frames. */
void garak_rs_engine_render(GarakRsEngine* engine, float* out, uint32_t frames);

/* ---- Host shell (docs/RUST_ENGINE.md 10) --------------------------------------------------------
 * The C++ RenderEngine keeps transport, count-in timing, live MIDI and capture, and asks the Rust graph for
 * each block at its own position: the track mix and master bus (render_host), then the metronome and count-in
 * clicks after its meters (garak_rs_engine_clicks). */
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
/* Audio thread: 1 when the next graph of the same project could swap in now (nothing deferred, no IEUM WAVE table
 * crossfade running), else 0. The shell holds its own graph command until then. */
int32_t garak_rs_engine_settled(GarakRsEngine* engine);
/* VST3 plug-ins and device input stay in the host (docs/RUST_ENGINE.md 4): the graph calls these back at the
 * node's place in each chain, on any render thread (concurrently for different tracks, never twice at once for
 * one track). source: fill the zeroed `stereo` (interleaved, `frames`) with track `track`'s instrument. insert:
 * process `stereo` in place through plan insert `insert`. input: add a monitored track's device input into
 * `stereo`; return 1 for a stereo pair, 0 for mono (duplicated) or an unopened input (nothing added). */
typedef struct GarakRsHostNodes {
  void* user;
  void (*source)(void* user, uint32_t track, float* stereo, uint32_t frames);
  void (*insert)(void* user, uint32_t track, uint32_t insert, float* stereo, uint32_t frames);
  int32_t (*input)(void* user, uint32_t track, float* stereo, uint32_t frames);
} GarakRsHostNodes;
/* One shell block: position, transport, the ticket to apply up to, whether to apply the master bus after the mix
 * (master gain gliding to its target, then the master processor; skipped offline with the master bypass),
 * monitored tracks (bit i of word i/64) and the host nodes (null: sources render silence, inserts pass through). */
typedef struct GarakRsBlock {
  int64_t position;
  int32_t playing;
  uint64_t allowed;
  int32_t master;
  uint64_t monitor[4];
  const GarakRsHostNodes* nodes;
  /* `ahead_count` per-track pointers (null entries allowed): the block's output of tracks the shell renders ahead
   * (garak_rs_engine_render_ahead); the graph skips those tracks and mixes these. */
  const float* const* ahead;
  uint32_t ahead_count;
} GarakRsBlock;
/* Audio thread: render_block with a GarakRsBlock (master bus, routes, monitoring, host nodes). */
void garak_rs_engine_render_host(GarakRsEngine* engine, float* out, uint32_t frames, const GarakRsBlock* block,
                                 float* peaks, uint32_t peak_capacity, GarakRsParallelRun run, void* host);
/* Render-ahead (the shell's rings): a worker renders track `track` of the active graph at `frame` exactly as the
 * graph would; returns its output (valid until it renders again) or null; `peak` gets the block peak. The shell
 * keeps that track out of render_host (in `ahead`) and its resets, renders it on one thread at a time, and keeps
 * its workers out while the renderer applies commands. reset_track: the shell takes a track back out of sync.
 * reset_skip: the transport reset that leaves ahead tracks alone (bit i of word i/64). */
const float* garak_rs_engine_render_ahead(GarakRsEngine* engine, uint32_t track, int64_t frame, uint32_t frames,
                                          int32_t playing, const GarakRsHostNodes* nodes, float* peak);
void garak_rs_engine_reset_track(GarakRsEngine* engine, uint32_t track, int64_t frame, int32_t chase, int32_t effects);
void garak_rs_engine_reset_skip(GarakRsEngine* engine, int64_t frame, int32_t chase, int32_t effects, const uint64_t* skip);
/* Audio thread, after render_host: routed track `track`'s input of the last block (what a recording of it
 * captures; interleaved stereo), or null when it has no internal route. Valid until the next render/reset. */
const float* garak_rs_engine_route_input(GarakRsEngine* engine, uint32_t track);
/* Audio thread: the running graph's plug-in delay and its senders' delay (0 without a graph). */
void garak_rs_engine_active_latency(GarakRsEngine* engine, uint32_t* latency_frames, uint32_t* sender_latency_frames);
/* Audio thread, after render_block: compressor/limiter/gate detector peak and lowest gain since the last
 * call, in track then chain order (`insert` indexes the track plan's inserts). Returns the count. */
typedef struct GarakRsDynamicsReading { uint16_t track, insert; float input, gain; } GarakRsDynamicsReading;
uint32_t garak_rs_engine_take_dynamics(GarakRsEngine* engine, GarakRsDynamicsReading* out, uint32_t capacity);
/* Audio thread: transport reset at project frame `frame` (the shell's position): instrument voices stop and
 * cursors move there; chase != 0 chases controllers and restarts sounding notes; effects != 0 also clears tails
 * and delay lines (C++ Impl::reset(chase, effects)). */
void garak_rs_engine_reset(GarakRsEngine* engine, int64_t frame, int32_t chase, int32_t effects);
/* Audio thread, at a block boundary: a live event the shell applies itself (its live MIDI ring and live
 * commands) for track `track`: kind 0 note on (a = note id), 1 note off (a = note id), 2 all notes off,
 * 3 controller (pitch = controller number, a = value), 4 preview (a = frames). Returns 1 when a built-in
 * instrument played it, 0 when no track did, -1 for an invalid event. The track must not be rendering ahead. */
int32_t garak_rs_engine_live(GarakRsEngine* engine, uint32_t track, uint32_t kind, int32_t pitch, int32_t a, float velocity);
/* Audio thread: the shell's transport stopped at the project end (no cycle): plug-in style Rust instruments
 * (vintage) release their notes next block. */
void garak_rs_engine_stop_at_end(GarakRsEngine* engine);

/* Control: the master gain the master bus glides to (C++ setMasterGain); offline renders without the master bus
 * (setMasterBypass: stems, freeze). Return the ticket or -1. */
int64_t garak_rs_engine_set_master_gain(GarakRsEngine* engine, float gain);
int64_t garak_rs_engine_set_master_bypass(GarakRsEngine* engine, int32_t bypass);
/* Control: the metronome (C++ setMetronome). strokes: 0 keeps the current strokes, 1 replaces them with `levels`
 * (3 mono strokes of `lengths` samples at `sample_rate`, the engine rate), 2 drops them (silence). Ticket or -1. */
int64_t garak_rs_engine_set_metronome(GarakRsEngine* engine, uint32_t strokes, uint32_t sample_rate,
                                      const float* const* levels, const size_t* lengths, int32_t on, float gain);
/* Control: tracks the last garak_rs_engine_set rebuilt and swapped in (C++ UpdateResult::replacedTracks). */
uint32_t garak_rs_engine_replaced_tracks(GarakRsEngine* engine);
/* Audio thread, after render_host and the shell's meters and recording: the block's metronome and count-in clicks
 * added to `out` (monitor only; nothing offline). position / playing: the shell's transport for the block;
 * counting_in: a count-in of `length` frames with `elapsed` frames already clicked. */
void garak_rs_engine_clicks(GarakRsEngine* engine, float* out, uint32_t frames, int64_t position, int32_t playing,
                            int32_t counting_in, int64_t elapsed, int64_t length);

/* Metronome port (rust/garak-engine/src/metronome.rs) for the parity harness: adds `total` frames of clicks to
 * `out` (interleaved stereo) in blocks of `block`, like RenderEngine: a count-in of `count_in` frames at the tempo
 * and meter of transport frame `start`, else the transport from `start` (tempo map: tempo_* arrays, >= 2 points;
 * meter map: meter_* arrays, the first at bar 0). `levels`: 3 mono strokes (downbeat, group, pulse). 0 or -1. */
int32_t garak_rs_metronome_render(uint32_t sample_rate, double bpm, int32_t numerator, int32_t denominator,
                                  const double* tempo_beats, const double* tempo_bpms, const uint8_t* tempo_ramps,
                                  uint32_t tempo_count, const int64_t* meter_bars, const int32_t* meter_numerators,
                                  const int32_t* meter_denominators, uint32_t meter_count, const float* const* levels,
                                  const size_t* level_lengths, int64_t start, int64_t count_in, uint32_t block,
                                  uint32_t total, float gain, float* out);

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

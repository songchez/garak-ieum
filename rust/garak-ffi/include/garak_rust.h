/* 가락이음 Rust DSP core — C ABI (rust/garak-ffi). Hand-written; `cargo test -p garak-ffi`
 * fails when an exported function is missing here. See docs/RUST.md.
 *
 * Real-time safe: no function allocates, locks or blocks. Storage is caller-owned (embed the
 * structs by value) and must be initialised with the matching *_init before other calls.
 * Null pointers are ignored. Units match garak::dsp (low/high-pass Q in dB, Web Audio style). */
#ifndef GARAK_RUST_H
#define GARAK_RUST_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GARAK_RS_ABI_VERSION 2

/* Same order as garak::dsp::Filter. */
enum GarakRsFilter {
  GARAK_RS_LOWPASS = 0,
  GARAK_RS_HIGHPASS = 1,
  GARAK_RS_BANDPASS = 2,
  GARAK_RS_PEAK = 3,
  GARAK_RS_LOWSHELF = 4,
  GARAK_RS_HIGHSHELF = 5,
  GARAK_RS_NOTCH = 6
};

typedef struct GarakRsCoefficients { double b0, b1, b2, a1, a2; } GarakRsCoefficients;

typedef struct GarakRsUtilityParams {
  double gain_db; /* -36..24 */
  double pan;     /* -1..1 balance */
  double width;   /* 0..2 */
  double mono;    /* >= 0.5 sums to mono */
  double phase;   /* bit 1 flips left, bit 2 flips right */
} GarakRsUtilityParams;

/* Opaque, 8-byte aligned storage. */
typedef struct GarakRsBiquad { uint64_t opaque[16]; } GarakRsBiquad;
typedef struct GarakRsUtility { uint64_t opaque[16]; } GarakRsUtility;

uint32_t garak_rs_abi_version(void);
double garak_rs_db_to_gain(double db);

/* Equal-power mono pan and stereo balance pan of the track channel strip. */
void garak_rs_pan_mono(double pan, double x, double* out_left, double* out_right);
void garak_rs_pan_stereo(double pan, double left, double right, double* out_left, double* out_right);

void garak_rs_biquad_design(uint32_t kind, double sample_rate, double frequency, double q, double gain_db,
                            GarakRsCoefficients* out);
void garak_rs_biquad_init(GarakRsBiquad* filter);
/* Jump to the new response (history kept). */
void garak_rs_biquad_configure(GarakRsBiquad* filter, uint32_t kind, double sample_rate, double frequency,
                               double q, double gain_db);
/* Glide (~12 ms) from the current response to the new one. */
void garak_rs_biquad_retarget(GarakRsBiquad* filter, uint32_t kind, double sample_rate, double frequency,
                              double q, double gain_db);
void garak_rs_biquad_reset(GarakRsBiquad* filter);
void garak_rs_biquad_process_interleaved(GarakRsBiquad* filter, float* stereo, uint32_t frames);

void garak_rs_utility_init(GarakRsUtility* utility, double sample_rate);
/* First call applies immediately, later calls glide. */
void garak_rs_utility_configure(GarakRsUtility* utility, const GarakRsUtilityParams* params);
void garak_rs_utility_process_interleaved(GarakRsUtility* utility, float* stereo, uint32_t frames);

/* ---- Built-in effects (rust/garak-ffi/src/fx.rs) ------------------------------------------------
 * Every native makeEffect() type except the guitar rig. Parameters are doubles in the catalog order
 * of native/src/dsp.cpp effectDefs() (garak_rs_fx_param_id lists them). Lifecycle:
 *   1. allocate garak_rs_fx_size() bytes aligned to garak_rs_fx_align() (opaque state) and
 *      garak_rs_fx_storage_len() floats of state storage (delay lines; 0 for most kinds);
 *      reverb: also an impulse response (garak_rs_reverb_generate_ir or a cached one) FFT'd into
 *      garak_rs_reverb_kernel_len() floats with garak_rs_reverb_prepare_kernels (control thread);
 *   2. garak_rs_fx_init (control thread);
 *   3. process / automate / set_param + commit / set_tempo / reset / meter (audio thread, real-time
 *      safe); latency and tail at any time;
 *   4. free the buffers (no Rust destructor runs). Buffers must outlive the effect and not move. */
enum GarakRsEffect {
  GARAK_RS_FX_DELAY = 0,
  GARAK_RS_FX_CHORUS = 1,
  GARAK_RS_FX_PHASER = 2,
  GARAK_RS_FX_FLANGER = 3,
  GARAK_RS_FX_TREMOLO = 4,
  GARAK_RS_FX_LIMITER = 5,
  GARAK_RS_FX_GATE = 6,
  GARAK_RS_FX_TAPE = 7,
  GARAK_RS_FX_BITCRUSHER = 8,
  GARAK_RS_FX_UTILITY = 9,
  GARAK_RS_FX_EQ = 10,
  GARAK_RS_FX_FILTER = 11,
  GARAK_RS_FX_COMPRESSOR = 12,
  GARAK_RS_FX_DRIVE = 13,
  GARAK_RS_FX_REVERB = 14
};
#define GARAK_RS_FX_COUNT 15

/* garak_rs_fx_init results. */
#define GARAK_RS_OK 0
#define GARAK_RS_ERR_ARGUMENT (-1) /* null or misaligned state */
#define GARAK_RS_ERR_KIND (-2)
#define GARAK_RS_ERR_RATE (-3)     /* sample rate outside 8-192 kHz or tempo outside 20-400 BPM */
#define GARAK_RS_ERR_STORAGE (-4)  /* storage shorter than garak_rs_fx_storage_len */
#define GARAK_RS_ERR_KERNELS (-5)  /* reverb kernels missing or short */

typedef struct GarakRsFx GarakRsFx; /* opaque */

size_t garak_rs_fx_size(void);
size_t garak_rs_fx_align(void);
/* Kind of a project effect type id ("chorus"), or -1. */
int32_t garak_rs_fx_kind(const char* id, size_t len);
uint32_t garak_rs_fx_param_count(uint32_t kind);
/* Copies the id (no terminator) into out and returns its full length; 0 when out of range. */
size_t garak_rs_fx_param_id(uint32_t kind, uint32_t index, char* out, size_t capacity);
int32_t garak_rs_fx_param_range(uint32_t kind, uint32_t index, double* out_default, double* out_min, double* out_max);
/* State storage in floats; ir_len is the reverb impulse length (ignored by other kinds). */
size_t garak_rs_fx_storage_len(uint32_t kind, double sample_rate, size_t ir_len);

size_t garak_rs_reverb_ir_len(double sample_rate, double type_param);
size_t garak_rs_reverb_scratch_len(double sample_rate, double type_param);
/* Same impulse as dsp.cpp impulse() + the size cross-fade. Returns 1 on success. */
int32_t garak_rs_reverb_generate_ir(double sample_rate, double type_param, double size, float* left, float* right,
                                    size_t ir_len, float* scratch, size_t scratch_len);
size_t garak_rs_reverb_kernel_len(size_t ir_len);
/* FFTs any impulse response of ir_len frames (generated or cached). Returns 1 on success. */
int32_t garak_rs_reverb_prepare_kernels(const float* left, const float* right, size_t ir_len, float* kernels,
                                        size_t kernels_len);

int32_t garak_rs_fx_init(GarakRsFx* fx, uint32_t kind, double sample_rate, double bpm, const double* params,
                         uint32_t count, float* storage, size_t storage_len, const float* kernels, size_t kernels_len,
                         size_t ir_len);
/* Interleaved / planar stereo in place. */
void garak_rs_fx_process(GarakRsFx* fx, float* stereo, uint32_t frames);
void garak_rs_fx_process_planar(GarakRsFx* fx, float* left, float* right, uint32_t frames);
/* All parameters at once, then automate in place (C++ StereoProcessor::automate). */
void garak_rs_fx_automate(GarakRsFx* fx, const double* params, uint32_t count);
/* Stage one parameter (clamped, non-finite ignored); commit applies staged changes if any. */
void garak_rs_fx_set_param(GarakRsFx* fx, uint32_t index, double value);
void garak_rs_fx_commit(GarakRsFx* fx);
double garak_rs_fx_param(const GarakRsFx* fx, uint32_t index);
void garak_rs_fx_set_tempo(GarakRsFx* fx, double bpm);
void garak_rs_fx_reset(GarakRsFx* fx);
uint32_t garak_rs_fx_latency(const GarakRsFx* fx);
double garak_rs_fx_tail(const GarakRsFx* fx);
/* Compressor, limiter, gate: detector peak and lowest gain since the last call; returns 1, else 0. */
int32_t garak_rs_fx_meter(GarakRsFx* fx, float* out_peak, float* out_gain);
/* C++ takeStateFrom. Returns 1 when the two effects exchanged their whole state storage: the caller
 * must then swap the two storage buffers as well. */
int32_t garak_rs_fx_take_state(GarakRsFx* fx, GarakRsFx* previous);

/* ---- Guitar rig (rust/garak-ffi/src/rig.rs) -------------------------------------------------------
 * makeEffect("guitar-rig") ported to rust/garak-dsp/src/fx/guitar: up to 18 rack modules (comp, drive,
 * amp, cabinet + mic, chorus, delay, fuzz, phaser, tremolo, plate reverb, tuner; each up to 3 times),
 * in the parameter order of dsp.cpp guitarRigDefs(). Lifecycle as for GarakRsFx: allocate
 * garak_rs_rig_size() bytes aligned to garak_rs_rig_align(), garak_rs_rig_storage_len() floats of state
 * storage (depends on the rack layout) and, for every reverb instance garak_rs_rig_reverb_decays()
 * reports, kernels: impulse from garak_rs_rig_reverb_generate_ir(), then garak_rs_reverb_kernel_len() /
 * garak_rs_reverb_prepare_kernels(). Then garak_rs_rig_init (control thread); the rest is real-time
 * safe. Plain data: free the bytes, no destructor runs. The rack layout (rackSlot*) and each reverb's
 * Decay / switch are structural: a new rig + garak_rs_rig_take_state, as in C++. */
#define GARAK_RS_RIG_MAX_REVERBS 3

typedef struct GarakRsRig GarakRsRig; /* opaque */

size_t garak_rs_rig_size(void);
size_t garak_rs_rig_align(void);
uint32_t garak_rs_rig_param_count(void);
/* Copies the id (no terminator) into out and returns its full length; 0 when out of range. */
size_t garak_rs_rig_param_id(uint32_t index, char* out, size_t capacity);
int32_t garak_rs_rig_param_range(uint32_t index, double* out_default, double* out_min, double* out_max);
/* The plate reverb's impulse (the hall impulse blended by Decay). generate_ir returns 1 on success. */
size_t garak_rs_rig_reverb_ir_len(double sample_rate);
size_t garak_rs_rig_reverb_scratch_len(double sample_rate);
int32_t garak_rs_rig_reverb_generate_ir(double sample_rate, double decay, float* left, float* right, size_t ir_len,
                                        float* scratch, size_t scratch_len);
/* Bit i set: reverb instance i is in the rack and switched on, its Decay in out_decays[i] (3 doubles or null). */
uint32_t garak_rs_rig_reverb_decays(const double* params, uint32_t count, double* out_decays);
size_t garak_rs_rig_storage_len(double sample_rate, const double* params, uint32_t count, size_t ir_len);
/* kernels / kernel_lens: GARAK_RS_RIG_MAX_REVERBS entries, one per reverb instance (null / 0 where unused).
 * Returns GARAK_RS_OK, GARAK_RS_ERR_ARGUMENT, _RATE, _STORAGE or _KERNELS. */
int32_t garak_rs_rig_init(GarakRsRig* rig, double sample_rate, const double* params, uint32_t count, float* storage,
                          size_t storage_len, const float* const* kernels, const size_t* kernel_lens, size_t ir_len);
void garak_rs_rig_process(GarakRsRig* rig, float* stereo, uint32_t frames);
void garak_rs_rig_process_planar(GarakRsRig* rig, float* left, float* right, uint32_t frames);
void garak_rs_rig_automate(GarakRsRig* rig, const double* params, uint32_t count);
void garak_rs_rig_set_param(GarakRsRig* rig, uint32_t index, double value);
void garak_rs_rig_commit(GarakRsRig* rig);
double garak_rs_rig_param(const GarakRsRig* rig, uint32_t index);
void garak_rs_rig_reset(GarakRsRig* rig);
uint32_t garak_rs_rig_latency(const GarakRsRig* rig);
double garak_rs_rig_tail(const GarakRsRig* rig);
/* C++ takeStateFrom by module code and instance. Returns 1 when the two rigs exchanged their whole state
 * storage: the caller must then swap the two storage buffers as well. */
int32_t garak_rs_rig_take_state(GarakRsRig* rig, GarakRsRig* previous);

/* ---- Built-in instruments (rust/garak-ffi/src/instruments.rs) -----------------------------------
 * 옥구슬 EP and 한밤 106 (rust/garak-dsp/src/instruments). The same Rust code runs in the browser
 * worklet (garak-wasm), with deterministic math, so both engines render identical samples.
 * Lifecycle: allocate garak_rs_instrument_size() bytes aligned to garak_rs_instrument_align(),
 * garak_rs_instrument_init (control thread), then process / set_param / reset / take_state on the
 * audio thread (real-time safe). The state is plain data: free the bytes, no destructor runs. */
enum GarakRsInstrumentKind { GARAK_RS_INSTRUMENT_EP = 0, GARAK_RS_INSTRUMENT_POLY = 1 };
#define GARAK_RS_INSTRUMENT_COUNT 2

/* GarakRsInstrumentEvent.kind */
#define GARAK_RS_EVENT_NOTE_ON 0       /* pitch, value = velocity 0..1, id = host note id or -1 */
#define GARAK_RS_EVENT_NOTE_OFF 1      /* by id (>= 0) or pitch */
#define GARAK_RS_EVENT_ALL_NOTES_OFF 2 /* releases every voice, lifts the pedal */
#define GARAK_RS_EVENT_CONTROLLER 3    /* param: 0..127 CC, 128 pressure, 129 bend, 131 bend range; value 0..1 */
#define GARAK_RS_EVENT_PARAM 4         /* param = catalog index, value in catalog units */
#define GARAK_RS_EVENT_RESET 5         /* immediate silence */

typedef struct GarakRsInstrumentEvent {
  uint32_t offset; /* frame inside the block; sorted */
  uint32_t kind;
  int32_t id;
  uint32_t pitch;
  float value;
  uint32_t param;
} GarakRsInstrumentEvent;

typedef struct GarakRsInstrument GarakRsInstrument; /* opaque */

size_t garak_rs_instrument_size(void);
size_t garak_rs_instrument_align(void);
/* Kind of a project instrument id ("okgu-ep", "hanbam-106"), or -1. */
int32_t garak_rs_instrument_kind(const char* id, size_t len);
uint32_t garak_rs_instrument_param_count(uint32_t kind);
size_t garak_rs_instrument_param_id(uint32_t kind, uint32_t index, char* out, size_t capacity);
int32_t garak_rs_instrument_param_range(uint32_t kind, uint32_t index, double* out_default, double* out_min,
                                        double* out_max);
/* GARAK_RS_OK, GARAK_RS_ERR_ARGUMENT, GARAK_RS_ERR_KIND or GARAK_RS_ERR_RATE. */
int32_t garak_rs_instrument_init(GarakRsInstrument* inst, uint32_t kind, double sample_rate, const double* params,
                                 uint32_t count);
void garak_rs_instrument_set_param(GarakRsInstrument* inst, uint32_t index, double value);
double garak_rs_instrument_param(const GarakRsInstrument* inst, uint32_t index);
/* Planar stereo, overwritten. */
void garak_rs_instrument_process(GarakRsInstrument* inst, float* left, float* right, uint32_t frames,
                                 const GarakRsInstrumentEvent* events, uint32_t count);
void garak_rs_instrument_reset(GarakRsInstrument* inst);
/* inst adopts previous's voices / delay lines and keeps its own parameters. */
void garak_rs_instrument_take_state(GarakRsInstrument* inst, const GarakRsInstrument* previous);
double garak_rs_instrument_tail(const GarakRsInstrument* inst);
uint32_t garak_rs_instrument_active_voices(const GarakRsInstrument* inst);

#ifdef __cplusplus
} /* extern "C" */
static_assert(sizeof(GarakRsInstrumentEvent) == 24, "GarakRsInstrumentEvent layout");
static_assert(sizeof(GarakRsCoefficients) == 40, "GarakRsCoefficients layout");
static_assert(sizeof(GarakRsUtilityParams) == 40, "GarakRsUtilityParams layout");
#endif

#endif /* GARAK_RUST_H */

/* 가락이음 Rust DSP core — C ABI (rust/garak-ffi). Hand-written; `cargo test -p garak-ffi`
 * fails when an exported function is missing here. See docs/RUST.md.
 *
 * Real-time safe: no function allocates, locks or blocks. Storage is caller-owned (embed the
 * structs by value) and must be initialised with the matching *_init before other calls.
 * Null pointers are ignored. Units match garak::dsp (low/high-pass Q in dB, Web Audio style). */
#ifndef GARAK_RUST_H
#define GARAK_RUST_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GARAK_RS_ABI_VERSION 1

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

#ifdef __cplusplus
} /* extern "C" */
static_assert(sizeof(GarakRsCoefficients) == 40, "GarakRsCoefficients layout");
static_assert(sizeof(GarakRsUtilityParams) == 40, "GarakRsUtilityParams layout");
#endif

#endif /* GARAK_RUST_H */

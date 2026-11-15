// Behavioural parity: Rust kernels (rust/garak-dsp through the garak-ffi C ABI) against the existing
// C++ kernels on identical input. Tolerance-based (libm vs the platform libm differ in the last
// ulp; outputs are float), never golden hashes. Built with -DGARAK_RUST=ON (docs/RUST.md).
#include "garak/dsp.hpp"
#include "garak/engine.hpp"
#include "garak_rust.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>
#include <vector>

namespace {
int failures = 0;
void check(bool ok, const std::string& what, double detail = 0) {
  if (!ok) { ++failures; std::fprintf(stderr, "FAIL %s (%.3g)\n", what.c_str(), detail); }
}

std::vector<float> noise(std::size_t samples, std::uint32_t seed) {
  std::vector<float> out(samples);
  for (auto& x : out) { seed = seed * 1664525u + 1013904223u; x = static_cast<float>(seed / 4294967296.0 * 2 - 1); }
  return out;
}
double maxDiff(const std::vector<float>& a, const std::vector<float>& b) {
  double m = 0;
  for (std::size_t i = 0; i < a.size(); ++i) m = std::max(m, static_cast<double>(std::abs(a[i] - b[i])));
  return m;
}

constexpr double rate = 48000;
constexpr std::uint32_t frames = 4800;

void biquadParity() {
  using garak::dsp::Filter;
  struct Case { Filter type; double hz, q, gain, hz2, q2, gain2; };
  const Case cases[] = {
    {Filter::Lowpass, 800, 3, 0, 6000, -6, 0},     {Filter::Highpass, 120, 0, 0, 2000, 12, 0},
    {Filter::Bandpass, 1000, .7, 0, 300, 8, 0},    {Filter::Peak, 2500, 1.4, 9, 400, .3, -12},
    {Filter::LowShelf, 200, 1, -6, 90, 1, 12},     {Filter::HighShelf, 7000, 1, 4, 12000, 1, -9},
    {Filter::Notch, 1000, 4, 0, 60, 10, 0},        {Filter::Lowpass, 30000, 60, 0, .5, -60, 0},  // clamped ranges
  };
  for (const auto& c : cases) {
    const auto kind = static_cast<std::uint32_t>(c.type);
    const auto input = noise(frames * 2, 7 + kind);
    // C++: configure, run, then rebuild + takeHistoryFrom (how parameter edits glide in native).
    garak::dsp::Biquad cpp;
    cpp.configure(c.type, rate, c.hz, c.q, c.gain);
    std::vector<float> expected = input;
    for (std::uint32_t i = 0; i < frames / 2; ++i) for (unsigned ch = 0; ch < 2; ++ch) expected[2 * i + ch] = cpp.sample(expected[2 * i + ch], ch);
    garak::dsp::Biquad next;
    next.configure(c.type, rate, c.hz2, c.q2, c.gain2);
    next.takeHistoryFrom(cpp);
    for (std::uint32_t i = frames / 2; i < frames; ++i) for (unsigned ch = 0; ch < 2; ++ch) expected[2 * i + ch] = next.sample(expected[2 * i + ch], ch);

    GarakRsBiquad rs;
    garak_rs_biquad_init(&rs);
    garak_rs_biquad_configure(&rs, kind, rate, c.hz, c.q, c.gain);
    std::vector<float> actual = input;
    garak_rs_biquad_process_interleaved(&rs, actual.data(), frames / 2);
    garak_rs_biquad_retarget(&rs, kind, rate, c.hz2, c.q2, c.gain2);
    garak_rs_biquad_process_interleaved(&rs, actual.data() + frames, frames / 2);
    const double d = maxDiff(expected, actual);
    check(d < 1e-5, "biquad type " + std::to_string(kind), d);
  }
}

void utilityParity() {
  const garak::Parameters settings[][2] = {
    {{{"gain", -6}, {"pan", .4}, {"width", 1.6}}, {{"gain", 3}, {"pan", -.8}, {"width", .2}, {"phase", 2}}},
    {{{"mono", 1}, {"phase", 1}}, {{"width", 2}, {"pan", 1}, {"gain", -36}}},
    {{}, {{"phase", 3}, {"gain", 24}}},
  };
  auto rustParams = [](const garak::Parameters& p) {
    auto get = [&](const char* k, double fallback) { const auto it = p.find(k); return it == p.end() ? fallback : it->second; };
    return GarakRsUtilityParams{get("gain", 0), get("pan", 0), get("width", 1), get("mono", 0), get("phase", 0)};
  };
  int index = 0;
  for (const auto& pair : settings) {
    const auto input = noise(frames * 2, 40 + index);
    std::vector<float> expected = input, actual = input;
    auto first = garak::dsp::makeEffect("utility", pair[0], rate, 120);
    first->process(expected.data(), 1000);
    auto second = garak::dsp::makeEffect("utility", pair[1], rate, 120);
    second->takeStateFrom(*first);
    second->process(expected.data() + 2000, frames - 1000);

    GarakRsUtility rs;
    garak_rs_utility_init(&rs, rate);
    const auto p0 = rustParams(pair[0]), p1 = rustParams(pair[1]);
    garak_rs_utility_configure(&rs, &p0);
    garak_rs_utility_process_interleaved(&rs, actual.data(), 1000);
    garak_rs_utility_configure(&rs, &p1);
    garak_rs_utility_process_interleaved(&rs, actual.data() + 2000, frames - 1000);
    const double d = maxDiff(expected, actual);
    check(d < 1e-6, "utility case " + std::to_string(index), d);
    ++index;
  }
}

// Reference transcription of the track pan law in native/src/engine.cpp (the mix loop keeps it
// inline). If that loop changes, update this copy and garak-dsp's gain.rs together.
void enginePan(bool stereo, double pan, double& l, double& r) {
  constexpr double pi = garak::dsp::pi;
  if (!stereo) { const double angle = (pan + 1) * pi / 4; r = l * std::sin(angle); l *= std::cos(angle); }
  else if (pan < 0) { const double angle = (pan + 1) * pi / 2; l += r * std::cos(angle); r *= std::sin(angle); }
  else if (pan > 0) { const double angle = pan * pi / 2; r += l * std::sin(angle); l *= std::cos(angle); }
}

void panParity() {
  double worst = 0;
  for (int i = 0; i <= 40; ++i) {
    const double pan = -1 + i * .05;
    for (const auto [inL, inR] : {std::pair{.8, -.3}, std::pair{-1.0, 1.0}, std::pair{.25, .25}}) {
      double l = inL, r = inR, rl = 0, rr = 0;
      enginePan(false, pan, l, r);
      garak_rs_pan_mono(pan, inL, &rl, &rr);
      worst = std::max({worst, std::abs(l - rl), std::abs(r - rr)});
      l = inL; r = inR;
      enginePan(true, pan, l, r);
      garak_rs_pan_stereo(pan, inL, inR, &rl, &rr);
      worst = std::max({worst, std::abs(l - rl), std::abs(r - rr)});
    }
  }
  check(worst < 1e-12, "pan law", worst);
  double gainWorst = 0;
  for (double db = -60; db <= 24; db += 1.5) gainWorst = std::max(gainWorst, std::abs(garak::dsp::dbToGain(db) - garak_rs_db_to_gain(db)) / garak::dsp::dbToGain(db));
  check(gainWorst < 1e-14, "dbToGain", gainWorst);
}
} // namespace

int main() {
  check(garak_rs_abi_version() == GARAK_RS_ABI_VERSION, "ABI version");
  // Null pointers must be ignored, never crash.
  garak_rs_biquad_process_interleaved(nullptr, nullptr, 128);
  garak_rs_utility_configure(nullptr, nullptr);
  biquadParity();
  utilityParity();
  panParity();
  if (failures) { std::fprintf(stderr, "%d Rust parity check(s) failed\n", failures); return EXIT_FAILURE; }
  std::puts("Rust DSP parity: biquad (7 types + glide), utility (+ glide), pan law, dbToGain OK");
  return EXIT_SUCCESS;
}

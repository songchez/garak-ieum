// Behavioural parity: Rust kernels (rust/garak-dsp through the garak-ffi C ABI) against the existing
// C++ kernels on identical input. Tolerance-based (libm vs the platform libm differ in the last
// ulp; outputs are float), never golden hashes. Built with -DGARAK_RUST=ON (docs/RUST.md).
//
// Effects: every makeEffect() type with a Rust port is rendered through both backends of the same
// StereoProcessor interface (makeEffect(..., EffectBackend::Cpp / ::Rust)) with identical input,
// block sizes, EffectControl automation, tempo changes, resets and takeStateFrom hand-overs. The
// gate is a residual <= -90 dBFS per effect plus identical latency, tail and dynamics-meter values.
#include "garak/dsp.hpp"
#include "garak/engine.hpp"
#include "garak_rust.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <map>
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
double dbfs(double v) { return v > 0 ? 20 * std::log10(v) : -400; }

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
    auto first = garak::dsp::makeEffect("utility", pair[0], rate, 120, garak::dsp::EffectBackend::Cpp);
    first->process(expected.data(), 1000);
    auto second = garak::dsp::makeEffect("utility", pair[1], rate, 120, garak::dsp::EffectBackend::Cpp);
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

// ---- Effects ----------------------------------------------------------------------------------

using garak::dsp::EffectBackend;
using garak::dsp::StereoProcessor;
constexpr double residualGate = -90;  // dBFS

struct Def { std::string id; double fallback, minimum, maximum; };
std::vector<Def> catalog(std::string_view type) {
  const int kind = garak_rs_fx_kind(type.data(), type.size());
  std::vector<Def> defs;
  for (std::uint32_t i = 0; i < garak_rs_fx_param_count(static_cast<std::uint32_t>(kind)); ++i) {
    char id[64];
    const auto n = garak_rs_fx_param_id(static_cast<std::uint32_t>(kind), i, id, sizeof id);
    Def d{std::string(id, std::min(n, sizeof id)), 0, 0, 0};
    garak_rs_fx_param_range(static_cast<std::uint32_t>(kind), i, &d.fallback, &d.minimum, &d.maximum);
    defs.push_back(d);
  }
  return defs;
}

struct Rng {
  std::uint32_t s;
  std::uint32_t next() { s = s * 1664525u + 1013904223u; return s; }
  double unit() { return next() / 4294967296.0; }
  double range(double lo, double hi) { return lo + (hi - lo) * unit(); }
};

// Test programme: noise bursts with attacks and silences (gate / dynamics), a sine sweep, a loud
// section above 0 dBFS (limiter / compressor / drive) and isolated impulses (delay / reverb tails).
std::vector<float> programme(std::size_t frameCount, double sr, std::uint32_t seed) {
  std::vector<float> out(frameCount * 2);
  Rng rng{seed};
  double phase = 0;
  for (std::size_t i = 0; i < frameCount; ++i) {
    const double t = static_cast<double>(i) / sr;
    const double cycle = std::fmod(t, 0.75);
    double envelope = cycle < 0.3 ? std::min(1.0, cycle / 0.004) : cycle < 0.45 ? std::exp(-(cycle - 0.3) * 30) : 0.0;
    if (t > 1.0 && t < 1.25) envelope *= 1.8;  // hot section
    phase += 2 * garak::dsp::pi * (80 + 6000 * (t / (frameCount / sr))) / sr;
    const double tone = 0.4 * std::sin(phase);
    const double impulse = i % 9973 == 0 ? 0.9 : 0.0;
    out[2 * i] = static_cast<float>(envelope * (0.5 * (rng.unit() * 2 - 1) + tone) + impulse);
    out[2 * i + 1] = static_cast<float>(envelope * (0.5 * (rng.unit() * 2 - 1) - 0.7 * tone) - impulse);
  }
  return out;
}

struct Action {
  enum Kind { Automate, Tempo, Reset, Handover } kind;
  std::string id; double value = 0;
  garak::Parameters handover;  // parameters of the processor that takes over
};
struct Block { std::uint32_t frames; std::vector<Action> actions; };

struct EffectStats {
  int renders = 0;
  double worst = 0;
  std::string worstCase;
  bool latencyTailOk = true, meterOk = true;
};
std::map<std::string, EffectStats> stats;
std::vector<std::string> order;

// Renders `input` through the C++ and the Rust backend with the same programme of blocks/actions.
void compare(const std::string& type, const std::string& name, const garak::Parameters& init, const std::vector<float>& input,
             const std::vector<Block>& blocks, double sr = rate, double bpm = 120) {
  if (!stats.count(type)) order.push_back(type);
  auto& st = stats[type];
  std::unique_ptr<StereoProcessor> fx[2];
  std::unique_ptr<garak::dsp::EffectControl> control[2];
  std::vector<float> out[2] = {input, input};
  double meterWorst = 0, tailWorst = 0;
  bool latencyEqual = true;
  for (int b = 0; b < 2; ++b) {
    fx[b] = garak::dsp::makeEffect(type, init, sr, bpm, b ? EffectBackend::Rust : EffectBackend::Cpp);
    control[b] = std::make_unique<garak::dsp::EffectControl>(type, init);
  }
  auto compareReports = [&] {
    latencyEqual &= fx[0]->latencyFrames() == fx[1]->latencyFrames();
    tailWorst = std::max(tailWorst, std::abs(fx[0]->tailSeconds() - fx[1]->tailSeconds()));
  };
  compareReports();
  std::size_t offset = 0;
  for (const auto& block : blocks) {
    const std::uint32_t n = std::min<std::uint32_t>(block.frames, static_cast<std::uint32_t>(input.size() / 2 - offset));
    if (!n) break;
    for (int b = 0; b < 2; ++b) {
      for (const auto& a : block.actions) {
        switch (a.kind) {
          case Action::Automate: control[b]->set(control[b]->index(a.id), a.value); break;
          case Action::Tempo: fx[b]->setTempo(a.value); break;
          case Action::Reset: fx[b]->reset(); break;
          case Action::Handover: {
            auto next = garak::dsp::makeEffect(type, a.handover, sr, bpm, b ? EffectBackend::Rust : EffectBackend::Cpp);
            next->takeStateFrom(*fx[b]);
            fx[b] = std::move(next);
            control[b] = std::make_unique<garak::dsp::EffectControl>(type, a.handover);
            break;
          }
        }
      }
      control[b]->apply(*fx[b]);
      fx[b]->process(out[b].data() + offset * 2, n);
    }
    compareReports();
    auto* tap0 = fx[0]->dynamics();
    auto* tap1 = fx[1]->dynamics();
    if ((tap0 == nullptr) != (tap1 == nullptr)) st.meterOk = false;
    if (tap0 && tap1) {
      float p0, g0, p1, g1;
      tap0->take(p0, g0); tap1->take(p1, g1);
      meterWorst = std::max({meterWorst, static_cast<double>(std::abs(p0 - p1)), static_cast<double>(std::abs(g0 - g1))});
    }
    offset += n;
  }
  const double d = maxDiff(out[0], out[1]);
  bool finite = std::all_of(out[1].begin(), out[1].end(), [](float v) { return std::isfinite(v); });
  ++st.renders;
  if (d > st.worst) { st.worst = d; st.worstCase = name; }
  st.latencyTailOk &= latencyEqual && tailWorst <= 1e-9;
  st.meterOk &= meterWorst <= 1e-5;
  check(finite, type + " " + name + ": non-finite Rust output");
  check(dbfs(d) <= residualGate, type + " " + name + ": residual " + std::to_string(dbfs(d)) + " dBFS", d);
  check(latencyEqual, type + " " + name + ": latency differs");
  check(tailWorst <= 1e-9, type + " " + name + ": tail differs", tailWorst);
  check(meterWorst <= 1e-5, type + " " + name + ": dynamics meter differs", meterWorst);
}

std::vector<Block> plainBlocks(std::size_t frameCount, std::uint32_t seed, bool tempo) {
  std::vector<Block> blocks;
  Rng rng{seed};
  for (std::size_t done = 0; done < frameCount;) {
    // Mostly engine-sized blocks with odd sizes mixed in (the automation chunking splits blocks).
    const auto n = static_cast<std::uint32_t>(rng.unit() < 0.2 ? 1 + rng.next() % 37 : 64 << (rng.next() % 4));
    Block block{n, {}};
    if (tempo && rng.unit() < 0.15) block.actions.push_back({Action::Tempo, "", rng.range(60, 190), {}});
    blocks.push_back(block);
    done += n;
  }
  return blocks;
}

bool rebuildOnly(const std::string& type, const std::string& id) {
  // Parameters that shape a prepared buffer: automate() keeps the prepared value on both sides.
  return type == "reverb" && (id == "size" || id == "type" || id == "predelay");
}

void effectParity(const std::string& type) {
  const auto defs = catalog(type);
  check(!defs.empty(), type + ": no Rust catalog");
  const bool heavy = type == "reverb";
  const std::size_t shortLength = heavy ? 24000 : 18000, longLength = heavy ? 72000 : 96000;
  const auto input = programme(longLength, rate, 11);
  const std::vector<float> shortInput(input.begin(), input.begin() + static_cast<std::ptrdiff_t>(shortLength * 2));

  // Defaults with tempo changes.
  compare(type, "defaults", {}, input, plainBlocks(longLength, 3, true));

  for (const auto& def : defs) {
    // Edge values at construction.
    for (const double v : {def.minimum, def.maximum}) {
      compare(type, def.id + "=" + std::to_string(v), {{def.id, v}}, shortInput, plainBlocks(shortLength, 5, true));
    }
    if (rebuildOnly(type, def.id)) continue;
    // Automation sweep min -> max -> min in steps (plus out-of-range values that EffectControl clamps).
    std::vector<Block> blocks = plainBlocks(longLength, 7, false);
    const std::size_t steps = blocks.size();
    for (std::size_t i = 0; i < steps; i += std::max<std::size_t>(1, steps / 24)) {
      const double x = static_cast<double>(i) / static_cast<double>(steps);
      const double tri = x < .5 ? 2 * x : 2 - 2 * x;
      double v = def.minimum + tri * (def.maximum - def.minimum);
      if (i == steps / 3) v = def.maximum + 10;
      if (i == steps / 2) v = def.minimum - 10;
      blocks[i].actions.push_back({Action::Automate, def.id, v, {}});
    }
    compare(type, "sweep " + def.id, {}, input, blocks);
  }

  // Random parameter sets, random per-block automation, tempo changes, a reset and a hand-over.
  for (std::uint32_t seed = 1; seed <= (heavy ? 3u : 6u); ++seed) {
    Rng rng{seed * 7919};
    auto randomParams = [&] {
      garak::Parameters p;
      for (const auto& def : defs) if (rng.unit() < 0.7) p[def.id] = rng.range(def.minimum, def.maximum);
      return p;
    };
    const auto init = randomParams();
    std::vector<Block> blocks = plainBlocks(longLength, seed, true);
    for (std::size_t i = 0; i < blocks.size(); ++i) {
      if (rng.unit() < 0.3) {
        const auto& def = defs[rng.next() % defs.size()];
        if (!rebuildOnly(type, def.id)) blocks[i].actions.push_back({Action::Automate, def.id, rng.range(def.minimum, def.maximum), {}});
      }
      if (i == blocks.size() / 3) blocks[i].actions.push_back({Action::Reset, "", 0, {}});
      if (i == blocks.size() * 2 / 3) blocks[i].actions.push_back({Action::Handover, "", 0, randomParams()});
    }
    compare(type, "random " + std::to_string(seed), init, input, blocks, rate, rng.range(70, 170));
  }

  // Other sample rates (block sizes, delay-line lengths, IR lengths, coefficient designs).
  for (const double sr : {44100.0, 96000.0}) {
    const std::size_t n = static_cast<std::size_t>(sr * (heavy ? 0.5 : 0.75));
    compare(type, "rate " + std::to_string(static_cast<int>(sr)), {}, programme(n, sr, 23), plainBlocks(n, 9, true), sr);
  }
}

void ffiContract() {
  // Null handles are ignored, unknown kinds refused, every effect reports a catalog.
  garak_rs_fx_process(nullptr, nullptr, 128);
  garak_rs_fx_automate(nullptr, nullptr, 0);
  check(garak_rs_fx_kind("guitar-rig", 10) < 0, "guitar rig has no Rust port yet");
  check(garak_rs_fx_param_count(99) == 0, "unknown kind");
  check(garak::dsp::rustEffectsAvailable(), "rustEffectsAvailable");
  bool threw = false;
  try { (void)garak::dsp::makeEffect("guitar-rig", {}, rate, 120, EffectBackend::Rust); } catch (const std::exception&) { threw = true; }
  check(threw, "Rust guitar rig must throw");
  threw = false;
  try { (void)garak::dsp::makeEffect("chorus", {{"rate", 99}}, rate, 120, EffectBackend::Rust); } catch (const std::exception&) { threw = true; }
  check(threw, "Rust path validates parameters like the C++ path");
  // Runtime switch: default C++ (or the GARAK_RUST_EFFECTS start-up list), per type, "all".
  const char* env = std::getenv("GARAK_RUST_EFFECTS");
  if (env && std::string(env) == "all") check(garak::dsp::effectBackend("reverb") == EffectBackend::Rust, "GARAK_RUST_EFFECTS=all selects Rust");
  else if (env && (std::string(env) == "none" || std::string(env) == "cpp")) check(garak::dsp::effectBackend("delay") == EffectBackend::Cpp, "GARAK_RUST_EFFECTS=none selects C++");
#ifdef GARAK_RUST_EFFECTS_DEFAULT
  else if (!env && std::string(GARAK_RUST_EFFECTS_DEFAULT) == "all") check(garak::dsp::effectBackend("delay") == EffectBackend::Rust, "build default (all) selects Rust");
#else
  else if (!env) check(garak::dsp::effectBackend("delay") == EffectBackend::Cpp, "default backend is C++");
#endif
  garak::dsp::setEffectBackend("delay", EffectBackend::Rust);
  check(garak::dsp::effectBackend("delay") == EffectBackend::Rust, "setEffectBackend(delay)");
  garak::dsp::setEffectBackend("all", EffectBackend::Cpp);
  check(garak::dsp::effectBackend("delay") == EffectBackend::Cpp, "setEffectBackend(all, Cpp)");
  check(garak::dsp::effectBackend("guitar-rig") == EffectBackend::Cpp, "guitar rig stays C++");
}
} // namespace

int main(int argc, char** argv) {
  check(garak_rs_abi_version() == GARAK_RS_ABI_VERSION, "ABI version");
  // Null pointers must be ignored, never crash.
  garak_rs_biquad_process_interleaved(nullptr, nullptr, 128);
  garak_rs_utility_configure(nullptr, nullptr);
  biquadParity();
  utilityParity();
  panParity();
  ffiContract();
  const char* types[] = {"chorus", "flanger", "phaser", "tremolo", "limiter", "gate", "tape", "bitcrusher", "utility", "delay",
                         "eq", "filter", "compressor", "drive", "reverb"};
  for (const char* type : types) {
    if (argc > 1 && std::string(argv[1]) != type) continue;
    effectParity(type);
  }
  std::printf("| effect | renders | max residual (dBFS) | worst case | latency/tail | meter |\n|---|---:|---:|---|---|---|\n");
  for (const auto& type : order) {
    const auto& s = stats[type];
    std::printf("| %s | %d | %.1f | %s | %s | %s |\n", type.c_str(), s.renders, dbfs(s.worst), s.worstCase.empty() ? "(bit-identical)" : s.worstCase.c_str(),
                s.latencyTailOk ? "identical" : "DIFFERS", s.meterOk ? "ok" : "DIFFERS");
  }
  if (failures) { std::fprintf(stderr, "%d Rust parity check(s) failed\n", failures); return EXIT_FAILURE; }
  std::puts("Rust DSP parity: biquad, utility, pan law, dbToGain and every ported effect within -90 dBFS");
  return EXIT_SUCCESS;
}

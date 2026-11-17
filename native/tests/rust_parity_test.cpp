// Rust DSP kernels (rust/garak-dsp through the garak-ffi C ABI) against golden references (docs/RUST.md,
// native/tests/golden.hpp). Until 0.3.2 this test rendered every case through the C++ kernels too and compared the
// two (residual <= -90 dBFS; every case was bit-identical). 0.3.3 removed the C++ effect DSP, so its outputs were
// recorded once (native/tests/golden/rust-kernels.golden) and the Rust kernels are now checked against them: bit-
// identical on Windows x64, residual <= -90 dBFS elsewhere, plus the same latency, tail and dynamics-meter values.
//
// Effects: every built-in effect type is driven through the same programme as before (identical input, block sizes,
// live parameter automation, tempo changes, resets and state hand-overs). The guitar rig (garak_rs_rig_*) runs
// through the same comparison in groups (rigParity).
#include "garak/engine.hpp"
#include "garak_rust.h"
#include "golden.hpp"
#include "rust_fx.hpp"

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
golden::Suite goldens("rust-kernels");
int failures = 0;
void check(bool ok, const std::string& what, double detail = 0) {
  if (!ok) { ++failures; std::fprintf(stderr, "FAIL %s (%.3g)\n", what.c_str(), detail); }
}

std::vector<float> noise(std::size_t samples, std::uint32_t seed) {
  std::vector<float> out(samples);
  for (auto& x : out) { seed = seed * 1664525u + 1013904223u; x = static_cast<float>(seed / 4294967296.0 * 2 - 1); }
  return out;
}
double dbfs(double v) { return v > 0 ? 20 * std::log10(v) : -400; }

constexpr double rate = 48000;
constexpr std::uint32_t frames = 4800;

void biquadParity() {
  using garak::test::Filter;
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
    // Configure, run, then retarget (how parameter edits glide).
    GarakRsBiquad rs;
    garak_rs_biquad_init(&rs);
    garak_rs_biquad_configure(&rs, kind, rate, c.hz, c.q, c.gain);
    std::vector<float> actual = input;
    garak_rs_biquad_process_interleaved(&rs, actual.data(), frames / 2);
    garak_rs_biquad_retarget(&rs, kind, rate, c.hz2, c.q2, c.gain2);
    garak_rs_biquad_process_interleaved(&rs, actual.data() + frames, frames / 2);
    const auto r = goldens.check("biquad " + std::to_string(kind) + " " + std::to_string(&c - cases), actual);
    check(r.ok, r.message, r.residual);
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
    std::vector<float> actual = input;
    GarakRsUtility rs;
    garak_rs_utility_init(&rs, rate);
    const auto p0 = rustParams(pair[0]), p1 = rustParams(pair[1]);
    garak_rs_utility_configure(&rs, &p0);
    garak_rs_utility_process_interleaved(&rs, actual.data(), 1000);
    garak_rs_utility_configure(&rs, &p1);
    garak_rs_utility_process_interleaved(&rs, actual.data() + 2000, frames - 1000);
    const auto r = goldens.check("utility kernel " + std::to_string(index), actual);
    check(r.ok, r.message, r.residual);
    ++index;
  }
}

// Reference transcription of the track pan law of the C++ track mix loop removed in 0.3.3 (src/audio/graph.ts uses
// the same law). garak-dsp's gain.rs must keep it.
void enginePan(bool stereo, double pan, double& l, double& r) {
  constexpr double pi = garak::test::pi;
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
  for (double db = -60; db <= 24; db += 1.5) gainWorst = std::max(gainWorst, std::abs(garak::test::dbToGain(db) - garak_rs_db_to_gain(db)) / garak::test::dbToGain(db));
  check(gainWorst < 1e-14, "dbToGain", gainWorst);
}

// ---- Effects ----------------------------------------------------------------------------------

using garak::test::Effect;

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
    phase += 2 * garak::test::pi * (80 + 6000 * (t / (frameCount / sr))) / sr;
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
// Row of the parity table the next renders count towards (default: the effect type).
std::string statsGroup;

// Renders `input` through the Rust kernel with the programme of blocks/actions and compares the output, latency,
// tail and dynamics meter with the golden reference of the former C++ kernel.
void compare(const std::string& type, const std::string& name, const garak::Parameters& init, const std::vector<float>& input,
             const std::vector<Block>& blocks, double sr = rate, double bpm = 120) {
  const std::string key = statsGroup.empty() ? type : statsGroup;
  if (!stats.count(key)) order.push_back(key);
  auto& st = stats[key];
  auto fx = garak::test::makeEffect(type, init, sr, bpm);
  auto control = std::make_unique<garak::test::Control>(type, init);
  std::vector<float> out = input;
  double auxLatency = 0, auxTail = 0, auxPeak = 0, auxGain = 0, auxBlocks = 0, auxMeters = 0;
  std::size_t offset = 0;
  for (const auto& block : blocks) {
    const std::uint32_t n = std::min<std::uint32_t>(block.frames, static_cast<std::uint32_t>(input.size() / 2 - offset));
    if (!n) break;
    for (const auto& a : block.actions) {
      switch (a.kind) {
        case Action::Automate: control->set(control->index(a.id), a.value); break;
        case Action::Tempo: fx->setTempo(a.value); break;
        case Action::Reset: fx->reset(); break;
        case Action::Handover: {
          auto next = garak::test::makeEffect(type, a.handover, sr, bpm);
          next->takeStateFrom(*fx);
          fx = std::move(next);
          control = std::make_unique<garak::test::Control>(type, a.handover);
          break;
        }
      }
    }
    control->apply(*fx);
    fx->process(out.data() + offset * 2, n);
    auxLatency += fx->latencyFrames(); auxTail += fx->tailSeconds(); ++auxBlocks;
    if (auto* tap = fx->dynamics()) { float p = 0, g = 1; tap->take(p, g); auxPeak += p; auxGain += g; ++auxMeters; }
    offset += n;
  }
  const bool finite = std::all_of(out.begin(), out.end(), [](float v) { return std::isfinite(v); });
  // Former gates: latency identical, tail within 1e-9 s and each meter reading within 1e-5 per block.
  const double blocksDone = std::max(1.0, auxBlocks);
  const auto r = goldens.check(type + "/" + name, out, {auxBlocks, auxLatency, auxTail, auxMeters, auxPeak, auxGain, double(fx->latencyFrames()), fx->tailSeconds()},
                               {0, 0, 1e-9 * blocksDone, 0, 1e-5 * blocksDone, 1e-5 * blocksDone, 0, 1e-9});
  ++st.renders;
  if (r.residual > st.worst) { st.worst = r.residual; st.worstCase = name; }
  st.latencyTailOk &= r.ok || r.message.find("aux") == std::string::npos;
  check(finite, type + " " + name + ": non-finite Rust output");
  check(r.ok, r.message, r.residual);
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

// ---- Guitar rig ---------------------------------------------------------------------------------
// makeEffect("guitar-rig") through both backends: every amp model, every cabinet x microphone, every
// pedal alone and in a full rack (copies included), edge values and automation sweeps of every
// parameter, rack reorder / bypass / duplicate / removal and reverb rebuilds as hand-overs, random racks,
// 44.1 / 96 kHz. Each group is one row of the table.

std::vector<Def> rigCatalog() {
  std::vector<Def> defs;
  for (std::uint32_t i = 0; i < garak_rs_rig_param_count(); ++i) {
    char id[64];
    const auto n = garak_rs_rig_param_id(i, id, sizeof id);
    Def d{std::string(id, std::min(n, sizeof id)), 0, 0, 0};
    garak_rs_rig_param_range(i, &d.fallback, &d.minimum, &d.maximum);
    defs.push_back(d);
  }
  return defs;
}

// Rack slots (module code + 16 x instance) in signal order; the rest of the 18 slots empty.
garak::Parameters rack(std::initializer_list<int> modules, garak::Parameters extra = {}) {
  garak::Parameters p = std::move(extra);
  int slot = 0;
  for (const int m : modules) p["rackSlot" + std::to_string(slot++)] = m;
  for (; slot < 18; ++slot) p["rackSlot" + std::to_string(slot)] = 0;
  return p;
}
garak::Parameters merged(garak::Parameters a, const garak::Parameters& b) { for (const auto& [k, v] : b) a[k] = v; return a; }

// Every module and a copy of the clipping / modulation pedals, everything switched on (18 slots).
garak::Parameters fullRack(bool reverb = true) {
  garak::Parameters on;
  for (const char* base : {"comp", "drive", "fuzz", "amp", "cabinet", "chorus", "delay", "phaser", "tremolo", "reverb"})
    for (const char* suffix : {"", "_2"}) on[std::string(base) + "Enabled" + suffix] = 1;
  on["reverbEnabled"] = reverb ? 1 : 0; on["reverbEnabled_2"] = 0;
  on["delayTime"] = 140; on["delayTime_2"] = 75; on["fuzzLevel_2"] = -24; on["ampModel_2"] = 2; on["cabinet_2"] = 3;
  // comp, drive, fuzz, phaser, amp, cabinet, chorus, delay, tremolo, reverb, then copies and the tuner.
  return rack({1, 2, 7, 8, 3, 4, 5, 6, 9, 10, 17, 18, 23, 24, 25, 22, 19, 20}, on);
}

std::vector<Block> sweepBlocks(std::size_t frameCount, std::uint32_t seed, const Def& def) {
  std::vector<Block> blocks = plainBlocks(frameCount, seed, false);
  const std::size_t steps = blocks.size();
  for (std::size_t i = 0; i < steps; i += std::max<std::size_t>(1, steps / 24)) {
    const double x = static_cast<double>(i) / static_cast<double>(steps);
    const double tri = x < .5 ? 2 * x : 2 - 2 * x;
    double v = def.minimum + tri * (def.maximum - def.minimum);
    if (i == steps / 3) v = def.maximum + 10;
    if (i == steps / 2) v = def.minimum - 10;
    blocks[i].actions.push_back({Action::Automate, def.id, v, {}});
  }
  return blocks;
}

void rigParity() {
  const std::string type = "guitar-rig";
  const auto defs = rigCatalog();
  check(defs.size() == 154, "guitar rig catalog size", static_cast<double>(defs.size()));
  const auto input = programme(48000, rate, 11);
  const std::vector<float> shortInput(input.begin(), input.begin() + 2 * 12000);
  const std::vector<float> mediumInput(input.begin(), input.begin() + 2 * 24000);
  auto find = [&](const std::string& id) { return *std::find_if(defs.begin(), defs.end(), [&](const Def& d) { return d.id == id; }); };

  statsGroup = "guitar-rig (default rack)";
  compare(type, "defaults", {}, input, plainBlocks(48000, 3, true));
  compare(type, "empty rack", rack({}), shortInput, plainBlocks(12000, 4, false));

  // Amp heads: every model, each knob swept, hot and quiet input gain.
  statsGroup = "guitar-rig amp models";
  for (int model = 0; model <= 4; ++model) {
    const auto amp = rack({3}, {{"ampModel", model}});
    compare(type, "amp model " + std::to_string(model), amp, mediumInput, plainBlocks(24000, 5 + model, false));
    compare(type, "amp model " + std::to_string(model) + " max gain", merged(amp, {{"ampGain", 36}, {"ampBass", 12}, {"ampTreble", -12}}), shortInput, plainBlocks(12000, 6, false));
    for (const char* id : {"ampGain", "ampBass", "ampMid", "ampTreble", "ampPresence", "ampLevel", "ampModel", "ampEnabled"})
      compare(type, "amp model " + std::to_string(model) + " sweep " + id, amp, shortInput, sweepBlocks(12000, 7, find(id)));
  }

  // Cabinets x microphones, then position and distance sweeps.
  statsGroup = "guitar-rig cabinets x mics";
  for (int cab = 0; cab <= 4; ++cab) for (int mic = 0; mic <= 4; ++mic)
    compare(type, "cabinet " + std::to_string(cab) + " mic " + std::to_string(mic), rack({3, 4}, {{"cabinet", cab}, {"micType", mic}, {"micPosition", cab * .25}, {"micDistance", mic * .25}}),
            shortInput, plainBlocks(12000, 10 + cab * 5 + mic, false));
  for (const char* id : {"cabinet", "micType", "micPosition", "micDistance", "cabinetEnabled"})
    compare(type, std::string("cabinet sweep ") + id, rack({4}), mediumInput, sweepBlocks(24000, 8, find(id)));

  // Each pedal alone (switched on), every knob at its edges and swept, the switch toggled.
  statsGroup = "guitar-rig pedals";
  const std::pair<int, const char*> pedals[] = {{1, "comp"}, {2, "drive"}, {5, "chorus"}, {6, "delay"}, {7, "fuzz"}, {8, "phaser"}, {9, "tremolo"}, {10, "reverb"}, {11, "tuner"}};
  for (const auto& [code, base] : pedals) {
    const auto alone = rack({code}, {{std::string(base) + "Enabled", 1}});
    compare(type, std::string(base) + " alone", alone, mediumInput, plainBlocks(24000, 12 + code, false));
    for (const auto& def : defs) {
      if (def.id.rfind(base, 0) != 0 || def.id.find('_') != std::string::npos) continue;
      for (const double v : {def.minimum, def.maximum})
        compare(type, def.id + "=" + std::to_string(v), merged(alone, {{def.id, v}}), shortInput, plainBlocks(12000, 13, false));
      compare(type, "sweep " + def.id, alone, mediumInput, sweepBlocks(24000, 14 + code, def));
    }
  }

  // Full rack (every module, copies): construction edges and automation sweeps of every parameter.
  statsGroup = "guitar-rig full rack";
  const auto full = fullRack();
  compare(type, "full rack", full, input, plainBlocks(48000, 15, true));
  for (const auto& def : defs) {
    if (def.id.rfind("rackSlot", 0) == 0) continue;
    for (const double v : {def.minimum, def.maximum})
      compare(type, "full " + def.id + "=" + std::to_string(v), merged(full, {{def.id, v}}), shortInput, plainBlocks(12000, 16, false));
  }
  for (const auto& def : defs) compare(type, "full sweep " + def.id, full, shortInput, sweepBlocks(12000, 17, def));

  // Structural edits as hand-overs: reorder, bypass, duplicate, remove, reverb rebuilds, tuner.
  statsGroup = "guitar-rig reorder/duplicate/hand-over";
  {
    const auto base = rack({1, 2, 3, 4, 5, 6, 10}, {{"driveEnabled", 1}, {"chorusEnabled", 1}, {"delayEnabled", 1}, {"reverbEnabled", 1}});
    const std::vector<garak::Parameters> steps = {
      rack({1, 2, 3, 4, 6, 5, 10}, base),                       // reorder (chorus <-> delay): O(1) swap
      rack({2, 1, 3, 4, 6, 5, 10, 18}, merged(base, {{"driveEnabled_2", 1}})),  // reorder + duplicate drive
      merged(rack({2, 1, 3, 4, 6, 5, 10, 18}, base), {{"driveEnabled", 0}}),     // bypass
      rack({3, 4, 6, 10, 22, 21}, merged(base, {{"delayEnabled_2", 1}, {"chorusEnabled_2", 1}})),  // remove, copies of delay/chorus
      rack({3, 4, 6, 10, 22, 21}, merged(base, {{"reverbDecay", .9}})),          // reverb rebuild (new decay)
      rack({3, 4, 6, 10, 22, 21}, merged(base, {{"reverbEnabled", 0}})),         // reverb off: convolvers dropped
      rack({11, 3, 4, 6, 10, 26}, merged(base, {{"reverbEnabled_2", 1}, {"tunerEnabled", 1}})),  // tuner engaged, reverb copy
      rack({11, 3, 4, 6, 10, 26}, merged(base, {{"reverbEnabled_2", 1}})),       // tuner off again
    };
    std::vector<Block> blocks = plainBlocks(48000, 18, false);
    for (std::size_t i = 0; i < steps.size(); ++i) blocks[(i + 1) * blocks.size() / (steps.size() + 1)].actions.push_back({Action::Handover, "", 0, steps[i]});
    compare(type, "structural edits", base, input, blocks);
    std::vector<Block> resets = plainBlocks(24000, 19, false);
    resets[resets.size() / 2].actions.push_back({Action::Reset, "", 0, {}});
    compare(type, "reset", full, mediumInput, resets);
  }

  // Random racks (random layouts, copies), random automation, a reset and a hand-over to another rack.
  statsGroup = "guitar-rig random racks";
  for (std::uint32_t seed = 1; seed <= 8; ++seed) {
    Rng rng{seed * 104729};
    auto randomParams = [&] {
      garak::Parameters p;
      for (const auto& def : defs) {
        if (def.id.rfind("rackSlot", 0) == 0) p[def.id] = rng.unit() < 0.3 ? 0 : static_cast<double>(rng.next() % 44);
        else if (rng.unit() < 0.7) p[def.id] = def.id.find("Enabled") != std::string::npos ? (rng.unit() < .6 ? 1 : 0) : rng.range(def.minimum, def.maximum);
      }
      return p;
    };
    const auto init = randomParams();
    std::vector<Block> blocks = plainBlocks(24000, seed, true);
    for (std::size_t i = 0; i < blocks.size(); ++i) {
      if (rng.unit() < 0.3) {
        const auto& def = defs[rng.next() % defs.size()];
        blocks[i].actions.push_back({Action::Automate, def.id, rng.range(def.minimum, def.maximum), {}});
      }
      if (i == blocks.size() / 3) blocks[i].actions.push_back({Action::Reset, "", 0, {}});
      if (i == blocks.size() * 2 / 3) blocks[i].actions.push_back({Action::Handover, "", 0, randomParams()});
    }
    compare(type, "random " + std::to_string(seed), init, mediumInput, blocks);
  }

  // Other sample rates: the full rack (delay lines, IR lengths, coefficient designs, oversamplers).
  statsGroup = "guitar-rig 44.1/96 kHz";
  for (const double sr : {44100.0, 96000.0}) {
    const std::size_t n = static_cast<std::size_t>(sr * 0.5);
    compare(type, "rate " + std::to_string(static_cast<int>(sr)), full, programme(n, sr, 23), plainBlocks(n, 9, true), sr);
    compare(type, "rate " + std::to_string(static_cast<int>(sr)) + " defaults", {}, programme(n, sr, 24), plainBlocks(n, 10, false), sr);
  }
  statsGroup.clear();
}

void ffiContract() {
  // Null handles are ignored, unknown kinds refused, every effect reports a catalog.
  garak_rs_fx_process(nullptr, nullptr, 128);
  garak_rs_fx_automate(nullptr, nullptr, 0);
  // The guitar rig has its own entry points (garak_rs_rig_*), not a garak_rs_fx kind.
  check(garak_rs_fx_kind("guitar-rig", 10) < 0, "guitar rig is not a garak_rs_fx kind");
  garak_rs_rig_process(nullptr, nullptr, 128);
  garak_rs_rig_automate(nullptr, nullptr, 0);
  check(garak_rs_fx_param_count(99) == 0, "unknown kind");
  bool threw = false;
  try { (void)garak::test::makeEffect("guitar-rig", {{"ampGain", 99}}, rate, 120); } catch (const std::exception&) { threw = true; }
  check(threw, "guitar rig parameters are validated against the Rust catalog");
  threw = false;
  try { (void)garak::test::makeEffect("chorus", {{"rate", 99}}, rate, 120); } catch (const std::exception&) { threw = true; }
  check(threw, "effect parameters are validated against the Rust catalog");
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
  if (argc == 1 || std::string(argv[1]) == "guitar-rig") rigParity();
  check(goldens.size() > 0, "no golden references (native/tests/golden/rust-kernels.golden)");
  std::printf("| effect | renders | max residual vs golden (dBFS) | worst case | latency/tail/meter |\n|---|---:|---:|---|---|\n");
  for (const auto& type : order) {
    const auto& s = stats[type];
    std::printf("| %s | %d | %.1f | %s | %s |\n", type.c_str(), s.renders, dbfs(s.worst), s.worstCase.empty() ? "(bit-identical)" : s.worstCase.c_str(),
                s.latencyTailOk ? "as recorded" : "DIFFERS");
  }
  if (failures) { std::fprintf(stderr, "%d Rust kernel check(s) failed\n", failures); return EXIT_FAILURE; }
  std::puts("Rust DSP kernels: biquad, utility, pan law, dbToGain and every effect match the golden references");
  return EXIT_SUCCESS;
}

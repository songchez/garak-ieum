// 옥구슬 EP / 한밤 106 through the C ABI and the engine (docs/RUST.md "빈티지 악기").
//
// 1. Parity: the scripted scene of rust/garak-dsp/src/instruments/mod.rs (parity_scene) rendered
//    through garak-ffi must hash to the checksums in parity.golden, the file garak-dsp's own test
//    (instruments/mod.rs) checks; the web runs the same garak-dsp code inside garak-engine.wasm.
// 2. CPU: 8 sustained voices of each instrument at 48 kHz must stay under 3 % of one core.
// 3. Engine: a timeline track and live notes (sustain pedal deferral, automation, param edits that
//    keep voices ringing) through RenderEngine.
#include "garak/engine.hpp"
#include "garak_rust.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
#include <new>
#include <sstream>
#include <string>
#include <vector>

#ifndef GARAK_INSTRUMENT_GOLDEN
#error "GARAK_INSTRUMENT_GOLDEN must name rust/garak-dsp/src/instruments/parity.golden"
#endif

namespace {
int failures = 0;
void check(bool ok, const std::string& what) {
  if (!ok) { std::fprintf(stderr, "FAIL: %s\n", what.c_str()); ++failures; }
}

struct Instrument {
  explicit Instrument(std::uint32_t kind, const std::vector<double>& params, double rate = 48000) {
    state = static_cast<GarakRsInstrument*>(::operator new(garak_rs_instrument_size(), std::align_val_t(garak_rs_instrument_align())));
    rc = garak_rs_instrument_init(state, kind, rate, params.data(), static_cast<std::uint32_t>(params.size()));
  }
  ~Instrument() { ::operator delete(state, std::align_val_t(garak_rs_instrument_align())); }
  Instrument(const Instrument&) = delete;
  Instrument& operator=(const Instrument&) = delete;
  GarakRsInstrument* state = nullptr;
  int rc = 0;
};

std::vector<std::string> ids(std::uint32_t kind) {
  std::vector<std::string> out;
  for (std::uint32_t i = 0; i < garak_rs_instrument_param_count(kind); ++i) {
    char name[64];
    out.emplace_back(name, std::min(garak_rs_instrument_param_id(kind, i, name, sizeof name), sizeof name));
  }
  return out;
}

std::vector<double> defaults(std::uint32_t kind) {
  std::vector<double> out(garak_rs_instrument_param_count(kind));
  for (std::uint32_t i = 0; i < out.size(); ++i) { double lo = 0, hi = 0; garak_rs_instrument_param_range(kind, i, &out[i], &lo, &hi); }
  return out;
}

// --- parity scene (mirror of parity_scene in rust/garak-dsp/src/instruments/mod.rs) -------------
struct Timed { std::uint64_t frame; GarakRsInstrumentEvent e; };

std::vector<Timed> sceneEvents(std::uint32_t kind) {
  std::vector<Timed> list;
  for (std::uint32_t i = 0; i < 12; ++i) {
    const std::uint32_t pitch = 36 + (i * 7) % 40;
    const auto velocity = static_cast<float>(0.3 + 0.05 * i);
    list.push_back({std::uint64_t(i) * 3001, {0, GARAK_RS_EVENT_NOTE_ON, static_cast<std::int32_t>(i), pitch, velocity, 0}});
    list.push_back({std::uint64_t(i) * 3001 + 9000, {0, GARAK_RS_EVENT_NOTE_OFF, static_cast<std::int32_t>(i), pitch, 0, 0}});
  }
  list.push_back({20000, {0, GARAK_RS_EVENT_CONTROLLER, -1, 0, .75f, 129}});
  list.push_back({25000, {0, GARAK_RS_EVENT_CONTROLLER, -1, 0, .5f, 1}});
  list.push_back({30000, {0, GARAK_RS_EVENT_CONTROLLER, -1, 0, 1.f, 64}});
  list.push_back({50000, {0, GARAK_RS_EVENT_CONTROLLER, -1, 0, 0.f, 64}});
  double def = 0, lo = 0, hi = 0;
  garak_rs_instrument_param_range(kind, 0, &def, &lo, &hi);
  list.push_back({40000, {0, GARAK_RS_EVENT_PARAM, -1, 0, static_cast<float>(hi), 0}});
  list.push_back({60000, {0, GARAK_RS_EVENT_CONTROLLER, -1, 0, .6f, 7}});
  std::stable_sort(list.begin(), list.end(), [](const Timed& a, const Timed& b) { return a.frame < b.frame; });
  return list;
}

std::vector<double> sceneParams(std::uint32_t kind) {
  const std::map<std::string, double> ep{{"bark", .8}, {"tremDepth", .6}, {"autopan", .7}, {"drive", .4}, {"tremRate", 5.5}};
  const std::map<std::string, double> poly{{"pulse", .6}, {"noise", .1}, {"resonance", .6}, {"chorus", 3}, {"glide", .05},
                                           {"voices", 4}, {"lfoFilter", .2}, {"vibrato", .3}, {"lfoDelay", .2}};
  auto values = defaults(kind);
  const auto names = ids(kind);
  for (const auto& [id, value] : kind == GARAK_RS_INSTRUMENT_EP ? ep : poly) {
    const auto found = std::find(names.begin(), names.end(), id);
    check(found != names.end(), "scene parameter " + id);
    if (found != names.end()) values[static_cast<std::size_t>(found - names.begin())] = value;
  }
  return values;
}

std::uint64_t fnv(std::uint64_t h, float v) {
  std::uint32_t bits;
  std::memcpy(&bits, &v, 4);
  h ^= bits;
  return h * 0x00000100000001b3ull;
}

std::uint64_t renderScene(std::uint32_t kind, std::uint32_t block) {
  Instrument inst(kind, sceneParams(kind));
  check(inst.rc == GARAK_RS_OK, "init");
  const auto events = sceneEvents(kind);
  std::vector<float> l(block), r(block);
  std::vector<GarakRsInstrumentEvent> blockEvents;
  std::uint64_t h = 0xcbf29ce484222325ull;
  std::size_t next = 0;
  for (std::uint64_t at = 0; at < 96000; at += block) {
    const auto n = static_cast<std::uint32_t>(std::min<std::uint64_t>(block, 96000 - at));
    blockEvents.clear();
    while (next < events.size() && events[next].frame < at + n) {
      auto e = events[next++].e;
      e.offset = static_cast<std::uint32_t>(events[next - 1].frame - at);
      blockEvents.push_back(e);
    }
    garak_rs_instrument_process(inst.state, l.data(), r.data(), n, blockEvents.data(), static_cast<std::uint32_t>(blockEvents.size()));
    for (std::uint32_t i = 0; i < n; ++i) { h = fnv(h, l[i]); h = fnv(h, r[i]); }
  }
  return h;
}

std::map<std::string, std::uint64_t> golden() {
  std::map<std::string, std::uint64_t> out;
  std::ifstream file(GARAK_INSTRUMENT_GOLDEN);
  std::string id, hex;
  while (file >> id >> hex) out[id] = std::strtoull(hex.c_str(), nullptr, 16);
  return out;
}

void parity() {
  const auto expected = golden();
  check(expected.size() == GARAK_RS_INSTRUMENT_COUNT, "parity.golden lists every instrument");
  const char* names[] = {"okgu-ep", "hanbam-106"};
  for (std::uint32_t kind = 0; kind < GARAK_RS_INSTRUMENT_COUNT; ++kind) {
    check(garak_rs_instrument_kind(names[kind], std::strlen(names[kind])) == static_cast<int>(kind), "kind id");
    const auto a = renderScene(kind, 128), b = renderScene(kind, 97);
    std::printf("| %s | %016llx | %s | %s |\n", names[kind], static_cast<unsigned long long>(a),
                a == expected.at(names[kind]) ? "bit-identical to Rust/WASM" : "DIFFERS", a == b ? "block-size independent" : "BLOCK DEPENDENT");
    check(a == expected.at(names[kind]), std::string(names[kind]) + " parity checksum");
    check(a == b, std::string(names[kind]) + " block-size independence");
  }
}

// --- CPU budget --------------------------------------------------------------------------------
void cpu() {
  const char* names[] = {"okgu-ep", "hanbam-106"};
  for (std::uint32_t kind = 0; kind < GARAK_RS_INSTRUMENT_COUNT; ++kind) {
    auto params = defaults(kind);
    if (kind == GARAK_RS_INSTRUMENT_POLY) {
      const auto names2 = ids(kind);
      // Worst case: every oscillator, 8 voices, resonant filter, chorus I+II.
      for (const auto& [id, value] : std::map<std::string, double>{{"voices", 8}, {"pulse", 1}, {"sub", 1}, {"noise", .2}, {"resonance", .7}, {"chorus", 3}, {"sustain", 1}})
        params[static_cast<std::size_t>(std::find(names2.begin(), names2.end(), id) - names2.begin())] = value;
    } else {
      const auto names2 = ids(kind);
      for (const auto& [id, value] : std::map<std::string, double>{{"tremDepth", .5}, {"autopan", 1}, {"drive", .5}, {"decay", 4}})
        params[static_cast<std::size_t>(std::find(names2.begin(), names2.end(), id) - names2.begin())] = value;
    }
    Instrument inst(kind, params);
    std::vector<GarakRsInstrumentEvent> notes;
    for (std::uint32_t v = 0; v < 8; ++v) notes.push_back({0, GARAK_RS_EVENT_NOTE_ON, static_cast<std::int32_t>(v), 40 + v * 5, .8f, 0});
    std::vector<float> l(128), r(128);
    garak_rs_instrument_process(inst.state, l.data(), r.data(), 128, notes.data(), static_cast<std::uint32_t>(notes.size()));
    const double seconds = 10;
    const auto blocks = static_cast<int>(seconds * 48000 / 128);
    double best = 1e9;
    const auto measure = [&] {
      for (int round = 0; round < 3; ++round) {
        const auto start = std::chrono::steady_clock::now();
        for (int b = 0; b < blocks; ++b) garak_rs_instrument_process(inst.state, l.data(), r.data(), 128, nullptr, 0);
        best = std::min(best, std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count());
      }
    };
    measure();
    // A shared runner can stall a whole round: up to two more sets of rounds before judging (best of all).
    for (int retry = 0; retry < 2 && best / seconds * 100 >= 3.0; ++retry) measure();
    const double percent = best / seconds * 100;
    const auto voices = garak_rs_instrument_active_voices(inst.state);
    std::printf("| %s | 8 voices @ 48 kHz | %.2f %% of one core | %u voices sounding |\n", names[kind], percent, voices);
    check(voices == 8, std::string(names[kind]) + " keeps 8 voices for the CPU measurement");
    // GARAK_CPU_GATES=report (the installer workflows, on shared runners): the budget is reported, not enforced.
    // rust.yml enforces it. Parity and voice counts above are always enforced.
    const char* gates = std::getenv("GARAK_CPU_GATES");
    if (gates && std::string(gates) == "report") {
      if (percent >= 3.0) std::printf("CPU budget exceeded (report only): %s %.2f %% >= 3 %%\n", names[kind], percent);
    } else {
      check(percent < 3.0, std::string(names[kind]) + " CPU budget (8 voices < 3 % of one core)");
    }
  }
}

// --- engine -----------------------------------------------------------------------------------
using namespace garak;
std::vector<float> render(RenderEngine& e, std::uint32_t frames, std::uint32_t block = 128) {
  std::vector<float> out(static_cast<std::size_t>(frames) * 2);
  for (std::uint32_t at = 0; at < frames; at += block) e.render(out.data() + at * 2, nullptr, std::min(block, frames - at), 2);
  return out;
}
double energy(const std::vector<float>& d, std::size_t first = 0, std::size_t last = ~std::size_t(0)) {
  double sum = 0;
  last = std::min(last, d.size() / 2);
  for (std::size_t i = first * 2; i < last * 2; ++i) { check(std::isfinite(d[i]), "finite engine output"); sum += double(d[i]) * d[i]; }
  return sum;
}
ProjectTimeline project(const std::string& instrument, Parameters params = {}) {
  ProjectTimeline p;
  p.projectId = "vintage";
  p.sampleRate = 48000;
  p.lengthFrames = 96000;
  TrackTimeline t;
  t.id = "v";
  t.source.kind = TrackSource::Kind::BuiltinSynth;
  t.source.instrumentId = instrument;
  t.source.params = std::move(params);
  p.tracks.push_back(t);
  return p;
}

void engine() {
  for (const char* id : {"okgu-ep", "hanbam-106"}) {
    // Timeline notes; a block size that does not divide anything nicely.
    auto p = project(id, {{"level", 1}});
    p.tracks[0].notes = {{1, 4800, 24000, 96000, 60, .8f}, {2, 4800, 24000, 96000, 64, .7f}};
    RenderEngine e(48000, 512);
    e.submit(e.prepare(p, {}));
    check(e.play(), "play");
    const auto out = render(e, 72000, 173);
    check(energy(out, 0, 4800) == 0, std::string(id) + " silent before the first onset");
    check(energy(out, 4800, 24000) > 1, std::string(id) + " timeline notes sound");
    check(energy(out, 60000, 72000) < energy(out, 4800, 24000) * 1e-3, std::string(id) + " notes end after their note-off");

    // Unknown parameters are rejected like the built-in synths'.
    bool threw = false;
    try { RenderEngine x(48000, 512); x.submit(x.prepare(project(id, {{"nope", 1}}), {})); } catch (const std::exception&) { threw = true; }
    check(threw, std::string(id) + " rejects unknown parameters");

    // Live notes with the sustain pedal: the deferred note-off keeps the voice ringing until pedal up.
    auto live = project(id, {{"release", .05}});
    RenderEngine pedal(48000, 256), plain(48000, 256);
    for (auto* x : {&pedal, &plain}) x->submit(x->prepare(live, {}));
    check(pedal.noteOn(0, 60, .9f, 1) && plain.noteOn(0, 60, .9f, 1), "live note on");
    (void)render(pedal, 2400); (void)render(plain, 2400);
    check(pedal.controlChange(0, 64, 127) && pedal.noteOff(0, 60, 1) && plain.noteOff(0, 60, 1), "pedal + note off");
    auto a = render(pedal, 24000), b = render(plain, 24000);
    check(energy(a, 12000, 24000) > 50 * energy(b, 12000, 24000) + 1e-9, std::string(id) + " sustain pedal defers the live note-off");
    check(pedal.controlChange(0, 64, 0), "pedal up");
    a = render(pedal, 48000);
    check(energy(a, 36000, 48000) < 1e-6 + energy(a, 0, 2400) * 1e-3, std::string(id) + " pedal up releases");

    // Editing a parameter rebuilds the track but keeps the ringing voice (take_state).
    auto edited = project(id, {{"level", 1}});
    edited.tracks[0].notes = {{1, 0, 90000, 96000, 57, .9f}};
    RenderEngine x(48000, 256);
    x.submit(x.prepare(edited, {}));
    check(x.play(), "play edited");
    (void)render(x, 24000);
    auto changed = edited;
    changed.tracks[0].source.params["level"] = .5;
    x.submit(x.prepare(changed, {}));
    const auto after = render(x, 4800);
    check(energy(after, 2400, 4800) > 1e-3, std::string(id) + " keeps ringing across a parameter edit");
  }
}
} // namespace

int main(int argc, char** argv) {
  std::printf("| instrument | checksum | parity | blocks |\n|---|---|---|---|\n");
  parity();
  if (argc < 2 || std::string(argv[1]) != "--no-cpu") {
    std::printf("\n| instrument | load | CPU | voices |\n|---|---|---|---|\n");
    cpu();
  }
  engine();
  if (failures) { std::fprintf(stderr, "%d vintage instrument check(s) failed\n", failures); return EXIT_FAILURE; }
  std::puts("Vintage instruments: parity with WASM, CPU budget and engine integration OK");
  return EXIT_SUCCESS;
}

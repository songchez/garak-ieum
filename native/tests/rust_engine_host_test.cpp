// GARAK_RUST_ENGINE host path (docs/RUST_ENGINE.md 10): RenderEngine as the shell around the Rust graph.
//
// The project is rust/garak-engine/src/testkit.rs (audio clips, fades, every built-in effect but the guitar
// rig, pre/post sends into returns, automation, a tempo ramp). Cases:
//   1. offline export (host renderStopped loop): the C++ engine vs the same RenderEngine with setRustEngine(2);
//   2. live playback with mid-play diffs (mix, send, live insert parameter, master, a track rebuild), a seek and
//      a cycle: C++ vs Rust shell, through RenderEngine::update (the Rust graph's commands are gated by ticket);
//   3. multi-core: the Rust shell with 0 and N worker threads must be bit-identical;
//   4. fallback: a project the Rust engine refuses renders in C++ in mode 1 (counted in EngineSnapshot::rustRefusals)
//      and throws in strict mode. The Rust engine renders every project now, so the shell's test diagnostic
//      GARAK_RUST_ENGINE_REFUSE_INSERT names the refused insert (a guitar rig);
//   5. metronome: the garak-engine port vs native/src/metronome.hpp (grids, compound meters, tempo and meter
//      maps, count-in), driven the way RenderEngine::renderClicks drives it;
//   6. host nodes (docs/RUST_ENGINE.md 4): VST3 instrument and inserts (a stand-in plug-in) with events, sustain,
//      parameter automation and PDC, a latent return, track-input routes and a master resampler, monitored device
//      input and routed/physical recording takes, live MIDI, seek, cycle, edits; frozen windows with tails; the
//      shell's render-ahead rings: C++ engine vs Rust shell bit-identical, 0 vs N workers bit-identical;
//   7. live MIDI at sample offsets (queueLiveMidi) on a VST3 instrument and a built-in synth: C++ split blocks vs
//      the Rust shell's offsets (garak_rs_engine_live_at, sampleOffset), same onset sample;
//   8. CPU: blocks per second of the C++ engine, the Rust shell and the Rust shell on N workers (table).
// Gate: residual <= -90 dBFS (bit-identical expected), equal latency; the multi-core output bit-identical.
#include "cpp_reference_engine.hpp"
#include "garak/dsp.hpp"
#include "garak/engine.hpp"
#include "garak_engine.h"
#include "protocol.hpp"
#include "metronome.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <map>
#include <memory>
#include <span>
#include <string>
#include <thread>
#include <vector>

namespace {
int failures = 0;
void check(bool ok, const std::string& what, double detail = 0) {
  if (!ok) { ++failures; std::fprintf(stderr, "FAIL %s (%.6g)\n", what.c_str(), detail); }
}
double dbfs(double v) { return v > 0 ? 20 * std::log10(v) : -400; }

struct Project {
  std::string json;
  garak::AssetStore assets;
};

Project testProject(std::uint32_t tracks, double seconds, std::uint32_t rate) {
  Project p;
  auto* t = garak_rs_testkit_create(tracks, seconds, rate);
  if (!t) throw std::runtime_error("testkit project");
  std::size_t length = 0;
  const auto* json = garak_rs_testkit_json(t, &length);
  p.json.assign(reinterpret_cast<const char*>(json), length);
  for (std::uint32_t i = 0; i < garak_rs_testkit_asset_count(t); ++i) {
    const std::uint8_t* id = nullptr; std::size_t idLength = 0, count = 0; std::uint32_t sr = 0, channels = 0; const float* samples = nullptr;
    garak_rs_testkit_asset(t, i, &id, &idLength, &sr, &channels, &samples, &count);
    auto asset = std::make_shared<garak::PcmAsset>();
    asset->id.assign(reinterpret_cast<const char*>(id), idLength);
    asset->sampleRate = sr; asset->channels = channels; asset->samples.assign(samples, samples + count);
    p.assets.emplace(asset->id, std::move(asset));
  }
  garak_rs_testkit_destroy(t);
  return p;
}
garak::ProjectTimeline parse(const std::string& json) { return garak::protocol::timeline(garak::protocol::Json::parse(json)); }
std::string edit(std::string text, const std::string& from, const std::string& to) {
  const auto at = text.find(from);
  if (at == std::string::npos) throw std::runtime_error("edit target missing: " + from);
  return text.replace(at, from.size(), to);
}
double residual(const std::vector<float>& a, const std::vector<float>& b) {
  if (a.size() != b.size()) return 1e9;
  double m = 0;
  for (std::size_t i = 0; i < a.size(); ++i) m = std::max(m, double(std::abs(a[i] - b[i])));
  return m;
}
double peak(const std::vector<float>& a) { double m = 0; for (const auto x : a) m = std::max(m, double(std::abs(x))); return m; }
std::string verdict(double d) { return d == 0 ? "bit-identical" : std::to_string(dbfs(d)).substr(0, 7) + " dBFS"; }

struct Render { std::vector<float> samples; std::uint32_t latency = 0; bool rust = false; std::uint64_t refusals = 0; };

// native/src/host.cpp renderStopped through RenderEngine in `mode` (0 C++, 1 Rust + fallback, 2 strict).
Render offline(const Project& project, std::uint32_t block, int mode, std::uint32_t threads = 0, bool bypass = false,
               const std::function<void(garak::ProjectTimeline&)>& shape = {}) {
  auto timeline = parse(project.json); timeline.cycle.reset();
  if (shape) shape(timeline);
  garak::RenderEngine engine(timeline.sampleRate, block); engine.setRustEngine(mode); engine.setOffline(true); engine.setMasterBypass(bypass);
  if (threads) { garak::ProcessingOptions options; options.threads = threads; engine.setProcessing(options); }
  auto prepared = engine.prepare(timeline, project.assets);
  const double tail = std::min(30.0, prepared->tailSeconds());
  Render r; r.latency = prepared->latencyFrames();
  const auto frames = std::uint64_t(timeline.lengthFrames) + std::uint64_t(std::ceil(tail * timeline.sampleRate));
  engine.submit(std::move(prepared)); (void)engine.play();
  std::vector<float> chunk(std::size_t(block) * 2);
  for (std::uint64_t done = 0; done < frames + r.latency;) {
    const auto n = std::uint32_t(std::min<std::uint64_t>(block, frames + r.latency - done));
    engine.render(chunk.data(), nullptr, n, 0);
    r.rust = r.rust || engine.snapshot().rustEngine;
    const auto skip = std::uint32_t(std::min<std::uint64_t>(n, done < r.latency ? r.latency - done : 0));
    r.samples.insert(r.samples.end(), chunk.begin() + skip * 2, chunk.begin() + n * 2);
    done += n;
  }
  r.refusals = engine.snapshot().rustRefusals;
  engine.collectRetired();
  return r;
}

// Live playback with edits at fixed callbacks; `calls` device buffers of `call` frames.
Render live(const Project& project, int mode, std::uint32_t threads, const std::vector<std::pair<std::uint32_t, std::function<void(garak::RenderEngine&)>>>& script,
            std::uint32_t calls, std::uint32_t call = 256, std::uint32_t block = 128) {
  const auto timeline = parse(project.json);
  garak::RenderEngine engine(timeline.sampleRate, block); engine.setRustEngine(mode);
  if (threads) { garak::ProcessingOptions options; options.threads = threads; engine.setProcessing(options); }
  (void)engine.update(timeline, project.assets);
  (void)engine.play();
  Render r; r.samples.resize(std::size_t(calls) * call * 2);
  std::size_t next = 0;
  for (std::uint32_t k = 0; k < calls; ++k) {
    while (next < script.size() && script[next].first == k) script[next++].second(engine);
    engine.render(r.samples.data() + std::size_t(k) * call * 2, nullptr, call, 0);
    r.rust = r.rust || engine.snapshot().rustEngine;
    if (k % 16 == 0) engine.collectRetired();
  }
  r.refusals = engine.snapshot().rustRefusals;
  return r;
}

void offlineCases() {
  for (const auto& [tracks, seconds, rate, block] : {std::tuple{8u, 4.0, 48000u, 4096u}, std::tuple{8u, 4.0, 48000u, 128u}, std::tuple{6u, 3.0, 44100u, 4096u}}) {
    const auto project = testProject(tracks, seconds, rate);
    const auto cpp = offline(project, block, 0), rust = offline(project, block, 2);
    const double d = residual(cpp.samples, rust.samples);
    std::printf("| offline export | %u+2 | %.0f s | %u Hz | %u | %u / %u | %s |\n", tracks, seconds, rate, block, cpp.latency, rust.latency, verdict(d).c_str());
    check(rust.rust && !cpp.rust, "offline: the Rust shell rendered through Rust");
    check(cpp.latency == rust.latency, "offline: latency", rust.latency);
    check(peak(cpp.samples) > .05, "offline: silent", peak(cpp.samples));
    check(dbfs(d) <= -90, "offline: residual", dbfs(d));
  }
  // Master bypass (stems/freeze renders): the shell skips master gain and processor for both engines.
  const auto project = testProject(4, 2, 48000);
  const auto cpp = offline(project, 512, 0, 0, true), rust = offline(project, 512, 2, 0, true);
  const double d = residual(cpp.samples, rust.samples);
  std::printf("| offline, master bypass | 4+2 | 2 s | 48000 Hz | 512 | %u / %u | %s |\n", cpp.latency, rust.latency, verdict(d).c_str());
  check(dbfs(d) <= -90, "master bypass: residual", dbfs(d));
  // Stem and freeze/bounce taps (docs/BOUNCE_FREEZE_STEMS.md): one track pre-fader (its own output only), and a
  // return stem (every sender out of the master sum, their sends still feeding the returns).
  const std::function<void(garak::ProjectTimeline&)> preFader = [](garak::ProjectTimeline& t) {
    for (std::size_t i = 0; i < t.tracks.size(); ++i) { t.tracks[i].directOut = i == 1; t.tracks[i].preFader = i == 1; }
  };
  const std::function<void(garak::ProjectTimeline&)> returnStem = [](garak::ProjectTimeline& t) {
    for (auto& track : t.tracks) track.directOut = track.isReturn;
  };
  for (const auto& [name, shape] : {std::pair{"pre-fader track (freeze/bounce)", preFader}, std::pair{"return stem (direct-out off)", returnStem}}) {
    const auto c = offline(project, 512, 0, 0, true, shape), r = offline(project, 512, 2, 0, true, shape);
    const double x = residual(c.samples, r.samples);
    std::printf("| offline, %s | 4+2 | 2 s | 48000 Hz | 512 | %u / %u | %s |\n", name, c.latency, r.latency, verdict(x).c_str());
    check(r.rust && peak(c.samples) > 1e-3, std::string(name) + ": rendered through Rust", peak(c.samples));
    check(dbfs(x) <= -90, std::string(name) + ": residual", dbfs(x));
  }
}

void liveCases() {
  const auto project = testProject(8, 4, 48000);
  auto diff = edit(project.json, R"("revision":1)", R"("revision":2)");
  diff = edit(diff, R"("masterGain":0.8)", R"("masterGain":0.55)");
  diff = edit(diff, R"("id":"track-0","source":{"kind":"audio"},"gain":0.5)", R"("id":"track-0","source":{"kind":"audio"},"gain":0.2)");
  diff = edit(diff, R"({"returnId":"ret-verb","gain":0.25})", R"({"returnId":"ret-verb","gain":0.9})");
  diff = edit(diff, R"("ratio":5)", R"("ratio":9)");
  auto rebuild = edit(diff, R"("revision":2)", R"("revision":3)");
  rebuild = edit(rebuild, R"("gain":1.3)", R"("gain":0.4)");
  const auto diffPlan = parse(diff), rebuildPlan = parse(rebuild);
  auto cycled = rebuildPlan; cycled.revision = 4; cycled.cycle = std::array<std::int64_t, 2>{24000, 120000};
  std::vector<std::pair<std::uint32_t, std::function<void(garak::RenderEngine&)>>> script{
      {90, [&](garak::RenderEngine& e) { check(e.update(diffPlan, project.assets).kind == garak::UpdateResult::Kind::Diff, "live: diff classification"); }},
      {280, [&](garak::RenderEngine& e) { check(e.update(rebuildPlan, project.assets).kind == garak::UpdateResult::Kind::Tracks, "live: rebuild classification"); }},
      {400, [&](garak::RenderEngine& e) { (void)e.seek(30000); }},
      {470, [&](garak::RenderEngine& e) { check(e.update(cycled, project.assets).kind == garak::UpdateResult::Kind::Full, "live: cycle is a new graph"); }},
      {560, [&](garak::RenderEngine& e) { (void)e.pause(); }},
      {580, [&](garak::RenderEngine& e) { (void)e.play(); }},
      {640, [&](garak::RenderEngine& e) { (void)e.setMasterGain(.3f); }},
  };
  const auto cpp = live(project, 0, 0, script, 750), rust = live(project, 2, 0, script, 750);
  const double d = residual(cpp.samples, rust.samples);
  std::printf("| live: diffs, rebuild, seek, cycle, pause/play, master | 8+2 | 4 s | 48000 Hz | 128 (256 calls) | — | %s |\n", verdict(d).c_str());
  check(rust.rust && peak(cpp.samples) > .05, "live: rendered through Rust");
  check(dbfs(d) <= -90, "live: residual", dbfs(d));

  // Multi-core: the Rust shell on worker threads is bit-identical to one thread (and to the C++ engine).
  const auto workers = std::max(2u, std::min(4u, std::thread::hardware_concurrency()));
  const auto parallel = live(project, 2, workers, script, 750);
  const double m = residual(rust.samples, parallel.samples);
  std::printf("| multi-core: Rust shell, 0 vs %u workers | 8+2 | 4 s | 48000 Hz | 128 (256 calls) | — | %s |\n", workers, verdict(m).c_str());
  check(m == 0, "multi-core: Rust output differs from one thread", dbfs(m));
  const auto many = testProject(24, 2, 48000);
  const auto one = offline(many, 512, 2, 0), more = offline(many, 512, 2, workers);
  const double m2 = residual(one.samples, more.samples);
  std::printf("| multi-core: offline export, 0 vs %u workers | 24+2 | 2 s | 48000 Hz | 512 | %u / %u | %s |\n", workers, one.latency, more.latency, verdict(m2).c_str());
  check(m2 == 0, "multi-core offline: Rust output differs from one thread", dbfs(m2));
}

// Sets (or with null, clears) an environment variable for the engines constructed next.
void setEnvironment(const char* name, const char* value) {
#ifdef _WIN32
  (void)_putenv_s(name, value ? value : "");
#else
  if (value) (void)setenv(name, value, 1); else (void)unsetenv(name);
#endif
}

void fallbackCases() {
  setEnvironment("GARAK_RUST_ENGINE_REFUSE_INSERT", "guitar-rig");
  struct Restore { ~Restore() { setEnvironment("GARAK_RUST_ENGINE_REFUSE_INSERT", nullptr); } } restore;
  const auto project = testProject(2, 1, 48000);
  auto plan = parse(project.json);
  garak::BuiltinInsert rig; rig.id = "rig"; rig.type = "guitar-rig";
  plan.tracks[0].inserts.push_back(rig);
  const auto timeline = parse(project.json);
  // Mode 1: the refused update renders in C++ from then on (equal to the C++ engine after a seek).
  garak::RenderEngine fallback(48000, 256); fallback.setRustEngine(1);
  garak::RenderEngine reference(48000, 256);
  (void)fallback.update(timeline, project.assets); (void)reference.update(timeline, project.assets);
  (void)fallback.play(); (void)reference.play();
  std::vector<float> a(512), b(512);
  bool rustBefore = false, rustAfter = true;
  double d = 0;
  for (int k = 0; k < 120; ++k) {
    if (k == 40) { (void)fallback.update(plan, project.assets); (void)reference.update(plan, project.assets); }
    // Switching engines mid-play restarts the C++ tracks' state (they were idle); a seek resets both alike.
    if (k == 60) { (void)fallback.seek(0); (void)reference.seek(0); }
    fallback.render(a.data(), nullptr, 256, 0); reference.render(b.data(), nullptr, 256, 0);
    if (k == 30) rustBefore = fallback.snapshot().rustEngine;
    if (k == 119) rustAfter = fallback.snapshot().rustEngine;
    if (k > 60) d = std::max(d, residual(a, b));
  }
  std::printf("| fallback: a refused update renders in C++ | 2+2 | — | 48000 Hz | 256 | — | %s (refusals %llu: %s) |\n", verdict(d).c_str(),
              static_cast<unsigned long long>(fallback.snapshot().rustRefusals), fallback.lastRustRefusal().c_str());
  check(rustBefore && !rustAfter, "fallback: render path did not switch to C++");
  check(fallback.snapshot().rustRefusals == 1 && !fallback.lastRustRefusal().empty(), "fallback: refusal not reported");
  check(dbfs(d) <= -90, "fallback: C++ render after refusal differs", dbfs(d));
  // Strict mode refuses the same plan, leaving the running graph unchanged.
  garak::RenderEngine strict(48000, 256); strict.setRustEngine(2);
  bool threw = false;
  try { (void)strict.update(plan, project.assets); } catch (const std::exception&) { threw = true; }
  check(threw, "strict: a refused project did not throw");
  check(garak::rustEngineAvailable(), "rustEngineAvailable");
}

struct MetronomeCase {
  const char* name; double bpm; int numerator, denominator;
  std::vector<garak::TempoPoint> tempo; std::vector<garak::MeterEvent> meters;
  std::int64_t start, countIn; std::uint32_t block;
};
// native/src/engine.cpp renderClicks (count-in, one meter, meter map) over metronome.hpp.
std::vector<float> clicksCpp(const MetronomeCase& c, const garak::MetronomeClicks& set, std::uint32_t total) {
  constexpr double rate = 48000;
  const garak::TempoMap tempo(c.bpm, c.tempo);
  const garak::MeterMap meters(c.numerator, c.denominator, c.meters);
  const bool mapped = c.tempo.size() >= 2, metered = c.meters.size() >= 2;
  garak::metronome::Player player;
  std::vector<float> out(std::size_t(total) * 2);
  std::int64_t position = c.start, elapsed = 0;
  for (std::uint32_t done = 0; done < total;) {
    const auto frames = std::min(c.block, total - done);
    float* chunk = out.data() + std::size_t(done) * 2;
    player.mix(chunk, frames, .7f);
    if (c.countIn > 0) {
      const double startBeat = mapped ? tempo.beatAtFrame(double(position), rate) : double(position) * c.bpm / (60.0 * rate);
      const auto meter = metered ? meters.at(startBeat) : garak::MeterEvent{0, c.numerator, c.denominator, 0};
      garak::metronome::clicks(garak::metronome::grid(rate, mapped ? tempo.bpmAt(startBeat) : c.bpm, meter.numerator, meter.denominator), set, player, chunk, elapsed, frames, .7f, c.countIn);
      elapsed += frames;
    } else if (!metered) {
      garak::metronome::clicks(garak::metronome::grid(rate, c.bpm, c.numerator, c.denominator, mapped ? &tempo : nullptr), set, player, chunk, position, frames, .7f);
      position += frames;
    } else {
      garak::metronome::meterClicks(meters, rate, c.bpm, mapped ? &tempo : nullptr, set, player, chunk, position, frames, .7f);
      position += frames;
    }
    done += frames;
  }
  return out;
}
std::vector<float> clicksRust(const MetronomeCase& c, const garak::MetronomeClicks& set, std::uint32_t total) {
  std::vector<double> beats, bpms; std::vector<std::uint8_t> ramps;
  for (const auto& p : c.tempo) { beats.push_back(p.beat); bpms.push_back(p.bpm); ramps.push_back(p.ramp ? 1 : 0); }
  std::vector<std::int64_t> bars; std::vector<std::int32_t> numerators, denominators;
  for (const auto& m : c.meters) { bars.push_back(m.bar); numerators.push_back(m.numerator); denominators.push_back(m.denominator); }
  const float* levels[3] = {set.levels[0].data(), set.levels[1].data(), set.levels[2].data()};
  const std::size_t lengths[3] = {set.levels[0].size(), set.levels[1].size(), set.levels[2].size()};
  std::vector<float> out(std::size_t(total) * 2);
  const auto status = garak_rs_metronome_render(48000, c.bpm, c.numerator, c.denominator, beats.data(), bpms.data(), ramps.data(), std::uint32_t(beats.size()),
                                                bars.data(), numerators.data(), denominators.data(), std::uint32_t(bars.size()), levels, lengths,
                                                c.start, c.countIn, c.block, total, .7f, out.data());
  check(status == 0, std::string(c.name) + ": rust metronome refused the arguments");
  return out;
}
void metronomeCases() {
  // Three distinct strokes, long enough to overlap blocks and each other (the gugak set's shapes do not matter here).
  garak::MetronomeClicks set; set.sampleRate = 48000;
  for (int level = 0; level < 3; ++level) {
    const int length = 2400 + 1700 * level;
    for (int i = 0; i < length; ++i) set.levels[std::size_t(level)].push_back(float(std::sin(i * (.05 + .03 * level)) * std::exp(-i / (300.0 + 200 * level))));
  }
  const std::vector<garak::TempoPoint> ramp{{0, 96, true}, {8, 150, false}, {20, 70, false}};
  const std::vector<garak::MeterEvent> changes{{0, 4, 4, 0}, {2, 7, 8, 0}, {5, 6, 8, 0}, {7, 3, 4, 0}};
  const std::vector<garak::MeterEvent> changes12{{0, 12, 8, 0}, {1, 5, 4, 0}, {3, 9, 16, 0}};
  const MetronomeCase cases[] = {
      {"4/4, 120 bpm", 120, 4, 4, {}, {}, 0, 0, 128},
      {"6/8 compound, tempo ramp", 110, 6, 8, ramp, {}, 0, 0, 1000},
      {"meter map 4/4-7/8-6/8-3/4 + tempo map", 96, 4, 4, ramp, changes, 0, 0, 128},
      {"meter map 12/8-5/4-9/16 from mid-song", 132, 12, 8, {}, changes12, 123457, 0, 333},
      {"count-in at a mapped position", 96, 4, 4, ramp, changes, 200000, 96000, 256},
      {"count-in, constant 3/4", 140, 3, 4, {}, {}, 0, 41143, 128},
  };
  for (const auto& c : cases) {
    const std::uint32_t total = 48000 * 12;
    const auto a = clicksCpp(c, set, total), b = clicksRust(c, set, total);
    const double d = residual(a, b);
    std::printf("| metronome: %s | — | 12 s | 48000 Hz | %u | — | %s |\n", c.name, c.block, verdict(d).c_str());
    check(peak(a) > .1, std::string(c.name) + ": no clicks", peak(a));
    check(dbfs(d) <= -90, std::string(c.name) + ": metronome residual", dbfs(d));
  }
}

// ---- Host nodes, routes, monitoring, capture, frozen windows, render-ahead (docs/RUST_ENGINE.md 4, 10) ----
// A stateful stand-in plug-in, so event timing, PDC, parameter points and resets all show in the output. As an
// instrument: a saw per held note (sustain pedal CC64 defers note-offs), level from parameter 3 and CC1. As an
// effect: a one-pole smoother times parameter 7, delayed by `latency` frames.
class StandIn final : public garak::PluginProcessor {
 public:
  StandIn(bool instrument, std::uint32_t latency) : instrument_(instrument), latency_(latency), ring_((latency + 1) * 2) {}
  void process(float* stereo, std::uint32_t frames, std::span<const garak::PluginEvent> events, const garak::ProcessContext& context) noexcept override {
    if (reset_) { reset_ = false; notes_.fill({}); pedal_ = false; smooth_ = {0, 0}; }
    std::size_t next = 0;
    for (std::uint32_t i = 0; i < frames; ++i) {
      for (; next < events.size() && events[next].offset <= i; ++next) apply(events[next]);
      for (int c = 0; c < 2; ++c) {
        float x = 0;
        if (instrument_) {
          for (auto& n : notes_) if (n.on || n.held) { x += static_cast<float>(n.velocity * (n.phase * 2 - 1)) * level_; }
        } else {
          smooth_[c] += (stereo[2 * i + c] - smooth_[c]) * .3f;
          x = smooth_[c] * gain_;
        }
        if (latency_) { const auto at = (write_ + 1) % (latency_ + 1); const float y = ring_[at * 2 + c]; ring_[write_ * 2 + c] = x; x = y; }
        stereo[2 * i + c] = x;
      }
      if (latency_) write_ = (write_ + 1) % (latency_ + 1);
      if (instrument_) for (auto& n : notes_) if (n.on || n.held) { n.phase += n.step * (1 + context.bpm / 1e4); n.phase -= std::floor(n.phase); }
    }
  }
  [[nodiscard]] std::uint32_t latencyFrames() const noexcept override { return latency_; }
  [[nodiscard]] double tailSeconds() const noexcept override { return instrument_ ? 0 : .01; }
  void requestReset() noexcept override { reset_ = true; }

 private:
  struct Note { bool on = false, held = false; int pitch = 0; double velocity = 0, phase = 0, step = 0; std::int32_t id = -1; };
  void apply(const garak::PluginEvent& e) noexcept {
    using T = garak::PluginEvent::Type;
    if (e.type == T::Parameter) { if (e.parameterId == 3) level_ = .05f + e.value * .2f; if (e.parameterId == 7) gain_ = .2f + e.value; return; }
    if (e.type == T::Controller) {
      if (e.parameterId == 64) { pedal_ = e.value >= .5f; if (!pedal_) for (auto& n : notes_) n.held = false; }
      if (e.parameterId == 1) level_ = .1f + e.value * .1f;
      return;
    }
    if (e.type == T::AllNotesOff) { for (auto& n : notes_) n = {}; return; }
    if (e.type == T::NoteOn) {
      for (auto& n : notes_) if (!n.on && !n.held) { n = {true, false, e.pitch, e.value, 0, 110.0 * std::pow(2.0, (e.pitch - 45) / 12.0) / 48000, e.noteId}; return; }
      return;
    }
    for (auto& n : notes_) if (n.on && (e.noteId >= 0 ? n.id == e.noteId : n.pitch == e.pitch)) { n.on = false; n.held = pedal_; }
  }
  bool instrument_; std::uint32_t latency_, write_ = 0; std::vector<float> ring_;
  std::array<Note, 16> notes_{}; bool pedal_ = false, reset_ = false; float level_ = .1f, gain_ = 1;
  std::array<float, 2> smooth_{};
};
// One resolver per engine: instances are cached by id (a re-prepared graph keeps them, like the desktop host).
garak::PluginResolver standIns() {
  auto cache = std::make_shared<std::map<std::string, std::shared_ptr<garak::PluginProcessor>>>();
  return [cache](const garak::PluginSpec& spec, double, std::uint32_t) -> std::shared_ptr<garak::PluginProcessor> {
    auto& slot = (*cache)[spec.instanceId];
    if (!slot) slot = std::make_shared<StandIn>(spec.isInstrument, spec.instanceId == "fxA" ? 11u : spec.instanceId == "fxB" ? 5u : spec.instanceId == "fxR" ? 7u : 0u);
    return slot;
  };
}
std::shared_ptr<const garak::PcmAsset> tone(const char* id, std::uint32_t channels, double frequency, std::uint32_t frames) {
  auto a = std::make_shared<garak::PcmAsset>(); a->id = id; a->sampleRate = 48000; a->channels = channels;
  a->samples.resize(std::size_t(frames) * channels);
  for (std::uint32_t i = 0; i < frames; ++i) for (std::uint32_t c = 0; c < channels; ++c) a->samples[std::size_t(i) * channels + c] = float(.3 * std::sin(frequency * (i + 1) * (c + 1) / 48000.0 * 6.283185307179586));
  return a;
}
garak::AutomationLane lane(garak::AutomationLane::Target target, const char* insert, const char* param, std::vector<garak::AutomationPoint> points) {
  garak::AutomationLane l; l.target = target; l.insertId = insert; l.param = param; l.points = std::move(points); return l;
}
// VST3 instrument (notes, sustain pedal, mod wheel, instrument-parameter automation) into a latent VST3 insert with
// automation and a built-in EQ; an audio track through another VST3 insert; a return with a latent VST3 insert; a
// post-fader route of the instrument, a master resampler and a monitored mono input track.
struct HostProject { garak::ProjectTimeline timeline; garak::AssetStore assets; };
HostProject hostProject() {
  HostProject h;
  auto& p = h.timeline; p.projectId = "host-nodes"; p.sampleRate = 48000; p.lengthFrames = 96000; p.bpm = 100;
  h.assets["tone"] = tone("tone", 2, 220, 96000); h.assets["mono"] = tone("mono", 1, 330, 96000);
  garak::TrackTimeline inst; inst.id = "inst"; inst.gain = .8f; inst.pan = -.2f;
  inst.source.kind = garak::TrackSource::Kind::Vst3; inst.source.plugin.instanceId = "synth"; inst.source.plugin.isInstrument = true;
  inst.notes = {{1, 100, 9000, 96000, 57, .8f}, {2, 4000, 30000, 96000, 64, .6f}, {3, 31000, 33000, 96000, 60, .9f}, {4, 50000, 90000, 96000, 52, .7f}};
  inst.controls = {{20000, 64, 127}, {32000, 1, 90}, {36000, 64, 0}, {60000, 1, 10}};
  inst.automation = {lane(garak::AutomationLane::Target::Instrument, "", "3", {{0, .2, 0}, {48000, .9, .4}, {90000, .1, 0}}),
                     lane(garak::AutomationLane::Target::Insert, "fxA", "7", {{0, .5, 0}, {30000, 1, -.5}, {70000, .2, 0}})};
  garak::BuiltinInsert eq; eq.id = "eq"; eq.type = "eq"; eq.params = {{"mid", -3}};
  garak::BuiltinInsert fxA; fxA.id = "fxA"; fxA.type = "vst3"; fxA.plugin.instanceId = "fxA";
  inst.inserts = {fxA, eq}; inst.sends = {{"ret", .3f, false}};
  garak::TrackTimeline audio; audio.id = "audio"; audio.gain = .6f; audio.pan = .3f;
  audio.audio = {{1, "tone", 2000, 80000, 0, 48000, 0, 78000, .9f, 400, 600}};
  garak::BuiltinInsert fxB; fxB.id = "fxB"; fxB.type = "vst3"; fxB.plugin.instanceId = "fxB"; audio.inserts = {fxB};
  audio.sends = {{"ret", .5f, true}};
  garak::TrackTimeline ret; ret.id = "ret"; ret.isReturn = true; ret.gain = .7f;
  garak::BuiltinInsert fxR; fxR.id = "fxR"; fxR.type = "vst3"; fxR.plugin.instanceId = "fxR";
  garak::BuiltinInsert echo; echo.id = "echo"; echo.type = "delay"; echo.params = {{"amount", .6}, {"time", .25}, {"feedback", .3}};
  ret.inserts = {fxR, echo};
  garak::TrackTimeline rec; rec.id = "rec"; garak::TrackRoute fromInst; fromInst.kind = garak::TrackRoute::Kind::Track; fromInst.trackId = "inst"; fromInst.tap = garak::TrackRoute::Tap::PostFader; rec.route = fromInst; rec.gain = .5f;
  garak::TrackTimeline resample; resample.id = "resample"; garak::TrackRoute master; master.kind = garak::TrackRoute::Kind::Master; resample.route = master; resample.audible = false;
  garak::TrackTimeline mono; mono.id = "mono"; mono.input = garak::TrackInput{{1, -1}}; mono.audio = {{1, "mono", 10000, 60000, 0, 48000, 0, 50000, 1, 0, 0}};
  // Plain audio tracks (no sends, routes or plug-ins): the ones render-ahead takes.
  garak::TrackTimeline plain = audio; plain.id = "plain"; plain.sends.clear(); plain.pan = -.5f;
  garak::BuiltinInsert comp; comp.id = "comp"; comp.type = "compressor"; plain.inserts = {comp};
  garak::TrackTimeline roomy = mono; roomy.id = "roomy"; roomy.input.reset(); roomy.gain = .4f;
  garak::BuiltinInsert verb; verb.id = "verb"; verb.type = "reverb"; roomy.inserts = {verb};
  p.tracks = {rec, inst, audio, ret, resample, mono, plain, roomy};
  return h;
}
struct HostRun { std::vector<float> out, takes; bool rust = false; std::uint32_t ahead = 0; };
// `transportOnly`: play, a seek and cycle wraps only. Live commands on a track that renders ahead wait until its ring
// drains, and a pause keeps a ring's tail only when the workers had not got ahead yet: both depend on worker timing
// (in the C++ engine alike), so render-ahead runs compare without them.
HostRun hostLive(const HostProject& h, int mode, std::uint32_t threads, garak::RenderAhead renderAhead = garak::RenderAhead::Off, bool transportOnly = false) {
  garak::RenderEngine e(48000, 128, 48000); e.setRustEngine(mode);
  if (threads || renderAhead != garak::RenderAhead::Off) { garak::ProcessingOptions o; o.threads = threads; o.renderAhead = renderAhead; o.deviceBlockFrames = 256; e.setProcessing(o); }
  const auto plugins = standIns();
  auto start = h.timeline; if (transportOnly) start.cycle = std::array<std::int64_t, 2>{30000, 70000};
  (void)e.update(start, h.assets, {}, plugins);
  HostRun r; std::vector<float> in(512), out(512), drained(48000 * 6);
  auto cycled = h.timeline; cycled.revision = 2; cycled.cycle = std::array<std::int64_t, 2>{30000, 70000};
  auto edited = cycled; edited.revision = 3; edited.tracks[1].gain = .5f; edited.tracks[2].inserts[0].plugin.parameters[7] = .4;
  for (std::uint32_t k = 0; k < 520; ++k) {
    if (transportOnly) switch (k) {
      case 0: (void)e.play(); break;
      case 100: (void)e.seek(20000); break;
      default: break;
    } else switch (k) {
      case 0: (void)e.play(); break;
      case 10: { const std::array<std::uint32_t, 3> takes{0, 4, 5}; (void)e.startRecording(e.planRecording(takes)); break; }
      case 40: { const std::array<std::uint32_t, 2> monitored{0, 5}; (void)e.setMonitoring(monitored); break; }
      case 60: (void)e.noteOn(1, 69, .9f, 900); break;
      case 70: (void)e.controlChange(1, 64, 127); break;
      case 80: (void)e.noteOff(1, 69, 900); break;
      case 95: (void)e.controlChange(1, 64, 0); break;
      case 100: (void)e.seek(20000); break;
      case 140: (void)e.update(cycled, h.assets, {}, plugins); break;
      case 170: (void)e.pause(); break;
      case 175: (void)e.play(); break;
      case 200: (void)e.update(edited, h.assets, {}, plugins); break;
      case 260: (void)e.setMonitoring({}); break;
      case 300: (void)e.stopRecording(); break;
      default: break;
    }
    for (std::size_t i = 0; i < 256; ++i) { in[2 * i] = float(.2 * std::sin((k * 256 + i) * .031)); in[2 * i + 1] = float(.1 * std::cos((k * 256 + i) * .017)); }
    e.render(out.data(), in.data(), 256, 2);
    r.out.insert(r.out.end(), out.begin(), out.end());
    const auto s = e.snapshot(); r.rust = r.rust || s.rustEngine; r.ahead = std::max(r.ahead, s.renderAheadTracks);
    const auto got = e.drainRecording(drained.data(), 48000);
    r.takes.insert(r.takes.end(), drained.begin(), drained.begin() + std::ptrdiff_t(got) * e.recordingChannels());
    if (k % 16 == 0) e.collectRetired();
  }
  return r;
}
std::vector<float> hostOffline(const garak::ProjectTimeline& timeline, const garak::AssetStore& assets, int mode, std::uint32_t block) {
  garak::RenderEngine e(48000, block); e.setRustEngine(mode); e.setOffline(true);
  auto prepared = e.prepare(timeline, assets, {}, standIns());
  const auto latency = prepared->latencyFrames();
  const auto frames = std::uint64_t(timeline.lengthFrames) + std::uint64_t(std::ceil(std::min(30.0, prepared->tailSeconds()) * 48000)) + latency;
  e.submit(std::move(prepared)); (void)e.play();
  std::vector<float> out(frames * 2);
  for (std::uint64_t done = 0; done < frames; done += block) e.render(out.data() + done * 2, nullptr, std::uint32_t(std::min<std::uint64_t>(block, frames - done)), 0);
  return out;
}
void hostNodeCases() {
  const auto h = hostProject();
  const auto cpp = hostLive(h, 0, 0), rust = hostLive(h, 2, 0);
  const double d = residual(cpp.out, rust.out), t = residual(cpp.takes, rust.takes);
  std::printf("| host nodes: VST3 instrument/inserts/return, routes, monitoring, live MIDI, seek, cycle, edits | 7+1 | 2 s | 48000 Hz | 128 (256 calls) | — | %s (takes %s) |\n", verdict(d).c_str(), verdict(t).c_str());
  check(rust.rust && !cpp.rust && peak(cpp.out) > .05 && peak(cpp.takes) > .01, "host nodes: rendered through Rust", peak(cpp.out));
  check(cpp.takes.size() == rust.takes.size() && !cpp.takes.empty(), "host nodes: capture lengths", double(rust.takes.size()));
  check(dbfs(d) <= -90, "host nodes: output differs from the C++ engine", dbfs(d));
  check(dbfs(t) <= -90, "host nodes: routed/physical takes differ from the C++ engine", dbfs(t));
  const auto workers = std::max(2u, std::min(4u, std::thread::hardware_concurrency()));
  const auto parallel = hostLive(h, 2, workers);
  const double m = std::max(residual(rust.out, parallel.out), residual(rust.takes, parallel.takes));
  std::printf("| host nodes: Rust shell, 0 vs %u workers | 7+1 | 2 s | 48000 Hz | 128 (256 calls) | — | %s |\n", workers, verdict(m).c_str());
  check(m == 0, "host nodes: worker threads changed the Rust mix", dbfs(m));
  auto offlinePlan = h.timeline;
  const auto a = hostOffline(offlinePlan, h.assets, 0, 256), b = hostOffline(offlinePlan, h.assets, 2, 256);
  const double o = residual(a, b);
  std::printf("| host nodes: offline export | 7+1 | 2 s | 48000 Hz | 256 | — | %s |\n", verdict(o).c_str());
  check(dbfs(o) <= -90 && peak(a) > .05, "host nodes: offline export differs from the C++ engine", dbfs(o));
  // Frozen windows (docs/BOUNCE_FREEZE_STEMS.md): no click guard, the window runs past the project end and its
  // tail sets the export length; a delay after it keeps ringing.
  garak::ProjectTimeline frozen; frozen.projectId = "frozen"; frozen.sampleRate = 48000; frozen.lengthFrames = 48000;
  garak::AssetStore frozenAssets{{"render", tone("render", 2, 180, 60000)}};
  garak::TrackTimeline f; f.id = "frozen"; f.gain = .7f; f.pan = .4f;
  garak::AudioWindow w; w.id = 1; w.assetId = "render"; w.startFrame = 0; w.endFrame = 60000; w.clipLengthFrames = 60000; w.freeze = true; w.tailSeconds = .4; f.audio = {w};
  garak::BuiltinInsert delay; delay.id = "d"; delay.type = "delay"; delay.params = {{"amount", .5}, {"time", .2}, {"feedback", .4}}; f.inserts = {delay};
  frozen.tracks = {f};
  const auto x = hostOffline(frozen, frozenAssets, 0, 512), y = hostOffline(frozen, frozenAssets, 2, 512);
  double after = 0; for (std::size_t i = 48000 * 2; i < x.size(); ++i) after = std::max(after, double(std::abs(x[i])));
  const double z = residual(x, y);
  std::printf("| frozen window with tail (offline) | 1 | 1 s + tail | 48000 Hz | 512 | — | %s |\n", verdict(z).c_str());
  check(dbfs(z) <= -90 && after > .01, "frozen window: differs from the C++ engine or lost its tail", dbfs(z));
  // Render-ahead (Normal and High, 2 workers): the Rust shell keeps eligible tracks in the shell's rings, the same
  // tracks at the same blocks as the C++ engine. The return's plug-in delay is taken out: the dry tracks'
  // return-alignment delay is not cleared by a seek (C++ TrackRuntime::reset), so after one its first frames depend
  // on how far a ring had rendered.
  auto aheadProject = h; aheadProject.timeline.tracks[3].inserts.erase(aheadProject.timeline.tracks[3].inserts.begin());
  for (const auto mode : {garak::RenderAhead::Normal, garak::RenderAhead::High}) {
    const auto aheadCpp = hostLive(aheadProject, 0, 2, mode, true), aheadRust = hostLive(aheadProject, 2, 2, mode, true);
    const auto plain = hostLive(aheadProject, 2, 0, garak::RenderAhead::Off, true);
    const double r = std::max(residual(aheadCpp.out, aheadRust.out), residual(plain.out, aheadRust.out));
    std::printf("| render-ahead (%s, 2 workers): C++ vs Rust shell vs callback rendering, seek and cycle wraps | 7+1 | 2 s | 48000 Hz | 128 (256 calls) | - | %s (ahead tracks %u / %u) |\n",
                mode == garak::RenderAhead::High ? "High" : "Normal", verdict(r).c_str(), aheadCpp.ahead, aheadRust.ahead);
    check(aheadRust.ahead >= 2 && aheadRust.rust && aheadRust.ahead == aheadCpp.ahead, "render-ahead: the Rust shell rendered fewer tracks ahead", aheadRust.ahead);
    check(dbfs(residual(aheadCpp.out, aheadRust.out)) <= -90, "render-ahead: output differs from the C++ engine", dbfs(r));
    check(residual(plain.out, aheadRust.out) == 0, "render-ahead: Rust shell output differs from callback rendering", dbfs(r));
  }
}

void bench() {
  using Clock = std::chrono::steady_clock;
  const auto workers = std::max(2u, std::min(8u, std::thread::hardware_concurrency() > 1 ? std::thread::hardware_concurrency() - 1 : 1u));
  std::printf("\n| Tracks (+2 returns) | C++ engine | Rust shell, 1 thread | Rust shell, %u workers | Speed-up (workers vs 1 thread) |\n|---|---|---|---|---|\n", workers);
  for (const std::uint32_t tracks : {16u, 32u}) {
    const auto project = testProject(tracks, 10, 48000);
    const auto timeline = parse(project.json);
    const auto measure = [&](int mode, std::uint32_t threads) {
      double best = 1e9;
      for (int round = 0; round < 2; ++round) {
        garak::RenderEngine engine(48000, 128); engine.setRustEngine(mode);
        if (threads) { garak::ProcessingOptions options; options.threads = threads; engine.setProcessing(options); }
        (void)engine.update(timeline, project.assets); (void)engine.play();
        std::vector<float> out(256);
        const auto start = Clock::now();
        for (std::uint32_t k = 0; k < 48000 * 10 / 128; ++k) engine.render(out.data(), nullptr, 128, 0);
        best = std::min(best, std::chrono::duration<double>(Clock::now() - start).count());
      }
      return 10.0 / best; // x real time
    };
    const double cpp = measure(0, 0), one = measure(2, 0), many = measure(2, workers);
    std::printf("| %u | %.1fx | %.1fx | %.1fx | %.2fx |\n", tracks, cpp, one, many, many / one);
  }
}
// Sample-accurate device MIDI (docs/RUST_ENGINE.md 5.8): queueLiveMidi offsets on a VST3 instrument (a stand-in
// plug-in) and a built-in synth. The C++ engine splits its blocks at each event; the Rust shell passes the offsets
// through (garak_rs_engine_live_at: the built-in voices split their own render, the VST3 node gets sampleOffset), so
// both start every event on the same sample.
void liveOffsetCases() {
  garak::ProjectTimeline p; p.projectId = "live-offsets"; p.sampleRate = 48000; p.lengthFrames = 96000; p.bpm = 120;
  garak::TrackTimeline vst; vst.id = "vst"; vst.gain = .8f;
  vst.source.kind = garak::TrackSource::Kind::Vst3; vst.source.plugin.instanceId = "synth"; vst.source.plugin.isInstrument = true;
  garak::TrackTimeline keys; keys.id = "keys"; keys.gain = .7f; keys.source.kind = garak::TrackSource::Kind::BuiltinSynth; keys.source.instrumentId = "keys";
  p.tracks = {vst, keys};
  const auto run = [&](int mode, std::vector<std::size_t>& onsets) {
    garak::RenderEngine e(48000, 128, 48000); e.setRustEngine(mode);
    (void)e.update(p, {}, {}, standIns());
    std::vector<float> all, out(512);
    for (std::uint32_t k = 0; k < 120; ++k) {
      if (k == 0) (void)e.play();
      if (k == 3) { const std::array<garak::LiveMidiEvent, 1> on{garak::LiveMidiEvent{37, 0, 0x90, 60, 100, 11}}; (void)e.queueLiveMidi(on); }
      if (k == 4) { const std::array<garak::LiveMidiEvent, 1> off{garak::LiveMidiEvent{10, 0, 0x80, 60, 0, 11}}; (void)e.queueLiveMidi(off); }
      if (k == 5) { const std::array<garak::LiveMidiEvent, 1> on{garak::LiveMidiEvent{201, 1, 0x90, 64, 100, 12}}; (void)e.queueLiveMidi(on); }
      if (k == 9) {
        const std::array<garak::LiveMidiEvent, 10> more{garak::LiveMidiEvent{3, 0, 0x90, 67, 90, 13}, garak::LiveMidiEvent{5, 0, 0xE0, 0, 80, -1},
          garak::LiveMidiEvent{60, 1, 0xD0, 100, 0, -1}, garak::LiveMidiEvent{70, 1, 0xE0, 0, 100, -1}, garak::LiveMidiEvent{80, 0, 0xD0, 50, 0, -1},
          garak::LiveMidiEvent{90, 1, 0xB0, 64, 127, -1}, garak::LiveMidiEvent{100, 0, 0xB0, 64, 127, -1}, garak::LiveMidiEvent{130, 0, 0x80, 67, 0, 13},
          garak::LiveMidiEvent{131, 1, 0x80, 64, 0, 12}, garak::LiveMidiEvent{250, 1, 0xB0, 64, 0, -1}};
        (void)e.queueLiveMidi(more);
      }
      if (k == 11) { const std::array<garak::LiveMidiEvent, 1> up{garak::LiveMidiEvent{77, 0, 0xB0, 64, 0, -1}}; (void)e.queueLiveMidi(up); }
      e.render(out.data(), nullptr, 256, 0);
      if (k == 3 || k == 5) {
        std::size_t first = 256; for (std::size_t i = 0; i < 512; ++i) if (out[i] != 0) { first = i / 2; break; }
        onsets.push_back(first);
      }
      all.insert(all.end(), out.begin(), out.end());
      if (k % 16 == 0) e.collectRetired();
    }
    return all;
  };
  std::vector<std::size_t> cppOnsets, rustOnsets;
  const auto cpp = run(0, cppOnsets), rust = run(2, rustOnsets);
  const double d = residual(cpp, rust);
  std::printf("| live MIDI at sample offsets: VST3 instrument + built-in synth | 2 | 0.6 s | 48000 Hz | 128 (256 calls) | — | %s |\n", verdict(d).c_str());
  check(peak(cpp) > .05, "live offsets: silent", peak(cpp));
  check(dbfs(d) <= -90, "live offsets: Rust shell differs from the C++ engine's split blocks", dbfs(d));
  // The stand-in sounds on its note-on sample; the built-in envelope starts from zero there (first sound one later).
  check(cppOnsets.size() == 2 && cppOnsets == rustOnsets && cppOnsets[0] == 37 && cppOnsets[1] == 202,
        "live offsets: onset sample", rustOnsets.empty() ? -1.0 : double(rustOnsets[0]));
}
} // namespace

int main(int argc, char** argv) {
  pinCppReferenceEngine();
  std::printf("| Case | Tracks | Length | Rate | Block | Latency C++ / Rust | Residual |\n|---|---|---|---|---|---|---|\n");
  try {
    offlineCases();
    liveCases();
    fallbackCases();
    hostNodeCases();
    liveOffsetCases();
    metronomeCases();
    if (argc > 1 && std::string(argv[1]) == "--bench") bench();
  } catch (const std::exception& error) {
    check(false, std::string("exception: ") + error.what());
  }
  if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
  std::printf("\nRust engine host path: all cases passed.\n");
  return 0;
}

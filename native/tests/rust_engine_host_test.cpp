// GARAK_RUST_ENGINE host path (docs/RUST_ENGINE.md 10): RenderEngine as the shell around the Rust graph.
//
// The project is rust/garak-engine/src/testkit.rs (audio clips, fades, every built-in effect but the guitar
// rig, pre/post sends into returns, automation, a tempo ramp). Cases:
//   1. offline export (host renderStopped loop): the C++ engine vs the same RenderEngine with setRustEngine(2);
//   2. live playback with mid-play diffs (mix, send, live insert parameter, master, a track rebuild), a seek and
//      a cycle: C++ vs Rust shell, through RenderEngine::update (the Rust graph's commands are gated by ticket);
//   3. multi-core: the Rust shell with 0 and N worker threads must be bit-identical;
//   4. fallback: a project the Rust engine refuses (guitar rig insert) renders in C++ in mode 1 (counted in
//      EngineSnapshot::rustRefusals) and throws in strict mode;
//   5. metronome: the garak-engine port vs native/src/metronome.hpp (grids, compound meters, tempo and meter
//      maps, count-in), driven the way RenderEngine::renderClicks drives it;
//   6. CPU: blocks per second of the C++ engine, the Rust shell and the Rust shell on N workers (table).
// Gate: residual <= -90 dBFS (bit-identical expected), equal latency; the multi-core output bit-identical.
#include "garak/dsp.hpp"
#include "garak/engine.hpp"
#include "garak_engine.h"
#include "protocol.hpp"
#include "metronome.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <functional>
#include <memory>
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

void fallbackCases() {
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
} // namespace

int main(int argc, char** argv) {
  std::printf("| Case | Tracks | Length | Rate | Block | Latency C++ / Rust | Residual |\n|---|---|---|---|---|---|---|\n");
  try {
    offlineCases();
    liveCases();
    fallbackCases();
    metronomeCases();
    if (argc > 1 && std::string(argv[1]) == "--bench") bench();
  } catch (const std::exception& error) {
    check(false, std::string("exception: ") + error.what());
  }
  if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
  std::printf("\nRust engine host path: all cases passed.\n");
  return 0;
}

// CPU comparison of the two render engines (docs/RUST_ENGINE.md 7.3): the parity project
// (rust/garak-engine/src/testkit.rs) at 16 and 32 tracks through the C++ RenderEngine (with its
// C++ effects, and with the Rust effects) and through the Rust engine, single-threaded, offline
// (no render-ahead / worker threads), in device-sized blocks. Rounds alternate engines; the best
// of `rounds` counts. Prints a Markdown table: realtime factor (audio seconds per CPU second) and
// microseconds per 128-frame block. Usage: garak-rust-engine-bench [seconds] [rounds] [block].
#include "garak/dsp.hpp"
#include "garak/engine.hpp"
#include "garak_engine.h"
#include "protocol.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>
#include <vector>

namespace {
struct Project { std::string json; garak::AssetStore assets; std::vector<std::string> ids; };

Project testProject(std::uint32_t tracks, double seconds, std::uint32_t rate) {
  Project p;
  auto* t = garak_rs_testkit_create(tracks, seconds, rate);
  std::size_t length = 0;
  const auto* json = garak_rs_testkit_json(t, &length);
  p.json.assign(reinterpret_cast<const char*>(json), length);
  for (std::uint32_t i = 0; i < garak_rs_testkit_asset_count(t); ++i) {
    const std::uint8_t* id = nullptr; std::size_t idLength = 0, count = 0; std::uint32_t sr = 0, channels = 0; const float* samples = nullptr;
    garak_rs_testkit_asset(t, i, &id, &idLength, &sr, &channels, &samples, &count);
    auto asset = std::make_shared<garak::PcmAsset>();
    asset->id.assign(reinterpret_cast<const char*>(id), idLength);
    asset->sampleRate = sr; asset->channels = channels; asset->samples.assign(samples, samples + count);
    p.ids.push_back(asset->id);
    p.assets.emplace(asset->id, std::move(asset));
  }
  garak_rs_testkit_destroy(t);
  return p;
}

using Clock = std::chrono::steady_clock;
volatile float sink = 0;

// Seconds of CPU (wall, single thread) to render `frames` of the project in `block` calls.
double timeCpp(const Project& p, std::uint32_t rate, std::uint32_t block, std::uint64_t frames) {
  auto timeline = garak::protocol::timeline(garak::protocol::Json::parse(p.json));
  garak::RenderEngine engine(rate, block); engine.setOffline(true);
  engine.submit(engine.prepare(timeline, p.assets)); (void)engine.play();
  std::vector<float> out(std::size_t(block) * 2);
  const auto start = Clock::now();
  for (std::uint64_t done = 0; done < frames; done += block) { engine.render(out.data(), nullptr, block, 0); sink = sink + out[0]; }
  return std::chrono::duration<double>(Clock::now() - start).count();
}

double timeRust(const Project& p, std::uint32_t rate, std::uint32_t block, std::uint64_t frames) {
  auto* e = garak_rs_engine_create(rate, block, 1);
  for (const auto& id : p.ids) {
    const auto& a = *p.assets.at(id);
    garak_rs_engine_put_asset(e, reinterpret_cast<const std::uint8_t*>(id.data()), id.size(), a.sampleRate, a.channels, a.samples.data(), a.samples.size());
  }
  if (garak_rs_engine_set(e, reinterpret_cast<const std::uint8_t*>(p.json.data()), p.json.size(), nullptr, 0) < 0) { std::fprintf(stderr, "rust engine refused the project\n"); std::exit(1); }
  garak_rs_engine_transport(e, GARAK_RS_PLAY, 0);
  std::vector<float> out(std::size_t(block) * 2);
  const auto start = Clock::now();
  for (std::uint64_t done = 0; done < frames; done += block) { garak_rs_engine_render(e, out.data(), block); sink = sink + out[0]; }
  const double seconds = std::chrono::duration<double>(Clock::now() - start).count();
  garak_rs_engine_destroy(e);
  return seconds;
}
} // namespace

int main(int argc, char** argv) {
  const double seconds = argc > 1 ? std::atof(argv[1]) : 10;
  const int rounds = argc > 2 ? std::atoi(argv[2]) : 3;
  const std::uint32_t block = argc > 3 ? std::uint32_t(std::atoi(argv[3])) : 128;
  constexpr std::uint32_t rate = 48000;
  std::printf("Single thread, %u-frame blocks, %.0f s of audio per round, best of %d.\n\n", block, seconds, rounds);
  std::printf("| Tracks (+2 returns) | C++ engine, C++ effects | C++ engine, Rust effects | Rust engine | Rust engine vs C++/C++ | µs per block (C++ / Rust) |\n");
  std::printf("|---|---|---|---|---|---|\n");
  for (const std::uint32_t tracks : {16u, 32u}) {
    const auto project = testProject(tracks, seconds, rate);
    const auto frames = std::uint64_t(seconds * rate);
    double cpp = 1e9, mixed = 1e9, rust = 1e9;
    for (int r = 0; r < rounds; ++r) {
      garak::dsp::setEffectBackend("all", garak::dsp::EffectBackend::Cpp);
      cpp = std::min(cpp, timeCpp(project, rate, block, frames));
      garak::dsp::setEffectBackend("all", garak::dsp::EffectBackend::Rust);
      mixed = std::min(mixed, timeCpp(project, rate, block, frames));
      rust = std::min(rust, timeRust(project, rate, block, frames));
    }
    const double blocks = double(frames) / block;
    std::printf("| %u | %.1fx realtime | %.1fx | %.1fx | %.2fx %s | %.1f / %.1f |\n", tracks, seconds / cpp, seconds / mixed, seconds / rust,
                cpp > rust ? cpp / rust : rust / cpp, cpp > rust ? "faster" : "slower", cpp / blocks * 1e6, rust / blocks * 1e6);
  }
  garak::dsp::setEffectBackend("all", garak::dsp::EffectBackend::Cpp);
  return 0;
}

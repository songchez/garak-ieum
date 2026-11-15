// CPU baseline: frames per second of every ported effect, C++ vs Rust, through the same
// StereoProcessor interface (128-frame blocks, 48 kHz, a busy parameter set). Not a test: prints a
// Markdown table for docs/RUST.md and CI logs. Usage: garak-rust-bench [seconds] [effect ...]
// Each backend gets `seconds` of audio in total, split into rounds that alternate C++ and Rust; the
// best round counts. Alternating cancels clock ramps and noisy neighbours on shared CI runners.
#include "garak/dsp.hpp"
#include "garak/engine.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace {
using garak::dsp::EffectBackend;

struct Case { const char* type; garak::Parameters params; };

double run(const Case& c, EffectBackend backend, std::size_t totalFrames, const std::vector<float>& input) {
  auto fx = garak::dsp::makeEffect(c.type, c.params, 48000, 120, backend);
  constexpr std::uint32_t block = 128;
  std::vector<float> buffer(block * 2);
  const std::size_t inputFrames = input.size() / 2;
  // Warm-up (caches, branch predictors, the first FFT partitions of the reverb).
  for (std::size_t done = 0; done < 48000; done += block) {
    std::copy_n(input.begin() + static_cast<std::ptrdiff_t>((done % inputFrames) * 2), block * 2, buffer.begin());
    fx->process(buffer.data(), block);
  }
  double sink = 0;
  const auto start = std::chrono::steady_clock::now();
  for (std::size_t done = 0; done < totalFrames; done += block) {
    std::copy_n(input.begin() + static_cast<std::ptrdiff_t>((done % inputFrames) * 2), block * 2, buffer.begin());
    fx->process(buffer.data(), block);
    sink += buffer[0];
  }
  const double seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
  if (!std::isfinite(sink)) std::fputs("", stderr);
  return static_cast<double>(totalFrames) / std::max(seconds, 1e-9);
}
} // namespace

int main(int argc, char** argv) {
  const double seconds = argc > 1 ? std::max(0.5, std::atof(argv[1])) : 10.0;
  constexpr int rounds = 5;
  const auto totalFrames = static_cast<std::size_t>(48000 * seconds / rounds);
  std::vector<std::string> only(argv + std::min(argc, 2), argv + argc);
  std::vector<float> input(48000 * 2);
  std::uint32_t seed = 1;
  for (auto& x : input) { seed = seed * 1664525u + 1013904223u; x = static_cast<float>((seed / 4294967296.0 * 2 - 1) * 0.5); }
  const std::vector<Case> cases = {
    {"chorus", {}}, {"flanger", {}}, {"phaser", {}}, {"tremolo", {{"shape", .5}, {"pan", 1}}},
    {"limiter", {{"gain", 12}}}, {"gate", {{"threshold", -20}}}, {"tape", {}}, {"bitcrusher", {}}, {"utility", {{"width", 1.4}, {"pan", .3}}},
    {"delay", {{"age", .5}, {"lowcut", 200}, {"mode", 1}}},
    {"eq", {{"b4On", 1}, {"b5On", 1}, {"b6On", 1}, {"b7On", 1}, {"b8On", 1}, {"b8Slope", 3}}},
    {"filter", {{"slope", 2}}}, {"compressor", {}}, {"drive", {}}, {"reverb", {{"amount", .5}, {"lowcut", 120}}},
  };
  std::printf("%.1f s of 48 kHz stereo per backend (best of %d alternating rounds), 128-frame blocks.\n\n", seconds, rounds);
  std::printf("| effect | C++ (Mframes/s) | Rust (Mframes/s) | Rust / C++ | C++ x realtime |\n|---|---:|---:|---:|---:|\n");
  for (const auto& c : cases) {
    if (!only.empty() && std::find(only.begin(), only.end(), c.type) == only.end()) continue;
    double cpp = 0, rust = 0;
    for (int round = 0; round < rounds; ++round) {
      cpp = std::max(cpp, run(c, EffectBackend::Cpp, totalFrames, input));
      rust = std::max(rust, run(c, EffectBackend::Rust, totalFrames, input));
    }
    std::printf("| %s | %.2f | %.2f | %.2f | %.0f |\n", c.type, cpp / 1e6, rust / 1e6, rust / cpp, cpp / 48000);
  }
  return EXIT_SUCCESS;
}

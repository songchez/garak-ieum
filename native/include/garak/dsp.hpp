#pragma once
#include "garak/engine.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <memory>
#include <string_view>
#include <vector>

namespace garak::dsp {

constexpr double pi = 3.14159265358979323846264338327950288;
inline double dbToGain(double db) noexcept { return std::pow(10.0, db / 20.0); }
// Piano key-release ("damper") noise level, 0 = skip. Same rules as releaseNoiseGain in
// src/audio/samples.ts: follows velocity and the amount, fades with hold time (tau 2 s), and is
// skipped when cut off by a clip/loop/project end, very soft, or after the note rang out.
inline double releaseNoiseGain(double velocity, double heldSeconds, double naturalSeconds, double amount, bool cut) noexcept {
  if (cut || !(amount > 0) || !(velocity > 0.02) || !(heldSeconds < naturalSeconds)) return 0;
  const double gain = std::min(1.0, amount) * std::min(1.0, velocity) * std::exp(-std::max(0.0, heldSeconds) / 2.0);
  return gain >= 0.002 ? gain : 0;
}
enum class Filter { Lowpass, Highpass, Bandpass, Peak, LowShelf, HighShelf, Notch };

class Biquad {
 public:
  // Persisted parameters retain Web Audio's units: low/high-pass Q is in dB;
  // band-pass, notch and peaking Q is linear. Shelf slope is fixed at one.
  // glide: keep the current coefficients and move toward the new ones over ~12 ms (automation, no zipper).
  void configure(Filter type, double rate, double frequency, double q = 1, double gainDb = 0, bool glide = false) noexcept;
  [[nodiscard]] float sample(float input, unsigned channel = 0) noexcept;
  void takeHistoryFrom(const Biquad& previous) noexcept;
  void reset() noexcept { z1_ = {}; z2_ = {}; }
 private:
  double b0_ = 1, b1_ = 0, b2_ = 0, a1_ = 0, a2_ = 0;
  double tb0_ = 1, tb1_ = 0, tb2_ = 0, ta1_ = 0, ta2_ = 0, smoothing_ = 1;
  std::array<double, 2> z1_{}, z2_{};
};

// Dynamics metering for the device views: the audio thread folds each block's detector
// peak and lowest applied gain in; the callback's publish() takes them (and resets).
// Lock-free, allocation-free; a lost race only merges two blocks.
struct DynamicsTap {
  std::atomic<float> peak{0}, gain{1};
  void add(float blockPeak, float lowestGain) noexcept {
    if (blockPeak > peak.load(std::memory_order_relaxed)) peak.store(blockPeak, std::memory_order_relaxed);
    if (lowestGain < gain.load(std::memory_order_relaxed)) gain.store(lowestGain, std::memory_order_relaxed);
  }
  void take(float& blockPeak, float& lowestGain) noexcept {
    blockPeak = peak.exchange(0, std::memory_order_relaxed); lowestGain = gain.exchange(1, std::memory_order_relaxed);
  }
};

// Parameter view used to build effects and to automate them (defined in dsp.cpp).
class Reader;

class StereoProcessor {
 public:
  virtual ~StereoProcessor() = default;
  // Compressor, limiter and gate report their input level and gain reduction here.
  [[nodiscard]] virtual DynamicsTap* dynamics() noexcept { return nullptr; }
  virtual void process(float* stereo, std::uint32_t frames) noexcept = 0;
  virtual void reset() noexcept = 0;
  virtual void takeStateFrom(StereoProcessor& previous) noexcept = 0;
  [[nodiscard]] virtual std::uint32_t latencyFrames() const noexcept { return 0; }
  [[nodiscard]] virtual double tailSeconds() const noexcept { return 0; }
  // Tempo-synced processors (delay, tremolo) follow the tempo at the playhead (docs/TEMPO_MAP.md).
  // Called from the audio thread before each block; must not allocate.
  virtual void setTempo(double /*bpm*/) noexcept {}
  // Automation (docs/AUTOMATION.md): re-read the parameters from `p` in place. Real-time safe: no allocation,
  // buffers keep their size; new targets glide in like the worklet's configure(). Parameters that need a
  // rebuild (reverb size/type/pre-delay, rig reverb decay) keep their prepared value.
  virtual void automate(const Reader&) noexcept {}
};

// Live parameter control of one makeEffect() processor. Created on the control thread with the insert's
// parameters; index() resolves an id once, then set() and apply() are real-time safe.
class EffectControl {
 public:
  EffectControl(std::string_view type, const Parameters& initial);
  ~EffectControl();
  EffectControl(EffectControl&&) noexcept;
  EffectControl& operator=(EffectControl&&) noexcept;
  // -1 when the effect has no such parameter.
  [[nodiscard]] int index(std::string_view id) const noexcept;
  // Clamped to the parameter's range; apply() later pushes every change at once.
  void set(int index, double value) noexcept;
  [[nodiscard]] double get(int index) const noexcept;
  void apply(StereoProcessor& effect) noexcept;
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

// Throws for unsupported processors, unknown keys, invalid ranges or non-finite
// values. Initialization/IR FFT generation runs exclusively on the control thread.
[[nodiscard]] std::unique_ptr<StereoProcessor> makeEffect(std::string_view type,
    const Parameters& params, double sampleRate, double bpm);
[[nodiscard]] std::size_t estimateEffectMemory(std::string_view type, double sampleRate) noexcept;

// Causal, linked-channel compressor/safety ceiling used consistently for playback
// and offline output. It introduces no lookahead delay.
class Master {
 public:
  explicit Master(double sampleRate) noexcept;
  void reset() noexcept { envelope_ = 0; }
  void takeStateFrom(const Master& previous) noexcept { envelope_ = previous.envelope_; }
  void process(float* stereo, std::uint32_t frames) noexcept;
 private:
  double attack_, release_, envelope_ = 0;
};

} // namespace garak::dsp

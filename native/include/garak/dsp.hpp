#pragma once
#include "garak/engine.hpp"
#include <array>
#include <cmath>
#include <cstdint>
#include <memory>
#include <string_view>

namespace garak::dsp {

constexpr double pi = 3.14159265358979323846264338327950288;
inline double dbToGain(double db) noexcept { return std::pow(10.0, db / 20.0); }
enum class Filter { Lowpass, Highpass, Bandpass, Peak, LowShelf, HighShelf };

class Biquad {
 public:
  // Persisted parameters retain Web Audio's units: low/high-pass Q is in dB;
  // band-pass and peaking Q is linear. Shelf slope is fixed at one.
  void configure(Filter type, double rate, double frequency, double q = 1, double gainDb = 0) noexcept;
  [[nodiscard]] float sample(float input, unsigned channel = 0) noexcept;
  void takeHistoryFrom(const Biquad& previous) noexcept;
  void reset() noexcept { z1_ = {}; z2_ = {}; }
 private:
  double b0_ = 1, b1_ = 0, b2_ = 0, a1_ = 0, a2_ = 0;
  double tb0_ = 1, tb1_ = 0, tb2_ = 0, ta1_ = 0, ta2_ = 0, smoothing_ = 1;
  std::array<double, 2> z1_{}, z2_{};
};

class StereoProcessor {
 public:
  virtual ~StereoProcessor() = default;
  virtual void process(float* stereo, std::uint32_t frames) noexcept = 0;
  virtual void reset() noexcept = 0;
  virtual void takeStateFrom(StereoProcessor& previous) noexcept = 0;
  [[nodiscard]] virtual std::uint32_t latencyFrames() const noexcept { return 0; }
  [[nodiscard]] virtual double tailSeconds() const noexcept { return 0; }
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

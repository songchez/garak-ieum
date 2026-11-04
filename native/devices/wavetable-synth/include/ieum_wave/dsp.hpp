#pragma once

#include "math.hpp"
#include <array>
#include <cstdint>
#include <vector>

namespace ieum::wave {
struct Stereo { float left = 0.0f, right = 0.0f; };
struct EnvelopeSettings {
  float attack = 0.005f, hold = 0.0f, decay = 0.3f, sustain = 0.75f, release = 0.25f;
};

class Envelope {
public:
  enum class Stage { Idle, Attack, Hold, Decay, Sustain, Release };
  void prepare(double sampleRate) noexcept {
    sampleRate_ = sampleRate;
    sustainCoefficient_ = static_cast<float>(1.0 - std::exp(-1.0 / (sampleRate * 0.01)));
    reset();
  }
  void reset() noexcept;
  void configure(EnvelopeSettings settings) noexcept { settings_ = settings; }
  void noteOn() noexcept;
  void noteOff() noexcept;
  float next() noexcept;
  float value() const noexcept { return value_; }
  bool active() const noexcept { return stage_ != Stage::Idle; }
  Stage stage() const noexcept { return stage_; }
private:
  void enter(Stage stage) noexcept;
  double sampleRate_ = 48000.0;
  EnvelopeSettings settings_;
  Stage stage_ = Stage::Idle;
  float value_ = 0.0f, target_ = 0.0f, coefficient_ = 0.0f;
  float sustainCoefficient_ = 0.002f;
  std::uint32_t remaining_ = 0;
};

// Two-integrator topology-preserving-transform SVF. Coefficients and output type
// are ramped, with independent channel state. No oscillator, delay buffer, or FFT.
class StereoFilter {
public:
  void prepare(double sampleRate) noexcept;
  void reset() noexcept;
  void configure(float cutoff, float resonance, float type, float mix, std::uint32_t ramp) noexcept;
  Stereo process(Stereo input) noexcept;
private:
  double sampleRate_ = 48000.0;
  std::array<double, 2> ic1_ {}, ic2_ {};
  LinearSmoother g_, k_, type_, mix_;
};

// Entire FX state is allocated at prepare(), never by process().
class Effects {
public:
  void prepare(double sampleRate);
  void reset() noexcept;
  Stereo process(Stereo input, float drive, float driveMix, float chorusRate,
                 float chorusDepth, float chorusMix, float delaySeconds,
                 float feedback, float delayMix) noexcept;
private:
  float read(const std::vector<float>& data, std::size_t write, double delay) const noexcept;
  double sampleRate_ = 48000.0, chorusPhase_ = 0.0;
  std::vector<float> chorusL_, chorusR_, delayL_, delayR_;
  std::size_t chorusWrite_ = 0, delayWrite_ = 0;
  float previousDriveL_ = 0.0f, previousDriveR_ = 0.0f;
  float delayLowL_ = 0.0f, delayLowR_ = 0.0f, delayDcL_ = 0.0f, delayDcR_ = 0.0f;
  float lowCoefficient_ = 0.5f, dcCoefficient_ = 0.001f;
};
} // namespace ieum::wave

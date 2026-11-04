#include "ieum_wave/dsp.hpp"
#include <algorithm>

namespace ieum::wave {
void Envelope::reset() noexcept {
  stage_ = Stage::Idle; value_ = target_ = coefficient_ = 0.0f; remaining_ = 0;
}
void Envelope::noteOn() noexcept { value_ = 0.0f; enter(Stage::Attack); }
void Envelope::noteOff() noexcept {
  if (stage_ != Stage::Idle && stage_ != Stage::Release) enter(Stage::Release);
}
void Envelope::enter(Stage stage) noexcept {
  stage_ = stage;
  float seconds = 0.0f;
  switch (stage) {
    case Stage::Idle: reset(); return;
    case Stage::Attack: seconds = settings_.attack; target_ = 1.5f; break;
    case Stage::Hold:
      value_ = 1.0f;
      if (settings_.hold <= 0.0f) { enter(Stage::Decay); return; }
      seconds = settings_.hold; target_ = value_; break;
    case Stage::Decay: seconds = settings_.decay; target_ = settings_.sustain - 0.001f; break;
    case Stage::Sustain: value_ = settings_.sustain; remaining_ = 0; return;
    case Stage::Release: seconds = settings_.release; target_ = -0.001f; break;
  }
  remaining_ = static_cast<std::uint32_t>(std::max(1.0, std::round(seconds * sampleRate_)));
  float endpoint = stage == Stage::Attack || stage == Stage::Hold ? 1.0f : stage == Stage::Decay ? settings_.sustain : 0.0f;
  const double distance = std::max(1.0e-8, static_cast<double>(std::abs(value_ - target_)));
  const double endDistance = std::max(1.0e-8, static_cast<double>(std::abs(endpoint - target_)));
  coefficient_ = static_cast<float>(1.0 - std::exp(std::log(std::min(1.0, endDistance / distance)) / remaining_));
}
float Envelope::next() noexcept {
  if (stage_ == Stage::Idle) return 0.0f;
  if (stage_ == Stage::Sustain) { value_ += (settings_.sustain - value_) * sustainCoefficient_; return value_; }
  value_ += coefficient_ * (target_ - value_);
  if (--remaining_ == 0) {
    switch (stage_) {
      case Stage::Attack: value_ = 1.0f; enter(Stage::Hold); break;
      case Stage::Hold: enter(Stage::Decay); break;
      case Stage::Decay: enter(Stage::Sustain); break;
      case Stage::Release: reset(); break;
      default: break;
    }
  }
  return clamp(value_, 0.0f, 1.0f);
}

void StereoFilter::prepare(double sampleRate) noexcept {
  sampleRate_ = sampleRate;
  g_.reset(0.1f); k_.reset(1.8f); type_.reset(0.0f); mix_.reset(0.0f);
  reset();
}
void StereoFilter::reset() noexcept { ic1_.fill(0.0); ic2_.fill(0.0); }
void StereoFilter::configure(float cutoff, float resonance, float type, float mix, std::uint32_t ramp) noexcept {
  const double frequency = clamp(static_cast<double>(cutoff), 20.0, sampleRate_ * 0.45);
  g_.set(static_cast<float>(std::tan(kPi * frequency / sampleRate_)), ramp);
  k_.set(2.0f * (1.0f - clamp(resonance, 0.0f, 0.95f)), ramp);
  type_.set(clamp(type, 0.0f, 3.0f), ramp);
  mix_.set(clamp(mix, 0.0f, 1.0f), ramp);
}
Stereo StereoFilter::process(Stereo input) noexcept {
  const double g = g_.next(), k = k_.next();
  const double a1 = 1.0 / (1.0 + g * (g + k));
  const double a2 = g * a1, a3 = g * a2;
  const float type = type_.next(), mix = mix_.next();
  const unsigned first = static_cast<unsigned>(type), second = std::min(first + 1u, 3u);
  const float fraction = type - static_cast<float>(first);
  std::array<float, 2> data = {{input.left, input.right}};
  for (unsigned channel = 0; channel < 2; ++channel) {
    const double x = data[channel];
    const double v3 = x - ic2_[channel];
    const double v1 = a1 * ic1_[channel] + a2 * v3;
    const double v2 = ic2_[channel] + a2 * ic1_[channel] + a3 * v3;
    ic1_[channel] = 2.0 * v1 - ic1_[channel];
    ic2_[channel] = 2.0 * v2 - ic2_[channel];
    if (std::abs(ic1_[channel]) < 1.0e-20) ic1_[channel] = 0.0;
    if (std::abs(ic2_[channel]) < 1.0e-20) ic2_[channel] = 0.0;
    const double high = x - k * v1 - v2;
    // Schema: 0 LP, 1 HP, 2 BP, 3 notch. BP is unity normalized at its center.
    const std::array<float, 4> outputs = {{static_cast<float>(v2), static_cast<float>(high), static_cast<float>(k * v1), static_cast<float>(high + v2)}};
    data[channel] = lerp(data[channel], lerp(outputs[first], outputs[second], fraction), mix);
  }
  return {data[0], data[1]};
}

void Effects::prepare(double sampleRate) {
  sampleRate_ = sampleRate;
  const auto chorusSize = static_cast<std::size_t>(std::ceil(0.05 * sampleRate)) + 8;
  const auto delaySize = static_cast<std::size_t>(std::ceil(2.01 * sampleRate)) + 8;
  chorusL_.assign(chorusSize, 0.0f); chorusR_.assign(chorusSize, 0.0f);
  delayL_.assign(delaySize, 0.0f); delayR_.assign(delaySize, 0.0f);
  lowCoefficient_ = static_cast<float>(1.0 - std::exp(-kTau * 6500.0 / sampleRate));
  dcCoefficient_ = static_cast<float>(1.0 - std::exp(-kTau * 35.0 / sampleRate));
  reset();
}
void Effects::reset() noexcept {
  std::fill(chorusL_.begin(), chorusL_.end(), 0.0f); std::fill(chorusR_.begin(), chorusR_.end(), 0.0f);
  std::fill(delayL_.begin(), delayL_.end(), 0.0f); std::fill(delayR_.begin(), delayR_.end(), 0.0f);
  chorusWrite_ = delayWrite_ = 0; chorusPhase_ = 0.0;
  previousDriveL_ = previousDriveR_ = 0.0f;
  delayLowL_ = delayLowR_ = delayDcL_ = delayDcR_ = 0.0f;
}
float Effects::read(const std::vector<float>& data, std::size_t write, double delay) const noexcept {
  double position = static_cast<double>(write) - clamp(delay, 2.0, static_cast<double>(data.size() - 4));
  if (position < 0.0) position += static_cast<double>(data.size());
  const auto i = static_cast<std::size_t>(position);
  const float frac = static_cast<float>(position - static_cast<double>(i));
  const auto n = data.size();
  return cubic(data[(i + n - 1) % n], data[i], data[(i + 1) % n], data[(i + 2) % n], frac);
}
Stereo Effects::process(Stereo input, float drive, float driveMix, float chorusRate,
                        float chorusDepth, float chorusMix, float delaySeconds,
                        float feedback, float delayMix) noexcept {
  // First-order antiderivative antialiasing for f(x)=x/sqrt(1+x*x).
  // The conjugate form avoids cancellation and division by a near-zero delta.
  const float gain = 1.0f + 24.0f * drive * drive;
  const float compensation = 1.0f / std::sqrt(1.0f + 4.0f * drive);
  const auto saturate = [gain, compensation](float x, float previous) noexcept {
    const float a = gain * x, b = gain * previous;
    return (a + b) / (std::sqrt(1.0f + a * a) + std::sqrt(1.0f + b * b)) * compensation;
  };
  Stereo driven = input;
  if (driveMix > 0.0f) {
    driven.left = lerp(input.left, saturate(input.left, previousDriveL_), driveMix);
    driven.right = lerp(input.right, saturate(input.right, previousDriveR_), driveMix);
  }
  previousDriveL_ = input.left; previousDriveR_ = input.right;
  chorusL_[chorusWrite_] = driven.left; chorusR_[chorusWrite_] = driven.right;
  const double motion = std::sin(kTau * chorusPhase_);
  const double motionR = std::cos(kTau * chorusPhase_);
  const float wetL = read(chorusL_, chorusWrite_, sampleRate_ * (0.014 + 0.006 * chorusDepth * motion));
  const float wetR = read(chorusR_, chorusWrite_, sampleRate_ * (0.017 + 0.006 * chorusDepth * motionR));
  chorusWrite_ = (chorusWrite_ + 1) % chorusL_.size();
  chorusPhase_ = advancePhase(chorusPhase_, chorusRate / sampleRate_);
  Stereo modulated {lerp(driven.left, wetL, chorusMix), lerp(driven.right, wetR, chorusMix)};
  const float delayedL = read(delayL_, delayWrite_, delaySeconds * sampleRate_);
  const float delayedR = read(delayR_, delayWrite_, delaySeconds * sampleRate_);
  delayLowL_ += lowCoefficient_ * (delayedL - delayLowL_);
  delayLowR_ += lowCoefficient_ * (delayedR - delayLowR_);
  delayDcL_ += dcCoefficient_ * (delayLowL_ - delayDcL_);
  delayDcR_ += dcCoefficient_ * (delayLowR_ - delayDcR_);
  // Avoid indefinitely retained subnormal floats after an inaudible tail. This
  // does not change the host's floating-point mode or depend on CPU-specific FTZ.
  const auto clean = [](float value) noexcept { return std::abs(value) < 1.0e-20f ? 0.0f : value; };
  delayLowL_ = clean(delayLowL_); delayLowR_ = clean(delayLowR_);
  delayDcL_ = clean(delayDcL_); delayDcR_ = clean(delayDcR_);
  const float returnedL = delayLowL_ - delayDcL_, returnedR = delayLowR_ - delayDcR_;
  // Bounded feedback even at the schema's 0.95 setting; no self-generated source.
  delayL_[delayWrite_] = clean(clamp(modulated.left + feedback * returnedR, -16.0f, 16.0f));
  delayR_[delayWrite_] = clean(clamp(modulated.right + feedback * returnedL, -16.0f, 16.0f));
  delayWrite_ = (delayWrite_ + 1) % delayL_.size();
  return {lerp(modulated.left, returnedL, delayMix), lerp(modulated.right, returnedR, delayMix)};
}
} // namespace ieum::wave

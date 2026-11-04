#pragma once

#include "../../generated/patch_schema.hpp"
#include "math.hpp"
#include <array>
#include <cstddef>
#include <vector>

namespace ieum::wave {
inline constexpr std::size_t kPlaybackTableSize = 4096;
inline constexpr std::size_t kMipLevels = 10;
inline constexpr std::array<unsigned, kMipLevels> kHarmonicLimits = {{1023, 511, 255, 127, 63, 31, 15, 7, 3, 1}};

struct MipSelection {
  unsigned level = 0;
  float blend = 0.0f;
};

// Select/fade before a level's highest partial reaches 0.46 * sample rate.
// Both tables participating in the crossfade remain below Nyquist.
MipSelection selectMip(double frequency, double sampleRate) noexcept;

class PreparedWavetable {
public:
  struct FrameView { const float* first = nullptr; const float* second = nullptr; float mix = 0.0f; };
  // Control thread only. Input is frame-major, 2048 samples per frame. Removes DC
  // and applies ONE peak-normalization gain to the whole bank before making mips.
  void prepare(const float* frames, std::size_t frameCount);
  std::size_t frameCount() const noexcept { return frames_; }
  bool empty() const noexcept { return frames_ == 0; }
  float read(double phase, float position, MipSelection mip) const noexcept;
  // Cache once per oscillator/sample, then reuse across unison lanes. The view
  // is valid while this immutable table lives. Phase must be in [0,1), and mip
  // must come from selectMip(). The audio oscillator maintains these invariants.
  FrameView frameView(float position) const noexcept {
    if (frames_ == 0) return {};
    const float point = clamp(position, 0.0f, 1.0f) * static_cast<float>(frames_ - 1);
    const auto first = static_cast<std::size_t>(point), second = std::min(first + 1, frames_ - 1);
    return {data_.data() + first * kMipLevels * kStride, data_.data() + second * kMipLevels * kStride, point - static_cast<float>(first)};
  }
  static float readView(FrameView view, double phase, MipSelection mip) noexcept {
    if (!view.first) return 0.0f;
    const double point = phase * kPlaybackTableSize;
    const auto index = static_cast<std::size_t>(point);
    const float frac = static_cast<float>(point - static_cast<double>(index));
    const auto levelOffset = mip.level * kStride + index;
    const auto sample = [frac](const float* p) noexcept { return cubic(p[0], p[1], p[2], p[3], frac); };
    float a = sample(view.first + levelOffset);
    if (view.mix != 0.0f) a = lerp(a, sample(view.second + levelOffset), view.mix);
    if (mip.blend <= 0.0f || mip.level + 1 == kMipLevels) return a;
    float b = sample(view.first + levelOffset + kStride);
    if (view.mix != 0.0f) b = lerp(b, sample(view.second + levelOffset + kStride), view.mix);
    return lerp(a, b, mip.blend);
  }
  std::size_t bytes() const noexcept { return data_.size() * sizeof(float); }
private:
  static constexpr std::size_t kStride = kPlaybackTableSize + 3;
  std::size_t frames_ = 0;
  std::vector<float> data_;
};

// Prepare/edit on a non-audio thread. Immutable for the entire time a Synth uses it.
// The host owns lifetime. Synth::swapWavetables crossfades prepared sets and returns
// the retired pointer after its final read; only then may the host destroy it.
class PreparedWavetableSet {
public:
  PreparedWavetableSet();
  void setCustom(unsigned slot, const float* frameMajorSamples, std::size_t frames);
  bool hasBank(unsigned slot) const noexcept;
  const PreparedWavetable& bank(unsigned slot) const noexcept;
  const PreparedWavetable& sub(bool triangle) const noexcept { return sub_[triangle ? 1 : 0]; }
  std::size_t bytes() const noexcept;
private:
  std::array<PreparedWavetable, generated::kFactoryBankCount + generated::kMaxUserBanks> banks_;
  std::array<PreparedWavetable, 2> sub_;
};
} // namespace ieum::wave

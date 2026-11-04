#include "ieum_wave/wavetable.hpp"
#include "ieum_wave/math.hpp"
#include <complex>
#include <stdexcept>

namespace ieum::wave {
namespace {
// Original iterative radix-2 transform, used only while preparing immutable data.
void fft(std::complex<double>* values, std::size_t count, bool inverse) {
  for (std::size_t i = 1, j = 0; i < count; ++i) {
    std::size_t bit = count >> 1;
    for (; (j & bit) != 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) std::swap(values[i], values[j]);
  }
  for (std::size_t length = 2; length <= count; length <<= 1) {
    const double angle = (inverse ? kTau : -kTau) / static_cast<double>(length);
    const std::complex<double> rotation(std::cos(angle), std::sin(angle));
    for (std::size_t start = 0; start < count; start += length) {
      std::complex<double> phase(1.0, 0.0);
      for (std::size_t j = 0; j < length / 2; ++j) {
        const auto even = values[start + j];
        const auto odd = values[start + j + length / 2] * phase;
        values[start + j] = even + odd;
        values[start + j + length / 2] = even - odd;
        phase *= rotation;
      }
    }
  }
  if (inverse) for (std::size_t i = 0; i < count; ++i) values[i] /= static_cast<double>(count);
}
} // namespace

MipSelection selectMip(double frequency, double sampleRate) noexcept {
  const double f = std::abs(frequency) / sampleRate;
  unsigned level = 0;
  while (level + 1 < kMipLevels && f * kHarmonicLimits[level] > 0.46) ++level;
  if (level + 1 == kMipLevels) return {level, 0.0f};
  const double upper = 0.46 / kHarmonicLimits[level];
  const double lower = level == 0 ? upper * 0.5 : 0.46 / kHarmonicLimits[level - 1];
  return {level, static_cast<float>(clamp((f - lower) / (upper - lower), 0.0, 1.0))};
}

void PreparedWavetable::prepare(const float* frames, std::size_t frameCount) {
  constexpr std::size_t size = generated::kWavetableSize;
  if (frames == nullptr || frameCount == 0 || frameCount > generated::kMaxFrames)
    throw std::invalid_argument("Wavetable requires 1..16 frames of 2048 finite samples");
  std::vector<double> source(frameCount * size);
  double peak = 0.0;
  for (std::size_t frame = 0; frame < frameCount; ++frame) {
    double mean = 0.0;
    for (std::size_t i = 0; i < size; ++i) {
      const float sample = frames[frame * size + i];
      if (!std::isfinite(sample) || std::abs(sample) > 32.0f)
        throw std::invalid_argument("Invalid wavetable sample");
      mean += sample;
    }
    mean /= static_cast<double>(size);
    for (std::size_t i = 0; i < size; ++i) {
      const double value = static_cast<double>(frames[frame * size + i]) - mean;
      source[frame * size + i] = value;
      peak = std::max(peak, std::abs(value));
    }
  }
  const double gain = peak > 1.0e-12 ? 1.0 / peak : 0.0;
  std::vector<float> prepared(frameCount * kMipLevels * kStride);
  std::array<std::complex<double>, size> spectrum;
  std::array<std::complex<double>, kPlaybackTableSize> work;
  for (std::size_t frame = 0; frame < frameCount; ++frame) {
    for (std::size_t i = 0; i < size; ++i) spectrum[i] = source[frame * size + i] * gain;
    fft(spectrum.data(), spectrum.size(), false);
    for (std::size_t level = 0; level < kMipLevels; ++level) {
      work.fill({0.0, 0.0});
      for (unsigned h = 1; h <= kHarmonicLimits[level]; ++h) {
        // Zero-padding doubles the cycle resolution without changing its spectrum.
        work[h] = spectrum[h] * 2.0;
        work[kPlaybackTableSize - h] = spectrum[size - h] * 2.0;
      }
      fft(work.data(), work.size(), true);
      float* table = prepared.data() + (frame * kMipLevels + level) * kStride;
      for (std::size_t i = 0; i < kPlaybackTableSize; ++i) table[i + 1] = static_cast<float>(work[i].real());
      table[0] = table[kPlaybackTableSize];
      table[kPlaybackTableSize + 1] = table[1];
      table[kPlaybackTableSize + 2] = table[2];
    }
  }
  data_.swap(prepared);
  frames_ = frameCount;
}

float PreparedWavetable::read(double phase, float position, MipSelection mip) const noexcept {
  if (!std::isfinite(phase) || !std::isfinite(position)) return 0.0f;
  mip.level = std::min(mip.level, static_cast<unsigned>(kMipLevels - 1));
  mip.blend = clamp(finiteOr(mip.blend), 0.0f, 1.0f);
  return readView(frameView(position), wrapPhase(phase), mip);
}

PreparedWavetableSet::PreparedWavetableSet() {
  std::vector<float> samples(generated::kFactoryFrames * generated::kWavetableSize);
  for (std::size_t bank = 0; bank < generated::kFactoryBankCount; ++bank) {
    for (std::size_t frame = 0; frame < generated::kFactoryFrames; ++frame) {
      for (std::size_t i = 0; i < generated::kWavetableSize; ++i) {
        double value = 0.0;
        const double phase = kTau * static_cast<double>(i) / generated::kWavetableSize;
        for (std::size_t h = 0; h < generated::kFactoryHarmonicCount; ++h)
          value += generated::kFactoryHarmonics[bank][frame][h] * std::sin(phase * static_cast<double>(h + 1));
        samples[frame * generated::kWavetableSize + i] = static_cast<float>(value);
      }
    }
    banks_[bank].prepare(samples.data(), generated::kFactoryFrames);
  }
  for (unsigned shape = 0; shape < 2; ++shape) {
    for (std::size_t i = 0; i < generated::kWavetableSize; ++i) {
      const double sine = std::sin(kTau * static_cast<double>(i) / generated::kWavetableSize);
      samples[i] = static_cast<float>(shape == 0 ? sine : (2.0 / kPi) * std::asin(sine));
    }
    sub_[shape].prepare(samples.data(), 1);
  }
}

void PreparedWavetableSet::setCustom(unsigned slot, const float* samples, std::size_t frames) {
  if (slot < generated::kFactoryBankCount || slot >= banks_.size())
    throw std::invalid_argument("Custom wavetable slot must be 4..7");
  banks_[slot].prepare(samples, frames);
}
bool PreparedWavetableSet::hasBank(unsigned slot) const noexcept {
  return slot < banks_.size() && !banks_[slot].empty();
}
const PreparedWavetable& PreparedWavetableSet::bank(unsigned slot) const noexcept {
  // Defensive fallback for direct readers. Synth and bridge validation reject missing slots.
  return hasBank(slot) ? banks_[slot] : banks_[0];
}
std::size_t PreparedWavetableSet::bytes() const noexcept {
  std::size_t total = 0;
  for (const auto& bank : banks_) total += bank.bytes();
  for (const auto& sub : sub_) total += sub.bytes();
  return total;
}
} // namespace ieum::wave

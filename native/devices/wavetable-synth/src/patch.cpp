#include "ieum_wave/patch.hpp"
#include "ieum_wave/math.hpp"
#include <cstring>
#include <stdexcept>

namespace ieum::wave {
Patch::Patch() noexcept {
  for (std::size_t lfo = 0; lfo < lfoCurves.size(); ++lfo) {
    for (std::size_t i = 0; i < lfoCurves[lfo].size(); ++i) {
      const double phase = static_cast<double>(i) / generated::kLfoPoints;
      lfoCurves[lfo][i] = static_cast<float>(lfo == 0 ? 0.5 - 0.5 * std::cos(kTau * phase) :
        lfo == 1 ? 1.0 - std::abs(2.0 * phase - 1.0) : lfo == 2 ? phase : 1.0 - phase);
    }
  }
}

bool validateParameter(ParameterId id, float value) noexcept {
  const auto i = parameterIndex(id);
  if (i >= generated::kParamCount || !std::isfinite(value) || value < generated::kMinimum[i] ||
      value > generated::kMaximum[i] || (generated::kInteger[i] && std::round(value) != value)) return false;
  if (generated::kOptionCount[i] != 0) {
    bool found = false;
    for (unsigned option = 0; option < generated::kOptionCount[i]; ++option)
      if (value == generated::kOptionValues[i][option]) found = true;
    if (!found) return false;
  }
  return true;
}

bool validatePatch(const Patch& patch) noexcept {
  for (std::size_t i = 0; i < patch.params.size(); ++i) {
    if (!validateParameter(static_cast<ParameterId>(i), patch.params[i])) return false;
  }
  for (const auto& curve : patch.lfoCurves) for (float value : curve)
    if (!std::isfinite(value) || value < 0.0f || value > 1.0f) return false;
  for (const auto& route : patch.routes) {
    const auto source = static_cast<unsigned>(route.source);
    const auto dest = parameterIndex(route.destination);
    if (source >= static_cast<unsigned>(ModSource::Count) || dest >= generated::kParamCount || !generated::kModulatable[dest] ||
        (route.aux != generated::kNoAuxSource && route.aux >= static_cast<unsigned>(ModSource::Count)) ||
        !std::isfinite(route.amount) || std::abs(route.amount) > 1.0f ||
        !std::isfinite(route.curve) || std::abs(route.curve) > 1.0f) return false;
  }
  return true;
}

bool decodePatchBundle(const std::uint8_t* data, std::size_t size, PatchBundle& result, std::string& error) {
  error.clear();
  try {
    if (!data || size < 32 || size > 3 * 1024 * 1024) throw std::runtime_error("Invalid bridge pack size");
    if (std::memcmp(data, "IEWAVE01", 8) != 0) throw std::runtime_error("Invalid bridge pack magic");
    std::size_t cursor = 8;
    const auto u32 = [&]() -> std::uint32_t {
      if (size - cursor < 4) throw std::runtime_error("Truncated bridge pack");
      const std::uint32_t value = std::uint32_t(data[cursor]) | (std::uint32_t(data[cursor + 1]) << 8) |
        (std::uint32_t(data[cursor + 2]) << 16) | (std::uint32_t(data[cursor + 3]) << 24);
      cursor += 4; return value;
    };
    const auto f32 = [&]() -> float { const auto bits = u32(); float value; std::memcpy(&value, &bits, 4); return value; };
    if (u32() != 1) throw std::runtime_error("Unsupported bridge version");
    if (u32() != generated::kSchemaFingerprint) throw std::runtime_error("Parameter schema fingerprint mismatch");
    if (u32() != generated::kParamCount) throw std::runtime_error("Parameter count mismatch");
    const auto bankCount = u32(), routeCount = u32();
    if (u32() != 0 || bankCount > generated::kMaxUserBanks || routeCount > generated::kMaxModRoutes)
      throw std::runtime_error("Invalid bridge counts or reserved field");
    PatchBundle candidate;
    for (auto& value : candidate.patch.params) value = f32();
    for (auto& curve : candidate.patch.lfoCurves) for (auto& value : curve) value = f32();
    for (std::size_t i = 0; i < routeCount; ++i) {
      auto& route = candidate.patch.routes[i];
      const auto source = u32(), destination = u32(), aux = u32(), flags = u32();
      if (source >= static_cast<unsigned>(ModSource::Count) || destination >= generated::kParamCount || (flags & ~3u))
        throw std::runtime_error("Invalid modulation route");
      route.source = static_cast<ModSource>(source); route.destination = static_cast<ParameterId>(destination);
      route.aux = aux; route.bipolar = (flags & 1u) != 0; route.enabled = (flags & 2u) != 0;
      route.amount = f32(); route.curve = f32();
    }
    if (!validatePatch(candidate.patch)) throw std::runtime_error("Invalid patch parameter, curve, or routing value");
    std::array<bool, 8> seen {};
    for (std::size_t i = 0; i < bankCount; ++i) {
      CustomBank bank;
      bank.slot = u32(); bank.frameCount = u32();
      if (bank.slot < 4 || bank.slot > 7 || seen[bank.slot] || bank.frameCount == 0 || bank.frameCount > generated::kMaxFrames)
        throw std::runtime_error("Invalid or duplicate user wavetable bank");
      seen[bank.slot] = true;
      const auto count = bank.frameCount * generated::kWavetableSize;
      if (count > (size - cursor) / 4) throw std::runtime_error("Truncated user wavetable bank");
      bank.samples.resize(count);
      for (auto& sample : bank.samples) {
        sample = f32();
        if (!std::isfinite(sample) || sample < -1.0f || sample > 1.0f) throw std::runtime_error("Invalid user waveform sample");
      }
      candidate.banks.push_back(std::move(bank));
    }
    for (std::size_t osc = 0; osc < generated::kOscillators; ++osc) {
      const unsigned bank = static_cast<unsigned>(candidate.patch.params[osc * 12 + 1]);
      if (bank >= 4 && !seen[bank]) throw std::runtime_error("Selected user wavetable bank is missing");
    }
    if (cursor != size) throw std::runtime_error("Trailing bytes in bridge pack");
    result = std::move(candidate);
    return true;
  } catch (const std::exception& exception) { error = exception.what(); return false; }
}
} // namespace ieum::wave

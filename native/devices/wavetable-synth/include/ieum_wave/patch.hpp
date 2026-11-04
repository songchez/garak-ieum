#pragma once

#include "../../generated/patch_schema.hpp"
#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace ieum::wave {
using ParameterId = generated::ParameterId;
using ModSource = generated::ModSource;
inline constexpr std::size_t parameterIndex(ParameterId id) noexcept { return static_cast<std::size_t>(id); }

struct ModRoute {
  ModSource source = ModSource::Env2;
  ParameterId destination = ParameterId::Filter1Cutoff;
  std::uint32_t aux = generated::kNoAuxSource;
  float amount = 0.0f, curve = 0.0f;
  bool bipolar = false, enabled = false;
};
struct Patch {
  std::array<float, generated::kParamCount> params = generated::kDefaults;
  std::array<std::array<float, generated::kLfoPoints>, generated::kLfos> lfoCurves {};
  std::array<ModRoute, generated::kMaxModRoutes> routes {};
  Patch() noexcept;
};
struct CustomBank {
  unsigned slot = 4;
  unsigned frameCount = 0;
  std::vector<float> samples;
};
struct PatchBundle {
  Patch patch;
  std::vector<CustomBank> banks;
};

// Strict IEWAVE01 binary decoder. Control thread only; rejects unknown schema,
// non-finite/out-of-range values, duplicate slots and trailing/truncated bytes.
bool decodePatchBundle(const std::uint8_t* data, std::size_t size, PatchBundle& result, std::string& error);
bool validateParameter(ParameterId id, float value) noexcept;
bool validatePatch(const Patch& patch) noexcept;
} // namespace ieum::wave

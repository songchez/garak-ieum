#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace ieum::wave {
inline constexpr double kPi = 3.1415926535897932384626433832795;
inline constexpr double kTau = 2.0 * kPi;

template <class T> inline T clamp(T x, T low, T high) noexcept {
  return std::min(high, std::max(low, x));
}
inline float finiteOr(float x, float fallback = 0.0f) noexcept {
  return std::isfinite(x) ? x : fallback;
}
inline double wrapPhase(double phase) noexcept { return phase - std::floor(phase); }
// Internal oscillators/LFOs have phase in [0,1) and a non-negative increment <1.
// Their single wrap needs no floor; keep wrapPhase for arbitrary public inputs.
inline double advancePhase(double phase, double increment) noexcept {
  phase += increment;
  return phase >= 1.0 ? phase - 1.0 : phase;
}
inline float lerp(float a, float b, float t) noexcept { return a + t * (b - a); }

// Local deterministic PRNG. No global state, system calls, or random_device in audio code.
inline std::uint32_t randomBits(std::uint32_t& state) noexcept {
  state ^= state << 13; state ^= state >> 17; state ^= state << 5;
  return state;
}
inline float randomUnit(std::uint32_t& state) noexcept {
  return static_cast<float>(randomBits(state) >> 8) * (1.0f / 16777216.0f);
}

struct LinearSmoother {
  float value = 0.0f;
  float target = 0.0f;
  float step = 0.0f;
  std::uint32_t remaining = 0;
  void reset(float v) noexcept { value = target = v; step = 0.0f; remaining = 0; }
  void set(float v, std::uint32_t samples) noexcept {
    if (samples == 0) { reset(v); return; }
    if (v == target) return;
    target = v;
    remaining = samples; step = (target - value) / static_cast<float>(samples);
  }
  float next() noexcept {
    if (remaining != 0 && --remaining == 0) value = target;
    else if (remaining != 0) value += step;
    return value;
  }
};

inline float cubic(float a, float b, float c, float d, float fraction) noexcept {
  const float c1 = 0.5f * (c - a);
  const float c2 = a - 2.5f * b + 2.0f * c - 0.5f * d;
  const float c3 = 0.5f * (d - a) + 1.5f * (b - c);
  return ((c3 * fraction + c2) * fraction + c1) * fraction + b;
}

// Transparent below the knee, continuous first derivative; emergency peak safety,
// not a lookahead limiter and not loudness normalization.
inline float safetyCeiling(float x) noexcept {
  x = finiteOr(x);
  const float magnitude = std::abs(x);
  if (magnitude <= 0.94f) return x;
  const float excess = magnitude - 0.94f;
  return std::copysign(0.94f + 0.04f * excess / (0.04f + excess), x);
}
} // namespace ieum::wave

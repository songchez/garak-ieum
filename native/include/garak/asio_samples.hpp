#pragma once

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace garak::asio_samples {

// ASIO 2.3 sample type numeric values. Kept independent of the Windows SDK so
// conversion boundary tests run on every platform. DSD is deliberately rejected.
inline int bytes(int type) noexcept {
  switch (type) {
    case 0: case 16: return 2;
    case 1: case 17: return 3;
    case 2: case 3: case 8: case 9: case 10: case 11:
    case 18: case 19: case 24: case 25: case 26: case 27: return 4;
    case 4: case 20: return 8;
    default: return 0;
  }
}
inline std::uint64_t load(const std::uint8_t* p, int n, bool big) noexcept {
  std::uint64_t v = 0;
  for (int i = 0; i < n; ++i) v |= std::uint64_t(p[i]) << (8 * (big ? n - 1 - i : i));
  return v;
}
inline void store(std::uint8_t* p, int n, bool big, std::uint64_t v) noexcept {
  for (int i = 0; i < n; ++i) p[i] = std::uint8_t(v >> (8 * (big ? n - 1 - i : i)));
}
inline int validBits(int type) noexcept {
  switch (type) {
    case 0: case 16: case 8: case 24: return 16;
    case 9: case 25: return 18;
    case 10: case 26: return 20;
    case 1: case 17: case 11: case 27: return 24;
    default: return 32;
  }
}
inline float read(const void* buffer, int type, std::uint32_t frame) noexcept {
  const int n = bytes(type);
  if (!n) return 0;
  const auto* p = static_cast<const std::uint8_t*>(buffer) + std::size_t(frame) * n;
  const auto bits = load(p, n, type < 16);
  double value = 0;
  if (type == 3 || type == 19) value = std::bit_cast<float>(std::uint32_t(bits));
  else if (type == 4 || type == 20) value = std::bit_cast<double>(bits);
  else {
    const int width = validBits(type);
    // 32-bit containers with 16/18/20/24 valid bits are right-justified.
    const auto mask = (std::uint64_t(1) << width) - 1;
    const auto word = bits & mask;
    const std::int64_t signedValue = word & (std::uint64_t(1) << (width - 1))
        ? std::int64_t(word) - std::int64_t(std::uint64_t(1) << width) : std::int64_t(word);
    value = double(signedValue) / double(std::uint64_t(1) << (width - 1));
  }
  return std::isfinite(value) ? float(std::clamp(value, -1.0, 1.0)) : 0.f;
}
inline void write(void* buffer, int type, std::uint32_t frame, float sample) noexcept {
  const int n = bytes(type);
  if (!n) return;
  auto* p = static_cast<std::uint8_t*>(buffer) + std::size_t(frame) * n;
  const double x = std::isfinite(sample) ? std::clamp(double(sample), -1.0, 1.0) : 0;
  std::uint64_t v = 0;
  if (type == 3 || type == 19) v = std::bit_cast<std::uint32_t>(float(x));
  else if (type == 4 || type == 20) v = std::bit_cast<std::uint64_t>(x);
  else {
    const int width = validBits(type);
    const auto scale = std::int64_t(1) << (width - 1);
    const auto value = std::clamp(std::int64_t(std::llround(x * double(scale))), -scale, scale - 1);
    // Sign extend when the valid integer is held in a 32-bit container.
    v = std::uint64_t(value);
  }
  store(p, n, type < 16, v);
}

} // namespace garak::asio_samples

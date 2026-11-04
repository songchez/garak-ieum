#include "garak/asio_samples.hpp"
#include <array>
#include <cmath>
#include <iostream>
#include <limits>
#include <stdexcept>

using namespace garak::asio_samples;
void check(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
int main() {
  try {
    for (int type : {0, 1, 2, 3, 4, 8, 9, 10, 11, 16, 17, 18, 19, 20, 24, 25, 26, 27}) {
      std::array<std::uint8_t, 64> data{};
      const std::array<float, 8> samples{-2, -1, -.5f, 0, .5f, 1, 2, std::numeric_limits<float>::quiet_NaN()};
      for (std::uint32_t i = 0; i < samples.size(); ++i) write(data.data(), type, i, samples[i]);
      for (std::uint32_t i = 0; i < samples.size(); ++i) {
        const auto wanted = std::isfinite(samples[i]) ? std::clamp(samples[i], -1.f, 1.f) : 0.f;
        check(std::abs(read(data.data(), type, i) - wanted) < .00004f, "ASIO format conversion or clipping mismatch");
      }
    }
    std::array<std::uint8_t, 8> bytes{};
    write(bytes.data(), 17, 0, -.5f);
    check(bytes[0] == 0 && bytes[1] == 0 && bytes[2] == 0xc0, "24-bit little-endian representation");
    write(bytes.data(), 1, 0, -.5f);
    check(bytes[0] == 0xc0 && bytes[1] == 0 && bytes[2] == 0, "24-bit big-endian representation");
    write(bytes.data(), 24, 0, -.5f);
    check(bytes[0] == 0 && bytes[1] == 0xc0 && bytes[2] == 0xff && bytes[3] == 0xff, "16-in-32 ASIO sign extension");
    check(garak::asio_samples::bytes(32) == 0 && garak::asio_samples::bytes(99) == 0, "Unsupported DSD format accepted");
    std::cout << "PASS ASIO PCM endian, padded integer, clipping and finite sample conversion\n";
    return 0;
  } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}

#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace garak {

struct DeviceInfo {
  std::string id, name, backend;
  std::uint32_t inputChannels = 0, outputChannels = 0;
  bool isDefault = false;
  // Empty means not reported without opening the device, not unsupported.
  std::vector<std::uint32_t> sampleRates, bufferSizes;
};

struct DeviceConfig {
  std::string backend;
  std::string inputDeviceId, outputDeviceId;
  std::uint32_t sampleRate = 48000, bufferFrames = 128;
  std::uint32_t inputChannels = 2, inputChannelOffset = 0;
  std::uint32_t outputChannelOffset = 0;
  bool lowLatencyMonitoring = true;
  bool exclusive = false;
};

struct DeviceState {
  bool configured = false, running = false;
  std::string backend, inputDeviceId, outputDeviceId, name, error;
  std::uint32_t sampleRate = 0, bufferFrames = 0;
  std::uint32_t inputChannels = 0, outputChannels = 0;
  std::uint32_t inputDeviceSampleRate = 0, outputDeviceSampleRate = 0;
  std::uint32_t inputChannelOffset = 0, outputChannelOffset = 0;
  // These are driver reports, never presented as a measured round-trip time.
  std::optional<std::uint32_t> inputLatencyFrames, outputLatencyFrames;
  std::uint64_t callbacks = 0, discontinuities = 0;
  bool needsReconfigure = false, resampling = false;
};

// Selected input channels, interleaved; stereo output. Called only by the device
// callback. The caller must not allocate, block, perform IO or throw here.
using DeviceCallback = void (*)(void* user, float* stereoOutput, const float* input,
    std::uint32_t frames, std::uint32_t inputChannels) noexcept;

class DeviceHost {
 public:
  DeviceHost();
  ~DeviceHost();
  DeviceHost(const DeviceHost&) = delete;
  DeviceHost& operator=(const DeviceHost&) = delete;
  [[nodiscard]] static std::vector<std::string> availableBackends();
  [[nodiscard]] static std::vector<DeviceInfo> enumerate(const std::string& backend = {});
  // Control/main thread only. Closes the previous device and creates a stopped
  // device. An explicitly requested device/backend is never silently replaced.
  void configure(const DeviceConfig&, DeviceCallback, void* user);
  void start();
  void stop();
  void close() noexcept;
  // Handle driver reset/disconnect requests outside the real-time callback.
  // A reset stops the device and requires an explicit configure from the user.
  void service();
  [[nodiscard]] DeviceState state() const;
  void showControlPanel();
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

} // namespace garak

#pragma once

#include "garak/device_logic.hpp"

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

struct ProbeChannel { std::uint32_t index = 0; std::string name; };
struct ClockSourceInfo { std::int32_t index = 0; std::string name; bool current = false; };

// What an opened driver reports (devices.probe). Unknown values stay empty or
// unset; miniaudio backends cannot report buffer ranges, clocks or latencies.
struct DeviceProbe {
  std::string id, name, backend;
  std::vector<ProbeChannel> inputs, outputs;
  std::vector<std::uint32_t> sampleRates;
  std::optional<std::uint32_t> currentSampleRate;
  std::optional<BufferCaps> buffer;
  std::vector<std::uint32_t> bufferSizes;
  std::vector<ClockSourceInfo> clockSources;
  bool canDirectMonitor = false;
  std::optional<std::uint32_t> inputLatencyFrames, outputLatencyFrames;
};

struct DeviceConfig {
  std::string backend;
  std::string inputDeviceId, outputDeviceId;
  std::uint32_t sampleRate = 48000;
  // device_logic::kDriverBuffer (0) selects the driver's preferred size.
  std::uint32_t bufferFrames = 128;
  // Physical inputs delivered to the callback, interleaved in this order. When
  // empty, the legacy contiguous inputChannels/inputChannelOffset pair applies.
  std::vector<std::uint32_t> inputChannelList;
  std::uint32_t inputChannels = 2, inputChannelOffset = 0;
  std::uint32_t outputChannelOffset = 0;
  std::optional<std::int32_t> clockSource;
  bool directMonitoring = false;
  bool lowLatencyMonitoring = true;
  bool exclusive = false;
  // Set by recovery only: the driver's preferred size before a reset request.
  std::uint32_t previousDriverPreferred = 0;
};

// The physical input list a configuration opens (list first, then legacy pair).
inline std::vector<std::uint32_t> resolvedInputList(const DeviceConfig& config) {
  return config.inputChannelList.empty() ? device_logic::legacyInputList(config.inputChannels, config.inputChannelOffset)
                                         : config.inputChannelList;
}

struct DeviceState {
  bool configured = false, running = false;
  std::string backend, inputDeviceId, outputDeviceId, name, error;
  // DeviceErrorCode wire name for `error`, empty when the cause is unclassified.
  std::string errorCode;
  std::uint32_t sampleRate = 0, bufferFrames = 0;
  // inputChannels is the opened list length; inputChannelOffset its first entry.
  std::uint32_t inputChannels = 0, outputChannels = 0;
  std::uint32_t inputDeviceSampleRate = 0, outputDeviceSampleRate = 0;
  std::uint32_t inputChannelOffset = 0, outputChannelOffset = 0;
  std::vector<std::uint32_t> inputChannelList;
  // Names of the opened inputs (list order) and of the opened output pair.
  std::vector<std::string> inputNames, outputNames;
  // These are driver reports, never presented as a measured round-trip time.
  std::optional<std::uint32_t> inputLatencyFrames, outputLatencyFrames;
  std::uint64_t callbacks = 0, discontinuities = 0, recoveries = 0;
  std::optional<std::int32_t> clockSource;
  bool needsReconfigure = false, resampling = false, bufferAdjusted = false;
  bool recovering = false, suspended = false, directMonitoring = false;
};

// Selected input channels, interleaved; stereo output. Called only by the device
// callback. The caller must not allocate, block, perform IO or throw here.
using DeviceCallback = void (*)(void* user, float* stereoOutput, const float* input,
    std::uint32_t frames, std::uint32_t inputChannels) noexcept;

// Called on each engine worker thread as it starts (true) and exits (false).
// Windows: MMCSS "Pro Audio" plus time-critical priority, reverted on exit.
// macOS: a real-time time-constraint policy sized to the device buffer.
void promoteAudioWorkerThread(bool started, std::uint32_t sampleRate, std::uint32_t bufferFrames) noexcept;

// Failures with a known cause are thrown as DeviceError (device_logic.hpp).
class DeviceHost {
 public:
  DeviceHost();
  ~DeviceHost();
  DeviceHost(const DeviceHost&) = delete;
  DeviceHost& operator=(const DeviceHost&) = delete;
  [[nodiscard]] static std::vector<std::string> availableBackends();
  [[nodiscard]] static std::vector<DeviceInfo> enumerate(const std::string& backend = {});
  // Opens the driver briefly and closes it again. The device that is currently
  // open is answered from its open handle instead of being reopened.
  [[nodiscard]] DeviceProbe probe(const std::string& backend, const std::string& deviceId);
  // Control/main thread only. Closes the previous device and creates a stopped
  // device. An explicitly requested device/backend is never silently replaced.
  void configure(const DeviceConfig&, DeviceCallback, void* user);
  void start();
  // A planned stop also cancels a pending reconnect.
  void stop();
  void close() noexcept;
  // Control thread, called often. Handles driver reset/disconnect requests
  // outside the callback: the device is closed and reopened with the same
  // configuration on the RecoveryBackoff schedule. The callback/user pointer,
  // and therefore the engine and transport, survive.
  void service();
  // Closes the device but keeps the configuration; resume reopens it.
  void suspend();
  void resume();
  [[nodiscard]] bool suspended() const noexcept;
  void setClockSource(std::int32_t index);
  void setDirectMonitoring(bool enabled);
  [[nodiscard]] DeviceState state() const;
  // Without an id: the running device. With an ASIO id that is not running (e.g. its
  // configure was just refused), the driver is opened only to show its panel.
  void showControlPanel(const std::string& backend = {}, const std::string& deviceId = {});
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

} // namespace garak

#pragma once

// Device decisions that do not need a driver: buffer-size snapping, error
// classification, channel selection and the reconnect schedule. Real ASIO,
// WASAPI and Core Audio calls stay thin in device.cpp so these rules are
// unit-tested on every platform (tests/device_logic_test.cpp).

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace garak {

// Wire names are in deviceErrorCodeName(); docs/AUDIO_CORE_PLAN.md owns the table.
enum class DeviceErrorCode { None, NotFound, InUse, DriverInitFailed, SampleRateUnsupported, BufferUnsupported, ChannelsUnavailable, Lost };

inline const char* deviceErrorCodeName(DeviceErrorCode code) noexcept {
  switch (code) {
    case DeviceErrorCode::NotFound: return "DEVICE_NOT_FOUND";
    case DeviceErrorCode::InUse: return "DEVICE_IN_USE";
    case DeviceErrorCode::DriverInitFailed: return "DRIVER_INIT_FAILED";
    case DeviceErrorCode::SampleRateUnsupported: return "SAMPLE_RATE_UNSUPPORTED";
    case DeviceErrorCode::BufferUnsupported: return "BUFFER_UNSUPPORTED";
    case DeviceErrorCode::ChannelsUnavailable: return "CHANNELS_UNAVAILABLE";
    case DeviceErrorCode::Lost: return "DEVICE_LOST";
    default: return "";
  }
}

// ASIO getBufferSize() as reported. granularity -1 means powers of two.
struct BufferCaps {
  std::int32_t minimum = 0, maximum = 0, preferred = 0, granularity = 0;
};

struct DeviceErrorDetails {
  std::vector<std::uint32_t> supportedSampleRates;
  std::optional<BufferCaps> buffer;
  std::optional<std::uint32_t> availableInputs, availableOutputs;
};

// Thrown by the device layer. The message stays English; the renderer localizes
// by code, so the code must describe the cause rather than the failing call.
class DeviceError : public std::runtime_error {
 public:
  DeviceError(DeviceErrorCode code, const std::string& message, DeviceErrorDetails details = {})
      : std::runtime_error(message), code_(code), details_(std::move(details)) {}
  [[nodiscard]] DeviceErrorCode code() const noexcept { return code_; }
  [[nodiscard]] const DeviceErrorDetails& details() const noexcept { return details_; }
 private:
  DeviceErrorCode code_;
  DeviceErrorDetails details_;
};

// Why a running device stopped delivering callbacks. Every fault is recovered
// by reopening the same configuration (RecoveryBackoff).
enum class DeviceFault { None, ResetRequest, BufferSizeChange, SampleRateChange, Resync, Stopped, Interrupted, Rerouted };

namespace device_logic {

constexpr std::uint32_t kDriverBuffer = 0;           // bufferFrames: "driver"
constexpr std::size_t kMaxListedBufferSizes = 32;
constexpr std::size_t kMaxInputChannels = 32;
constexpr std::uint32_t kMaxPhysicalChannel = 255;   // inclusive physical index bound
constexpr std::uint32_t kProbeSampleRates[] = {44100, 48000, 88200, 96000, 176400, 192000};

// Some drivers report a zero minimum or a preferred size outside the range.
// The preferred size is what the driver runs best at, so it always stays usable.
inline BufferCaps sanitize(BufferCaps c) noexcept {
  if (c.preferred <= 0) c.preferred = c.minimum > 0 ? c.minimum : 0;
  if (c.minimum <= 0 || c.maximum < c.minimum) { c.minimum = c.maximum = c.preferred; c.granularity = 0; }
  return c;
}
inline bool onlyPreferred(const BufferCaps& c) noexcept {
  return c.granularity == 0 || c.granularity < -1 || c.minimum == c.maximum;
}

// Every size the driver accepts, ascending, including preferred. Bounded so a
// granularity of 1 over a wide range cannot grow without limit.
inline std::vector<std::uint32_t> allBufferSizes(BufferCaps caps) {
  const auto c = sanitize(caps);
  std::vector<std::uint32_t> sizes;
  if (c.preferred <= 0) return sizes;
  if (!onlyPreferred(c)) {
    if (c.granularity == -1) {
      for (std::int64_t p = 1; p <= c.maximum; p *= 2) if (p >= c.minimum) sizes.push_back(std::uint32_t(p));
    } else {
      for (std::int64_t v = c.minimum; v <= c.maximum && sizes.size() < 65536; v += c.granularity) sizes.push_back(std::uint32_t(v));
    }
  }
  sizes.push_back(std::uint32_t(c.preferred));
  std::sort(sizes.begin(), sizes.end());
  sizes.erase(std::unique(sizes.begin(), sizes.end()), sizes.end());
  return sizes;
}

// The list shown to the user (at most 32). When the driver allows more, keep the
// range ends, the preferred size and powers of two, which are what people pick.
inline std::vector<std::uint32_t> allowedBufferSizes(const BufferCaps& caps, std::size_t limit = kMaxListedBufferSizes) {
  auto sizes = allBufferSizes(caps);
  if (sizes.size() <= limit || limit == 0) return sizes;
  const auto c = sanitize(caps);
  const auto preferred = std::uint32_t(c.preferred);
  std::vector<std::uint32_t> reduced;
  for (const auto v : sizes)
    if (v == sizes.front() || v == sizes.back() || v == preferred || (v & (v - 1)) == 0) reduced.push_back(v);
  if (reduced.size() > limit) {
    std::vector<std::uint32_t> kept{preferred};
    for (const auto v : reduced) if (kept.size() < limit && v != preferred) kept.push_back(v);
    std::sort(kept.begin(), kept.end());
    reduced = std::move(kept);
  }
  return reduced;
}

struct BufferChoice {
  std::uint32_t frames = 0;       // 0: the driver reported nothing usable
  bool adjusted = false;          // a numeric request was replaced
  bool followedDriver = false;    // the driver's preferred size changed under us
};

// ASIO never rejects a requested size: it snaps to the nearest accepted size
// (ties pick the larger, safer one). "driver" (0) uses the preferred size. A
// recovery passes the preferred size seen before a reset; if the control panel
// changed it, the new preference wins over the old numeric request.
inline BufferChoice snapBufferSize(const BufferCaps& caps, std::uint32_t requested, std::uint32_t previousPreferred = 0) {
  const auto c = sanitize(caps);
  BufferChoice choice;
  if (c.preferred <= 0) { choice.frames = requested; return choice; }
  const auto preferred = std::uint32_t(c.preferred);
  if (requested == kDriverBuffer) { choice.frames = preferred; return choice; }
  if (previousPreferred && previousPreferred != preferred) {
    choice.frames = preferred; choice.adjusted = requested != preferred; choice.followedDriver = true;
    return choice;
  }
  const auto sizes = allBufferSizes(c);
  std::uint32_t best = preferred;
  std::int64_t bestDistance = -1;
  for (const auto v : sizes) {
    const auto distance = std::llabs(std::int64_t(v) - std::int64_t(requested));
    if (bestDistance < 0 || distance < bestDistance || (distance == bestDistance && v > best)) { best = v; bestDistance = distance; }
  }
  choice.frames = best;
  choice.adjusted = best != requested;
  return choice;
}

// The legacy contiguous 0/1/2-channel selection as a physical channel list.
inline std::vector<std::uint32_t> legacyInputList(std::uint32_t count, std::uint32_t offset) {
  std::vector<std::uint32_t> list;
  for (std::uint32_t c = 0; c < count; ++c) list.push_back(offset + c);
  return list;
}
// Ascending, unique, at most 32 entries: the callback delivers them in this order.
inline void validateInputList(const std::vector<std::uint32_t>& list) {
  if (list.size() > kMaxInputChannels) throw std::invalid_argument("At most 32 input channels can be opened at once.");
  for (std::size_t i = 0; i < list.size(); ++i) {
    if (list[i] > kMaxPhysicalChannel) throw std::invalid_argument("Input channel index is out of range.");
    if (i && list[i] <= list[i - 1]) throw std::invalid_argument("Input channels must be listed in ascending order without duplicates.");
  }
}
inline bool inputsAvailable(const std::vector<std::uint32_t>& list, std::uint32_t available) noexcept {
  return list.empty() || list.back() < available;
}
// Mono devices play the stereo mix on channel 0.
inline bool outputPairAvailable(std::uint32_t offset, std::uint32_t available) noexcept {
  return offset + 2 <= available || (available == 1 && offset == 0);
}

// Numeric ma_result values; device.cpp static_asserts them against miniaudio so
// this header (and its test) does not need the miniaudio headers.
inline DeviceErrorCode classifyMaResult(int result) noexcept {
  switch (result) {
    case -19:   // MA_BUSY (AUDCLNT_E_DEVICE_IN_USE)
    case -6:    // MA_ACCESS_DENIED (exclusive refused, or privacy settings)
    case -23:   // MA_ALREADY_IN_USE
    case -202:  // MA_SHARE_MODE_NOT_SUPPORTED (exclusive mode not allowed)
      return DeviceErrorCode::InUse;
    case -204:  // MA_NO_DEVICE
    case -7:    // MA_DOES_NOT_EXIST
    case -22:   // MA_UNAVAILABLE (AUDCLNT_E_DEVICE_INVALIDATED)
      return DeviceErrorCode::NotFound;
    case -200:  // MA_FORMAT_NOT_SUPPORTED: shared mode resamples, so this is the exclusive rate
      return DeviceErrorCode::SampleRateUnsupported;
    default:
      return DeviceErrorCode::DriverInitFailed;
  }
}

enum class AsioStep { Load, Channels, SampleRate, BufferSize, CreateBuffers, Start };
// ASIOError values from asio.h, kept numeric for the same reason as above.
inline DeviceErrorCode classifyAsioFailure(AsioStep step, long error) noexcept {
  constexpr long notPresent = -1000, hwMalfunction = -999, invalidParameter = -998, invalidMode = -997;
  if (error == notPresent) return step == AsioStep::Start ? DeviceErrorCode::Lost : DeviceErrorCode::NotFound;
  switch (step) {
    case AsioStep::Channels: return DeviceErrorCode::ChannelsUnavailable;
    case AsioStep::SampleRate: return DeviceErrorCode::SampleRateUnsupported;
    case AsioStep::BufferSize: case AsioStep::CreateBuffers:
      return error == invalidMode || error == invalidParameter ? DeviceErrorCode::BufferUnsupported : DeviceErrorCode::DriverInitFailed;
    case AsioStep::Start: return error == hwMalfunction ? DeviceErrorCode::Lost : DeviceErrorCode::DriverInitFailed;
    default: return DeviceErrorCode::DriverInitFailed;
  }
}

// A reset or buffer-size request comes from the driver's own control panel.
inline bool followsDriverBuffer(DeviceFault fault) noexcept {
  return fault == DeviceFault::ResetRequest || fault == DeviceFault::BufferSizeChange;
}
inline const char* faultMessage(DeviceFault fault) noexcept {
  switch (fault) {
    case DeviceFault::ResetRequest: return "The audio driver requested a reset.";
    case DeviceFault::BufferSizeChange: return "The audio driver changed its buffer size.";
    case DeviceFault::SampleRateChange: return "The audio driver changed its sample rate.";
    case DeviceFault::Resync: return "The audio driver lost synchronization.";
    case DeviceFault::Stopped: return "The audio device stopped unexpectedly.";
    case DeviceFault::Interrupted: return "The audio device was interrupted.";
    case DeviceFault::Rerouted: return "The audio device route changed.";
    default: return "";
  }
}

// Reopen schedule after a fault: 0.25 s, 0.5 s, 1 s, 2 s, then every 2 s. Other
// failures give up once the next attempt would start more than 30 s after the
// fault; a vanished device is polled at the same interval until it returns.
class RecoveryBackoff {
 public:
  static constexpr std::int64_t kGiveUpMs = 30000;
  static std::int64_t delayMs(std::uint32_t attempt) noexcept {
    constexpr std::int64_t delays[] = {250, 500, 1000, 2000};
    return delays[std::min<std::uint32_t>(attempt, 3)];
  }
  void begin(std::int64_t nowMs) noexcept {
    active_ = true; gaveUp_ = false; attempts_ = 0; started_ = nowMs; next_ = nowMs + delayMs(0);
  }
  [[nodiscard]] bool due(std::int64_t nowMs) const noexcept { return active_ && nowMs >= next_; }
  void failed(std::int64_t nowMs, bool deviceMissing) noexcept {
    if (!active_) return;
    ++attempts_;
    const auto next = nowMs + delayMs(attempts_);
    if (!deviceMissing && next - started_ > kGiveUpMs) { active_ = false; gaveUp_ = true; return; }
    next_ = next;
  }
  void succeeded() noexcept { active_ = false; gaveUp_ = false; attempts_ = 0; }
  void cancel() noexcept { active_ = false; gaveUp_ = false; attempts_ = 0; }
  [[nodiscard]] bool active() const noexcept { return active_; }
  [[nodiscard]] bool gaveUp() const noexcept { return gaveUp_; }
  [[nodiscard]] std::uint32_t attempts() const noexcept { return attempts_; }
  [[nodiscard]] std::int64_t nextAttemptMs() const noexcept { return next_; }
 private:
  bool active_ = false, gaveUp_ = false;
  std::uint32_t attempts_ = 0;
  std::int64_t started_ = 0, next_ = 0;
};

} // namespace device_logic
} // namespace garak

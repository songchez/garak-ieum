#include "garak/device.hpp"
#include "garak/asio_samples.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <stdexcept>
#include <string_view>
#include <utility>

#ifndef GARAK_ENABLE_DEVICES
#define GARAK_ENABLE_DEVICES 0
#endif
#ifndef GARAK_ENABLE_ASIO
#define GARAK_ENABLE_ASIO 0
#endif

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <objbase.h>
#endif

#if GARAK_ENABLE_DEVICES
#define MA_ENABLE_ONLY_SPECIFIC_BACKENDS
#if defined(_WIN32)
#define MA_ENABLE_WASAPI
#elif defined(__APPLE__)
#define MA_ENABLE_COREAUDIO
#else
#define MA_ENABLE_NULL
#endif
#define MA_NO_ENCODING
#define MA_NO_DECODING
#define MA_NO_ENGINE
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_NODE_GRAPH
#define MINIAUDIO_IMPLEMENTATION
#include <miniaudio.h>
#endif

#if GARAK_ENABLE_ASIO && defined(_WIN32)
#include <asiosys.h>
#include <asio.h>
#include <iasiodrv.h>
#endif

namespace garak {
namespace {

using device_logic::kDriverBuffer;
[[maybe_unused]] constexpr std::uint32_t kChunkFrames = 4096;
[[maybe_unused]] constexpr std::uint32_t kMaxDeviceChannels = 64;
[[maybe_unused]] constexpr std::uint32_t kMaxProbeChannels = 256;

void validate(const DeviceConfig& config, DeviceCallback cb) {
  if (!cb) throw std::invalid_argument("Audio device callback is required.");
  if (config.sampleRate < 8000 || config.sampleRate > 192000)
    throw std::invalid_argument("Audio sample rate must be between 8000 and 192000 Hz.");
  if (config.bufferFrames != kDriverBuffer && (config.bufferFrames < 16 || config.bufferFrames > 16384))
    throw std::invalid_argument("Audio buffer must contain 16 to 16384 frames.");
  device_logic::validateInputList(resolvedInputList(config));
  if (config.outputChannelOffset > device_logic::kMaxPhysicalChannel)
    throw std::invalid_argument("Invalid physical audio channel selection.");
}

[[maybe_unused]] std::string channelName(bool input, std::uint32_t index) {
  return std::string(input ? "Input " : "Output ") + std::to_string(index + 1);
}
// Names of the opened channels: inputs in list order, then the output pair.
[[maybe_unused]] void nameOpenChannels(DeviceState& state, const std::vector<ProbeChannel>& inputs, const std::vector<ProbeChannel>& outputs) {
  state.inputNames.clear(); state.outputNames.clear();
  for (const auto c : state.inputChannelList)
    state.inputNames.push_back(c < inputs.size() ? inputs[c].name : channelName(true, c));
  for (std::uint32_t c = state.outputChannelOffset; c < state.outputChannelOffset + std::min(2u, state.outputChannels); ++c)
    state.outputNames.push_back(c < outputs.size() ? outputs[c].name : channelName(false, c));
}
[[maybe_unused]] std::vector<ProbeChannel> genericChannels(bool input, std::uint32_t count) {
  std::vector<ProbeChannel> result;
  for (std::uint32_t c = 0; c < std::min(count, kMaxProbeChannels); ++c) result.push_back({c, channelName(input, c)});
  return result;
}

struct Adapter {
  virtual ~Adapter() = default;
  virtual void start() = 0;
  virtual void stop() = 0;
  virtual void service() = 0;
  virtual DeviceState state() const = 0;
  // Set from driver notifications; DeviceHost::service closes and reopens.
  virtual DeviceFault fault() const = 0;
  // The open driver's report, when it has one that a fresh probe cannot give
  // without reopening (ASIO). Empty means probing is non-invasive anyway.
  virtual std::optional<DeviceProbe> probe() { return std::nullopt; }
  virtual std::uint32_t driverPreferredBuffer() const { return 0; }
  virtual bool followedDriverBuffer() const { return false; }
  virtual void panel() { throw std::runtime_error("This backend has no ASIO control panel."); }
  virtual void clockSource(std::int32_t) { throw std::runtime_error("This audio device does not offer clock source selection."); }
  virtual void directMonitoring(bool) { throw std::runtime_error("This audio device does not offer direct monitoring control."); }
};

#if defined(_WIN32)
std::string utf8(const wchar_t* text) {
  if (!text || !*text) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
  if (n <= 1) return {};
  std::string result(std::size_t(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text, -1, result.data(), n, nullptr, nullptr);
  result.pop_back();
  return result;
}
[[maybe_unused]] std::wstring wide(const std::string& text) {
  const int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.c_str(), -1, nullptr, 0);
  if (n <= 0) throw std::runtime_error("Invalid UTF-8 device identifier.");
  std::wstring result(std::size_t(n), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.c_str(), -1, result.data(), n);
  result.pop_back();
  return result;
}
#endif

#if GARAK_ENABLE_DEVICES
static_assert(MA_BUSY == -19 && MA_ACCESS_DENIED == -6 && MA_ALREADY_IN_USE == -23 && MA_SHARE_MODE_NOT_SUPPORTED == -202 &&
              MA_NO_DEVICE == -204 && MA_DOES_NOT_EXIST == -7 && MA_UNAVAILABLE == -22 && MA_FORMAT_NOT_SUPPORTED == -200,
              "device_logic::classifyMaResult mirrors these miniaudio result values");

ma_backend maBackend(const std::string& name) {
#if defined(_WIN32)
  if (name == "wasapi") return ma_backend_wasapi;
#elif defined(__APPLE__)
  if (name == "coreaudio") return ma_backend_coreaudio;
#endif
  throw std::runtime_error("Requested native audio backend is not available on this platform: " + name);
}
std::string deviceId(const ma_device_id& id, const std::string& backend) {
#if defined(_WIN32)
  if (backend == "wasapi") return utf8(reinterpret_cast<const wchar_t*>(id.wasapi));
#elif defined(__APPLE__)
  if (backend == "coreaudio") return std::string(id.coreaudio);
#endif
  throw std::runtime_error("Unsupported native device identifier.");
}
struct MaContext {
  ma_context value{};
  explicit MaContext(const std::string& backend) {
    const auto selected = maBackend(backend);
    auto config = ma_context_config_init();
    // Verified in the pinned miniaudio 0.11.26 source: WASAPI has no backend data
    // loop, so ma_worker_thread runs our callback on a thread created with this
    // context priority (default "highest" = THREAD_PRIORITY_HIGHEST; "realtime" =
    // THREAD_PRIORITY_TIME_CRITICAL). That same worker thread runs
    // ma_device_start__wasapi_nolock, which joins MMCSS through
    // AvSetMmThreadCharacteristicsA only when device wasapi.usage is not default
    // (see MaAdapter). Core Audio is an asynchronous backend: it renders on its own
    // real-time IOProc thread and miniaudio creates no worker thread for it.
#if defined(_WIN32)
    config.threadPriority = ma_thread_priority_realtime;
#endif
    const auto result = ma_context_init(&selected, 1, &config, &value);
    if (result != MA_SUCCESS)
      throw DeviceError(DeviceErrorCode::DriverInitFailed, "Cannot initialize " + backend + ": " + ma_result_description(result));
  }
  ~MaContext() { ma_context_uninit(&value); }
  MaContext(const MaContext&) = delete;
  MaContext& operator=(const MaContext&) = delete;
};
std::vector<DeviceInfo> enumerateMa(const std::string& backend) {
  MaContext context(backend);
  ma_device_info *outputs = nullptr, *inputs = nullptr;
  ma_uint32 outputCount = 0, inputCount = 0;
  const auto result = ma_context_get_devices(&context.value, &outputs, &outputCount, &inputs, &inputCount);
  if (result != MA_SUCCESS) throw std::runtime_error("Cannot enumerate " + backend + ": " + ma_result_description(result));
  std::vector<DeviceInfo> list;
  const auto add = [&](ma_device_info* entries, ma_uint32 count, bool input) {
    for (ma_uint32 n = 0; n < count; ++n) {
      ma_device_info detail{};
      if (ma_context_get_device_info(&context.value, input ? ma_device_type_capture : ma_device_type_playback,
                                    &entries[n].id, &detail) != MA_SUCCESS) detail = entries[n];
      DeviceInfo info;
      info.id = deviceId(detail.id, backend);
      info.name = detail.name;
      info.backend = backend;
      info.isDefault = detail.isDefault != 0;
      for (ma_uint32 f = 0; f < detail.nativeDataFormatCount; ++f) {
        const auto& format = detail.nativeDataFormats[f];
        if (input) info.inputChannels = std::max(info.inputChannels, format.channels);
        else info.outputChannels = std::max(info.outputChannels, format.channels);
        if (format.sampleRate && std::find(info.sampleRates.begin(), info.sampleRates.end(), format.sampleRate) == info.sampleRates.end())
          info.sampleRates.push_back(format.sampleRate);
      }
      list.push_back(std::move(info));
    }
  };
  add(outputs, outputCount, false);
  add(inputs, inputCount, true);
  return list;
}
// miniaudio reads endpoint formats without opening a stream, so this never
// disturbs a running device. WASAPI capture and render endpoints have separate
// IDs; Core Audio may list one ID for both directions.
DeviceProbe probeMa(MaContext& context, const std::string& backend, const std::string& wanted) {
  ma_device_info *outputs = nullptr, *inputs = nullptr;
  ma_uint32 outputCount = 0, inputCount = 0;
  const auto listed = ma_context_get_devices(&context.value, &outputs, &outputCount, &inputs, &inputCount);
  if (listed != MA_SUCCESS)
    throw DeviceError(device_logic::classifyMaResult(int(listed)), std::string("Cannot enumerate audio devices: ") + ma_result_description(listed));
  const bool byDefault = wanted.empty() || wanted == "default";
  DeviceProbe probe;
  probe.backend = backend;
  probe.id = byDefault ? "default" : wanted;
  bool found = false;
  const auto read = [&](ma_device_info* entries, ma_uint32 count, bool input) {
    for (ma_uint32 i = 0; i < count; ++i) {
      if (byDefault ? !entries[i].isDefault : deviceId(entries[i].id, backend) != wanted) continue;
      ma_device_info detail{};
      if (ma_context_get_device_info(&context.value, input ? ma_device_type_capture : ma_device_type_playback,
                                    &entries[i].id, &detail) != MA_SUCCESS) detail = entries[i];
      found = true;
      if (probe.name.empty()) probe.name = detail.name;
      std::uint32_t channels = 0;
      for (ma_uint32 f = 0; f < detail.nativeDataFormatCount; ++f) {
        const auto& format = detail.nativeDataFormats[f];
        channels = std::max<std::uint32_t>(channels, format.channels);
        if (format.sampleRate && std::find(probe.sampleRates.begin(), probe.sampleRates.end(), format.sampleRate) == probe.sampleRates.end())
          probe.sampleRates.push_back(format.sampleRate);
      }
      (input ? probe.inputs : probe.outputs) = genericChannels(input, channels);
      return;
    }
  };
  read(outputs, outputCount, false);
  read(inputs, inputCount, true);
  if (!found) throw DeviceError(DeviceErrorCode::NotFound, "The selected audio device is not connected.");
  std::sort(probe.sampleRates.begin(), probe.sampleRates.end());
  if (probe.sampleRates.size() == 1) probe.currentSampleRate = probe.sampleRates.front();
  return probe;
}
ma_device_id findMaId(MaContext& context, const std::string& backend, const std::string& wanted, bool input) {
  ma_device_info *outputs = nullptr, *inputs = nullptr;
  ma_uint32 outputCount = 0, inputCount = 0;
  const auto listed = ma_context_get_devices(&context.value, &outputs, &outputCount, &inputs, &inputCount);
  if (listed != MA_SUCCESS)
    throw DeviceError(device_logic::classifyMaResult(int(listed)), std::string("Cannot enumerate audio devices: ") + ma_result_description(listed));
  auto* entries = input ? inputs : outputs;
  const auto count = input ? inputCount : outputCount;
  for (ma_uint32 i = 0; i < count; ++i) if (deviceId(entries[i].id, backend) == wanted) return entries[i].id;
  throw DeviceError(DeviceErrorCode::NotFound, "The selected " + std::string(input ? "input" : "output") + " device is not connected. Select it again explicitly.");
}

class MaAdapter final : public Adapter {
 public:
  MaAdapter(const DeviceConfig& config, DeviceCallback cb, void* user)
      : context_(config.backend), config_(config), callback_(cb), user_(user), inputs_(resolvedInputList(config)) {
    ma_device_config native = ma_device_config_init(inputs_.empty() ? ma_device_type_playback : ma_device_type_duplex);
    native.sampleRate = config.sampleRate;
    // 0 ("driver") lets miniaudio pick its low-latency default period.
    native.periodSizeInFrames = config.bufferFrames;
    native.performanceProfile = ma_performance_profile_low_latency;
    native.noFixedSizedCallback = MA_TRUE;
    native.playback.format = ma_format_f32;
    native.playback.channels = 0; // Keep physical channel indices; map ourselves.
    native.capture.format = ma_format_f32;
    native.capture.channels = 0;
    native.dataCallback = &MaAdapter::audio;
    native.notificationCallback = &MaAdapter::notification;
    native.pUserData = this;
    native.playback.shareMode = config.exclusive ? ma_share_mode_exclusive : ma_share_mode_shared;
    native.capture.shareMode = native.playback.shareMode;
    // "Pro Audio" MMCSS task for the WASAPI worker thread (see MaContext).
    native.wasapi.usage = ma_wasapi_usage_pro_audio;
    if (!config.outputDeviceId.empty() && config.outputDeviceId != "default") {
      outputId_ = findMaId(context_, config.backend, config.outputDeviceId, false);
      native.playback.pDeviceID = &outputId_;
    }
    if (!inputs_.empty() && !config.inputDeviceId.empty() && config.inputDeviceId != "default") {
      inputId_ = findMaId(context_, config.backend, config.inputDeviceId, true);
      native.capture.pDeviceID = &inputId_;
    }
    const auto result = ma_device_init(&context_.value, &native, &device_);
    if (result != MA_SUCCESS) throw failure(result, "open the selected audio device");
    initialized_ = true;
    try {
      if (!device_.playback.channels || device_.playback.channels > kMaxDeviceChannels ||
          device_.capture.channels > kMaxDeviceChannels)
        throw std::runtime_error("The audio device has an unsupported channel layout.");
      if (!device_logic::inputsAvailable(inputs_, device_.capture.channels)) {
        DeviceErrorDetails details; details.availableInputs = device_.capture.channels;
        throw DeviceError(DeviceErrorCode::ChannelsUnavailable, "The selected input channel does not exist on this device.", details);
      }
      if (!device_logic::outputPairAvailable(config.outputChannelOffset, device_.playback.channels)) {
        DeviceErrorDetails details; details.availableOutputs = device_.playback.channels;
        throw DeviceError(DeviceErrorCode::ChannelsUnavailable, "The selected stereo output pair does not exist on this device.", details);
      }
      input_.assign(std::size_t(kChunkFrames) * std::max<std::size_t>(1, inputs_.size()), 0.f);
      const bool capture = !inputs_.empty();
      initial_.configured = true;
      initial_.backend = config.backend;
      initial_.inputDeviceId = capture ? deviceId(device_.capture.id, config.backend) : "";
      initial_.outputDeviceId = deviceId(device_.playback.id, config.backend);
      initial_.name = device_.playback.name;
      initial_.sampleRate = device_.sampleRate;
      initial_.bufferFrames = device_.playback.internalPeriodSizeInFrames;
      initial_.bufferAdjusted = config.bufferFrames != kDriverBuffer && initial_.bufferFrames != config.bufferFrames;
      initial_.inputChannelList = inputs_;
      initial_.inputChannels = std::uint32_t(inputs_.size());
      initial_.inputChannelOffset = capture ? inputs_.front() : 0;
      initial_.outputChannelOffset = config.outputChannelOffset;
      initial_.outputChannels = device_.playback.channels;
      initial_.inputDeviceSampleRate = capture ? device_.capture.internalSampleRate : 0;
      initial_.outputDeviceSampleRate = device_.playback.internalSampleRate;
      initial_.resampling = device_.playback.internalSampleRate != device_.sampleRate ||
          (capture && device_.capture.internalSampleRate != device_.sampleRate);
      // miniaudio reports no channel names; numbered names match devices.probe.
      nameOpenChannels(initial_, genericChannels(true, device_.capture.channels), genericChannels(false, device_.playback.channels));
    } catch (...) {
      ma_device_uninit(&device_);
      initialized_ = false;
      throw;
    }
  }
  ~MaAdapter() override {
    plannedStop_.store(true, std::memory_order_release);
    if (initialized_) ma_device_uninit(&device_);
  }
  void start() override {
    if (fault_.load()) throw std::runtime_error("The audio device requires reconfiguration.");
    plannedStop_.store(false, std::memory_order_release);
    const auto result = ma_device_start(&device_);
    if (result != MA_SUCCESS) {
      plannedStop_.store(true, std::memory_order_release);
      throw failure(result, "start audio");
    }
    running_.store(true, std::memory_order_release);
  }
  void stop() override {
    plannedStop_.store(true, std::memory_order_release);
    if (ma_device_is_started(&device_)) {
      const auto result = ma_device_stop(&device_);
      if (result != MA_SUCCESS) throw std::runtime_error("Cannot stop the audio device: " + std::string(ma_result_description(result)));
    }
    running_.store(false, std::memory_order_release);
  }
  void service() override {}
  DeviceFault fault() const override {
    switch (fault_.load(std::memory_order_acquire)) {
      case 1: return DeviceFault::Stopped;
      case 2: return DeviceFault::Interrupted;
      case 3: return DeviceFault::Rerouted;
      default: return DeviceFault::None;
    }
  }
  DeviceState state() const override {
    DeviceState result = initial_;
    result.running = running_.load(std::memory_order_acquire);
    result.callbacks = callbackCount_.load(std::memory_order_relaxed);
    result.discontinuities = discontinuities_.load(std::memory_order_relaxed);
    if (const auto observed = observedFrames_.load(std::memory_order_relaxed)) result.bufferFrames = observed;
    if (const auto f = fault(); f != DeviceFault::None) {
      result.error = device_logic::faultMessage(f);
      result.errorCode = deviceErrorCodeName(DeviceErrorCode::Lost);
    }
    // miniaudio does not expose a portable measured/input/output driver latency
    // query. Keep these optional fields empty rather than inventing 2*buffer.
    return result;
  }
 private:
  DeviceError failure(ma_result result, const std::string& action) {
    const auto code = device_logic::classifyMaResult(int(result));
    std::string message = "Cannot " + action + ": " + ma_result_description(result) + ".";
    DeviceErrorDetails details;
    if (code == DeviceErrorCode::InUse)
      message += " Another application may be using it exclusively, or system privacy settings may block microphone access.";
    if (code == DeviceErrorCode::SampleRateUnsupported) {
      message = "The audio device cannot run at " + std::to_string(config_.sampleRate) + " Hz in this mode.";
      try { details.supportedSampleRates = probeMa(context_, config_.backend, config_.outputDeviceId).sampleRates; } catch (...) {}
    }
    return DeviceError(code, message, std::move(details));
  }
  static void notification(const ma_device_notification* notification) noexcept {
    auto& self = *static_cast<MaAdapter*>(notification->pDevice->pUserData);
    if (notification->type == ma_device_notification_type_stopped && !self.plannedStop_.load(std::memory_order_acquire)) self.fault_.store(1);
    if (notification->type == ma_device_notification_type_interruption_began) self.fault_.store(2);
    if (notification->type == ma_device_notification_type_rerouted) self.fault_.store(3);
    if (self.fault_.load()) self.discontinuities_.fetch_add(1, std::memory_order_relaxed);
  }
  static void audio(ma_device* device, void* output, const void* input, ma_uint32 frames) noexcept {
    auto& self = *static_cast<MaAdapter*>(device->pUserData);
    auto* out = static_cast<float*>(output);
    const auto* in = static_cast<const float*>(input);
    const auto outputChannels = device->playback.channels, inputChannels = device->capture.channels;
    std::fill_n(out, std::size_t(frames) * outputChannels, 0.f);
    if (self.fault_.load(std::memory_order_relaxed)) return;
    self.observedFrames_.store(frames, std::memory_order_relaxed);
    self.callbackCount_.fetch_add(1, std::memory_order_relaxed);
    const auto selected = std::uint32_t(self.inputs_.size());
    const auto* map = self.inputs_.data();
    for (std::uint32_t offset = 0; offset < frames; offset += kChunkFrames) {
      const auto count = std::min(kChunkFrames, frames - offset);
      for (std::uint32_t f = 0; f < count; ++f)
        for (std::uint32_t c = 0; c < selected; ++c)
          self.input_[f * selected + c] = in ? in[std::size_t(offset + f) * inputChannels + map[c]] : 0.f;
      std::fill_n(self.output_.data(), count * 2, 0.f);
      self.callback_(self.user_, self.output_.data(), selected ? self.input_.data() : nullptr, count, selected);
      for (std::uint32_t f = 0; f < count; ++f) {
        const float left = std::isfinite(self.output_[f * 2]) ? std::clamp(self.output_[f * 2], -1.f, 1.f) : 0.f;
        const float right = std::isfinite(self.output_[f * 2 + 1]) ? std::clamp(self.output_[f * 2 + 1], -1.f, 1.f) : 0.f;
        if (outputChannels == 1) out[offset + f] = (left + right) * .5f;
        else {
          out[(offset + f) * outputChannels + self.config_.outputChannelOffset] = left;
          out[(offset + f) * outputChannels + self.config_.outputChannelOffset + 1] = right;
        }
      }
    }
  }
  MaContext context_;
  DeviceConfig config_;
  DeviceCallback callback_;
  void* user_;
  std::vector<std::uint32_t> inputs_;
  ma_device device_{};
  ma_device_id inputId_{}, outputId_{};
  bool initialized_ = false;
  DeviceState initial_;
  std::vector<float> input_;
  std::array<float, kChunkFrames * 2> output_{};
  std::atomic<bool> running_{false}, plannedStop_{true};
  std::atomic<int> fault_{0};
  std::atomic<std::uint32_t> observedFrames_{0};
  std::atomic<std::uint64_t> callbackCount_{0}, discontinuities_{0};
};
#endif

#if GARAK_ENABLE_ASIO && defined(_WIN32)
static_assert(ASE_NotPresent == -1000 && ASE_HWMalfunction == -999 && ASE_InvalidParameter == -998 && ASE_InvalidMode == -997,
              "device_logic::classifyAsioFailure mirrors these ASIO error values");
constexpr std::size_t kMaxAsioBuffers = device_logic::kMaxInputChannels + 2;

// ASIO channel, clock and error strings are 8-bit text in the system code page.
std::string ansi(const char* text, std::size_t maximum) {
  std::size_t length = 0;
  while (length < maximum && text[length]) ++length;
  if (!length) return {};
  const int n = MultiByteToWideChar(CP_ACP, 0, text, int(length), nullptr, 0);
  if (n <= 0) return {};
  std::wstring converted(std::size_t(n), L'\0');
  MultiByteToWideChar(CP_ACP, 0, text, int(length), converted.data(), n);
  return utf8(converted.c_str());
}

struct AsioRegistryEntry {
  DeviceInfo info;
  CLSID clsid{};
};
std::vector<AsioRegistryEntry> asioEntries() {
  std::vector<AsioRegistryEntry> result;
  HKEY root = nullptr;
  if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\ASIO", 0, KEY_READ | KEY_WOW64_64KEY, &root) != ERROR_SUCCESS) return result;
  for (DWORD index = 0;; ++index) {
    wchar_t keyName[256]{};
    DWORD size = DWORD(std::size(keyName));
    const auto next = RegEnumKeyExW(root, index, keyName, &size, nullptr, nullptr, nullptr, nullptr);
    if (next == ERROR_NO_MORE_ITEMS) break;
    if (next != ERROR_SUCCESS) continue;
    HKEY child = nullptr;
    if (RegOpenKeyExW(root, keyName, 0, KEY_READ | KEY_WOW64_64KEY, &child) != ERROR_SUCCESS) continue;
    wchar_t id[128]{}, description[512]{};
    DWORD idBytes = sizeof(id), descriptionBytes = sizeof(description);
    const auto read = RegGetValueW(child, nullptr, L"CLSID", RRF_RT_REG_SZ, nullptr, id, &idBytes);
    RegGetValueW(child, nullptr, L"Description", RRF_RT_REG_SZ, nullptr, description, &descriptionBytes);
    RegCloseKey(child);
    AsioRegistryEntry entry;
    if (read != ERROR_SUCCESS || FAILED(CLSIDFromString(id, &entry.clsid))) continue;
    wchar_t canonical[40]{};
    StringFromGUID2(entry.clsid, canonical, int(std::size(canonical)));
    entry.info.id = utf8(canonical);
    entry.info.name = utf8(*description ? description : keyName);
    entry.info.backend = "asio";
    // Do not instantiate every installed driver just to fill a device list.
    // Port counts/rates/buffers become known after explicitly opening a driver.
    result.push_back(std::move(entry));
  }
  RegCloseKey(root);
  return result;
}
AsioRegistryEntry findAsio(const std::string& id) {
  if (id.empty() || id == "default") throw DeviceError(DeviceErrorCode::NotFound, "Select an installed ASIO driver explicitly.");
  auto entries = asioEntries();
  const auto selected = std::find_if(entries.begin(), entries.end(), [&](const auto& e) { return e.info.id == id; });
  if (selected == entries.end())
    throw DeviceError(DeviceErrorCode::NotFound, "The selected ASIO driver is not installed in the 64-bit registry.");
  return std::move(*selected);
}

// A loaded and initialized driver instance (COM object + message window).
// ASIO drivers are single-client: init() commonly fails while another
// application holds the interface, which the message says explicitly.
class AsioDriver {
 public:
  explicit AsioDriver(const AsioRegistryEntry& entry) {
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(initialized) && initialized != RPC_E_CHANGED_MODE)
      throw DeviceError(DeviceErrorCode::DriverInitFailed, "Cannot initialize COM for ASIO.");
    ownsCom_ = SUCCEEDED(initialized);
    try {
      if (FAILED(CoCreateInstance(entry.clsid, nullptr, CLSCTX_INPROC_SERVER, entry.clsid, reinterpret_cast<void**>(&driver_))) || !driver_)
        throw DeviceError(DeviceErrorCode::DriverInitFailed, "Cannot load the ASIO driver \"" + entry.info.name +
            "\". Reinstall its 64-bit driver, or close another application that may be using it.");
      window_ = CreateWindowExW(0, L"STATIC", L"Garak Ieum Audio Host", WS_OVERLAPPED,
                               0, 0, 1, 1, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
      if (!window_ || !driver_->init(window_)) {
        std::array<char, 128> reason{};
        if (window_) driver_->getErrorMessage(reason.data());
        const auto detail = ansi(reason.data(), reason.size() - 1);
        throw DeviceError(DeviceErrorCode::DriverInitFailed, "The ASIO driver \"" + entry.info.name +
            "\" could not initialize the interface. Another application may be using it, or the interface may be disconnected." +
            (detail.empty() ? std::string() : " Driver message: " + detail));
      }
    } catch (...) { release(); throw; }
  }
  ~AsioDriver() { release(); }
  AsioDriver(const AsioDriver&) = delete;
  AsioDriver& operator=(const AsioDriver&) = delete;
  [[nodiscard]] IASIO* get() const noexcept { return driver_; }
  [[nodiscard]] HWND window() const noexcept { return window_; }
 private:
  void release() noexcept {
    if (driver_) { driver_->Release(); driver_ = nullptr; }
    if (window_) { DestroyWindow(window_); window_ = nullptr; }
    if (ownsCom_) { CoUninitialize(); ownsCom_ = false; }
  }
  IASIO* driver_ = nullptr;
  HWND window_ = nullptr;
  bool ownsCom_ = false;
};

std::vector<ClockSourceInfo> readClocks(IASIO* driver) {
  std::array<ASIOClockSource, 32> clocks{};
  long count = long(clocks.size());
  std::vector<ClockSourceInfo> result;
  if (driver->getClockSources(clocks.data(), &count) != ASE_OK) return result;
  for (long i = 0; i < std::min<long>(count, long(clocks.size())); ++i) {
    const auto& c = clocks[std::size_t(i)];
    auto name = ansi(c.name, sizeof(c.name));
    result.push_back({std::int32_t(c.index), name.empty() ? "Clock " + std::to_string(i + 1) : std::move(name), c.isCurrentSource == ASIOTrue});
  }
  return result;
}
void readLatencies(IASIO* driver, DeviceProbe& probe) {
  long input = 0, output = 0;
  if (driver->getLatencies(&input, &output) == ASE_OK && input >= 0 && output >= 0) {
    probe.inputLatencyFrames = std::uint32_t(input);
    probe.outputLatencyFrames = std::uint32_t(output);
  } else {
    probe.inputLatencyFrames.reset();
    probe.outputLatencyFrames.reset();
  }
}
void readBuffer(IASIO* driver, DeviceProbe& probe) {
  long minimum = 0, maximum = 0, preferred = 0, granularity = 0;
  if (driver->getBufferSize(&minimum, &maximum, &preferred, &granularity) == ASE_OK) {
    probe.buffer = BufferCaps{std::int32_t(minimum), std::int32_t(maximum), std::int32_t(preferred), std::int32_t(granularity)};
    probe.bufferSizes = device_logic::allowedBufferSizes(*probe.buffer);
  } else {
    probe.buffer.reset();
    probe.bufferSizes.clear();
  }
}
// Everything an initialized (not yet started) driver reports. Latencies are
// only reliable after createBuffers; the adapter refreshes them then.
DeviceProbe readAsio(IASIO* driver, const AsioRegistryEntry& entry) {
  DeviceProbe probe;
  probe.id = entry.info.id; probe.name = entry.info.name; probe.backend = "asio";
  long inputs = 0, outputs = 0;
  if (const auto error = driver->getChannels(&inputs, &outputs); error != ASE_OK)
    throw DeviceError(device_logic::classifyAsioFailure(device_logic::AsioStep::Channels, error),
        "Could not query ASIO channels (ASIO error " + std::to_string(error) + ").");
  const auto list = [&](bool input, long count) {
    std::vector<ProbeChannel> channels;
    for (long c = 0; c < std::min<long>(count, long(kMaxProbeChannels)); ++c) {
      ASIOChannelInfo info{};
      info.channel = c; info.isInput = input ? ASIOTrue : ASIOFalse;
      auto name = driver->getChannelInfo(&info) == ASE_OK ? ansi(info.name, sizeof(info.name)) : std::string();
      channels.push_back({std::uint32_t(c), name.empty() ? channelName(input, std::uint32_t(c)) : std::move(name)});
    }
    return channels;
  };
  probe.inputs = list(true, inputs);
  probe.outputs = list(false, outputs);
  for (const auto rate : device_logic::kProbeSampleRates)
    if (driver->canSampleRate(ASIOSampleRate(rate)) == ASE_OK) probe.sampleRates.push_back(rate);
  ASIOSampleRate current = 0;
  if (driver->getSampleRate(&current) == ASE_OK && std::isfinite(current) && current >= 1 && current <= 1e6) {
    probe.currentSampleRate = std::uint32_t(std::llround(current));
    if (std::find(probe.sampleRates.begin(), probe.sampleRates.end(), *probe.currentSampleRate) == probe.sampleRates.end()) {
      probe.sampleRates.push_back(*probe.currentSampleRate);
      std::sort(probe.sampleRates.begin(), probe.sampleRates.end());
    }
  }
  readBuffer(driver, probe);
  probe.clockSources = readClocks(driver);
  probe.canDirectMonitor = driver->future(kAsioCanInputMonitor, nullptr) == ASE_SUCCESS;
  readLatencies(driver, probe);
  return probe;
}
DeviceProbe probeAsio(const std::string& id) {
  const auto entry = findAsio(id);
  AsioDriver driver(entry);
  return readAsio(driver.get(), entry);
}

class AsioAdapter;
std::atomic<AsioAdapter*> activeAsio{nullptr};

class AsioAdapter final : public Adapter {
 public:
  AsioAdapter(const DeviceConfig& config, DeviceCallback callback, void* user)
      : config_(config), callback_(callback), user_(user), inputs_(resolvedInputList(config)) {
    using device_logic::AsioStep;
    if (activeAsio.load()) throw DeviceError(DeviceErrorCode::InUse, "Only one ASIO device can be active in this engine process.");
    if (!config.inputDeviceId.empty() && config.inputDeviceId != config.outputDeviceId && config.inputDeviceId != "default")
      throw std::invalid_argument("ASIO input and output must use the same driver and clock.");
    const auto entry = findAsio(config.outputDeviceId);
    driver_ = std::make_unique<AsioDriver>(entry);
    try {
      auto* asio = driver_->get();
      probe_ = readAsio(asio, entry);
      const auto inputCount = std::uint32_t(inputs_.size());
      if (!device_logic::inputsAvailable(inputs_, std::uint32_t(probe_.inputs.size())) ||
          probe_.outputs.size() < 2 || !device_logic::outputPairAvailable(config.outputChannelOffset, std::uint32_t(probe_.outputs.size()))) {
        DeviceErrorDetails details;
        details.availableInputs = std::uint32_t(probe_.inputs.size()); details.availableOutputs = std::uint32_t(probe_.outputs.size());
        throw DeviceError(DeviceErrorCode::ChannelsUnavailable, "The selected physical ASIO input/output channels do not exist.", details);
      }
      // A saved clock index may belong to another interface; keep the current one then.
      if (config.clockSource && std::any_of(probe_.clockSources.begin(), probe_.clockSources.end(), [&](const auto& c) { return c.index == *config.clockSource; })) {
        (void)asio->setClockSource(long(*config.clockSource));
        probe_.clockSources = readClocks(asio);
      }
      DeviceErrorDetails rates; rates.supportedSampleRates = probe_.sampleRates;
      const auto rateError = [&](ASIOError error, const std::string& message) {
        return DeviceError(device_logic::classifyAsioFailure(AsioStep::SampleRate, error), message + " (ASIO error " + std::to_string(error) + ").", rates);
      };
      if (const auto error = asio->canSampleRate(ASIOSampleRate(config.sampleRate)); error != ASE_OK)
        throw rateError(error, "The ASIO driver cannot run at " + std::to_string(config.sampleRate) + " Hz");
      if (const auto error = asio->setSampleRate(ASIOSampleRate(config.sampleRate)); error != ASE_OK)
        throw rateError(error, "The ASIO driver refused " + std::to_string(config.sampleRate) + " Hz");
      ASIOSampleRate actual = 0;
      if (asio->getSampleRate(&actual) != ASE_OK || !std::isfinite(actual) || std::abs(actual - config.sampleRate) > .5)
        throw DeviceError(DeviceErrorCode::SampleRateUnsupported, "ASIO did not apply the requested sample rate. An external clock may be setting another rate.", rates);
      probe_.currentSampleRate = config.sampleRate;
      // The buffer range may depend on the rate, so read it after setting the rate.
      readBuffer(asio, probe_);
      const auto caps = probe_.buffer.value_or(BufferCaps{});
      const auto choice = device_logic::snapBufferSize(caps, config.bufferFrames, config.previousDriverPreferred);
      if (!choice.frames) {
        DeviceErrorDetails details; if (probe_.buffer) details.buffer = caps;
        throw DeviceError(DeviceErrorCode::BufferUnsupported, "The ASIO driver did not report a usable buffer size. Set one in its control panel.", details);
      }
      frames_ = choice.frames;
      followedDriver_ = choice.followedDriver;
      for (std::uint32_t c = 0; c < inputCount + 2; ++c) {
        auto& buffer = buffers_[c];
        buffer.isInput = c < inputCount ? ASIOTrue : ASIOFalse;
        buffer.channelNum = c < inputCount ? long(inputs_[c]) : long(config.outputChannelOffset + c - inputCount);
        auto& info = channelInfo_[c];
        info.channel = buffer.channelNum;
        info.isInput = buffer.isInput;
        check(asio->getChannelInfo(&info), "query the ASIO channel sample format");
        if (!asio_samples::bytes(int(info.type))) throw std::runtime_error("This ASIO channel uses an unsupported PCM/DSD format.");
      }
      callbacks_.bufferSwitch = &AsioAdapter::bufferSwitch;
      callbacks_.sampleRateDidChange = &AsioAdapter::sampleRateChanged;
      callbacks_.asioMessage = &AsioAdapter::message;
      callbacks_.bufferSwitchTimeInfo = &AsioAdapter::timeInfo;
      input_.assign(std::size_t(kChunkFrames) * std::max<std::size_t>(1, inputCount), 0.f);
      AsioAdapter* expected = nullptr;
      if (!activeAsio.compare_exchange_strong(expected, this))
        throw DeviceError(DeviceErrorCode::InUse, "Only one ASIO device can be active in this engine process.");
      if (const auto error = asio->createBuffers(buffers_.data(), long(inputCount + 2), long(frames_), &callbacks_); error != ASE_OK) {
        DeviceErrorDetails details; details.buffer = caps;
        throw DeviceError(device_logic::classifyAsioFailure(AsioStep::CreateBuffers, error),
            "The ASIO driver could not create " + std::to_string(frames_) + "-frame buffers (ASIO error " + std::to_string(error) + ").", details);
      }
      hasBuffers_ = true;
      for (std::uint32_t c = 0; c < inputCount + 2; ++c)
        for (unsigned half = 0; half < 2; ++half) {
          if (!buffers_[c].buffers[half]) throw std::runtime_error("The ASIO driver returned an invalid buffer.");
          if (c >= inputCount) std::memset(buffers_[c].buffers[half], 0, std::size_t(frames_) * asio_samples::bytes(int(channelInfo_[c].type)));
        }
      postOutput_ = asio->outputReady() == ASE_OK;
      readLatencies(asio, probe_);
      // Direct monitoring is a preference; a driver without it simply reports false.
      if (config.directMonitoring && probe_.canDirectMonitor) {
        try { directMonitoring(true); } catch (const std::exception&) {}
      }
      initial_.configured = true;
      initial_.backend = "asio";
      initial_.inputDeviceId = inputCount ? entry.info.id : "";
      initial_.outputDeviceId = entry.info.id;
      initial_.name = entry.info.name;
      initial_.sampleRate = std::uint32_t(std::llround(actual));
      initial_.bufferFrames = frames_;
      initial_.bufferAdjusted = choice.adjusted;
      initial_.inputChannelList = inputs_;
      initial_.inputChannels = inputCount;
      initial_.inputChannelOffset = inputCount ? inputs_.front() : 0;
      initial_.outputChannelOffset = config.outputChannelOffset;
      initial_.outputChannels = 2;
      initial_.inputDeviceSampleRate = inputCount ? initial_.sampleRate : 0;
      initial_.outputDeviceSampleRate = initial_.sampleRate;
      nameOpenChannels(initial_, probe_.inputs, probe_.outputs);
    } catch (...) { cleanup(); throw; }
  }
  ~AsioAdapter() override { cleanup(); }
  void start() override {
    if (fault_.load()) throw std::runtime_error("The ASIO device requires reconfiguration.");
    if (const auto error = driver_->get()->start(); error != ASE_OK)
      throw DeviceError(device_logic::classifyAsioFailure(device_logic::AsioStep::Start, error),
          "Could not start ASIO (ASIO error " + std::to_string(error) + ").");
    running_.store(true, std::memory_order_release);
  }
  void stop() override {
    if (running_.exchange(false, std::memory_order_acq_rel)) check(driver_->get()->stop(), "stop ASIO");
  }
  void service() override {
    if (latencyChanged_.exchange(false)) readLatencies(driver_->get(), probe_);
  }
  DeviceFault fault() const override { return DeviceFault(fault_.load(std::memory_order_acquire)); }
  DeviceState state() const override {
    DeviceState result = initial_;
    result.running = running_.load(std::memory_order_acquire);
    result.callbacks = callbackCount_.load(std::memory_order_relaxed);
    result.discontinuities = discontinuities_.load(std::memory_order_relaxed);
    result.inputLatencyFrames = probe_.inputLatencyFrames;
    result.outputLatencyFrames = probe_.outputLatencyFrames;
    for (const auto& c : probe_.clockSources) if (c.current) result.clockSource = c.index;
    result.directMonitoring = directMonitoring_;
    if (const auto f = fault(); f != DeviceFault::None) {
      result.error = device_logic::faultMessage(f);
      result.errorCode = deviceErrorCodeName(DeviceErrorCode::Lost);
    }
    return result;
  }
  std::optional<DeviceProbe> probe() override { return probe_; }
  std::uint32_t driverPreferredBuffer() const override {
    return probe_.buffer && probe_.buffer->preferred > 0 ? std::uint32_t(probe_.buffer->preferred) : 0;
  }
  bool followedDriverBuffer() const override { return followedDriver_; }
  void panel() override { check(driver_->get()->controlPanel(), "open the ASIO control panel"); }
  void clockSource(std::int32_t index) override {
    if (std::none_of(probe_.clockSources.begin(), probe_.clockSources.end(), [&](const auto& c) { return c.index == index; }))
      throw std::invalid_argument("This ASIO driver has no clock source " + std::to_string(index) + ".");
    check(driver_->get()->setClockSource(long(index)), "select the ASIO clock source");
    // A clock change may also be followed by a reset request; recovery handles it.
    probe_.clockSources = readClocks(driver_->get());
  }
  void directMonitoring(bool enabled) override {
    if (!probe_.canDirectMonitor) throw std::runtime_error("This ASIO driver does not offer direct monitoring control.");
    // All inputs (-1) to the opened output pair at 0 dB (0x20000000), centered.
    ASIOInputMonitor monitor{};
    monitor.input = -1;
    monitor.output = long(config_.outputChannelOffset);
    monitor.gain = 0x20000000;
    monitor.state = enabled ? ASIOTrue : ASIOFalse;
    monitor.pan = 0x3fffffff;
    // ASIOFuture success is ASE_SUCCESS only; ASE_OK means "not handled".
    if (driver_->get()->future(kAsioSetInputMonitor, &monitor) != ASE_SUCCESS)
      throw std::runtime_error("The ASIO driver refused the direct monitoring change.");
    directMonitoring_ = enabled;
  }
 private:
  static void check(ASIOError result, const char* action) {
    if (result != ASE_OK && result != ASE_SUCCESS) throw std::runtime_error(std::string("Could not ") + action + " (ASIO error " + std::to_string(long(result)) + ").");
  }
  void cleanup() noexcept {
    if (driver_) {
      if (running_.exchange(false)) driver_->get()->stop();
      // Only release the callback slot this adapter claimed.
      AsioAdapter* self = this;
      activeAsio.compare_exchange_strong(self, nullptr, std::memory_order_acq_rel);
      if (hasBuffers_) { driver_->get()->disposeBuffers(); hasBuffers_ = false; }
      driver_.reset();
    }
  }
  void render(long half) noexcept {
    if (half != 0 && half != 1) { fault_.store(int(DeviceFault::Resync)); return; }
    callbackCount_.fetch_add(1, std::memory_order_relaxed);
    const auto inputs = std::uint32_t(inputs_.size());
    for (std::uint32_t offset = 0; offset < frames_; offset += kChunkFrames) {
      const auto count = std::min(kChunkFrames, frames_ - offset);
      for (std::uint32_t f = 0; f < count; ++f)
        for (std::uint32_t c = 0; c < inputs; ++c)
          input_[f * inputs + c] = asio_samples::read(buffers_[c].buffers[half], int(channelInfo_[c].type), offset + f);
      std::fill_n(output_.data(), count * 2, 0.f);
      if (!fault_.load(std::memory_order_relaxed))
        callback_(user_, output_.data(), inputs ? input_.data() : nullptr, count, inputs);
      for (std::uint32_t f = 0; f < count; ++f)
        for (std::uint32_t c = 0; c < 2; ++c)
          asio_samples::write(buffers_[inputs + c].buffers[half], int(channelInfo_[inputs + c].type), offset + f, output_[f * 2 + c]);
    }
    if (postOutput_) driver_->get()->outputReady();
  }
  static void bufferSwitch(long half, ASIOBool) noexcept {
    if (auto* self = activeAsio.load(std::memory_order_acquire)) self->render(half);
  }
  static ASIOTime* timeInfo(ASIOTime* time, long half, ASIOBool direct) noexcept {
    bufferSwitch(half, direct);
    return time;
  }
  static void sampleRateChanged(ASIOSampleRate) noexcept {
    if (auto* self = activeAsio.load(std::memory_order_acquire)) self->raise(DeviceFault::SampleRateChange);
  }
  void raise(DeviceFault fault) noexcept {
    int expected = 0;
    // Keep the first cause: it decides whether recovery follows the driver buffer.
    fault_.compare_exchange_strong(expected, int(fault));
    discontinuities_.fetch_add(1, std::memory_order_relaxed);
  }
  static long message(long selector, long value, void*, double*) noexcept {
    auto* self = activeAsio.load(std::memory_order_acquire);
    if (!self) return 0;
    if (selector == kAsioSelectorSupported)
      return value == kAsioResetRequest || value == kAsioBufferSizeChange || value == kAsioResyncRequest ||
          value == kAsioLatenciesChanged || value == kAsioEngineVersion || value == kAsioSupportsTimeInfo || value == kAsioOverload;
    switch (selector) {
      case kAsioEngineVersion: return 2;
      case kAsioSupportsTimeInfo: return 1;
      // Handled by closing and reopening the driver from DeviceHost::service.
      case kAsioResetRequest: self->raise(DeviceFault::ResetRequest); return 1;
      case kAsioBufferSizeChange: self->raise(DeviceFault::BufferSizeChange); return 1;
      case kAsioResyncRequest: self->raise(DeviceFault::Resync); return 1;
      case kAsioLatenciesChanged: self->latencyChanged_.store(true); return 1;
      case kAsioOverload: self->discontinuities_.fetch_add(1); return 1;
      default: return 0;
    }
  }
  DeviceConfig config_;
  DeviceCallback callback_;
  void* user_;
  std::vector<std::uint32_t> inputs_;
  std::unique_ptr<AsioDriver> driver_;
  bool hasBuffers_ = false, postOutput_ = false, followedDriver_ = false, directMonitoring_ = false;
  std::uint32_t frames_ = 0;
  ASIOCallbacks callbacks_{};
  std::array<ASIOBufferInfo, kMaxAsioBuffers> buffers_{};
  std::array<ASIOChannelInfo, kMaxAsioBuffers> channelInfo_{};
  std::vector<float> input_;
  std::array<float, kChunkFrames * 2> output_{};
  DeviceProbe probe_;
  DeviceState initial_;
  std::atomic<bool> running_{false}, latencyChanged_{false};
  std::atomic<int> fault_{0};
  std::atomic<std::uint64_t> callbackCount_{0}, discontinuities_{0};
};
#endif

std::unique_ptr<Adapter> openAdapter(const DeviceConfig& config, DeviceCallback callback, void* user) {
#if GARAK_ENABLE_ASIO && defined(_WIN32)
  if (config.backend == "asio") return std::make_unique<AsioAdapter>(config, callback, user);
#endif
#if GARAK_ENABLE_DEVICES
  if (config.backend == "wasapi" || config.backend == "coreaudio") return std::make_unique<MaAdapter>(config, callback, user);
#endif
  (void)callback; (void)user;
  throw std::runtime_error("Requested audio backend is unavailable in this build: " + config.backend);
}

} // namespace

struct DeviceHost::Impl {
  using Clock = std::chrono::steady_clock;
  std::unique_ptr<Adapter> device;
  DeviceConfig config;
  DeviceCallback callback = nullptr;
  void* user = nullptr;
  bool hasConfig = false, wantRunning = false, suspended = false;
  device_logic::RecoveryBackoff backoff;
  // Reopened adapters count from zero; keep the device totals monotonic.
  std::uint64_t recoveries = 0, lostDiscontinuities = 0;
  // Reported while the device is closed for recovery or suspension.
  DeviceState last;
  std::string faultText, recoveryError;
  DeviceErrorCode recoveryCode = DeviceErrorCode::None;
  Clock::time_point epoch = Clock::now();
  [[nodiscard]] std::int64_t nowMs() const {
    return std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - epoch).count();
  }
  // The engine was built for this rate; a reopened device must keep it.
  std::unique_ptr<Adapter> reopen() {
    auto next = openAdapter(config, callback, user);
    if (last.sampleRate && next->state().sampleRate != last.sampleRate)
      throw DeviceError(DeviceErrorCode::SampleRateUnsupported, "The audio device reopened at a different sample rate.");
    if (wantRunning) next->start();
    if (next->followedDriverBuffer()) config.bufferFrames = kDriverBuffer;
    config.previousDriverPreferred = 0;
    return next;
  }
  void attemptRecovery(std::int64_t now) {
    std::string reason;
    DeviceErrorCode code = DeviceErrorCode::DriverInitFailed;
    try {
      device = reopen();
      backoff.succeeded(); ++recoveries;
      recoveryError.clear(); recoveryCode = DeviceErrorCode::None;
      return;
    } catch (const DeviceError& error) { reason = error.what(); code = error.code(); }
    catch (const std::exception& error) { reason = error.what(); }
    device.reset();
    backoff.failed(now, code == DeviceErrorCode::NotFound);
    if (backoff.gaveUp()) {
      recoveryError = faultText + " It could not be reopened: " + reason + " Reapply the audio settings.";
      recoveryCode = code;
    } else {
      recoveryError = faultText + " Reconnecting... (" + reason + ")";
      recoveryCode = DeviceErrorCode::Lost;
    }
  }
};
DeviceHost::DeviceHost() : impl_(std::make_unique<Impl>()) {}
DeviceHost::~DeviceHost() = default;
std::vector<std::string> DeviceHost::availableBackends() {
  std::vector<std::string> result;
#if GARAK_ENABLE_DEVICES && defined(_WIN32)
  result.push_back("wasapi");
#elif GARAK_ENABLE_DEVICES && defined(__APPLE__)
  result.push_back("coreaudio");
#endif
#if GARAK_ENABLE_ASIO && defined(_WIN32)
  result.push_back("asio");
#endif
  return result;
}
std::vector<DeviceInfo> DeviceHost::enumerate(const std::string& requested) {
  const auto backends = availableBackends();
  if (!requested.empty() && std::find(backends.begin(), backends.end(), requested) == backends.end())
    throw std::runtime_error("Audio backend is unavailable in this build: " + requested);
  std::vector<DeviceInfo> result;
  for (const auto& backend : backends) {
    if (!requested.empty() && requested != backend) continue;
#if GARAK_ENABLE_ASIO && defined(_WIN32)
    if (backend == "asio") {
      for (auto& entry : asioEntries()) result.push_back(std::move(entry.info));
      continue;
    }
#endif
#if GARAK_ENABLE_DEVICES
    auto devices = enumerateMa(backend);
    result.insert(result.end(), std::make_move_iterator(devices.begin()), std::make_move_iterator(devices.end()));
#endif
  }
  return result;
}
DeviceProbe DeviceHost::probe(const std::string& backend, const std::string& deviceId) {
  const auto backends = availableBackends();
  if (std::find(backends.begin(), backends.end(), backend) == backends.end())
    throw std::runtime_error("Audio backend is unavailable in this build: " + backend);
  auto& d = *impl_;
  const auto current = d.device ? d.device->state() : DeviceState{};
  const bool open = d.device && current.backend == backend &&
      (deviceId == current.outputDeviceId || (!current.inputDeviceId.empty() && deviceId == current.inputDeviceId));
#if GARAK_ENABLE_ASIO && defined(_WIN32)
  if (backend == "asio") {
    // Reopening the running ASIO driver would tear down its buffers.
    if (open) if (auto cached = d.device->probe()) return *cached;
    return probeAsio(deviceId);
  }
#endif
#if GARAK_ENABLE_DEVICES
  MaContext context(backend);
  auto result = probeMa(context, backend, deviceId);
  if (open) result.currentSampleRate = deviceId == current.outputDeviceId ? current.outputDeviceSampleRate : current.inputDeviceSampleRate;
  return result;
#else
  (void)open;
  throw std::runtime_error("Audio backend is unavailable in this build: " + backend);
#endif
}
void DeviceHost::configure(const DeviceConfig& config, DeviceCallback callback, void* user) {
  validate(config, callback);
  close();
  auto& d = *impl_;
  d.config = config;
  d.config.previousDriverPreferred = 0;
  d.callback = callback;
  d.user = user;
  d.device = openAdapter(d.config, callback, user);
  d.hasConfig = true;
}
void DeviceHost::start() {
  auto& d = *impl_;
  // Suspended or reconnecting devices start once they are open again.
  if (d.hasConfig && (d.suspended || (!d.device && d.backoff.active()) || (d.device && d.device->fault() != DeviceFault::None))) {
    d.wantRunning = true;
    return;
  }
  if (!d.device) throw std::runtime_error("Configure an audio device before starting it.");
  d.device->start();
  d.wantRunning = true;
}
void DeviceHost::stop() {
  auto& d = *impl_;
  // With the device closed for recovery or suspension there is nothing to stop.
  // record.stop calls this to finalize a take after a fault and must not leave
  // the device stopped once it reopens.
  if (!d.device) return;
  d.wantRunning = false;
  d.device->stop();
}
void DeviceHost::close() noexcept {
  auto& d = *impl_;
  d.device.reset();
  d.config = {};
  d.callback = nullptr; d.user = nullptr;
  d.hasConfig = d.wantRunning = d.suspended = false;
  d.backoff.cancel();
  d.recoveries = d.lostDiscontinuities = 0;
  d.last = {};
  d.faultText.clear(); d.recoveryError.clear();
  d.recoveryCode = DeviceErrorCode::None;
}
void DeviceHost::service() {
  auto& d = *impl_;
  if (!d.hasConfig || d.suspended) return;
  const auto now = d.nowMs();
  if (d.device) {
    d.device->service();
    const auto fault = d.device->fault();
    if (fault == DeviceFault::None) return;
    d.last = d.device->state();
    d.lostDiscontinuities += d.last.discontinuities;
    d.config.previousDriverPreferred = device_logic::followsDriverBuffer(fault) ? d.device->driverPreferredBuffer() : 0;
    // Close the faulted driver here, never from its own notification thread.
    d.device.reset();
    d.faultText = device_logic::faultMessage(fault);
    d.recoveryError = d.faultText + " Reconnecting...";
    d.recoveryCode = DeviceErrorCode::Lost;
    d.backoff.begin(now);
    return;
  }
  if (d.backoff.due(now)) d.attemptRecovery(now);
}
void DeviceHost::suspend() {
  auto& d = *impl_;
  if (!d.hasConfig) throw std::runtime_error("Configure an audio device before suspending it.");
  if (d.suspended) return;
  if (d.device) { d.last = d.device->state(); d.lostDiscontinuities += d.last.discontinuities; }
  d.device.reset();
  d.backoff.cancel();
  d.suspended = true;
}
void DeviceHost::resume() {
  auto& d = *impl_;
  if (!d.hasConfig) throw std::runtime_error("Configure an audio device before resuming it.");
  if (!d.suspended) return;
  d.device = d.reopen();
  d.suspended = false;
}
bool DeviceHost::suspended() const noexcept { return impl_->suspended; }
void DeviceHost::setClockSource(std::int32_t index) {
  auto& d = *impl_;
  if (!d.device) throw std::runtime_error("Open the audio device before selecting its clock source.");
  d.device->clockSource(index);
  d.config.clockSource = index;
}
void DeviceHost::setDirectMonitoring(bool enabled) {
  auto& d = *impl_;
  if (!d.device) throw std::runtime_error("Open the audio device before changing direct monitoring.");
  d.device->directMonitoring(enabled);
  d.config.directMonitoring = enabled;
}
DeviceState DeviceHost::state() const {
  const auto& d = *impl_;
  DeviceState result;
  if (d.device) {
    result = d.device->state();
    result.discontinuities += d.lostDiscontinuities;
  } else if (d.hasConfig && (d.suspended || d.backoff.active() || d.backoff.gaveUp())) {
    result = d.last;
    result.running = false;
    result.discontinuities = std::max(result.discontinuities, d.lostDiscontinuities);
    if (d.suspended) { result.error.clear(); result.errorCode.clear(); result.needsReconfigure = false; }
    else {
      result.error = d.recoveryError;
      result.errorCode = deviceErrorCodeName(d.recoveryCode);
      result.needsReconfigure = d.backoff.gaveUp();
    }
  } else return result;
  result.recoveries = d.recoveries;
  result.recovering = !d.device && d.backoff.active();
  result.suspended = d.suspended;
  return result;
}
void DeviceHost::showControlPanel() {
  if (!impl_->device) throw std::runtime_error("Open an ASIO device first.");
  impl_->device->panel();
}

} // namespace garak

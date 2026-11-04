#include "garak/device.hpp"
#include "garak/asio_samples.hpp"

#include <algorithm>
#include <array>
#include <atomic>
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

constexpr std::uint32_t kChunkFrames = 4096;
constexpr std::uint32_t kMaxDeviceChannels = 64;

void validate(const DeviceConfig& config, DeviceCallback cb) {
  if (!cb) throw std::invalid_argument("Audio device callback is required.");
  if (config.sampleRate < 8000 || config.sampleRate > 192000)
    throw std::invalid_argument("Audio sample rate must be between 8000 and 192000 Hz.");
  if (config.bufferFrames < 16 || config.bufferFrames > 16384)
    throw std::invalid_argument("Audio buffer must contain 16 to 16384 frames.");
  if (config.inputChannels > 2 || config.inputChannelOffset + config.inputChannels > kMaxDeviceChannels ||
      config.outputChannelOffset + 2 > kMaxDeviceChannels)
    throw std::invalid_argument("Invalid physical audio channel selection.");
}

struct Adapter {
  virtual ~Adapter() = default;
  virtual void start() = 0;
  virtual void stop() = 0;
  virtual void service() = 0;
  virtual DeviceState state() const = 0;
  virtual void panel() { throw std::runtime_error("This backend has no ASIO control panel."); }
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
std::wstring wide(const std::string& text) {
  const int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.c_str(), -1, nullptr, 0);
  if (n <= 0) throw std::runtime_error("Invalid UTF-8 device identifier.");
  std::wstring result(std::size_t(n), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.c_str(), -1, result.data(), n);
  result.pop_back();
  return result;
}
#endif

#if GARAK_ENABLE_DEVICES
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
    const auto result = ma_context_init(&selected, 1, nullptr, &value);
    if (result != MA_SUCCESS) throw std::runtime_error("Cannot initialize " + backend + ": " + ma_result_description(result));
  }
  ~MaContext() { ma_context_uninit(&value); }
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
ma_device_id findMaId(MaContext& context, const std::string& backend, const std::string& wanted, bool input) {
  ma_device_info *outputs = nullptr, *inputs = nullptr;
  ma_uint32 outputCount = 0, inputCount = 0;
  if (ma_context_get_devices(&context.value, &outputs, &outputCount, &inputs, &inputCount) != MA_SUCCESS)
    throw std::runtime_error("Cannot enumerate audio devices.");
  auto* entries = input ? inputs : outputs;
  const auto count = input ? inputCount : outputCount;
  for (ma_uint32 i = 0; i < count; ++i) if (deviceId(entries[i].id, backend) == wanted) return entries[i].id;
  throw std::runtime_error("The selected " + std::string(input ? "input" : "output") + " device is unavailable. Select it again explicitly.");
}

class MaAdapter final : public Adapter {
 public:
  MaAdapter(const DeviceConfig& config, DeviceCallback cb, void* user)
      : context_(config.backend), config_(config), callback_(cb), user_(user) {
    ma_device_config native = ma_device_config_init(config.inputChannels ? ma_device_type_duplex : ma_device_type_playback);
    native.sampleRate = config.sampleRate;
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
    if (!config.outputDeviceId.empty() && config.outputDeviceId != "default") {
      outputId_ = findMaId(context_, config.backend, config.outputDeviceId, false);
      native.playback.pDeviceID = &outputId_;
    }
    if (config.inputChannels && !config.inputDeviceId.empty() && config.inputDeviceId != "default") {
      inputId_ = findMaId(context_, config.backend, config.inputDeviceId, true);
      native.capture.pDeviceID = &inputId_;
    }
    const auto result = ma_device_init(&context_.value, &native, &device_);
    if (result != MA_SUCCESS) throw std::runtime_error("Cannot open the selected audio device: " + std::string(ma_result_description(result)));
    initialized_ = true;
    try {
      if (!device_.playback.channels || device_.playback.channels > kMaxDeviceChannels ||
          device_.capture.channels > kMaxDeviceChannels)
        throw std::runtime_error("The audio device has an unsupported channel layout.");
      if (config.inputChannels && config.inputChannelOffset + config.inputChannels > device_.capture.channels)
        throw std::runtime_error("The selected input channel does not exist on this device.");
      if (config.outputChannelOffset + 2 > device_.playback.channels &&
          !(device_.playback.channels == 1 && config.outputChannelOffset == 0))
        throw std::runtime_error("The selected stereo output pair does not exist on this device.");
      initial_.configured = true;
      initial_.backend = config.backend;
      initial_.inputDeviceId = config.inputChannels ? deviceId(device_.capture.id, config.backend) : "";
      initial_.outputDeviceId = deviceId(device_.playback.id, config.backend);
      initial_.name = device_.playback.name;
      initial_.sampleRate = device_.sampleRate;
      initial_.bufferFrames = device_.playback.internalPeriodSizeInFrames;
      initial_.inputChannels = config.inputChannels;
      initial_.inputChannelOffset = config.inputChannelOffset;
      initial_.outputChannelOffset = config.outputChannelOffset;
      initial_.outputChannels = device_.playback.channels;
      initial_.inputDeviceSampleRate = config.inputChannels ? device_.capture.internalSampleRate : 0;
      initial_.outputDeviceSampleRate = device_.playback.internalSampleRate;
      initial_.resampling = device_.playback.internalSampleRate != device_.sampleRate ||
          (config.inputChannels && device_.capture.internalSampleRate != device_.sampleRate);
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
      throw std::runtime_error("Cannot start audio: " + std::string(ma_result_description(result)));
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
  void service() override {
    if (fault_.load(std::memory_order_acquire) && running_.load()) stop();
  }
  DeviceState state() const override {
    DeviceState result = initial_;
    result.running = running_.load(std::memory_order_acquire);
    result.callbacks = callbackCount_.load(std::memory_order_relaxed);
    result.discontinuities = discontinuities_.load(std::memory_order_relaxed);
    if (const auto observed = observedFrames_.load(std::memory_order_relaxed)) result.bufferFrames = observed;
    switch (fault_.load(std::memory_order_acquire)) {
      case 1: result.error = "The audio device stopped unexpectedly. Check its connection and reapply the device settings."; break;
      case 2: result.error = "The audio device was interrupted. Reapply the device settings to resume."; break;
      case 3: result.error = "The audio device route changed. Reapply the device settings explicitly."; break;
      default: break;
    }
    result.needsReconfigure = !result.error.empty();
    // miniaudio does not expose a portable measured/input/output driver latency
    // query. Keep these optional fields empty rather than inventing 2*buffer.
    return result;
  }
 private:
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
    for (std::uint32_t offset = 0; offset < frames; offset += kChunkFrames) {
      const auto count = std::min(kChunkFrames, frames - offset);
      const auto selected = self.config_.inputChannels;
      if (selected) {
        for (std::uint32_t f = 0; f < count; ++f)
          for (std::uint32_t c = 0; c < selected; ++c)
            self.input_[f * selected + c] = in ? in[(offset + f) * inputChannels + self.config_.inputChannelOffset + c] : 0.f;
      }
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
  ma_device device_{};
  ma_device_id inputId_{}, outputId_{};
  bool initialized_ = false;
  DeviceState initial_;
  std::array<float, kChunkFrames * 2> input_{}, output_{};
  std::atomic<bool> running_{false}, plannedStop_{true};
  std::atomic<int> fault_{0};
  std::atomic<std::uint32_t> observedFrames_{0};
  std::atomic<std::uint64_t> callbackCount_{0}, discontinuities_{0};
};
#endif

#if GARAK_ENABLE_ASIO && defined(_WIN32)
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
class AsioAdapter;
std::atomic<AsioAdapter*> activeAsio{nullptr};

class AsioAdapter final : public Adapter {
 public:
  AsioAdapter(const DeviceConfig& config, DeviceCallback callback, void* user)
      : config_(config), callback_(callback), user_(user) {
    if (activeAsio.load()) throw std::runtime_error("Only one ASIO device can be active in this engine process.");
    if (config.outputDeviceId.empty() || config.outputDeviceId == "default")
      throw std::runtime_error("Select an installed ASIO driver explicitly.");
    if (!config.inputDeviceId.empty() && config.inputDeviceId != config.outputDeviceId && config.inputDeviceId != "default")
      throw std::runtime_error("ASIO input and output must use the same driver and clock.");
    const auto entries = asioEntries();
    const auto selected = std::find_if(entries.begin(), entries.end(), [&](const auto& e) { return e.info.id == config.outputDeviceId; });
    if (selected == entries.end()) throw std::runtime_error("The selected ASIO driver is not installed in the 64-bit registry.");
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(initialized) && initialized != RPC_E_CHANGED_MODE) throw std::runtime_error("Cannot initialize COM for ASIO.");
    ownsCom_ = SUCCEEDED(initialized);
    try {
      if (FAILED(CoCreateInstance(selected->clsid, nullptr, CLSCTX_INPROC_SERVER, selected->clsid,
                                  reinterpret_cast<void**>(&driver_))) || !driver_)
        throw std::runtime_error("Cannot load the selected ASIO driver.");
      window_ = CreateWindowExW(0, L"STATIC", L"Garak Ieum Audio Host", WS_OVERLAPPED,
                               0, 0, 1, 1, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
      if (!window_ || !driver_->init(window_)) throw std::runtime_error("The ASIO driver could not initialize the selected interface.");
      long inputs = 0, outputs = 0;
      check(driver_->getChannels(&inputs, &outputs), "query ASIO channels");
      if (inputs < 0 || outputs < 2 || config.outputChannelOffset + 2 > std::uint32_t(outputs) ||
          config.inputChannelOffset + config.inputChannels > std::uint32_t(inputs))
        throw std::runtime_error("The selected physical ASIO input/output channels do not exist.");
      check(driver_->canSampleRate(config.sampleRate), "use the requested ASIO sample rate");
      check(driver_->setSampleRate(config.sampleRate), "set the ASIO sample rate");
      ASIOSampleRate actual = 0;
      check(driver_->getSampleRate(&actual), "read the ASIO sample rate");
      if (!std::isfinite(actual) || std::abs(actual - config.sampleRate) > .5)
        throw std::runtime_error("ASIO did not apply the requested sample rate.");
      long minimum = 0, maximum = 0, preferred = 0, granularity = 0;
      check(driver_->getBufferSize(&minimum, &maximum, &preferred, &granularity), "query ASIO buffer sizes");
      const long frames = long(config.bufferFrames);
      bool valid = frames >= minimum && frames <= maximum;
      if (granularity == -1) valid = valid && (frames & (frames - 1)) == 0;
      else if (granularity > 0) valid = valid && ((frames - minimum) % granularity == 0);
      else valid = valid && frames == preferred;
      if (!valid) throw std::runtime_error("The ASIO driver rejected the requested buffer size. Use its control panel or choose a supported size.");
      for (std::uint32_t c = 0; c < config.inputChannels + 2; ++c) {
        auto& buffer = buffers_[c];
        buffer.isInput = c < config.inputChannels ? ASIOTrue : ASIOFalse;
        buffer.channelNum = c < config.inputChannels ? long(config.inputChannelOffset + c)
            : long(config.outputChannelOffset + c - config.inputChannels);
        auto& info = channelInfo_[c];
        info.channel = buffer.channelNum;
        info.isInput = buffer.isInput;
        check(driver_->getChannelInfo(&info), "query the ASIO channel sample format");
        if (!asio_samples::bytes(int(info.type))) throw std::runtime_error("This ASIO channel uses an unsupported PCM/DSD format.");
      }
      callbacks_.bufferSwitch = &AsioAdapter::bufferSwitch;
      callbacks_.sampleRateDidChange = &AsioAdapter::sampleRateChanged;
      callbacks_.asioMessage = &AsioAdapter::message;
      callbacks_.bufferSwitchTimeInfo = &AsioAdapter::timeInfo;
      activeAsio.store(this, std::memory_order_release);
      check(driver_->createBuffers(buffers_.data(), long(config.inputChannels + 2), frames, &callbacks_), "create ASIO buffers");
      hasBuffers_ = true;
      for (std::uint32_t c = 0; c < config.inputChannels + 2; ++c)
        for (unsigned half = 0; half < 2; ++half) {
          if (!buffers_[c].buffers[half]) throw std::runtime_error("The ASIO driver returned an invalid buffer.");
          if (c >= config.inputChannels) std::memset(buffers_[c].buffers[half], 0, std::size_t(frames) * asio_samples::bytes(int(channelInfo_[c].type)));
        }
      postOutput_ = driver_->outputReady() == ASE_OK;
      initial_.configured = true;
      initial_.backend = "asio";
      initial_.inputDeviceId = config.inputChannels ? selected->info.id : "";
      initial_.outputDeviceId = selected->info.id;
      initial_.name = selected->info.name;
      initial_.sampleRate = std::uint32_t(std::llround(actual));
      initial_.bufferFrames = config.bufferFrames;
      initial_.inputChannels = config.inputChannels;
      initial_.inputChannelOffset = config.inputChannelOffset;
      initial_.outputChannelOffset = config.outputChannelOffset;
      initial_.outputChannels = 2;
      initial_.inputDeviceSampleRate = config.inputChannels ? initial_.sampleRate : 0;
      initial_.outputDeviceSampleRate = initial_.sampleRate;
      updateLatencies();
    } catch (...) { cleanup(); throw; }
  }
  ~AsioAdapter() override { cleanup(); }
  void start() override {
    if (fault_.load()) throw std::runtime_error("The ASIO device requires reconfiguration.");
    check(driver_->start(), "start ASIO");
    running_.store(true, std::memory_order_release);
  }
  void stop() override {
    if (running_.exchange(false, std::memory_order_acq_rel)) check(driver_->stop(), "stop ASIO");
  }
  void service() override {
    if (fault_.load(std::memory_order_acquire) && running_.load()) stop();
    if (latencyChanged_.exchange(false)) updateLatencies();
  }
  DeviceState state() const override {
    DeviceState result = initial_;
    result.running = running_.load(std::memory_order_acquire);
    result.callbacks = callbackCount_.load(std::memory_order_relaxed);
    result.discontinuities = discontinuities_.load(std::memory_order_relaxed);
    switch (fault_.load(std::memory_order_acquire)) {
      case 1: result.error = "The ASIO driver requested a reset. Reapply the audio settings."; break;
      case 2: result.error = "The ASIO sample rate changed. Reapply the audio settings."; break;
      case 3: result.error = "The ASIO driver lost synchronization. Check the interface and reapply the audio settings."; break;
      default: break;
    }
    result.needsReconfigure = !result.error.empty();
    return result;
  }
  void panel() override { check(driver_->controlPanel(), "open the ASIO control panel"); }
 private:
  static void check(ASIOError result, const char* action) {
    if (result != ASE_OK && result != ASE_SUCCESS) throw std::runtime_error(std::string("Could not ") + action + " (ASIO error " + std::to_string(long(result)) + ").");
  }
  void updateLatencies() {
    long input = 0, output = 0;
    if (driver_->getLatencies(&input, &output) == ASE_OK && input >= 0 && output >= 0) {
      initial_.inputLatencyFrames = std::uint32_t(input);
      initial_.outputLatencyFrames = std::uint32_t(output);
    } else {
      initial_.inputLatencyFrames.reset();
      initial_.outputLatencyFrames.reset();
    }
  }
  void cleanup() noexcept {
    if (driver_) {
      if (running_.exchange(false)) driver_->stop();
      activeAsio.store(nullptr, std::memory_order_release);
      if (hasBuffers_) { driver_->disposeBuffers(); hasBuffers_ = false; }
      driver_->Release();
      driver_ = nullptr;
    }
    if (window_) { DestroyWindow(window_); window_ = nullptr; }
    if (ownsCom_) { CoUninitialize(); ownsCom_ = false; }
  }
  void render(long half) noexcept {
    if (half != 0 && half != 1) { fault_.store(1); return; }
    callbackCount_.fetch_add(1, std::memory_order_relaxed);
    const auto inputs = config_.inputChannels;
    for (std::uint32_t offset = 0; offset < config_.bufferFrames; offset += kChunkFrames) {
      const auto count = std::min(kChunkFrames, config_.bufferFrames - offset);
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
    if (postOutput_) driver_->outputReady();
  }
  static void bufferSwitch(long half, ASIOBool) noexcept {
    if (auto* self = activeAsio.load(std::memory_order_acquire)) self->render(half);
  }
  static ASIOTime* timeInfo(ASIOTime* time, long half, ASIOBool direct) noexcept {
    bufferSwitch(half, direct);
    return time;
  }
  static void sampleRateChanged(ASIOSampleRate) noexcept {
    if (auto* self = activeAsio.load(std::memory_order_acquire)) self->fault_.store(2);
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
      case kAsioResetRequest: case kAsioBufferSizeChange: self->fault_.store(1); return 1;
      case kAsioResyncRequest: self->fault_.store(3); self->discontinuities_.fetch_add(1); return 1;
      case kAsioLatenciesChanged: self->latencyChanged_.store(true); return 1;
      case kAsioOverload: self->discontinuities_.fetch_add(1); return 1;
      default: return 0;
    }
  }
  DeviceConfig config_;
  DeviceCallback callback_;
  void* user_;
  IASIO* driver_ = nullptr;
  HWND window_ = nullptr;
  bool ownsCom_ = false, hasBuffers_ = false, postOutput_ = false;
  ASIOCallbacks callbacks_{};
  std::array<ASIOBufferInfo, 4> buffers_{};
  std::array<ASIOChannelInfo, 4> channelInfo_{};
  std::array<float, kChunkFrames * 2> input_{}, output_{};
  DeviceState initial_;
  std::atomic<bool> running_{false}, latencyChanged_{false};
  std::atomic<int> fault_{0};
  std::atomic<std::uint64_t> callbackCount_{0}, discontinuities_{0};
};
#endif

} // namespace

struct DeviceHost::Impl {
  std::unique_ptr<Adapter> device;
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
void DeviceHost::configure(const DeviceConfig& config, DeviceCallback callback, void* user) {
  validate(config, callback);
  close();
#if GARAK_ENABLE_ASIO && defined(_WIN32)
  if (config.backend == "asio") { impl_->device = std::make_unique<AsioAdapter>(config, callback, user); return; }
#endif
#if GARAK_ENABLE_DEVICES
  if (config.backend == "wasapi" || config.backend == "coreaudio") {
    impl_->device = std::make_unique<MaAdapter>(config, callback, user); return;
  }
#endif
  throw std::runtime_error("Requested audio backend is unavailable in this build: " + config.backend);
}
void DeviceHost::start() {
  if (!impl_->device) throw std::runtime_error("Configure an audio device before starting it.");
  impl_->device->start();
}
void DeviceHost::stop() { if (impl_->device) impl_->device->stop(); }
void DeviceHost::close() noexcept { impl_->device.reset(); }
void DeviceHost::service() { if (impl_->device) impl_->device->service(); }
DeviceState DeviceHost::state() const { return impl_->device ? impl_->device->state() : DeviceState{}; }
void DeviceHost::showControlPanel() {
  if (!impl_->device) throw std::runtime_error("Open an ASIO device first.");
  impl_->device->panel();
}

} // namespace garak

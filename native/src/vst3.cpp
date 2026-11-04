#include "garak/vst3.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <utility>

#ifndef GARAK_ENABLE_VST3
#define GARAK_ENABLE_VST3 0
#endif

#if GARAK_ENABLE_VST3
#include "vst3_window.hpp"
#include <pluginterfaces/base/ibstream.h>
#include <pluginterfaces/base/funknownimpl.h>
#include <pluginterfaces/base/ustring.h>
#include <pluginterfaces/gui/iplugview.h>
#include <pluginterfaces/vst/ivstcomponent.h>
#include <pluginterfaces/vst/ivstaudioprocessor.h>
#include <pluginterfaces/vst/ivsteditcontroller.h>
#include <pluginterfaces/vst/ivstparameterchanges.h>
#include <pluginterfaces/vst/ivstprocesscontext.h>
#include <pluginterfaces/vst/vstspeaker.h>
#include <public.sdk/source/vst/hosting/module.h>
#include <public.sdk/source/vst/hosting/hostclasses.h>
#include <public.sdk/source/vst/hosting/plugprovider.h>
#include <public.sdk/source/vst/hosting/connectionproxy.h>
#include <public.sdk/source/vst/hosting/processdata.h>
#include <public.sdk/source/vst/hosting/eventlist.h>
#include <public.sdk/source/vst/utility/stringconvert.h>
#endif

namespace garak {
#if GARAK_ENABLE_VST3
namespace {

namespace S = Steinberg;
namespace V = Steinberg::Vst;
using S::int32;
using S::uint32;
constexpr std::size_t kMaxStateBytes = 16 * 1024 * 1024;
constexpr std::size_t kMaxEvents = 4096;
constexpr std::size_t kMaxChangedParameters = 128;
constexpr std::size_t kMaxPointsPerParameter = 64;

void require(S::tresult result, const char* operation) {
  if (result != S::kResultOk)
    throw std::runtime_error(std::string("VST3 could not ") + operation + " (result " + std::to_string(result) + ").");
}

// All allocations in this stream happen during stopped/control-thread state IO.
// A malformed or buggy plugin cannot grow a project state without a bound.
class StateStream final : public S::U::Implements<S::U::Directly<S::IBStream>> {
 public:
  std::vector<std::uint8_t> bytes;
  bool exceededLimit = false;
  StateStream() = default;
  explicit StateStream(const std::vector<std::uint8_t>& data) {
    if (data.size() > kMaxStateBytes) throw std::runtime_error("VST3 state exceeds 16 MiB per component/controller.");
    bytes = data;
  }
  S::tresult PLUGIN_API read(void* destination, int32 count, int32* actual) override {
    if (actual) *actual = 0;
    if (count < 0 || (!destination && count)) return S::kInvalidArgument;
    const auto available = position_ < bytes.size() ? bytes.size() - position_ : 0;
    const auto n = std::min<std::size_t>(std::size_t(count), available);
    if (n) std::memcpy(destination, bytes.data() + position_, n);
    position_ += n;
    if (actual) *actual = int32(n);
    return n == std::size_t(count) ? S::kResultOk : S::kResultFalse;
  }
  S::tresult PLUGIN_API write(void* source, int32 count, int32* actual) override {
    if (actual) *actual = 0;
    if (count < 0 || (!source && count)) return S::kInvalidArgument;
    if (std::size_t(count) > kMaxStateBytes - position_) { exceededLimit = true; return S::kInvalidArgument; }
    try {
      if (position_ + std::size_t(count) > bytes.size()) bytes.resize(position_ + std::size_t(count));
      if (count) std::memcpy(bytes.data() + position_, source, std::size_t(count));
      position_ += std::size_t(count);
      if (actual) *actual = count;
      return S::kResultOk;
    } catch (...) { return S::kOutOfMemory; }
  }
  S::tresult PLUGIN_API seek(S::int64 offset, int32 mode, S::int64* result) override {
    S::int64 base = 0;
    if (mode == S::IBStream::kIBSeekCur) base = S::int64(position_);
    else if (mode == S::IBStream::kIBSeekEnd) base = S::int64(bytes.size());
    else if (mode != S::IBStream::kIBSeekSet) return S::kInvalidArgument;
    if (offset < -base) return S::kInvalidArgument;
    if (offset > S::int64(kMaxStateBytes) - base) { exceededLimit = true; return S::kInvalidArgument; }
    position_ = std::size_t(base + offset);
    if (result) *result = S::int64(position_);
    return S::kResultOk;
  }
  S::tresult PLUGIN_API tell(S::int64* result) override {
    if (!result) return S::kInvalidArgument;
    *result = S::int64(position_);
    return S::kResultOk;
  }
 private:
  std::size_t position_ = 0;
};

class FixedParameterQueue final : public S::U::Implements<S::U::Directly<V::IParamValueQueue>> {
 public:
  V::ParamID id = 0;
  struct Point { int32 offset = 0; V::ParamValue value = 0; };
  std::array<Point, kMaxPointsPerParameter> points{};
  int32 size = 0;
  V::ParamID PLUGIN_API getParameterId() override { return id; }
  int32 PLUGIN_API getPointCount() override { return size; }
  S::tresult PLUGIN_API getPoint(int32 index, int32& offset, V::ParamValue& value) override {
    if (index < 0 || index >= size) return S::kInvalidArgument;
    offset = points[std::size_t(index)].offset;
    value = points[std::size_t(index)].value;
    return S::kResultOk;
  }
  S::tresult PLUGIN_API addPoint(int32 offset, V::ParamValue value, int32& index) override {
    if (offset < 0 || !std::isfinite(value)) return S::kInvalidArgument;
    // Same-sample parameter updates have last-write-wins semantics.
    for (int32 i = 0; i < size; ++i) if (points[std::size_t(i)].offset == offset) {
      points[std::size_t(i)].value = value; index = i; return S::kResultOk;
    }
    if (size >= int32(points.size())) return S::kOutOfMemory;
    int32 insertion = size;
    while (insertion > 0 && points[std::size_t(insertion - 1)].offset > offset) {
      points[std::size_t(insertion)] = points[std::size_t(insertion - 1)]; --insertion;
    }
    points[std::size_t(insertion)] = {offset, value};
    index = insertion;
    ++size;
    return S::kResultOk;
  }
};
class FixedParameters final : public S::U::Implements<S::U::Directly<V::IParameterChanges>> {
 public:
  std::array<FixedParameterQueue, kMaxChangedParameters> queues;
  int32 size = 0;
  bool overflow = false;
  void clear() noexcept { for (int32 i = 0; i < size; ++i) queues[std::size_t(i)].size = 0; size = 0; overflow = false; }
  int32 PLUGIN_API getParameterCount() override { return size; }
  V::IParamValueQueue* PLUGIN_API getParameterData(int32 index) override {
    return index >= 0 && index < size ? &queues[std::size_t(index)] : nullptr;
  }
  V::IParamValueQueue* PLUGIN_API addParameterData(const V::ParamID& id, int32& index) override {
    for (int32 i = 0; i < size; ++i) if (queues[std::size_t(i)].id == id) { index = i; return &queues[std::size_t(i)]; }
    if (size >= int32(queues.size())) { overflow = true; return nullptr; }
    index = size++;
    auto& result = queues[std::size_t(index)];
    result.id = id; result.size = 0;
    return &result;
  }
  bool add(V::ParamID id, int32 offset, double value) noexcept {
    int32 index = 0;
    auto* queue = addParameterData(id, index);
    if (!queue || queue->addPoint(offset, value, index) != S::kResultOk) { overflow = true; return false; }
    return true;
  }
};
struct ParameterChange { V::ParamID id = 0; double value = 0; };
template <std::size_t Capacity>
struct ParameterRing {
  std::array<ParameterChange, Capacity> data{};
  std::atomic<std::size_t> read{0}, write{0};
  bool push(ParameterChange change) noexcept {
    const auto w = write.load(std::memory_order_relaxed);
    const auto next = (w + 1) % Capacity;
    if (next == read.load(std::memory_order_acquire)) return false;
    data[w] = change;
    write.store(next, std::memory_order_release);
    return true;
  }
  bool pop(ParameterChange& change) noexcept {
    const auto r = read.load(std::memory_order_relaxed);
    if (r == write.load(std::memory_order_acquire)) return false;
    change = data[r];
    read.store((r + 1) % Capacity, std::memory_order_release);
    return true;
  }
};

class HostApplication final : public V::HostApplication {
 public:
  S::tresult PLUGIN_API getName(V::String128 name) override {
    S::UString(name, 128).fromAscii("Garak Ieum");
    return S::kResultOk;
  }
};
// The SDK's validator provider requires a controller and connection points.
// They are optional in production VST3 processors. Keep its disconnect and
// termination implementation, but initialize optional interfaces explicitly.
class HostProvider final : public V::PlugProvider {
 public:
  using V::PlugProvider::PlugProvider;
  void initializeForHost(S::FUnknown* context) {
    component = factory.createInstance<V::IComponent>(classInfo.ID());
    if (!component) throw std::runtime_error("The VST3 factory did not create its audio component.");
    if (component->initialize(context) != S::kResultOk) {
      component.reset();
      throw std::runtime_error("VST3 component initialization failed.");
    }
    controller = S::U::cast<V::IEditController>(component);
    if (!controller) {
      S::TUID id{};
      if (component->getControllerClassId(id) == S::kResultOk) {
        controller = factory.createInstance<V::IEditController>(VST3::UID(id));
        if (!controller) throw std::runtime_error("The VST3 factory did not create its declared edit controller.");
        if (controller->initialize(context) != S::kResultOk) {
          controller.reset();
          throw std::runtime_error("VST3 edit controller initialization failed.");
        }
        const auto fromComponent = S::U::cast<V::IConnectionPoint>(component);
        const auto fromController = S::U::cast<V::IConnectionPoint>(controller);
        if (fromComponent && fromController && !connectComponents())
          throw std::runtime_error("VST3 component/controller connection failed.");
      }
    }
  }
};
struct HandlerState {
  ParameterRing<2048> fromController, toController;
  std::atomic<bool> dirty{false}, openEditor{false};
  std::atomic<std::uint32_t> restart{0};
  std::atomic<std::uint64_t> dropped{0};
};
class ComponentHandler final : public S::U::Implements<S::U::Directly<V::IComponentHandler, V::IComponentHandler2>> {
 public:
  explicit ComponentHandler(HandlerState& state) : state_(state) {}
  S::tresult PLUGIN_API beginEdit(V::ParamID) override { return S::kResultOk; }
  S::tresult PLUGIN_API performEdit(V::ParamID id, V::ParamValue value) override {
    if (!std::isfinite(value) || value < 0 || value > 1) return S::kInvalidArgument;
    state_.dirty.store(true, std::memory_order_relaxed);
    if (!state_.fromController.push({id, value})) {
      state_.dropped.fetch_add(1, std::memory_order_relaxed);
      return S::kOutOfMemory;
    }
    return S::kResultOk;
  }
  S::tresult PLUGIN_API endEdit(V::ParamID) override { return S::kResultOk; }
  S::tresult PLUGIN_API restartComponent(int32 flags) override {
    state_.restart.fetch_or(std::uint32_t(flags), std::memory_order_release);
    return S::kResultOk;
  }
  S::tresult PLUGIN_API setDirty(S::TBool dirty) override { state_.dirty.store(dirty != 0); return S::kResultOk; }
  S::tresult PLUGIN_API requestOpenEditor(S::FIDString name) override {
    if (name && std::strcmp(name, V::ViewType::kEditor)) return S::kNotImplemented;
    state_.openEditor.store(true); return S::kResultOk;
  }
  S::tresult PLUGIN_API startGroupEdit() override { return S::kResultOk; }
  S::tresult PLUGIN_API finishGroupEdit() override { return S::kResultOk; }
 private:
  HandlerState& state_;
};

VST3::Hosting::Module::Ptr openModule(const std::string& path) {
  if (path.empty() || !std::filesystem::path(path).is_absolute())
    throw std::runtime_error("VST3 modules require an approved absolute filesystem path.");
  std::string error;
  auto module = VST3::Hosting::Module::create(path, error);
  if (!module) throw std::runtime_error("Cannot load VST3 module: " + error);
  return module;
}

} // namespace

struct Vst3Processor::Impl {
  // Destruction ordering keeps the module and host alive through termination.
  VST3::Hosting::Module::Ptr module;
  S::IPtr<HostApplication> host = S::owned(new HostApplication);
  HandlerState handlerState;
  S::IPtr<ComponentHandler> handler = S::owned(new ComponentHandler(handlerState));
  std::unique_ptr<V::PlugProvider> provider;
  S::IPtr<V::IComponent> component;
  S::IPtr<V::IEditController> controller;
  S::IPtr<V::IAudioProcessor> processor;
  V::HostProcessData data;
  V::EventList inputEvents{int32(kMaxEvents)}, outputEvents{int32(kMaxEvents)};
  FixedParameters inputParameters, outputParameters;
  struct ActiveNote {
    std::uint64_t key = 0;
    std::int32_t id = -1;
    std::uint8_t channel = 0, pitch = 0, state = 0; // empty, occupied, tombstone
  };
  std::array<ActiveNote, 4096> activeNotes{};
  std::size_t activeNoteCount = 0, syncParameterIndex = 0;
  bool syncingParameters = false;
  std::vector<PluginParameter> parameterInfo;
  std::unique_ptr<NativePluginWindow> window;
  S::IPtr<S::IPlugView> view;
  std::string name;
  double sampleRate = 48000;
  double tailSeconds = 0;
  std::uint32_t maxFrames = 4096;
  bool isInstrument = false, hasEventInput = false, active = false, processing = false, offline = false;
  std::atomic<bool> reset{false};
  std::atomic<std::uint32_t> fault{0}, latency{0};

  Impl(const PluginSpec& spec, double rate, std::uint32_t block, bool offlineMode)
      : module(openModule(spec.path)), sampleRate(rate), maxFrames(block), isInstrument(spec.isInstrument), offline(offlineMode) {
    try {
    if (!std::isfinite(rate) || rate < 8000 || rate > 192000 || block < 1 || block > 16384)
      throw std::runtime_error("Invalid VST3 processing setup.");
    const auto classes = module->getFactory().classInfos();
    const auto found = std::find_if(classes.begin(), classes.end(), [&](const auto& c) {
      return c.category() == kVstAudioEffectClass && c.ID().toString() == spec.classId;
    });
    if (found == classes.end()) throw std::runtime_error("The selected VST3 class is no longer provided by this module.");
    name = found->name();
    const bool declaredInstrument = found->subCategoriesString().find("Instrument") != std::string::npos;
    if (declaredInstrument != spec.isInstrument) throw std::runtime_error("The VST3 instrument/effect role does not match its scanned class.");
    module->getFactory().setHostContext(host);
    V::PlugProvider::setErrorStream(&std::cerr);
    auto nextProvider = std::make_unique<HostProvider>(module->getFactory(), *found, true);
    nextProvider->initializeForHost(host);
    provider = std::move(nextProvider);
    component = provider->getComponentPtr();
    controller = provider->getControllerPtr();
    processor = S::U::cast<V::IAudioProcessor>(component);
    if (!component || !processor) throw std::runtime_error("The VST3 class does not provide an audio processor.");
    if (controller) require(controller->setComponentHandler(handler), "connect its edit controller");
    component->setIoMode(V::kAdvanced);
    if (processor->canProcessSampleSize(V::kSample32) != S::kResultTrue)
      throw std::runtime_error("This VST3 plugin does not support 32-bit floating point audio.");
    restore({spec.state, spec.controllerState});
    configureBuses();
    V::ProcessSetup setup{};
    setup.processMode = offline ? V::kOffline : V::kRealtime;
    setup.symbolicSampleSize = V::kSample32;
    setup.maxSamplesPerBlock = int32(block);
    setup.sampleRate = rate;
    require(processor->setupProcessing(setup), "configure audio processing");
    if (!data.prepare(*component, int32(block), V::kSample32)) throw std::runtime_error("Cannot allocate VST3 bus buffers.");
    data.processMode = setup.processMode;
    data.inputEvents = &inputEvents;
    data.outputEvents = &outputEvents;
    data.inputParameterChanges = &inputParameters;
    data.outputParameterChanges = &outputParameters;
    refreshParameters();
    active = true;
    require(component->setActive(true), "activate its audio buses");
    processing = true;
    require(processor->setProcessing(true), "start processing");
    std::size_t initialCount = 0;
    for (const auto& [id, value] : spec.parameters) {
      setParameter(id, value);
      if (++initialCount % kMaxChangedParameters == 0) flushPendingParameters();
    }
    flushPendingParameters();
    latency.store(processor->getLatencySamples(), std::memory_order_relaxed);
    const auto tail = processor->getTailSamples();
    tailSeconds = tail == V::kInfiniteTail ? 30. : std::min(30., double(tail) / sampleRate);
    handlerState.dirty.store(false);
    } catch (...) { shutdown(); throw; }
  }
  ~Impl() { shutdown(); }
  void shutdown() noexcept {
    window.reset();
    view.reset();
    if (processor && processing) processor->setProcessing(false);
    if (component && active) component->setActive(false);
    if (controller) controller->setComponentHandler(nullptr);
    data.unprepare();
    processor.reset();
    controller.reset();
    component.reset();
    provider.reset();
    module.reset();
  }
  void configureBuses() {
    const auto inCount = component->getBusCount(V::kAudio, V::kInput);
    const auto outCount = component->getBusCount(V::kAudio, V::kOutput);
    if (inCount < 0 || inCount > 16 || outCount < 1 || outCount > 16)
      throw std::runtime_error("The VST3 plugin has an unsupported audio bus layout.");
    std::vector<V::SpeakerArrangement> inputs(std::size_t(inCount), V::SpeakerArr::kEmpty);
    std::vector<V::SpeakerArrangement> outputs(std::size_t(outCount), V::SpeakerArr::kEmpty);
    for (int32 i = 0; i < inCount; ++i) processor->getBusArrangement(V::kInput, i, inputs[std::size_t(i)]);
    for (int32 i = 0; i < outCount; ++i) processor->getBusArrangement(V::kOutput, i, outputs[std::size_t(i)]);
    if (inCount) inputs[0] = V::SpeakerArr::kStereo;
    outputs[0] = V::SpeakerArr::kStereo;
    processor->setBusArrangements(inputs.data(), inCount, outputs.data(), outCount);
    int32 totalChannels = 0;
    for (const auto direction : {V::kInput, V::kOutput}) {
      const auto count = component->getBusCount(V::kAudio, direction);
      for (int32 i = 0; i < count; ++i) {
        V::BusInfo info{};
        require(component->getBusInfo(V::kAudio, direction, i, info), "query its audio buses");
        if (info.channelCount < 0 || info.channelCount > 32) throw std::runtime_error("Unsupported VST3 bus channel count.");
        totalChannels += info.channelCount;
        if (i == 0 && (info.channelCount < 1 || info.channelCount > 2))
          throw std::runtime_error("The VST3 plugin cannot negotiate a mono or stereo main bus.");
        require(component->activateBus(V::kAudio, direction, i, i == 0), "activate its main audio bus");
      }
    }
    if (totalChannels > 64) throw std::runtime_error("The VST3 plugin exceeds the host channel limit.");
    for (const auto direction : {V::kInput, V::kOutput}) {
      const auto count = component->getBusCount(V::kEvent, direction);
      if (count < 0 || count > 16) throw std::runtime_error("Unsupported VST3 event bus count.");
      for (int32 i = 0; i < count; ++i)
        require(component->activateBus(V::kEvent, direction, i, direction == V::kInput && i == 0), "configure its event buses");
      if (direction == V::kInput) hasEventInput = count > 0;
    }
    if (isInstrument && !hasEventInput) throw std::runtime_error("The selected VST3 instrument has no MIDI/event input.");
  }
  void refreshParameters() {
    parameterInfo.clear();
    if (!controller) return;
    const auto count = controller->getParameterCount();
    if (count < 0 || count > 65536) throw std::runtime_error("The VST3 plugin has an invalid parameter count.");
    parameterInfo.reserve(std::size_t(count));
    for (int32 i = 0; i < count; ++i) {
      V::ParameterInfo info{};
      require(controller->getParameterInfo(i, info), "read parameter information");
      PluginParameter parameter;
      parameter.id = info.id;
      parameter.title = V::StringConvert::convert(info.title);
      parameter.units = V::StringConvert::convert(info.units);
      parameter.defaultValue = info.defaultNormalizedValue;
      parameter.value = controller->getParamNormalized(info.id);
      parameter.stepCount = info.stepCount;
      parameter.readOnly = (info.flags & V::ParameterInfo::kIsReadOnly) != 0;
      parameter.hidden = (info.flags & V::ParameterInfo::kIsHidden) != 0;
      parameterInfo.push_back(std::move(parameter));
    }
  }
  void setParameter(std::uint32_t id, double value) {
    if (!controller || !std::isfinite(value) || value < 0 || value > 1)
      throw std::runtime_error("VST3 parameter values must be finite normalized values between 0 and 1.");
    const auto found = std::find_if(parameterInfo.begin(), parameterInfo.end(), [id](const auto& p) { return p.id == id; });
    if (found == parameterInfo.end() || found->readOnly) throw std::runtime_error("Unknown or read-only VST3 parameter.");
    if (!handlerState.fromController.push({id, value})) throw std::runtime_error("VST3 parameter queue is full.");
    require(controller->setParamNormalized(id, value), "set its parameter");
    handlerState.dirty.store(true);
  }
  PluginState save() {
    flushPendingParameters();
    PluginState result;
    StateStream componentStream;
    const auto componentResult = component->getState(&componentStream);
    if (componentStream.exceededLimit) throw std::runtime_error("VST3 component state exceeds the 16 MiB project limit.");
    if (componentResult != S::kNotImplemented) require(componentResult, "save its component state");
    result.component = std::move(componentStream.bytes);
    if (controller) {
      StateStream controllerStream;
      const auto controllerResult = controller->getState(&controllerStream);
      if (controllerStream.exceededLimit) throw std::runtime_error("VST3 controller state exceeds the 16 MiB project limit.");
      if (controllerResult != S::kNotImplemented) require(controllerResult, "save its controller state");
      result.controller = std::move(controllerStream.bytes);
    }
    handlerState.dirty.store(false);
    return result;
  }
  void restore(const PluginState& state) {
    ParameterChange stale;
    while (handlerState.fromController.pop(stale)) {}
    while (handlerState.toController.pop(stale)) {}
    if (!state.component.empty()) {
      StateStream stream(state.component);
      require(component->setState(&stream), "restore its component state");
      if (controller) {
        stream.seek(0, S::IBStream::kIBSeekSet, nullptr);
        const auto result = controller->setComponentState(&stream);
        if (result != S::kNotImplemented) require(result, "synchronize its controller state");
      }
    }
    if (controller && !state.controller.empty()) {
      StateStream stream(state.controller);
      require(controller->setState(&stream), "restore its controller state");
    }
  }
  // Main/control thread only, with the audio callback stopped. VST3 permits
  // zero-sample calls to flush parameter changes without advancing the timeline.
  void flushPendingParameters() {
    if (!processor || !processing) return;
    for (;;) {
      inputParameters.clear(); outputParameters.clear();
      inputEvents.clear(); outputEvents.clear();
      ParameterChange change;
      std::size_t count = 0;
      while (count < kMaxChangedParameters && handlerState.fromController.pop(change)) {
        if (!inputParameters.add(change.id, 0, change.value)) throw std::runtime_error("VST3 parameter flush overflow.");
        ++count;
      }
      if (!count) break;
      data.numSamples = 0;
      data.processContext = nullptr;
      require(processor->process(data), "flush its parameter values");
      if (outputParameters.overflow) throw std::runtime_error("VST3 output parameter flush overflow.");
      for (int32 q = 0; q < outputParameters.size; ++q) {
        const auto& queue = outputParameters.queues[std::size_t(q)];
        if (controller && queue.size) controller->setParamNormalized(queue.id, queue.points[std::size_t(queue.size - 1)].value);
      }
    }
  }
  ActiveNote* noteSlot(std::uint8_t channel, std::uint8_t pitch, std::int32_t id, bool insert) noexcept {
    const auto identity = id >= 0 ? std::uint64_t(std::uint32_t(id)) : (std::uint64_t(1) << 32) | pitch;
    const auto key = identity | (std::uint64_t(channel) << 40);
    const auto start = std::size_t((key ^ (key >> 29)) * 11400714819323198485ull) & (activeNotes.size() - 1);
    ActiveNote* available = nullptr;
    for (std::size_t i = 0; i < activeNotes.size(); ++i) {
      auto& slot = activeNotes[(start + i) & (activeNotes.size() - 1)];
      if (slot.state == 1 && slot.key == key) return &slot;
      if (slot.state != 1 && !available) available = &slot;
      if (slot.state == 0) break;
    }
    if (!insert || activeNoteCount >= kMaxEvents / 2) return nullptr;
    if (available) available->key = key;
    return available;
  }
  bool addNote(bool on, std::uint8_t channel, std::uint8_t pitch, std::int32_t id,
               float velocity, std::uint32_t offset, const ProcessContext& context) noexcept {
    if (!hasEventInput) return true;
    V::Event event{};
    event.busIndex = 0;
    event.sampleOffset = int32(offset);
    event.ppqPosition = (double(context.projectFrame) + offset) / context.sampleRate * context.bpm / 60.;
    event.flags = 0;
    auto* tracked = noteSlot(channel, pitch, id, on);
    if (on && !tracked) return false;
    if (on) {
      event.type = V::Event::kNoteOnEvent;
      event.noteOn.channel = channel;
      event.noteOn.pitch = pitch;
      event.noteOn.velocity = std::clamp(velocity, 0.f, 1.f);
      event.noteOn.noteId = id;
      event.noteOn.tuning = 0;
      event.noteOn.length = 0;
    } else {
      event.type = V::Event::kNoteOffEvent;
      event.noteOff.channel = channel;
      event.noteOff.pitch = pitch;
      event.noteOff.velocity = std::clamp(velocity, 0.f, 1.f);
      event.noteOff.noteId = id;
      event.noteOff.tuning = 0;
    }
    if (inputEvents.addEvent(event) != S::kResultOk) return false;
    if (on) {
      if (tracked->state != 1) ++activeNoteCount;
      tracked->state = 1; tracked->id = id; tracked->channel = channel; tracked->pitch = pitch;
    } else if (tracked) {
      tracked->state = 2;
      if (--activeNoteCount == 0) for (auto& slot : activeNotes) slot.state = 0;
    }
    return true;
  }
  bool allNotesOff(const ProcessContext& context, std::uint32_t offset = 0) noexcept {
    bool ok = true;
    for (auto& note : activeNotes) if (note.state == 1)
      ok = addNote(false, note.channel, note.pitch, note.id, 0, offset, context) && ok;
    return ok;
  }
  void render(float* stereo, std::uint32_t frames, std::span<const PluginEvent> events, const ProcessContext& context) noexcept {
    if (!frames) return;
    if (frames > maxFrames) fault.store(5);
    if (fault.load(std::memory_order_relaxed)) {
      std::fill_n(stereo, std::size_t(frames) * 2, 0.f); return;
    }
    // Configuration/lifetime requests must be serviced by a stopped control
    // thread. Do not continue processing with a stale bus or latency layout.
    constexpr auto structuralRestart = V::kReloadComponent | V::kIoChanged | V::kLatencyChanged;
    if (handlerState.restart.load(std::memory_order_acquire) & structuralRestart) {
      fault.store(3);
      std::fill_n(stereo, std::size_t(frames) * 2, 0.f); return;
    }
    inputEvents.clear(); outputEvents.clear();
    inputParameters.clear(); outputParameters.clear();
    bool valid = true;
    if (reset.exchange(false, std::memory_order_acq_rel)) valid = allNotesOff(context);
    ParameterChange change;
    std::size_t parameterCount = 0;
    while (parameterCount++ < kMaxChangedParameters && handlerState.fromController.pop(change))
      valid = inputParameters.add(change.id, 0, change.value) && valid;
    for (const auto& event : events) {
      if (event.offset >= frames || event.channel > 15 || event.pitch > 127) { valid = false; continue; }
      switch (event.type) {
        case PluginEvent::Type::NoteOn: valid = addNote(true, event.channel, event.pitch, event.noteId, event.value, event.offset, context) && valid; break;
        case PluginEvent::Type::NoteOff: valid = addNote(false, event.channel, event.pitch, event.noteId, event.value, event.offset, context) && valid; break;
        case PluginEvent::Type::Parameter: valid = inputParameters.add(event.parameterId, int32(event.offset), std::clamp(double(event.value), 0., 1.)) && valid; break;
        case PluginEvent::Type::AllNotesOff: valid = allNotesOff(context, event.offset) && valid; break;
      }
    }
    if (!valid) {
      handlerState.dropped.fetch_add(1, std::memory_order_relaxed);
      fault.store(2);
      std::fill_n(stereo, std::size_t(frames) * 2, 0.f); return;
    }
    for (int32 bus = 0; bus < data.numInputs; ++bus) {
      auto& input = data.inputs[bus];
      input.silenceFlags = bus == 0 && !isInstrument ? 0 : V::HostProcessData::kAllChannelsSilent;
      for (int32 channel = 0; channel < input.numChannels; ++channel)
        std::fill_n(input.channelBuffers32[channel], frames, 0.f);
    }
    for (int32 bus = 0; bus < data.numOutputs; ++bus) {
      auto& output = data.outputs[bus];
      output.silenceFlags = 0;
      for (int32 channel = 0; channel < output.numChannels; ++channel)
        std::fill_n(output.channelBuffers32[channel], frames, 0.f);
    }
    if (!isInstrument && data.numInputs) {
      auto& input = data.inputs[0];
      for (std::uint32_t f = 0; f < frames; ++f) {
        input.channelBuffers32[0][f] = input.numChannels == 1 ? .5f * (stereo[f * 2] + stereo[f * 2 + 1]) : stereo[f * 2];
        if (input.numChannels > 1) input.channelBuffers32[1][f] = stereo[f * 2 + 1];
      }
    }
    V::ProcessContext timing{};
    timing.state = V::ProcessContext::kProjectTimeMusicValid | V::ProcessContext::kTempoValid |
        V::ProcessContext::kTimeSigValid | V::ProcessContext::kBarPositionValid | V::ProcessContext::kContTimeValid;
    if (context.playing) timing.state |= V::ProcessContext::kPlaying;
    if (context.recording) timing.state |= V::ProcessContext::kRecording;
    if (context.cycleActive) {
      timing.state |= V::ProcessContext::kCycleActive | V::ProcessContext::kCycleValid;
      timing.cycleStartMusic = double(context.cycleStartFrame) / sampleRate * context.bpm / 60.;
      timing.cycleEndMusic = double(context.cycleEndFrame) / sampleRate * context.bpm / 60.;
    }
    timing.sampleRate = sampleRate;
    timing.projectTimeSamples = context.projectFrame;
    timing.continousTimeSamples = context.continuousFrame;
    timing.tempo = context.bpm;
    timing.timeSigNumerator = context.timeSigNumerator;
    timing.timeSigDenominator = context.timeSigDenominator;
    timing.projectTimeMusic = double(context.projectFrame) / sampleRate * context.bpm / 60.;
    const auto bar = std::max(1., context.timeSigNumerator * 4. / std::max(1, context.timeSigDenominator));
    timing.barPositionMusic = std::floor(timing.projectTimeMusic / bar) * bar;
    data.numSamples = int32(frames);
    data.processContext = &timing;
    const auto result = processor->process(data);
    data.processContext = nullptr;
    if (result != S::kResultOk || outputParameters.overflow) {
      fault.store(result == S::kResultOk ? 2 : 1);
      std::fill_n(stereo, std::size_t(frames) * 2, 0.f); return;
    }
    const auto& output = data.outputs[0];
    for (std::uint32_t f = 0; f < frames; ++f) {
      for (int channel = 0; channel < 2; ++channel) {
        const auto sourceChannel = std::min(channel, output.numChannels - 1);
        const float sample = output.silenceFlags & (S::uint64(1) << sourceChannel) ? 0.f : output.channelBuffers32[sourceChannel][f];
        stereo[f * 2 + channel] = std::isfinite(sample) ? sample : 0.f;
        if (!std::isfinite(sample)) fault.store(4);
      }
    }
    for (int32 q = 0; q < outputParameters.size; ++q) {
      const auto& queue = outputParameters.queues[std::size_t(q)];
      if (queue.size && !handlerState.toController.push({queue.id, queue.points[std::size_t(queue.size - 1)].value}))
        handlerState.dropped.fetch_add(1, std::memory_order_relaxed);
    }
  }
};

bool vst3Available() noexcept { return true; }
std::vector<PluginDescriptor> scanVst3(const std::string& path) {
  auto module = openModule(path);
  std::vector<PluginDescriptor> result;
  for (const auto& info : module->getFactory().classInfos()) if (info.category() == kVstAudioEffectClass) {
    PluginDescriptor descriptor;
    descriptor.classId = info.ID().toString();
    descriptor.name = info.name();
    descriptor.vendor = info.vendor();
    descriptor.version = info.version();
    descriptor.category = info.subCategoriesString();
    descriptor.isInstrument = descriptor.category.find("Instrument") != std::string::npos;
    result.push_back(std::move(descriptor));
  }
  if (result.empty()) throw std::runtime_error("The selected file contains no VST3 audio processor classes.");
  return result;
}
std::vector<std::string> defaultVst3Paths() { return VST3::Hosting::Module::getModulePaths(); }
Vst3Processor::Vst3Processor(const PluginSpec& spec, double rate, std::uint32_t block, bool offline)
    : impl_(std::make_unique<Impl>(spec, rate, block, offline)) {}
Vst3Processor::~Vst3Processor() = default;
void Vst3Processor::process(float* stereo, std::uint32_t frames, std::span<const PluginEvent> events, const ProcessContext& context) noexcept {
  try { impl_->render(stereo, frames, events, context); }
  catch (...) { impl_->fault.store(1); std::fill_n(stereo, std::size_t(frames) * 2, 0.f); }
}
std::uint32_t Vst3Processor::latencyFrames() const noexcept { return impl_->latency.load(std::memory_order_relaxed); }
double Vst3Processor::tailSeconds() const noexcept { return impl_->tailSeconds; }
void Vst3Processor::requestReset() noexcept { impl_->reset.store(true, std::memory_order_release); }
std::vector<PluginParameter> Vst3Processor::parameters() const {
  auto result = impl_->parameterInfo;
  if (impl_->controller) for (auto& parameter : result) parameter.value = impl_->controller->getParamNormalized(parameter.id);
  return result;
}
void Vst3Processor::setParameter(std::uint32_t id, double value) { impl_->setParameter(id, value); }
PluginState Vst3Processor::saveState() { return impl_->save(); }
void Vst3Processor::restoreState(const PluginState& state) { impl_->restore(state); impl_->refreshParameters(); impl_->reset.store(true); }
void Vst3Processor::openEditor() {
  if (impl_->window && impl_->window->isOpen()) return;
  impl_->window.reset(); impl_->view.reset();
  if (!impl_->controller) throw std::runtime_error("This VST3 plugin does not provide an edit controller.");
  impl_->view = S::owned(impl_->controller->createView(V::ViewType::kEditor));
  if (!impl_->view) throw std::runtime_error("This VST3 plugin has no custom editor. Use its parameter controls.");
  impl_->window = makePluginWindow(impl_->view, impl_->name);
}
void Vst3Processor::closeEditor() noexcept { impl_->window.reset(); impl_->view.reset(); }
void Vst3Processor::service() {
  ParameterChange change;
  while (impl_->handlerState.toController.pop(change)) if (impl_->controller)
    impl_->controller->setParamNormalized(change.id, change.value);
  const auto flags = impl_->handlerState.restart.load(std::memory_order_acquire);
  if ((flags & V::kParamTitlesChanged) && impl_->controller) {
    impl_->refreshParameters();
    impl_->handlerState.restart.fetch_and(~std::uint32_t(V::kParamTitlesChanged));
  }
  if ((flags & V::kParamValuesChanged) && impl_->controller) {
    impl_->syncingParameters = true;
    impl_->syncParameterIndex = 0;
    impl_->handlerState.restart.fetch_and(~std::uint32_t(V::kParamValuesChanged));
  }
  if (impl_->syncingParameters && impl_->controller) {
    while (impl_->syncParameterIndex < impl_->parameterInfo.size()) {
      const auto& parameter = impl_->parameterInfo[impl_->syncParameterIndex];
      if (!parameter.readOnly && !impl_->handlerState.fromController.push({parameter.id, impl_->controller->getParamNormalized(parameter.id)})) break;
      ++impl_->syncParameterIndex;
    }
    impl_->syncingParameters = impl_->syncParameterIndex < impl_->parameterInfo.size();
  }
  if (impl_->handlerState.openEditor.exchange(false)) openEditor();
}
PluginStatus Vst3Processor::status() const {
  PluginStatus result;
  result.dirty = impl_->handlerState.dirty.load();
  result.editorOpen = impl_->window && impl_->window->isOpen();
  result.restartFlags = impl_->handlerState.restart.load();
  result.latencyFrames = latencyFrames();
  result.droppedEvents = impl_->handlerState.dropped.load();
  switch (impl_->fault.load()) {
    case 1: result.error = "The VST3 processor failed. Stop playback and reload the plugin."; break;
    case 2: result.error = "The VST3 event or parameter queue exceeded its bounded capacity."; break;
    case 3: result.error = "The VST3 plugin changed its processing layout or latency. Stop playback and reload the plugin."; break;
    case 4: result.error = "The VST3 processor produced invalid audio samples."; break;
    case 5: result.error = "The VST3 audio callback exceeds the prepared maximum block size."; break;
    default: break;
  }
  result.faulted = !result.error.empty();
  return result;
}

#else

struct Vst3Processor::Impl {};
bool vst3Available() noexcept { return false; }
std::vector<PluginDescriptor> scanVst3(const std::string&) { throw std::runtime_error("VST3 support is not compiled into this offline test build."); }
std::vector<std::string> defaultVst3Paths() { return {}; }
Vst3Processor::Vst3Processor(const PluginSpec&, double, std::uint32_t, bool) { throw std::runtime_error("VST3 support is not compiled into this offline test build."); }
Vst3Processor::~Vst3Processor() = default;
void Vst3Processor::process(float* samples, std::uint32_t frames, std::span<const PluginEvent>, const ProcessContext&) noexcept { std::fill_n(samples, std::size_t(frames) * 2, 0.f); }
std::uint32_t Vst3Processor::latencyFrames() const noexcept { return 0; }
double Vst3Processor::tailSeconds() const noexcept { return 0; }
void Vst3Processor::requestReset() noexcept {}
std::vector<PluginParameter> Vst3Processor::parameters() const { return {}; }
void Vst3Processor::setParameter(std::uint32_t, double) { throw std::runtime_error("VST3 is unavailable in this build."); }
PluginState Vst3Processor::saveState() { throw std::runtime_error("VST3 is unavailable in this build."); }
void Vst3Processor::restoreState(const PluginState&) { throw std::runtime_error("VST3 is unavailable in this build."); }
void Vst3Processor::openEditor() { throw std::runtime_error("VST3 is unavailable in this build."); }
void Vst3Processor::closeEditor() noexcept {}
void Vst3Processor::service() {}
PluginStatus Vst3Processor::status() const { PluginStatus s; s.faulted = true; s.error = "VST3 is unavailable in this build."; return s; }

#endif

} // namespace garak

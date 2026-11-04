// A real, deterministic VST3 module used only by native integration tests.
// Two processor classes exercise effects, instruments, MIDI offsets and state.
#include <public.sdk/source/vst/vstaudioeffect.h>
#include <public.sdk/source/vst/vsteditcontroller.h>
#include <public.sdk/source/main/pluginfactory.h>
#include <base/source/fstreamer.h>
#include <pluginterfaces/base/ibstream.h>
#include <pluginterfaces/base/ustring.h>
#include <pluginterfaces/vst/ivstevents.h>
#include <pluginterfaces/vst/ivstparameterchanges.h>

#include <array>
#include <cmath>
#include <cstdio>

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace {
const FUID kGainId(0x71949A01, 0xCC064E86, 0xA10DB06A, 0x05710001);
const FUID kInstrumentId(0x71949A01, 0xCC064E86, 0xA10DB06A, 0x05710002);
const FUID kControllerId(0x71949A01, 0xCC064E86, 0xA10DB06A, 0x05710003);
const FUID kProcessorOnlyId(0x71949A01, 0xCC064E86, 0xA10DB06A, 0x05710004);
constexpr std::size_t kParameterCount = 260;
using Values = std::array<float, kParameterCount>;
Values initialValues() { Values v{}; v.fill(1.f); v[0] = .5f; return v; }
tresult readState(IBStream* stream, Values& values) {
  if (!stream) return kInvalidArgument;
  IBStreamer io(stream, kLittleEndian);
  int32 magic = 0;
  Values next{};
  if (!io.readInt32(magic) || magic != 0x47524b31) return kResultFalse;
  for (auto& v : next) if (!io.readFloat(v) || !std::isfinite(v) || v < 0 || v > 1) return kResultFalse;
  values = next;
  return kResultOk;
}
tresult writeState(IBStream* stream, const Values& values) {
  if (!stream) return kInvalidArgument;
  IBStreamer io(stream, kLittleEndian);
  if (!io.writeInt32(0x47524b31)) return kResultFalse;
  for (auto v : values) if (!io.writeFloat(v)) return kResultFalse;
  return kResultOk;
}

class TestController final : public EditController {
 public:
  static FUnknown* createInstance(void*) { return static_cast<IEditController*>(new TestController); }
  tresult PLUGIN_API initialize(FUnknown* context) override {
    const auto result = EditController::initialize(context);
    if (result != kResultOk) return result;
    const auto values = initialValues();
    for (ParamID i = 0; i < kParameterCount; ++i) {
      String128 title{};
      char text[48];
      std::snprintf(text, sizeof(text), i ? "Test parameter %u" : "Gain", unsigned(i));
      UString(title, 128).fromAscii(text);
      parameters.addParameter(title, STR16(""), 0, values[i], ParameterInfo::kCanAutomate, i);
    }
    return kResultOk;
  }
  tresult PLUGIN_API setComponentState(IBStream* stream) override { return setState(stream); }
  tresult PLUGIN_API setState(IBStream* stream) override {
    Values next{};
    const auto result = readState(stream, next);
    if (result != kResultOk) return result;
    for (ParamID i = 0; i < kParameterCount; ++i) setParamNormalized(i, next[i]);
    return kResultOk;
  }
  tresult PLUGIN_API getState(IBStream* stream) override {
    Values values{};
    for (ParamID i = 0; i < kParameterCount; ++i) values[i] = float(getParamNormalized(i));
    return writeState(stream, values);
  }
};

class TestProcessor final : public AudioEffect {
 public:
  explicit TestProcessor(bool instrument, bool controller = true) : instrument_(instrument) {
    if (controller) setControllerClass(kControllerId);
    // Exercises the host's separate protocol descriptor: plugin diagnostics
    // must reach stderr and must never corrupt NDJSON replies on stdout.
    std::puts("Garak VST3 fixture initialized");
    std::fflush(stdout);
  }
  static FUnknown* createGain(void*) { return static_cast<IAudioProcessor*>(new TestProcessor(false)); }
  static FUnknown* createInstrument(void*) { return static_cast<IAudioProcessor*>(new TestProcessor(true)); }
  static FUnknown* createProcessorOnly(void*) { return static_cast<IAudioProcessor*>(new TestProcessor(false, false)); }
  tresult PLUGIN_API initialize(FUnknown* context) override {
    const auto result = AudioEffect::initialize(context);
    if (result != kResultOk) return result;
    if (!instrument_) addAudioInput(STR16("Stereo input"), SpeakerArr::kStereo);
    addAudioOutput(STR16("Stereo output"), SpeakerArr::kStereo);
    if (instrument_) addEventInput(STR16("Notes"), 16);
    return kResultOk;
  }
  tresult PLUGIN_API setProcessing(TBool state) override {
    if (!state) for (auto& voice : voices_) voice.active = false;
    return kResultOk;
  }
  tresult PLUGIN_API setState(IBStream* stream) override { return readState(stream, values_); }
  tresult PLUGIN_API getState(IBStream* stream) override { return writeState(stream, values_); }
  tresult PLUGIN_API process(ProcessData& data) override {
    if (data.symbolicSampleSize != kSample32) return kResultFalse;
    // Zero-sample parameter flushing must be supported by a VST3 processor.
    const auto iterations = data.numSamples ? data.numSamples : 1;
    for (int32 frame = 0; frame < iterations; ++frame) {
      if (data.inputParameterChanges) for (int32 p = 0; p < data.inputParameterChanges->getParameterCount(); ++p) {
        auto* queue = data.inputParameterChanges->getParameterData(p);
        if (!queue || queue->getParameterId() >= kParameterCount) continue;
        for (int32 point = 0; point < queue->getPointCount(); ++point) {
          int32 offset = 0; ParamValue value = 0;
          if (queue->getPoint(point, offset, value) == kResultOk && offset == frame)
            values_[queue->getParameterId()] = float(value);
        }
      }
      if (!data.numSamples) break;
      if (data.inputEvents) for (int32 e = 0; e < data.inputEvents->getEventCount(); ++e) {
        Event event{};
        if (data.inputEvents->getEvent(e, event) != kResultOk || event.sampleOffset != frame) continue;
        if (event.type == Event::kNoteOnEvent) {
          for (auto& voice : voices_) if (!voice.active) {
            voice = {true, event.noteOn.noteId, event.noteOn.channel, event.noteOn.pitch, event.noteOn.velocity};
            break;
          }
        } else if (event.type == Event::kNoteOffEvent) {
          for (auto& voice : voices_) if (voice.active && voice.channel == event.noteOff.channel &&
              (event.noteOff.noteId >= 0 ? voice.id == event.noteOff.noteId : voice.pitch == event.noteOff.pitch)) voice.active = false;
        }
      }
      float generated = 0;
      if (instrument_) for (const auto& voice : voices_) if (voice.active) generated += voice.velocity;
      if (data.numOutputs) for (int32 channel = 0; channel < data.outputs[0].numChannels; ++channel) {
        const float source = instrument_ ? generated : data.numInputs && channel < data.inputs[0].numChannels
            ? data.inputs[0].channelBuffers32[channel][frame] : 0.f;
        data.outputs[0].channelBuffers32[channel][frame] = source * values_[0] * values_.back();
      }
    }
    if (data.numOutputs) data.outputs[0].silenceFlags = 0;
    return kResultOk;
  }
 private:
  struct Voice { bool active = false; int32 id = -1; int16 channel = 0, pitch = 0; float velocity = 0; };
  bool instrument_;
  Values values_ = initialValues();
  std::array<Voice, 128> voices_{};
};
} // namespace

BEGIN_FACTORY_DEF("Garak Ieum", "https://github.com/songchez/garak-ieum", "")
DEF_CLASS2(INLINE_UID_FROM_FUID(kGainId), PClassInfo::kManyInstances, kVstAudioEffectClass,
  "Garak Native Test Gain", Vst::kDistributable, "Fx|Tools", "1.0.0", kVstVersionString, TestProcessor::createGain)
DEF_CLASS2(INLINE_UID_FROM_FUID(kInstrumentId), PClassInfo::kManyInstances, kVstAudioEffectClass,
  "Garak Native Test Instrument", Vst::kDistributable, "Instrument|Synth", "1.0.0", kVstVersionString, TestProcessor::createInstrument)
DEF_CLASS2(INLINE_UID_FROM_FUID(kControllerId), PClassInfo::kManyInstances, kVstComponentControllerClass,
  "Garak Native Test Controller", 0, "", "1.0.0", kVstVersionString, TestController::createInstance)
DEF_CLASS2(INLINE_UID_FROM_FUID(kProcessorOnlyId), PClassInfo::kManyInstances, kVstAudioEffectClass,
  "Garak Native Test Processor Only", Vst::kDistributable, "Fx|Tools", "1.0.0", kVstVersionString, TestProcessor::createProcessorOnly)
END_FACTORY

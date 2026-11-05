#include "protocol.hpp"
#include "garak/device.hpp"
#include "garak/vst3.hpp"
#include "ieum_wave/patch.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <bit>
#include <chrono>
#include <condition_variable>
#include <cerrno>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <set>
#include <thread>
#if defined(_WIN32)
#include <windows.h>
#include <io.h>
#include <fcntl.h>
#else
#include <poll.h>
#include <unistd.h>
#endif

namespace {
using namespace garak;
using namespace garak::protocol;
using Clock = std::chrono::steady_clock;
constexpr std::size_t maxLine = 64 * 1024 * 1024;
constexpr std::uint32_t scratchFrames = 4096;
std::filesystem::path pathOf(const std::string& value) { return std::filesystem::u8path(value); }

void put16(std::ostream& out, std::uint16_t v) { const char b[]{char(v),char(v>>8)}; out.write(b,2); }
void put32(std::ostream& out, std::uint32_t v) { const char b[]{char(v),char(v>>8),char(v>>16),char(v>>24)}; out.write(b,4); }
void waveHeader(std::ostream& out, std::uint32_t rate, std::uint16_t channels, std::uint64_t frames, bool floating) {
  const auto bytes = frames * channels * (floating ? 4 : 2);
  if (bytes > 0xffffffffu - 36) throw std::runtime_error("WAV exceeds RIFF capacity");
  out.seekp(0); out.write("RIFF",4); put32(out,static_cast<std::uint32_t>(bytes+36)); out.write("WAVEfmt ",8); put32(out,16);
  put16(out,floating ? 3 : 1); put16(out,channels); put32(out,rate); put32(out,rate*channels*(floating?4:2));
  put16(out,channels*(floating?4:2)); put16(out,floating?32:16); out.write("data",4); put32(out,static_cast<std::uint32_t>(bytes));
}

/** A single non-realtime consumer writes the preallocated recording ring. */
class RecordingFile {
 public:
  RecordingFile(RenderEngine& engine, std::string path, std::uint32_t rate, std::uint16_t channels)
      : engine_(engine), path_(std::move(path)), rate_(rate), channels_(channels),
        file_(pathOf(path_),std::ios::binary|std::ios::out|std::ios::trunc) {
    if (!file_) throw std::runtime_error("Cannot create recording file");
    waveHeader(file_,rate_,channels_,0,true); file_.flush();
    thread_ = std::thread([this] { run(); });
  }
  ~RecordingFile() { finish(); }
  void finish() noexcept { stopping_.store(true); if (thread_.joinable()) thread_.join(); }
  [[nodiscard]] std::uint64_t frames() const noexcept { return frames_.load(); }
  [[nodiscard]] bool failed() const noexcept { return failed_.load(); }
  [[nodiscard]] std::uint16_t channels() const noexcept { return channels_; }
  [[nodiscard]] const std::string& path() const noexcept { return path_; }
 private:
  void run() noexcept {
    try {
      std::array<float,scratchFrames*2> pcm{}, mono{};
      auto checkpoint = Clock::now();
      for (;;) {
        const auto n = engine_.drainRecording(pcm.data(),scratchFrames);
        if (n) {
          if (channels_ == 1) for (std::uint32_t i=0;i<n;++i) mono[i]=pcm[i*2];
          file_.write(reinterpret_cast<const char*>(channels_==1?mono.data():pcm.data()),std::streamsize(n)*channels_*sizeof(float));
          frames_.fetch_add(n);
          if (!file_) throw std::runtime_error("Recording disk write failed");
        } else if (stopping_.load()) break;
        else std::this_thread::sleep_for(std::chrono::milliseconds(2));
        if (Clock::now()-checkpoint>std::chrono::seconds(1)) {
          waveHeader(file_,rate_,channels_,frames_.load(),true); file_.seekp(0,std::ios::end); file_.flush(); checkpoint=Clock::now();
        }
      }
      waveHeader(file_,rate_,channels_,frames_.load(),true); file_.flush(); file_.close();
    } catch (...) { failed_.store(true); }
  }
  RenderEngine& engine_; std::string path_; std::uint32_t rate_; std::uint16_t channels_;
  std::ofstream file_; std::thread thread_; std::atomic<bool> stopping_{false},failed_{false}; std::atomic<std::uint64_t> frames_{0};
};

template<class T> Json optionalJson(const std::optional<T>& value) { return value?Json(*value):Json(nullptr); }
Json deviceJson(const DeviceState& s) {
  return {{"configured",s.configured},{"running",s.running},{"backend",s.backend},{"inputDeviceId",s.inputDeviceId},{"outputDeviceId",s.outputDeviceId},
    {"inputName",s.name},{"outputName",s.name},{"sampleRate",s.sampleRate},{"bufferFrames",s.bufferFrames},{"inputChannels",s.inputChannels},{"outputChannels",s.outputChannels},
    {"inputChannelOffset",s.inputChannelOffset},{"outputChannelOffset",s.outputChannelOffset},
    {"inputDeviceSampleRate",s.inputDeviceSampleRate},{"outputDeviceSampleRate",s.outputDeviceSampleRate},{"inputLatencyFrames",optionalJson(s.inputLatencyFrames)},
    {"outputLatencyFrames",optionalJson(s.outputLatencyFrames)},{"underruns",s.discontinuities},{"needsReconfigure",s.needsReconfigure},{"resampling",s.resampling},{"error",s.error},
    {"errorCode",s.errorCode.empty()?Json(nullptr):Json(s.errorCode)},{"inputChannelList",s.inputChannelList},{"inputNames",s.inputNames},{"outputNames",s.outputNames},
    {"bufferAdjusted",s.bufferAdjusted},{"recovering",s.recovering},{"recoveries",s.recoveries},{"suspended",s.suspended},
    {"clockSource",optionalJson(s.clockSource)},{"directMonitoring",s.directMonitoring}};
}
Json bufferJson(const std::optional<BufferCaps>& caps,const std::vector<std::uint32_t>& sizes) {
  return {{"min",caps?Json(caps->minimum):Json(nullptr)},{"max",caps?Json(caps->maximum):Json(nullptr)},{"preferred",caps?Json(caps->preferred):Json(nullptr)},
    {"granularity",caps?Json(caps->granularity):Json(nullptr)},{"sizes",sizes},{"fixed",caps.has_value()&&sizes.size()==1}};
}
Json probeJson(const DeviceProbe& p) {
  Json inputs=Json::array(),outputs=Json::array(),clocks=Json::array();
  for(const auto& c:p.inputs) inputs.push_back({{"index",c.index},{"name",c.name}});
  for(const auto& c:p.outputs) outputs.push_back({{"index",c.index},{"name",c.name}});
  for(const auto& c:p.clockSources) clocks.push_back({{"index",c.index},{"name",c.name},{"current",c.current}});
  return {{"id",p.id},{"name",p.name},{"backend",p.backend},{"inputs",inputs},{"outputs",outputs},{"sampleRates",p.sampleRates},
    {"currentSampleRate",optionalJson(p.currentSampleRate)},{"buffer",bufferJson(p.buffer,p.bufferSizes)},{"clockSources",clocks},
    {"canDirectMonitor",p.canDirectMonitor},{"inputLatencyFrames",optionalJson(p.inputLatencyFrames)},{"outputLatencyFrames",optionalJson(p.outputLatencyFrames)}};
}
Json errorDetailsJson(const DeviceErrorDetails& d) {
  Json result=Json::object();
  if(!d.supportedSampleRates.empty()) result["supported"]=d.supportedSampleRates;
  if(d.buffer) result["buffer"]=bufferJson(d.buffer,device_logic::allowedBufferSizes(*d.buffer));
  if(d.availableInputs) result["availableInputs"]=*d.availableInputs;
  if(d.availableOutputs) result["availableOutputs"]=*d.availableOutputs;
  return result;
}
// The synthetic clock behaves like a fixed two-in/two-out interface so CI can
// exercise probing, buffer snapping, channel lists and suspend/resume.
constexpr BufferCaps testBufferCaps{16,4096,128,16};
Json descriptorJson(const PluginDescriptor& p) { return {{"classId",p.classId},{"name",p.name},{"vendor",p.vendor},{"version",p.version},{"category",p.category},{"isInstrument",p.isInstrument}}; }

class Host {
 public:
  explicit Host(bool testClock):test_(testClock) {}
  ~Host() { close(); }
  void service() {
    if (test_ && configured_ && engine_ && testState_.running) {
      const auto now=Clock::now(); int count=0;
      while (now>=nextTest_ && count++<8) {
        const auto frames=testState_.bufferFrames;
        if (testState_.inputChannels) {
          for (std::uint32_t i=0;i<frames;++i) { const float v=testTone_?float(.15*std::sin(testPhase_)):0; testPhase_+=6.283185307179586*220/testState_.sampleRate; for(std::uint32_t c=0;c<testState_.inputChannels;++c) testInput_[std::size_t(i)*testState_.inputChannels+c]=v; }
        }
        callback(this,testOutput_.data(),testState_.inputChannels?testInput_.data():nullptr,frames,testState_.inputChannels);
        nextTest_+=std::chrono::nanoseconds(std::int64_t(1e9*frames/testState_.sampleRate));
      }
      if (count>=8) nextTest_=now;
    }
    if (!test_) device_.service();
    if (engine_) engine_->collectRetired();
    const auto epoch=callbacks_.load();
    std::erase_if(retiredPreview_,[epoch](const auto& item){return epoch>=item.first;});
    for (auto& [id,p]:plugins_) {
      p.processor->service();
      const auto status=p.processor->status();
      if (status.faulted || status.restartFlags) {
        pluginError_="VST3 "+id+": "+(status.error.empty()?"플러그인 구성이 변경되었습니다. 재생을 멈추고 오디오 장치를 다시 연결해주세요.":status.error);
        if (!test_) device_.stop();
        else testState_.running=false;
        configured_=false;
      }
    }
    if (recording_ && (recording_->failed() || (engine_ && engine_->snapshot().recordingDroppedFrames))) {
      if (!recordingError_) { recordingError_=true; (void)engine_->stopRecording(); }
    }
  }
  Json request(const std::string& method,const Json& a) {
    if (method=="hello") return {{"protocol",1},{"engine","garak-native"},{"testClock",test_},{"vst3",vst3Available()},{"backends",DeviceHost::availableBackends()},
      {"wavetable",{{"protocolVersion",1},{"schemaFingerprint",ieum::wave::generated::kSchemaFingerprint},{"minimumSampleRate",22050},{"maximumSampleRate",192000}}}};
    if (method=="engine.snapshot") return snapshot();
    if (method=="devices.list") {
      Json result=Json::array();
      if (test_) return Json::array({{{"id","test-device"},{"name","Test clock (no audio hardware)"},{"backend","test"},{"inputChannels",2},{"outputChannels",2},{"isDefault",true}}});
      for(const auto& d:DeviceHost::enumerate(a.value("backend",std::string{}))) result.push_back({{"id",d.id},{"name",d.name},{"backend",d.backend},{"inputChannels",d.inputChannels},{"outputChannels",d.outputChannels},{"isDefault",d.isDefault},{"sampleRates",d.sampleRates},{"bufferSizes",d.bufferSizes}});
      return result;
    }
    if (method=="engine.configure") return configure(a);
    if (method=="engine.close") { close(); return Json::object(); }
    if (method=="test.fault") {
      if(!test_) throw std::runtime_error("Test fault injection is not enabled");
      requireEngine();
      // CLI smoke harness only: leave the capture ring intact while stopping
      // the synthetic callback, just as a failed device leaves a partial take.
      configured_=false; testState_.running=false; testState_.needsReconfigure=true;
      testState_.error="Injected test device failure";
      return snapshot();
    }
    if (method=="asset.load") return loadAsset(a);
    if (method=="samples.register") { auto set=sampleSet(a); for(const auto& z:set.zones) if(!assets_.contains(z.assetId)) throw std::runtime_error("Sample asset is missing"); for(const auto& z:set.releaseZones) if(!assets_.contains(z.assetId)) throw std::runtime_error("Release sample asset is missing"); sets_[set.id]=std::move(set); return Json::object(); }
    if (method=="project.set") {
      auto project=timeline(a.at("timeline"));
      if (engine_ && configured_ && project.sampleRate!=engine_->snapshot().sampleRate) throw std::runtime_error("Project and device sample rates differ; configure the device first");
      if (!engine_) engine_=std::make_unique<RenderEngine>(project.sampleRate,scratchFrames);
      auto prepared=engine_->prepare(project,assets_,sets_,resolver(false));
      if(a.value("awaitApplied",false))requireEngine();
      const auto ticket=engine_->submit(std::move(prepared)); project_=std::move(project); prunePlugins();
      if(a.value("awaitApplied",false))awaitApplied(ticket);
      return {{"revision",project_.revision}};
    }
    if (method=="render.wav") return render(a);
    if (method=="device.controlPanel" || method=="devices.controlPanel") { if(test_) return Json::object(); device_.showControlPanel(); return Json::object(); }
    if (method=="devices.probe") return probeJson(test_?testProbe():device_.probe(string(a,"backend",32),a.value("deviceId",std::string{})));
    if (method.rfind("device.",0)==0) return deviceRequest(method,a);
    // A device/plugin fault must not prevent a captured take being finalized.
    if(method!="record.stop") requireEngine();
    if (method=="transport.play") { awaitApplied(engine_->play()); return snapshot(); }
    if (method=="transport.pause") { awaitApplied(engine_->pause()); return snapshot(); }
    if (method=="transport.stop") { awaitApplied(engine_->stop()); clearPreview(); return snapshot(); }
    if (method=="transport.seek") { awaitApplied(engine_->seek(integer(a,"frame",0,project_.lengthFrames,0))); return snapshot(); }
    if (method=="note.preview") {
      const auto pitch=static_cast<int>(integer(a,"pitch",0,127,60)); const auto velocity=static_cast<float>(number(a,"velocity",0,4,.8));
      const auto frames=std::uint32_t(number(a,"durationSeconds",.01,10,.5)*currentDevice().sampleRate);
      if (a.contains("trackId") && a.at("trackId").is_string() && !a.at("trackId").get<std::string>().empty()) { awaitApplied(engine_->previewNote(trackIndex(a.at("trackId").get<std::string>()),pitch,velocity,frames)); }
      else {
        auto audition=source(a.at("source"));
        if(audition.kind!=TrackSource::Kind::BuiltinSynth && audition.kind!=TrackSource::Kind::BuiltinSampled && audition.kind!=TrackSource::Kind::NativeWavetable) throw std::runtime_error("Standalone audition supports built-in instruments only");
        preview(std::move(audition),pitch,velocity,frames);
      }
      return Json::object();
    }
    if (method=="note.on" || method=="note.off") {
      const auto index=trackIndex(string(a,"trackId")); const auto pitch=static_cast<int>(integer(a,"pitch",0,127,60)); const auto id=static_cast<std::int32_t>(integer(a,"noteId",0,2000000000,0));
      awaitApplied(method=="note.on"?engine_->noteOn(index,pitch,static_cast<float>(number(a,"velocity",0,4,.8)),id):engine_->noteOff(index,pitch,id));
      return Json::object();
    }
    if(method=="note.allOff") { awaitApplied(engine_->allNotesOff(trackIndex(string(a,"trackId")))); return Json::object(); }
    if (method=="monitor.set") {
      std::vector<std::uint32_t> tracks;
      if(a.value("enabled",false)) {
        if(!currentDevice().inputChannels) throw std::runtime_error("Enable the native input device before monitoring");
        const auto& ids=a.at("trackIds"); if(!ids.is_array() || ids.size()>256) throw std::runtime_error("Invalid monitor tracks");
        for(const auto& id:ids) tracks.push_back(trackIndex(id.get<std::string>()));
      }
      awaitApplied(engine_->setMonitoring(tracks)); return Json::object();
    }
    if (method=="record.start") {
      if(recording_) throw std::runtime_error("Recording is already active");
      if(!currentDevice().inputChannels) throw std::runtime_error("Native input is not configured");
      if(!engine_->snapshot().playing) throw std::runtime_error("Start transport playback before recording");
      const auto index=trackIndex(string(a,"trackId")); if(project_.tracks[index].source.kind!=TrackSource::Kind::Audio) throw std::runtime_error("Recording requires an audio track");
      recordingError_=false;
      recording_=std::make_unique<RecordingFile>(*engine_,string(a,"path",32768),currentDevice().sampleRate,std::uint16_t(std::min(2u,currentDevice().inputChannels)));
      try { awaitApplied(engine_->startRecording()); } catch(...) { recording_.reset(); throw; }
      const auto s=engine_->snapshot(); const auto device=currentDevice();
      recordingRawStart_=s.recordingStartFrame;
      recordingCompensation_=std::uint64_t(device.inputLatencyFrames.value_or(0))+device.outputLatencyFrames.value_or(0)+s.latencyFrames;
      recordingCompensationKnown_=device.inputLatencyFrames.has_value()&&device.outputLatencyFrames.has_value();
      return {{"startFrame",recordingRawStart_-std::int64_t(recordingCompensation_)},{"rawStartFrame",recordingRawStart_},
        {"compensationFrames",recordingCompensation_},{"compensationKnown",recordingCompensationKnown_},{"sampleRate",s.sampleRate},{"channels",recording_->channels()}};
    }
    if (method=="record.stop") {
      if(!recording_ || !engine_) throw std::runtime_error("No active recording");
      const auto ticket=engine_->stopRecording();
      if(configured_ && currentDevice().running) awaitApplied(ticket);
      else {
        // The callback is joined/stopped before the control thread consumes its
        // final command. No synthetic input frames are added to the take.
        if(!test_) device_.stop();
        std::array<float,2> scratch{}; engine_->render(scratch.data(),nullptr,0,0);
        recordingError_=true;
      }
      const auto s=engine_->snapshot(); recording_->finish();
      Json result={{"path",recording_->path()},{"startFrame",recordingRawStart_-std::int64_t(recordingCompensation_)},{"rawStartFrame",recordingRawStart_},
        {"compensationFrames",recordingCompensation_},{"compensationKnown",recordingCompensationKnown_},{"frames",recording_->frames()},{"sampleRate",s.sampleRate},{"channels",recording_->channels()}};
      if(recordingError_ || recording_->failed() || s.recordingDroppedFrames) result["error"]="장치·플러그인 또는 녹음 오류로 중단되었습니다. 복구 폴더에 받은 오디오를 보관했습니다.";
      recording_.reset(); return result;
    }
    if (method=="output.test") { toneRemaining_.store(a.value("active",true)?currentDevice().sampleRate*2:0); return Json::object(); }
    if (method=="test.input") { if(!test_) throw std::runtime_error("Test input is not enabled"); testTone_=a.value("active",true); return Json::object(); }
    if (method.rfind("plugins.",0)==0) return pluginRequest(method,a);
    throw std::runtime_error("Unknown native audio method: "+method);
  }
 private:
  struct PluginEntry { PluginSpec spec; std::shared_ptr<Vst3Processor> processor; };
  static bool sameModuleState(const PluginSpec& a,const PluginSpec& b) { return a.path==b.path && a.classId==b.classId && a.state==b.state && a.controllerState==b.controllerState && a.isInstrument==b.isInstrument; }
  PluginResolver resolver(bool offline,std::vector<std::shared_ptr<Vst3Processor>>* renderedPlugins=nullptr) {
    return [this,offline,renderedPlugins](const PluginSpec& spec,double rate,std::uint32_t block)->std::shared_ptr<PluginProcessor> {
      if(offline) {
        auto processor=std::make_shared<Vst3Processor>(spec,rate,block,true);
        if(renderedPlugins) renderedPlugins->push_back(processor);
        return processor;
      }
      auto found=plugins_.find(spec.instanceId);
      if(found!=plugins_.end() && sameModuleState(found->second.spec,spec)) {
        for(const auto& [id,value]:spec.parameters) if(!found->second.spec.parameters.contains(id)||found->second.spec.parameters[id]!=value) found->second.processor->setParameter(id,value);
        found->second.spec.parameters=spec.parameters; return found->second.processor;
      }
      auto processor=std::make_shared<Vst3Processor>(spec,rate,block,false);
      plugins_[spec.instanceId]={spec,processor}; return processor;
    };
  }
  void prunePlugins() {
    std::set<std::string> active;
    // Bypass must preserve the editor state until its serialized slot is removed.
    for(const auto& t:project_.tracks) { if(t.source.kind==TrackSource::Kind::Vst3) active.insert(t.source.plugin.instanceId); for(const auto& i:t.inserts) if(i.type=="vst3") active.insert(i.plugin.instanceId); }
    std::erase_if(plugins_,[&](const auto& entry){return !active.contains(entry.first);});
  }
  Json pluginRequest(const std::string& method,const Json& a) {
    const auto id=string(a,"instanceId"); const auto found=plugins_.find(id);
    if(found==plugins_.end()) {
      if(method=="plugins.state" && a.value("allowUnloaded",false)) {
        for(const auto& track:project_.tracks) {
          if(!track.enabled && track.source.kind==TrackSource::Kind::Vst3 && track.source.plugin.instanceId==id) return nullptr;
          for(const auto& insert:track.inserts)
            if(insert.type=="vst3" && (!insert.enabled || !track.enabled) && insert.plugin.instanceId==id) return nullptr;
        }
      }
      throw std::runtime_error("Plugin instance is not loaded");
    }
    auto& p=*found->second.processor;
    if(method=="plugins.parameters") { Json result=Json::array(); for(const auto& v:p.parameters()) result.push_back({{"id",std::to_string(v.id)},{"title",v.title},{"min",0},{"max",1},{"defaultValue",v.defaultValue},{"value",v.value},{"stepCount",v.stepCount},{"units",v.units},{"readOnly",v.readOnly},{"hidden",v.hidden}}); return result; }
    if(method=="plugins.parameter") {
      std::string key=a.at("id").is_string()?a.at("id").get<std::string>():a.at("id").dump(); std::uint32_t parameter=0; const auto parsed=std::from_chars(key.data(),key.data()+key.size(),parameter);
      if(parsed.ec!=std::errc{}||parsed.ptr!=key.data()+key.size()) throw std::runtime_error("Invalid plugin parameter ID");
      const auto value=number(a,"value",0,1,0); p.setParameter(parameter,value); found->second.spec.parameters[parameter]=value; return Json::object();
    }
    if(method=="plugins.editor") { if(a.value("open",true)) p.openEditor(); else p.closeEditor(); return Json::object(); }
    if(method=="plugins.state") {
      if(engine_->snapshot().playing || recording_) throw std::runtime_error("Pause playback before saving opaque plugin state");
      if(!test_) device_.stop();
      try { const auto state=p.saveState(); if(!test_) device_.start(); return {{"component",base64(state.component)},{"controller",base64(state.controller)}}; }
      catch(...) { if(!test_) device_.start(); throw; }
    }
    throw std::runtime_error("Unknown plugin operation");
  }
  [[nodiscard]] bool recordingActive() const { return recording_!=nullptr; }
  DeviceProbe testProbe() const {
    DeviceProbe p; p.id="test-device"; p.name="Test clock (no audio hardware)"; p.backend="test";
    p.inputs={{0,"Input 1"},{1,"Input 2"}}; p.outputs={{0,"Output 1"},{1,"Output 2"}};
    p.sampleRates.assign(std::begin(device_logic::kProbeSampleRates),std::end(device_logic::kProbeSampleRates));
    p.currentSampleRate=testState_.configured?testState_.sampleRate:48000;
    p.buffer=testBufferCaps; p.bufferSizes=device_logic::allowedBufferSizes(testBufferCaps);
    p.clockSources={{0,"Internal",true}};
    return p;
  }
  // device.clockSource/directMonitor/suspend/resume. Each answers the device state.
  Json deviceRequest(const std::string& method,const Json& a) {
    requireEngine();
    if(method=="device.clockSource") {
      const auto index=static_cast<std::int32_t>(integer(a,"index",0,255,0));
      if(test_) { if(index!=0) throw std::invalid_argument("The test clock has no clock source "+std::to_string(index)+"."); }
      else device_.setClockSource(index);
    } else if(method=="device.directMonitor") {
      if(!a.contains("enabled") || !a.at("enabled").is_boolean()) throw std::runtime_error("Missing boolean: enabled");
      if(test_) throw std::runtime_error("The test clock does not offer direct monitoring control.");
      device_.setDirectMonitoring(a.at("enabled").get<bool>());
    } else if(method=="device.suspend" || method=="device.resume") {
      if(recordingActive()) throw std::runtime_error("Stop recording before releasing or reopening the audio device");
      const bool suspend=method=="device.suspend";
      if(test_) {
        if(testState_.suspended!=suspend) { testState_.suspended=suspend; testState_.running=!suspend; nextTest_=Clock::now(); }
      } else if(suspend) device_.suspend();
      else device_.resume();
    } else throw std::runtime_error("Unknown native audio method: "+method);
    auto result=deviceJson(currentDevice()); result["testClock"]=test_; return result;
  }
  DeviceState currentDevice() const { return test_?testState_:device_.state(); }
  void requireEngine() const { if(!engine_ || !configured_) throw std::runtime_error("Configure a native audio device first"); }
  std::uint32_t trackIndex(const std::string& id) const {
    const auto found=std::find_if(project_.tracks.begin(),project_.tracks.end(),[&](const auto& track){return track.id==id;});
    if(found==project_.tracks.end()) throw std::runtime_error("Track is missing");
    return static_cast<std::uint32_t>(std::distance(project_.tracks.begin(),found));
  }
  static DeviceConfig deviceConfig(const Json& a) {
    DeviceConfig config;
    config.backend=string(a,"backend",32); config.sampleRate=std::uint32_t(integer(a,"sampleRate",8000,192000,48000));
    if(a.contains("bufferFrames") && a.at("bufferFrames").is_string()) {
      if(a.at("bufferFrames").get<std::string>()!="driver") throw std::runtime_error("Invalid bufferFrames");
      config.bufferFrames=device_logic::kDriverBuffer;
    } else config.bufferFrames=std::uint32_t(integer(a,"bufferFrames",16,16384,128));
    config.inputDeviceId=a.value("inputDeviceId",std::string{}); config.outputDeviceId=a.value("outputDeviceId",std::string{});
    // inputChannelList wins over the legacy contiguous 0..2-channel selection.
    if(a.contains("inputChannelList") && !a.at("inputChannelList").is_null()) {
      const auto& list=a.at("inputChannelList");
      if(!list.is_array() || list.size()>device_logic::kMaxInputChannels) throw std::runtime_error("Invalid inputChannelList");
      for(const auto& item:list) {
        if(!item.is_number_integer() || item.get<std::int64_t>()<0 || item.get<std::int64_t>()>device_logic::kMaxPhysicalChannel) throw std::runtime_error("Invalid input channel index");
        config.inputChannelList.push_back(item.get<std::uint32_t>());
      }
      device_logic::validateInputList(config.inputChannelList);
      config.inputChannels=std::uint32_t(config.inputChannelList.size()); config.inputChannelOffset=config.inputChannelList.empty()?0:config.inputChannelList.front();
    } else {
      config.inputChannels=std::uint32_t(integer(a,"inputChannels",0,2,0)); config.inputChannelOffset=std::uint32_t(integer(a,"inputChannelOffset",0,255,0));
    }
    config.outputChannelOffset=std::uint32_t(integer(a,"outputChannelOffset",0,255,0)); config.lowLatencyMonitoring=a.value("lowLatencyMonitoring",true); config.exclusive=a.value("exclusive",false);
    if(a.contains("clockSource") && !a.at("clockSource").is_null()) config.clockSource=static_cast<std::int32_t>(integer(a,"clockSource",0,255,0));
    config.directMonitoring=a.value("directMonitoring",false);
    return config;
  }
  void configureTestClock(const DeviceConfig& config) {
    const auto probe=testProbe(); const auto inputs=resolvedInputList(config);
    device_logic::validateInputList(inputs);
    if(!device_logic::inputsAvailable(inputs,2) || !device_logic::outputPairAvailable(config.outputChannelOffset,2)) {
      DeviceErrorDetails details; details.availableInputs=2; details.availableOutputs=2;
      throw DeviceError(DeviceErrorCode::ChannelsUnavailable,"The test clock has two inputs and one stereo output pair.",details);
    }
    if(std::find(probe.sampleRates.begin(),probe.sampleRates.end(),config.sampleRate)==probe.sampleRates.end()) {
      DeviceErrorDetails details; details.supportedSampleRates=probe.sampleRates;
      throw DeviceError(DeviceErrorCode::SampleRateUnsupported,"The test clock cannot run at "+std::to_string(config.sampleRate)+" Hz.",details);
    }
    const auto buffer=device_logic::snapBufferSize(testBufferCaps,config.bufferFrames);
    testState_={}; testState_.configured=true; testState_.running=true; testState_.backend="test"; testState_.name=probe.name;
    testState_.sampleRate=config.sampleRate; testState_.bufferFrames=buffer.frames; testState_.bufferAdjusted=buffer.adjusted;
    testState_.inputChannelList=inputs; testState_.inputChannels=std::uint32_t(inputs.size()); testState_.inputChannelOffset=inputs.empty()?0:inputs.front();
    for(const auto c:inputs) testState_.inputNames.push_back(probe.inputs[c].name);
    testState_.outputNames={"Output 1","Output 2"}; testState_.outputChannels=2; testState_.inputDeviceId="test-device"; testState_.outputDeviceId="test-device";
    testState_.outputChannelOffset=config.outputChannelOffset; testState_.clockSource=0;
  }
  Json configure(const Json& a) {
    if(recording_) throw std::runtime_error("Stop recording before changing the audio device");
    const auto oldFrame=engine_?engine_->snapshot().frame:0;
    closeDevice(); pluginError_.clear(); recordingError_=false;
    const auto config=deviceConfig(a);
    if(test_) configureTestClock(config);
    else device_.configure(config,callback,this);
    const auto state=currentDevice();
    if(!state.sampleRate || !state.bufferFrames) { device_.close(); throw std::runtime_error("Audio driver did not report a usable configuration"); }
    engine_=std::make_unique<RenderEngine>(state.sampleRate,scratchFrames); plugins_.clear();
    project_.lowLatencyMonitoring=config.lowLatencyMonitoring;
    if(project_.projectId.empty()) { project_.projectId="empty"; project_.sampleRate=state.sampleRate; project_.lengthFrames=state.sampleRate; }
    if(project_.sampleRate!=state.sampleRate) { project_={}; project_.projectId="empty"; project_.sampleRate=state.sampleRate; project_.lengthFrames=state.sampleRate; }
    auto prepared=engine_->prepare(project_,assets_,sets_,resolver(false)); engine_->submit(std::move(prepared));
    (void)engine_->setInputChannels(0,state.inputChannels>1?1:-1); (void)engine_->seek(std::min(oldFrame,project_.lengthFrames));
    configured_=true; nextTest_=Clock::now();
    try { if(!test_) device_.start(); } catch(...) { configured_=false; device_.close(); throw; }
    auto result=deviceJson(currentDevice()); result["testClock"]=test_; return result;
  }
  Json loadAsset(const Json& a) {
    auto asset=std::make_shared<PcmAsset>(); asset->id=string(a,"id"); asset->sampleRate=std::uint32_t(integer(a,"sampleRate",8000,192000,48000)); asset->channels=std::uint32_t(integer(a,"channels",1,32,2));
    const auto frames=integer(a,"frames",1,536870912/(asset->channels*4),1); const auto bytes=std::uint64_t(frames)*asset->channels*4;
    const auto path=pathOf(string(a,"path",32768));
    if(std::filesystem::file_size(path)!=bytes) throw std::runtime_error("PCM file length does not match metadata");
    std::uint64_t total=bytes; for(const auto& [id,other]:assets_) if(id!=asset->id) total+=other->samples.size()*sizeof(float);
    if(total>std::uint64_t(2)*1024*1024*1024) throw std::runtime_error("Native PCM cache exceeds 2 GiB");
    asset->samples.resize(static_cast<std::size_t>(bytes/4)); std::ifstream file(path,std::ios::binary); file.read(reinterpret_cast<char*>(asset->samples.data()),static_cast<std::streamsize>(bytes));
    if(!file || !std::all_of(asset->samples.begin(),asset->samples.end(),[](float v){return std::isfinite(v);})) throw std::runtime_error("Invalid PCM file");
    assets_[asset->id]=asset; return {{"id",asset->id},{"sampleRate",asset->sampleRate},{"channels",asset->channels},{"frames",frames}};
  }
  void awaitApplied(std::uint64_t ticket) {
    if(!ticket) throw std::runtime_error("Audio control queue is full");
    const auto until=Clock::now()+std::chrono::seconds(2);
    while(engine_->snapshot().lastAppliedCommand<ticket) {
      service(); pumpNativeEvents();
      if(Clock::now()>until || (!test_ && !device_.state().running)) throw std::runtime_error("Audio callback did not acknowledge the command");
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
  }
  void preview(TrackSource source,int pitch,float velocity,std::uint32_t duration) {
    auto next=std::make_unique<RenderEngine>(currentDevice().sampleRate,scratchFrames);
    ProjectTimeline project; project.projectId="audition"; project.sampleRate=currentDevice().sampleRate; project.lengthFrames=duration+project.sampleRate*2; project.masterGain=project_.masterGain;
    TrackTimeline track; track.id="audition"; track.source=std::move(source); track.gain=.7f; track.notes.push_back({0,0,duration,project.lengthFrames,pitch,velocity}); project.tracks.push_back(std::move(track));
    next->submit(next->prepare(project,assets_,sets_,resolver(true))); (void)next->play();
    auto previous=std::move(previewOwned_); previewOwned_=std::move(next); preview_.store(previewOwned_.get(),std::memory_order_release);
    if(previous) retiredPreview_.emplace_back(callbacks_.load()+2,std::move(previous));
  }
  void clearPreview() { preview_.store(nullptr,std::memory_order_release); if(previewOwned_) retiredPreview_.emplace_back(callbacks_.load()+2,std::move(previewOwned_)); }
  static void callback(void* context,float* output,const float* input,std::uint32_t frames,std::uint32_t channels) noexcept {
    auto& host=*static_cast<Host*>(context);
    if(host.engine_) host.engine_->render(output,input,frames,channels); else std::fill_n(output,std::size_t(frames)*2,0.f);
    auto* audition=host.preview_.load(std::memory_order_acquire);
    if(audition) for(std::uint32_t offset=0;offset<frames;offset+=scratchFrames) {
      const auto count=std::min(scratchFrames,frames-offset); audition->render(host.previewScratch_.data(),nullptr,count,0);
      for(std::uint32_t i=0;i<count*2;++i) output[offset*2+i]+=host.previewScratch_[i];
    }
    auto remaining=host.toneRemaining_.load(); const auto originalRemaining=remaining;
    if(remaining) {
      const auto rate=host.engine_?host.engine_->snapshot().sampleRate:48000;
      for(std::uint32_t i=0;i<frames && remaining;++i,--remaining) {
        const auto edge=std::min({1.0,double(remaining)/128,double(rate*2-remaining)/128});
        const float v=float(.06*edge*std::sin(host.outputPhase_)); host.outputPhase_+=6.283185307179586*440/rate;
        output[i*2]+=v; output[i*2+1]+=v;
      }
      // Do not overwrite an output-test stop/restart that arrived during render.
      auto expected=originalRemaining;
      host.toneRemaining_.compare_exchange_strong(expected,remaining);
    }
    for(std::uint32_t i=0;i<frames*2;++i) output[i]=std::isfinite(output[i])?std::clamp(output[i],-1.f,1.f):0.f;
    host.callbacks_.fetch_add(1,std::memory_order_release);
  }
  Json render(const Json& a) {
    if(recording_) throw std::runtime_error("Stop recording before exporting");
    if(configured_ && engine_ && engine_->snapshot().playing) awaitApplied(engine_->pause());
    const bool restart=!test_ && device_.state().running;
    if(restart) device_.stop();
    try {
      auto result=renderStopped(a);
      if(restart) device_.start();
      return result;
    } catch(...) {
      if(restart) {
        try { device_.start(); }
        catch(const std::exception& error) { configured_=false; pluginError_=std::string("WAV 출력 후 장치를 다시 열지 못했습니다: ")+error.what(); }
      }
      throw;
    }
  }
  Json renderStopped(const Json& a) {
    auto project=timeline(a.at("timeline")); project.cycle.reset();
    RenderEngine offline(project.sampleRate,scratchFrames); offline.setOffline(true);
    std::vector<std::shared_ptr<Vst3Processor>> renderedPlugins;
    auto prepared=offline.prepare(project,assets_,sets_,resolver(true,&renderedPlugins)); const auto tail=std::min(30.0,prepared->tailSeconds());
    const std::uint64_t latency=prepared->latencyFrames();
    const auto total=std::uint64_t(project.lengthFrames)+std::uint64_t(std::ceil(tail*project.sampleRate));
    if(total*4>512u*1024*1024) throw std::runtime_error("WAV export exceeds 512 MiB");
    const auto path=string(a,"path",32768); std::ofstream file(pathOf(path),std::ios::binary|std::ios::out|std::ios::trunc); if(!file) throw std::runtime_error("Cannot create WAV export");
    waveHeader(file,project.sampleRate,2,total,false); offline.submit(std::move(prepared)); (void)offline.play();
    std::array<float,scratchFrames*2> pcm{}; std::array<char,scratchFrames*4> bytes{};
    // Remove the common PDC delay from the file, rendering those extra frames
    // at the end so the first clip and the complete release tail stay aligned.
    for(std::uint64_t done=0;done<total+latency;) {
      const auto frames=std::uint32_t(std::min<std::uint64_t>(scratchFrames,total+latency-done)); offline.render(pcm.data(),nullptr,frames,0);
      for(const auto& processor:renderedPlugins) {
        processor->service(); const auto status=processor->status();
        if(status.faulted || status.restartFlags) throw std::runtime_error("VST3 export failed: "+(status.error.empty()?std::string("plugin processing configuration changed"):status.error));
      }
      const auto skip=std::uint32_t(std::min<std::uint64_t>(frames,done<latency?latency-done:0));
      const auto written=frames-skip;
      for(std::uint32_t i=0;i<written*2;++i) { const float x=std::clamp(pcm[skip*2+i],-1.f,1.f); const auto v=std::int16_t(std::lround(x*(x<0?32768:32767))); bytes[i*2]=char(v); bytes[i*2+1]=char(std::uint16_t(v)>>8); }
      file.write(bytes.data(),std::streamsize(written)*4); if(!file) throw std::runtime_error("WAV export write failed"); done+=frames;
      if(done%(scratchFrames*32)==0) pumpNativeEvents();
    }
    file.flush(); if(!file) throw std::runtime_error("WAV export flush failed");
    return {{"path",path},{"sampleRate",project.sampleRate},{"frames",total},{"channels",2}};
  }
  Json snapshot() const {
    Json result={{"type","state"},{"ready",false},{"playing",false},{"frame",0},{"sampleRate",48000},{"masterLevel",0},{"levels",Json::object()},{"testClock",test_}};
    const auto device=currentDevice(); if(device.configured) { result["device"]=deviceJson(device); result["device"]["testClock"]=test_; }
    if(!device.error.empty()) result["error"]=device.error;
    if(engine_) {
      const auto s=engine_->snapshot();
      result.update({{"revision",s.revision},{"ready",configured_&&s.ready&&device.running},{"playing",s.playing&&device.running},{"frame",s.frame},{"sampleRate",s.sampleRate},{"masterLevel",s.masterPeak},
        {"recording",s.recording},{"recordingStartFrame",s.recordingStartFrame},{"recordedFrames",s.recordedFrames},{"recordingDroppedFrames",s.recordingDroppedFrames},{"latencyFrames",s.latencyFrames},{"commandOverflows",s.commandOverflows},{"voiceOverflows",s.voiceOverflows},{"invalidSamples",s.invalidSamples}});
      for(std::size_t i=0;i<std::min(project_.tracks.size(),std::size_t(s.trackCount));++i) result["levels"][project_.tracks[i].id]=s.trackPeaks[i];
      if(recordingError_) result["error"]="녹음 데이터가 손실되었습니다. 녹음을 중지하고 복구 파일을 확인해주세요.";
    }
    if(!pluginError_.empty()) result["error"]=pluginError_;
    return result;
  }
  void closeDevice() {
    if(!test_) device_.close(); configured_=false; testState_={};
    preview_.store(nullptr); previewOwned_.reset(); retiredPreview_.clear(); toneRemaining_.store(0);
  }
  void close() noexcept {
    try { closeDevice(); if(recording_) recording_->finish(); recording_.reset(); engine_.reset(); plugins_.clear(); assets_.clear(); sets_.clear(); project_={}; pluginError_.clear(); recordingError_=false; } catch(...) {}
  }
  bool test_=false,configured_=false,testTone_=false,recordingError_=false;
  std::string pluginError_;
  DeviceHost device_; DeviceState testState_; std::unique_ptr<RenderEngine> engine_; ProjectTimeline project_;
  AssetStore assets_; SampleSetStore sets_; std::map<std::string,PluginEntry> plugins_;
  std::unique_ptr<RecordingFile> recording_; Clock::time_point nextTest_{};
  std::int64_t recordingRawStart_=0; std::uint64_t recordingCompensation_=0; bool recordingCompensationKnown_=false;
  // Heap-allocated: up to 32 interleaved test inputs would crowd the main stack.
  std::vector<float> testInput_=std::vector<float>(std::size_t(scratchFrames)*device_logic::kMaxInputChannels);
  std::array<float,scratchFrames*2> testOutput_{},previewScratch_{};
  double testPhase_=0,outputPhase_=0; std::atomic<std::uint32_t> toneRemaining_{0};
  std::atomic<std::uint64_t> callbacks_{0}; std::atomic<RenderEngine*> preview_{nullptr}; std::unique_ptr<RenderEngine> previewOwned_;
  std::vector<std::pair<std::uint64_t,std::unique_ptr<RenderEngine>>> retiredPreview_;
};

struct InputQueue { std::mutex mutex; std::condition_variable changed; std::deque<std::string> lines; bool done=false; std::string error; };
/** Bounded, interruptible stdin reader. A GUI/plugin failure cannot leave a
 * joinable thread blocked forever in getline during stack unwinding. */
class InputReader {
 public:
  explicit InputReader(InputQueue& queue):queue_(queue),thread_([this]{read();}) {}
  ~InputReader() { stop_.store(true); if(thread_.joinable()) thread_.join(); }
 private:
  void read() noexcept {
    try {
      std::string line; line.reserve(4096); std::array<char,8192> buffer{};
      while(!stop_.load()) {
        std::size_t length=0;
#if defined(_WIN32)
        const auto input=GetStdHandle(STD_INPUT_HANDLE);
        DWORD available=0, received=0;
        if(GetFileType(input)==FILE_TYPE_PIPE) {
          if(!PeekNamedPipe(input,nullptr,0,nullptr,&available,nullptr)) {
            if(GetLastError()==ERROR_BROKEN_PIPE) break;
            throw std::runtime_error("Cannot inspect the audio control pipe");
          }
          if(!available) { std::this_thread::sleep_for(std::chrono::milliseconds(2)); continue; }
        } else if(GetFileType(input)!=FILE_TYPE_DISK) throw std::runtime_error("The audio protocol requires piped stdin");
        if(!ReadFile(input,buffer.data(),DWORD(buffer.size()),&received,nullptr)) {
          if(GetLastError()==ERROR_BROKEN_PIPE) break;
          throw std::runtime_error("Cannot read the audio control pipe");
        }
        length=received;
#else
        pollfd input{STDIN_FILENO,POLLIN,0};
        const auto ready=poll(&input,1,20);
        if(ready<0) { if(errno==EINTR) continue; throw std::runtime_error("Cannot poll the audio control pipe"); }
        if(!ready) continue;
        const auto received=::read(STDIN_FILENO,buffer.data(),buffer.size());
        if(received<0) { if(errno==EINTR) continue; throw std::runtime_error("Cannot read the audio control pipe"); }
        length=static_cast<std::size_t>(received);
#endif
        if(!length) break;
        for(std::size_t i=0;i<length;++i) {
          if(buffer[i]=='\n') {
            std::lock_guard lock(queue_.mutex);
            if(queue_.lines.size()>=64) throw std::runtime_error("Native command queue overflow");
            queue_.lines.push_back(std::move(line)); line.clear(); line.reserve(4096); queue_.changed.notify_one();
          } else { line.push_back(buffer[i]); if(line.size()>maxLine) throw std::runtime_error("Native request exceeds 64 MiB"); }
        }
      }
    } catch(const std::exception& error) { std::lock_guard lock(queue_.mutex); queue_.error=error.what(); }
    { std::lock_guard lock(queue_.mutex); queue_.done=true; }
    queue_.changed.notify_one();
  }
  InputQueue& queue_; std::atomic<bool> stop_{false}; std::thread thread_;
};
FILE* protocolOutput() {
#if defined(_WIN32)
  const int descriptor=_dup(_fileno(stdout)); _dup2(_fileno(stderr),_fileno(stdout)); _setmode(descriptor,_O_BINARY); return _fdopen(descriptor,"wb");
#else
  const int descriptor=dup(STDOUT_FILENO); dup2(STDERR_FILENO,STDOUT_FILENO); return fdopen(descriptor,"w");
#endif
}
void emit(FILE* output,const Json& value) { const auto line=value.dump()+"\n"; if(std::fwrite(line.data(),1,line.size(),output)!=line.size() || std::fflush(output)!=0) throw std::runtime_error("Control pipe closed"); }
int run(const std::vector<std::string>& args) {
  static_assert(std::endian::native==std::endian::little,"PCM protocol requires little endian");
#if !defined(_WIN32)
  std::signal(SIGPIPE,SIG_IGN);
#endif
  FILE* output=protocolOutput(); if(!output) return 1;
  try {
    initializeNativeEvents();
    if(args.size()==3 && args[1]=="--scan-plugin") { Json found=Json::array(); for(const auto& p:scanVst3(args[2])) found.push_back(descriptorJson(p)); emit(output,{{"plugins",found}}); return 0; }
    if(args.size()<2 || args[1]!="--protocol") throw std::runtime_error("Usage: garak-audio-host --protocol [--test-clock] | --scan-plugin PATH");
    const bool test=std::find(args.begin(),args.end(),"--test-clock")!=args.end();
    Host host(test); InputQueue queue; InputReader reader(queue);
    bool failed=false;
    for(;;) {
      std::string line; bool finished=false;
      { std::unique_lock lock(queue.mutex); if(queue.lines.empty()&&!queue.done) queue.changed.wait_for(lock,std::chrono::milliseconds(2)); if(!queue.lines.empty()) {line=std::move(queue.lines.front());queue.lines.pop_front();} finished=queue.done&&queue.lines.empty()&&line.empty(); if(!queue.error.empty()) failed=true; }
      if(finished) break;
      pumpNativeEvents(); host.service();
      if(line.empty()) continue;
      Json id=nullptr;
      try { const auto request=Json::parse(line); id=request.at("id"); if(!id.is_number_unsigned()&&!id.is_number_integer()) throw std::runtime_error("Invalid request ID"); const auto method=string(request,"method",128); const auto params=request.value("params",Json::object()); if(!params.is_object()) throw std::runtime_error("Invalid params"); emit(output,{{"id",id},{"ok",true},{"result",host.request(method,params)}}); }
      catch(const DeviceError& error) {
        // Classified device failures carry `code` (and `details`) both at the top
        // level (docs/AUDIO_CORE_PLAN.md) and inside the existing error object.
        const std::string code=deviceErrorCodeName(error.code()); const auto details=errorDetailsJson(error.details());
        Json problem={{"code",code.empty()?std::string("NATIVE_AUDIO_ERROR"):code},{"message",error.what()}};
        Json response={{"id",id},{"ok",false},{"error",problem}};
        if(!code.empty()) response["code"]=code;
        if(!details.empty()) { response["error"]["details"]=details; response["details"]=details; }
        emit(output,response);
      }
      catch(const std::exception& error) { emit(output,{{"id",id},{"ok",false},{"error",{{"code","NATIVE_AUDIO_ERROR"},{"message",error.what()}}}}); }
    }
    if(failed) { std::cerr<<queue.error<<"\n"; return 1; }
    return 0;
  } catch(const std::exception& error) { std::cerr<<error.what()<<"\n"; return 1; }
}
} // namespace

#if defined(_WIN32)
int wmain(int argc,wchar_t** argv) {
  std::vector<std::string> args;
  for(int i=0;i<argc;++i) { const auto length=WideCharToMultiByte(CP_UTF8,0,argv[i],-1,nullptr,0,nullptr,nullptr); std::string text(length,'\0'); WideCharToMultiByte(CP_UTF8,0,argv[i],-1,text.data(),length,nullptr,nullptr); if(!text.empty()) text.pop_back(); args.push_back(std::move(text)); }
  return run(args);
}
#else
int main(int argc,char** argv) { std::vector<std::string> args(argv,argv+argc); return run(args); }
#endif

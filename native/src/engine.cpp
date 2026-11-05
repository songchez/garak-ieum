#include "garak/engine.hpp"
#include "garak/dsp.hpp"
#include "wavetable.hpp"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <limits>
#include <set>
#include <stdexcept>
#include <string_view>
#include <thread>
#include <type_traits>
#include <utility>
#if defined(_MSC_VER) && (defined(_M_X64) || defined(_M_IX86))
#include <intrin.h>
#endif

namespace garak {
namespace {
constexpr std::size_t maxVoices = 128, maxPluginEvents = 2048;
constexpr std::size_t memoryLimit = 512u * 1024u * 1024u;
constexpr double epsilon = .00001;
constexpr std::int64_t unlimitedFrame = std::numeric_limits<std::int64_t>::max() / 4;

void require(bool condition, const char* description) { if (!condition) throw std::invalid_argument(description); }
double checked(double value, double minimum, double maximum, const char* description) {
  require(std::isfinite(value) && value >= minimum && value <= maximum, description); return value;
}
double parameter(const Parameters& p, std::string_view name, double fallback, double minimum, double maximum) {
  const auto it = p.find(name); return checked(it == p.end() ? fallback : it->second, minimum, maximum, "Invalid native instrument parameter");
}
template<class T, std::size_t N> class SpscQueue {
 public:
  bool push(const T& value) noexcept {
    const auto write = write_.load(std::memory_order_relaxed), next = (write + 1) % N;
    if (next == read_.load(std::memory_order_acquire)) return false;
    data_[write] = value; write_.store(next, std::memory_order_release); return true;
  }
  bool pop(T& value) noexcept {
    const auto read = read_.load(std::memory_order_relaxed);
    if (read == write_.load(std::memory_order_acquire)) return false;
    value = data_[read]; read_.store((read + 1) % N, std::memory_order_release); return true;
  }
 private:
  std::array<T, N> data_{};
  alignas(64) std::atomic<std::size_t> write_{0};
  alignas(64) std::atomic<std::size_t> read_{0};
};

inline void cpuRelax() noexcept {
#if defined(_MSC_VER) && (defined(_M_X64) || defined(_M_IX86))
  _mm_pause();
#elif (defined(__GNUC__) || defined(__clang__)) && (defined(__x86_64__) || defined(__i386__))
  __builtin_ia32_pause();
#elif (defined(__GNUC__) || defined(__clang__)) && defined(__aarch64__)
  __asm__ __volatile__("yield");
#endif
}
// Waits for another running thread to finish a bounded piece of work (at most
// one track block). Real-time safe: no lock, no allocation, no kernel wait.
template<class Done> void spinUntil(Done&& done) noexcept {
  for(unsigned spins=0;!done();++spins){if(spins<4096)cpuRelax();else std::this_thread::yield();}
}

// Fixed worker threads, created and joined on the control thread only. The
// callback forks one job per block and participates in it; workers sleep on
// an atomic between jobs and render ahead when the engine has such work.
class WorkerPool {
 public:
  using Task=void(*)(void*,std::uint32_t index,std::uint32_t slot)noexcept;
  using Background=bool(*)(void*,std::uint32_t slot)noexcept;
  WorkerPool(std::uint32_t threads,Background background,void*context,std::function<void(bool)> hook)
      :background_(background),context_(context),hook_(std::move(hook)) {
    threads_.reserve(threads);
    try{for(std::uint32_t i=0;i<threads;++i)threads_.emplace_back([this,i]{loop(i+1);});}
    catch(...){shutdown();throw;}
  }
  ~WorkerPool(){shutdown();}
  WorkerPool(const WorkerPool&)=delete;
  WorkerPool& operator=(const WorkerPool&)=delete;
  [[nodiscard]] std::uint32_t size()const noexcept{return static_cast<std::uint32_t>(threads_.size());}
  // Callback thread: task(index, slot) for every index; slot 0 is the caller.
  // Returns when all completed. One job at a time; count < 65536.
  void run(std::uint32_t count,Task task,void*context)noexcept {
    task_=task;taskContext_=context;done_.store(0,std::memory_order_relaxed);
    // Epoch, count and next index share one word: a worker that was late for
    // the previous job can never claim an index of this one under stale fields.
    claim_.store((std::uint64_t{++epoch_}<<32)|(std::uint64_t{count}<<16),std::memory_order_release);
    wake();
    (void)work(0);
    spinUntil([&]{return done_.load(std::memory_order_acquire)==count;});
  }
  // Callback thread: new background work may be available.
  void wake()noexcept {
    wake_.fetch_add(1,std::memory_order_seq_cst);
    if(sleepers_.load(std::memory_order_seq_cst))wake_.notify_all();
  }
 private:
  bool work(std::uint32_t slot)noexcept {
    bool any=false;auto c=claim_.load(std::memory_order_acquire);
    for(;;) {
      const auto next=c&0xffffu,count=(c>>16)&0xffffu;
      if(next>=count)return any;
      if(!claim_.compare_exchange_weak(c,c+1,std::memory_order_acq_rel,std::memory_order_acquire))continue;
      // This job cannot finish before this index does, so its fields are current.
      task_(taskContext_,static_cast<std::uint32_t>(next),slot);
      done_.fetch_add(1,std::memory_order_acq_rel);
      any=true;c=claim_.load(std::memory_order_acquire);
    }
  }
  void loop(std::uint32_t slot)noexcept {
    try{if(hook_)hook_(true);}catch(...){}
    while(!stop_.load(std::memory_order_acquire)) {
      const auto seen=wake_.load(std::memory_order_seq_cst);
      if(work(slot))continue;
      if(background_&&background_(context_,slot))continue;
      // Spin briefly: the next block usually arrives within a buffer period.
      bool changed=false;
      for(unsigned i=0;i<2048&&!changed;++i){cpuRelax();changed=wake_.load(std::memory_order_relaxed)!=seen;}
      if(changed)continue;
      sleepers_.fetch_add(1,std::memory_order_seq_cst);
      if(!stop_.load(std::memory_order_seq_cst))wake_.wait(seen,std::memory_order_seq_cst);
      sleepers_.fetch_sub(1,std::memory_order_seq_cst);
    }
    try{if(hook_)hook_(false);}catch(...){}
  }
  void shutdown()noexcept {
    stop_.store(true,std::memory_order_seq_cst);wake_.fetch_add(1,std::memory_order_seq_cst);wake_.notify_all();
    for(auto&t:threads_)if(t.joinable())t.join();
    threads_.clear();
  }
  Background background_;void*context_;std::function<void(bool)> hook_;
  std::vector<std::thread> threads_;
  Task task_=nullptr;void*taskContext_=nullptr;std::uint32_t epoch_=0;
  alignas(64) std::atomic<std::uint64_t> claim_{0};
  alignas(64) std::atomic<std::uint32_t> done_{0};
  alignas(64) std::atomic<std::uint32_t> wake_{0};
  std::atomic<std::uint32_t> sleepers_{0};
  std::atomic<bool> stop_{false};
};

// One track's render-ahead ring. The holder of `busy` produces (a worker, or the
// callback helping when the ring runs dry); the callback alone consumes.
struct AheadState {
  enum Mode:int { Off, Active, Draining };
  enum class Produce { Done, Full, Ended, Inactive };
  static constexpr std::size_t chunkSlots=128;
  struct Chunk { std::int64_t start=0; std::uint32_t frames=0; float peak=0; std::uint64_t overflows=0,invalid=0; };
  AheadState(std::uint32_t frames,std::uint32_t maxBlock):capacity(frames),ring(static_cast<std::size_t>(frames)*2),out(static_cast<std::size_t>(maxBlock)*2){}
  const std::uint32_t capacity;
  std::vector<float> ring,out; // `out`: the callback's copy for this block's mix.
  std::array<Chunk,chunkSlots> chunks{};
  // Producer state (busy holder). `phase`/`block` mirror the callback's split
  // of each device buffer so equal buffers render bit-identically.
  std::int64_t nextFrame=0,continuous=0;
  std::uint32_t phase=0,block=0;
  std::uint64_t pendingOverflows=0;
  // Consumer state (callback).
  std::uint32_t chunkOffset=0;
  alignas(64) std::atomic<std::uint64_t> written{0},writtenChunks{0};
  alignas(64) std::atomic<std::uint64_t> read{0},readChunks{0};
  alignas(64) std::atomic<int> mode{Off};
  std::atomic<bool> busy{false};
  void lock()noexcept{spinUntil([&]{return !busy.exchange(true,std::memory_order_acquire);});}
  void unlock()noexcept{busy.store(false,std::memory_order_release);}
  [[nodiscard]] bool empty()const noexcept{return written.load(std::memory_order_acquire)==read.load(std::memory_order_relaxed);}
  // Only while no producer can run: mode Off under the lock, or quiesced.
  void clear()noexcept {
    written.store(0,std::memory_order_relaxed);read.store(0,std::memory_order_relaxed);
    writtenChunks.store(0,std::memory_order_relaxed);readChunks.store(0,std::memory_order_relaxed);
    chunkOffset=0;pendingOverflows=0;phase=0;
  }
};
// Rings for one graph never exceed this; later tracks then render in the callback.
constexpr std::size_t aheadMemoryBudget=64u*1024u*1024u;

struct Synth {
  enum class Kind { Keys, Bass, Pad, Pluck, Rhodes, Drums, Sampled } kind = Kind::Keys;
  double level = 1, tone = 0, attack = .004, decay = .22, sustain = .2, release = .3;
  double sub = .65, bell = .2, detune = 7, sweep = .25, bark = .5, tune = 0, punch = 1;
};
Synth compileSynth(const TrackSource& source) {
  Synth result;
  const auto& p = source.params;
  std::set<std::string_view> permitted{"level", "tone"};
  if (source.kind == TrackSource::Kind::BuiltinSampled) {
    result.kind = Synth::Kind::Sampled;
    if (source.isKit) {
      permitted.insert({"tune", "decay"});
      result.tune=parameter(p,"tune",0,-12,12); result.decay=parameter(p,"decay",1,.1,1);
    } else {
      permitted.insert({"attack","release"}); result.attack=parameter(p,"attack",.001,.001,2); result.release=parameter(p,"release",.25,.02,5);
    }
  } else if (source.instrumentId == "drums") {
    result.kind=Synth::Kind::Drums; permitted.insert({"tune","decay","punch"});
    result.tune=parameter(p,"tune",0,-12,12); result.decay=parameter(p,"decay",1,.3,3); result.punch=parameter(p,"punch",1,.5,2);
  } else {
    permitted.insert({"attack","decay","sustain","release"});
    if (source.instrumentId == "bass") { result.kind=Synth::Kind::Bass;result.attack=.006;result.decay=.09;result.sustain=.65;result.release=.13;permitted.insert("sub");result.sub=parameter(p,"sub",.65,0,1); }
    else if (source.instrumentId == "keys") { result.kind=Synth::Kind::Keys;permitted.insert("bell");result.bell=parameter(p,"bell",.2,0,.6); }
    else if (source.instrumentId == "pad") { result.kind=Synth::Kind::Pad;result.attack=.08;result.decay=.24;result.sustain=.7;result.release=.7;permitted.insert("detune");result.detune=parameter(p,"detune",7,0,40); }
    else if (source.instrumentId == "pluck") { result.kind=Synth::Kind::Pluck;result.attack=.003;result.decay=.12;result.sustain=.08;result.release=.16;permitted.insert("sweep");result.sweep=parameter(p,"sweep",.25,.02,1); }
    else if (source.instrumentId == "rhodes") { result.kind=Synth::Kind::Rhodes;result.attack=.003;result.decay=2.5;result.sustain=0;result.release=.25;permitted.insert("bark");result.bark=parameter(p,"bark",.5,0,1); }
    else throw std::invalid_argument("Unknown native synthesizer: " + source.instrumentId);
    result.attack=parameter(p,"attack",result.attack,.001,2);
    result.decay=parameter(p,"decay",result.decay,result.kind==Synth::Kind::Rhodes?.2:.01,result.kind==Synth::Kind::Rhodes?6:3);
    result.sustain=parameter(p,"sustain",result.sustain,0,1);result.release=parameter(p,"release",result.release,.01,5);
  }
  result.level=parameter(p,"level",1,0,2);result.tone=parameter(p,"tone",0,-1,1);
  for (const auto& [name,value] : p) { (void)value; require(permitted.contains(name), "Unknown native instrument parameter"); }
  return result;
}

struct ResolvedZone { SampleZone zone; std::shared_ptr<const PcmAsset> asset; };
struct ResolvedSet {
  bool isKit=false;double gainDb=0,startOffset=0;
  std::vector<ResolvedZone> zones,releases;
};
const ResolvedZone* pickZone(const std::vector<ResolvedZone>& zones,bool kit,int pitch,float velocity) noexcept {
  double top=-1;
  for(const auto& z:zones)if(kit?z.zone.root==pitch:pitch>=z.zone.lo&&pitch<=z.zone.hi)top=std::max(top,z.zone.vhi);
  const ResolvedZone* best=nullptr;double bestDistance=std::numeric_limits<double>::max();bool matched=false;
  for(const auto& z:zones) {
    if(!(kit?z.zone.root==pitch:pitch>=z.zone.lo&&pitch<=z.zone.hi))continue;
    const bool layer=velocity>=z.zone.vlo&&(velocity<z.zone.vhi||(z.zone.vhi==top&&velocity<=z.zone.vhi));
    const double distance=layer?0:std::max({z.zone.vlo-velocity,velocity-z.zone.vhi,0.0});
    if(!best||(layer&&!matched)||(layer==matched&&(distance<bestDistance||(distance==bestDistance&&std::abs(z.zone.root-pitch)<std::abs(best->zone.root-pitch))))) {best=&z;bestDistance=distance;matched=layer;}
  }
  return best;
}

float pcmChannel(const PcmAsset& a,double position,unsigned channel) noexcept {
  if(position<0||position>=static_cast<double>(a.frames()))return 0;
  const auto index=static_cast<std::uint64_t>(position);
  const auto c=std::min<std::uint32_t>(channel,a.channels-1);
  const float left=a.samples[static_cast<std::size_t>(index)*a.channels+c];
  const float right=index+1<a.frames()?a.samples[static_cast<std::size_t>(index+1)*a.channels+c]:0;
  return left+static_cast<float>(position-index)*(right-left);
}
float pcmSample(const PcmAsset& a,double position,unsigned channel) noexcept {
  // Speaker downmix used by the former stereo output bus. Non-standard layouts
  // use discrete first-two-channel mapping, matching Web Audio's fallback.
  if(a.channels==4)return .5f*(pcmChannel(a,position,channel)+pcmChannel(a,position,channel+2));
  if(a.channels==6)return pcmChannel(a,position,channel)+.7071067811865476f*(pcmChannel(a,position,2)+pcmChannel(a,position,channel+4));
  return pcmChannel(a,position,channel);
}

double polyBlep(double phase,double step) noexcept {
  if(phase<step){const double t=phase/step;return t+t-t*t-1;}
  if(phase>1-step){const double t=(phase-1)/step;return t*t+t+t+1;}
  return 0;
}
double oscillator(double& phase,double frequency,double sr,int waveform=0) noexcept {
  const double step=std::clamp(frequency/sr,0.0,.45);double value=0;
  if(waveform==1)value=2*phase-1-polyBlep(phase,step);
  else if(waveform==2) {
    // A short, band-limited triangle Fourier series. Each partial is below Nyquist.
    for(int harmonic=1;harmonic<=15&&frequency*harmonic<sr*.45;harmonic+=2)
      value+=((harmonic%4==1)?1.0:-1.0)*std::sin(2*dsp::pi*phase*harmonic)/(harmonic*harmonic);
    value*=8/(dsp::pi*dsp::pi);
  } else value=std::sin(2*dsp::pi*phase);
  phase+=step;if(phase>=1)phase-=1;return value;
}

struct Voice {
  Synth synth;
  bool active=false,sampled=false,releaseSample=false,releaseSpawned=false,live=false,forcedRelease=false;
  std::int32_t id=0;int pitch=60,choke=-1;
  std::int64_t age=0,noteFrames=0,endFrames=0;
  float velocity=1;double samplePosition=0,sampleStep=1,peak=1,naturalFrames=0,releaseGain=0;
  double frequency=440,drumDecay=0,drumSweep=0,drumStart=0,drumEnd=0;
  std::array<double,4> phases{};
  dsp::Biquad tone,noiseFilter;
  const ResolvedZone* zone=nullptr;
  const ResolvedZone* releaseZone=nullptr;
  std::uint32_t noise=47081;
  double chokeGain=1;bool choking=false;
};
struct ResolvedWindow { AudioWindow window; std::shared_ptr<const PcmAsset> asset; };
struct TimedPluginEvent { std::int64_t frame; PluginEvent event; };
struct InsertRuntime {
  InsertRuntime() = default;
  InsertRuntime(const InsertRuntime&) = delete;
  InsertRuntime& operator=(const InsertRuntime&) = delete;
  InsertRuntime(InsertRuntime&&) noexcept = default;
  InsertRuntime& operator=(InsertRuntime&&) noexcept = default;

  std::unique_ptr<dsp::StereoProcessor> builtin;
  std::shared_ptr<PluginProcessor> plugin;
};
class CompensationDelay {
 public:
  explicit CompensationDelay(std::uint32_t frames=0):frames_(frames),samples_(static_cast<std::size_t>(frames+1)*2),generations_(frames+1){}
  void process(float* s,std::uint32_t frames)noexcept {
    if(!frames_)return;
    for(std::uint32_t i=0;i<frames;++i) {
      const auto read=(write_+1)%generations_.size();
      const float l=generations_[read]==generation_?samples_[read*2]:0,r=generations_[read]==generation_?samples_[read*2+1]:0;
      samples_[write_*2]=s[2*i];samples_[write_*2+1]=s[2*i+1];generations_[write_]=generation_;
      s[2*i]=l;s[2*i+1]=r;write_=read;
    }
  }
  void reset()noexcept{++generation_;if(!generation_)++generation_;write_=0;}
  void takeStateFrom(CompensationDelay& previous)noexcept {
    if(frames_!=previous.frames_)return;
    samples_.swap(previous.samples_);generations_.swap(previous.generations_);
    std::swap(write_,previous.write_);std::swap(generation_,previous.generation_);
  }
 private:
  std::uint32_t frames_;std::vector<float>samples_;std::vector<std::uint64_t>generations_;
  std::size_t write_=0;std::uint64_t generation_=1;
};

struct TrackRuntime {
  TrackRuntime() = default;
  TrackRuntime(const TrackRuntime&) = delete;
  TrackRuntime& operator=(const TrackRuntime&) = delete;
  // Configuration maps can make this move potentially throwing on MSVC. Keep
  // the compiler-derived exception specification: deleting copy is what makes
  // vector relocation select move without promising an unsafe noexcept move.
  TrackRuntime(TrackRuntime&&) = default;
  TrackRuntime& operator=(TrackRuntime&&) = default;

  TrackTimeline timeline;
  Synth synth;
  ResolvedSet samples;
  std::vector<Voice> voices=std::vector<Voice>(maxVoices);
  std::vector<ResolvedWindow> windows;
  std::vector<InsertRuntime> inserts;
  std::shared_ptr<PluginProcessor> instrument;
  std::shared_ptr<WavetableProcessor> wavetable;
  std::vector<TimedPluginEvent> events;
  std::array<PluginEvent,maxPluginEvents> blockEvents{};
  std::array<PluginEvent,maxVoices> pendingEvents{};
  std::size_t pendingCount=0;
  bool releaseAudition=false;
  struct LivePluginNote { bool active=false;std::int32_t id=-1;std::uint8_t pitch=60;std::int64_t remaining=0; };
  std::array<LivePluginNote,maxVoices> pluginNotes{};
  std::size_t nextNote=0,nextEvent=0;
  std::uint32_t latency=0;
  CompensationDelay compensation;
  std::vector<float> buffer;
  double sampleRate=48000;
  std::int64_t projectLength=0;
  float peak=0;
  double fader=1,panValue=0;
  bool stereoSource=false,stereoEffects=false;
  // Multi-core bookkeeping. A block task writes only its own track: counters
  // are summed and `mix` read by the callback after the join, in track order.
  std::unique_ptr<AheadState> ahead; // Render-ahead ring when eligible (no VST3).
  const float* mix=nullptr;          // This block's output: buffer or ahead->out.
  float meter=0;                     // Callback-published peak.
  std::uint64_t taskOverflows=0,taskInvalid=0,taskResyncs=0;
  // Continuous frame until which live input/notes keep this track in the callback.
  std::int64_t liveUntil=std::numeric_limits<std::int64_t>::min();

  void takeStateFrom(TrackRuntime& previous)noexcept {
    meter=previous.meter;liveUntil=previous.liveUntil;
    // The ring and its producer position belong with the voice/effect state.
    if(ahead&&previous.ahead&&ahead->capacity==previous.ahead->capacity)ahead.swap(previous.ahead);
    voices.swap(previous.voices);std::swap(samples,previous.samples);
    nextNote=previous.nextNote;nextEvent=previous.nextEvent;pendingCount=previous.pendingCount;
    pendingEvents=previous.pendingEvents;pluginNotes=previous.pluginNotes;
    releaseAudition=previous.releaseAudition;
    if(wavetable)wavetable->takeStateFrom(*previous.wavetable);
    else instrument.swap(previous.instrument);
    for(std::size_t i=0;i<inserts.size();++i) {
      if(inserts[i].builtin)inserts[i].builtin->takeStateFrom(*previous.inserts[i].builtin);
      else inserts[i].plugin.swap(previous.inserts[i].plugin);
    }
    compensation.takeStateFrom(previous.compensation);peak=previous.peak;
    fader=previous.fader;panValue=previous.panValue;
  }

  Voice& availableVoice(std::uint64_t& overflows)noexcept {
    for(auto& v:voices)if(!v.active)return v;
    ++overflows;
    return *std::max_element(voices.begin(),voices.end(),[](const Voice&a,const Voice&b){return a.age<b.age;});
  }
  void spawn(int pitch,float velocity,std::int64_t duration,std::int64_t available,std::int32_t id,bool live,std::uint64_t& overflows)noexcept {
    if(velocity<=0||duration<=0||available<=0||!timeline.enabled||timeline.source.kind==TrackSource::Kind::Audio)return;
    if(instrument) {
      if(pendingCount==pendingEvents.size()){++overflows;return;}
      if(live){
        auto slot=std::find_if(pluginNotes.begin(),pluginNotes.end(),[](const LivePluginNote&n){return !n.active;});
        if(slot==pluginNotes.end()){++overflows;return;}
        *slot={true,id,static_cast<std::uint8_t>(pitch),duration};
      }
      pendingEvents[pendingCount++]={PluginEvent::Type::NoteOn,0,id,static_cast<std::uint8_t>(pitch),0,wavetable?velocity:std::min(1.f,velocity),0,live};
      // Chased timeline notes already have an exact scheduled note-off. Only
      // live/preview notes need a callback-local countdown.
      return;
    }
    const ResolvedZone* zone=nullptr;
    if(timeline.source.kind==TrackSource::Kind::BuiltinSampled) {
      zone=pickZone(samples.zones,samples.isKit,pitch,std::clamp(velocity,0.f,1.f));
      // Kit notes with no mapped pad are intentional silence, as in the manifest.
      if(!zone)return;
    }
    auto& voice=availableVoice(overflows);voice=Voice{};voice.synth=synth;voice.active=true;voice.pitch=pitch;voice.velocity=velocity;
    voice.id=id;voice.live=live;voice.noteFrames=std::max<std::int64_t>(1,std::min(duration,available));
    voice.frequency=440*std::pow(2,(pitch-69)/12.0);voice.noise=47081;
    const double noteSeconds=static_cast<double>(voice.noteFrames)/sampleRate;
    const double toneFactor=std::pow(2,synth.tone*2);
    if(zone) {
      voice.sampled=true;voice.zone=zone;voice.choke=zone->zone.choke;
      voice.samplePosition=samples.startOffset*zone->asset->sampleRate;
      const double ratio=std::pow(2,(samples.isKit?0:(pitch-zone->zone.root)/12.0)+zone->zone.tune/1200+(samples.isKit?synth.tune/12:0));
      voice.sampleStep=ratio*zone->asset->sampleRate/sampleRate;
      voice.naturalFrames=std::max(1.0,(zone->asset->frames()-voice.samplePosition)/voice.sampleStep);
      voice.peak=dsp::dbToGain(samples.gainDb+zone->zone.gainDb-6)*(.25+.75*velocity)*synth.level;
      if(synth.tone<0)voice.tone.configure(dsp::Filter::Lowpass,sampleRate,20000*std::pow(2,synth.tone*3),.5);
      else voice.tone.configure(dsp::Filter::HighShelf,sampleRate,2500,1,synth.tone*6);
      if(samples.isKit) {
        voice.drumDecay=synth.decay<1?std::max(.02*sampleRate,synth.decay*voice.naturalFrames):voice.naturalFrames;
        voice.endFrames=static_cast<std::int64_t>(voice.drumDecay+.004*sampleRate);
        if(voice.choke>=0)for(auto& previous:voices)if(&previous!=&voice&&previous.active&&previous.choke==voice.choke)previous.choking=true;
      } else {
        voice.endFrames=voice.noteFrames+static_cast<std::int64_t>((synth.release*1.5+.02)*sampleRate);
        if(!zone->zone.loop)voice.endFrames=std::min(voice.endFrames,static_cast<std::int64_t>(voice.naturalFrames+.01*sampleRate));
        if(live||voice.noteFrames<voice.naturalFrames)voice.releaseZone=pickZone(samples.releases,false,pitch,std::clamp(velocity,0.f,1.f));
      }
      return;
    }
    voice.endFrames=voice.noteFrames+static_cast<std::int64_t>((synth.release+.005)*sampleRate);
    double cutoff=6800,amplitude=.35;
    switch(synth.kind) {
      case Synth::Kind::Bass:cutoff=700+velocity*1700;amplitude=.32;break;
      case Synth::Kind::Pad:cutoff=2600;amplitude=.25;break;
      case Synth::Kind::Pluck:cutoff=4800;amplitude=.35;break;
      case Synth::Kind::Rhodes:cutoff=9000;amplitude=.28+.1*std::min(1.f,velocity);voice.endFrames=voice.noteFrames+static_cast<std::int64_t>((synth.release*1.5+.02)*sampleRate);break;
      case Synth::Kind::Drums: {
        const double tune=std::pow(2,synth.tune/12);double decay=.23;
        if(pitch==35||pitch==36){decay=.32;amplitude=.8;voice.drumStart=(47+98*synth.punch)*tune;voice.drumEnd=47*tune;voice.drumSweep=.12;}
        else if(pitch==38||pitch==40||pitch==39){decay=pitch==39?.12:.18;amplitude=.32;voice.frequency=185*tune;voice.noiseFilter.configure(dsp::Filter::Highpass,sampleRate,900*std::pow(2,synth.tone*1.5),1);}
        else if(pitch==42||pitch==44||pitch==46||pitch==49||pitch==51){decay=pitch==46?.32:(pitch==49||pitch==51)?.62:.065;amplitude=(pitch==42||pitch==44)?.18:.16;voice.noiseFilter.configure(dsp::Filter::Highpass,sampleRate,6500*std::pow(2,synth.tone*1.5),1);}
        else {amplitude=.5;voice.drumEnd=440*std::pow(2,(std::clamp(pitch,24,84)-69)/12.0)*tune;voice.drumStart=voice.drumEnd*1.8;voice.drumSweep=.1;}
        voice.drumDecay=std::max(.008*sampleRate,std::min(decay*synth.decay*sampleRate,static_cast<double>(available)));
        voice.endFrames=static_cast<std::int64_t>(voice.drumDecay+.004*sampleRate);break;
      }
      default:break;
    }
    voice.peak=amplitude*velocity*synth.level;voice.tone.configure(dsp::Filter::Lowpass,sampleRate,cutoff*toneFactor,.7);
    (void)noteSeconds;
  }
  void spawnRelease(Voice& source,std::uint64_t& overflows)noexcept {
    if(!source.releaseZone||source.releaseSpawned)return;
    source.releaseSpawned=true;
    auto* zone=source.releaseZone;const int pitch=source.pitch;const float velocity=source.velocity;const auto voiceSynth=source.synth;
    auto& v=availableVoice(overflows);v=Voice{};v.synth=voiceSynth;v.active=true;v.sampled=true;v.releaseSample=true;v.zone=zone;v.pitch=pitch;
    v.samplePosition=samples.startOffset*zone->asset->sampleRate;
    v.sampleStep=std::pow(2,(pitch-zone->zone.root)/12.0+zone->zone.tune/1200)*zone->asset->sampleRate/sampleRate;
    v.peak=dsp::dbToGain(samples.gainDb+zone->zone.gainDb-6)*.35*std::min(1.f,velocity)*voiceSynth.level;
    v.endFrames=static_cast<std::int64_t>(std::max(0.0,(zone->asset->frames()-v.samplePosition)/v.sampleStep));
  }
  void noteOff(int pitch,std::int32_t id,std::uint64_t& overflows)noexcept {
    if(instrument) {
      bool cancelledPending=false;
      for(std::size_t i=0;i<pendingCount;){
        const auto&e=pendingEvents[i];
        if(e.type==PluginEvent::Type::NoteOn&&e.audition&&(id>=0?e.noteId==id:e.pitch==pitch)){
          std::move(pendingEvents.begin()+static_cast<std::ptrdiff_t>(i+1),pendingEvents.begin()+static_cast<std::ptrdiff_t>(pendingCount),pendingEvents.begin()+static_cast<std::ptrdiff_t>(i));
          --pendingCount;cancelledPending=true;
        }else ++i;
      }
      if(!cancelledPending){
        if(pendingCount<pendingEvents.size())pendingEvents[pendingCount++]={PluginEvent::Type::NoteOff,0,id,static_cast<std::uint8_t>(pitch),0,0,0,true};
        else{++overflows;instrument->requestReset();pendingCount=0;for(auto&n:pluginNotes)n.active=false;}
      }
      for(auto& n:pluginNotes)if(n.active&&(id>=0?n.id==id:n.pitch==pitch))n.active=false;
    }
    for(auto& v:voices)if(v.active&&v.live&&(id>=0?v.id==id:v.pitch==pitch)) {
      if(!timeline.source.isKit&&!v.forcedRelease){v.releaseGain=envelope(v);v.forcedRelease=true;}
      v.noteFrames=std::min(v.noteFrames,v.age);
      if(v.sampled&&v.age>=v.naturalFrames)v.releaseZone=nullptr;
      if (!timeline.source.isKit) v.endFrames=std::min(v.endFrames,v.age+static_cast<std::int64_t>((v.synth.release*1.5+.02)*sampleRate));
    }
  }
  void allNotesOff(std::uint64_t& overflows)noexcept {
    if(wavetable) {
      // Reserve no per-note queue slots: channel one belongs only to audition.
      // Cancel its queued on/off events before emitting a single release event.
      auto end=std::remove_if(pendingEvents.begin(),pendingEvents.begin()+static_cast<std::ptrdiff_t>(pendingCount),
        [](const PluginEvent&e){return e.audition;});
      pendingCount=static_cast<std::size_t>(end-pendingEvents.begin());
      for(auto&n:pluginNotes)n.active=false;
      releaseAudition=true;
    } else if(instrument) {
      for(auto&n:pluginNotes)if(n.active)noteOff(n.pitch,n.id,overflows);
    } else {
      for(auto&v:voices)if(v.active&&v.live)noteOff(v.pitch,v.id,overflows);
    }
  }
  double envelope(const Voice& v)const noexcept {
    const auto&synth=v.synth;
    const double t=static_cast<double>(v.age)/sampleRate,duration=static_cast<double>(v.noteFrames)/sampleRate;
    if(v.releaseSample)return v.peak;
    if(v.forcedRelease){
      if(v.sampled||synth.kind==Synth::Kind::Rhodes)return v.releaseGain*std::exp(-(t-duration)/(synth.release/4));
      if(t>=duration+synth.release||v.releaseGain<=0)return 0;
      return v.releaseGain*std::pow(epsilon/std::max(epsilon,v.releaseGain),(t-duration)/synth.release);
    }
    if(v.sampled) {
      if(samples.isKit) {
        if(synth.decay>=1)return v.peak;
        const double end=v.drumDecay/sampleRate;
        if(t>=end)return 0;
        return v.peak*std::pow(epsilon/std::max(epsilon,v.peak),t/end);
      }
      const double attack=std::min(synth.attack,duration);
      if(t<attack)return v.peak*t/std::max(1/sampleRate,attack);
      return t<duration?v.peak:v.peak*std::exp(-(t-duration)/(synth.release/4));
    }
    if(synth.kind==Synth::Kind::Drums) {
      const double end=v.drumDecay/sampleRate,attack=std::min(.002,end/4);
      if(t<attack)return v.peak*t/attack;
      if(t>=end)return 0;
      return v.peak*std::pow(epsilon/std::max(epsilon,v.peak),(t-attack)/(end-attack));
    }
    if(synth.kind==Synth::Kind::Rhodes) {
      const double attack=std::min(synth.attack,duration),decay=synth.decay*std::pow(2,-(v.pitch-60)/24.0),sustain=std::max(epsilon,synth.sustain*v.peak);
      auto beforeOff=[&](double at){if(at<attack)return v.peak*at/std::max(attack,1/sampleRate);const double a=at-attack;
        if(a<decay*.25)return v.peak*.45+v.peak*.55*std::exp(-a/(decay*.1));
        const double initial=v.peak*.45+v.peak*.55*std::exp(-2.5);
        return sustain+(initial-sustain)*std::exp(-(a-decay*.25)/(decay/3));};
      return t<duration?beforeOff(t):beforeOff(duration)*std::exp(-(t-duration)/(synth.release/4));
    }
    const double attack=std::min(synth.attack,duration*.3),decayEnd=std::min(attack+synth.decay,duration*.85),sustain=std::max(epsilon,v.peak*synth.sustain);
    if(t<attack)return v.peak*t/std::max(attack,1/sampleRate);
    if(t<decayEnd&&decayEnd>attack)return v.peak*std::pow(sustain/std::max(epsilon,v.peak),(t-attack)/(decayEnd-attack));
    if(t<duration)return sustain;
    if(t>=duration+synth.release)return 0;
    return sustain*std::pow(epsilon/sustain,(t-duration)/synth.release);
  }
  void voicesInto(float* out,std::uint32_t frames,std::uint64_t& overflows)noexcept {
    for(std::uint32_t i=0;i<frames;++i) {
      for(auto& v:voices) if(v.active&&v.releaseZone&&!v.releaseSpawned&&v.age>=v.noteFrames) spawnRelease(v,overflows);
      for(auto& v:voices) {
      if(!v.active)continue;
      if(v.age>=v.endFrames){v.active=false;continue;}
      const auto&synth=v.synth;
      double l=0,r=0;
      if(v.sampled) {
        const auto& a=*v.zone->asset;
        if(v.zone->zone.loop&&!samples.isKit&&!v.releaseSample) {
          const double start=(v.zone->zone.loop->at(0)+samples.startOffset)*a.sampleRate,end=(v.zone->zone.loop->at(1)+samples.startOffset)*a.sampleRate;
          if(v.samplePosition>=end)v.samplePosition=start+std::fmod(v.samplePosition-start,end-start);
        }
        if(v.samplePosition>=a.frames()){v.active=false;continue;}
        l=pcmSample(a,v.samplePosition,0);r=pcmSample(a,v.samplePosition,1);v.samplePosition+=v.sampleStep;
        if(!v.releaseSample){l=v.tone.sample(static_cast<float>(l),0);r=v.tone.sample(static_cast<float>(r),1);}
      } else {
        const double t=static_cast<double>(v.age)/sampleRate;
        if(synth.kind==Synth::Kind::Drums) {
          if(v.drumSweep>0){const double freq=v.drumStart*std::pow(v.drumEnd/v.drumStart,std::min(1.0,t/v.drumSweep));l=oscillator(v.phases[0],freq,sampleRate);}
          else {v.noise=v.noise*1664525u+1013904223u;l=v.noiseFilter.sample(static_cast<float>(static_cast<double>(v.noise)/4294967295.0*2-1));
            if(v.pitch==38||v.pitch==40||v.pitch==39)l+=.25*oscillator(v.phases[0],v.frequency,sampleRate,2);}
        } else if(synth.kind==Synth::Kind::Bass)l=.45*oscillator(v.phases[0],v.frequency,sampleRate,1)+synth.sub*oscillator(v.phases[1],v.frequency,sampleRate);
        else if(synth.kind==Synth::Kind::Pad)l=.27*oscillator(v.phases[0],v.frequency*std::pow(2,-synth.detune/1200),sampleRate,1)+.27*oscillator(v.phases[1],v.frequency*std::pow(2,synth.detune/1200),sampleRate,1)+.2*oscillator(v.phases[2],v.frequency*2,sampleRate,2);
        else if(synth.kind==Synth::Kind::Pluck){
          const double sweep=std::max(.03,std::min(static_cast<double>(v.noteFrames)/sampleRate,synth.sweep));
          if((v.age&15)==0)v.tone.configure(dsp::Filter::Lowpass,sampleRate,4800*std::pow(900.0/4800,std::min(1.0,t/sweep))*std::pow(2,synth.tone*2),.7);
          l=.85*oscillator(v.phases[0],v.frequency,sampleRate,2)+.2*oscillator(v.phases[1],v.frequency*2,sampleRate);
        } else if(synth.kind==Synth::Kind::Rhodes) {
          const double hit=std::min(1.f,v.velocity),index=(.3+2.4*synth.bark)*(.35+.65*hit)*std::pow(2,synth.tone*1.2);
          const double depth=v.frequency*index*(t<.012?1:.1+.9*std::exp(-(t-.012)/.13));
          const double mod=oscillator(v.phases[1],v.frequency,sampleRate)*depth;
          // Frequency modulation can cross zero; reversing phase is part of the
          // tine's original 1:1 FM sound, not a frequency clamp at zero.
          l=.75*std::sin(2*dsp::pi*v.phases[0]);
          v.phases[0]+=std::clamp((v.frequency+mod)/sampleRate,-.45,.45);
          v.phases[0]-=std::floor(v.phases[0]);
          l+=.12*hit*(.3+synth.bark)*(t<.006?1:std::exp(-(t-.006)/.03))*oscillator(v.phases[2],v.frequency*7,sampleRate);
          l=std::tanh(1.2*l+.25*l*l)/std::tanh(1.45);
        } else l=.8*oscillator(v.phases[0],v.frequency,sampleRate)+synth.bell*oscillator(v.phases[1],v.frequency*2,sampleRate,2)+synth.bell*.4*oscillator(v.phases[2],v.frequency*3,sampleRate);
        if(synth.kind!=Synth::Kind::Drums) l=v.tone.sample(static_cast<float>(l));
        r=l;
      }
      double gain=envelope(v);
      if(v.choking){v.chokeGain*=std::exp(-1/(.003*sampleRate));gain*=v.chokeGain;if(v.chokeGain<.006)v.active=false;}
      out[2*i]+=static_cast<float>(l*gain);out[2*i+1]+=static_cast<float>(r*gain);++v.age;
      }
    }
  }
  void reset(std::int64_t frame,bool chase,bool resetEffects,std::uint64_t& overflows)noexcept {
    for(auto& v:voices) v.active=false;
    for(auto& n:pluginNotes) n.active=false;
    pendingCount=0;
    releaseAudition=false;
    if(instrument)instrument->requestReset();
    if(resetEffects){for(auto& effect:inserts){if(effect.builtin)effect.builtin->reset();if(effect.plugin)effect.plugin->requestReset();}compensation.reset();}
    nextNote=static_cast<std::size_t>(std::lower_bound(timeline.notes.begin(),timeline.notes.end(),frame,[](const NotePair& n,std::int64_t f){return n.onFrame<f;})-timeline.notes.begin());
    nextEvent=static_cast<std::size_t>(std::lower_bound(events.begin(),events.end(),frame,[](const TimedPluginEvent&e,std::int64_t f){return e.frame<f;})-events.begin());
    if(chase&&!timeline.source.isKit&&timeline.enabled)for(std::size_t i=0;i<nextNote;++i){const auto& n=timeline.notes[i];if(n.offFrame>frame)spawn(n.pitch,n.velocity,n.offFrame-frame,n.limitFrame-frame,n.id,false,overflows);}
  }
  void render(std::int64_t frame,std::uint32_t frames,bool playing,const float* input,bool monitor,bool stereoInput,
              const ProcessContext& context,std::uint64_t& overflows,std::uint64_t& invalid)noexcept {
    std::fill_n(buffer.data(),static_cast<std::size_t>(frames)*2,0.f);
    if(!timeline.enabled){peak=0;return;}
    if(playing)for(const auto& resolved:windows) {
      const auto&w=resolved.window;
      if(w.startFrame>=frame+frames)break;
      if(w.endFrame<=frame)continue;
      const auto start=std::max(frame,w.startFrame),end=std::min<std::int64_t>(frame+frames,w.endFrame);
      const double click=std::min(sampleRate*.004,(w.endFrame-w.startFrame)/4.0);
      for(auto absolute=start;absolute<end;++absolute){const auto delta=absolute-w.startFrame;const auto offset=static_cast<std::size_t>(absolute-frame);
        const double envelopePos=w.clipOffsetFrames+delta;
        double gain=w.gain;
        if(w.fadeInFrames>0)gain*=std::min(1.0,envelopePos/w.fadeInFrames);
        if(w.fadeOutFrames>0)gain=std::min(gain,w.gain*std::clamp((w.clipLengthFrames-envelopePos)/w.fadeOutFrames,0.0,1.0));
        if(click>0)gain*=std::min({1.0,delta/click,(w.endFrame-absolute)/click});
        const double position=w.sourceStartFrame+delta*w.sourceSampleRate/sampleRate;
        buffer[2*offset]+=static_cast<float>(pcmSample(*resolved.asset,position,0)*gain);buffer[2*offset+1]+=static_cast<float>(pcmSample(*resolved.asset,position,1)*gain);
      }
    }
    std::size_t eventCount=0;
    if(releaseAudition) {
      blockEvents[eventCount++]={PluginEvent::Type::AllNotesOff,0,-1,60,0,0,0,true};
      releaseAudition=false;
    }
    for(std::size_t i=0;i<pendingCount&&eventCount<blockEvents.size();++i) blockEvents[eventCount++]=pendingEvents[i];
    pendingCount=0;
    if(instrument) {
      // A note ending exactly at the project boundary releases in the first
      // tail block. This applies to live WAVE playback and offline export.
      if(playing||(wavetable&&frame>=projectLength))while(nextEvent<events.size()&&events[nextEvent].frame<frame+frames){const auto& e=events[nextEvent++];if(e.frame>=frame){if(eventCount<blockEvents.size()){blockEvents[eventCount]=e.event;blockEvents[eventCount++].offset=static_cast<std::uint32_t>(e.frame-frame);}else ++overflows;}}
      for(auto& n:pluginNotes)if(n.active){if(n.remaining<frames){if(eventCount<blockEvents.size())blockEvents[eventCount++]={PluginEvent::Type::NoteOff,static_cast<std::uint32_t>(std::max<std::int64_t>(0,n.remaining)),n.id,n.pitch,0,0,0,true};else ++overflows;n.active=false;}else n.remaining-=frames;}
      std::sort(blockEvents.begin(),blockEvents.begin()+static_cast<std::ptrdiff_t>(eventCount),[](const PluginEvent&a,const PluginEvent&b){
        const auto order=[](PluginEvent::Type type){return type==PluginEvent::Type::AllNotesOff?0:type==PluginEvent::Type::NoteOff?1:2;};
        return a.offset<b.offset||(a.offset==b.offset&&order(a.type)<order(b.type));});
      instrument->process(buffer.data(),frames,std::span(blockEvents).first(eventCount),context);
    } else {
      std::uint32_t cursor=0;
      if(playing)while(nextNote<timeline.notes.size()&&timeline.notes[nextNote].onFrame<frame+frames) {
        const auto& n=timeline.notes[nextNote++];if(n.onFrame<frame)continue;
        const auto onset=static_cast<std::uint32_t>(n.onFrame-frame);
        voicesInto(buffer.data()+cursor*2,onset-cursor,overflows);cursor=onset;
        spawn(n.pitch,n.velocity,n.offFrame-n.onFrame,n.limitFrame-n.onFrame,n.id,false,overflows);
      }
      voicesInto(buffer.data()+cursor*2,frames-cursor,overflows);
    }
    if(monitor&&input)for(std::size_t i=0;i<static_cast<std::size_t>(frames)*2;++i)buffer[i]+=input[i];
    for(auto& effect:inserts){if(effect.builtin)effect.builtin->process(buffer.data(),frames);else effect.plugin->process(buffer.data(),frames,{},context);}
    // A reduced-latency monitor deliberately avoids waiting for unrelated tracks.
    if(!(monitor&&context.playing&&!context.offline&&contextLowLatency))compensation.process(buffer.data(),frames);
    const double targetPan=timeline.pan,targetGain=timeline.audible?timeline.gain:0;
    const double smoothing=1-std::exp(-1/(sampleRate*.012));
    peak=0;
    for(std::uint32_t i=0;i<frames;++i) {
      fader+=(targetGain-fader)*smoothing;panValue+=(targetPan-panValue)*smoothing;
      const double pan=panValue,gain=fader;
      double l=buffer[2*i],r=buffer[2*i+1];
      // Preserve equal-power mono panning. Duplicating a mono voice into the
      // native stereo scratch buffer must not turn full-left into a +6 dB sum.
      if(!(stereoSource||stereoEffects||(monitor&&stereoInput))){const double angle=(pan+1)*dsp::pi/4;r=l*std::sin(angle);l*=std::cos(angle);}
      else if(pan<0){const double angle=(pan+1)*dsp::pi/2;l+=r*std::cos(angle);r*=std::sin(angle);}
      else if(pan>0){const double angle=pan*dsp::pi/2;r+=l*std::sin(angle);l*=std::cos(angle);}
      l*=gain;r*=gain;
      if(!std::isfinite(l)){l=0;++invalid;}if(!std::isfinite(r)){r=0;++invalid;}
      buffer[2*i]=static_cast<float>(std::clamp(l,-32.0,32.0));buffer[2*i+1]=static_cast<float>(std::clamp(r,-32.0,32.0));
      peak=std::max(peak,static_cast<float>(std::max(std::abs(l),std::abs(r))));
    }
  }
  bool contextLowLatency=true;
};
static_assert(!std::is_copy_constructible_v<InsertRuntime> && std::is_nothrow_move_constructible_v<InsertRuntime>);
static_assert(!std::is_copy_constructible_v<TrackRuntime> && std::is_move_constructible_v<TrackRuntime>);

std::shared_ptr<const PcmAsset> resolveAsset(const AssetStore& assets,const std::string&id) {
  const auto a=assets.find(id);require(a!=assets.end()&&a->second,"Native PCM asset is not registered");
  require(a->second->channels>=1&&a->second->channels<=32&&a->second->sampleRate>=8000&&a->second->sampleRate<=192000,"Invalid native PCM asset format");
  require(!a->second->samples.empty()&&a->second->samples.size()%a->second->channels==0,"Invalid native PCM asset length");
  return a->second;
}
ResolvedSet resolveSet(const SampleSet& set,const AssetStore& assets) {
  ResolvedSet result;result.isKit=set.isKit;result.gainDb=checked(set.gainDb,-120,48,"Invalid sample set gain");result.startOffset=checked(set.startOffset,0,10,"Invalid sample codec offset");
  require(!set.zones.empty()&&set.zones.size()<=10000&&set.releaseZones.size()<=10000,"Invalid sample zone count");
  auto convert=[&](const std::vector<SampleZone>& zones){std::vector<ResolvedZone> out;out.reserve(zones.size());
    for(const auto&z:zones){require(z.root>=0&&z.root<=127&&z.lo>=0&&z.hi<=127&&z.lo<=z.hi,"Invalid sample key range");
      checked(z.vlo,0,1,"Invalid velocity zone");checked(z.vhi,z.vlo,1,"Invalid velocity zone");checked(z.gainDb,-120,48,"Invalid sample gain");checked(z.tune,-4800,4800,"Invalid sample tuning");
      auto a=resolveAsset(assets,z.assetId);require(set.startOffset*a->sampleRate<a->frames(),"Sample codec offset exceeds asset");
      if(z.loop){checked(z.loop->at(0),0,static_cast<double>(a->frames())/a->sampleRate,"Invalid sample loop start");checked(z.loop->at(1),z.loop->at(0),static_cast<double>(a->frames())/a->sampleRate-set.startOffset,"Invalid sample loop end");require(z.loop->at(1)>z.loop->at(0),"Empty sample loop");}
      out.push_back({z,std::move(a)});
    }return out;};
  result.zones=convert(set.zones);result.releases=convert(set.releaseZones);return result;
}

struct ControlRecipe {
  ProjectTimeline timeline;
  std::vector<std::shared_ptr<const PcmAsset>> assets;
  std::vector<SampleSet> sets;
};
// This potentially large exact comparison happens only on the control thread.
// The callback receives a predecessor serial, not a hash or JSON to compare.
bool sameStructure(const ControlRecipe& a,const ControlRecipe& b) {
  const auto&x=a.timeline;const auto&y=b.timeline;
  if(x.projectId!=y.projectId||x.sampleRate!=y.sampleRate||x.bpm!=y.bpm||x.beatsPerBar!=y.beatsPerBar||x.timeSigNumerator!=y.timeSigNumerator||x.timeSigDenominator!=y.timeSigDenominator||x.lengthFrames!=y.lengthFrames||x.cycle!=y.cycle||x.tracks.size()!=y.tracks.size()||a.assets!=b.assets||a.sets!=b.sets)return false;
  for(std::size_t i=0;i<x.tracks.size();++i) {
    const auto&tx=x.tracks[i];const auto&ty=y.tracks[i];
    const auto samePlugin=[](const PluginSpec&a,const PluginSpec&b){return a.instanceId==b.instanceId&&a.path==b.path&&a.classId==b.classId&&a.state==b.state&&a.controllerState==b.controllerState&&a.isInstrument==b.isInstrument;};
    const auto&sx=tx.source;const auto&sy=ty.source;
    if(tx.id!=ty.id||sx.kind!=sy.kind||sx.instrumentId!=sy.instrumentId||sx.sampleSetId!=sy.sampleSetId||sx.isKit!=sy.isKit||!samePlugin(sx.plugin,sy.plugin)||tx.enabled!=ty.enabled||tx.notes!=ty.notes||tx.audio!=ty.audio||tx.inserts.size()!=ty.inserts.size())return false;
    for(std::size_t j=0;j<tx.inserts.size();++j){const auto&ex=tx.inserts[j];const auto&ey=ty.inserts[j];
      if(ex.id!=ey.id||ex.type!=ey.type||ex.enabled!=ey.enabled||(ex.type=="vst3"&&!samePlugin(ex.plugin,ey.plugin)))return false;
    }
  }
  return true;
}

// One recording's capture ring: allocated on the control thread, handed to the
// callback by pointer in RecordStart and dropped by it in RecordStop. The
// control thread frees it only after that stop is acknowledged and drained.
struct Capture {
  std::vector<RecordingTake> takes;
  std::vector<float> ring;
  std::uint64_t capacity = 0;  // Frames.
  std::uint32_t channels = 0;  // Samples per frame: every take's channels in order.
  alignas(64) std::atomic<std::uint64_t> write{0};
  alignas(64) std::atomic<std::uint64_t> read{0};
};
// 64 stereo takes at the default ring length would pin 128 MiB. Bound the ring
// in samples instead; ~2.7 s at 48 kHz for 128 channels still covers disk stalls.
constexpr std::uint64_t captureSampleBudget = 16u * 1024u * 1024u;

inline float inputSample(const float* input,std::uint32_t channels,std::uint32_t frame,std::int32_t index,std::uint64_t& invalid)noexcept {
  float value=input&&index>=0&&static_cast<std::uint32_t>(index)<channels?input[static_cast<std::size_t>(frame)*channels+static_cast<std::uint32_t>(index)]:0.f;
  if(!std::isfinite(value)){value=0;++invalid;}
  return value;
}

} // namespace

InputRoute routeInput(const std::optional<TrackInput>& input,std::span<const std::uint8_t> layout,std::uint32_t delivered,int defaultLeft,int defaultRight)noexcept {
  InputRoute route;
  const auto open=[&](int index){return index>=0&&static_cast<std::uint32_t>(index)<delivered;};
  if(!input) {
    route.left=open(defaultLeft)?defaultLeft:-1;
    route.right=route.left>=0&&defaultRight!=defaultLeft&&open(defaultRight)?defaultRight:-1;
    route.channels=route.right>=0?2:1;route.missing=route.left<0;
    return route;
  }
  const auto find=[&](int physical)->std::int32_t{
    for(std::size_t i=0;i<layout.size()&&i<delivered;++i)if(layout[i]==physical)return static_cast<std::int32_t>(i);
    return -1;
  };
  route.channels=input->count();route.left=find(input->channels[0]);
  if(route.channels==2)route.right=find(input->channels[1]);
  // A half-open stereo pair is not silently recorded as mono of the other side.
  route.missing=route.left<0||(route.channels==2&&route.right<0);
  if(route.missing)route.left=route.right=-1;
  return route;
}

std::vector<float> latencyPulse(std::uint32_t sampleRate) {
  require(sampleRate>=8000&&sampleRate<=192000,"Invalid latency pulse rate");
  // A 4 ms windowed chirp: pulse compression gives a one-sample correlation
  // peak even when the loopback is quiet, band-limited or polarity inverted.
  const auto length=std::max<std::uint32_t>(32,sampleRate/250);
  const double low=500,high=std::min(16000.0,sampleRate*.4),duration=static_cast<double>(length)/sampleRate;
  std::vector<float> pulse(length);
  for(std::uint32_t i=0;i<length;++i) {
    const double t=static_cast<double>(i)/sampleRate,window=.5-.5*std::cos(2*dsp::pi*i/(length-1));
    pulse[i]=static_cast<float>(.5*window*std::sin(2*dsp::pi*(low*t+(high-low)*t*t/(2*duration))));
  }
  return pulse;
}

LatencyDetection detectLatency(std::span<const float> captured,std::span<const float> pulse,std::span<const std::int64_t> emitted,std::int64_t maxLag) {
  LatencyDetection result;result.attempts=static_cast<std::uint32_t>(emitted.size());
  double pulseEnergy=0;for(const auto v:pulse)pulseEnergy+=double(v)*v;
  if(pulse.empty()||pulseEnergy<=0||maxLag<0)return result;
  constexpr double threshold=.5; // Cosine similarity; white noise over a 4 ms window stays near 0.1.
  struct Found { std::int64_t lag; double clarity; };
  std::vector<Found> found;
  const auto length=static_cast<std::int64_t>(pulse.size()),size=static_cast<std::int64_t>(captured.size());
  for(const auto emit:emitted) {
    double best=0;std::int64_t bestLag=-1;
    for(std::int64_t lag=0;lag<=maxLag&&emit+lag+length<=size;++lag) {
      if(emit+lag<0)continue;
      const auto* x=captured.data()+emit+lag;double dot=0,energy=0;
      for(std::int64_t k=0;k<length;++k){dot+=double(pulse[static_cast<std::size_t>(k)])*x[k];energy+=double(x[k])*x[k];}
      // Ignore converter noise far below any usable loopback level.
      if(energy<pulseEnergy*1e-8)continue;
      const double similarity=std::abs(dot)/std::sqrt(pulseEnergy*energy);
      if(similarity>best){best=similarity;bestLag=lag;}
    }
    if(bestLag>=0&&best>=threshold)found.push_back({bestLag,std::min(1.0,best)});
  }
  if(found.empty())return result;
  std::vector<std::int64_t> lags;for(const auto& f:found)lags.push_back(f.lag);
  std::nth_element(lags.begin(),lags.begin()+static_cast<std::ptrdiff_t>(lags.size()/2),lags.end());
  const auto median=lags[lags.size()/2];
  // Hardware loopback is deterministic; a different lag is a false hit (noise,
  // a monitor echo), not jitter to average in.
  double clarity=0;std::vector<std::int64_t> consistent;
  for(const auto& f:found)if(std::abs(f.lag-median)<=2){consistent.push_back(f.lag);clarity+=f.clarity;}
  std::sort(consistent.begin(),consistent.end());
  result.detected=static_cast<std::uint32_t>(consistent.size());
  result.roundTripFrames=consistent[consistent.size()/2];
  result.confidence=std::clamp(clarity/static_cast<double>(std::max<std::size_t>(1,emitted.size())),0.0,1.0);
  return result;
}

void LoadMeter::record(double processing,double buffer)noexcept {
  if(!(buffer>0)||!std::isfinite(processing))return;
  const auto load=static_cast<float>(std::max(0.0,processing/buffer));
  last_.store(load,std::memory_order_relaxed);
  if(load>overloadThreshold)overloads_.fetch_add(1,std::memory_order_relaxed);
}
void LoadMeter::reset()noexcept{overloads_.store(0,std::memory_order_relaxed);last_.store(0,std::memory_order_relaxed);}

struct PreparedProject::Impl {
  ProjectTimeline timeline;
  std::vector<TrackRuntime> tracks;
  dsp::Master master;
  std::uint32_t latency=0;
  double tail=.85;
  std::shared_ptr<const ControlRecipe> recipe;
  std::uint64_t serial=0,preserveFrom=0;
  std::size_t wavetableMemory=0,wavetableTableMemory=0;
  explicit Impl(const ProjectTimeline& p):timeline(p),master(p.sampleRate){}
  void reset(std::int64_t frame,bool chase,bool effects,std::uint64_t& overflows)noexcept {
    for(auto&track:tracks) track.reset(frame,chase,effects,overflows);
    if(effects) master.reset();
  }
  void takeStateFrom(Impl& previous)noexcept {
    for(std::size_t i=0;i<tracks.size();++i)tracks[i].takeStateFrom(previous.tracks[i]);
    master.takeStateFrom(previous.master);
  }
  bool readyToPreserve()noexcept {
    for(auto& track:tracks)if(track.wavetable&&!track.wavetable->readyToTransfer())return false;
    return true;
  }
};
PreparedProject::PreparedProject(std::unique_ptr<Impl> impl):impl_(std::move(impl)){}
PreparedProject::~PreparedProject()=default;
PreparedProject::PreparedProject(PreparedProject&&)noexcept=default;
PreparedProject& PreparedProject::operator=(PreparedProject&&)noexcept=default;
std::size_t PreparedProject::trackCount()const noexcept{return impl_->tracks.size();}
double PreparedProject::tailSeconds()const noexcept{return impl_->tail;}
std::uint32_t PreparedProject::latencyFrames()const noexcept{return impl_->latency;}

struct RenderEngine::Impl {
  enum class Kind { Graph,Play,Pause,Stop,Seek,Preview,NoteOn,NoteOff,AllNotesOff,Monitor,RecordStart,RecordStop,Master,Input,Layout };
  struct Command {Kind kind=Kind::Stop;std::uint64_t ticket=0;PreparedProject*graph=nullptr;Capture*capture=nullptr;std::uint32_t track=0;std::int64_t frame=0;int pitch=60;std::int32_t noteId=-1;float value=1;std::array<std::uint64_t,4>mask{};std::array<std::uint8_t,maxInputLayout>layout{};};
  std::uint32_t rate,maxBlock;
  PreparedProject*active=nullptr;
  SpscQueue<Command,1024> commands;
  SpscQueue<PreparedProject*,4096>retired;
  std::optional<Command> deferred;
  std::uint64_t nextTicket=1,lastTicket=0,voiceOverflows=0,invalidSamples=0;
  std::atomic<std::uint64_t>commandOverflows{0};
  std::shared_ptr<const ControlRecipe>lastSubmittedRecipe;
  std::uint64_t lastSubmittedSerial=0;
  WavetableResources wavetableResources;
  std::size_t retainedWavetableMemory=0; // Control-thread graph ownership budget.
  std::size_t lastSubmittedWavetableTableMemory=0;
  std::int64_t position=0;
  std::int64_t continuousFrame=0;
  bool playing=false,offline=false,recording=false;
  float masterGain=1;
  float targetMasterGain=1;
  std::array<std::uint64_t,4>monitor{};
  int inputLeft=0,inputRight=1;
  // Callback copy of the device's physical channel order. Identity until set.
  std::array<std::uint8_t,maxInputLayout>layout{};std::uint32_t layoutCount=maxInputLayout;
  std::vector<float>inputScratch;
  Capture*capture=nullptr; // Callback-owned view of ownedCapture while recording.
  std::uint32_t recordingCapacity;
  // Control-thread state: the capture it owns, the stop that releases it, and
  // its own copies of the routing inputs used to plan takes before they start.
  std::unique_ptr<Capture>ownedCapture;
  std::uint64_t captureStopTicket=0;
  int controlLeft=0,controlRight=1;
  std::array<std::uint8_t,maxInputLayout>controlLayout{};std::uint32_t controlLayoutCount=maxInputLayout;
  std::uint64_t recordedFrames=0,droppedFrames=0;
  std::int64_t recordingStart=0;
  struct AtomicSnapshot {
    std::atomic<std::uint64_t>revision{0},ticket{0},voiceOverflows{0},invalidSamples{0},recorded{0},dropped{0},aheadResyncs{0};
    std::atomic<std::int64_t>frame{0},recordingStart{0};
    std::atomic<std::uint32_t>trackCount{0},latency{0},aheadTracks{0};
    std::atomic<bool>ready{false},playing{false},recording{false};
    std::atomic<float>masterPeak{0};std::array<std::atomic<float>,256>trackPeaks{};
  }published;

  // Multi-core processing. Configured on the control thread before the device
  // starts (setProcessing); the pool's workers live as long as this engine.
  std::unique_ptr<WorkerPool> pool;
  std::uint32_t workerCount=0,aheadBlocks=0,aheadHint=512;
  bool forkEnabled=false;
  // Render-ahead shared with workers. `aheadGraph` is the graph workers may
  // enter; each announces it in its hazard slot first, so the callback can
  // wait until none is inside before moving or retiring that graph's state.
  std::atomic<PreparedProject::Impl*> aheadGraph{nullptr};
  std::array<std::atomic<PreparedProject::Impl*>,maxProcessingThreads+1> hazards{};
  std::atomic<std::uint32_t> deviceBlock{0};
  std::atomic<bool> recordingNow{false};
  std::uint32_t aheadTracks=0; // Callback: tracks not Off (an upper bound between blocks).
  std::uint64_t aheadResyncs=0;
  // The sub-block every track task of one fork renders.
  struct Block {
    PreparedProject::Impl* graph=nullptr;const ProcessContext* context=nullptr;const float* input=nullptr;
    std::int64_t position=0;std::uint32_t count=0,cursor=0,channels=0;bool playing=false;
  } block;

  Impl(std::uint32_t r,std::uint32_t b,std::uint32_t capacity):rate(r),maxBlock(b),inputScratch(static_cast<std::size_t>(b)*2),recordingCapacity(capacity){
    for(std::size_t i=0;i<maxInputLayout;++i){layout[i]=static_cast<std::uint8_t>(i);controlLayout[i]=layout[i];}
  }
  ~Impl(){pool.reset();Command c;while(commands.pop(c))if(c.kind==Kind::Graph)delete c.graph;if(deferred&&deferred->kind==Kind::Graph)delete deferred->graph;PreparedProject*p=nullptr;while(retired.pop(p))delete p;delete active;}
  std::uint64_t enqueue(Command command) {
    command.ticket=nextTicket++;
    if(!commands.push(command)){commandOverflows.fetch_add(1,std::memory_order_relaxed);return 0;}return command.ticket;
  }
  // Tracks rendering ahead are skipped: their producer applies the same cycle
  // wrap at the same frame. Every other caller first reclaims them.
  void reset(bool chase,bool effects)noexcept {
    if(!active)return;
    auto&p=*active->impl_;
    for(auto&t:p.tracks)if(!t.ahead||t.ahead->mode.load(std::memory_order_relaxed)==AheadState::Off)t.reset(position,chase,effects,voiceOverflows);
    if(effects)p.master.reset();
  }

  // ---- Render-ahead -------------------------------------------------------
  // Callback: after this no worker is inside any graph or holds a track lock.
  void quiesce()noexcept {
    if(!pool||!aheadGraph.load(std::memory_order_relaxed))return;
    aheadGraph.store(nullptr,std::memory_order_seq_cst);
    for(std::uint32_t s=1;s<=pool->size();++s)spinUntil([&]{return hazards[s].load(std::memory_order_seq_cst)==nullptr;});
  }
  [[nodiscard]] std::int64_t boundaryOf(const ProjectTimeline&p)const noexcept{return p.cycle?p.cycle->at(1):p.lengthFrames;}
  [[nodiscard]] std::uint64_t aheadTarget(const AheadState&a)const noexcept {
    const auto b=std::max<std::uint32_t>(1,deviceBlock.load(std::memory_order_relaxed));
    return std::min<std::uint64_t>(a.capacity,std::uint64_t{b}*(1+aheadBlocks));
  }
  // Busy holder: render this track's next block exactly as the callback would.
  AheadState::Produce produce(const PreparedProject::Impl&g,TrackRuntime&t,bool helping)noexcept {
    auto&a=*t.ahead;const auto&p=g.timeline;const auto boundary=boundaryOf(p);
    if(a.nextFrame>=boundary) {
      if(!p.cycle)return AheadState::Produce::Ended;
      a.nextFrame=p.cycle->at(0);t.reset(a.nextFrame,true,false,a.pendingOverflows);
    }
    if(a.phase==0){a.block=std::max<std::uint32_t>(1,deviceBlock.load(std::memory_order_relaxed));}
    auto count=static_cast<std::uint32_t>(std::min<std::int64_t>({static_cast<std::int64_t>(maxBlock),static_cast<std::int64_t>(a.block-a.phase),boundary-a.nextFrame}));
    const auto written=a.written.load(std::memory_order_relaxed),fill=written-a.read.load(std::memory_order_acquire);
    const auto chunkIndex=a.writtenChunks.load(std::memory_order_relaxed);
    if(chunkIndex-a.readChunks.load(std::memory_order_acquire)>=AheadState::chunkSlots)return AheadState::Produce::Full;
    const auto limit=helping?std::uint64_t{a.capacity}:aheadTarget(a);
    if(fill+count>limit) {
      // Workers keep whole blocks (equal partitions render bit-identically).
      // The callback, short of audio after the device buffer grew, takes what fits.
      if(!helping||fill>=limit)return AheadState::Produce::Full;
      count=static_cast<std::uint32_t>(limit-fill);
    }
    ProcessContext context{static_cast<double>(rate),p.bpm,a.nextFrame,true,false,p.timeSigNumerator,p.timeSigDenominator};
    context.recording=recordingNow.load(std::memory_order_relaxed);context.continuousFrame=a.continuous;
    if(p.cycle){context.cycleActive=true;context.cycleStartFrame=p.cycle->at(0);context.cycleEndFrame=p.cycle->at(1);}
    std::uint64_t overflows=a.pendingOverflows,invalid=0;a.pendingOverflows=0;
    t.render(a.nextFrame,count,true,nullptr,false,false,context,overflows,invalid);
    const auto at=static_cast<std::size_t>(written%a.capacity),first=std::min<std::size_t>(count,a.capacity-at);
    std::copy_n(t.buffer.data(),first*2,a.ring.data()+at*2);
    std::copy_n(t.buffer.data()+first*2,(count-first)*2,a.ring.data());
    a.chunks[chunkIndex%AheadState::chunkSlots]={a.nextFrame,count,t.peak,overflows,invalid};
    a.nextFrame+=count;a.continuous+=count;a.phase+=count;if(a.phase>=a.block)a.phase=0;
    a.writtenChunks.store(chunkIndex+1,std::memory_order_release);
    a.written.store(written+count,std::memory_order_release);
    return AheadState::Produce::Done;
  }
  static bool background(void*self,std::uint32_t slot)noexcept{return static_cast<Impl*>(self)->produceAhead(slot);}
  // Worker: produce one block for the active track with the least audio ahead.
  bool produceAhead(std::uint32_t slot)noexcept {
    auto*g=aheadGraph.load(std::memory_order_seq_cst);
    if(!g)return false;
    hazards[slot].store(g,std::memory_order_seq_cst);
    if(aheadGraph.load(std::memory_order_seq_cst)!=g){hazards[slot].store(nullptr,std::memory_order_release);return true;}
    TrackRuntime*best=nullptr;std::uint64_t bestFill=std::numeric_limits<std::uint64_t>::max();
    for(auto&t:g->tracks) {
      if(!t.ahead)continue;
      auto&a=*t.ahead;
      if(a.mode.load(std::memory_order_acquire)!=AheadState::Active||a.busy.load(std::memory_order_relaxed))continue;
      const auto fill=a.written.load(std::memory_order_relaxed)-a.read.load(std::memory_order_acquire);
      if(fill<bestFill&&fill<aheadTarget(a)){best=&t;bestFill=fill;}
    }
    bool did=false;
    if(best) {
      auto&a=*best->ahead;
      if(!a.busy.exchange(true,std::memory_order_acquire)) {
        if(a.mode.load(std::memory_order_acquire)==AheadState::Active)did=produce(*g,*best,false)==AheadState::Produce::Done;
        a.unlock();
      } else did=true; // Another worker took it; look again.
    }
    hazards[slot].store(nullptr,std::memory_order_release);
    return did;
  }
  // Whether a track returning from render-ahead is exactly at `frame`. The
  // producer applies a cycle wrap lazily: if it stopped at the cycle end and the
  // callback already wrapped (skipping this track), apply that reset here. If
  // the producer wrapped first, the callback's own wrap repeats the same reset
  // at the same frame, which is idempotent.
  bool catchUp(const PreparedProject::Impl&g,TrackRuntime&t,std::int64_t frame,std::uint64_t&overflows)noexcept {
    auto&a=*t.ahead;const auto&p=g.timeline;
    overflows+=a.pendingOverflows;a.pendingOverflows=0;
    if(a.nextFrame==frame)return true;
    if(!p.cycle)return false;
    if(a.nextFrame>=p.cycle->at(1)&&frame==p.cycle->at(0)){a.nextFrame=frame;t.reset(frame,true,false,overflows);return true;}
    return a.nextFrame==p.cycle->at(0)&&frame>=p.cycle->at(1);
  }
  // Callback (transport change): every ahead track returns to the callback. A
  // drained ring hands over seamlessly; otherwise its state is ahead of the
  // playhead and is reset here (voices and tails) unless the caller resets all.
  void reclaimAll(bool resetFollows)noexcept {
    if(!active||!aheadTracks)return;
    quiesce();
    auto&g=*active->impl_;
    for(auto&t:g.tracks) {
      if(!t.ahead||t.ahead->mode.load(std::memory_order_relaxed)==AheadState::Off)continue;
      auto&a=*t.ahead;
      const bool seamless=a.empty()&&catchUp(g,t,position,voiceOverflows);
      a.mode.store(AheadState::Off,std::memory_order_relaxed);a.clear();
      if(!seamless&&!resetFollows)t.reset(position,false,true,voiceOverflows);
    }
    aheadTracks=0;
  }
  // Callback, preserving graph swap after quiesce: a track whose ring cannot
  // move into the new graph comes back first.
  void handOverAhead(PreparedProject::Impl&previous,PreparedProject::Impl&next)noexcept {
    for(std::size_t i=0;i<previous.tracks.size()&&i<next.tracks.size();++i) {
      auto&t=previous.tracks[i];
      if(!t.ahead||t.ahead->mode.load(std::memory_order_relaxed)==AheadState::Off)continue;
      if(next.tracks[i].ahead&&next.tracks[i].ahead->capacity==t.ahead->capacity)continue;
      auto&a=*t.ahead;
      const bool seamless=a.empty()&&catchUp(previous,t,position,voiceOverflows);
      a.mode.store(AheadState::Off,std::memory_order_relaxed);a.clear();
      if(!seamless)t.reset(position,playing,true,voiceOverflows);
    }
  }
  // Callback, before a live command: true when the callback owns the track.
  // Otherwise it stops rendering ahead and drains; the command waits.
  bool own(TrackRuntime&t)noexcept {
    if(!t.ahead)return true;
    const auto mode=t.ahead->mode.load(std::memory_order_relaxed);
    if(mode==AheadState::Off)return true;
    if(mode==AheadState::Active)t.ahead->mode.store(AheadState::Draining,std::memory_order_release);
    return false;
  }
  void markLive(TrackRuntime&t)noexcept{t.liveUntil=continuousFrame+static_cast<std::int64_t>(rate)*2;}
  // Block task: this track's audio for `block` from its ring into ahead->out.
  // False when the ring lost sync; the caller then resets and renders here.
  bool consumeAhead(PreparedProject::Impl&g,TrackRuntime&t)noexcept {
    auto&a=*t.ahead;const auto count=block.count;std::uint32_t got=0;
    while(got<count) {
      const auto read=a.read.load(std::memory_order_relaxed),avail=a.written.load(std::memory_order_acquire)-read;
      if(!avail) {
        if(a.mode.load(std::memory_order_relaxed)==AheadState::Draining) {
          a.lock();const bool drained=a.empty();
          if(drained)a.mode.store(AheadState::Off,std::memory_order_relaxed);
          a.unlock();
          if(!drained)continue;
          // Seamless hand-back: the track's state is exactly at this frame.
          const bool synced=catchUp(g,t,block.position+got,t.taskOverflows);a.clear();
          if(!synced)return false;
          auto context=*block.context;context.projectFrame+=got;context.continuousFrame+=got;
          t.render(block.position+got,count-got,block.playing,nullptr,false,false,context,t.taskOverflows,t.taskInvalid);
          std::copy_n(t.buffer.data(),static_cast<std::size_t>(count-got)*2,a.out.data()+static_cast<std::size_t>(got)*2);
          t.meter=t.peak;t.mix=a.out.data();
          return true;
        }
        if(a.busy.exchange(true,std::memory_order_acquire)){cpuRelax();continue;} // A worker is rendering it.
        const auto result=produce(g,t,true);a.unlock();
        if(result!=AheadState::Produce::Done&&a.empty())return false;
        continue;
      }
      const auto readChunk=a.readChunks.load(std::memory_order_relaxed);
      const auto&chunk=a.chunks[readChunk%AheadState::chunkSlots];
      if(chunk.start+a.chunkOffset!=block.position+got)return false;
      const auto n=static_cast<std::uint32_t>(std::min<std::uint64_t>({avail,std::uint64_t{count-got},std::uint64_t{chunk.frames-a.chunkOffset}}));
      const auto at=static_cast<std::size_t>(read%a.capacity),first=std::min<std::size_t>(n,a.capacity-at);
      float*dst=a.out.data()+static_cast<std::size_t>(got)*2;
      std::copy_n(a.ring.data()+at*2,first*2,dst);std::copy_n(a.ring.data(),(n-first)*2,dst+first*2);
      a.chunkOffset+=n;got+=n;
      if(a.chunkOffset==chunk.frames) {
        t.meter=chunk.peak;t.taskOverflows+=chunk.overflows;t.taskInvalid+=chunk.invalid;
        a.chunkOffset=0;a.readChunks.store(readChunk+1,std::memory_order_release);
      }
      a.read.store(read+n,std::memory_order_release);
    }
    t.mix=a.out.data();
    if(a.mode.load(std::memory_order_relaxed)==AheadState::Draining&&a.empty()) {
      // Drained exactly at this block's end: the next block renders here.
      a.lock();const bool drained=a.empty();
      if(drained)a.mode.store(AheadState::Off,std::memory_order_relaxed);
      a.unlock();
      if(drained) {
        if(!catchUp(g,t,block.position+count,t.taskOverflows)){t.reset(block.position+count,block.playing,true,t.taskOverflows);++t.taskResyncs;}
        a.clear();
      }
    }
    return true;
  }
  static void trackTask(void*self,std::uint32_t index,std::uint32_t slot)noexcept{static_cast<Impl*>(self)->renderTrack(index,slot);}
  void renderTrack(std::uint32_t index,std::uint32_t slot)noexcept {
    auto&g=*block.graph;auto&t=g.tracks[index];
    t.taskOverflows=0;t.taskInvalid=0;
    if(t.ahead&&t.ahead->mode.load(std::memory_order_acquire)!=AheadState::Off) {
      if(consumeAhead(g,t))return;
      // Lost sync (never expected): the documented per-track reset.
      auto&a=*t.ahead;a.lock();a.mode.store(AheadState::Off,std::memory_order_relaxed);a.clear();a.unlock();
      t.reset(block.position,block.playing,true,t.taskOverflows);++t.taskResyncs;
    }
    const bool monitored=(monitor[index/64]&(std::uint64_t{1}<<(index%64)))!=0;
    // Each monitored track hears its own input; an unopened one hears silence.
    const float*trackInput=nullptr;bool stereoInput=false;
    if(monitored) {
      const auto route=routeInput(t.timeline.input,std::span(layout.data(),layoutCount),block.channels,inputLeft,inputRight);
      if(!route.missing) {
        float*scratch=inputScratch.data()+static_cast<std::size_t>(slot)*maxBlock*2;
        for(std::uint32_t i=0;i<block.count;++i) {
          const float left=inputSample(block.input,block.channels,block.cursor+i,route.left,t.taskInvalid);
          scratch[2*i]=left;scratch[2*i+1]=route.right>=0?inputSample(block.input,block.channels,block.cursor+i,route.right,t.taskInvalid):left;
        }
        trackInput=scratch;stereoInput=route.right>=0;
      }
    }
    t.render(block.position,block.count,block.playing,trackInput,monitored,stereoInput,*block.context,t.taskOverflows,t.taskInvalid);
    t.meter=t.peak;t.mix=t.buffer.data();
  }
  // Callback, end of a device buffer: hand eligible tracks to the workers.
  void promote()noexcept {
    std::uint32_t count=0;
    if(pool&&aheadBlocks&&!offline&&active&&playing) {
      auto&g=*active->impl_;
      const auto blockFrames=deviceBlock.load(std::memory_order_relaxed);
      const bool open=!deferred&&blockFrames&&position<boundaryOf(g.timeline);
      for(std::size_t i=0;i<g.tracks.size();++i) {
        auto&t=g.tracks[i];
        if(!t.ahead)continue;
        auto&a=*t.ahead;
        if(a.mode.load(std::memory_order_relaxed)!=AheadState::Off){++count;continue;}
        if(!open||a.capacity<std::uint64_t{blockFrames}*2||continuousFrame<t.liveUntil)continue;
        if((monitor[i/64]&(std::uint64_t{1}<<(i%64)))||t.pendingCount||t.releaseAudition)continue;
        if(capture&&std::any_of(capture->takes.begin(),capture->takes.end(),[&](const RecordingTake&take){return take.track==i;}))continue;
        a.clear();a.nextFrame=position;a.continuous=continuousFrame;a.block=blockFrames;
        a.mode.store(AheadState::Active,std::memory_order_release);++count;
      }
      if(count) {
        if(aheadGraph.load(std::memory_order_relaxed)!=&g)aheadGraph.store(&g,std::memory_order_seq_cst);
        pool->wake();
      }
    }
    aheadTracks=count;
  }
  void normalize(bool starting=false)noexcept {
    if(!active){position=0;return;}
    const auto&p=active->impl_->timeline;position=std::clamp<std::int64_t>(position,0,p.lengthFrames);
    if(!offline&&p.cycle&&position>=p.cycle->at(1))position=p.cycle->at(0);
    else if(starting&&position==p.lengthFrames)position=0;
  }
  void consume()noexcept {
    Command c;
    while(deferred||commands.pop(c)) {
      if(deferred){c=*deferred;deferred.reset();}
      switch(c.kind) {
        case Kind::Graph: {
          const bool projectChanged=!active||active->impl_->timeline.projectId!=c.graph->impl_->timeline.projectId;
          auto*previous=active;
          const bool preserve=previous&&c.graph->impl_->preserveFrom&&previous->impl_->serial==c.graph->impl_->preserveFrom;
          // Keep at most two immutable table sets in one running synth. A
          // rapid edit waits for the current 20 ms table crossfade, then moves
          // completed ownership into the graph retired on the control thread.
          // No worker may be inside either graph while its state is read, moved
          // or retired (the next block's promote() lets them back in).
          quiesce();
          if(preserve&&!previous->impl_->readyToPreserve()){deferred=c;return;}
          if(preserve)handOverAhead(*previous->impl_,*c.graph->impl_);
          active=c.graph;targetMasterGain=active->impl_->timeline.masterGain;
          if(preserve)active->impl_->takeStateFrom(*previous->impl_);
          else {masterGain=targetMasterGain;aheadTracks=0;}
          if(projectChanged){position=0;playing=false;monitor={};}
          normalize();if(!preserve)reset(playing,true);
          if(previous){const bool accepted=retired.push(previous);(void)accepted;}
          break;
        }
        case Kind::Play:if(!playing){normalize(true);playing=active!=nullptr;reset(playing,false);}break;
        case Kind::Pause:reclaimAll(false);playing=false;reset(false,false);break;
        case Kind::Stop:reclaimAll(true);playing=false;position=0;reset(false,true);break;
        case Kind::Seek:reclaimAll(true);position=c.frame;normalize();reset(playing,true);break;
        case Kind::Preview:case Kind::NoteOn:case Kind::NoteOff:case Kind::AllNotesOff: {
          if(!active||c.track>=active->impl_->tracks.size())break;
          auto&t=active->impl_->tracks[c.track];
          // A track rendering ahead finishes its ring first (a few buffers):
          // live notes then start on time from the callback-owned state.
          if(!own(t)){deferred=c;return;}
          markLive(t);
          if(c.kind==Kind::NoteOff)t.noteOff(c.pitch,c.noteId,voiceOverflows);
          else if(c.kind==Kind::AllNotesOff)t.allNotesOff(voiceOverflows);
          else t.spawn(c.pitch,c.value,c.frame,c.frame,c.noteId,true,voiceOverflows);
          break;
        }
        case Kind::Monitor: {
          bool wait=false;
          if(active)for(std::size_t i=0;i<active->impl_->tracks.size();++i)if((c.mask[i/64]&(std::uint64_t{1}<<(i%64)))&&!own(active->impl_->tracks[i]))wait=true;
          if(wait){deferred=c;return;}
          monitor=c.mask;break;
        }
        case Kind::RecordStart: {
          bool wait=false;
          if(active&&c.capture)for(const auto&take:c.capture->takes)if(take.track<active->impl_->tracks.size()&&!own(active->impl_->tracks[take.track]))wait=true;
          if(wait){deferred=c;return;}
          capture=c.capture;recording=capture!=nullptr;recordingStart=position;recordedFrames=0;droppedFrames=0;break;
        }
        case Kind::RecordStop:recording=false;capture=nullptr;break;
        case Kind::Master:targetMasterGain=c.value;break;
        case Kind::Input:inputLeft=c.pitch;inputRight=static_cast<int>(c.frame);break;
        case Kind::Layout:layout=c.layout;layoutCount=c.track;break;
      }
      lastTicket=c.ticket;
    }
  }
  void publish(float masterPeak)noexcept {
    published.frame.store(position,std::memory_order_relaxed);published.playing.store(playing,std::memory_order_relaxed);published.ready.store(active!=nullptr,std::memory_order_relaxed);
    const auto count=active?active->impl_->tracks.size():0;
    published.trackCount.store(static_cast<std::uint32_t>(count),std::memory_order_relaxed);
    published.revision.store(active?active->impl_->timeline.revision:0,std::memory_order_relaxed);
    published.latency.store(active?active->impl_->latency:0,std::memory_order_relaxed);
    for(std::size_t i=0;i<count;++i)published.trackPeaks[i].store(active->impl_->tracks[i].meter,std::memory_order_relaxed);
    published.aheadTracks.store(aheadTracks,std::memory_order_relaxed);published.aheadResyncs.store(aheadResyncs,std::memory_order_relaxed);
    published.masterPeak.store(masterPeak,std::memory_order_relaxed);published.voiceOverflows.store(voiceOverflows,std::memory_order_relaxed);published.invalidSamples.store(invalidSamples,std::memory_order_relaxed);
    published.recording.store(recording,std::memory_order_relaxed);published.recordingStart.store(recordingStart,std::memory_order_relaxed);
    published.recorded.store(recordedFrames,std::memory_order_relaxed);published.dropped.store(droppedFrames,std::memory_order_relaxed);
    published.ticket.store(lastTicket,std::memory_order_release);
  }
};

RenderEngine::RenderEngine(std::uint32_t sr,std::uint32_t maxBlock,std::uint32_t recordCapacity) {
  require(sr>=8000&&sr<=192000&&maxBlock>=1&&maxBlock<=65536,"Invalid native engine format");
  require(recordCapacity>=maxBlock&&recordCapacity<=sr*60,"Invalid recording ring capacity");
  static_assert(std::atomic<float>::is_always_lock_free&&std::atomic<std::uint64_t>::is_always_lock_free,"Native audio requires lock-free float and 64-bit atomics");
  impl_=std::make_unique<Impl>(sr,maxBlock,recordCapacity);
}
RenderEngine::~RenderEngine()=default;

std::unique_ptr<PreparedProject> RenderEngine::prepare(const ProjectTimeline& p,const AssetStore& assets,const SampleSetStore& sets,const PluginResolver& resolvePlugin)const {
  require(p.version==1&&p.sampleRate==impl_->rate,"Native project/device sample rates must agree");
  require(p.tracks.size()<=256&&p.lengthFrames>0&&p.lengthFrames<=static_cast<std::int64_t>(p.sampleRate)*3600,"Native project exceeds track/duration limits");
  require(p.projectId.size()<=200&&!p.projectId.empty(),"Invalid native project ID");
  checked(p.bpm,20,400,"Invalid native tempo");checked(p.masterGain,0,2,"Invalid native master gain");
  require(p.timeSigNumerator>=1&&p.timeSigNumerator<=32&&(p.timeSigDenominator==2||p.timeSigDenominator==4||p.timeSigDenominator==8||p.timeSigDenominator==16),"Invalid native meter");
  if(p.cycle)require(p.cycle->at(0)>=0&&p.cycle->at(1)<=p.lengthFrames&&p.cycle->at(1)>p.cycle->at(0),"Invalid native cycle");
  std::size_t estimated=0,noteCount=0,windowCount=0;
  std::set<const ieum::wave::PreparedWavetableSet*> waveTables;
  std::set<std::string>ids,pluginIds;
  for(const auto&t:p.tracks){require(!t.id.empty()&&t.id.size()<=200&&ids.insert(t.id).second,"Invalid or duplicate native track ID");
    noteCount+=t.notes.size();windowCount+=t.audio.size();require(t.inserts.size()<=64&&t.audio.size()<=2048,"Native track exceeds limits");
    const auto uniquePlugin=[&](const PluginSpec&plugin){require(!plugin.instanceId.empty()&&pluginIds.insert(plugin.instanceId).second,"Invalid or duplicate native plugin instance ID");};
    if(t.source.kind==TrackSource::Kind::Vst3)uniquePlugin(t.source.plugin);
    for(const auto&e:t.inserts)if(e.type=="vst3")uniquePlugin(e.plugin);
    for(const auto&e:t.inserts)if(t.enabled&&e.enabled)estimated+=dsp::estimateEffectMemory(e.type,p.sampleRate);
  }
  require(noteCount<=100000&&windowCount<=8192&&estimated<=memoryLimit,"Native project exceeds bounded memory/event limits");
  auto result=std::make_unique<PreparedProject::Impl>(p);result->tracks.reserve(p.tracks.size());
  auto recipe=std::make_shared<ControlRecipe>();recipe->timeline=p;
  for(const auto&t:p.tracks) {
    TrackRuntime track;track.timeline=t;track.sampleRate=p.sampleRate;track.projectLength=p.lengthFrames;track.contextLowLatency=p.lowLatencyMonitoring;
    track.fader=t.audible?t.gain:0;track.panValue=t.pan;
    checked(t.gain,0,2,"Invalid native track gain");checked(t.pan,-1,1,"Invalid native pan");
    track.buffer.resize(static_cast<std::size_t>(impl_->maxBlock)*2);
    require(t.source.kind!=TrackSource::Kind::Audio||t.notes.empty(),"Audio tracks cannot contain instrument notes");
    require(t.source.kind==TrackSource::Kind::Audio||t.audio.empty(),"Instrument tracks cannot contain audio windows");
    if(t.source.kind==TrackSource::Kind::BuiltinSynth||t.source.kind==TrackSource::Kind::BuiltinSampled)track.synth=compileSynth(t.source);
    // An explicitly disabled source is retained in the immutable recipe but
    // needs neither its sample library nor a loadable third-party plug-in.
    if(!t.enabled){result->tracks.push_back(std::move(track));continue;}
    double trackTail=0;
    if(t.source.kind==TrackSource::Kind::NativeWavetable) {
      require(p.sampleRate>=22050,"IEUM WAVE requires a sample rate of 22050..192000 Hz");
      require(t.source.instrumentId=="wavetable"&&!t.source.isKit,"Invalid IEUM WAVE source");
      auto prepared=impl_->wavetableResources.prepare(t.source.patchData);
      const auto tableBytes=waveTables.insert(prepared.tables.get()).second?prepared.tables->bytes():0;
      const auto bytes=WavetableProcessor::instanceMemory(p.sampleRate,impl_->maxBlock)
        +tableBytes+t.source.patchData.size()*3;
      estimated+=bytes;result->wavetableMemory+=bytes;result->wavetableTableMemory+=tableBytes;
      require(estimated<=memoryLimit,"IEUM WAVE exceeds native memory budget");
      track.wavetable=std::make_shared<WavetableProcessor>(std::move(prepared),p.sampleRate,impl_->maxBlock);
      track.instrument=track.wavetable;track.stereoSource=true;trackTail=track.wavetable->tailSeconds();
    }
    if(t.source.kind==TrackSource::Kind::BuiltinSampled){const auto set=sets.find(t.source.sampleSetId);require(set!=sets.end(),"Required native sample set is not registered");require(set->second.isKit==t.source.isKit,"Sample kind differs from instrument");track.samples=resolveSet(set->second,assets);recipe->sets.push_back(set->second);
      for(const auto&z:track.samples.zones){recipe->assets.push_back(z.asset);track.stereoSource|=z.asset->channels>1;
        if(t.source.isKit)trackTail=std::max(trackTail,(static_cast<double>(z.asset->frames())/z.asset->sampleRate-track.samples.startOffset)/std::pow(2,z.zone.tune/1200+track.synth.tune/12)*track.synth.decay+.014);
      }
      for(const auto&z:track.samples.releases){recipe->assets.push_back(z.asset);track.stereoSource|=z.asset->channels>1;
        trackTail=std::max(trackTail,(static_cast<double>(z.asset->frames())/z.asset->sampleRate-track.samples.startOffset)/std::pow(2,(z.zone.lo-z.zone.root)/12.0+z.zone.tune/1200));
      }
    }
    if(t.source.kind==TrackSource::Kind::Vst3){require(static_cast<bool>(resolvePlugin),"No native VST3 host is available");track.instrument=resolvePlugin(t.source.plugin,p.sampleRate,impl_->maxBlock);require(static_cast<bool>(track.instrument),"VST3 instrument could not be prepared");track.latency=track.instrument->latencyFrames();track.stereoSource=true;trackTail=checked(track.instrument->tailSeconds(),0,3600,"Invalid plugin tail time");require(track.latency<=p.sampleRate*30,"Plugin latency exceeds native memory budget");}
    if(t.source.kind==TrackSource::Kind::BuiltinSynth||t.source.kind==TrackSource::Kind::BuiltinSampled)trackTail=std::max(trackTail,t.source.isKit?(track.synth.kind==Synth::Kind::Drums?.62*track.synth.decay+.004:0):track.synth.release*1.5+.02);
    std::set<std::int32_t>noteIds;
    for(const auto&n:t.notes){require(noteIds.insert(n.id).second&&n.pitch>=0&&n.pitch<=127&&n.onFrame>=-p.lengthFrames&&n.offFrame>n.onFrame&&n.offFrame>0&&n.offFrame<=p.lengthFrames&&n.limitFrame>=n.offFrame&&n.limitFrame<=p.lengthFrames,"Invalid native note event");checked(n.velocity,0,2,"Invalid native note velocity");
      if(track.instrument&&n.velocity>0){track.events.push_back({n.onFrame,{PluginEvent::Type::NoteOn,0,n.id,static_cast<std::uint8_t>(n.pitch),0,track.wavetable?n.velocity:std::min(1.f,n.velocity),0}});track.events.push_back({n.offFrame,{PluginEvent::Type::NoteOff,0,n.id,static_cast<std::uint8_t>(n.pitch),0,0,0}});}
    }
    std::stable_sort(track.timeline.notes.begin(),track.timeline.notes.end(),[](const NotePair&a,const NotePair&b){return a.onFrame<b.onFrame||(a.onFrame==b.onFrame&&a.id<b.id);});
    std::stable_sort(track.events.begin(),track.events.end(),[](const TimedPluginEvent&a,const TimedPluginEvent&b){return a.frame<b.frame||(a.frame==b.frame&&a.event.type==PluginEvent::Type::NoteOff&&b.event.type!=PluginEvent::Type::NoteOff);});
    for(std::size_t begin=0,end=0;end<track.events.size();++end){
      while(track.events[end].frame-track.events[begin].frame>=impl_->maxBlock)++begin;
      // Leave room for all queued live notes and their auto-release events.
      require(end-begin+1<=maxPluginEvents-maxVoices*2-1,"Instrument note density exceeds the bounded event buffer");
    }
    for(const auto&w:t.audio){require(w.startFrame>=0&&w.endFrame>w.startFrame&&w.endFrame<=p.lengthFrames&&w.clipLengthFrames>0&&w.clipOffsetFrames>=0&&w.fadeInFrames>=0&&w.fadeOutFrames>=0,"Invalid native audio window");
      checked(w.gain,0,2,"Invalid audio window gain");checked(w.sourceStartFrame,0,1e15,"Invalid audio source offset");checked(w.sourceSampleRate,8000,192000,"Invalid source sample rate");
      auto a=resolveAsset(assets,w.assetId);require(w.sourceSampleRate==a->sampleRate&&w.sourceStartFrame<a->frames(),"Audio window does not match registered PCM");
      track.stereoSource|=a->channels>1;
      recipe->assets.push_back(a);
      track.windows.push_back({w,std::move(a)});
    }
    std::stable_sort(track.windows.begin(),track.windows.end(),[](const ResolvedWindow&a,const ResolvedWindow&b){return a.window.startFrame<b.window.startFrame;});
    std::set<std::string>insertIds;
    for(const auto&e:t.inserts){require(!e.id.empty()&&insertIds.insert(e.id).second,"Duplicate native insert ID");if(!e.enabled)continue;
      InsertRuntime effect;
      if(e.type=="vst3"){require(static_cast<bool>(resolvePlugin),"No native VST3 host is available");effect.plugin=resolvePlugin(e.plugin,p.sampleRate,impl_->maxBlock);require(static_cast<bool>(effect.plugin),"VST3 effect could not be prepared");const auto latency=effect.plugin->latencyFrames();require(latency<=p.sampleRate*30,"Plugin latency exceeds native memory budget");track.latency+=latency;trackTail+=checked(effect.plugin->tailSeconds(),0,3600,"Invalid plugin tail time");track.stereoEffects=true;}
      else {effect.builtin=dsp::makeEffect(e.type,e.params,p.sampleRate,p.bpm);track.latency+=effect.builtin->latencyFrames();trackTail+=effect.builtin->tailSeconds();track.stereoEffects|=e.type=="reverb"||e.type=="guitar-rig";}
      require(track.latency<=p.sampleRate*30,"Plugin latency exceeds native memory budget");track.inserts.push_back(std::move(effect));
    }
    result->tail=std::max(result->tail,trackTail+.15);
    result->latency=std::max(result->latency,track.latency);result->tracks.push_back(std::move(track));
  }
  estimated+=static_cast<std::size_t>(result->latency)*p.tracks.size()*16;
  require(estimated<=memoryLimit,"Plugin compensation exceeds native memory budget");
  for(auto&t:result->tracks)t.compensation=CompensationDelay(result->latency-t.latency);
  if(impl_->aheadBlocks&&!impl_->offline) {
    // Rings hold the current device buffer plus the ahead window. VST3 tracks
    // stay in the callback: their editors feed parameters that must be heard now.
    const auto capacity=std::min<std::uint32_t>(65536,std::max<std::uint32_t>(64,impl_->aheadHint)*(1+impl_->aheadBlocks));
    const auto bytes=(static_cast<std::size_t>(capacity)+impl_->maxBlock)*2*sizeof(float);
    std::size_t budget=aheadMemoryBudget;
    for(auto&t:result->tracks) {
      const bool vst3=(t.instrument&&!t.wavetable)||std::any_of(t.inserts.begin(),t.inserts.end(),[](const InsertRuntime&i){return i.plugin!=nullptr;});
      if(!t.timeline.enabled||vst3)continue;
      if(bytes>budget)break;
      budget-=bytes;t.ahead=std::make_unique<AheadState>(capacity,impl_->maxBlock);
    }
  }
  result->recipe=std::move(recipe);
  return std::unique_ptr<PreparedProject>(new PreparedProject(std::move(result)));
}

std::uint64_t RenderEngine::submit(std::unique_ptr<PreparedProject> project) {
  require(project!=nullptr,"Cannot submit an empty native graph");collectRetired();
  auto recipe=project->impl_->recipe;
  project->impl_->serial=impl_->nextTicket;
  project->impl_->preserveFrom=impl_->lastSubmittedRecipe&&sameStructure(*recipe,*impl_->lastSubmittedRecipe)?impl_->lastSubmittedSerial:0;
  // A graph can keep its predecessor's table set through the 20 ms crossfade
  // after that predecessor is collected. Include those bytes until this graph
  // retires; shared tables are intentionally conservatively counted twice.
  if(project->impl_->preserveFrom)project->impl_->wavetableMemory+=impl_->lastSubmittedWavetableTableMemory;
  require(impl_->retainedWavetableMemory+project->impl_->wavetableMemory<=memoryLimit,
    "Pending IEUM WAVE updates exceed native memory budget");
  Impl::Command c;c.kind=Impl::Kind::Graph;c.graph=project.get();
  const auto serial=impl_->enqueue(c);
  if(!serial)throw std::runtime_error("Native graph command queue is full");
  impl_->lastSubmittedRecipe=std::move(recipe);impl_->lastSubmittedSerial=serial;
  impl_->lastSubmittedWavetableTableMemory=project->impl_->wavetableTableMemory;
  impl_->retainedWavetableMemory+=project->impl_->wavetableMemory;
  (void)project.release();
  return serial;
}
void RenderEngine::collectRetired(){PreparedProject*p=nullptr;while(impl_->retired.pop(p)){impl_->retainedWavetableMemory-=p->impl_->wavetableMemory;delete p;}}
std::uint64_t RenderEngine::play(){Impl::Command c;c.kind=Impl::Kind::Play;return impl_->enqueue(c);}
std::uint64_t RenderEngine::pause(){Impl::Command c;c.kind=Impl::Kind::Pause;return impl_->enqueue(c);}
std::uint64_t RenderEngine::stop(){Impl::Command c;c.kind=Impl::Kind::Stop;return impl_->enqueue(c);}
std::uint64_t RenderEngine::seek(std::int64_t frame){Impl::Command c;c.kind=Impl::Kind::Seek;c.frame=frame;return impl_->enqueue(c);}
std::uint64_t RenderEngine::previewNote(std::uint32_t track,int pitch,float velocity,std::uint32_t duration){require(track<256&&pitch>=0&&pitch<=127&&duration>0&&duration<=impl_->rate*30,"Invalid preview note");checked(velocity,0,2,"Invalid preview velocity");Impl::Command c;c.kind=Impl::Kind::Preview;c.track=track;c.pitch=pitch;c.value=velocity;c.frame=duration;c.noteId=-2;return impl_->enqueue(c);}
std::uint64_t RenderEngine::noteOn(std::uint32_t track,int pitch,float velocity,std::int32_t id){require(track<256&&pitch>=0&&pitch<=127,"Invalid live MIDI note");checked(velocity,0,2,"Invalid MIDI velocity");Impl::Command c;c.kind=Impl::Kind::NoteOn;c.track=track;c.pitch=pitch;c.value=velocity;c.noteId=id;c.frame=unlimitedFrame;return impl_->enqueue(c);}
std::uint64_t RenderEngine::noteOff(std::uint32_t track,int pitch,std::int32_t id){require(track<256&&pitch>=0&&pitch<=127,"Invalid MIDI note off");Impl::Command c;c.kind=Impl::Kind::NoteOff;c.track=track;c.pitch=pitch;c.noteId=id;return impl_->enqueue(c);}
std::uint64_t RenderEngine::allNotesOff(std::uint32_t track){require(track<256,"Invalid audition track index");Impl::Command c;c.kind=Impl::Kind::AllNotesOff;c.track=track;return impl_->enqueue(c);}
std::uint64_t RenderEngine::setMonitoring(std::span<const std::uint32_t> tracks){Impl::Command c;c.kind=Impl::Kind::Monitor;for(const auto t:tracks){require(t<256,"Invalid monitor track index");c.mask[t/64]|=std::uint64_t{1}<<(t%64);}return impl_->enqueue(c);}
std::vector<RecordingTake> RenderEngine::planRecording(std::span<const std::uint32_t> tracks)const {
  const auto&e=*impl_;require(e.lastSubmittedRecipe!=nullptr,"Submit a project before recording");
  require(!tracks.empty()&&tracks.size()<=maxRecordingTakes,"Invalid recording take count");
  const auto&timeline=e.lastSubmittedRecipe->timeline;std::set<std::uint32_t>seen;std::vector<RecordingTake>takes;
  for(const auto track:tracks) {
    require(track<timeline.tracks.size()&&seen.insert(track).second,"Invalid or duplicate recording track");
    takes.push_back({track,routeInput(timeline.tracks[track].input,std::span(e.controlLayout.data(),e.controlLayoutCount),e.controlLayoutCount,e.controlLeft,e.controlRight)});
  }
  return takes;
}
std::uint64_t RenderEngine::startRecording(std::span<const RecordingTake> takes){
  auto&e=*impl_;
  require(!takes.empty()&&takes.size()<=maxRecordingTakes,"Invalid recording take count");
  if(e.ownedCapture) {
    // The callback may still hold the previous capture until its stop is consumed.
    require(e.captureStopTicket&&e.published.ticket.load(std::memory_order_acquire)>=e.captureStopTicket,"Stop the previous recording before starting a take");
    require(e.ownedCapture->read.load(std::memory_order_acquire)==e.ownedCapture->write.load(std::memory_order_acquire),"Previous recording must be drained before starting a take");
  }
  auto capture=std::make_unique<Capture>();
  for(const auto&take:takes) {
    const auto&r=take.route;
    require(r.channels>=1&&r.channels<=2&&r.left>=-1&&r.left<64&&r.right>=-1&&r.right<64,"Invalid recording input route");
    capture->channels+=r.channels;capture->takes.push_back(take);
  }
  capture->capacity=std::max<std::uint64_t>(e.maxBlock,std::min<std::uint64_t>(e.recordingCapacity,captureSampleBudget/capture->channels));
  capture->ring.resize(static_cast<std::size_t>(capture->capacity*capture->channels));
  Impl::Command c;c.kind=Impl::Kind::RecordStart;c.capture=capture.get();
  e.ownedCapture=std::move(capture);e.captureStopTicket=0;
  const auto ticket=e.enqueue(c);
  if(!ticket)e.ownedCapture.reset(); // Never reached the callback.
  return ticket;
}
std::uint64_t RenderEngine::startRecording(){
  // The former whole-device take: the default pair, mono duplicated to stereo.
  RecordingTake take;take.track=std::numeric_limits<std::uint32_t>::max();
  take.route.left=impl_->controlLeft;take.route.right=impl_->controlRight;take.route.channels=2;
  return startRecording(std::span(&take,1));
}
std::uint64_t RenderEngine::stopRecording(){Impl::Command c;c.kind=Impl::Kind::RecordStop;const auto ticket=impl_->enqueue(c);if(ticket)impl_->captureStopTicket=ticket;return ticket;}
std::uint32_t RenderEngine::recordingChannels()const noexcept{return impl_->ownedCapture?impl_->ownedCapture->channels:2;}
std::uint64_t RenderEngine::setInputLayout(std::span<const std::uint32_t> channels){
  require(channels.size()<=maxInputLayout,"Too many native input channels");
  Impl::Command c;c.kind=Impl::Kind::Layout;c.track=static_cast<std::uint32_t>(channels.size());std::set<std::uint32_t>seen;
  for(std::size_t i=0;i<channels.size();++i){require(channels[i]<256&&seen.insert(channels[i]).second,"Invalid or duplicate native input channel");c.layout[i]=static_cast<std::uint8_t>(channels[i]);}
  impl_->controlLayout=c.layout;impl_->controlLayoutCount=c.track;
  return impl_->enqueue(c);
}
std::uint64_t RenderEngine::setMasterGain(float gain){checked(gain,0,2,"Invalid master gain");Impl::Command c;c.kind=Impl::Kind::Master;c.value=gain;return impl_->enqueue(c);}
std::uint64_t RenderEngine::setInputChannels(int left,int right){require(left>=0&&left<64&&right>=-1&&right<64,"Invalid native input channel");Impl::Command c;c.kind=Impl::Kind::Input;c.pitch=left;c.frame=right;impl_->controlLeft=left;impl_->controlRight=right;return impl_->enqueue(c);}
void RenderEngine::setOffline(bool value)noexcept{impl_->offline=value;}
std::uint32_t autoProcessingThreads()noexcept {
  const auto hardware=std::thread::hardware_concurrency();
  return hardware>1?std::min(hardware-1,8u):0u;
}
void RenderEngine::setProcessing(const ProcessingOptions& options){
  auto&e=*impl_;
  require(options.threads<=maxProcessingThreads,"Invalid native processing thread count");
  require(!e.lastSubmittedRecipe&&!e.active,"Configure native processing before submitting a project");
  e.pool.reset();e.workerCount=0;e.forkEnabled=false;
  e.aheadBlocks=e.offline?0:renderAheadBlocks(options.renderAhead);
  e.aheadHint=options.deviceBlockFrames?std::clamp<std::uint32_t>(options.deviceBlockFrames,16,16384):512;
  // Rendering ahead needs at least one worker even when blocks are not forked.
  const auto workers=options.threads?options.threads:(e.aheadBlocks?1u:0u);
  e.inputScratch.assign(static_cast<std::size_t>(workers+1)*e.maxBlock*2,0.f);
  if(!workers)return;
  e.pool=std::make_unique<WorkerPool>(workers,&Impl::background,&e,options.onWorkerThread);
  e.workerCount=workers;e.forkEnabled=options.threads>0;
}

void RenderEngine::render(float* output,const float* input,std::uint32_t frames,std::uint32_t channels)noexcept {
  if(!output)return;
  auto& e=*impl_;
  if(frames)e.deviceBlock.store(frames,std::memory_order_relaxed);
  e.consume();
  e.recordingNow.store(e.recording,std::memory_order_relaxed);
  std::uint32_t cursor=0;float masterPeak=0;
  while(cursor<frames) {
    auto count=std::min(e.maxBlock,frames-cursor);
    if(e.active&&e.playing) {
      const auto&p=e.active->impl_->timeline;
      const auto boundary=!e.offline&&p.cycle?p.cycle->at(1):p.lengthFrames;
      if(e.position>=boundary) {
        if(!e.offline&&p.cycle){e.position=p.cycle->at(0);e.reset(true,false);}
        else if(!e.offline){e.reclaimAll(false);e.playing=false;for(auto&track:e.active->impl_->tracks)if(track.instrument&&!track.wavetable)track.instrument->requestReset();}
      }
      if(e.playing&&e.position<boundary)count=static_cast<std::uint32_t>(std::min<std::int64_t>(count,boundary-e.position));
    }
    if(e.recording&&e.capture) {
      // Every take shares one frame clock: the same callback frames, written together.
      auto&cap=*e.capture;
      const auto write=cap.write.load(std::memory_order_relaxed),read=cap.read.load(std::memory_order_acquire);
      const auto available=cap.capacity-(write-read),take=std::min<std::uint64_t>(available,count);
      for(std::uint64_t i=0;i<take;++i) {
        float*frame=cap.ring.data()+static_cast<std::size_t>((write+i)%cap.capacity)*cap.channels;
        const auto at=cursor+static_cast<std::uint32_t>(i);
        for(const auto&t:cap.takes) {
          const float left=inputSample(input,channels,at,t.route.left,e.invalidSamples);*frame++=left;
          if(t.route.channels==2)*frame++=t.route.right>=0?inputSample(input,channels,at,t.route.right,e.invalidSamples):left;
        }
      }
      cap.write.store(write+take,std::memory_order_release);e.recordedFrames+=count;e.droppedFrames+=count-take;
      if(take<count)e.recording=false;
    }
    auto*out=output+static_cast<std::size_t>(cursor)*2;std::fill_n(out,static_cast<std::size_t>(count)*2,0.f);
    if(e.active) {
      auto& p=*e.active->impl_;
      ProcessContext context{static_cast<double>(e.rate),p.timeline.bpm,e.position,e.playing&&e.position<p.timeline.lengthFrames,e.offline,p.timeline.timeSigNumerator,p.timeline.timeSigDenominator};
      context.recording=e.recording;context.continuousFrame=e.continuousFrame;
      if(p.timeline.cycle&&!e.offline){context.cycleActive=true;context.cycleStartFrame=p.timeline.cycle->at(0);context.cycleEndFrame=p.timeline.cycle->at(1);}
      e.block={&p,&context,input,e.position,count,cursor,channels,e.playing&&e.position<p.timeline.lengthFrames};
      // Tracks render independently (in parallel when there is a pool and at
      // least two tracks to render here), then mix in track order, so the sum
      // is bit-identical to the single-threaded path.
      std::uint32_t callbackTracks=0;
      if(e.forkEnabled)for(const auto&t:p.tracks)if(t.timeline.enabled&&(!t.ahead||t.ahead->mode.load(std::memory_order_relaxed)==AheadState::Off))++callbackTracks;
      const auto trackCount=static_cast<std::uint32_t>(p.tracks.size());
      if(e.pool&&e.forkEnabled&&callbackTracks>=2)e.pool->run(trackCount,&Impl::trackTask,&e);
      else for(std::uint32_t index=0;index<trackCount;++index)e.renderTrack(index,0);
      for(auto&t:p.tracks) {
        for(std::size_t sample=0;sample<static_cast<std::size_t>(count)*2;++sample)out[sample]+=t.mix[sample];
        e.voiceOverflows+=t.taskOverflows;e.invalidSamples+=t.taskInvalid;e.aheadResyncs+=t.taskResyncs;t.taskResyncs=0;
      }
      const float smoothing=static_cast<float>(1-std::exp(-1/(e.rate*.012)));
      for(std::uint32_t i=0;i<count;++i){e.masterGain+=(e.targetMasterGain-e.masterGain)*smoothing;out[2*i]*=e.masterGain;out[2*i+1]*=e.masterGain;}
      p.master.process(out,count);
    }
    for(std::size_t i=0;i<static_cast<std::size_t>(count)*2;++i){if(!std::isfinite(out[i])){out[i]=0;++e.invalidSamples;}masterPeak=std::max(masterPeak,std::abs(out[i]));}
    if(e.playing) e.position+=count;
    e.continuousFrame+=count;
    cursor+=count;
  }
  if(e.active&&e.playing&&!e.offline) {
    const auto&p=e.active->impl_->timeline;
    if(p.cycle&&e.position>=p.cycle->at(1)){e.position=p.cycle->at(0);e.reset(true,false);}
    else if(!p.cycle&&e.position>=p.lengthFrames){e.reclaimAll(false);e.playing=false;for(auto&track:e.active->impl_->tracks)if(track.instrument&&!track.wavetable)track.instrument->requestReset();}
  }
  e.promote();
  e.publish(masterPeak);
}

EngineSnapshot RenderEngine::snapshot()const noexcept {
  const auto&e=*impl_;const auto&p=e.published;EngineSnapshot s;
  s.lastAppliedCommand=p.ticket.load(std::memory_order_acquire);s.revision=p.revision.load(std::memory_order_relaxed);s.frame=p.frame.load(std::memory_order_relaxed);s.sampleRate=e.rate;
  s.trackCount=p.trackCount.load(std::memory_order_relaxed);s.latencyFrames=p.latency.load(std::memory_order_relaxed);s.ready=p.ready.load(std::memory_order_relaxed);s.playing=p.playing.load(std::memory_order_relaxed);
  s.masterPeak=p.masterPeak.load(std::memory_order_relaxed);for(std::uint32_t i=0;i<std::min(256u,s.trackCount);++i)s.trackPeaks[i]=p.trackPeaks[i].load(std::memory_order_relaxed);
  s.commandOverflows=e.commandOverflows.load(std::memory_order_relaxed);s.voiceOverflows=p.voiceOverflows.load(std::memory_order_relaxed);s.invalidSamples=p.invalidSamples.load(std::memory_order_relaxed);
  s.recording=p.recording.load(std::memory_order_relaxed);s.recordingStartFrame=p.recordingStart.load(std::memory_order_relaxed);s.recordedFrames=p.recorded.load(std::memory_order_relaxed);s.recordingDroppedFrames=p.dropped.load(std::memory_order_relaxed);
  s.workerThreads=e.workerCount;s.renderAheadTracks=p.aheadTracks.load(std::memory_order_relaxed);s.renderAheadResyncs=p.aheadResyncs.load(std::memory_order_relaxed);return s;
}
std::uint32_t RenderEngine::drainRecording(float* destination,std::uint32_t capacity)noexcept {
  if(!destination||!capacity||!impl_->ownedCapture)return 0;
  auto&cap=*impl_->ownedCapture;const auto read=cap.read.load(std::memory_order_relaxed),write=cap.write.load(std::memory_order_acquire);
  const auto count=static_cast<std::uint32_t>(std::min<std::uint64_t>(write-read,capacity));
  for(std::uint32_t i=0;i<count;++i)std::copy_n(cap.ring.data()+static_cast<std::size_t>((read+i)%cap.capacity)*cap.channels,cap.channels,destination+static_cast<std::size_t>(i)*cap.channels);
  cap.read.store(read+count,std::memory_order_release);return count;
}

} // namespace garak

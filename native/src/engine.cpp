#include "garak/engine.hpp"
#include "garak/dsp.hpp"
#include "wavetable.hpp"
#include "rust_instrument.hpp"
#include "metronome.hpp"
#if GARAK_RUST
#include "garak_engine.h"
#include "garak_engine_instruments.h"
#endif

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <set>
#include <stdexcept>
#include <string_view>
#include <thread>
#include <tuple>
#include <type_traits>
#include <unordered_map>
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

// Owning list of heap objects with reference iteration. Tracks live behind stable pointers so the callback
// can swap one track of the running graph (RenderEngine::update) without moving a TrackRuntime: on MSVC a
// moved std::map allocates its sentinel, so moving a track in the callback would allocate.
template<class T> class PtrList {
  using Items = std::vector<std::unique_ptr<T>>;
 public:
  template<class Base, class V> class Iter {
   public:
    explicit Iter(Base it) noexcept : it_(it) {}
    V& operator*() const noexcept { return **it_; }
    V* operator->() const noexcept { return it_->get(); }
    Iter& operator++() noexcept { ++it_; return *this; }
    bool operator==(const Iter& other) const noexcept { return it_ == other.it_; }
    bool operator!=(const Iter& other) const noexcept { return it_ != other.it_; }
   private:
    Base it_;
  };
  using iterator = Iter<typename Items::iterator, T>;
  using const_iterator = Iter<typename Items::const_iterator, const T>;
  iterator begin() noexcept { return iterator(items_.begin()); }
  iterator end() noexcept { return iterator(items_.end()); }
  const_iterator begin() const noexcept { return const_iterator(items_.begin()); }
  const_iterator end() const noexcept { return const_iterator(items_.end()); }
  T& operator[](std::size_t i) noexcept { return *items_[i]; }
  const T& operator[](std::size_t i) const noexcept { return *items_[i]; }
  [[nodiscard]] std::size_t size() const noexcept { return items_.size(); }
  [[nodiscard]] bool empty() const noexcept { return items_.empty(); }
  void reserve(std::size_t n) { items_.reserve(n); }
  void push_back(T&& value) { items_.push_back(std::make_unique<T>(std::move(value))); }
  std::unique_ptr<T>& slot(std::size_t i) noexcept { return items_[i]; }
 private:
  Items items_;
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
  AheadState(std::uint32_t frames,std::uint32_t maxBlock):capacity(frames),ring(static_cast<std::size_t>(frames)*2),out(static_cast<std::size_t>(maxBlock)*4){}
  const std::uint32_t capacity;
  std::vector<float> ring,out; // `out`: the callback's copy for this block's mix, then the producer's block.
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
  double sub = .65, bell = .2, detune = 7, sweep = .25, bark = .5, tune = 0, punch = 1, releaseNoise = .5;
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
      permitted.insert({"attack","release","releaseNoise"}); result.attack=parameter(p,"attack",.001,.001,2); result.release=parameter(p,"release",.25,.02,5);
      result.releaseNoise=parameter(p,"releaseNoise",.5,0,1);
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
  bool active=false,sampled=false,releaseSample=false,releaseSpawned=false,live=false,forcedRelease=false,cut=false;
  bool sustained=false; // Live note released while the live sustain pedal is down: rings until the pedal lifts.
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
} // namespace

double automationShape(double t,double curve)noexcept{
  const double x=std::clamp(t,0.0,1.0);
  if(!(std::abs(curve)>1e-6))return x;
  const double k=std::clamp(curve,-1.0,1.0)*6;
  return (std::exp(k*x)-1)/(std::exp(k)-1);
}
double evaluateAutomation(const AutomationLane& lane,double frame,std::size_t& hint)noexcept{
  const auto& p=lane.points;
  if(p.empty())return 0;
  if(frame<p.front().frame){hint=0;return p.front().value;}
  // The last point at or before `frame`: walk from the hint (monotonic playback), else binary search.
  std::size_t i=hint<p.size()?hint:0;
  if(p[i].frame>frame||(i+1<p.size()&&p[i+1].frame<=frame&&(i+2>=p.size()||p[i+2].frame<=frame))){
    i=static_cast<std::size_t>(std::upper_bound(p.begin(),p.end(),frame,[](double f,const AutomationPoint& a){return f<a.frame;})-p.begin())-1;
  } else while(i+1<p.size()&&p[i+1].frame<=frame)++i;
  hint=i;
  const auto& a=p[i];
  if(i+1==p.size()||!lane.options.empty())return a.value;
  const auto& b=p[i+1];
  const double span=b.frame-a.frame;
  if(!(span>1e-9))return b.value;
  return a.value+(b.value-a.value)*automationShape((frame-a.frame)/span,a.curve);
}
double automationValue(const AutomationLane& lane,double normalized)noexcept{
  const double n=std::clamp(normalized,0.0,1.0);
  if(!lane.options.empty())return lane.options[static_cast<std::size_t>(std::lround(n*static_cast<double>(lane.options.size()-1)))];
  return lane.logarithmic?lane.minimum*std::pow(lane.maximum/lane.minimum,n):lane.minimum+n*(lane.maximum-lane.minimum);
}

namespace {
// Same-sample order: reset, then controllers (a pedal-down catches a note-off at that sample; a pedal-up at
// the sample does not extend it, docs/SUSTAIN_PEDAL.md), then note-offs, then note-ons and parameters.
constexpr int eventOrder(PluginEvent::Type type)noexcept{
  return type==PluginEvent::Type::AllNotesOff?0:type==PluginEvent::Type::Controller?1:type==PluginEvent::Type::NoteOff?2:3;
}
// One prepared automation lane: what it drives in this graph (resolved once, never by name in the callback).
struct LaneRuntime {
  std::uint16_t lane=0;           // Index in TrackTimeline::automation.
  AutomationLane::Target target=AutomationLane::Target::Volume;
  std::int32_t insert=-1;          // Index in TrackRuntime::inserts.
  std::int32_t control=-1;         // EffectControl parameter index (built-in insert).
  std::uint32_t pluginParam=0;     // VST3 ParamID (VST3 insert or instrument).
  bool plugin=false;
  double Synth::* synthField=nullptr; // Built-in instrument parameter (member, so moving the track is safe).
  std::int32_t rustParam=-1;        // Rust instrument parameter index (옥구슬 EP, 한밤 106).
  std::size_t hint=0;
  float lastSent=-1;               // Last VST3 value queued (avoids repeating flat values).
};
constexpr std::uint32_t automationChunk=32;   // Built-in effect parameters update every 32 frames (then glide).
constexpr std::size_t maxInsertEvents=512;

struct InsertRuntime {
  InsertRuntime() = default;
  InsertRuntime(const InsertRuntime&) = delete;
  InsertRuntime& operator=(const InsertRuntime&) = delete;
  InsertRuntime(InsertRuntime&&) noexcept = default;
  InsertRuntime& operator=(InsertRuntime&&) noexcept = default;

  std::unique_ptr<dsp::StereoProcessor> builtin;
  std::shared_ptr<PluginProcessor> plugin;
  // Live parameter control of a built-in insert: every built-in insert has one, so a parameter diff
  // (RenderEngine::update) applies in place. `automated`: an automation lane drives it (chunked render).
  std::unique_ptr<dsp::EffectControl> control;
  bool automated=false;
  std::uint16_t source=0; // Index in TrackTimeline::inserts (disabled inserts are skipped here).
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
  // 옥구슬 EP / 한밤 106 (rust_instrument.hpp): the same object as `instrument`, a built-in plug-in like IEUM WAVE.
  std::shared_ptr<PluginProcessor> rust;
  std::vector<TimedPluginEvent> events;
  std::array<PluginEvent,maxPluginEvents> blockEvents{};
  std::array<PluginEvent,maxVoices> pendingEvents{};
  std::size_t pendingCount=0;
  bool releaseAudition=false;
  struct LivePluginNote { bool active=false;std::int32_t id=-1;std::uint8_t pitch=60;std::int64_t remaining=0; };
  std::array<LivePluginNote,maxVoices> pluginNotes{};
  // Live sustain pedal (CC64 from controlChange). VST3 instruments get the controller itself; built-in
  // voices and IEUM WAVE notes have their live note-offs deferred here until the pedal lifts.
  bool livePedal=false;
  struct DeferredOff { std::int32_t id=-1; std::uint8_t pitch=60; };
  std::array<DeferredOff,maxVoices> deferredOffs{};
  std::size_t deferredCount=0;
  [[nodiscard]] bool vst3()const noexcept{return instrument&&!wavetable&&!rust;}
  // Built-in voices' MIDI controller state (docs/MIDI_CONTROLLERS.md): the latest values from the timeline
  // or live input, and the smoothed pitch offset, vibrato depth (cents) and level they lead to.
  struct Controllers { int bend=0,range=2,mod=0,pressure=0,volume=100,expression=127; };
  Controllers controllers;
  double bendCents=0,vibratoCents=0,controlGain=1,vibratoPhase=0;
  void applyController(int controller,int value)noexcept {
    switch(controller){
      case pitchBendController:controllers.bend=value;break;
      case bendRangeController:controllers.range=value;break;
      case modWheelController:controllers.mod=value;break;
      case channelPressureController:controllers.pressure=value;break;
      case volumeController:controllers.volume=value;break;
      case expressionController:controllers.expression=value;break;
      default:break; // CC64 is applied to note-offs; program change and other controllers have no built-in meaning.
    }
  }
  [[nodiscard]] double bendTarget()const noexcept{return (controllers.bend>0?controllers.bend/8191.0:controllers.bend/8192.0)*controllers.range*100;}
  [[nodiscard]] double vibratoTarget()const noexcept{return std::max(controllers.mod,controllers.pressure)/127.0*vibratoDepthCents;}
  [[nodiscard]] double gainTarget()const noexcept{const double v=controllers.volume/100.0,e=controllers.expression/127.0;return v*v*e*e;}
  void snapControllers()noexcept{bendCents=bendTarget();vibratoCents=vibratoTarget();controlGain=gainTarget();}
  static constexpr double vibratoDepthCents=50,vibratoRate=5.5,controllerSmoothingSeconds=.005;
  std::size_t nextNote=0,nextEvent=0,nextControl=0;
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
  // Track-input routing (docs/TRACK_INPUT_ROUTING.md), resolved in prepare(). Tap buffers exist only on
  // tracks another track listens to; `routeInput` only on routed tracks. All sized maxBlock*2 up front.
  TrackRoute::Kind routeKind=TrackRoute::Kind::None;
  TrackRoute::Tap routeTap=TrackRoute::Tap::PostFx;
  std::int32_t routeSource=-1;   // Graph index of the source track (Kind::Track).
  bool routed=false;             // Has an internal input (any kind, including None = silence).
  bool inMasterFeed=true;        // Heard by master-resampling tracks (false for them and downstream).
  std::uint32_t routeLevel=0;    // Processing level: sources render in an earlier level.
  std::vector<float> preTap,postTap,routeInput;
  // Send/return (docs/SENDS_RETURNS.md), resolved in prepare(). Non-return tracks delay their output by the
  // largest fed return's plug-in latency (`outputDelay`) after every tap, so sends reach the returns at the
  // sender alignment and the returns' outputs line up with the dry tracks at the master. `faderTap` holds
  // the post-fader signal before that delay (post-fader sends, post-fader routes while the delay is used).
  bool isReturn=false;
  std::uint32_t outputDelayFrames=0;
  CompensationDelay outputDelay;
  std::vector<float> faderTap;
  // Returns only: one entry per send that feeds this return, with its own gain smoothing (owned by the
  // return's task, so returns of one level render in parallel without sharing state).
  // `lane`: the sender's Send automation lane for this return (index in its timeline.automation), or -1.
  struct Feed { std::int32_t sender=-1; bool pre=false; float target=0; double gain=0; std::int32_t lane=-1; std::size_t hint=0; };
  std::vector<Feed> feeds;
  std::vector<float> returnInput;
  // Automation (docs/AUTOMATION.md), resolved in prepare(). Volume/pan/mute are evaluated per sample.
  std::vector<LaneRuntime> lanes;
  std::int32_t volumeLane=-1,panLane=-1,muteLane=-1;
  double muteGain=1;
  std::array<PluginEvent,maxInsertEvents> insertEvents{};

  // Value of lane `index` (in its units) at a project frame.
  double laneValue(LaneRuntime& l,double frame)noexcept{const auto& lane=timeline.automation[l.lane];return automationValue(lane,evaluateAutomation(lane,frame,l.hint));}
  // VST3 parameter points for one block: at most 32 per parameter (the host queue holds 64), on a fixed grid.
  template<class Push> void pluginPoints(LaneRuntime& l,std::int64_t frame,std::uint32_t frames,Push&& push)noexcept{
    const std::uint32_t step=std::max<std::uint32_t>(automationChunk*2,(frames+31)/32);
    for(std::uint32_t offset=0;offset<frames;offset+=step){
      const auto value=static_cast<float>(std::clamp(laneValue(l,static_cast<double>(frame+offset)),0.0,1.0));
      if(value==l.lastSent)continue;
      l.lastSent=value;
      PluginEvent e{};e.type=PluginEvent::Type::Parameter;e.offset=offset;e.parameterId=l.pluginParam;e.value=value;
      push(e);
    }
  }

  // How this track continues from its predecessor (the same track id in the running graph), filled on the
  // control thread (RenderEngine::submit/update) and consumed once by adopt() at the swap.
  struct RemovedNote { std::int32_t id=0; std::int64_t onFrame=0,offFrame=0; std::uint8_t pitch=60; };
  std::int32_t predecessor=-1;            // Index in the previous graph, or -1 (a new track).
  bool identical=false;                   // Same events/source/enabled: cursors and a render-ahead ring carry over.
  bool sameSource=false;                  // Same instrument identity: voices, samples and the instrument carry over.
  bool reuseInstrument=false;             // The instrument was not built: take the predecessor's (update()).
  bool aheadEligible=false;               // May take the predecessor's (idle) render-ahead ring (update()).
  std::vector<std::int32_t> insertOrigin; // Per runtime insert: the predecessor's runtime insert (same id/type), or -1.
  std::vector<RemovedNote> removedNotes;  // Predecessor notes absent here: released if sounding.

  // Callback (or a quiesced graph swap): continue playing from `previous`, the same track before an edit.
  // identical: events are unchanged, so cursors (and a moving ring) keep their position exactly like a
  // structure-preserving swap always did. Otherwise `previous` is callback-owned at `frame` (its ring was
  // drained) and cursors are recomputed there: voices, effect tails, controllers and live notes continue;
  // only notes that were removed or edited are released (docs/RENDER_DIFF_PROTOCOL.md).
  // routing: a single-track replacement keeps the graph, so the graph-derived routing/send state moves too.
  void adopt(TrackRuntime& previous,std::int64_t frame,bool sameEvents,bool routing)noexcept {
    meter=previous.meter;liveUntil=previous.liveUntil;peak=previous.peak;
    fader=previous.fader;panValue=previous.panValue;muteGain=previous.muteGain;
    if(sameSource) {
      voices.swap(previous.voices);std::swap(samples,previous.samples);
      livePedal=previous.livePedal;deferredOffs=previous.deferredOffs;deferredCount=previous.deferredCount;
      controllers=previous.controllers;bendCents=previous.bendCents;vibratoCents=previous.vibratoCents;controlGain=previous.controlGain;vibratoPhase=previous.vibratoPhase;
      pendingEvents=previous.pendingEvents;pendingCount=previous.pendingCount;pluginNotes=previous.pluginNotes;
      releaseAudition=previous.releaseAudition;
      if(reuseInstrument){instrument.swap(previous.instrument);wavetable.swap(previous.wavetable);}
      else if(wavetable&&previous.wavetable)wavetable->takeStateFrom(*previous.wavetable);
      else if(rust&&previous.rust)rustTakeState(*rust,*previous.rust); // New parameters, old voices.
      else if(instrument&&previous.instrument&&!wavetable&&!previous.wavetable&&!rust&&!previous.rust)instrument.swap(previous.instrument);
    } else if(instrument&&instrument==previous.instrument)instrument->requestReset();
    for(std::size_t i=0;i<inserts.size()&&i<insertOrigin.size();++i) {
      const auto from=insertOrigin[i];
      if(from<0||static_cast<std::size_t>(from)>=previous.inserts.size())continue;
      auto&old=previous.inserts[static_cast<std::size_t>(from)];
      if(inserts[i].builtin&&old.builtin)inserts[i].builtin->takeStateFrom(*old.builtin);
      else if(inserts[i].plugin&&old.plugin)inserts[i].plugin.swap(old.plugin);
    }
    compensation.takeStateFrom(previous.compensation);
    outputDelay.takeStateFrom(previous.outputDelay);
    if(routing) {
      isReturn=previous.isReturn;routed=previous.routed;routeKind=previous.routeKind;routeTap=previous.routeTap;routeSource=previous.routeSource;
      inMasterFeed=previous.inMasterFeed;routeLevel=previous.routeLevel;outputDelayFrames=previous.outputDelayFrames;
      preTap.swap(previous.preTap);postTap.swap(previous.postTap);faderTap.swap(previous.faderTap);
      routeInput.swap(previous.routeInput);returnInput.swap(previous.returnInput);feeds.swap(previous.feeds);
    } else for(auto&f:feeds)for(const auto&o:previous.feeds)if(o.sender==f.sender&&o.pre==f.pre){f.gain=o.gain;break;}
    if(sameEvents) {
      // The ring and its producer position belong with the voice/effect state.
      if(ahead&&previous.ahead&&ahead->capacity==previous.ahead->capacity)ahead.swap(previous.ahead);
      nextNote=previous.nextNote;nextEvent=previous.nextEvent;nextControl=previous.nextControl;
      return;
    }
    if(routing&&aheadEligible&&!ahead)ahead.swap(previous.ahead);
    nextNote=static_cast<std::size_t>(std::lower_bound(timeline.notes.begin(),timeline.notes.end(),frame,[](const NotePair& n,std::int64_t f){return n.onFrame<f;})-timeline.notes.begin());
    nextEvent=static_cast<std::size_t>(std::lower_bound(events.begin(),events.end(),frame,[](const TimedPluginEvent&e,std::int64_t f){return e.frame<f;})-events.begin());
    nextControl=static_cast<std::size_t>(std::lower_bound(timeline.controls.begin(),timeline.controls.end(),frame,[](const ControlEvent& c,std::int64_t f){return c.frame<f;})-timeline.controls.begin());
    for(const auto&r:removedNotes) {
      if(instrument) {
        if(r.onFrame<frame&&r.offFrame>frame&&pendingCount<pendingEvents.size())pendingEvents[pendingCount++]={PluginEvent::Type::NoteOff,0,r.id,r.pitch,0,0,0,false};
      } else for(auto&v:voices)if(v.active&&!v.live&&v.id==r.id)releaseLive(v);
    }
  }

  Voice& availableVoice(std::uint64_t& overflows)noexcept {
    for(auto& v:voices)if(!v.active)return v;
    ++overflows;
    return *std::max_element(voices.begin(),voices.end(),[](const Voice&a,const Voice&b){return a.age<b.age;});
  }
  void spawn(int pitch,float velocity,std::int64_t duration,std::int64_t available,std::int32_t id,bool live,std::uint64_t& overflows)noexcept {
    if(velocity<=0||duration<=0||available<=0||!timeline.enabled||timeline.source.kind==TrackSource::Kind::Audio)return;
    // Re-striking a key that only rings because of the pedal ends that sustained note first.
    if(live&&!timeline.source.isKit)retriggerSustained(pitch,overflows);
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
        // A timeline note that reaches its clip end, the loop boundary or the project end is cut off, not released.
        voice.cut=!live&&duration>=available;
        if(!samples.releases.empty()&&synth.releaseNoise>0&&!voice.cut)voice.releaseZone=pickZone(samples.releases,false,pitch,std::clamp(velocity,0.f,1.f));
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
    const double noise=dsp::releaseNoiseGain(source.velocity,static_cast<double>(source.noteFrames)/sampleRate,source.naturalFrames/sampleRate,source.synth.releaseNoise,source.cut);
    if(noise<=0)return;
    auto* zone=source.releaseZone;const int pitch=source.pitch;const auto voiceSynth=source.synth;
    auto& v=availableVoice(overflows);v=Voice{};v.synth=voiceSynth;v.active=true;v.sampled=true;v.releaseSample=true;v.zone=zone;v.pitch=pitch;
    v.samplePosition=samples.startOffset*zone->asset->sampleRate;
    v.sampleStep=std::pow(2,(pitch-zone->zone.root)/12.0+zone->zone.tune/1200)*zone->asset->sampleRate/sampleRate;
    v.peak=dsp::dbToGain(samples.gainDb+zone->zone.gainDb-6)*noise*voiceSynth.level;
    v.endFrames=static_cast<std::int64_t>(std::max(0.0,(zone->asset->frames()-v.samplePosition)/v.sampleStep));
  }
  void retriggerSustained(int pitch,std::uint64_t& overflows)noexcept {
    if(wavetable||rust){
      for(std::size_t i=0;i<deferredCount;){
        if(deferredOffs[i].pitch==pitch){const auto off=deferredOffs[i];deferredOffs[i]=deferredOffs[--deferredCount];noteOff(off.pitch,off.id,overflows,true);}
        else ++i;
      }
    }
    for(auto& v:voices)if(v.active&&v.live&&v.sustained&&v.pitch==pitch){v.sustained=false;releaseLive(v);}
  }
  void releaseLive(Voice& v)noexcept {
    if(!timeline.source.isKit&&!v.forcedRelease){v.releaseGain=envelope(v);v.forcedRelease=true;}
    v.noteFrames=std::min(v.noteFrames,v.age);
    if(v.sampled&&v.age>=v.naturalFrames)v.releaseZone=nullptr;
    if (!timeline.source.isKit) v.endFrames=std::min(v.endFrames,v.age+static_cast<std::int64_t>((v.synth.release*1.5+.02)*sampleRate));
  }
  // Live MIDI controller (docs/MIDI_CONTROLLERS.md). VST3 instruments receive every controller and IEUM WAVE
  // every one but the pedal; built-in voices follow bend/mod/pressure/CC7/CC11. CC64 defers live note-offs.
  void controlChange(int controller,int value,std::uint64_t& overflows)noexcept {
    if(instrument&&(vst3()||controller!=sustainController)){
      if(controller==bendRangeController&&!rust)return; // Meta controller of the built-in sources only.
      if(pendingCount<pendingEvents.size()){PluginEvent e{};e.type=PluginEvent::Type::Controller;e.parameterId=static_cast<std::uint32_t>(controller);e.value=normalizedControllerValue(controller,value);e.audition=true;pendingEvents[pendingCount++]=e;}
      else ++overflows;
      if(controller==sustainController)livePedal=pedalDown(value);
      return;
    }
    if(controller!=sustainController){applyController(controller,value);return;}
    const bool down=pedalDown(value);
    if(down==livePedal)return;
    livePedal=down;
    if(!down)releaseSustained(overflows);
  }
  void releaseSustained(std::uint64_t& overflows)noexcept {
    const auto count=deferredCount;deferredCount=0;
    for(std::size_t i=0;i<count;++i)noteOff(deferredOffs[i].pitch,deferredOffs[i].id,overflows,true);
    for(auto& v:voices)if(v.active&&v.live&&v.sustained){v.sustained=false;releaseLive(v);}
  }
  void noteOff(int pitch,std::int32_t id,std::uint64_t& overflows,bool force=false)noexcept {
    if(livePedal&&!force&&!vst3()&&!timeline.source.isKit) {
      if(wavetable||rust){
        if(deferredCount<deferredOffs.size())deferredOffs[deferredCount++]={id,static_cast<std::uint8_t>(pitch)};
        else noteOff(pitch,id,overflows,true);
        return;
      }
      for(auto& v:voices)if(v.active&&v.live&&(id>=0?v.id==id:v.pitch==pitch))v.sustained=true;
      return;
    }
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
    for(auto& v:voices)if(v.active&&v.live&&(id>=0?v.id==id:v.pitch==pitch)){v.sustained=false;releaseLive(v);}
  }
  void allNotesOff(std::uint64_t& overflows)noexcept {
    // A panic also lifts the (live) pedal: nothing may keep ringing afterwards.
    livePedal=false;deferredCount=0;
    for(auto&v:voices)v.sustained=false;
    if(vst3())controlChange(sustainController,0,overflows);
    if(wavetable) {
      // Reserve no per-note queue slots: channel one belongs only to audition.
      // Cancel its queued on/off events before emitting a single release event.
      auto end=std::remove_if(pendingEvents.begin(),pendingEvents.begin()+static_cast<std::ptrdiff_t>(pendingCount),
        [](const PluginEvent&e){return e.audition;});
      pendingCount=static_cast<std::size_t>(end-pendingEvents.begin());
      for(auto&n:pluginNotes)n.active=false;
      releaseAudition=true;
    } else if(instrument) {
      for(auto&n:pluginNotes)if(n.active)noteOff(n.pitch,n.id,overflows,true);
    } else {
      for(auto&v:voices)if(v.active&&v.live)noteOff(v.pitch,v.id,overflows,true);
    }
    // ...and returns the bend and the modulation to rest.
    if(instrument){controlChange(pitchBendController,0,overflows);controlChange(modWheelController,0,overflows);}
    else{controllers.bend=0;controllers.mod=0;controllers.pressure=0;}
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
    const double smoothing=1-std::exp(-1/(sampleRate*controllerSmoothingSeconds));
    const double bendGoal=bendTarget(),vibratoGoal=vibratoTarget(),gainGoal=gainTarget();
    const bool pitched=!timeline.source.isKit;
    const auto glide=[smoothing](double& value,double goal,double snap){value+=(goal-value)*smoothing;if(std::abs(goal-value)<snap)value=goal;};
    for(std::uint32_t i=0;i<frames;++i) {
      glide(bendCents,bendGoal,1e-4);glide(vibratoCents,vibratoGoal,1e-4);glide(controlGain,gainGoal,1e-7);
      double cents=bendCents;
      if(vibratoCents>0)cents+=vibratoCents*std::sin(2*dsp::pi*vibratoPhase);
      vibratoPhase+=vibratoRate/sampleRate;if(vibratoPhase>=1)vibratoPhase-=1;
      // Pitch bend and vibrato scale every pitched voice's frequency (samples: playback rate). Kits ignore them.
      const double ratio=pitched&&cents!=0?std::exp2(cents/1200):1;
      const double level=controlGain;
      for(auto& v:voices) if(v.active&&v.releaseZone&&!v.releaseSpawned&&v.age>=v.noteFrames) spawnRelease(v,overflows);
      for(auto& v:voices) {
      if(!v.active)continue;
      if(v.age>=v.endFrames){v.active=false;continue;}
      const auto&synth=v.synth;
      const double frequency=v.frequency*ratio;
      double l=0,r=0;
      if(v.sampled) {
        const auto& a=*v.zone->asset;
        if(v.zone->zone.loop&&!samples.isKit&&!v.releaseSample) {
          const double start=(v.zone->zone.loop->at(0)+samples.startOffset)*a.sampleRate,end=(v.zone->zone.loop->at(1)+samples.startOffset)*a.sampleRate;
          if(v.samplePosition>=end)v.samplePosition=start+std::fmod(v.samplePosition-start,end-start);
        }
        if(v.samplePosition>=a.frames()){v.active=false;continue;}
        l=pcmSample(a,v.samplePosition,0);r=pcmSample(a,v.samplePosition,1);v.samplePosition+=v.sampleStep*ratio;
        if(!v.releaseSample){l=v.tone.sample(static_cast<float>(l),0);r=v.tone.sample(static_cast<float>(r),1);}
      } else {
        const double t=static_cast<double>(v.age)/sampleRate;
        if(synth.kind==Synth::Kind::Drums) {
          if(v.drumSweep>0){const double freq=v.drumStart*std::pow(v.drumEnd/v.drumStart,std::min(1.0,t/v.drumSweep));l=oscillator(v.phases[0],freq,sampleRate);}
          else {v.noise=v.noise*1664525u+1013904223u;l=v.noiseFilter.sample(static_cast<float>(static_cast<double>(v.noise)/4294967295.0*2-1));
            if(v.pitch==38||v.pitch==40||v.pitch==39)l+=.25*oscillator(v.phases[0],frequency,sampleRate,2);}
        } else if(synth.kind==Synth::Kind::Bass)l=.45*oscillator(v.phases[0],frequency,sampleRate,1)+synth.sub*oscillator(v.phases[1],frequency,sampleRate);
        else if(synth.kind==Synth::Kind::Pad)l=.27*oscillator(v.phases[0],frequency*std::pow(2,-synth.detune/1200),sampleRate,1)+.27*oscillator(v.phases[1],frequency*std::pow(2,synth.detune/1200),sampleRate,1)+.2*oscillator(v.phases[2],frequency*2,sampleRate,2);
        else if(synth.kind==Synth::Kind::Pluck){
          const double sweep=std::max(.03,std::min(static_cast<double>(v.noteFrames)/sampleRate,synth.sweep));
          if((v.age&15)==0)v.tone.configure(dsp::Filter::Lowpass,sampleRate,4800*std::pow(900.0/4800,std::min(1.0,t/sweep))*std::pow(2,synth.tone*2),.7);
          l=.85*oscillator(v.phases[0],frequency,sampleRate,2)+.2*oscillator(v.phases[1],frequency*2,sampleRate);
        } else if(synth.kind==Synth::Kind::Rhodes) {
          const double hit=std::min(1.f,v.velocity),index=(.3+2.4*synth.bark)*(.35+.65*hit)*std::pow(2,synth.tone*1.2);
          const double depth=frequency*index*(t<.012?1:.1+.9*std::exp(-(t-.012)/.13));
          const double mod=oscillator(v.phases[1],frequency,sampleRate)*depth;
          // Frequency modulation can cross zero; reversing phase is part of the
          // tine's original 1:1 FM sound, not a frequency clamp at zero.
          l=.75*std::sin(2*dsp::pi*v.phases[0]);
          v.phases[0]+=std::clamp((frequency+mod)/sampleRate,-.45,.45);
          v.phases[0]-=std::floor(v.phases[0]);
          l+=.12*hit*(.3+synth.bark)*(t<.006?1:std::exp(-(t-.006)/.03))*oscillator(v.phases[2],frequency*7,sampleRate);
          l=std::tanh(1.2*l+.25*l*l)/std::tanh(1.45);
        } else l=.8*oscillator(v.phases[0],frequency,sampleRate)+synth.bell*oscillator(v.phases[1],frequency*2,sampleRate,2)+synth.bell*.4*oscillator(v.phases[2],frequency*3,sampleRate);
        if(synth.kind!=Synth::Kind::Drums) l=v.tone.sample(static_cast<float>(l));
        r=l;
      }
      double gain=envelope(v);
      if(v.choking){v.chokeGain*=std::exp(-1/(.003*sampleRate));gain*=v.chokeGain;if(v.chokeGain<.006)v.active=false;}
      if(level!=1)gain*=level;
      out[2*i]+=static_cast<float>(l*gain);out[2*i+1]+=static_cast<float>(r*gain);++v.age;
      }
    }
  }
  void reset(std::int64_t frame,bool chase,bool resetEffects,std::uint64_t& overflows)noexcept {
    for(auto& v:voices) v.active=false;
    for(auto& n:pluginNotes) n.active=false;
    pendingCount=0;deferredCount=0;
    releaseAudition=false;
    if(instrument)instrument->requestReset();
    // Timeline controllers (docs/MIDI_CONTROLLERS.md): chase the values in effect at the new position, or
    // return the resetting ones (mod wheel, expression, pedal, pressure, bend) to rest when stopping.
    nextControl=static_cast<std::size_t>(std::lower_bound(timeline.controls.begin(),timeline.controls.end(),frame,[](const ControlEvent& c,std::int64_t f){return c.frame<f;})-timeline.controls.begin());
    if(instrument&&!timeline.controls.empty()){
      std::array<std::int32_t,controllerCount> values{};std::array<bool,controllerCount> present{},known{};
      for(const auto&c:timeline.controls){present[c.controller]=true;if(chase&&c.frame<frame){values[c.controller]=c.value;known[c.controller]=true;}}
      for(int controller=0;controller<controllerCount;++controller){
        const auto index=static_cast<std::size_t>(controller);
        if(!present[index]||(controller==bendRangeController&&!rust))continue;
        int value=0;
        if(chase&&timeline.enabled&&known[index])value=values[index];
        else if(!resetController(controller,value))continue;
        if(pendingCount>=pendingEvents.size()){++overflows;break;}
        PluginEvent e{};e.type=PluginEvent::Type::Controller;e.parameterId=static_cast<std::uint32_t>(controller);e.value=normalizedControllerValue(controller,value);
        pendingEvents[pendingCount++]=e;
      }
    } else if(!instrument) {
      controllers=Controllers{};
      if(chase&&timeline.enabled)for(std::size_t i=0;i<nextControl;++i)applyController(timeline.controls[i].controller,timeline.controls[i].value);
      snapControllers();
    }
    if(resetEffects){for(auto& effect:inserts){if(effect.builtin)effect.builtin->reset();if(effect.plugin)effect.plugin->requestReset();}compensation.reset();}
    nextNote=static_cast<std::size_t>(std::lower_bound(timeline.notes.begin(),timeline.notes.end(),frame,[](const NotePair& n,std::int64_t f){return n.onFrame<f;})-timeline.notes.begin());
    nextEvent=static_cast<std::size_t>(std::lower_bound(events.begin(),events.end(),frame,[](const TimedPluginEvent&e,std::int64_t f){return e.frame<f;})-events.begin());
    if(chase&&!timeline.source.isKit&&timeline.enabled)for(std::size_t i=0;i<nextNote;++i){const auto& n=timeline.notes[i];if(n.offFrame>frame)spawn(n.pitch,n.velocity,n.offFrame-frame,n.limitFrame-frame,n.id,false,overflows);}
  }
  // The instrument part of a block (built-in voices, IEUM WAVE, VST3 or a Rust instrument with its events),
  // added into `out`. Also the GARAK_RUST_ENGINE host source node (rust_engine.inc): the Rust graph calls it for
  // VST3 / IEUM WAVE tracks, so their events, chase and live notes stay exactly this code.
  void renderSource(float* out,std::int64_t frame,std::uint32_t frames,bool playing,const ProcessContext& context,std::uint64_t& overflows)noexcept {
    for(auto& l:lanes)if(l.synthField)synth.*l.synthField=laneValue(l,static_cast<double>(frame));
    if(rust)for(auto& l:lanes)if(l.rustParam>=0)rustSetParameter(*rust,l.rustParam,laneValue(l,static_cast<double>(frame)));
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
      if(playing||((wavetable||rust)&&frame>=projectLength))while(nextEvent<events.size()&&events[nextEvent].frame<frame+frames){const auto& e=events[nextEvent++];if(e.frame>=frame){if(eventCount<blockEvents.size()){blockEvents[eventCount]=e.event;blockEvents[eventCount++].offset=static_cast<std::uint32_t>(e.frame-frame);}else ++overflows;}}
      if(vst3())for(auto& l:lanes)if(l.plugin&&l.insert<0)pluginPoints(l,frame,frames,[&](const PluginEvent& e){if(eventCount<blockEvents.size())blockEvents[eventCount++]=e;else ++overflows;});
      for(auto& n:pluginNotes)if(n.active){if(n.remaining<frames){if(eventCount<blockEvents.size())blockEvents[eventCount++]={PluginEvent::Type::NoteOff,static_cast<std::uint32_t>(std::max<std::int64_t>(0,n.remaining)),n.id,n.pitch,0,0,0,true};else ++overflows;n.active=false;}else n.remaining-=frames;}
      std::sort(blockEvents.begin(),blockEvents.begin()+static_cast<std::ptrdiff_t>(eventCount),[](const PluginEvent&a,const PluginEvent&b){
        return a.offset<b.offset||(a.offset==b.offset&&eventOrder(a.type)<eventOrder(b.type));});
      instrument->process(out,frames,std::span(blockEvents).first(eventCount),context);
    } else {
      std::uint32_t cursor=0;
      const auto blockEnd=frame+frames;
      // Controllers and note onsets in time order; a controller at an onset's sample applies first.
      if(playing)for(;;) {
        const bool note=nextNote<timeline.notes.size()&&timeline.notes[nextNote].onFrame<blockEnd;
        const bool control=nextControl<timeline.controls.size()&&timeline.controls[nextControl].frame<blockEnd;
        if(!note&&!control)break;
        if(control&&(!note||timeline.controls[nextControl].frame<=timeline.notes[nextNote].onFrame)) {
          const auto& c=timeline.controls[nextControl++];
          if(c.frame>frame){const auto at=static_cast<std::uint32_t>(c.frame-frame);if(at>cursor){voicesInto(out+cursor*2,at-cursor,overflows);cursor=at;}}
          applyController(c.controller,c.value);
          continue;
        }
        const auto& n=timeline.notes[nextNote++];if(n.onFrame<frame)continue;
        const auto onset=static_cast<std::uint32_t>(n.onFrame-frame);
        voicesInto(out+cursor*2,onset-cursor,overflows);cursor=onset;
        spawn(n.pitch,n.velocity,n.offFrame-n.onFrame,n.limitFrame-n.onFrame,n.id,false,overflows);
      }
      voicesInto(out+cursor*2,frames-cursor,overflows);
    }
  }
  // Runtime insert `index` when it is a VST3 plug-in: sample-offset automation points through IParameterChanges.
  // Also the GARAK_RUST_ENGINE host insert node.
  void processPlugin(std::size_t index,float* buf,std::int64_t frame,std::uint32_t frames,const ProcessContext& context,std::uint64_t& overflows)noexcept {
    auto& effect=inserts[index];
    if(lanes.empty()){effect.plugin->process(buf,frames,{},context);return;}
    std::size_t count=0;
    for(auto& l:lanes)if(l.plugin&&l.insert==static_cast<std::int32_t>(index))pluginPoints(l,frame,frames,[&](const PluginEvent& e){if(count<insertEvents.size())insertEvents[count++]=e;else ++overflows;});
    // Stable insertion sort by offset (lanes arrive in order; std::stable_sort may allocate).
    for(std::size_t i=1;i<count;++i){const auto e=insertEvents[i];std::size_t j=i;while(j>0&&insertEvents[j-1].offset>e.offset){insertEvents[j]=insertEvents[j-1];--j;}insertEvents[j]=e;}
    effect.plugin->process(buf,frames,std::span<const PluginEvent>(insertEvents.data(),count),context);
  }
  void render(std::int64_t frame,std::uint32_t frames,bool playing,const float* input,bool monitor,bool stereoInput,
              const ProcessContext& context,std::uint64_t& overflows,std::uint64_t& invalid)noexcept {
    std::fill_n(buffer.data(),static_cast<std::size_t>(frames)*2,0.f);
    if(!timeline.enabled){peak=0;if(!preTap.empty())std::fill_n(preTap.data(),static_cast<std::size_t>(frames)*2,0.f);if(!postTap.empty())std::fill_n(postTap.data(),static_cast<std::size_t>(frames)*2,0.f);if(!faderTap.empty())std::fill_n(faderTap.data(),static_cast<std::size_t>(frames)*2,0.f);return;}
    // Offline engines keep reading frozen windows after the project end: that part is the frozen tail.
    const bool freezeTail=!playing&&context.offline&&frame>=projectLength;
    if(playing||freezeTail)for(const auto& resolved:windows) {
      const auto&w=resolved.window;
      if(w.startFrame>=frame+frames)break;
      if(w.endFrame<=frame||(freezeTail&&!w.freeze))continue;
      const auto start=std::max(frame,w.startFrame),end=std::min<std::int64_t>(frame+frames,w.endFrame);
      const double click=w.freeze?0:std::min(sampleRate*.004,(w.endFrame-w.startFrame)/4.0);
      for(auto absolute=start;absolute<end;++absolute){const auto delta=absolute-w.startFrame;const auto offset=static_cast<std::size_t>(absolute-frame);
        const double envelopePos=w.clipOffsetFrames+delta;
        double gain=w.gain;
        if(w.fadeInFrames>0)gain*=fadeShape(w.fadeInCurve,envelopePos/w.fadeInFrames);
        if(w.fadeOutFrames>0)gain=std::min(gain,w.gain*fadeShape(w.fadeOutCurve,(w.clipLengthFrames-envelopePos)/w.fadeOutFrames));
        if(click>0)gain*=std::min({1.0,delta/click,(w.endFrame-absolute)/click});
        const double position=w.sourceStartFrame+delta*w.sourceSampleRate/sampleRate;
        buffer[2*offset]+=static_cast<float>(pcmSample(*resolved.asset,position,0)*gain);buffer[2*offset+1]+=static_cast<float>(pcmSample(*resolved.asset,position,1)*gain);
      }
    }
    renderSource(buffer.data(),frame,frames,playing,context,overflows);
    if(monitor&&input)for(std::size_t i=0;i<static_cast<std::size_t>(frames)*2;++i)buffer[i]+=input[i];
    if(!preTap.empty())std::copy_n(buffer.data(),static_cast<std::size_t>(frames)*2,preTap.data());
    for(std::size_t index=0;index<inserts.size();++index){
      auto& effect=inserts[index];
      if(effect.plugin){processPlugin(index,buffer.data(),frame,frames,context,overflows);continue;}
      if(lanes.empty()){if(context.tempo)effect.builtin->setTempo(context.bpm);effect.builtin->process(buffer.data(),frames);continue;}
      if(context.tempo)effect.builtin->setTempo(context.bpm);
      if(!effect.automated){effect.builtin->process(buffer.data(),frames);continue;}
      // Built-in insert automation: parameters re-read every chunk; the processor glides to them.
      for(std::uint32_t offset=0;offset<frames;offset+=automationChunk){
        const auto count=std::min(automationChunk,frames-offset);
        for(auto& l:lanes)if(l.insert==static_cast<std::int32_t>(index)&&l.control>=0)effect.control->set(l.control,laneValue(l,static_cast<double>(frame+offset)));
        effect.control->apply(*effect.builtin);
        effect.builtin->process(buffer.data()+static_cast<std::size_t>(offset)*2,count);
      }
    }
    // A reduced-latency monitor deliberately avoids waiting for unrelated tracks. A return's `monitor` is its
    // send input, never a live input: it always stays compensated.
    const bool lowLatencyMonitor=monitor&&!isReturn&&context.playing&&!context.offline&&contextLowLatency;
    if(!lowLatencyMonitor)compensation.process(buffer.data(),frames);
    if(!postTap.empty())std::copy_n(buffer.data(),static_cast<std::size_t>(frames)*2,postTap.data());
    if(timeline.preFader) {
      // Freeze/bounce renders: the compensated post-insert signal, without pan, fader or mute. A mono track
      // (whose pan uses the mono law) leaves the right channel silent: the render is then kept mono.
      if(!(stereoSource||stereoEffects))for(std::uint32_t i=0;i<frames;++i)buffer[2*i+1]=0;
      peak=0;for(std::size_t i=0;i<static_cast<std::size_t>(frames)*2;++i){if(!std::isfinite(buffer[i])){buffer[i]=0;++invalid;}peak=std::max(peak,std::abs(buffer[i]));}
      if(!faderTap.empty())std::copy_n(buffer.data(),static_cast<std::size_t>(frames)*2,faderTap.data());
      if(!lowLatencyMonitor)outputDelay.process(buffer.data(),frames);
      return;
    }
    const double targetPan=timeline.pan,targetGain=timeline.audible?timeline.gain:0;
    const double smoothing=1-std::exp(-1/(sampleRate*.012));
    peak=0;
    const bool automatedFader=volumeLane>=0||panLane>=0||muteLane>=0;
    const double muteSmoothing=1-std::exp(-1/(sampleRate*.003));
    for(std::uint32_t i=0;i<frames;++i) {
      double gain,pan;
      if(!automatedFader){fader+=(targetGain-fader)*smoothing;panValue+=(targetPan-panValue)*smoothing;gain=fader;pan=panValue;}
      else {
        // Lanes are evaluated at every sample; mute ramps over ~3 ms (like a region click guard).
        const double at=static_cast<double>(frame+i);
        const bool heard=muteLane>=0?timeline.unmutedAudible:timeline.audible;
        if(volumeLane>=0)fader=heard?std::clamp(laneValue(lanes[static_cast<std::size_t>(volumeLane)],at),0.0,2.0):0;
        else fader+=((heard?timeline.gain:0)-fader)*smoothing;
        if(panLane>=0)panValue=std::clamp(laneValue(lanes[static_cast<std::size_t>(panLane)],at),-1.0,1.0);
        else panValue+=(targetPan-panValue)*smoothing;
        const double muteTarget=muteLane>=0&&laneValue(lanes[static_cast<std::size_t>(muteLane)],at)>=.5?0:1;
        muteGain+=(muteTarget-muteGain)*muteSmoothing;if(muteTarget==0&&muteGain<1e-4)muteGain=0;
        gain=fader*muteGain;
        pan=panValue;
      }
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
    if(!faderTap.empty())std::copy_n(buffer.data(),static_cast<std::size_t>(frames)*2,faderTap.data());
    if(!lowLatencyMonitor)outputDelay.process(buffer.data(),frames);
  }
  bool contextLowLatency=true;
};
static_assert(!std::is_copy_constructible_v<InsertRuntime> && std::is_nothrow_move_constructible_v<InsertRuntime>);
static_assert(!std::is_copy_constructible_v<TrackRuntime> && std::is_move_constructible_v<TrackRuntime>);

double Synth::* synthField(std::string_view id)noexcept{
  const std::pair<std::string_view,double Synth::*> fields[]{{"level",&Synth::level},{"tone",&Synth::tone},{"attack",&Synth::attack},{"decay",&Synth::decay},
    {"sustain",&Synth::sustain},{"release",&Synth::release},{"sub",&Synth::sub},{"bell",&Synth::bell},{"detune",&Synth::detune},{"sweep",&Synth::sweep},
    {"bark",&Synth::bark},{"tune",&Synth::tune},{"punch",&Synth::punch},{"releaseNoise",&Synth::releaseNoise}};
  for(const auto& [name,field]:fields)if(name==id)return field;
  return nullptr;
}
// Control thread: validate the lanes and bind each to what it drives in this graph. Lanes whose target is
// absent here (a disabled insert, an unknown parameter) are ignored, like the Web Audio engine does.
void prepareAutomation(TrackRuntime& track,const TrackTimeline& t){
  require(t.automation.size()<=256,"Too many automation lanes");
  for(std::size_t index=0;index<t.automation.size();++index){
    const auto& lane=t.automation[index];
    require(lane.points.size()<=20000,"Too many automation points");
    double previous=-1;
    for(const auto& point:lane.points){require(std::isfinite(point.frame)&&point.frame>=0&&point.frame>=previous&&point.value>=0&&point.value<=1&&point.curve>=-1&&point.curve<=1,"Invalid automation point");previous=point.frame;}
    require(std::isfinite(lane.minimum)&&std::isfinite(lane.maximum)&&(!lane.logarithmic||(lane.minimum>0&&lane.maximum>0)),"Invalid automation range");
    if(lane.points.empty())continue;
    LaneRuntime l;l.lane=static_cast<std::uint16_t>(index);l.target=lane.target;
    switch(lane.target){
      case AutomationLane::Target::Volume:track.volumeLane=static_cast<std::int32_t>(track.lanes.size());break;
      case AutomationLane::Target::Pan:track.panLane=static_cast<std::int32_t>(track.lanes.size());break;
      case AutomationLane::Target::Mute:track.muteLane=static_cast<std::int32_t>(track.lanes.size());break;
      case AutomationLane::Target::Send:continue; // Evaluated by the fed return (TrackRuntime::Feed::lane).
      case AutomationLane::Target::Instrument:
        if(track.vst3()){l.plugin=true;l.pluginParam=static_cast<std::uint32_t>(std::stoul(lane.param));}
        else if(track.rust)l.rustParam=rustParameterIndex(*track.rust,lane.param);
        else if(t.source.kind==TrackSource::Kind::BuiltinSynth||t.source.kind==TrackSource::Kind::BuiltinSampled)l.synthField=synthField(lane.param);
        if(!l.plugin&&!l.synthField&&l.rustParam<0)continue;
        break;
      case AutomationLane::Target::Insert:{
        const auto found=std::find_if(t.inserts.begin(),t.inserts.end(),[&](const BuiltinInsert& e){return e.id==lane.insertId;});
        if(found==t.inserts.end())continue;
        const auto source=static_cast<std::uint16_t>(found-t.inserts.begin());
        const auto runtime=std::find_if(track.inserts.begin(),track.inserts.end(),[&](const InsertRuntime& i){return i.source==source;});
        if(runtime==track.inserts.end())continue; // Disabled insert.
        l.insert=static_cast<std::int32_t>(runtime-track.inserts.begin());
        if(runtime->plugin){l.plugin=true;l.pluginParam=static_cast<std::uint32_t>(std::stoul(lane.param));}
        else{
          if(!runtime->control)runtime->control=std::make_unique<dsp::EffectControl>(found->type,found->params);
          l.control=runtime->control->index(lane.param);
          if(l.control<0)continue;
          runtime->automated=true;
        }
        break;
      }
    }
    track.lanes.push_back(l);
  }
  // Mid-block VST3 points need one event slot each; reserve the worst case against the bounded buffers.
  std::size_t pluginLanes=0;for(const auto& l:track.lanes)pluginLanes+=l.plugin;
  require(pluginLanes*32<=maxInsertEvents,"Too many automated VST3 parameters on one track");
}

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

// Control-thread record of the last submitted graph plus every diff applied to it since (RenderEngine::update):
// the timeline as the running graph knows it (note ids as renumbered by update) and what each track resolved.
// The callback never reads it; it receives a predecessor serial and per-track links, not a hash or JSON.
struct ControlTrack {
  std::uint32_t latency=0;
  double tail=0,instrumentTail=0;
  std::size_t memory=0,wavetableMemory=0;   // Per-instance estimate (inserts, IEUM WAVE).
  bool routing=false,aheadEligible=false;   // Reads or feeds a tap in the same block / may render ahead.
  // GARAK_RUST_ENGINE host nodes (rust_engine.inc): the instrument's delay, tail (before windows and inserts) and
  // stereo layout, and each VST3 insert's delay and tail (indexed like TrackTimeline::inserts).
  std::uint32_t sourceLatency=0;double sourceTail=0;bool sourceStereo=false;
  std::vector<std::pair<std::uint32_t,double>> pluginInserts;
  std::vector<std::shared_ptr<const PcmAsset>> assets; // Windows, then sample zones, in resolution order.
  std::optional<SampleSet> set;
  std::vector<dsp::SharedResource> shared;
};
struct ControlRecipe {
  ProjectTimeline timeline;
  std::vector<ControlTrack> tracks;
  std::uint32_t senderLatency=0,returnLatency=0;
};
ProjectTimeline headerOf(const ProjectTimeline& p) {
  ProjectTimeline h;
  h.version=p.version;h.projectId=p.projectId;h.revision=p.revision;h.sampleRate=p.sampleRate;h.bpm=p.bpm;h.beatsPerBar=p.beatsPerBar;h.tempoMap=p.tempoMap;h.meterMap=p.meterMap;
  h.timeSigNumerator=p.timeSigNumerator;h.timeSigDenominator=p.timeSigDenominator;h.lengthFrames=p.lengthFrames;h.cycle=p.cycle;h.masterGain=p.masterGain;h.lowLatencyMonitoring=p.lowLatencyMonitoring;
  return h;
}
// Header fields that every track's frames or the transport depend on: a change rebuilds the graph.
bool sameTiming(const ProjectTimeline& x,const ProjectTimeline& y) {
  return x.bpm==y.bpm&&x.beatsPerBar==y.beatsPerBar&&x.timeSigNumerator==y.timeSigNumerator&&x.timeSigDenominator==y.timeSigDenominator&&x.lengthFrames==y.lengthFrames&&x.cycle==y.cycle&&x.tempoMap==y.tempoMap&&x.meterMap==y.meterMap;
}
bool samePlugin(const PluginSpec&a,const PluginSpec&b){return a.instanceId==b.instanceId&&a.path==b.path&&a.classId==b.classId&&a.state==b.state&&a.controllerState==b.controllerState&&a.isInstrument==b.isInstrument;}
// Instrument identity: equal sources keep their voices and instrument across an edit (parameters may differ;
// IEUM WAVE crossfades a changed patch, VST3 instances are resolved by instance id).
bool sameSourceIdentity(const TrackSource& x,const TrackSource& y) {
  return x.kind==y.kind&&x.instrumentId==y.instrumentId&&x.sampleSetId==y.sampleSetId&&x.isKit==y.isKit&&samePlugin(x.plugin,y.plugin);
}
// Notes compared without their ids (update() renumbers them against the running graph).
bool sameNotes(const std::vector<NotePair>& x,const std::vector<NotePair>& y) {
  if(x.size()!=y.size())return false;
  for(std::size_t i=0;i<x.size();++i){const auto&a=x[i];const auto&b=y[i];if(a.onFrame!=b.onFrame||a.offFrame!=b.offFrame||a.limitFrame!=b.limitFrame||a.pitch!=b.pitch||a.velocity!=b.velocity)return false;}
  return true;
}
// Old notes not present (by value, ids included) in `next`: released at a swap when sounding.
std::vector<TrackRuntime::RemovedNote> removedNotes(const std::vector<NotePair>& old,const std::vector<NotePair>& next) {
  const auto key=[](const NotePair& n){return std::make_tuple(n.id,n.onFrame,n.offFrame,n.limitFrame,n.pitch,n.velocity);};
  std::vector<const NotePair*> a,b;a.reserve(old.size());b.reserve(next.size());
  for(const auto&n:old)a.push_back(&n);
  for(const auto&n:next)b.push_back(&n);
  const auto less=[&](const NotePair* x,const NotePair* y){return key(*x)<key(*y);};
  std::sort(a.begin(),a.end(),less);std::sort(b.begin(),b.end(),less);
  std::vector<TrackRuntime::RemovedNote> removed;
  std::size_t j=0;
  for(const auto* n:a) {
    while(j<b.size()&&less(b[j],n))++j;
    if(j<b.size()&&key(*b[j])==key(*n)){++j;continue;}
    removed.push_back({n->id,n->onFrame,n->offFrame,static_cast<std::uint8_t>(n->pitch)});
  }
  return removed;
}
// Gives every note of `next` that equals a note of `old` (frames, pitch, velocity) that note's id and every
// other note a fresh id above all old ids, so unchanged notes keep their running voices and plug-in note ids.
// Returns the old notes without a match (removed or edited).
std::vector<TrackRuntime::RemovedNote> renumberNotes(const std::vector<NotePair>& old,std::vector<NotePair>& next) {
  const auto key=[](const NotePair& n){return std::make_tuple(n.onFrame,n.offFrame,n.limitFrame,n.pitch,n.velocity);};
  std::vector<std::uint32_t> a(old.size()),b(next.size());
  for(std::uint32_t i=0;i<a.size();++i)a[i]=i;
  for(std::uint32_t i=0;i<b.size();++i)b[i]=i;
  std::sort(a.begin(),a.end(),[&](std::uint32_t x,std::uint32_t y){return std::make_pair(key(old[x]),old[x].id)<std::make_pair(key(old[y]),old[y].id);});
  std::sort(b.begin(),b.end(),[&](std::uint32_t x,std::uint32_t y){return std::make_pair(key(next[x]),x)<std::make_pair(key(next[y]),y);});
  std::int64_t top=-1;for(const auto&n:old)top=std::max<std::int64_t>(top,n.id);
  const bool compact=top+static_cast<std::int64_t>(next.size())+1>std::numeric_limits<std::int32_t>::max()/2;
  std::vector<char> matched(next.size(),0),used(old.size(),0);
  if(!compact)for(std::size_t i=0,j=0;i<a.size()&&j<b.size();) {
    const auto ka=key(old[a[i]]),kb=key(next[b[j]]);
    if(ka<kb)++i;else if(kb<ka)++j;
    else{next[b[j]].id=old[a[i]].id;matched[b[j]]=1;used[a[i]]=1;++i;++j;}
  }
  std::int32_t fresh=compact?0:static_cast<std::int32_t>(top+1);
  for(std::size_t j=0;j<next.size();++j)if(!matched[j])next[j].id=fresh++;
  std::vector<TrackRuntime::RemovedNote> removed;
  for(std::size_t i=0;i<old.size();++i)if(!used[i])removed.push_back({old[i].id,old[i].onFrame,old[i].offFrame,static_cast<std::uint8_t>(old[i].pitch)});
  return removed;
}
// Runtime insert index (enabled inserts of an enabled track, in order) of each timeline insert, or -1.
std::vector<std::int32_t> runtimeInserts(const TrackTimeline& t) {
  std::vector<std::int32_t> result(t.inserts.size(),-1);std::int32_t next=0;
  if(t.enabled)for(std::size_t i=0;i<t.inserts.size();++i)if(t.inserts[i].enabled)result[i]=next++;
  return result;
}
// Per runtime insert of `next`: the runtime insert of `old` with the same id and type (same plug-in), or -1.
std::vector<std::int32_t> insertOrigins(const TrackTimeline& old,const TrackTimeline& next) {
  std::vector<std::int32_t> result;
  const auto from=runtimeInserts(old);
  if(!next.enabled)return result;
  for(const auto&e:next.inserts) {
    if(!e.enabled)continue;
    std::int32_t origin=-1;
    for(std::size_t j=0;j<old.inserts.size();++j){const auto&o=old.inserts[j];
      if(o.id==e.id&&o.type==e.type&&from[j]>=0&&(e.type!="vst3"||samePlugin(o.plugin,e.plugin))){origin=from[j];break;}}
    result.push_back(origin);
  }
  return result;
}
// Index of this track's send automation lane for a return (TrackRuntime::Feed::lane), or -1.
std::int32_t sendLane(const TrackTimeline& t,const std::string& returnId) {
  for(std::size_t l=0;l<t.automation.size();++l)if(t.automation[l].target==AutomationLane::Target::Send&&t.automation[l].returnId==returnId&&!t.automation[l].points.empty())return static_cast<std::int32_t>(l);
  return -1;
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

// Tempo and meter maps in a block's process context: the tempo and time signature at the block start and
// frame→beat for plug-ins (docs/TEMPO_MAP.md, docs/METER_MAP.md).
template<class Graph> void tempoContext(ProcessContext& context,const Graph& g)noexcept {
  if(!g.timeline.tempoMap.empty()){context.tempo=&g.tempo;context.bpm=g.tempo.bpmAt(g.tempo.beatAtFrame(static_cast<double>(context.projectFrame),context.sampleRate));}
  if(!g.timeline.meterMap.empty()) {
    const auto& meter=g.meters.at(context.beatAt(static_cast<double>(context.projectFrame)));
    context.meters=&g.meters;context.timeSigNumerator=meter.numerator;context.timeSigDenominator=meter.denominator;
  }
}

#include "rust_engine.inc"
namespace { std::atomic<std::uint64_t> rustBlockCounter{0}; } // Process-wide blocks the Rust graph rendered.

struct PreparedProject::Impl {
  ProjectTimeline timeline; // Header only: the tracks live in `tracks` (and in the control recipe).
  // Compiled once on the control thread; null-free for the callback (constant maps use timeline.bpm).
  TempoMap tempo;
  MeterMap meters; // Time-signature changes; constant (one event) when timeline.meterMap is empty.
  PtrList<TrackRuntime> tracks;
  dsp::Master master;
  std::uint32_t latency=0,senderLatency=0;
  double tail=.85,trackTail=0;
  std::unique_ptr<ControlRecipe> recipe; // Moved to the engine by submit().
  std::uint64_t serial=0,preserveFrom=0;
  // Set by submit() when this graph continues the running one: tempo/length/cycle changed (every track
  // continues from the playhead), and each previous track's index here (-1: removed).
  bool headerChanged=false;
  std::vector<std::int32_t> successor;
  std::size_t wavetableMemory=0,wavetableTableMemory=0;
  // GARAK_RUST_ENGINE (rust_engine.inc): the PCM objects the Rust graph needs, collected by prepare().
  std::vector<std::shared_ptr<const PcmAsset>> rustAssets;
  std::vector<SampleSet> rustSets; // The sample sets its sampled instruments use (zone PCM is in rustAssets).
  // Track-input routing: track indices grouped by processing level (sources first). One level = no
  // routes, the original single fork. `masterLevel` is the first level holding a master-resampling track.
  std::vector<std::uint32_t> levelOrder,levelStart;
  std::uint32_t masterLevel=std::numeric_limits<std::uint32_t>::max();
  explicit Impl(const ProjectTimeline& p):timeline(headerOf(p)),tempo(p.bpm,p.tempoMap),meters(p.timeSigNumerator,p.timeSigDenominator,p.meterMap),master(p.sampleRate){}
  void reset(std::int64_t frame,bool chase,bool effects,std::uint64_t& overflows)noexcept {
    for(auto&track:tracks) track.reset(frame,chase,effects,overflows);
    if(effects) master.reset();
  }
  // Each track continues its predecessor (same id); a new track starts at the playhead like after a seek.
  void takeStateFrom(Impl& previous,std::int64_t frame,bool playing,std::uint64_t& overflows)noexcept {
    for(auto&t:tracks) {
      if(t.predecessor>=0&&static_cast<std::size_t>(t.predecessor)<previous.tracks.size())t.adopt(previous.tracks[static_cast<std::size_t>(t.predecessor)],frame,t.identical&&!headerChanged,false);
      else t.reset(frame,playing,true,overflows);
    }
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
double PreparedProject::trackTailSeconds()const noexcept{return impl_->trackTail;}
std::uint32_t PreparedProject::latencyFrames()const noexcept{return impl_->latency;}
std::uint32_t PreparedProject::senderLatencyFrames()const noexcept{return impl_->senderLatency;}

struct RenderEngine::Impl {
  // Diff commands (docs/RENDER_DIFF_PROTOCOL.md): Mix (track gain/pan/mute/solo flags), Send (a return's feed
  // gain), Param (one built-in insert parameter, in place), Replace (one track swapped at a block boundary,
  // keeping its voices and tails), Revision (the applied project revision).
  enum class Kind { Graph,Play,Pause,Stop,Seek,Preview,NoteOn,NoteOff,AllNotesOff,Control,Monitor,RecordStart,RecordStop,Master,Input,Layout,Metronome,Mix,Send,Param,Replace,Revision,RustSync };
  enum MixFlag : std::uint32_t { MixAudible=1,MixUnmutedAudible=2,MixMute=4,MixSolo=8,MixSoloSafe=16 };
  struct Command {Kind kind=Kind::Stop;std::uint64_t ticket=0;PreparedProject*graph=nullptr;Capture*capture=nullptr;std::uint32_t track=0;std::int64_t frame=0;int pitch=60;std::int32_t noteId=-1;float value=1;std::array<std::uint64_t,4>mask{};std::array<std::uint8_t,maxInputLayout>layout{};const MetronomeClicks*clicks=nullptr;
    TrackRuntime*runtime=nullptr;double param=0;float pan=0;std::uint32_t flags=0,insert=0;};
  std::uint32_t rate,maxBlock;
  PreparedProject*active=nullptr;
  // GARAK_RUST_ENGINE (rust_engine.inc). Control thread: the mode, the backend (created at the first graph, with
  // the offline flag then set), refusal bookkeeping and whether update() already synchronised the Rust graph.
  // Callback: whether the active graph renders through Rust, the Rust ticket it may apply, and whether the
  // last block did (a switch resets the engine taking over).
  int rustMode=rustEngineModeFromEnvironment();
  bool rustHostInstruments=rustHostInstrumentsFromEnvironment(); // Diagnostics: built-in instruments as host nodes.
  std::string rustRefuseInsert=rustRefuseInsertFromEnvironment(); // Diagnostics (tests): refuse graphs with this insert.
#if GARAK_RUST
  std::unique_ptr<RustBackend> rust;
#endif
  bool rustInUpdate=false;
  std::string rustRefusal;
  std::atomic<std::uint64_t> rustRefusals{0};
  bool rustActive=false,rustRendered=false;
  std::uint64_t rustAllowed=0;
  std::array<float,256> rustPeaks{};
#if GARAK_RUST
  GarakRsTask rustTask=nullptr;void* rustJob=nullptr; // Current parallel Rust job (callback + pool workers).
  // Host node callbacks (VST3, IEUM WAVE, device input) for the Rust graph. `user` is a RustScope: the block
  // the callbacks render (the callback's, or a render-ahead producer's own).
  struct RustScope { Impl* e=nullptr; PreparedProject::Impl* graph=nullptr; const ProcessContext* context=nullptr; const float* input=nullptr;
    std::int64_t position=0; std::uint32_t cursor=0,channels=0; bool playing=false; };
  RustScope rustScope;
  GarakRsHostNodes rustNodes{};
  std::array<const float*,256> rustAhead{}; // This block's ring output of tracks rendering ahead (else null).
  std::uint64_t rustConsumed=0;            // Rust commands applied up to this ticket.
#endif
  std::atomic<bool> publishedRust{false};
  SpscQueue<Command,1024> commands;
  SpscQueue<PreparedProject*,4096>retired;
  // Tracks replaced in the running graph, destroyed on the control thread (collectRetired). The control
  // thread keeps at most retiredTrackCapacity replacements in flight, so the callback's push never fails.
  static constexpr std::size_t retiredTrackCapacity=512;
  SpscQueue<TrackRuntime*,retiredTrackCapacity>retiredTracks;
  std::size_t replacementsInFlight=0;
  std::optional<Command> deferred;
  std::uint64_t nextTicket=1,lastTicket=0,voiceOverflows=0,invalidSamples=0;
  std::atomic<std::uint64_t>commandOverflows{0};
  std::unique_ptr<ControlRecipe>lastSubmittedRecipe;
  std::uint64_t lastSubmittedSerial=0;
  WavetableResources wavetableResources;
  std::size_t retainedWavetableMemory=0; // Control-thread graph ownership budget.
  std::size_t lastSubmittedWavetableTableMemory=0;
  std::int64_t position=0;
  std::int64_t continuousFrame=0;
  bool playing=false,offline=false,recording=false,masterBypass=false;
  float masterGain=1;
  float targetMasterGain=1;
  // Metronome (callback-owned view; see metronome.hpp). During a count-in the
  // transport holds `position` and is not `playing`; a capture started meanwhile
  // waits (recording=false) and begins on the frame the transport starts.
  const MetronomeClicks*clicks=nullptr;bool metronomeOn=false;float metronomeGain=0;
  metronome::Player clickPlayer;
  std::int64_t countInRemaining=0,countInElapsed=0,countInLength=0;
  // Control thread: click sets in submission order, freed once a newer one is applied.
  std::vector<std::pair<std::uint64_t,std::shared_ptr<const MetronomeClicks>>>ownedClicks;
  std::array<std::uint64_t,4>monitor{};
  int inputLeft=0,inputRight=1;
  // Callback copy of the device's physical channel order. Identity until set.
  std::array<std::uint8_t,maxInputLayout>layout{};std::uint32_t layoutCount=maxInputLayout;
  std::vector<float>inputScratch;
  std::vector<float>resampleScratch; // Master feed of the current block for resampling tracks.
  const std::uint32_t*levelTracks=nullptr; // Track indices of the level a fork renders.
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
    std::atomic<std::uint32_t>trackCount{0},latency{0},senderLatency{0},aheadTracks{0};
    std::atomic<bool>ready{false},playing{false},recording{false};
    std::atomic<float>masterPeak{0};std::array<std::atomic<float>,256>trackPeaks{};
    std::atomic<std::uint32_t>dynamicsCount{0};
    std::array<std::atomic<std::uint32_t>,EngineSnapshot::maxDynamicsReadings>dynamicsIds{};
    std::array<std::atomic<float>,EngineSnapshot::maxDynamicsReadings>dynamicsInput{},dynamicsGain{};
  }published;
  // Callback-owned meter window for `published.dynamics*`: slot id, current and previous bucket.
  std::array<std::uint32_t,EngineSnapshot::maxDynamicsReadings>heldIds{};
  std::array<float,EngineSnapshot::maxDynamicsReadings>heldInput{},heldGain{},lastInput{},lastGain{};
  std::uint32_t meterFrames=0;
  // Live MIDI from the device thread (queueLiveMidi), applied in render() at
  // sub-block starts, and where each sub-block of the last render() fell on the
  // transport (renderedTransportFrame). Both fixed, callback-owned.
  static constexpr std::uint32_t maxLiveMidi=256,maxRendered=256;
  std::array<LiveMidiEvent,maxLiveMidi>liveMidi{};std::uint32_t liveMidiCount=0,liveMidiNext=0;
  struct RenderedSpan{std::uint32_t cursor=0,count=0;std::int64_t position=0;bool playing=false;};
  std::array<RenderedSpan,maxRendered>rendered{};std::uint32_t renderedCount=0;
  // Applies queued live events due at `cursor`; returns frames until the next one.
  std::uint32_t applyLiveMidi(std::uint32_t cursor,std::uint32_t frames)noexcept {
    while(liveMidiNext<liveMidiCount&&liveMidi[liveMidiNext].offset<=cursor) {
      auto&ev=liveMidi[liveMidiNext];
      if(active&&ev.track<active->impl_->tracks.size()) {
        auto&t=active->impl_->tracks[ev.track];
        // A track rendering ahead drains first: keep the rest for the next call.
        if(!own(t))break;
        markLive(t);
        const auto type=ev.status&0xF0;
        if(type==0x90&&ev.data2>0)rustLive(ev.track,0,ev.data1&0x7F,ev.noteId,static_cast<float>(ev.data2&0x7F)/127.f);
        else if(type==0x80||type==0x90)rustLive(ev.track,1,ev.data1&0x7F,ev.noteId,0);
        else if(type==0xB0&&(ev.data1==120||ev.data1==123))rustLive(ev.track,2,0,0,0);
        else if(type==0xB0)rustLive(ev.track,3,ev.data1&0x7F,ev.data2&0x7F,0);
        else if(type==0xE0)rustLive(ev.track,3,pitchBendController,(((ev.data2&0x7F)<<7)|(ev.data1&0x7F))-8192,0);
        else if(type==0xD0)rustLive(ev.track,3,channelPressureController,ev.data1&0x7F,0);
        else if(type==0xC0)rustLive(ev.track,3,programChangeController,ev.data1&0x7F,0);
        if(type==0x90&&ev.data2>0)t.spawn(ev.data1&0x7F,static_cast<float>(ev.data2&0x7F)/127.f,unlimitedFrame,unlimitedFrame,ev.noteId,true,voiceOverflows);
        else if(type==0x80||type==0x90)t.noteOff(ev.data1&0x7F,ev.noteId,voiceOverflows);
        else if(type==0xB0&&(ev.data1==120||ev.data1==123))t.allNotesOff(voiceOverflows);
        // Controllers (CC64 defers built-in note-offs), pitch bend, channel pressure, program change.
        else if(type==0xB0)t.controlChange(ev.data1&0x7F,ev.data2&0x7F,voiceOverflows);
        else if(type==0xE0)t.controlChange(pitchBendController,(((ev.data2&0x7F)<<7)|(ev.data1&0x7F))-8192,voiceOverflows);
        else if(type==0xD0)t.controlChange(channelPressureController,ev.data1&0x7F,voiceOverflows);
        else if(type==0xC0)t.controlChange(programChangeController,ev.data1&0x7F,voiceOverflows);
      }
      ++liveMidiNext;
    }
    if(liveMidiNext<liveMidiCount&&liveMidi[liveMidiNext].offset>cursor)return std::min(frames-cursor,liveMidi[liveMidiNext].offset-cursor);
    return frames-cursor;
  }

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

  Impl(std::uint32_t r,std::uint32_t b,std::uint32_t capacity):rate(r),maxBlock(b),inputScratch(static_cast<std::size_t>(b)*2),resampleScratch(static_cast<std::size_t>(b)*2),recordingCapacity(capacity){
    for(std::size_t i=0;i<maxInputLayout;++i){layout[i]=static_cast<std::uint8_t>(i);controlLayout[i]=layout[i];}
  }
  ~Impl(){pool.reset();Command c;
    const auto drop=[](Command& x){if(x.kind==Kind::Graph)delete x.graph;if(x.kind==Kind::Replace)delete x.runtime;};
    while(commands.pop(c))drop(c);
    if(deferred)drop(*deferred);
    PreparedProject*p=nullptr;
    while(retired.pop(p))delete p;
    TrackRuntime*t=nullptr;
    while(retiredTracks.pop(t))delete t;
    delete active;}
  std::uint64_t enqueue(Command command) {
    command.ticket=nextTicket++;
    if(!commands.push(command)){commandOverflows.fetch_add(1,std::memory_order_relaxed);return 0;}return command.ticket;
  }
  // Control thread (GARAK_RUST_ENGINE): submit `p` to the Rust graph. False (with rustRefusal set) when the Rust
  // engine refuses it: the C++ tracks render that graph, or in strict mode the call throws.
  template<class Assets>bool rustApply(const ProjectTimeline& p,const Assets& assets,const std::vector<SampleSet>& sets,const ControlRecipe* recipe) {
#if GARAK_RUST
    std::string reason;bool ok=false;
    try {
      if(!rust)rust=std::make_unique<RustBackend>(rate,maxBlock,offline);
      ok=rust->apply(p,assets,sets,recipe,rustHostInstruments,reason);
    } catch(const std::exception& error){reason=error.what();ok=false;}
    if(ok){rustRefusal.clear();return true;}
    rustRefusal=reason;rustRefusals.fetch_add(1,std::memory_order_relaxed);
    if(rustMode==2)throw std::invalid_argument("GARAK_RUST_ENGINE=strict: the Rust engine refused the project: "+reason);
    return false;
#else
    (void)p;(void)assets;(void)sets;(void)recipe;rustRefusal="this build has no Rust engine (GARAK_RUST=OFF)";
    if(rustMode==2)throw std::invalid_argument(rustRefusal);
    return false;
#endif
  }
  std::uint64_t enqueueRustSync(bool enabled) {
#if GARAK_RUST
    Command c;c.kind=Kind::RustSync;c.flags=enabled?1u:0u;c.frame=static_cast<std::int64_t>(rust?rust->ticket():0);
    return enqueue(c);
#else
    (void)enabled;return 0;
#endif
  }
  // A live event for the Rust graph's track `track` (callback, after `own` of that track): its built-in instrument
  // plays it like the C++ track would (kind 0 note on (a = id), 1 note off (a = id), 2 all notes off, 3 controller
  // (pitch = controller, a = value), 4 preview (a = frames)). The C++ track gets the event too: it renders when the
  // Rust graph does not.
  void rustLive(std::uint32_t track,std::uint32_t kind,int pitch,int a,float velocity)noexcept {
#if GARAK_RUST
    if(!rustRenders()||!active)return;
    rustPrepare(); // The event lands on the Rust graph this block renders, after any switch reset.
    garak_rs_engine_live(rust->handle,track,kind,pitch,a,velocity);
#else
    (void)track;(void)kind;(void)pitch;(void)a;(void)velocity;
#endif
  }
  void rustStopAtEnd()noexcept {
#if GARAK_RUST
    if(rustRenders())garak_rs_engine_stop_at_end(rust->handle);
#endif
  }
  // Tracks rendering ahead are skipped: their producer applies the same cycle
  // wrap at the same frame. Every other caller first reclaims them.
  void reset(bool chase,bool effects)noexcept {
    if(!active)return;
    auto&p=*active->impl_;
    for(auto&t:p.tracks)if(!t.ahead||t.ahead->mode.load(std::memory_order_relaxed)==AheadState::Off)t.reset(position,chase,effects,voiceOverflows);
    if(effects)p.master.reset();
#if GARAK_RUST
    if(rust&&rustActive) {
      std::array<std::uint64_t,4>skip{};
      for(std::size_t i=0;i<p.tracks.size()&&i<256;++i){const auto&t=p.tracks[i];if(t.ahead&&t.ahead->mode.load(std::memory_order_relaxed)!=AheadState::Off)skip[i/64]|=std::uint64_t{1}<<(i%64);}
      garak_rs_engine_reset_skip(rust->handle,position,chase?1:0,effects?1:0,skip.data());
    }
#endif
  }
#if GARAK_RUST
  // The Rust graph renders this block when the active graph is Rust-backed (monitoring, routes and recording
  // taps included: the device input reaches it through the input host node).
  [[nodiscard]] bool rustRenders()const noexcept {
    return rust&&rustActive;
  }
  // Host nodes (docs/RUST_ENGINE.md 4), called by the Rust graph from the thread rendering that track, inside
  // renderRust: `block` describes the block. Each touches only its own track (like renderTrack).
  static void rustSourceNode(void*self,std::uint32_t track,float*stereo,std::uint32_t frames)noexcept {
    const auto&b=*static_cast<RustScope*>(self);auto&g=*b.graph;
    if(track>=g.tracks.size())return;
    auto&t=g.tracks[track];
    t.renderSource(stereo,b.position,frames,b.playing,*b.context,t.taskOverflows);
  }
  static void rustInsertNode(void*self,std::uint32_t track,std::uint32_t insert,float*stereo,std::uint32_t frames)noexcept {
    const auto&b=*static_cast<RustScope*>(self);auto&g=*b.graph;
    if(track>=g.tracks.size())return;
    auto&t=g.tracks[track];
    for(std::size_t k=0;k<t.inserts.size();++k)if(t.inserts[k].source==insert&&t.inserts[k].plugin){t.processPlugin(k,stereo,b.position,frames,*b.context,t.taskOverflows);return;}
  }
  // Each monitored track hears its own physical input; an unopened one hears silence (renderTrack).
  static std::int32_t rustInputNode(void*self,std::uint32_t track,float*stereo,std::uint32_t frames)noexcept {
    const auto&b=*static_cast<RustScope*>(self);auto*e=b.e;auto&g=*b.graph;
    if(track>=g.tracks.size()||!b.input)return 0;
    auto&t=g.tracks[track];
    const auto route=routeInput(t.timeline.input,std::span(e->layout.data(),e->layoutCount),b.channels,e->inputLeft,e->inputRight);
    if(route.missing)return 0;
    for(std::uint32_t i=0;i<frames;++i) {
      const float left=inputSample(b.input,b.channels,b.cursor+i,route.left,t.taskInvalid);
      stereo[2*i]+=left;stereo[2*i+1]+=route.right>=0?inputSample(b.input,b.channels,b.cursor+i,route.right,t.taskInvalid):left;
    }
    return route.right>=0?1:0;
  }
  static void rustTaskAdapter(void*self,std::uint32_t index,std::uint32_t)noexcept {
    auto*e=static_cast<Impl*>(self);e->rustTask(e->rustJob,index);
  }
  static void rustParallelRun(void*host,std::uint32_t count,GarakRsTask task,void*job) {
    auto*e=static_cast<Impl*>(host);e->rustTask=task;e->rustJob=job;
    e->pool->run(count,&rustTaskAdapter,e);
  }
  // Callback: one Rust block. The track meters follow the Rust graph's; host nodes see the same transport
  // context the C++ tracks would.
  // Rust commands first (no render-ahead worker may be inside the Rust graph while they apply), so the rings and
  // the render see the graph this block's C++ graph matches; a switch from C++ resets the idle Rust tracks. Also
  // run before a live event reaches the Rust graph (rustLive), so the event survives that reset.
  void rustPrepare()noexcept {
    if(!rustRendered||rustConsumed!=rustAllowed){quiesce();garak_rs_engine_render_block(rust->handle,nullptr,0,position,playing&&position<active->impl_->timeline.lengthFrames?1:0,rustAllowed,nullptr,0,nullptr,nullptr);rustConsumed=rustAllowed;}
    if(!rustRendered){ // C++ -> Rust: the Rust tracks were idle.
      reclaimAll(true);
      garak_rs_engine_reset(rust->handle,position,playing&&position<active->impl_->timeline.lengthFrames?1:0,1);
      rustRendered=true;
    }
  }
  void renderRust(float*out,std::uint32_t count,const float*input,std::uint32_t cursor,std::uint32_t channels)noexcept {
    auto&p=*active->impl_;
    rustPrepare();
    const bool audible=playing&&position<p.timeline.lengthFrames;
    ProcessContext context{static_cast<double>(rate),p.timeline.bpm,position,audible,offline,p.timeline.timeSigNumerator,p.timeline.timeSigDenominator};
    tempoContext(context,p);
    context.recording=recording;context.continuousFrame=continuousFrame;
    if(p.timeline.cycle&&!offline){context.cycleActive=true;context.cycleStartFrame=p.timeline.cycle->at(0);context.cycleEndFrame=p.timeline.cycle->at(1);}
    block={&p,&context,input,position,count,cursor,channels,audible};
    for(auto&t:p.tracks){t.taskOverflows=0;t.taskInvalid=0;}
    // Tracks rendering ahead: this block from their rings (a lost ring renders here after a reset).
    rustAhead.fill(nullptr);
    for(std::size_t i=0;i<p.tracks.size()&&i<rustAhead.size();++i) {
      auto&t=p.tracks[i];
      if(!t.ahead||t.ahead->mode.load(std::memory_order_acquire)==AheadState::Off)continue;
      if(consumeAhead(p,t,static_cast<std::uint32_t>(i))){rustAhead[i]=t.mix;continue;}
      auto&a=*t.ahead;a.lock();a.mode.store(AheadState::Off,std::memory_order_relaxed);a.clear();a.unlock();
      t.reset(position,audible,true,t.taskOverflows);garak_rs_engine_reset_track(rust->handle,static_cast<std::uint32_t>(i),position,audible?1:0,1);++t.taskResyncs;
    }
    rustScope={this,&p,&context,input,position,cursor,channels,audible};
    rustNodes.user=&rustScope;rustNodes.source=&rustSourceNode;rustNodes.insert=&rustInsertNode;rustNodes.input=&rustInputNode;
    GarakRsBlock b{};b.position=position;b.playing=audible?1:0;b.allowed=rustAllowed;b.master_gain=masterGain;b.target_master_gain=targetMasterGain;
    for(std::size_t i=0;i<monitor.size();++i)b.monitor[i]=monitor[i];
    b.nodes=&rustNodes;b.ahead=rustAhead.data();b.ahead_count=static_cast<std::uint32_t>(std::min<std::size_t>(p.tracks.size(),rustAhead.size()));
    const bool parallel=pool&&forkEnabled&&p.tracks.size()>=2;
    garak_rs_engine_render_host(rust->handle,out,count,&b,rustPeaks.data(),static_cast<std::uint32_t>(std::min<std::size_t>(p.tracks.size(),rustPeaks.size())),
      parallel?&rustParallelRun:nullptr,this);
    for(std::size_t i=0;i<p.tracks.size();++i) {
      auto&t=p.tracks[i];
      if(i<rustPeaks.size()&&!rustAhead[i])t.meter=rustPeaks[i]; // Ahead tracks: their ring's chunk peaks.
      voiceOverflows+=t.taskOverflows;invalidSamples+=t.taskInvalid;aheadResyncs+=t.taskResyncs;t.taskResyncs=0;
    }
    rustBlockCounter.fetch_add(1,std::memory_order_relaxed);
  }
#endif

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
  // One block of an ahead track (the C++ track, or its Rust graph track when the Rust graph renders) into `out`;
  // returns its peak.
  float renderOwn(const PreparedProject::Impl&g,TrackRuntime&t,std::uint32_t index,std::int64_t frame,std::uint32_t count,bool playing,
                  const ProcessContext&context,float*out,std::uint64_t&overflows,std::uint64_t&invalid)noexcept {
#if GARAK_RUST
    if(rustRenders()) {
      RustScope scope{this,const_cast<PreparedProject::Impl*>(&g),&context,nullptr,frame,0,0,playing};
      const GarakRsHostNodes nodes{&scope,&rustSourceNode,&rustInsertNode,&rustInputNode};
      float peak=0;const float*mix=garak_rs_engine_render_ahead(rust->handle,index,frame,count,playing?1:0,&nodes,&peak);
      if(mix)std::copy_n(mix,static_cast<std::size_t>(count)*2,out);else std::fill_n(out,static_cast<std::size_t>(count)*2,0.f);
      return peak;
    }
#else
    (void)g;(void)index;
#endif
    t.render(frame,count,playing,nullptr,false,false,context,overflows,invalid);
    std::copy_n(t.buffer.data(),static_cast<std::size_t>(count)*2,out);
    return t.peak;
  }
  // A track the callback takes back from its ring out of sync: voices and tails restart here.
  void resetOwn(TrackRuntime&t,std::uint32_t index,std::int64_t frame,bool chase,std::uint64_t&overflows)noexcept {
    t.reset(frame,chase,true,overflows);
    rustResetTrack(index,frame,chase,true);
  }
  // The same reset of the Rust graph's track (the calling thread owns it: the callback, or its ahead producer).
  void rustResetTrack(std::uint32_t index,std::int64_t frame,bool chase,bool effects)noexcept {
#if GARAK_RUST
    if(rustRenders())garak_rs_engine_reset_track(rust->handle,index,frame,chase?1:0,effects?1:0);
#else
    (void)index;(void)frame;(void)chase;(void)effects;
#endif
  }
  // Busy holder: render this track's next block exactly as the callback would.
  AheadState::Produce produce(const PreparedProject::Impl&g,TrackRuntime&t,std::uint32_t index,bool helping)noexcept {
    auto&a=*t.ahead;const auto&p=g.timeline;const auto boundary=boundaryOf(p);
    if(a.nextFrame>=boundary) {
      if(!p.cycle)return AheadState::Produce::Ended;
      a.nextFrame=p.cycle->at(0);t.reset(a.nextFrame,true,false,a.pendingOverflows);rustResetTrack(index,a.nextFrame,true,false);
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
    tempoContext(context,g);
    context.recording=recordingNow.load(std::memory_order_relaxed);context.continuousFrame=a.continuous;
    if(p.cycle){context.cycleActive=true;context.cycleStartFrame=p.cycle->at(0);context.cycleEndFrame=p.cycle->at(1);}
    std::uint64_t overflows=a.pendingOverflows,invalid=0;a.pendingOverflows=0;
    float*scratch=a.out.data()+static_cast<std::size_t>(maxBlock)*2; // Producer half of `out`.
    const float peak=renderOwn(g,t,index,a.nextFrame,count,true,context,scratch,overflows,invalid);
    const auto at=static_cast<std::size_t>(written%a.capacity),first=std::min<std::size_t>(count,a.capacity-at);
    std::copy_n(scratch,first*2,a.ring.data()+at*2);
    std::copy_n(scratch+first*2,(count-first)*2,a.ring.data());
    a.chunks[chunkIndex%AheadState::chunkSlots]={a.nextFrame,count,peak,overflows,invalid};
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
    TrackRuntime*best=nullptr;std::uint32_t bestIndex=0;std::uint64_t bestFill=std::numeric_limits<std::uint64_t>::max();
    for(std::size_t i=0;i<g->tracks.size();++i) {
      auto&t=g->tracks[i];
      if(!t.ahead)continue;
      auto&a=*t.ahead;
      if(a.mode.load(std::memory_order_acquire)!=AheadState::Active||a.busy.load(std::memory_order_relaxed))continue;
      const auto fill=a.written.load(std::memory_order_relaxed)-a.read.load(std::memory_order_acquire);
      if(fill<bestFill&&fill<aheadTarget(a)){best=&t;bestIndex=static_cast<std::uint32_t>(i);bestFill=fill;}
    }
    bool did=false;
    if(best) {
      auto&a=*best->ahead;
      if(!a.busy.exchange(true,std::memory_order_acquire)) {
        if(a.mode.load(std::memory_order_acquire)==AheadState::Active)did=produce(*g,*best,bestIndex,false)==AheadState::Produce::Done;
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
  bool catchUp(const PreparedProject::Impl&g,TrackRuntime&t,std::uint32_t index,std::int64_t frame,std::uint64_t&overflows)noexcept {
    auto&a=*t.ahead;const auto&p=g.timeline;
    overflows+=a.pendingOverflows;a.pendingOverflows=0;
    if(a.nextFrame==frame)return true;
    if(!p.cycle)return false;
    if(a.nextFrame>=p.cycle->at(1)&&frame==p.cycle->at(0)){a.nextFrame=frame;t.reset(frame,true,false,overflows);rustResetTrack(index,frame,true,false);return true;}
    return a.nextFrame==p.cycle->at(0)&&frame>=p.cycle->at(1);
  }
  // Callback (transport change): every ahead track returns to the callback. A
  // drained ring hands over seamlessly; otherwise its state is ahead of the
  // playhead and is reset here (voices and tails) unless the caller resets all.
  void reclaimAll(bool resetFollows)noexcept {
    if(!active||!aheadTracks)return;
    quiesce();
    auto&g=*active->impl_;
    for(std::size_t i=0;i<g.tracks.size();++i) {
      auto&t=g.tracks[i];
      if(!t.ahead||t.ahead->mode.load(std::memory_order_relaxed)==AheadState::Off)continue;
      auto&a=*t.ahead;
      const bool seamless=a.empty()&&catchUp(g,t,static_cast<std::uint32_t>(i),position,voiceOverflows);
      a.mode.store(AheadState::Off,std::memory_order_relaxed);a.clear();
      if(!seamless&&!resetFollows)resetOwn(t,static_cast<std::uint32_t>(i),position,false,voiceOverflows);
    }
    aheadTracks=0;
  }
  // Callback, preserving graph swap after quiesce: a track whose ring cannot
  // move into the new graph comes back first.
  void handOverAhead(PreparedProject::Impl&previous,PreparedProject::Impl&next)noexcept {
    for(std::size_t i=0;i<previous.tracks.size();++i) {
      auto&t=previous.tracks[i];
      if(!t.ahead||t.ahead->mode.load(std::memory_order_relaxed)==AheadState::Off)continue;
      const auto s=i<next.successor.size()?next.successor[i]:-1;
      if(s>=0){const auto&n=next.tracks[static_cast<std::size_t>(s)];if(n.identical&&!next.headerChanged&&n.ahead&&n.ahead->capacity==t.ahead->capacity)continue;}
      auto&a=*t.ahead;
      const bool seamless=a.empty()&&catchUp(previous,t,static_cast<std::uint32_t>(i),position,voiceOverflows);
      a.mode.store(AheadState::Off,std::memory_order_relaxed);a.clear();
      if(!seamless)resetOwn(t,static_cast<std::uint32_t>(i),position,playing,voiceOverflows); // The running Rust graph is still `previous`'s.
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
  bool consumeAhead(PreparedProject::Impl&g,TrackRuntime&t,std::uint32_t index)noexcept {
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
          const bool synced=catchUp(g,t,index,block.position+got,t.taskOverflows);a.clear();
          if(!synced)return false;
          auto context=*block.context;context.projectFrame+=got;context.continuousFrame+=got;
          t.meter=renderOwn(g,t,index,block.position+got,count-got,block.playing,context,a.out.data()+static_cast<std::size_t>(got)*2,t.taskOverflows,t.taskInvalid);
          t.mix=a.out.data();
          return true;
        }
        if(a.busy.exchange(true,std::memory_order_acquire)){cpuRelax();continue;} // A worker is rendering it.
        const auto result=produce(g,t,index,true);a.unlock();
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
        if(!catchUp(g,t,index,block.position+count,t.taskOverflows)){resetOwn(t,index,block.position+count,block.playing,t.taskOverflows);++t.taskResyncs;}
        a.clear();
      }
    }
    return true;
  }
  static void trackTask(void*self,std::uint32_t index,std::uint32_t slot)noexcept{static_cast<Impl*>(self)->renderTrack(index,slot);}
  static void levelTask(void*self,std::uint32_t index,std::uint32_t slot)noexcept{auto*e=static_cast<Impl*>(self);e->renderTrack(e->levelTracks[index],slot);}
  // The routed track's input for this block, from its source's tap (rendered in an earlier level) or the
  // master feed. Same block frames as the source: an internal route adds no latency of its own.
  void fillRouteInput(PreparedProject::Impl&g,TrackRuntime&t)noexcept {
    const auto samples=static_cast<std::size_t>(block.count)*2;
    const float*source=nullptr;
    if(t.routeKind==TrackRoute::Kind::Track&&t.routeSource>=0) {
      const auto&s=g.tracks[static_cast<std::size_t>(t.routeSource)];
      source=t.routeTap==TrackRoute::Tap::PreFx?s.preTap.data():t.routeTap==TrackRoute::Tap::PostFx?s.postTap.data():s.faderTap.empty()?s.mix:s.faderTap.data();
    } else if(t.routeKind==TrackRoute::Kind::Master)source=resampleScratch.data();
    if(source)std::copy_n(source,samples,t.routeInput.data());else std::fill_n(t.routeInput.data(),samples,0.f);
  }
  // Callback, before the master-resampling level: master gain over the tracks in the master feed (before
  // the master processor), computed with the same smoothing the output mix applies to this block.
  void fillMasterFeed(PreparedProject::Impl&g)noexcept {
    const auto samples=static_cast<std::size_t>(block.count)*2;float*feed=resampleScratch.data();
    std::fill_n(feed,samples,0.f);
    for(const auto&t:g.tracks)if(t.inMasterFeed&&t.mix)for(std::size_t i=0;i<samples;++i)feed[i]+=t.mix[i];
    const float smoothing=static_cast<float>(1-std::exp(-1/(rate*.012)));float gain=masterGain;
    for(std::uint32_t i=0;i<block.count;++i){gain+=(targetMasterGain-gain)*smoothing;feed[2*i]*=gain;feed[2*i+1]*=gain;}
  }
  // A return's input for this block: every feeding send's tap (its sender rendered in an earlier level) times
  // the send gain, smoothed like the fader. Same block frames as the senders: a send adds no latency.
  void fillReturnInput(PreparedProject::Impl&g,TrackRuntime&t)noexcept {
    const auto count=block.count;float*in=t.returnInput.data();
    std::fill_n(in,static_cast<std::size_t>(count)*2,0.f);
    const double smoothing=1-std::exp(-1/(rate*.012));
    for(auto&f:t.feeds) {
      const auto&s=g.tracks[static_cast<std::size_t>(f.sender)];
      const float*tap=f.pre?s.postTap.data():s.faderTap.data();
      const double target=f.pre&&!s.timeline.audible?0.0:static_cast<double>(f.target);
      if(!tap)continue;
      if(f.lane>=0) {
        // Send-level automation: evaluated per sample like the fader lane (docs/AUTOMATION.md).
        const auto&lane=s.timeline.automation[static_cast<std::size_t>(f.lane)];
        const bool silent=f.pre&&!s.timeline.audible;
        for(std::uint32_t i=0;i<count;++i){f.gain=silent?0.0:std::clamp(automationValue(lane,evaluateAutomation(lane,static_cast<double>(block.position+i),f.hint)),0.0,2.0);const auto g2=static_cast<float>(f.gain);in[2*i]+=tap[2*i]*g2;in[2*i+1]+=tap[2*i+1]*g2;}
        continue;
      }
      for(std::uint32_t i=0;i<count;++i){f.gain+=(target-f.gain)*smoothing;const auto g2=static_cast<float>(f.gain);in[2*i]+=tap[2*i]*g2;in[2*i+1]+=tap[2*i+1]*g2;}
    }
  }
  void renderTrack(std::uint32_t index,std::uint32_t slot)noexcept {
    auto&g=*block.graph;auto&t=g.tracks[index];
    t.taskOverflows=0;t.taskInvalid=0;
    if(t.isReturn) {
      fillReturnInput(g,t);
      t.render(block.position,block.count,block.playing,t.returnInput.data(),true,true,*block.context,t.taskOverflows,t.taskInvalid);
      t.meter=t.peak;t.mix=t.buffer.data();
      return;
    }
    if(t.ahead&&t.ahead->mode.load(std::memory_order_acquire)!=AheadState::Off) {
      if(consumeAhead(g,t,index))return;
      // Lost sync (never expected): the documented per-track reset.
      auto&a=*t.ahead;a.lock();a.mode.store(AheadState::Off,std::memory_order_relaxed);a.clear();a.unlock();
      t.reset(block.position,block.playing,true,t.taskOverflows);++t.taskResyncs;
    }
    const bool monitored=(monitor[index/64]&(std::uint64_t{1}<<(index%64)))!=0;
    // Each monitored track hears its own input; an unopened one hears silence.
    const float*trackInput=nullptr;bool stereoInput=false;
    if(t.routed) {
      // Filled even when not monitored: a recording of this track reads it after the block.
      fillRouteInput(g,t);
      if(monitored){trackInput=t.routeInput.data();stereoInput=true;}
    } else if(monitored) {
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
          if(preserve) {
            // A track whose events change continues from the playhead: its render-ahead ring drains first.
            auto&next=*c.graph->impl_;bool wait=false;
            for(auto&t:next.tracks)if(t.predecessor>=0&&(!t.identical||next.headerChanged)&&!own(previous->impl_->tracks[static_cast<std::size_t>(t.predecessor)]))wait=true;
            if(wait){deferred=c;return;}
            handOverAhead(*previous->impl_,next);
          }
          active=c.graph;targetMasterGain=active->impl_->timeline.masterGain;
          if(preserve)active->impl_->takeStateFrom(*previous->impl_,position,playing,voiceOverflows);
          else {masterGain=targetMasterGain;aheadTracks=0;}
          if(projectChanged){position=0;playing=false;monitor={};countInRemaining=0;}
          normalize();if(!preserve)reset(playing,true);
          if(previous){const bool accepted=retired.push(previous);(void)accepted;}
          break;
        }
        case Kind::Play:
          if(!playing&&!countInRemaining){
            normalize(true);
            if(c.frame>0&&active&&!offline){countInRemaining=countInLength=c.frame;countInElapsed=0;}
            else {playing=active!=nullptr;reset(playing,false);}
          }
          break;
        case Kind::Pause:countInRemaining=0;reclaimAll(false);playing=false;reset(false,false);break;
        case Kind::Stop:countInRemaining=0;reclaimAll(true);playing=false;position=0;reset(false,true);break;
        case Kind::Seek:reclaimAll(true);position=c.frame;normalize();reset(playing,true);break;
        case Kind::Preview:case Kind::NoteOn:case Kind::NoteOff:case Kind::AllNotesOff:case Kind::Control: {
          if(!active||c.track>=active->impl_->tracks.size())break;
          auto&t=active->impl_->tracks[c.track];
          // A track rendering ahead finishes its ring first (a few buffers):
          // live notes then start on time from the callback-owned state.
          if(!own(t)){deferred=c;return;}
          markLive(t);
          rustLive(c.track,c.kind==Kind::NoteOff?1:c.kind==Kind::AllNotesOff?2:c.kind==Kind::Control?3:c.kind==Kind::Preview?4:0,
                   c.pitch,c.kind==Kind::Control?static_cast<int>(c.value):c.kind==Kind::Preview?static_cast<int>(c.frame):c.noteId,c.value);
          if(c.kind==Kind::NoteOff)t.noteOff(c.pitch,c.noteId,voiceOverflows);
          else if(c.kind==Kind::AllNotesOff)t.allNotesOff(voiceOverflows);
          else if(c.kind==Kind::Control)t.controlChange(c.pitch,static_cast<int>(c.value),voiceOverflows);
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
          capture=c.capture;recording=capture!=nullptr&&!countInRemaining;recordingStart=position;recordedFrames=0;droppedFrames=0;break;
        }
        case Kind::RecordStop:recording=false;capture=nullptr;break;
        case Kind::Master:targetMasterGain=c.value;break;
        case Kind::Input:inputLeft=c.pitch;inputRight=static_cast<int>(c.frame);break;
        case Kind::Layout:layout=c.layout;layoutCount=c.track;break;
        case Kind::Metronome:
          // Voices may still read the previous set, which the control thread frees once this is acknowledged.
          if(c.clicks!=clicks)clickPlayer.clear();
          clicks=c.clicks;metronomeOn=c.pitch!=0;metronomeGain=c.value;break;
        case Kind::Mix: {
          if(!active||c.track>=active->impl_->tracks.size())break;
          auto&t=active->impl_->tracks[c.track];
          if(!own(t)){deferred=c;return;}
          // Keep the track in the callback while the fader moves: each tick then applies on the next block.
          markLive(t);
          t.timeline.gain=c.value;t.timeline.pan=c.pan;
          t.timeline.audible=(c.flags&MixAudible)!=0;t.timeline.unmutedAudible=(c.flags&MixUnmutedAudible)!=0;
          t.timeline.mute=(c.flags&MixMute)!=0;t.timeline.solo=(c.flags&MixSolo)!=0;t.timeline.soloSafe=(c.flags&MixSoloSafe)!=0;
          break;
        }
        case Kind::Send: {
          // Returns read their feeds in the callback only (they never render ahead).
          if(!active||c.track>=active->impl_->tracks.size())break;
          for(auto&f:active->impl_->tracks[c.track].feeds)if(f.sender==c.noteId&&f.pre==(c.pitch!=0)){f.target=c.value;break;}
          break;
        }
        case Kind::Param: {
          if(!active||c.track>=active->impl_->tracks.size())break;
          auto&t=active->impl_->tracks[c.track];
          if(c.insert>=t.inserts.size())break;
          if(!own(t)){deferred=c;return;}
          markLive(t);
          auto&insert=t.inserts[c.insert];
          if(insert.builtin&&insert.control){insert.control->set(c.pitch,c.param);insert.control->apply(*insert.builtin);}
          break;
        }
        case Kind::Replace: {
          auto*incoming=c.runtime;
          if(!active||c.track>=active->impl_->tracks.size()){(void)retiredTracks.push(incoming);break;}
          auto&g=*active->impl_;
          // No worker may read the track list while one slot changes (the next promote() lets them back).
          quiesce();
          if(!own(g.tracks[c.track])){deferred=c;return;}
          incoming->adopt(g.tracks[c.track],position,false,true);
          std::unique_ptr<TrackRuntime> swapped(incoming);
          g.tracks.slot(c.track).swap(swapped);
          (void)retiredTracks.push(swapped.release());
          break;
        }
        case Kind::Revision:if(active)active->impl_->timeline.revision=static_cast<std::uint64_t>(c.frame);break;
        case Kind::RustSync:if((c.flags!=0)!=rustActive)quiesce();rustActive=c.flags!=0;rustAllowed=static_cast<std::uint64_t>(c.frame);break;
      }
      lastTicket=c.ticket;
    }
  }
  // Dynamics inserts: a two-bucket window (each ~25 ms) keeps the loudest input and
  // the lowest gain of the last 25-50 ms, so a 25 Hz snapshot poll never misses a
  // transient, and input/gain come from the same window (the live dot sits on the curve).
  void publishDynamics(std::uint32_t frames)noexcept {
    std::uint32_t slot=0;
    meterFrames+=frames;const bool rotate=meterFrames>=rate/40;if(rotate)meterFrames=0;
    const auto hold=[&](std::uint32_t id,float peak,float gain){
      if(heldIds[slot]!=id){heldIds[slot]=id;heldInput[slot]=lastInput[slot]=0;heldGain[slot]=lastGain[slot]=1;}
      heldInput[slot]=std::max(heldInput[slot],peak);heldGain[slot]=std::min(heldGain[slot],gain);
      published.dynamicsIds[slot].store(id,std::memory_order_relaxed);
      published.dynamicsInput[slot].store(std::max(heldInput[slot],lastInput[slot]),std::memory_order_relaxed);
      published.dynamicsGain[slot].store(std::min(heldGain[slot],lastGain[slot]),std::memory_order_relaxed);
      if(rotate){lastInput[slot]=heldInput[slot];lastGain[slot]=heldGain[slot];heldInput[slot]=0;heldGain[slot]=1;}
      ++slot;
    };
#if GARAK_RUST
    if(active&&rustRendered) {
      std::array<GarakRsDynamicsReading,EngineSnapshot::maxDynamicsReadings>readings{};
      const auto count=garak_rs_engine_take_dynamics(rust->handle,readings.data(),static_cast<std::uint32_t>(readings.size()));
      for(std::uint32_t i=0;i<count;++i)hold(static_cast<std::uint32_t>(readings[i].track)<<16|readings[i].insert,readings[i].input,readings[i].gain);
      published.dynamicsCount.store(slot,std::memory_order_relaxed);
      return;
    }
#endif
    if(active)for(std::size_t t=0;t<active->impl_->tracks.size()&&t<65535;++t)for(auto&insert:active->impl_->tracks[t].inserts) {
      auto*tap=insert.builtin?insert.builtin->dynamics():nullptr;
      if(!tap||slot>=EngineSnapshot::maxDynamicsReadings)continue;
      float peak=0,gain=1;tap->take(peak,gain);
      hold(static_cast<std::uint32_t>(t)<<16|insert.source,peak,gain);
    }
    published.dynamicsCount.store(slot,std::memory_order_relaxed);
  }
  // Clicks after the master bus and meters: monitor only (offline engines never click).
  void renderClicks(float* out,std::uint32_t count,bool countingIn)noexcept {
    if(offline)return;
    const float gain=clicks&&clicks->sampleRate==rate?metronomeGain:0.f;
    if(gain<=0){if(countingIn)countInElapsed+=count;return;}
    clickPlayer.mix(out,count,gain);
    if(active) {
      const auto&t=active->impl_->timeline;
      // The count-in clicks evenly at the tempo and in the meter where the transport starts; the transport
      // follows the tempo map and accents each bar's first pulse across meter changes (docs/METER_MAP.md).
      const auto&tempo=active->impl_->tempo;const auto&meters=active->impl_->meters;const bool mapped=!t.tempoMap.empty();
      if(countingIn) {
        const double startBeat=mapped?tempo.beatAtFrame(static_cast<double>(position),rate):static_cast<double>(position)*t.bpm/(60.0*rate);
        const auto&meter=t.meterMap.empty()?MeterEvent{0,t.timeSigNumerator,t.timeSigDenominator,0}:meters.at(startBeat);
        metronome::clicks(metronome::grid(rate,mapped?tempo.bpmAt(startBeat):t.bpm,meter.numerator,meter.denominator),*clicks,clickPlayer,out,countInElapsed,count,gain,countInLength);
      }
      else if(metronomeOn&&playing&&position<t.lengthFrames) {
        if(t.meterMap.empty())metronome::clicks(metronome::grid(rate,t.bpm,t.timeSigNumerator,t.timeSigDenominator,mapped?&tempo:nullptr),*clicks,clickPlayer,out,position,count,gain);
        else metronome::meterClicks(meters,rate,t.bpm,mapped?&tempo:nullptr,*clicks,clickPlayer,out,position,count,gain);
      }
    }
    if(countingIn)countInElapsed+=count;
  }
  void publish(float masterPeak)noexcept {
    published.frame.store(position,std::memory_order_relaxed);published.playing.store(playing||countInRemaining>0,std::memory_order_relaxed);published.ready.store(active!=nullptr,std::memory_order_relaxed);
    const auto count=active?active->impl_->tracks.size():0;
    published.trackCount.store(static_cast<std::uint32_t>(count),std::memory_order_relaxed);
    published.revision.store(active?active->impl_->timeline.revision:0,std::memory_order_relaxed);
    published.latency.store(active?active->impl_->latency:0,std::memory_order_relaxed);
    published.senderLatency.store(active?active->impl_->senderLatency:0,std::memory_order_relaxed);
    for(std::size_t i=0;i<count;++i)published.trackPeaks[i].store(active->impl_->tracks[i].meter,std::memory_order_relaxed);
    published.aheadTracks.store(aheadTracks,std::memory_order_relaxed);published.aheadResyncs.store(aheadResyncs,std::memory_order_relaxed);
    published.masterPeak.store(masterPeak,std::memory_order_relaxed);published.voiceOverflows.store(voiceOverflows,std::memory_order_relaxed);published.invalidSamples.store(invalidSamples,std::memory_order_relaxed);
    published.recording.store(recording,std::memory_order_relaxed);published.recordingStart.store(recordingStart,std::memory_order_relaxed);
    published.recorded.store(recordedFrames,std::memory_order_relaxed);published.dropped.store(droppedFrames,std::memory_order_relaxed);
    publishedRust.store(rustRendered,std::memory_order_relaxed);
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

namespace {
// Control thread (prepare): resolves each route to a graph index, turns loops and missing sources into
// silence (Kind::None), marks the master feed, allocates tap/route buffers and orders tracks by level so
// every source renders before the tracks that take it. Mirrors src/core/trackRouting.ts.
void prepareRoutes(PtrList<TrackRuntime>& tracks,std::vector<std::uint32_t>& levelOrder,std::vector<std::uint32_t>& levelStart,std::uint32_t& masterLevel,std::uint32_t maxBlock) {
  const auto count=tracks.size();
  std::vector<std::int32_t> source(count,-1);
  for(std::size_t i=0;i<count;++i) {
    auto&t=tracks[i];const auto&route=t.timeline.route;
    if(!route||t.timeline.source.kind!=TrackSource::Kind::Audio||t.isReturn)continue;
    t.routed=true;t.routeKind=route->kind;t.routeTap=route->tap;
    if(route->kind==TrackRoute::Kind::Track) {
      // Return tracks are never route sources (docs/SENDS_RETURNS.md): a route naming one records silence.
      for(std::size_t j=0;j<count;++j)if(j!=i&&!tracks[j].isReturn&&tracks[j].timeline.id==route->trackId){source[i]=static_cast<std::int32_t>(j);break;}
      if(source[i]<0)t.routeKind=TrackRoute::Kind::None;
    }
  }
  // Sends: each feeds an existing return (never itself; returns never send). One feed per send.
  for(std::size_t i=0;i<count;++i) {
    if(tracks[i].isReturn)continue;
    for(const auto&send:tracks[i].timeline.sends)
      for(std::size_t r=0;r<count;++r)if(r!=i&&tracks[r].isReturn&&tracks[r].timeline.id==send.returnId) {
        std::int32_t lane=-1;
        const auto& lanes=tracks[i].timeline.automation;
        for(std::size_t l=0;l<lanes.size();++l)if(lanes[l].target==AutomationLane::Target::Send&&lanes[l].returnId==send.returnId&&!lanes[l].points.empty()){lane=static_cast<std::int32_t>(l);break;}
        tracks[r].feeds.push_back({static_cast<std::int32_t>(i),send.pre,send.gain,tracks[i].timeline.audible||!send.pre?static_cast<double>(send.gain):0.0,lane,0});
        break;
      }
  }
  // Each track has one input: a loop is a chain that returns to its start. Break it at that track.
  for(std::size_t i=0;i<count;++i) {
    std::size_t steps=0;
    for(auto at=source[i];at>=0&&steps<=count;at=source[static_cast<std::size_t>(at)],++steps)
      if(static_cast<std::size_t>(at)==i){source[i]=-1;tracks[i].routeKind=TrackRoute::Kind::None;break;}
  }
  for(std::size_t i=0;i<count;++i){if(tracks[i].routeKind!=TrackRoute::Kind::Track)source[i]=-1;tracks[i].routeSource=source[i];}
  // Master-resampling tracks and everything downstream of them stay out of the master feed.
  for(std::size_t i=0;i<count;++i) {
    std::size_t steps=0;bool excluded=tracks[i].routeKind==TrackRoute::Kind::Master;
    for(auto at=source[i];!excluded&&at>=0&&steps<=count;at=source[static_cast<std::size_t>(at)],++steps)excluded=tracks[static_cast<std::size_t>(at)].routeKind==TrackRoute::Kind::Master;
    tracks[i].inMasterFeed=!excluded;
  }
  // A return fed by a track outside the master feed carries the resampled signal too.
  for(auto&t:tracks)if(t.isReturn)for(const auto&f:t.feeds)if(!tracks[static_cast<std::size_t>(f.sender)].inMasterFeed){t.inMasterFeed=false;break;}
  // Levels: feed tracks by their chain depth, master resamplers above every feed track, then theirs.
  std::vector<std::int32_t> level(count,-1);
  const std::function<std::int32_t(std::size_t,std::size_t)> depth=[&](std::size_t i,std::size_t guard)->std::int32_t {
    if(level[i]>=0)return level[i];
    if(guard>count)return 0;
    std::int32_t value=0;
    if(source[i]>=0)value=depth(static_cast<std::size_t>(source[i]),guard+1)+1;
    else if(tracks[i].routeKind==TrackRoute::Kind::Master){value=0;for(std::size_t j=0;j<count;++j)if(tracks[j].inMasterFeed)value=std::max(value,depth(j,guard+1)+1);}
    else if(tracks[i].isReturn){value=0;for(const auto&f:tracks[i].feeds)value=std::max(value,depth(static_cast<std::size_t>(f.sender),guard+1)+1);}
    return level[i]=value;
  };
  std::int32_t top=0;
  for(std::size_t i=0;i<count;++i)top=std::max(top,depth(i,0));
  levelOrder.clear();levelStart.clear();masterLevel=std::numeric_limits<std::uint32_t>::max();
  for(std::int32_t l=0;l<=top;++l) {
    levelStart.push_back(static_cast<std::uint32_t>(levelOrder.size()));
    for(std::size_t i=0;i<count;++i)if(level[i]==l) {
      levelOrder.push_back(static_cast<std::uint32_t>(i));tracks[i].routeLevel=static_cast<std::uint32_t>(l);
      if(tracks[i].routeKind==TrackRoute::Kind::Master)masterLevel=std::min(masterLevel,static_cast<std::uint32_t>(l));
    }
  }
  levelStart.push_back(static_cast<std::uint32_t>(levelOrder.size()));
  const auto samples=static_cast<std::size_t>(maxBlock)*2;
  for(std::size_t i=0;i<count;++i) {
    auto&t=tracks[i];
    if(t.routed)t.routeInput.assign(samples,0.f);
    if(source[i]>=0) {
      auto&s=tracks[static_cast<std::size_t>(source[i])];
      if(t.routeTap==TrackRoute::Tap::PreFx&&s.preTap.empty())s.preTap.assign(samples,0.f);
      if(t.routeTap==TrackRoute::Tap::PostFx&&s.postTap.empty())s.postTap.assign(samples,0.f);
      // The post-fader tap is the output before the return-latency delay (equal to it when there is none).
      if(t.routeTap==TrackRoute::Tap::PostFader&&s.outputDelayFrames&&s.faderTap.empty())s.faderTap.assign(samples,0.f);
    }
    if(t.isReturn) {
      t.returnInput.assign(samples,0.f);
      for(const auto&f:t.feeds) {
        auto&s=tracks[static_cast<std::size_t>(f.sender)];
        if(f.pre&&s.postTap.empty())s.postTap.assign(samples,0.f);
        if(!f.pre&&s.faderTap.empty())s.faderTap.assign(samples,0.f);
      }
    }
  }
}
} // namespace

namespace {
// Everything one track resolves on the control thread: its runtime and the facts update() needs later.
struct TrackBuild {
  TrackRuntime track;
  ControlTrack info;
  std::size_t wavetableTableMemory=0;
};
// The previous track's IEUM WAVE instrument is kept (identical source): update() swaps it in at the swap.
struct ReusedInstrument { double tail=0; std::size_t memory=0; };
TrackBuild buildTrack(const ProjectTimeline& p,const TrackTimeline& t,const AssetStore& assets,const SampleSetStore& sets,const PluginResolver& resolvePlugin,
                      WavetableResources& wavetables,std::uint32_t maxBlock,std::set<const ieum::wave::PreparedWavetableSet*>& waveTables,const ReusedInstrument* reuse) {
  TrackBuild build;auto& track=build.track;auto& info=build.info;
  track.timeline=t;track.isReturn=t.isReturn;track.sampleRate=p.sampleRate;track.projectLength=p.lengthFrames;track.contextLowLatency=p.lowLatencyMonitoring;
  require(!t.isReturn||(t.source.kind==TrackSource::Kind::Audio&&t.notes.empty()&&t.audio.empty()&&t.sends.empty()),"Return tracks are audio buses without events or sends");
  require(t.sends.size()<=256,"Native track exceeds send limit");
  for(const auto&send:t.sends)checked(send.gain,0,4,"Invalid native send gain");
  track.fader=t.audible?t.gain:0;track.panValue=t.pan;
  checked(t.gain,0,2,"Invalid native track gain");checked(t.pan,-1,1,"Invalid native pan");
  track.buffer.resize(static_cast<std::size_t>(maxBlock)*2);
  require(t.source.kind!=TrackSource::Kind::Audio||t.notes.empty(),"Audio tracks cannot contain instrument notes");
  require(t.source.kind==TrackSource::Kind::Audio||t.audio.empty(),"Instrument tracks cannot contain audio windows");
  const bool rustSource=t.source.kind==TrackSource::Kind::BuiltinSynth&&rustInstrumentId(t.source.instrumentId);
  if((t.source.kind==TrackSource::Kind::BuiltinSynth||t.source.kind==TrackSource::Kind::BuiltinSampled)&&!rustSource)track.synth=compileSynth(t.source);
  // An explicitly disabled source is retained in the immutable recipe but
  // needs neither its sample library nor a loadable third-party plug-in.
  if(!t.enabled)return build;
  for(const auto&e:t.inserts)if(e.enabled)info.memory+=dsp::estimateEffectMemory(e.type,p.sampleRate);
  double trackTail=0;
  const bool wave=t.source.kind==TrackSource::Kind::NativeWavetable;
  if(wave) {
    require(p.sampleRate>=22050,"IEUM WAVE requires a sample rate of 22050..192000 Hz");
    require(t.source.instrumentId=="wavetable"&&!t.source.isKit,"Invalid IEUM WAVE source");
    if(reuse) {
      track.reuseInstrument=true;track.stereoSource=true;trackTail=reuse->tail;
      info.instrumentTail=reuse->tail;info.wavetableMemory=reuse->memory;
    } else {
      auto prepared=wavetables.prepare(t.source.patchData);
      const auto tableBytes=waveTables.insert(prepared.tables.get()).second?prepared.tables->bytes():0;
      const auto bytes=WavetableProcessor::instanceMemory(p.sampleRate,maxBlock)+tableBytes+t.source.patchData.size()*3;
      info.wavetableMemory=bytes;build.wavetableTableMemory=tableBytes;
      track.wavetable=std::make_shared<WavetableProcessor>(std::move(prepared),p.sampleRate,maxBlock);
      track.instrument=track.wavetable;track.stereoSource=true;trackTail=track.wavetable->tailSeconds();info.instrumentTail=trackTail;
    }
    info.memory+=info.wavetableMemory;
  }
  if(rustSource) {
    // 옥구슬 EP / 한밤 106: one Rust implementation shared with the web worklet (rust_instrument.hpp).
    require(!t.source.isKit,"Invalid built-in instrument source");
    track.rust=makeRustInstrument(t.source.instrumentId,t.source.params,p.sampleRate,maxBlock);
    track.instrument=track.rust;track.stereoSource=true;trackTail=track.rust->tailSeconds();info.instrumentTail=trackTail;
    info.memory+=rustInstrumentMemory(maxBlock);
  }
  if(t.source.kind==TrackSource::Kind::BuiltinSampled){const auto set=sets.find(t.source.sampleSetId);require(set!=sets.end(),"Required native sample set is not registered");require(set->second.isKit==t.source.isKit,"Sample kind differs from instrument");track.samples=resolveSet(set->second,assets);info.set=set->second;
    for(const auto&z:track.samples.zones){info.assets.push_back(z.asset);track.stereoSource|=z.asset->channels>1;
      if(t.source.isKit)trackTail=std::max(trackTail,(static_cast<double>(z.asset->frames())/z.asset->sampleRate-track.samples.startOffset)/std::pow(2,z.zone.tune/1200+track.synth.tune/12)*track.synth.decay+.014);
    }
    for(const auto&z:track.samples.releases){info.assets.push_back(z.asset);track.stereoSource|=z.asset->channels>1;
      trackTail=std::max(trackTail,(static_cast<double>(z.asset->frames())/z.asset->sampleRate-track.samples.startOffset)/std::pow(2,(z.zone.lo-z.zone.root)/12.0+z.zone.tune/1200));
    }
  }
  if(t.source.kind==TrackSource::Kind::Vst3){require(static_cast<bool>(resolvePlugin),"No native VST3 host is available");track.instrument=resolvePlugin(t.source.plugin,p.sampleRate,maxBlock);require(static_cast<bool>(track.instrument),"VST3 instrument could not be prepared");track.latency=track.instrument->latencyFrames();track.stereoSource=true;trackTail=checked(track.instrument->tailSeconds(),0,3600,"Invalid plugin tail time");require(track.latency<=p.sampleRate*30,"Plugin latency exceeds native memory budget");}
  if((t.source.kind==TrackSource::Kind::BuiltinSynth||t.source.kind==TrackSource::Kind::BuiltinSampled)&&!rustSource)trackTail=std::max(trackTail,t.source.isKit?(track.synth.kind==Synth::Kind::Drums?.62*track.synth.decay+.004:0):track.synth.release*1.5+.02);
  info.sourceLatency=track.latency;info.sourceTail=trackTail;info.sourceStereo=track.stereoSource;
  // Plug-in instruments (VST3, IEUM WAVE) take notes and controllers as sample-accurate events.
  const bool pluginSource=track.instrument!=nullptr||track.reuseInstrument;
  std::set<std::int32_t>noteIds;
  for(const auto&n:t.notes){require(noteIds.insert(n.id).second&&n.pitch>=0&&n.pitch<=127&&n.onFrame>=-p.lengthFrames&&n.offFrame>n.onFrame&&n.offFrame>0&&n.offFrame<=p.lengthFrames&&n.limitFrame>=n.offFrame&&n.limitFrame<=p.lengthFrames,"Invalid native note event");checked(n.velocity,0,2,"Invalid native note velocity");
    if(pluginSource&&n.velocity>0){track.events.push_back({n.onFrame,{PluginEvent::Type::NoteOn,0,n.id,static_cast<std::uint8_t>(n.pitch),0,wave?n.velocity:std::min(1.f,n.velocity),0}});track.events.push_back({n.offFrame,{PluginEvent::Type::NoteOff,0,n.id,static_cast<std::uint8_t>(n.pitch),0,0,0}});}
  }
  std::stable_sort(track.timeline.notes.begin(),track.timeline.notes.end(),[](const NotePair&a,const NotePair&b){return a.onFrame<b.onFrame||(a.onFrame==b.onFrame&&a.id<b.id);});
  for(std::size_t i=0;i<t.controls.size();++i){
    const auto&c=t.controls[i];
    require(c.frame>=0&&c.frame<=p.lengthFrames&&validControllerValue(c.controller,c.value)&&(!i||t.controls[i-1].frame<=c.frame),"Invalid native control event");
    // Built-in voices read timeline.controls while rendering. The bend range is a built-in meta controller.
    if(!pluginSource||(c.controller==bendRangeController&&!track.rust))continue;
    PluginEvent e{};e.type=PluginEvent::Type::Controller;e.parameterId=c.controller;e.value=normalizedControllerValue(c.controller,c.value);
    track.events.push_back({c.frame,e});
  }
  std::stable_sort(track.events.begin(),track.events.end(),[](const TimedPluginEvent&a,const TimedPluginEvent&b){return a.frame<b.frame||(a.frame==b.frame&&eventOrder(a.event.type)<eventOrder(b.event.type));});
  for(std::size_t begin=0,end=0;end<track.events.size();++end){
    while(track.events[end].frame-track.events[begin].frame>=maxBlock)++begin;
    // Leave room for all queued live notes and their auto-release events.
    require(end-begin+1<=maxPluginEvents-maxVoices*2-1,"Instrument note density exceeds the bounded event buffer");
  }
  for(const auto&w:t.audio){require(w.startFrame>=0&&w.endFrame>w.startFrame&&(w.endFrame<=p.lengthFrames||w.freeze)&&w.clipLengthFrames>0&&w.clipOffsetFrames>=0&&w.fadeInFrames>=0&&w.fadeOutFrames>=0&&w.fadeInCurve>=0&&w.fadeInCurve<=4&&w.fadeOutCurve>=0&&w.fadeOutCurve<=4,"Invalid native audio window");
    checked(w.gain,0,16,"Invalid audio window gain");checked(w.sourceStartFrame,0,1e15,"Invalid audio source offset");checked(w.sourceSampleRate,8000,192000,"Invalid source sample rate");
    auto a=resolveAsset(assets,w.assetId);require(w.sourceSampleRate==a->sampleRate&&w.sourceStartFrame<a->frames(),"Audio window does not match registered PCM");
    track.stereoSource|=a->channels>1;
    // A frozen render already carries its track's release and effect tails: the window states that own tail.
    if(w.freeze)trackTail=std::max(trackTail,w.tailSeconds);
    info.assets.push_back(a);
    track.windows.push_back({w,std::move(a)});
  }
  std::stable_sort(track.windows.begin(),track.windows.end(),[](const ResolvedWindow&a,const ResolvedWindow&b){return a.window.startFrame<b.window.startFrame;});
  std::set<std::string>insertIds;
  for(const auto&e:t.inserts){require(!e.id.empty()&&insertIds.insert(e.id).second,"Duplicate native insert ID");if(!e.enabled)continue;
    InsertRuntime effect;effect.source=static_cast<std::uint16_t>(&e-t.inserts.data());
    if(e.type=="vst3"){require(static_cast<bool>(resolvePlugin),"No native VST3 host is available");effect.plugin=resolvePlugin(e.plugin,p.sampleRate,maxBlock);require(static_cast<bool>(effect.plugin),"VST3 effect could not be prepared");const auto latency=effect.plugin->latencyFrames();require(latency<=p.sampleRate*30,"Plugin latency exceeds native memory budget");track.latency+=latency;const auto tail=checked(effect.plugin->tailSeconds(),0,3600,"Invalid plugin tail time");trackTail+=tail;track.stereoEffects=true;
      info.pluginInserts.resize(t.inserts.size());info.pluginInserts[effect.source]={latency,tail};}
    else {
      effect.builtin=dsp::makeEffect(e.type,e.params,p.sampleRate,p.bpm);track.latency+=effect.builtin->latencyFrames();trackTail+=effect.builtin->tailSeconds();
      track.stereoEffects|=e.type=="reverb"||e.type=="guitar-rig"||(e.type=="delay"&&e.params.count("mode")&&e.params.at("mode")>=.5)||e.type=="chorus"||e.type=="phaser"||e.type=="flanger"||e.type=="tremolo"||e.type=="utility";
      effect.builtin->sharedResources(info.shared);
      effect.control=std::make_unique<dsp::EffectControl>(e.type,e.params);
    }
    require(track.latency<=p.sampleRate*30,"Plugin latency exceeds native memory budget");track.inserts.push_back(std::move(effect));
  }
  prepareAutomation(track,t);
  info.tail=trackTail;info.latency=track.latency;
  return build;
}
// Shared immutable data (reverb spectra) counted once per graph.
std::size_t sharedMemory(const std::vector<const ControlTrack*>& tracks) {
  std::set<const void*> seen;std::size_t total=0;
  for(const auto*t:tracks)for(const auto&r:t->shared)if(seen.insert(r.key).second)total+=r.bytes;
  return total;
}
bool aheadCandidate(const TrackRuntime& t) {
  const bool vst3=(t.instrument&&!t.wavetable&&!t.rust)||std::any_of(t.inserts.begin(),t.inserts.end(),[](const InsertRuntime&i){return i.plugin!=nullptr;});
  return t.timeline.enabled&&!vst3;
}
bool routingTrack(const TrackRuntime& t) {
  // Routed tracks read a source tap in the same block, and pre/post-FX taps are not in the ring.
  // Sends and returns likewise read a tap in the same block.
  return t.routed||!t.preTap.empty()||!t.postTap.empty()||!t.faderTap.empty()||t.isReturn;
}
} // namespace

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
  // Checked before any processor is built: a refused project costs no impulse responses.
  require(noteCount<=100000&&windowCount<=8192&&estimated<=memoryLimit,"Native project exceeds bounded memory/event limits");
  auto result=std::make_unique<PreparedProject::Impl>(p);result->tracks.reserve(p.tracks.size());
  auto recipe=std::make_unique<ControlRecipe>();recipe->timeline=headerOf(p);recipe->timeline.tracks.reserve(p.tracks.size());recipe->tracks.reserve(p.tracks.size());
  for(const auto&t:p.tracks) {
    auto build=buildTrack(p,t,assets,sets,resolvePlugin,impl_->wavetableResources,impl_->maxBlock,waveTables,nullptr);
    if(build.info.wavetableMemory){estimated+=build.info.wavetableMemory;require(estimated<=memoryLimit,"IEUM WAVE exceeds native memory budget");}
    result->wavetableMemory+=build.info.wavetableMemory;result->wavetableTableMemory+=build.wavetableTableMemory;
    recipe->tracks.push_back(std::move(build.info));recipe->timeline.tracks.push_back(t);
    result->tracks.push_back(std::move(build.track));
  }
  {std::vector<const ControlTrack*> all;for(const auto&t:recipe->tracks)all.push_back(&t);estimated+=sharedMemory(all);}
  require(estimated<=memoryLimit,"Native project exceeds bounded memory/event limits");
  for(std::size_t i=0;i<result->tracks.size();++i){result->tail=std::max(result->tail,recipe->tracks[i].tail+.15);if(!p.tracks[i].isReturn)result->trackTail=std::max(result->trackTail,recipe->tracks[i].tail);}
  // Send/return plug-in delay compensation (docs/SENDS_RETURNS.md). Senders align to the largest non-return
  // latency S (as before); a fed return R adds its own chain latency after that, so every return is padded
  // to the largest fed return latency L and every non-return track's output waits L after its taps. The
  // master then hears dry and return paths aligned at S + L; with no latent return this is the former PDC.
  std::set<std::string> fed;
  for(const auto&t:p.tracks)if(!t.isReturn)for(const auto&send:t.sends)fed.insert(send.returnId);
  std::uint32_t senderLatency=0,returnLatency=0;
  for(const auto&t:result->tracks) {
    if(!t.isReturn)senderLatency=std::max(senderLatency,t.latency);
    else if(fed.contains(t.timeline.id))returnLatency=std::max(returnLatency,t.latency);
  }
  result->senderLatency=senderLatency;result->latency=senderLatency+returnLatency;
  recipe->senderLatency=senderLatency;recipe->returnLatency=returnLatency;
  // A return's tail continues from its senders' tails.
  for(std::size_t r=0;r<result->tracks.size();++r) {
    if(!result->tracks[r].isReturn||!result->tracks[r].timeline.enabled)continue;
    double senders=0;
    for(std::size_t i=0;i<p.tracks.size();++i)if(!p.tracks[i].isReturn)for(const auto&send:p.tracks[i].sends)if(send.returnId==p.tracks[r].id)senders=std::max(senders,recipe->tracks[i].tail);
    result->tail=std::max(result->tail,recipe->tracks[r].tail+senders+.15);
  }
  estimated+=static_cast<std::size_t>(result->latency)*p.tracks.size()*16;
  require(estimated<=memoryLimit,"Plugin compensation exceeds native memory budget");
  for(auto&t:result->tracks) {
    if(t.isReturn)t.compensation=CompensationDelay(t.latency<returnLatency?returnLatency-t.latency:0);
    else {t.compensation=CompensationDelay(senderLatency-t.latency);t.outputDelayFrames=returnLatency;t.outputDelay=CompensationDelay(returnLatency);}
  }
  prepareRoutes(result->tracks,result->levelOrder,result->levelStart,result->masterLevel,impl_->maxBlock);
  if(impl_->rustMode) {
    std::set<const PcmAsset*> seen;
    const auto keep=[&](const std::string& id){const auto found=assets.find(id);if(found!=assets.end()&&found->second&&seen.insert(found->second.get()).second)result->rustAssets.push_back(found->second);};
    for(const auto&t:p.tracks)for(const auto&w:t.audio)keep(w.assetId);
#if GARAK_RUST
    result->rustSets=rustSampleSets(p,sets);
    for(const auto&s:result->rustSets)for(const auto*zones:{&s.zones,&s.releaseZones})for(const auto&z:*zones)keep(z.assetId);
#endif
  }
  for(std::size_t i=0;i<result->tracks.size();++i){const auto&t=result->tracks[i];recipe->tracks[i].routing=routingTrack(t);recipe->tracks[i].aheadEligible=aheadCandidate(t)&&!recipe->tracks[i].routing;}
  if(impl_->aheadBlocks&&!impl_->offline) {
    // Rings hold the current device buffer plus the ahead window. VST3 tracks
    // stay in the callback: their editors feed parameters that must be heard now.
    const auto capacity=std::min<std::uint32_t>(65536,std::max<std::uint32_t>(64,impl_->aheadHint)*(1+impl_->aheadBlocks));
    const auto bytes=(static_cast<std::size_t>(capacity)+std::size_t{impl_->maxBlock}*2)*2*sizeof(float);
    std::size_t budget=aheadMemoryBudget;
    for(std::size_t i=0;i<result->tracks.size();++i) {
      auto&t=result->tracks[i];
      if(!recipe->tracks[i].aheadEligible)continue;
      if(bytes>budget)break;
      budget-=bytes;t.ahead=std::make_unique<AheadState>(capacity,impl_->maxBlock);
    }
  }
  result->recipe=std::move(recipe);
  return std::unique_ptr<PreparedProject>(new PreparedProject(std::move(result)));
}

namespace {
// Control thread: link every track of \`next\` to the same track id of the running graph (\`last\`), so the swap
// carries voices, tails, controllers and live notes over per track instead of by position.
void linkGraph(PtrList<TrackRuntime>& tracks,bool& headerChanged,std::vector<std::int32_t>& successor,const ControlRecipe& recipe,const ControlRecipe& last) {
  headerChanged=!sameTiming(recipe.timeline,last.timeline);
  std::unordered_map<std::string_view,std::size_t> previous;
  for(std::size_t i=0;i<last.timeline.tracks.size();++i)previous.emplace(last.timeline.tracks[i].id,i);
  successor.assign(last.timeline.tracks.size(),-1);
  for(std::size_t i=0;i<tracks.size();++i) {
    auto&t=tracks[i];const auto&neu=recipe.timeline.tracks[i];
    const auto found=previous.find(neu.id);
    if(found==previous.end())continue;
    const auto j=found->second;const auto&old=last.timeline.tracks[j];
    const auto&oldInfo=last.tracks[j];const auto&newInfo=recipe.tracks[i];
    t.predecessor=static_cast<std::int32_t>(j);successor[j]=static_cast<std::int32_t>(i);
    t.sameSource=old.enabled&&neu.enabled&&sameSourceIdentity(old.source,neu.source)&&oldInfo.set==newInfo.set&&
      (neu.source.kind!=TrackSource::Kind::BuiltinSampled||oldInfo.assets==newInfo.assets);
    bool sameEvents=old.notes==neu.notes&&old.controls==neu.controls&&old.audio==neu.audio&&old.automation==neu.automation&&oldInfo.assets==newInfo.assets&&old.inserts.size()==neu.inserts.size();
    // A moving render-ahead ring already holds this chain's output: the chain must be the same too.
    for(std::size_t k=0;sameEvents&&k<neu.inserts.size();++k)sameEvents=old.inserts[k].id==neu.inserts[k].id&&old.inserts[k].type==neu.inserts[k].type&&old.inserts[k].enabled==neu.inserts[k].enabled;
    t.identical=sameEvents&&old.enabled==neu.enabled&&(t.sameSource||!neu.enabled)&&old.isReturn==neu.isReturn;
    t.insertOrigin=insertOrigins(old,neu);
    if(!t.identical&&old.notes!=neu.notes)t.removedNotes=removedNotes(old.notes,neu.notes);
  }
}
} // namespace

std::uint64_t RenderEngine::submit(std::unique_ptr<PreparedProject> project) {
  require(project!=nullptr,"Cannot submit an empty native graph");collectRetired();
  auto&graph=*project->impl_;
  require(graph.recipe!=nullptr,"Native graph was already submitted");
  auto recipe=std::move(graph.recipe);
  graph.serial=impl_->nextTicket;
  const auto*last=impl_->lastSubmittedRecipe.get();
  // Any graph of the same project continues the running one: each track carries its state over by id.
  const bool continues=last&&last->timeline.projectId==recipe->timeline.projectId&&last->timeline.sampleRate==recipe->timeline.sampleRate;
  graph.preserveFrom=continues?impl_->lastSubmittedSerial:0;
  if(continues)linkGraph(graph.tracks,graph.headerChanged,graph.successor,*recipe,*last);
  // A graph can keep its predecessor's table set through the 20 ms crossfade
  // after that predecessor is collected. Include those bytes until this graph
  // retires; shared tables are intentionally conservatively counted twice.
  if(graph.preserveFrom)graph.wavetableMemory+=impl_->lastSubmittedWavetableTableMemory;
  require(impl_->retainedWavetableMemory+graph.wavetableMemory<=memoryLimit,
    "Pending IEUM WAVE updates exceed native memory budget");
  // GARAK_RUST_ENGINE: hand the same plan to the Rust graph first (update() does this itself), so a strict
  // refusal leaves the running graph alone.
  bool rustEnabled=false;
  if(impl_->rustMode&&!impl_->rustInUpdate)rustEnabled=impl_->rustApply(recipe->timeline,graph.rustAssets,graph.rustSets,recipe.get());
  Impl::Command c;c.kind=Impl::Kind::Graph;c.graph=project.get();
  const auto serial=impl_->enqueue(c);
  if(!serial)throw std::runtime_error("Native graph command queue is full");
  if(impl_->rustMode&&!impl_->rustInUpdate)impl_->enqueueRustSync(rustEnabled);
  impl_->lastSubmittedRecipe=std::move(recipe);impl_->lastSubmittedSerial=serial;
  impl_->lastSubmittedWavetableTableMemory=graph.wavetableTableMemory;
  impl_->retainedWavetableMemory+=graph.wavetableMemory;
  (void)project.release();
  return serial;
}

UpdateResult RenderEngine::update(const ProjectTimeline& p,const AssetStore& assets,const SampleSetStore& sets,const PluginResolver& resolvePlugin) {
  auto&e=*impl_;
  if(!e.rustMode)return updateGraph(p,assets,sets,resolvePlugin);
  // GARAK_RUST_ENGINE: the Rust graph classifies the same plan itself (docs/RENDER_DIFF_PROTOCOL.md 8); its
  // commands apply in the block where this update's last C++ command does. The C++ graph is updated first: its
  // recipe then holds the host nodes' delays and tails (VST3 plug-ins are prepared there). A strict refusal
  // known up front (an ineligible graph) still leaves the running graph alone.
  collectRetired();
#if GARAK_RUST
  if(e.rustMode==2&&!rustIneligibility(p,e.rustHostInstruments,e.rustRefuseInsert).empty())(void)e.rustApply(p,assets,rustSampleSets(p,sets),nullptr); // Throws.
#endif
  struct Scope{Impl&e;explicit Scope(Impl&x):e(x){e.rustInUpdate=true;}~Scope(){e.rustInUpdate=false;}};
  UpdateResult result;
  {Scope scope(e);result=updateGraph(p,assets,sets,resolvePlugin);}
  bool rustEnabled=false;
  try{
#if GARAK_RUST
    rustEnabled=e.rustApply(p,assets,rustSampleSets(p,sets),e.lastSubmittedRecipe.get());
#else
    rustEnabled=e.rustApply(p,assets,std::vector<SampleSet>{},e.lastSubmittedRecipe.get());
#endif
  }
  catch(...){(void)e.enqueueRustSync(false);throw;} // Strict: the C++ graph already renders the update.
  const auto ticket=e.enqueueRustSync(rustEnabled);
  if(ticket)result.ticket=ticket;
  return result;
}

UpdateResult RenderEngine::updateGraph(const ProjectTimeline& p,const AssetStore& assets,const SampleSetStore& sets,const PluginResolver& resolvePlugin) {
  collectRetired();
  auto&e=*impl_;
  auto*last=e.lastSubmittedRecipe.get();
  UpdateResult result;
  // Full path: a new graph whose tracks continue the running ones by id. Unchanged notes keep their ids.
  const auto full=[&]{
    ProjectTimeline staged=p;
    if(last&&last->timeline.projectId==p.projectId) {
      std::unordered_map<std::string_view,std::size_t> previous;
      for(std::size_t i=0;i<last->timeline.tracks.size();++i)previous.emplace(last->timeline.tracks[i].id,i);
      for(auto&t:staged.tracks){const auto found=previous.find(t.id);if(found!=previous.end())(void)renumberNotes(last->timeline.tracks[found->second].notes,t.notes);}
    }
    result.ticket=submit(prepare(staged,assets,sets,resolvePlugin));result.kind=UpdateResult::Kind::Full;
    return result;
  };
  if(!last||p.version!=last->timeline.version||p.projectId!=last->timeline.projectId||p.sampleRate!=last->timeline.sampleRate||!sameTiming(p,last->timeline)||
     p.lowLatencyMonitoring!=last->timeline.lowLatencyMonitoring||p.tracks.size()!=last->timeline.tracks.size())return full();
  for(std::size_t i=0;i<p.tracks.size();++i)if(p.tracks[i].id!=last->timeline.tracks[i].id)return full();
  checked(p.masterGain,0,2,"Invalid native master gain");
  // Classify every track against the running graph.
  struct ParamEdit { std::uint32_t insert; int control; double value; std::size_t timelineInsert; std::string param; };
  struct Plan { bool replace=false,mix=false; std::vector<std::size_t> sends; std::vector<ParamEdit> params; std::vector<const PluginSpec*> pluginParams; };
  std::vector<Plan> plans(p.tracks.size());
  std::size_t noteCount=0;
  for(std::size_t i=0;i<p.tracks.size();++i) {
    const auto&neu=p.tracks[i];const auto&old=last->timeline.tracks[i];const auto&info=last->tracks[i];auto&plan=plans[i];
    noteCount+=neu.notes.size();
    if(neu.isReturn!=old.isReturn||neu.route!=old.route||neu.sends.size()!=old.sends.size())return full();
    for(std::size_t s=0;s<neu.sends.size();++s) {
      if(neu.sends[s].returnId!=old.sends[s].returnId||neu.sends[s].pre!=old.sends[s].pre||sendLane(neu,neu.sends[s].returnId)!=sendLane(old,old.sends[s].returnId))return full();
      if(neu.sends[s].gain!=old.sends[s].gain){checked(neu.sends[s].gain,0,4,"Invalid native send gain");plan.sends.push_back(s);}
    }
    plan.mix=neu.gain!=old.gain||neu.pan!=old.pan||neu.mute!=old.mute||neu.solo!=old.solo||neu.soloSafe!=old.soloSafe||neu.audible!=old.audible||neu.unmutedAudible!=old.unmutedAudible;
    if(plan.mix){checked(neu.gain,0,2,"Invalid native track gain");checked(neu.pan,-1,1,"Invalid native pan");}
    bool replace=neu.enabled!=old.enabled||neu.directOut!=old.directOut||neu.preFader!=old.preFader||neu.input!=old.input||!sameNotes(neu.notes,old.notes)||neu.controls!=old.controls||neu.audio!=old.audio||neu.automation!=old.automation;
    if(!replace) {
      if(!(neu.source==old.source)) {
        // A VST3 instrument's parameter values reach the cached instance through the resolver, in place.
        auto a=neu.source,b=old.source;a.plugin.parameters.clear();b.plugin.parameters.clear();
        if(neu.source.kind==TrackSource::Kind::Vst3&&a==b){if(neu.enabled)plan.pluginParams.push_back(&neu.source.plugin);}else replace=true;
      }
    }
    if(!replace&&neu.inserts.size()!=old.inserts.size())replace=true;
    const auto runtime=runtimeInserts(neu);
    for(std::size_t k=0;!replace&&k<neu.inserts.size();++k) {
      const auto&a=neu.inserts[k];const auto&b=old.inserts[k];
      if(a.id!=b.id||a.type!=b.type||a.enabled!=b.enabled){replace=true;break;}
      if(a.type=="vst3"){
        if(!samePlugin(a.plugin,b.plugin))replace=true;
        else if(a.plugin.parameters!=b.plugin.parameters&&runtime[k]>=0)plan.pluginParams.push_back(&a.plugin);
        continue;
      }
      if(a.params==b.params)continue;
      if(runtime[k]<0){continue;} // Disabled insert: only the recipe changes.
      dsp::validateEffectParameters(a.type,a.params);
      std::set<std::string_view> names;for(const auto&[name,value]:a.params){(void)value;names.insert(name);}for(const auto&[name,value]:b.params){(void)value;names.insert(name);}
      for(const auto name:names) {
        const auto x=a.params.find(name),y=b.params.find(name);
        if(x!=a.params.end()&&y!=b.params.end()&&x->second==y->second)continue;
        if(x==a.params.end()||!dsp::liveEffectParameter(a.type,name)){replace=true;break;}
        plan.params.push_back({static_cast<std::uint32_t>(runtime[k]),dsp::effectParameterIndex(a.type,name),x->second,k,std::string(name)});
      }
    }
    // A re-registered PCM asset or sample set under the same id: the track resolves it again.
    if(!replace&&neu.enabled) {
      // Same order as buildTrack: sample zones (instrument tracks) or audio windows (audio tracks).
      std::vector<std::shared_ptr<const PcmAsset>> resolved;
      if(neu.source.kind==TrackSource::Kind::BuiltinSampled){
        const auto set=sets.find(neu.source.sampleSetId);
        if(set==sets.end()||!info.set||!(set->second==*info.set))replace=true;
        else for(const auto*zones:{&set->second.zones,&set->second.releaseZones})for(const auto&z:*zones){const auto a=assets.find(z.assetId);resolved.push_back(a==assets.end()?nullptr:a->second);}
      }
      for(const auto&w:neu.audio){const auto a=assets.find(w.assetId);resolved.push_back(a==assets.end()?nullptr:a->second);}
      if(!replace&&resolved!=info.assets)replace=true;
    }
    plan.replace=replace;
    if(replace){plan.mix=false;plan.params.clear();plan.pluginParams.clear();}
  }
  require(noteCount<=100000,"Native project exceeds bounded memory/event limits");
  // Build replacements (control thread); any that would change the graph's shape falls back to a full graph.
  struct Replacement { std::size_t index; std::unique_ptr<TrackRuntime> runtime; ControlTrack info; TrackTimeline timeline; };
  std::vector<Replacement> replacements;
  std::set<const ieum::wave::PreparedWavetableSet*> waveTables;
  for(std::size_t i=0;i<p.tracks.size();++i) {
    if(!plans[i].replace)continue;
    if(e.replacementsInFlight+replacements.size()+1>=Impl::retiredTrackCapacity)return full();
    const auto&old=last->timeline.tracks[i];const auto&info=last->tracks[i];
    TrackTimeline neu=p.tracks[i];
    const bool wave=neu.source.kind==TrackSource::Kind::NativeWavetable||old.source.kind==TrackSource::Kind::NativeWavetable;
    const bool sameWave=neu.source==old.source&&neu.enabled&&old.enabled;
    if(wave&&!sameWave)return full(); // IEUM WAVE patch changes keep their table crossfade on the graph path.
    auto removed=renumberNotes(old.notes,neu.notes);
    ReusedInstrument reuse{info.instrumentTail,info.wavetableMemory};
    auto build=buildTrack(p,neu,assets,sets,resolvePlugin,e.wavetableResources,e.maxBlock,waveTables,wave?&reuse:nullptr);
    if(build.info.latency!=info.latency)return full(); // Plug-in delay compensation of the whole graph changes.
    auto runtime=std::make_unique<TrackRuntime>(std::move(build.track));
    auto&t=*runtime;
    t.predecessor=static_cast<std::int32_t>(i);
    // Sampled voices point into the predecessor's resolved set: its zones must be the same PCM objects.
    t.sameSource=old.enabled&&neu.enabled&&sameSourceIdentity(old.source,neu.source)&&info.set==build.info.set&&
      (neu.source.kind!=TrackSource::Kind::BuiltinSampled||info.assets==build.info.assets);
    t.insertOrigin=insertOrigins(old,neu);
    t.removedNotes=std::move(removed);
    build.info.routing=info.routing;
    build.info.aheadEligible=aheadCandidate(t)&&!info.routing;
    t.aheadEligible=build.info.aheadEligible;
    if(old.isReturn)t.compensation=CompensationDelay(t.latency<last->returnLatency?last->returnLatency-t.latency:0);
    else {t.compensation=CompensationDelay(last->senderLatency-t.latency);t.outputDelay=CompensationDelay(last->returnLatency);}
    replacements.push_back({i,std::move(runtime),std::move(build.info),std::move(neu)});
  }
  if(!replacements.empty()) {
    // Memory budget of the graph with the replacements in place.
    std::vector<const ControlTrack*> projected;projected.reserve(last->tracks.size());
    std::size_t memory=0;
    for(std::size_t i=0,r=0;i<last->tracks.size();++i) {
      const auto&info=r<replacements.size()&&replacements[r].index==i?replacements[r++].info:last->tracks[i];
      memory+=info.memory;projected.push_back(&info);
    }
    memory+=sharedMemory(projected)+static_cast<std::size_t>(last->senderLatency+last->returnLatency)*p.tracks.size()*16;
    require(memory<=memoryLimit,"Native project exceeds bounded memory/event limits");
  }
  // Commands: per track its replacement, then mix, sends and parameters; then master gain and revision.
  std::unordered_map<std::string_view,std::size_t> index;
  for(std::size_t i=0;i<p.tracks.size();++i)index.emplace(p.tracks[i].id,i);
  std::vector<Impl::Command> commands;
  for(auto&r:replacements){Impl::Command c;c.kind=Impl::Kind::Replace;c.track=static_cast<std::uint32_t>(r.index);c.runtime=r.runtime.get();commands.push_back(c);}
  for(std::size_t i=0;i<p.tracks.size();++i) {
    const auto&neu=p.tracks[i];const auto&plan=plans[i];
    if(plan.mix){Impl::Command c;c.kind=Impl::Kind::Mix;c.track=static_cast<std::uint32_t>(i);c.value=neu.gain;c.pan=neu.pan;
      c.flags=(neu.audible?Impl::MixAudible:0u)|(neu.unmutedAudible?Impl::MixUnmutedAudible:0u)|(neu.mute?Impl::MixMute:0u)|(neu.solo?Impl::MixSolo:0u)|(neu.soloSafe?Impl::MixSoloSafe:0u);
      commands.push_back(c);}
    for(const auto s:plan.sends){
      const auto r=index.find(neu.sends[s].returnId);
      if(r==index.end()||!p.tracks[r->second].isReturn||r->second==i)continue; // Silent send (unknown or non-return id).
      Impl::Command c;c.kind=Impl::Kind::Send;c.track=static_cast<std::uint32_t>(r->second);c.noteId=static_cast<std::int32_t>(i);c.pitch=neu.sends[s].pre?1:0;c.value=neu.sends[s].gain;commands.push_back(c);
    }
    for(const auto&edit:plan.params){Impl::Command c;c.kind=Impl::Kind::Param;c.track=static_cast<std::uint32_t>(i);c.insert=edit.insert;c.pitch=edit.control;c.param=edit.value;commands.push_back(c);}
  }
  if(p.masterGain!=last->timeline.masterGain){Impl::Command c;c.kind=Impl::Kind::Master;c.value=p.masterGain;commands.push_back(c);}
  {Impl::Command c;c.kind=Impl::Kind::Revision;c.frame=static_cast<std::int64_t>(p.revision);commands.push_back(c);}
  // VST3 parameter values: the host's resolver applies them to its cached instances.
  for(std::size_t i=0;i<plans.size();++i)for(const auto*plugin:plans[i].pluginParams)if(resolvePlugin)(void)resolvePlugin(*plugin,p.sampleRate,e.maxBlock);
  for(auto&c:commands) {
    const auto ticket=e.enqueue(c);
    if(!ticket) {
      // The callback has stopped draining: forget the recipe so the next update rebuilds the whole graph.
      // Replacements not yet queued are still owned here.
      e.lastSubmittedRecipe.reset();
      throw std::runtime_error("Native graph command queue is full");
    }
    if(c.kind==Impl::Kind::Replace){for(auto&r:replacements)if(r.runtime.get()==c.runtime)(void)r.runtime.release();++e.replacementsInFlight;++result.replacedTracks;}
    result.ticket=ticket;++result.commands;
  }
  // The recipe follows the running graph.
  for(auto&r:replacements){last->timeline.tracks[r.index]=std::move(r.timeline);last->tracks[r.index]=std::move(r.info);}
  for(std::size_t i=0;i<p.tracks.size();++i) {
    if(plans[i].replace)continue;
    auto&old=last->timeline.tracks[i];const auto&neu=p.tracks[i];
    old.gain=neu.gain;old.pan=neu.pan;old.mute=neu.mute;old.solo=neu.solo;old.soloSafe=neu.soloSafe;old.audible=neu.audible;old.unmutedAudible=neu.unmutedAudible;
    old.sends=neu.sends;old.source=neu.source;old.inserts=neu.inserts;
  }
  last->timeline.masterGain=p.masterGain;last->timeline.revision=p.revision;
  result.kind=result.replacedTracks?UpdateResult::Kind::Tracks:result.commands>1?UpdateResult::Kind::Diff:UpdateResult::Kind::None;
  return result;
}

void RenderEngine::collectRetired(){
#if GARAK_RUST
  if(impl_->rust)impl_->rust->collect();
#endif
  PreparedProject*p=nullptr;while(impl_->retired.pop(p)){impl_->retainedWavetableMemory-=p->impl_->wavetableMemory;delete p;}
  TrackRuntime*t=nullptr;while(impl_->retiredTracks.pop(t)){delete t;if(impl_->replacementsInFlight)--impl_->replacementsInFlight;}
  // Keep the newest applied click set (the callback's) and any still queued.
  auto&owned=impl_->ownedClicks;const auto applied=impl_->published.ticket.load(std::memory_order_acquire);std::size_t keep=0;
  for(std::size_t i=0;i<owned.size();++i)if(owned[i].first<=applied)keep=i;
  if(keep)owned.erase(owned.begin(),owned.begin()+static_cast<std::ptrdiff_t>(keep));}
std::uint64_t RenderEngine::play(std::int64_t countIn){require(countIn>=0&&countIn<=std::int64_t(impl_->rate)*120,"Invalid count-in length");Impl::Command c;c.kind=Impl::Kind::Play;c.frame=countIn;return impl_->enqueue(c);}
std::uint64_t RenderEngine::setMetronome(std::shared_ptr<const MetronomeClicks> clicks,bool enabled,float volume){
  checked(volume,0,2,"Invalid metronome volume");
  if(clicks)for(const auto&level:clicks->levels){require(level.size()<=std::size_t(impl_->rate)*4,"Metronome stroke is too long");for(const auto v:level)require(std::isfinite(v)&&std::abs(v)<=4,"Invalid metronome stroke sample");}
  Impl::Command c;c.kind=Impl::Kind::Metronome;c.clicks=clicks.get();c.pitch=enabled?1:0;c.value=volume;
  const auto ticket=impl_->enqueue(c);if(ticket)impl_->ownedClicks.emplace_back(ticket,std::move(clicks));return ticket;}
std::uint64_t RenderEngine::pause(){Impl::Command c;c.kind=Impl::Kind::Pause;return impl_->enqueue(c);}
std::uint64_t RenderEngine::stop(){Impl::Command c;c.kind=Impl::Kind::Stop;return impl_->enqueue(c);}
std::uint64_t RenderEngine::seek(std::int64_t frame){Impl::Command c;c.kind=Impl::Kind::Seek;c.frame=frame;return impl_->enqueue(c);}
std::uint64_t RenderEngine::previewNote(std::uint32_t track,int pitch,float velocity,std::uint32_t duration){require(track<256&&pitch>=0&&pitch<=127&&duration>0&&duration<=impl_->rate*30,"Invalid preview note");checked(velocity,0,2,"Invalid preview velocity");Impl::Command c;c.kind=Impl::Kind::Preview;c.track=track;c.pitch=pitch;c.value=velocity;c.frame=duration;c.noteId=-2;return impl_->enqueue(c);}
std::uint64_t RenderEngine::noteOn(std::uint32_t track,int pitch,float velocity,std::int32_t id){require(track<256&&pitch>=0&&pitch<=127,"Invalid live MIDI note");checked(velocity,0,2,"Invalid MIDI velocity");Impl::Command c;c.kind=Impl::Kind::NoteOn;c.track=track;c.pitch=pitch;c.value=velocity;c.noteId=id;c.frame=unlimitedFrame;return impl_->enqueue(c);}
std::uint64_t RenderEngine::noteOff(std::uint32_t track,int pitch,std::int32_t id){require(track<256&&pitch>=0&&pitch<=127,"Invalid MIDI note off");Impl::Command c;c.kind=Impl::Kind::NoteOff;c.track=track;c.pitch=pitch;c.noteId=id;return impl_->enqueue(c);}
std::uint64_t RenderEngine::controlChange(std::uint32_t track,int controller,int value){require(track<256&&validControllerValue(controller,value),"Invalid MIDI control change");Impl::Command c;c.kind=Impl::Kind::Control;c.track=track;c.pitch=controller;c.value=static_cast<float>(value);return impl_->enqueue(c);}
std::uint64_t RenderEngine::allNotesOff(std::uint32_t track){require(track<256,"Invalid audition track index");Impl::Command c;c.kind=Impl::Kind::AllNotesOff;c.track=track;return impl_->enqueue(c);}
std::uint64_t RenderEngine::setMonitoring(std::span<const std::uint32_t> tracks){Impl::Command c;c.kind=Impl::Kind::Monitor;for(const auto t:tracks){require(t<256,"Invalid monitor track index");c.mask[t/64]|=std::uint64_t{1}<<(t%64);}return impl_->enqueue(c);}
std::vector<RecordingTake> RenderEngine::planRecording(std::span<const std::uint32_t> tracks)const {
  const auto&e=*impl_;require(e.lastSubmittedRecipe!=nullptr,"Submit a project before recording");
  require(!tracks.empty()&&tracks.size()<=maxRecordingTakes,"Invalid recording take count");
  const auto&timeline=e.lastSubmittedRecipe->timeline;std::set<std::uint32_t>seen;std::vector<RecordingTake>takes;
  for(const auto track:tracks) {
    require(track<timeline.tracks.size()&&seen.insert(track).second,"Invalid or duplicate recording track");
    const auto&route=timeline.tracks[track].route;
    if(route&&timeline.tracks[track].source.kind==TrackSource::Kind::Audio) {
      // An internal route: stereo, never a missing device channel.
      RecordingTake take;take.track=track;take.route.channels=2;take.routed=true;
      take.routeDelayed=route->kind==TrackRoute::Kind::Master||(route->kind==TrackRoute::Kind::Track&&route->tap!=TrackRoute::Tap::PreFx);
      take.routeMasterFeed=route->kind==TrackRoute::Kind::Master;
      takes.push_back(take);continue;
    }
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
bool rustEngineAvailable()noexcept{return GARAK_RUST!=0;}
std::uint64_t rustEngineBlocks()noexcept{return rustBlockCounter.load(std::memory_order_relaxed);}
bool RenderEngine::rustEngineRequested()const noexcept{return impl_->rustMode!=0;}
void RenderEngine::setRustEngine(int mode){
  require(mode>=0&&mode<=2,"Invalid Rust engine mode");
  require(!impl_->lastSubmittedRecipe&&!impl_->active,"Choose the render engine before submitting a project");
  require(mode==0||GARAK_RUST,"This build has no Rust engine (configure with -DGARAK_RUST=ON)");
  impl_->rustMode=mode;
}
std::string RenderEngine::lastRustRefusal()const{return impl_->rustRefusal;}
void RenderEngine::setMasterBypass(bool value)noexcept{impl_->masterBypass=value;}
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
  std::uint32_t cursor=0;float masterPeak=0;e.renderedCount=0;e.liveMidiNext=0;
  while(cursor<frames) {
    auto count=std::min({e.maxBlock,frames-cursor,e.applyLiveMidi(cursor,frames)});
    const bool countingIn=e.countInRemaining>0;
    if(countingIn)count=static_cast<std::uint32_t>(std::min<std::int64_t>(count,e.countInRemaining));
    if(e.active&&e.playing) {
      const auto&p=e.active->impl_->timeline;
      const auto boundary=!e.offline&&p.cycle?p.cycle->at(1):p.lengthFrames;
      if(e.position>=boundary) {
        if(!e.offline&&p.cycle){e.position=p.cycle->at(0);e.reset(true,false);}
        else if(!e.offline){e.reclaimAll(false);e.playing=false;for(auto&track:e.active->impl_->tracks)if(track.instrument&&!track.wavetable)track.instrument->requestReset();e.rustStopAtEnd();}
      }
      if(e.playing&&e.position<boundary)count=static_cast<std::uint32_t>(std::min<std::int64_t>(count,boundary-e.position));
    }
    if(e.renderedCount<Impl::maxRendered)e.rendered[e.renderedCount++]={cursor,count,e.position,e.active&&e.playing&&!countingIn};
    auto*out=output+static_cast<std::size_t>(cursor)*2;std::fill_n(out,static_cast<std::size_t>(count)*2,0.f);
    bool viaRust=false;(void)viaRust;
#if GARAK_RUST
    viaRust=e.active&&e.rustRenders();
    if(viaRust) {
      e.renderRust(out,count,input,cursor,channels);
      if(!(e.offline&&e.masterBypass)) {
        const float smoothing=static_cast<float>(1-std::exp(-1/(e.rate*.012)));
        for(std::uint32_t i=0;i<count;++i){e.masterGain+=(e.targetMasterGain-e.masterGain)*smoothing;out[2*i]*=e.masterGain;out[2*i+1]*=e.masterGain;}
        e.active->impl_->master.process(out,count);
      }
    } else if(e.rustRendered&&e.active){e.reclaimAll(true);e.reset(e.playing,true);} // Rust -> C++: the C++ tracks were idle.
    e.rustRendered=viaRust;
    if(e.active&&!viaRust) {
#else
    if(e.active) {
#endif
      auto& p=*e.active->impl_;
      ProcessContext context{static_cast<double>(e.rate),p.timeline.bpm,e.position,e.playing&&e.position<p.timeline.lengthFrames,e.offline,p.timeline.timeSigNumerator,p.timeline.timeSigDenominator};
      tempoContext(context,p);
      context.recording=e.recording;context.continuousFrame=e.continuousFrame;
      if(p.timeline.cycle&&!e.offline){context.cycleActive=true;context.cycleStartFrame=p.timeline.cycle->at(0);context.cycleEndFrame=p.timeline.cycle->at(1);}
      e.block={&p,&context,input,e.position,count,cursor,channels,e.playing&&e.position<p.timeline.lengthFrames};
      // Tracks render independently (in parallel when there is a pool and at
      // least two tracks to render here), then mix in track order, so the sum
      // is bit-identical to the single-threaded path.
      std::uint32_t callbackTracks=0;
      if(e.forkEnabled)for(const auto&t:p.tracks)if(t.timeline.enabled&&(!t.ahead||t.ahead->mode.load(std::memory_order_relaxed)==AheadState::Off))++callbackTracks;
      const auto trackCount=static_cast<std::uint32_t>(p.tracks.size());
      const auto levels=p.levelStart.empty()?0u:static_cast<std::uint32_t>(p.levelStart.size()-1);
      if(levels<=1) {
        if(e.pool&&e.forkEnabled&&callbackTracks>=2)e.pool->run(trackCount,&Impl::trackTask,&e);
        else for(std::uint32_t index=0;index<trackCount;++index)e.renderTrack(index,0);
      } else for(std::uint32_t level=0;level<levels;++level) {
        // Track-input routes: each level forks after the sources it reads have rendered.
        if(level==p.masterLevel)e.fillMasterFeed(p);
        const auto begin=p.levelStart[level],size=p.levelStart[level+1]-begin;
        if(e.pool&&e.forkEnabled&&callbackTracks>=2&&size>=2){e.levelTracks=p.levelOrder.data()+begin;e.pool->run(size,&Impl::levelTask,&e);}
        else for(std::uint32_t k=0;k<size;++k)e.renderTrack(p.levelOrder[begin+k],0);
      }
      for(auto&t:p.tracks) {
        if(t.timeline.directOut)for(std::size_t sample=0;sample<static_cast<std::size_t>(count)*2;++sample)out[sample]+=t.mix[sample];
        e.voiceOverflows+=t.taskOverflows;e.invalidSamples+=t.taskInvalid;e.aheadResyncs+=t.taskResyncs;t.taskResyncs=0;
      }
      const float smoothing=static_cast<float>(1-std::exp(-1/(e.rate*.012)));
      if(!(e.offline&&e.masterBypass)) {
        for(std::uint32_t i=0;i<count;++i){e.masterGain+=(e.targetMasterGain-e.masterGain)*smoothing;out[2*i]*=e.masterGain;out[2*i+1]*=e.masterGain;}
        p.master.process(out,count);
      }
    }
    if(e.recording&&e.capture) {
      // Every take shares one frame clock: the same callback frames, written together. Written after the
      // tracks so a routed take reads its track's route input for exactly these frames.
      auto&cap=*e.capture;
      const auto write=cap.write.load(std::memory_order_relaxed),read=cap.read.load(std::memory_order_acquire);
      const auto available=cap.capacity-(write-read),take=std::min<std::uint64_t>(available,count);
      auto*graph=e.active?e.active->impl_.get():nullptr;
      // Routed takes read their track's route input of these frames (the Rust graph's when it rendered them).
      std::array<const float*,maxRecordingTakes>routedInput{};
      for(std::size_t k=0;k<cap.takes.size()&&k<routedInput.size();++k) {
        const auto&t=cap.takes[k];if(!t.routed)continue;
        const TrackRuntime*track=graph&&t.track<graph->tracks.size()?&graph->tracks[t.track]:nullptr;
        if(!track||!track->routed||track->routeInput.empty())continue;
#if GARAK_RUST
        if(viaRust){routedInput[k]=garak_rs_engine_route_input(e.rust->handle,t.track);continue;}
#endif
        routedInput[k]=track->routeInput.data();
      }
      for(std::uint64_t i=0;i<take;++i) {
        float*frame=cap.ring.data()+static_cast<std::size_t>((write+i)%cap.capacity)*cap.channels;
        const auto at=cursor+static_cast<std::uint32_t>(i);
        for(std::size_t k=0;k<cap.takes.size();++k) {
          const auto&t=cap.takes[k];
          if(t.routed) {
            const float*routed=routedInput[k];
            *frame++=routed?routed[2*i]:0.f;*frame++=routed?routed[2*i+1]:0.f;
            continue;
          }
          const float left=inputSample(input,channels,at,t.route.left,e.invalidSamples);*frame++=left;
          if(t.route.channels==2)*frame++=t.route.right>=0?inputSample(input,channels,at,t.route.right,e.invalidSamples):left;
        }
      }
      cap.write.store(write+take,std::memory_order_release);e.recordedFrames+=count;e.droppedFrames+=count-take;
      if(take<count)e.recording=false;
    }
    for(std::size_t i=0;i<static_cast<std::size_t>(count)*2;++i){if(!std::isfinite(out[i])){out[i]=0;++e.invalidSamples;}masterPeak=std::max(masterPeak,std::abs(out[i]));}
    e.renderClicks(out,count,countingIn);
    if(e.playing) e.position+=count;
    if(countingIn&&(e.countInRemaining-=count)<=0) {
      // The transport starts on the frame right after the count-in; a waiting capture with it.
      e.countInRemaining=0;e.playing=e.active!=nullptr;e.reset(e.playing,false);
      if(e.capture){e.recording=true;e.recordingStart=e.position;}
    }
    e.continuousFrame+=count;
    cursor+=count;
  }
  if(e.active&&e.playing&&!e.offline) {
    const auto&p=e.active->impl_->timeline;
    if(p.cycle&&e.position>=p.cycle->at(1)){e.position=p.cycle->at(0);e.reset(true,false);}
    else if(!p.cycle&&e.position>=p.lengthFrames){e.reclaimAll(false);e.playing=false;for(auto&track:e.active->impl_->tracks)if(track.instrument&&!track.wavetable)track.instrument->requestReset();e.rustStopAtEnd();}
  }
  // Events left behind (a track still draining its render-ahead ring) apply at the start of the next call.
  {std::uint32_t kept=0;for(std::uint32_t i=e.liveMidiNext;i<e.liveMidiCount;++i){e.liveMidi[kept]=e.liveMidi[i];e.liveMidi[kept++].offset=0;}e.liveMidiCount=kept;e.liveMidiNext=0;}
  e.promote();
  e.publishDynamics(frames);
  e.publish(masterPeak);
}

std::uint32_t RenderEngine::queueLiveMidi(std::span<const LiveMidiEvent> events)noexcept {
  auto&e=*impl_;std::uint32_t accepted=0;
  for(const auto&ev:events) {
    if(e.liveMidiCount>=Impl::maxLiveMidi)break;
    // Insertion keeps offsets ordered (stable for equal offsets).
    auto at=e.liveMidiCount;while(at>0&&e.liveMidi[at-1].offset>ev.offset){e.liveMidi[at]=e.liveMidi[at-1];--at;}
    e.liveMidi[at]=ev;++e.liveMidiCount;++accepted;
  }
  return accepted;
}
std::int64_t RenderEngine::renderedTransportFrame(std::uint32_t offset)const noexcept {
  const auto&e=*impl_;
  for(std::uint32_t i=0;i<e.renderedCount;++i){const auto&r=e.rendered[i];
    if(offset>=r.cursor&&offset<r.cursor+r.count)return r.playing?r.position+(offset-r.cursor):notRenderedFrame;}
  return notRenderedFrame;
}
EngineSnapshot RenderEngine::snapshot()const noexcept {
  const auto&e=*impl_;const auto&p=e.published;EngineSnapshot s;
  s.lastAppliedCommand=p.ticket.load(std::memory_order_acquire);s.revision=p.revision.load(std::memory_order_relaxed);s.frame=p.frame.load(std::memory_order_relaxed);s.sampleRate=e.rate;
  s.trackCount=p.trackCount.load(std::memory_order_relaxed);s.latencyFrames=p.latency.load(std::memory_order_relaxed);s.senderLatencyFrames=p.senderLatency.load(std::memory_order_relaxed);s.ready=p.ready.load(std::memory_order_relaxed);s.playing=p.playing.load(std::memory_order_relaxed);
  s.masterPeak=p.masterPeak.load(std::memory_order_relaxed);for(std::uint32_t i=0;i<std::min(256u,s.trackCount);++i)s.trackPeaks[i]=p.trackPeaks[i].load(std::memory_order_relaxed);
  s.commandOverflows=e.commandOverflows.load(std::memory_order_relaxed);s.voiceOverflows=p.voiceOverflows.load(std::memory_order_relaxed);s.invalidSamples=p.invalidSamples.load(std::memory_order_relaxed);
  s.recording=p.recording.load(std::memory_order_relaxed);s.recordingStartFrame=p.recordingStart.load(std::memory_order_relaxed);s.recordedFrames=p.recorded.load(std::memory_order_relaxed);s.recordingDroppedFrames=p.dropped.load(std::memory_order_relaxed);
  s.rustEngine=e.publishedRust.load(std::memory_order_relaxed);s.rustRefusals=e.rustRefusals.load(std::memory_order_relaxed);
  s.workerThreads=e.workerCount;s.renderAheadTracks=p.aheadTracks.load(std::memory_order_relaxed);s.renderAheadResyncs=p.aheadResyncs.load(std::memory_order_relaxed);
  s.dynamicsCount=std::min<std::uint32_t>(p.dynamicsCount.load(std::memory_order_relaxed),EngineSnapshot::maxDynamicsReadings);
  for(std::uint32_t i=0;i<s.dynamicsCount;++i){const auto id=p.dynamicsIds[i].load(std::memory_order_relaxed);
    s.dynamics[i]={static_cast<std::uint16_t>(id>>16),static_cast<std::uint16_t>(id&0xffff),p.dynamicsInput[i].load(std::memory_order_relaxed),p.dynamicsGain[i].load(std::memory_order_relaxed)};}
  return s;
}
std::uint32_t RenderEngine::drainRecording(float* destination,std::uint32_t capacity)noexcept {
  if(!destination||!capacity||!impl_->ownedCapture)return 0;
  auto&cap=*impl_->ownedCapture;const auto read=cap.read.load(std::memory_order_relaxed),write=cap.write.load(std::memory_order_acquire);
  const auto count=static_cast<std::uint32_t>(std::min<std::uint64_t>(write-read,capacity));
  for(std::uint32_t i=0;i<count;++i)std::copy_n(cap.ring.data()+static_cast<std::size_t>((read+i)%cap.capacity)*cap.channels,cap.channels,destination+static_cast<std::size_t>(i)*cap.channels);
  cap.read.store(read+count,std::memory_order_release);return count;
}

} // namespace garak

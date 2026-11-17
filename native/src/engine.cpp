// RenderEngine: the desktop host's real-time shell around the unified Rust render engine (docs/RUST_ENGINE.md 10,
// docs/NATIVE_AUDIO.md). Since 0.3.3 every track renders in rust/garak-engine (rust_engine.inc), master bus and
// metronome included. This file keeps the shell: the control-thread queues and graph swaps, transport, cycle and
// count-in timing, live MIDI forwarding, monitored input and capture, the worker pool and render-ahead rings,
// snapshots, and the host nodes the Rust graph calls back: VST3 instruments and inserts (HostTrack). IEUM WAVE renders
// in the Rust graph too; the shell only validates its patches (docs/IEUM_WAVE.md).
#include "garak/engine.hpp"
#include "garak_engine.h"
#include "garak_engine_instruments.h"

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
constexpr std::int64_t unlimitedFrame = std::numeric_limits<std::int64_t>::max() / 4;
constexpr double pi = 3.14159265358979323846264338327950288;

void require(bool condition, const char* description) { if (!condition) throw std::invalid_argument(description); }
double checked(double value, double minimum, double maximum, const char* description) {
  require(std::isfinite(value) && value >= minimum && value <= maximum, description); return value;
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
// can swap one track of the running graph (RenderEngine::update) without moving a HostTrack: on MSVC a
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
// One VST3 automation lane (docs/AUTOMATION.md): a VST3 instrument or insert parameter, sent as sample-offset
// parameter points. The Rust graph evaluates every other lane (mix, sends, built-in parameters) itself.
struct LaneRuntime {
  std::uint16_t lane=0;           // Index in TrackTimeline::automation.
  std::int32_t insert=-1;          // Index in HostTrack::inserts; -1: the instrument.
  std::uint32_t pluginParam=0;     // VST3 ParamID.
  std::size_t hint=0;
  float lastSent=-1;               // Last value queued (avoids repeating flat values).
};
constexpr std::uint32_t automationChunk=32;   // VST3 points sit on a grid of at least 64 frames.
constexpr std::size_t maxInsertEvents=512;

// One enabled insert of the track (runtime index = enabled inserts in order, like the Rust plan's): a VST3 plug-in,
// or null for a built-in effect (rendered by the Rust graph).
struct InsertRuntime {
  std::shared_ptr<PluginProcessor> plugin;
  std::uint16_t source=0; // Index in TrackTimeline::inserts.
};

// The shell's part of one graph track: the host nodes the Rust graph calls back (docs/RUST_ENGINE.md 4) and the
// shell's bookkeeping. A VST3 instrument receives sample-accurate events (timeline notes and controllers, chased
// notes, live and audition notes, instrument parameter points); VST3 inserts receive their parameter points. The track also carries its render-ahead ring, its
// published meter and live ownership. Built-in instruments, IEUM WAVE, effects, windows, routes, sends and the mix
// are the Rust graph's: for such a track this holds no processor at all.
struct HostTrack {
  HostTrack() = default;
  HostTrack(const HostTrack&) = delete;
  HostTrack& operator=(const HostTrack&) = delete;
  HostTrack(HostTrack&&) = default;
  HostTrack& operator=(HostTrack&&) = default;

  TrackTimeline timeline;
  std::vector<InsertRuntime> inserts;
  std::shared_ptr<PluginProcessor> instrument;
  std::vector<TimedPluginEvent> events;
  std::array<PluginEvent,maxPluginEvents> blockEvents{};
  std::array<PluginEvent,maxVoices> pendingEvents{};
  std::size_t pendingCount=0;
  struct LivePluginNote { bool active=false;std::int32_t id=-1;std::uint8_t pitch=60;std::int64_t remaining=0; };
  std::array<LivePluginNote,maxVoices> pluginNotes{};
  // Live sustain pedal (CC64 from controlChange): the VST3 instrument gets the controller itself.
  bool livePedal=false;
  // Sample offset of the live event being applied (the Rust graph's host live node; 0 otherwise): the plug-in
  // events it queues land there in the next renderSource.
  std::uint32_t liveOffset=0;
  [[nodiscard]] bool vst3()const noexcept{return instrument!=nullptr;}
  std::size_t nextNote=0,nextEvent=0;
  std::uint32_t latency=0; // VST3 instrument + VST3 inserts (host nodes only).
  // Render-ahead and multi-core bookkeeping. A block task writes only its own track.
  std::unique_ptr<AheadState> ahead; // Render-ahead ring when eligible (no VST3).
  const float* mix=nullptr;          // This block's ring output (ahead->out).
  float meter=0;                     // Callback-published peak.
  std::uint64_t taskOverflows=0,taskInvalid=0,taskResyncs=0;
  // Continuous frame until which live input/notes keep this track in the callback.
  std::int64_t liveUntil=std::numeric_limits<std::int64_t>::min();
  std::vector<LaneRuntime> lanes;
  std::array<PluginEvent,maxInsertEvents> insertEvents{};

  // Value of lane `l` (in its units) at a project frame.
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
  bool sameSource=false;                  // Same instrument identity: the instrument and its live notes carry over.
  bool aheadEligible=false;               // May take the predecessor's (idle) render-ahead ring (update()).
  std::vector<std::int32_t> insertOrigin; // Per runtime insert: the predecessor's runtime insert (same id/type), or -1.
  std::vector<RemovedNote> removedNotes;  // Predecessor notes absent here: released if sounding.

  // Callback (or a quiesced graph swap): continue playing from `previous`, the same track before an edit.
  // identical: events are unchanged, so cursors (and a moving ring) keep their position. Otherwise `previous` is
  // callback-owned at `frame` (its ring was drained) and cursors are recomputed there: the instrument, plug-in
  // tails and live notes continue; only notes that were removed or edited are released
  // (docs/RENDER_DIFF_PROTOCOL.md). `replaced`: a single-track replacement keeps the graph (and its ring).
  void adopt(HostTrack& previous,std::int64_t frame,bool sameEvents,bool replaced)noexcept {
    meter=previous.meter;liveUntil=previous.liveUntil;
    if(sameSource) {
      livePedal=previous.livePedal;
      pendingEvents=previous.pendingEvents;pendingCount=previous.pendingCount;pluginNotes=previous.pluginNotes;
      if(instrument&&previous.instrument)instrument.swap(previous.instrument);
    } else if(instrument&&instrument==previous.instrument)instrument->requestReset();
    for(std::size_t i=0;i<inserts.size()&&i<insertOrigin.size();++i) {
      const auto from=insertOrigin[i];
      if(from<0||static_cast<std::size_t>(from)>=previous.inserts.size())continue;
      auto&old=previous.inserts[static_cast<std::size_t>(from)];
      if(inserts[i].plugin&&old.plugin)inserts[i].plugin.swap(old.plugin);
    }
    if(sameEvents) {
      // The ring and its producer position belong with the track's state.
      if(ahead&&previous.ahead&&ahead->capacity==previous.ahead->capacity)ahead.swap(previous.ahead);
      nextNote=previous.nextNote;nextEvent=previous.nextEvent;
      return;
    }
    if(replaced&&aheadEligible&&!ahead)ahead.swap(previous.ahead);
    nextNote=static_cast<std::size_t>(std::lower_bound(timeline.notes.begin(),timeline.notes.end(),frame,[](const NotePair& n,std::int64_t f){return n.onFrame<f;})-timeline.notes.begin());
    nextEvent=static_cast<std::size_t>(std::lower_bound(events.begin(),events.end(),frame,[](const TimedPluginEvent&e,std::int64_t f){return e.frame<f;})-events.begin());
    if(instrument)for(const auto&r:removedNotes)
      if(r.onFrame<frame&&r.offFrame>frame&&pendingCount<pendingEvents.size())pendingEvents[pendingCount++]={PluginEvent::Type::NoteOff,0,r.id,r.pitch,0,0,0,false};
  }

  // Live and chased notes for the instrument (built-in instruments receive theirs in the Rust graph).
  void spawn(int pitch,float velocity,std::int64_t duration,std::int64_t available,std::int32_t id,bool live,std::uint64_t& overflows)noexcept {
    if(!instrument||velocity<=0||duration<=0||available<=0||!timeline.enabled)return;
    if(pendingCount==pendingEvents.size()){++overflows;return;}
    if(live){
      auto slot=std::find_if(pluginNotes.begin(),pluginNotes.end(),[](const LivePluginNote&n){return !n.active;});
      if(slot==pluginNotes.end()){++overflows;return;}
      *slot={true,id,static_cast<std::uint8_t>(pitch),duration+liveOffset};
    }
    // Chased timeline notes already have an exact scheduled note-off. Only live/preview notes need a
    // callback-local countdown.
    pendingEvents[pendingCount++]={PluginEvent::Type::NoteOn,liveOffset,id,static_cast<std::uint8_t>(pitch),0,std::min(1.f,velocity),0,live};
  }
  // Live MIDI controller (docs/MIDI_CONTROLLERS.md): the VST3 instrument receives every controller.
  void controlChange(int controller,int value,std::uint64_t& overflows)noexcept {
    if(!instrument)return;
    if(controller==bendRangeController)return; // Meta controller of the built-in sources only.
    if(pendingCount<pendingEvents.size()){PluginEvent e{};e.type=PluginEvent::Type::Controller;e.offset=liveOffset;e.parameterId=static_cast<std::uint32_t>(controller);e.value=normalizedControllerValue(controller,value);e.audition=true;pendingEvents[pendingCount++]=e;}
    else ++overflows;
    if(controller==sustainController)livePedal=pedalDown(value);
  }
  void noteOff(int pitch,std::int32_t id,std::uint64_t& overflows)noexcept {
    if(!instrument)return;
    bool cancelledPending=false;
    for(std::size_t i=0;i<pendingCount;){
      const auto&e=pendingEvents[i];
      // A note-off at the same sample as its still pending note-on cancels it; a later one follows it.
      if(e.type==PluginEvent::Type::NoteOn&&e.audition&&e.offset>=liveOffset&&(id>=0?e.noteId==id:e.pitch==pitch)){
        std::move(pendingEvents.begin()+static_cast<std::ptrdiff_t>(i+1),pendingEvents.begin()+static_cast<std::ptrdiff_t>(pendingCount),pendingEvents.begin()+static_cast<std::ptrdiff_t>(i));
        --pendingCount;cancelledPending=true;
      }else ++i;
    }
    if(!cancelledPending){
      if(pendingCount<pendingEvents.size())pendingEvents[pendingCount++]={PluginEvent::Type::NoteOff,liveOffset,id,static_cast<std::uint8_t>(pitch),0,0,0,true};
      else{++overflows;instrument->requestReset();pendingCount=0;for(auto&n:pluginNotes)n.active=false;}
    }
    for(auto& n:pluginNotes)if(n.active&&(id>=0?n.id==id:n.pitch==pitch))n.active=false;
  }
  void allNotesOff(std::uint64_t& overflows)noexcept {
    // A panic also lifts the (live) pedal: nothing may keep ringing afterwards.
    livePedal=false;
    if(!instrument)return;
    controlChange(sustainController,0,overflows);
    for(auto&n:pluginNotes)if(n.active)noteOff(n.pitch,n.id,overflows);
    // ...and returns the bend and the modulation to rest.
    controlChange(pitchBendController,0,overflows);controlChange(modWheelController,0,overflows);
  }
  void reset(std::int64_t frame,bool chase,bool resetEffects,std::uint64_t& overflows)noexcept {
    for(auto& n:pluginNotes) n.active=false;
    pendingCount=0;
    if(instrument)instrument->requestReset();
    // Timeline controllers (docs/MIDI_CONTROLLERS.md): chase the values in effect at the new position, or
    // return the resetting ones (mod wheel, expression, pedal, pressure, bend) to rest when stopping.
    if(instrument&&!timeline.controls.empty()){
      std::array<std::int32_t,controllerCount> values{};std::array<bool,controllerCount> present{},known{};
      for(const auto&c:timeline.controls){present[c.controller]=true;if(chase&&c.frame<frame){values[c.controller]=c.value;known[c.controller]=true;}}
      for(int controller=0;controller<controllerCount;++controller){
        const auto index=static_cast<std::size_t>(controller);
        if(!present[index]||controller==bendRangeController)continue;
        int value=0;
        if(chase&&timeline.enabled&&known[index])value=values[index];
        else if(!resetController(controller,value))continue;
        if(pendingCount>=pendingEvents.size()){++overflows;break;}
        PluginEvent e{};e.type=PluginEvent::Type::Controller;e.parameterId=static_cast<std::uint32_t>(controller);e.value=normalizedControllerValue(controller,value);
        pendingEvents[pendingCount++]=e;
      }
    }
    if(resetEffects)for(auto& effect:inserts)if(effect.plugin)effect.plugin->requestReset();
    nextNote=static_cast<std::size_t>(std::lower_bound(timeline.notes.begin(),timeline.notes.end(),frame,[](const NotePair& n,std::int64_t f){return n.onFrame<f;})-timeline.notes.begin());
    nextEvent=static_cast<std::size_t>(std::lower_bound(events.begin(),events.end(),frame,[](const TimedPluginEvent&e,std::int64_t f){return e.frame<f;})-events.begin());
    if(chase&&!timeline.source.isKit&&timeline.enabled)for(std::size_t i=0;i<nextNote;++i){const auto& n=timeline.notes[i];if(n.offFrame>frame)spawn(n.pitch,n.velocity,n.offFrame-frame,n.limitFrame-frame,n.id,false,overflows);}
  }
  // The host source node: the VST3 instrument with this block's events, added into `out`.
  void renderSource(float* out,std::int64_t frame,std::uint32_t frames,bool playing,const ProcessContext& context,std::uint64_t& overflows)noexcept {
    std::size_t eventCount=0;
    for(std::size_t i=0;i<pendingCount&&eventCount<blockEvents.size();++i) blockEvents[eventCount++]=pendingEvents[i];
    pendingCount=0;
    if(!instrument)return;
    if(playing)while(nextEvent<events.size()&&events[nextEvent].frame<frame+frames){const auto& e=events[nextEvent++];if(e.frame>=frame){if(eventCount<blockEvents.size()){blockEvents[eventCount]=e.event;blockEvents[eventCount++].offset=static_cast<std::uint32_t>(e.frame-frame);}else ++overflows;}}
    for(auto& l:lanes)if(l.insert<0)pluginPoints(l,frame,frames,[&](const PluginEvent& e){if(eventCount<blockEvents.size())blockEvents[eventCount++]=e;else ++overflows;});
    for(auto& n:pluginNotes)if(n.active){if(n.remaining<frames){if(eventCount<blockEvents.size())blockEvents[eventCount++]={PluginEvent::Type::NoteOff,static_cast<std::uint32_t>(std::max<std::int64_t>(0,n.remaining)),n.id,n.pitch,0,0,0,true};else ++overflows;n.active=false;}else n.remaining-=frames;}
    std::sort(blockEvents.begin(),blockEvents.begin()+static_cast<std::ptrdiff_t>(eventCount),[](const PluginEvent&a,const PluginEvent&b){
      return a.offset<b.offset||(a.offset==b.offset&&eventOrder(a.type)<eventOrder(b.type));});
    instrument->process(out,frames,std::span(blockEvents).first(eventCount),context);
  }
  // The host insert node: runtime insert `index` (a VST3 plug-in) with sample-offset automation points
  // through IParameterChanges.
  void processPlugin(std::size_t index,float* buf,std::int64_t frame,std::uint32_t frames,const ProcessContext& context,std::uint64_t& overflows)noexcept {
    auto& effect=inserts[index];
    if(lanes.empty()){effect.plugin->process(buf,frames,{},context);return;}
    std::size_t count=0;
    for(auto& l:lanes)if(l.insert==static_cast<std::int32_t>(index))pluginPoints(l,frame,frames,[&](const PluginEvent& e){if(count<insertEvents.size())insertEvents[count++]=e;else ++overflows;});
    // Stable insertion sort by offset (lanes arrive in order; std::stable_sort may allocate).
    for(std::size_t i=1;i<count;++i){const auto e=insertEvents[i];std::size_t j=i;while(j>0&&insertEvents[j-1].offset>e.offset){insertEvents[j]=insertEvents[j-1];--j;}insertEvents[j]=e;}
    effect.plugin->process(buf,frames,std::span<const PluginEvent>(insertEvents.data(),count),context);
  }
};
static_assert(!std::is_copy_constructible_v<HostTrack> && std::is_move_constructible_v<HostTrack>);

// Control thread: validate the lanes and bind the VST3 ones to their plug-in parameter. Lanes the Rust graph
// evaluates (mix, sends, built-in instrument and effect parameters) are validated here and skipped.
void prepareAutomation(HostTrack& track,const TrackTimeline& t){
  require(t.automation.size()<=256,"Too many automation lanes");
  for(std::size_t index=0;index<t.automation.size();++index){
    const auto& lane=t.automation[index];
    require(lane.points.size()<=20000,"Too many automation points");
    double previous=-1;
    for(const auto& point:lane.points){require(std::isfinite(point.frame)&&point.frame>=0&&point.frame>=previous&&point.value>=0&&point.value<=1&&point.curve>=-1&&point.curve<=1,"Invalid automation point");previous=point.frame;}
    require(std::isfinite(lane.minimum)&&std::isfinite(lane.maximum)&&(!lane.logarithmic||(lane.minimum>0&&lane.maximum>0)),"Invalid automation range");
    if(lane.points.empty())continue;
    LaneRuntime l;l.lane=static_cast<std::uint16_t>(index);
    if(lane.target==AutomationLane::Target::Instrument&&track.vst3())l.pluginParam=static_cast<std::uint32_t>(std::stoul(lane.param));
    else if(lane.target==AutomationLane::Target::Insert){
      const auto found=std::find_if(t.inserts.begin(),t.inserts.end(),[&](const BuiltinInsert& e){return e.id==lane.insertId;});
      if(found==t.inserts.end())continue;
      const auto source=static_cast<std::uint16_t>(found-t.inserts.begin());
      const auto runtime=std::find_if(track.inserts.begin(),track.inserts.end(),[&](const InsertRuntime& i){return i.source==source;});
      if(runtime==track.inserts.end()||!runtime->plugin)continue; // Disabled, or a built-in effect.
      l.insert=static_cast<std::int32_t>(runtime-track.inserts.begin());
      l.pluginParam=static_cast<std::uint32_t>(std::stoul(lane.param));
    } else continue;
    track.lanes.push_back(l);
  }
  // Mid-block VST3 points need one event slot each; reserve the worst case against the bounded buffers.
  require(track.lanes.size()*32<=maxInsertEvents,"Too many automated VST3 parameters on one track");
}

std::shared_ptr<const PcmAsset> resolveAsset(const AssetStore& assets,const std::string&id) {
  const auto a=assets.find(id);require(a!=assets.end()&&a->second,"Native PCM asset is not registered");
  require(a->second->channels>=1&&a->second->channels<=32&&a->second->sampleRate>=8000&&a->second->sampleRate<=192000,"Invalid native PCM asset format");
  require(!a->second->samples.empty()&&a->second->samples.size()%a->second->channels==0,"Invalid native PCM asset length");
  return a->second;
}

// Control-thread record of the last submitted graph plus every diff applied to it since (RenderEngine::update):
// the timeline as the running graph knows it (note ids as renumbered by update) and what each track resolved.
// The callback never reads it; it receives a predecessor serial and per-track links, not a hash or JSON.
struct ControlTrack {
  std::uint32_t latency=0;                  // Host-node plug-in delay (VST3 instrument + VST3 inserts).
  bool routing=false,aheadEligible=false;   // Reads or feeds a tap in the same block / may render ahead.
  // Host nodes (rust_engine.inc): the instrument's delay, tail and stereo layout, and each VST3 insert's delay and
  // tail (indexed like TrackTimeline::inserts).
  std::uint32_t sourceLatency=0;double sourceTail=0;bool sourceStereo=false;
  std::vector<std::pair<std::uint32_t,double>> pluginInserts;
  std::vector<std::shared_ptr<const PcmAsset>> assets; // Sample zones, then windows, in resolution order.
  std::optional<SampleSet> set;
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
// the Rust graph crossfades a changed IEUM WAVE patch, VST3 instances are resolved by instance id).
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
std::vector<HostTrack::RemovedNote> removedNotes(const std::vector<NotePair>& old,const std::vector<NotePair>& next) {
  const auto key=[](const NotePair& n){return std::make_tuple(n.id,n.onFrame,n.offFrame,n.limitFrame,n.pitch,n.velocity);};
  std::vector<const NotePair*> a,b;a.reserve(old.size());b.reserve(next.size());
  for(const auto&n:old)a.push_back(&n);
  for(const auto&n:next)b.push_back(&n);
  const auto less=[&](const NotePair* x,const NotePair* y){return key(*x)<key(*y);};
  std::sort(a.begin(),a.end(),less);std::sort(b.begin(),b.end(),less);
  std::vector<HostTrack::RemovedNote> removed;
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
std::vector<HostTrack::RemovedNote> renumberNotes(const std::vector<NotePair>& old,std::vector<NotePair>& next) {
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
  std::vector<HostTrack::RemovedNote> removed;
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
// Index of this track's send automation lane for a return (the Rust graph's send feed lane), or -1.
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
    const double t=static_cast<double>(i)/sampleRate,window=.5-.5*std::cos(2*pi*i/(length-1));
    pulse[i]=static_cast<float>(.5*window*std::sin(2*pi*(low*t+(high-low)*t*t/(2*duration))));
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
  // Compiled once on the control thread; null-free for the callback (constant maps use timeline.bpm). The host
  // nodes' ProcessContext reads them (docs/TEMPO_MAP.md, docs/METER_MAP.md).
  TempoMap tempo;
  MeterMap meters; // Time-signature changes; constant (one event) when timeline.meterMap is empty.
  PtrList<HostTrack> tracks;
  // The Rust graph of this plan (prepare() submitted it): plug-in delay, sender delay, tails.
  std::uint32_t latency=0,senderLatency=0;
  double tail=0,trackTail=0;
  std::unique_ptr<ControlRecipe> recipe; // Moved to the engine by submit().
  std::uint64_t serial=0,preserveFrom=0;
  // Set by submit() when this graph continues the running one: tempo/length/cycle changed (every track
  // continues from the playhead), and each previous track's index here (-1: removed).
  bool headerChanged=false;
  std::vector<std::int32_t> successor;
  explicit Impl(const ProjectTimeline& p):timeline(headerOf(p)),tempo(p.bpm,p.tempoMap),meters(p.timeSigNumerator,p.timeSigDenominator,p.meterMap){}
  // Each track continues its predecessor (same id); a new track starts at the playhead like after a seek.
  void takeStateFrom(Impl& previous,std::int64_t frame,bool playing,std::uint64_t& overflows)noexcept {
    for(auto&t:tracks) {
      if(t.predecessor>=0&&static_cast<std::size_t>(t.predecessor)<previous.tracks.size())t.adopt(previous.tracks[static_cast<std::size_t>(t.predecessor)],frame,t.identical&&!headerChanged,false);
      else t.reset(frame,playing,true,overflows);
    }
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
  // Touch: a live edit of one track (mix, built-in insert parameter) that the Rust graph applies; the track leaves
  // render-ahead first so the edit is heard on the next block. Replace: one host track swapped at a block boundary,
  // keeping its instrument and plug-in state. Revision: the applied project revision. RustSync: the Rust engine's
  // commands up to a ticket may apply (they land in the same block as the shell's commands queued before it).
  enum class Kind { Graph,Play,Pause,Stop,Seek,Preview,NoteOn,NoteOff,AllNotesOff,Control,Monitor,RecordStart,RecordStop,Input,Layout,Touch,Replace,Revision,RustSync };
  struct Command {Kind kind=Kind::Stop;std::uint64_t ticket=0;PreparedProject*graph=nullptr;Capture*capture=nullptr;std::uint32_t track=0;std::int64_t frame=0;int pitch=60;std::int32_t noteId=-1;float value=1;std::array<std::uint64_t,4>mask{};std::array<std::uint8_t,maxInputLayout>layout{};
    HostTrack*runtime=nullptr;};
  std::uint32_t rate,maxBlock;
  PreparedProject*active=nullptr;
  // The Rust engine (rust_engine.inc), created on the control thread at the first need with the offline flag then
  // set. The callback applies its commands up to `rustAllowed` (RustSync) and renders every block through it.
  std::unique_ptr<RustBackend> rust;
  bool rustRendered=false;
  std::uint64_t rustAllowed=0;
  std::array<float,256> rustPeaks{};
  // Analysis taps (setAnalysis): the callback appends each Rust render's tap signals to a history ring per slot,
  // published under a seqlock (odd while writing) for readAnalysis on the control thread.
  std::vector<float> analysisRing=std::vector<float>(static_cast<std::size_t>(analysisSlots)*analysisFrames*2);
  std::uint32_t analysisWrite=0;
  std::atomic<std::uint32_t> analysisTaps{0},analysisSeq{0};
  std::atomic<std::uint64_t> analysisVersion{0};
  void publishAnalysis(std::uint32_t count)noexcept {
    const auto taps=analysisTaps.load(std::memory_order_acquire);
    count=std::min(count,maxBlock);
    if(!taps||!count||!rust)return;
    const float* src=garak_rs_engine_analysis_output(rust->handle);
    if(!src)return;
    analysisSeq.fetch_add(1,std::memory_order_acq_rel);
    std::atomic_thread_fence(std::memory_order_release);
    const std::size_t size=static_cast<std::size_t>(analysisFrames)*2,slot=static_cast<std::size_t>(maxBlock)*2;
    for(std::uint32_t i=0;i<count;++i){
      const std::size_t at=static_cast<std::size_t>((analysisWrite+i)%analysisFrames)*2;
      for(std::uint32_t k=0;k<taps;++k){const float* f=src+k*slot+static_cast<std::size_t>(i)*2;analysisRing[k*size+at]=f[0];analysisRing[k*size+at+1]=f[1];}
    }
    analysisWrite=(analysisWrite+count)%analysisFrames;
    std::atomic_thread_fence(std::memory_order_release);
    analysisSeq.fetch_add(1,std::memory_order_acq_rel);
    analysisVersion.fetch_add(1,std::memory_order_release);
  }
  GarakRsTask rustTask=nullptr;void* rustJob=nullptr; // Current parallel Rust job (callback + pool workers).
  // Host node callbacks (VST3, device input) for the Rust graph. `user` is a RustScope: the block
  // the callbacks render (the callback's, or a render-ahead producer's own).
  struct RustScope { Impl* e=nullptr; PreparedProject::Impl* graph=nullptr; const ProcessContext* context=nullptr; const float* input=nullptr;
    std::int64_t position=0; std::uint32_t cursor=0,channels=0; bool playing=false; };
  RustScope rustScope;
  GarakRsHostNodes rustNodes{};
  std::array<const float*,256> rustAhead{}; // This block's ring output of tracks rendering ahead (else null).
  std::uint64_t rustConsumed=0;            // Rust commands applied up to this ticket.
  std::atomic<bool> publishedRust{false};
  // Control-thread copies forwarded to every Rust engine this shell creates: the master bypass and the metronome
  // (the last stroke set handed over, kept alive so a pointer comparison can never match a recycled address).
  bool controlMasterBypass=false;
  std::shared_ptr<const MetronomeClicks> metronomeClicks,forwardedClicks;
  bool metronomeOn=false,metronomeForwarded=false;float metronomeGain=0;
  SpscQueue<Command,1024> commands;
  SpscQueue<PreparedProject*,4096>retired;
  // Tracks replaced in the running graph, destroyed on the control thread (collectRetired). The control
  // thread keeps at most retiredTrackCapacity replacements in flight, so the callback's push never fails.
  static constexpr std::size_t retiredTrackCapacity=512;
  SpscQueue<HostTrack*,retiredTrackCapacity>retiredTracks;
  std::size_t replacementsInFlight=0;
  std::optional<Command> deferred;
  std::uint64_t nextTicket=1,lastTicket=0,voiceOverflows=0,invalidSamples=0;
  std::atomic<std::uint64_t>commandOverflows{0};
  std::unique_ptr<ControlRecipe>lastSubmittedRecipe;
  std::uint64_t lastSubmittedSerial=0;
  std::int64_t position=0;
  std::int64_t continuousFrame=0;
  bool playing=false,offline=false,recording=false;
  // Count-in (the Rust engine clicks it, garak_rs_engine_clicks). During a count-in the transport holds `position`
  // and is not `playing`; a capture started meanwhile waits (recording=false) and begins on the frame the
  // transport starts.
  std::int64_t countInRemaining=0,countInElapsed=0,countInLength=0;
  std::array<std::uint64_t,4>monitor{};
  int inputLeft=0,inputRight=1;
  // Callback copy of the device's physical channel order. Identity until set.
  std::array<std::uint8_t,maxInputLayout>layout{};std::uint32_t layoutCount=maxInputLayout;
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
  // Applies queued live events; returns frames until the next one. The Rust graph takes every event of the call at
  // once, each at its sample offset from this sub-block (docs/RUST_ENGINE.md 5.8; one past the call lands on the
  // next call's first frame), so blocks are not split while a graph renders.
  std::uint32_t applyLiveMidi(std::uint32_t cursor,std::uint32_t frames)noexcept {
    const bool viaRust=rustRenders();
    while(liveMidiNext<liveMidiCount&&(viaRust||liveMidi[liveMidiNext].offset<=cursor)) {
      auto&ev=liveMidi[liveMidiNext];
      if(active&&ev.track<active->impl_->tracks.size()) {
        auto&t=active->impl_->tracks[ev.track];
        // A track rendering ahead drains first: keep the rest for the next call.
        if(!own(t))break;
        markLive(t);
        const auto type=ev.status&0xF0;
        // The Rust graph plays it: built-in instruments on that sample, a VST3 host node through rustLiveNode.
        const auto at=std::min(ev.offset,frames),offset=at>cursor?at-cursor:0u;
        if(type==0x90&&ev.data2>0)rustLive(ev.track,0,ev.data1&0x7F,ev.noteId,static_cast<float>(ev.data2&0x7F)/127.f,offset);
        else if(type==0x80||type==0x90)rustLive(ev.track,1,ev.data1&0x7F,ev.noteId,0,offset);
        else if(type==0xB0&&(ev.data1==120||ev.data1==123))rustLive(ev.track,2,0,0,0,offset);
        // Controllers, pitch bend, channel pressure, program change.
        else if(type==0xB0)rustLive(ev.track,3,ev.data1&0x7F,ev.data2&0x7F,0,offset);
        else if(type==0xE0)rustLive(ev.track,3,pitchBendController,(((ev.data2&0x7F)<<7)|(ev.data1&0x7F))-8192,0,offset);
        else if(type==0xD0)rustLive(ev.track,3,channelPressureController,ev.data1&0x7F,0,offset);
        else if(type==0xC0)rustLive(ev.track,3,programChangeController,ev.data1&0x7F,0,offset);
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
  // The sub-block the callback renders (render-ahead hand-backs read it).
  struct Block {
    PreparedProject::Impl* graph=nullptr;const ProcessContext* context=nullptr;const float* input=nullptr;
    std::int64_t position=0;std::uint32_t count=0,cursor=0,channels=0;bool playing=false;
  } block;

  Impl(std::uint32_t r,std::uint32_t b,std::uint32_t capacity):rate(r),maxBlock(b),recordingCapacity(capacity){
    for(std::size_t i=0;i<maxInputLayout;++i){layout[i]=static_cast<std::uint8_t>(i);controlLayout[i]=layout[i];}
  }
  ~Impl(){pool.reset();Command c;
    const auto drop=[](Command& x){if(x.kind==Kind::Graph)delete x.graph;if(x.kind==Kind::Replace)delete x.runtime;};
    while(commands.pop(c))drop(c);
    if(deferred)drop(*deferred);
    PreparedProject*p=nullptr;
    while(retired.pop(p))delete p;
    HostTrack*t=nullptr;
    while(retiredTracks.pop(t))delete t;
    delete active;}
  std::uint64_t enqueue(Command command) {
    command.ticket=nextTicket++;
    if(!commands.push(command)){commandOverflows.fetch_add(1,std::memory_order_relaxed);return 0;}return command.ticket;
  }
  // Control thread: the Rust engine, created with the offline flag set now and the shell's master bypass and
  // metronome forwarded.
  RustBackend& ensureRust() {
    if(!rust) {
      rust=std::make_unique<RustBackend>(rate,maxBlock,offline);
      metronomeForwarded=false;forwardedClicks.reset();
      if(controlMasterBypass)(void)garak_rs_engine_set_master_bypass(rust->handle,1);
      forwardMetronome();
    }
    return *rust;
  }
  // Control thread: the shell's metronome settings into the Rust engine (strokes only when they changed: equal
  // strokes keep ringing; none or strokes at another rate are silence). Returns the Rust ticket, or 0.
  std::int64_t forwardMetronome() {
    if(!rust)return 0;
    const bool usable=metronomeClicks&&metronomeClicks->sampleRate==rate;
    std::uint32_t strokes=0;
    if(usable&&(metronomeClicks!=forwardedClicks||!metronomeForwarded))strokes=1;
    else if(!usable&&(forwardedClicks||!metronomeForwarded))strokes=2;
    const float* levels[3]{};std::size_t lengths[3]{};
    if(strokes==1)for(std::size_t i=0;i<3;++i){levels[i]=metronomeClicks->levels[i].data();lengths[i]=metronomeClicks->levels[i].size();}
    const auto ticket=garak_rs_engine_set_metronome(rust->handle,strokes,rate,levels,lengths,metronomeOn?1:0,metronomeGain);
    if(ticket<0)return 0;
    metronomeForwarded=true;
    forwardedClicks=usable?metronomeClicks:nullptr;
    return ticket;
  }
  // Control thread: submit `p` to the Rust graph (throws with the Rust engine's reason when it refuses it).
  int rustApply(const ProjectTimeline& p,const AssetStore& assets,const SampleSetStore& sets,const ControlRecipe* recipe) {
    return ensureRust().apply(p,assets,rustSampleSets(p,sets),recipe);
  }
  // Control thread: the Rust commands queued so far apply at this point of the shell's command order.
  std::uint64_t enqueueRustSync() {
    Command c;c.kind=Kind::RustSync;c.frame=static_cast<std::int64_t>(rust?rust->ticket():0);
    return enqueue(c);
  }
  // A live event for the Rust graph's track `track` (callback, after `own` of that track) `offset` frames into the
  // block about to render: its built-in instrument plays it on that sample, a VST3 host node gets it through
  // rustLiveNode with that offset (kind 0 note on (a = id), 1 note off (a = id), 2 all notes off, 3 controller
  // (pitch = controller, a = value), 4 preview (a = frames)).
  void rustLive(std::uint32_t track,std::uint32_t kind,int pitch,int a,float velocity,std::uint32_t offset=0)noexcept {
    if(!rustRenders())return;
    rustPrepare(); // The event lands on the Rust graph this block renders.
    garak_rs_engine_live_at(rust->handle,track,kind,pitch,a,velocity,offset);
  }
  // Callback: the Rust graph applied the commands this shell allowed and could take the next graph now (no
  // IEUM WAVE table crossfade running).
  bool rustSettled()noexcept {
    if(!rustRenders())return true;
    rustPrepare();
    return garak_rs_engine_settled(rust->handle)!=0;
  }
  void rustStopAtEnd()noexcept {
    if(rustRenders())garak_rs_engine_stop_at_end(rust->handle);
  }
  // Tracks rendering ahead are skipped: their producer applies the same cycle
  // wrap at the same frame. Every other caller first reclaims them.
  void reset(bool chase,bool effects)noexcept {
    if(!active)return;
    auto&p=*active->impl_;
    for(auto&t:p.tracks)if(!t.ahead||t.ahead->mode.load(std::memory_order_relaxed)==AheadState::Off)t.reset(position,chase,effects,voiceOverflows);
    if(rustRenders()) {
      std::array<std::uint64_t,4>skip{};
      for(std::size_t i=0;i<p.tracks.size()&&i<256;++i){const auto&t=p.tracks[i];if(t.ahead&&t.ahead->mode.load(std::memory_order_relaxed)!=AheadState::Off)skip[i/64]|=std::uint64_t{1}<<(i%64);}
      garak_rs_engine_reset_skip(rust->handle,position,chase?1:0,effects?1:0,skip.data());
    }
  }
  // Every active graph renders through the Rust engine (prepare() submitted it there first).
  [[nodiscard]] bool rustRenders()const noexcept { return rust&&active; }
  // Host nodes (docs/RUST_ENGINE.md 4), called by the Rust graph from the thread rendering that track, inside
  // renderRust: `block` describes the block. Each touches only its own track.
  static void rustSourceNode(void*self,std::uint32_t track,float*stereo,std::uint32_t frames)noexcept {
    const auto&b=*static_cast<RustScope*>(self);auto&g=*b.graph;
    if(track>=g.tracks.size())return;
    auto&t=g.tracks[track];
    t.renderSource(stereo,b.position,frames,b.playing,*b.context,t.taskOverflows);
  }
  // The block's live events of a host-rendered instrument, right before rustSourceNode: they enter its plug-in
  // event queue at their sample offsets (the VST3 sampleOffset; docs/RUST_ENGINE.md 5.8).
  static void rustLiveNode(void*self,std::uint32_t track,const GarakRsLiveEvent*events,std::uint32_t count)noexcept {
    const auto&b=*static_cast<RustScope*>(self);auto&g=*b.graph;
    if(track>=g.tracks.size()||!events)return;
    auto&t=g.tracks[track];
    for(std::uint32_t i=0;i<count;++i) {
      const auto&ev=events[i];t.liveOffset=ev.offset;
      switch(ev.kind) {
        case 0:t.spawn(ev.pitch,ev.velocity,unlimitedFrame,unlimitedFrame,ev.a,true,t.taskOverflows);break;
        case 1:t.noteOff(ev.pitch,ev.a,t.taskOverflows);break;
        case 2:t.allNotesOff(t.taskOverflows);break;
        case 3:t.controlChange(ev.pitch,ev.a,t.taskOverflows);break;
        case 4:t.spawn(ev.pitch,ev.velocity,ev.a,ev.a,-2,true,t.taskOverflows);break;
        default:break;
      }
    }
    t.liveOffset=0;
  }
  static void rustInsertNode(void*self,std::uint32_t track,std::uint32_t insert,float*stereo,std::uint32_t frames)noexcept {
    const auto&b=*static_cast<RustScope*>(self);auto&g=*b.graph;
    if(track>=g.tracks.size())return;
    auto&t=g.tracks[track];
    for(std::size_t k=0;k<t.inserts.size();++k)if(t.inserts[k].source==insert&&t.inserts[k].plugin){t.processPlugin(k,stereo,b.position,frames,*b.context,t.taskOverflows);return;}
  }
  // Each monitored track hears its own physical input; an unopened one hears silence.
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
  // Callback: the Rust commands this block may apply, first (no render-ahead worker may be inside the Rust graph
  // while they apply), so the rings and the render see the graph this block's shell graph matches. The first
  // block of an engine resets the Rust tracks at the shell's position. Also run before a live event reaches the
  // Rust graph (rustLive).
  void rustPrepare()noexcept {
    if(!rustRendered||rustConsumed!=rustAllowed){quiesce();garak_rs_engine_render_block(rust->handle,nullptr,0,position,playing&&position<active->impl_->timeline.lengthFrames?1:0,rustAllowed,nullptr,0,nullptr,nullptr);rustConsumed=rustAllowed;}
    if(!rustRendered){
      reclaimAll(true);
      garak_rs_engine_reset(rust->handle,position,playing&&position<active->impl_->timeline.lengthFrames?1:0,1);
      rustRendered=true;
    }
  }
  // Callback: one Rust block, master bus included. The track meters follow the Rust graph's; host nodes see the
  // block's transport context.
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
    rustNodes.user=&rustScope;rustNodes.source=&rustSourceNode;rustNodes.insert=&rustInsertNode;rustNodes.input=&rustInputNode;rustNodes.live=&rustLiveNode;
    GarakRsBlock b{};b.position=position;b.playing=audible?1:0;b.allowed=rustAllowed;b.master=1;
    for(std::size_t i=0;i<monitor.size();++i)b.monitor[i]=monitor[i];
    b.nodes=&rustNodes;b.ahead=rustAhead.data();b.ahead_count=static_cast<std::uint32_t>(std::min<std::size_t>(p.tracks.size(),rustAhead.size()));
    const bool parallel=pool&&forkEnabled&&p.tracks.size()>=2;
    garak_rs_engine_render_host(rust->handle,out,count,&b,rustPeaks.data(),static_cast<std::uint32_t>(std::min<std::size_t>(p.tracks.size(),rustPeaks.size())),
      parallel?&rustParallelRun:nullptr,this);
    publishAnalysis(count);
    for(std::size_t i=0;i<p.tracks.size();++i) {
      auto&t=p.tracks[i];
      if(i<rustPeaks.size()&&!rustAhead[i])t.meter=rustPeaks[i]; // Ahead tracks: their ring's chunk peaks.
      voiceOverflows+=t.taskOverflows;invalidSamples+=t.taskInvalid;aheadResyncs+=t.taskResyncs;t.taskResyncs=0;
    }
    rustBlockCounter.fetch_add(1,std::memory_order_relaxed);
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
  // One block of an ahead track (its Rust graph track, host nodes included) into `out`; returns its peak.
  float renderOwn(const PreparedProject::Impl&g,std::uint32_t index,std::int64_t frame,std::uint32_t count,bool playing,
                  const ProcessContext&context,float*out)noexcept {
    RustScope scope{this,const_cast<PreparedProject::Impl*>(&g),&context,nullptr,frame,0,0,playing};
    const GarakRsHostNodes nodes{&scope,&rustSourceNode,&rustInsertNode,&rustInputNode,&rustLiveNode};
    float peak=0;const float*mix=garak_rs_engine_render_ahead(rust->handle,index,frame,count,playing?1:0,&nodes,&peak);
    if(mix)std::copy_n(mix,static_cast<std::size_t>(count)*2,out);else std::fill_n(out,static_cast<std::size_t>(count)*2,0.f);
    return peak;
  }
  // A track the callback takes back from its ring out of sync: host and Rust track state restart here.
  void resetOwn(HostTrack&t,std::uint32_t index,std::int64_t frame,bool chase,std::uint64_t&overflows)noexcept {
    t.reset(frame,chase,true,overflows);
    rustResetTrack(index,frame,chase,true);
  }
  // The same reset of the Rust graph's track (the calling thread owns it: the callback, or its ahead producer).
  void rustResetTrack(std::uint32_t index,std::int64_t frame,bool chase,bool effects)noexcept {
    if(rustRenders())garak_rs_engine_reset_track(rust->handle,index,frame,chase?1:0,effects?1:0);
  }
  // Busy holder: render this track's next block exactly as the callback would.
  AheadState::Produce produce(const PreparedProject::Impl&g,HostTrack&t,std::uint32_t index,bool helping)noexcept {
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
    const float peak=renderOwn(g,index,a.nextFrame,count,true,context,scratch);
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
    HostTrack*best=nullptr;std::uint32_t bestIndex=0;std::uint64_t bestFill=std::numeric_limits<std::uint64_t>::max();
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
  bool catchUp(const PreparedProject::Impl&g,HostTrack&t,std::uint32_t index,std::int64_t frame,std::uint64_t&overflows)noexcept {
    auto&a=*t.ahead;const auto&p=g.timeline;
    overflows+=a.pendingOverflows;a.pendingOverflows=0;
    if(a.nextFrame==frame)return true;
    if(!p.cycle)return false;
    if(a.nextFrame>=p.cycle->at(1)&&frame==p.cycle->at(0)){a.nextFrame=frame;t.reset(frame,true,false,overflows);rustResetTrack(index,frame,true,false);return true;}
    return a.nextFrame==p.cycle->at(0)&&frame>=p.cycle->at(1);
  }
  // Callback (transport change): every ahead track returns to the callback. A
  // drained ring hands over seamlessly; otherwise its state is ahead of the
  // playhead and is reset here unless the caller resets all.
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
  bool own(HostTrack&t)noexcept {
    if(!t.ahead)return true;
    const auto mode=t.ahead->mode.load(std::memory_order_relaxed);
    if(mode==AheadState::Off)return true;
    if(mode==AheadState::Active)t.ahead->mode.store(AheadState::Draining,std::memory_order_release);
    return false;
  }
  void markLive(HostTrack&t)noexcept{t.liveUntil=continuousFrame+static_cast<std::int64_t>(rate)*2;}
  // This track's audio for `block` from its ring into ahead->out (t.mix).
  // False when the ring lost sync; the caller then resets and renders it in the graph.
  bool consumeAhead(PreparedProject::Impl&g,HostTrack&t,std::uint32_t index)noexcept {
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
          t.meter=renderOwn(g,index,block.position+got,count-got,block.playing,context,a.out.data()+static_cast<std::size_t>(got)*2);
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
      // Drained exactly at this block's end: the next block renders in the graph.
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
        if((monitor[i/64]&(std::uint64_t{1}<<(i%64)))||t.pendingCount)continue;
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
          // No worker may be inside either graph while its state is read, moved or retired (the next block's
          // promote() lets them back in). A rapid edit waits until the Rust graph took the previous one and
          // its IEUM WAVE table crossfade (20 ms) finished, so both graphs swap in the same block.
          quiesce();
          if(preserve&&!rustSettled()){deferred=c;return;}
          if(preserve) {
            // A track whose events change continues from the playhead: its render-ahead ring drains first.
            auto&next=*c.graph->impl_;bool wait=false;
            for(auto&t:next.tracks)if(t.predecessor>=0&&(!t.identical||next.headerChanged)&&!own(previous->impl_->tracks[static_cast<std::size_t>(t.predecessor)]))wait=true;
            if(wait){deferred=c;return;}
            handOverAhead(*previous->impl_,next);
          }
          active=c.graph;
          if(preserve)active->impl_->takeStateFrom(*previous->impl_,position,playing,voiceOverflows);
          else aheadTracks=0;
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
          // Live commands carry no device timestamp: they start the block (the Rust graph takes them, host nodes
          // included).
          rustLive(c.track,c.kind==Kind::NoteOff?1:c.kind==Kind::AllNotesOff?2:c.kind==Kind::Control?3:c.kind==Kind::Preview?4:0,
                   c.pitch,c.kind==Kind::Control?static_cast<int>(c.value):c.kind==Kind::Preview?static_cast<int>(c.frame):c.noteId,c.value);
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
        case Kind::Input:inputLeft=c.pitch;inputRight=static_cast<int>(c.frame);break;
        case Kind::Layout:layout=c.layout;layoutCount=c.track;break;
        case Kind::Touch: {
          if(!active||c.track>=active->impl_->tracks.size())break;
          auto&t=active->impl_->tracks[c.track];
          if(!own(t)){deferred=c;return;}
          // Keep the track in the callback while it is edited: each tick then applies on the next block.
          markLive(t);
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
          std::unique_ptr<HostTrack> swapped(incoming);
          g.tracks.slot(c.track).swap(swapped);
          (void)retiredTracks.push(swapped.release());
          break;
        }
        case Kind::Revision:if(active)active->impl_->timeline.revision=static_cast<std::uint64_t>(c.frame);break;
        case Kind::RustSync:rustAllowed=static_cast<std::uint64_t>(c.frame);break;
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
    if(active&&rustRendered) {
      std::array<GarakRsDynamicsReading,EngineSnapshot::maxDynamicsReadings>readings{};
      const auto count=garak_rs_engine_take_dynamics(rust->handle,readings.data(),static_cast<std::uint32_t>(readings.size()));
      for(std::uint32_t i=0;i<count;++i)hold(static_cast<std::uint32_t>(readings[i].track)<<16|readings[i].insert,readings[i].input,readings[i].gain);
    }
    published.dynamicsCount.store(slot,std::memory_order_relaxed);
  }
  void publish(float masterPeak)noexcept {
    published.frame.store(position,std::memory_order_relaxed);published.playing.store(playing||countInRemaining>0,std::memory_order_relaxed);published.ready.store(active!=nullptr,std::memory_order_relaxed);
    const auto count=active?active->impl_->tracks.size():0;
    published.trackCount.store(static_cast<std::uint32_t>(count),std::memory_order_relaxed);
    published.revision.store(active?active->impl_->timeline.revision:0,std::memory_order_relaxed);
    // The plug-in delay of the graph the Rust engine renders (a live diff can change it without a new shell graph).
    std::uint32_t latency=0,senderLatency=0;
    if(rustRenders())garak_rs_engine_active_latency(rust->handle,&latency,&senderLatency);
    published.latency.store(latency,std::memory_order_relaxed);
    published.senderLatency.store(senderLatency,std::memory_order_relaxed);
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
// Everything one host track resolves on the control thread: its runtime and the facts update() needs later.
struct TrackBuild {
  HostTrack track;
  ControlTrack info;
};
TrackBuild buildTrack(const ProjectTimeline& p,const TrackTimeline& t,const AssetStore& assets,const SampleSetStore& sets,const PluginResolver& resolvePlugin,
                      std::uint32_t maxBlock) {
  TrackBuild build;auto& track=build.track;auto& info=build.info;
  track.timeline=t;
  require(t.source.kind!=TrackSource::Kind::Audio||t.notes.empty(),"Audio tracks cannot contain instrument notes");
  require(t.source.kind==TrackSource::Kind::Audio||t.audio.empty(),"Instrument tracks cannot contain audio windows");
  // An explicitly disabled source is retained in the immutable recipe but
  // needs neither its sample library nor a loadable third-party plug-in.
  if(!t.enabled)return build;
  double trackTail=0;
  if(t.source.kind==TrackSource::Kind::NativeWavetable) {
    // IEUM WAVE renders only in the Rust graph (docs/IEUM_WAVE.md): the patch is validated here, before the graph
    // changes (its tail comes with the Rust graph's details); the host track keeps no processor for it.
    require(t.source.instrumentId=="wavetable"&&!t.source.isKit,"Invalid IEUM WAVE source");
    (void)checkWavetablePatch(p.sampleRate,t.source.patchData);
  }
  // Sample sets render in the Rust graph; the shell only notes which set and PCM objects the track resolved, so a
  // re-registered set or asset under the same id rebuilds it (update()).
  if(t.source.kind==TrackSource::Kind::BuiltinSampled) {
    const auto set=sets.find(t.source.sampleSetId);
    if(set!=sets.end()) {
      info.set=set->second;
      for(const auto*zones:{&set->second.zones,&set->second.releaseZones})for(const auto&z:*zones){const auto a=assets.find(z.assetId);info.assets.push_back(a==assets.end()?nullptr:a->second);}
    }
  }
  if(t.source.kind==TrackSource::Kind::Vst3){require(static_cast<bool>(resolvePlugin),"No native VST3 host is available");track.instrument=resolvePlugin(t.source.plugin,p.sampleRate,maxBlock);require(static_cast<bool>(track.instrument),"VST3 instrument could not be prepared");track.latency=track.instrument->latencyFrames();trackTail=checked(track.instrument->tailSeconds(),0,3600,"Invalid plugin tail time");require(track.latency<=p.sampleRate*30,"Plugin latency exceeds native memory budget");}
  info.sourceLatency=track.latency;info.sourceTail=trackTail;info.sourceStereo=track.instrument!=nullptr;
  // VST3 instruments take notes and controllers as sample-accurate events.
  const bool pluginSource=track.instrument!=nullptr;
  std::set<std::int32_t>noteIds;
  for(const auto&n:t.notes){require(noteIds.insert(n.id).second&&n.pitch>=0&&n.pitch<=127&&n.onFrame>=-p.lengthFrames&&n.offFrame>n.onFrame&&n.offFrame>0&&n.offFrame<=p.lengthFrames&&n.limitFrame>=n.offFrame&&n.limitFrame<=p.lengthFrames,"Invalid native note event");checked(n.velocity,0,2,"Invalid native note velocity");
    if(pluginSource&&n.velocity>0){track.events.push_back({n.onFrame,{PluginEvent::Type::NoteOn,0,n.id,static_cast<std::uint8_t>(n.pitch),0,std::min(1.f,n.velocity),0}});track.events.push_back({n.offFrame,{PluginEvent::Type::NoteOff,0,n.id,static_cast<std::uint8_t>(n.pitch),0,0,0}});}
  }
  std::stable_sort(track.timeline.notes.begin(),track.timeline.notes.end(),[](const NotePair&a,const NotePair&b){return a.onFrame<b.onFrame||(a.onFrame==b.onFrame&&a.id<b.id);});
  for(std::size_t i=0;i<t.controls.size();++i){
    const auto&c=t.controls[i];
    require(c.frame>=0&&c.frame<=p.lengthFrames&&validControllerValue(c.controller,c.value)&&(!i||t.controls[i-1].frame<=c.frame),"Invalid native control event");
    // The bend range is a built-in meta controller.
    if(!pluginSource||c.controller==bendRangeController)continue;
    PluginEvent e{};e.type=PluginEvent::Type::Controller;e.parameterId=c.controller;e.value=normalizedControllerValue(c.controller,c.value);
    track.events.push_back({c.frame,e});
  }
  std::stable_sort(track.events.begin(),track.events.end(),[](const TimedPluginEvent&a,const TimedPluginEvent&b){return a.frame<b.frame||(a.frame==b.frame&&eventOrder(a.event.type)<eventOrder(b.event.type));});
  for(std::size_t begin=0,end=0;end<track.events.size();++end){
    while(track.events[end].frame-track.events[begin].frame>=maxBlock)++begin;
    // Leave room for all queued live notes and their auto-release events.
    require(end-begin+1<=maxPluginEvents-maxVoices*2-1,"Instrument note density exceeds the bounded event buffer");
  }
  for(const auto&w:t.audio)info.assets.push_back(resolveAsset(assets,w.assetId));
  std::set<std::string>insertIds;
  for(const auto&e:t.inserts){require(!e.id.empty()&&insertIds.insert(e.id).second,"Duplicate native insert ID");if(!e.enabled)continue;
    InsertRuntime effect;effect.source=static_cast<std::uint16_t>(&e-t.inserts.data());
    if(e.type=="vst3"){require(static_cast<bool>(resolvePlugin),"No native VST3 host is available");effect.plugin=resolvePlugin(e.plugin,p.sampleRate,maxBlock);require(static_cast<bool>(effect.plugin),"VST3 effect could not be prepared");const auto latency=effect.plugin->latencyFrames();require(latency<=p.sampleRate*30,"Plugin latency exceeds native memory budget");track.latency+=latency;const auto tail=checked(effect.plugin->tailSeconds(),0,3600,"Invalid plugin tail time");
      info.pluginInserts.resize(t.inserts.size());info.pluginInserts[effect.source]={latency,tail};}
    require(track.latency<=p.sampleRate*30,"Plugin latency exceeds native memory budget");track.inserts.push_back(std::move(effect));
  }
  prepareAutomation(track,t);
  info.latency=track.latency;
  return build;
}
bool aheadCandidate(const HostTrack& t) {
  const bool vst3=t.vst3()||std::any_of(t.inserts.begin(),t.inserts.end(),[](const InsertRuntime&i){return i.plugin!=nullptr;});
  return t.timeline.enabled&&!vst3;
}
// Tracks that read or feed a tap in the same block (routed tracks, the sources of pre/post-FX taps and of delayed
// post-fader taps, senders and returns): they stay out of render-ahead rings. `returnLatency`: the graph's extra
// delay of latent return tracks (a post-fader route then reads a tap before that delay). Mirrors the Rust graph's
// routes.rs / send preparation (src/core/trackRouting.ts).
std::vector<char> routingTracks(const ProjectTimeline& p,std::uint32_t returnLatency) {
  const auto count=p.tracks.size();
  std::vector<char> routing(count,0);
  std::vector<std::int32_t> source(count,-1);
  for(std::size_t i=0;i<count;++i) {
    const auto&t=p.tracks[i];
    if(t.isReturn){routing[i]=1;continue;}
    if(!t.route||t.source.kind!=TrackSource::Kind::Audio)continue;
    routing[i]=1;
    if(t.route->kind!=TrackRoute::Kind::Track)continue;
    // Return tracks are never route sources (docs/SENDS_RETURNS.md): a route naming one records silence.
    for(std::size_t j=0;j<count;++j)if(j!=i&&!p.tracks[j].isReturn&&p.tracks[j].id==t.route->trackId){source[i]=static_cast<std::int32_t>(j);break;}
  }
  // Each track has one input: a loop is a chain that returns to its start. Break it at that track.
  for(std::size_t i=0;i<count;++i) {
    std::size_t steps=0;
    for(auto at=source[i];at>=0&&steps<=count;at=source[static_cast<std::size_t>(at)],++steps)
      if(static_cast<std::size_t>(at)==i){source[i]=-1;break;}
  }
  for(std::size_t i=0;i<count;++i) {
    if(source[i]<0)continue;
    const auto tap=p.tracks[i].route->tap;
    if(tap!=TrackRoute::Tap::PostFader||returnLatency)routing[static_cast<std::size_t>(source[i])]=1;
  }
  // Sends: each feeds an existing return (never itself; returns never send).
  for(std::size_t i=0;i<count;++i) {
    if(p.tracks[i].isReturn)continue;
    for(const auto&send:p.tracks[i].sends)
      for(std::size_t r=0;r<count;++r)if(r!=i&&p.tracks[r].isReturn&&p.tracks[r].id==send.returnId){routing[i]=1;break;}
  }
  return routing;
}
} // namespace

std::unique_ptr<PreparedProject> RenderEngine::prepare(const ProjectTimeline& p,const AssetStore& assets,const SampleSetStore& sets,const PluginResolver& resolvePlugin)const {
  return prepareGraph(p,p,assets,sets,resolvePlugin);
}

// `p`: the shell's plan (update() renumbers notes against the running graph); `plan`: what the Rust engine receives
// (it renumbers them itself). Same tracks in the same order.
std::unique_ptr<PreparedProject> RenderEngine::prepareGraph(const ProjectTimeline& p,const ProjectTimeline& plan,const AssetStore& assets,const SampleSetStore& sets,const PluginResolver& resolvePlugin)const {
  require(p.version==1&&p.sampleRate==impl_->rate,"Native project/device sample rates must agree");
  require(p.tracks.size()<=256&&p.lengthFrames>0&&p.lengthFrames<=static_cast<std::int64_t>(p.sampleRate)*3600,"Native project exceeds track/duration limits");
  require(p.projectId.size()<=200&&!p.projectId.empty(),"Invalid native project ID");
  checked(p.bpm,20,400,"Invalid native tempo");checked(p.masterGain,0,2,"Invalid native master gain");
  require(p.timeSigNumerator>=1&&p.timeSigNumerator<=32&&(p.timeSigDenominator==2||p.timeSigDenominator==4||p.timeSigDenominator==8||p.timeSigDenominator==16),"Invalid native meter");
  if(p.cycle)require(p.cycle->at(0)>=0&&p.cycle->at(1)<=p.lengthFrames&&p.cycle->at(1)>p.cycle->at(0),"Invalid native cycle");
  std::size_t noteCount=0,windowCount=0;
  std::set<std::string>ids,pluginIds;
  for(const auto&t:p.tracks){require(!t.id.empty()&&t.id.size()<=200&&ids.insert(t.id).second,"Invalid or duplicate native track ID");
    noteCount+=t.notes.size();windowCount+=t.audio.size();require(t.inserts.size()<=64&&t.audio.size()<=2048,"Native track exceeds limits");
    const auto uniquePlugin=[&](const PluginSpec&plugin){require(!plugin.instanceId.empty()&&pluginIds.insert(plugin.instanceId).second,"Invalid or duplicate native plugin instance ID");};
    if(t.source.kind==TrackSource::Kind::Vst3)uniquePlugin(t.source.plugin);
    for(const auto&e:t.inserts)if(e.type=="vst3")uniquePlugin(e.plugin);
  }
  require(noteCount<=100000&&windowCount<=8192,"Native project exceeds bounded memory/event limits");
  auto result=std::make_unique<PreparedProject::Impl>(p);result->tracks.reserve(p.tracks.size());
  auto recipe=std::make_unique<ControlRecipe>();recipe->timeline=headerOf(p);recipe->timeline.tracks.reserve(p.tracks.size());recipe->tracks.reserve(p.tracks.size());
  for(const auto&t:p.tracks) {
    auto build=buildTrack(p,t,assets,sets,resolvePlugin,impl_->maxBlock);
    recipe->tracks.push_back(std::move(build.info));recipe->timeline.tracks.push_back(t);
    result->tracks.push_back(std::move(build.track));
  }
  // The Rust graph of the same plan, with the host nodes' delays and tails. It is queued now and applies with the
  // shell's graph command (submit). Its delays and tails are the graph's (built-in effects and instruments).
  (void)impl_->rustApply(plan,assets,sets,recipe.get());
  double tail=0,trackTail=0;
  garak_rs_engine_graph_details(impl_->rust->handle,&result->latency,&result->senderLatency,&tail,&trackTail);
  result->tail=tail;result->trackTail=trackTail;
  recipe->senderLatency=result->senderLatency;recipe->returnLatency=result->latency-result->senderLatency;
  const auto routing=routingTracks(p,recipe->returnLatency);
  for(std::size_t i=0;i<result->tracks.size();++i){recipe->tracks[i].routing=routing[i]!=0;recipe->tracks[i].aheadEligible=aheadCandidate(result->tracks[i])&&!routing[i];}
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
// Control thread: link every track of `next` to the same track id of the running graph (`last`), so the swap
// carries instruments, plug-in state and live notes over per track instead of by position.
void linkGraph(PtrList<HostTrack>& tracks,bool& headerChanged,std::vector<std::int32_t>& successor,const ControlRecipe& recipe,const ControlRecipe& last) {
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
  Impl::Command c;c.kind=Impl::Kind::Graph;c.graph=project.get();
  const auto serial=impl_->enqueue(c);
  if(!serial)throw std::runtime_error("Native graph command queue is full");
  // The Rust graph prepare() queued applies in the same block as this graph.
  (void)impl_->enqueueRustSync();
  impl_->lastSubmittedRecipe=std::move(recipe);impl_->lastSubmittedSerial=serial;
  (void)project.release();
  return serial;
}

UpdateResult RenderEngine::update(const ProjectTimeline& p,const AssetStore& assets,const SampleSetStore& sets,const PluginResolver& resolvePlugin) {
  collectRetired();
  auto&e=*impl_;
  auto*last=e.lastSubmittedRecipe.get();
  UpdateResult result;
  // Full path: a new graph whose tracks continue the running ones by id. Unchanged notes keep their ids. The Rust
  // engine classifies the same plan itself (it may apply it as a diff): the result names the larger change.
  const auto full=[&]{
    ProjectTimeline staged=p;
    if(last&&last->timeline.projectId==p.projectId) {
      std::unordered_map<std::string_view,std::size_t> previous;
      for(std::size_t i=0;i<last->timeline.tracks.size();++i)previous.emplace(last->timeline.tracks[i].id,i);
      for(auto&t:staged.tracks){const auto found=previous.find(t.id);if(found!=previous.end())(void)renumberNotes(last->timeline.tracks[found->second].notes,t.notes);}
    }
    auto prepared=prepareGraph(staged,p,assets,sets,resolvePlugin);
    result.replacedTracks=garak_rs_engine_replaced_tracks(e.rust->handle);
    result.ticket=submit(std::move(prepared));result.kind=UpdateResult::Kind::Full;
    return result;
  };
  if(!last||p.version!=last->timeline.version||p.projectId!=last->timeline.projectId||p.sampleRate!=last->timeline.sampleRate||!sameTiming(p,last->timeline)||
     p.lowLatencyMonitoring!=last->timeline.lowLatencyMonitoring||p.tracks.size()!=last->timeline.tracks.size())return full();
  for(std::size_t i=0;i<p.tracks.size();++i)if(p.tracks[i].id!=last->timeline.tracks[i].id)return full();
  checked(p.masterGain,0,2,"Invalid native master gain");
  // Classify every track against the running graph (the shell's part: host tracks to rebuild, tracks to pull back
  // from render-ahead for a live edit, VST3 parameter values).
  struct Plan { bool replace=false,touch=false; std::vector<const PluginSpec*> pluginParams; };
  std::vector<Plan> plans(p.tracks.size());
  std::size_t noteCount=0;
  for(std::size_t i=0;i<p.tracks.size();++i) {
    const auto&neu=p.tracks[i];const auto&old=last->timeline.tracks[i];const auto&info=last->tracks[i];auto&plan=plans[i];
    noteCount+=neu.notes.size();
    if(neu.isReturn!=old.isReturn||neu.route!=old.route||neu.sends.size()!=old.sends.size())return full();
    for(std::size_t s=0;s<neu.sends.size();++s)
      if(neu.sends[s].returnId!=old.sends[s].returnId||neu.sends[s].pre!=old.sends[s].pre||sendLane(neu,neu.sends[s].returnId)!=sendLane(old,old.sends[s].returnId))return full();
    plan.touch=neu.gain!=old.gain||neu.pan!=old.pan||neu.mute!=old.mute||neu.solo!=old.solo||neu.soloSafe!=old.soloSafe||neu.audible!=old.audible||neu.unmutedAudible!=old.unmutedAudible;
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
      // A built-in effect parameter: the Rust graph sets it in place or rebuilds its track.
      if(a.params!=b.params&&runtime[k]>=0)plan.touch=true;
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
    if(replace){plan.touch=false;plan.pluginParams.clear();}
  }
  require(noteCount<=100000,"Native project exceeds bounded memory/event limits");
  // Build replacements (control thread); any that would change the host nodes' delay falls back to a full graph.
  struct Replacement { std::size_t index; std::unique_ptr<HostTrack> runtime; ControlTrack info; TrackTimeline timeline; };
  std::vector<Replacement> replacements;
  for(std::size_t i=0;i<p.tracks.size();++i) {
    if(!plans[i].replace)continue;
    if(e.replacementsInFlight+replacements.size()+1>=Impl::retiredTrackCapacity)return full();
    const auto&old=last->timeline.tracks[i];const auto&info=last->tracks[i];
    TrackTimeline neu=p.tracks[i];
    const bool wave=neu.source.kind==TrackSource::Kind::NativeWavetable||old.source.kind==TrackSource::Kind::NativeWavetable;
    const bool sameWave=neu.source==old.source&&neu.enabled&&old.enabled;
    if(wave&&!sameWave)return full(); // IEUM WAVE patch changes keep their table crossfade on the graph path.
    auto removed=renumberNotes(old.notes,neu.notes);
    auto build=buildTrack(p,neu,assets,sets,resolvePlugin,e.maxBlock);
    if(build.info.latency!=info.latency)return full(); // Plug-in delay compensation of the whole graph changes.
    auto runtime=std::make_unique<HostTrack>(std::move(build.track));
    auto&t=*runtime;
    t.predecessor=static_cast<std::int32_t>(i);
    t.sameSource=old.enabled&&neu.enabled&&sameSourceIdentity(old.source,neu.source)&&info.set==build.info.set&&
      (neu.source.kind!=TrackSource::Kind::BuiltinSampled||info.assets==build.info.assets);
    t.insertOrigin=insertOrigins(old,neu);
    t.removedNotes=std::move(removed);
    build.info.routing=info.routing;
    build.info.aheadEligible=aheadCandidate(t)&&!info.routing;
    t.aheadEligible=build.info.aheadEligible;
    replacements.push_back({i,std::move(runtime),std::move(build.info),std::move(neu)});
  }
  // The Rust graph first, with the replacements' host-node delays: a refusal throws here and leaves both graphs as
  // they are (nothing is queued yet).
  int rustKind=0;
  {
    ControlRecipe staged;staged.timeline=headerOf(p);staged.tracks=last->tracks;staged.senderLatency=last->senderLatency;staged.returnLatency=last->returnLatency;
    for(const auto&r:replacements)staged.tracks[r.index]=r.info;
    rustKind=e.rustApply(p,assets,sets,&staged);
  }
  // The Rust engine built a new graph (e.g. a built-in effect's structural edit changed the plug-in delay): the
  // shell follows with a new graph too, so render-ahead rings and host tracks hand over at the same block. The
  // Rust engine finds that plan applied already.
  if(rustKind==3)return full();
  // Commands: per track its replacement, then the touched tracks; then the revision and the Rust graph's commands.
  std::vector<Impl::Command> commands;
  for(auto&r:replacements){Impl::Command c;c.kind=Impl::Kind::Replace;c.track=static_cast<std::uint32_t>(r.index);c.runtime=r.runtime.get();commands.push_back(c);}
  for(std::size_t i=0;i<p.tracks.size();++i)if(plans[i].touch){Impl::Command c;c.kind=Impl::Kind::Touch;c.track=static_cast<std::uint32_t>(i);commands.push_back(c);}
  {Impl::Command c;c.kind=Impl::Kind::Revision;c.frame=static_cast<std::int64_t>(p.revision);commands.push_back(c);}
  {Impl::Command c;c.kind=Impl::Kind::RustSync;c.frame=static_cast<std::int64_t>(e.rust->ticket());commands.push_back(c);}
  // VST3 parameter values: the host's resolver applies them to its cached instances.
  for(std::size_t i=0;i<plans.size();++i)for(const auto*plugin:plans[i].pluginParams)if(resolvePlugin)(void)resolvePlugin(*plugin,p.sampleRate,e.maxBlock);
  std::uint32_t shellCommands=0;
  for(auto&c:commands) {
    const auto ticket=e.enqueue(c);
    if(!ticket) {
      // The callback has stopped draining: forget the recipe so the next update rebuilds the whole graph.
      // Replacements not yet queued are still owned here.
      e.lastSubmittedRecipe.reset();
      throw std::runtime_error("Native graph command queue is full");
    }
    if(c.kind==Impl::Kind::Replace){for(auto&r:replacements)if(r.runtime.get()==c.runtime)(void)r.runtime.release();++e.replacementsInFlight;++result.replacedTracks;}
    if(c.kind==Impl::Kind::Touch)++shellCommands;
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
  const auto shellKind=result.replacedTracks?UpdateResult::Kind::Tracks:shellCommands?UpdateResult::Kind::Diff:UpdateResult::Kind::None;
  result.kind=std::max(shellKind,static_cast<UpdateResult::Kind>(std::clamp(rustKind,0,3)));
  result.replacedTracks=std::max(result.replacedTracks,garak_rs_engine_replaced_tracks(e.rust->handle));
  return result;
}

void RenderEngine::collectRetired(){
  if(impl_->rust)impl_->rust->collect();
  PreparedProject*p=nullptr;while(impl_->retired.pop(p))delete p;
  HostTrack*t=nullptr;while(impl_->retiredTracks.pop(t)){delete t;if(impl_->replacementsInFlight)--impl_->replacementsInFlight;}
}
std::uint64_t RenderEngine::play(std::int64_t countIn){require(countIn>=0&&countIn<=std::int64_t(impl_->rate)*120,"Invalid count-in length");Impl::Command c;c.kind=Impl::Kind::Play;c.frame=countIn;return impl_->enqueue(c);}
std::uint64_t RenderEngine::setMetronome(std::shared_ptr<const MetronomeClicks> clicks,bool enabled,float volume){
  auto&e=*impl_;
  checked(volume,0,2,"Invalid metronome volume");
  if(clicks)for(const auto&level:clicks->levels){require(level.size()<=std::size_t(e.rate)*4,"Metronome stroke is too long");for(const auto v:level)require(std::isfinite(v)&&std::abs(v)<=4,"Invalid metronome stroke sample");}
  e.metronomeClicks=std::move(clicks);e.metronomeOn=enabled;e.metronomeGain=volume;
  // The Rust engine copies the strokes; they click after its master bus (garak_rs_engine_clicks).
  e.ensureRust();
  (void)e.forwardMetronome();
  return e.enqueueRustSync();
}
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
std::uint64_t RenderEngine::setMasterGain(float gain){
  checked(gain,0,2,"Invalid master gain");
  auto&e=*impl_;
  if(garak_rs_engine_set_master_gain(e.ensureRust().handle,gain)<0)return 0;
  return e.enqueueRustSync();
}
std::uint64_t RenderEngine::setInputChannels(int left,int right){require(left>=0&&left<64&&right>=-1&&right<64,"Invalid native input channel");Impl::Command c;c.kind=Impl::Kind::Input;c.pitch=left;c.frame=right;impl_->controlLeft=left;impl_->controlRight=right;return impl_->enqueue(c);}
void RenderEngine::setOffline(bool value)noexcept{
  auto&e=*impl_;
  if(e.offline==value)return;
  e.offline=value;
  // A Rust engine created before (by setMetronome or setMasterGain) was made for the other mode: the next need
  // creates one for this mode. Only valid before the first submit, like the rest of this setting.
  if(!e.lastSubmittedRecipe&&!e.active)e.rust.reset();
}
std::uint64_t rustEngineBlocks()noexcept{return rustBlockCounter.load(std::memory_order_relaxed);}
std::uint64_t RenderEngine::setAnalysis(std::span<const AnalysisTap> taps){
  auto&e=*impl_;
  require(taps.size()<=analysisSlots,"Too many analysis taps");
  std::array<std::int32_t,analysisSlots*3> raw{};
  for(std::size_t k=0;k<taps.size();++k){require(taps[k].track>=-1&&taps[k].track<256&&taps[k].insert>=-1&&taps[k].insert<=65535,"Invalid analysis tap");raw[k*3]=taps[k].track;raw[k*3+1]=taps[k].insert;raw[k*3+2]=taps[k].tuner?1:0;}
  if(!e.rust)return 0;
  if(garak_rs_engine_set_analysis(e.rust->handle,raw.data(),static_cast<std::uint32_t>(taps.size()))<0)throw std::runtime_error("The Rust engine refused the analysis taps");
  // The callback keeps appending the previous slots until the Rust command applies: a new tap's history starts
  // with a little of the old one, which the next publications push out.
  e.analysisTaps.store(static_cast<std::uint32_t>(taps.size()),std::memory_order_release);
  return e.enqueueRustSync();
}
std::uint64_t RenderEngine::readAnalysis(std::uint32_t slot,std::span<float> out)const noexcept{
  const auto&e=*impl_;
  const std::size_t size=static_cast<std::size_t>(analysisFrames)*2;
  if(slot>=analysisSlots||out.size()<size)return 0;
  for(int attempt=0;attempt<8;++attempt){
    const auto before=e.analysisSeq.load(std::memory_order_acquire);
    if(before&1u){std::this_thread::yield();continue;}
    const auto version=e.analysisVersion.load(std::memory_order_acquire);
    const std::size_t base=slot*size,split=static_cast<std::size_t>(e.analysisWrite)*2;
    std::copy(e.analysisRing.begin()+static_cast<std::ptrdiff_t>(base+split),e.analysisRing.begin()+static_cast<std::ptrdiff_t>(base+size),out.begin());
    std::copy(e.analysisRing.begin()+static_cast<std::ptrdiff_t>(base),e.analysisRing.begin()+static_cast<std::ptrdiff_t>(base+split),out.begin()+static_cast<std::ptrdiff_t>(size-split));
    std::atomic_thread_fence(std::memory_order_acquire);
    if(e.analysisSeq.load(std::memory_order_relaxed)==before)return version;
  }
  return 0;
}
void RenderEngine::setMasterBypass(bool value)noexcept{
  auto&e=*impl_;
  e.controlMasterBypass=value;
  if(e.rust&&garak_rs_engine_set_master_bypass(e.rust->handle,value?1:0)>=0)(void)e.enqueueRustSync();
}
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
        else if(!e.offline){e.reclaimAll(false);e.playing=false;for(auto&track:e.active->impl_->tracks)if(track.vst3())track.instrument->requestReset();e.rustStopAtEnd();}
      }
      if(e.playing&&e.position<boundary)count=static_cast<std::uint32_t>(std::min<std::int64_t>(count,boundary-e.position));
    }
    if(e.renderedCount<Impl::maxRendered)e.rendered[e.renderedCount++]={cursor,count,e.position,e.active&&e.playing&&!countingIn};
    auto*out=output+static_cast<std::size_t>(cursor)*2;std::fill_n(out,static_cast<std::size_t>(count)*2,0.f);
    // Tracks and the master bus in the Rust engine.
    const bool viaRust=e.rustRenders();
    if(viaRust)e.renderRust(out,count,input,cursor,channels);
    if(e.recording&&e.capture) {
      // Every take shares one frame clock: the same callback frames, written together. Written after the
      // tracks so a routed take reads its track's route input for exactly these frames.
      auto&cap=*e.capture;
      const auto write=cap.write.load(std::memory_order_relaxed),read=cap.read.load(std::memory_order_acquire);
      const auto available=cap.capacity-(write-read),take=std::min<std::uint64_t>(available,count);
      // Routed takes read their track's route input of these frames in the Rust graph.
      std::array<const float*,maxRecordingTakes>routedInput{};
      for(std::size_t k=0;k<cap.takes.size()&&k<routedInput.size();++k)
        if(cap.takes[k].routed&&viaRust)routedInput[k]=garak_rs_engine_route_input(e.rust->handle,cap.takes[k].track);
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
    // Metronome and count-in clicks after the master bus and the meters: monitor only (offline engines never click).
    if(!e.offline) {
      if(e.rust)garak_rs_engine_clicks(e.rust->handle,out,count,e.position,e.playing?1:0,countingIn?1:0,e.countInElapsed,e.countInLength);
      if(countingIn)e.countInElapsed+=count;
    }
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
    else if(!p.cycle&&e.position>=p.lengthFrames){e.reclaimAll(false);e.playing=false;for(auto&track:e.active->impl_->tracks)if(track.vst3())track.instrument->requestReset();e.rustStopAtEnd();}
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
  s.rustEngine=e.publishedRust.load(std::memory_order_relaxed);
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

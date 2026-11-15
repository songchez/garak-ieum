// Live MIDI: lock-free queues, routing/active-note table, sample-accurate live
// events and transport stamps (docs/MIDI_RECORDING.md). No golden hashes: only
// exact silence (0.0f) before an onset and energy thresholds after it.
#include "garak/engine.hpp"
#include "midi_input.hpp"
#include "midi_queue.hpp"
#include "midi_routing.hpp"

#include <atomic>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <new>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {
std::atomic<bool> watching{false};
std::atomic<std::size_t> heapOperations{0};
void check(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }
}
void* operator new(std::size_t size) { if (watching.load(std::memory_order_relaxed)) heapOperations.fetch_add(1); if (void* p = std::malloc(size ? size : 1)) return p; throw std::bad_alloc(); }
void* operator new[](std::size_t size) { return ::operator new(size); }
void operator delete(void* p) noexcept { if (p && watching.load(std::memory_order_relaxed)) heapOperations.fetch_add(1); std::free(p); }
void operator delete[](void* p) noexcept { ::operator delete(p); }
void operator delete(void* p, std::size_t) noexcept { ::operator delete(p); }
void operator delete[](void* p, std::size_t) noexcept { ::operator delete(p); }

namespace {
using namespace garak;
using namespace garak::midi;

template<class F> void noHeap(F&& f, const char* message) {
  heapOperations = 0; watching = true; f(); watching = false;
  check(heapOperations.load() == 0, message);
}

void mpscQueueMultiProducer() {
  constexpr int producers = 4, perProducer = 20000;
  auto queue = std::make_unique<MpscQueue<RawMidi, 1024>>();
  std::vector<std::thread> threads;
  for (int p = 0; p < producers; ++p) threads.emplace_back([&, p] {
    for (int i = 0; i < perProducer;) {
      RawMidi m; m.source = static_cast<std::uint16_t>(p); m.nanos = i;
      if (queue->push(m)) ++i; else std::this_thread::yield();
    }
  });
  std::vector<std::int64_t> next(producers, 0); int received = 0;
  while (received < producers * perProducer) {
    RawMidi m;
    if (!queue->pop(m)) { std::this_thread::yield(); continue; }
    check(m.source < producers, "Corrupt source from MPSC queue");
    check(m.nanos == next[m.source], "MPSC queue reordered one producer's messages");
    ++next[m.source]; ++received;
  }
  for (auto& t : threads) t.join();
  RawMidi extra; check(!queue->pop(extra), "MPSC queue produced a phantom item");

  MpscQueue<RawMidi, 8> small;
  noHeap([&] { for (int i = 0; i < 8; ++i) check(small.push(RawMidi{}), "Push into free slot failed"); check(!small.push(RawMidi{}), "Full queue accepted a push");
    RawMidi m; for (int i = 0; i < 8; ++i) check(small.pop(m), "Pop failed"); check(!small.pop(m), "Empty queue popped"); }, "MPSC push/pop allocated");
  check(small.dropped() == 1, "MPSC drop count is wrong");

  SpscRing<ObservedMidi, 4> ring;
  noHeap([&] { for (int i = 0; i < 5; ++i) (void)ring.push(ObservedMidi{}); ObservedMidi o; int n = 0; while (ring.pop(o)) ++n; check(n == 4, "SPSC ring lost items"); }, "SPSC ring allocated");
  check(ring.takeDropped() == 1 && ring.takeDropped() == 0, "SPSC drop count is wrong");
}

struct Collect { std::vector<LiveMidiEvent>* out; void operator()(const LiveMidiEvent& e) const { out->push_back(e); } };

void routingAndActiveNotes() {
  MidiRouteTable table;
  MidiRoute all; all.track = 0; table.routes.push_back(all);
  MidiRoute keyboard; keyboard.track = 1; keyboard.source = 2; keyboard.channel = 3; keyboard.transpose = 12; keyboard.velocityOffset = 20; keyboard.keyHigh = 100; keyboard.velocityLow = 30; table.routes.push_back(keyboard);
  NoteRouter router; std::vector<LiveMidiEvent> events; events.reserve(64);
  // Channel 3 (status nibble 2) from source 2 reaches both routes.
  router.handle(2, 0x92, 60, 64, &table, 7, Collect{&events});
  check(events.size() == 2, "Note-on did not reach every matching route");
  check(events[0].track == 0 && events[0].data1 == 60 && events[0].data2 == 64 && events[0].offset == 7, "Default route changed the note");
  check(events[1].track == 1 && events[1].data1 == 72 && events[1].data2 == 84, "Track transpose/velocity offset not applied");
  check(events[0].noteId >= firstHostNoteId && events[1].noteId != events[0].noteId, "Host note ids are not unique/high range");
  // Other channel / source: only the 'all inputs, all channels' route.
  events.clear(); router.handle(2, 0x90, 61, 64, &table, 0, Collect{&events}); check(events.size() == 1 && events[0].track == 0, "Channel filter ignored");
  events.clear(); router.handle(5, 0x92, 62, 64, &table, 0, Collect{&events}); check(events.size() == 1 && events[0].track == 0, "Device filter ignored");
  // Limits: transposed 101 > keyHigh 100; velocity 5+20 < 30.
  events.clear(); router.handle(2, 0x92, 89, 64, &table, 0, Collect{&events}); check(events.size() == 1, "Key limit ignored");
  events.clear(); router.handle(2, 0x92, 50, 5, &table, 0, Collect{&events}); check(events.size() == 1, "Velocity limit ignored");
  int p = 0, v = 0; check(transformNote(keyboard, 60, 120, p, v) && v == 127, "Velocity offset must clamp to 127");
  // Note-off (also as velocity-0 note-on) follows the note-on's tracks and ids.
  const auto before = router.sounding();
  std::vector<LiveMidiEvent> on; router.handle(2, 0x92, 64, 90, &table, 0, Collect{&on});
  events.clear(); router.handle(2, 0x92, 64, 0, nullptr, 3, Collect{&events});
  check(events.size() == 2 && events[0].status == 0x80 && events[0].noteId == on[0].noteId && events[1].noteId == on[1].noteId && events[1].data1 == 76, "Note-off did not use the sounding table");
  check(router.sounding() == before, "Note-off left notes sounding");
  // Route change (track switch): notes on tracks no longer routed are released.
  MidiRouteTable switched; MidiRoute other; other.track = 4; switched.routes.push_back(other);
  events.clear(); router.retarget(&switched, 0, Collect{&events});
  check(!events.empty() && router.sounding() == 0, "Track switch left live notes hanging");
  for (const auto& e : events) check(e.status == 0x80, "Retarget emitted a non note-off");
  // Repeated note-on releases the previous instance first; CC123 releases a channel.
  events.clear(); router.handle(1, 0x90, 60, 100, &switched, 0, Collect{&events}); router.handle(1, 0x90, 60, 100, &switched, 0, Collect{&events});
  check(events.size() == 3 && events[1].status == 0x80 && router.sounding() == 1, "Retriggered note did not end the previous one");
  events.clear(); router.handle(1, 0xB0, 123, 0, &switched, 0, Collect{&events}); check(events.size() == 1 && router.sounding() == 0, "All notes off (CC123) ignored");
  // CC64 is forwarded for recording but has no live routing yet.
  events.clear(); router.handle(1, 0xB0, 64, 127, &switched, 0, Collect{&events}); check(events.empty(), "CC64 unexpectedly routed");
  // Allocation-free.
  std::array<LiveMidiEvent, 16> fixed{}; std::size_t n = 0;
  auto emit = [&](const LiveMidiEvent& e) { if (n < fixed.size()) fixed[n++] = e; };
  noHeap([&] { router.handle(0, 0x90, 40, 100, &table, 0, emit); router.handle(0, 0x80, 40, 0, &table, 0, emit); router.retarget(&switched, 0, emit); router.releaseAll(0, emit); }, "Routing allocated");
  const auto ids = MidiInputManager::stableIds({"Keys", "Pads", "Keys", "Keys"});
  check(ids[0] == "Keys" && ids[2] == "Keys #2" && ids[3] == "Keys #3" && ids[1] == "Pads", "Device ids are not stable/unique");
}

ProjectTimeline project(std::int64_t frames = 48000 * 4) { ProjectTimeline p; p.projectId = "midi"; p.sampleRate = 48000; p.lengthFrames = frames; return p; }
TrackTimeline synth() { TrackTimeline t; t.id = "keys"; t.source.kind = TrackSource::Kind::BuiltinSynth; t.source.instrumentId = "keys"; return t; }
std::vector<float> renderCall(RenderEngine& e, std::uint32_t frames) {
  std::vector<float> out(std::size_t(frames) * 2);
  noHeap([&] { e.render(out.data(), nullptr, frames, 0); }, "Audio callback allocated");
  return out;
}
double energy(const std::vector<float>& v, std::size_t fromFrame, std::size_t toFrame) { double s = 0; for (auto i = fromFrame * 2; i < toFrame * 2; ++i) s += double(v[i]) * v[i]; return s; }

void sampleAccurateLiveEvents() {
  auto p = project(); p.tracks.push_back(synth());
  RenderEngine e(48000, 512); e.submit(e.prepare(p, {}));
  (void)renderCall(e, 64); // graph applied
  const LiveMidiEvent on{100, 0, 0x90, 60, 100, 1'500'000'001};
  std::uint32_t accepted = 0;
  noHeap([&] { accepted = e.queueLiveMidi(std::span<const LiveMidiEvent>(&on, 1)); }, "queueLiveMidi allocated");
  check(accepted == 1, "Live event rejected");
  const auto out = renderCall(e, 256);
  for (std::size_t i = 0; i < 100 * 2; ++i) check(out[i] == 0.f, "Live note sounded before its sample offset");
  check(energy(out, 100, 256) > 1e-6, "Live note did not start at its sample offset");
  // Note-off by id at offset 10; the voice then releases to silence.
  const LiveMidiEvent off{10, 0, 0x80, 60, 0, 1'500'000'001};
  (void)e.queueLiveMidi(std::span<const LiveMidiEvent>(&off, 1));
  std::vector<float> tail; for (int i = 0; i < 400; ++i) { const auto b = renderCall(e, 256); tail.insert(tail.end(), b.begin(), b.end()); }
  check(energy(tail, tail.size() / 2 - 2048, tail.size() / 2) == 0, "Live note-off did not release the voice");
  // An event past this call's frames applies at the start of the next call.
  const LiveMidiEvent late{300, 0, 0x90, 64, 90, 1'500'000'002};
  (void)e.queueLiveMidi(std::span<const LiveMidiEvent>(&late, 1));
  const auto first = renderCall(e, 256); check(energy(first, 0, 256) == 0, "Late event played early");
  const auto second = renderCall(e, 256); check(energy(second, 0, 256) > 1e-6, "Late event was lost");
  // Unknown track and CC64 are ignored safely.
  const LiveMidiEvent junk[]{{0, 99, 0x90, 60, 100, -1}, {0, 0, 0xB0, 64, 127, -1}};
  (void)e.queueLiveMidi(junk); (void)renderCall(e, 128);
}

void transportStamps() {
  {
    auto p = project(); p.tracks.push_back(synth()); RenderEngine e(48000, 512); e.submit(e.prepare(p, {}));
    (void)renderCall(e, 128);
    check(e.renderedTransportFrame(10) == notRenderedFrame, "Stopped transport reported a frame");
    check(e.seek(1000) && e.play(), "Play failed"); (void)renderCall(e, 256);
    check(e.renderedTransportFrame(10) == 1010 && e.renderedTransportFrame(255) == 1255, "Playing stamp is wrong");
    check(e.renderedTransportFrame(256) == notRenderedFrame, "Offset beyond the call reported a frame");
    // Sub-block splits at live events keep the mapping continuous.
    const LiveMidiEvent on{77, 0, 0x90, 60, 100, 5}; (void)e.queueLiveMidi(std::span<const LiveMidiEvent>(&on, 1)); (void)renderCall(e, 256);
    check(e.renderedTransportFrame(76) == 1256 + 76 && e.renderedTransportFrame(77) == 1256 + 77, "Split sub-blocks broke the stamp");
  }
  {
    auto p = project(); p.cycle = std::array<std::int64_t, 2>{0, 2000}; RenderEngine e(48000, 512); e.submit(e.prepare(p, {}));
    check(e.seek(1900) && e.play(), "Play failed"); (void)renderCall(e, 256);
    check(e.renderedTransportFrame(50) == 1950, "Stamp before the cycle wrap is wrong");
    check(e.renderedTransportFrame(150) == 50, "Stamp after the cycle wrap is wrong");
  }
  {
    auto p = project(); RenderEngine e(48000, 512); e.submit(e.prepare(p, {}));
    check(e.seek(4800) && e.play(100), "Count-in play failed"); (void)renderCall(e, 256);
    check(e.renderedTransportFrame(50) == notRenderedFrame, "Count-in reported a transport frame");
    check(e.renderedTransportFrame(150) == 4800 + 50, "Stamp after the count-in is wrong");
  }
}
} // namespace

int main() {
  const std::pair<const char*, void (*)()> tests[]{{"MPSC/SPSC queues are lock-free and allocation-free", mpscQueueMultiProducer},
    {"routing, limits and sounding-note table", routingAndActiveNotes}, {"sample-accurate live events", sampleAccurateLiveEvents}, {"transport stamps for recording", transportStamps}};
  unsigned failed = 0;
  for (const auto& [name, test] : tests) {
    try { test(); std::cout << "PASS " << name << '\n'; }
    catch (const std::exception& error) { watching = false; ++failed; std::cerr << "FAIL " << name << ": " << error.what() << '\n'; }
  }
  return failed ? 1 : 0;
}

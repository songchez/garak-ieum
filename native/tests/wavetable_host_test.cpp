// IEUM WAVE through RenderEngine (docs/IEUM_WAVE.md). Since 0.3.3 the synth renders only in the Rust engine
// (rust/garak-engine/src/wave); RenderEngine is the shell: it validates patches, forwards timeline / live /
// audition notes and controllers, owns transport, render-ahead and the master bus, and waits for the Rust graph's
// table crossfades before the next graph swap. These cases check that shell: exact onsets at every supported rate,
// callback partitions and offline agreement, render-ahead, velocity above one, audition ownership, stopped
// previews, held-note patch edits, rapid custom-table edits, the offline endpoint, deterministic stop/seek,
// validation, concurrent preparation without callback allocations, and MIDI controllers. The reference is the Rust
// engine driven directly (garak_engine.h), which catches a shell that substitutes, restarts or drops something.
#include "garak/engine.hpp"
#include "garak_engine.h"
#include "garak_engine_instruments.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <limits>
#include <new>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>
#if defined(_WIN32)
#include <malloc.h>
#define GARAK_WAVE_NOINLINE __declspec(noinline)
#else
#define GARAK_WAVE_NOINLINE __attribute__((noinline))
#endif

namespace {
thread_local bool watchAllocations = false;
thread_local std::size_t allocations = 0, deallocations = 0;
void check(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }
}

// The callback must neither allocate nor free, including the graph handoff and table retirement.
GARAK_WAVE_NOINLINE void* operator new(std::size_t size) {
  if (watchAllocations) ++allocations;
  if (void* p = std::malloc(size ? size : 1)) return p;
  throw std::bad_alloc();
}
GARAK_WAVE_NOINLINE void* operator new[](std::size_t size) { return ::operator new(size); }
GARAK_WAVE_NOINLINE void* operator new(std::size_t size, const std::nothrow_t&) noexcept { try { return ::operator new(size); } catch (...) { return nullptr; } }
GARAK_WAVE_NOINLINE void* operator new[](std::size_t size, const std::nothrow_t& n) noexcept { return ::operator new(size, n); }
GARAK_WAVE_NOINLINE void operator delete(void* p) noexcept { if (watchAllocations && p) ++deallocations; std::free(p); }
GARAK_WAVE_NOINLINE void operator delete[](void* p) noexcept { ::operator delete(p); }
GARAK_WAVE_NOINLINE void operator delete(void* p, std::size_t) noexcept { ::operator delete(p); }
GARAK_WAVE_NOINLINE void operator delete[](void* p, std::size_t) noexcept { ::operator delete(p); }
GARAK_WAVE_NOINLINE void operator delete(void* p, const std::nothrow_t&) noexcept { ::operator delete(p); }
GARAK_WAVE_NOINLINE void operator delete[](void* p, const std::nothrow_t&) noexcept { ::operator delete(p); }
GARAK_WAVE_NOINLINE void* operator new(std::size_t size, std::align_val_t alignment) {
  if (watchAllocations) ++allocations;
  const auto a = static_cast<std::size_t>(alignment);
  if (size > std::numeric_limits<std::size_t>::max() - a) throw std::bad_alloc();
#if defined(_WIN32)
  void* p = _aligned_malloc(size ? size : 1, a);
#else
  void* p = std::aligned_alloc(a, ((size ? size : 1) + a - 1) / a * a);
#endif
  if (!p) throw std::bad_alloc();
  return p;
}
GARAK_WAVE_NOINLINE void* operator new[](std::size_t size, std::align_val_t a) { return ::operator new(size, a); }
GARAK_WAVE_NOINLINE void* operator new(std::size_t size, std::align_val_t a, const std::nothrow_t&) noexcept { try { return ::operator new(size, a); } catch (...) { return nullptr; } }
GARAK_WAVE_NOINLINE void* operator new[](std::size_t size, std::align_val_t a, const std::nothrow_t& n) noexcept { return ::operator new(size, a, n); }
GARAK_WAVE_NOINLINE void operator delete(void* p, std::align_val_t) noexcept {
  if (watchAllocations && p) ++deallocations;
#if defined(_WIN32)
  _aligned_free(p);
#else
  std::free(p);
#endif
}
GARAK_WAVE_NOINLINE void operator delete[](void* p, std::align_val_t a) noexcept { ::operator delete(p, a); }
GARAK_WAVE_NOINLINE void operator delete(void* p, std::size_t, std::align_val_t a) noexcept { ::operator delete(p, a); }
GARAK_WAVE_NOINLINE void operator delete[](void* p, std::size_t, std::align_val_t a) noexcept { ::operator delete(p, a); }
GARAK_WAVE_NOINLINE void operator delete(void* p, std::align_val_t a, const std::nothrow_t&) noexcept { ::operator delete(p, a); }
GARAK_WAVE_NOINLINE void operator delete[](void* p, std::align_val_t a, const std::nothrow_t&) noexcept { ::operator delete(p, a); }

namespace {
using namespace garak;

constexpr std::size_t kFrameSize = 2048, kLfoValues = 4 * 128;
constexpr std::uint32_t kNoAux = 0xffffffffu, kLfo1 = 4;

// An IEWAVE01 patch built from the engine's default (garak_rs_wave_default_patch), edited by schema id.
struct Route { std::uint32_t source = 0, destination = 0, aux = kNoAux; float amount = 0, curve = 0; bool bipolar = false, enabled = true; };
struct Bank { std::uint32_t slot = 4, frames = 1; std::vector<float> samples; };
struct Patch {
  std::vector<float> params, curves;
  std::vector<Route> routes;
};
std::uint32_t word(const std::vector<std::uint8_t>& b, std::size_t at) { std::uint32_t v = 0; for (int i = 0; i < 4; ++i) v |= std::uint32_t(b[at + i]) << (8 * i); return v; }
float real(const std::vector<std::uint8_t>& b, std::size_t at) { const auto bits = word(b, at); float v; std::memcpy(&v, &bits, 4); return v; }
Patch defaultPatch() {
  std::vector<std::uint8_t> bytes(garak_rs_wave_default_patch(nullptr, 0));
  (void)garak_rs_wave_default_patch(bytes.data(), bytes.size());
  Patch p;
  const auto count = word(bytes, 16);
  for (std::size_t i = 0; i < count; ++i) p.params.push_back(real(bytes, 32 + 4 * i));
  for (std::size_t i = 0; i < kLfoValues; ++i) p.curves.push_back(real(bytes, 32 + 4 * (count + i)));
  return p;
}
std::uint32_t index(const char* id) {
  const auto i = garak_rs_wave_parameter_index(reinterpret_cast<const std::uint8_t*>(id), std::strlen(id));
  if (i < 0) throw std::runtime_error(std::string("unknown IEUM WAVE parameter ") + id);
  return static_cast<std::uint32_t>(i);
}
void set(Patch& patch, const char* id, float value) { patch.params[index(id)] = value; }
float get(const Patch& patch, const char* id) { return patch.params[index(id)]; }
void u32(std::vector<std::uint8_t>& out, std::uint32_t value) { for (unsigned i = 0; i < 4; ++i) out.push_back(static_cast<std::uint8_t>(value >> (i * 8))); }
void f32(std::vector<std::uint8_t>& out, float value) { std::uint32_t bits; std::memcpy(&bits, &value, sizeof(bits)); u32(out, bits); }
std::vector<std::uint8_t> pack(const Patch& patch, const std::vector<Bank>& banks = {}) {
  std::vector<std::uint8_t> out {'I', 'E', 'W', 'A', 'V', 'E', '0', '1'};
  u32(out, 1); u32(out, garak_rs_wave_schema_fingerprint());
  u32(out, static_cast<std::uint32_t>(patch.params.size())); u32(out, static_cast<std::uint32_t>(banks.size()));
  u32(out, static_cast<std::uint32_t>(patch.routes.size())); u32(out, 0);
  for (float value : patch.params) f32(out, value);
  for (float value : patch.curves) f32(out, value);
  for (const auto& r : patch.routes) {
    u32(out, r.source); u32(out, r.destination); u32(out, r.aux);
    u32(out, (r.bipolar ? 1u : 0u) | (r.enabled ? 2u : 0u)); f32(out, r.amount); f32(out, r.curve);
  }
  for (const auto& bank : banks) { u32(out, bank.slot); u32(out, bank.frames); for (float sample : bank.samples) f32(out, sample); }
  return out;
}
Bank bank(unsigned slot, unsigned harmonic) {
  Bank result {slot, 1, std::vector<float>(kFrameSize)};
  for (std::size_t i = 0; i < result.samples.size(); ++i)
    result.samples[i] = static_cast<float>(std::sin(6.2831853071795864769 * harmonic * i / result.samples.size()));
  return result;
}
Patch dryPatch() {
  auto patch = defaultPatch();
  set(patch, "filter1Enabled", 0); set(patch, "filter2Enabled", 0);
  set(patch, "osc1Position", 0); set(patch, "osc1Level", .5f);
  set(patch, "osc1Unison", 1); set(patch, "osc1Phase", .25f); set(patch, "osc1RandomPhase", 0);
  set(patch, "osc2Enabled", 0); set(patch, "osc3Enabled", 0);
  set(patch, "subLevel", 0); set(patch, "noiseLevel", 0);
  set(patch, "env1Attack", .001f); set(patch, "env1Hold", 0);
  set(patch, "env1Decay", .001f); set(patch, "env1Sustain", 1); set(patch, "env1Release", .02f);
  set(patch, "driveMix", 0); set(patch, "chorusMix", 0); set(patch, "delayMix", 0);
  // Below both safety limiters, so amplitude comparisons do not depend on their nonlinear curve.
  set(patch, "level", .15f);
  return patch;
}
Patch complexPatch() {
  auto patch = dryPatch(); set(patch, "osc1Unison", 3); set(patch, "osc1RandomPhase", 1);
  set(patch, "noiseLevel", .02f); set(patch, "chorusMix", .1f); set(patch, "delayMix", .07f);
  set(patch, "lfo1Sync", 1); set(patch, "lfo1Division", .5f); set(patch, "lfo1Retrigger", 0);
  patch.routes.push_back({kLfo1, index("osc1Position"), kNoAux, .2f, 0, true, true});
  return patch;
}
ProjectTimeline project(const Patch& patch = dryPatch(), std::uint32_t rate = 48000, const std::vector<Bank>& banks = {}) {
  ProjectTimeline p; p.projectId = "wave-host-test"; p.revision = 1; p.sampleRate = rate; p.lengthFrames = rate;
  TrackTimeline track; track.id = "wave"; track.source.kind = TrackSource::Kind::NativeWavetable;
  track.source.instrumentId = "wavetable"; track.source.patchData = pack(patch, banks);
  p.tracks.push_back(std::move(track));
  return p;
}
void rt(RenderEngine& engine, float* out, std::uint32_t frames) {
  allocations = deallocations = 0; watchAllocations = true;
  engine.render(out, nullptr, frames, 0);
  watchAllocations = false;
  check(allocations == 0 && deallocations == 0, "WAVE callback allocated or destroyed heap storage");
}
std::vector<float> render(RenderEngine& engine, std::uint32_t frames, std::uint32_t block = 128, bool collect = false) {
  std::vector<float> result(static_cast<std::size_t>(frames) * 2);
  for (std::uint32_t at = 0; at < frames; at += block) {
    rt(engine, result.data() + static_cast<std::size_t>(at) * 2, std::min(block, frames - at));
    if (collect) engine.collectRetired();
  }
  return result;
}
double energy(const std::vector<float>& data, std::size_t firstFrame = 0, std::size_t lastFrame = 0) {
  if (!lastFrame) lastFrame = data.size() / 2;
  check(firstFrame <= lastFrame && lastFrame <= data.size() / 2, "Invalid PCM comparison interval");
  double sum = 0;
  for (std::size_t i = firstFrame * 2; i < lastFrame * 2; ++i) {
    check(std::isfinite(data[i]), "WAVE emitted non-finite audio");
    sum += static_cast<double>(data[i]) * data[i];
  }
  return sum;
}
void same(const std::vector<float>& a, const std::vector<float>& b, double tolerance, const char* message, std::size_t firstFrame = 0) {
  check(a.size() == b.size(), "Different PCM comparison lengths");
  for (std::size_t i = firstFrame * 2; i < a.size(); ++i) {
    if (!std::isfinite(a[i]) || !std::isfinite(b[i]) || std::abs(static_cast<double>(a[i]) - b[i]) > tolerance) {
      std::ostringstream detail; detail << message << " (sample " << i << ", actual " << a[i] << ", expected " << b[i] << ")";
      throw std::runtime_error(detail.str());
    }
  }
}
void silent(const std::vector<float>& data, std::size_t firstFrame, const char* message) {
  for (std::size_t i = firstFrame * 2; i < data.size(); ++i) check(std::isfinite(data[i]) && std::abs(data[i]) < 1e-8f, message);
}
template<class F> void rejects(F&& fn, const char* message) {
  try { fn(); } catch (const std::exception&) { return; }
  throw std::runtime_error(message);
}

std::string base64(const std::vector<std::uint8_t>& data) {
  static constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  for (std::size_t i = 0; i < data.size(); i += 3) {
    const std::uint32_t n = (std::uint32_t(data[i]) << 16) | (i + 1 < data.size() ? std::uint32_t(data[i + 1]) << 8 : 0) | (i + 2 < data.size() ? std::uint32_t(data[i + 2]) : 0);
    out += alphabet[(n >> 18) & 63]; out += alphabet[(n >> 12) & 63];
    out += i + 1 < data.size() ? alphabet[(n >> 6) & 63] : '='; out += i + 2 < data.size() ? alphabet[n & 63] : '=';
  }
  return out;
}

// The Rust engine driven directly: one WAVE track (no notes) and one live note 60 (id 1, velocity .8), stopped.
class Reference {
 public:
  explicit Reference(const Patch& patch, const std::vector<Bank>& banks = {}, std::uint32_t rate = 48000)
      : engine_(garak_rs_engine_create(rate, 512, 0)), rate_(rate) {
    check(engine_ != nullptr, "Reference engine refused the format");
    apply(pack(patch, banks));
  }
  ~Reference() { garak_rs_engine_destroy(engine_); }
  Reference(const Reference&) = delete;
  Reference& operator=(const Reference&) = delete;
  void patch(const Patch& patch, const std::vector<Bank>& banks = {}) { apply(pack(patch, banks)); }
  std::vector<float> render(std::uint32_t frames, bool on = false, bool off = false, std::uint32_t block = 128) {
    if (on) check(garak_rs_engine_note_on(engine_, 0, 60, .8f, 1) >= 0, "Reference note-on failed");
    if (off) check(garak_rs_engine_note_off(engine_, 0, 60, 1) >= 0, "Reference note-off failed");
    std::vector<float> result(static_cast<std::size_t>(frames) * 2);
    for (std::uint32_t at = 0; at < frames; at += block) {
      garak_rs_engine_render(engine_, result.data() + static_cast<std::size_t>(at) * 2, std::min(block, frames - at));
      garak_rs_engine_collect(engine_);
    }
    return result;
  }
 private:
  void apply(const std::vector<std::uint8_t>& data) {
    const std::string json = "{\"version\":1,\"projectId\":\"wave-reference\",\"revision\":" + std::to_string(++revision_) +
      ",\"sampleRate\":" + std::to_string(rate_) + ",\"bpm\":120,\"beatsPerBar\":4,\"lengthFrames\":" + std::to_string(rate_) +
      ",\"masterGain\":1,\"lowLatencyMonitoring\":true,\"timeSignature\":{\"numerator\":4,\"denominator\":4},\"tracks\":[{\"id\":\"wave\",\"enabled\":true,"
      "\"source\":{\"kind\":\"native-wavetable\",\"instrumentId\":\"wavetable\",\"patchData\":\"" + base64(data) + "\"},"
      "\"gain\":1,\"pan\":0,\"mute\":false,\"solo\":false,\"soloSafe\":false,\"audible\":true,\"unmutedAudible\":true,\"inserts\":[],\"notes\":[],\"audio\":[]}]}";
    check(garak_rs_engine_set(engine_, reinterpret_cast<const std::uint8_t*>(json.data()), json.size(), nullptr, 0) >= 0, "Reference engine refused the patch");
  }
  GarakRsEngine* engine_;
  std::uint32_t rate_;
  int revision_ = 0;
};

void timelineRatesAndExactOnsets() {
  for (const auto rate : {22050u, 44100u, 48000u, 96000u, 192000u}) {
    auto p = project(dryPatch(), rate); const auto off = static_cast<std::int64_t>(rate / 10);
    p.tracks[0].notes = {{0, 37, off, p.lengthFrames, 60, .8f}};
    RenderEngine engine(rate, 512); engine.submit(engine.prepare(p, {})); check(engine.play(), "WAVE play queue failed");
    const auto audio = render(engine, rate / 4, 173);
    for (std::size_t i = 0; i < 37 * 2; ++i) check(audio[i] == 0, "WAVE timeline note started before its sample offset");
    check(std::abs(audio[37 * 2]) > 1e-7f, "WAVE timeline note missed its exact sample offset");
    check(energy(audio, 37, static_cast<std::size_t>(off)) > .001, "WAVE native timeline rendered silence");
    silent(audio, static_cast<std::size_t>(off) + rate / 12, "WAVE timeline note did not finish its release");
    const auto status = engine.snapshot();
    check(status.ready && status.sampleRate == rate && status.trackCount == 1 && status.revision == p.revision, "WAVE graph state was not published");
    check(status.invalidSamples == 0 && status.voiceOverflows == 0, "WAVE timeline lost events or generated invalid PCM");
  }
}

void callbackPartitionsAndOfflineAgreement() {
  auto p = project(complexPatch()); p.bpm = 137.5;
  p.tracks[0].notes = {{0, 19, 9007, p.lengthFrames, 60, .8f}, {1, 4001, 12017, p.lengthFrames, 67, .6f}, {2, 12017, 15037, p.lengthFrames, 60, .5f}};
  RenderEngine small(48000,512), irregular(48000,512), offline(48000,512); offline.setOffline(true);
  for (auto* engine : {&small, &irregular, &offline}) { engine->submit(engine->prepare(p, {})); check(engine->play(), "WAVE play queue failed"); }
  const auto a = render(small, 20000, 31), b = render(irregular, 20000, 257), c = render(offline, 20000, 733);
  check(energy(a) > .01, "Complex WAVE patch rendered silence");
  same(a, b, 2e-6, "WAVE output depends on the device callback partition");
  same(a, c, 2e-6, "WAVE realtime and offline output diverged");
}

void velocityAboveOneReachesEveryNotePath() {
  for (unsigned path = 0; path < 3; ++path) {
    auto a = project(), b = a; RenderEngine low(48000, 512), high(48000, 512);
    if (path == 0) { a.tracks[0].notes = {{0,0,8000,a.lengthFrames,60,1}}; b.tracks[0].notes = {{0,0,8000,b.lengthFrames,60,2}}; }
    low.submit(low.prepare(a, {})); high.submit(high.prepare(b, {}));
    if (path == 0) check(low.play() && high.play(), "Timeline velocity test play failed");
    if (path == 1) check(low.previewNote(0,60,1,8000) && high.previewNote(0,60,2,8000), "Preview velocity queue failed");
    if (path == 2) check(low.noteOn(0,60,1,0) && high.noteOn(0,60,2,0), "Live velocity queue failed");
    auto quiet = render(low, 4096, 193); const auto loud = render(high, 4096, 193);
    check(energy(quiet) > .001, "Velocity comparison used a silent instrument");
    for (auto& value : quiet) value *= 2;
    same(loud, quiet, 2e-6, "WAVE host clamped velocity times clip gain to one");
  }
}

void auditionReleaseIsTrackScoped() {
  auto p = project(); p.tracks[0].notes = {{0,0,40000,p.lengthFrames,60,.8f}};
  auto second = p.tracks[0]; second.id = "second-wave"; second.notes.clear(); p.tracks.push_back(second);
  RenderEngine edited(48000,512), reference(48000,512);
  for (auto* engine : {&edited, &reference}) { engine->submit(engine->prepare(p, {})); check(engine->play(), "WAVE play failed"); (void)render(*engine,4096); }
  // The same note ID and pitch as the timeline: the audition namespace keeps a key release or a track panic
  // from releasing that note.
  check(edited.noteOn(0,60,.8f,0), "WAVE audition note failed");
  check(edited.noteOn(1,67,.7f,0) && reference.noteOn(1,67,.7f,0), "Second WAVE audition note failed");
  (void)render(edited,1024); (void)render(reference,1024);
  check(edited.allNotesOff(0), "WAVE track audition release failed");
  const auto actual = render(edited,4096,127), expected = render(reference,4096,127);
  same(actual,expected,2e-6,"Audition panic killed timeline/another track or left its live note held",2048);
  check(energy(actual,2048) > .001, "Audition panic silenced the continuing project");
  check(edited.noteOn(0,60,.8f,0), "Second WAVE live note failed");
  (void)render(edited,1024); (void)render(reference,1024);
  check(edited.noteOff(0,60,0), "WAVE live note-off failed");
  same(render(edited,4096,131),render(reference,4096,131),2e-6,"WAVE live note-off released a same-ID timeline note",2048);
  check(edited.allNotesOff(1) && reference.allNotesOff(1), "Second-track panic failed");
  same(render(edited,4096),render(reference,4096),2e-6,"WAVE track-scoped releases diverged");

  auto empty = project(); RenderEngine cancelled(48000,512); cancelled.submit(cancelled.prepare(empty,{}));
  check(cancelled.noteOn(0,60,.8f,0) && cancelled.allNotesOff(0), "Pending WAVE audition cancellation failed");
  silent(render(cancelled,2048),0,"Cancelled WAVE note-on was delivered after audition panic");
}

void previewExpiresWithoutTransport() {
  RenderEngine engine(48000,512); const auto p = project(); engine.submit(engine.prepare(p,{}));
  check(engine.previewNote(0,60,.8f,777), "WAVE preview queue failed");
  const auto preview = render(engine,4096,257);
  check(energy(preview,0,777) > .001, "Stopped WAVE preview rendered silence");
  silent(preview,2200,"WAVE preview outlived its duration and release");
  check(!engine.snapshot().playing && engine.snapshot().frame == 0, "Preview advanced the project transport");
  check(engine.noteOn(0,60,.8f,0), "WAVE held preview failed");
  check(energy(render(engine,4096)) > .001, "WAVE live note did not remain held");
  check(engine.noteOff(0,60,0), "WAVE held preview release failed");
  silent(render(engine,4096),2200,"WAVE note-off left a stuck audition voice");
}

// WAVE tracks render ahead on a worker. With equal device buffers the output is bit-identical across cycle
// wraps; a patch edit (table crossfade, preserved voices) is heard up to the ahead window late, and a seek
// realigns exactly.
void renderAheadMatchesCallback() {
  auto patch = complexPatch(); set(patch,"osc1Bank",4); auto p = project(patch,48000,{bank(4,1)}); p.bpm = 128;
  p.cycle = std::array<std::int64_t,2>{4000,30000};
  p.tracks[0].notes = {{0, 100, 9000, p.lengthFrames, 60, .8f}, {1, 6001, 20017, p.lengthFrames, 67, .6f}, {2, 21000, 29990, p.lengthFrames, 64, .7f}};
  RenderEngine reference(48000,512), ahead(48000,512);
  ProcessingOptions options; options.threads = 1; options.renderAhead = RenderAhead::High; options.deviceBlockFrames = 128;
  ahead.setProcessing(options);
  for (auto* engine : {&reference, &ahead}) { engine->submit(engine->prepare(p, {})); check(engine->play(), "WAVE play queue failed"); }
  std::uint32_t mostAhead = 0;
  const auto both = [&](std::uint32_t frames) {
    std::vector<float> a, b;
    for (std::uint32_t at = 0; at < frames; at += 128) {
      const auto x = render(reference, 128, 128, true), y = render(ahead, 128, 128, true);
      a.insert(a.end(), x.begin(), x.end()); b.insert(b.end(), y.begin(), y.end());
      mostAhead = std::max(mostAhead, ahead.snapshot().renderAheadTracks);
    }
    return std::pair{a, b};
  };
  const auto exact = [](const std::vector<float>& a, const std::vector<float>& b, const char* message) {
    check(a.size() == b.size() && std::equal(a.begin(), a.end(), b.begin(), [](float x, float y) { return std::memcmp(&x, &y, sizeof x) == 0; }), message);
  };
  const auto [a, b] = both(128 * 600); // Three cycle wraps.
  check(energy(a) > .01 && mostAhead == 1, "WAVE track did not render ahead");
  exact(a, b, "Render-ahead WAVE differs from callback rendering");
  set(patch,"osc1Bank",5); set(patch,"level",.12f); ++p.revision; p.tracks[0].source.patchData = pack(patch,{bank(5,2)});
  for (auto* engine : {&reference, &ahead}) engine->submit(engine->prepare(p, {}));
  const auto [c, d] = both(128 * 100);
  check(energy(d) > .001 && ahead.snapshot().revision == p.revision, "A WAVE patch edit on an ahead track was lost");
  for (auto* engine : {&reference, &ahead}) check(engine->seek(5000), "WAVE seek failed");
  const auto [e, f] = both(128 * 400);
  exact(e, f, "Render-ahead WAVE differs after a patch edit and seek");
  check(ahead.snapshot().renderAheadResyncs == 0, "A WAVE render-ahead ring lost sync");
}

void patchUpdatesPreserveHeldVoiceAndPhase() {
  auto patch = dryPatch(); set(patch,"env1Attack",1); auto p = project(patch);
  RenderEngine engine(48000,512); engine.submit(engine.prepare(p,{})); check(engine.noteOn(0,60,.8f,0),"WAVE sustained note failed");
  Reference reference(patch);
  same(render(engine,30000,257),reference.render(30000,true,false,257),2e-6,"Hosted WAVE voice differs from the engine's synth");
  ++p.revision; engine.submit(engine.prepare(p,{})); reference.patch(patch);
  same(render(engine,2048,193),reference.render(2048,false,false,193),2e-6,"No-op project revision reset a WAVE envelope or phase");
  set(patch,"level",.09f); set(patch,"osc1Position",.8f); set(patch,"env1Release",.05f);
  ++p.revision; p.tracks[0].source.patchData = pack(patch); engine.submit(engine.prepare(p,{})); reference.patch(patch);
  const auto changed = render(engine,4096,127);
  same(changed,reference.render(4096,false,false,127),2e-6,"WAVE knob update restarted, ignored or replaced the held voice");
  check(energy(changed,0,64) > 1e-6,"WAVE knob update restarted its slow attack");
  check(engine.snapshot().revision == p.revision,"WAVE patch revision was not acknowledged");
  check(engine.noteOff(0,60,0),"Edited WAVE note-off failed");
  same(render(engine,4096,131),reference.render(4096,false,true,131),2e-6,"Edited WAVE release did not reach the held voice");
  engine.collectRetired();
}

void customTableReplacementSurvivesRetirement() {
  auto patch = dryPatch(); set(patch,"osc1Bank",4); set(patch,"osc1Phase",0);
  auto p = project(patch,48000,{bank(4,1)}); RenderEngine engine(48000,512);
  engine.submit(engine.prepare(p,{})); check(engine.noteOn(0,60,.8f,0),"Custom WAVE live note failed");
  check(energy(render(engine,4096,127)) > .001,"Custom WAVE source rendered silence");
  set(patch,"osc1Bank",5); ++p.revision; p.tracks[0].source.patchData = pack(patch,{bank(5,2)});
  engine.submit(engine.prepare(p,{})); (void)render(engine,64,64,true);
  // Both further graphs arrive before the previous 20 ms table crossfade ends: they wait for it, and retiring
  // earlier graphs must not lose the final requested patch.
  for (unsigned slot : {6u,7u}) {
    set(patch,"osc1Bank",static_cast<float>(slot)); ++p.revision;
    p.tracks[0].source.patchData = pack(patch,{bank(slot,slot-3)});
    engine.submit(engine.prepare(p,{}));
  }
  const auto transition = render(engine,14400,31,true);
  check(energy(transition) > .01,"Rapid table revisions interrupted the held WAVE voice");
  check(engine.snapshot().revision == p.revision,"Rapid WAVE table updates lost the final revision");
  Reference reference(patch,{bank(7,4)});
  (void)reference.render(4096+64+14400,true,false,127);
  same(render(engine,4096,193,true),reference.render(4096,false,false,193),3e-6,"Final custom table or held oscillator phase was not preserved");
  check(engine.noteOff(0,60,0),"Custom WAVE note release failed");
  silent(render(engine,4096,127,true),2200,"Custom table edit left a stuck voice");
}

void offlineEndpointAndCompleteRelease() {
  auto patch = dryPatch(); set(patch,"env1Release",1.25f); auto p = project(patch);
  p.lengthFrames = 4096; p.cycle = std::array<std::int64_t,2>{512,1024};
  p.tracks[0].notes = {{0,0,p.lengthFrames,p.lengthFrames,60,.8f}};
  RenderEngine engine(48000,512); engine.setOffline(true); auto prepared = engine.prepare(p,{});
  check(prepared->tailSeconds() >= 1.25,"Offline WAVE tail budget omitted its release envelope");
  engine.submit(std::move(prepared)); check(engine.play(),"Offline WAVE play failed");
  Reference reference(patch);
  same(render(engine,4096,257),reference.render(4096,true,false,257),2e-6,"Offline WAVE followed the audition loop or changed its source");
  const auto tail = render(engine,70000,311), expected = reference.render(70000,false,true,311);
  same(tail,expected,2e-6,"Offline WAVE dropped the project-end note-off or cut the release tail");
  check(energy(tail,0,4096) > .001,"Offline WAVE export cut its last release at the project boundary");
  silent(tail,65000,"Offline WAVE project-end note remained held past its release");
  check(engine.snapshot().frame == 74096,"Offline WAVE cycle/endpoint changed the export clock");
}

void deterministicStopSeekAndFreshEngine() {
  auto p = project(complexPatch()); p.tracks[0].notes = {{0,0,20000,p.lengthFrames,60,.8f}};
  RenderEngine engine(48000,512), fresh(48000,512);
  for (auto* current : {&engine,&fresh}) { current->submit(current->prepare(p,{})); check(current->play(),"WAVE deterministic playback failed"); }
  const auto first = render(engine,4096,127);
  same(first,render(fresh,4096,257),2e-6,"Fresh WAVE engine configuration is not deterministic");
  check(engine.seek(0),"WAVE seek queue failed");
  same(first,render(engine,4096,131),2e-6,"WAVE seek did not reset noise/phase/effect state deterministically");
  check(engine.stop(),"WAVE stop queue failed");
  silent(render(engine,512),0,"WAVE stop retained voices or effects");
  check(engine.play(),"WAVE restart queue failed");
  same(first,render(engine,4096,193),2e-6,"WAVE restart did not reproduce its initial audio");
}

void malformedPatchAndRateValidation() {
  RenderEngine engine(48000,512); auto p = project();
  double tail = 0; std::size_t length = 0;
  check(garak_rs_wave_check_patch(p.tracks[0].source.patchData.data(),p.tracks[0].source.patchData.size(),&tail,nullptr,0,&length) == 0 && tail > 0,
        "Test binary encoder produced an invalid packet");
  auto bad = p; bad.tracks[0].source.patchData.clear();
  rejects([&]{(void)engine.prepare(bad,{});},"Missing WAVE patch silently produced a substitute source");
  bad = p; bad.tracks[0].source.patchData[12] ^= 1;
  rejects([&]{(void)engine.prepare(bad,{});},"Mismatched WAVE schema was accepted");
  bad = p; bad.tracks[0].source.patchData.pop_back();
  rejects([&]{(void)engine.prepare(bad,{});},"Truncated WAVE patch was accepted");
  auto patch = dryPatch(); set(patch,"osc1Bank",4); bad.tracks[0].source.patchData = pack(patch);
  rejects([&]{(void)engine.prepare(bad,{});},"WAVE source accepted a missing custom bank");
  patch = dryPatch(); set(patch,"level",std::numeric_limits<float>::quiet_NaN()); bad.tracks[0].source.patchData = pack(patch);
  rejects([&]{(void)engine.prepare(bad,{});},"WAVE source accepted a non-finite patch parameter");
  auto lowRate = project(dryPatch(),16000); RenderEngine unsupported(16000,512);
  rejects([&]{(void)unsupported.prepare(lowRate,{});},"WAVE source silently accepted an unsupported device sample rate");
  bad = p; bad.tracks[0].notes = {{0,0,4000,bad.lengthFrames,60,2.01f}};
  rejects([&]{(void)engine.prepare(bad,{});},"WAVE source accepted an out-of-contract note amplitude");
  // The C++ track path has no synth: an engine without the Rust graph refuses WAVE instead of playing silence.
  RenderEngine cpp(48000,512); cpp.setRustEngine(0);
  rejects([&]{(void)cpp.prepare(p,{});},"The C++ track path accepted an IEUM WAVE track");
}

void concurrentPatchPreparationAndRender() {
  auto patch = dryPatch(); auto p = project(patch); RenderEngine engine(48000,64);
  engine.submit(engine.prepare(p,{})); check(engine.noteOn(0,60,.8f,0),"Concurrent WAVE live note failed");
  std::atomic<bool> bad {false}, stop {false};
  std::thread audio([&] {
    std::array<float,128> out {};
    while (!stop.load(std::memory_order_relaxed)) {
      allocations = deallocations = 0; watchAllocations = true; engine.render(out.data(),nullptr,64,0); watchAllocations = false;
      if (allocations || deallocations) bad.store(true);
      for (float sample : out) if (!std::isfinite(sample)) bad.store(true);
      std::this_thread::yield();
    }
  });
  // AppleClang's libc++ does not provide jthread on every supported SDK: keep the callback joined before the
  // engine is destroyed, including on test errors.
  struct StopAndJoin {
    std::atomic<bool>& stop;
    std::thread& audio;
    void finish() {
      stop.store(true,std::memory_order_relaxed);
      if (audio.joinable()) audio.join();
    }
    ~StopAndJoin() { finish(); }
  } stopAudio {stop,audio};
  for (unsigned i = 0; i < 16; ++i) {
    set(patch,"level",.08f+.005f*i); ++p.revision; p.tracks[0].source.patchData = pack(patch);
    engine.submit(engine.prepare(p,{})); engine.collectRetired();
  }
  const auto deadline = std::chrono::steady_clock::now()+std::chrono::seconds(5);
  while (engine.snapshot().revision != p.revision && std::chrono::steady_clock::now() < deadline) std::this_thread::yield();
  const auto status = engine.snapshot(); stopAudio.finish(); engine.collectRetired();
  check(status.revision == p.revision,"Concurrent WAVE graph updates did not reach the last revision");
  check(!bad.load() && status.invalidSamples == 0,"Concurrent WAVE updates violated callback allocation/lifetime safety");
  check(energy(render(engine,1024)) > .001,"Concurrent WAVE patch preparation lost its held note");
}

// MIDI controllers (docs/MIDI_CONTROLLERS.md): pitch bend uses the patch's bend range; CC11 scales the output;
// the mod wheel drives Macro 1; seek chases the bend. Behavioural comparisons, never golden PCM.
double crossingRate(const std::vector<float>& data, std::size_t first, std::size_t last) {
  std::size_t crossings = 0;
  for (std::size_t i = first + 1; i < last; ++i) if (data[(i - 1) * 2] < 0 && data[i * 2] >= 0) ++crossings;
  return static_cast<double>(crossings) / static_cast<double>(last - first);
}
void midiControllers() {
  auto p = project(); p.tracks[0].notes = {{0,0,40000,p.lengthFrames,57,.8f}};
  const double bend = std::pow(2.0, get(dryPatch(), "pitchBendRange") / 12);
  auto bent = p; bent.tracks[0].controls = {{0,129,8191}};
  auto louder = p; louder.tracks[0].controls = {{0,11,90},{0,7,100}};
  auto modded = p; modded.tracks[0].controls = {{0,1,127},{0,64,127}};
  RenderEngine plain(48000,512), bending(48000,512), expressive(48000,512), modulated(48000,512);
  plain.submit(plain.prepare(p,{})); bending.submit(bending.prepare(bent,{}));
  expressive.submit(expressive.prepare(louder,{})); modulated.submit(modulated.prepare(modded,{}));
  for (auto* e : {&plain,&bending,&expressive,&modulated}) check(e->play(),"WAVE controller playback failed");
  const auto a = render(plain,24000), b = render(bending,24000), c = render(expressive,24000), d = render(modulated,24000);
  check(std::abs(crossingRate(b,4800,24000) / crossingRate(a,4800,24000) - bend) < .01, "WAVE pitch bend did not follow the patch bend range");
  const double gain = std::sqrt(energy(c,4800,24000) / energy(a,4800,24000));
  check(std::abs(gain - (90.0 / 127) * (90.0 / 127)) < .01, "WAVE CC11 expression did not scale the output");
  // Macro 1 is unrouted in this patch: the mod wheel (and a stray CC64, which the host owns) leave the sound alone.
  same(a,d,2e-6,"An unrouted mod wheel or a stray CC64 changed WAVE output");
  // A seek chases the bend.
  check(bending.seek(4800),"WAVE seek failed");
  const auto chased = render(bending,9600);
  check(std::abs(crossingRate(chased,480,9600) / crossingRate(a,4800,14000) - bend) < .015, "WAVE seek did not chase the pitch bend");
  // Live pitch bend reaches a live note.
  RenderEngine live(48000,512), reference(48000,512);
  for (auto* e : {&live,&reference}) { e->submit(e->prepare(project(),{})); check(e->noteOn(0,57,.8f,3),"WAVE live note failed"); }
  check(live.controlChange(0,129,8191),"WAVE live bend failed");
  const auto la = render(live,24000), lr = render(reference,24000);
  check(std::abs(crossingRate(la,4800,24000) / crossingRate(lr,4800,24000) - bend) < .01, "WAVE live pitch bend failed");
}
} // namespace

int main() {
  const std::pair<const char*,void(*)()> tests[] = {
    {"WAVE sample rates, exact onset and release",timelineRatesAndExactOnsets},
    {"WAVE callback partitions and offline agreement",callbackPartitionsAndOfflineAgreement},
    {"WAVE render-ahead equals callback rendering",renderAheadMatchesCallback},
    {"WAVE velocity times clip gain in every note path",velocityAboveOneReachesEveryNotePath},
    {"WAVE audition release isolation and note IDs",auditionReleaseIsTrackScoped},
    {"WAVE stopped preview duration and live release",previewExpiresWithoutTransport},
    {"WAVE held-note patch and phase preservation",patchUpdatesPreserveHeldVoiceAndPhase},
    {"WAVE custom table updates and graph retirement",customTableReplacementSurvivesRetirement},
    {"WAVE offline endpoint note-off and release tail",offlineEndpointAndCompleteRelease},
    {"WAVE deterministic stop, seek and fresh engine",deterministicStopSeekAndFreshEngine},
    {"WAVE patch format and sample-rate validation",malformedPatchAndRateValidation},
    {"WAVE concurrent preparation and callback isolation",concurrentPatchPreparationAndRender},
    {"WAVE MIDI controllers: bend, expression, chase and live",midiControllers}
  };
  unsigned failed = 0;
  for (const auto& [name,test] : tests) {
    try { test(); std::cout << "PASS " << name << '\n'; }
    catch (const std::exception& error) { watchAllocations = false; ++failed; std::cerr << "FAIL " << name << ": " << error.what() << '\n'; }
  }
  return failed ? 1 : 0;
}

#include "ieum_wave/synth.hpp"
#include "ieum_wave/dsp.hpp"
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <complex>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <iostream>
#include <limits>
#include <new>
#include <stdexcept>
#include <string>
#include <vector>
#if defined(_MSC_VER)
#include <malloc.h>
#endif

namespace allocation_guard {
thread_local bool active = false;
thread_local std::size_t allocations = 0;
void count() noexcept { if (active) ++allocations; }
}
void* operator new(std::size_t size) {
  allocation_guard::count();
  if (void* p = std::malloc(std::max<std::size_t>(size, 1))) return p;
  throw std::bad_alloc();
}
void* operator new[](std::size_t size) { return ::operator new(size); }
void operator delete(void* p) noexcept { std::free(p); }
void operator delete[](void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }
void operator delete[](void* p, std::size_t) noexcept { std::free(p); }
void* operator new(std::size_t size, std::align_val_t alignment) {
  allocation_guard::count();
#if defined(_MSC_VER)
  if (void* p = _aligned_malloc(size, static_cast<std::size_t>(alignment))) return p;
#else
  void* p = nullptr;
  if (posix_memalign(&p, static_cast<std::size_t>(alignment), std::max<std::size_t>(size, 1)) == 0) return p;
#endif
  throw std::bad_alloc();
}
void* operator new[](std::size_t size, std::align_val_t alignment) { return ::operator new(size, alignment); }
void operator delete(void* p, std::align_val_t) noexcept {
#if defined(_MSC_VER)
  _aligned_free(p);
#else
  std::free(p);
#endif
}
void operator delete[](void* p, std::align_val_t alignment) noexcept { ::operator delete(p, alignment); }
void operator delete(void* p, std::size_t, std::align_val_t alignment) noexcept { ::operator delete(p, alignment); }
void operator delete[](void* p, std::size_t, std::align_val_t alignment) noexcept { ::operator delete(p, alignment); }

using namespace ieum::wave;
namespace {
#define CHECK(condition) do { if (!(condition)) throw std::runtime_error(std::string(#condition) + " at line " + std::to_string(__LINE__)); } while (false)
void set(Patch& patch, ParameterId id, float value) { patch.params[parameterIndex(id)] = value; }
float get(const Patch& patch, ParameterId id) { return patch.params[parameterIndex(id)]; }
Patch dryPatch() {
  Patch patch;
  set(patch, ParameterId::Filter1Enabled, 0); set(patch, ParameterId::Filter2Enabled, 0);
  set(patch, ParameterId::Osc1Position, 0); set(patch, ParameterId::Osc1Level, 0.7f);
  set(patch, ParameterId::Env1Attack, 0.001f); set(patch, ParameterId::Env1Decay, 0.001f);
  set(patch, ParameterId::Env1Sustain, 1); set(patch, ParameterId::Env1Release, 0.02f);
  set(patch, ParameterId::Level, 0.7f);
  return patch;
}
Event noteOn(unsigned note = 60, unsigned offset = 0, float velocity = 0.8f) {
  Event event; event.note = static_cast<std::uint8_t>(note); event.sampleOffset = offset; event.value = velocity; return event;
}
Event noteOff(unsigned note = 60, unsigned offset = 0) { auto event = noteOn(note, offset); event.type = EventType::NoteOff; return event; }
struct Audio { std::vector<float> left, right; };
Audio render(Synth& synth, unsigned frames, const std::vector<Event>& events = {}, unsigned block = 128, double bpm = 120.0) {
  Audio result {std::vector<float>(frames), std::vector<float>(frames)};
  std::array<Event, 128> local {}; std::size_t next = 0;
  for (unsigned offset = 0; offset < frames; offset += block) {
    const unsigned count = std::min(block, frames - offset); std::size_t eventCount = 0;
    while (next < events.size() && events[next].sampleOffset < offset + count) {
      CHECK(eventCount < local.size()); local[eventCount] = events[next++]; local[eventCount++].sampleOffset -= offset;
    }
    synth.process(result.left.data() + offset, result.right.data() + offset, count, local.data(), eventCount, {bpm, 0, false, false});
  }
  return result;
}
Audio sound(const PreparedWavetableSet& tables, const Patch& patch, unsigned frames = 16384, unsigned note = 60, double rate = 48000) {
  Synth synth; synth.prepare(rate, tables); CHECK(synth.applyPatch(patch, true)); synth.reset(123);
  return render(synth, frames, {noteOn(note)});
}
double rms(const std::vector<float>& samples, std::size_t first = 0, std::size_t last = 0) {
  if (last == 0) last = samples.size(); double sum = 0;
  for (std::size_t i = first; i < last; ++i) sum += samples[i] * static_cast<double>(samples[i]);
  return std::sqrt(sum / static_cast<double>(last - first));
}
double difference(const std::vector<float>& a, const std::vector<float>& b, std::size_t start = 0) {
  CHECK(a.size() == b.size()); double sum = 0;
  for (std::size_t i = start; i < a.size(); ++i) { const double d = a[i] - b[i]; sum += d * d; }
  return std::sqrt(sum / static_cast<double>(a.size() - start));
}
void bounded(const Audio& audio) {
  for (const auto& channel : {&audio.left, &audio.right}) for (float sample : *channel) CHECK(std::isfinite(sample) && std::abs(sample) <= 0.980001f);
}
void fft(std::vector<std::complex<double>>& values) {
  const std::size_t n = values.size();
  for (std::size_t i = 1, j = 0; i < n; ++i) {
    std::size_t bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) std::swap(values[i], values[j]);
  }
  for (std::size_t size = 2; size <= n; size <<= 1) {
    const std::complex<double> rotation = std::polar(1.0, -kTau / static_cast<double>(size));
    for (std::size_t offset = 0; offset < n; offset += size) {
      std::complex<double> w(1.0, 0.0);
      for (std::size_t i = 0; i < size / 2; ++i) {
        const auto even = values[offset + i], odd = values[offset + i + size / 2] * w;
        values[offset + i] = even + odd; values[offset + i + size / 2] = even - odd; w *= rotation;
      }
    }
  }
}
double aliasRatio(const std::vector<float>& wave, unsigned fundamental, unsigned harmonicCount) {
  std::vector<std::complex<double>> spectrum(wave.begin(), wave.end()); fft(spectrum);
  double wanted = 0, residual = 0;
  for (unsigned bin = 1; bin < spectrum.size() / 2; ++bin) {
    const bool harmonic = bin % fundamental == 0 && bin / fundamental <= harmonicCount;
    (harmonic ? wanted : residual) += std::norm(spectrum[bin]);
  }
  return 10.0 * std::log10(std::max(1.0e-30, residual / wanted));
}
std::vector<float> waveform(unsigned harmonic = 1, unsigned frames = 1) {
  std::vector<float> result(generated::kWavetableSize * frames);
  for (unsigned frame = 0; frame < frames; ++frame) for (unsigned i = 0; i < generated::kWavetableSize; ++i)
    result[frame * generated::kWavetableSize + i] = static_cast<float>(std::sin(kTau * (harmonic + frame) * i / generated::kWavetableSize));
  return result;
}
void u32(std::vector<std::uint8_t>& out, std::uint32_t value) { for (unsigned i = 0; i < 4; ++i) out.push_back(static_cast<std::uint8_t>(value >> (8 * i))); }
void f32(std::vector<std::uint8_t>& out, float value) { std::uint32_t bits; std::memcpy(&bits, &value, 4); u32(out, bits); }
void write32(std::vector<std::uint8_t>& out, unsigned offset, std::uint32_t value) { for (unsigned i = 0; i < 4; ++i) out[offset + i] = static_cast<std::uint8_t>(value >> (8 * i)); }
std::vector<std::uint8_t> pack(const Patch& patch, const std::vector<CustomBank>& banks = {}) {
  std::vector<std::uint8_t> out {'I','E','W','A','V','E','0','1'};
  u32(out, 1); u32(out, generated::kSchemaFingerprint); u32(out, generated::kParamCount); u32(out, static_cast<unsigned>(banks.size()));
  u32(out, generated::kMaxModRoutes); u32(out, 0);
  for (float value : patch.params) f32(out, value);
  for (const auto& curve : patch.lfoCurves) for (float value : curve) f32(out, value);
  for (const auto& route : patch.routes) {
    u32(out, static_cast<unsigned>(route.source)); u32(out, static_cast<unsigned>(route.destination)); u32(out, route.aux);
    u32(out, (route.bipolar ? 1u : 0u) | (route.enabled ? 2u : 0u)); f32(out, route.amount); f32(out, route.curve);
  }
  for (const auto& bank : banks) { u32(out, bank.slot); u32(out, bank.frameCount); for (float sample : bank.samples) f32(out, sample); }
  return out;
}
} // namespace

int main() {
  PreparedWavetableSet tables;
  unsigned passed = 0, failed = 0;
  const auto test = [&](const char* name, const std::function<void()>& body) {
    try { body(); ++passed; std::cout << "PASS " << name << '\n'; }
    catch (const std::exception& exception) { ++failed; std::cerr << "FAIL " << name << ": " << exception.what() << '\n'; }
  };
  test("shared parameter constraints and default LFO shapes", [&] {
    Patch patch; CHECK(validatePatch(patch)); CHECK(patch.lfoCurves[0][0] == 0);
    CHECK(patch.lfoCurves[1][64] == 1); CHECK(patch.lfoCurves[2][64] == 0.5f); CHECK(patch.lfoCurves[3][0] == 1);
    CHECK(!validateParameter(ParameterId::Lfo1Division, 0.75f)); CHECK(validateParameter(ParameterId::Lfo1Division, 0.125f));
    CHECK(!validateParameter(ParameterId::Osc1Unison, 1.5f));
    CHECK(!validateParameter(ParameterId::Level, std::numeric_limits<float>::quiet_NaN()));
    CHECK(!validateParameter(static_cast<ParameterId>(65535), 0));
  });
  test("strict binary decoder including absent banks and exact lengths", [&] {
    Patch patch; PatchBundle result; std::string error; const auto good = pack(patch);
    CHECK(decodePatchBundle(good.data(), good.size(), result, error)); CHECK(result.patch.params == patch.params);
    auto data = good; data.push_back(0); CHECK(!decodePatchBundle(data.data(), data.size(), result, error));
    CHECK(!decodePatchBundle(good.data(), good.size() - 1, result, error));
    data = good; write32(data, 12, generated::kSchemaFingerprint ^ 1u); CHECK(!decodePatchBundle(data.data(), data.size(), result, error));
    data = good; write32(data, 32 + 94 * 4, 0x7fc00000u); CHECK(!decodePatchBundle(data.data(), data.size(), result, error));
    set(patch, ParameterId::Osc2Bank, 7); data = pack(patch); CHECK(!decodePatchBundle(data.data(), data.size(), result, error));
    CustomBank bank {7, 2, waveform(1, 2)}; data = pack(patch, {bank}); CHECK(decodePatchBundle(data.data(), data.size(), result, error));
    CHECK(result.banks.size() == 1 && result.banks[0].samples == bank.samples);
    data = pack(patch, {bank, bank}); CHECK(!decodePatchBundle(data.data(), data.size(), result, error));
    bank.samples[11] = 1.1f; data = pack(patch, {bank}); CHECK(!decodePatchBundle(data.data(), data.size(), result, error));
  });
  test("silence and sample-offset onset", [&] {
    Synth synth; synth.prepare(48000, tables); Patch patch = dryPatch(); set(patch, ParameterId::Osc1Phase, 0.25f); CHECK(synth.applyPatch(patch, true));
    auto silent = render(synth, 4096); CHECK(rms(silent.left) == 0 && rms(silent.right) == 0);
    const auto audio = render(synth, 1024, {noteOn(60, 173)}, 257);
    for (unsigned i = 0; i < 173; ++i) CHECK(audio.left[i] == 0 && audio.right[i] == 0);
    CHECK(std::abs(audio.left[173]) > 0.00001f); CHECK(rms(audio.left, 173) > 0.01); bounded(audio);
  });
  test("AHDSR hold and release durations", [&] {
    Envelope envelope; envelope.prepare(48000); envelope.configure({0.01f, 0.02f, 0.03f, 0.4f, 0.04f}); envelope.noteOn();
    for (unsigned i = 0; i < 480; ++i) envelope.next(); CHECK(envelope.stage() == Envelope::Stage::Hold);
    for (unsigned i = 0; i < 960; ++i) CHECK(envelope.next() == 1.0f);
    CHECK(envelope.stage() == Envelope::Stage::Decay);
    for (unsigned i = 0; i < 1440; ++i) envelope.next(); CHECK(envelope.stage() == Envelope::Stage::Sustain);
    CHECK(std::abs(envelope.value() - 0.4f) < 0.000001f); envelope.noteOff();
    for (unsigned i = 0; i < 1920; ++i) envelope.next(); CHECK(!envelope.active() && envelope.value() == 0);
  });
  test("determinism and callback partition invariance", [&] {
    Patch patch = dryPatch(); set(patch, ParameterId::Osc1Unison, 5); set(patch, ParameterId::Osc1RandomPhase, 1);
    set(patch, ParameterId::NoiseLevel, 0.1f); set(patch, ParameterId::ChorusMix, 0.2f); set(patch, ParameterId::DelayMix, 0.1f);
    patch.routes[0] = {ModSource::Lfo1, ParameterId::Osc1Position, generated::kNoAuxSource, 0.3f, 0, true, true};
    std::vector<Event> events {noteOn(60, 19), noteOn(67, 4001), noteOff(60, 9007), noteOff(67, 12017)};
    Synth a, b; a.prepare(48000, tables); b.prepare(48000, tables); CHECK(a.applyPatch(patch, true)); CHECK(b.applyPatch(patch, true)); a.reset(7); b.reset(7);
    const auto one = render(a, 20000, events, 128), two = render(b, 20000, events, 511);
    CHECK(one.left == two.left && one.right == two.right);
  });
  test("sustain pedal, repeated note matching, and release", [&] {
    Synth synth; synth.prepare(48000, tables); CHECK(synth.applyPatch(dryPatch(), true));
    Event pedal = noteOn(); pedal.type = EventType::Sustain; pedal.value = 1;
    render(synth, 1000, {pedal, noteOn(60), noteOn(60, 1), noteOff(60, 300), noteOff(60, 400)});
    CHECK(synth.stats().activeVoices == 2); render(synth, 2000); CHECK(synth.stats().activeVoices == 2);
    pedal.value = 0; render(synth, 2000, {pedal}); CHECK(synth.stats().activeVoices == 0);
  });
  test("sixteen voice limit and bounded steal crossfades", [&] {
    Synth synth; synth.prepare(48000, tables); CHECK(synth.applyPatch(dryPatch(), true));
    std::vector<Event> events; for (unsigned i = 0; i < 16; ++i) events.push_back(noteOn(40 + i)); render(synth, 2048, events);
    CHECK(synth.stats().activeVoices == 16); auto audio = render(synth, 64, {noteOn(80)});
    CHECK(synth.stats().activeVoices == 16 && synth.stats().stolenVoices == 1 && synth.stats().fadingVoices == 1); bounded(audio);
    Event off; off.type = EventType::AllNotesOff; render(synth, 4096, {off}); CHECK(synth.stats().activeVoices == 0 && synth.stats().fadingVoices == 0);
  });
  test("held-note scalar patch update preserves attack and phase", [&] {
    Synth a, b; a.prepare(48000, tables); b.prepare(48000, tables); auto patch = dryPatch(); set(patch, ParameterId::Env1Attack, 1);
    CHECK(a.applyPatch(patch, true)); CHECK(b.applyPatch(patch, true)); render(a, 30000, {noteOn()}); render(b, 30000, {noteOn()});
    CHECK(a.applyPatch(patch)); const auto sameA = render(a, 2048), sameB = render(b, 2048); CHECK(sameA.left == sameB.left);
    set(patch, ParameterId::Osc1Position, 0.9f); CHECK(a.applyPatch(patch)); const auto changed = render(a, 4096), baseline = render(b, 4096);
    CHECK(a.stats().activeVoices == 1); CHECK(rms(changed.left, 1024) > 0.01); CHECK(difference(changed.left, baseline.left, 1024) > 0.005);
  });
  test("atomic disjoint user bank replacement retains held voice", [&] {
    PreparedWavetableSet first, second; const auto sine = waveform(1), third = waveform(3);
    first.setCustom(4, sine.data(), 1); second.setCustom(5, third.data(), 1);
    Patch patch = dryPatch(); set(patch, ParameterId::Osc1Bank, 4); Synth synth; synth.prepare(48000, first); CHECK(synth.applyPatch(patch, true));
    render(synth, 4096, {noteOn()}); set(patch, ParameterId::Osc1Bank, 5);
    CHECK(!synth.applyPatch(patch)); CHECK(!synth.swapWavetables(second)); CHECK(synth.applyPreparedPatch(patch, second));
    CHECK(!synth.applyPreparedPatch(patch, first)); CHECK(synth.takeRetiredWavetables() == nullptr);
    auto transition = render(synth, 1024); bounded(transition); CHECK(rms(transition.left) > 0.01); CHECK(synth.stats().activeVoices == 1);
    CHECK(synth.takeRetiredWavetables() == &first); CHECK(synth.takeRetiredWavetables() == nullptr);
    CHECK(!synth.setParameter(ParameterId::Osc2Bank, 4));
    const auto sustained = render(synth, 4096); CHECK(rms(sustained.left) > 0.01);
  });
  test("same-slot table edit crossfade lifetime and audible change", [&] {
    PreparedWavetableSet first, second; const auto a = waveform(1), b = waveform(2); first.setCustom(4, a.data(), 1); second.setCustom(4, b.data(), 1);
    Patch patch = dryPatch(); set(patch, ParameterId::Osc1Bank, 4); Synth synth; synth.prepare(48000, first); CHECK(synth.applyPatch(patch, true));
    render(synth, 2048, {noteOn()}); CHECK(synth.swapWavetables(second, 256)); CHECK(!synth.swapWavetables(first));
    render(synth, 255); CHECK(synth.takeRetiredWavetables() == nullptr); render(synth, 1); CHECK(synth.takeRetiredWavetables() == &first);
    CHECK(synth.stats().activeVoices == 1); CHECK(rms(render(synth, 1024).left) > 0.01);
  });
  test("modulation amount, polarity, auxiliary source and curve", [&] {
    Patch actual = dryPatch(); set(actual, ParameterId::Osc1Level, 0.2f); set(actual, ParameterId::Macro1, 0.75f); set(actual, ParameterId::Macro2, 0.5f);
    actual.routes[0] = {ModSource::Macro1, ParameterId::Osc1Level, static_cast<unsigned>(ModSource::Macro2), 0.5f, 0.5f, true, true};
    // ((2*.75-1)^2) * .5(aux) * .5(amount) = .0625 normalized displacement.
    Patch reference = actual; reference.routes[0].enabled = false; set(reference, ParameterId::Osc1Level, 0.2625f);
    const auto a = sound(tables, actual), b = sound(tables, reference); CHECK(difference(a.left, b.left) < 0.000001);
    actual.routes[1] = actual.routes[0]; actual.routes[1].amount = -0.5f; reference = actual; reference.routes[0].enabled = reference.routes[1].enabled = false;
    CHECK(difference(sound(tables, actual).left, sound(tables, reference).left) < 0.000001);
  });
  test("cutoff routes use the logarithmic normalized domain", [&] {
    Patch actual = dryPatch(); set(actual, ParameterId::Filter1Enabled, 1); set(actual, ParameterId::Osc1Position, 0.8f);
    set(actual, ParameterId::Filter1Cutoff, 100); set(actual, ParameterId::Macro1, 0.5f);
    actual.routes[0] = {ModSource::Macro1, ParameterId::Filter1Cutoff, generated::kNoAuxSource, 0.4f, 0, false, true};
    Patch reference = actual; reference.routes[0].enabled = false; set(reference, ParameterId::Filter1Cutoff, 100.0f * std::pow(1000.0f, 0.2f));
    CHECK(difference(sound(tables, actual).left, sound(tables, reference).left) < 0.00001);
  });
  test("all eighteen modulation destinations reach the audio path", [&] {
    for (unsigned index = 0; index < generated::kParamCount; ++index) if (generated::kModulatable[index]) {
      Patch patch = dryPatch(); set(patch, ParameterId::Macro1, 0.6f);
      for (unsigned oscillator = 0; oscillator < 3; ++oscillator) { patch.params[oscillator * 12] = 1; patch.params[oscillator * 12 + 2] = 0.5f; patch.params[oscillator * 12 + 3] = 0.12f; }
      set(patch, ParameterId::Filter1Enabled, 1); set(patch, ParameterId::Filter2Enabled, 1);
      set(patch, ParameterId::Filter1Cutoff, 700); set(patch, ParameterId::Filter2Cutoff, 1400); set(patch, ParameterId::SubLevel, 0.1f); set(patch, ParameterId::NoiseLevel, 0.02f);
      const auto before = sound(tables, patch, 8192);
      patch.routes[0] = {ModSource::Macro1, static_cast<ParameterId>(index), generated::kNoAuxSource, 0.25f, 0, false, true};
      const auto after = sound(tables, patch, 8192);
      if (difference(before.left, after.left) <= 0.00001 && difference(before.right, after.right) <= 0.00001)
        throw std::runtime_error(std::string("Unresponsive destination: ") + generated::kParameterNames[index]);
    }
  });
  test("LFO BPM sync matches equivalent Hz rate", [&] {
    Patch synchronized = dryPatch(); set(synchronized, ParameterId::Lfo1Sync, 1); set(synchronized, ParameterId::Lfo1Division, 0.5f);
    synchronized.routes[0] = {ModSource::Lfo1, ParameterId::Osc1Level, generated::kNoAuxSource, 0.4f, 0, true, true};
    Patch free = synchronized; set(free, ParameterId::Lfo1Sync, 0); set(free, ParameterId::Lfo1Rate, 4);
    CHECK(difference(sound(tables, synchronized, 48000).left, sound(tables, free, 48000).left) < 0.000001);
    Synth slow; slow.prepare(48000, tables); CHECK(slow.applyPatch(synchronized, true));
    const auto at60 = render(slow, 48000, {noteOn()}, 128, 60);
    CHECK(difference(at60.left, sound(tables, synchronized, 48000).left) > 0.005);
  });
  test("global LFO follows transport; retrigger LFO follows each note", [&] {
    Patch global = dryPatch(); set(global, ParameterId::Lfo1Sync, 1); set(global, ParameterId::Lfo1Retrigger, 0);
    global.routes[0] = {ModSource::Lfo1, ParameterId::Osc1Level, generated::kNoAuxSource, 0.5f, 0, true, true};
    Synth a, b; a.prepare(48000, tables); b.prepare(48000, tables); CHECK(a.applyPatch(global, true)); CHECK(b.applyPatch(global, true));
    std::array<float, 2048> al {}, ar {}, bl {}, br {}; auto event = noteOn();
    a.process(al.data(), ar.data(), 2048, &event, 1, {120, 0, true, true}); b.process(bl.data(), br.data(), 2048, &event, 1, {120, 0.5, true, true});
    double delta = 0; for (unsigned i = 0; i < al.size(); ++i) delta += std::abs(al[i] - bl[i]); CHECK(delta > 1);
    set(global, ParameterId::Lfo1Retrigger, 1); a.reset(); b.reset(); CHECK(a.applyPatch(global, true)); CHECK(b.applyPatch(global, true));
    a.process(al.data(), ar.data(), 2048, &event, 1, {120, 0, true, true}); b.process(bl.data(), br.data(), 2048, &event, 1, {120, 0.5, true, true}); CHECK(al == bl);
  });
  test("stereo filters and serial/parallel routing are distinct", [&] {
    Patch patch = dryPatch(); set(patch, ParameterId::Osc1Position, 0.8f); set(patch, ParameterId::Filter1Enabled, 1); set(patch, ParameterId::Filter1Cutoff, 900);
    std::array<Audio, 4> types;
    for (unsigned type = 0; type < 4; ++type) { set(patch, ParameterId::Filter1Type, static_cast<float>(type)); types[type] = sound(tables, patch); bounded(types[type]); }
    for (unsigned a = 0; a < 4; ++a) for (unsigned b = a + 1; b < 4; ++b) CHECK(difference(types[a].left, types[b].left) > 0.001);
    set(patch, ParameterId::Filter1Type, 0); set(patch, ParameterId::Filter2Enabled, 1); set(patch, ParameterId::Filter2Type, 1); set(patch, ParameterId::Filter2Cutoff, 1500);
    const auto serial = sound(tables, patch); set(patch, ParameterId::FilterRouting, 1); const auto parallel = sound(tables, patch); CHECK(difference(serial.left, parallel.left) > 0.001);
  });
  test("pitch bend and sub oscillator octave are audible", [&] {
    Patch patch = dryPatch(); Synth synth; synth.prepare(48000, tables); CHECK(synth.applyPatch(patch, true));
    auto bend = noteOn(); bend.type = EventType::PitchBend; bend.value = 1; bend.sampleOffset = 1000;
    const auto bent = render(synth, 16000, {noteOn(), bend}); CHECK(difference(bent.left, sound(tables, patch, 16000).left, 3000) > 0.01);
    set(patch, ParameterId::Osc1Enabled, 0); set(patch, ParameterId::SubLevel, 0.8f); const auto sub = sound(tables, patch);
    set(patch, ParameterId::SubOctave, -2); const auto lower = sound(tables, patch); CHECK(rms(sub.left) > 0.01 && difference(sub.left, lower.left) > 0.01);
  });
  test("timeline note amplitude above one preserves clip gain", [&] {
    Patch patch = dryPatch(); set(patch, ParameterId::Level, 0.2f); Synth a, b; a.prepare(48000, tables); b.prepare(48000, tables);
    CHECK(a.applyPatch(patch, true)); CHECK(b.applyPatch(patch, true));
    const auto low = render(a, 4096, {noteOn(60, 0, 0.8f)}), high = render(b, 4096, {noteOn(60, 0, 1.6f)});
    for (unsigned i = 0; i < low.left.size(); ++i) CHECK(std::abs(high.left[i] - 2.0f * low.left[i]) < 0.000001f);
    CHECK(b.stats().ignoredEvents == 0 && b.stats().activeVoices == 1);
    patch.routes[0] = {ModSource::Velocity, ParameterId::Osc1Level, generated::kNoAuxSource, 0.1f, 0, false, true};
    a.reset(); b.reset(); CHECK(a.applyPatch(patch, true)); patch.routes[0].source = ModSource::Macro1; set(patch, ParameterId::Macro1, 1);
    CHECK(b.applyPatch(patch, true));
    CHECK(render(a, 4096, {noteOn(60, 0, 1.6f)}).left == render(b, 4096, {noteOn(60, 0, 1.6f)}).left);
  });
  test("effects produce stereo motion, nonlinear color, and a causal tail", [&] {
    const auto dry = sound(tables, dryPatch(), 24000); Patch patch = dryPatch();
    set(patch, ParameterId::Drive, 0.8f); set(patch, ParameterId::DriveMix, 0.7f); CHECK(difference(dry.left, sound(tables, patch, 24000).left) > 0.001);
    patch = dryPatch(); set(patch, ParameterId::ChorusMix, 0.4f); const auto chorus = sound(tables, patch, 24000); CHECK(difference(chorus.left, chorus.right, 4000) > 0.001);
    patch = dryPatch(); set(patch, ParameterId::DelayTime, 0.1f); set(patch, ParameterId::DelayMix, 0.4f); set(patch, ParameterId::DelayFeedback, 0.5f);
    Synth synth; synth.prepare(48000, tables); CHECK(synth.applyPatch(patch, true)); const auto delay = render(synth, 30000, {noteOn(), noteOff(60, 6000)});
    CHECK(rms(delay.left, 11000, 16000) > 0.0001); bounded(delay);
  });
  test("long silent effect tail returns exactly to zero without denormals", [&] {
    Effects effects; effects.prepare(48000); Stereo output;
    for (unsigned i = 0; i < 480000; ++i)
      output = effects.process({i == 0 ? 1.0f : 0.0f, 0}, 0, 0, 0.3f, 0.3f, 0, 0.01f, 0.5f, 1);
    CHECK(output.left == 0.0f && output.right == 0.0f);
  });
  test("bandlimited table spectral residual and morph continuity", [&] {
    std::vector<float> saw(generated::kWavetableSize); for (unsigned i = 0; i < saw.size(); ++i) saw[i] = 2.0f * i / static_cast<float>(saw.size()) - 1.0f;
    PreparedWavetable table; table.prepare(saw.data(), 1);
    constexpr unsigned count = 32768, bin = 997; constexpr double rate = 48000;
    const double frequency = rate * bin / count; const auto mip = selectMip(frequency, rate);
    std::vector<float> limited(count), naive(count);
    for (unsigned i = 0; i < count; ++i) {
      const double phase = wrapPhase(static_cast<double>(bin) * i / count);
      limited[i] = table.read(phase, 0, mip); naive[i] = static_cast<float>(2 * phase - 1);
    }
    const unsigned allowed = static_cast<unsigned>(std::floor(0.46 * rate / frequency));
    const double limitedDb = aliasRatio(limited, bin, allowed), naiveDb = aliasRatio(naive, bin, allowed);
    std::cout << "METRIC alias_residual_db=" << limitedDb << " naive_saw_db=" << naiveDb << '\n';
    CHECK(limitedDb < -85 && naiveDb - limitedDb > 60); CHECK(rms(limited) > 0.2);
    const auto frames = waveform(1, 2); table.prepare(frames.data(), 2);
    for (unsigned i = 0; i < 100; ++i) {
      const double phase = static_cast<double>(i) / 100;
      CHECK(std::abs(table.read(phase, 0.5f, {0, 0}) - 0.5f * (table.read(phase, 0, {0, 0}) + table.read(phase, 1, {0, 0}))) < 0.000001f);
    }
  });
  test("finite bounded output at 44.1, 48, and 96 kHz under parameter extremes", [&] {
    Patch patch = dryPatch();
    for (unsigned oscillator = 0; oscillator < 3; ++oscillator) {
      patch.params[oscillator * 12] = 1; patch.params[oscillator * 12 + 3] = 1; patch.params[oscillator * 12 + 7] = 7;
      patch.params[oscillator * 12 + 8] = 50; patch.params[oscillator * 12 + 11] = 1;
    }
    set(patch, ParameterId::Filter1Enabled, 1); set(patch, ParameterId::Filter1Resonance, 0.95f); set(patch, ParameterId::Filter1Cutoff, 20000);
    set(patch, ParameterId::Filter2Enabled, 1); set(patch, ParameterId::Filter2Resonance, 0.95f); set(patch, ParameterId::Filter2Cutoff, 20);
    set(patch, ParameterId::Drive, 1); set(patch, ParameterId::DriveMix, 1); set(patch, ParameterId::ChorusMix, 1); set(patch, ParameterId::ChorusDepth, 1);
    set(patch, ParameterId::DelayTime, 0.01f); set(patch, ParameterId::DelayFeedback, 0.95f); set(patch, ParameterId::DelayMix, 0.5f);
    set(patch, ParameterId::SubLevel, 1); set(patch, ParameterId::NoiseLevel, 1);
    for (double rate : {44100.0, 48000.0, 96000.0}) { Synth synth; synth.prepare(rate, tables); CHECK(synth.applyPatch(patch, true));
      std::vector<Event> events; for (unsigned i = 0; i < 16; ++i) events.push_back(noteOn(i * 8, i * 7)); bounded(render(synth, 12000, events)); }
  });
  test("callback, patch apply, and table swap allocate no heap memory", [&] {
    PreparedWavetableSet replacement; Patch patch = dryPatch(); Synth synth; synth.prepare(48000, tables); CHECK(synth.applyPatch(patch, true));
    std::array<float, 128> left {}, right {}; std::array<Event, 32> notes {};
    for (unsigned i = 0; i < notes.size(); ++i) notes[i] = noteOn(40 + i, i * 2);
    allocation_guard::allocations = 0; allocation_guard::active = true;
    const bool applied = synth.applyPatch(patch), swapped = synth.swapWavetables(replacement);
    for (unsigned block = 0; block < 128; ++block) synth.process(left.data(), right.data(), 128, block == 0 ? notes.data() : nullptr, block == 0 ? notes.size() : 0);
    const auto* retired = synth.takeRetiredWavetables();
    allocation_guard::active = false;
    CHECK(applied && swapped && retired == &tables && allocation_guard::allocations == 0);
  });
  test("invalid events are rejected and never poison audio state", [&] {
    Synth synth; synth.prepare(48000, tables); Event nan = noteOn(); nan.value = std::numeric_limits<float>::quiet_NaN();
    Event outside = noteOn(); outside.channel = 17; Event parameter; parameter.type = EventType::Parameter; parameter.parameter = ParameterId::Lfo1Division; parameter.value = 0.75f;
    const auto audio = render(synth, 1024, {nan, outside, parameter, noteOn(60, 10)}); bounded(audio); CHECK(synth.stats().ignoredEvents == 3 && synth.stats().activeVoices == 1);
    Patch patch = dryPatch(); set(patch, ParameterId::Lfo1Sync, 1); set(patch, ParameterId::Lfo1Retrigger, 0);
    set(patch, ParameterId::Lfo1Division, 0.125f);
    patch.routes[0] = {ModSource::Lfo1, ParameterId::Osc1Level, generated::kNoAuxSource, 0.2f, 0, true, true};
    CHECK(synth.applyPatch(patch)); std::array<float, 128> left {}, right {};
    synth.process(left.data(), right.data(), 128, nullptr, 0,
      {std::numeric_limits<double>::quiet_NaN(), std::numeric_limits<double>::max(), true, true});
    for (float sample : left) CHECK(std::isfinite(sample));
  });
  test("worst configured polyphony throughput report", [&] {
    Patch patch = dryPatch();
    for (unsigned osc = 0; osc < 3; ++osc) { patch.params[osc * 12] = 1; patch.params[osc * 12 + 7] = 7; patch.params[osc * 12 + 11] = 1; patch.params[osc * 12 + 3] = 0.2f; }
    set(patch, ParameterId::Filter1Enabled, 1); set(patch, ParameterId::Filter2Enabled, 1); set(patch, ParameterId::ChorusMix, 0.25f); set(patch, ParameterId::DelayMix, 0.2f); set(patch, ParameterId::DriveMix, 0.3f);
    Synth synth; synth.prepare(48000, tables); CHECK(synth.applyPatch(patch, true)); std::vector<Event> notes; for (unsigned i = 0; i < 16; ++i) notes.push_back(noteOn(36 + i * 2));
    const auto begin = std::chrono::steady_clock::now(); const auto audio = render(synth, 48000, notes);
    const double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - begin).count();
    std::cout << "METRIC worst_16x3x7_seconds=" << elapsed << " realtime_factor=" << 1.0 / elapsed << '\n'; bounded(audio); CHECK(rms(audio.left, 4096) > 0.001);
  });
  test("64-frame callback timing under maximum voices, unison, routes, and FX", [&] {
    Patch patch = dryPatch();
    for (unsigned osc = 0; osc < 3; ++osc) {
      patch.params[osc * 12] = 1; patch.params[osc * 12 + 2] = 0.5f; patch.params[osc * 12 + 3] = 0.15f;
      patch.params[osc * 12 + 7] = 7; patch.params[osc * 12 + 11] = 1;
    }
    set(patch, ParameterId::Filter1Enabled, 1); set(patch, ParameterId::Filter2Enabled, 1);
    set(patch, ParameterId::Filter1Cutoff, 4000); set(patch, ParameterId::Filter2Cutoff, 8000);
    set(patch, ParameterId::Drive, 0.5f); set(patch, ParameterId::DriveMix, 0.3f);
    set(patch, ParameterId::ChorusMix, 0.3f); set(patch, ParameterId::DelayMix, 0.3f);
    for (unsigned i = 0; i < patch.routes.size(); ++i) {
      const ParameterId destination = i % 4 == 0 ? ParameterId::Osc1Position : i % 4 == 1 ? ParameterId::Osc2Position :
        i % 4 == 2 ? ParameterId::Osc3Tune : ParameterId::Filter1Cutoff;
      patch.routes[i] = {static_cast<ModSource>(4 + i % 4), destination, static_cast<unsigned>(ModSource::Velocity), 0.03f, 0.3f, true, true};
    }
    std::array<Event, 16> notes; for (unsigned i = 0; i < 16; ++i) notes[i] = noteOn(36 + i * 2);
    std::array<float, 64> left {}, right {};
    for (double rate : {44100.0, 48000.0, 96000.0}) {
      Synth synth; synth.prepare(rate, tables); CHECK(synth.applyPatch(patch, true)); synth.process(left.data(), right.data(), 64, notes.data(), notes.size());
      for (unsigned warm = 0; warm < 256; ++warm) synth.process(left.data(), right.data(), 64);
      constexpr unsigned blocks = 1024; std::array<double, blocks> elapsed {};
      const double deadline = 64.0 / rate * 1000000.0; unsigned missed = 0;
      for (unsigned block = 0; block < blocks; ++block) {
        const auto begin = std::chrono::steady_clock::now(); synth.process(left.data(), right.data(), 64);
        elapsed[block] = std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - begin).count();
        if (elapsed[block] > deadline) ++missed;
      }
      std::sort(elapsed.begin(), elapsed.end());
      std::cout << "METRIC block64_rate=" << rate << " deadline_us=" << deadline << " p50_us=" << elapsed[blocks / 2]
        << " p95_us=" << elapsed[blocks * 95 / 100] << " p99_us=" << elapsed[blocks * 99 / 100] << " max_us=" << elapsed.back()
        << " observed_overruns=" << missed << '/' << blocks << '\n';
      CHECK(synth.stats().activeVoices == 16);
      for (float value : left) CHECK(std::isfinite(value) && std::abs(value) <= 0.980001f);
    }
  });
  std::cout << "RESULT " << passed << " passed, " << failed << " failed\n";
  return failed == 0 ? 0 : 1;
}

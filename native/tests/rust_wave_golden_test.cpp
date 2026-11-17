// IEUM WAVE golden parity (docs/IEUM_WAVE.md, docs/RUST_ENGINE.md 7): the Rust engine (rust/garak-engine via
// garak-ffi) against renders of the original C++ synth (native/devices/wavetable-synth, removed in 0.3.3),
// captured from the C++ RenderEngine before that removal and stored in rust/garak-engine/tests/golden/ieum-wave.
//
// Cases (the WAVE cases of the former C++ vs Rust instrument parity test): the WAVE test project (a rich patch
// with a user bank, unison, three oscillators, sub, noise, two filters, LFO/envelope/velocity routes, drive,
// chorus and delay, plus the default patch, and a reverb return) offline at 48 kHz / 4096, 48 kHz / 128 and
// 44.1 kHz / 512, and a live engine with a cycle: note deletions / additions across the playhead, a mix edit,
// a seek, live MIDI (velocity above 1, CC7, pitch bend, the sustain pedal, a timed preview, track all-notes-off),
// a WAVE patch change (20 ms table crossfade) with a tempo edit during the fade, pause / stop / replay.
//
// Gate: bit-identical (the float32 hash) on Windows x86-64 (MSVC and MinGW: the CRT math the C++ synth called),
// otherwise a residual <= -90 dBFS against the stored 24-bit render; equal latency and length always.
//
// Built with GARAK_WAVE_GOLDEN_CAPTURE (only possible while the C++ synth existed) it rendered the C++
// reference, checked the Rust engine against it and wrote the golden files.
#include "garak_engine.h"
#include "garak_engine_instruments.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#ifdef GARAK_WAVE_GOLDEN_CAPTURE
#include "cpp_reference_engine.hpp"
#include "garak/engine.hpp"
#include "protocol.hpp"
#endif

#ifndef GARAK_WAVE_GOLDEN_DIR
#error "GARAK_WAVE_GOLDEN_DIR must name rust/garak-engine/tests/golden/ieum-wave"
#endif

namespace {
int failures = 0;
void check(bool ok, const std::string& what, double detail = 0) {
  if (!ok) { ++failures; std::fprintf(stderr, "FAIL %s (%.6g)\n", what.c_str(), detail); }
}
double dbfs(double v) { return v > 0 ? 20 * std::log10(v) : -400; }

constexpr std::uint32_t kWaveCase = 4; // garak_engine::testkit::instruments::WAVE

struct Project {
  std::string json;
  std::vector<std::pair<std::string, std::vector<float>>> assets; // none for the WAVE project today
  std::vector<std::uint32_t> assetRates, assetChannels;
};

Project waveProject(double seconds, std::uint32_t rate) {
  Project p;
  auto* t = garak_rs_testkit_instruments_create(kWaveCase, seconds, rate);
  if (!t) throw std::runtime_error("WAVE testkit project");
  std::size_t length = 0;
  const auto* json = garak_rs_testkit_json(t, &length);
  p.json.assign(reinterpret_cast<const char*>(json), length);
  for (std::uint32_t i = 0; i < garak_rs_testkit_asset_count(t); ++i) {
    const std::uint8_t* id = nullptr; std::size_t idLength = 0, count = 0; std::uint32_t sr = 0, channels = 0; const float* samples = nullptr;
    garak_rs_testkit_asset(t, i, &id, &idLength, &sr, &channels, &samples, &count);
    p.assets.emplace_back(std::string(reinterpret_cast<const char*>(id), idLength), std::vector<float>(samples, samples + count));
    p.assetRates.push_back(sr); p.assetChannels.push_back(channels);
  }
  garak_rs_testkit_destroy(t);
  return p;
}

struct Render { std::vector<float> samples; std::uint32_t latency = 0; std::uint64_t frames = 0; std::uint32_t rate = 0; };

std::string rustError(GarakRsEngine* e) {
  std::string message(512, '\0');
  message.resize(std::min<std::size_t>(512, garak_rs_engine_last_error(e, reinterpret_cast<std::uint8_t*>(message.data()), message.size())));
  return message;
}

GarakRsEngine* rustEngine(const Project& project, std::uint32_t rate, std::uint32_t block, bool offline) {
  auto* e = garak_rs_engine_create(rate, block, offline ? 1 : 0);
  for (std::size_t i = 0; i < project.assets.size(); ++i) {
    const auto& [id, samples] = project.assets[i];
    garak_rs_engine_put_asset(e, reinterpret_cast<const std::uint8_t*>(id.data()), id.size(), project.assetRates[i], project.assetChannels[i], samples.data(), samples.size());
  }
  return e;
}

int setRust(GarakRsEngine* e, const std::string& json) { return garak_rs_engine_set(e, reinterpret_cast<const std::uint8_t*>(json.data()), json.size(), nullptr, 0); }

std::int64_t lengthFrames(const std::string& json) {
  const auto at = json.find("\"lengthFrames\":");
  if (at == std::string::npos) throw std::runtime_error("lengthFrames missing");
  return std::stoll(json.substr(at + 15));
}

// host.cpp renderStopped through the Rust engine (offline engine, play from 0, length + tail + latency).
Render renderRustOffline(const Project& project, std::uint32_t rate, std::uint32_t block) {
  auto* e = rustEngine(project, rate, block, true);
  Render r; r.rate = rate;
  if (setRust(e, project.json) < 0) {
    check(false, "rust engine refused the WAVE project: " + rustError(e));
    garak_rs_engine_destroy(e);
    return r;
  }
  garak_rs_engine_transport(e, GARAK_RS_PLAY, 0);
  double tail = 0; garak_rs_engine_graph_info(e, &r.latency, &tail);
  r.frames = std::uint64_t(lengthFrames(project.json)) + std::uint64_t(std::ceil(std::min(30.0, tail) * rate));
  std::vector<float> chunk(std::size_t(block) * 2);
  r.samples.reserve(r.frames * 2);
  for (std::uint64_t done = 0; done < r.frames + r.latency;) {
    const auto frames = std::uint32_t(std::min<std::uint64_t>(block, r.frames + r.latency - done));
    garak_rs_engine_render(e, chunk.data(), frames);
    const auto skip = std::uint32_t(std::min<std::uint64_t>(frames, done < r.latency ? r.latency - done : 0));
    r.samples.insert(r.samples.end(), chunk.begin() + skip * 2, chunk.begin() + frames * 2);
    done += frames;
  }
  garak_rs_engine_collect(e);
  garak_rs_engine_destroy(e);
  return r;
}

std::string edit(std::string text, const std::string& from, const std::string& to, std::size_t from_pos = 0) {
  const auto at = text.find(from, from_pos);
  if (at == std::string::npos) throw std::runtime_error("edit target missing: " + from);
  return text.replace(at, from.size(), to);
}
std::size_t trackStart(const std::string& json, const std::string& id) {
  const auto at = json.find("{\"id\":\"" + id + "\"");
  if (at == std::string::npos) throw std::runtime_error("track missing: " + id);
  return at;
}
std::string withRevision(const std::string& json, int from, int to) { return edit(json, "\"revision\":" + std::to_string(from), "\"revision\":" + std::to_string(to)); }
std::string patchOf(const std::string& json, const std::string& track) {
  const auto at = json.find("\"patchData\":\"", trackStart(json, track)) + 13;
  return json.substr(at, json.find('"', at) - at);
}
std::string withPatch(std::string json, const std::string& track, const std::string& patch) {
  const auto at = json.find("\"patchData\":\"", trackStart(json, track)) + 13;
  return json.replace(at, json.find('"', at) - at, patch);
}
// The first note record of `track` ({"id":N,"onFrame":A,"offFrame":B,...}) sounding at `frame`, removed.
std::string removeSounding(const std::string& json, const std::string& track, std::int64_t frame) {
  std::size_t at = json.find("\"notes\":[", trackStart(json, track)) + 9;
  const auto end = json.find(']', at);
  while (at < end) {
    const auto close = json.find('}', at) + 1;
    const auto record = json.substr(at, close - at);
    const auto on = std::stoll(record.substr(record.find("\"onFrame\":") + 10));
    const auto off = std::stoll(record.substr(record.find("\"offFrame\":") + 11));
    if (on < frame && off > frame + 480) {
      std::size_t a = at, b = close;
      std::string out = json;
      if (out[b] == ',') ++b; else if (out[a - 1] == ',') --a;
      return out.erase(a, b - a);
    }
    at = close + (json[close] == ',' ? 1 : 0);
  }
  throw std::runtime_error("no sounding note on " + track + " at " + std::to_string(frame));
}
std::string addNote(const std::string& json, const std::string& track, std::int64_t on, std::int64_t off, int pitch, double velocity, std::int32_t id) {
  const auto at = json.find("\"notes\":[", trackStart(json, track)) + 9;
  std::string note = "{\"id\":" + std::to_string(id) + ",\"onFrame\":" + std::to_string(on) + ",\"offFrame\":" + std::to_string(off) +
                     ",\"limitFrame\":" + std::to_string(off) + ",\"pitch\":" + std::to_string(pitch) + ",\"velocity\":" + std::to_string(velocity) + "},";
  std::string out = json;
  return out.insert(at, note);
}

// One engine of the live scenario: the Rust engine, or (capture) the C++ RenderEngine.
struct LiveEngine {
  virtual ~LiveEngine() = default;
  virtual int apply(const std::string& json) = 0; // 0 none, 1 diff, 2 tracks, 3 full; < 0 refused
  virtual void transport(std::uint32_t command, std::int64_t frame) = 0;
  virtual void noteOn(std::uint32_t track, int pitch, float velocity, int id) = 0;
  virtual void noteOff(std::uint32_t track, int pitch, int id) = 0;
  virtual void preview(std::uint32_t track, int pitch, float velocity, std::uint32_t frames) = 0;
  virtual void control(std::uint32_t track, int controller, int value) = 0;
  virtual void allNotesOff(std::uint32_t track) = 0;
  virtual void render(float* out, std::uint32_t frames) = 0;
  virtual std::int64_t frame() = 0;
};

struct RustLive final : LiveEngine {
  GarakRsEngine* e;
  RustLive(const Project& p, std::uint32_t rate, std::uint32_t block) : e(rustEngine(p, rate, block, false)) {}
  ~RustLive() override { garak_rs_engine_destroy(e); }
  int apply(const std::string& json) override {
    const int applied = setRust(e, json);
    if (applied < 0) check(false, "live: rust refused an edit: " + rustError(e));
    return applied;
  }
  void transport(std::uint32_t command, std::int64_t frame) override { garak_rs_engine_transport(e, command, frame); }
  void noteOn(std::uint32_t t, int pitch, float v, int id) override { garak_rs_engine_note_on(e, t, pitch, v, id); }
  void noteOff(std::uint32_t t, int pitch, int id) override { garak_rs_engine_note_off(e, t, pitch, id); }
  void preview(std::uint32_t t, int pitch, float v, std::uint32_t frames) override { garak_rs_engine_preview_note(e, t, pitch, v, frames); }
  void control(std::uint32_t t, int c, int value) override { garak_rs_engine_control_change(e, t, c, value); }
  void allNotesOff(std::uint32_t t) override { garak_rs_engine_all_notes_off(e, t); }
  void render(float* out, std::uint32_t frames) override { garak_rs_engine_render(e, out, frames); garak_rs_engine_collect(e); }
  std::int64_t frame() override { std::uint64_t applied = 0; std::int64_t f = 0; garak_rs_engine_snapshot(e, &applied, &f); return f; }
};

constexpr std::uint32_t kLiveRate = 48000, kLiveBlock = 128, kLiveCall = 256;
constexpr double kLiveSeconds = 6;

// The live scenario on `engine` (the WAVE project, 6 s at 48 kHz, cycle 1..4 s). Returns the stereo output.
Render live(LiveEngine& engine, const Project& base, std::vector<int>* kinds) {
  std::string current = edit(base.json, "\"lengthFrames\":" + std::to_string(lengthFrames(base.json)) + ",",
                             "\"lengthFrames\":" + std::to_string(lengthFrames(base.json)) + ",\"cycle\":{\"startFrame\":48000,\"endFrame\":192000},");
  const std::string defaultPatch = patchOf(current, "wave-default");
  check(engine.apply(current) == 3, "live: initial graph");
  engine.transport(GARAK_RS_PLAY, 0);
  const auto total = std::uint32_t(kLiveSeconds * kLiveRate);
  Render r; r.rate = kLiveRate; r.frames = total; r.samples.assign(std::size_t(total) * 2, 0.f);
  int revision = 1, stage = 0;
  std::int64_t position = 0;
  const auto apply = [&](const std::string& next) { const int k = engine.apply(next); if (kinds) kinds->push_back(k); current = next; };
  for (std::uint32_t done = 0; done < total; done += kLiveCall) {
    const double seconds = double(done) / kLiveRate;
    if (stage == 0 && seconds >= .7) {
      // A sounding lead note deleted (it releases), notes added across the playhead and ahead of it.
      auto next = withRevision(current, revision, revision + 1); ++revision;
      try { next = removeSounding(next, "wave-lead", position); } catch (const std::exception&) { next = removeSounding(next, "wave-default", position); }
      next = addNote(next, "wave-default", position - 6000, position + 30000, 55, .9, 9000);
      next = addNote(next, "wave-lead", position + 9000, position + 40000, 74, .7, 9001);
      apply(next); ++stage;
    } else if (stage == 1 && seconds >= 1.4) {
      auto next = withRevision(current, revision, revision + 1); ++revision;
      next = edit(next, "\"masterGain\":0.7", "\"masterGain\":0.55");
      next = edit(next, "\"sends\":[{\"returnId\":\"ret\",\"gain\":0.3}]", "\"sends\":[{\"returnId\":\"ret\",\"gain\":0.5}]");
      apply(next); ++stage;
    } else if (stage == 2 && seconds >= 2.0) {
      // Seek into held notes, then live MIDI on the lead (velocity above 1, CC7, bend, pedal).
      engine.transport(GARAK_RS_SEEK, 96000); position = 96000;
      engine.noteOn(0, 62, 1.5f, 8);
      engine.control(0, 7, 90);
      engine.control(0, 129, -4000);
      engine.control(0, 64, 127);
      ++stage;
    } else if (stage == 3 && seconds >= 2.4) {
      engine.noteOff(0, 62, 8); // held by the pedal
      engine.noteOn(1, 67, .8f, 9);
      engine.preview(1, 70, .7f, 3000);
      engine.control(0, 1, 80);
      ++stage;
    } else if (stage == 4 && seconds >= 2.8) {
      engine.control(0, 64, 0);
      engine.allNotesOff(1);
      ++stage;
    } else if (stage == 5 && seconds >= 3.1) {
      // A WAVE patch change: the running synth crossfades to the new table set (20 ms) ...
      auto next = withRevision(current, revision, revision + 1); ++revision;
      apply(withPatch(next, "wave-lead", defaultPatch)); ++stage;
    } else if (stage == 6 && seconds >= 3.11) {
      // ... and a tempo edit right after it waits for that fade.
      auto next = withRevision(current, revision, revision + 1); ++revision;
      apply(edit(next, "\"bpm\":100", "\"bpm\":104")); ++stage;
    } else if (stage == 7 && seconds >= 3.6) {
      engine.transport(GARAK_RS_PAUSE, 0); ++stage;
    } else if (stage == 8 && seconds >= 3.8) {
      engine.transport(GARAK_RS_PLAY, 0); ++stage;
    } else if (stage == 9 && seconds >= 4.4) {
      engine.allNotesOff(0);
      engine.transport(GARAK_RS_STOP, 0); position = 0; ++stage;
    } else if (stage == 10 && seconds >= 4.8) {
      engine.transport(GARAK_RS_PLAY, 0); ++stage;
    }
    const auto frames = std::min(kLiveCall, total - done);
    engine.render(r.samples.data() + std::size_t(done) * 2, frames);
    position = engine.frame();
  }
  return r;
}

// Golden file: "IWGOLD01", u32 rate, u32 latency, u64 frames, u64 FNV-1a 64 of the whole render's float32 bits
// (little endian; the bit-identity gate), then every kStride-th stereo frame as two signed 24-bit little-endian
// samples at 2^22 per unit (range +-2, quantization -138 dBFS; the residual gate). The stride keeps the files
// small: a platform's libm difference spreads over every sample, and Windows checks every bit through the hash.
constexpr double kScale = 4194304.0;
constexpr std::uint64_t kStride = 4;
std::uint64_t storedFrames(std::uint64_t frames) { return (frames + kStride - 1) / kStride; }
std::uint64_t floatHash(const std::vector<float>& v) {
  std::uint64_t h = 1469598103934665603ULL;
  for (const float x : v) {
    std::uint32_t bits; std::memcpy(&bits, &x, 4);
    for (int i = 0; i < 4; ++i) { h ^= (bits >> (8 * i)) & 0xFF; h *= 1099511628211ULL; }
  }
  return h;
}

struct Golden { std::uint32_t rate = 0, latency = 0; std::uint64_t frames = 0, hash = 0; std::vector<float> samples; };

std::string goldenPath(const std::string& name) { return std::string(GARAK_WAVE_GOLDEN_DIR) + "/" + name + ".iwgold"; }

Golden readGolden(const std::string& name) {
  std::ifstream in(goldenPath(name), std::ios::binary);
  if (!in) throw std::runtime_error("missing golden file " + goldenPath(name));
  std::vector<unsigned char> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  if (bytes.size() < 32 || std::memcmp(bytes.data(), "IWGOLD01", 8) != 0) throw std::runtime_error("bad golden file " + name);
  const auto u32 = [&](std::size_t at) { std::uint32_t v = 0; for (int i = 0; i < 4; ++i) v |= std::uint32_t(bytes[at + i]) << (8 * i); return v; };
  const auto u64 = [&](std::size_t at) { return std::uint64_t(u32(at)) | (std::uint64_t(u32(at + 4)) << 32); };
  Golden g; g.rate = u32(8); g.latency = u32(12); g.frames = u64(16); g.hash = u64(24);
  if (bytes.size() != 32 + storedFrames(g.frames) * 6) throw std::runtime_error("truncated golden file " + name);
  g.samples.resize(storedFrames(g.frames) * 2);
  for (std::size_t i = 0; i < g.samples.size(); ++i) {
    const std::size_t at = 32 + i * 3;
    std::int32_t v = std::int32_t(bytes[at]) | (std::int32_t(bytes[at + 1]) << 8) | (std::int32_t(bytes[at + 2]) << 16);
    if (v & 0x800000) v -= 0x1000000;
    g.samples[i] = float(v / kScale);
  }
  return g;
}

bool requireBitIdentical() {
#if defined(_WIN32) && (defined(_M_X64) || defined(__x86_64__))
  return true;
#else
  return false;
#endif
}

void compare(const std::string& name, const Render& rust) {
  const auto golden = readGolden(name);
  check(rust.rate == golden.rate, name + ": rate", rust.rate);
  check(rust.latency == golden.latency, name + ": latency", rust.latency);
  const bool sameLength = rust.frames == golden.frames && rust.samples.size() == golden.frames * 2;
  check(sameLength, name + ": length", double(rust.frames));
  double residual = 0, peak = 0;
  if (sameLength)
    for (std::size_t k = 0; k < golden.samples.size(); ++k) {
      const std::size_t i = (k / 2) * kStride * 2 + k % 2;
      residual = std::max(residual, double(std::abs(std::clamp(rust.samples[i], -2.f, 2.f) - golden.samples[k])));
      peak = std::max(peak, double(std::abs(golden.samples[k])));
    }
  else residual = 1e9;
  const bool identical = floatHash(rust.samples) == golden.hash;
  std::printf("| %s | %u Hz | %llu frames | %.2f | %s | %.1f dBFS |\n", name.c_str(), golden.rate, static_cast<unsigned long long>(golden.frames),
              dbfs(peak), identical ? "bit-identical" : "differs", dbfs(residual));
  check(peak > .05, name + ": silent golden", peak);
  check(dbfs(residual) <= -90, name + ": residual against the C++ render", dbfs(residual));
  if (requireBitIdentical()) check(identical, name + ": not bit-identical to the C++ render on Windows x86-64");
}

struct OfflineCase { const char* name; double seconds; std::uint32_t rate, block; };
constexpr OfflineCase kOffline[] = {
  {"offline-48k-4096", 4, 48000, 4096},
  {"offline-48k-128", 3, 48000, 128},
  {"offline-44k1-512", 3, 44100, 512},
};

#ifdef GARAK_WAVE_GOLDEN_CAPTURE
garak::ProjectTimeline parse(const std::string& json) { return garak::protocol::timeline(garak::protocol::Json::parse(json)); }
garak::AssetStore assetsOf(const Project& p) {
  garak::AssetStore store;
  for (std::size_t i = 0; i < p.assets.size(); ++i) {
    auto asset = std::make_shared<garak::PcmAsset>();
    asset->id = p.assets[i].first; asset->sampleRate = p.assetRates[i]; asset->channels = p.assetChannels[i]; asset->samples = p.assets[i].second;
    store.emplace(asset->id, std::move(asset));
  }
  return store;
}
Render renderCppOffline(const Project& project, std::uint32_t block) {
  auto timeline = parse(project.json); timeline.cycle.reset();
  const auto assets = assetsOf(project);
  garak::RenderEngine engine(timeline.sampleRate, block); engine.setOffline(true);
  auto prepared = engine.prepare(timeline, assets, garak::SampleSetStore{});
  const double tail = std::min(30.0, prepared->tailSeconds());
  Render r; r.rate = timeline.sampleRate; r.latency = prepared->latencyFrames();
  r.frames = std::uint64_t(timeline.lengthFrames) + std::uint64_t(std::ceil(tail * timeline.sampleRate));
  engine.submit(std::move(prepared)); (void)engine.play();
  std::vector<float> chunk(std::size_t(block) * 2);
  for (std::uint64_t done = 0; done < r.frames + r.latency;) {
    const auto frames = std::uint32_t(std::min<std::uint64_t>(block, r.frames + r.latency - done));
    engine.render(chunk.data(), nullptr, frames, 0);
    const auto skip = std::uint32_t(std::min<std::uint64_t>(frames, done < r.latency ? r.latency - done : 0));
    r.samples.insert(r.samples.end(), chunk.begin() + skip * 2, chunk.begin() + frames * 2);
    done += frames;
  }
  engine.collectRetired();
  return r;
}
struct CppLive final : LiveEngine {
  garak::RenderEngine e;
  garak::AssetStore assets;
  CppLive(const Project& p, std::uint32_t rate, std::uint32_t block) : e(rate, block), assets(assetsOf(p)) {}
  int apply(const std::string& json) override {
    const auto k = e.update(parse(json), assets, garak::SampleSetStore{}).kind;
    return k == garak::UpdateResult::Kind::None ? 0 : k == garak::UpdateResult::Kind::Diff ? 1 : k == garak::UpdateResult::Kind::Tracks ? 2 : 3;
  }
  void transport(std::uint32_t command, std::int64_t frame) override {
    if (command == GARAK_RS_PLAY) (void)e.play();
    else if (command == GARAK_RS_PAUSE) (void)e.pause();
    else if (command == GARAK_RS_STOP) (void)e.stop();
    else if (command == GARAK_RS_SEEK) (void)e.seek(frame);
  }
  void noteOn(std::uint32_t t, int pitch, float v, int id) override { (void)e.noteOn(t, pitch, v, id); }
  void noteOff(std::uint32_t t, int pitch, int id) override { (void)e.noteOff(t, pitch, id); }
  void preview(std::uint32_t t, int pitch, float v, std::uint32_t frames) override { (void)e.previewNote(t, pitch, v, frames); }
  void control(std::uint32_t t, int c, int value) override { (void)e.controlChange(t, c, value); }
  void allNotesOff(std::uint32_t t) override { (void)e.allNotesOff(t); }
  void render(float* out, std::uint32_t frames) override { e.render(out, nullptr, frames, 0); e.collectRetired(); }
  std::int64_t frame() override { return e.snapshot().frame; }
};
void writeGolden(const std::string& name, const Render& r) {
  std::vector<unsigned char> bytes(32 + storedFrames(r.frames) * 6);
  std::memcpy(bytes.data(), "IWGOLD01", 8);
  const auto put32 = [&](std::size_t at, std::uint32_t v) { for (int i = 0; i < 4; ++i) bytes[at + i] = static_cast<unsigned char>(v >> (8 * i)); };
  const auto put64 = [&](std::size_t at, std::uint64_t v) { put32(at, std::uint32_t(v)); put32(at + 4, std::uint32_t(v >> 32)); };
  put32(8, r.rate); put32(12, r.latency); put64(16, r.frames); put64(24, floatHash(r.samples));
  for (std::size_t k = 0; k < storedFrames(r.frames) * 2; ++k) {
    const std::size_t i = (k / 2) * kStride * 2 + k % 2;
    const auto v = std::int32_t(std::lround(std::clamp(double(r.samples[i]), -2.0, 2.0 - 1.0 / kScale) * kScale));
    for (int b = 0; b < 3; ++b) bytes[32 + k * 3 + b] = static_cast<unsigned char>((v >> (8 * b)) & 0xFF);
  }
  std::ofstream out(goldenPath(name), std::ios::binary);
  out.write(reinterpret_cast<const char*>(bytes.data()), std::streamsize(bytes.size()));
  if (!out) throw std::runtime_error("cannot write " + goldenPath(name));
}
double residual(const std::vector<float>& a, const std::vector<float>& b) {
  if (a.size() != b.size()) return 1e9;
  double m = 0;
  for (std::size_t i = 0; i < a.size(); ++i) m = std::max(m, double(std::abs(a[i] - b[i])));
  return m;
}
void capture() {
  pinCppReferenceEngine();
  for (const auto& c : kOffline) {
    const auto project = waveProject(c.seconds, c.rate);
    const auto cpp = renderCppOffline(project, c.block);
    const auto rust = renderRustOffline(project, c.rate, c.block);
    std::printf("capture %s: %llu frames, latency %u, C++ vs Rust %s\n", c.name, static_cast<unsigned long long>(cpp.frames), cpp.latency,
                residual(cpp.samples, rust.samples) == 0 ? "bit-identical" : std::to_string(dbfs(residual(cpp.samples, rust.samples))).c_str());
    check(residual(cpp.samples, rust.samples) == 0 && cpp.latency == rust.latency, std::string("capture: ") + c.name + " C++ vs Rust");
    writeGolden(c.name, cpp);
  }
  const auto project = waveProject(kLiveSeconds, kLiveRate);
  std::vector<int> cppKinds, rustKinds;
  CppLive cppEngine(project, kLiveRate, kLiveBlock);
  const auto cpp = live(cppEngine, project, &cppKinds);
  RustLive rustEngineLive(project, kLiveRate, kLiveBlock);
  const auto rust = live(rustEngineLive, project, &rustKinds);
  std::printf("capture live: C++ vs Rust %s\n", residual(cpp.samples, rust.samples) == 0 ? "bit-identical" : std::to_string(dbfs(residual(cpp.samples, rust.samples))).c_str());
  check(residual(cpp.samples, rust.samples) == 0, "capture: live C++ vs Rust");
  check(cppKinds == rustKinds, "capture: live classifications");
  writeGolden("live-48k-128", cpp);
}
#endif
} // namespace

int main(int argc, char** argv) {
  try {
#ifdef GARAK_WAVE_GOLDEN_CAPTURE
    if (argc > 1 && std::string(argv[1]) == "capture") {
      capture();
      if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
      return 0;
    }
#else
    (void)argc; (void)argv;
#endif
    std::printf("| Case | Rate | Length | Peak dBFS | Float32 | Residual vs C++ |\n|---|---|---|---|---|---|\n");
    for (const auto& c : kOffline) compare(c.name, renderRustOffline(waveProject(c.seconds, c.rate), c.rate, c.block));
    const auto project = waveProject(kLiveSeconds, kLiveRate);
    std::vector<int> kinds;
    RustLive engine(project, kLiveRate, kLiveBlock);
    compare("live-48k-128", live(engine, project, &kinds));
    std::string seen;
    for (const int k : kinds) seen += std::to_string(k) + " ";
    // As the C++ engine classified them at capture: note edits rebuild the track, the mix is a diff, the patch
    // change and the tempo edit are new graphs.
    check(kinds == std::vector<int>({2, 1, 3, 3}), "live: edit classifications " + seen);
  } catch (const std::exception& error) {
    check(false, std::string("exception: ") + error.what());
  }
  if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
  std::printf("\nIEUM WAVE golden parity: %s.\n", requireBitIdentical() ? "bit-identical to the C++ synth" : "within -90 dBFS of the C++ synth");
  return 0;
}

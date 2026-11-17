// Render-engine parity (docs/RUST_ENGINE.md, stage 4): the same project through the C++
// RenderEngine and the Rust engine (rust/garak-engine via garak-ffi, garak_engine.h).
//
// The project is rust/garak-engine/src/testkit.rs (timeline JSON + PCM, fetched through the C ABI):
// audio clips with gain, fades of every shape and crossfades, mono/stereo/44.1 kHz PCM, every
// built-in effect but the guitar rig (drive adds plug-in delay), pre/post sends into two returns,
// volume/pan/mute/send/insert automation and a tempo ramp. The C++ side parses the JSON with the
// host's own protocol.hpp; the Rust side receives the JSON text. Both render it like the host's
// WAV export (renderStopped: offline engine, length + tail, plug-in delay trimmed), at engine
// blocks of 4096 and 128 frames, with the C++ effects and with the Rust effects behind the C++
// engine, at 48 and 44.1 kHz; then a live engine applies mid-play diffs (mix, send, insert
// parameter, master, a track rebuild) on both. The same runs with a guitar rig insert (withGuitarRig):
// offline exports and a live knob diff + rack reorder. Gate: residual <= -90 dBFS, equal latency/length.
#include "garak/dsp.hpp"
#include "garak/engine.hpp"
#include "garak_engine.h"
#include "protocol.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

namespace {
int failures = 0;
void check(bool ok, const std::string& what, double detail = 0) {
  if (!ok) { ++failures; std::fprintf(stderr, "FAIL %s (%.6g)\n", what.c_str(), detail); }
}
double dbfs(double v) { return v > 0 ? 20 * std::log10(v) : -400; }

struct Project {
  std::string json;
  garak::AssetStore assets;
  std::vector<std::string> ids;
};

Project testProject(std::uint32_t tracks, double seconds, std::uint32_t rate) {
  Project p;
  auto* t = garak_rs_testkit_create(tracks, seconds, rate);
  if (!t) throw std::runtime_error("testkit project");
  std::size_t length = 0;
  const auto* json = garak_rs_testkit_json(t, &length);
  p.json.assign(reinterpret_cast<const char*>(json), length);
  for (std::uint32_t i = 0; i < garak_rs_testkit_asset_count(t); ++i) {
    const std::uint8_t* id = nullptr; std::size_t idLength = 0, count = 0; std::uint32_t sr = 0, channels = 0; const float* samples = nullptr;
    garak_rs_testkit_asset(t, i, &id, &idLength, &sr, &channels, &samples, &count);
    auto asset = std::make_shared<garak::PcmAsset>();
    asset->id.assign(reinterpret_cast<const char*>(id), idLength);
    asset->sampleRate = sr; asset->channels = channels; asset->samples.assign(samples, samples + count);
    p.ids.push_back(asset->id);
    p.assets.emplace(asset->id, std::move(asset));
  }
  garak_rs_testkit_destroy(t);
  return p;
}

garak::ProjectTimeline parse(const std::string& json) { return garak::protocol::timeline(garak::protocol::Json::parse(json)); }

struct Render { std::vector<float> samples; std::uint32_t latency = 0; std::uint64_t frames = 0; double seconds = 0; };

// native/src/host.cpp renderStopped, minus the int16 conversion.
Render renderCpp(const Project& project, std::uint32_t block) {
  auto timeline = parse(project.json); timeline.cycle.reset();
  garak::RenderEngine engine(timeline.sampleRate, block); engine.setOffline(true);
  auto prepared = engine.prepare(timeline, project.assets);
  const double tail = std::min(30.0, prepared->tailSeconds());
  Render r; r.latency = prepared->latencyFrames();
  r.frames = std::uint64_t(timeline.lengthFrames) + std::uint64_t(std::ceil(tail * timeline.sampleRate));
  engine.submit(std::move(prepared)); (void)engine.play();
  std::vector<float> chunk(std::size_t(block) * 2);
  r.samples.reserve(r.frames * 2);
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

GarakRsEngine* rustEngine(const Project& project, std::uint32_t rate, std::uint32_t block, bool offline) {
  auto* e = garak_rs_engine_create(rate, block, offline ? 1 : 0);
  for (const auto& id : project.ids) {
    const auto& a = *project.assets.at(id);
    garak_rs_engine_put_asset(e, reinterpret_cast<const std::uint8_t*>(id.data()), id.size(), a.sampleRate, a.channels, a.samples.data(), a.samples.size());
  }
  return e;
}

std::string rustError(GarakRsEngine* e) {
  std::string message(512, '\0');
  message.resize(std::min<std::size_t>(512, garak_rs_engine_last_error(e, reinterpret_cast<std::uint8_t*>(message.data()), message.size())));
  return message;
}

Render renderRust(const Project& project, std::uint32_t rate, std::uint32_t block) {
  auto* e = rustEngine(project, rate, block, true);
  Render r;
  if (garak_rs_engine_set(e, reinterpret_cast<const std::uint8_t*>(project.json.data()), project.json.size(), nullptr, 0) < 0) {
    check(false, "rust engine refused the project: " + rustError(e));
    garak_rs_engine_destroy(e);
    return r;
  }
  garak_rs_engine_transport(e, GARAK_RS_PLAY, 0);
  double tail = 0; garak_rs_engine_graph_info(e, &r.latency, &tail);
  const auto length = parse(project.json).lengthFrames;
  r.frames = std::uint64_t(length) + std::uint64_t(std::ceil(std::min(30.0, tail) * rate));
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

double residual(const std::vector<float>& a, const std::vector<float>& b) {
  if (a.size() != b.size()) return 1e9;
  double m = 0;
  for (std::size_t i = 0; i < a.size(); ++i) m = std::max(m, double(std::abs(a[i] - b[i])));
  return m;
}
double peak(const std::vector<float>& a) {
  double m = 0;
  for (const auto x : a) m = std::max(m, double(std::abs(x)));
  return m;
}

std::string edit(std::string text, const std::string& from, const std::string& to);
std::string withGuitarRig(std::string json);

void offlineCase(const char* name, std::uint32_t tracks, double seconds, std::uint32_t rate, std::uint32_t block, bool rustEffects, bool rig = false) {
  garak::dsp::setEffectBackend("all", rustEffects ? garak::dsp::EffectBackend::Rust : garak::dsp::EffectBackend::Cpp);
  auto project = testProject(tracks, seconds, rate);
  if (rig) project.json = withGuitarRig(project.json);
  const auto cpp = renderCpp(project, block);
  const auto rust = renderRust(project, rate, block);
  const double diff = residual(cpp.samples, rust.samples);
  const bool exact = diff == 0;
  std::printf("| %s | %u | %.1f s | %u Hz | %u | %s | %u / %u | %.2f | %s |\n", name, tracks, seconds, rate, block,
              rustEffects ? "Rust" : "C++", cpp.latency, rust.latency, dbfs(peak(cpp.samples)), exact ? "bit-identical" : (std::to_string(dbfs(diff)).substr(0, 7) + " dBFS").c_str());
  check(cpp.latency == rust.latency, std::string(name) + ": latency", double(rust.latency));
  check(cpp.frames == rust.frames, std::string(name) + ": length", double(rust.frames));
  check(peak(cpp.samples) > .05, std::string(name) + ": silent render", peak(cpp.samples));
  check(dbfs(diff) <= -90, std::string(name) + ": residual", dbfs(diff));
}

// Replace the first occurrence of `from` (must exist) in a JSON text.
std::string edit(std::string text, const std::string& from, const std::string& to) {
  const auto at = text.find(from);
  if (at == std::string::npos) throw std::runtime_error("edit target missing: " + from);
  return text.replace(at, from.size(), to);
}

// The guitar rig as an engine insert: track 1's chorus becomes a rig (compressor, drive, crunch amp,
// cabinet, a second drive, chorus, delay, plate reverb, phaser) and its filter lane automates the amp gain.
const char* const kRig = R"({"id":"rig","type":"guitar-rig","params":{"driveEnabled":1,"ampModel":1,"ampGain":18,"cabinet":2,"micType":1,)"
                         R"("chorusEnabled":1,"delayEnabled":1,"delayTime":180,"reverbEnabled":1,"reverbDecay":0.6,"phaserEnabled":1,"driveEnabled_2":1,)"
                         R"("rackSlot0":1,"rackSlot1":2,"rackSlot2":3,"rackSlot3":4,"rackSlot4":18,"rackSlot5":5,"rackSlot6":6,"rackSlot7":10,"rackSlot8":8}})";
std::string withGuitarRig(std::string json) {
  json = edit(json, R"({"id":"chorus","type":"chorus","params":{"rate":1.3,"depth":0.6,"mix":0.4}})", kRig);
  return edit(json, R"("insertId":"filter","param":"cutoff"},"minimum":20,"maximum":20000,"logarithmic":true)",
              R"("insertId":"rig","param":"ampGain"},"minimum":0,"maximum":36)");
}

// A live engine with the rig: a live knob (Diff, set in place) then a rack reorder (structural: that
// track is rebuilt and the new rig adopts the old one's state by module).
void liveRigCase(bool rustEffects) {
  garak::dsp::setEffectBackend("all", rustEffects ? garak::dsp::EffectBackend::Rust : garak::dsp::EffectBackend::Cpp);
  constexpr std::uint32_t rate = 48000, block = 128, call = 256;
  auto project = testProject(4, 3, rate);
  project.json = withGuitarRig(project.json);
  auto diff = edit(project.json, R"("revision":1)", R"("revision":2)");
  diff = edit(diff, R"("ampGain":18)", R"("ampGain":30)");
  auto rebuild = edit(diff, R"("revision":2)", R"("revision":3)");
  rebuild = edit(rebuild, R"("rackSlot5":5,"rackSlot6":6)", R"("rackSlot5":6,"rackSlot6":5)");
  garak::RenderEngine cpp(rate, block);
  auto* rust = rustEngine(project, rate, block, false);
  check(cpp.update(parse(project.json), project.assets).kind == garak::UpdateResult::Kind::Full, "live rig: c++ initial graph");
  check(garak_rs_engine_set(rust, reinterpret_cast<const std::uint8_t*>(project.json.data()), project.json.size(), nullptr, 0) == GARAK_RS_APPLIED_FULL, "live rig: rust initial graph " + rustError(rust));
  (void)cpp.play(); garak_rs_engine_transport(rust, GARAK_RS_PLAY, 0);
  const std::uint32_t total = rate * 3;
  std::vector<float> a(std::size_t(total) * 2), b(std::size_t(total) * 2);
  int stage = 0;
  for (std::uint32_t done = 0; done < total; done += call) {
    if (stage == 0 && done >= rate / 2) {
      const auto kind = cpp.update(parse(diff), project.assets).kind;
      const auto applied = garak_rs_engine_set(rust, reinterpret_cast<const std::uint8_t*>(diff.data()), diff.size(), nullptr, 0);
      check(kind == garak::UpdateResult::Kind::Diff && applied == GARAK_RS_APPLIED_DIFF, "live rig: knob is a diff", applied);
      ++stage;
    } else if (stage == 1 && done >= rate * 3 / 2) {
      const auto kind = cpp.update(parse(rebuild), project.assets).kind;
      const auto applied = garak_rs_engine_set(rust, reinterpret_cast<const std::uint8_t*>(rebuild.data()), rebuild.size(), nullptr, 0);
      check(kind == garak::UpdateResult::Kind::Tracks && applied == GARAK_RS_APPLIED_TRACKS, "live rig: reorder rebuilds the track", applied);
      ++stage;
    }
    const auto frames = std::min(call, total - done);
    cpp.render(a.data() + std::size_t(done) * 2, nullptr, frames, 0);
    garak_rs_engine_render(rust, b.data() + std::size_t(done) * 2, frames);
    cpp.collectRetired(); garak_rs_engine_collect(rust);
  }
  garak_rs_engine_destroy(rust);
  const double d = residual(a, b);
  std::printf("| live guitar rig (knob diff, rack reorder) | 4 | 3.0 s | %u Hz | %u | %s | — | %.2f | %s |\n", rate, block,
              rustEffects ? "Rust" : "C++", dbfs(peak(a)), d == 0 ? "bit-identical" : (std::to_string(dbfs(d)).substr(0, 7) + " dBFS").c_str());
  check(peak(a) > .05, "live rig: silent", peak(a));
  check(dbfs(d) <= -90, std::string("live rig: residual (") + (rustEffects ? "Rust" : "C++") + " effects)", dbfs(d));
}

// Live engines (transport, no offline tail): the project is set and played, then mid-play edits
// go through RenderEngine::update and garak_rs_engine_set (both classify them as diffs/rebuilds).
void liveCase(bool rustEffects) {
  garak::dsp::setEffectBackend("all", rustEffects ? garak::dsp::EffectBackend::Rust : garak::dsp::EffectBackend::Cpp);
  constexpr std::uint32_t rate = 48000, block = 128, call = 256;
  const auto project = testProject(8, 3, rate);
  // Mix + send + live insert parameter + master gain, then a track rebuild (a window removed).
  auto diff = edit(project.json, R"("revision":1)", R"("revision":2)");
  diff = edit(diff, R"("masterGain":0.8)", R"("masterGain":0.55)");
  diff = edit(diff, R"("id":"track-0","source":{"kind":"audio"},"gain":0.5)", R"("id":"track-0","source":{"kind":"audio"},"gain":0.2)");
  diff = edit(diff, R"({"returnId":"ret-verb","gain":0.25})", R"({"returnId":"ret-verb","gain":0.9})");
  diff = edit(diff, R"("ratio":5)", R"("ratio":9)");
  auto rebuild = edit(diff, R"("revision":2)", R"("revision":3)");
  rebuild = edit(rebuild, R"("gain":1.3)", R"("gain":0.4)");  // track 0's third window
  garak::RenderEngine cpp(rate, block);
  auto* rust = rustEngine(project, rate, block, false);
  check(cpp.update(parse(project.json), project.assets).kind == garak::UpdateResult::Kind::Full, "live: c++ initial graph");
  check(garak_rs_engine_set(rust, reinterpret_cast<const std::uint8_t*>(project.json.data()), project.json.size(), nullptr, 0) == GARAK_RS_APPLIED_FULL, "live: rust initial graph " + rustError(rust));
  (void)cpp.play(); garak_rs_engine_transport(rust, GARAK_RS_PLAY, 0);
  const std::uint32_t total = rate * 3;
  std::vector<float> a(std::size_t(total) * 2), b(std::size_t(total) * 2);
  int stage = 0;
  for (std::uint32_t done = 0; done < total; done += call) {
    if (stage == 0 && done >= rate / 2) {
      const auto kind = cpp.update(parse(diff), project.assets).kind;
      const auto applied = garak_rs_engine_set(rust, reinterpret_cast<const std::uint8_t*>(diff.data()), diff.size(), nullptr, 0);
      check(kind == garak::UpdateResult::Kind::Diff && applied == GARAK_RS_APPLIED_DIFF, "live: diff classification", applied);
      ++stage;
    } else if (stage == 1 && done >= rate * 3 / 2) {
      // The rebuilt track's window gain changes: both engines replace that one track.
      auto next = parse(rebuild);
      const auto kind = cpp.update(next, project.assets).kind;
      const auto applied = garak_rs_engine_set(rust, reinterpret_cast<const std::uint8_t*>(rebuild.data()), rebuild.size(), nullptr, 0);
      check(kind == garak::UpdateResult::Kind::Tracks && applied == GARAK_RS_APPLIED_TRACKS, "live: track rebuild classification", applied);
      ++stage;
    }
    const auto frames = std::min(call, total - done);
    cpp.render(a.data() + std::size_t(done) * 2, nullptr, frames, 0);
    garak_rs_engine_render(rust, b.data() + std::size_t(done) * 2, frames);
    cpp.collectRetired(); garak_rs_engine_collect(rust);
  }
  garak_rs_engine_destroy(rust);
  const double d = residual(a, b);
  std::printf("| live diffs (mix, send, param, master, rebuild) | 8 | 3.0 s | %u Hz | %u | %s | — | %.2f | %s |\n", rate, block,
              rustEffects ? "Rust" : "C++", dbfs(peak(a)), d == 0 ? "bit-identical" : (std::to_string(dbfs(d)).substr(0, 7) + " dBFS").c_str());
  check(peak(a) > .05, "live: silent", peak(a));
  check(dbfs(d) <= -90, std::string("live diffs: residual (") + (rustEffects ? "Rust" : "C++") + " effects)", dbfs(d));
}
} // namespace

int main() {
  std::printf("| Case | Tracks | Length | Rate | Block | Effects in C++ engine | Latency C++ / Rust | Peak dBFS | Residual |\n");
  std::printf("|---|---|---|---|---|---|---|---|---|\n");
  try {
    for (const bool rustEffects : {false, true}) {
      offlineCase("offline export", 8, 4, 48000, 4096, rustEffects);
      offlineCase("offline export", 8, 4, 48000, 128, rustEffects);
      offlineCase("offline export", 6, 3, 44100, 4096, rustEffects);
      offlineCase("offline export", 1, 1, 48000, 512, rustEffects);
      liveCase(rustEffects);
      offlineCase("offline export + guitar rig", 8, 4, 48000, 4096, rustEffects, true);
      offlineCase("offline export + guitar rig", 6, 3, 44100, 128, rustEffects, true);
      liveRigCase(rustEffects);
    }
  } catch (const std::exception& error) {
    check(false, std::string("exception: ") + error.what());
  }
  garak::dsp::setEffectBackend("all", garak::dsp::EffectBackend::Cpp);
  if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
  std::printf("\nRender-engine parity: all cases within -90 dBFS.\n");
  return 0;
}

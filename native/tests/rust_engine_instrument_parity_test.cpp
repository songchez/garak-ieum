// Render-engine instrument parity (docs/RUST_ENGINE.md 6-7, gate G2): the built-in instruments
// through the C++ RenderEngine and the Rust engine (rust/garak-engine via garak-ffi).
//
// Projects: rust/garak-engine/src/testkit/instruments.rs (timeline JSON + synthesized PCM +
// samples.register JSON), fetched through the C ABI and fed to both engines: the five synths and
// the drum kit, sample instruments (layered grand with release zones and a codec offset, a looped
// 44.1 kHz bowed string, a choke-group kit), 옥구슬 EP / 한밤 106, and all of them at once. Notes
// cover chords, overlapping repeats, cut-offs at clip/project ends and a note that starts before the
// project; controllers cover bend + range, mod wheel, pressure, CC7/CC11 and the sustain pedal;
// every track automates an instrument parameter. Offline exports (host renderStopped) at several
// blocks and rates, then a live engine with a cycle: knob edits, note moves / deletions / additions
// across the playhead, a seek into held notes and the pedal, cycle wraps (note and pedal chasing),
// live MIDI, stop/replay. Gate: residual <= -90 dBFS, equal latency / length / diff classification.
//
// `garak-rust-engine-instrument-parity-test bench [seconds] [repeats] [block]` prints the CPU
// comparison for the instrument-heavy project instead.
#include "garak/dsp.hpp"
#include "garak/engine.hpp"
#include "garak_engine_instruments.h"
#include "protocol.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
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
const char* caseName(std::uint32_t c) { return c == 0 ? "synths + drums" : c == 1 ? "samples (grand, bowed, kit)" : c == 2 ? "vintage (EP, 106)" : "all instruments"; }

struct Project {
  std::string json;
  garak::AssetStore assets;
  std::vector<std::string> ids;
  std::vector<std::string> sets;
  garak::SampleSetStore store;
};

Project instrumentProject(std::uint32_t which, double seconds, std::uint32_t rate) {
  Project p;
  auto* t = garak_rs_testkit_instruments_create(which, seconds, rate);
  if (!t) throw std::runtime_error("instrument testkit project");
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
  for (std::uint32_t i = 0; i < garak_rs_testkit_sample_set_count(t); ++i) {
    std::size_t n = 0; const auto* s = garak_rs_testkit_sample_set(t, i, &n);
    p.sets.emplace_back(reinterpret_cast<const char*>(s), n);
    auto set = garak::protocol::sampleSet(garak::protocol::Json::parse(p.sets.back()));
    p.store[set.id] = std::move(set);
  }
  garak_rs_testkit_destroy(t);
  return p;
}

garak::ProjectTimeline parse(const std::string& json) { return garak::protocol::timeline(garak::protocol::Json::parse(json)); }

struct Render { std::vector<float> samples; std::uint32_t latency = 0; std::uint64_t frames = 0; };

// native/src/host.cpp renderStopped, minus the int16 conversion.
Render renderCpp(const Project& project, std::uint32_t block) {
  auto timeline = parse(project.json); timeline.cycle.reset();
  garak::RenderEngine engine(timeline.sampleRate, block); engine.setOffline(true);
  auto prepared = engine.prepare(timeline, project.assets, project.store);
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

std::string rustError(GarakRsEngine* e) {
  std::string message(512, '\0');
  message.resize(std::min<std::size_t>(512, garak_rs_engine_last_error(e, reinterpret_cast<std::uint8_t*>(message.data()), message.size())));
  return message;
}

GarakRsEngine* rustEngine(const Project& project, std::uint32_t rate, std::uint32_t block, bool offline) {
  auto* e = garak_rs_engine_create(rate, block, offline ? 1 : 0);
  for (const auto& id : project.ids) {
    const auto& a = *project.assets.at(id);
    garak_rs_engine_put_asset(e, reinterpret_cast<const std::uint8_t*>(id.data()), id.size(), a.sampleRate, a.channels, a.samples.data(), a.samples.size());
  }
  for (const auto& s : project.sets)
    if (garak_rs_engine_register_samples(e, reinterpret_cast<const std::uint8_t*>(s.data()), s.size()) != 0) check(false, "rust sample set: " + rustError(e));
  return e;
}

int setRust(GarakRsEngine* e, const std::string& json) { return garak_rs_engine_set(e, reinterpret_cast<const std::uint8_t*>(json.data()), json.size(), nullptr, 0); }

Render renderRust(const Project& project, std::uint32_t rate, std::uint32_t block) {
  auto* e = rustEngine(project, rate, block, true);
  Render r;
  if (setRust(e, project.json) < 0) {
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
std::string verdict(double d) { return d == 0 ? "bit-identical" : std::to_string(dbfs(d)).substr(0, 7) + " dBFS"; }

void offlineCase(std::uint32_t which, double seconds, std::uint32_t rate, std::uint32_t block, bool rustEffects) {
  garak::dsp::setEffectBackend("all", rustEffects ? garak::dsp::EffectBackend::Rust : garak::dsp::EffectBackend::Cpp);
  const auto project = instrumentProject(which, seconds, rate);
  const auto cpp = renderCpp(project, block);
  const auto rust = renderRust(project, rate, block);
  const double diff = residual(cpp.samples, rust.samples);
  std::printf("| offline: %s | %.1f s | %u Hz | %u | %s | %u / %u | %.2f | %s |\n", caseName(which), seconds, rate, block,
              rustEffects ? "Rust" : "C++", cpp.latency, rust.latency, dbfs(peak(cpp.samples)), verdict(diff).c_str());
  const std::string name = std::string("offline ") + caseName(which) + " @" + std::to_string(rate) + "/" + std::to_string(block);
  check(cpp.latency == rust.latency, name + ": latency", double(rust.latency));
  check(cpp.frames == rust.frames, name + ": length", double(rust.frames));
  check(peak(cpp.samples) > .05, name + ": silent render", peak(cpp.samples));
  check(dbfs(diff) <= -90, name + ": residual", dbfs(diff));
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
// The note record of `track` with this id, as written by the testkit ({"id":N,"onFrame":...}).
std::pair<std::size_t, std::size_t> noteSpan(const std::string& json, const std::string& track, std::int32_t id) {
  const auto start = json.find("{\"id\":" + std::to_string(id) + ",\"onFrame\"", trackStart(json, track));
  if (start == std::string::npos) throw std::runtime_error("note missing");
  return {start, json.find('}', start) + 1};
}
// A note of `track` sounding at `frame` (onset before, release after), or -1.
std::int32_t soundingNote(const std::string& json, const std::string& track, std::int64_t frame) {
  for (const auto& t : parse(json).tracks) if (t.id == track)
    for (const auto& n : t.notes) if (n.onFrame < frame - 500 && n.offFrame > frame + 2000) return n.id;
  return -1;
}
std::string removeNote(const std::string& json, const std::string& track, std::int32_t id) {
  auto [a, b] = noteSpan(json, track, id);
  std::string out = json;
  if (out[b] == ',') ++b; else if (out[a - 1] == ',') --a;
  return out.erase(a, b - a);
}
std::string addNote(const std::string& json, const std::string& track, std::int64_t on, std::int64_t off, int pitch, double velocity, std::int32_t id) {
  const auto at = json.find("\"notes\":[", trackStart(json, track)) + 9;
  std::string note = "{\"id\":" + std::to_string(id) + ",\"onFrame\":" + std::to_string(on) + ",\"offFrame\":" + std::to_string(off) +
                     ",\"limitFrame\":" + std::to_string(off) + ",\"pitch\":" + std::to_string(pitch) + ",\"velocity\":" + std::to_string(velocity) + "},";
  std::string out = json;
  return out.insert(at, note);
}
std::string moveNote(const std::string& json, const std::string& track, std::int32_t id, std::int64_t shift) {
  auto [a, b] = noteSpan(json, track, id);
  const auto note = garak::protocol::Json::parse(json.substr(a, b - a));
  const std::int64_t on = note["onFrame"], off = note["offFrame"], limit = note["limitFrame"];
  std::string replaced = json.substr(a, b - a);
  replaced = edit(replaced, "\"onFrame\":" + std::to_string(on) + ",", "\"onFrame\":" + std::to_string(on + shift) + ",");
  replaced = edit(replaced, "\"offFrame\":" + std::to_string(off) + ",", "\"offFrame\":" + std::to_string(off + shift) + ",");
  replaced = edit(replaced, "\"limitFrame\":" + std::to_string(limit) + ",", "\"limitFrame\":" + std::to_string(limit + shift) + ",");
  std::string out = json;
  return out.replace(a, b - a, replaced);
}
std::string withRevision(const std::string& json, int from, int to) { return edit(json, "\"revision\":" + std::to_string(from), "\"revision\":" + std::to_string(to)); }

const char* kindName(garak::UpdateResult::Kind k) { return k == garak::UpdateResult::Kind::None ? "none" : k == garak::UpdateResult::Kind::Diff ? "diff" : k == garak::UpdateResult::Kind::Tracks ? "tracks" : "full"; }

// Live engines with a cycle: mid-play edits through RenderEngine::update and garak_rs_engine_set,
// transport commands and live MIDI at the same frames.
void liveCase(bool rustEffects) {
  garak::dsp::setEffectBackend("all", rustEffects ? garak::dsp::EffectBackend::Rust : garak::dsp::EffectBackend::Cpp);
  constexpr std::uint32_t rate = 48000, block = 128, call = 256;
  auto project = instrumentProject(3, 6, rate);
  // Cycle 1.0 s .. 4.0 s: wraps chase notes, controllers and the pedal.
  project.json = edit(project.json, "\"lengthFrames\":288000,", "\"lengthFrames\":288000,\"cycle\":{\"startFrame\":48000,\"endFrame\":192000},");
  garak::RenderEngine cpp(rate, block);
  auto* rust = rustEngine(project, rate, block, false);
  check(cpp.update(parse(project.json), project.assets, project.store).kind == garak::UpdateResult::Kind::Full, "live: c++ initial graph");
  check(setRust(rust, project.json) == GARAK_RS_APPLIED_FULL, "live: rust initial graph " + rustError(rust));
  (void)cpp.play(); garak_rs_engine_transport(rust, GARAK_RS_PLAY, 0);
  const std::uint32_t total = rate * 9;
  std::vector<float> a(std::size_t(total) * 2), b(std::size_t(total) * 2);
  std::string current = project.json;
  int revision = 1, stage = 0, deleted = 0;
  std::string summary;
  std::int64_t position = 0; // Project frame of the next render (follows the cycle).
  const auto apply = [&](const std::string& next, const char* what) {
    const auto kind = cpp.update(parse(next), project.assets, project.store).kind;
    const auto applied = setRust(rust, next);
    const int expected = kind == garak::UpdateResult::Kind::None ? 0 : kind == garak::UpdateResult::Kind::Diff ? 1 : kind == garak::UpdateResult::Kind::Tracks ? 2 : 3;
    check(applied == expected, std::string("live: classification of ") + what + " (c++ " + kindName(kind) + ")", applied);
    if (applied < 0) check(false, "live: rust refused " + std::string(what) + ": " + rustError(rust));
    if (!summary.empty()) summary += ", ";
    summary += std::string(what) + " = " + kindName(kind);
    current = next;
  };
  for (std::uint32_t done = 0; done < total; done += call) {
    const double seconds = double(done) / rate;
    if (stage == 0 && seconds >= .7) {
      // Knob edits on a synth and a sampled instrument (same source: voices carry over).
      auto next = withRevision(current, revision, revision + 1); ++revision;
      next = edit(next, "\"bell\":0.35", "\"bell\":0.5");
      next = edit(next, "\"releaseNoise\":0.7,\"release\":0.6", "\"releaseNoise\":0.4,\"release\":0.9");
      next = edit(next, "\"tremDepth\":0.3", "\"tremDepth\":0.6");
      next = edit(next, "\"resonance\":0.35", "\"resonance\":0.5");
      apply(next, "instrument knobs"); ++stage;
    } else if (stage == 1 && seconds >= 1.3) {
      // Delete notes that sound right now (they release); move a later note; add a note across
      // the playhead (heard from the next cycle pass) and one ahead of it.
      auto next = withRevision(current, revision, revision + 1); ++revision;
      for (const char* track : {"grand", "synth-pad", "okgu-ep", "hanbam-106", "synth-rhodes"}) {
        const auto id = soundingNote(next, track, position);
        if (id >= 0) { next = removeNote(next, track, id); ++deleted; }
      }
      next = moveNote(next, "synth-keys", 30, 2400);
      next = addNote(next, "synth-keys", position - 9000, position + 30000, 67, .8, 9000);
      next = addNote(next, "haegeum", position + 12000, position + 60000, 70, .6, 9001);
      next = addNote(next, "okgu-ep", position - 4000, position + 50000, 64, .9, 9002);
      apply(next, "note edits"); ++stage;
    } else if (stage == 2 && seconds >= 2.1) {
      // Mixer + send level: in-place diffs.
      auto next = withRevision(current, revision, revision + 1); ++revision;
      next = edit(next, "\"masterGain\":0.7", "\"masterGain\":0.5");
      next = edit(next, "\"sends\":[{\"returnId\":\"ret\",\"gain\":0.3}]", "\"sends\":[{\"returnId\":\"ret\",\"gain\":0.6}]");
      apply(next, "mix"); ++stage;
    } else if (stage == 3 && seconds >= 2.6) {
      // Seek into held notes and pedal presses (chase), then live MIDI on the EP and the keys.
      (void)cpp.seek(96000); garak_rs_engine_transport(rust, GARAK_RS_SEEK, 96000); position = 96000;
      (void)cpp.noteOn(0, 72, .7f, 77); garak_rs_engine_note_on(rust, 0, 72, .7f, 77);
      (void)cpp.noteOn(9, 60, .8f, 5); garak_rs_engine_note_on(rust, 9, 60, .8f, 5); // 옥구슬 EP
      (void)cpp.controlChange(9, 64, 127); garak_rs_engine_control_change(rust, 9, 64, 127);
      ++stage;
    } else if (stage == 4 && seconds >= 3.0) {
      (void)cpp.controlChange(0, 64, 127); garak_rs_engine_control_change(rust, 0, 64, 127);
      (void)cpp.controlChange(0, 129, 3000); garak_rs_engine_control_change(rust, 0, 129, 3000);
      (void)cpp.noteOff(0, 72, 77); garak_rs_engine_note_off(rust, 0, 72, 77);
      (void)cpp.noteOff(9, 60, 5); garak_rs_engine_note_off(rust, 9, 60, 5);
      (void)cpp.noteOn(10, 48, .6f, 6); garak_rs_engine_note_on(rust, 10, 48, .6f, 6); // 한밤 106
      ++stage;
    } else if (stage == 5 && seconds >= 3.4) {
      (void)cpp.controlChange(0, 64, 0); garak_rs_engine_control_change(rust, 0, 64, 0);
      (void)cpp.controlChange(9, 64, 0); garak_rs_engine_control_change(rust, 9, 64, 0);
      (void)cpp.controlChange(10, 1, 100); garak_rs_engine_control_change(rust, 10, 1, 100);
      (void)cpp.noteOff(10, 48, 6); garak_rs_engine_note_off(rust, 10, 48, 6);
      (void)cpp.previewNote(1, 40, .9f, 6000); garak_rs_engine_preview_note(rust, 1, 40, .9f, 6000);
      // A track change: new instrument on the bass track (different source: fresh voices).
      auto next = withRevision(current, revision, revision + 1); ++revision;
      next = edit(next, "\"instrumentId\":\"bass\",\"isKit\":false,\"params\":{\"level\":0.7,\"sub\":0.5,\"tone\":-0.3}", "\"instrumentId\":\"pluck\",\"isKit\":false,\"params\":{\"level\":0.5}");
      next = edit(next, "{\"target\":{\"kind\":\"instrument\",\"param\":\"sub\"}", "{\"target\":{\"kind\":\"instrument\",\"param\":\"sweep\"}");
      apply(next, "instrument change"); ++stage;
    } else if (stage == 6 && seconds >= 5.2) {
      // A tempo change: a new graph whose tracks continue (cursors re-found at the playhead).
      auto next = withRevision(current, revision, revision + 1); ++revision;
      next = edit(next, "\"bpm\":100", "\"bpm\":112");
      apply(next, "tempo"); ++stage;
    } else if (stage == 7 && seconds >= 5.9) {
      (void)cpp.pause(); garak_rs_engine_transport(rust, GARAK_RS_PAUSE, 0);
      ++stage;
    } else if (stage == 8 && seconds >= 6.1) {
      (void)cpp.play(); garak_rs_engine_transport(rust, GARAK_RS_PLAY, 0);
      ++stage;
    } else if (stage == 9 && seconds >= 6.5) {
      (void)cpp.allNotesOff(0); garak_rs_engine_all_notes_off(rust, 0);
      (void)cpp.allNotesOff(10); garak_rs_engine_all_notes_off(rust, 10);
      (void)cpp.stop(); garak_rs_engine_transport(rust, GARAK_RS_STOP, 0); position = 0;
      ++stage;
    } else if (stage == 10 && seconds >= 7.0) {
      (void)cpp.play(); garak_rs_engine_transport(rust, GARAK_RS_PLAY, 0);
      ++stage;
    } else if (stage == 11 && seconds >= 7.6) {
      // Removing a track rebuilds the graph; every other track keeps sounding.
      auto next = withRevision(current, revision, revision + 1); ++revision;
      const auto start = trackStart(next, "kit");
      const auto end = next.find("{\"id\":\"okgu-ep\"", start);
      next.erase(start, end - start);
      apply(next, "track removed"); ++stage;
    }
    const auto frames = std::min(call, total - done);
    cpp.render(a.data() + std::size_t(done) * 2, nullptr, frames, 0);
    garak_rs_engine_render(rust, b.data() + std::size_t(done) * 2, frames);
    cpp.collectRetired(); garak_rs_engine_collect(rust);
    const auto snap = cpp.snapshot(); position = snap.frame;
    std::uint64_t applied = 0; std::int64_t frame = 0; garak_rs_engine_snapshot(rust, &applied, &frame);
    check(frame == snap.frame, "live: transport position", double(frame - snap.frame));
  }
  garak_rs_engine_destroy(rust);
  const double d = residual(a, b);
  std::printf("| live: all instruments, cycle, edits, seek, live MIDI | 9.0 s | %u Hz | %u | %s | — | %.2f | %s |\n", rate, block,
              rustEffects ? "Rust" : "C++", dbfs(peak(a)), verdict(d).c_str());
  if (!rustEffects) std::printf("\nLive edits (%d sounding notes deleted): %s\n\n", deleted, summary.c_str());
  check(deleted >= 3, "live: too few sounding notes deleted", deleted);
  check(peak(a) > .05, "live: silent", peak(a));
  check(dbfs(d) <= -90, std::string("live instruments: residual (") + (rustEffects ? "Rust" : "C++") + " effects)", dbfs(d));
}

// CPU: the instrument-heavy project (every instrument, dense chords) through both engines.
int bench(double seconds, int repeats, std::uint32_t block) {
  const std::uint32_t rate = 48000;
  const auto project = instrumentProject(3, seconds, rate);
  const auto frames = std::uint32_t(seconds * rate);
  std::vector<float> out(std::size_t(block) * 2);
  const auto time = [&](auto&& run) { double best = 1e30; for (int r = 0; r < repeats; ++r) { const auto t0 = std::chrono::steady_clock::now(); run(); best = std::min(best, std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count()); } return best; };
  double cppTime[2] = {0, 0};
  for (int backend = 0; backend < 2; ++backend) {
    garak::dsp::setEffectBackend("all", backend ? garak::dsp::EffectBackend::Rust : garak::dsp::EffectBackend::Cpp);
    cppTime[backend] = time([&] {
      garak::RenderEngine e(rate, block);
      e.submit(e.prepare(parse(project.json), project.assets, project.store)); (void)e.play();
      for (std::uint32_t done = 0; done < frames; done += block) e.render(out.data(), nullptr, std::min(block, frames - done), 0);
    });
  }
  const double rustTime = time([&] {
    auto* e = rustEngine(project, rate, block, false);
    setRust(e, project.json); garak_rs_engine_transport(e, GARAK_RS_PLAY, 0);
    for (std::uint32_t done = 0; done < frames; done += block) garak_rs_engine_render(e, out.data(), std::min(block, frames - done));
    garak_rs_engine_destroy(e);
  });
  const auto tracks = parse(project.json).tracks.size();
  const double blocks = double(frames) / block;
  std::printf("| Tracks | C++ engine + C++ effects | C++ engine + Rust effects | Rust engine | µs per block (C++ / Rust) |\n|---|---|---|---|---|\n");
  std::printf("| %zu instrument tracks + return | %.1fx realtime | %.1fx | **%.1fx** (%.2fx faster) | %.0f / %.0f |\n", tracks - 1,
              seconds / cppTime[0], seconds / cppTime[1], seconds / rustTime, cppTime[0] / rustTime, cppTime[0] / blocks * 1e6, rustTime / blocks * 1e6);
  garak::dsp::setEffectBackend("all", garak::dsp::EffectBackend::Cpp);
  return 0;
}
} // namespace

int main(int argc, char** argv) {
  if (argc > 1 && std::string(argv[1]) == "bench")
    return bench(argc > 2 ? std::atof(argv[2]) : 10, argc > 3 ? std::atoi(argv[3]) : 3, argc > 4 ? std::uint32_t(std::atoi(argv[4])) : 128);
  std::printf("| Case | Length | Rate | Block | Effects in C++ engine | Latency C++ / Rust | Peak dBFS | Residual |\n");
  std::printf("|---|---|---|---|---|---|---|---|\n");
  try {
    for (const bool rustEffects : {true, false}) {
      offlineCase(0, 4, 48000, 4096, rustEffects);
      offlineCase(0, 3, 48000, 128, rustEffects);
      offlineCase(1, 4, 48000, 4096, rustEffects);
      offlineCase(1, 3, 44100, 512, rustEffects);
      offlineCase(2, 4, 48000, 4096, rustEffects);
      offlineCase(2, 3, 48000, 128, rustEffects);
      offlineCase(3, 3, 48000, 1024, rustEffects);
      liveCase(rustEffects);
    }
  } catch (const std::exception& error) {
    check(false, std::string("exception: ") + error.what());
  }
  garak::dsp::setEffectBackend("all", garak::dsp::EffectBackend::Cpp);
  if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
  std::printf("\nInstrument render-engine parity: all cases within -90 dBFS.\n");
  return 0;
}

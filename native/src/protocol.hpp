#pragma once
#include "garak/engine.hpp"
#include <nlohmann/json.hpp>
#include <charconv>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <string_view>

namespace garak::protocol {
using Json = nlohmann::json;
inline std::string string(const Json& value, const char* key, std::size_t maximum = 512, bool empty = false) {
  if (!value.contains(key) || !value.at(key).is_string()) throw std::runtime_error(std::string("Missing string: ") + key);
  auto result = value.at(key).get<std::string>();
  if ((!empty && result.empty()) || result.size() > maximum || result.find('\0') != std::string::npos) throw std::runtime_error(std::string("Invalid string: ") + key);
  return result;
}
inline double number(const Json& value, const char* key, double minimum, double maximum, double fallback) {
  if (!value.contains(key)) return fallback;
  if (!value.at(key).is_number()) throw std::runtime_error(std::string("Invalid number: ") + key);
  const auto result = value.at(key).get<double>();
  if (!std::isfinite(result) || result < minimum || result > maximum) throw std::runtime_error(std::string("Number out of range: ") + key);
  return result;
}
inline std::int64_t integer(const Json& value, const char* key, std::int64_t minimum, std::int64_t maximum, std::int64_t fallback) {
  const auto result = number(value, key, static_cast<double>(minimum), static_cast<double>(maximum), static_cast<double>(fallback));
  if (std::floor(result) != result) throw std::runtime_error(std::string("Expected integer: ") + key);
  return static_cast<std::int64_t>(result);
}
inline Parameters parameters(const Json& value) {
  if (!value.is_object() || value.size() > 1024) throw std::runtime_error("Invalid parameter map");
  Parameters result;
  for (auto it = value.begin(); it != value.end(); ++it) {
    if (it.key().size() > 128 || !it.value().is_number()) throw std::runtime_error("Invalid parameter");
    auto v = it.value().get<double>(); if (!std::isfinite(v)) throw std::runtime_error("Non-finite parameter");
    result.emplace(it.key(), v);
  }
  return result;
}
inline std::vector<std::uint8_t> unbase64(const std::string& input) {
  constexpr std::string_view digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (input.size() > (16u * 1024 * 1024 + 2) / 3 * 4 || input.size() % 4 != 0) throw std::runtime_error("Invalid plugin state length");
  std::vector<std::uint8_t> output; output.reserve(input.size() / 4 * 3);
  for (std::size_t i = 0; i < input.size(); i += 4) {
    std::uint32_t n = 0; int padding = 0;
    for (int j = 0; j < 4; ++j) {
      const auto c = input[i + j];
      if (c == '=') { if (j < 2 || i + 4 != input.size()) throw std::runtime_error("Invalid plugin state padding"); ++padding; n <<= 6; }
      else { const auto digit = digits.find(c); if (padding || digit == digits.npos) throw std::runtime_error("Invalid plugin state encoding"); n = (n << 6) | static_cast<std::uint32_t>(digit); }
    }
    if (padding > 2) throw std::runtime_error("Invalid plugin state padding");
    output.push_back(static_cast<std::uint8_t>(n >> 16));
    if (padding < 2) output.push_back(static_cast<std::uint8_t>(n >> 8));
    if (padding < 1) output.push_back(static_cast<std::uint8_t>(n));
  }
  return output;
}
inline std::string base64(const std::vector<std::uint8_t>& bytes) {
  constexpr char digits[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out; out.reserve((bytes.size() + 2) / 3 * 4);
  for (std::size_t i = 0; i < bytes.size(); i += 3) {
    const std::uint32_t n = (std::uint32_t(bytes[i]) << 16) | (i + 1 < bytes.size() ? std::uint32_t(bytes[i + 1]) << 8 : 0) | (i + 2 < bytes.size() ? bytes[i + 2] : 0);
    out.push_back(digits[(n >> 18) & 63]); out.push_back(digits[(n >> 12) & 63]);
    out.push_back(i + 1 < bytes.size() ? digits[(n >> 6) & 63] : '=');
    out.push_back(i + 2 < bytes.size() ? digits[n & 63] : '=');
  }
  return out;
}
inline PluginSpec plugin(const Json& value, bool instrument, bool enabled = true) {
  PluginSpec result;
  result.instanceId = string(value, "id"); result.path = string(value, "path", 32768, !enabled);
  result.classId = string(value, "classId", 64); result.isInstrument = instrument;
  if (value.contains("state")) {
    const auto& state = value.at("state");
    if (state.contains("component")) result.state = unbase64(string(state, "component", 24 * 1024 * 1024, true));
    if (state.contains("controller")) result.controllerState = unbase64(string(state, "controller", 24 * 1024 * 1024, true));
  }
  if (value.contains("parameters")) for (const auto& [key, val] : parameters(value.at("parameters"))) {
    std::uint32_t id = 0; const auto parsed = std::from_chars(key.data(), key.data() + key.size(), id);
    if (parsed.ec != std::errc{} || parsed.ptr != key.data() + key.size() || val < 0 || val > 1) throw std::runtime_error("Invalid VST3 parameter");
    result.parameters[id] = val;
  }
  return result;
}
inline TrackSource source(const Json& value, bool enabled = true) {
  TrackSource result; const auto kind = string(value, "kind", 32);
  if (kind == "audio") result.kind = TrackSource::Kind::Audio;
  else if (kind == "builtin-synth") result.kind = TrackSource::Kind::BuiltinSynth;
  else if (kind == "builtin-sampled") result.kind = TrackSource::Kind::BuiltinSampled;
  else if (kind == "vst3") { result.kind = TrackSource::Kind::Vst3; result.plugin = plugin(value.at("plugin"), true, enabled); }
  else throw std::runtime_error("Unsupported native track source: " + kind);
  if (kind == "builtin-synth" || kind == "builtin-sampled") {
    result.instrumentId = string(value, "instrumentId"); result.isKit = value.value("isKit", false);
    result.params = parameters(value.value("params", Json::object()));
    if (kind == "builtin-sampled") result.sampleSetId = string(value, "sampleSetId");
  }
  return result;
}
inline ProjectTimeline timeline(const Json& value) {
  ProjectTimeline p;
  if (integer(value, "version", 1, 1, 0) != 1) throw std::runtime_error("Unsupported timeline version");
  p.projectId = string(value, "projectId"); p.revision = integer(value, "revision", 0, 9007199254740991LL, 0);
  p.sampleRate = static_cast<std::uint32_t>(integer(value, "sampleRate", 8000, 192000, 48000));
  p.bpm = number(value, "bpm", 20, 400, 120); p.beatsPerBar = number(value, "beatsPerBar", .25, 64, 4);
  p.lengthFrames = integer(value, "lengthFrames", 1, std::int64_t(p.sampleRate) * 3600, 1);
  p.masterGain = static_cast<float>(number(value, "masterGain", 0, 4, 1));
  p.lowLatencyMonitoring = value.value("lowLatencyMonitoring", true);
  const auto signature = value.value("timeSignature", Json::object());
  p.timeSigNumerator = static_cast<int>(integer(signature, "numerator", 1, 32, 4));
  p.timeSigDenominator = static_cast<int>(integer(signature, "denominator", 2, 16, 4));
  if (p.timeSigDenominator != 2 && p.timeSigDenominator != 4 && p.timeSigDenominator != 8 && p.timeSigDenominator != 16) throw std::runtime_error("Invalid meter denominator");
  if (value.contains("cycle") && !value.at("cycle").is_null()) {
    const auto& cycle = value.at("cycle");
    const auto start = integer(cycle, "startFrame", 0, p.lengthFrames - 1, 0);
    const auto end = integer(cycle, "endFrame", start + 1, p.lengthFrames, p.lengthFrames);
    p.cycle = std::array<std::int64_t, 2>{start, end};
  }
  const auto& tracks = value.at("tracks");
  if (!tracks.is_array() || tracks.size() > 256) throw std::runtime_error("Invalid track count");
  std::size_t totalNotes = 0, totalAudio = 0;
  for (const auto& item : tracks) {
    TrackTimeline t; t.id = string(item, "id"); t.enabled = item.value("enabled", true); t.source = source(item.at("source"), t.enabled);
    t.gain = static_cast<float>(number(item, "gain", 0, 4, 1)); t.pan = static_cast<float>(number(item, "pan", -1, 1, 0));
    t.enabled = item.value("enabled", true); t.mute = item.value("mute", false); t.solo = item.value("solo", false);
    t.soloSafe = item.value("soloSafe", false); t.audible = item.value("audible", true);
    if (!item.at("inserts").is_array() || item.at("inserts").size() > 64) throw std::runtime_error("Too many inserts");
    for (const auto& insert : item.at("inserts")) {
      BuiltinInsert b; b.id = string(insert, "id"); b.type = string(insert, "type"); b.enabled = insert.value("enabled", true);
      if (b.type == "vst3") b.plugin = plugin(insert.at("plugin"), false, t.enabled && b.enabled);
      else b.params = parameters(insert.value("params", Json::object()));
      t.inserts.push_back(std::move(b));
    }
    const auto& notes = item.at("notes"); const auto& audio = item.at("audio");
    if (!notes.is_array() || !audio.is_array() || (totalNotes += notes.size()) > 100000 || (totalAudio += audio.size()) > 8192) throw std::runtime_error("Timeline event limit exceeded");
    for (const auto& n : notes) {
      NotePair note;
      note.id = static_cast<std::int32_t>(integer(n, "id", 0, 2000000000, 0));
      note.onFrame = integer(n, "onFrame", -p.lengthFrames, p.lengthFrames - 1, 0);
      note.offFrame = integer(n, "offFrame", std::max<std::int64_t>(1,note.onFrame + 1), p.lengthFrames, std::max<std::int64_t>(1,note.onFrame + 1));
      note.limitFrame = integer(n, "limitFrame", note.offFrame, p.lengthFrames, note.offFrame);
      note.pitch = static_cast<int>(integer(n, "pitch", 0, 127, 60));
      note.velocity = static_cast<float>(number(n, "velocity", 0, 4, 1));
      t.notes.push_back(note);
    }
    for (const auto& a : audio) {
      AudioWindow w;
      w.id = static_cast<std::int32_t>(integer(a, "id", 0, 2000000000, 0)); w.assetId = string(a, "assetId");
      w.startFrame = integer(a, "startFrame", 0, p.lengthFrames, 0);
      w.endFrame = integer(a, "endFrame", w.startFrame + 1, p.lengthFrames, w.startFrame + 1);
      w.sourceStartFrame = number(a, "sourceStartFrame", 0, 1000000000, 0);
      w.sourceSampleRate = number(a, "sourceSampleRate", 8000, 192000, p.sampleRate);
      w.clipOffsetFrames = integer(a, "clipOffsetFrames", 0, std::int64_t(p.sampleRate) * 3600, 0);
      w.clipLengthFrames = integer(a, "clipLengthFrames", 1, std::int64_t(p.sampleRate) * 3600, w.endFrame - w.startFrame);
      w.gain = static_cast<float>(number(a, "gain", 0, 16, 1));
      w.fadeInFrames = integer(a, "fadeInFrames", 0, w.clipLengthFrames, 0);
      w.fadeOutFrames = integer(a, "fadeOutFrames", 0, w.clipLengthFrames, 0);
      t.audio.push_back(std::move(w));
    }
    p.tracks.push_back(std::move(t));
  }
  return p;
}
inline SampleSet sampleSet(const Json& value) {
  SampleSet set; set.id = string(value, "id"); const auto& manifest = value.at("manifest"); const auto& files = value.at("files");
  set.isKit = manifest.value("kind", "pitched") == "kit";
  set.gainDb = number(manifest, "gainDb", -120, 36, 0); set.release = number(manifest, "release", .001, 30, .25);
  set.startOffset = number(value, "startOffset", 0, 1, 0);
  const auto zones = [&](const char* key, std::vector<SampleZone>& target) {
    const auto& values = manifest.at(key);
    if (!values.is_array() || values.size() > 10000) throw std::runtime_error("Invalid sample zones");
    for (const auto& item : values) {
      SampleZone z; const auto file = string(item, "file"); z.assetId = string(files, file.c_str());
      z.root = static_cast<int>(integer(item, "root", 0, 127, 60)); z.lo = static_cast<int>(integer(item, "lo", 0, 127, z.root)); z.hi = static_cast<int>(integer(item, "hi", z.lo, 127, z.root));
      z.vlo = number(item, "vlo", 0, 1, 0); z.vhi = number(item, "vhi", z.vlo, 1, 1);
      z.gainDb = number(item, "gainDb", -120, 36, 0); z.tune = number(item, "tune", -2400, 2400, 0);
      z.choke = static_cast<int>(integer(item, "choke", -1, 127, -1));
      if (item.contains("loop")) {
        const auto& l = item.at("loop");
        if (!l.is_array() || l.size() != 2 || !l[0].is_number() || !l[1].is_number()) throw std::runtime_error("Invalid sample loop");
        const double a = l[0], b = l[1]; if (!std::isfinite(a) || !std::isfinite(b) || a < 0 || b <= a) throw std::runtime_error("Invalid sample loop");
        z.loop = std::array<double,2>{a,b};
      }
      target.push_back(std::move(z));
    }
  };
  zones("zones", set.zones); if (manifest.contains("releaseZones")) zones("releaseZones", set.releaseZones);
  return set;
}
} // namespace garak::protocol

#pragma once
#include "garak/engine.hpp"
#include <nlohmann/json.hpp>
#include <charconv>
#include <cstring>
#include <unordered_map>
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
  else if (kind == "native-wavetable") {
    result.kind = TrackSource::Kind::NativeWavetable;
    result.instrumentId = string(value, "instrumentId");
    if (result.instrumentId != "wavetable" || value.value("isKit", false)) throw std::runtime_error("Invalid IEUM WAVE source");
    try { result.patchData = unbase64(string(value, "patchData", 4 * 1024 * 1024)); }
    catch (const std::exception& error) { throw std::runtime_error(std::string("Invalid IEUM WAVE patch encoding: ") + error.what()); }
  }
  else throw std::runtime_error("Unsupported native track source: " + kind);
  if (kind == "builtin-synth" || kind == "builtin-sampled") {
    result.instrumentId = string(value, "instrumentId"); result.isKit = value.value("isKit", false);
    result.params = parameters(value.value("params", Json::object()));
    if (kind == "builtin-sampled") result.sampleSetId = string(value, "sampleSetId");
  }
  return result;
}
// Bulk event arrays may travel as a binary frame next to the JSON request (docs/RENDER_DIFF_PROTOCOL.md):
// "notesBinary"/"controlsBinary": { "offset": byte offset, "count": records } into that frame, little endian.
// Note record (24 bytes): int32 id, onFrame, offFrame, limitFrame, pitch; float32 velocity.
// Control record (12 bytes): int32 frame, controller, value.
constexpr std::size_t noteRecordBytes = 24, controlRecordBytes = 12;
inline const std::uint8_t* binaryRecords(const Json& ref, std::string_view blob, std::size_t recordBytes, std::size_t maximum, std::size_t& count) {
  if (!ref.is_object()) throw std::runtime_error("Invalid binary reference");
  const auto offset = static_cast<std::size_t>(integer(ref, "offset", 0, 1LL << 32, 0));
  count = static_cast<std::size_t>(integer(ref, "count", 0, static_cast<std::int64_t>(maximum), 0));
  if (offset % 4 || offset > blob.size() || count * recordBytes > blob.size() - offset) throw std::runtime_error("Binary reference exceeds the request frame");
  return reinterpret_cast<const std::uint8_t*>(blob.data()) + offset;
}
inline std::int32_t readInt32(const std::uint8_t* at) noexcept { std::int32_t v; std::memcpy(&v, at, 4); return v; }
inline float readFloat32(const std::uint8_t* at) noexcept { float v; std::memcpy(&v, at, 4); return v; }
inline void readNote(NotePair& note, std::int64_t id, std::int64_t on, std::int64_t off, std::int64_t limit, std::int64_t pitch, double velocity, std::int64_t lengthFrames) {
  if (id < 0 || id > 2000000000 || on < -lengthFrames || on > lengthFrames - 1 || off < std::max<std::int64_t>(1, on + 1) || off > lengthFrames ||
      limit < off || limit > lengthFrames || pitch < 0 || pitch > 127 || !std::isfinite(velocity) || velocity < 0 || velocity > 4) throw std::runtime_error("Invalid native note");
  note.id = static_cast<std::int32_t>(id); note.onFrame = on; note.offFrame = off; note.limitFrame = limit; note.pitch = static_cast<int>(pitch); note.velocity = static_cast<float>(velocity);
}
inline void readControl(ControlEvent& event, std::int64_t frame, std::int64_t controller, std::int64_t value, std::int64_t lengthFrames, std::int64_t& previous) {
  if (frame < 0 || frame > lengthFrames || controller < 0 || controller >= controllerCount || !validControllerValue(static_cast<int>(controller), static_cast<int>(value))) throw std::runtime_error("Invalid track control value");
  if (frame < previous) throw std::runtime_error("Track controls must be sorted by frame");
  previous = frame;
  event.frame = frame; event.controller = static_cast<std::uint16_t>(controller); event.value = static_cast<std::int32_t>(value);
}
// Header fields of a timeline (everything but its tracks).
inline ProjectTimeline timelineHeader(const Json& value) {
  ProjectTimeline p;
  if (integer(value, "version", 1, 1, 0) != 1) throw std::runtime_error("Unsupported timeline version");
  p.projectId = string(value, "projectId"); p.revision = integer(value, "revision", 0, 9007199254740991LL, 0);
  p.sampleRate = static_cast<std::uint32_t>(integer(value, "sampleRate", 8000, 192000, 48000));
  p.bpm = number(value, "bpm", 20, 400, 120); p.beatsPerBar = number(value, "beatsPerBar", .25, 64, 4);
  p.lengthFrames = integer(value, "lengthFrames", 1, std::int64_t(p.sampleRate) * 3600, 1);
  // Tempo map (docs/TEMPO_MAP.md): sorted points, the first at beat 0 carrying `bpm`. Absent = constant tempo.
  if (value.contains("tempoMap") && !value.at("tempoMap").is_null()) {
    const auto& points = value.at("tempoMap");
    if (!points.is_array() || points.size() > 4096) throw std::runtime_error("Invalid tempo map");
    for (const auto& point : points) {
      TempoPoint t;
      t.beat = number(point, "beat", 0, 10000000, 0); t.bpm = number(point, "bpm", 20, 400, p.bpm);
      const auto curve = point.value("curve", std::string("step"));
      if (curve != "step" && curve != "ramp") throw std::runtime_error("Invalid tempo curve");
      t.ramp = curve == "ramp";
      if (p.tempoMap.empty() ? (t.beat != 0 || std::abs(t.bpm - p.bpm) > 1e-6) : !(t.beat > p.tempoMap.back().beat)) throw std::runtime_error("Invalid tempo map order");
      p.tempoMap.push_back(t);
    }
    if (p.tempoMap.size() < 2) p.tempoMap.clear();
  }
  p.masterGain = static_cast<float>(number(value, "masterGain", 0, 4, 1));
  p.lowLatencyMonitoring = value.value("lowLatencyMonitoring", true);
  const auto signature = value.value("timeSignature", Json::object());
  p.timeSigNumerator = static_cast<int>(integer(signature, "numerator", 1, 32, 4));
  p.timeSigDenominator = static_cast<int>(integer(signature, "denominator", 2, 16, 4));
  if (p.timeSigDenominator != 2 && p.timeSigDenominator != 4 && p.timeSigDenominator != 8 && p.timeSigDenominator != 16) throw std::runtime_error("Invalid meter denominator");
  // Meter map (docs/METER_MAP.md): events sorted by bar, the first at bar 0 with the meter above. Absent = one meter.
  if (value.contains("meterMap") && !value.at("meterMap").is_null()) {
    const auto& events = value.at("meterMap");
    if (!events.is_array() || events.size() > 1024) throw std::runtime_error("Invalid meter map");
    std::vector<MeterEvent> parsed;
    for (const auto& item : events) {
      MeterEvent e;
      e.bar = integer(item, "bar", 0, 1000000, 0);
      e.numerator = static_cast<int>(integer(item, "numerator", 1, 32, 4));
      e.denominator = static_cast<int>(integer(item, "denominator", 2, 16, 4));
      e.beat = number(item, "beat", 0, 1e9, 0);
      if (e.denominator != 2 && e.denominator != 4 && e.denominator != 8 && e.denominator != 16) throw std::runtime_error("Invalid meter denominator");
      if (parsed.empty() ? (e.bar != 0 || e.numerator != p.timeSigNumerator || e.denominator != p.timeSigDenominator) : !(e.bar > parsed.back().bar)) throw std::runtime_error("Invalid meter map order");
      parsed.push_back(e);
    }
    // The bar walk decides every downbeat; a payload whose beats disagree with its bars is rejected, not trusted.
    const MeterMap compiled(p.timeSigNumerator, p.timeSigDenominator, parsed);
    for (std::size_t i = 0; i < parsed.size(); ++i) if (std::abs(compiled.events()[i].beat - parsed[i].beat) > 1e-6) throw std::runtime_error("Meter map beats disagree with its bars");
    if (compiled.events().size() > 1) p.meterMap = compiled.events();
  }
  if (value.contains("cycle") && !value.at("cycle").is_null()) {
    const auto& cycle = value.at("cycle");
    const auto start = integer(cycle, "startFrame", 0, p.lengthFrames - 1, 0);
    const auto end = integer(cycle, "endFrame", start + 1, p.lengthFrames, p.lengthFrames);
    p.cycle = std::array<std::int64_t, 2>{start, end};
  }
  return p;
}
// Which heavy fields a track message carried (project.patch keeps the previous value of the others).
struct TrackFields { bool notes = false, controls = false, audio = false, automation = false; };
inline TrackTimeline timelineTrack(const Json& item, const ProjectTimeline& p, std::string_view blob, TrackFields& present) {
  {
    TrackTimeline t; t.id = string(item, "id"); t.enabled = item.value("enabled", true); t.source = source(item.at("source"), t.enabled);
    t.gain = static_cast<float>(number(item, "gain", 0, 4, 1)); t.pan = static_cast<float>(number(item, "pan", -1, 1, 0));
    t.enabled = item.value("enabled", true); t.mute = item.value("mute", false); t.solo = item.value("solo", false);
    t.soloSafe = item.value("soloSafe", false); t.audible = item.value("audible", true);
    // Physical device channels; null/absent is the device default (first channel or pair).
    if (item.contains("input") && !item.at("input").is_null()) {
      const auto& channels = item.at("input").at("channels");
      if (!channels.is_array() || channels.empty() || channels.size() > 2) throw std::runtime_error("Invalid track input channels");
      TrackInput input; input.channels = {-1, -1};
      for (std::size_t i = 0; i < channels.size(); ++i) {
        if (!channels[i].is_number_integer() || channels[i].get<std::int64_t>() < 0 || channels[i].get<std::int64_t>() > 255) throw std::runtime_error("Invalid track input channel");
        input.channels[i] = static_cast<std::int16_t>(channels[i].get<std::int64_t>());
      }
      if (input.channels[1] == input.channels[0]) throw std::runtime_error("A stereo track input needs two different channels");
      t.input = input;
    }
    // Internal input (docs/TRACK_INPUT_ROUTING.md): { kind: track, trackId, tap } | { kind: master } | { kind: none }.
    if (item.contains("route") && !item.at("route").is_null()) {
      const auto& value = item.at("route");
      TrackRoute route; const auto kind = string(value, "kind", 16);
      if (kind == "track") {
        route.kind = TrackRoute::Kind::Track; route.trackId = string(value, "trackId");
        const auto tap = string(value, "tap", 16);
        if (tap == "preFx") route.tap = TrackRoute::Tap::PreFx; else if (tap == "postFx") route.tap = TrackRoute::Tap::PostFx;
        else if (tap == "postFader") route.tap = TrackRoute::Tap::PostFader; else throw std::runtime_error("Invalid track route tap");
      } else if (kind == "master") route.kind = TrackRoute::Kind::Master;
      else if (kind == "none") route.kind = TrackRoute::Kind::None;
      else throw std::runtime_error("Invalid track route");
      t.route = std::move(route);
    }
    // Send/return (docs/SENDS_RETURNS.md): `return` marks an aux track; `sends` feed returns by id.
    t.isReturn = item.value("return", false);
    if (item.contains("sends") && !item.at("sends").is_null()) {
      const auto& sends = item.at("sends");
      if (!sends.is_array() || sends.size() > 256) throw std::runtime_error("Invalid track sends");
      if (t.isReturn && !sends.empty()) throw std::runtime_error("A return track cannot have sends");
      for (const auto& value : sends) {
        TrackSend send; send.returnId = string(value, "returnId");
        send.gain = static_cast<float>(number(value, "gain", 0, 4, 0)); send.pre = value.value("pre", false);
        for (const auto& other : t.sends) if (other.returnId == send.returnId) throw std::runtime_error("Duplicate track send");
        t.sends.push_back(std::move(send));
      }
    }
    if (!item.at("inserts").is_array() || item.at("inserts").size() > 64) throw std::runtime_error("Too many inserts");
    for (const auto& insert : item.at("inserts")) {
      BuiltinInsert b; b.id = string(insert, "id"); b.type = string(insert, "type"); b.enabled = insert.value("enabled", true);
      if (b.type == "vst3") b.plugin = plugin(insert.at("plugin"), false, t.enabled && b.enabled);
      else b.params = parameters(insert.value("params", Json::object()));
      t.inserts.push_back(std::move(b));
    }
    if (item.contains("notesBinary")) {
      std::size_t count = 0; const auto* at = binaryRecords(item.at("notesBinary"), blob, noteRecordBytes, 100000, count);
      t.notes.resize(count);
      for (std::size_t i = 0; i < count; ++i, at += noteRecordBytes)
        readNote(t.notes[i], readInt32(at), readInt32(at + 4), readInt32(at + 8), readInt32(at + 12), readInt32(at + 16), readFloat32(at + 20), p.lengthFrames);
      present.notes = true;
    } else if (item.contains("notes")) {
      const auto& notes = item.at("notes");
      if (!notes.is_array() || notes.size() > 100000) throw std::runtime_error("Timeline event limit exceeded");
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
      present.notes = true;
    }
    if (item.contains("controlsBinary")) {
      std::size_t count = 0; const auto* at = binaryRecords(item.at("controlsBinary"), blob, controlRecordBytes, 100000, count);
      t.controls.resize(count); std::int64_t previous = -1;
      for (std::size_t i = 0; i < count; ++i, at += controlRecordBytes) readControl(t.controls[i], readInt32(at), readInt32(at + 4), readInt32(at + 8), p.lengthFrames, previous);
      present.controls = true;
    } else if (item.contains("controls")) {
      const auto& controls = item.at("controls");
      if (!controls.is_array() || controls.size() > 100000) throw std::runtime_error("Invalid track controls");
      std::int64_t previous = -1;
      for (const auto& c : controls) {
        ControlEvent event;
        event.frame = integer(c, "frame", 0, p.lengthFrames, 0);
        event.controller = static_cast<std::uint16_t>(integer(c, "controller", 0, controllerCount - 1, sustainController));
        event.value = static_cast<std::int32_t>(integer(c, "value", -8192, 8191, 0));
        if (!validControllerValue(event.controller, event.value)) throw std::runtime_error("Invalid track control value");
        if (event.frame < previous) throw std::runtime_error("Track controls must be sorted by frame");
        previous = event.frame;
        t.controls.push_back(event);
      }
      present.controls = true;
    }
    // Automation lanes (docs/AUTOMATION.md): { target: { kind, insertId?, param?, returnId? }, minimum, maximum, logarithmic?,
    // options?, points: [{ frame, value, curve? }] }.
    t.unmutedAudible = item.value("unmutedAudible", t.audible);
    t.directOut = item.value("directOut", true); t.preFader = item.value("preFader", false);
    if (item.contains("automation")) {
      present.automation = true;
      const auto& lanes = item.at("automation");
      if (!lanes.is_array() || lanes.size() > 256) throw std::runtime_error("Invalid track automation");
      std::size_t totalPoints = 0;
      for (const auto& value : lanes) {
        AutomationLane lane; const auto& target = value.at("target"); const auto kind = string(target, "kind", 16);
        if (kind == "volume") lane.target = AutomationLane::Target::Volume;
        else if (kind == "pan") lane.target = AutomationLane::Target::Pan;
        else if (kind == "mute") lane.target = AutomationLane::Target::Mute;
        else if (kind == "insert") { lane.target = AutomationLane::Target::Insert; lane.insertId = string(target, "insertId"); lane.param = string(target, "param", 120); }
        else if (kind == "instrument") { lane.target = AutomationLane::Target::Instrument; lane.param = string(target, "param", 120); }
        else if (kind == "send") { lane.target = AutomationLane::Target::Send; lane.returnId = string(target, "returnId"); }
        else throw std::runtime_error("Invalid automation target");
        lane.minimum = number(value, "minimum", -1e9, 1e9, 0); lane.maximum = number(value, "maximum", -1e9, 1e9, 1);
        lane.logarithmic = value.value("logarithmic", false);
        if (lane.logarithmic && !(lane.minimum > 0 && lane.maximum > 0)) throw std::runtime_error("Invalid logarithmic automation range");
        if (value.contains("options")) {
          const auto& options = value.at("options");
          if (!options.is_array() || options.size() > 64) throw std::runtime_error("Invalid automation options");
          for (const auto& option : options) { if (!option.is_number()) throw std::runtime_error("Invalid automation option"); lane.options.push_back(option.get<double>()); }
        }
        const auto& points = value.at("points");
        if (!points.is_array() || points.size() > 20000 || (totalPoints += points.size()) > 100000) throw std::runtime_error("Automation point limit exceeded");
        double previous = 0;
        for (const auto& item : points) {
          AutomationPoint point;
          point.frame = number(item, "frame", previous, 1e13, previous);
          point.value = number(item, "value", 0, 1, 0); point.curve = number(item, "curve", -1, 1, 0);
          previous = point.frame;
          lane.points.push_back(point);
        }
        t.automation.push_back(std::move(lane));
      }
    }
    if (item.contains("audio")) present.audio = true;
    static const Json noAudio = Json::array();
    const Json& audio = item.contains("audio") ? item.at("audio") : noAudio;
    if (!audio.is_array() || audio.size() > 8192) throw std::runtime_error("Timeline event limit exceeded");
    for (const auto& a : audio) {
      AudioWindow w;
      w.id = static_cast<std::int32_t>(integer(a, "id", 0, 2000000000, 0)); w.assetId = string(a, "assetId");
      w.startFrame = integer(a, "startFrame", 0, p.lengthFrames, 0);
      w.freeze = a.value("freeze", false); if (w.freeze) w.tailSeconds = number(a, "tailSeconds", 0, 3600, 0);
      // A frozen window may run into the export tail (at most the 30 s export cap past the project end).
      w.endFrame = integer(a, "endFrame", w.startFrame + 1, w.freeze ? p.lengthFrames + std::int64_t(p.sampleRate) * 31 : p.lengthFrames, w.startFrame + 1);
      w.sourceStartFrame = number(a, "sourceStartFrame", 0, 1000000000, 0);
      w.sourceSampleRate = number(a, "sourceSampleRate", 8000, 192000, p.sampleRate);
      w.clipOffsetFrames = integer(a, "clipOffsetFrames", 0, std::int64_t(p.sampleRate) * 3600, 0);
      w.clipLengthFrames = integer(a, "clipLengthFrames", 1, std::int64_t(p.sampleRate) * 3600, w.endFrame - w.startFrame);
      w.gain = static_cast<float>(number(a, "gain", 0, 16, 1));
      w.fadeInFrames = integer(a, "fadeInFrames", 0, w.clipLengthFrames, 0);
      w.fadeOutFrames = integer(a, "fadeOutFrames", 0, w.clipLengthFrames, 0);
      w.fadeInCurve = static_cast<std::int32_t>(integer(a, "fadeInCurve", 0, 4, 0));
      w.fadeOutCurve = static_cast<std::int32_t>(integer(a, "fadeOutCurve", 0, 4, 0));
      t.audio.push_back(std::move(w));
    }
    return t;
  }
}
// A complete timeline (project.set / render.wav). `blob` is the request's binary frame, if any.
inline ProjectTimeline timeline(const Json& value, std::string_view blob = {}) {
  auto p = timelineHeader(value);
  const auto& tracks = value.at("tracks");
  if (!tracks.is_array() || tracks.size() > 256) throw std::runtime_error("Invalid track count");
  std::size_t totalNotes = 0, totalAudio = 0;
  for (const auto& item : tracks) {
    TrackFields present;
    auto t = timelineTrack(item, p, blob, present);
    if (!present.notes || !present.audio) throw std::runtime_error("A timeline track needs notes and audio");
    if ((totalNotes += t.notes.size()) > 100000 || (totalAudio += t.audio.size()) > 8192) throw std::runtime_error("Timeline event limit exceeded");
    p.tracks.push_back(std::move(t));
  }
  return p;
}
// project.patch: the next timeline from the current one. `header` replaces every header field; `order` lists all
// track ids; `tracks` carries the changed tracks only, and a changed track without notes/controls/audio/automation
// keeps the current track's value of that field. Unlisted tracks are kept as they are.
inline ProjectTimeline patchTimeline(const ProjectTimeline& current, const Json& value, std::string_view blob) {
  auto p = timelineHeader(value.at("header"));
  if (p.projectId != current.projectId || p.sampleRate != current.sampleRate) throw std::runtime_error("A patch must target the current project; send project.set");
  p.revision = static_cast<std::uint64_t>(integer(value, "revision", 0, 9007199254740991LL, 0));
  const auto& order = value.at("order");
  const auto& changed = value.at("tracks");
  if (!order.is_array() || order.size() > 256 || !changed.is_array() || changed.size() > order.size()) throw std::runtime_error("Invalid track patch");
  std::unordered_map<std::string, const Json*> patched;
  for (const auto& item : changed) if (!patched.emplace(string(item, "id"), &item).second) throw std::runtime_error("Duplicate patched track");
  std::unordered_map<std::string_view, const TrackTimeline*> existing;
  for (const auto& t : current.tracks) existing.emplace(t.id, &t);
  std::size_t totalNotes = 0, totalAudio = 0;
  for (const auto& entry : order) {
    if (!entry.is_string()) throw std::runtime_error("Invalid track order");
    const auto id = entry.get<std::string>();
    const auto before = existing.find(id);
    const auto change = patched.find(id);
    if (change == patched.end()) {
      if (before == existing.end()) throw std::runtime_error("Patch order names an unknown track");
      p.tracks.push_back(*before->second);
    } else {
      TrackFields present;
      auto t = timelineTrack(*change->second, p, blob, present);
      if (before == existing.end() && (!present.notes || !present.audio)) throw std::runtime_error("A new track needs notes and audio");
      if (before != existing.end()) {
        if (!present.notes) t.notes = before->second->notes;
        if (!present.controls) t.controls = before->second->controls;
        if (!present.audio) t.audio = before->second->audio;
        if (!present.automation) t.automation = before->second->automation;
      }
      patched.erase(change);
      p.tracks.push_back(std::move(t));
    }
    if ((totalNotes += p.tracks.back().notes.size()) > 100000 || (totalAudio += p.tracks.back().audio.size()) > 8192) throw std::runtime_error("Timeline event limit exceeded");
  }
  if (!patched.empty()) throw std::runtime_error("A patched track is missing from the order");
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

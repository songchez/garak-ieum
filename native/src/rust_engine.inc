// Rust render engine backend of RenderEngine (docs/RUST_ENGINE.md 10). Included by engine.cpp inside
// namespace garak. GARAK_RUST_ENGINE=1 (or "strict") at RenderEngine construction makes every graph the Rust
// engine accepts render its tracks through rust/garak-engine (garak_engine.h), while this C++ engine stays the
// shell: transport, cycle, count-in, metronome, live MIDI, capture, master bus and snapshots. VST3 instruments
// and inserts and IEUM WAVE stay C++ processors the Rust graph calls back at their place in the chain (host
// nodes, docs/RUST_ENGINE.md 4), and so does monitored device input; routes, taps, sends, frozen windows and
// plug-in delay compensation are the Rust graph's. A graph the Rust engine refuses (built-in instruments until
// they are ported, guitar rig ...) renders in C++ as before ("1"), or is refused ("strict", for the regression
// suite). GARAK_RUST_ENGINE_HOST_INSTRUMENTS=1 (diagnostics) renders the C++ built-in instruments as host
// nodes too, so every graph runs through the Rust graph.
//
// The plan travels as the same timeline JSON the host receives (docs/RENDER_DIFF_PROTOCOL.md), written
// from the ProjectTimeline with round-trip exact numbers, so the Rust parser reads exactly these values.

namespace {

// 0: off, 1: on with C++ fallback, 2: strict (refusals throw).
int rustEngineModeFromEnvironment() noexcept {
#if GARAK_RUST
  const char* value = std::getenv("GARAK_RUST_ENGINE");
  if (!value || !*value) return 0;
  const std::string_view v(value);
  if (v == "strict") return 2;
  if (v == "0" || v == "off" || v == "false") return 0;
  return 1;
#else
  return 0;
#endif
}

bool rustHostInstrumentsFromEnvironment() noexcept {
#if GARAK_RUST
  const char* value = std::getenv("GARAK_RUST_ENGINE_HOST_INSTRUMENTS");
  return value && *value && std::string_view(value) != "0";
#else
  return false;
#endif
}

class JsonWriter {
 public:
  std::string out;
  void raw(std::string_view s) { out.append(s); }
  void str(std::string_view s) {
    out.push_back('"');
    for (const char ch : s) {
      const auto c = static_cast<unsigned char>(ch);
      if (c == '"' || c == '\\') { out.push_back('\\'); out.push_back(ch); }
      else if (c < 0x20) { char buffer[8]; std::snprintf(buffer, sizeof buffer, "\\u%04x", c); out.append(buffer); }
      else out.push_back(ch);
    }
    out.push_back('"');
  }
  // Shortest form that parses back to the same double (17 significant digits always round-trip).
  void num(double v) { char buffer[40]; std::snprintf(buffer, sizeof buffer, "%.17g", v); out.append(buffer); }
  void integer(std::int64_t v) { char buffer[32]; std::snprintf(buffer, sizeof buffer, "%lld", static_cast<long long>(v)); out.append(buffer); }
  void boolean(bool v) { out.append(v ? "true" : "false"); }
  void key(std::string_view k) { if (!out.empty() && out.back() != '{' && out.back() != '[') out.push_back(','); str(k); out.push_back(':'); }
  void comma() { if (!out.empty() && out.back() != '{' && out.back() != '[') out.push_back(','); }
};

#if GARAK_RUST
// The reason a timeline cannot render in the Rust engine yet, or empty. The Rust parser and graph builder
// refuse the rest themselves (their error is the reason then). VST3 and IEUM WAVE are host nodes; built-in
// instruments are host nodes only with `hostInstruments`.
// Checked before the C++ graph changes, so a strict refusal leaves the running graph alone (RenderEngine::update).
std::string rustIneligibility(const ProjectTimeline& p, bool hostInstruments) {
  for (const auto& t : p.tracks) {
    if (!t.enabled) continue;
    if (!hostInstruments && t.source.kind == TrackSource::Kind::BuiltinSampled) return "sampled instrument on track " + t.id;
    if (!hostInstruments && t.source.kind == TrackSource::Kind::BuiltinSynth) return "instrument source on track " + t.id;
    // Not ported to garak-dsp yet (the Rust graph refuses it too; this names it before anything changes).
    for (const auto& e : t.inserts) if (e.enabled && e.type == "guitar-rig") return "guitar rig insert on track " + t.id;
  }
  return {};
}

// An identity for an IEUM WAVE patch (the Rust graph only compares it): length and FNV-1a 64.
std::string patchIdentity(const std::vector<std::uint8_t>& data) {
  std::uint64_t hash = 1469598103934665603ULL;
  for (const auto byte : data) { hash ^= byte; hash *= 1099511628211ULL; }
  char buffer[48]; std::snprintf(buffer, sizeof buffer, "%zu:%016llx", data.size(), static_cast<unsigned long long>(hash));
  return buffer;
}

void writeParams(JsonWriter& w, const Parameters& params) {
  w.raw("{");
  for (const auto& [name, value] : params) { w.key(name); w.num(value); }
  w.raw("}");
}

// A host node (docs/RUST_ENGINE.md 4): the C++ processor's delay and tail as prepared, for the Rust graph's PDC.
void writeHost(JsonWriter& w, std::uint32_t latency, double tail, bool stereo) {
  w.key("host"); w.raw("{"); w.key("latencyFrames"); w.integer(latency); w.key("tailSeconds"); w.num(tail); w.key("stereo"); w.boolean(stereo); w.raw("}");
}

// `recipe` (the C++ graph prepared from the same timeline, same track order) supplies the host nodes' delays and
// tails; without it host nodes are written without them and the Rust graph refuses them.
std::string rustTimelineJson(const ProjectTimeline& p, const ControlRecipe* recipe, bool hostInstruments) {
  JsonWriter w;
  w.out.reserve(4096);
  w.raw("{");
  w.key("version"); w.integer(p.version);
  w.key("projectId"); w.str(p.projectId);
  w.key("revision"); w.integer(static_cast<std::int64_t>(std::min<std::uint64_t>(p.revision, 9007199254740991ULL)));
  w.key("sampleRate"); w.integer(p.sampleRate);
  w.key("bpm"); w.num(p.bpm);
  w.key("beatsPerBar"); w.num(p.beatsPerBar);
  w.key("lengthFrames"); w.integer(p.lengthFrames);
  if (!p.tempoMap.empty()) {
    w.key("tempoMap"); w.raw("[");
    for (const auto& t : p.tempoMap) { w.comma(); w.raw("{"); w.key("beat"); w.num(t.beat); w.key("bpm"); w.num(t.bpm); w.key("curve"); w.str(t.ramp ? "ramp" : "step"); w.raw("}"); }
    w.raw("]");
  }
  w.key("masterGain"); w.num(p.masterGain);
  w.key("lowLatencyMonitoring"); w.boolean(p.lowLatencyMonitoring);
  w.key("timeSignature"); w.raw("{"); w.key("numerator"); w.integer(p.timeSigNumerator); w.key("denominator"); w.integer(p.timeSigDenominator); w.raw("}");
  if (!p.meterMap.empty()) {
    w.key("meterMap"); w.raw("[");
    for (const auto& m : p.meterMap) { w.comma(); w.raw("{"); w.key("bar"); w.integer(m.bar); w.key("numerator"); w.integer(m.numerator); w.key("denominator"); w.integer(m.denominator); w.key("beat"); w.num(m.beat); w.raw("}"); }
    w.raw("]");
  }
  if (p.cycle) { w.key("cycle"); w.raw("{"); w.key("startFrame"); w.integer(p.cycle->at(0)); w.key("endFrame"); w.integer(p.cycle->at(1)); w.raw("}"); }
  w.key("tracks"); w.raw("[");
  for (std::size_t index = 0; index < p.tracks.size(); ++index) {
    const auto& t = p.tracks[index];
    const ControlTrack* info = recipe && index < recipe->tracks.size() ? &recipe->tracks[index] : nullptr;
    const bool hosted = info && t.enabled;
    w.comma(); w.raw("{");
    w.key("id"); w.str(t.id);
    w.key("enabled"); w.boolean(t.enabled);
    w.key("source"); w.raw("{");
    switch (t.source.kind) {
      case TrackSource::Kind::Audio: w.key("kind"); w.str("audio"); break;
      case TrackSource::Kind::BuiltinSynth: case TrackSource::Kind::BuiltinSampled:
        w.key("kind"); w.str(t.source.kind == TrackSource::Kind::BuiltinSynth ? "builtin-synth" : "builtin-sampled");
        w.key("instrumentId"); w.str(t.source.instrumentId); w.key("isKit"); w.boolean(t.source.isKit);
        w.key("params"); writeParams(w, t.source.params);
        if (t.source.kind == TrackSource::Kind::BuiltinSampled) { w.key("sampleSetId"); w.str(t.source.sampleSetId); }
        if (hostInstruments && hosted) writeHost(w, info->sourceLatency, info->sourceTail, info->sourceStereo);
        break;
      case TrackSource::Kind::Vst3:
        w.key("kind"); w.str("vst3"); w.key("plugin"); w.raw("{"); w.key("instanceId"); w.str(t.source.plugin.instanceId); w.raw("}");
        if (hosted) writeHost(w, info->sourceLatency, info->sourceTail, true);
        break;
      case TrackSource::Kind::NativeWavetable:
        w.key("kind"); w.str("native-wavetable"); w.key("instrumentId"); w.str("wavetable"); w.key("patchData"); w.str(patchIdentity(t.source.patchData));
        if (hosted) writeHost(w, info->sourceLatency, info->sourceTail, true);
        break;
    }
    w.raw("}");
    w.key("gain"); w.num(t.gain); w.key("pan"); w.num(t.pan);
    w.key("mute"); w.boolean(t.mute); w.key("solo"); w.boolean(t.solo); w.key("soloSafe"); w.boolean(t.soloSafe);
    w.key("audible"); w.boolean(t.audible); w.key("unmutedAudible"); w.boolean(t.unmutedAudible);
    if (t.input) {
      w.key("input"); w.raw("{"); w.key("channels"); w.raw("[");
      w.integer(t.input->channels[0]); if (t.input->channels[1] >= 0) { w.raw(","); w.integer(t.input->channels[1]); }
      w.raw("]}");
    }
    if (t.route) {
      w.key("route"); w.raw("{"); w.key("kind");
      switch (t.route->kind) {
        case TrackRoute::Kind::None: w.str("none"); break;
        case TrackRoute::Kind::Master: w.str("master"); break;
        case TrackRoute::Kind::Track:
          w.str("track"); w.key("trackId"); w.str(t.route->trackId); w.key("tap");
          w.str(t.route->tap == TrackRoute::Tap::PreFx ? "preFx" : t.route->tap == TrackRoute::Tap::PostFx ? "postFx" : "postFader");
          break;
      }
      w.raw("}");
    }
    if (t.isReturn) { w.key("return"); w.boolean(true); }
    if (!t.sends.empty()) {
      w.key("sends"); w.raw("[");
      for (const auto& s : t.sends) { w.comma(); w.raw("{"); w.key("returnId"); w.str(s.returnId); w.key("gain"); w.num(s.gain); w.key("pre"); w.boolean(s.pre); w.raw("}"); }
      w.raw("]");
    }
    w.key("inserts"); w.raw("[");
    for (std::size_t k = 0; k < t.inserts.size(); ++k) {
      const auto& e = t.inserts[k];
      w.comma(); w.raw("{"); w.key("id"); w.str(e.id); w.key("type"); w.str(e.type); w.key("enabled"); w.boolean(e.enabled);
      if (e.type == "vst3") {
        w.key("plugin"); w.raw("{"); w.key("instanceId"); w.str(e.plugin.instanceId); w.raw("}");
        if (hosted && e.enabled && k < info->pluginInserts.size()) writeHost(w, info->pluginInserts[k].first, info->pluginInserts[k].second, true);
      } else { w.key("params"); writeParams(w, e.params); }
      w.raw("}");
    }
    w.raw("]");
    w.key("notes"); w.raw("[");
    for (const auto& n : t.notes) {
      w.comma(); w.raw("{"); w.key("id"); w.integer(n.id); w.key("onFrame"); w.integer(n.onFrame); w.key("offFrame"); w.integer(n.offFrame);
      w.key("limitFrame"); w.integer(n.limitFrame); w.key("pitch"); w.integer(n.pitch); w.key("velocity"); w.num(n.velocity); w.raw("}");
    }
    w.raw("]");
    if (!t.controls.empty()) {
      w.key("controls"); w.raw("[");
      for (const auto& c : t.controls) { w.comma(); w.raw("{"); w.key("frame"); w.integer(c.frame); w.key("controller"); w.integer(c.controller); w.key("value"); w.integer(c.value); w.raw("}"); }
      w.raw("]");
    }
    if (!t.automation.empty()) {
      w.key("automation"); w.raw("[");
      for (const auto& lane : t.automation) {
        w.comma(); w.raw("{"); w.key("target"); w.raw("{");
        switch (lane.target) {
          case AutomationLane::Target::Volume: w.key("kind"); w.str("volume"); break;
          case AutomationLane::Target::Pan: w.key("kind"); w.str("pan"); break;
          case AutomationLane::Target::Mute: w.key("kind"); w.str("mute"); break;
          case AutomationLane::Target::Insert: w.key("kind"); w.str("insert"); w.key("insertId"); w.str(lane.insertId); w.key("param"); w.str(lane.param); break;
          case AutomationLane::Target::Instrument: w.key("kind"); w.str("instrument"); w.key("param"); w.str(lane.param); break;
          case AutomationLane::Target::Send: w.key("kind"); w.str("send"); w.key("returnId"); w.str(lane.returnId); break;
        }
        w.raw("}");
        w.key("minimum"); w.num(lane.minimum); w.key("maximum"); w.num(lane.maximum); w.key("logarithmic"); w.boolean(lane.logarithmic);
        if (!lane.options.empty()) { w.key("options"); w.raw("["); for (const auto o : lane.options) { w.comma(); w.num(o); } w.raw("]"); }
        w.key("points"); w.raw("[");
        for (const auto& pt : lane.points) { w.comma(); w.raw("{"); w.key("frame"); w.num(pt.frame); w.key("value"); w.num(pt.value); w.key("curve"); w.num(pt.curve); w.raw("}"); }
        w.raw("]}");
      }
      w.raw("]");
    }
    w.key("audio"); w.raw("[");
    for (const auto& a : t.audio) {
      w.comma(); w.raw("{"); w.key("id"); w.integer(a.id); w.key("assetId"); w.str(a.assetId);
      w.key("startFrame"); w.integer(a.startFrame); w.key("endFrame"); w.integer(a.endFrame);
      w.key("sourceStartFrame"); w.num(a.sourceStartFrame); w.key("sourceSampleRate"); w.num(a.sourceSampleRate);
      w.key("clipOffsetFrames"); w.integer(a.clipOffsetFrames); w.key("clipLengthFrames"); w.integer(a.clipLengthFrames);
      w.key("gain"); w.num(a.gain); w.key("fadeInFrames"); w.integer(a.fadeInFrames); w.key("fadeOutFrames"); w.integer(a.fadeOutFrames);
      w.key("fadeInCurve"); w.integer(a.fadeInCurve); w.key("fadeOutCurve"); w.integer(a.fadeOutCurve);
      if (a.freeze) { w.key("freeze"); w.boolean(true); w.key("tailSeconds"); w.num(a.tailSeconds); }
      w.raw("}");
    }
    w.raw("]");
    if (!t.directOut) { w.key("directOut"); w.boolean(false); }
    if (t.preFader) { w.key("preFader"); w.boolean(true); }
    w.raw("}");
  }
  w.raw("]}");
  return std::move(w.out);
}

#endif
} // namespace

#if GARAK_RUST
// Control-thread owner of the Rust engine handle. The audio thread only calls garak_rs_engine_render_block /
// garak_rs_engine_reset on `handle`.
class RustBackend {
 public:
  RustBackend(std::uint32_t rate, std::uint32_t maxBlock, bool offline)
      : handle(garak_rs_engine_create(rate, maxBlock, offline ? 1 : 0)) {
    if (!handle) throw std::invalid_argument("Rust render engine refused the engine format");
  }
  ~RustBackend() { garak_rs_engine_destroy(handle); }
  RustBackend(const RustBackend&) = delete;
  RustBackend& operator=(const RustBackend&) = delete;
  GarakRsEngine* handle;

  // Registers the PCM of `p`'s windows (once per asset object) and submits the plan. Returns false and the
  // reason when the Rust engine refuses it; the running Rust graph is then unchanged. `recipe`: the C++ graph of
  // the same timeline (host node delays and tails).
  bool apply(const ProjectTimeline& p, const AssetStore& assets, const ControlRecipe* recipe, bool hostInstruments, std::string& reason) {
    reason = rustIneligibility(p, hostInstruments);
    if (!reason.empty()) return false;
    for (const auto& t : p.tracks) for (const auto& w : t.audio) {
      const auto found = assets.find(w.assetId);
      if (found == assets.end() || !found->second) continue; // The Rust graph reports the missing asset.
      if (!put(found->second)) { reason = lastError(); return false; }
    }
    const auto json = rustTimelineJson(p, recipe, hostInstruments);
    if (garak_rs_engine_set(handle, reinterpret_cast<const std::uint8_t*>(json.data()), json.size(), nullptr, 0) < 0) {
      reason = lastError();
      return false;
    }
    return true;
  }
  bool apply(const ProjectTimeline& p, const std::vector<std::shared_ptr<const PcmAsset>>& assets, const ControlRecipe* recipe,
             bool hostInstruments, std::string& reason) {
    AssetStore store;
    for (const auto& a : assets) if (a) store.emplace(a->id, a);
    return apply(p, store, recipe, hostInstruments, reason);
  }
  [[nodiscard]] std::uint64_t ticket() const noexcept { return garak_rs_engine_ticket(handle); }
  void collect() noexcept { garak_rs_engine_collect(handle); }

 private:
  // Asset id -> the PCM object last registered under it.
  std::unordered_map<std::string, std::shared_ptr<const PcmAsset>> registered_;
  bool put(const std::shared_ptr<const PcmAsset>& asset) {
    auto& slot = registered_[asset->id];
    if (slot == asset) return true;
    if (garak_rs_engine_put_asset(handle, reinterpret_cast<const std::uint8_t*>(asset->id.data()), asset->id.size(), asset->sampleRate,
                                  asset->channels, asset->samples.data(), asset->samples.size()) < 0) return false;
    slot = asset; // Owned, so the identity check can never match a recycled address.
    return true;
  }
  std::string lastError() {
    std::string message(512, '\0');
    const auto length = garak_rs_engine_last_error(handle, reinterpret_cast<std::uint8_t*>(message.data()), message.size());
    message.resize(std::min(length, message.size()));
    return message.empty() ? std::string("Rust render engine refused the project") : message;
  }
};
#endif

// Parametric EQ ("Curve 8") and Sweep filter. Included inside dsp.cpp's anonymous namespace.
// Keep in sync with src/devices/effects/eqModel.ts: same parameter ids, ranges, defaults and
// biquad stage layout, so the Web Audio and native engines render the same curve.

// A fixed number of biquad slots processed in order; only the first `active` run. Slots keep
// their history across parameter edits (the engine rebuilds processors on every change).
class BiquadChain final : public StereoProcessor {
 public:
  static constexpr std::size_t slots = 32;
  std::array<Biquad, slots> filters{};
  std::array<bool, slots> used{};
  double outputGain = 1;
  void process(float* s, std::uint32_t frames) noexcept override {
    for (std::size_t f = 0; f < slots; ++f) if (used[f]) for (std::uint32_t i = 0; i < frames; ++i) {
      s[2 * i] = filters[f].sample(s[2 * i], 0); s[2 * i + 1] = filters[f].sample(s[2 * i + 1], 1);
    }
    if (outputGain != 1) for (std::uint32_t i = 0; i < 2 * frames; ++i) s[i] = static_cast<float>(s[i] * outputGain);
  }
  void reset() noexcept override { for (auto& f : filters) f.reset(); }
  void automate(const Reader& p) noexcept override { if (reconfigure) reconfigure(*this, p); }
  // Set by the factory: re-derives the stages from the parameters with glide (EQ or sweep filter).
  void (*reconfigure)(BiquadChain&, const Reader&) noexcept = nullptr;
  double sampleRate = 48000;
  void takeStateFrom(StereoProcessor& previous) noexcept override {
    if (auto* p = dynamic_cast<BiquadChain*>(&previous))
      for (std::size_t i = 0; i < slots; ++i) if (used[i] && p->used[i]) filters[i].takeHistoryFrom(p->filters[i]);
  }
};

struct EqStage { Filter type; double hz, q, gain; };
constexpr std::size_t eqBands = 8, eqStagesPerBand = 4;

// Butterworth stage Qs (ascending) for 1..4 cascaded biquads.
const std::array<double, 4>& butterworth(unsigned stages) {
  static const std::array<std::array<double, 4>, 4> table = [] {
    std::array<std::array<double, 4>, 4> t{};
    for (unsigned n = 1; n <= 4; ++n) {
      std::vector<double> q;
      for (unsigned k = 0; k < n; ++k) q.push_back(1 / (2 * std::cos((2 * k + 1) * pi / (4.0 * n))));
      std::sort(q.begin(), q.end());
      for (unsigned k = 0; k < n; ++k) t[n - 1][k] = q[k];
    }
    return t;
  }();
  return table[stages - 1];
}

// Low/high-pass cascade; low/high-pass Q is passed in dB as the persisted Web Audio unit.
unsigned passStages(EqStage* out, Filter type, double hz, double resonanceQ, unsigned stages) {
  const auto& q = butterworth(stages);
  for (unsigned k = 0; k < stages; ++k) {
    const double linear = k + 1 == stages ? q[k] * resonanceQ / std::sqrt(.5) : q[k];
    out[k] = {type, hz, 20 * std::log10(std::max(1e-4, linear)), 0};
  }
  return stages;
}

const std::vector<Def>& eqDefs() {
  static const std::vector<std::string> names = [] {
    std::vector<std::string> n;
    for (unsigned b = 1; b <= eqBands; ++b) for (const char* f : {"On", "Type", "Freq", "Gain", "Q", "Slope"}) n.push_back("b" + std::to_string(b) + f);
    return n;
  }();
  static const std::vector<Def> defs = [] {
    struct BandDefault { double on, type, freq, q; };
    const BandDefault d[eqBands] = {{1, 1, 220, 1}, {1, 0, 1000, .9}, {1, 2, 4500, 1}, {0, 3, 40, .71}, {0, 0, 180, 1}, {0, 0, 600, 1}, {0, 0, 2500, 1}, {0, 4, 16000, .71}};
    std::vector<Def> v{{"low", 0, -24, 24}, {"mid", 0, -24, 24}, {"midFreq", 1000, 20, 20000}, {"high", 0, -24, 24}, {"output", 0, -24, 24}};
    for (unsigned b = 0; b < eqBands; ++b) {
      const std::string* n = &names[b * 6];
      v.push_back({n[0].c_str(), d[b].on, 0, 2}); v.push_back({n[1].c_str(), d[b].type, 0, 5});
      if (b != 1) v.push_back({n[2].c_str(), d[b].freq, 20, 20000});  // band 2 frequency is "midFreq"
      if (b > 2) v.push_back({n[3].c_str(), 0, -24, 24});              // bands 1–3 gains are low/mid/high
      v.push_back({n[4].c_str(), d[b].q, .1, 18}); v.push_back({n[5].c_str(), 0, 0, 3});
    }
    return v;
  }();
  return defs;
}

// Parameter ids per band and field (On, Type, Freq, Gain, Q, Slope), built once so automation never allocates.
const char* eqId(unsigned band, const char* field) {
  static const std::array<std::array<std::string, 6>, eqBands> ids = [] {
    std::array<std::array<std::string, 6>, eqBands> t;
    const char* fields[6] = {"On", "Type", "Freq", "Gain", "Q", "Slope"};
    for (unsigned b = 1; b <= eqBands; ++b) for (unsigned f = 0; f < 6; ++f) {
      const std::string name = fields[f];
      t[b - 1][f] = b == 1 && name == "Gain" ? "low" : b == 2 && name == "Gain" ? "mid" : b == 2 && name == "Freq" ? "midFreq" : b == 3 && name == "Gain" ? "high" : "b" + std::to_string(b) + name;
    }
    return t;
  }();
  const std::string_view f = field;
  const unsigned index = f == "On" ? 0 : f == "Type" ? 1 : f == "Freq" ? 2 : f == "Gain" ? 3 : f == "Q" ? 4 : 5;
  return ids[band - 1][index].c_str();
}

void configureEq(BiquadChain& chain, const Reader& p, bool glide) noexcept {
  const double sr = chain.sampleRate;
  std::array<bool, BiquadChain::slots> used{};
  for (unsigned b = 1; b <= eqBands; ++b) {
    if (std::round(p(eqId(b, "On"))) != 1) continue;  // 0 unused, 2 bypassed
    const double hz = bounded(p(eqId(b, "Freq")), 10, sr * .45), gain = p(eqId(b, "Gain")), q = p(eqId(b, "Q"));
    const auto slope = static_cast<unsigned>(std::round(p(eqId(b, "Slope"))));
    EqStage stages[eqStagesPerBand]; unsigned count = 1;
    switch (static_cast<int>(std::round(p(eqId(b, "Type"))))) {
      case 0: stages[0] = {Filter::Peak, hz, q, gain}; break;
      case 1: stages[0] = {Filter::LowShelf, hz, 1, gain}; break;
      case 2: stages[0] = {Filter::HighShelf, hz, 1, gain}; break;
      case 3: count = passStages(stages, Filter::Highpass, hz, q, slope + 1); break;
      case 4: count = passStages(stages, Filter::Lowpass, hz, q, slope + 1); break;
      default: stages[0] = {Filter::Notch, hz, q, 0}; break;
    }
    for (unsigned s = 0; s < count; ++s) {
      const std::size_t slot = (b - 1) * eqStagesPerBand + s;
      // A stage that was idle starts from its new response; running stages glide.
      chain.filters[slot].configure(stages[s].type, sr, stages[s].hz, stages[s].q, stages[s].gain, glide && chain.used[slot]); used[slot] = true;
    }
  }
  chain.used = used;
  chain.outputGain = dbToGain(p("output"));
}

std::unique_ptr<StereoProcessor> makeParametricEq(const Parameters& params, double sr) {
  Reader p(params, eqDefs());
  auto chain = std::make_unique<BiquadChain>();
  chain->sampleRate = sr;
  configureEq(*chain, p, false);
  chain->reconfigure = [](BiquadChain& c, const Reader& r) noexcept { configureEq(c, r, true); };
  return chain;
}

void configureSweep(BiquadChain& chain, const Reader& p, bool glide) noexcept {
  const double sr = chain.sampleRate;
  const unsigned stages = std::array<unsigned, 3>{1, 2, 4}[static_cast<unsigned>(std::round(p("slope")))];
  const auto mode = static_cast<unsigned>(std::round(p("mode")));
  const double hz = p("cutoff"), resonance = p("resonance");
  EqStage s[eqStagesPerBand];
  if (mode == 2) for (unsigned k = 0; k < stages; ++k) s[k] = {Filter::Bandpass, hz, resonance, 0};
  else if (stages == 1) s[0] = {mode == 0 ? Filter::Lowpass : Filter::Highpass, hz, resonance, 0};
  else passStages(s, mode == 0 ? Filter::Lowpass : Filter::Highpass, hz, std::sqrt(.5) * dbToGain(resonance - .7), stages);  // default 0.7 is flat
  for (unsigned k = 0; k < BiquadChain::slots; ++k) {
    if (k < stages) chain.filters[k].configure(s[k].type, sr, s[k].hz, s[k].q, s[k].gain, glide && chain.used[k]);
    chain.used[k] = k < stages;
  }
}

std::unique_ptr<StereoProcessor> makeSweepFilter(const Parameters& params, double sr) {
  Reader p(params, {{"cutoff", 1200, 20, 20000}, {"resonance", .7, .1, 18}, {"mode", 0, 0, 2}, {"slope", 0, 0, 2}});
  auto chain = std::make_unique<BiquadChain>();
  chain->sampleRate = sr;
  configureSweep(*chain, p, false);
  chain->reconfigure = [](BiquadChain& c, const Reader& r) noexcept { configureSweep(c, r, true); };
  return chain;
}

// Test-only access to the Rust DSP kernels (rust/garak-dsp through garak_rust.h) behind a small processor interface:
// the parameter catalog, validation, live parameter control and state hand-over the C++ makeEffect() /
// EffectControl API offered until 0.3.3 removed the C++ effect DSP. The engine renders these kernels inside the Rust
// graph; the tests (rust_parity_test.cpp, engine_test.cpp) drive them directly with the same call sequence the old
// Rust backend of makeEffect() used, so their outputs stay bit-identical to the golden references.
#pragma once

#include "garak/engine.hpp"
#include "garak_rust.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <map>
#include <memory>
#include <new>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace garak::test {

constexpr double pi = 3.14159265358979323846264338327950288;
inline double dbToGain(double db) noexcept { return std::pow(10.0, db / 20.0); }

struct Def { std::string id; double fallback = 0, minimum = 0, maximum = 0; };

inline std::vector<Def> catalog(std::string_view type) {
  std::vector<Def> defs;
  char id[64];
  if (type == "guitar-rig") {
    for (std::uint32_t i = 0; i < garak_rs_rig_param_count(); ++i) {
      const auto n = garak_rs_rig_param_id(i, id, sizeof id);
      Def d{std::string(id, std::min(n, sizeof id))};
      garak_rs_rig_param_range(i, &d.fallback, &d.minimum, &d.maximum);
      defs.push_back(d);
    }
    return defs;
  }
  const int kind = garak_rs_fx_kind(type.data(), type.size());
  if (kind < 0) return defs;
  for (std::uint32_t i = 0; i < garak_rs_fx_param_count(static_cast<std::uint32_t>(kind)); ++i) {
    const auto n = garak_rs_fx_param_id(static_cast<std::uint32_t>(kind), i, id, sizeof id);
    Def d{std::string(id, std::min(n, sizeof id))};
    garak_rs_fx_param_range(static_cast<std::uint32_t>(kind), i, &d.fallback, &d.minimum, &d.maximum);
    defs.push_back(d);
  }
  return defs;
}

// Parameter values in catalog order; unknown ids and out-of-range or non-finite values throw.
inline std::vector<double> values(std::string_view type, const Parameters& params, const std::vector<Def>& defs) {
  if (defs.empty()) throw std::invalid_argument("Unsupported native effect: " + std::string(type));
  for (const auto& [name, value] : params) {
    const auto it = std::find_if(defs.begin(), defs.end(), [&](const Def& d) { return d.id == name; });
    if (it == defs.end()) throw std::invalid_argument("Unknown effect parameter: " + name);
    if (!std::isfinite(value) || value < it->minimum || value > it->maximum) throw std::invalid_argument("Invalid effect parameter: " + name);
  }
  std::vector<double> out;
  for (const auto& d : defs) { const auto found = params.find(d.id); out.push_back(found == params.end() ? d.fallback : found->second); }
  return out;
}

// Compressor / limiter / gate meter: detector peak and lowest gain since the last take().
struct DynamicsTap {
  float peak = 0, gain = 1;
  void add(float p, float g) noexcept { peak = std::max(peak, p); gain = std::min(gain, g); }
  void take(float& p, float& g) noexcept { p = peak; g = gain; peak = 0; gain = 1; }
};

class Effect {
 public:
  virtual ~Effect() = default;
  [[nodiscard]] virtual DynamicsTap* dynamics() noexcept { return nullptr; }
  virtual void process(float* stereo, std::uint32_t frames) noexcept = 0;
  virtual void reset() noexcept = 0;
  virtual void takeStateFrom(Effect& previous) noexcept = 0;
  [[nodiscard]] virtual std::uint32_t latencyFrames() const noexcept = 0;
  [[nodiscard]] virtual double tailSeconds() const noexcept = 0;
  virtual void setTempo(double) noexcept {}
  virtual void automate(const std::vector<double>& values) noexcept = 0;
};

class RustEffect final : public Effect {
 public:
  RustEffect(std::string_view type, const Parameters& params, double sr, double bpm) {
    const int kind = garak_rs_fx_kind(type.data(), type.size());
    if (kind < 0) throw std::invalid_argument("Unsupported native effect: " + std::string(type));
    kind_ = static_cast<std::uint32_t>(kind);
    const auto defs = catalog(type);
    values_ = values(type, params, defs);
    std::size_t irLength = 0;
    if (kind_ == GARAK_RS_FX_REVERB) {
      const auto at = [&](const char* id) { return values_[static_cast<std::size_t>(std::find_if(defs.begin(), defs.end(), [&](const Def& d) { return d.id == id; }) - defs.begin())]; };
      irLength = garak_rs_reverb_ir_len(sr, at("type"));
      std::vector<float> left(irLength), right(irLength), scratch(garak_rs_reverb_scratch_len(sr, at("type")));
      if (!garak_rs_reverb_generate_ir(sr, at("type"), at("size"), left.data(), right.data(), irLength, scratch.data(), scratch.size()))
        throw std::runtime_error("Rust reverb impulse generation failed");
      kernels_.resize(garak_rs_reverb_kernel_len(irLength));
      if (!garak_rs_reverb_prepare_kernels(left.data(), right.data(), irLength, kernels_.data(), kernels_.size()))
        throw std::runtime_error("Rust reverb kernel preparation failed");
    }
    storage_.resize(garak_rs_fx_storage_len(kind_, sr, irLength));
    state_ = static_cast<GarakRsFx*>(::operator new(garak_rs_fx_size(), std::align_val_t(garak_rs_fx_align())));
    const int rc = garak_rs_fx_init(state_, kind_, sr, bpm, values_.data(), static_cast<std::uint32_t>(values_.size()),
                                    storage_.data(), storage_.size(), kernels_.data(), kernels_.size(), irLength);
    if (rc != GARAK_RS_OK) {
      ::operator delete(state_, std::align_val_t(garak_rs_fx_align()));
      state_ = nullptr;
      throw std::invalid_argument("Rust effect initialisation failed: " + std::string(type));
    }
    metered_ = kind_ == GARAK_RS_FX_COMPRESSOR || kind_ == GARAK_RS_FX_LIMITER || kind_ == GARAK_RS_FX_GATE;
  }
  ~RustEffect() override { if (state_) ::operator delete(state_, std::align_val_t(garak_rs_fx_align())); }
  RustEffect(const RustEffect&) = delete;
  RustEffect& operator=(const RustEffect&) = delete;
  DynamicsTap* dynamics() noexcept override { return metered_ ? &tap_ : nullptr; }
  void process(float* stereo, std::uint32_t frames) noexcept override {
    garak_rs_fx_process(state_, stereo, frames);
    if (metered_) { float peak = 0, gain = 1; garak_rs_fx_meter(state_, &peak, &gain); tap_.add(peak, gain); }
  }
  void reset() noexcept override { garak_rs_fx_reset(state_); }
  void takeStateFrom(Effect& previous) noexcept override {
    auto* p = dynamic_cast<RustEffect*>(&previous);
    if (!p || p->kind_ != kind_) return;
    if (garak_rs_fx_take_state(state_, p->state_)) storage_.swap(p->storage_);
  }
  std::uint32_t latencyFrames() const noexcept override { return garak_rs_fx_latency(state_); }
  double tailSeconds() const noexcept override { return garak_rs_fx_tail(state_); }
  void setTempo(double bpm) noexcept override { garak_rs_fx_set_tempo(state_, bpm); }
  void automate(const std::vector<double>& v) noexcept override {
    std::copy(v.begin(), v.begin() + static_cast<std::ptrdiff_t>(std::min(v.size(), values_.size())), values_.begin());
    garak_rs_fx_automate(state_, values_.data(), static_cast<std::uint32_t>(values_.size()));
  }

 private:
  std::uint32_t kind_ = 0;
  GarakRsFx* state_ = nullptr;
  std::vector<float> storage_, kernels_;
  std::vector<double> values_;
  DynamicsTap tap_;
  bool metered_ = false;
};

class RustGuitarRig final : public Effect {
 public:
  RustGuitarRig(const Parameters& params, double sr) {
    values_ = values("guitar-rig", params, catalog("guitar-rig"));
    const auto count = static_cast<std::uint32_t>(values_.size());
    double decays[GARAK_RS_RIG_MAX_REVERBS]{};
    const std::uint32_t reverbs = garak_rs_rig_reverb_decays(values_.data(), count, decays);
    const std::size_t irLength = reverbs ? garak_rs_rig_reverb_ir_len(sr) : 0;
    const float* pointers[GARAK_RS_RIG_MAX_REVERBS]{};
    std::size_t lengths[GARAK_RS_RIG_MAX_REVERBS]{};
    for (unsigned i = 0; i < GARAK_RS_RIG_MAX_REVERBS; ++i) {
      if (!(reverbs >> i & 1u)) continue;
      std::vector<float> left(irLength), right(irLength), scratch(garak_rs_rig_reverb_scratch_len(sr));
      if (!garak_rs_rig_reverb_generate_ir(sr, decays[i], left.data(), right.data(), irLength, scratch.data(), scratch.size()))
        throw std::runtime_error("Rust guitar rig reverb impulse generation failed");
      kernels_[i].resize(garak_rs_reverb_kernel_len(irLength));
      if (!garak_rs_reverb_prepare_kernels(left.data(), right.data(), irLength, kernels_[i].data(), kernels_[i].size()))
        throw std::runtime_error("Rust guitar rig reverb kernel preparation failed");
      pointers[i] = kernels_[i].data(); lengths[i] = kernels_[i].size();
    }
    storage_.resize(garak_rs_rig_storage_len(sr, values_.data(), count, irLength));
    state_ = static_cast<GarakRsRig*>(::operator new(garak_rs_rig_size(), std::align_val_t(garak_rs_rig_align())));
    const int rc = garak_rs_rig_init(state_, sr, values_.data(), count, storage_.data(), storage_.size(), pointers, lengths, irLength);
    if (rc != GARAK_RS_OK) {
      ::operator delete(state_, std::align_val_t(garak_rs_rig_align()));
      state_ = nullptr;
      throw std::invalid_argument("Rust guitar rig initialisation failed");
    }
  }
  ~RustGuitarRig() override { if (state_) ::operator delete(state_, std::align_val_t(garak_rs_rig_align())); }
  RustGuitarRig(const RustGuitarRig&) = delete;
  RustGuitarRig& operator=(const RustGuitarRig&) = delete;
  void process(float* stereo, std::uint32_t frames) noexcept override { garak_rs_rig_process(state_, stereo, frames); }
  void reset() noexcept override { garak_rs_rig_reset(state_); }
  void takeStateFrom(Effect& previous) noexcept override {
    auto* p = dynamic_cast<RustGuitarRig*>(&previous);
    if (!p) return;
    if (garak_rs_rig_take_state(state_, p->state_)) storage_.swap(p->storage_);
  }
  std::uint32_t latencyFrames() const noexcept override { return garak_rs_rig_latency(state_); }
  double tailSeconds() const noexcept override { return garak_rs_rig_tail(state_); }
  void automate(const std::vector<double>& v) noexcept override {
    std::copy(v.begin(), v.begin() + static_cast<std::ptrdiff_t>(std::min(v.size(), values_.size())), values_.begin());
    garak_rs_rig_automate(state_, values_.data(), static_cast<std::uint32_t>(values_.size()));
  }

 private:
  GarakRsRig* state_ = nullptr;
  std::vector<float> storage_;
  std::array<std::vector<float>, GARAK_RS_RIG_MAX_REVERBS> kernels_;
  std::vector<double> values_;
};

// Throws for unsupported effects, unknown keys, invalid ranges or non-finite values.
inline std::unique_ptr<Effect> makeEffect(std::string_view type, const Parameters& params, double sr, double bpm) {
  if (!std::isfinite(sr) || sr < 8000 || sr > 192000 || !std::isfinite(bpm) || bpm < 20 || bpm > 400) throw std::invalid_argument("Invalid DSP rate or tempo");
  if (type == "guitar-rig") return std::make_unique<RustGuitarRig>(params, sr);
  return std::make_unique<RustEffect>(type, params, sr, bpm);
}

// Live parameter control of one effect (the former EffectControl): set() clamps to the catalog range, apply()
// pushes every value at once when one changed.
class Control {
 public:
  Control(std::string_view type, const Parameters& initial) : defs_(catalog(type)) {
    if (defs_.empty()) throw std::invalid_argument("Unsupported native effect: " + std::string(type));
    for (const auto& d : defs_) { const auto found = initial.find(d.id); values_.push_back(found != initial.end() ? found->second : d.fallback); }
  }
  [[nodiscard]] int index(std::string_view id) const noexcept {
    for (std::size_t i = 0; i < defs_.size(); ++i) if (defs_[i].id == id) return static_cast<int>(i);
    return -1;
  }
  void set(int index, double value) noexcept {
    if (index < 0 || static_cast<std::size_t>(index) >= values_.size() || !std::isfinite(value)) return;
    const auto& d = defs_[static_cast<std::size_t>(index)];
    const double clamped = std::clamp(value, d.minimum, d.maximum);
    if (values_[static_cast<std::size_t>(index)] != clamped) { values_[static_cast<std::size_t>(index)] = clamped; dirty_ = true; }
  }
  [[nodiscard]] double get(int index) const noexcept { return index < 0 || static_cast<std::size_t>(index) >= values_.size() ? 0 : values_[static_cast<std::size_t>(index)]; }
  void apply(Effect& effect) noexcept { if (!dirty_) return; dirty_ = false; effect.automate(values_); }

 private:
  std::vector<Def> defs_;
  std::vector<double> values_;
  bool dirty_ = false;
};

// The garak-dsp biquad (Web Audio units) behind the former dsp::Biquad interface: one filter per channel (mono
// sample() calls run channel 0). Kinds: 0 lowpass, 1 highpass, 2 bandpass, 3 peak, 4 low shelf, 5 high shelf, 6 notch.
enum class Filter : std::uint32_t { Lowpass, Highpass, Bandpass, Peak, LowShelf, HighShelf, Notch };
class Biquad {
 public:
  Biquad() { for (auto& s : state_) garak_rs_biquad_init(&s); }
  void configure(Filter type, double rate, double frequency, double q = 1, double gainDb = 0) noexcept {
    for (auto& s : state_) garak_rs_biquad_configure(&s, static_cast<std::uint32_t>(type), rate, frequency, q, gainDb);
  }
  float sample(float input) noexcept { return sampleChannel(input, 0); }
  float sampleChannel(float input, unsigned channel) noexcept {
    float frame[2]{input, 0.f};
    garak_rs_biquad_process_interleaved(&state_[channel & 1u], frame, 1);
    return frame[0];
  }

 private:
  std::array<GarakRsBiquad, 2> state_{};
};

// Piano key-release ("damper") noise level, 0 = skip: the rule of releaseNoiseGain in src/audio/samples.ts and
// rust/garak-dsp (the reference the engine test checks rendered releases against).
inline double releaseNoiseGain(double velocity, double heldSeconds, double naturalSeconds, double amount, bool cut) noexcept {
  if (cut || !(amount > 0) || !(velocity > 0.02) || !(heldSeconds < naturalSeconds)) return 0;
  const double gain = std::min(1.0, amount) * std::min(1.0, velocity) * std::exp(-std::max(0.0, heldSeconds) / 2.0);
  return gain >= 0.002 ? gain : 0;
}

} // namespace garak::test

// Rust-backed built-in effects (docs/RUST.md, stage 1). Included inside dsp.cpp's anonymous
// namespace only when the build has GARAK_RUST=ON. RustEffect implements StereoProcessor by
// calling rust/garak-ffi (garak_rust.h): the same algorithms as the C++ classes above, ported to
// rust/garak-dsp. makeEffect() picks it per effect type (setEffectBackend / GARAK_RUST_EFFECTS);
// the default stays the C++ implementation. dsp.cpp includes garak_rust.h, <cstdlib> and <new>.

std::vector<Def> effectDefs(std::string_view type);

int rustKind(std::string_view type) noexcept { return garak_rs_fx_kind(type.data(), type.size()); }

class RustEffect final : public StereoProcessor {
 public:
  RustEffect(std::string_view type, const Parameters& params, double sr, double bpm) : kind_(static_cast<std::uint32_t>(rustKind(type))) {
    if (rustKind(type) < 0) throw std::invalid_argument("No Rust implementation for effect: " + std::string(type));
    Reader p(params, effectDefs(type));  // the same validation (and exceptions) as the C++ path
    defs_ = p.defs();
    if (garak_rs_fx_param_count(kind_) != defs_.size() || defs_.size() > values_.size())
      throw std::logic_error("Rust and C++ parameter catalogs differ for effect: " + std::string(type));
    for (std::size_t i = 0; i < defs_.size(); ++i) {
      char id[64];
      const auto length = garak_rs_fx_param_id(kind_, static_cast<std::uint32_t>(i), id, sizeof id);
      if (std::string_view(id, std::min(length, sizeof id)) != defs_[i].name)
        throw std::logic_error("Rust and C++ parameter catalogs differ for effect: " + std::string(type));
      values_[i] = p(defs_[i].name);
    }
    std::size_t irLength = 0;
    if (kind_ == GARAK_RS_FX_REVERB) {
      // Same impulse as dsp.cpp impulse(); a cached IR could be handed to prepare_kernels instead.
      irLength = garak_rs_reverb_ir_len(sr, p("type"));
      std::vector<float> left(irLength), right(irLength), scratch(garak_rs_reverb_scratch_len(sr, p("type")));
      if (!garak_rs_reverb_generate_ir(sr, p("type"), p("size"), left.data(), right.data(), irLength, scratch.data(), scratch.size()))
        throw std::runtime_error("Rust reverb impulse generation failed");
      kernels_.resize(garak_rs_reverb_kernel_len(irLength));
      if (!garak_rs_reverb_prepare_kernels(left.data(), right.data(), irLength, kernels_.data(), kernels_.size()))
        throw std::runtime_error("Rust reverb kernel preparation failed");
    }
    storage_.resize(garak_rs_fx_storage_len(kind_, sr, irLength));
    state_ = static_cast<GarakRsFx*>(::operator new(garak_rs_fx_size(), std::align_val_t(garak_rs_fx_align())));
    const int rc = garak_rs_fx_init(state_, kind_, sr, bpm, values_.data(), static_cast<std::uint32_t>(defs_.size()),
        storage_.data(), storage_.size(), kernels_.data(), kernels_.size(), irLength);
    if (rc != GARAK_RS_OK) {
      ::operator delete(state_, std::align_val_t(garak_rs_fx_align()));
      state_ = nullptr;
      throw std::invalid_argument("Rust effect initialisation failed (" + std::to_string(rc) + "): " + std::string(type));
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
  void takeStateFrom(StereoProcessor& previous) noexcept override {
    auto* p = dynamic_cast<RustEffect*>(&previous);
    if (!p || p->kind_ != kind_) return;
    // Rust swapped its views of the two state buffers: swap the owners to match (O(1)).
    if (garak_rs_fx_take_state(state_, p->state_)) storage_.swap(p->storage_);
  }
  std::uint32_t latencyFrames() const noexcept override { return garak_rs_fx_latency(state_); }
  double tailSeconds() const noexcept override { return garak_rs_fx_tail(state_); }
  void setTempo(double bpm) noexcept override { garak_rs_fx_set_tempo(state_, bpm); }
  void automate(const Reader& p) noexcept override {
    for (std::size_t i = 0; i < defs_.size(); ++i) values_[i] = p(defs_[i].name);
    garak_rs_fx_automate(state_, values_.data(), static_cast<std::uint32_t>(defs_.size()));
  }

 private:
  std::uint32_t kind_;
  GarakRsFx* state_ = nullptr;
  std::vector<float> storage_, kernels_;
  std::vector<Def> defs_;
  std::array<double, 64> values_{};
  DynamicsTap tap_;
  bool metered_ = false;
};

// Per-type backend choice. Defaults come from the GARAK_RUST_EFFECTS CMake list and the
// GARAK_RUST_EFFECTS environment variable ("all", "none"/"cpp", or comma-separated type ids, applied left to right); empty = C++ only.
// Release desktop builds default to "all"; GARAK_RUST_EFFECTS=none at run time goes back to C++.
std::array<std::atomic<bool>, GARAK_RS_FX_COUNT>& rustSelection() {
  static std::array<std::atomic<bool>, GARAK_RS_FX_COUNT> selected{};
  static const bool initialised = [] {
    auto apply = [](std::string_view list) {
      while (!list.empty()) {
        const auto comma = list.find_first_of(",; ");
        const auto item = list.substr(0, comma);
        if (item == "all") for (auto& v : selected) v.store(true);
        else if (item == "none" || item == "cpp") for (auto& v : selected) v.store(false);
        else if (const int kind = rustKind(item); kind >= 0) selected[static_cast<std::size_t>(kind)].store(true);
        list = comma == std::string_view::npos ? std::string_view{} : list.substr(comma + 1);
      }
    };
#ifdef GARAK_RUST_EFFECTS_DEFAULT
    apply(GARAK_RUST_EFFECTS_DEFAULT);
#endif
#ifdef _MSC_VER
#pragma warning(suppress : 4996)  // getenv: read once at start-up, no concurrent setenv
#endif
    if (const char* env = std::getenv("GARAK_RUST_EFFECTS")) apply(env);
    return true;
  }();
  (void)initialised;
  return selected;
}

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

// ---- Guitar rig (rust/garak-ffi/src/rig.rs, garak_rs_rig_*) -------------------------------------------

// Plate kernels shared by every Rust rig reverb with the same (rate, float decay): built once on the control
// thread (IR synthesis + FFT partitioning, the heavy part of a rig rebuild) and kept while a rig uses them,
// plus the few most recently built so a toggled reverb comes back without a rebuild (as blendedKernel()).
struct RigKernelCache {
  std::mutex mutex;
  std::map<std::pair<double, float>, std::weak_ptr<const std::vector<float>>> kernels;
  std::deque<std::shared_ptr<const std::vector<float>>> recent;
};
std::shared_ptr<const std::vector<float>> rustRigKernels(double sr, double decay, std::size_t irLength) {
  static RigKernelCache cache;
  std::lock_guard lock(cache.mutex);
  auto& slot = cache.kernels[{sr, static_cast<float>(decay)}];
  if (auto found = slot.lock()) return found;
  std::vector<float> left(irLength), right(irLength), scratch(garak_rs_rig_reverb_scratch_len(sr));
  if (!garak_rs_rig_reverb_generate_ir(sr, decay, left.data(), right.data(), irLength, scratch.data(), scratch.size()))
    throw std::runtime_error("Rust guitar rig reverb impulse generation failed");
  auto kernels = std::make_shared<std::vector<float>>(garak_rs_reverb_kernel_len(irLength));
  if (!garak_rs_reverb_prepare_kernels(left.data(), right.data(), irLength, kernels->data(), kernels->size()))
    throw std::runtime_error("Rust guitar rig reverb kernel preparation failed");
  std::shared_ptr<const std::vector<float>> result = std::move(kernels);
  slot = result;
  cache.recent.push_back(result);
  while (cache.recent.size() > 4) cache.recent.pop_front();
  if (cache.kernels.size() > 64) std::erase_if(cache.kernels, [](const auto& item) { return item.second.expired(); });
  return result;
}

class RustGuitarRig final : public StereoProcessor {
 public:
  RustGuitarRig(const Parameters& params, double sr) {
    Reader p(params, guitarRigDefs());  // the same validation (and exceptions) as the C++ path
    defs_ = p.defs();
    if (garak_rs_rig_param_count() != defs_.size()) throw std::logic_error("Rust and C++ guitar rig catalogs differ");
    values_.resize(defs_.size());
    for (std::size_t i = 0; i < defs_.size(); ++i) {
      char id[64];
      const auto length = garak_rs_rig_param_id(static_cast<std::uint32_t>(i), id, sizeof id);
      if (std::string_view(id, std::min(length, sizeof id)) != defs_[i].name) throw std::logic_error("Rust and C++ guitar rig catalogs differ");
      values_[i] = p(defs_[i].name);
    }
    const auto count = static_cast<std::uint32_t>(values_.size());
    double decays[GARAK_RS_RIG_MAX_REVERBS]{};
    const std::uint32_t reverbs = garak_rs_rig_reverb_decays(values_.data(), count, decays);
    const std::size_t irLength = reverbs ? garak_rs_rig_reverb_ir_len(sr) : 0;
    const float* pointers[GARAK_RS_RIG_MAX_REVERBS]{};
    std::size_t lengths[GARAK_RS_RIG_MAX_REVERBS]{};
    for (unsigned i = 0; i < GARAK_RS_RIG_MAX_REVERBS; ++i) {
      if (!(reverbs >> i & 1u)) continue;
      kernels_[i] = rustRigKernels(sr, decays[i], irLength);
      pointers[i] = kernels_[i]->data(); lengths[i] = kernels_[i]->size();
    }
    storage_.resize(garak_rs_rig_storage_len(sr, values_.data(), count, irLength));
    state_ = static_cast<GarakRsRig*>(::operator new(garak_rs_rig_size(), std::align_val_t(garak_rs_rig_align())));
    const int rc = garak_rs_rig_init(state_, sr, values_.data(), count, storage_.data(), storage_.size(), pointers, lengths, irLength);
    if (rc != GARAK_RS_OK) {
      ::operator delete(state_, std::align_val_t(garak_rs_rig_align()));
      state_ = nullptr;
      throw std::invalid_argument("Rust guitar rig initialisation failed (" + std::to_string(rc) + ")");
    }
  }
  ~RustGuitarRig() override { if (state_) ::operator delete(state_, std::align_val_t(garak_rs_rig_align())); }
  RustGuitarRig(const RustGuitarRig&) = delete;
  RustGuitarRig& operator=(const RustGuitarRig&) = delete;

  void process(float* stereo, std::uint32_t frames) noexcept override { garak_rs_rig_process(state_, stereo, frames); }
  void reset() noexcept override { garak_rs_rig_reset(state_); }
  void takeStateFrom(StereoProcessor& previous) noexcept override {
    auto* p = dynamic_cast<RustGuitarRig*>(&previous);
    if (!p) return;
    // Rust swapped its views of the two state buffers: swap the owners to match (O(1)).
    if (garak_rs_rig_take_state(state_, p->state_)) storage_.swap(p->storage_);
  }
  std::uint32_t latencyFrames() const noexcept override { return garak_rs_rig_latency(state_); }
  double tailSeconds() const noexcept override { return garak_rs_rig_tail(state_); }
  // The rack layout is structural and never automated; each module re-reads its own knobs.
  void automate(const Reader& p) noexcept override {
    for (std::size_t i = 0; i < defs_.size(); ++i) values_[i] = p(defs_[i].name);
    garak_rs_rig_automate(state_, values_.data(), static_cast<std::uint32_t>(values_.size()));
  }
  void sharedResources(std::vector<SharedResource>& out) const override {
    for (const auto& k : kernels_) if (k) out.push_back({k.get(), k->size() * sizeof(float)});
  }

 private:
  GarakRsRig* state_ = nullptr;
  std::vector<float> storage_;
  std::array<std::shared_ptr<const std::vector<float>>, GARAK_RS_RIG_MAX_REVERBS> kernels_;
  std::vector<Def> defs_;
  std::vector<double> values_;
};

// The rig is not a garak_rs_fx kind; it takes the selection slot after them (C++ side only, no ABI change).
constexpr int kRustGuitarRig = GARAK_RS_FX_COUNT;
int rustSelectionKind(std::string_view type) noexcept { return type == "guitar-rig" ? kRustGuitarRig : rustKind(type); }

// Per-type backend choice. Defaults come from the GARAK_RUST_EFFECTS CMake list and the
// GARAK_RUST_EFFECTS environment variable ("all", "none"/"cpp", or comma-separated type ids, applied left to right); empty = C++ only.
// Release desktop builds default to "all"; GARAK_RUST_EFFECTS=none at run time goes back to C++.
std::array<std::atomic<bool>, GARAK_RS_FX_COUNT + 1>& rustSelection() {
  static std::array<std::atomic<bool>, GARAK_RS_FX_COUNT + 1> selected{};
  static const bool initialised = [] {
    auto apply = [](std::string_view list) {
      while (!list.empty()) {
        const auto comma = list.find_first_of(",; ");
        const auto item = list.substr(0, comma);
        if (item == "all") for (auto& v : selected) v.store(true);
        else if (item == "none" || item == "cpp") for (auto& v : selected) v.store(false);
        else if (const int kind = rustSelectionKind(item); kind >= 0) selected[static_cast<std::size_t>(kind)].store(true);
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

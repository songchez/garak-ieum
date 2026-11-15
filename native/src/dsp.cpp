#include "garak/dsp.hpp"

// 1 when CMake links the Rust DSP core (-DGARAK_RUST=ON, native/cmake/GarakRust.cmake).
#ifndef GARAK_RUST
#define GARAK_RUST 0
#endif
#if GARAK_RUST
#include "garak_rust.h"
#include <cstdlib>
#include <new>
#endif

#include <algorithm>
#include <complex>
#include <deque>
#include <string>
#include <limits>
#include <stdexcept>
#include <utility>
#include <vector>

namespace garak::dsp {
namespace {
double bounded(double v, double lo, double hi) noexcept { return std::clamp(v, lo, hi); }
} // namespace
struct Def { const char* name; double fallback, minimum, maximum; };
class Reader {
 public:
  Reader(const Parameters& p, std::initializer_list<Def> defs) : Reader(p, std::vector<Def>(defs)) {}
  Reader(const Parameters& p, std::vector<Def> defs) : params_(p), defs_(std::move(defs)) {
    for (const auto& [name, value] : p) {
      const auto it = std::find_if(defs_.begin(), defs_.end(), [&](const Def& d) { return name == d.name; });
      if (it == defs_.end()) throw std::invalid_argument("Unknown effect parameter: " + name);
      if (!std::isfinite(value) || value < it->minimum || value > it->maximum)
        throw std::invalid_argument("Invalid effect parameter: " + name);
    }
  }
  double operator()(std::string_view id) const {
    if (const auto p = params_.find(id); p != params_.end()) return p->second;
    for (const auto& def : defs_) if (id == def.name) return def.fallback;
    throw std::invalid_argument("Unknown native effect parameter definition");
  }
  [[nodiscard]] const std::vector<Def>& defs() const noexcept { return defs_; }
 private:
  const Parameters& params_;
  std::vector<Def> defs_;
};
namespace {

class DelayLine {
 public:
  explicit DelayLine(std::size_t frames) : data_((frames + 3) * 2), stamps_(frames + 3) {}
  float read(double delay, unsigned channel) const noexcept {
    delay = bounded(delay, 0, static_cast<double>(stamps_.size() - 2));
    const auto whole = static_cast<std::size_t>(delay);
    const auto a = (write_ + stamps_.size() - whole) % stamps_.size();
    const auto b = (a + stamps_.size() - 1) % stamps_.size();
    const float av = stamps_[a] == generation_ ? data_[a * 2 + channel] : 0;
    const float bv = stamps_[b] == generation_ ? data_[b * 2 + channel] : 0;
    return av + static_cast<float>(delay - whole) * (bv - av);
  }
  void put(float left, float right) noexcept {
    data_[write_ * 2] = left; data_[write_ * 2 + 1] = right; stamps_[write_] = generation_;
  }
  void advance() noexcept { if (++write_ == stamps_.size()) write_ = 0; }
  void reset() noexcept { ++generation_; if (!generation_) ++generation_; write_ = 0; }
  void takeStateFrom(DelayLine& previous) noexcept {
    if (data_.size() != previous.data_.size()) return;
    data_.swap(previous.data_); stamps_.swap(previous.stamps_);
    std::swap(write_, previous.write_); std::swap(generation_, previous.generation_);
  }
 private:
  std::vector<float> data_;
  std::vector<std::uint64_t> stamps_;
  std::size_t write_ = 0;
  std::uint64_t generation_ = 1;
};

class Compressor final : public StereoProcessor {
 public:
  Compressor(double rate, double threshold, double ratio, double attack, double release,
             double makeup, double knee = 6) noexcept : rate_(rate), knee_(knee) { set(threshold, ratio, attack, release, makeup); }
  void set(double threshold, double ratio, double attack, double release, double makeup) noexcept {
    threshold_ = threshold; strength_ = 1 - 1 / ratio; attack_ = std::exp(-1 / (std::max(.00001, attack) * rate_));
    release_ = std::exp(-1 / (std::max(.00001, release) * rate_)); makeup_ = makeup;
  }
  void automate(const Reader& p) noexcept override { set(p("threshold"), p("ratio"), p("attack") * .001, p("release") * .001, dbToGain(p("makeup"))); }
  void process(float* s, std::uint32_t frames) noexcept override {
    double loudest = 0, lowest = 1;
    for (std::uint32_t i = 0; i < frames; ++i) {
      const double peak = std::max(std::abs(s[2 * i]), std::abs(s[2 * i + 1]));
      const double c = peak > envelope_ ? attack_ : release_;
      envelope_ = peak + c * (envelope_ - peak);
      const double above = 20 * std::log10(std::max(1e-12, envelope_)) - threshold_;
      const double over = above < -knee_ / 2 ? 0 : above < knee_ / 2 ? (above + knee_ / 2) * (above + knee_ / 2) / (2 * knee_) : above;
      const double reduction = dbToGain(-strength_ * over);
      const float gain = static_cast<float>(reduction * makeup_);
      s[2 * i] *= gain; s[2 * i + 1] *= gain;
      loudest = std::max(loudest, peak); lowest = std::min(lowest, reduction);
    }
    tap_.add(static_cast<float>(loudest), static_cast<float>(lowest));
  }
  DynamicsTap* dynamics() noexcept override { return &tap_; }
  void reset() noexcept override { envelope_ = 0; }
  void takeStateFrom(StereoProcessor& previous) noexcept override {
    if (auto* p = dynamic_cast<Compressor*>(&previous)) envelope_ = p->envelope_;
  }
 private:
  double rate_, threshold_ = 0, strength_ = 0, attack_ = 0, release_ = 0, makeup_ = 1, knee_, envelope_ = 0;
  DynamicsTap tap_;
};

// 17-tap half-band interpolator and decimator. Together they introduce eight
// base-rate frames, which are exposed to graph delay compensation.
class Saturator {
 public:
  Saturator(double amount, double bias = 0) : amount_(amount), bias_(bias), origin_(std::tanh(bias)) {
    normal_ = std::max(std::tanh(amount + bias) - origin_, origin_ - std::tanh(-amount + bias));
    double sum = 0;
    for (int i = 0; i < 17; ++i) {
      const double x = i - 8;
      const double sinc = x == 0 ? .5 : std::sin(pi * .5 * x) / (pi * x);
      coefficients_[i] = sinc * (.5 - .5 * std::cos(2 * pi * i / 16));
      sum += coefficients_[i];
    }
    for (auto& c : coefficients_) c /= sum;
  }
  float sample(float input, unsigned channel) noexcept {
    const double upA = filter(2 * input, up_[channel], upWrite_[channel]);
    const double a = filter(shape(upA), down_[channel], downWrite_[channel]);
    const double upB = filter(0, up_[channel], upWrite_[channel]);
    (void)filter(shape(upB), down_[channel], downWrite_[channel]);
    return static_cast<float>(a);
  }
  void reset() noexcept { up_ = {}; down_ = {}; upWrite_ = {}; downWrite_ = {}; }
  void takeStateFrom(const Saturator& previous) noexcept {
    up_ = previous.up_; down_ = previous.down_; upWrite_ = previous.upWrite_; downWrite_ = previous.downWrite_;
  }
 private:
  double shape(double x) const noexcept { return (std::tanh(amount_ * bounded(x, -1, 1) + bias_) - origin_) / normal_; }
  double filter(double x, std::array<double, 17>& state, unsigned& write) noexcept {
    state[write] = x; double output = 0;
    for (unsigned i = 0; i < 17; ++i) output += coefficients_[i] * state[(write + 17 - i) % 17];
    write = (write + 1) % 17;
    return output;
  }
  double amount_, bias_, origin_, normal_;
  std::array<double, 17> coefficients_{};
  std::array<std::array<double, 17>, 2> up_{}, down_{};
  std::array<unsigned, 2> upWrite_{}, downWrite_{};
};

class Drive final : public StereoProcessor {
 public:
  Drive(double sr, const Reader& p) : shaper_(2.5), dry_(8), sampleRate_(sr) { configure(p, false); }
  void configure(const Reader& p, bool glide) noexcept {
    pre_ = dbToGain(p("drive")); wet_ = p("mix"); output_ = dbToGain(p("output"));
    tone_.configure(Filter::Lowpass, sampleRate_, p("tone"), 1, 0, glide);
    post_ = output_ / std::sqrt(pre_ * 2.53);
  }
  void automate(const Reader& p) noexcept override { configure(p, true); }
  void process(float* s, std::uint32_t frames) noexcept override {
    for (std::uint32_t i = 0; i < frames; ++i) {
      dry_.put(s[2 * i], s[2 * i + 1]);
      for (unsigned c = 0; c < 2; ++c) {
        const float wet = tone_.sample(shaper_.sample(static_cast<float>(s[2 * i + c] * pre_), c), c);
        s[2 * i + c] = static_cast<float>(dry_.read(8, c) * (1 - wet_) * output_ + wet * wet_ * post_);
      }
      dry_.advance();
    }
  }
  void reset() noexcept override { shaper_.reset(); tone_.reset(); dry_.reset(); }
  void takeStateFrom(StereoProcessor& previous) noexcept override {
    if (auto* p = dynamic_cast<Drive*>(&previous)) { shaper_.takeStateFrom(p->shaper_); tone_.takeHistoryFrom(p->tone_); dry_.takeStateFrom(p->dry_); }
  }
  std::uint32_t latencyFrames() const noexcept override { return 8; }
 private:
  Saturator shaper_; Biquad tone_; DelayLine dry_;
  double sampleRate_, pre_ = 1, wet_ = 1, output_ = 1, post_ = 1;
};

class Delay final : public StereoProcessor {
 public:
  Delay(double sr, double seconds, double wet, double feedback, double tone, bool bandLimited = false)
      : line_(static_cast<std::size_t>(sr * 4.1)), frames_(seconds * sr), wet_(wet), feedback_(feedback),
        filteredOutput_(bandLimited) {
    low_.configure(Filter::Lowpass, sr, tone, bandLimited ? .5 : 1);
    high_.configure(Filter::Highpass, sr, 120, .5);
    const double repeats = feedback > .01 ? std::ceil(std::log(.001) / std::log(feedback)) : 1;
    tail_ = wet > 0 ? std::min(30.0, seconds * (repeats + 1) + .85) : 0;
  }
  void process(float* s, std::uint32_t frames) noexcept override {
    for (std::uint32_t i = 0; i < frames; ++i) {
      float next[2]{};
      for (unsigned c = 0; c < 2; ++c) {
        const float delayed = line_.read(frames_, c);
        float filtered = low_.sample(delayed, c);
        if (filteredOutput_) filtered = high_.sample(filtered, c);
        next[c] = static_cast<float>(s[2 * i + c] + feedback_ * filtered);
        s[2 * i + c] += static_cast<float>(wet_ * (filteredOutput_ ? filtered : delayed));
      }
      line_.put(next[0], next[1]); line_.advance();
    }
  }
  void set(double sr, double seconds, double wet, double feedback) noexcept { frames_ = seconds * sr; wet_ = wet; feedback_ = feedback; }
  void reset() noexcept override { line_.reset(); low_.reset(); high_.reset(); }
  void takeStateFrom(StereoProcessor& previous) noexcept override {
    if (auto* p = dynamic_cast<Delay*>(&previous)) { line_.takeStateFrom(p->line_); low_.takeHistoryFrom(p->low_); high_.takeHistoryFrom(p->high_); }
  }
  double tailSeconds() const noexcept override { return tail_; }
 private:
  DelayLine line_; Biquad low_, high_;
  double frames_, wet_, feedback_, tail_; bool filteredOutput_;
};

class Fft {
 public:
  explicit Fft(std::size_t n) : size_(n), reversed_(n), roots_(n / 2) {
    unsigned bits = 0; for (auto s = n; s > 1; s >>= 1) ++bits;
    for (std::size_t i = 0; i < n; ++i) {
      auto value = i; std::size_t reverse = 0;
      for (unsigned bit = 0; bit < bits; ++bit) { reverse = (reverse << 1) | (value & 1); value >>= 1; }
      reversed_[i] = reverse;
    }
    for (std::size_t i = 0; i < n / 2; ++i) roots_[i] = std::polar(1.0f, static_cast<float>(-2 * pi * i / n));
  }
  void run(std::span<std::complex<float>> data, bool inverse = false) const noexcept {
    for (std::size_t i = 0; i < size_; ++i) if (reversed_[i] > i) std::swap(data[i], data[reversed_[i]]);
    for (std::size_t n = 2; n <= size_; n <<= 1) {
      const auto half = n / 2, stride = size_ / n;
      for (std::size_t offset = 0; offset < size_; offset += n) for (std::size_t j = 0; j < half; ++j) {
        const auto root = inverse ? std::conj(roots_[j * stride]) : roots_[j * stride];
        const auto odd = data[offset + j + half] * root, even = data[offset + j];
        data[offset + j] = even + odd; data[offset + j + half] = even - odd;
      }
    }
    if (inverse) for (auto& x : data) x /= static_cast<float>(size_);
  }
 private:
  std::size_t size_; std::vector<std::size_t> reversed_; std::vector<std::complex<float>> roots_;
};

// A partition's first IR frame is >= its block size. Thus its FFT result is
// available before the earliest affected output frame; no extra reverb latency.
class ConvolutionGroup {
 public:
  ConvolutionGroup(std::span<const float> ir, std::size_t base, std::size_t block)
      : block_(block), base_(base), count_((ir.size() + block - 1) / block), fft_(block * 2),
        kernels_(count_ * block * 2), history_(kernels_.size()), historyGeneration_(count_),
        input_(block * 2), sum_(block * 2), output_(base + 3 * block), outputGeneration_(output_.size()) {
    for (std::size_t p = 0; p < count_; ++p) {
      auto kernel = std::span(kernels_).subspan(p * block * 2, block * 2);
      for (std::size_t i = 0; i < block && p * block + i < ir.size(); ++i) kernel[i] = ir[p * block + i];
      fft_.run(kernel);
    }
  }
  float sample(float input) noexcept {
    const float result = outputGeneration_[outputRead_] == generation_ ? output_[outputRead_] : 0;
    outputGeneration_[outputRead_] = 0;
    input_[inputFill_++] = input;
    if (inputFill_ == block_) {
      std::fill(input_.begin() + static_cast<std::ptrdiff_t>(block_), input_.end(), std::complex<float>{});
      fft_.run(input_);
      auto destination = std::span(history_).subspan(historyWrite_ * block_ * 2, block_ * 2);
      std::copy(input_.begin(), input_.end(), destination.begin());
      historyGeneration_[historyWrite_] = generation_;
      std::fill(sum_.begin(), sum_.end(), std::complex<float>{});
      for (std::size_t p = 0; p < count_; ++p) {
        const auto slot = (historyWrite_ + count_ - p) % count_;
        if (historyGeneration_[slot] != generation_) continue;
        const auto* x = history_.data() + slot * block_ * 2;
        const auto* h = kernels_.data() + p * block_ * 2;
        for (std::size_t j = 0; j < block_ * 2; ++j) sum_[j] += x[j] * h[j];
      }
      fft_.run(sum_, true);
      const auto start = (outputRead_ + 1 + base_ - block_) % output_.size();
      for (std::size_t j = 0; j < block_ * 2; ++j) {
        const auto slot = (start + j) % output_.size();
        if (outputGeneration_[slot] != generation_) { output_[slot] = 0; outputGeneration_[slot] = generation_; }
        output_[slot] += sum_[j].real();
      }
      historyWrite_ = (historyWrite_ + 1) % count_; inputFill_ = 0;
    }
    outputRead_ = (outputRead_ + 1) % output_.size();
    return result;
  }
  void reset() noexcept { ++generation_; if (!generation_) ++generation_; inputFill_ = historyWrite_ = outputRead_ = 0; }
  void takeStateFrom(ConvolutionGroup& previous) noexcept {
    if (block_ != previous.block_ || base_ != previous.base_ || count_ != previous.count_) return;
    history_.swap(previous.history_); historyGeneration_.swap(previous.historyGeneration_);
    input_.swap(previous.input_); output_.swap(previous.output_); outputGeneration_.swap(previous.outputGeneration_);
    std::swap(inputFill_, previous.inputFill_); std::swap(historyWrite_, previous.historyWrite_);
    std::swap(outputRead_, previous.outputRead_); std::swap(generation_, previous.generation_);
  }
 private:
  std::size_t block_, base_, count_; Fft fft_;
  std::vector<std::complex<float>> kernels_, history_;
  std::vector<std::uint64_t> historyGeneration_;
  std::vector<std::complex<float>> input_, sum_;
  std::vector<float> output_; std::vector<std::uint64_t> outputGeneration_;
  std::size_t inputFill_ = 0, historyWrite_ = 0, outputRead_ = 0;
  std::uint64_t generation_ = 1;
};

class Convolver {
 public:
  explicit Convolver(const std::vector<float>& ir) {
    const auto head = std::min<std::size_t>(64, ir.size());
    std::copy_n(ir.begin(), head, head_.begin());
    if (ir.size() > 64) groups_.emplace_back(std::span(ir).subspan(64, std::min<std::size_t>(448, ir.size() - 64)), 64, 64);
    if (ir.size() > 512) groups_.emplace_back(std::span(ir).subspan(512, std::min<std::size_t>(3584, ir.size() - 512)), 512, 512);
    if (ir.size() > 4096) groups_.emplace_back(std::span(ir).subspan(4096), 4096, 2048);
  }
  float sample(float x) noexcept {
    history_[write_] = x; double out = 0;
    for (std::size_t i = 0; i < 64; ++i) out += head_[i] * history_[(write_ + 64 - i) % 64];
    write_ = (write_ + 1) % 64;
    for (auto& group : groups_) out += group.sample(x);
    return static_cast<float>(out);
  }
  void reset() noexcept { history_ = {}; write_ = 0; for (auto& group : groups_) group.reset(); }
  void takeStateFrom(Convolver& previous) noexcept {
    if (groups_.size() != previous.groups_.size()) return;
    history_ = previous.history_; write_ = previous.write_;
    for (std::size_t i = 0; i < groups_.size(); ++i) groups_[i].takeStateFrom(previous.groups_[i]);
  }
 private:
  std::array<float, 64> head_{}, history_{}; std::size_t write_ = 0;
  std::vector<ConvolutionGroup> groups_;
};

// Space 0 hall, 1 room, 2 plate, 3 spring; keep in sync with src/devices/effects/reverb.ts reverbImpulse().
std::array<std::vector<float>, 2> impulse(double sr, double seconds, std::uint32_t seed, int space = 0) {
  const auto length = static_cast<std::size_t>(std::ceil(sr * seconds));
  std::array<std::vector<float>, 2> result{std::vector<float>(length), std::vector<float>(length)};
  const auto comb = static_cast<std::size_t>(std::floor(.0293 * sr + .5));
  double power = 0;
  for (auto& channel : result) {
    double previous = 0, dark = 0;
    for (std::size_t i = 0; i < length; ++i) {
      seed = seed * 1664525u + 1013904223u;
      const double noise = static_cast<double>(seed) / 4294967295.0 * 2 - 1, t = static_cast<double>(i) / length;
      if (space == 0) channel[i] = static_cast<float>(noise * std::pow(1 - t, 3.6));
      else if (space == 1) channel[i] = static_cast<float>(noise * std::pow(1 - t, 4.5));
      else if (space == 2) channel[i] = static_cast<float>((noise - .65 * previous) * std::pow(1 - t, 2.4));
      else { dark += .45 * (noise - dark); channel[i] = static_cast<float>(dark * std::pow(1 - t, 3) + (i >= comb ? .55 * channel[i - comb] : 0)); }
      previous = noise;
      power += static_cast<double>(channel[i]) * channel[i];
    }
  }
  power = std::max(.000125, std::sqrt(power / (length * 2)));
  const auto scale = static_cast<float>(.00125 / power * 44100 / sr);
  for (auto& channel : result) for (auto& value : channel) value *= scale;
  return result;
}

struct ReverbSpace { double shortSeconds; std::uint32_t shortSeed; double longSeconds; std::uint32_t longSeed; };
constexpr std::array<ReverbSpace, 4> kReverbSpaces{{{1.7, 9183, 4.2, 61427}, {.35, 4421, 1.2, 7717}, {1.1, 3301, 3.2, 8803}, {.9, 5153, 2.6, 6007}}};

class Reverb final : public StereoProcessor {
 public:
  Reverb(double sr, const Reader& p) : wet_(p("amount") * .5), dry_(p("dry")), predelay_(static_cast<std::size_t>(sr * .25) + 4),
      delayFrames_(p("predelay") * .001 * sr), lowcut_(p("lowcut") > 20.5) {
    const int space = std::clamp(static_cast<int>(std::lround(p("type"))), 0, 3);
    const auto& spec = kReverbSpaces[static_cast<std::size_t>(space)];
    tail_ = .85 + spec.shortSeconds + p("size") * (spec.longSeconds - spec.shortSeconds) + p("predelay") * .001;
    auto small = impulse(sr, spec.shortSeconds, spec.shortSeed, space), large = impulse(sr, spec.longSeconds, spec.longSeed, space);
    const float size = static_cast<float>(p("size"));
    for (unsigned c = 0; c < 2; ++c) {
      for (std::size_t i = 0; i < large[c].size(); ++i) large[c][i] = large[c][i] * size + (i < small[c].size() ? small[c][i] * (1 - size) : 0);
      channels_[c] = std::make_unique<Convolver>(large[c]);
    }
    tone_.configure(Filter::Lowpass, sr, p("tone"), 1);
    highpass_.configure(Filter::Highpass, sr, p("lowcut"), .5);
    sampleRate_ = sr;
  }
  // Amount, tone and low cut follow automation; size, type and pre-delay shape the prepared impulse response.
  void automate(const Reader& p) noexcept override {
    wet_ = p("amount") * .5; dry_ = p("dry"); lowcut_ = p("lowcut") > 20.5;
    tone_.configure(Filter::Lowpass, sampleRate_, p("tone"), 1, 0, true);
    highpass_.configure(Filter::Highpass, sampleRate_, p("lowcut"), .5, 0, true);
  }
  void process(float* s, std::uint32_t frames) noexcept override {
    for (std::uint32_t i = 0; i < frames; ++i) {
      float in[2]{s[2 * i], s[2 * i + 1]};
      if (delayFrames_ > 0) { predelay_.put(in[0], in[1]); in[0] = predelay_.read(delayFrames_, 0); in[1] = predelay_.read(delayFrames_, 1); predelay_.advance(); }
      for (unsigned c = 0; c < 2; ++c) {
        float wet = tone_.sample(channels_[c]->sample(in[c]), c);
        if (lowcut_) wet = highpass_.sample(wet, c);
        // dry_ = 1 must stay bit-identical to the former `s += wet` (float sum of the two terms).
        s[2 * i + c] = static_cast<float>(dry_ * s[2 * i + c]) + static_cast<float>(wet_ * wet);
      }
    }
  }
  void reset() noexcept override { for (auto& c : channels_) c->reset(); tone_.reset(); highpass_.reset(); predelay_.reset(); }
  void takeStateFrom(StereoProcessor& previous) noexcept override {
    if (auto* p = dynamic_cast<Reverb*>(&previous)) {
      for (std::size_t i = 0; i < channels_.size(); ++i) channels_[i]->takeStateFrom(*p->channels_[i]);
      tone_.takeHistoryFrom(p->tone_); highpass_.takeHistoryFrom(p->highpass_); predelay_.takeStateFrom(p->predelay_);
    }
  }
  double tailSeconds() const noexcept override { return wet_ > 0 ? tail_ : 0; }
 private:
  std::array<std::unique_ptr<Convolver>, 2> channels_; Biquad tone_, highpass_; double wet_, dry_, tail_ = 0;
  DelayLine predelay_; double delayFrames_; bool lowcut_; double sampleRate_ = 48000;
};

class Chorus {
 public:
  Chorus(double sr, double rate, double depth, double mix) : line_(static_cast<std::size_t>(sr * .05) + 4),
      sampleRate_(sr), phaseStep_(2 * pi * rate / sr), depth_(depth), mix_(mix) {}
  void process(float* s, std::uint32_t frames) noexcept {
    for (std::uint32_t i = 0; i < frames; ++i) {
      line_.put(s[2 * i], s[2 * i + 1]);
      const double modulation = std::sin(phase_) * depth_ * .005;
      s[2 * i] = static_cast<float>(s[2 * i] * (1 - mix_ * .5) + line_.read((.014 + modulation) * sampleRate_, 0) * mix_ * .5);
      s[2 * i + 1] = static_cast<float>(s[2 * i + 1] * (1 - mix_ * .5) + line_.read((.017 - modulation) * sampleRate_, 1) * mix_ * .5);
      phase_ += phaseStep_; if (phase_ >= 2 * pi) phase_ -= 2 * pi;
      line_.advance();
    }
  }
  void set(double rate, double depth, double mix) noexcept { phaseStep_ = 2 * pi * rate / sampleRate_; depth_ = depth; mix_ = mix; }
  void reset() noexcept { line_.reset(); phase_ = 0; }
  void takeStateFrom(Chorus& previous) noexcept { line_.takeStateFrom(previous.line_); phase_ = previous.phase_; }
 private:
  DelayLine line_; double sampleRate_, phaseStep_, depth_, mix_, phase_ = 0;
};

// Keep Phaser and Tremolo in sync with src/devices/guitar-rig/modulation.ts (the web worklets).
class Phaser {
 public:
  Phaser(double sr, double rate, double depth, double feedback, bool enabled)
      : sampleRate_(sr), phaseStep_(2 * pi * rate / sr), depth_(depth), feedback_(feedback),
        target_(enabled ? 1 : 0), mix_(target_), smoothing_(1 - std::exp(-1 / (.012 * sr))) {}
  void process(float* s, std::uint32_t frames) noexcept {
    for (std::uint32_t i = 0; i < frames; ++i) {
      if (target_ == 0 && mix_ < 1e-6) { mix_ = 0; continue; }
      mix_ += (target_ - mix_) * smoothing_;
      for (unsigned c = 0; c < 2; ++c) {
        const double x = s[2 * i + c];
        const double lfo = .5 + .5 * std::sin(phase_ + (c ? pi / 2 : 0));
        const double frequency = 200 * std::pow(16.0, .5 + (lfo - .5) * depth_);
        const double t = std::tan(pi * std::min(frequency, sampleRate_ * .45) / sampleRate_), a = (t - 1) / (t + 1);
        double y = x + feedback_ * last_[c];
        for (auto& z : state_[c]) {
          const double output = a * y + z;
          z = y - a * output; if (std::abs(z) < 1e-30) z = 0;
          y = output;
        }
        last_[c] = y;
        s[2 * i + c] = static_cast<float>(x * (1 - mix_) + mix_ * .5 * (x + y));
      }
      phase_ += phaseStep_; if (phase_ >= 2 * pi) phase_ -= 2 * pi;
    }
  }
  void set(double rate, double depth, double feedback, bool enabled) noexcept { phaseStep_ = 2 * pi * rate / sampleRate_; depth_ = depth; feedback_ = feedback; target_ = enabled ? 1 : 0; }
  void reset() noexcept { state_ = {}; last_ = {}; phase_ = 0; }
  void takeStateFrom(const Phaser& previous) noexcept { state_ = previous.state_; last_ = previous.last_; phase_ = previous.phase_; mix_ = previous.mix_; }
 private:
  double sampleRate_, phaseStep_, depth_, feedback_, target_, mix_, smoothing_, phase_ = 0;
  std::array<std::array<double, 6>, 2> state_{}; std::array<double, 2> last_{};
};

class Tremolo {
 public:
  Tremolo(double sr, double rate, double depth, double shape, bool enabled)
      : sampleRate_(sr), phaseStep_(2 * pi * rate / sr), depth_(depth), k_(.01 + shape * 9), target_(enabled ? 1 : 0), enabled_(target_),
        smoothing_(1 - std::exp(-1 / (.012 * sr))) {}
  void process(float* s, std::uint32_t frames) noexcept {
    for (std::uint32_t i = 0; i < frames; ++i) {
      if (target_ == 0 && enabled_ < 1e-6) { enabled_ = 0; continue; }
      enabled_ += (target_ - enabled_) * smoothing_;
      const double wave = std::tanh(k_ * std::sin(phase_)) / std::tanh(k_);
      phase_ += phaseStep_; if (phase_ >= 2 * pi) phase_ -= 2 * pi;
      const auto gain = static_cast<float>(1 - enabled_ * depth_ * .5 * (1 - wave));
      s[2 * i] *= gain; s[2 * i + 1] *= gain;
    }
  }
  void set(double rate, double depth, double shape, bool enabled) noexcept { phaseStep_ = 2 * pi * rate / sampleRate_; depth_ = depth; k_ = .01 + shape * 9; target_ = enabled ? 1 : 0; }
  void reset() noexcept { phase_ = 0; }
  void takeStateFrom(const Tremolo& previous) noexcept { phase_ = previous.phase_; enabled_ = previous.enabled_; }
 private:
  double sampleRate_, phaseStep_, depth_, k_, target_, enabled_, smoothing_, phase_ = 0;
};

// User-arranged rack (src/devices/guitar-rig/definition.ts GUITAR_RIG_MODULES): 1 comp, 2 drive,
// 3 amp, 4 cabinet, 5 chorus, 6 delay, 7 fuzz, 8 phaser, 9 tremolo, 10 reverb, 11 tuner. A slot stores
// `code + 16 x instance`; instance 0 reads the original parameter names and instance k > 0 appends
// `_<k+1>` (driveGain_2). The tuner allows a single instance.
constexpr int kRigModuleCodes = 12, kRigInstanceStride = 16, kRigMaxInstances = 3, kRigSlots = 18;
constexpr int rigMaxInstances(int code) noexcept { return code == 11 ? 1 : kRigMaxInstances; }
const std::array<std::vector<const char*>, kRigModuleCodes> kRigModuleParams{{
  {},
  {"compEnabled", "compSustain", "compAttack", "compLevel"},
  {"driveEnabled", "driveGain", "driveTone", "driveLevel"},
  {"ampEnabled", "ampGain", "ampBass", "ampMid", "ampTreble", "ampPresence", "ampLevel", "ampModel"},
  {"cabinetEnabled", "cabinet", "micType", "micPosition", "micDistance"},
  {"chorusEnabled", "chorusRate", "chorusDepth", "chorusMix"},
  {"delayEnabled", "delayTime", "delayFeedback", "delayMix"},
  {"fuzzEnabled", "fuzzGain", "fuzzTone", "fuzzLevel"},
  {"phaserEnabled", "phaserRate", "phaserDepth", "phaserFeedback"},
  {"tremoloEnabled", "tremoloRate", "tremoloDepth", "tremoloShape"},
  {"reverbEnabled", "reverbDecay", "reverbTone", "reverbMix"},
  {"tunerEnabled"},
}};

const std::vector<Def>& guitarRigDefs() {
  static const std::vector<Def> defs = [] {
    static const Def base[] = {{"compSustain",.35,0,1},{"compAttack",10,.5,50},{"compLevel",0,-18,18},
      {"driveGain",9,0,30},{"driveTone",.5,0,1},{"driveLevel",-3,-24,12},{"chorusRate",.8,.1,5},{"chorusDepth",.35,0,1},{"chorusMix",.25,0,.6},
      {"delayTime",320,30,1200},{"delayFeedback",.3,0,.85},{"delayMix",.2,0,.6},{"ampGain",10,0,36},{"ampBass",0,-12,12},{"ampMid",0,-12,12},
      {"ampTreble",0,-12,12},{"ampPresence",0,-9,9},{"ampLevel",-6,-36,6},{"compEnabled",1,0,1},{"driveEnabled",0,0,1},{"chorusEnabled",0,0,1},
      {"delayEnabled",0,0,1},{"ampEnabled",1,0,1},{"cabinetEnabled",1,0,1},{"ampModel",0,0,4},{"cabinet",1,0,4},{"micType",0,0,4},
      {"micPosition",.35,0,1},{"micDistance",.15,0,1},
      {"fuzzGain",26,0,40},{"fuzzTone",.45,0,1},{"fuzzLevel",-14,-36,0},{"phaserRate",.45,.05,4},{"phaserDepth",.7,0,1},{"phaserFeedback",.35,0,.85},
      {"tremoloRate",4.5,.5,12},{"tremoloDepth",.5,0,1},{"tremoloShape",0,0,1},{"reverbDecay",.45,0,1},{"reverbTone",.5,0,1},{"reverbMix",.25,0,.8},
      {"fuzzEnabled",0,0,1},{"phaserEnabled",0,0,1},{"tremoloEnabled",0,0,1},{"reverbEnabled",0,0,1},{"tunerEnabled",0,0,1}};
    static std::deque<std::string> names;  // stable storage for the generated names
    std::vector<Def> out(std::begin(base), std::end(base));
    for (int code = 1; code < kRigModuleCodes; ++code) for (int instance = 1; instance < rigMaxInstances(code); ++instance)
      for (const char* param : kRigModuleParams[code]) {
        const auto it = std::find_if(std::begin(base), std::end(base), [&](const Def& d) { return std::string_view(d.name) == param; });
        names.push_back(std::string(param) + "_" + std::to_string(instance + 1));
        out.push_back({names.back().c_str(), it->fallback, it->minimum, it->maximum});
      }
    const std::array<double, kRigSlots> slotDefaults{1, 2, 3, 4, 5, 6};
    const double maxSlot = kRigModuleCodes - 1 + kRigInstanceStride * (kRigMaxInstances - 1);
    for (int slot = 0; slot < kRigSlots; ++slot) {
      names.push_back("rackSlot" + std::to_string(slot));
      out.push_back({names.back().c_str(), slotDefaults[slot], 0, maxSlot});
    }
    return out;
  }();
  return defs;
}

// "<base>_<k+1>" names of instances 1 and 2, built once with guitarRigDefs() so reads never allocate.
const char* rigInstanceName(const char* base, int instance) noexcept {
  for (const auto& def : guitarRigDefs()) {
    const std::string_view name = def.name, prefix = base;
    if (name.size() == prefix.size() + 2 && name.substr(0, prefix.size()) == prefix && name[prefix.size()] == '_' && name[prefix.size() + 1] == '1' + instance) return def.name;
  }
  return base;
}
// Reads one module instance's parameters by their base names.
struct RigParams {
  const Reader& reader; int instance;
  double operator()(const char* base) const { return instance ? reader(rigInstanceName(base, instance)) : reader(base); }
  bool on(const char* base) const { return (*this)(base) >= .5; }
};

class RigModule {
 public:
  RigModule(int code, int instance) : code_(code), instance_(instance) {}
  virtual ~RigModule() = default;
  virtual void process(float* s, std::uint32_t frames) noexcept = 0;
  virtual void reset() noexcept = 0;
  virtual void takeStateFrom(RigModule& previous) noexcept = 0;
  virtual std::uint32_t latencyFrames() const noexcept { return 0; }
  virtual double tailSeconds() const noexcept { return 0; }
  // Automation: re-read this instance's parameters (no allocation; see StereoProcessor::automate).
  virtual void automate(const RigParams&) noexcept {}
  int code() const noexcept { return code_; }
  int instance() const noexcept { return instance_; }
 private:
  int code_, instance_;
};

class RigComp final : public RigModule {
 public:
  RigComp(double sr, const RigParams& p) : RigModule(1, p.instance), comp_(sr, -12 - p("compSustain") * 30, 1 + p("compSustain") * 7,
      p("compAttack") * .001, .09 + p("compSustain") * .1, dbToGain(p("compLevel") + p("compSustain") * 6)), enabled_(p.on("compEnabled")) {}
  void automate(const RigParams& p) noexcept override {
    comp_.set(-12 - p("compSustain") * 30, 1 + p("compSustain") * 7, p("compAttack") * .001, .09 + p("compSustain") * .1, dbToGain(p("compLevel") + p("compSustain") * 6));
    enabled_ = p.on("compEnabled");
  }
  void process(float* s, std::uint32_t frames) noexcept override { if (enabled_) comp_.process(s, frames); }
  void reset() noexcept override { comp_.reset(); }
  void takeStateFrom(RigModule& previous) noexcept override { if (auto* p = dynamic_cast<RigComp*>(&previous)) comp_.takeStateFrom(p->comp_); }
 private:
  Compressor comp_; bool enabled_;
};

class RigDrive final : public RigModule {
 public:
  RigDrive(double sr, const RigParams& p) : RigModule(2, p.instance), shaper_(2.8, .12), enabled_(p.on("driveEnabled")), sampleRate_(sr) {
    pre_ = dbToGain(p("driveGain")); post_ = dbToGain(p("driveLevel")) / std::pow(pre_, .4);
    input_.configure(Filter::Highpass, sr, 95, .707); dc_.configure(Filter::Highpass, sr, 25, .707);
    tone_.configure(Filter::Lowpass, sr, 1200 * std::pow(8, p("driveTone")), .707);
  }
  void automate(const RigParams& p) noexcept override {
    pre_ = dbToGain(p("driveGain")); post_ = dbToGain(p("driveLevel")) / std::pow(pre_, .4); enabled_ = p.on("driveEnabled");
    tone_.configure(Filter::Lowpass, sampleRate_, 1200 * std::pow(8, p("driveTone")), .707, 0, true);
  }
  void process(float* s, std::uint32_t frames) noexcept override {
    if (enabled_) for (std::uint32_t i = 0; i < frames; ++i) for (unsigned c = 0; c < 2; ++c) {
      float x = input_.sample(s[2 * i + c], c);
      x = shaper_.sample(static_cast<float>(x * pre_), c);
      s[2 * i + c] = static_cast<float>(dc_.sample(tone_.sample(x,c),c) * post_);
    }
  }
  void reset() noexcept override { shaper_.reset(); input_.reset(); tone_.reset(); dc_.reset(); }
  void takeStateFrom(RigModule& previous) noexcept override {
    if (auto* p = dynamic_cast<RigDrive*>(&previous)) {
      shaper_.takeStateFrom(p->shaper_); input_.takeHistoryFrom(p->input_); tone_.takeHistoryFrom(p->tone_); dc_.takeHistoryFrom(p->dc_);
    }
  }
  std::uint32_t latencyFrames() const noexcept override { return enabled_ ? 8u : 0u; }
 private:
  Saturator shaper_; Biquad input_, tone_, dc_; double pre_ = 1, post_ = 1; bool enabled_; double sampleRate_;
};

class RigAmp final : public RigModule {
 public:
  RigAmp(double sr, const RigParams& p) : RigModule(3, p.instance), shaper_(2.4, .08), power_(2.4 * .65, -.08), enabled_(p.on("ampEnabled")), sampleRate_(sr) { configure(p, false); }
  void automate(const RigParams& p) noexcept override { enabled_ = p.on("ampEnabled"); configure(p, true); }
  void configure(const RigParams& p, bool glide) noexcept {
    const double sr = sampleRate_;
    const int model = std::clamp(static_cast<int>(std::round(p("ampModel"))), 0, 4);
    const double gain = dbToGain(p("ampGain"));
    // Keep in sync with src/devices/guitar-rig/voicing.ts: 0 clean, 1 crunch, 2 lead, 3 chime, 4 jazz clean.
    const std::array<double, 5> pre{.55, 1.5, 3.5, 1.0, .4}, inter{.8, 1.2, 1.65, 1.05, .7}, highpass{45, 75, 100, 90, 40}, lowpass{9500, 6600, 5200, 8200, 6000}, compensation{.9, .55, .42, .7, 1.0};
    pre_ = gain * pre[model]; inter_ = inter[model]; post_ = dbToGain(p("ampLevel")) * compensation[model] / std::pow(gain, .15);
    input_.configure(Filter::Highpass, sr, highpass[model], .707, 0, glide); interFilter_.configure(Filter::Lowpass, sr, lowpass[model], .707, 0, glide); dc_.configure(Filter::Highpass, sr, 25, .707, 0, glide);
    eq_[0].configure(Filter::LowShelf, sr, 150, .707, p("ampBass"), glide); eq_[1].configure(Filter::Peak, sr, 750, .8, p("ampMid"), glide);
    eq_[2].configure(Filter::HighShelf, sr, 2600, .707, p("ampTreble"), glide); eq_[3].configure(Filter::HighShelf, sr, 4200, .707, p("ampPresence"), glide);
  }
  void process(float* s, std::uint32_t frames) noexcept override {
    if (enabled_) for (std::uint32_t i = 0; i < frames; ++i) for (unsigned c = 0; c < 2; ++c) {
      float x = input_.sample(s[2 * i + c], c);
      x = shaper_.sample(static_cast<float>(x * pre_), c);
      x = power_.sample(static_cast<float>(interFilter_.sample(x,c) * inter_), c);
      x = dc_.sample(x,c); for (auto& f : eq_) x = f.sample(x,c);
      s[2 * i + c] = static_cast<float>(x * post_);
    }
  }
  void reset() noexcept override {
    shaper_.reset(); power_.reset(); input_.reset(); interFilter_.reset(); dc_.reset(); for (auto& f : eq_) f.reset();
  }
  void takeStateFrom(RigModule& previous) noexcept override {
    if (auto* p = dynamic_cast<RigAmp*>(&previous)) {
      shaper_.takeStateFrom(p->shaper_); power_.takeStateFrom(p->power_);
      input_.takeHistoryFrom(p->input_); interFilter_.takeHistoryFrom(p->interFilter_); dc_.takeHistoryFrom(p->dc_);
      for (std::size_t i = 0; i < eq_.size(); ++i) eq_[i].takeHistoryFrom(p->eq_[i]);
    }
  }
  std::uint32_t latencyFrames() const noexcept override { return enabled_ ? 16u : 0u; }
 private:
  Saturator shaper_, power_; Biquad input_, interFilter_, dc_; std::array<Biquad, 4> eq_;
  double pre_ = 1, inter_ = 1, post_ = 1; bool enabled_; double sampleRate_;
};

class RigCabinet final : public RigModule {
 public:
  RigCabinet(double sr, const RigParams& p) : RigModule(4, p.instance), enabled_(p.on("cabinetEnabled")), sampleRate_(sr) { configure(p, false); }
  void automate(const RigParams& p) noexcept override { enabled_ = p.on("cabinetEnabled"); configure(p, true); }
  void configure(const RigParams& p, bool glide) noexcept {
    const double sr = sampleRate_;
    const int cab = std::clamp(static_cast<int>(std::round(p("cabinet"))), 0, 4), mic = std::clamp(static_cast<int>(std::round(p("micType"))), 0, 4);
    const double edge = p("micPosition"), far = p("micDistance");
    const std::array<double, 5> hp{95,75,62,120,85}, resonance{145,118,95,175,125}, baseCutoff{6500,7200,5700,5600,7800}, micCutoff{1,.76,1.15,.92,1.25}, q{.9,.75,1.1,1.0,.8}, resonantGain{2.4,1.5,3.4,1.8,1.6}, proximity{2,3,1,2.5,.5};
    const std::array<double, 5> mids{620,750,480,800,900}, midGain{-1.5,-2.3,-3.4,-.8,-1.2}, presenceFreq{3200,2300,4200,2800,5500}, presenceGain{3.4,-.6,2.2,2.0,2.8}, shelfGain{0,-2,1,-1,2};
    const double cutoff = baseCutoff[cab] * micCutoff[mic] * (1 - .33 * edge) * (1 - .12 * far);
    cab_[0].configure(Filter::Highpass, sr, hp[cab], .72, 0, glide);
    cab_[1].configure(Filter::Peak, sr, resonance[cab], q[cab], resonantGain[cab] + (1 - far) * proximity[mic], glide);
    cab_[2].configure(Filter::Peak, sr, mids[cab], .8, midGain[cab], glide);
    cab_[3].configure(Filter::Peak, sr, presenceFreq[mic], .8 + edge * .4, presenceGain[mic] * (1 - edge) - 2.2 * edge, glide);
    cab_[4].configure(Filter::HighShelf, sr, 2400 - 500 * edge, .707, -1.5 - edge * 5 - far * 1.5 + shelfGain[mic], glide);
    cab_[5].configure(Filter::Lowpass, sr, cutoff, .68, 0, glide); cab_[6].configure(Filter::Lowpass, sr, cutoff * 1.15, .55, 0, glide);
  }
  void process(float* s, std::uint32_t frames) noexcept override {
    if (enabled_) for (auto& f : cab_) for (std::uint32_t i = 0; i < frames; ++i) {
      s[2 * i] = f.sample(s[2 * i], 0); s[2 * i + 1] = f.sample(s[2 * i + 1], 1);
    }
  }
  void reset() noexcept override { for (auto& f : cab_) f.reset(); }
  void takeStateFrom(RigModule& previous) noexcept override {
    if (auto* p = dynamic_cast<RigCabinet*>(&previous)) for (std::size_t i = 0; i < cab_.size(); ++i) cab_[i].takeHistoryFrom(p->cab_[i]);
  }
 private:
  std::array<Biquad, 7> cab_; bool enabled_; double sampleRate_;
};

class RigChorus final : public RigModule {
 public:
  RigChorus(double sr, const RigParams& p) : RigModule(5, p.instance), chorus_(sr, p("chorusRate"), p("chorusDepth"), p("chorusMix")), enabled_(p.on("chorusEnabled")) {}
  void automate(const RigParams& p) noexcept override { chorus_.set(p("chorusRate"), p("chorusDepth"), p("chorusMix")); enabled_ = p.on("chorusEnabled"); }
  void process(float* s, std::uint32_t frames) noexcept override { if (enabled_) chorus_.process(s, frames); }
  void reset() noexcept override { chorus_.reset(); }
  void takeStateFrom(RigModule& previous) noexcept override { if (auto* p = dynamic_cast<RigChorus*>(&previous)) chorus_.takeStateFrom(p->chorus_); }
  double tailSeconds() const noexcept override { return enabled_ ? .04 : 0; }
 private:
  Chorus chorus_; bool enabled_;
};

class RigDelay final : public RigModule {
 public:
  RigDelay(double sr, const RigParams& p) : RigModule(6, p.instance),
      delay_(sr, p("delayTime") * .001, p("delayMix"), p("delayFeedback"), 4400, true), enabled_(p.on("delayEnabled")), sampleRate_(sr) {}
  void automate(const RigParams& p) noexcept override { delay_.set(sampleRate_, p("delayTime") * .001, p("delayMix"), p("delayFeedback")); enabled_ = p.on("delayEnabled"); }
  void process(float* s, std::uint32_t frames) noexcept override { if (enabled_) delay_.process(s, frames); }
  void reset() noexcept override { delay_.reset(); }
  void takeStateFrom(RigModule& previous) noexcept override { if (auto* p = dynamic_cast<RigDelay*>(&previous)) delay_.takeStateFrom(p->delay_); }
  double tailSeconds() const noexcept override { return enabled_ ? delay_.tailSeconds() : 0; }
 private:
  Delay delay_; bool enabled_; double sampleRate_;
};

// Fuzz (keep in sync with src/devices/guitar-rig/index.ts): tone 500 Hz - 5 kHz, no gain compensation.
class RigFuzz final : public RigModule {
 public:
  void automate(const RigParams& p) noexcept override {
    pre_ = dbToGain(p("fuzzGain")); post_ = dbToGain(p("fuzzLevel")); enabled_ = p.on("fuzzEnabled");
    tone_.configure(Filter::Lowpass, sampleRate_, 500 * std::pow(10, p("fuzzTone")), .707, 0, true);
  }
  RigFuzz(double sr, const RigParams& p) : RigModule(7, p.instance), shaper_(4.5, .3), enabled_(p.on("fuzzEnabled")), sampleRate_(sr) {
    pre_ = dbToGain(p("fuzzGain")); post_ = dbToGain(p("fuzzLevel"));
    input_.configure(Filter::Highpass, sr, 40, .707); dc_.configure(Filter::Highpass, sr, 25, .707);
    tone_.configure(Filter::Lowpass, sr, 500 * std::pow(10, p("fuzzTone")), .707);
  }
  void process(float* s, std::uint32_t frames) noexcept override {
    if (enabled_) for (std::uint32_t i = 0; i < frames; ++i) for (unsigned c = 0; c < 2; ++c) {
      float x = input_.sample(s[2 * i + c], c);
      x = shaper_.sample(static_cast<float>(x * pre_), c);
      s[2 * i + c] = static_cast<float>(dc_.sample(tone_.sample(x, c), c) * post_);
    }
  }
  void reset() noexcept override { shaper_.reset(); input_.reset(); tone_.reset(); dc_.reset(); }
  void takeStateFrom(RigModule& previous) noexcept override {
    if (auto* p = dynamic_cast<RigFuzz*>(&previous)) {
      shaper_.takeStateFrom(p->shaper_); input_.takeHistoryFrom(p->input_); tone_.takeHistoryFrom(p->tone_); dc_.takeHistoryFrom(p->dc_);
    }
  }
  std::uint32_t latencyFrames() const noexcept override { return enabled_ ? 8u : 0u; }
 private:
  Saturator shaper_; Biquad input_, tone_, dc_; double pre_ = 1, post_ = 1; bool enabled_; double sampleRate_;
};

class RigPhaser final : public RigModule {
 public:
  RigPhaser(double sr, const RigParams& p) : RigModule(8, p.instance),
      phaser_(sr, p("phaserRate"), p("phaserDepth"), p("phaserFeedback"), p.on("phaserEnabled")) {}
  void automate(const RigParams& p) noexcept override { phaser_.set(p("phaserRate"), p("phaserDepth"), p("phaserFeedback"), p.on("phaserEnabled")); }
  void process(float* s, std::uint32_t frames) noexcept override { phaser_.process(s, frames); }
  void reset() noexcept override { phaser_.reset(); }
  void takeStateFrom(RigModule& previous) noexcept override { if (auto* p = dynamic_cast<RigPhaser*>(&previous)) phaser_.takeStateFrom(p->phaser_); }
 private:
  Phaser phaser_;
};

class RigTremolo final : public RigModule {
 public:
  RigTremolo(double sr, const RigParams& p) : RigModule(9, p.instance),
      tremolo_(sr, p("tremoloRate"), p("tremoloDepth"), p("tremoloShape"), p.on("tremoloEnabled")) {}
  void automate(const RigParams& p) noexcept override { tremolo_.set(p("tremoloRate"), p("tremoloDepth"), p("tremoloShape"), p.on("tremoloEnabled")); }
  void process(float* s, std::uint32_t frames) noexcept override { tremolo_.process(s, frames); }
  void reset() noexcept override { tremolo_.reset(); }
  void takeStateFrom(RigModule& previous) noexcept override { if (auto* p = dynamic_cast<RigTremolo*>(&previous)) tremolo_.takeStateFrom(p->tremolo_); }
 private:
  Tremolo tremolo_;
};

// Plate-style reverb (src/devices/guitar-rig/reverb.ts): Decay blends the short and long IR. The
// convolvers are built only when the reverb can be heard, so other rig edits stay cheap.
class RigReverb final : public RigModule {
 public:
  RigReverb(double sr, const RigParams& p) : RigModule(10, p.instance) {
    if (p.on("reverbEnabled")) {
      auto small = impulse(sr, 1.7, 9183), large = impulse(sr, 4.2, 61427);
      const auto decay = static_cast<float>(p("reverbDecay"));
      for (unsigned c = 0; c < 2; ++c) {
        for (std::size_t i = 0; i < large[c].size(); ++i) large[c][i] = large[c][i] * decay + (i < small[c].size() ? small[c][i] * (1 - decay) : 0);
        reverb_[c] = std::make_unique<Convolver>(large[c]);
      }
      wet_ = p("reverbMix"); tail_ = (decay > .001 ? 4.2 : 1.7) + .25;
    }
    highpass_.configure(Filter::Highpass, sr, 180, .5);
    tone_.configure(Filter::Lowpass, sr, 1500 * std::pow(8, p("reverbTone")), .5);
    sampleRate_ = sr;
  }
  void automate(const RigParams& p) noexcept override {
    if (reverb_[0]) wet_ = p.on("reverbEnabled") ? p("reverbMix") : 0;
    tone_.configure(Filter::Lowpass, sampleRate_, 1500 * std::pow(8, p("reverbTone")), .5, 0, true);
  }
  void process(float* s, std::uint32_t frames) noexcept override {
    if (reverb_[0]) for (std::uint32_t i = 0; i < frames; ++i) for (unsigned c = 0; c < 2; ++c) {
      const float wet = tone_.sample(highpass_.sample(reverb_[c]->sample(s[2 * i + c]), c), c);
      s[2 * i + c] += static_cast<float>(wet_ * wet);
    }
  }
  void reset() noexcept override { for (auto& r : reverb_) if (r) r->reset(); highpass_.reset(); tone_.reset(); }
  void takeStateFrom(RigModule& previous) noexcept override {
    if (auto* p = dynamic_cast<RigReverb*>(&previous)) {
      for (std::size_t i = 0; i < reverb_.size(); ++i) if (reverb_[i] && p->reverb_[i]) reverb_[i]->takeStateFrom(*p->reverb_[i]);
      highpass_.takeHistoryFrom(p->highpass_); tone_.takeHistoryFrom(p->tone_);
    }
  }
  double tailSeconds() const noexcept override { return reverb_[0] && wet_ > 0 ? tail_ : 0; }
 private:
  std::array<std::unique_ptr<Convolver>, 2> reverb_; Biquad highpass_, tone_; double wet_ = 0, tail_ = 0, sampleRate_ = 48000;
};

class RigTuner final : public RigModule {
 public:
  explicit RigTuner(const RigParams& p) : RigModule(11, p.instance), enabled_(p.on("tunerEnabled")) {}
  void automate(const RigParams& p) noexcept override { enabled_ = p.on("tunerEnabled"); }
  void process(float* s, std::uint32_t frames) noexcept override { if (enabled_) std::fill(s, s + 2 * static_cast<std::size_t>(frames), 0.f); }
  void reset() noexcept override {}
  void takeStateFrom(RigModule&) noexcept override {}
 private:
  bool enabled_;
};

std::unique_ptr<RigModule> makeRigModule(int code, double sr, const RigParams& p) {
  switch (code) {
    case 1: return std::make_unique<RigComp>(sr, p);
    case 2: return std::make_unique<RigDrive>(sr, p);
    case 3: return std::make_unique<RigAmp>(sr, p);
    case 4: return std::make_unique<RigCabinet>(sr, p);
    case 5: return std::make_unique<RigChorus>(sr, p);
    case 6: return std::make_unique<RigDelay>(sr, p);
    case 7: return std::make_unique<RigFuzz>(sr, p);
    case 8: return std::make_unique<RigPhaser>(sr, p);
    case 9: return std::make_unique<RigTremolo>(sr, p);
    case 10: return std::make_unique<RigReverb>(sr, p);
    case 11: return std::make_unique<RigTuner>(p);
    default: return nullptr;
  }
}

class GuitarRig final : public StereoProcessor {
 public:
  // Modules are built only for the slots in the rack and run in slot order. Empty, unknown, over-limit
  // and repeated (code, instance) slots are skipped.
  GuitarRig(double sr, const Reader& p) {
    std::array<std::array<bool, kRigMaxInstances>, kRigModuleCodes> seen{};
    for (int slot = 0; slot < kRigSlots; ++slot) {
      const int value = static_cast<int>(std::round(p("rackSlot" + std::to_string(slot))));
      if (value <= 0) continue;
      const int code = value % kRigInstanceStride, instance = value / kRigInstanceStride;
      if (code < 1 || code >= kRigModuleCodes || instance >= rigMaxInstances(code) || seen[code][instance]) continue;
      seen[code][instance] = true;
      modules_.push_back(makeRigModule(code, sr, RigParams{p, instance}));
    }
  }
  void process(float* s, std::uint32_t frames) noexcept override { for (auto& m : modules_) m->process(s, frames); }
  // The rack layout (rackSlot*) is structural and is never automated; each module re-reads its own knobs.
  void automate(const Reader& p) noexcept override { for (auto& m : modules_) m->automate(RigParams{p, m->instance()}); }
  void reset() noexcept override { for (auto& m : modules_) m->reset(); }
  // State follows each module by (code, instance), so moving or adding a module keeps the others ringing.
  void takeStateFrom(StereoProcessor& previous) noexcept override {
    if (auto* p = dynamic_cast<GuitarRig*>(&previous)) for (auto& m : modules_) for (auto& old : p->modules_)
      if (old->code() == m->code() && old->instance() == m->instance()) { m->takeStateFrom(*old); break; }
  }
  std::uint32_t latencyFrames() const noexcept override {
    std::uint32_t total = 0; for (const auto& m : modules_) total += m->latencyFrames(); return total;
  }
  double tailSeconds() const noexcept override {
    double total = 0; for (const auto& m : modules_) total += m->tailSeconds(); return total;
  }
 private:
  std::vector<std::unique_ptr<RigModule>> modules_;
};

#include "sigimsae_effects.inc"
#include "eq_effects.inc"
#if GARAK_RUST
#include "rust_effects.inc"
#endif

} // namespace

void Biquad::configure(Filter type, double sr, double hz, double q, double gain, bool glide) noexcept {
  // Low/high-pass Q is in dB and may be negative (cascaded Butterworth stages below Q 1).
  const bool passQ = type == Filter::Lowpass || type == Filter::Highpass;
  hz = bounded(hz, 1, sr * .45); q = passQ ? bounded(q, -60, 60) : bounded(q, .0001, 40);
  const double omega = 2 * pi * hz / sr, cosine = std::cos(omega), sine = std::sin(omega);
  // Match the original BiquadFilterNode response, including its distinct Q
  // units for low/high-pass (W3C Web Audio 1.13.5, alpha_Q_dB).
  const double quality = passQ ? dbToGain(q) : q;
  const double a = std::pow(10, gain / 40), alpha = sine / (2 * quality);
  double b0=1,b1=0,b2=0,a0=1,a1=0,a2=0;
  switch (type) {
    case Filter::Lowpass: b0=(1-cosine)/2; b1=1-cosine; b2=b0; a0=1+alpha; a1=-2*cosine; a2=1-alpha; break;
    case Filter::Highpass: b0=(1+cosine)/2; b1=-(1+cosine); b2=b0; a0=1+alpha; a1=-2*cosine; a2=1-alpha; break;
    case Filter::Bandpass: b0=alpha; b1=0; b2=-alpha; a0=1+alpha; a1=-2*cosine; a2=1-alpha; break;
    case Filter::Notch: b0=1; b1=-2*cosine; b2=1; a0=1+alpha; a1=-2*cosine; a2=1-alpha; break;
    case Filter::Peak: b0=1+alpha*a; b1=-2*cosine; b2=1-alpha*a; a0=1+alpha/a; a1=-2*cosine; a2=1-alpha/a; break;
    case Filter::LowShelf: {
      const double beta = std::sqrt(2*a)*sine;
      b0=a*((a+1)-(a-1)*cosine+beta); b1=2*a*((a-1)-(a+1)*cosine); b2=a*((a+1)-(a-1)*cosine-beta);
      a0=(a+1)+(a-1)*cosine+beta; a1=-2*((a-1)+(a+1)*cosine); a2=(a+1)+(a-1)*cosine-beta; break;
    }
    case Filter::HighShelf: {
      const double beta = std::sqrt(2*a)*sine;
      b0=a*((a+1)+(a-1)*cosine+beta); b1=-2*a*((a-1)+(a+1)*cosine); b2=a*((a+1)+(a-1)*cosine-beta);
      a0=(a+1)-(a-1)*cosine+beta; a1=2*((a-1)-(a+1)*cosine); a2=(a+1)-(a-1)*cosine-beta; break;
    }
  }
  tb0_=b0/a0; tb1_=b1/a0; tb2_=b2/a0; ta1_=a1/a0; ta2_=a2/a0;
  if (!glide) { b0_=tb0_; b1_=tb1_; b2_=tb2_; a1_=ta1_; a2_=ta2_; }
  smoothing_=1-std::exp(-1/(sr*.012));
}
void Biquad::takeHistoryFrom(const Biquad& previous) noexcept {
  z1_=previous.z1_; z2_=previous.z2_;
  b0_=previous.b0_; b1_=previous.b1_; b2_=previous.b2_; a1_=previous.a1_; a2_=previous.a2_;
}
float Biquad::sample(float x, unsigned c) noexcept {
  if (!c) { b0_+=(tb0_-b0_)*smoothing_; b1_+=(tb1_-b1_)*smoothing_; b2_+=(tb2_-b2_)*smoothing_; a1_+=(ta1_-a1_)*smoothing_; a2_+=(ta2_-a2_)*smoothing_; }
  const double y = b0_ * x + z1_[c];
  z1_[c] = b1_ * x - a1_ * y + z2_[c]; z2_[c] = b2_ * x - a2_ * y;
  if (std::abs(z1_[c]) < 1e-30) z1_[c] = 0;
  if (std::abs(z2_[c]) < 1e-30) z2_[c] = 0;
  return static_cast<float>(y);
}

Master::Master(double sr) noexcept : attack_(std::exp(-1/(sr*.003))), release_(std::exp(-1/(sr*.12))) {}
void Master::process(float* s, std::uint32_t frames) noexcept {
  for (std::uint32_t i=0;i<frames;++i) {
    const double peak = std::min(32.0, static_cast<double>(std::max(std::abs(s[2*i]),std::abs(s[2*i+1]))));
    const double c = peak>envelope_?attack_:release_; envelope_=peak+c*(envelope_-peak);
    double gain=1;
    if (envelope_>.5956621435) {const double above=20*std::log10(envelope_)+3;const double over=above<1.5?(above+1.5)*(above+1.5)/6:above;gain=dbToGain(-(11.0/12)*over);}
    for (unsigned channel=0;channel<2;++channel) {
      const double value=bounded(s[2*i+channel],-32,32)*gain,magnitude=std::abs(value);
      s[2*i+channel]=static_cast<float>(magnitude<=.9?value:std::copysign(.9+.08*std::tanh((magnitude-.9)/.08),value));
    }
  }
}

namespace {
// Parameter catalog of each native effect (ids, defaults, ranges): mirrors the TypeScript definitions.
std::vector<Def> effectDefs(std::string_view type) {
  if (type=="eq") return eqDefs();
  if (type=="filter") return {{"cutoff",1200,20,20000},{"resonance",.7,.1,18},{"mode",0,0,2},{"slope",0,0,2}};
  if (type=="compressor") return {{"threshold",-18,-60,0},{"ratio",4,1,20},{"attack",10,.1,100},{"release",150,10,1000},{"makeup",0,0,24}};
  if (type=="drive") return {{"drive",9,0,36},{"tone",9000,500,20000},{"mix",1,0,1},{"output",0,-24,6}};
  if (type=="reverb") return {{"amount",.3,0,1},{"size",.35,0,1},{"tone",9000,1000,20000},{"type",0,0,3},{"predelay",0,0,250},{"lowcut",20,20,1000},{"dry",1,0,1}};
  if (type=="guitar-rig") return guitarRigDefs();
  return sigimsaeDefs(type);
}
} // namespace

bool rustEffectsAvailable() noexcept { return GARAK_RUST != 0; }
bool rustEffectSupported(std::string_view type) noexcept {
#if GARAK_RUST
  return rustKind(type) >= 0;
#else
  (void)type; return false;
#endif
}
void setEffectBackend(std::string_view type, EffectBackend backend) noexcept {
#if GARAK_RUST
  auto& selected = rustSelection();
  if (type == "all") { for (auto& v : selected) v.store(backend == EffectBackend::Rust); return; }
  if (const int kind = rustKind(type); kind >= 0) selected[static_cast<std::size_t>(kind)].store(backend == EffectBackend::Rust);
#else
  (void)type; (void)backend;
#endif
}
EffectBackend effectBackend(std::string_view type) noexcept {
#if GARAK_RUST
  if (const int kind = rustKind(type); kind >= 0 && rustSelection()[static_cast<std::size_t>(kind)].load()) return EffectBackend::Rust;
#else
  (void)type;
#endif
  return EffectBackend::Cpp;
}

std::unique_ptr<StereoProcessor> makeEffect(std::string_view type,const Parameters& params,double sr,double bpm) {
  return makeEffect(type,params,sr,bpm,effectBackend(type));
}

std::unique_ptr<StereoProcessor> makeEffect(std::string_view type,const Parameters& params,double sr,double bpm,EffectBackend backend) {
  if (!std::isfinite(sr)||sr<8000||sr>192000||!std::isfinite(bpm)||bpm<20||bpm>400) throw std::invalid_argument("Invalid DSP rate or tempo");
  if (backend==EffectBackend::Rust) {
#if GARAK_RUST
    return std::make_unique<RustEffect>(type,params,sr,bpm);
#else
    throw std::invalid_argument("This build has no Rust DSP core (configure with -DGARAK_RUST=ON)");
#endif
  }
  if (type=="eq") return makeParametricEq(params,sr);
  if (type=="filter") return makeSweepFilter(params,sr);
  if (type=="compressor") {
    Reader p(params,effectDefs(type));
    return std::make_unique<Compressor>(sr,p("threshold"),p("ratio"),p("attack")*.001,p("release")*.001,dbToGain(p("makeup")));
  }
  if (type=="drive") { Reader p(params,effectDefs(type));return std::make_unique<Drive>(sr,p); }
  if (type=="reverb") { Reader p(params,effectDefs(type));return std::make_unique<Reverb>(sr,p); }
  if (auto effect=makeSigimsae(type,params,sr,bpm)) return effect;
  if (type=="guitar-rig") { Reader p(params,guitarRigDefs());return std::make_unique<GuitarRig>(sr,p); }
  throw std::invalid_argument("Unsupported native effect: "+std::string(type));
}

struct EffectControl::Impl {
  Parameters values;
  std::unique_ptr<Reader> reader;
  std::vector<Parameters::iterator> slots;
  std::vector<Def> defs;
  bool dirty = false;
};
EffectControl::EffectControl(std::string_view type, const Parameters& initial) : impl_(std::make_unique<Impl>()) {
  impl_->defs = effectDefs(type);
  if (impl_->defs.empty()) throw std::invalid_argument("Unsupported native effect: "+std::string(type));
  for (const auto& def : impl_->defs) {
    const auto found = initial.find(def.name);
    impl_->slots.push_back(impl_->values.emplace(def.name, found != initial.end() ? found->second : def.fallback).first);
  }
  impl_->reader = std::make_unique<Reader>(impl_->values, impl_->defs);
}
EffectControl::~EffectControl() = default;
EffectControl::EffectControl(EffectControl&&) noexcept = default;
EffectControl& EffectControl::operator=(EffectControl&&) noexcept = default;
int EffectControl::index(std::string_view id) const noexcept {
  for (std::size_t i = 0; i < impl_->defs.size(); ++i) if (id == impl_->defs[i].name) return static_cast<int>(i);
  return -1;
}
void EffectControl::set(int index, double value) noexcept {
  if (index < 0 || static_cast<std::size_t>(index) >= impl_->slots.size() || !std::isfinite(value)) return;
  const auto& def = impl_->defs[static_cast<std::size_t>(index)];
  const double clamped = bounded(value, def.minimum, def.maximum);
  auto& slot = impl_->slots[static_cast<std::size_t>(index)]->second;
  if (slot != clamped) { slot = clamped; impl_->dirty = true; }
}
double EffectControl::get(int index) const noexcept {
  return index < 0 || static_cast<std::size_t>(index) >= impl_->slots.size() ? 0 : impl_->slots[static_cast<std::size_t>(index)]->second;
}
void EffectControl::apply(StereoProcessor& effect) noexcept {
  if (!impl_->dirty) return;
  impl_->dirty = false;
  effect.automate(*impl_->reader);
}

std::size_t estimateEffectMemory(std::string_view type,double sr) noexcept {
  if (type=="reverb") return static_cast<std::size_t>(sr*4.2*80)+1024*1024;
  // The rig holds up to three delay lines and, for each heard reverb, a 4.2 s stereo convolver.
  if (type=="guitar-rig") return static_cast<std::size_t>(sr*4.2*(24+80))*3+3*1024*1024+65536;
  if (type=="delay") return static_cast<std::size_t>(sr*4.2*24)+65536;
  if (type=="chorus"||type=="flanger") return static_cast<std::size_t>(sr*.06*16)+65536;
  return 4096;
}

} // namespace garak::dsp

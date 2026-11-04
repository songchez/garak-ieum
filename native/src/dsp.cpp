#include "garak/dsp.hpp"

#include <algorithm>
#include <complex>
#include <limits>
#include <stdexcept>
#include <utility>
#include <vector>

namespace garak::dsp {
namespace {
double bounded(double v, double lo, double hi) noexcept { return std::clamp(v, lo, hi); }
struct Def { const char* name; double fallback, minimum, maximum; };
class Reader {
 public:
  Reader(const Parameters& p, std::initializer_list<Def> defs) : params_(p), defs_(defs) {
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
 private:
  const Parameters& params_;
  std::vector<Def> defs_;
};

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
             double makeup, double knee = 6) noexcept
      : threshold_(threshold), strength_(1 - 1 / ratio), attack_(std::exp(-1 / (std::max(.00001, attack) * rate))),
        release_(std::exp(-1 / (std::max(.00001, release) * rate))), makeup_(makeup), knee_(knee) {}
  void process(float* s, std::uint32_t frames) noexcept override {
    for (std::uint32_t i = 0; i < frames; ++i) {
      const double peak = std::max(std::abs(s[2 * i]), std::abs(s[2 * i + 1]));
      const double c = peak > envelope_ ? attack_ : release_;
      envelope_ = peak + c * (envelope_ - peak);
      const double above = 20 * std::log10(std::max(1e-12, envelope_)) - threshold_;
      const double over = above < -knee_ / 2 ? 0 : above < knee_ / 2 ? (above + knee_ / 2) * (above + knee_ / 2) / (2 * knee_) : above;
      const float gain = static_cast<float>(dbToGain(-strength_ * over) * makeup_);
      s[2 * i] *= gain; s[2 * i + 1] *= gain;
    }
  }
  void reset() noexcept override { envelope_ = 0; }
  void takeStateFrom(StereoProcessor& previous) noexcept override {
    if (auto* p = dynamic_cast<Compressor*>(&previous)) envelope_ = p->envelope_;
  }
 private:
  double threshold_, strength_, attack_, release_, makeup_, knee_, envelope_ = 0;
};

class Filters final : public StereoProcessor {
 public:
  std::vector<Biquad> filters;
  void process(float* s, std::uint32_t frames) noexcept override {
    for (auto& f : filters) for (std::uint32_t i = 0; i < frames; ++i) {
      s[2 * i] = f.sample(s[2 * i], 0); s[2 * i + 1] = f.sample(s[2 * i + 1], 1);
    }
  }
  void reset() noexcept override { for (auto& f : filters) f.reset(); }
  void takeStateFrom(StereoProcessor& previous) noexcept override {
    if (auto* p = dynamic_cast<Filters*>(&previous); p && p->filters.size() == filters.size())
      for (std::size_t i = 0; i < filters.size(); ++i) filters[i].takeHistoryFrom(p->filters[i]);
  }
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
  Drive(double sr, const Reader& p) : shaper_(2.5), dry_(8), pre_(dbToGain(p("drive"))),
      wet_(p("mix")), output_(dbToGain(p("output"))) {
    tone_.configure(Filter::Lowpass, sr, p("tone"), 1);
    post_ = output_ / std::sqrt(pre_ * 2.53);
  }
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
  double pre_, wet_, output_, post_;
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

std::array<std::vector<float>, 2> impulse(double sr, double seconds, std::uint32_t seed) {
  const auto length = static_cast<std::size_t>(std::ceil(sr * seconds));
  std::array<std::vector<float>, 2> result{std::vector<float>(length), std::vector<float>(length)};
  double power = 0;
  for (auto& channel : result) for (std::size_t i = 0; i < length; ++i) {
    seed = seed * 1664525u + 1013904223u;
    channel[i] = static_cast<float>((static_cast<double>(seed) / 4294967295.0 * 2 - 1) * std::pow(1 - static_cast<double>(i) / length, 3.6));
    power += static_cast<double>(channel[i]) * channel[i];
  }
  power = std::max(.000125, std::sqrt(power / (length * 2)));
  const auto scale = static_cast<float>(.00125 / power * 44100 / sr);
  for (auto& channel : result) for (auto& value : channel) value *= scale;
  return result;
}

class Reverb final : public StereoProcessor {
 public:
  Reverb(double sr, const Reader& p) : wet_(p("amount") * .5), tail_(.85 + 1.7 + p("size") * 2.5) {
    auto small = impulse(sr, 1.7, 9183), large = impulse(sr, 4.2, 61427);
    const float size = static_cast<float>(p("size"));
    for (unsigned c = 0; c < 2; ++c) {
      for (std::size_t i = 0; i < large[c].size(); ++i) large[c][i] = large[c][i] * size + (i < small[c].size() ? small[c][i] * (1 - size) : 0);
      channels_[c] = std::make_unique<Convolver>(large[c]);
    }
    tone_.configure(Filter::Lowpass, sr, p("tone"), 1);
  }
  void process(float* s, std::uint32_t frames) noexcept override {
    for (std::uint32_t i = 0; i < frames; ++i) for (unsigned c = 0; c < 2; ++c)
      s[2 * i + c] += static_cast<float>(wet_ * tone_.sample(channels_[c]->sample(s[2 * i + c]), c));
  }
  void reset() noexcept override { for (auto& c : channels_) c->reset(); tone_.reset(); }
  void takeStateFrom(StereoProcessor& previous) noexcept override {
    if (auto* p = dynamic_cast<Reverb*>(&previous)) {
      for (std::size_t i = 0; i < channels_.size(); ++i) channels_[i]->takeStateFrom(*p->channels_[i]);
      tone_.takeHistoryFrom(p->tone_);
    }
  }
  double tailSeconds() const noexcept override { return wet_ > 0 ? tail_ : 0; }
 private:
  std::array<std::unique_ptr<Convolver>, 2> channels_; Biquad tone_; double wet_, tail_;
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
  void reset() noexcept { line_.reset(); phase_ = 0; }
  void takeStateFrom(Chorus& previous) noexcept { line_.takeStateFrom(previous.line_); phase_ = previous.phase_; }
 private:
  DelayLine line_; double sampleRate_, phaseStep_, depth_, mix_, phase_ = 0;
};

class GuitarRig final : public StereoProcessor {
 public:
  GuitarRig(double sr, const Reader& p) : comp_(sr, -12 - p("compSustain") * 30, 1 + p("compSustain") * 7,
        p("compAttack") * .001, .09 + p("compSustain") * .1, dbToGain(p("compLevel") + p("compSustain") * 6)),
      driveShaper_(2.8, .12), ampShaper_(2.4, .08), powerShaper_(2.4 * .65, -.08),
      chorus_(sr, p("chorusRate"), p("chorusDepth"), p("chorusMix")),
      delay_(sr, p("delayTime") * .001, p("delayMix"), p("delayFeedback"), 4400, true) {
    compEnabled_ = p("compEnabled") >= .5; driveEnabled_ = p("driveEnabled") >= .5;
    ampEnabled_ = p("ampEnabled") >= .5; cabEnabled_ = p("cabinetEnabled") >= .5;
    chorusEnabled_ = p("chorusEnabled") >= .5; delayEnabled_ = p("delayEnabled") >= .5;
    drivePre_ = dbToGain(p("driveGain")); drivePost_ = dbToGain(p("driveLevel")) / std::pow(drivePre_, .4);
    driveInput_.configure(Filter::Highpass, sr, 95, .707); driveDc_.configure(Filter::Highpass, sr, 25, .707);
    driveTone_.configure(Filter::Lowpass, sr, 1200 * std::pow(8, p("driveTone")), .707);
    const int model = static_cast<int>(std::round(p("ampModel")));
    const double gain = dbToGain(p("ampGain"));
    const std::array<double, 3> pre{.55, 1.5, 3.5}, inter{.8, 1.2, 1.65}, highpass{45, 75, 100}, lowpass{9500, 6600, 5200}, compensation{.9, .55, .42};
    ampPre_ = gain * pre[model]; ampInter_ = inter[model]; ampPost_ = dbToGain(p("ampLevel")) * compensation[model] / std::pow(gain, .15);
    ampInput_.configure(Filter::Highpass, sr, highpass[model], .707); ampInterFilter_.configure(Filter::Lowpass, sr, lowpass[model], .707); ampDc_.configure(Filter::Highpass, sr, 25, .707);
    eq_[0].configure(Filter::LowShelf, sr, 150, .707, p("ampBass")); eq_[1].configure(Filter::Peak, sr, 750, .8, p("ampMid"));
    eq_[2].configure(Filter::HighShelf, sr, 2600, .707, p("ampTreble")); eq_[3].configure(Filter::HighShelf, sr, 4200, .707, p("ampPresence"));
    const int cab = static_cast<int>(std::round(p("cabinet"))), mic = static_cast<int>(std::round(p("micType")));
    const double edge = p("micPosition"), far = p("micDistance");
    const std::array<double, 3> hp{95,75,62}, resonance{145,118,95}, baseCutoff{6500,7200,5700}, micCutoff{1,.76,1.15}, q{.9,.75,1.1}, resonantGain{2.4,1.5,3.4}, proximity{2,3,1};
    const std::array<double, 3> mids{620,750,480}, midGain{-1.5,-2.3,-3.4}, presenceFreq{3200,2300,4200}, presenceGain{3.4,-.6,2.2}, shelfGain{0,-2,1};
    const double cutoff = baseCutoff[cab] * micCutoff[mic] * (1 - .33 * edge) * (1 - .12 * far);
    cab_[0].configure(Filter::Highpass, sr, hp[cab], .72);
    cab_[1].configure(Filter::Peak, sr, resonance[cab], q[cab], resonantGain[cab] + (1 - far) * proximity[mic]);
    cab_[2].configure(Filter::Peak, sr, mids[cab], .8, midGain[cab]);
    cab_[3].configure(Filter::Peak, sr, presenceFreq[mic], .8 + edge * .4, presenceGain[mic] * (1 - edge) - 2.2 * edge);
    cab_[4].configure(Filter::HighShelf, sr, 2400 - 500 * edge, .707, -1.5 - edge * 5 - far * 1.5 + shelfGain[mic]);
    cab_[5].configure(Filter::Lowpass, sr, cutoff, .68); cab_[6].configure(Filter::Lowpass, sr, cutoff * 1.15, .55);
  }
  void process(float* s, std::uint32_t frames) noexcept override {
    if (compEnabled_) comp_.process(s, frames);
    if (driveEnabled_) for (std::uint32_t i = 0; i < frames; ++i) for (unsigned c = 0; c < 2; ++c) {
      float x = driveInput_.sample(s[2 * i + c], c);
      x = driveShaper_.sample(static_cast<float>(x * drivePre_), c);
      s[2 * i + c] = static_cast<float>(driveDc_.sample(driveTone_.sample(x,c),c) * drivePost_);
    }
    if (ampEnabled_) for (std::uint32_t i = 0; i < frames; ++i) for (unsigned c = 0; c < 2; ++c) {
      float x = ampInput_.sample(s[2 * i + c], c);
      x = ampShaper_.sample(static_cast<float>(x * ampPre_), c);
      x = powerShaper_.sample(static_cast<float>(ampInterFilter_.sample(x,c) * ampInter_), c);
      x = ampDc_.sample(x,c); for (auto& f : eq_) x = f.sample(x,c);
      s[2 * i + c] = static_cast<float>(x * ampPost_);
    }
    if (cabEnabled_) for (auto& f : cab_) for (std::uint32_t i = 0; i < frames; ++i) {
      s[2 * i] = f.sample(s[2 * i], 0); s[2 * i + 1] = f.sample(s[2 * i + 1], 1);
    }
    if (chorusEnabled_) chorus_.process(s, frames);
    if (delayEnabled_) delay_.process(s, frames);
  }
  void reset() noexcept override {
    comp_.reset(); driveShaper_.reset(); ampShaper_.reset(); powerShaper_.reset(); chorus_.reset(); delay_.reset();
    driveInput_.reset(); driveTone_.reset(); driveDc_.reset(); ampInput_.reset(); ampInterFilter_.reset(); ampDc_.reset();
    for (auto& f : eq_) f.reset();
    for (auto& f : cab_) f.reset();
  }
  void takeStateFrom(StereoProcessor& previous) noexcept override {
    if (auto* p = dynamic_cast<GuitarRig*>(&previous)) {
      comp_.takeStateFrom(p->comp_); driveShaper_.takeStateFrom(p->driveShaper_); ampShaper_.takeStateFrom(p->ampShaper_); powerShaper_.takeStateFrom(p->powerShaper_);
      chorus_.takeStateFrom(p->chorus_); delay_.takeStateFrom(p->delay_);
      driveInput_.takeHistoryFrom(p->driveInput_); driveTone_.takeHistoryFrom(p->driveTone_); driveDc_.takeHistoryFrom(p->driveDc_);
      ampInput_.takeHistoryFrom(p->ampInput_); ampInterFilter_.takeHistoryFrom(p->ampInterFilter_); ampDc_.takeHistoryFrom(p->ampDc_);
      for (std::size_t i = 0; i < eq_.size(); ++i) eq_[i].takeHistoryFrom(p->eq_[i]);
      for (std::size_t i = 0; i < cab_.size(); ++i) cab_[i].takeHistoryFrom(p->cab_[i]);
    }
  }
  std::uint32_t latencyFrames() const noexcept override { return (driveEnabled_ ? 8u : 0u) + (ampEnabled_ ? 16u : 0u); }
  double tailSeconds() const noexcept override { return (chorusEnabled_ ? .04 : 0) + (delayEnabled_ ? delay_.tailSeconds() : 0); }
 private:
  Compressor comp_; Saturator driveShaper_, ampShaper_, powerShaper_; Chorus chorus_; Delay delay_;
  Biquad driveInput_, driveTone_, driveDc_, ampInput_, ampInterFilter_, ampDc_;
  std::array<Biquad, 4> eq_; std::array<Biquad, 7> cab_;
  double drivePre_ = 1, drivePost_ = 1, ampPre_ = 1, ampInter_ = 1, ampPost_ = 1;
  bool compEnabled_, driveEnabled_, ampEnabled_, cabEnabled_, chorusEnabled_, delayEnabled_;
};

} // namespace

void Biquad::configure(Filter type, double sr, double hz, double q, double gain) noexcept {
  hz = bounded(hz, 1, sr * .45); q = bounded(q, .0001, 40);
  const double omega = 2 * pi * hz / sr, cosine = std::cos(omega), sine = std::sin(omega);
  // Match the original BiquadFilterNode response, including its distinct Q
  // units for low/high-pass (W3C Web Audio 1.13.5, alpha_Q_dB).
  const double quality = type == Filter::Lowpass || type == Filter::Highpass ? dbToGain(q) : q;
  const double a = std::pow(10, gain / 40), alpha = sine / (2 * quality);
  double b0=1,b1=0,b2=0,a0=1,a1=0,a2=0;
  switch (type) {
    case Filter::Lowpass: b0=(1-cosine)/2; b1=1-cosine; b2=b0; a0=1+alpha; a1=-2*cosine; a2=1-alpha; break;
    case Filter::Highpass: b0=(1+cosine)/2; b1=-(1+cosine); b2=b0; a0=1+alpha; a1=-2*cosine; a2=1-alpha; break;
    case Filter::Bandpass: b0=alpha; b1=0; b2=-alpha; a0=1+alpha; a1=-2*cosine; a2=1-alpha; break;
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
  b0_=tb0_=b0/a0; b1_=tb1_=b1/a0; b2_=tb2_=b2/a0; a1_=ta1_=a1/a0; a2_=ta2_=a2/a0;
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

std::unique_ptr<StereoProcessor> makeEffect(std::string_view type,const Parameters& params,double sr,double bpm) {
  if (!std::isfinite(sr)||sr<8000||sr>192000||!std::isfinite(bpm)||bpm<20||bpm>400) throw std::invalid_argument("Invalid DSP rate or tempo");
  if (type=="eq") {
    Reader p(params,{{"low",0,-18,18},{"mid",0,-18,18},{"midFreq",1000,200,5000},{"high",0,-18,18}});
    auto f=std::make_unique<Filters>();f->filters.resize(3);
    f->filters[0].configure(Filter::LowShelf,sr,220,1,p("low"));f->filters[1].configure(Filter::Peak,sr,p("midFreq"),.9,p("mid"));f->filters[2].configure(Filter::HighShelf,sr,4500,1,p("high"));return f;
  }
  if (type=="filter") {
    Reader p(params,{{"cutoff",1200,20,20000},{"resonance",.7,.1,18},{"mode",0,0,2}});
    auto f=std::make_unique<Filters>();f->filters.resize(1);const std::array<Filter,3> modes{Filter::Lowpass,Filter::Highpass,Filter::Bandpass};
    f->filters[0].configure(modes[static_cast<unsigned>(std::round(p("mode")))],sr,p("cutoff"),p("resonance"));return f;
  }
  if (type=="compressor") {
    Reader p(params,{{"threshold",-18,-60,0},{"ratio",4,1,20},{"attack",10,.1,100},{"release",150,10,1000},{"makeup",0,0,24}});
    return std::make_unique<Compressor>(sr,p("threshold"),p("ratio"),p("attack")*.001,p("release")*.001,dbToGain(p("makeup")));
  }
  if (type=="drive") {
    Reader p(params,{{"drive",9,0,36},{"tone",9000,500,20000},{"mix",1,0,1},{"output",0,-24,6}});return std::make_unique<Drive>(sr,p);
  }
  if (type=="delay") {
    Reader p(params,{{"amount",.3,0,1},{"time",.75,.25,2},{"feedback",.32,0,.95},{"tone",3800,500,16000}});
    return std::make_unique<Delay>(sr,std::min(3.9,p("time")*60/bpm),p("amount")*.45,p("feedback"),p("tone"));
  }
  if (type=="reverb") {
    Reader p(params,{{"amount",.3,0,1},{"size",.35,0,1},{"tone",9000,1000,20000}});return std::make_unique<Reverb>(sr,p);
  }
  if (type=="guitar-rig") {
    Reader p(params,{{"compSustain",.35,0,1},{"compAttack",10,.5,50},{"compLevel",0,-18,18},
      {"driveGain",9,0,30},{"driveTone",.5,0,1},{"driveLevel",-3,-24,12},{"chorusRate",.8,.1,5},{"chorusDepth",.35,0,1},{"chorusMix",.25,0,.6},
      {"delayTime",320,30,1200},{"delayFeedback",.3,0,.85},{"delayMix",.2,0,.6},{"ampGain",10,0,36},{"ampBass",0,-12,12},{"ampMid",0,-12,12},
      {"ampTreble",0,-12,12},{"ampPresence",0,-9,9},{"ampLevel",-6,-36,6},{"compEnabled",1,0,1},{"driveEnabled",0,0,1},{"chorusEnabled",0,0,1},
      {"delayEnabled",0,0,1},{"ampEnabled",1,0,1},{"cabinetEnabled",1,0,1},{"ampModel",0,0,2},{"cabinet",1,0,2},{"micType",0,0,2},
      {"micPosition",.35,0,1},{"micDistance",.15,0,1}});return std::make_unique<GuitarRig>(sr,p);
  }
  throw std::invalid_argument("Unsupported native effect: "+std::string(type));
}

std::size_t estimateEffectMemory(std::string_view type,double sr) noexcept {
  if (type=="reverb") return static_cast<std::size_t>(sr*4.2*80)+1024*1024;
  if (type=="delay"||type=="guitar-rig") return static_cast<std::size_t>(sr*4.2*24)+65536;
  return 4096;
}

} // namespace garak::dsp

// Sample-processed 시김새 (effects). Included inside dsp.cpp's anonymous namespace (uses Reader,
// Biquad, dbToGain). Mirrors src/devices/effects/kernels.ts class for class; parameter catalogs
// mirror src/devices/effects/sigimsaeDefs.ts. A parameter edit rebuilds the processor on the control
// thread; takeStateFrom() moves the audio history and the current (smoothed) values across, so the
// new targets glide in over ~12 ms exactly as the worklet's configure() does.

// Float ring; read(age) interpolates `age` frames behind the newest pushed frame.
class Ring {
 public:
  explicit Ring(std::size_t n) : data_(n) {}
  void push(float x) noexcept { write_ = write_ + 1 == data_.size() ? 0 : write_ + 1; data_[write_] = x; }
  float read(double age) const noexcept {
    age = bounded(age, 0, static_cast<double>(data_.size() - 2));
    const auto whole = static_cast<std::size_t>(age); const double fraction = age - static_cast<double>(whole);
    const auto a = (write_ + data_.size() - whole) % data_.size(), b = a == 0 ? data_.size() - 1 : a - 1;
    return static_cast<float>(data_[a] + fraction * (data_[b] - data_[a]));
  }
  void reset() noexcept { std::fill(data_.begin(), data_.end(), 0.f); write_ = 0; }
  void takeStateFrom(Ring& previous) noexcept { if (data_.size() == previous.data_.size()) { data_.swap(previous.data_); std::swap(write_, previous.write_); } }
 private:
  std::vector<float> data_; std::size_t write_ = 0;
};

struct Smooth {
  double value = 0, target = 0;
  void set(double t) noexcept { value = target = t; }
  double next(double k) noexcept { value += (target - value) * k; return value; }
  void follow(const Smooth& previous) noexcept { value = previous.value; }
};

class KernelBase : public StereoProcessor {
 public:
  explicit KernelBase(double sr) : sampleRate_(sr), k_(1 - std::exp(-1 / (.012 * sr))) {}
 protected:
  double sampleRate_, k_;
};

class ChorusFx final : public KernelBase {
 public:
  ChorusFx(double sr, const Reader& p) : KernelBase(sr), l_(static_cast<std::size_t>(std::ceil(sr * .05)) + 4), r_(l_), rate_(p("rate")) { depth_.set(p("depth")); mix_.set(p("mix")); }
  void process(float* s, std::uint32_t frames) noexcept override {
    const double step = 2 * pi * rate_ / sampleRate_;
    for (std::uint32_t i = 0; i < frames; ++i) {
      const double depth = depth_.next(k_), mix = mix_.next(k_);
      l_.push(s[2 * i]); r_.push(s[2 * i + 1]);
      const double modulation = std::sin(phase_) * depth * .005;
      const double wl = l_.read((.014 + modulation) * sampleRate_), wr = r_.read((.017 - modulation) * sampleRate_);
      s[2 * i] = static_cast<float>(s[2 * i] * (1 - mix) + wl * mix); s[2 * i + 1] = static_cast<float>(s[2 * i + 1] * (1 - mix) + wr * mix);
      phase_ += step; if (phase_ >= 2 * pi) phase_ -= 2 * pi;
    }
  }
  void reset() noexcept override { l_.reset(); r_.reset(); phase_ = 0; }
  void takeStateFrom(StereoProcessor& previous) noexcept override {
    if (auto* p = dynamic_cast<ChorusFx*>(&previous)) { l_.takeStateFrom(p->l_); r_.takeStateFrom(p->r_); phase_ = p->phase_; depth_.follow(p->depth_); mix_.follow(p->mix_); }
  }
  double tailSeconds() const noexcept override { return .05; }
 private:
  Ring l_, r_; double rate_, phase_ = 0; Smooth depth_, mix_;
};

class FlangerFx final : public KernelBase {
 public:
  FlangerFx(double sr, const Reader& p) : KernelBase(sr), l_(static_cast<std::size_t>(std::ceil(sr * .012)) + 4), r_(l_), rate_(p("rate")) {
    depth_.set(p("depth")); feedback_.set(p("feedback")); mix_.set(p("mix"));
    const double fb = p("feedback"), repeats = fb > .01 ? std::ceil(std::log(.001) / std::log(fb)) : 1;
    tail_ = .0065 * (repeats + 1) + .05;
  }
  void process(float* s, std::uint32_t frames) noexcept override {
    const double step = 2 * pi * rate_ / sampleRate_;
    for (std::uint32_t i = 0; i < frames; ++i) {
      const double depth = depth_.next(k_), feedback = feedback_.next(k_), mix = mix_.next(k_);
      const double yl = l_.read((.0003 + depth * (.5 + .5 * std::sin(phase_)) * .006) * sampleRate_);
      const double yr = r_.read((.0003 + depth * (.5 + .5 * std::sin(phase_ + pi / 2)) * .006) * sampleRate_);
      l_.push(static_cast<float>(s[2 * i] + feedback * yl)); r_.push(static_cast<float>(s[2 * i + 1] + feedback * yr));
      const double wet = .5 * mix * (1 - .5 * feedback);
      s[2 * i] = static_cast<float>(s[2 * i] * (1 - .5 * mix) + wet * yl); s[2 * i + 1] = static_cast<float>(s[2 * i + 1] * (1 - .5 * mix) + wet * yr);
      phase_ += step; if (phase_ >= 2 * pi) phase_ -= 2 * pi;
    }
  }
  void reset() noexcept override { l_.reset(); r_.reset(); phase_ = 0; }
  void takeStateFrom(StereoProcessor& previous) noexcept override {
    if (auto* p = dynamic_cast<FlangerFx*>(&previous)) { l_.takeStateFrom(p->l_); r_.takeStateFrom(p->r_); phase_ = p->phase_; depth_.follow(p->depth_); feedback_.follow(p->feedback_); mix_.follow(p->mix_); }
  }
  double tailSeconds() const noexcept override { return tail_; }
 private:
  Ring l_, r_; double rate_, phase_ = 0, tail_; Smooth depth_, feedback_, mix_;
};

class PhaserFx final : public KernelBase {
 public:
  PhaserFx(double sr, const Reader& p) : KernelBase(sr), rate_(p("rate")) { depth_.set(p("depth")); feedback_.set(p("feedback")); mix_.set(p("mix")); }
  void process(float* s, std::uint32_t frames) noexcept override {
    const double step = 2 * pi * rate_ / sampleRate_;
    for (std::uint32_t i = 0; i < frames; ++i) {
      const double depth = depth_.next(k_), feedback = feedback_.next(k_), mix = mix_.next(k_);
      for (unsigned c = 0; c < 2; ++c) {
        const double x = s[2 * i + c];
        const double lfo = .5 + .5 * std::sin(phase_ + (c ? pi / 2 : 0));
        const double frequency = 200 * std::pow(16.0, .5 + (lfo - .5) * depth);
        const double t = std::tan(pi * std::min(frequency, sampleRate_ * .45) / sampleRate_), a = (t - 1) / (t + 1);
        double y = x + feedback * last_[c];
        for (auto& z : state_[c]) { const double out = a * y + z; z = y - a * out; if (std::abs(z) < 1e-30) z = 0; y = out; }
        last_[c] = y;
        s[2 * i + c] = static_cast<float>(x * (1 - .5 * mix) + .5 * mix * y);
      }
      phase_ += step; if (phase_ >= 2 * pi) phase_ -= 2 * pi;
    }
  }
  void reset() noexcept override { state_ = {}; last_ = {}; phase_ = 0; }
  void takeStateFrom(StereoProcessor& previous) noexcept override {
    if (auto* p = dynamic_cast<PhaserFx*>(&previous)) { state_ = p->state_; last_ = p->last_; phase_ = p->phase_; depth_.follow(p->depth_); feedback_.follow(p->feedback_); mix_.follow(p->mix_); }
  }
  double tailSeconds() const noexcept override { return .05; }
 private:
  double rate_, phase_ = 0; Smooth depth_, feedback_, mix_;
  std::array<std::array<double, 6>, 2> state_{}; std::array<double, 2> last_{};
};

class TremoloFx final : public KernelBase {
 public:
  TremoloFx(double sr, const Reader& p, double bpm) : KernelBase(sr) {
    const double sync = p("sync"); rate_ = sync > 0 ? bpm / 60 / sync : p("rate");
    depth_.set(p("depth")); shape_.set(p("shape")); pan_.set(p("pan") >= .5 ? 1 : 0);
  }
  void process(float* s, std::uint32_t frames) noexcept override {
    const double step = 2 * pi * rate_ / sampleRate_;
    for (std::uint32_t i = 0; i < frames; ++i) {
      const double depth = depth_.next(k_), shape = shape_.next(k_), pan = pan_.next(k_);
      const double kk = .01 + shape * 9, wave = std::tanh(kk * std::sin(phase_)) / std::tanh(kk);
      const double trem = 1 - depth * .5 * (1 - wave);
      const double gl = trem * (1 - pan) + (1 - depth * .5 * (1 + wave)) * pan, gr = trem * (1 - pan) + (1 - depth * .5 * (1 - wave)) * pan;
      s[2 * i] = static_cast<float>(s[2 * i] * gl); s[2 * i + 1] = static_cast<float>(s[2 * i + 1] * gr);
      phase_ += step; if (phase_ >= 2 * pi) phase_ -= 2 * pi;
    }
  }
  void reset() noexcept override { phase_ = 0; }
  void takeStateFrom(StereoProcessor& previous) noexcept override {
    if (auto* p = dynamic_cast<TremoloFx*>(&previous)) { phase_ = p->phase_; depth_.follow(p->depth_); shape_.follow(p->shape_); pan_.follow(p->pan_); }
  }
 private:
  double rate_ = 4, phase_ = 0; Smooth depth_, shape_, pan_;
};

// Zero-latency peak limiter: instant attack, exponential release, hard ceiling guarantee.
class LimiterFx final : public KernelBase {
 public:
  LimiterFx(double sr, const Reader& p) : KernelBase(sr), ceiling_(dbToGain(p("ceiling"))),
      release_(1 - std::exp(-1 / (p("release") * .001 * sr))), tail_(p("release") * .007) { pre_.set(dbToGain(p("gain"))); }
  void process(float* s, std::uint32_t frames) noexcept override {
    const double c = ceiling_;
    double loudest = 0, lowest = 1;
    for (std::uint32_t i = 0; i < frames; ++i) {
      const double pre = pre_.next(k_), xl = s[2 * i] * pre, xr = s[2 * i + 1] * pre;
      const double peak = std::max(std::abs(xl), std::abs(xr)), target = peak > c ? c / peak : 1;
      if (target < gain_) gain_ = target; else gain_ += (target - gain_) * release_;
      s[2 * i] = static_cast<float>(bounded(xl * gain_, -c, c)); s[2 * i + 1] = static_cast<float>(bounded(xr * gain_, -c, c));
      loudest = std::max(loudest, peak / pre); lowest = std::min(lowest, gain_);
    }
    tap_.add(static_cast<float>(loudest), static_cast<float>(lowest));
  }
  DynamicsTap* dynamics() noexcept override { return &tap_; }
  void reset() noexcept override { gain_ = 1; }
  void takeStateFrom(StereoProcessor& previous) noexcept override { if (auto* p = dynamic_cast<LimiterFx*>(&previous)) { gain_ = p->gain_; pre_.follow(p->pre_); } }
  double tailSeconds() const noexcept override { return tail_; }
 private:
  double ceiling_, release_, tail_, gain_ = 1; Smooth pre_; DynamicsTap tap_;
};

// Noise gate: peak detector, 4 dB hysteresis, hold, then attack/release ramps of the gain.
class GateFx final : public KernelBase {
 public:
  GateFx(double sr, const Reader& p) : KernelBase(sr), open_(dbToGain(p("threshold"))), close_(open_ * dbToGain(-4)),
      attack_(1 - std::exp(-1 / (p("attack") * .001 * sr))), release_(1 - std::exp(-6.9 / (p("release") * .001 * sr))),
      detector_(std::exp(-1 / (.01 * sr))), holdFrames_(static_cast<long>(std::floor(p("hold") * .001 * sr + .5))),
      tail_((p("hold") + p("release") * 1.5) * .001) {}
  void process(float* s, std::uint32_t frames) noexcept override {
    double loudest = 0, lowest = 1;
    for (std::uint32_t i = 0; i < frames; ++i) {
      const double peak = std::max(std::abs(s[2 * i]), std::abs(s[2 * i + 1]));
      loudest = std::max(loudest, peak);
      envelope_ = peak > envelope_ ? peak : envelope_ * detector_;
      if (envelope_ >= open_) { open = true; held_ = holdFrames_; }
      else if (envelope_ < close_) { if (held_ > 0) --held_; else open = false; }
      if (open) gain_ += (1 - gain_) * attack_;
      else { gain_ -= gain_ * release_; if (gain_ < 1e-4) gain_ = 0; }
      s[2 * i] = static_cast<float>(s[2 * i] * gain_); s[2 * i + 1] = static_cast<float>(s[2 * i + 1] * gain_);
      lowest = std::min(lowest, gain_);
    }
    tap_.add(static_cast<float>(loudest), static_cast<float>(lowest));
  }
  DynamicsTap* dynamics() noexcept override { return &tap_; }
  void reset() noexcept override { envelope_ = gain_ = 0; held_ = 0; open = false; }
  void takeStateFrom(StereoProcessor& previous) noexcept override {
    if (auto* p = dynamic_cast<GateFx*>(&previous)) { envelope_ = p->envelope_; gain_ = p->gain_; held_ = p->held_; open = p->open; }
  }
  double tailSeconds() const noexcept override { return tail_; }
 private:
  double open_, close_, attack_, release_, detector_; long holdFrames_; double tail_;
  double envelope_ = 0, gain_ = 0; long held_ = 0; bool open = false; DynamicsTap tap_;
};

// Asymmetric tanh saturation, head bump and a warmth-controlled high roll-off.
class TapeFx final : public KernelBase {
 public:
  TapeFx(double sr, const Reader& p) : KernelBase(sr) {
    const double pre = dbToGain(p("drive")), warmth = p("warmth");
    pre_.set(pre); post_.set(std::pow(pre, -.8)); mix_.set(p("mix")); out_.set(dbToGain(p("output")));
    lowpass_.configure(Filter::Lowpass, sr, 20000 * std::pow(.25, warmth), .5);
    bump_.configure(Filter::LowShelf, sr, 110, .707, 3 * warmth);
    dc_.configure(Filter::Highpass, sr, 20, .5);
  }
  void process(float* s, std::uint32_t frames) noexcept override {
    constexpr double bias = .15; const double origin = std::tanh(bias);
    for (std::uint32_t i = 0; i < frames; ++i) {
      const double pre = pre_.next(k_), post = post_.next(k_), mix = mix_.next(k_), out = out_.next(k_);
      for (unsigned c = 0; c < 2; ++c) {
        const double x = s[2 * i + c];
        const float shaped = static_cast<float>((std::tanh(x * pre + bias) - origin) * post);
        const double y = dc_.sample(bump_.sample(lowpass_.sample(shaped, c), c), c);
        s[2 * i + c] = static_cast<float>((x * (1 - mix) + y * mix) * out);
      }
    }
  }
  void reset() noexcept override { lowpass_.reset(); bump_.reset(); dc_.reset(); }
  void takeStateFrom(StereoProcessor& previous) noexcept override {
    if (auto* p = dynamic_cast<TapeFx*>(&previous)) {
      lowpass_.takeHistoryFrom(p->lowpass_); bump_.takeHistoryFrom(p->bump_); dc_.takeHistoryFrom(p->dc_);
      pre_.follow(p->pre_); post_.follow(p->post_); mix_.follow(p->mix_); out_.follow(p->out_);
    }
  }
 private:
  Smooth pre_, post_, mix_, out_; Biquad lowpass_, bump_, dc_;
};

// Sample-and-hold downsampling followed by mid-tread quantisation to `bits`.
class BitcrusherFx final : public KernelBase {
 public:
  BitcrusherFx(double sr, const Reader& p) : KernelBase(sr), levels_(std::pow(2.0, p("bits") - 1)), factor_(p("downsample")) { mix_.set(p("mix")); }
  void process(float* s, std::uint32_t frames) noexcept override {
    for (std::uint32_t i = 0; i < frames; ++i) {
      const double mix = mix_.next(k_);
      if (countdown_ <= 0) { holdL_ = s[2 * i]; holdR_ = s[2 * i + 1]; countdown_ += factor_; }
      countdown_ -= 1;
      const double ql = std::floor(holdL_ * levels_ + .5) / levels_, qr = std::floor(holdR_ * levels_ + .5) / levels_;
      s[2 * i] = static_cast<float>(s[2 * i] * (1 - mix) + ql * mix); s[2 * i + 1] = static_cast<float>(s[2 * i + 1] * (1 - mix) + qr * mix);
    }
  }
  void reset() noexcept override { countdown_ = 0; holdL_ = holdR_ = 0; }
  void takeStateFrom(StereoProcessor& previous) noexcept override {
    if (auto* p = dynamic_cast<BitcrusherFx*>(&previous)) { countdown_ = p->countdown_; holdL_ = p->holdL_; holdR_ = p->holdR_; mix_.follow(p->mix_); }
  }
 private:
  double levels_, factor_, countdown_ = 0, holdL_ = 0, holdR_ = 0; Smooth mix_;
};

// Gain, balance, mid/side width, mono sum and per-side polarity.
class UtilityFx final : public KernelBase {
 public:
  UtilityFx(double sr, const Reader& p) : KernelBase(sr) {
    const int phase = static_cast<int>(std::lround(p("phase")));
    gain_.set(dbToGain(p("gain"))); pan_.set(p("pan")); width_.set(p("mono") >= .5 ? 0 : p("width"));
    signL_.set(phase & 1 ? -1 : 1); signR_.set(phase & 2 ? -1 : 1);
  }
  void process(float* s, std::uint32_t frames) noexcept override {
    for (std::uint32_t i = 0; i < frames; ++i) {
      const double gain = gain_.next(k_), pan = pan_.next(k_), width = width_.next(k_);
      const double a = s[2 * i] * signL_.next(k_), b = s[2 * i + 1] * signR_.next(k_);
      const double mid = .5 * (a + b), side = .5 * (a - b) * width;
      s[2 * i] = static_cast<float>((mid + side) * (pan > 0 ? 1 - pan : 1) * gain);
      s[2 * i + 1] = static_cast<float>((mid - side) * (pan < 0 ? 1 + pan : 1) * gain);
    }
  }
  void reset() noexcept override {}
  void takeStateFrom(StereoProcessor& previous) noexcept override {
    if (auto* p = dynamic_cast<UtilityFx*>(&previous)) { gain_.follow(p->gain_); pan_.follow(p->pan_); width_.follow(p->width_); signL_.follow(p->signL_); signR_.follow(p->signR_); }
  }
 private:
  Smooth gain_, pan_, width_, signL_, signR_;
};

// Studio delay (kernels.ts DelayKernel): stereo or ping-pong; band-limited feedback path; Tape (age)
// adds 0.7 Hz wow, 7.3 Hz flutter and loop saturation. Every repeat passes through the filters.
class StudioDelay final : public KernelBase {
 public:
  StudioDelay(double sr, const Reader& p, double bpm) : KernelBase(sr), l_(static_cast<std::size_t>(std::ceil(sr * 4.1)) + 4), r_(l_),
      glide_(1 - std::exp(-1 / (.08 * sr))), lowcut_(p("lowcut") > 20.5), pingPong_(p("mode") >= .5) {
    const double seconds = std::min(3.9, p("sync") >= .5 ? p("time") * 60 / bpm : p("ms") * .001);
    wet_.set(p("amount") * .45); dry_.set(p("dry")); feedback_.set(p("feedback")); age_.set(p("age")); time_.set(seconds * sr);
    low_.configure(Filter::Lowpass, sr, p("tone"), 1); high_.configure(Filter::Highpass, sr, p("lowcut"), .5);
    const double fb = p("feedback"), repeats = fb > .01 ? std::ceil(std::log(.001) / std::log(fb)) : 1;
    tail_ = p("amount") > 0 ? std::min(30.0, (seconds + p("age") * .0026) * (repeats + 1) + .85) : 0;
  }
  void process(float* s, std::uint32_t frames) noexcept override {
    const double wowStep = 2 * pi * .7 / sampleRate_, flutterStep = 2 * pi * 7.3 / sampleRate_;
    for (std::uint32_t i = 0; i < frames; ++i) {
      const double wet = wet_.next(k_), dry = dry_.next(k_), feedback = feedback_.next(k_), age = age_.next(k_), time = time_.next(glide_);
      const double wobble = age * sampleRate_ * (.0014 + .0012 * std::sin(wow_) + .00015 * std::sin(flutter_));
      const double read = std::max(0.0, time + wobble - 1), drive = 1 + 2 * age;
      double fl = low_.sample(l_.read(read), 0), fr = low_.sample(r_.read(read), 1);
      if (lowcut_) { fl = high_.sample(static_cast<float>(fl), 0); fr = high_.sample(static_cast<float>(fr), 1); }
      if (age > 1e-4) { fl = std::tanh(fl * drive) / drive; fr = std::tanh(fr * drive) / drive; }
      const double xl = s[2 * i], xr = s[2 * i + 1];
      if (pingPong_) { l_.push(static_cast<float>(.5 * (xl + xr) + feedback * fr)); r_.push(static_cast<float>(feedback * fl)); }
      else { l_.push(static_cast<float>(xl + feedback * fl)); r_.push(static_cast<float>(xr + feedback * fr)); }
      s[2 * i] = static_cast<float>(dry * xl + wet * fl); s[2 * i + 1] = static_cast<float>(dry * xr + wet * fr);
      wow_ += wowStep; if (wow_ >= 2 * pi) wow_ -= 2 * pi;
      flutter_ += flutterStep; if (flutter_ >= 2 * pi) flutter_ -= 2 * pi;
    }
  }
  void reset() noexcept override { l_.reset(); r_.reset(); low_.reset(); high_.reset(); wow_ = flutter_ = 0; }
  void takeStateFrom(StereoProcessor& previous) noexcept override {
    if (auto* p = dynamic_cast<StudioDelay*>(&previous)) {
      l_.takeStateFrom(p->l_); r_.takeStateFrom(p->r_); low_.takeHistoryFrom(p->low_); high_.takeHistoryFrom(p->high_);
      wet_.follow(p->wet_); dry_.follow(p->dry_); feedback_.follow(p->feedback_); age_.follow(p->age_); time_.follow(p->time_); wow_ = p->wow_; flutter_ = p->flutter_;
    }
  }
  double tailSeconds() const noexcept override { return tail_; }
 private:
  Ring l_, r_; Biquad low_, high_; Smooth wet_, dry_, feedback_, age_, time_;
  double glide_, tail_ = 0, wow_ = 0, flutter_ = 0; bool lowcut_, pingPong_;
};

std::unique_ptr<StereoProcessor> makeSigimsae(std::string_view type, const Parameters& params, double sr, double bpm) {
  if (type == "delay") {
    Reader p(params, {{"amount",.3,0,1},{"time",.75,1.0/6,4},{"feedback",.32,0,.95},{"tone",3800,500,16000},{"lowcut",20,20,2000},
      {"age",0,0,1},{"sync",1,0,1},{"ms",375,1,2000},{"mode",0,0,1},{"dry",1,0,1}});
    return std::make_unique<StudioDelay>(sr, p, bpm);
  }
  if (type == "chorus") { Reader p(params, {{"rate",.8,.05,5},{"depth",.5,0,1},{"mix",.5,0,1}}); return std::make_unique<ChorusFx>(sr, p); }
  if (type == "phaser") { Reader p(params, {{"rate",.5,.05,5},{"depth",.7,0,1},{"feedback",.4,0,.9},{"mix",1,0,1}}); return std::make_unique<PhaserFx>(sr, p); }
  if (type == "flanger") { Reader p(params, {{"rate",.25,.05,5},{"depth",.7,0,1},{"feedback",.6,0,.95},{"mix",1,0,1}}); return std::make_unique<FlangerFx>(sr, p); }
  if (type == "tremolo") { Reader p(params, {{"rate",4,.1,20},{"depth",.5,0,1},{"shape",0,0,1},{"sync",0,0,4},{"pan",0,0,1}}); return std::make_unique<TremoloFx>(sr, p, bpm); }
  if (type == "limiter") { Reader p(params, {{"gain",0,0,24},{"ceiling",-1,-24,0},{"release",100,10,1000}}); return std::make_unique<LimiterFx>(sr, p); }
  if (type == "gate") { Reader p(params, {{"threshold",-50,-80,0},{"attack",1,.1,50},{"hold",50,0,500},{"release",150,5,2000}}); return std::make_unique<GateFx>(sr, p); }
  if (type == "tape") { Reader p(params, {{"drive",6,0,24},{"warmth",.5,0,1},{"mix",1,0,1},{"output",0,-24,6}}); return std::make_unique<TapeFx>(sr, p); }
  if (type == "bitcrusher") { Reader p(params, {{"bits",8,1,16},{"downsample",4,1,32},{"mix",1,0,1}}); return std::make_unique<BitcrusherFx>(sr, p); }
  if (type == "utility") { Reader p(params, {{"gain",0,-36,24},{"pan",0,-1,1},{"width",1,0,2},{"mono",0,0,1},{"phase",0,0,3}}); return std::make_unique<UtilityFx>(sr, p); }
  return nullptr;
}

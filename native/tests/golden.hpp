// Golden reference renders for the parity tests (docs/RUST_ENGINE.md 7). Until 0.3.2 the parity tests rendered every
// case through the C++ track path and through the Rust engine and compared the two. 0.3.3 removed the C++ track
// path and the C++ effect DSP, so its output was recorded once (docs/RUST_ENGINE.md 7) and the tests now
// compare the Rust output against that recording:
//
//   * hash: FNV-1a 64 of the whole reference render (canonical: -0 hashes as +0). A case whose Rust render was
//     bit-identical to the C++ render when it was recorded (`exact`) must stay bit-identical on Windows x64 (MSVC
//     and MinGW), where the comparison tests always found the two engines bit-identical;
//   * gate (every platform): the residual against the reference stays <= -90 dBFS, the former C++ vs Rust gate.
//     The stored part of the reference keeps the files small: every `stride`-th sample, plus the RMS of equal
//     segments (64 by default), the peak and the RMS of the whole render. |rms(a) - rms(b)| <= max|a - b| (triangle inequality), so
//     the segment and whole-render checks use the same -90 dBFS threshold and test every sample, not only the
//     stored ones. Nothing here is looser than the former gate.
//   * aux: per-case numbers (latency, tails, meters, lengths) with a tolerance the test names.
//
// Recording (only possible with a C++ reference, i.e. from a checkout before 0.3.3): GARAK_GOLDEN_RECORD=1 makes
// Suite::record() collect entries and write native/tests/golden/<suite>.golden when the suite object is destroyed.
// The file format is little-endian binary (see Suite::save).
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

#ifndef GARAK_GOLDEN_DIR
#error "GARAK_GOLDEN_DIR must name native/tests/golden"
#endif

namespace golden {

constexpr double gateDb = -90;
inline double gateLinear() { return std::pow(10.0, gateDb / 20); }
inline double dbfs(double v) { return v > 0 ? 20 * std::log10(v) : -400; }

// Windows x64: the platforms where the C++ and Rust engines were bit-identical (MSVC in CI, MinGW locally).
#if defined(_WIN32) && (defined(_M_X64) || defined(__x86_64__))
constexpr bool exactPlatform = true;
#else
constexpr bool exactPlatform = false;
#endif

inline std::uint64_t hash(const float* data, std::size_t count, std::uint64_t h = 1469598103934665603ULL) {
  for (std::size_t i = 0; i < count; ++i) {
    std::uint32_t bits = 0;
    const float v = data[i] == 0 ? 0.f : data[i];
    std::memcpy(&bits, &v, sizeof bits);
    for (int b = 0; b < 4; ++b) { h ^= (bits >> (8 * b)) & 0xffu; h *= 1099511628211ULL; }
  }
  return h;
}
inline std::uint64_t hash(const std::vector<float>& v) { return hash(v.data(), v.size()); }

struct Entry {
  bool exact = false;
  std::uint64_t count = 0, hash = 0;
  std::uint32_t stride = 1;
  float peak = 0, rms = 0;
  std::vector<float> subset, segments;
  std::vector<double> aux;
};

inline std::vector<float> segmentRms(const std::vector<float>& v, std::size_t segments) {
  std::vector<float> out;
  if (v.empty()) return out;
  const std::size_t n = std::min(segments, v.size());
  for (std::size_t s = 0; s < n; ++s) {
    const std::size_t a = v.size() * s / n, b = v.size() * (s + 1) / n;
    double sum = 0;
    for (std::size_t i = a; i < b; ++i) sum += double(v[i]) * v[i];
    out.push_back(static_cast<float>(std::sqrt(sum / double(std::max<std::size_t>(1, b - a)))));
  }
  return out;
}
inline void peakRms(const std::vector<float>& v, float& peak, float& rms) {
  double p = 0, sum = 0;
  for (const float x : v) { p = std::max(p, double(std::abs(x))); sum += double(x) * x; }
  peak = static_cast<float>(p);
  rms = static_cast<float>(v.empty() ? 0 : std::sqrt(sum / double(v.size())));
}

struct Result {
  bool ok = false, bitIdentical = false;
  double residual = 1e9; // Worst linear difference over every check (stored samples, segments, peak, rms).
  std::string message;
  [[nodiscard]] std::string verdict() const {
    if (bitIdentical) return "bit-identical";
    char buffer[64];
    std::snprintf(buffer, sizeof buffer, "%.1f dBFS", dbfs(residual));
    return buffer;
  }
};

class Suite {
 public:
  explicit Suite(std::string name) : name_(std::move(name)), path_(std::string(GARAK_GOLDEN_DIR) + "/" + name_ + ".golden") {
    const char* record = std::getenv("GARAK_GOLDEN_RECORD");
    recording_ = record && *record && std::string(record) != "0";
    if (!recording_) load();
  }
  ~Suite() { if (recording_ && !entries_.empty()) save(); }
  Suite(const Suite&) = delete;
  Suite& operator=(const Suite&) = delete;
  [[nodiscard]] bool recording() const noexcept { return recording_; }

  // Record mode: `reference` is the C++ render; `rust` (optional) the Rust render of the same case, so the entry
  // knows whether the two were bit-identical. `stored`: how many samples of the reference to keep.
  void record(const std::string& key, const std::vector<float>& reference, const std::vector<float>* rust,
              std::vector<double> aux = {}, std::size_t stored = 2048, std::size_t segments = 64) {
    if (!recording_) return;
    if (entries_.count(key)) throw std::logic_error("duplicate golden case: " + key);
    Entry e;
    e.count = reference.size();
    e.hash = hash(reference);
    e.exact = rust && rust->size() == reference.size() && hash(*rust) == e.hash;
    e.stride = static_cast<std::uint32_t>(std::max<std::size_t>(1, (reference.size() + stored - 1) / std::max<std::size_t>(1, stored)));
    for (std::size_t i = 0; i < reference.size(); i += e.stride) e.subset.push_back(reference[i]);
    e.segments = segmentRms(reference, segments);
    peakRms(reference, e.peak, e.rms);
    e.aux = std::move(aux);
    entries_[key] = std::move(e);
    order_.push_back(key);
  }

  // `tolerance`: absolute tolerance per aux value (one value for all, or one per value).
  Result check(const std::string& key, const std::vector<float>& got, const std::vector<double>& aux = {},
               const std::vector<double>& tolerance = {0}) const {
    Result r;
    const auto found = entries_.find(key);
    if (found == entries_.end()) { r.message = "no golden reference for " + key + " in " + path_; return r; }
    const auto& e = found->second;
    if (got.size() != e.count) { r.message = key + ": length " + std::to_string(got.size()) + " != golden " + std::to_string(e.count); return r; }
    if (aux.size() != e.aux.size()) { r.message = key + ": aux count differs from the golden reference"; return r; }
    for (std::size_t i = 0; i < aux.size(); ++i) {
      const double tol = tolerance.empty() ? 0 : tolerance[std::min(i, tolerance.size() - 1)];
      if (!(std::abs(aux[i] - e.aux[i]) <= tol)) {
        char buffer[160];
        std::snprintf(buffer, sizeof buffer, "%s: aux[%zu] = %.17g, golden %.17g (tolerance %g)", key.c_str(), i, aux[i], e.aux[i], tol);
        r.message = buffer; return r;
      }
    }
    const bool same = hash(got) == e.hash;
    double worst = 0;
    for (std::size_t i = 0, k = 0; i < got.size() && k < e.subset.size(); i += e.stride, ++k) worst = std::max(worst, double(std::abs(got[i] - e.subset[k])));
    const auto segments = segmentRms(got, e.segments.size());
    for (std::size_t s = 0; s < segments.size() && s < e.segments.size(); ++s) worst = std::max(worst, double(std::abs(segments[s] - e.segments[s])));
    float peak = 0, rms = 0;
    peakRms(got, peak, rms);
    worst = std::max({worst, double(std::abs(peak - e.peak)), double(std::abs(rms - e.rms))});
    r.residual = same ? 0 : worst;
    r.bitIdentical = same;
    if (e.exact && exactPlatform && !same) {
      r.message = key + ": not bit-identical to the C++ reference on Windows x64 (stored-sample residual " + std::to_string(dbfs(worst)) + " dBFS)";
      return r;
    }
    if (!(worst <= gateLinear())) { r.message = key + ": residual " + std::to_string(dbfs(worst)) + " dBFS above the -90 dBFS gate"; return r; }
    r.ok = true;
    return r;
  }
  [[nodiscard]] bool exactCase(const std::string& key) const { const auto f = entries_.find(key); return f != entries_.end() && f->second.exact; }
  [[nodiscard]] std::size_t size() const noexcept { return entries_.size(); }

 private:
  std::string name_, path_;
  bool recording_ = false;
  std::map<std::string, Entry> entries_;
  std::vector<std::string> order_;

  template<class T> static void put(std::FILE* f, const T& v) { std::fwrite(&v, sizeof v, 1, f); }
  template<class T> static bool get(std::FILE* f, T& v) { return std::fread(&v, sizeof v, 1, f) == 1; }

  // "GKGOLD01", u32 entries; per entry: u16 key length + key, u8 exact, u64 count, u64 hash, u32 stride,
  // f32 peak, f32 rms, u32 n + f32 subset[n], u32 n + f32 segments[n], u32 n + f64 aux[n].
  void save() const {
    std::FILE* f = std::fopen(path_.c_str(), "wb");
    if (!f) { std::fprintf(stderr, "cannot write %s\n", path_.c_str()); return; }
    std::fwrite("GKGOLD01", 1, 8, f);
    put(f, static_cast<std::uint32_t>(order_.size()));
    for (const auto& key : order_) {
      const auto& e = entries_.at(key);
      put(f, static_cast<std::uint16_t>(key.size())); std::fwrite(key.data(), 1, key.size(), f);
      put(f, static_cast<std::uint8_t>(e.exact)); put(f, e.count); put(f, e.hash); put(f, e.stride); put(f, e.peak); put(f, e.rms);
      put(f, static_cast<std::uint32_t>(e.subset.size())); std::fwrite(e.subset.data(), sizeof(float), e.subset.size(), f);
      put(f, static_cast<std::uint32_t>(e.segments.size())); std::fwrite(e.segments.data(), sizeof(float), e.segments.size(), f);
      put(f, static_cast<std::uint32_t>(e.aux.size())); std::fwrite(e.aux.data(), sizeof(double), e.aux.size(), f);
    }
    std::fclose(f);
    std::fprintf(stderr, "recorded %zu golden cases into %s\n", order_.size(), path_.c_str());
  }
  void load() {
    std::FILE* f = std::fopen(path_.c_str(), "rb");
    if (!f) return; // check() then reports the missing references.
    char magic[8]{};
    std::uint32_t count = 0;
    bool ok = std::fread(magic, 1, 8, f) == 8 && std::memcmp(magic, "GKGOLD01", 8) == 0 && get(f, count);
    for (std::uint32_t i = 0; ok && i < count; ++i) {
      std::uint16_t length = 0; std::uint8_t exact = 0; std::uint32_t n = 0;
      Entry e;
      std::string key;
      ok = get(f, length);
      key.resize(length);
      ok = ok && std::fread(key.data(), 1, length, f) == length && get(f, exact) && get(f, e.count) && get(f, e.hash) && get(f, e.stride) && get(f, e.peak) && get(f, e.rms);
      ok = ok && get(f, n); e.subset.resize(n); ok = ok && std::fread(e.subset.data(), sizeof(float), n, f) == n;
      ok = ok && get(f, n); e.segments.resize(n); ok = ok && std::fread(e.segments.data(), sizeof(float), n, f) == n;
      ok = ok && get(f, n); e.aux.resize(n); ok = ok && std::fread(e.aux.data(), sizeof(double), n, f) == n;
      e.exact = exact != 0;
      if (ok) entries_[key] = std::move(e);
    }
    std::fclose(f);
    if (!ok) throw std::runtime_error("corrupt golden file " + path_);
  }
};

} // namespace golden

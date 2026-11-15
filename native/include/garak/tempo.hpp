#pragma once
// Tempo map (docs/TEMPO_MAP.md): the native mirror of src/core/tempoMap.ts. The UI compiles every note,
// audio window and cycle frame through the TypeScript map; the host uses this one for the metronome,
// tempo-synced effects and the VST3 transport, so both must agree to the sample.
//
// Points are sorted by beat, the first at beat 0. A point's `ramp` shapes the segment after it: the
// tempo changes linearly in beats to the next point's tempo; otherwise it steps. A ramp integrates
// exactly: t = 60/k * log1p(k*db/v0) and db = v0/k * expm1(k*t/60) (k = bpm per beat).
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <vector>

namespace garak {

struct TempoPoint {
  double beat = 0, bpm = 120;
  bool ramp = false;
  bool operator==(const TempoPoint&) const = default;
};

class TempoMap {
 public:
  TempoMap() { build(120, {}); }
  TempoMap(double bpm, const std::vector<TempoPoint>& points) { build(bpm, points); }

  // Control thread only (allocates). Points after the first must already be sorted and unique (the UI
  // normalizes them); anything else is dropped rather than reordered.
  void build(double bpm, const std::vector<TempoPoint>& points) {
    points_.clear(); seconds_.clear(); slopes_.clear();
    points_.push_back({0, clampBpm(points.empty() ? bpm : points.front().bpm), !points.empty() && points.front().ramp});
    for (std::size_t i = 1; i < points.size(); ++i) {
      const auto& p = points[i];
      if (!std::isfinite(p.beat) || !(p.beat > points_.back().beat)) continue;
      points_.push_back({p.beat, clampBpm(p.bpm), p.ramp});
    }
    seconds_.push_back(0);
    for (std::size_t i = 0; i < points_.size(); ++i) {
      const bool hasNext = i + 1 < points_.size();
      const double slope = hasNext && points_[i].ramp ? (points_[i + 1].bpm - points_[i].bpm) / (points_[i + 1].beat - points_[i].beat) : 0;
      slopes_.push_back(slope);
      if (hasNext) seconds_.push_back(seconds_[i] + segmentSeconds(points_[i].bpm, slope, points_[i + 1].beat - points_[i].beat));
    }
  }

  [[nodiscard]] const std::vector<TempoPoint>& points() const noexcept { return points_; }
  [[nodiscard]] bool constant() const noexcept {
    for (const auto& p : points_) if (std::abs(p.bpm - points_.front().bpm) > 1e-9) return false;
    return true;
  }

  [[nodiscard]] double bpmAt(double beat) const noexcept {
    if (!(beat > 0)) return points_.front().bpm;
    const auto i = segmentAt(beat);
    return points_[i].bpm + slopes_[i] * (beat - points_[i].beat);
  }
  [[nodiscard]] double secondsAt(double beat) const noexcept {
    if (beat <= 0) return beat * 60.0 / points_.front().bpm;
    const auto i = segmentAt(beat);
    return seconds_[i] + segmentSeconds(points_[i].bpm, slopes_[i], beat - points_[i].beat);
  }
  [[nodiscard]] double beatAt(double seconds) const noexcept {
    if (seconds <= 0) return seconds * points_.front().bpm / 60.0;
    std::size_t lo = 0, hi = points_.size() - 1;
    while (lo < hi) { const auto mid = (lo + hi + 1) / 2; if (seconds_[mid] <= seconds) lo = mid; else hi = mid - 1; }
    return points_[lo].beat + segmentBeats(points_[lo].bpm, slopes_[lo], seconds - seconds_[lo]);
  }
  // Unrounded project frame of a beat, and the beat at a project frame.
  [[nodiscard]] double frameAt(double beat, double sampleRate) const noexcept { return secondsAt(beat) * sampleRate; }
  [[nodiscard]] double beatAtFrame(double frame, double sampleRate) const noexcept { return beatAt(frame / sampleRate); }

 private:
  std::vector<TempoPoint> points_;
  std::vector<double> seconds_, slopes_;

  static double clampBpm(double bpm) noexcept { return std::isfinite(bpm) ? std::clamp(bpm, 20.0, 400.0) : 120.0; }
  [[nodiscard]] std::size_t segmentAt(double beat) const noexcept {
    std::size_t lo = 0, hi = points_.size() - 1;
    while (lo < hi) { const auto mid = (lo + hi + 1) / 2; if (points_[mid].beat <= beat) lo = mid; else hi = mid - 1; }
    return lo;
  }
  static double segmentSeconds(double bpm, double slope, double beats) noexcept {
    return slope == 0 ? beats * 60.0 / bpm : 60.0 / slope * std::log1p(slope * beats / bpm);
  }
  static double segmentBeats(double bpm, double slope, double seconds) noexcept {
    return slope == 0 ? seconds * bpm / 60.0 : bpm / slope * std::expm1(slope * seconds / 60.0);
  }
};

} // namespace garak

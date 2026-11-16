#pragma once
// Meter map (docs/METER_MAP.md): the native mirror of src/core/meterMap.ts. Time-signature changes sit on
// bar lines; `bar` is a 0-based bar index and the first event is bar 0 with the project meter. Bars hold
// numerator * 4 / denominator quarter notes, so each event's start beat is the walk over the bars before it.
// The UI sends `beat` too; build() recomputes it from the bars (and the protocol rejects a mismatch) so a
// stale or hand-written payload can never move a downbeat.
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace garak {

struct MeterEvent {
  std::int64_t bar = 0;
  int numerator = 4, denominator = 4;
  double beat = 0; // Derived: quarter-note beat of the event's first bar line.
  bool operator==(const MeterEvent&) const = default;
};

class MeterMap {
 public:
  MeterMap() { build(4, 4, {}); }
  MeterMap(int numerator, int denominator, const std::vector<MeterEvent>& events) { build(numerator, denominator, events); }

  // Control thread only (allocates). Events after the first must be sorted by bar and unique (the UI
  // normalizes them); anything else is dropped rather than reordered. The first event takes the project meter.
  void build(int numerator, int denominator, const std::vector<MeterEvent>& events) {
    events_.clear();
    events_.push_back({0, std::max(1, numerator), std::max(1, denominator), 0});
    for (std::size_t i = 1; i < events.size(); ++i) {
      const auto& e = events[i];
      auto& last = events_.back();
      if (!(e.bar > last.bar) || e.numerator < 1 || e.denominator < 1) continue;
      events_.push_back({e.bar, e.numerator, e.denominator, last.beat + static_cast<double>(e.bar - last.bar) * barBeats(last)});
    }
  }

  [[nodiscard]] const std::vector<MeterEvent>& events() const noexcept { return events_; }
  [[nodiscard]] bool constant() const noexcept { return events_.size() < 2; }
  [[nodiscard]] static double barBeats(const MeterEvent& e) noexcept { return e.numerator * 4.0 / e.denominator; }
  [[nodiscard]] static double pulseBeats(const MeterEvent& e) noexcept { return 4.0 / e.denominator; }

  // Index of the event at or before `beat` (negative beats: the first).
  [[nodiscard]] std::size_t segmentAt(double beat) const noexcept {
    std::size_t lo = 0, hi = events_.size() - 1;
    while (lo < hi) { const auto mid = (lo + hi + 1) / 2; if (events_[mid].beat <= beat + 1e-7) lo = mid; else hi = mid - 1; }
    return lo;
  }
  [[nodiscard]] const MeterEvent& at(double beat) const noexcept { return events_[segmentAt(beat)]; }
  // Start beat of the bar containing `beat`.
  [[nodiscard]] double barStart(double beat) const noexcept {
    const auto& e = at(beat);
    const double length = barBeats(e);
    return e.beat + std::floor((beat - e.beat) / length + 1e-7) * length;
  }
  // First beat of segment `index + 1` (infinity after the last).
  [[nodiscard]] double segmentEnd(std::size_t index) const noexcept {
    return index + 1 < events_.size() ? events_[index + 1].beat : HUGE_VAL;
  }

 private:
  std::vector<MeterEvent> events_;
};

} // namespace garak

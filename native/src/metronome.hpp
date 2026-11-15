#pragma once
// Monitor-only metronome for the real-time RenderEngine. Clicks are mixed after
// the master bus, never into track inputs, the capture ring or offline export.
// Click PCM (one mono stroke per level) is synthesized by the UI and owned by
// the control thread; the callback only reads it. No allocation in here.
#include "garak/engine.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

namespace garak::metronome {

// Same grid as src/core/metronome.ts: one pulse per denominator note; groups of
// three pulses in compound meters (6/8, 9/8, 12/8, 6/16 ...); level 0 = bar
// downbeat, 1 = group start, 2 = other pulses. Bars start at project frame 0.
struct Grid {
  double pulseFrames = 0;
  int pulsesPerBar = 4, groupPulses = 4;
  [[nodiscard]] int level(std::int64_t pulse) const noexcept {
    const auto inBar = static_cast<int>(((pulse % pulsesPerBar) + pulsesPerBar) % pulsesPerBar);
    if (inBar == 0) return 0;
    return inBar % groupPulses == 0 ? 1 : 2;
  }
  [[nodiscard]] std::int64_t frameOf(std::int64_t pulse) const noexcept { return std::llround(static_cast<double>(pulse) * pulseFrames); }
};

inline Grid grid(double sampleRate, double bpm, int numerator, int denominator) noexcept {
  Grid g;
  const bool compound = denominator >= 8 && numerator > 3 && numerator % 3 == 0;
  g.pulseFrames = sampleRate * 60.0 / std::max(1.0, bpm) * (4.0 / std::max(1, denominator));
  g.pulsesPerBar = std::max(1, numerator);
  g.groupPulses = compound ? 3 : g.pulsesPerBar;
  return g;
}

struct Voice { const std::vector<float>* pcm = nullptr; std::size_t position = 0; };

struct Player {
  std::array<Voice, 6> voices{};
  std::size_t nextVoice = 0;

  // Continue every ringing stroke for `frames` frames.
  void mix(float* stereo, std::uint32_t frames, float gain) noexcept {
    for (auto& v : voices) mixVoice(v, stereo, 0, frames, gain);
  }
  // Start a stroke at `offset` inside the current block and mix it to the block end.
  void trigger(const std::vector<float>* pcm, float* stereo, std::uint32_t offset, std::uint32_t frames, float gain) noexcept {
    if (!pcm || pcm->empty() || offset >= frames) return;
    auto& v = voices[nextVoice]; nextVoice = (nextVoice + 1) % voices.size();
    v.pcm = pcm; v.position = 0;
    mixVoice(v, stereo, offset, frames, gain);
  }
  void clear() noexcept { for (auto& v : voices) v = {}; }

 private:
  static void mixVoice(Voice& v, float* stereo, std::uint32_t from, std::uint32_t frames, float gain) noexcept {
    if (!v.pcm) return;
    const auto& pcm = *v.pcm;
    for (std::uint32_t i = from; i < frames && v.position < pcm.size(); ++i) {
      const float s = pcm[v.position++] * gain;
      stereo[2 * i] += s; stereo[2 * i + 1] += s;
    }
    if (v.position >= pcm.size()) v = {};
  }
};

// Clicks of pulses whose exact frame lies in [begin, begin + frames), relative to
// `origin` (project frame 0 for the transport, count-in start for the count-in).
// `limit` excludes pulses at or after it (count-in length); <0 means no limit.
inline void clicks(const Grid& g, const MetronomeClicks& set, Player& player, float* stereo,
                   std::int64_t begin, std::uint32_t frames, float gain, std::int64_t limit = -1) noexcept {
  if (g.pulseFrames <= 0 || frames == 0) return;
  const auto end = begin + static_cast<std::int64_t>(frames);
  auto pulse = std::max<std::int64_t>(0, static_cast<std::int64_t>(std::floor(static_cast<double>(begin) / g.pulseFrames)) - 1);
  for (auto at = g.frameOf(pulse); at < end; at = g.frameOf(++pulse)) {
    if (at < begin || (limit >= 0 && at >= limit)) continue;
    player.trigger(&set.levels[static_cast<std::size_t>(g.level(pulse))], stereo, static_cast<std::uint32_t>(at - begin), frames, gain);
  }
}

} // namespace garak::metronome

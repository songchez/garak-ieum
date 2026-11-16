#pragma once
// Monitor-only metronome for the real-time RenderEngine. Clicks are mixed after
// the master bus, never into track inputs, the capture ring or offline export.
// Click PCM (one mono stroke per level) is synthesized by the UI and owned by
// the control thread; the callback only reads it. No allocation in here.
#include "garak/engine.hpp"
#include "garak/meter.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

namespace garak::metronome {

// Same grid as src/core/metronome.ts: one pulse per denominator note; groups of
// three pulses in compound meters (6/8, 9/8, 12/8, 6/16 ...); level 0 = bar
// downbeat, 1 = group start, 2 = other pulses. Bars start at project frame 0.
// With a tempo map (docs/TEMPO_MAP.md) pulses stay on the beat grid and their frames follow the map's
// steps and ramps exactly (garak/tempo.hpp, the mirror of src/core/tempoMap.ts); without one they are
// evenly `pulseFrames` apart (constant tempo and the count-in).
struct Grid {
  double pulseFrames = 0, pulseBeats = 1, sampleRate = 48000;
  const TempoMap* tempo = nullptr;
  int pulsesPerBar = 4, groupPulses = 4;
  [[nodiscard]] int level(std::int64_t pulse) const noexcept {
    const auto inBar = static_cast<int>(((pulse % pulsesPerBar) + pulsesPerBar) % pulsesPerBar);
    if (inBar == 0) return 0;
    return inBar % groupPulses == 0 ? 1 : 2;
  }
  [[nodiscard]] std::int64_t frameOf(std::int64_t pulse) const noexcept {
    const double at = static_cast<double>(pulse);
    return std::llround(tempo ? tempo->frameAt(at * pulseBeats, sampleRate) : at * pulseFrames);
  }
  // A pulse at or just before `frame` (never after it).
  [[nodiscard]] std::int64_t pulseBefore(std::int64_t frame) const noexcept {
    const double at = static_cast<double>(frame);
    return static_cast<std::int64_t>(std::floor(tempo ? tempo->beatAtFrame(at, sampleRate) / pulseBeats : at / pulseFrames)) - 1;
  }
};

inline Grid grid(double sampleRate, double bpm, int numerator, int denominator, const TempoMap* tempo = nullptr) noexcept {
  Grid g;
  const bool compound = denominator >= 8 && numerator > 3 && numerator % 3 == 0;
  g.pulseBeats = 4.0 / std::max(1, denominator); g.sampleRate = sampleRate; g.tempo = tempo;
  g.pulseFrames = sampleRate * 60.0 / std::max(1.0, bpm) * g.pulseBeats;
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
  auto pulse = std::max<std::int64_t>(0, g.pulseBefore(begin));
  for (auto at = g.frameOf(pulse); at < end; at = g.frameOf(++pulse)) {
    if (at < begin || (limit >= 0 && at >= limit)) continue;
    player.trigger(&set.levels[static_cast<std::size_t>(g.level(pulse))], stereo, static_cast<std::uint32_t>(at - begin), frames, gain);
  }
}

// Clicks across time-signature changes (docs/METER_MAP.md, the mirror of meterClicksInRange in
// src/core/metronome.ts): each meter's pulses restart on its first bar line, so every bar's first pulse is
// the level-0 downbeat and compound meters group their pulses in threes inside each bar. Pulse frames follow
// the tempo map when there is one, else `bpm`. Only used when the meter changes; one meter keeps clicks().
inline void meterClicks(const MeterMap& meters, double sampleRate, double bpm, const TempoMap* tempo, const MetronomeClicks& set, Player& player,
                        float* stereo, std::int64_t begin, std::uint32_t frames, float gain) noexcept {
  if (frames == 0) return;
  const double framesPerBeat = sampleRate * 60.0 / std::max(1.0, bpm);
  const auto frameOf = [&](double beat) { return std::llround(tempo ? tempo->frameAt(beat, sampleRate) : beat * framesPerBeat); };
  const double startBeat = std::max(0.0, tempo ? tempo->beatAtFrame(static_cast<double>(begin), sampleRate) : static_cast<double>(begin) / framesPerBeat);
  const auto end = begin + static_cast<std::int64_t>(frames);
  const auto& events = meters.events();
  for (auto index = meters.segmentAt(startBeat); index < events.size(); ++index) {
    const auto& e = events[index];
    const double until = meters.segmentEnd(index), pulse = MeterMap::pulseBeats(e);
    const Grid g = grid(sampleRate, bpm, e.numerator, e.denominator);
    // Start one pulse early: rounding can put a pulse's frame inside this block while its beat is just before it.
    for (auto k = std::max<std::int64_t>(0, static_cast<std::int64_t>(std::floor((startBeat - e.beat) / pulse)) - 1);; ++k) {
      const double beat = e.beat + static_cast<double>(k) * pulse;
      if (beat >= until - 1e-9) break;
      const auto at = frameOf(beat);
      if (at >= end) return;
      if (at < begin) continue;
      player.trigger(&set.levels[static_cast<std::size_t>(g.level(k))], stereo, static_cast<std::uint32_t>(at - begin), frames, gain);
    }
    if (!(until < HUGE_VAL) || frameOf(until) >= end) return;
  }
}

} // namespace garak::metronome

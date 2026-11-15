#pragma once
// Live MIDI routing for the audio callback (docs/MIDI_RECORDING.md): which
// tracks hear a message, with the track parameters the renderer's trackNote()
// applies (transpose, velocity offset, key/velocity limits), and a fixed table
// of sounding notes so note-offs follow the note-on, never the current routes.
// Pure and allocation-free after construction; unit-tested in midi_test.cpp.
#include "garak/engine.hpp"
#include <algorithm>
#include <array>
#include <cstdint>
#include <vector>

namespace garak::midi {

inline constexpr int anySource = -1;

struct MidiRoute {
  std::uint32_t track = 0;
  int source = anySource;   // source index, or anySource (모든 MIDI 입력)
  std::uint8_t channel = 0; // 0 = all channels, 1..16
  int transpose = 0, velocityOffset = 0;
  std::uint8_t keyLow = 0, keyHigh = 127, velocityLow = 1, velocityHigh = 127;
  [[nodiscard]] bool accepts(int fromSource, std::uint8_t fromChannel) const noexcept {
    return (source == anySource || source == fromSource) && (channel == 0 || channel == fromChannel);
  }
};

/** Immutable once published to the callback. */
struct MidiRouteTable { std::vector<MidiRoute> routes; };

/** trackNote(): null (false) when filtered out by the track's limits. */
inline bool transformNote(const MidiRoute& route, int pitch, int velocity, int& outPitch, int& outVelocity) noexcept {
  const int transposed = pitch + route.transpose;
  if (transposed < 0 || transposed > 127 || transposed < route.keyLow || transposed > route.keyHigh) return false;
  const int scaled = std::clamp(velocity + route.velocityOffset, 1, 127);
  if (scaled < route.velocityLow || scaled > route.velocityHigh) return false;
  outPitch = transposed; outVelocity = scaled; return true;
}

/** Host note IDs live above the renderer's own audition IDs. */
inline constexpr std::int32_t firstHostNoteId = 1'500'000'000;
inline constexpr std::int32_t lastHostNoteId = 2'000'000'000;

class NoteRouter {
 public:
  static constexpr std::size_t capacity = 512;
  struct Active { bool used = false; std::uint16_t source = 0; std::uint8_t channel = 0, pitch = 0, outPitch = 0; std::uint32_t track = 0; std::int32_t noteId = 0; };

  /** Routes one message, calling emit(LiveMidiEvent) for every track event. */
  template<class Emit> void handle(std::uint16_t source, std::uint8_t status, std::uint8_t data1, std::uint8_t data2,
                                   const MidiRouteTable* table, std::uint32_t offset, Emit&& emit) noexcept {
    const auto type = status & 0xF0; const auto channel = static_cast<std::uint8_t>((status & 0x0F) + 1);
    const auto pitch = static_cast<std::uint8_t>(data1 & 0x7F);
    if (type == 0x90 && data2 > 0) {
      // A repeated note-on without its note-off: release the earlier one first.
      release(source, channel, pitch, offset, emit);
      if (!table) return;
      for (const auto& route : table->routes) {
        if (!route.accepts(source, channel)) continue;
        int outPitch = 0, outVelocity = 0;
        if (!transformNote(route, pitch, data2 & 0x7F, outPitch, outVelocity)) continue;
        auto* slot = std::find_if(active_.begin(), active_.end(), [](const Active& a) { return !a.used; });
        if (slot == active_.end()) { ++overflows_; continue; }
        const auto id = nextId();
        *slot = {true, source, channel, pitch, static_cast<std::uint8_t>(outPitch), route.track, id};
        emit(LiveMidiEvent{offset, route.track, 0x90, static_cast<std::uint8_t>(outPitch), static_cast<std::uint8_t>(outVelocity), id});
      }
    } else if (type == 0x80 || type == 0x90) {
      release(source, channel, pitch, offset, emit);
    } else if (type == 0xB0 && (data1 == 120 || data1 == 123)) {
      for (auto& a : active_) if (a.used && a.source == source && a.channel == channel) off(a, offset, emit);
      for (auto& down : pedal_) down = false;
    } else if (type == 0xB0 && table) {
      // Controllers go to every track hearing this input (once per track). CC64 is the sustain pedal
      // (docs/SUSTAIN_PEDAL.md): built-ins defer note-offs, VST3 receives every controller.
      const auto controller = static_cast<std::uint8_t>(data1 & 0x7F), value = static_cast<std::uint8_t>(data2 & 0x7F);
      for (std::size_t i = 0; i < table->routes.size(); ++i) {
        const auto& route = table->routes[i];
        if (!route.accepts(source, channel)) continue;
        bool seen = false;
        for (std::size_t j = 0; j < i && !seen; ++j) seen = table->routes[j].track == route.track && table->routes[j].accepts(source, channel);
        if (seen) continue;
        if (controller == sustainCc && route.track < pedal_.size()) pedal_[route.track] = value >= 64;
        emit(LiveMidiEvent{offset, route.track, 0xB0, controller, value, -1});
      }
    }
  }
  /** After a route change: release notes whose track no longer hears their input (track switch). */
  template<class Emit> void retarget(const MidiRouteTable* table, std::uint32_t offset, Emit&& emit) noexcept {
    for (auto& a : active_) {
      if (!a.used) continue;
      const bool kept = table && std::any_of(table->routes.begin(), table->routes.end(),
        [&](const MidiRoute& r) { return r.track == a.track && r.accepts(a.source, a.channel); });
      if (!kept) off(a, offset, emit);
    }
    // A track that lost its input also loses the pedal it was holding.
    for (std::uint32_t track = 0; track < pedal_.size(); ++track) {
      if (!pedal_[track]) continue;
      const bool kept = table && std::any_of(table->routes.begin(), table->routes.end(), [&](const MidiRoute& r) { return r.track == track; });
      if (!kept) { pedal_[track] = false; emit(LiveMidiEvent{offset, track, 0xB0, sustainCc, 0, -1}); }
    }
  }
  /** Releases every sounding note (panic, transport stop). */
  template<class Emit> void releaseAll(std::uint32_t offset, Emit&& emit) noexcept { for (auto& a : active_) if (a.used) off(a, offset, emit); }
  void clear() noexcept { for (auto& a : active_) a.used = false; for (auto& down : pedal_) down = false; }
  [[nodiscard]] bool pedalDown(std::uint32_t track) const noexcept { return track < pedal_.size() && pedal_[track]; }
  [[nodiscard]] std::size_t sounding() const noexcept { return static_cast<std::size_t>(std::count_if(active_.begin(), active_.end(), [](const Active& a) { return a.used; })); }
  [[nodiscard]] std::uint64_t overflows() const noexcept { return overflows_; }
 private:
  template<class Emit> void release(std::uint16_t source, std::uint8_t channel, std::uint8_t pitch, std::uint32_t offset, Emit& emit) noexcept {
    for (auto& a : active_) if (a.used && a.source == source && a.channel == channel && a.pitch == pitch) off(a, offset, emit);
  }
  template<class Emit> void off(Active& a, std::uint32_t offset, Emit& emit) noexcept {
    a.used = false; emit(LiveMidiEvent{offset, a.track, 0x80, a.outPitch, 0, a.noteId});
  }
  std::int32_t nextId() noexcept { const auto id = next_; next_ = next_ >= lastHostNoteId ? firstHostNoteId : next_ + 1; return id; }
  static constexpr std::uint8_t sustainCc = 64;
  std::array<Active, capacity> active_{};
  std::array<bool, 256> pedal_{};
  std::int32_t next_ = firstHostNoteId;
  std::uint64_t overflows_ = 0;
};

} // namespace garak::midi

#pragma once
// Built-in vintage instruments implemented in Rust (rust/garak-dsp/src/instruments, C ABI in
// rust/garak-ffi): 옥구슬 EP ("okgu-ep") and 한밤 106 ("hanbam-106"). One implementation for both
// engines: the browser worklet runs the same code from garak-dsp.wasm (src/devices/vintage).
//
// The engine treats them like IEUM WAVE: a PluginProcessor that receives sample-accurate note and
// controller events. Desktop builds have GARAK_RUST=ON (since 0.3.0); without it the instrument ids
// are known but rejected with an explicit error, and the host reports no "vintage" capability.

#include "garak/engine.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <memory>
#include <new>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#ifndef GARAK_RUST
#define GARAK_RUST 0
#endif
#if GARAK_RUST
#include "garak_rust.h"
#endif

namespace garak {

[[nodiscard]] inline bool rustInstrumentId(std::string_view id) noexcept { return id == "okgu-ep" || id == "hanbam-106"; }

#if GARAK_RUST
class RustInstrumentProcessor final : public PluginProcessor {
 public:
  RustInstrumentProcessor(std::string_view id, const Parameters& params, double sampleRate, std::uint32_t maxBlock)
      : left_(std::max<std::uint32_t>(1, maxBlock)), right_(std::max<std::uint32_t>(1, maxBlock)) {
    const auto kind = garak_rs_instrument_kind(id.data(), id.size());
    if (kind < 0) throw std::invalid_argument("Unknown Rust instrument: " + std::string(id));
    kind_ = static_cast<std::uint32_t>(kind);
    const auto count = garak_rs_instrument_param_count(kind_);
    std::vector<double> values(count);
    std::vector<bool> used(count);
    for (std::uint32_t i = 0; i < count; ++i) {
      char name[64];
      const auto length = std::min(garak_rs_instrument_param_id(kind_, i, name, sizeof name), sizeof name);
      ids_.emplace_back(name, length);
      double fallback = 0, minimum = 0, maximum = 0;
      garak_rs_instrument_param_range(kind_, i, &fallback, &minimum, &maximum);
      values[i] = fallback;
    }
    for (const auto& [name, value] : params) {
      const auto index = parameterIndex(name);
      if (index < 0) throw std::invalid_argument("Unknown native instrument parameter");
      if (!std::isfinite(value)) throw std::invalid_argument("Invalid native instrument parameter");
      values[static_cast<std::size_t>(index)] = value;
    }
    state_ = static_cast<GarakRsInstrument*>(::operator new(garak_rs_instrument_size(), std::align_val_t(garak_rs_instrument_align())));
    const int rc = garak_rs_instrument_init(state_, kind_, sampleRate, values.data(), count);
    if (rc != GARAK_RS_OK) {
      ::operator delete(state_, std::align_val_t(garak_rs_instrument_align()));
      state_ = nullptr;
      throw std::invalid_argument("Rust instrument initialisation failed (" + std::to_string(rc) + ")");
    }
  }
  ~RustInstrumentProcessor() override {
    if (state_) ::operator delete(state_, std::align_val_t(garak_rs_instrument_align()));
  }
  RustInstrumentProcessor(const RustInstrumentProcessor&) = delete;
  RustInstrumentProcessor& operator=(const RustInstrumentProcessor&) = delete;

  [[nodiscard]] int parameterIndex(std::string_view id) const noexcept {
    const auto found = std::find(ids_.begin(), ids_.end(), id);
    return found == ids_.end() ? -1 : static_cast<int>(found - ids_.begin());
  }
  [[nodiscard]] std::uint32_t kind() const noexcept { return kind_; }
  // Audio thread: instrument automation (glides inside Rust).
  void setParameter(std::uint32_t index, double value) noexcept { garak_rs_instrument_set_param(state_, index, value); }
  // Callback-only: keep the predecessor's voices / chorus line ringing across a rebuilt track.
  void takeStateFrom(RustInstrumentProcessor& previous) noexcept {
    if (previous.kind_ == kind_) garak_rs_instrument_take_state(state_, previous.state_);
    reset_ = previous.reset_;
  }

  void process(float* stereo, std::uint32_t frames, std::span<const PluginEvent> input, const ProcessContext&) noexcept override {
    std::size_t count = 0;
    if (reset_) {
      reset_ = false;
      // Transport stop / seek: release (not cut) every voice and return the controllers to rest.
      events_[count++] = {0, GARAK_RS_EVENT_ALL_NOTES_OFF, -1, 0, 0, 0};
      static constexpr std::array<std::pair<int, float>, 4> rest{{{pitchBendController, .5f}, {modWheelController, 0.f}, {channelPressureController, 0.f}, {expressionController, 1.f}}};
      for (const auto& [controller, value] : rest)
        events_[count++] = {0, GARAK_RS_EVENT_CONTROLLER, -1, 0, value, static_cast<std::uint32_t>(controller)};
    }
    for (const auto& e : input) {
      if (count == events_.size()) break;
      GarakRsInstrumentEvent out{std::min(e.offset, frames ? frames - 1 : 0), 0, -1, e.pitch, e.value, e.parameterId};
      // Timeline and audition (live / editor) notes may reuse ids: keep them apart.
      out.id = e.noteId < 0 ? -1 : (e.audition ? (e.noteId | 0x40000000) : (e.noteId & 0x3fffffff));
      switch (e.type) {
        case PluginEvent::Type::NoteOn: out.kind = GARAK_RS_EVENT_NOTE_ON; out.value = std::clamp(e.value, 0.f, 1.f); break;
        case PluginEvent::Type::NoteOff: out.kind = GARAK_RS_EVENT_NOTE_OFF; break;
        case PluginEvent::Type::AllNotesOff: out.kind = GARAK_RS_EVENT_ALL_NOTES_OFF; break;
        case PluginEvent::Type::Parameter: out.kind = GARAK_RS_EVENT_PARAM; break;
        case PluginEvent::Type::Controller:
          out.kind = GARAK_RS_EVENT_CONTROLLER;
          // The host normalises every controller by 127; Rust reads the bend range as semitones / 48.
          if (e.parameterId == static_cast<std::uint32_t>(bendRangeController)) out.value = e.value * 127.f / 48.f;
          break;
      }
      events_[count++] = out;
    }
    for (std::uint32_t done = 0; done < frames;) {
      const auto n = std::min<std::uint32_t>(frames - done, static_cast<std::uint32_t>(left_.size()));
      // Events are block-relative: hand each chunk the ones that start inside it.
      std::size_t first = 0, last = 0;
      while (first < count && events_[first].offset < done) ++first;
      last = first;
      while (last < count && events_[last].offset < done + n) { events_[last].offset -= done; ++last; }
      garak_rs_instrument_process(state_, left_.data(), right_.data(), n, events_.data() + first, static_cast<std::uint32_t>(last - first));
      for (std::uint32_t i = 0; i < n; ++i) { stereo[2 * (done + i)] = left_[i]; stereo[2 * (done + i) + 1] = right_[i]; }
      done += n;
    }
  }
  [[nodiscard]] std::uint32_t latencyFrames() const noexcept override { return 0; }
  [[nodiscard]] double tailSeconds() const noexcept override { return garak_rs_instrument_tail(state_); }
  void requestReset() noexcept override { reset_ = true; }
  [[nodiscard]] static std::size_t instanceMemory(std::uint32_t maxBlock) noexcept {
    return garak_rs_instrument_size() + std::size_t(maxBlock) * 2 * sizeof(float) + sizeof(RustInstrumentProcessor);
  }

 private:
  std::uint32_t kind_ = 0;
  GarakRsInstrument* state_ = nullptr;
  std::vector<std::string> ids_;
  std::vector<float> left_, right_;
  std::array<GarakRsInstrumentEvent, 2048 + 8> events_{};
  bool reset_ = false;
};
#endif

// Engine helpers that compile in both configurations (without GARAK_RUST the instruments are rejected).
// Only engine.cpp (garak_core, where GARAK_RUST is defined) includes this header; the host asks
// garak::dsp::rustEffectsAvailable() instead.
[[nodiscard]] inline std::shared_ptr<PluginProcessor> makeRustInstrument([[maybe_unused]] std::string_view id, [[maybe_unused]] const Parameters& params,
                                                                         [[maybe_unused]] double sampleRate, [[maybe_unused]] std::uint32_t maxBlock) {
#if GARAK_RUST
  return std::make_shared<RustInstrumentProcessor>(id, params, sampleRate, maxBlock);
#else
  throw std::invalid_argument("This build has no Rust DSP core (configure with -DGARAK_RUST=ON): 옥구슬 EP / 한밤 106 are unavailable");
#endif
}
[[nodiscard]] inline std::size_t rustInstrumentMemory([[maybe_unused]] std::uint32_t maxBlock) noexcept {
#if GARAK_RUST
  return RustInstrumentProcessor::instanceMemory(maxBlock);
#else
  return 0;
#endif
}
[[nodiscard]] inline int rustParameterIndex([[maybe_unused]] const PluginProcessor& p, [[maybe_unused]] std::string_view id) noexcept {
#if GARAK_RUST
  return static_cast<const RustInstrumentProcessor&>(p).parameterIndex(id);
#else
  return -1;
#endif
}
inline void rustSetParameter([[maybe_unused]] PluginProcessor& p, [[maybe_unused]] std::int32_t index, [[maybe_unused]] double value) noexcept {
#if GARAK_RUST
  static_cast<RustInstrumentProcessor&>(p).setParameter(static_cast<std::uint32_t>(index), value);
#endif
}
inline void rustTakeState([[maybe_unused]] PluginProcessor& to, [[maybe_unused]] PluginProcessor& from) noexcept {
#if GARAK_RUST
  static_cast<RustInstrumentProcessor&>(to).takeStateFrom(static_cast<RustInstrumentProcessor&>(from));
#endif
}

} // namespace garak

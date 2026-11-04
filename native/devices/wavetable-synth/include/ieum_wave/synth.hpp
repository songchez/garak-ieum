#pragma once

#include "patch.hpp"
#include "wavetable.hpp"
#include <cstdint>
#include <memory>

namespace ieum::wave {
enum class EventType : std::uint8_t { NoteOn, NoteOff, Parameter, PitchBend, Sustain, AllNotesOff, AllSoundOff };
struct Event {
  std::uint32_t sampleOffset = 0;
  EventType type = EventType::NoteOn;
  std::uint8_t channel = 0; // MIDI channels 0..15.
  std::uint8_t note = 60;
  ParameterId parameter = ParameterId::Level;
  // NoteOn amplitude [0,2] preserves the timeline's MIDI velocity × clip gain.
  // The Velocity modulation source separately clamps this amplitude to [0,1].
  // Preview normally uses [0,1]; pitch bend [-1,1], sustain [0,1], other events
  // carry the physical parameter value. Zero NoteOn is interpreted as NoteOff.
  float value = 0.8f;
  std::uint32_t noteId = 0; // Optional host note id; zero uses oldest matching held MIDI note.
};
struct ProcessContext {
  double bpm = 120.0;
  double beatPosition = 0.0; // Quarter-note beats at sample zero of this block.
  bool playing = false;
  bool hasBeatPosition = false;
};
struct SynthStats {
  std::uint32_t activeVoices = 0, fadingVoices = 0, ignoredEvents = 0;
  std::uint64_t stolenVoices = 0, processedFrames = 0;
};

class Synth {
public:
  Synth();
  ~Synth();
  Synth(const Synth&) = delete;
  Synth& operator=(const Synth&) = delete;

  // Non-realtime setup. `tables` remains immutable/alive until replaced and
  // returned by takeRetiredWavetables(), a later stopped prepare(), or destruction.
  // Supported rate: 22050..192000 Hz.
  void prepare(double sampleRate, const PreparedWavetableSet& tables);
  // Serialized with process, normally while stopped; no allocations. Seed fixes
  // random phase/noise/voice variation for reproducible offline/live rendering.
  void reset(std::uint32_t seed = 0x49e127adu) noexcept;
  // Audio-thread/block-boundary operations. Reject invalid data without changing state.
  // Existing voices, envelope stages and LFO phases survive patch changes.
  bool applyPatch(const Patch& patch, bool immediate = false) noexcept;
  bool setParameter(ParameterId id, float value, bool immediate = false) noexcept;
  // Block-boundary, no allocation. The host prepares and owns both immutable sets.
  // 0 means 20 ms; minimum 128 samples. Rejects another pending replacement, an
  // uncollected retired pointer, or a set missing a bank selected by the patch.
  bool swapWavetables(const PreparedWavetableSet& tables, std::uint32_t fadeFrames = 0) noexcept;
  // Atomic patch + table-set replacement handles disjoint custom bank slots.
  // Validation precedes all mutation; held voices and phases survive. Same
  // pending/retirement and lifetime rules as swapWavetables().
  bool applyPreparedPatch(const Patch& patch, const PreparedWavetableSet& tables,
                          std::uint32_t fadeFrames = 0) noexcept;
  // Serialized with process(). Returns the old pointer only after its last read.
  // Destroy it off the audio thread. Returning a pointer never frees memory.
  const PreparedWavetableSet* takeRetiredWavetables() noexcept;

  // Stereo planar overwrite. Outputs must be non-null and point to `frames`
  // floats. Events must be sorted, 0 <= offset < frames, max 4096 per block.
  // No allocation, lock, file access, logging, exception, or host/device API call.
  // All methods on an instance are serialized by the host; it is not concurrently mutable.
  void process(float* left, float* right, std::uint32_t frames,
               const Event* events = nullptr, std::size_t eventCount = 0,
               ProcessContext context = {}) noexcept;
  SynthStats stats() const noexcept;
  double sampleRate() const noexcept;
private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
} // namespace ieum::wave

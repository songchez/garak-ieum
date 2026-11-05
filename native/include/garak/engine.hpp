#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <unordered_map>
#include <vector>

namespace garak {

// All configuration objects below are created/validated on the control thread.
// Never construct a project, decode PCM or destroy a processor in the callback.
using Parameters = std::map<std::string, double, std::less<>>;

struct PcmAsset {
  std::string id;
  std::uint32_t sampleRate = 48000;
  std::uint32_t channels = 2;
  std::vector<float> samples; // Interleaved, immutable after registration.
  [[nodiscard]] std::uint64_t frames() const noexcept { return channels ? samples.size() / channels : 0; }
};
using AssetStore = std::unordered_map<std::string, std::shared_ptr<const PcmAsset>>;

struct SampleZone {
  std::string assetId;
  int root = 60, lo = 0, hi = 127;
  double vlo = 0, vhi = 1, gainDb = 0, tune = 0;
  std::optional<std::array<double, 2>> loop; // Seconds, before startOffset.
  int choke = -1;
  bool operator==(const SampleZone&) const = default;
};
struct SampleSet {
  std::string id;
  bool isKit = false;
  double gainDb = 0, release = .25, startOffset = 0;
  std::vector<SampleZone> zones, releaseZones;
  bool operator==(const SampleSet&) const = default;
};
using SampleSetStore = std::unordered_map<std::string, SampleSet>;

struct PluginSpec {
  std::string instanceId;
  std::string path;
  std::string classId;
  std::vector<std::uint8_t> state;
  std::vector<std::uint8_t> controllerState;
  std::map<std::uint32_t, double> parameters;
  bool isInstrument = false;
  bool operator==(const PluginSpec&) const = default;
};
struct ProcessContext {
  double sampleRate = 48000, bpm = 120;
  std::int64_t projectFrame = 0;
  bool playing = false, offline = false;
  int timeSigNumerator = 4, timeSigDenominator = 4;
  bool cycleActive = false, recording = false;
  std::int64_t cycleStartFrame = 0, cycleEndFrame = 0, continuousFrame = 0;
};
struct PluginEvent {
  enum class Type : std::uint8_t { NoteOn, NoteOff, Parameter, AllNotesOff };
  Type type = Type::NoteOn;
  std::uint32_t offset = 0;
  std::int32_t noteId = -1;
  std::uint8_t pitch = 60, channel = 0;
  float value = 1;
  std::uint32_t parameterId = 0;
  bool audition = false; // Separate WAVE live/editor note ownership from the timeline.
};
class PluginProcessor {
 public:
  virtual ~PluginProcessor() = default;
  // Stereo interleaved in/out. Instrument processors receive silence at input.
  // The instance has already been activated and all scratch storage allocated.
  virtual void process(float* stereo, std::uint32_t frames,
                       std::span<const PluginEvent> events, const ProcessContext&) noexcept = 0;
  [[nodiscard]] virtual std::uint32_t latencyFrames() const noexcept = 0;
  // Prepared on the control thread; infinite tails must use the host's explicit
  // export cap. Instances are never shared between real-time and offline render.
  [[nodiscard]] virtual double tailSeconds() const noexcept { return 0; }
  // RT-safe request only: no component lifecycle/state calls. Flush next block.
  virtual void requestReset() noexcept = 0;
};
using ExternalProcessor = PluginProcessor;
using PluginResolver = std::function<std::shared_ptr<PluginProcessor>(const PluginSpec&, double, std::uint32_t)>;

struct TrackSource {
  enum class Kind { Audio, BuiltinSynth, BuiltinSampled, Vst3, NativeWavetable };
  Kind kind = Kind::Audio;
  std::string instrumentId;
  std::string sampleSetId;
  bool isKit = false;
  Parameters params;
  PluginSpec plugin;
  std::vector<std::uint8_t> patchData; // Validated IEWAVE01 pack, decoded off the callback.
  bool operator==(const TrackSource&) const = default;
};
struct BuiltinInsert {
  std::string id, type;
  bool enabled = true;
  Parameters params;
  PluginSpec plugin;
};
struct NotePair {
  std::int32_t id = 0;
  std::int64_t onFrame = 0, offFrame = 1, limitFrame = 1;
  int pitch = 60;
  float velocity = 1;
  bool operator==(const NotePair&) const = default;
};
struct AudioWindow {
  std::int32_t id = 0;
  std::string assetId;
  std::int64_t startFrame = 0, endFrame = 0;
  double sourceStartFrame = 0;
  double sourceSampleRate = 48000;
  std::int64_t clipOffsetFrames = 0, clipLengthFrames = 0;
  float gain = 1;
  std::int64_t fadeInFrames = 0, fadeOutFrames = 0;
  bool operator==(const AudioWindow&) const = default;
};
// Physical device input channels (zero based) a track records and monitors.
// channels[1] < 0 is mono. A track without one uses the device default input.
struct TrackInput {
  std::array<std::int16_t, 2> channels{0, -1};
  [[nodiscard]] std::uint32_t count() const noexcept { return channels[1] >= 0 ? 2u : 1u; }
  bool operator==(const TrackInput&) const = default;
};
struct TrackTimeline {
  std::string id;
  TrackSource source;
  std::optional<TrackInput> input;
  float gain = 1, pan = 0;
  bool enabled = true, mute = false, solo = false, soloSafe = false, audible = true;
  std::vector<BuiltinInsert> inserts;
  std::vector<NotePair> notes;
  std::vector<AudioWindow> audio;
};
struct ProjectTimeline {
  std::uint32_t version = 1;
  std::string projectId;
  std::uint64_t revision = 0;
  std::uint32_t sampleRate = 48000;
  double bpm = 120, beatsPerBar = 4;
  int timeSigNumerator = 4, timeSigDenominator = 4;
  std::int64_t lengthFrames = 1;
  std::optional<std::array<std::int64_t, 2>> cycle;
  float masterGain = 1;
  bool lowLatencyMonitoring = true;
  std::vector<TrackTimeline> tracks;
};

struct EngineSnapshot {
  std::uint64_t revision = 0, lastAppliedCommand = 0;
  std::int64_t frame = 0;
  std::uint32_t sampleRate = 48000, trackCount = 0, latencyFrames = 0;
  bool ready = false, playing = false;
  float masterPeak = 0;
  std::array<float, 256> trackPeaks{};
  std::uint64_t commandOverflows = 0, voiceOverflows = 0, invalidSamples = 0;
  bool recording = false;
  std::int64_t recordingStartFrame = 0;
  std::uint64_t recordedFrames = 0, recordingDroppedFrames = 0;
};

// Indices into the interleaved callback input. The device opens K physical
// channels in a list; a track names physical channels, so the host and the
// callback must map through the same list. -1 is silence.
struct InputRoute {
  std::int32_t left = -1, right = -1;
  std::uint32_t channels = 1; // Samples a recording of this route writes per frame.
  bool missing = false;        // An explicit channel is not open: silent, never another channel.
};
constexpr std::size_t maxInputLayout = 32;
// Pure and noexcept: used by the control thread (take planning, missing-input
// reports) and the callback (per-track monitoring) so both agree exactly.
// `layout` lists physical channel numbers in interleaved order; `delivered` is
// how many interleaved channels the callback actually receives. A track without
// an input uses (defaultLeft, defaultRight), the legacy setInputChannels pair.
[[nodiscard]] InputRoute routeInput(const std::optional<TrackInput>& input, std::span<const std::uint8_t> layout,
                                    std::uint32_t delivered, int defaultLeft, int defaultRight) noexcept;

struct RecordingTake {
  std::uint32_t track = 0; // Graph track index; informational for the legacy whole-device take.
  InputRoute route;
};
constexpr std::size_t maxRecordingTakes = 64;

// Loopback latency detection (latency.measure). `captured` is the input channel
// recorded from the frame the first pulse was emitted; `emitted` lists each
// pulse's start frame in that clock. Each attempt searches [emit, emit+maxLag]
// by normalized cross-correlation, so polarity, gain and DC do not matter.
struct LatencyDetection {
  std::optional<std::int64_t> roundTripFrames;
  double confidence = 0;       // 0..1: agreement of the attempts times their peak clarity.
  std::uint32_t attempts = 0;  // Pulses emitted.
  std::uint32_t detected = 0;  // Pulses found and consistent with the median.
};
[[nodiscard]] LatencyDetection detectLatency(std::span<const float> captured, std::span<const float> pulse,
                                             std::span<const std::int64_t> emitted, std::int64_t maxLag);
// The short band-limited click emitted by latency.measure: steep enough for a
// sharp correlation peak, without DC that AC-coupled converters would smear.
[[nodiscard]] std::vector<float> latencyPulse(std::uint32_t sampleRate);

// Real-time callback load. One writer (the device callback), atomics only.
// A callback that used more than 90% of its buffer time is an overload: the
// next one is at risk of missing its deadline even if this one did not.
class LoadMeter {
 public:
  static constexpr double overloadThreshold = .9;
  void record(double processingSeconds, double bufferSeconds) noexcept;
  void reset() noexcept;
  [[nodiscard]] std::uint64_t overloads() const noexcept { return overloads_.load(std::memory_order_relaxed); }
  [[nodiscard]] float lastLoad() const noexcept { return last_.load(std::memory_order_relaxed); }
 private:
  std::atomic<std::uint64_t> overloads_{0};
  std::atomic<float> last_{0};
};

class PreparedProject {
 public:
  ~PreparedProject();
  PreparedProject(PreparedProject&&) noexcept;
  PreparedProject& operator=(PreparedProject&&) noexcept;
  PreparedProject(const PreparedProject&) = delete;
  PreparedProject& operator=(const PreparedProject&) = delete;
  [[nodiscard]] std::size_t trackCount() const noexcept;
  [[nodiscard]] double tailSeconds() const noexcept;
  [[nodiscard]] std::uint32_t latencyFrames() const noexcept;
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
  explicit PreparedProject(std::unique_ptr<Impl>);
  friend class RenderEngine;
};

class RenderEngine {
 public:
  explicit RenderEngine(std::uint32_t sampleRate = 48000, std::uint32_t maxBlockFrames = 4096,
                        std::uint32_t recordingCapacityFrames = 262144);
  ~RenderEngine(); // Device must be stopped before destruction.
  RenderEngine(const RenderEngine&) = delete;
  RenderEngine& operator=(const RenderEngine&) = delete;
  [[nodiscard]] std::unique_ptr<PreparedProject> prepare(const ProjectTimeline&, const AssetStore&,
      const SampleSetStore& = {}, const PluginResolver& = {}) const;
  // Control-thread only; throws if the bounded graph queue is full. Ownership is
  // consumed on either outcome. Retired destruction happens in collectRetired.
  std::uint64_t submit(std::unique_ptr<PreparedProject> project);
  void collectRetired();
  [[nodiscard]] std::uint64_t play();
  [[nodiscard]] std::uint64_t pause();
  [[nodiscard]] std::uint64_t stop();
  [[nodiscard]] std::uint64_t seek(std::int64_t frame);
  [[nodiscard]] std::uint64_t previewNote(std::uint32_t trackIndex, int pitch, float velocity,
                                        std::uint32_t durationFrames = 24000);
  [[nodiscard]] std::uint64_t noteOn(std::uint32_t trackIndex, int pitch, float velocity, std::int32_t noteId);
  [[nodiscard]] std::uint64_t noteOff(std::uint32_t trackIndex, int pitch, std::int32_t noteId);
  // Release audition/live notes on this track without touching timeline notes.
  [[nodiscard]] std::uint64_t allNotesOff(std::uint32_t trackIndex);
  [[nodiscard]] std::uint64_t setMonitoring(std::span<const std::uint32_t> tracks);
  // Physical channel numbers the device interleaves into the callback, in
  // order (<= 32, each < 256, distinct). Swapped atomically by the callback.
  // Until called, physical channel n is interleaved index n.
  [[nodiscard]] std::uint64_t setInputLayout(std::span<const std::uint32_t> physicalChannels);
  // Control thread: resolve each graph track's take against the last submitted
  // graph and input layout. Throws on duplicates, > 64 takes or unknown tracks.
  [[nodiscard]] std::vector<RecordingTake> planRecording(std::span<const std::uint32_t> tracks) const;
  // All takes start on the same callback frame and share one capture ring; each
  // frame holds every take's channels in order (recordingChannels() samples).
  // The previous capture must be stopped (acknowledged) and drained.
  [[nodiscard]] std::uint64_t startRecording(std::span<const RecordingTake> takes);
  // Legacy whole-device take: one stereo take of the default input pair.
  [[nodiscard]] std::uint64_t startRecording();
  [[nodiscard]] std::uint64_t stopRecording();
  [[nodiscard]] std::uint32_t recordingChannels() const noexcept;
  [[nodiscard]] std::uint64_t setMasterGain(float gain);
  // Input selection is zero-based; -1 for right duplicates the left channel.
  [[nodiscard]] std::uint64_t setInputChannels(int left, int right = -1);
  // Calls may be subdivided internally at maxBlockFrames; no allocations/locks/IO.
  void render(float* stereoOutput, const float* input, std::uint32_t frames,
              std::uint32_t inputChannels = 2) noexcept;
  [[nodiscard]] EngineSnapshot snapshot() const noexcept;
  // Returns frames written; each frame holds recordingChannels() samples
  // (stereo for the legacy take). One control-thread consumer.
  std::uint32_t drainRecording(float* destination, std::uint32_t capacityFrames) noexcept;
  // Offline instances ignore the audition cycle, and allow tails beyond project end.
  // Set only while stopped, before submitting/playing a project.
  void setOffline(bool offline) noexcept;
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

} // namespace garak

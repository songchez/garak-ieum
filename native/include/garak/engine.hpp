#pragma once

#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <limits>
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
  // Controller: MIDI control change; parameterId is the controller number (0..127) and value is
  // normalized (CC value / 127). VST3 delivers it through the plug-in's IMidiMapping.
  enum class Type : std::uint8_t { NoteOn, NoteOff, Parameter, AllNotesOff, Controller };
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
// A MIDI control change on the timeline (currently CC64 sustain for VST3 instruments; built-in sources get
// the pedal applied to their note-off frames by the timeline compiler, docs/SUSTAIN_PEDAL.md).
struct ControlEvent {
  std::int64_t frame = 0;
  std::uint8_t controller = 64, value = 0;
  bool operator==(const ControlEvent&) const = default;
};
constexpr int sustainController = 64;
[[nodiscard]] constexpr bool pedalDown(int value) noexcept { return value >= 64; }
struct AudioWindow {
  std::int32_t id = 0;
  std::string assetId;
  std::int64_t startFrame = 0, endFrame = 0;
  double sourceStartFrame = 0;
  double sourceSampleRate = 48000;
  std::int64_t clipOffsetFrames = 0, clipLengthFrames = 0;
  float gain = 1;
  std::int64_t fadeInFrames = 0, fadeOutFrames = 0;
  // Fade shapes (src/core/clipEnvelope.ts FADE_CURVE_CODES): 0 linear, 1 equal power, 2 S-curve, 3 exponential, 4 logarithmic.
  std::int32_t fadeInCurve = 0, fadeOutCurve = 0;
  bool operator==(const AudioWindow&) const = default;
};
// Gain of a region fade at progress x (0 = silent end, 1 = full level); matches fadeShape() in clipEnvelope.ts.
[[nodiscard]] inline double fadeShape(std::int32_t curve, double x) noexcept {
  const double t = x < 0 ? 0 : x > 1 ? 1 : x;
  constexpr double pi = 3.14159265358979323846;
  switch (curve) {
    case 1: return std::sin(t * pi / 2);
    case 2: return (1 - std::cos(t * pi)) / 2;
    case 3: return t * t;
    case 4: return 1 - (1 - t) * (1 - t);
    default: return t;
  }
}
// Physical device input channels (zero based) a track records and monitors.
// channels[1] < 0 is mono. A track without one uses the device default input.
struct TrackInput {
  std::array<std::int16_t, 2> channels{0, -1};
  [[nodiscard]] std::uint32_t count() const noexcept { return channels[1] >= 0 ? 2u : 1u; }
  bool operator==(const TrackInput&) const = default;
};
// Internal recording input (docs/TRACK_INPUT_ROUTING.md): another track's signal at a tap, or the
// master feed (resampling), instead of a physical input. None records and monitors silence (a deleted
// source). prepare() resolves ids, breaks loops (to None) and orders sources before destinations.
struct TrackRoute {
  enum class Kind : std::uint8_t { None, Track, Master };
  // PreFx: source/instrument output before inserts. PostFx: after inserts and plug-in delay compensation,
  // before pan/fader. PostFader: the track's output (pan, fader, mute/solo applied).
  enum class Tap : std::uint8_t { PreFx, PostFx, PostFader };
  Kind kind = Kind::None;
  std::string trackId;
  Tap tap = Tap::PostFx;
  bool operator==(const TrackRoute&) const = default;
};
struct TrackTimeline {
  std::string id;
  TrackSource source;
  std::optional<TrackInput> input;
  std::optional<TrackRoute> route; // When set, replaces `input` for monitoring and recording.
  float gain = 1, pan = 0;
  bool enabled = true, mute = false, solo = false, soloSafe = false, audible = true;
  std::vector<BuiltinInsert> inserts;
  std::vector<NotePair> notes;
  std::vector<ControlEvent> controls; // Sorted by frame.
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

// Metronome strokes (mono PCM at the engine rate) for levels 0 (bar downbeat),
// 1 (compound group start) and 2 (other pulses). Immutable once handed over.
struct MetronomeClicks {
  std::uint32_t sampleRate = 0;
  std::array<std::vector<float>, 3> levels;
};

// One live MIDI message for the next render() call (docs/MIDI_RECORDING.md).
// offset is callback-relative; 0x90 data2 is the MIDI velocity (0 = note off),
// 0x80 is note off, 0xB0 with data1 120/123 releases this track's live notes.
// noteId pairs a note-off with its note-on (-1 matches by pitch).
struct LiveMidiEvent {
  std::uint32_t offset = 0;
  std::uint32_t track = 0;
  std::uint8_t status = 0, data1 = 0, data2 = 0;
  std::int32_t noteId = -1;
};
inline constexpr std::int64_t notRenderedFrame = std::numeric_limits<std::int64_t>::min();

struct EngineSnapshot {
  std::uint64_t revision = 0, lastAppliedCommand = 0;
  std::int64_t frame = 0;
  std::uint32_t sampleRate = 48000, trackCount = 0, latencyFrames = 0;
  bool ready = false, playing = false;
  float masterPeak = 0;
  std::array<float, 256> trackPeaks{};
  // Built-in compressor/limiter/gate inserts: detector peak (linear) and lowest
  // applied gain (linear, 1 = no reduction), held with meter ballistics between
  // snapshots. `track`/`insert` index ProjectTimeline::tracks and its inserts.
  struct DynamicsReading { std::uint16_t track = 0, insert = 0; float input = 0, gain = 1; };
  static constexpr std::size_t maxDynamicsReadings = 64;
  std::array<DynamicsReading, maxDynamicsReadings> dynamics{};
  std::uint32_t dynamicsCount = 0;
  std::uint64_t commandOverflows = 0, voiceOverflows = 0, invalidSamples = 0;
  bool recording = false;
  std::int64_t recordingStartFrame = 0;
  std::uint64_t recordedFrames = 0, recordingDroppedFrames = 0;
  // Multi-core processing: worker threads running beside the callback, tracks
  // the callback currently consumes from render-ahead rings, and the times a
  // ring had to be dropped mid-playback because it lost sync (never expected).
  std::uint32_t workerThreads = 0, renderAheadTracks = 0;
  std::uint64_t renderAheadResyncs = 0;
};

// Multi-core track processing (Logic "Processing Threads") and render-ahead of
// non-live tracks (Cubase ASIO-Guard). `threads` workers join the callback for
// each block: tracks render in parallel and are summed in track order, so the
// mix is bit-identical to threads = 0 (the single-threaded path).
// Render-ahead pre-renders playing tracks that are not live (not monitored,
// not recording, no recent live/preview notes, no VST3) into per-track rings,
// `renderAheadBlocks` device buffers ahead of the callback.
enum class RenderAhead : std::uint8_t { Off, Normal, High };
[[nodiscard]] constexpr std::uint32_t renderAheadBlocks(RenderAhead mode) noexcept {
  return mode == RenderAhead::High ? 4u : mode == RenderAhead::Normal ? 2u : 0u;
}
constexpr std::uint32_t maxProcessingThreads = 16;
// 'auto': hardware threads minus the callback's own, at most 8.
[[nodiscard]] std::uint32_t autoProcessingThreads() noexcept;
struct ProcessingOptions {
  std::uint32_t threads = 0; // 0..maxProcessingThreads worker threads besides the callback.
  RenderAhead renderAhead = RenderAhead::Off; // Ignored by offline engines.
  // Expected device buffer; sizes the render-ahead rings. 0 assumes 512 frames.
  std::uint32_t deviceBlockFrames = 0;
  // Runs on each worker thread as it starts (true) and just before it exits
  // (false): real-time scheduling, OS audio workgroups, test instrumentation.
  std::function<void(bool started)> onWorkerThread;
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
  // Records the track's internal route (stereo) instead of `route`. Samples are captured on the same
  // callback frames as physical takes; a PostFx/PostFader/Master route carries the graph's plug-in
  // delay (latencyFrames), a PreFx route none: the host subtracts that, never converter latency.
  bool routed = false;
  bool routeDelayed = false;
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
  // countInFrames > 0 clicks a count-in first (monitor only) while the
  // transport holds its position; it then starts on the exact following frame.
  // A recording started during the count-in begins capturing on that frame.
  [[nodiscard]] std::uint64_t play(std::int64_t countInFrames = 0);
  // Monitor-only clicks after the master bus; never in offline instances. The
  // control thread keeps `clicks` alive until a later set is acknowledged.
  [[nodiscard]] std::uint64_t setMetronome(std::shared_ptr<const MetronomeClicks> clicks, bool enabled, float volume);
  [[nodiscard]] std::uint64_t pause();
  [[nodiscard]] std::uint64_t stop();
  [[nodiscard]] std::uint64_t seek(std::int64_t frame);
  [[nodiscard]] std::uint64_t previewNote(std::uint32_t trackIndex, int pitch, float velocity,
                                        std::uint32_t durationFrames = 24000);
  [[nodiscard]] std::uint64_t noteOn(std::uint32_t trackIndex, int pitch, float velocity, std::int32_t noteId);
  [[nodiscard]] std::uint64_t noteOff(std::uint32_t trackIndex, int pitch, std::int32_t noteId);
  // Live MIDI control change (0..127). CC64 sustains live notes: built-in and IEUM WAVE sources defer
  // live note-offs while the pedal is down; VST3 instruments receive the controller as an event.
  [[nodiscard]] std::uint64_t controlChange(std::uint32_t trackIndex, int controller, int value);
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
  // Render thread only, immediately before render(): live MIDI applied at its
  // sample offset inside that call (sub-blocks split there). Fixed capacity, no
  // locks or allocation; returns how many were accepted. Events for a track that
  // is rendering ahead wait for the next call (offset 0).
  std::uint32_t queueLiveMidi(std::span<const LiveMidiEvent> events) noexcept;
  // Render thread only, after render(): the transport frame that callback-relative
  // `offset` was rendered at, or notRenderedFrame when the transport was not
  // playing there (stopped, paused or counting in).
  [[nodiscard]] std::int64_t renderedTransportFrame(std::uint32_t offset) const noexcept;
  [[nodiscard]] EngineSnapshot snapshot() const noexcept;
  // Returns frames written; each frame holds recordingChannels() samples
  // (stereo for the legacy take). One control-thread consumer.
  std::uint32_t drainRecording(float* destination, std::uint32_t capacityFrames) noexcept;
  // Offline instances ignore the audition cycle, and allow tails beyond project end.
  // Set only while stopped, before submitting/playing a project.
  void setOffline(bool offline) noexcept;
  // Control thread, before the first submit and before the device starts:
  // creates the worker pool (threads > 0, or 1 when only rendering ahead).
  // Graphs prepared afterwards carry render-ahead rings within a memory budget.
  void setProcessing(const ProcessingOptions& options);
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

} // namespace garak

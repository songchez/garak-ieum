#pragma once

#include "garak/meter.hpp"
#include "garak/tempo.hpp"
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
  // bpm is the tempo at projectFrame; `tempo` (when set) converts any project frame to beats (docs/TEMPO_MAP.md).
  double sampleRate = 48000, bpm = 120;
  std::int64_t projectFrame = 0;
  bool playing = false, offline = false;
  int timeSigNumerator = 4, timeSigDenominator = 4;
  bool cycleActive = false, recording = false;
  std::int64_t cycleStartFrame = 0, cycleEndFrame = 0, continuousFrame = 0;
  const TempoMap* tempo = nullptr;
  // Time-signature changes (docs/METER_MAP.md); null = timeSigNumerator/Denominator for the whole song. When set,
  // the signature fields already hold the meter at projectFrame.
  const MeterMap* meters = nullptr;
  // Musical position (quarter notes) of a project frame: through the tempo map when there is one.
  [[nodiscard]] double beatAt(double frame) const noexcept { return tempo ? tempo->beatAtFrame(frame, sampleRate) : frame / sampleRate * bpm / 60.0; }
};
struct PluginEvent {
  // Controller: MIDI controller; parameterId is the controller number (ControlEvent numbering: 0..127 CC,
  // 128 channel pressure, 129 pitch bend, 130 program change) and value is normalizedControllerValue().
  // VST3 delivers it through the plug-in's IMidiMapping; IEUM WAVE interprets it itself.
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
// A MIDI controller event on the timeline (docs/MIDI_CONTROLLERS.md, docs/SUSTAIN_PEDAL.md).
// controller: 0..127 control change (value 0..127), 128 channel pressure (0..127), 129 pitch bend
// (-8192..8191, 0 = centre), 130 program change (0..127), 131 pitch-bend range in semitones (0..48,
// a host meta-controller for built-in sources only). The timeline compiler sends VST3 instruments every
// controller including CC64; IEUM WAVE everything but CC64/131 (the pedal is baked into note-offs);
// built-in sources everything but CC64/130.
struct ControlEvent {
  std::int64_t frame = 0;
  std::uint16_t controller = 64;
  std::int32_t value = 0;
  bool operator==(const ControlEvent&) const = default;
};
constexpr int sustainController = 64;
constexpr int modWheelController = 1, volumeController = 7, expressionController = 11;
constexpr int channelPressureController = 128, pitchBendController = 129, programChangeController = 130, bendRangeController = 131;
constexpr int controllerCount = 132;
[[nodiscard]] constexpr bool pedalDown(int value) noexcept { return value >= 64; }
// Valid value range of a controller (pitch bend is signed; the bend range is 0..48 semitones).
[[nodiscard]] constexpr bool validControllerValue(int controller, int value) noexcept {
  if (controller < 0 || controller >= controllerCount) return false;
  if (controller == pitchBendController) return value >= -8192 && value <= 8191;
  if (controller == bendRangeController) return value >= 0 && value <= 48;
  return value >= 0 && value <= 127;
}
// Normalized 0..1 value a plug-in receives (VST3 IMidiMapping parameter point; IEUM WAVE decodes it back).
[[nodiscard]] constexpr float normalizedControllerValue(int controller, int value) noexcept {
  return controller == pitchBendController ? static_cast<float>(value + 8192) / 16383.f : static_cast<float>(value) / 127.f;
}
// Controllers returned to a default when playback stops and at region ends (mod wheel, expression, sustain,
// channel pressure, pitch bend); others (volume, pan, program, ...) keep their last value.
[[nodiscard]] constexpr bool resetController(int controller, int& defaultValue) noexcept {
  switch (controller) {
    case modWheelController: case sustainController: case channelPressureController: case pitchBendController: defaultValue = 0; return true;
    case expressionController: defaultValue = 127; return true;
    default: return false;
  }
}
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
  // A frozen track's cached render (docs/BOUNCE_FREEZE_STEMS.md): no click guard, may end after the project
  // (its tail), and offline engines keep reading it during the export tail like an instrument release.
  bool freeze = false;
  // Frozen windows: the frozen track's own tail (PreparedProject::trackTailSeconds() of its freeze render), so
  // the export and the returns it feeds keep the unfrozen tail exactly.
  double tailSeconds = 0;
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
// One aux send (docs/SENDS_RETURNS.md): this track's signal into a return track at a linear gain. Post-fader
// (default) taps after pan, fader, mute and solo; pre-fader taps after the inserts and plug-in delay
// compensation, before pan/fader, and is still silenced while the track is not audible (mute/solo).
struct TrackSend {
  std::string returnId;
  float gain = 0;
  bool pre = false;
  bool operator==(const TrackSend&) const = default;
};
// Track automation (docs/AUTOMATION.md), compiled by src/audio/native/timeline.ts. Points sit on project
// frames (fractional) with values normalized 0..1 in the target's range; `curve` bends the segment to the next
// point exactly like automationShape() in src/core/automation.ts.
struct AutomationPoint {
  double frame = 0, value = 0, curve = 0;
  bool operator==(const AutomationPoint&) const = default;
};
struct AutomationLane {
  // Insert: a built-in effect parameter (by id) or a VST3 insert ParamID. Instrument: a built-in instrument
  // parameter, or a VST3 instrument ParamID. Send: this track's send level (linear 0..2) into return `returnId`.
  enum class Target : std::uint8_t { Volume, Pan, Mute, Insert, Instrument, Send };
  Target target = Target::Volume;
  std::string insertId, param, returnId;
  // Normalized -> target units: options (discrete), logarithmic or linear between minimum and maximum.
  double minimum = 0, maximum = 1;
  bool logarithmic = false;
  std::vector<double> options;
  std::vector<AutomationPoint> points; // Sorted by frame; two points on one frame make a jump.
  bool operator==(const AutomationLane&) const = default;
};
[[nodiscard]] double automationShape(double t, double curve) noexcept;
// Normalized value at `frame`. `hint` caches the segment for monotonic calls (any start value is valid).
[[nodiscard]] double evaluateAutomation(const AutomationLane& lane, double frame, std::size_t& hint) noexcept;
[[nodiscard]] double automationValue(const AutomationLane& lane, double normalized) noexcept;

struct TrackTimeline {
  std::string id;
  // A return (aux) track: an Audio source without windows or inputs, fed by other tracks' sends, rendered
  // after all of them; its output joins the master. Returns never send and are never route sources.
  bool isReturn = false;
  std::vector<TrackSend> sends; // Ignored on returns; sends to unknown or non-return ids are silent.
  TrackSource source;
  std::optional<TrackInput> input;
  std::optional<TrackRoute> route; // When set, replaces `input` for monitoring and recording.
  float gain = 1, pan = 0;
  bool enabled = true, mute = false, solo = false, soloSafe = false, audible = true;
  std::vector<BuiltinInsert> inserts;
  std::vector<NotePair> notes;
  std::vector<ControlEvent> controls; // Sorted by frame; equal frames keep their order.
  std::vector<AudioWindow> audio;
  std::vector<AutomationLane> automation;
  // Fader audibility if the track were unmuted (solo state included); used while a mute lane is active.
  bool unmutedAudible = true;
  // Offline render options (docs/BOUNCE_FREEZE_STEMS.md). directOut=false keeps the track out of the master sum
  // while its sends still feed returns (return stems). preFader skips pan and fader: the output is the
  // compensated post-insert signal (freeze and bounce in place); a mono source leaves its right channel silent.
  bool directOut = true, preFader = false;
};
struct ProjectTimeline {
  std::uint32_t version = 1;
  std::string projectId;
  std::uint64_t revision = 0;
  std::uint32_t sampleRate = 48000;
  double bpm = 120, beatsPerBar = 4;
  // Tempo changes (schema 14): sorted points, the first at beat 0 with `bpm`. Empty = constant `bpm`.
  // Note/audio/cycle frames already follow it; the host uses it for clicks, synced effects and VST3 time.
  std::vector<TempoPoint> tempoMap;
  int timeSigNumerator = 4, timeSigDenominator = 4;
  // Time-signature changes (schema 18; docs/METER_MAP.md): events sorted by bar, the first at bar 0 with the
  // meter above. Empty = one meter. The host uses it for metronome accents and the VST3 signature/bar position.
  std::vector<MeterEvent> meterMap;
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
  // Plug-in delay of the track taps (post-FX, post-fader, sends): latencyFrames minus the extra delay the
  // dry paths wait for the latent return tracks. Equal to latencyFrames when no return adds latency.
  std::uint32_t senderLatencyFrames = 0;
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
  // A delayed route's delay: the master feed carries the whole graph latency (latencyFrames); a track's
  // post-FX/post-fader tap carries only the sender alignment (senderLatencyFrames), which is smaller when a
  // return track's inserts add latency (returns are compensated after the taps).
  bool routeMasterFeed = false;
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
  // The longest own tail of a non-return track (instrument release plus insert tails), without the render floor.
  [[nodiscard]] double trackTailSeconds() const noexcept;
  [[nodiscard]] std::uint32_t latencyFrames() const noexcept;
  [[nodiscard]] std::uint32_t senderLatencyFrames() const noexcept;
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
  explicit PreparedProject(std::unique_ptr<Impl>);
  friend class RenderEngine;
};

// What RenderEngine::update() did (docs/RENDER_DIFF_PROTOCOL.md).
struct UpdateResult {
  // None: nothing but the revision changed. Diff: only in-place diff commands (mix, sends, insert parameters,
  // master gain). Tracks: one or more tracks were rebuilt and swapped into the running graph. Full: a new graph
  // replaced the running one (its tracks still continue their predecessors by id).
  enum class Kind : std::uint8_t { None, Diff, Tracks, Full };
  Kind kind = Kind::None;
  std::uint64_t ticket = 0; // The last queued command (awaitable through EngineSnapshot::lastAppliedCommand).
  std::uint32_t replacedTracks = 0, commands = 0;
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
  // Control thread: bring the running graph to `project` with the least work (docs/RENDER_DIFF_PROTOCOL.md).
  // Mix, send-level and live insert-parameter changes become lock-free diff commands applied in place; a track
  // whose events, chain or source changed is rebuilt alone and swapped in at a block boundary, keeping its
  // voices, effect tails and controllers; tempo/length/cycle, track order and routing changes submit a new
  // graph whose tracks continue their predecessors by id. Notes equal to running ones keep their ids.
  // Throws like prepare() on invalid input; the running graph is then unchanged.
  UpdateResult update(const ProjectTimeline& project, const AssetStore& assets, const SampleSetStore& sets = {},
                      const PluginResolver& resolver = {});
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
  // Live MIDI controller (ControlEvent numbering and ranges: validControllerValue). CC64 sustains live notes:
  // built-in and IEUM WAVE sources defer live note-offs while the pedal is down; VST3 instruments receive
  // every controller as an event. Built-ins follow pitch bend, mod wheel/pressure (vibrato), CC7 and CC11.
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
  // Offline only: skip master gain and the master processor (pre-master stems, freeze and bounce renders).
  // Set only while stopped, before submitting/playing a project.
  void setMasterBypass(bool bypass) noexcept;
  // Control thread, before the first submit and before the device starts:
  // creates the worker pool (threads > 0, or 1 when only rendering ahead).
  // Graphs prepared afterwards carry render-ahead rings within a memory budget.
  void setProcessing(const ProcessingOptions& options);
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

} // namespace garak

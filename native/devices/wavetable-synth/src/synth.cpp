#include "ieum_wave/synth.hpp"
#include "ieum_wave/dsp.hpp"
#include <algorithm>
#include <array>
#include <cstring>
#include <limits>
#include <stdexcept>

namespace ieum::wave {
namespace {
constexpr unsigned kControlPeriod = 16;
constexpr unsigned kStealFade = 128;
constexpr std::size_t kMaxEvents = 4096;
constexpr float kVoiceGain = 0.5f;
// The generated manifest is authoritative. Fail the build if a future schema
// changes the compact DSP block layout rather than silently reading another field.
static_assert(parameterIndex(ParameterId::Osc1Enabled) == 0 && parameterIndex(ParameterId::Osc1Bank) == 1 &&
  parameterIndex(ParameterId::Osc1RandomPhase) == 11 && parameterIndex(ParameterId::Osc2Enabled) == 12 &&
  parameterIndex(ParameterId::Osc3Enabled) == 24 && parameterIndex(ParameterId::Osc3RandomPhase) == 35);
static_assert(parameterIndex(ParameterId::SubLevel) == 36 && parameterIndex(ParameterId::NoiseLevel) == 39 &&
  parameterIndex(ParameterId::Filter1Enabled) == 40 && parameterIndex(ParameterId::Filter2Enabled) == 44 &&
  parameterIndex(ParameterId::FilterRouting) == 48 && parameterIndex(ParameterId::FilterBlend) == 49);
static_assert(parameterIndex(ParameterId::Env1Attack) == 50 && parameterIndex(ParameterId::Env1Release) == 54 &&
  parameterIndex(ParameterId::Env2Attack) == 55 && parameterIndex(ParameterId::Env3Attack) == 60 &&
  parameterIndex(ParameterId::Env4Attack) == 65 && parameterIndex(ParameterId::Env4Release) == 69);
static_assert(parameterIndex(ParameterId::Lfo1Rate) == 70 && parameterIndex(ParameterId::Lfo1Retrigger) == 73 &&
  parameterIndex(ParameterId::Lfo2Rate) == 74 && parameterIndex(ParameterId::Lfo3Rate) == 78 &&
  parameterIndex(ParameterId::Lfo4Rate) == 82 && parameterIndex(ParameterId::Lfo4Retrigger) == 85);
static_assert(parameterIndex(ParameterId::Drive) == 86 && parameterIndex(ParameterId::ChorusRate) == 88 &&
  parameterIndex(ParameterId::DelayTime) == 91 && parameterIndex(ParameterId::Level) == 94 &&
  parameterIndex(ParameterId::PitchBendRange) == 95 && parameterIndex(ParameterId::Macro1) == 96 &&
  parameterIndex(ParameterId::Macro8) == 103 && generated::kParamCount == 104);

bool discreteParameter(std::size_t i) noexcept {
  if (i < 36) return i % 12 == 1 || i % 12 == 7;
  return i == 37 || (i >= 70 && i < 86 && i % 4 != 2) || i == 95;
}
bool hasSelectedBanks(const Patch& patch, const PreparedWavetableSet& tables) noexcept {
  for (unsigned oscillator = 0; oscillator < 3; ++oscillator)
    if (!tables.hasBank(static_cast<unsigned>(patch.params[oscillator * 12 + 1]))) return false;
  return true;
}
float unisonFraction(unsigned index, unsigned count) noexcept {
  if (count == 1) return 0.0f;
  if ((count & 1u) != 0) {
    if (index == 0) return 0.0f;
    const float rank = static_cast<float>((index + 1) / 2) / static_cast<float>(count / 2);
    return (index & 1u) ? -rank : rank;
  }
  const float rank = (static_cast<float>(index / 2) + 0.5f) / (static_cast<float>(count / 2) - 0.5f);
  return (index & 1u) ? rank : -rank;
}
EnvelopeSettings envelopeSettings(const std::array<float, generated::kParamCount>& values, unsigned index) noexcept {
  const unsigned p = 50 + index * 5;
  return {values[p], values[p + 1], values[p + 2], values[p + 3], values[p + 4]};
}
float readCurve(const std::array<float, generated::kLfoPoints>& values, double phase) noexcept {
  const double point = wrapPhase(phase) * generated::kLfoPoints;
  const auto first = static_cast<unsigned>(point);
  return lerp(values[first], values[(first + 1) % generated::kLfoPoints], static_cast<float>(point - first));
}
struct Oscillator {
  std::array<double, generated::kMaxUnison> phase {};
  std::array<LinearSmoother, generated::kMaxUnison> increment {}, gainLeft {}, gainRight {};
  std::array<MipSelection, generated::kMaxUnison> mip {};
  LinearSmoother position, bankFade;
  unsigned bank = 0, previousBank = 0;
};
struct Voice {
  bool active = false, keyDown = false, sustained = false, fresh = true;
  std::uint8_t channel = 0, note = 60;
  std::uint32_t noteId = 0, rng = 1, controlRemaining = 0, tailRemaining = 0;
  std::uint64_t age = 0;
  float velocity = 0.0f, random = 0.5f;
  std::array<Envelope, 4> envelopes;
  std::array<double, 4> lfoPhase {};
  std::array<Oscillator, 3> oscillators;
  std::array<StereoFilter, 2> filters;
  double subPhase = 0.0;
  LinearSmoother subIncrement, subGain, subShape, noiseGain, fadeIn;
  MipSelection subMip;
};
struct TableView {
  PreparedWavetable::FrameView current, previous;
  float fade = 1.0f;
};
} // namespace

struct Synth::Impl {
  double rate = 48000.0;
  bool prepared = false;
  const PreparedWavetableSet* tables = nullptr;
  const PreparedWavetableSet* previousTables = nullptr;
  const PreparedWavetableSet* retiredTables = nullptr;
  std::array<const PreparedWavetable*, 8> currentBanks {}, previousBanks {};
  LinearSmoother tableFade, curveFade;
  Patch patch;
  std::array<std::array<float, generated::kLfoPoints>, 4> previousCurves {};
  std::array<LinearSmoother, generated::kParamCount> parameters;
  std::array<float, generated::kParamCount> values = generated::kDefaults;
  std::array<float, generated::kMaxModRoutes> routeExponent {};
  std::array<unsigned, generated::kMaxModRoutes> activeRoutes {};
  unsigned routeCount = 0;
  std::array<Voice, generated::kMaxPolyphony> voices, tails;
  std::array<LinearSmoother, 16> pitchBend;
  std::array<bool, 16> sustain {};
  std::array<double, 4> globalLfoPhase {}, lfoIncrement {};
  std::uint32_t controlRemaining = 0, randomState = 0x49e127adu;
  std::uint64_t voiceAge = 0;
  SynthStats counters;
  Effects effects;

  void updateBankPointers() noexcept {
    for (unsigned bank = 0; bank < currentBanks.size(); ++bank) {
      currentBanks[bank] = tables && tables->hasBank(bank) ? &tables->bank(bank) : nullptr;
      previousBanks[bank] = previousTables && previousTables->hasBank(bank) ? &previousTables->bank(bank) : nullptr;
    }
  }

  std::uint32_t smoothingFrames() const noexcept { return static_cast<std::uint32_t>(rate * 0.012); }
  void reset(std::uint32_t seed) noexcept {
    randomState = seed == 0 ? 1 : seed;
    voices = {}; tails = {};
    for (auto& bend : pitchBend) bend.reset(0.0f);
    sustain.fill(false); globalLfoPhase.fill(0.0); lfoIncrement.fill(0.0);
    controlRemaining = 0; voiceAge = 0; counters = {};
    for (std::size_t i = 0; i < parameters.size(); ++i) {
      parameters[i].reset(patch.params[i]); values[i] = patch.params[i];
    }
    previousCurves = patch.lfoCurves; curveFade.reset(1.0f);
    effects.reset();
    if (previousTables) { retiredTables = previousTables; previousTables = nullptr; updateBankPointers(); }
    tableFade.reset(1.0f);
  }
  void refreshVoices() noexcept {
    for (auto& voice : voices) voice.controlRemaining = 0;
    for (auto& voice : tails) voice.controlRemaining = 0;
    controlRemaining = 0;
  }
  bool setParameter(ParameterId id, float value, bool immediate) noexcept {
    if (!validateParameter(id, value)) return false;
    const auto index = parameterIndex(id);
    if (index < 36 && index % 12 == 1 && tables && !tables->hasBank(static_cast<unsigned>(value))) return false;
    patch.params[index] = value;
    parameters[index].set(value, immediate || discreteParameter(index) ? 0 : smoothingFrames());
    if (immediate || discreteParameter(index)) values[index] = value;
    refreshVoices();
    return true;
  }
  bool applyPatch(const Patch& incoming, bool immediate) noexcept {
    if (!validatePatch(incoming) || (tables && !hasSelectedBanks(incoming, *tables))) return false;
    const bool now = immediate || counters.processedFrames == 0;
    if (std::memcmp(incoming.lfoCurves.data(), patch.lfoCurves.data(), sizeof(patch.lfoCurves)) != 0) {
      for (unsigned lfo = 0; lfo < 4; ++lfo) for (unsigned point = 0; point < generated::kLfoPoints; ++point)
        previousCurves[lfo][point] = lerp(previousCurves[lfo][point], patch.lfoCurves[lfo][point], curveFade.value);
      curveFade.reset(now ? 1.0f : 0.0f);
      if (!now) curveFade.set(1.0f, static_cast<std::uint32_t>(rate * 0.02));
    }
    patch = incoming;
    for (std::size_t i = 0; i < parameters.size(); ++i) {
      parameters[i].set(patch.params[i], now || discreteParameter(i) ? 0 : smoothingFrames());
      if (now || discreteParameter(i)) values[i] = patch.params[i];
    }
    routeCount = 0;
    for (unsigned i = 0; i < patch.routes.size(); ++i) {
      routeExponent[i] = std::exp2(patch.routes[i].curve * 2.0f);
      if (patch.routes[i].enabled && patch.routes[i].amount != 0.0f) activeRoutes[routeCount++] = i;
    }
    refreshVoices();
    return true;
  }
  void release(Voice& voice) noexcept {
    voice.sustained = false;
    for (auto& envelope : voice.envelopes) envelope.noteOff();
  }
  void noteOff(const Event& event) noexcept {
    Voice* chosen = nullptr;
    for (auto& voice : voices) {
      if (!voice.active || !voice.keyDown || voice.channel != event.channel) continue;
      if (event.noteId != 0 ? voice.noteId != event.noteId : voice.note != event.note) continue;
      if (!chosen || voice.age < chosen->age) chosen = &voice;
    }
    if (!chosen) return;
    chosen->keyDown = false;
    if (sustain[event.channel]) chosen->sustained = true;
    else release(*chosen);
  }
  void noteOn(const Event& event) noexcept {
    if (event.value <= 0.0f) { noteOff(event); return; }
    unsigned chosen = 0;
    bool found = false;
    for (unsigned i = 0; i < voices.size(); ++i) if (!voices[i].active) { chosen = i; found = true; break; }
    if (!found) {
      // Prefer the quietest released voice, then the oldest held voice.
      for (unsigned i = 1; i < voices.size(); ++i) {
        const auto& a = voices[i]; const auto& b = voices[chosen];
        const bool releasedA = !a.keyDown && !a.sustained, releasedB = !b.keyDown && !b.sustained;
        if ((releasedA && !releasedB) || (releasedA == releasedB &&
            (releasedA ? a.envelopes[0].value() < b.envelopes[0].value() : a.age < b.age))) chosen = i;
      }
      tails[chosen] = voices[chosen]; tails[chosen].tailRemaining = kStealFade;
      ++counters.stolenVoices;
    }
    auto& voice = voices[chosen];
    voice = Voice {};
    voice.active = voice.keyDown = true; voice.channel = event.channel; voice.note = event.note;
    voice.noteId = event.noteId; voice.velocity = event.value; voice.age = ++voiceAge;
    voice.rng = randomBits(randomState); if (voice.rng == 0) voice.rng = 1;
    voice.random = randomUnit(voice.rng);
    for (unsigned envelope = 0; envelope < 4; ++envelope) {
      voice.envelopes[envelope].prepare(rate);
      voice.envelopes[envelope].configure(envelopeSettings(values, envelope));
      voice.envelopes[envelope].noteOn();
    }
    for (auto& filter : voice.filters) filter.prepare(rate);
    for (unsigned osc = 0; osc < 3; ++osc) {
      auto& state = voice.oscillators[osc];
      state.bank = state.previousBank = static_cast<unsigned>(patch.params[osc * 12 + 1]);
      state.bankFade.reset(1.0f);
      for (auto& phase : state.phase) phase = wrapPhase(values[osc * 12 + 10] + values[osc * 12 + 11] * randomUnit(voice.rng));
    }
    voice.fadeIn.reset(found ? 1.0f : 0.0f);
    if (!found) voice.fadeIn.set(1.0f, kStealFade);
  }
  void handleEvent(const Event& event) noexcept {
    if (event.channel > 15 || event.note > 127 || !std::isfinite(event.value)) { ++counters.ignoredEvents; return; }
    switch (event.type) {
      case EventType::NoteOn:
        if (event.value < 0.0f || event.value > 2.0f) { ++counters.ignoredEvents; break; }
        noteOn(event); break;
      case EventType::NoteOff: noteOff(event); break;
      case EventType::Parameter:
        if (!setParameter(event.parameter, event.value, false)) ++counters.ignoredEvents;
        break;
      case EventType::PitchBend:
        if (std::abs(event.value) > 1.0f) { ++counters.ignoredEvents; break; }
        pitchBend[event.channel].set(event.value, static_cast<std::uint32_t>(rate * 0.005));
        refreshVoices(); break;
      case EventType::Sustain:
        if (event.value < 0.0f || event.value > 1.0f) { ++counters.ignoredEvents; break; }
        sustain[event.channel] = event.value >= 0.5f;
        if (!sustain[event.channel]) for (auto& voice : voices)
          if (voice.active && voice.channel == event.channel && !voice.keyDown) release(voice);
        break;
      case EventType::AllNotesOff:
        sustain[event.channel] = false;
        for (auto& voice : voices) if (voice.active && voice.channel == event.channel) { voice.keyDown = false; release(voice); }
        break;
      case EventType::AllSoundOff:
        sustain[event.channel] = false;
        for (auto& voice : voices) if (voice.channel == event.channel) voice.active = false;
        for (auto& voice : tails) if (voice.channel == event.channel) voice.active = false;
        // Channel panic kills its generators. Shared effect tails remain; reset()
        // is the host's stopped/global panic operation, without a big callback memset.
        break;
      default: ++counters.ignoredEvents; break;
    }
  }
  void updateLfoIncrements(double bpm) noexcept {
    for (unsigned lfo = 0; lfo < 4; ++lfo) {
      const unsigned p = 70 + lfo * 4;
      lfoIncrement[lfo] = (patch.params[p + 1] >= 0.5f ? bpm / (60.0 * patch.params[p + 2]) : values[p]) / rate;
    }
  }
  float lfoValue(unsigned lfo, double phase) const noexcept {
    const float current = readCurve(patch.lfoCurves[lfo], phase);
    return curveFade.value >= 1.0f ? current : lerp(readCurve(previousCurves[lfo], phase), current, curveFade.value);
  }
  void updateVoice(Voice& voice) noexcept {
    auto modulated = values;
    std::array<float, generated::kParamCount> offsets {};
    std::array<float, static_cast<unsigned>(ModSource::Count)> sources {};
    for (unsigned i = 0; i < 4; ++i) {
      sources[i] = voice.envelopes[i].value();
      sources[4 + i] = lfoValue(i, patch.params[73 + i * 4] >= 0.5f ? voice.lfoPhase[i] : globalLfoPhase[i]);
      voice.envelopes[i].configure(envelopeSettings(values, i));
    }
    for (unsigned macro = 0; macro < 8; ++macro) sources[8 + macro] = values[96 + macro];
    sources[16] = clamp(voice.velocity, 0.0f, 1.0f);
    sources[17] = static_cast<float>(voice.note) / 127.0f; sources[18] = voice.random;
    for (unsigned active = 0; active < routeCount; ++active) {
      const unsigned index = activeRoutes[active]; const auto& route = patch.routes[index];
      float source = sources[static_cast<unsigned>(route.source)];
      if (route.bipolar) source = 2.0f * source - 1.0f;
      if (route.curve != 0.0f) source = std::copysign(std::pow(std::abs(source), routeExponent[index]), source);
      if (route.aux != generated::kNoAuxSource) source *= sources[route.aux];
      offsets[parameterIndex(route.destination)] += source * route.amount;
    }
    for (unsigned i = 0; i < generated::kParamCount; ++i) if (generated::kModulatable[i] && offsets[i] != 0.0f) {
      const float lo = generated::kMinimum[i], hi = generated::kMaximum[i];
      if (generated::kLogarithmic[i]) {
        const float scale = std::log(hi / lo);
        const float normalized = std::log(std::max(modulated[i], lo) / lo) / scale;
        modulated[i] = lo * std::exp(clamp(normalized + offsets[i], 0.0f, 1.0f) * scale);
      } else modulated[i] = lo + clamp((modulated[i] - lo) / (hi - lo) + offsets[i], 0.0f, 1.0f) * (hi - lo);
    }
    const unsigned ramp = voice.fresh ? 0 : kControlPeriod;
    const float bend = pitchBend[voice.channel].value * values[95];
    for (unsigned osc = 0; osc < 3; ++osc) {
      const unsigned p = osc * 12; auto& state = voice.oscillators[osc];
      const unsigned count = static_cast<unsigned>(patch.params[p + 7]);
      const unsigned bank = static_cast<unsigned>(patch.params[p + 1]);
      if (bank != state.bank) {
        state.previousBank = state.bank; state.bank = bank;
        state.bankFade.reset(0.0f); state.bankFade.set(1.0f, kStealFade);
      }
      state.position.set(modulated[p + 2], ramp);
      const float level = modulated[p + 3] * values[p] / std::sqrt(static_cast<float>(count));
      for (unsigned unison = 0; unison < generated::kMaxUnison; ++unison) {
        const float fraction = unison < count ? unisonFraction(unison, count) : 0.0f;
        const double semitones = static_cast<double>(voice.note) - 69.0 + modulated[p + 5] +
          values[p + 6] * 0.01 + bend + fraction * values[p + 8] * 0.01;
        const double frequency = 440.0 * std::exp2(semitones / 12.0);
        const float increment = static_cast<float>(std::min(frequency / rate, 0.49));
        const double conservativeFrequency = std::max(static_cast<double>(state.increment[unison].value) * rate, frequency);
        state.mip[unison] = selectMip(conservativeFrequency, rate);
        state.increment[unison].set(increment, ramp);
        const float pan = clamp(modulated[p + 4] + fraction * values[p + 9], -1.0f, 1.0f);
        const float amplitude = unison < count && frequency < rate * 0.46 ? level : 0.0f;
        const unsigned gainRamp = voice.fresh ? 0 : kStealFade;
        state.gainLeft[unison].set(amplitude * std::sqrt(0.5f * (1.0f - pan)), gainRamp);
        state.gainRight[unison].set(amplitude * std::sqrt(0.5f * (1.0f + pan)), gainRamp);
      }
    }
    const double subFrequency = 440.0 * std::exp2((static_cast<double>(voice.note) - 69.0 + bend + values[37] * 12.0) / 12.0);
    voice.subMip = selectMip(std::max(static_cast<double>(voice.subIncrement.value) * rate, subFrequency), rate);
    voice.subIncrement.set(static_cast<float>(std::min(subFrequency / rate, 0.49)), ramp);
    voice.subGain.set(subFrequency < rate * 0.46 ? modulated[36] * 0.70710678f : 0.0f, ramp);
    voice.subShape.set(values[38], ramp); voice.noiseGain.set(modulated[39] * 0.5f, ramp);
    for (unsigned filter = 0; filter < 2; ++filter) {
      const unsigned p = 40 + filter * 4;
      voice.filters[filter].configure(modulated[p + 2], modulated[p + 3], values[p + 1], values[p], ramp);
    }
    voice.fresh = false; voice.controlRemaining = kControlPeriod;
  }
  TableView tableView(unsigned bank, float position) const noexcept {
    const auto* current = currentBanks[bank]; const auto* previous = previousBanks[bank];
    if (!current) return {previous ? previous->frameView(position) : PreparedWavetable::FrameView {}, {}, 1.0f};
    return {current->frameView(position), previous ? previous->frameView(position) : PreparedWavetable::FrameView {}, tableFade.value};
  }
  static float readView(const TableView& view, double phase, MipSelection mip) noexcept {
    const float current = PreparedWavetable::readView(view.current, phase, mip);
    return view.previous.first ? lerp(PreparedWavetable::readView(view.previous, phase, mip), current, view.fade) : current;
  }
  float readSub(bool triangle, double phase, MipSelection mip) const noexcept {
    const float current = tables->sub(triangle).read(phase, 0.0f, mip);
    return previousTables ? lerp(previousTables->sub(triangle).read(phase, 0.0f, mip), current, tableFade.value) : current;
  }
  Stereo renderVoice(Voice& voice, bool tail) noexcept {
    if (!voice.active) return {};
    for (auto& envelope : voice.envelopes) envelope.next();
    if (!voice.envelopes[0].active()) { voice.active = false; return {}; }
    if (voice.controlRemaining == 0) updateVoice(voice);
    --voice.controlRemaining;
    Stereo mixed;
    for (auto& state : voice.oscillators) {
      const float position = state.position.next(), bankMix = state.bankFade.next();
      const auto currentView = tableView(state.bank, position);
      const auto previousView = bankMix < 1.0f ? tableView(state.previousBank, position) : TableView {};
      for (unsigned unison = 0; unison < generated::kMaxUnison; ++unison) {
        const float left = state.gainLeft[unison].next(), right = state.gainRight[unison].next();
        if (left != 0.0f || right != 0.0f) {
          float sample = readView(currentView, state.phase[unison], state.mip[unison]);
          if (bankMix < 1.0f) sample = lerp(readView(previousView, state.phase[unison], state.mip[unison]), sample, bankMix);
          mixed.left += sample * left; mixed.right += sample * right;
        }
        state.phase[unison] = advancePhase(state.phase[unison], state.increment[unison].next());
      }
    }
    const float subGain = voice.subGain.next(), subShape = voice.subShape.next();
    if (subGain != 0.0f) {
      const float a = readSub(false, voice.subPhase, voice.subMip);
      const float sub = (subShape == 0.0f ? a : lerp(a, readSub(true, voice.subPhase, voice.subMip), subShape)) * subGain;
      mixed.left += sub; mixed.right += sub;
    }
    voice.subPhase = advancePhase(voice.subPhase, voice.subIncrement.next());
    const float noise = voice.noiseGain.next();
    if (noise != 0.0f) {
      mixed.left += (randomUnit(voice.rng) * 2.0f - 1.0f) * noise;
      mixed.right += (randomUnit(voice.rng) * 2.0f - 1.0f) * noise;
    }
    const Stereo first = voice.filters[0].process(mixed);
    const float routing = values[48], blend = values[49];
    const Stereo second = voice.filters[1].process({lerp(first.left, mixed.left, routing), lerp(first.right, mixed.right, routing)});
    const Stereo parallel {lerp(first.left, second.left, blend), lerp(first.right, second.right, blend)};
    float amplitude = kVoiceGain * voice.velocity * voice.envelopes[0].value() * voice.fadeIn.next();
    if (tail) {
      amplitude *= static_cast<float>(voice.tailRemaining) / kStealFade;
      if (voice.tailRemaining == 0 || --voice.tailRemaining == 0) voice.active = false;
    }
    for (unsigned lfo = 0; lfo < 4; ++lfo) voice.lfoPhase[lfo] = advancePhase(voice.lfoPhase[lfo], lfoIncrement[lfo]);
    return {lerp(second.left, parallel.left, routing) * amplitude, lerp(second.right, parallel.right, routing) * amplitude};
  }
  void process(float* left, float* right, std::uint32_t frames, const Event* events, std::size_t count, ProcessContext context) noexcept {
    if (!left || !right) return;
    if (!prepared || !tables) { std::fill(left, left + frames, 0.0f); std::fill(right, right + frames, 0.0f); return; }
    const double bpm = std::isfinite(context.bpm) ? clamp(context.bpm, 1.0, 999.0) : 120.0;
    if (context.playing && context.hasBeatPosition && std::isfinite(context.beatPosition)) {
      for (unsigned lfo = 0; lfo < 4; ++lfo) {
        const unsigned p = 70 + lfo * 4;
        if (patch.params[p + 1] >= 0.5f && patch.params[p + 3] < 0.5f)
          globalLfoPhase[lfo] = wrapPhase(std::fmod(context.beatPosition, patch.params[p + 2]) / patch.params[p + 2]);
      }
    }
    if (!events) count = 0;
    if (count > kMaxEvents) { counters.ignoredEvents += static_cast<std::uint32_t>(std::min<std::size_t>(count - kMaxEvents, 0xffffffffu)); count = kMaxEvents; }
    std::size_t nextEvent = 0;
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
      while (nextEvent < count && events[nextEvent].sampleOffset <= frame) {
        if (events[nextEvent].sampleOffset == frame) handleEvent(events[nextEvent]); else ++counters.ignoredEvents;
        ++nextEvent;
      }
      for (std::size_t i = 0; i < parameters.size(); ++i) values[i] = parameters[i].next();
      for (auto& bend : pitchBend) bend.next();
      curveFade.next(); tableFade.next();
      if (controlRemaining == 0) { updateLfoIncrements(bpm); controlRemaining = kControlPeriod; }
      --controlRemaining;
      Stereo sum;
      for (auto& voice : voices) { const auto sample = renderVoice(voice, false); sum.left += sample.left; sum.right += sample.right; }
      for (auto& voice : tails) { const auto sample = renderVoice(voice, true); sum.left += sample.left; sum.right += sample.right; }
      const Stereo effected = effects.process(sum, values[86], values[87], values[88], values[89], values[90], values[91], values[92], values[93]);
      left[frame] = safetyCeiling(effected.left * values[94]); right[frame] = safetyCeiling(effected.right * values[94]);
      for (unsigned lfo = 0; lfo < 4; ++lfo) globalLfoPhase[lfo] = advancePhase(globalLfoPhase[lfo], lfoIncrement[lfo]);
      if (previousTables && tableFade.remaining == 0) { retiredTables = previousTables; previousTables = nullptr; previousBanks.fill(nullptr); }
    }
    counters.ignoredEvents += static_cast<std::uint32_t>(count - nextEvent);
    counters.processedFrames += frames;
    counters.activeVoices = counters.fadingVoices = 0;
    for (const auto& voice : voices) if (voice.active) ++counters.activeVoices;
    for (const auto& voice : tails) if (voice.active) ++counters.fadingVoices;
  }
};

Synth::Synth() : impl_(std::make_unique<Impl>()) { impl_->applyPatch(Patch {}, true); }
Synth::~Synth() = default;
void Synth::prepare(double sampleRate, const PreparedWavetableSet& tables) {
  if (!std::isfinite(sampleRate) || sampleRate < 22050.0 || sampleRate > 192000.0)
    throw std::invalid_argument("Sample rate must be 22050..192000 Hz");
  if (!hasSelectedBanks(impl_->patch, tables)) throw std::invalid_argument("Prepared set is missing a selected wavetable bank");
  impl_->rate = sampleRate; impl_->tables = &tables; impl_->previousTables = impl_->retiredTables = nullptr;
  impl_->updateBankPointers();
  impl_->effects.prepare(sampleRate); impl_->prepared = true; impl_->reset(0x49e127adu);
}
void Synth::reset(std::uint32_t seed) noexcept { impl_->reset(seed); }
bool Synth::applyPatch(const Patch& patch, bool immediate) noexcept { return impl_->applyPatch(patch, immediate); }
bool Synth::setParameter(ParameterId id, float value, bool immediate) noexcept { return impl_->setParameter(id, value, immediate); }
bool Synth::swapWavetables(const PreparedWavetableSet& tables, std::uint32_t fadeFrames) noexcept {
  if (!impl_->prepared || impl_->previousTables || impl_->retiredTables || !hasSelectedBanks(impl_->patch, tables)) return false;
  if (impl_->tables == &tables) return true;
  impl_->previousTables = impl_->tables; impl_->tables = &tables;
  impl_->updateBankPointers();
  impl_->tableFade.reset(0.0f);
  impl_->tableFade.set(1.0f, std::max(128u, fadeFrames == 0 ? static_cast<unsigned>(impl_->rate * 0.02) : fadeFrames));
  return true;
}
bool Synth::applyPreparedPatch(const Patch& patch, const PreparedWavetableSet& tables, std::uint32_t fadeFrames) noexcept {
  if (!impl_->prepared || !validatePatch(patch) || !hasSelectedBanks(patch, tables)) return false;
  if (impl_->tables == &tables) return impl_->applyPatch(patch, false);
  if (impl_->previousTables || impl_->retiredTables) return false;
  impl_->previousTables = impl_->tables; impl_->tables = &tables;
  impl_->updateBankPointers();
  impl_->tableFade.reset(0.0f);
  impl_->tableFade.set(1.0f, std::max(128u, fadeFrames == 0 ? static_cast<unsigned>(impl_->rate * 0.02) : fadeFrames));
  return impl_->applyPatch(patch, false); // Already validated against the installed set.
}
const PreparedWavetableSet* Synth::takeRetiredWavetables() noexcept {
  const auto* result = impl_->retiredTables; impl_->retiredTables = nullptr; return result;
}
void Synth::process(float* left, float* right, std::uint32_t frames, const Event* events, std::size_t eventCount, ProcessContext context) noexcept {
  impl_->process(left, right, frames, events, eventCount, context);
}
SynthStats Synth::stats() const noexcept { return impl_->counters; }
double Synth::sampleRate() const noexcept { return impl_->rate; }
} // namespace ieum::wave

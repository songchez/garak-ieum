#include "wavetable.hpp"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <stdexcept>

namespace garak {

WavetableResources::Prepared WavetableResources::prepare(std::span<const std::uint8_t> bytes) {
  ieum::wave::PatchBundle bundle;
  std::string error;
  if (!ieum::wave::decodePatchBundle(bytes.data(), bytes.size(), bundle, error))
    throw std::invalid_argument("Invalid IEUM WAVE patch: " + error);
  std::sort(bundle.banks.begin(), bundle.banks.end(), [](const auto& a, const auto& b) { return a.slot < b.slot; });
  std::erase_if(entries_, [](const Entry& entry) { return entry.tables.expired(); });
  for (const auto& entry : entries_) {
    if (entry.banks.size() != bundle.banks.size()) continue;
    bool equal = true;
    for (std::size_t i = 0; i < bundle.banks.size(); ++i) {
      const auto& a = entry.banks[i]; const auto& b = bundle.banks[i];
      if (a.slot != b.slot || a.frameCount != b.frameCount || a.samples != b.samples) { equal = false; break; }
    }
    if (equal) if (auto tables = entry.tables.lock()) return {bundle.patch, std::move(tables)};
  }
  auto tables = std::make_shared<ieum::wave::PreparedWavetableSet>();
  for (const auto& bank : bundle.banks) tables->setCustom(bank.slot, bank.samples.data(), bank.frameCount);
  entries_.push_back({std::move(bundle.banks), tables});
  return {bundle.patch, std::move(tables)};
}

WavetableProcessor::WavetableProcessor(WavetableResources::Prepared prepared, double rate, std::uint32_t block)
    : desiredPatch_(prepared.patch), desiredTables_(std::move(prepared.tables)), tables_(desiredTables_),
      synth_(std::make_unique<ieum::wave::Synth>()), left_(block), right_(block) {
  synth_->prepare(rate, *tables_);
  if (!synth_->applyPatch(desiredPatch_, true)) throw std::invalid_argument("IEUM WAVE patch cannot use the prepared tables");
}

std::size_t WavetableProcessor::instanceMemory(double rate, std::uint32_t block) noexcept {
  // Conservative bound for voices/smoothers, two planar blocks, and the synth's
  // stereo 50 ms chorus + 2.01 s delay buffers (including interpolation guards).
  return 1024u * 1024u + std::size_t(block) * 2 * sizeof(float)
    + (std::size_t(std::ceil(rate * .05)) + std::size_t(std::ceil(rate * 2.01)) + 16) * 2 * sizeof(float);
}

bool WavetableProcessor::readyToTransfer() noexcept {
  if (fadeComplete_ || !fadingTables_) return true;
  if (synth_->takeRetiredWavetables()) fadeComplete_ = true;
  return fadeComplete_;
}

void WavetableProcessor::takeStateFrom(WavetableProcessor& previous) noexcept {
  assert(previous.readyToTransfer());
  // Swaps leave the newly allocated, unused synth and any completed old fade
  // in the previous graph. collectRetired destroys them on the control thread.
  synth_.swap(previous.synth_);
  tables_.swap(previous.tables_);
  std::swap(reset_, previous.reset_);
  bool applied = false;
  if (tables_ != desiredTables_) {
    fadingTables_.swap(tables_); // tables_ is now empty; assigning cannot delete.
    tables_ = desiredTables_;
    fadeComplete_ = false;
    applied = synth_->applyPreparedPatch(desiredPatch_, *tables_);
  } else {
    applied = synth_->applyPatch(desiredPatch_);
  }
  assert(applied);
  (void)applied;
}

void WavetableProcessor::process(float* stereo, std::uint32_t frames, std::span<const PluginEvent> input,
                                const ProcessContext& context) noexcept {
  if (reset_) { synth_->reset(); reset_ = false; }
  const auto count = std::min(input.size(), events_.size());
  for (std::size_t i = 0; i < count; ++i) {
    const auto& source = input[i]; auto& event = events_[i];
    event = {};
    event.sampleOffset = source.offset;
    // The editor and timeline can use the same host ID/pitch independently.
    event.channel = source.audition ? 1 : 0;
    event.note = source.pitch;
    event.noteId = source.noteId >= 0 ? static_cast<std::uint32_t>(source.noteId) + 1u : 0u;
    event.value = source.value;
    switch (source.type) {
      case PluginEvent::Type::NoteOn: event.type = ieum::wave::EventType::NoteOn; break;
      case PluginEvent::Type::NoteOff: event.type = ieum::wave::EventType::NoteOff; break;
      case PluginEvent::Type::AllNotesOff: event.type = ieum::wave::EventType::AllNotesOff; break;
      case PluginEvent::Type::Parameter:
        event.type = ieum::wave::EventType::Parameter;
        event.parameter = static_cast<ieum::wave::ParameterId>(source.parameterId);
        break;
    }
  }
  const ieum::wave::ProcessContext transport{context.bpm,
    double(context.projectFrame) * context.bpm / (60.0 * context.sampleRate), context.playing, true};
  synth_->process(left_.data(), right_.data(), frames, events_.data(), count, transport);
  for (std::uint32_t i = 0; i < frames; ++i) { stereo[i * 2] = left_[i]; stereo[i * 2 + 1] = right_[i]; }
}

double WavetableProcessor::tailSeconds() const noexcept {
  using namespace ieum::wave;
  const auto maximum = [&](ParameterId id) {
    const auto index = parameterIndex(id);
    for (const auto& route : desiredPatch_.routes)
      if (route.enabled && route.amount != 0 && route.destination == id) return double(generated::kMaximum[index]);
    return double(desiredPatch_.params[index]);
  };
  double seconds = maximum(ParameterId::Env1Release);
  if (maximum(ParameterId::ChorusMix) > 0) seconds += .05;
  if (maximum(ParameterId::DelayMix) > 0) {
    const double feedback = maximum(ParameterId::DelayFeedback);
    const double repeats = feedback > 0 ? std::max(1.0, std::ceil(std::log(1e-5) / std::log(feedback))) : 1;
    seconds += maximum(ParameterId::DelayTime) * repeats;
  }
  return std::min(30.0, seconds + .01);
}

} // namespace garak

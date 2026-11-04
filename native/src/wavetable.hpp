#pragma once

#include "garak/engine.hpp"
#include "ieum_wave/synth.hpp"

namespace garak {

// Control-thread cache. Scalar patch changes reuse immutable prepared tables;
// synth instances and effect history are never shared between tracks/engines.
class WavetableResources {
 public:
  struct Prepared {
    ieum::wave::Patch patch;
    std::shared_ptr<const ieum::wave::PreparedWavetableSet> tables;
  };
  Prepared prepare(std::span<const std::uint8_t> bytes);
 private:
  struct Entry {
    std::vector<ieum::wave::CustomBank> banks;
    std::weak_ptr<const ieum::wave::PreparedWavetableSet> tables;
  };
  std::vector<Entry> entries_;
};

class WavetableProcessor final : public PluginProcessor {
 public:
  WavetableProcessor(WavetableResources::Prepared, double sampleRate, std::uint32_t maxBlockFrames);
  void process(float*, std::uint32_t, std::span<const PluginEvent>, const ProcessContext&) noexcept override;
  std::uint32_t latencyFrames() const noexcept override { return 0; }
  double tailSeconds() const noexcept override;
  void requestReset() noexcept override { reset_ = true; }
  // Callback-only. A completed fade's ownership stays in the retired graph,
  // so neither this check nor the state transfer releases a shared resource.
  bool readyToTransfer() noexcept;
  void takeStateFrom(WavetableProcessor&) noexcept;
  static std::size_t instanceMemory(double sampleRate, std::uint32_t maxBlockFrames) noexcept;
 private:
  ieum::wave::Patch desiredPatch_;
  std::shared_ptr<const ieum::wave::PreparedWavetableSet> desiredTables_, tables_, fadingTables_;
  std::unique_ptr<ieum::wave::Synth> synth_;
  std::vector<float> left_, right_;
  std::array<ieum::wave::Event, 2048> events_{};
  bool reset_ = false, fadeComplete_ = true;
};

} // namespace garak

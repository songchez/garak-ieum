#pragma once

#include "garak/engine.hpp"
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace garak {

struct PluginDescriptor {
  std::string classId, name, vendor, version, category;
  bool isInstrument = false;
};
struct PluginParameter {
  std::uint32_t id = 0;
  std::string title, units;
  double min = 0, max = 1, defaultValue = 0, value = 0;
  std::int32_t stepCount = 0;
  bool readOnly = false, hidden = false;
};
struct PluginState {
  std::vector<std::uint8_t> component, controller;
};
struct PluginStatus {
  bool faulted = false, dirty = false, editorOpen = false;
  std::uint32_t restartFlags = 0, latencyFrames = 0;
  std::uint64_t droppedEvents = 0;
  std::string error;
};

// Scanner must run in a disposable child process with a timeout. Loading an
// arbitrary third-party binary can crash; this API does not pretend otherwise.
[[nodiscard]] std::vector<PluginDescriptor> scanVst3(const std::string& path);
[[nodiscard]] std::vector<std::string> defaultVst3Paths();
[[nodiscard]] bool vst3Available() noexcept;

class Vst3Processor final : public PluginProcessor {
 public:
  Vst3Processor(const PluginSpec&, double sampleRate, std::uint32_t maxBlockFrames,
                bool offline = false);
  ~Vst3Processor() override;
  Vst3Processor(const Vst3Processor&) = delete;
  Vst3Processor& operator=(const Vst3Processor&) = delete;
  void process(float* stereo, std::uint32_t frames, std::span<const PluginEvent>,
               const ProcessContext&) noexcept override;
  [[nodiscard]] std::uint32_t latencyFrames() const noexcept override;
  [[nodiscard]] double tailSeconds() const noexcept override;
  void requestReset() noexcept override;
  [[nodiscard]] std::vector<PluginParameter> parameters() const;
  // Main thread: enqueue processor changes and update the edit controller.
  void setParameter(std::uint32_t id, double normalizedValue);
  // Processing must be stopped by the host before save/restore/reconfigure.
  [[nodiscard]] PluginState saveState();
  void restoreState(const PluginState&);
  void openEditor();
  void closeEditor() noexcept;
  // Main thread. Transfers processor parameter output to the edit controller;
  // restart requests are reported, never executed inside process().
  void service();
  [[nodiscard]] PluginStatus status() const;
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

// Must be invoked from the native process main thread; particularly on macOS.
// No Electron/JS thread participates in the audio processing callback.
void initializeNativeEvents();
void pumpNativeEvents();

} // namespace garak

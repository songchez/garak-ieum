#pragma once
// Hardware MIDI input for the native host (docs/MIDI_RECORDING.md).
// Windows: WinMM midiIn*. macOS: CoreMIDI. Elsewhere: unsupported (no devices).
// Device callbacks only push RawMidi into the lock-free queue; everything else
// (enumeration, open/close) runs on the host control thread.
#include "midi_queue.hpp"
#include <functional>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

namespace garak::midi {

using InputQueue = MpscQueue<RawMidi, 1024>;

struct MidiDeviceInfo { std::string id, name; bool enabled = false; bool open = false; };

class MidiInputManager {
 public:
  /** sourceIndex maps a stable device id to the small index carried by RawMidi. */
  MidiInputManager(InputQueue& queue, std::function<std::uint16_t(const std::string&)> sourceIndex);
  ~MidiInputManager();
  MidiInputManager(const MidiInputManager&) = delete;
  MidiInputManager& operator=(const MidiInputManager&) = delete;
  [[nodiscard]] static bool supported() noexcept;
  /** Re-enumerates (hot-plug by polling): opens enabled devices that appeared, closes vanished ones. */
  std::vector<MidiDeviceInfo> list();
  /** Remembers the enabled ids (also for devices not connected now), then re-lists. */
  std::vector<MidiDeviceInfo> enable(const std::vector<std::string>& ids);
  /** Ids from names: "Name", then "Name #2", "Name #3" for duplicates, in system order. */
  static std::vector<std::string> stableIds(const std::vector<std::string>& names);
 private:
  struct Platform;
  InputQueue& queue_;
  std::function<std::uint16_t(const std::string&)> sourceIndex_;
  std::set<std::string> enabled_;
  std::unique_ptr<Platform> platform_;
};

} // namespace garak::midi

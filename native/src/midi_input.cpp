#include "midi_input.hpp"
#include <algorithm>
#include <chrono>
#include <map>
#if defined(_WIN32)
#include <windows.h>
#include <mmsystem.h>
#elif defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#include <CoreMIDI/CoreMIDI.h>
#endif

namespace garak::midi {
namespace {
std::int64_t nowNanos() noexcept {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}
/** Callback context; lives until its device is closed. */
struct Port { InputQueue* queue = nullptr; std::uint16_t source = 0; std::uint8_t running = 0; };
void deliver(Port& port, std::uint8_t status, std::uint8_t data1, std::uint8_t data2) noexcept {
  // Short channel messages only; system/realtime (0xF0-0xFF) are ignored.
  if (status < 0x80 || status >= 0xF0) return;
  port.queue->push(RawMidi{port.source, status, data1, data2, nowNanos()});
}
} // namespace

std::vector<std::string> MidiInputManager::stableIds(const std::vector<std::string>& names) {
  std::map<std::string, int> seen; std::vector<std::string> ids;
  for (const auto& name : names) { const auto n = ++seen[name]; ids.push_back(n == 1 ? name : name + " #" + std::to_string(n)); }
  return ids;
}

#if defined(_WIN32)
namespace {
void CALLBACK winmmCallback(HMIDIIN, UINT message, DWORD_PTR instance, DWORD_PTR param1, DWORD_PTR) {
  if (message != MIM_DATA || !instance) return;
  auto& port = *reinterpret_cast<Port*>(instance);
  const auto packed = static_cast<std::uint32_t>(param1);
  deliver(port, static_cast<std::uint8_t>(packed & 0xFF), static_cast<std::uint8_t>((packed >> 8) & 0x7F), static_cast<std::uint8_t>((packed >> 16) & 0x7F));
}
std::string narrow(const wchar_t* text) {
  const auto length = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
  if (length <= 1) return {};
  std::string out(static_cast<std::size_t>(length), '\0'); WideCharToMultiByte(CP_UTF8, 0, text, -1, out.data(), length, nullptr, nullptr); out.pop_back(); return out;
}
} // namespace
struct MidiInputManager::Platform {
  struct Open { HMIDIIN handle = nullptr; std::unique_ptr<Port> port; };
  std::map<std::string, Open> open;
  void close(Open& o) noexcept { if (o.handle) { midiInStop(o.handle); midiInReset(o.handle); midiInClose(o.handle); o.handle = nullptr; } }
  ~Platform() { for (auto& [id, o] : open) close(o); }
};
bool MidiInputManager::supported() noexcept { return true; }
std::vector<MidiDeviceInfo> MidiInputManager::list() {
  std::vector<std::string> names; const auto count = midiInGetNumDevs();
  for (UINT i = 0; i < count; ++i) { MIDIINCAPSW caps{}; names.push_back(midiInGetDevCapsW(i, &caps, sizeof(caps)) == MMSYSERR_NOERROR ? narrow(caps.szPname) : "MIDI " + std::to_string(i + 1)); }
  const auto ids = stableIds(names);
  auto& p = *platform_;
  for (auto it = p.open.begin(); it != p.open.end();) {
    const bool present = std::find(ids.begin(), ids.end(), it->first) != ids.end();
    if (!present || !enabled_.contains(it->first)) { p.close(it->second); it = p.open.erase(it); } else ++it;
  }
  std::vector<MidiDeviceInfo> result;
  for (std::size_t i = 0; i < ids.size(); ++i) {
    const bool enabled = enabled_.contains(ids[i]);
    if (enabled && !p.open.contains(ids[i])) {
      Platform::Open o; o.port = std::make_unique<Port>(Port{&queue_, sourceIndex_(ids[i])});
      if (midiInOpen(&o.handle, static_cast<UINT>(i), reinterpret_cast<DWORD_PTR>(&winmmCallback), reinterpret_cast<DWORD_PTR>(o.port.get()), CALLBACK_FUNCTION) == MMSYSERR_NOERROR) {
        if (midiInStart(o.handle) == MMSYSERR_NOERROR) p.open.emplace(ids[i], std::move(o)); else p.close(o);
      }
    }
    result.push_back({ids[i], names[i], enabled, p.open.contains(ids[i])});
  }
  return result;
}
#elif defined(__APPLE__)
namespace {
void coreMidiRead(const MIDIPacketList* list, void*, void* connection) {
  if (!connection) return;
  auto& port = *static_cast<Port*>(connection);
  const MIDIPacket* packet = &list->packet[0];
  for (UInt32 n = 0; n < list->numPackets; ++n) {
    std::uint8_t message[3]{}; int need = 0, have = 0;
    for (UInt16 i = 0; i < packet->length; ++i) {
      const auto byte = packet->data[i];
      if (byte >= 0xF8) continue; // realtime may interleave
      if (byte & 0x80) {
        if (byte >= 0xF0) { port.running = 0; need = 0; continue; }
        port.running = byte; message[0] = byte; have = 1;
        const auto type = byte & 0xF0; need = (type == 0xC0 || type == 0xD0) ? 2 : 3;
      } else {
        if (!port.running) continue;
        if (have == 0) { message[0] = port.running; have = 1; const auto type = port.running & 0xF0; need = (type == 0xC0 || type == 0xD0) ? 2 : 3; }
        message[have++] = byte;
      }
      if (have && have == need) { deliver(port, message[0], message[1], need == 3 ? message[2] : 0); have = 0; }
    }
    packet = MIDIPacketNext(packet);
  }
}
std::string cfString(CFStringRef text) {
  if (!text) return {};
  char buffer[512]{}; CFStringGetCString(text, buffer, sizeof(buffer), kCFStringEncodingUTF8); return buffer;
}
} // namespace
struct MidiInputManager::Platform {
  MIDIClientRef client = 0; MIDIPortRef input = 0;
  struct Open { MIDIEndpointRef source = 0; std::unique_ptr<Port> port; };
  std::map<std::string, Open> open;
  bool ready() {
    if (input) return true;
    if (!client && MIDIClientCreate(CFSTR("Garak Ieum"), nullptr, nullptr, &client) != noErr) return false;
    return MIDIInputPortCreate(client, CFSTR("Garak Ieum Input"), coreMidiRead, nullptr, &input) == noErr;
  }
  ~Platform() {
    for (auto& [id, o] : open) if (input && o.source) MIDIPortDisconnectSource(input, o.source);
    if (input) MIDIPortDispose(input);
    if (client) MIDIClientDispose(client);
  }
};
bool MidiInputManager::supported() noexcept { return true; }
std::vector<MidiDeviceInfo> MidiInputManager::list() {
  auto& p = *platform_;
  std::vector<std::string> names; std::vector<MIDIEndpointRef> sources;
  if (p.ready()) for (ItemCount i = 0; i < MIDIGetNumberOfSources(); ++i) {
    const auto source = MIDIGetSource(i); CFStringRef name = nullptr;
    MIDIObjectGetStringProperty(source, kMIDIPropertyDisplayName, &name);
    names.push_back(name ? cfString(name) : "MIDI " + std::to_string(i + 1)); if (name) CFRelease(name);
    sources.push_back(source);
  }
  const auto ids = stableIds(names);
  for (auto it = p.open.begin(); it != p.open.end();) {
    const bool present = std::find(ids.begin(), ids.end(), it->first) != ids.end();
    if (!present || !enabled_.contains(it->first)) { if (p.input) MIDIPortDisconnectSource(p.input, it->second.source); it = p.open.erase(it); } else ++it;
  }
  std::vector<MidiDeviceInfo> result;
  for (std::size_t i = 0; i < ids.size(); ++i) {
    const bool enabled = enabled_.contains(ids[i]);
    if (enabled && !p.open.contains(ids[i]) && p.input) {
      Platform::Open o; o.source = sources[i]; o.port = std::make_unique<Port>(Port{&queue_, sourceIndex_(ids[i])});
      if (MIDIPortConnectSource(p.input, o.source, o.port.get()) == noErr) p.open.emplace(ids[i], std::move(o));
    }
    result.push_back({ids[i], names[i], enabled, p.open.contains(ids[i])});
  }
  return result;
}
#else
struct MidiInputManager::Platform {};
bool MidiInputManager::supported() noexcept { return false; }
std::vector<MidiDeviceInfo> MidiInputManager::list() { return {}; }
#endif

MidiInputManager::MidiInputManager(InputQueue& queue, std::function<std::uint16_t(const std::string&)> sourceIndex)
    : queue_(queue), sourceIndex_(std::move(sourceIndex)), platform_(std::make_unique<Platform>()) {}
MidiInputManager::~MidiInputManager() = default;
std::vector<MidiDeviceInfo> MidiInputManager::enable(const std::vector<std::string>& ids) {
  enabled_ = std::set<std::string>(ids.begin(), ids.end());
  return list();
}

} // namespace garak::midi

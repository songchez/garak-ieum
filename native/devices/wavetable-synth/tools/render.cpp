#include "ieum_wave/synth.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <vector>

using namespace ieum::wave;
namespace {
struct Options {
  std::string patch, out, pattern = "chord";
  unsigned sampleRate = 48000;
  double seconds = 6.0, noteSeconds = 3.0, bpm = 120.0;
  float velocity = 0.8f;
  std::uint32_t seed = 123;
  std::vector<unsigned> notes {60, 64, 67};
};
double number(const std::string& text) {
  std::size_t consumed = 0; const double value = std::stod(text, &consumed);
  if (consumed != text.size() || !std::isfinite(value)) throw std::runtime_error("Invalid number: " + text);
  return value;
}
Options parse(int argc, char** argv) {
  Options options;
  for (int i = 1; i < argc; ++i) {
    const std::string flag = argv[i];
    if (flag == "--help") {
      std::cout << "IEUM WAVE native float32 stereo WAV renderer\n"
        "--out FILE.wav [--patch FILE.iewave] [--sample-rate 48000]\n"
        "[--seconds 6] [--note-seconds 3] [--notes 60,64,67] [--velocity 0.8]\n"
        "[--bpm 120] [--seed 123] [--pattern chord|phrase]\n";
      std::exit(0);
    }
    if (++i >= argc) throw std::runtime_error("Missing value for " + flag);
    const std::string value = argv[i];
    if (flag == "--patch") options.patch = value;
    else if (flag == "--out") options.out = value;
    else if (flag == "--pattern") options.pattern = value;
    else if (flag == "--sample-rate") {
      const auto rate = number(value);
      if (rate < 22050 || rate > 192000 || std::floor(rate) != rate) throw std::runtime_error("Invalid sample rate");
      options.sampleRate = static_cast<unsigned>(rate);
    } else if (flag == "--seconds") options.seconds = number(value);
    else if (flag == "--note-seconds") options.noteSeconds = number(value);
    else if (flag == "--velocity") options.velocity = static_cast<float>(number(value));
    else if (flag == "--bpm") options.bpm = number(value);
    else if (flag == "--seed") {
      const auto seed = number(value);
      if (seed < 0 || seed > 4294967295.0 || std::floor(seed) != seed) throw std::runtime_error("Invalid seed");
      options.seed = static_cast<std::uint32_t>(seed);
    } else if (flag == "--notes") {
      options.notes.clear(); std::size_t start = 0;
      do {
        const auto comma = value.find(',', start); const auto note = number(value.substr(start, comma - start));
        if (note < 0 || note > 127 || std::floor(note) != note) throw std::runtime_error("MIDI note must be 0..127");
        options.notes.push_back(static_cast<unsigned>(note));
        if (comma == std::string::npos) break;
        start = comma + 1;
      } while (start <= value.size());
    } else throw std::runtime_error("Unknown option " + flag);
  }
  if (options.out.empty()) throw std::runtime_error("--out is required");
  if (options.seconds <= 0 || options.seconds > 120 || options.noteSeconds <= 0 || options.noteSeconds > options.seconds ||
      options.velocity <= 0 || options.velocity > 1 || options.bpm < 1 || options.bpm > 999 || options.notes.empty() || options.notes.size() > 32 ||
      (options.pattern != "chord" && options.pattern != "phrase")) throw std::runtime_error("Invalid render options");
  return options;
}
void u16(std::ostream& stream, std::uint16_t value) { for (unsigned i = 0; i < 2; ++i) stream.put(static_cast<char>((value >> (8 * i)) & 255u)); }
void u32(std::ostream& stream, std::uint32_t value) { for (unsigned i = 0; i < 4; ++i) stream.put(static_cast<char>((value >> (8 * i)) & 255u)); }
void wave(const Options& options, const std::vector<float>& left, const std::vector<float>& right) {
  std::ofstream stream(options.out, std::ios::binary);
  if (!stream) throw std::runtime_error("Cannot write WAV: " + options.out);
  const auto bytes = static_cast<std::uint32_t>(left.size() * 8);
  stream.write("RIFF", 4); u32(stream, bytes + 50); stream.write("WAVEfmt ", 8);
  u32(stream, 18); u16(stream, 3); u16(stream, 2); u32(stream, options.sampleRate);
  u32(stream, options.sampleRate * 8); u16(stream, 8); u16(stream, 32); u16(stream, 0);
  stream.write("fact", 4); u32(stream, 4); u32(stream, static_cast<std::uint32_t>(left.size()));
  stream.write("data", 4); u32(stream, bytes);
  for (std::size_t i = 0; i < left.size(); ++i) for (float sample : {left[i], right[i]}) {
    std::uint32_t bits; std::memcpy(&bits, &sample, 4); u32(stream, bits);
  }
  if (!stream) throw std::runtime_error("WAV write failed");
}
} // namespace

int main(int argc, char** argv) {
  try {
    const Options options = parse(argc, argv);
    const auto setupStart = std::chrono::steady_clock::now();
    PatchBundle bundle;
    if (!options.patch.empty()) {
      std::ifstream stream(options.patch, std::ios::binary);
      if (!stream) throw std::runtime_error("Cannot read patch: " + options.patch);
      const std::vector<std::uint8_t> bytes {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
      std::string error;
      if (!decodePatchBundle(bytes.data(), bytes.size(), bundle, error)) throw std::runtime_error(error);
    }
    PreparedWavetableSet tables;
    for (const auto& bank : bundle.banks) tables.setCustom(bank.slot, bank.samples.data(), bank.frameCount);
    Synth synth; synth.prepare(options.sampleRate, tables);
    if (!synth.applyPatch(bundle.patch, true)) throw std::runtime_error("Patch cannot be applied to prepared tables");
    synth.reset(options.seed);
    const auto frames = static_cast<std::uint32_t>(std::llround(options.seconds * options.sampleRate));
    std::vector<float> left(frames), right(frames);
    std::vector<Event> scheduled;
    const auto push = [&](unsigned note, double start, double end, std::uint32_t id) {
      Event on; on.type = EventType::NoteOn; on.note = static_cast<std::uint8_t>(note); on.value = options.velocity;
      on.sampleOffset = static_cast<std::uint32_t>(std::llround(start * options.sampleRate)); on.noteId = id;
      Event off = on; off.type = EventType::NoteOff; off.sampleOffset = static_cast<std::uint32_t>(std::llround(end * options.sampleRate));
      if (on.sampleOffset < frames) scheduled.push_back(on);
      if (off.sampleOffset < frames) scheduled.push_back(off);
    };
    if (options.pattern == "phrase") {
      const double beat = 60.0 / options.bpm;
      for (unsigned step = 0; step * beat * 0.5 < options.noteSeconds; ++step) {
        const double start = step * beat * 0.5;
        push(options.notes[step % options.notes.size()], start, std::min(start + beat * 0.43, options.noteSeconds), step + 1);
      }
    } else for (unsigned i = 0; i < options.notes.size(); ++i) push(options.notes[i], 0.0, options.noteSeconds, i + 1);
    std::stable_sort(scheduled.begin(), scheduled.end(), [](const Event& a, const Event& b) { return a.sampleOffset < b.sampleOffset; });
    const double setupSeconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - setupStart).count();
    const auto renderStart = std::chrono::steady_clock::now();
    std::size_t next = 0;
    constexpr unsigned block = 128;
    std::array<Event, 64> events {};
    for (std::uint32_t offset = 0; offset < frames; offset += block) {
      const auto count = std::min(block, frames - offset); std::size_t eventCount = 0;
      while (next < scheduled.size() && scheduled[next].sampleOffset < offset + count) {
        if (eventCount >= events.size()) throw std::runtime_error("Too many render events in block");
        events[eventCount] = scheduled[next++]; events[eventCount++].sampleOffset -= offset;
      }
      const ProcessContext context {options.bpm, static_cast<double>(offset) / options.sampleRate * options.bpm / 60.0, true, true};
      synth.process(left.data() + offset, right.data() + offset, count, events.data(), eventCount, context);
    }
    const double renderSeconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - renderStart).count();
    double peak = 0.0, squared = 0.0, sum = 0.0; std::uint64_t nearCeiling = 0;
    for (std::size_t i = 0; i < frames; ++i) for (float sample : {left[i], right[i]}) {
      if (!std::isfinite(sample)) throw std::runtime_error("Non-finite rendered output");
      peak = std::max(peak, static_cast<double>(std::abs(sample))); squared += sample * static_cast<double>(sample); sum += sample;
      if (std::abs(sample) > 0.939f) ++nearCeiling;
    }
    wave(options, left, right);
    std::cout << std::setprecision(9) << "{\"sampleRate\":" << options.sampleRate << ",\"frames\":" << frames
      << ",\"peak\":" << peak << ",\"rms\":" << std::sqrt(squared / (frames * 2.0))
      << ",\"mean\":" << sum / (frames * 2.0) << ",\"nearCeilingSamples\":" << nearCeiling
      << ",\"setupSeconds\":" << setupSeconds << ",\"renderSeconds\":" << renderSeconds
      << ",\"realtimeFactor\":" << options.seconds / renderSeconds
      << ",\"activeVoices\":" << synth.stats().activeVoices << ",\"stolenVoices\":" << synth.stats().stolenVoices
      << ",\"preparedBytes\":" << tables.bytes() << "}\n";
    return 0;
  } catch (const std::exception& exception) { std::cerr << "ieum-wave-render: " << exception.what() << '\n'; return 1; }
}

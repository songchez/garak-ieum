#include "garak/vst3.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <iostream>
#include <stdexcept>

using namespace garak;
void check(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
void near(float actual, float wanted, const char* message) { check(std::abs(actual - wanted) < .000001f, message); }
template <class F> void throws(F f, const char* message) { bool failed = false; try { f(); } catch (...) { failed = true; } check(failed, message); }

int main(int argc, char** argv) {
  try {
    if (argc != 2) throw std::runtime_error("Expected the actual VST3 fixture module path");
    initializeNativeEvents();
    check(vst3Available(), "This integration test requires real VST3 support");
    const auto catalog = scanVst3(argv[1]);
    check(catalog.size() == 3, "VST3 class scan");
    const auto gain = std::find_if(catalog.begin(), catalog.end(), [](const auto& d) { return !d.isInstrument; });
    const auto instrument = std::find_if(catalog.begin(), catalog.end(), [](const auto& d) { return d.isInstrument; });
    check(gain != catalog.end() && instrument != catalog.end(), "VST3 class roles");
    PluginSpec spec; spec.path = argv[1]; spec.classId = gain->classId; spec.instanceId = "gain";
    Vst3Processor effect(spec, 48000, 64);
    check(effect.parameters().size() == 260 && effect.parameters()[0].id == 0, "VST3 parameter discovery");
    check(effect.latencyFrames() == 0, "VST3 declared latency");
    std::array<float, 128> buffer{}; buffer.fill(.8f);
    ProcessContext context; context.playing = true;
    effect.process(buffer.data(), 64, {}, context);
    near(buffer[0], .4f, "Native VST3 effect renders real input");
    auto bareSpec = spec;
    bareSpec.classId = std::find_if(catalog.begin(), catalog.end(), [](const auto& d) { return d.name == "Garak Native Test Processor Only"; })->classId;
    Vst3Processor bare(bareSpec, 48000, 64);
    check(bare.parameters().empty(), "A VST3 controller is optional");
    buffer.fill(.8f); bare.process(buffer.data(), 64, {}, context);
    near(buffer[0], .4f, "Processor-only VST3 audio");
    check(!bare.saveState().component.empty() && bare.saveState().controller.empty(), "Processor-only VST3 state");
    effect.setParameter(0, .25);
    buffer.fill(.8f); effect.process(buffer.data(), 64, {}, context);
    near(buffer[42], .2f, "Controller-to-processor parameter queue");
    PluginEvent automation{}; automation.type = PluginEvent::Type::Parameter; automation.parameterId = 0; automation.offset = 23; automation.value = .75f;
    buffer.fill(.8f); effect.process(buffer.data(), 64, {&automation, 1}, context);
    near(buffer[44], .2f, "Parameter sample offset before point");
    near(buffer[46], .6f, "Parameter sample offset at point");
    effect.setParameter(0, .625);
    const auto state = effect.saveState(); // Must flush a queued edit even without another audio callback.
    check(!state.component.empty() && !state.controller.empty(), "Separate VST3 state parts");
    spec.state = state.component; spec.controllerState = state.controller;
    Vst3Processor restored(spec, 48000, 64, true);
    buffer.fill(.8f); restored.process(buffer.data(), 64, {}, context);
    near(buffer[0], .5f, "VST3 component/controller state round trip");
    near(float(restored.parameters()[0].value), .625f, "Restored controller parameter");
    for (std::uint32_t i = 0; i < 260; ++i) spec.parameters[i] = 1;
    spec.parameters[259] = .125;
    Vst3Processor manyParameters(spec, 48000, 64);
    buffer.fill(.8f); manyParameters.process(buffer.data(), 64, {}, context);
    near(buffer[0], .1f, "Initial values beyond one bounded parameter batch");
    check(!manyParameters.status().faulted, "Legitimate initial parameter count must not overflow");
    throws([&] { restored.setParameter(0, 1.5); }, "Invalid parameter accepted");
    throws([&] { restored.openEditor(); }, "Missing editor must report an error");
    auto wrong = spec; wrong.classId = "00000000000000000000000000000000";
    throws([&] { Vst3Processor invalid(wrong, 48000, 64); }, "Missing plugin class accepted");
    PluginState huge; huge.component.resize(16 * 1024 * 1024 + 1);
    throws([&] { restored.restoreState(huge); }, "Oversized project state accepted");

    PluginSpec synthSpec; synthSpec.path = argv[1]; synthSpec.classId = instrument->classId; synthSpec.isInstrument = true;
    Vst3Processor synth(synthSpec, 48000, 64);
    std::array<PluginEvent, 3> notes{};
    notes[0].type = PluginEvent::Type::NoteOn; notes[0].pitch = 60; notes[0].noteId = 1; notes[0].value = 1; notes[0].offset = 7;
    notes[1] = notes[0]; notes[1].noteId = 2; notes[1].offset = 11;
    notes[2] = notes[0]; notes[2].type = PluginEvent::Type::NoteOff; notes[2].offset = 29;
    buffer.fill(9.f); synth.process(buffer.data(), 64, notes, context);
    near(buffer[12], 0, "Instrument output before MIDI offset");
    near(buffer[14], .5f, "Instrument note starts at exact offset");
    near(buffer[22], 1, "Overlapping note IDs on the same pitch");
    near(buffer[58], .5f, "Note-off releases only its matching note ID");
    synth.requestReset(); synth.process(buffer.data(), 64, {}, context);
    near(buffer[0], 0, "Transport reset releases all surviving note IDs");
    notes[0].offset = 0; notes[1] = notes[0]; notes[1].noteId = 2;
    synth.process(buffer.data(), 64, {notes.data(), 2}, context);
    synth.requestReset(); synth.process(buffer.data(), 64, {}, context);
    near(buffer[0], 0, "Reset releases simultaneous overlapping pitch voices");
    notes[1].type = PluginEvent::Type::AllNotesOff; notes[1].offset = 17;
    synth.process(buffer.data(), 64, {notes.data(), 2}, context);
    near(buffer[32], .5f, "Explicit all-notes-off preserves prior samples");
    near(buffer[34], 0, "Explicit all-notes-off sample offset");
    check(!synth.status().faulted && !effect.status().faulted, "Actual VST3 processing fault");
    std::cout << "PASS real VST3 scan, lifecycle, effect/instrument processing, offsets, parameters, state and note reset\n";
    return 0;
  } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}

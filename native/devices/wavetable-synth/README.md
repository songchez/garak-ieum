# IEUM WAVE native DSP

This directory contains the original C++17 synthesis engine, a strict patch-pack decoder, native tests, and a float32 WAV renderer. It has no third-party DSP dependency and makes no calls to an audio device, Electron, Web Audio, WASM, JUCE, or an operating-system audio API. The repository's GPL-3.0 license applies.

The application's `garak_core` now links this engine through `native/src/wavetable.cpp`. The common `RenderEngine` routes WAVE timeline notes, live/editor notes and offline WAV export through the same synth. Windows WASAPI and ASIO, and macOS Core Audio, use that common renderer. This library remains independent of the device adapters; its standalone WAV renderer also exercises the C++ synth directly.

## Application host connection

The host `hello` response advertises `wavetable.protocolVersion: 1`, the generated `schemaFingerprint`, and the supported 22,050–192,000 Hz range. The renderer verifies the handshake before advertising a playable WAVE instrument. An enabled WAVE source at an unsupported device/export rate is rejected explicitly.

`project.set` supplies each `native-wavetable` source with `instrumentId: "wavetable"` and `patchData`, a base64-encoded `IEWAVE01` pack. `awaitApplied: true` acknowledges the actual callback graph ticket before returning its revision. This project path also synchronizes tracks whose editor has never been opened. The native host decodes/validates packs and builds mip tables on the control thread, reusing immutable tables when only parameters change.

When a compatible project revision arrives, the new graph adopts the existing synth instance. Held notes, envelope stages, phases and effect state survive scalar/LFO/route edits. Replacing custom tables uses the DSP's 20 ms crossfade; a subsequent graph waits for that fade to finish before another replacement. Completed table ownership and unused processors remain in retired graphs until control-thread collection. Both current/fading sets and queued WAVE graphs count against the native memory budget. The callback never allocates or frees them.

Timeline and audition events use separate internal MIDI channels and nonzero host IDs. `note.on`, `note.off` and timed `note.preview` preserve velocity × clip gain up to 2. `note.allOff {trackId}` releases that track's live/audition notes while preserving its timeline notes and all other tracks. An editor that owns individual note IDs should send their note-offs when it closes. Stop, seek and device reconfiguration reset the synth deterministically. Project-end note-offs are delivered before rendering the release/effect tail, including when a note ends exactly at the project boundary.

The parent native CMake build includes `native-wavetable-host`, which checks real common-renderer output, callback partition independence, offline/live agreement, live note ownership, held-note edits, rapid disjoint custom-table updates, and callback allocation/deallocation. The CLI/Electron smoke suite additionally checks binary transport, capability negotiation, reconfiguration and WAV export. Synthetic-clock tests verify routing but do not claim physical WASAPI/ASIO/Core Audio driver latency or hardware playback validation.

## Implemented synthesis

| Component | Implementation |
| --- | --- |
| Oscillators | Three independent wavetable oscillators; 1–7 unison lanes each; frame position, gain, pan, coarse/fine tuning, detune, stereo spread, initial phase and random phase |
| Polyphony | 16 main voices, with up to 16 temporary 128-sample fading voices during stealing |
| Tables | Four original banks, eight frames each; four user slots with 1–16 frames of 2,048 samples |
| Sub and noise | Bandlimited sine/triangle sub, octave selection; deterministic per-voice stereo white noise |
| Envelopes | Four AHDSR envelopes; ENV1 controls amplitude, all four are modulation sources |
| LFOs | Four editable 128-point cyclic curves, Hz or quarter-note-beat sync; per-note retrigger or global phase; transport phase support |
| Modulation | 16 fixed routes; 19 sources, 18 per-voice destinations, eight macros; amount, polarity, auxiliary source and signed power curve |
| Filters | Two independent stereo TPT state-variable filters, LP/HP/BP/notch, serial/parallel routing and parallel blend |
| Effects | Antiderivative-antialiased drive, stereo modulated chorus delay, filtered cross-feedback delay |
| MIDI/event handling | Sample-offset note on/off, optional note IDs, channel pitch bend, sustain, all-notes-off, channel all-sound-off, parameter events |

The canonical manifest and factory harmonic coefficients live in `src/devices/wavetable-synth/schema.json`. The generated `generated/patch_schema.hpp` and the TypeScript model share the same parameter order and fingerprint. Do not edit the generated header manually. Compile-time assertions guard the compact parameter-block layout used by the DSP.

### Table preparation and antialiasing

Preparation runs outside the audio callback. Each frame has DC removed, then **one peak-normalization gain is applied to the whole bank**, preserving the level relationship among its frames. An original radix-2 FFT builds ten harmonic-limited levels: 1,023, 511, 255, 127, 63, 31, 15, 7, 3 and 1 partials. Zero-padding provides 4,096 playback samples per period.

Playback uses cubic phase interpolation, linear interpolation between adjacent frames, and a crossfade between adjacent mip levels. Mip transitions occur before the richest participating level's top partial reaches `0.46 × sampleRate`. Frequencies at or above that boundary are faded out rather than folded or transposed to another audible pitch. The sub oscillator uses the same prepared-table approach. No FFT or table construction occurs during rendering.

The factory table set, including sub tables, occupies 5,574,640 bytes. Four full 16-frame user banks bring this to 16,068,080 bytes. Replacing a set temporarily requires both sets to remain alive. Hosts can cache prepared sets outside the callback.

This reduces aliasing for ordinary wavetable playback; it is not a guarantee of zero aliasing during rapid pitch/frame modulation or nonlinear processing. Custom frames are neither automatically phase-aligned nor converted into spectral/granular/sample oscillators. Their relationship is the user's authored waveform data.

### Modulation semantics

Sources are ENV1–4, LFO1–4, Macro1–8, note velocity, MIDI key (`note / 127`) and one deterministic random value per note. Each route computes:

1. Read a source in `[0,1]`, optionally map it to `[-1,1]`.
2. Apply `sign(x) × abs(x) ^ (2 ^ (2 × curve))`.
3. Multiply by the optional auxiliary source in `[0,1]` and the route amount.
4. Sum all routes for that destination, then clamp once in the normalized parameter domain.

Cutoff uses a logarithmic normalized domain; other supported targets use their linear parameter range. The destinations are each oscillator's position/level/pan/tune, each filter's cutoff/resonance, sub level, and noise level. Effects are global and are not modulation destinations in this version.

Modulation is evaluated every 16 samples per voice, then applied with sample-by-sample ramps. Continuous control edits have approximately 12 ms smoothing, pitch bend approximately 5 ms, and edited LFO curves approximately 20 ms. Envelopes and LFO phases continue while controls change. AHDSR time edits affect the next stage entered or next note; they do not restart an already-running segment. Sustain level changes are smoothed while in the sustain stage.

LFO `Division` is a duration in quarter-note beats: `.125, .25, .5, 1, 2, 4, 8, 16`. Synced rate is `bpm / (60 × Division)` cycles per second. A global synced LFO follows `ProcessContext.beatPosition` while transport is playing and supplied; a retriggered LFO starts at zero for each note and ignores transport phase. Both continue at their selected rate when transport is stopped.

## Host integration and ownership

Public API: `include/ieum_wave/synth.hpp`. All calls on one instance must be **serialized by the host**. These methods do not provide inter-thread locking.

### Initial setup outside the callback

```cpp
ieum::wave::PatchBundle bundle;
std::string error;
if (!ieum::wave::decodePatchBundle(bytes, byteCount, bundle, error)) {
  // Report the error on the control thread.
}

auto tables = std::make_unique<ieum::wave::PreparedWavetableSet>();
for (const auto& bank : bundle.banks)
  tables->setCustom(bank.slot, bank.samples.data(), bank.frameCount);

ieum::wave::Synth synth;
synth.prepare(48000.0, *tables);
if (!synth.applyPatch(bundle.patch, true)) {
  // Reject the patch; the prior valid state remains intact.
}
synth.reset(123); // Optional reproducible seed; initialization/stopped operation.
```

`prepare()` supports 22,050–192,000 Hz, allocates effect buffers, and initializes voice state. Use it during setup or while stopped. A successful stopped `prepare()` releases all engine references to prior table sets; the host may then dispose of those prior sets itself. `reset()` clears voices and the effect buffers and therefore should be a stopped/global-panic operation, even though it allocates no memory. It is not a patch-update mechanism.

### Audio callback

```cpp
ieum::wave::ProcessContext context;
context.bpm = 120.0;
context.playing = true;
context.hasBeatPosition = true;
context.beatPosition = blockStartInQuarterNoteBeats;

synth.process(left, right, frameCount, sortedEvents, eventCount, context);
```

The two output pointers are non-null planar float buffers overwritten by the engine. Events have offsets relative to this block, sorted ascending, with `0 <= sampleOffset < frameCount`. An event is applied before its addressed sample. At most 4,096 events are consumed per block; malformed, stale or out-of-block events are counted as ignored. Continuous parameter changes begin smoothing at their event; their voice modulation/coefficient update has a maximum 16-sample control interval.

Note channels are `0..15`, notes `0..127`. **NoteOn `value` accepts `0..2`** to preserve the existing timeline's MIDI velocity multiplied by clip gain. That value controls amplitude unchanged. The Velocity modulation source is separately clamped to `[0,1]`. A normal keyboard preview supplies `0..1`; zero NoteOn means NoteOff. Pitch bend uses `[-1,1]` multiplied by the patch's bend range. Sustain uses `[0,1]` with a threshold of `0.5`.

With `noteId != 0`, note-off matches that ID within its channel. With ID zero, it releases the oldest matching held MIDI note. Pedal-held notes release when sustain becomes false. All-notes-off releases the channel's notes and clears its sustain state. Channel all-sound-off removes that channel's generators immediately; shared effect tails remain. A host requiring complete global silence calls `reset()` while stopped or removes the instance from the render graph.

`process`, `applyPatch`, `setParameter`, the prepared-set replacement calls, and pointer retirement perform no allocation, lock, logging, file I/O or device API access. Tables must remain immutable. The engine owns preallocated voices, a small temporary steal-tail pool, and buffers allocated by `prepare()`.

### Editing a held note

For scalar/route/LFO changes with the same waveform set, call `applyPatch(patch)` at a callback boundary or use sample-offset parameter events. Do not call `prepare()` or `reset()` when a knob moves. Successful patch updates preserve voices, envelope stages, phase and MIDI state.

For an edited waveform, prepare a new `PreparedWavetableSet` on a non-audio thread. Transfer only its pointer/ownership token to the serialized audio boundary, then call one of:

```cpp
bool accepted = synth.swapWavetables(newTables); // Same patch, same selected slots.
// Or atomically install a patch that can select different user-bank slots:
bool accepted = synth.applyPreparedPatch(newPatch, newTables);
```

Replacement validates before mutation. It uses a 20 ms waveform-set crossfade by default; an explicit fade length has a minimum of 128 samples. The patch and the new set may use disjoint slots, such as old slot 4 and new slot 5. A bank existing on only one side is read from that side, so an unrelated factory fallback is never inserted into the transition. Bank-selection changes also have a 128-sample crossfade.

The previous set is still in use until the engine returns it:

```cpp
const auto* retired = synth.takeRetiredWavetables();
// Queue the returned ownership token to the control thread for destruction.
// Do not delete/free on the audio callback.
```

A second set replacement returns `false` while the first fade is active or while a retired pointer has not been collected. The host should coalesce incoming edits and retry the latest prepared set after retirement. An unsuccessful call leaves state intact. `takeRetiredWavetables()` never deletes anything. Scalar/LFO/route patches may still update during a set fade. All current/old sets must outlive their last read; the host retains ownership throughout.

## Patch pack

`decodePatchBundle()` reads the versioned, little-endian `IEWAVE01` binary written by `encodeWavetablePatch()` in the TypeScript model. The pack contains the generated schema fingerprint, 104 float parameters, four 128-point LFO curves, up to 16 modulation routes and up to four user banks. The decoder is a control-thread operation.

It rejects an unknown fingerprint/version, invalid enums/options, non-finite values, out-of-range samples or controls, missing selected user banks (including disabled oscillators), duplicate bank slots, oversized counts and any trailing/truncated data. A failed decode leaves the previous output bundle unchanged. Preset metadata remains in the project JSON; it is not part of the DSP pack.

## Building and testing

From the repository root, with CMake, a C++17 compiler and Ninja available:

```sh
cmake -S native/devices/wavetable-synth \
  -B build/native/wavetable-synth -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build/native/wavetable-synth
ctest --test-dir build/native/wavetable-synth --output-on-failure
```

MSVC builds use `/fp:precise`; GCC/Clang builds intentionally avoid `-ffast-math`, which would conflict with finite-value validation. `IEUM_WAVE_BUILD_TESTS=OFF` omits the test executable. `IEUM_WAVE_SANITIZE=ON` enables AddressSanitizer and UndefinedBehaviorSanitizer on non-MSVC builds.

The tests cover event timing and partition invariance, AHDSR timing, pedal/repeated notes, voice stealing, held-note updates, atomic disjoint-bank replacement, table retirement, all 18 modulation destinations, polarity/auxiliary/curve semantics, logarithmic cutoff, tempo/retrigger/transport LFO behavior, filters/effects, timeline clip gain, strict pack rejection, zero heap allocations in callback operations, spectral residuals, and finite bounded output at 44.1/48/96 kHz.

The benchmark additionally reports 64-frame callback p50/p95/p99/max at those three rates under 16 voices × 3 oscillators × 7 unison, 16 routes, two filters and all effects. It reports observed deadline overruns instead of asserting a machine-independent real-time guarantee. This development container does not run with a device driver's real-time thread priority, so OS scheduling affects the maxima. The maximum 96 kHz combination currently leaves insufficient headroom here; 48 kHz is the initial integration target. Temporary steal tails or table crossfades can increase load further. Validate actual host/device settings on the intended Windows and Apple Silicon hardware.

### Cross-language fixtures and real audio

```sh
node src/devices/wavetable-synth/generate-fixtures.mjs
build/native/wavetable-synth/ieum-wave-render \
  --patch build/native/wavetable-synth/fixtures/init.iewave \
  --out build/native/wavetable-synth/example.wav \
  --sample-rate 48000 --seconds 6 --note-seconds 3 \
  --notes 60,64,67 --velocity 0.8 --bpm 120 --seed 123
```

Use an actual generated fixture filename in `--patch`; omitting the argument renders the native init patch. `--pattern phrase` plays a short sequence instead of a held chord. The output is a standard stereo float32 WAV, with JSON statistics on stdout: peak, RMS, mean, near-ceiling count, preparation/render times, realtime factor, active/stolen voices and prepared-table bytes. The renderer's default velocity range remains `0..1` for keyboard-preview use.

## Current boundaries

This version provides wavetable synthesis, original banks and application-native host integration. It does not implement Serum's warp modes, FM/PM, sample/granular/spectral/multisample oscillators, a commercial factory library, audio-to-wavetable analysis, or oversampled nonlinear filters. There is no claim of Serum sound equivalence.

The drive uses first-order antiderivative antialiasing, not oversampling. The final output has a transparent-below-0.94 soft safety ceiling approaching 0.98, not lookahead limiting or loudness normalization. Extreme patch levels or dense chords can reach that ceiling and color the result. Effects and waveform interpolation are original algorithms and still require listening/host-hardware evaluation beyond the deterministic and spectral tests.

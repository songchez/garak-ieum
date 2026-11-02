# Signalsmith Stretch WASM core

The upstream Signalsmith Stretch distribution is MIT licensed. This pinned copy
is used directly in an ordinary Worker for offline PCM processing. It does not
instantiate the AudioWorklet wrapper or fetch runtime code from a CDN.

- Upstream: https://github.com/Signalsmith-Audio/signalsmith-stretch
- Commit: `88061fd4eda56a2353c5d65c74aa3f4ccf76f9da`
- Original file: `web/release/SignalsmithStretch.mjs`
- Original SHA-256: `97530b11d5bc01015af4cde40d6aa55ff10c40aa1294ca4c8c5762027d517a46`
- Adapted SHA-256: `fb089b3b4c30e3128cdc515339b7a69a7673c3bf829c45b5609be856f62dbb04`
- License: [LICENSE.signalsmith.txt](LICENSE.signalsmith.txt)
- Public C binding: `web/emscripten/main.cpp` in that upstream commit.

## Local adaptation

Keep the original generated Emscripten factory up to its first CommonJS/AMD
registration (`if (typeof exports === 'object' && typeof module === 'object')`).
Remove that registration and the following AudioWorklet wrapper, then append
`export default SignalsmithStretch;`. Normalize trailing whitespace and blank
lines at EOF. No DSP instructions or embedded WASM bytes
are modified. A TypeScript declaration describes only the C binding we use.

The factory includes the compiled WASM bytes. Each rendering task creates a fresh
module: the upstream C binding has one global stretcher per module. PCM is copied
into its documented contiguous channel buffers and read from output buffers.
The renderer uses neutral-pitch time stretching and a 64-tap, 1024-phase
Blackman-windowed sinc resampler to shift pitch while retaining exact source
frame count. For ratio `r`, the stretched stream is aligned by
`inputLatency * r + outputLatency` frames before resampling. Zero-padding flushes
the required tail; a small ring buffer keeps intermediate memory bounded.
Node PCM tests exercise this exact vendored binary.

Direct spectral transposition was rejected after two independent measurements
showed 10.54 cents of error for a requested −20-cent shift of a 220 Hz sine.
The replacement and original paths are both reproducible in
[`scripts/pitch-poc`](../../../../scripts/pitch-poc/README.md).
No automatic formant compensation is applied: formants move with pitch.

The source-window adapter renders changed notes with surrounding source context,
preserves sample count and stereo channel layout, and crossfades into unchanged
source at note boundaries. This is an initial monophonic note editor, not
polyphonic note separation, advanced time warping, or Melodyne-quality parity.


Saved note times remain in source seconds. Decoding the same file at a different
sample rate can round its duration. The adapter permits at most 0.25 ms of end
overrun (two frames at the minimum supported 8 kHz rate), then clamps actual
rendering to the current PCM frame count. Positive trim fragments are accepted;
fragments that round to zero or one frame pass through unchanged.

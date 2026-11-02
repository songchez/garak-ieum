# Reproduce the pitch DSP measurements

Use Node 24 or newer. This imports the app's actual TypeScript analysis/render
modules and pinned Signalsmith WASM binary; it does not install another DSP library.

```bash
node scripts/pitch-poc/run.mjs --out /tmp/garak-pitch-poc --assets docs/assets
```

Without output flags, the script only prints JSON. `--out` writes the complete
report, a generated sine source, its eight rendered/bypass versions, and the
musical fixture. `--assets` writes only the review fixtures:

- `docs/assets/pitch-editor-original.wav`
- `docs/assets/pitch-editor-edited.wav`
- `docs/assets/pitch-editor-metrics.json`

All audio is synthesized by this script. The WAV files contain mono 48 kHz
32-bit float PCM, preserving actual output values. No user recordings are used
or uploaded. Runtime milliseconds describe the current machine only.

## Actual analysis → note editing → rendering

A 4.8-second four-note harmonic motif (MIDI 57, 60, 64, 57) has ±15-cent, 5 Hz
vibrato and short attack/release envelopes. The script detects its notes, shifts
the detected second note by +200 cents and fourth note by −100 cents, then
analyzes the real output again. It verifies identical input/output frame counts,
unchanged source, and bit-identical samples outside the edited note spans.

The checked-in run detected four notes. Its central contour medians measured
+199.56 and −99.58 cents for the two edits. Those medians include detector error
and the effect of stretching a changing vibrato contour; they are not a proof
that every instantaneous pitch sample has sub-cent error. The source and output
are both exactly 230,400 frames. Unedited notes are unchanged.

## Why direct spectral transposition was replaced

The first adapter called Signalsmith's direct transpose function with automatic
formant compensation. A requested −20-cent change to a 220 Hz sine produced
about −9.46 cents, an error of +10.54 cents. Turning off formant compensation
had the same general error. FFT blocks of 80, 160, 240 and 320 ms did not resolve
it consistently. The phase-vocoder's direct spectral mapping was unsuitable for
this precision requirement in the pinned binary.

The final renderer uses **neutral-pitch time stretching followed by bandlimited
resampling**. It stretches by `2 ** (cents / 1200)` and resamples by that same
ratio, retaining source duration. The 64-tap Blackman-windowed sinc resampler
also filters frequencies that would alias on upward shifts. A small ring buffer
avoids allocating an entire intermediate stretched recording. Renderer identity:
`signalsmith-88061fd4-stretch-sinc64-v1`.

The script retains the old path for comparison on the **same** four-second,
48 kHz, 220 Hz, 0.4-amplitude sine. Both paths are measured over the central
one-to-three-second interval using interpolated positive zero crossings and an
independent Hann-window DFT peak fit (±4 Hz search, 0.125 Hz grid, parabolic
log-power interpolation). Signed errors from the checked-in run:

| Requested change | Former direct transpose | Final stretch + sinc |
| --- | ---: | ---: |
| −1200 cents | +7.9356 cents | +0.0022 cents |
| −50 cents | −0.5092 cents | +0.0004 cents |
| −20 cents | +10.5367 cents | +0.0014 cents |
| +20 cents | +2.3689 cents | +0.0002 cents |
| +50 cents | +7.1872 cents | −0.0001 cents |
| +1200 cents | +0.5732 cents | −0.0024 cents |

The independent DFT confirms that the former errors were in the rendered
signal, not a short-window crossing-count artefact. Its final-render estimates
are even closer to the targets. The small difference between final zero-crossing
and DFT estimates reflects finite-window and waveform measurement effects.
These steady sine results are **not** a universal accuracy or sound-quality
claim for natural voices, attacks, or changing pitch.

The script also checks zero-edit bit-exact bypass, exact frame counts, input
immutability, and untouched samples outside the edit. It fails if sine errors
exceed 0.1 cent or motif center errors exceed 5 cents. It reports 55 Hz / 1600 Hz
boundary-detector results; the checked-in errors are below 0.04 cent.

## Regression scope and limits

Vitest additionally covers stereo/antiphase audio, adjacent independently shifted
notes, 8/44.1/48/96/192 kHz processing, anti-alias filtering, source-start/end
alignment, sub-frame trim fragments, noise/silence, invalid/oversized inputs,
worker cancellation, and transfer-copy ownership.

Saved note coordinates remain in source seconds when decoding at another sample
rate. End-time validation allows at most 0.25 ms of rounding overrun (two frames
at 8 kHz), then clamps rendering to actual PCM length. Positive trimmed fragments
below the detector's 25 ms minimum are accepted; fragments rounding to zero or
one frame pass through unchanged.

These are engineering checks, not a listening evaluation. Natural voices,
consonants, transients and instruments still need representative listening
comparison. The detector covers monophonic 55–1600 Hz material, not polyphonic
separation or calibrated confidence. Formants move with pitch; automatic
formant preservation, advanced vocal controls and time warping are not included.

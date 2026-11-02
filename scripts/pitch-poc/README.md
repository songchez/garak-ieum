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
`signalsmith-88061fd4-stretch-sinc64-v1` in the original checked-in report. The
version-2 renderer retains this default pitch path and identifies its optional
formant policy as `signalsmith-88061fd4-stretch-sinc64-formants-v2`.

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
separation or calibrated confidence. Default settings leave formants moving with
pitch. The optional version-2 envelope controls are measured separately below;
advanced vocal controls and time warping are not included.

## Formant experiment

```bash
node scripts/pitch-poc/formants.mjs --out /tmp/garak-formant-poc --metrics docs/assets/pitch-formant-metrics.json
```

This runs the actual application renderer and writes the JSON report. Audition
WAVs are restricted to `/tmp/garak-formant-poc` or a child folder; no generated
audio is added to the repository. `--quick` selects a smaller exploratory set.
The ordinary command measures 182 accepted renders and verifies 16 rejected
combinations. It also checks zero-edit bypass, stereo antiphase, adjacent notes,
source-start/end alignment, subframe fragments and cross-rate end-time tolerance.

### Signal and measurement method

The two-second harmonic vowel-like fixtures use known Gaussian resonant
envelopes at 650, 1250 and 2500 Hz, with standard deviations of 90, 110 and 160 Hz,
relative heights 1, 0.8 and 0.6, and a small baseline between resonances. Harmonic
amplitude falls as the square root of harmonic number. Deterministic phases,
25 ms attack/release and a source peak of 0.65 make the fixtures reproducible.
These are analytic periodic signals, not natural voices or anatomical models.

At 48 kHz, the matrix uses source fundamentals of 110, 120, 150, 220 and 240 Hz;
pitch and formant requests include both signs of 100, 200, 300, 600 and 1200 cents.
Additional 150 Hz fixtures cover 8, 96 and 192 kHz. The stable measurement window
is 0.6–1.4 seconds.

The report contains two frequency estimates. A Hann-window DFT peak fit measures
the fundamental, and an independent peak fit measures the strongest harmonic and
divides by its harmonic index. The latter checks periodic pitch when the first
harmonic is weak. Both use a 0.125 Hz grid with log-magnitude interpolation; both
results remain visible when they disagree. This is not a universal instantaneous
pitch-accuracy guarantee for natural voices or transients.

Envelope measurements compare harmonic magnitudes with the known analytic
envelope after removing only a constant gain. A grid search from −2600 to +2600
cents in 5-cent increments finds the best overall envelope displacement. The
report separately records residual error to the requested envelope and estimated
individual peak locations. Sparse harmonics can leave a resonance unresolved;
the report marks it missing instead of inventing a peak. A small global fit error
does **not** prove that every individual resonance was recovered.

### Observed quality and limits

Preservation is **off by default** and remains experimental. In the checked-in
matrix, moderate corrections at a low fundamental improve the broad envelope,
while higher-register and large-shift cases can leave large residuals:

| Source F0 | Pitch request with preservation | Fitted envelope displacement | Target-envelope residual |
| --- | ---: | ---: | ---: |
| 110 Hz | −300 cents | −20 cents | 3.67 dB |
| 110 Hz | +300 cents | +70 cents | 4.02 dB |
| 150 Hz | −300 cents | −45 cents | 4.91 dB |
| 150 Hz | +300 cents | +115 cents | 5.50 dB |
| 220 Hz | −300 cents | −205 cents | 6.87 dB |
| 220 Hz | +300 cents | +155 cents | 6.78 dB |
| 220 Hz | +600 cents | −625 cents | 9.99 dB |

The intended envelope displacement in this table is zero. These failures are
retained in [`pitch-formant-metrics.json`](../../docs/assets/pitch-formant-metrics.json),
alongside every other accepted case. The formant-only control also produces a
measured envelope change, but its cents value is a requested envelope scale,
not a promise of exact individual resonance positions. The upstream algorithm
uses a smoothed spectral envelope and explicitly describes its correction as
less sharp than monophonic methods; see the pinned
[implementation](https://github.com/Signalsmith-Audio/signalsmith-stretch/blob/88061fd4eda56a2353c5d65c74aa3f4ccf76f9da/signalsmith-stretch.h)
and [upstream documentation](https://github.com/Signalsmith-Audio/signalsmith-stretch#formant-compensation).

Across the 182 accepted cases, the maximum strongest-harmonic pitch error is
about 0.0115 cents. The weak-fundamental estimate reaches 0.344 cents on an
octave-down 110 Hz fixture; the default legacy path has the same discrepancy,
and its strongest harmonic is within 0.0002 cents. This distinction is retained
in the report rather than treating a short-window first-harmonic estimate as a
complete description of periodic pitch. All accepted cases preserve frame count,
finite samples, input buffers and samples outside their edited intervals.

Accepted outputs can still exceed float-PCM unity: the largest measured peak is
1.168 from a source peak of 0.65, and the largest RMS increase is about 1.33 dB.
The adapter performs no hidden normalization, clipping or limiting. Larger
formant offsets can also lose resonances even when a request is accepted;
Nyquist and source-harmonic bandwidth cannot be recovered by envelope remapping.
Natural speech, singing, consonants and attacks require listening comparison.
These synthetic checks are not a listening test or a Melodyne-parity claim.

### Rejected combined shifts

For pitch delta `p` and formant offset `f`, the renderer applies an upstream
envelope shift of `f - (preserveFormants ? p : 0)` before the final resampling.
Each individual control accepts ±1200 cents. The effective upstream shift must
also remain within **±1200 cents, inclusive**; larger combinations fail with an
explicit error before DSP starts. Reducing the difference or disabling
preservation makes the intended alternative concrete.

The earlier unguarded candidate allowed effective shifts of ±2400 cents. The
combination +1200 pitch / −1200 formant at 150 Hz produced a dominant-harmonic
pitch error of about 0.62–0.74 cents across rates, and the inverse combination
reached a peak of 1.562 and a maximum RMS increase of 3.36 dB. Those observations
motivated the combined-shift restriction; they are **not** accepted render results.
The 16 historical candidate records are preserved in
[`rejected-formant-candidates.json`](rejected-formant-candidates.json) and embedded
separately in the report. They describe the earlier candidate and are not
recomputed by bypassing the final renderer's guard. Each new run verifies that
the same requests are explicitly rejected without changing the source.

The command exits unsuccessfully if PCM integrity, the strongest-harmonic pitch
check, stereo/boundary/bypass invariants, or rejection checks fail. The independent
weak-fundamental result and formant-quality flags are descriptive measurements;
their failures remain in JSON. Successful execution does not certify perceptual
formant quality. No listening evaluation or real-browser audio test is claimed.

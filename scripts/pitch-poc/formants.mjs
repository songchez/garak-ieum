// Node 24+. Synthetic envelope measurements of the application's actual renderer.
import { registerHooks } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context) }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && /^\.{1,2}\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
      throw error
    }
  },
})
const { renderPitch, PITCH_RENDERER_ID } = await import('../../src/devices/pitch-editor/render.ts')

const centsBetween = (actual, expected) => 1200 * Math.log2(actual / expected)
const hash = channel => createHash('sha256').update(new Uint8Array(channel.buffer, channel.byteOffset, channel.byteLength)).digest('hex')
const profile = { centersHz: [650, 1250, 2500], widthsHz: [90, 110, 160], heights: [1, 0.8, 0.6] }
const rms = samples => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)
const peak = samples => samples.reduce((value, sample) => Math.max(value, Math.abs(sample)), 0)

// A periodic voiced fixture with three specified Gaussian resonance envelopes.
// Its broad baseline retains measurable harmonics between peaks. This is an
// analytic vowel-like signal, not a recording or an anatomical vocal-tract model.
function envelope(hz, f0) {
  let amplitude = 0.025
  for (let j = 0; j < profile.centersHz.length; j += 1) amplitude += profile.heights[j] * Math.exp(-0.5 * ((hz - profile.centersHz[j]) / profile.widthsHz[j]) ** 2)
  return amplitude * Math.sqrt(f0 / Math.max(f0, hz))
}
function vowel(rate, f0, seconds = 2) {
  const result = new Float32Array(Math.round(rate * seconds))
  const harmonics = Math.floor(Math.min(7500, rate * 0.45) / f0)
  for (let h = 1; h <= harmonics; h += 1) {
    const amplitude = envelope(h * f0, f0)
    const omega = 2 * Math.PI * f0 * h / rate
    for (let i = 0; i < result.length; i += 1) result[i] += amplitude * Math.sin(omega * i + 0.23 * h * h)
  }
  let peak = 0
  for (const value of result) peak = Math.max(peak, Math.abs(value))
  for (let i = 0; i < result.length; i += 1) {
    const edge = Math.min(1, i / (0.025 * rate), (result.length - 1 - i) / (0.025 * rate))
    result[i] *= 0.65 * Math.max(0, edge) / peak
  }
  return result
}
function hann(samples, rate, start = 0.6, end = 1.4) {
  const frames = Math.round((end - start) * rate), from = Math.round(start * rate)
  return Float64Array.from({ length: frames }, (_, i) => samples[from + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (frames - 1))))
}
function amplitudeAt(weighted, rate, hz) {
  const angle = 2 * Math.PI * hz / rate, cr = Math.cos(angle), ci = Math.sin(angle)
  let pr = 1, pi = 0, real = 0, imaginary = 0
  for (const value of weighted) {
    real += value * pr; imaginary += value * pi
    const next = pr * cr - pi * ci
    pi = pr * ci + pi * cr; pr = next
  }
  return Math.max(1e-15, Math.hypot(real, imaginary) * 4 / weighted.length)
}
function measureF0(weighted, rate, expected) {
  const step = 0.125, half = 24, powers = []
  for (let j = -half; j <= half; j += 1) powers.push(Math.log(amplitudeAt(weighted, rate, expected + j * step)))
  const peak = powers.indexOf(Math.max(...powers))
  if (!peak || peak === powers.length - 1) return null
  const offset = 0.5 * (powers[peak - 1] - powers[peak + 1]) / (powers[peak - 1] - 2 * powers[peak] + powers[peak + 1])
  return expected + (peak - half + offset) * step
}
function harmonics(weighted, rate, f0, maxHz) {
  return Array.from({ length: Math.floor(maxHz / f0) }, (_, h) => {
    const hz = (h + 1) * f0
    return { hz, db: 20 * Math.log10(amplitudeAt(weighted, rate, hz)) }
  })
}
function envelopeError(spectrum, sourceF0, shift) {
  const ratio = 2 ** (shift / 1200)
  const residuals = spectrum.map(point => point.db - 20 * Math.log10(envelope(point.hz / ratio, sourceF0)))
  const gain = residuals.reduce((sum, value) => sum + value, 0) / residuals.length
  return Math.sqrt(residuals.reduce((sum, value) => sum + (value - gain) ** 2, 0) / residuals.length)
}
function fitEnvelope(spectrum, sourceF0, expectedCents) {
  let bestCents = 0, bestError = Infinity
  for (let shift = -2600; shift <= 2600; shift += 5) {
    const error = envelopeError(spectrum, sourceF0, shift)
    if (error < bestError) { bestError = error; bestCents = shift }
  }
  return { expectedCents, fittedCents: bestCents, errorCents: bestCents - expectedCents, fittedRmseDb: bestError, targetRmseDb: envelopeError(spectrum, sourceF0, expectedCents) }
}
function peaks(spectrum, expectedRatio) {
  return profile.centersHz.map((center, index) => {
    const expectedHz = center * expectedRatio
    const lower = (index ? (profile.centersHz[index - 1] + center) / 2 : center * 0.5) * expectedRatio
    const upper = (index < 2 ? (center + profile.centersHz[index + 1]) / 2 : center * 1.4) * expectedRatio
    const candidates = spectrum.map((point, i) => ({ ...point, i })).filter(point => point.i > 0 && point.i < spectrum.length - 1 && point.hz >= lower && point.hz <= upper && point.db > spectrum[point.i - 1].db && point.db >= spectrum[point.i + 1].db)
    if (!candidates.length) return { expectedHz, measuredHz: null, errorHz: null, resolved: false }
    const peak = candidates.reduce((a, b) => a.db >= b.db ? a : b)
    const a = spectrum[peak.i - 1], b = spectrum[peak.i], c = spectrum[peak.i + 1]
    const offset = 0.5 * (a.db - c.db) / (a.db - 2 * b.db + c.db)
    const measuredHz = b.hz + offset * (c.hz - b.hz)
    return { expectedHz, measuredHz, errorHz: measuredHz - expectedHz, resolved: true }
  })
}
function unchangedOutside(input, output, rate, segments) {
  const intervals = segments.map(segment => [Math.max(0, Math.round(segment.start * rate)), Math.min(input.length, Math.round(segment.end * rate))])
  return input.every((value, i) => intervals.some(([start, end]) => i >= start && i < end) || Object.is(value, output[i]))
}
function wav(channels, rate) {
  const frames = channels[0].length, stride = channels.length * 4, buffer = Buffer.alloc(44 + frames * stride)
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(3, 20); buffer.writeUInt16LE(channels.length, 22)
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * stride, 28); buffer.writeUInt16LE(stride, 32); buffer.writeUInt16LE(32, 34)
  buffer.write('data', 36); buffer.writeUInt32LE(frames * stride, 40)
  for (let i = 0; i < frames; i += 1) for (let c = 0; c < channels.length; c += 1) buffer.writeFloatLE(channels[c][i], 44 + i * stride + c * 4)
  return buffer
}

const outFlag = process.argv.indexOf('--out'), metricsFlag = process.argv.indexOf('--metrics')
const directory = outFlag < 0 ? null : process.argv[outFlag + 1]
if (outFlag >= 0 && (!directory || (directory !== '/tmp/garak-formant-poc' && !directory.startsWith('/tmp/garak-formant-poc/')) || directory.split('/').includes('..'))) throw new Error('--out must name /tmp/garak-formant-poc or a child directory; audition WAVs must not enter the repository')
if (directory) await mkdir(directory, { recursive: true })
const report = {
  renderer: PITCH_RENDERER_ID, runtime: process.version, platform: `${process.platform}/${process.arch}`,
  fixture: { description: 'Two-second generated harmonic vowel-like fixture; three Gaussian resonant envelopes plus a 0.025 baseline; amplitude decreases with sqrt(harmonic number), deterministic harmonic phases, 25 ms attack/release, 0.65 peak.', ...profile, measurementSeconds: [0.6, 1.4] },
  method: { f0: 'Hann DFT peak near expected fundamental, 0.125 Hz grid and log-magnitude interpolation. Separately measure the strongest harmonic peak and divide by its harmonic index; retain both results because a weak fundamental can have different leakage/sidebands.', envelope: 'Gain-normalized dB residual to the known analytic envelope over harmonic amplitudes; search all net envelope shifts from -2600 to +2600 cents in 5-cent steps. This is an aggregate envelope fit, not a human-vowel/formant tracker.', peaks: 'Local harmonic-magnitude maxima with 3-point log-magnitude interpolation; no result if a peak lacks neighboring harmonics. Sparse harmonics and changed envelope widths limit peak precision.', qualityFlags: 'Observational flags at >100 cents aggregate fit error, >6 dB target envelope RMSE, unresolved resonance, >1 peak, or >0.2 cents weak-fundamental error. They are not perceptual acceptance criteria.' },
  policy: { formantPreShiftCents: 'formantOffsetCents - (preserveFormants ? pitchCents : 0)', maxAbsolutePreShiftCents: 1200, expectedNetEnvelopeCents: 'formantOffsetCents + (preserveFormants ? 0 : pitchCents)', formantBase: 'source note F0 / sampleRate', automaticCompensation: false, newAnalysisDefault: false },
  sources: [
    'https://github.com/Signalsmith-Audio/signalsmith-stretch/blob/88061fd4eda56a2353c5d65c74aa3f4ccf76f9da/signalsmith-stretch.h',
    'https://github.com/Signalsmith-Audio/signalsmith-stretch/blob/88061fd4eda56a2353c5d65c74aa3f4ccf76f9da/web/emscripten/main.cpp',
    'https://github.com/Signalsmith-Audio/signalsmith-stretch#formant-compensation',
  ],
  measurements: [], rejectedRequests: [],
  recordedRejectedCandidates: JSON.parse(await readFile(new URL('./rejected-formant-candidates.json', import.meta.url), 'utf8')),
  limits: ['Synthetic measurement only; no listening evaluation or natural-voice validation.', 'Envelope smoothing is approximate; sparse harmonics at high F0 and large combined shifts can move, smear, or erase individual peaks.', 'Resampling cannot reconstruct harmonics absent from the original source or above the final Nyquist limit.', 'Unchanged audio bypasses exactly; edited note boundaries retain the source through short crossfades.', 'Historical unguarded candidate failures are retained separately and are not results from the final renderer.'],
}
const quick = process.argv.includes('--quick')
const amounts = quick ? [-1200, -600, -300, 300, 600, 1200] : [-1200, -600, -300, -200, -100, 100, 200, 300, 600, 1200]
const scenarios = [
  ...amounts.flatMap(pitchCents => [false, true].map(preserveFormants => ({ pitchCents, formantCents: 0, preserveFormants }))),
  ...amounts.map(formantCents => ({ pitchCents: 0, formantCents, preserveFormants: true })),
  { pitchCents: 600, formantCents: -300, preserveFormants: true },
  { pitchCents: -600, formantCents: 300, preserveFormants: true },
  { pitchCents: 1200, formantCents: -1200, preserveFormants: true },
  { pitchCents: -1200, formantCents: 1200, preserveFormants: true },
  { pitchCents: 300, formantCents: 200, preserveFormants: false },
  { pitchCents: -300, formantCents: -200, preserveFormants: false },
]
const fixtures = (quick ? [120] : [110, 120, 150, 220, 240]).map(f0 => ({ rate: 48000, f0, group: 'voice-registers', scenarios }))
if (!quick) for (const rate of [8000, 96000, 192000]) fixtures.push({ rate, f0: 150, group: 'supported-rates', scenarios: [
  ...[-600, 600].map(pitchCents => ({ pitchCents, formantCents: 0, preserveFormants: true })),
  ...[-300, 300].map(formantCents => ({ pitchCents: 0, formantCents, preserveFormants: true })),
  { pitchCents: 1200, formantCents: -1200, preserveFormants: true },
  { pitchCents: -1200, formantCents: 1200, preserveFormants: true },
] })
for (const fixture of fixtures) {
  const { rate, f0, group } = fixture, input = vowel(rate, f0), inputHash = hash(input)
  const segment = { id: 'vowel', start: 0.1, end: 1.9, midi: 69 + 12 * Math.log2(f0 / 440), confidence: 1 }
  const inputSpectrum = harmonics(hann(input, rate), rate, f0, Math.min(6000, rate * 0.42))
  report.measurements.push({ group, sampleRate: rate, sourceF0: f0, sourceReference: true, envelope: fitEnvelope(inputSpectrum, f0, 0), peaks: peaks(inputSpectrum, 1), peak: peak(input), rms: rms(input.subarray(Math.round(rate * 0.6), Math.round(rate * 1.4))) })
  if (directory && rate === 48000) await writeFile(join(directory, `source-${f0}hz.wav`), wav([input], rate))
  for (const scenario of fixture.scenarios) {
    const { pitchCents, formantCents, preserveFormants } = scenario
    const preShiftCents = formantCents - (preserveFormants ? pitchCents : 0)
    if (Math.abs(preShiftCents) > 1200) {
      let rejected = false, message = null
      try { await renderPitch([input], rate, [segment], { vowel: pitchCents }, undefined, { preserveFormants, formantShifts: { vowel: formantCents } }) }
      catch (error) { rejected = true; message = error.message }
      report.rejectedRequests.push({ group, sampleRate: rate, sourceF0: f0, ...scenario, preShiftCents, rejected, message, inputUnchanged: hash(input) === inputHash })
      continue
    }
    const started = performance.now()
    const [output] = await renderPitch([input], rate, [segment], { vowel: pitchCents }, undefined, { preserveFormants, formantShifts: { vowel: formantCents } })
    const milliseconds = performance.now() - started
    const expectedF0 = f0 * 2 ** (pitchCents / 1200), weighted = hann(output, rate), measuredF0 = measureF0(weighted, rate, expectedF0)
    const maxHz = Math.min(6000, rate * 0.42, Math.min(7000, rate * 0.42) * 2 ** (pitchCents / 1200))
    const spectrum = harmonics(weighted, rate, expectedF0, maxHz)
    const strongestHarmonic = spectrum.reduce((a, b) => a.db > b.db ? a : b), harmonicIndex = Math.round(strongestHarmonic.hz / expectedF0)
    const measuredHarmonic = measureF0(weighted, rate, strongestHarmonic.hz)
    const strongestHarmonicF0 = measuredHarmonic === null ? null : measuredHarmonic / harmonicIndex
    const expectedEnvelopeCents = formantCents + (preserveFormants ? 0 : pitchCents)
    const envelopeMeasurement = fitEnvelope(spectrum, f0, expectedEnvelopeCents), peakMeasurements = peaks(spectrum, 2 ** (expectedEnvelopeCents / 1200))
    const sourceRms = rms(input.subarray(Math.round(rate * 0.6), Math.round(rate * 1.4))), renderedRms = rms(output.subarray(Math.round(rate * 0.6), Math.round(rate * 1.4)))
    const outputPeak = peak(output), qualityFlags = []
    if (Math.abs(envelopeMeasurement.errorCents) > 100) qualityFlags.push('aggregate-envelope-fit-error-over-100-cents')
    if (envelopeMeasurement.targetRmseDb > 6) qualityFlags.push('target-envelope-rmse-over-6-db')
    if (peakMeasurements.some(value => !value.resolved)) qualityFlags.push('one-or-more-resonances-not-resolved')
    if (outputPeak > 1) qualityFlags.push('float-pcm-peak-exceeds-unity')
    if (measuredF0 === null || Math.abs(centsBetween(measuredF0, expectedF0)) > 0.2) qualityFlags.push('weak-fundamental-error-over-0.2-cents')
    report.measurements.push({ group, sampleRate: rate, sourceF0: f0, ...scenario, expectedF0, measuredF0, f0ErrorCents: measuredF0 === null ? null : centsBetween(measuredF0, expectedF0), strongestHarmonicIndex: harmonicIndex, strongestHarmonicF0, strongestHarmonicF0ErrorCents: strongestHarmonicF0 === null ? null : centsBetween(strongestHarmonicF0, expectedF0), envelope: envelopeMeasurement, peaks: peakMeasurements, sourceFrames: input.length, outputFrames: output.length, inputUnchanged: hash(input) === inputHash, outsideUnchanged: unchangedOutside(input, output, rate, [segment]), finite: output.every(Number.isFinite), sourcePeak: peak(input), peak: outputPeak, sourceRms, renderedRms, rmsGainDb: 20 * Math.log10(renderedRms / sourceRms), peakGainDb: 20 * Math.log10(outputPeak / peak(input)), samplesAboveUnity: output.reduce((sum, value) => sum + (Math.abs(value) > 1 ? 1 : 0), 0), qualityFlags, milliseconds, outputSha256: hash(output) })
    if (directory && rate === 48000 && (f0 === 120 || f0 === 150)) await writeFile(join(directory, `vowel-${f0}hz-p${pitchCents}-f${formantCents}-${preserveFormants ? 'preserve' : 'follow'}.wav`), wav([output], rate))
  }
}
report.regressionChecks = { bypass: [], stereo: [], boundaries: [] }
const invariantRate = 48000, invariantInput = vowel(invariantRate, 150), invariantHash = hash(invariantInput)
const invariantNote = { id: 'note', start: 0.1, end: 1.9, midi: 69 + 12 * Math.log2(150 / 440), confidence: 1 }
for (const preserveFormants of [false, true]) {
  const [output] = await renderPitch([invariantInput], invariantRate, [invariantNote], { note: 0 }, undefined, { preserveFormants, formantShifts: { note: 0 } })
  report.regressionChecks.bypass.push({ preserveFormants, exact: hash(output) === invariantHash, independentBuffer: output !== invariantInput })
}
for (const scenario of [{ pitchCents: 300, formantCents: 0 }, { pitchCents: 0, formantCents: 300 }]) {
  const right = invariantInput.map(value => -0.5 * value)
  const outputs = await renderPitch([invariantInput, right], invariantRate, [invariantNote], { note: scenario.pitchCents }, undefined, { preserveFormants: true, formantShifts: { note: scenario.formantCents } })
  const from = Math.round(0.6 * invariantRate), end = Math.round(1.4 * invariantRate)
  let residual = 0, energy = 0
  for (let i = from; i < end; i += 1) { residual += (outputs[1][i] + outputs[0][i] * 0.5) ** 2; energy += outputs[0][i] ** 2 }
  report.regressionChecks.stereo.push({ ...scenario, channels: outputs.length, exactLengths: outputs.every(channel => channel.length === invariantInput.length), finite: outputs.every(channel => channel.every(Number.isFinite)), antiphaseResidualRatio: Math.sqrt(residual / energy), inputUnchanged: hash(invariantInput) === invariantHash, outsideUnchanged: unchangedOutside(invariantInput, outputs[0], invariantRate, [invariantNote]) && unchangedOutside(right, outputs[1], invariantRate, [invariantNote]) })
}
for (const rate of [8000, 48000, 96000, 192000]) {
  const input = vowel(rate, 150), savedHash = hash(input)
  const segments = [
    { ...invariantNote, id: 'first', start: 0, end: 1 },
    { ...invariantNote, id: 'second', start: 1, end: 2 + 1 / 8000 },
  ]
  const [output] = await renderPitch([input], rate, segments, { first: 300, second: -300 }, undefined, { preserveFormants: true, formantShifts: { first: -200, second: 200 } })
  const fragment = { ...invariantNote, id: 'fragment', start: 0.25, end: 0.25 + 0.4 / rate }
  const [fragmentOutput] = await renderPitch([input], rate, [fragment], {}, undefined, { preserveFormants: true, formantShifts: { fragment: 1200 } })
  report.regressionChecks.boundaries.push({ sampleRate: rate, frames: input.length, outputFrames: output.length, finite: output.every(Number.isFinite), inputUnchanged: hash(input) === savedHash, startExact: Object.is(output[0], input[0]), endExact: Object.is(output.at(-1), input.at(-1)), adjacentBoundaryExact: Object.is(output[rate - 1], input[rate - 1]) && Object.is(output[rate], input[rate]), subframeBypassExact: hash(fragmentOutput) === savedHash })
}
const rendered = report.measurements.filter(row => !row.sourceReference)
report.summary = {
  renderedCases: rendered.length,
  rejectedRequests: report.rejectedRequests.length,
  maxAbsoluteWeakFundamentalErrorCents: Math.max(...rendered.map(row => Math.abs(row.f0ErrorCents ?? Infinity))),
  maxAbsoluteStrongestHarmonicF0ErrorCents: Math.max(...rendered.map(row => Math.abs(row.strongestHarmonicF0ErrorCents ?? Infinity))),
  maxAbsoluteEnvelopeFitErrorCents: Math.max(...rendered.map(row => Math.abs(row.envelope.errorCents))),
  maxEnvelopeTargetRmseDb: Math.max(...rendered.map(row => row.envelope.targetRmseDb)),
  maxPeak: Math.max(...rendered.map(row => row.peak)), maxRmsGainDb: Math.max(...rendered.map(row => row.rmsGainDb)),
  casesWithQualityFlags: rendered.filter(row => row.qualityFlags.length).length,
  qualityFlagsAreObservationsNotSafetyPass: true,
  pcmIntegrityPass: rendered.every(row => row.finite && row.inputUnchanged && row.outsideUnchanged && row.sourceFrames === row.outputFrames),
  weakFundamentalCheckPass: rendered.every(row => row.f0ErrorCents !== null && Math.abs(row.f0ErrorCents) <= 0.2),
  strongestHarmonicPitchCheckPass: rendered.every(row => row.strongestHarmonicF0ErrorCents !== null && Math.abs(row.strongestHarmonicF0ErrorCents) <= 0.2),
  bypassPass: report.regressionChecks.bypass.every(row => row.exact && row.independentBuffer),
  stereoPass: report.regressionChecks.stereo.every(row => row.channels === 2 && row.exactLengths && row.finite && row.antiphaseResidualRatio < 0.001 && row.inputUnchanged && row.outsideUnchanged),
  boundaryPass: report.regressionChecks.boundaries.every(row => row.frames === row.outputFrames && row.finite && row.inputUnchanged && row.startExact && row.endExact && row.adjacentBoundaryExact && row.subframeBypassExact),
  unsupportedCombinationRejectionPass: report.rejectedRequests.every(row => row.rejected && row.inputUnchanged && row.message?.includes('보정 차이')),
}
if (directory) await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
if (metricsFlag >= 0) {
  const destination = process.argv[metricsFlag + 1]
  if (!destination) throw new Error('--metrics requires a JSON file path')
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify(report, null, 2))
if (!report.summary.pcmIntegrityPass || !report.summary.strongestHarmonicPitchCheckPass || !report.summary.bypassPass || !report.summary.stereoPass || !report.summary.boundaryPass || !report.summary.unsupportedCombinationRejectionPass) process.exitCode = 1

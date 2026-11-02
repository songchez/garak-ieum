// Node 24+. Reuses the exact app DSP modules and the pinned WASM binary.
import { registerHooks } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
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
const { analyzePitch } = await import('../../src/devices/pitch-editor/analysis.ts')
const { renderPitch, PITCH_RENDERER_ID } = await import('../../src/devices/pitch-editor/render.ts')
const { default: createSignalsmith } = await import('../../src/devices/pitch-editor/vendor/signalsmith-core.mjs')

function tone(hz, rate, seconds) {
  return Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => 0.4 * Math.sin(2 * Math.PI * hz * i / rate))
}
function frequency(samples, rate, start, end) {
  const crossings = []
  for (let i = Math.ceil(start * rate); i < Math.floor(end * rate); i += 1) {
    if (samples[i - 1] < 0 && samples[i] >= 0) crossings.push(i - samples[i] / (samples[i] - samples[i - 1]))
  }
  return (crossings.length - 1) * rate / (crossings.at(-1) - crossings[0])
}
const hash = channel => createHash('sha256').update(new Uint8Array(channel.buffer, channel.byteOffset, channel.byteLength)).digest('hex')
const note = { id: 'tone', start: 0.1, end: 3.9, midi: 57, confidence: 1 }
const rate = 48000, input = tone(220, rate, 4)
const analysisAt = performance.now()
const analysis = analyzePitch([input], rate)
const analysisMs = performance.now() - analysisAt
const middle = analysis.contour.filter(p => p.time > 0.2 && p.time < 3.8).map(p => p.midi).sort((a, b) => a - b)
const inputHash = hash(input)
const renders = [], outputs = []
for (const cents of [-1200, -50, -20, 0, 20, 50, 700, 1200]) {
  const began = performance.now()
  const [output] = await renderPitch([input], rate, [note], { tone: cents })
  const milliseconds = performance.now() - began
  const measuredHz = frequency(output, rate, 1, 3)
  const expectedHz = 220 * 2 ** (cents / 1200)
  const outsideUnchanged = input.subarray(0, 4800).every((value, i) => Object.is(value, output[i])) && input.subarray(187200).every((value, i) => Object.is(value, output[187200 + i]))
  renders.push({ cents, expectedHz, measuredHz, absoluteErrorCents: Math.abs(1200 * Math.log2(measuredHz / expectedHz)), frames: output.length, inputUnchanged: hash(input) === inputHash, outsideUnchanged, bitExactBypass: cents === 0 ? hash(output) === inputHash : null, milliseconds, outputSha256: hash(output) })
  outputs.push({ cents, output })
}
const report = {
  runtime: process.version, platform: `${process.platform}/${process.arch}`,
  renderer: PITCH_RENDERER_ID, sampleRate: rate, sourceFrames: input.length,
  source: 'Generated 220 Hz sine, 0.4 linear amplitude, 4 seconds; edit from 0.1 to 3.9 seconds; stable measurement window 1 to 3 seconds.',
  analysis: { notes: analysis.notes.length, contourPoints: analysis.contour.length, centerMidi: middle[Math.floor(middle.length / 2)], absoluteErrorCents: Math.abs(middle[Math.floor(middle.length / 2)] - 57) * 100, milliseconds: analysisMs },
  renders,
  limits: ['Synthetic PCM measurement, not listening evaluation.', 'No real-browser/UI or hardware test.', 'No polyphonic note separation, time warping, or advanced vocal controls.', 'This script uses legacy/default settings: formants move with pitch. Optional approximate envelope controls are measured in formants.mjs.', 'These synthetic steady-tone errors are not a universal accuracy guarantee for voices or transients.'],
}

// Preserve the rejected direct-transpose path as a reproducible comparison.
// It uses the same binary/input/region/context as the app's former adapter.
async function legacyDirectTranspose(cents) {
  const module = await createSignalsmith()
  module._presetDefault(1, rate)
  module._setTransposeSemitones(cents / 100, 8000 / rate)
  module._setFormantSemitones(0, true)
  module._setFormantBase(220 / rate)
  const block = 512, latency = module._inputLatency() + module._outputLatency()
  const base = module._setBuffers(1, block) / 4
  const result = new Float32Array(input.length)
  for (let position = 0; position < input.length + latency; position += block) {
    const count = Math.min(block, input.length + latency - position)
    let heap = new Float32Array(module.HEAP8.buffer)
    heap.fill(0, base, base + block)
    if (position < input.length) heap.set(input.subarray(position, Math.min(input.length, position + count)), base)
    module._process(count, count)
    heap = new Float32Array(module.HEAP8.buffer)
    const from = Math.max(0, latency - position)
    for (let i = from; i < count; i += 1) result[position + i - latency] = heap[base + block + i]
  }
  return result
}

// An independent Hann-window DFT peak check distinguishes estimator/bin error
// from actual DSP output error. The peak fit is finer than the search grid.
function hannFrequency(samples, rate, start, end, expectedHz) {
  const from = Math.round(start * rate), frames = Math.round((end - start) * rate)
  const weighted = Float64Array.from({ length: frames }, (_, i) => samples[from + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (frames - 1))))
  const step = 0.125, halfSteps = 32, logPower = []
  for (let bin = -halfSteps; bin <= halfSteps; bin += 1) {
    const angle = 2 * Math.PI * (expectedHz + bin * step) / rate
    const realStep = Math.cos(angle), imaginaryStep = Math.sin(angle)
    let phaseReal = 1, phaseImaginary = 0, real = 0, imaginary = 0
    for (let i = 0; i < frames; i += 1) {
      real += weighted[i] * phaseReal; imaginary += weighted[i] * phaseImaginary
      const nextReal = phaseReal * realStep - phaseImaginary * imaginaryStep
      phaseImaginary = phaseReal * imaginaryStep + phaseImaginary * realStep
      phaseReal = nextReal
    }
    logPower.push(Math.log(Math.max(1e-30, real * real + imaginary * imaginary)))
  }
  let peak = 0
  for (let i = 1; i < logPower.length; i += 1) if (logPower[i] > logPower[peak]) peak = i
  if (!peak || peak === logPower.length - 1) throw new Error('Frequency peak outside comparison search window')
  const a = logPower[peak - 1], b = logPower[peak], c = logPower[peak + 1]
  const offset = 0.5 * (a - c) / (a - 2 * b + c)
  return expectedHz + (peak - halfSteps + offset) * step
}
report.precisionComparison = {
  conditions: 'Same 4 s / 48 kHz / 220 Hz / 0.4 amplitude input; measure central 1–3 s; default 120 ms FFT block; legacy formant compensation enabled.',
  methods: ['Interpolated positive zero crossings over 2 s.', 'Hann-window DFT: ±4 Hz search around target, 0.125 Hz grid, parabolic log-power interpolation.'],
  legacyRenderer: 'signalsmith-88061fd4-note-window-v1',
  finalRenderer: PITCH_RENDERER_ID,
  measurements: [],
}
for (const cents of [-1200, -50, -20, 20, 50, 1200]) {
  const legacy = await legacyDirectTranspose(cents)
  const final = outputs.find(output => output.cents === cents).output
  const expectedHz = 220 * 2 ** (cents / 1200)
  const legacyHz = frequency(legacy, rate, 1, 3), finalHz = frequency(final, rate, 1, 3)
  const legacyHannHz = hannFrequency(legacy, rate, 1, 3, expectedHz)
  const finalHannHz = hannFrequency(final, rate, 1, 3, expectedHz)
  report.precisionComparison.measurements.push({ cents, expectedHz, legacyHz, legacyErrorCents: 1200 * Math.log2(legacyHz / expectedHz), legacyHannHz, finalHz, finalErrorCents: 1200 * Math.log2(finalHz / expectedHz), finalHannHz, finalHannErrorCents: 1200 * Math.log2(finalHannHz / expectedHz) })
}

// A short musical fixture runs the actual analysis -> detected segments -> render
// path, instead of handing the renderer only manually known sine boundaries.
const motif = new Float32Array(Math.round(rate * 4.8))
const motifNotes = [
  { start: 0.15, end: 1.1, midi: 57 },
  { start: 1.3, end: 2.25, midi: 60 },
  { start: 2.45, end: 3.4, midi: 64 },
  { start: 3.6, end: 4.55, midi: 57 },
]
for (const expected of motifNotes) {
  let phase = 0
  for (let i = Math.ceil(expected.start * rate); i < Math.floor(expected.end * rate); i += 1) {
    const local = i / rate - expected.start
    const vibrato = 0.15 * Math.sin(2 * Math.PI * 5 * local)
    const hz = 440 * 2 ** ((expected.midi + vibrato - 69) / 12)
    phase += 2 * Math.PI * hz / rate
    const envelope = Math.min(1, local / 0.02, (expected.end - i / rate) / 0.03)
    motif[i] = Math.max(0, envelope) * (0.34 * Math.sin(phase) + 0.09 * Math.sin(2 * phase) + 0.035 * Math.sin(3 * phase))
  }
}
const motifSourceHash = hash(motif)
const motifAnalysis = analyzePitch([motif], rate)
const motifShifts = Object.fromEntries(motifAnalysis.notes.map((n, index) => [n.id, index === 1 ? 200 : index === 3 ? -100 : 0]))
const [motifEdited] = await renderPitch([motif], rate, motifAnalysis.notes, motifShifts)
const motifAfter = analyzePitch([motifEdited], rate)
const medianPitch = (analysis, start, end) => {
  const values = analysis.contour.filter(p => p.time >= start && p.time <= end).map(p => p.midi).sort((a, b) => a - b)
  return values[Math.floor(values.length / 2)]
}
const motifMeasurements = motifNotes.map((n, index) => {
  const beforeMidi = medianPitch(motifAnalysis, n.start + 0.2, n.end - 0.2)
  const afterMidi = medianPitch(motifAfter, n.start + 0.2, n.end - 0.2)
  const expectedCents = index === 1 ? 200 : index === 3 ? -100 : 0
  return { expectedSourceMidi: n.midi, beforeMidi, afterMidi, expectedCents, measuredCents: (afterMidi - beforeMidi) * 100, absoluteErrorCents: Math.abs((afterMidi - beforeMidi) * 100 - expectedCents) }
})
const editedSpans = motifAnalysis.notes.filter(n => motifShifts[n.id] !== 0).map(n => [Math.round(n.start * rate), Math.round(n.end * rate)])
let motifOutsideUnchanged = true
for (let i = 0; i < motif.length; i += 1) {
  if (!editedSpans.some(([start, end]) => i >= start && i < end) && !Object.is(motif[i], motifEdited[i])) motifOutsideUnchanged = false
}
report.motif = {
  description: '4.8 s generated harmonic motif MIDI 57-60-64-57, ±15-cent 5 Hz vibrato; detected second note +200 cents, fourth note -100 cents.',
  expectedNotes: 4, detectedNotes: motifAnalysis.notes.length, frames: motif.length, outputFrames: motifEdited.length,
  inputUnchanged: hash(motif) === motifSourceHash, outsideUnchanged: motifOutsideUnchanged, sourceSha256: hash(motif), outputSha256: hash(motifEdited), measurements: motifMeasurements,
}
report.rangeBoundaryAnalysis = [55, 1600].map(hz => {
  const result = analyzePitch([tone(hz, rate, 0.5)], rate)
  const midi = medianPitch(result, 0.1, 0.4)
  return { expectedHz: hz, measuredHz: 440 * 2 ** ((midi - 69) / 12), absoluteErrorCents: Math.abs(midi - (69 + 12 * Math.log2(hz / 440))) * 100, notes: result.notes.length }
})
// PCM float WAV files preserve the actual output values for independent review.
function wav(channel) {
  const buffer = Buffer.alloc(44 + channel.length * 4)
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(3, 20); buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 4, 28); buffer.writeUInt16LE(4, 32); buffer.writeUInt16LE(32, 34)
  buffer.write('data', 36); buffer.writeUInt32LE(channel.length * 4, 40)
  for (let i = 0; i < channel.length; i += 1) buffer.writeFloatLE(channel[i], 44 + i * 4)
  return buffer
}
const flag = process.argv.indexOf('--out')
if (flag !== -1) {
  const directory = process.argv[flag + 1]
  if (!directory) throw new Error('--out requires a directory')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  await writeFile(join(directory, 'source-220hz.wav'), wav(input))
  for (const { cents, output } of outputs) await writeFile(join(directory, `shift-${cents}-cents.wav`), wav(output))
  await writeFile(join(directory, 'motif-original.wav'), wav(motif))
  await writeFile(join(directory, 'motif-edited.wav'), wav(motifEdited))
  await writeFile(join(directory, 'metrics.json'), JSON.stringify(report, null, 2) + '\n')
}
const assetsFlag = process.argv.indexOf('--assets')
if (assetsFlag !== -1) {
  const directory = process.argv[assetsFlag + 1]
  if (!directory) throw new Error('--assets requires a directory')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'pitch-editor-original.wav'), wav(motif))
  await writeFile(join(directory, 'pitch-editor-edited.wav'), wav(motifEdited))
  await writeFile(join(directory, 'pitch-editor-metrics.json'), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify(report, null, 2))
if (renders.some(row => row.frames !== input.length || !row.inputUnchanged || !row.outsideUnchanged || row.absoluteErrorCents > 0.1) || !renders.find(row => row.cents === 0)?.bitExactBypass) process.exitCode = 1
if (motifAnalysis.notes.length !== 4 || motifEdited.length !== motif.length || hash(motif) !== motifSourceHash || !motifOutsideUnchanged || motifMeasurements.some(row => !Number.isFinite(row.absoluteErrorCents) || row.absoluteErrorCents > 5)) process.exitCode = 1

if (report.precisionComparison.measurements.some(row => Math.abs(row.finalErrorCents) > 0.1 || Math.abs(row.finalHannErrorCents) > 0.1)) process.exitCode = 1

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NativeAudioService } from '../dist-desktop/native-audio.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const flag = name => args.includes(name)
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
const executable = path.resolve(option('--executable') ?? path.join(root, 'build/native-audio', process.platform === 'win32' ? 'garak-audio-host.exe' : 'garak-audio-host'))
const pluginPath = option('--plugin') ?? process.env.GARAK_TEST_VST3
const temporary = await mkdtemp(path.join(tmpdir(), 'garak-native-smoke-'))
const states = []
const service = new NativeAudioService({
  executable, profileDirectory: temporary, testClock: true,
  allowInput: async () => true, selectPlugin: async () => pluginPath ?? null,
  onState: state => states.push(state),
})
let checks = 0
async function checked(name, operation) { await operation(); checks++; console.log('PASS ' + name) }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const source = instrumentId => ({ kind: 'builtin-synth', instrumentId, isKit: instrumentId === 'drums', params: {} })
const track = (id, src = source('keys')) => ({
  id, source: src, gain: .7, pan: 0, enabled: true, mute: false, solo: false, soloSafe: false, audible: true, inserts: [],
  notes: src.kind === 'audio' ? [] : [{ id: 0, clipId: 'clip', occurrenceIndex: 0, onFrame: 1000, offFrame: 6000, limitFrame: 12000, pitch: 60, velocity: .7 }],
  audio: [],
})
const project = (tracks = [track('keys')], revision = 1) => ({
  version: 1, projectId: 'native-smoke', revision, sampleRate: 48000, bpm: 120, timeSignature: { numerator: 4, denominator: 4 }, beatsPerBar: 4,
  lengthFrames: 12000, cycle: null, masterGain: .8, assets: [], tracks,
})
function wav(data) {
  const buffer = Buffer.from(data)
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF')
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE')
  assert.equal(buffer.toString('ascii', 36, 40), 'data')
  const format = buffer.readUInt16LE(20), channels = buffer.readUInt16LE(22), rate = buffer.readUInt32LE(24), bits = buffer.readUInt16LE(34)
  const bytes = buffer.readUInt32LE(40), frames = bytes / channels / (bits / 8)
  assert.equal(buffer.length, 44 + bytes)
  const samples = new Float32Array(frames * channels)
  for (let i = 0; i < samples.length; i++) samples[i] = format === 3 ? buffer.readFloatLE(44 + i * 4) : buffer.readInt16LE(44 + i * 2) / 32768
  assert.ok(samples.every(Number.isFinite))
  return { format, channels, rate, frames, samples }
}
const peak = samples => samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)
const rms = samples => Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / Math.max(1, samples.length))
try {
  await checked('native command boundary rejects arbitrary methods and paths', async () => {
    await assert.rejects(service.request('system.exec', {}), /허용되지/)
    await assert.rejects(service.request('transport.play', { path: '/untrusted' }), /파일 경로/)
    await assert.rejects(service.request('note.preview', { source: { kind: 'vst3', plugin: { path: '/untrusted.vst3' } } }), /내장 악기/)
  })
  await checked('native output opens only the explicitly requested test clock', async () => {
    const state = await service.request('engine.configure', { backend: process.platform === 'darwin' ? 'coreaudio' : 'wasapi', sampleRate: 48000, bufferFrames: 128, inputChannels: 0 })
    assert.equal(state.sampleRate, 48000); assert.equal(state.bufferFrames, 128)
    assert.equal(state.backend, 'test'); assert.equal(state.testClock, true)
    await service.request('project.set', { timeline: project() })
    await service.request('transport.play')
    await delay(45)
    const state2 = await service.request('engine.snapshot')
    assert.equal(state2.playing, true); assert.ok(state2.frame > 0); assert.equal(state2.sampleRate, 48000)
    await service.request('transport.pause')
    const paused = (await service.request('engine.snapshot')).frame
    await delay(25)
    assert.equal((await service.request('engine.snapshot')).frame, paused)
  })
  await checked('offline native synthesis respects note onset and produces finite WAV', async () => {
    const result = await service.request('render.wav', { timeline: project() })
    const audio = wav(result.data)
    assert.equal(audio.rate, 48000); assert.equal(audio.channels, 2); assert.equal(audio.format, 1)
    assert.ok(audio.frames >= 12000)
    assert.equal(peak(audio.samples.subarray(0, 1000 * 2)), 0)
    assert.ok(peak(audio.samples.subarray(1000 * 2, 6000 * 2)) > .005)
    assert.ok(peak(audio.samples) <= 1)
  })
  const pcm = new Float32Array(12000)
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i * 2 * Math.PI * 220 / 48000) * .2
  await checked('one-time PCM transfer and native clip rendering preserve source samples', async () => {
    await service.request('asset.put', { id: 'pcm', sampleRate: 48000, channels: [pcm] })
    const audioTrack = track('audio', { kind: 'audio' })
    audioTrack.gain = 1
    audioTrack.audio = [{ id: 1, clipId: 'audio-clip', assetId: 'pcm', startFrame: 0, endFrame: 12000, sourceStartFrame: 0, sourceSampleRate: 48000, clipOffsetFrames: 0, clipLengthFrames: 12000, gain: 1, fadeInFrames: 0, fadeOutFrames: 0 }]
    const p = project([audioTrack]); p.masterGain = 1
    const output = wav((await service.request('render.wav', { timeline: p })).data)
    assert.ok(rms(output.samples.subarray(0, 12000 * 2)) > .05)
    assert.ok(output.samples.slice(0, 100).some(sample => sample !== 0))
    const malformed = new Float32Array([0, Number.NaN])
    await assert.rejects(service.request('asset.put', { id: 'bad', sampleRate: 48000, channels: [malformed] }), /유효하지/)
  })
  await checked('native guitar rig processes the same project during offline export', async () => {
    const t = track('guitar', { kind: 'audio' })
    t.audio = [{ id: 1, clipId: 'audio-clip', assetId: 'pcm', startFrame: 0, endFrame: 12000, sourceStartFrame: 0, sourceSampleRate: 48000, clipOffsetFrames: 0, clipLengthFrames: 12000, gain: 1, fadeInFrames: 0, fadeOutFrames: 0 }]
    const dry = wav((await service.request('render.wav', { timeline: project([t]) })).data)
    t.inserts = [{ id: 'rig', type: 'guitar-rig', enabled: true, params: {} }]
    const wet = wav((await service.request('render.wav', { timeline: project([t]) })).data)
    assert.ok(peak(wet.samples) > .001)
    assert.notEqual(rms(wet.samples.subarray(0, 20000)), rms(dry.samples.subarray(0, 20000)))
  })
  await checked('native seek and cycle advance on the audio clock', async () => {
    const p = project(); p.cycle = { startFrame: 1000, endFrame: 3000 }
    await service.request('project.set', { timeline: p })
    await service.request('transport.seek', { frame: 1000 }); await service.request('transport.play')
    await delay(130)
    const state = await service.request('engine.snapshot')
    assert.ok(state.frame >= 1000 && state.frame < 3000, 'cycle position must stay inside its frame range')
    await service.request('transport.stop')
  })
  await checked('native recording writes PCM with exact frame metadata and recovers its source', async () => {
    await service.request('engine.configure', { backend: process.platform === 'darwin' ? 'coreaudio' : 'wasapi', sampleRate: 48000, bufferFrames: 128, inputChannels: 2 })
    const p = project([track('record', { kind: 'audio' })]); p.lengthFrames = 48000
    await service.request('project.set', { timeline: p })
    await service.request('transport.play')
    const start = await service.request('record.start', { trackId: 'record' })
    assert.ok(Number.isInteger(start.startFrame))
    await delay(110)
    const take = await service.request('record.stop')
    const audio = wav(take.data)
    assert.equal(audio.format, 3); assert.equal(audio.rate, 48000)
    assert.equal(take.startFrame, start.startFrame); assert.equal(audio.frames, take.frames)
    assert.ok(audio.frames >= 512)
    assert.equal(take.error, undefined)
    assert.ok(take.takeId)
    const sourceFile = path.join(temporary, 'native-audio', 'recovery', take.takeId + '.wav')
    assert.deepEqual(await readFile(sourceFile), Buffer.from(take.data))
    await service.request('record.commit', { takeId: take.takeId })
    await assert.rejects(readFile(sourceFile), /ENOENT/)
    await service.request('transport.stop')
  })
  await checked('unknown and missing processors fail before silent substitution', async () => {
    const p = project()
    p.tracks[0].source.instrumentId = 'not-an-instrument'
    await assert.rejects(service.request('project.set', { timeline: p }), /Unknown|unknown|Unsupported|unsupported/)
    const missing = project()
    missing.tracks[0].source = { kind: 'vst3', plugin: { id: 'untrusted', pluginId: 'unapproved', classId: '00000000000000000000000000000000', name: 'untrusted', enabled: true, parameters: {}, path: '/arbitrary/library.vst3' } }
    await assert.rejects(service.request('project.set', { timeline: missing }), /승인된 VST3/)
  })
  if (pluginPath) {
    await checked('real VST3 SDK scanner, processor, normalized parameters and state round-trip', async () => {
      const entries = await service.request('plugins.scan')
      assert.ok(entries.length)
      assert.ok(entries.every(entry => !('path' in entry)))
      const effect = entries.find(entry => !entry.isInstrument)
      assert.ok(effect, 'fixture must provide an effect')
      const t = track('vst-audio', { kind: 'audio' })
      t.audio = [{ id: 1, clipId: 'audio-clip', assetId: 'pcm', startFrame: 0, endFrame: 12000, sourceStartFrame: 0, sourceSampleRate: 48000, clipOffsetFrames: 0, clipLengthFrames: 12000, gain: 1, fadeInFrames: 0, fadeOutFrames: 0 }]
      const p = project([t])
      t.inserts = [{ id: 'fixture', type: 'vst3', enabled: true, plugin: { ...effect, id: 'fixture', enabled: true, parameters: {} } }]
      await service.request('project.set', { timeline: p })
      const parameters = await service.request('plugins.parameters', { instanceId: 'fixture' })
      const gain = parameters.find(parameter => !parameter.readOnly)
      assert.ok(gain, 'fixture must expose an editable normalized parameter')
      await service.request('plugins.parameter', { instanceId: 'fixture', id: gain.id, value: .25 })
      await delay(20)
      const saved = await service.request('plugins.state', { instanceId: 'fixture' })
      assert.equal(typeof saved.component, 'string')
      t.inserts[0].plugin.parameters[gain.id] = .25
      t.inserts[0].plugin.state = saved
      const rendered = wav((await service.request('render.wav', { timeline: p })).data)
      assert.ok(peak(rendered.samples) > 0)
      await service.request('project.set', { timeline: p })
      const restored = await service.request('plugins.parameters', { instanceId: 'fixture' })
      assert.ok(Math.abs(restored.find(parameter => parameter.id === gain.id).value - .25) < 1e-5)
      t.inserts[0].enabled = false
      await service.request('project.set', { timeline: p })
      assert.equal(typeof (await service.request('plugins.state', { instanceId: 'fixture', allowUnloaded: true })).component, 'string', 'bypass retains the loaded editor state')
      const unavailable = { ...t.inserts[0], id: 'disabled-missing', plugin: { ...t.inserts[0].plugin, id: 'disabled-missing', pluginId: 'not-installed' } }
      t.inserts = [unavailable]
      await service.request('project.set', { timeline: p })
      assert.equal(await service.request('plugins.state', { instanceId: 'disabled-missing', allowUnloaded: true }), null)
      await assert.rejects(service.request('plugins.state', { instanceId: 'not-in-project', allowUnloaded: true }), /not loaded/)

      const instrument = entries.find(entry => entry.isInstrument)
      assert.ok(instrument, 'fixture must provide a real VST3 instrument')
      const instrumentTrack = track('vst-instrument', { kind: 'vst3', plugin: { ...instrument, id: 'instrument', enabled: true, parameters: { '0': .5 } } })
      const renderedInstrument = wav((await service.request('render.wav', { timeline: project([instrumentTrack]) })).data)
      assert.equal(peak(renderedInstrument.samples.subarray(0, 1000 * 2)), 0)
      assert.ok(peak(renderedInstrument.samples.subarray(1000 * 2, 6000 * 2)) > .01)
    })
  } else if (!flag('--core-only')) throw new Error('A built VST3 fixture is required. Pass --plugin PATH or explicitly use --core-only for the offline core build.')
  await checked('native snapshots and clean engine shutdown', async () => {
    assert.ok(states.some(state => state.type === 'state' && typeof state.frame === 'number'))
    await service.request('engine.close')
    await service.dispose()
  })
  await checked('production process rejects an unavailable backend and exits on stdin EOF', async () => {
    const child = spawn(executable, ['--protocol'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let output = '', diagnostics = ''
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { diagnostics += value })
    child.stdin.end(JSON.stringify({ id: 0, method: 'hello' }) + '\n' + JSON.stringify({ id: 1, method: 'engine.configure', params: { backend: 'not-a-backend', sampleRate: 48000, bufferFrames: 128, inputChannels: 0 } }) + '\n')
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Native EOF shutdown timed out')) }, 5000)
      child.on('error', error => { clearTimeout(timer); reject(error) }); child.on('exit', code => { clearTimeout(timer); resolve(code) })
    })
    assert.equal(code, 0, diagnostics)
    const [hello, response] = output.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(hello.result.testClock, false)
    if (!flag('--core-only')) {
      assert.equal(hello.result.vst3, true, 'the distribution must contain the real VST3 host')
      if (process.platform === 'win32') { assert.ok(hello.result.backends.includes('asio')); assert.ok(hello.result.backends.includes('wasapi')) }
      if (process.platform === 'darwin') assert.ok(hello.result.backends.includes('coreaudio'))
    }
    assert.equal(response.id, 1); assert.equal(response.ok, false)
    assert.match(response.error.message, /unavailable|not available|Unknown|Unsupported/)
  })
  console.log('Native smoke: ' + checks + ' checks passed. The test clock does not validate physical ASIO/Core Audio latency.')
} finally {
  await service.dispose()
  await rm(temporary, { recursive: true, force: true })
}

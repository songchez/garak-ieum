import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
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
async function within(promise, description, timeout = 5000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(description + ' timed out')), timeout) })]) }
  finally { clearTimeout(timer) }
}
/** Test-only CLI commands never pass through the renderer's method allowlist. */
async function withTestHost(operation) {
  const child = spawn(executable, ['--protocol', '--test-clock'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let diagnostics = '', id = 0
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', value => { diagnostics = (diagnostics + value).slice(-8192) })
  child.on('error', error => { diagnostics += error.message })
  child.stdin.on('error', error => { diagnostics += error.message })
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  const output = createInterface({ input: child.stdout })
  const lines = output[Symbol.asyncIterator]()
  const request = async (method, params = {}) => {
    const requestId = ++id
    child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n')
    const line = await within(lines.next(), 'Native test request ' + method)
    assert.equal(line.done, false, 'Native test process closed: ' + diagnostics)
    const response = JSON.parse(line.value)
    assert.equal(response.id, requestId)
    if (!response.ok) throw new Error(response.error?.message ?? 'Native test request failed')
    return response.result
  }
  try { await operation(request) }
  finally {
    child.stdin.end()
    try {
      const result = await within(exited, 'Native test shutdown')
      assert.equal(result.code, 0, diagnostics || String(result.signal))
    } finally { if (child.exitCode === null) child.kill(); output.close() }
  }
}
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
async function waveFixtures() {
  // Exercise the production UI encoder, including schema validation/custom banks.
  const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
    optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null } })
  try {
    const { createDefaultWavetablePatch, getFactoryWavetableFrames } = await server.ssrLoadModule('/src/devices/wavetable-synth/model.ts')
    const { encodeWavetablePatch } = await server.ssrLoadModule('/src/devices/wavetable-synth/bridge.ts')
    const { WAVE_SCHEMA_FINGERPRINT } = await server.ssrLoadModule('/src/devices/wavetable-synth/schema.generated.ts')
    const patch = createDefaultWavetablePatch()
    Object.assign(patch.params, { env1Attack: .001, env1Release: .005, env1Sustain: .8, delayMix: 0, chorusMix: 0 })
    const encode = value => ({ kind: 'native-wavetable', instrumentId: 'wavetable', isKit: false,
      patchData: Buffer.from(encodeWavetablePatch(value)).toString('base64') })
    const basic = encode(patch)
    const quiet = encode({ ...patch, params: { ...patch.params, level: 0 } })
    patch.customBanks = [{ slot: 4, name: 'Native IPC fixture', frames: getFactoryWavetableFrames(2).slice(0, 3) }]
    Object.assign(patch.params, { osc1Bank: 4, osc1Position: .4 })
    return { basic, quiet, custom: encode(patch), fingerprint: WAVE_SCHEMA_FINGERPRINT }
  } finally { await server.close() }
}
async function waitForNativeState(description, predicate, timeout = 5000) {
  const deadline = Date.now() + timeout
  do {
    const state = await service.request('engine.snapshot')
    if (predicate(state)) return state
    await delay(15)
  } while (Date.now() < deadline)
  assert.fail(description + ' did not become true')
}
try {
  await checked('native command boundary rejects arbitrary methods and paths', async () => {
    await assert.rejects(service.request('system.exec', {}), /허용되지/)
    await assert.rejects(service.request('test.input', { active: true }), /허용되지/)
    await assert.rejects(service.request('test.fault', {}), /허용되지/)
    await assert.rejects(service.request('transport.play', { path: '/untrusted' }), /파일 경로/)
    await assert.rejects(service.request('note.preview', { source: { kind: 'vst3', plugin: { path: '/untrusted.vst3' } } }), /내장 악기/)
  })
  const wave = await waveFixtures()
  await checked('WAVE capability handshake does not open an audio device', async () => {
    const capabilities = await service.request('engine.capabilities')
    assert.equal(capabilities.protocol, 1)
    assert.equal(capabilities.wavetable.protocolVersion, 1)
    assert.equal(capabilities.wavetable.schemaFingerprint, wave.fingerprint)
    assert.equal(capabilities.wavetable.minimumSampleRate, 22050)
    assert.equal(capabilities.wavetable.maximumSampleRate, 192000)
    assert.equal((await service.request('engine.snapshot')).ready, false)
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
  await checked('native WAVE timeline and custom banks render finite stereo at 44.1/48/96 kHz', async () => {
    for (const sampleRate of [44100, 48000, 96000]) {
      const rendered = []
      for (const patch of [wave.basic, wave.custom]) {
        const timeline = project([track('wave', patch)])
        timeline.sampleRate = sampleRate
        const audio = wav((await service.request('render.wav', { timeline })).data)
        assert.equal(audio.rate, sampleRate); assert.equal(audio.channels, 2)
        assert.equal(peak(audio.samples.subarray(0, 1000 * 2)), 0, 'WAVE must respect sample-accurate note onset')
        assert.ok(peak(audio.samples.subarray(1000 * 2, 6000 * 2)) > .005, 'WAVE output must contain the synthesized note')
        assert.ok(peak(audio.samples) <= 1)
        rendered.push(audio.samples)
      }
      assert.ok(rendered[0].some((sample, index) => Math.abs(sample - rendered[1][index]) > .001), 'custom bank data must reach the native oscillator')
    }
  })
  await checked('native WAVE rejects missing, corrupt and incompatible patches before project mutation', async () => {
    const corrupted = Buffer.from(wave.basic.patchData, 'base64')
    corrupted.writeUInt32LE((wave.fingerprint ^ 1) >>> 0, 12)
    const { patchData: _missing, ...missingPatch } = wave.basic
    for (const bad of [missingPatch, { ...wave.basic, patchData: '%%%invalid%%%' }, { ...wave.basic, patchData: corrupted.toString('base64') }]) {
      await assert.rejects(service.request('project.set', { timeline: project([track('wave', bad)]) }), /patch|wave|binary|base64|fingerprint|schema|key/i)
    }
    const result = await service.request('project.set', { timeline: project([track('wave', wave.basic)], 100), awaitApplied: true })
    assert.equal(result.revision, 100)
    assert.equal((await service.request('engine.snapshot')).revision, 100, 'patch ack must follow callback application')
  })
  await checked('stopped WAVE audition releases only its track and applies held-voice patches', async () => {
    await service.request('transport.stop')
    const first = track('wave-a', wave.basic), second = track('wave-b', wave.basic)
    first.notes = []; second.notes = []
    await service.request('project.set', { timeline: project([first, second], 101), awaitApplied: true })
    await service.request('note.on', { trackId: first.id, pitch: 60, velocity: .8, noteId: 10001 })
    await service.request('note.on', { trackId: second.id, pitch: 67, velocity: .8, noteId: 10002 })
    const audible = await waitForNativeState('both stopped WAVE auditions', state => state.levels['wave-a'] > .005 && state.levels['wave-b'] > .005)
    assert.equal(audible.playing, false)
    await service.request('note.allOff', { trackId: first.id })
    await waitForNativeState('track-local WAVE all-notes-off', state => state.levels['wave-a'] < .0001 && state.levels['wave-b'] > .005)
    second.source = wave.quiet
    await service.request('project.set', { timeline: project([first, second], 102), awaitApplied: true })
    await waitForNativeState('held WAVE voice gain update', state => state.levels['wave-b'] < .0001)
    second.source = wave.basic
    await service.request('project.set', { timeline: project([first, second], 103), awaitApplied: true })
    await waitForNativeState('held WAVE voice survives patch updates', state => state.levels['wave-b'] > .005)
    await service.request('note.off', { trackId: second.id, pitch: 67, noteId: 10002 })
    await waitForNativeState('WAVE note release', state => state.masterLevel < .0001)
  })
  await checked('WAVE remains usable after output sample-rate reconfiguration', async () => {
    for (const sampleRate of [44100, 48000]) {
      const configured = await service.request('engine.configure', { backend: process.platform === 'darwin' ? 'coreaudio' : 'wasapi', sampleRate, bufferFrames: 128, inputChannels: 0 })
      assert.equal(configured.backend, 'test', 'this check is the explicit test clock, not a physical WASAPI endpoint')
      const waveTrack = track('wave-reconnected', wave.custom); waveTrack.notes = []
      const timeline = project([waveTrack], 104 + sampleRate); timeline.sampleRate = sampleRate
      await service.request('project.set', { timeline, awaitApplied: true })
      await service.request('note.on', { trackId: waveTrack.id, pitch: 64, velocity: .8, noteId: 10003 })
      const audible = await waitForNativeState('reconfigured WAVE output', state => state.levels[waveTrack.id] > .005)
      assert.equal(audible.sampleRate, sampleRate)
      await service.request('note.allOff', { trackId: waveTrack.id })
    }
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
  await checked('nonzero native capture survives device failure and clears faults on reconnect or close', async () => {
    await withTestHost(async request => {
      assert.equal((await request('hello')).testClock, true)
      const config = { backend: 'test', sampleRate: 48000, bufferFrames: 128, inputChannels: 1 }
      await request('engine.configure', config)
      const p = project([track('capture', { kind: 'audio' })]); p.lengthFrames = 48000 * 30
      await request('project.set', { timeline: p })
      await request('test.input', { active: true })
      await request('transport.seek', { frame: 4096 })
      for (const recovery of ['reconnect', 'close']) {
        await request('transport.play')
        const filename = path.join(temporary, 'partial-' + recovery + '.wav')
        const start = await request('record.start', { trackId: 'capture', path: filename })
        assert.ok(Number.isInteger(start.rawStartFrame) && start.rawStartFrame >= 4096)
        assert.equal(start.startFrame, start.rawStartFrame - start.compensationFrames)
        assert.equal(start.compensationKnown, false, 'the synthetic clock must not claim hardware latency measurements')
        const deadline = Date.now() + 5000
        let capturing
        do {
          await delay(10)
          capturing = await request('engine.snapshot')
          assert.equal(capturing.recording, true)
          assert.ok(Date.now() < deadline, 'Native recording did not advance')
        } while (capturing.recordedFrames < 1024)
        const failed = await request('test.fault')
        assert.equal(failed.ready, false); assert.equal(failed.playing, false)
        assert.equal(failed.device.running, false); assert.equal(failed.device.needsReconfigure, true)
        assert.match(failed.error, /Injected test device failure/)
        await assert.rejects(request('engine.configure', config), /Stop recording/)
        const stopped = await request('record.stop')
        assert.match(stopped.error, /복구/)
        assert.equal(stopped.path, filename)
        assert.equal(stopped.rawStartFrame, start.rawStartFrame)
        assert.equal(stopped.startFrame, start.startFrame)
        assert.equal(stopped.compensationFrames, start.compensationFrames)
        assert.equal(stopped.compensationKnown, false)
        assert.equal(stopped.frames, failed.recordedFrames, 'stopping a failed device must not append synthetic input frames')
        assert.equal(stopped.frames, failed.frame - stopped.rawStartFrame, 'recorded PCM must use the native timeline frame clock')
        const audio = wav(await readFile(filename))
        assert.equal(audio.format, 3); assert.equal(audio.channels, 1); assert.equal(audio.rate, 48000)
        assert.equal(audio.frames, stopped.frames)
        assert.ok(peak(audio.samples) > .1 && peak(audio.samples) <= .151, 'the partial take must retain the actual nonzero input')
        assert.ok(rms(audio.samples) > .05, 'a zero-filled recovery file is not a successful recording')
        const finalized = await request('engine.snapshot')
        assert.equal(finalized.recording, false); assert.equal(finalized.frame, failed.frame)
        assert.equal(finalized.recordedFrames, stopped.frames); assert.equal(finalized.recordingDroppedFrames, 0)
        if (recovery === 'reconnect') {
          const configured = await request('engine.configure', config)
          assert.equal(configured.running, true)
          const recovered = await request('engine.snapshot')
          assert.equal(recovered.ready, true); assert.equal(recovered.recording, false)
          assert.equal(recovered.error, undefined, 'reconnecting must clear the finalized recording fault')
        } else {
          await request('engine.close')
          // Recreate the project without configure (which independently clears
          // old faults), so this specifically verifies the explicit close path.
          await request('project.set', { timeline: p })
          const closed = await request('engine.snapshot')
          assert.equal(closed.ready, false)
          assert.equal(closed.error, undefined, 'closing must clear the finalized recording fault')
          await request('engine.close')
        }
      }
    })
  })
  await checked('simultaneous takes record each track input from one start, and loopback latency is measured', async () => {
    await withTestHost(async request => {
      const configured = await request('engine.configure', { backend: 'test', sampleRate: 48000, bufferFrames: 128, inputChannels: 2 })
      assert.equal(typeof configured.running, 'boolean')
      const p = project([
        { ...track('left', { kind: 'audio' }), input: { channels: [0] } },
        { ...track('pair', { kind: 'audio' }), input: null },
        { ...track('absent', { kind: 'audio' }), input: { channels: [7] } },
      ]); p.lengthFrames = 48000 * 30
      await request('project.set', { timeline: p })
      const idle = await request('engine.snapshot')
      assert.deepEqual(idle.tracksMissingInput, ['absent'])
      assert.ok(Number.isInteger(idle.device.overloads) && idle.device.overloads >= 0)
      assert.ok(typeof idle.device.lastCallbackLoad === 'number' && idle.device.lastCallbackLoad >= 0)

      const latency = await request('latency.measure', { inputChannel: 1 })
      assert.equal(latency.roundTripFrames, 128, 'the synthetic loopback is exactly one buffer')
      assert.equal(latency.attempts, 5); assert.ok(latency.confidence > .9)
      assert.equal(latency.reportedFrames, null); assert.equal(latency.extraFrames, null)
      await assert.rejects(request('latency.measure', { inputChannel: 5 }), /not open/)

      await request('test.input', { active: true })
      await request('transport.play')
      await assert.rejects(request('latency.measure', { inputChannel: 0 }), /Stop playback/)
      await assert.rejects(request('record.start', { takes: [{ trackId: 'absent', path: path.join(temporary, 'absent.wav') }] }), /not open/)
      await assert.rejects(request('record.start', { takes: [{ trackId: 'left', path: path.join(temporary, 'a.wav') }, { trackId: 'left', path: path.join(temporary, 'b.wav') }] }), /one take/)
      const files = { left: path.join(temporary, 'multi-left.wav'), pair: path.join(temporary, 'multi-pair.wav') }
      const start = await request('record.start', { takes: [{ trackId: 'left', takeId: 'L', path: files.left }, { trackId: 'pair', takeId: 'P', path: files.pair }] })
      assert.deepEqual(start.takes.map(take => [take.trackId, take.takeId, take.channels]), [['left', 'L', 1], ['pair', 'P', 2]])
      assert.equal(start.takes[0].startFrame, start.takes[1].startFrame)
      assert.equal(start.startFrame, undefined, 'a multi-take start has no single-take fields')
      const deadline = Date.now() + 5000
      while ((await request('engine.snapshot')).recordedFrames < 2048) { assert.ok(Date.now() < deadline, 'Multi-take capture did not advance'); await delay(10) }
      const stop = await request('record.stop')
      assert.equal(stop.takes.length, 2); assert.equal(stop.path, undefined)
      for (const take of stop.takes) {
        assert.equal(take.error, undefined)
        const audio = wav(await readFile(files[take.trackId]))
        assert.equal(audio.channels, take.channels); assert.equal(audio.frames, take.frames)
        assert.equal(take.frames, stop.takes[0].frames, 'takes stopped on different frames')
        assert.ok(rms(audio.samples) > .05, 'a take recorded silence from an open input')
      }
      await request('transport.stop')
      await request('engine.close')
    })
  })
  await checked('processing threads and render-ahead reach the engine; exports match single-threaded', async () => {
    await withTestHost(async request => {
      const base = { backend: 'test', sampleRate: 48000, bufferFrames: 128, inputChannels: 0 }
      await assert.rejects(request('engine.configure', { ...base, processingThreads: 17 }), /processingThreads/)
      await assert.rejects(request('engine.configure', { ...base, renderAhead: 'max' }), /renderAhead/)
      const p = project([track('keys'), track('bass', source('bass')), track('pad', source('pad')), track('drums', source('drums'))])
      p.lengthFrames = 48000 * 20
      const exported = []
      for (const processingThreads of [0, 2]) {
        await request('engine.configure', { ...base, processingThreads, renderAhead: 'off' })
        const file = path.join(temporary, `threads-${processingThreads}.wav`)
        await request('render.wav', { timeline: { ...p, lengthFrames: 24000 }, path: file })
        exported.push(await readFile(file))
      }
      assert.ok(exported[0].equals(exported[1]), 'a two-thread export differs from the single-threaded export')
      await request('engine.configure', { ...base, processingThreads: 'auto', renderAhead: 'normal' })
      await request('project.set', { timeline: p })
      const configured = await request('engine.snapshot')
      assert.equal(configured.processingThreads, 'auto'); assert.equal(configured.renderAhead, 'normal')
      assert.ok(Number.isInteger(configured.workerThreads) && configured.workerThreads >= 1, 'render-ahead needs a worker')
      await request('transport.play')
      const deadline = Date.now() + 5000
      let state = await request('engine.snapshot')
      while (state.renderAheadTracks < 4) { assert.ok(Date.now() < deadline, 'playing tracks did not render ahead'); await delay(10); state = await request('engine.snapshot') }
      assert.equal(state.renderAheadResyncs, 0)
      await request('transport.pause')
      assert.equal((await request('engine.snapshot')).renderAheadTracks, 0, 'a paused engine still renders ahead')
      await request('engine.close')
    })
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
    child.stdin.end(JSON.stringify({ id: 0, method: 'hello' }) + '\n' + JSON.stringify({ id: 1, method: 'engine.configure', params: { backend: 'not-a-backend', sampleRate: 48000, bufferFrames: 128, inputChannels: 0 } }) + '\n' + JSON.stringify({ id: 2, method: 'test.fault' }) + '\n')
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Native EOF shutdown timed out')) }, 5000)
      child.on('error', error => { clearTimeout(timer); reject(error) }); child.on('exit', code => { clearTimeout(timer); resolve(code) })
    })
    assert.equal(code, 0, diagnostics)
    const [hello, response, fault] = output.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(hello.result.testClock, false)
    if (!flag('--core-only')) {
      assert.equal(hello.result.vst3, true, 'the distribution must contain the real VST3 host')
      if (process.platform === 'win32') { assert.ok(hello.result.backends.includes('asio')); assert.ok(hello.result.backends.includes('wasapi')) }
      if (process.platform === 'darwin') assert.ok(hello.result.backends.includes('coreaudio'))
    }
    assert.equal(response.id, 1); assert.equal(response.ok, false)
    assert.match(response.error.message, /unavailable|not available|Unknown|Unsupported/)
    assert.equal(fault.id, 2); assert.equal(fault.ok, false)
    assert.match(fault.error.message, /Test fault injection is not enabled/)
  })
  console.log('Native smoke: ' + checks + ' checks passed. The test clock does not validate physical WASAPI/ASIO/Core Audio playback or latency.')
} finally {
  await service.dispose()
  await rm(temporary, { recursive: true, force: true })
}

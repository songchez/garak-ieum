// Browser check of the web render engine (docs/RUST_ENGINE.md 5): garak-engine.wasm is the only web renderer.
// In Chromium, through the real AudioWorklet and Worker:
//   1. the app boots (no console errors) and createAudioEngine returns the engine host;
//   2. exports: the A/B fixtures and a track with every built-in effect (the guitar rig included) render on
//      the engine worker, audible and finite (the sample-exact A/B against a TS reference is engineAB.test.ts);
//   3. realtime: the worklet plays (non-silent master, advancing transport, seek/pause/stop), a sampled kit
//      plays from its decoded set, and the export runs on the engine;
//   4. CPU: 16/32-track projects played in realtime (worklet render time per quantum;
//      AudioContext.renderCapacity load when the browser has it) and rendered offline. On the
//      isolated page the worklet is timed with a microsecond clock (engineBenchmark.preciseClock);
//   5. the web host paths (docs/RUST_ENGINE.md 5.7): a count-in clicked by the engine, track and dynamics
//      meters, an editor's analysis tap (spectrum + scope), a library preview while playing, input monitoring of a MediaStream, route monitoring
//      and a route recording from the engine's taps, and a pre-master (stem) render.
// Runs twice: a plain page (postMessage channel) and a cross-origin isolated one (SharedArrayBuffer).
// Run after `pnpm rust:wasm`: `node scripts/rust-engine-smoke.mjs`. Optional GARAK_CHROMIUM_EXECUTABLE.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const ISOLATION = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }

async function openPage(browser, url) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage()
  const errors = [], logs = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { logs.push(`${message.type()}: ${message.text()}`); if (message.type() === 'error') errors.push(message.text()) })
  // The first load of a cold Vite server pre-bundles dependencies.
  await page.goto(url, { timeout: 180000 })
  await page.getByRole('button', { name: '새 빈 프로젝트', exact: true }).click({ timeout: 15000 }).catch(() => undefined)
  await page.getByRole('button', { name: '트랙 추가', exact: true }).waitFor()
  return { page, errors, logs }
}

async function session(browser, isolated, port) {
  const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port, hmr: false, headers: isolated ? ISOLATION : {} } })
  await server.listen()
  const url = server.resolvedUrls.local[0]
  const errors = [], notes = []
  // Each task in a fresh page (renderer process), so one task's engine instances and memory never affect the next.
  const task = async (name, arg) => {
    const opened = await openPage(browser, url)
    try { return await opened.page.evaluate(TASK, { name, arg }) } finally {
      errors.push(...opened.errors); notes.push(...opened.logs.filter(line => line.includes('오디오 엔진')))
      await opened.page.context().close()
    }
  }
  try {
    const result = await task('main')
    result.host = await task('host')
    result.cpu = {}
    for (const tracks of [16, 32]) result.cpu[tracks] = { realtime: await task('load', { tracks }), offline: await task('offline', { tracks }) }
    return { result, errors, notes }
  } finally {
    await server.close()
  }
}

const TASK = async ({ name, arg }) => {
      const { WebAudioEngine } = await import('/src/audio/WebAudioEngine.ts')
      const { createAudioEngine } = await import('/src/audio/engineFactory.ts')
      const { engineBenchmark } = await import('/src/audio/rust/engineHost.ts')
      const { createDevice, createTrack } = await import('/src/core/project.ts')
      const { EFFECT_TYPES } = await import('/src/devices/effects/registry.ts')
      const { DEFAULT_AUDIO_SETTINGS } = await import('/src/core/audioSettings.ts')
      const fixtures = await import('/src/audio/rust/engineTestProjects.ts')
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
      const factoryPicksEngine = (() => { const e = createAudioEngine(DEFAULT_AUDIO_SETTINGS); const ok = e instanceof WebAudioEngine; e.dispose(); return ok })()

      const assetsOf = test => new Map([...test.pcm].map(([id, pcm]) => {
        const buffer = new AudioBuffer({ length: pcm.channels[0].length, numberOfChannels: pcm.channels.length, sampleRate: pcm.sampleRate })
        pcm.channels.forEach((data, c) => buffer.copyToChannel(data, c))
        return [id, { id, name: id, blob: new Blob(['x']), buffer, peaks: [] }]
      }))
      const decode = async blob => {
        const view = new DataView(await blob.arrayBuffer())
        let at = 12, format = 0, channels = 2, bits = 32
        while (at + 8 <= view.byteLength) {
          const id = String.fromCharCode(...new Uint8Array(view.buffer, at, 4)), size = view.getUint32(at + 4, true)
          if (id === 'fmt ') { format = view.getUint16(at + 8, true); channels = view.getUint16(at + 10, true); bits = view.getUint16(at + 22, true) }
          if (id === 'data') {
            const frames = size / (channels * bits / 8), left = new Float32Array(frames), right = new Float32Array(frames)
            for (let i = 0; i < frames; i += 1) { left[i] = view.getFloat32(at + 8 + i * 8, true); right[i] = view.getFloat32(at + 12 + i * 8, true) }
            if (format !== 3 && format !== 0xfffe) throw new Error(`unexpected WAV format ${format}`)
            return { left, right }
          }
          at += 8 + size + (size & 1)
        }
        throw new Error('no data chunk')
      }
      const db = x => x > 0 ? 20 * Math.log10(x) : -Infinity
      const level = audio => {
        let peak = 0, finite = true
        for (const channel of [audio.left, audio.right]) for (const x of channel) { finite &&= Number.isFinite(x); peak = Math.max(peak, Math.abs(x)) }
        return { peakDb: db(peak), finite, frames: audio.left.length }
      }
      const exportWith = async (test, options = {}) => {
        const engine = new WebAudioEngine(test.project)
        engine.setAssets(assetsOf(test))
        const began = performance.now()
        const rendered = await engine.renderAudio(test.project, { bitDepth: 32, ...options })
        const wallMs = performance.now() - began
        const info = engine.diagnostics?.().lastRender ?? null
        engine.dispose()
        return { audio: await decode(rendered.blob), wallMs, info }
      }

      const main = async () => {
      // 2. Exports on the engine worker.
      const exports = {}
      for (const test of fixtures.abProjects()) {
        const rendered = await exportWith(test)
        exports[test.name] = { ...level(rendered.audio), renderMs: rendered.info?.renderMs, wallMs: Math.round(rendered.wallMs) }
      }
      // Every built-in effect on one track (the guitar rig included), in catalog order.
      const chainTest = fixtures.effectsProject()
      chainTest.project.tracks = [{ ...chainTest.project.tracks[0], devices: EFFECT_TYPES.map(type => createDevice(type)) }]
      exports['every-effect'] = level((await exportWith(chainTest)).audio)

      // 3. Realtime on the worklet.
      const playTest = fixtures.effectsProject()
      const engine = new WebAudioEngine(playTest.project)
      engine.setAssets(assetsOf(playTest))
      await engine.play()
      let master = 0
      const beats = []
      for (let i = 0; i < 30; i += 1) { await sleep(50); master = Math.max(master, engine.getMasterLevel()); beats.push(engine.getSnapshot().beat) }
      const playing = engine.diagnostics()
      engine.seek(1)
      await sleep(150)
      const afterSeek = engine.getSnapshot().beat
      engine.pause()
      const paused = engine.getSnapshot()
      await sleep(100)
      const pausedLater = engine.getSnapshot().beat
      engine.stop()
      const exported = await engine.renderAudio(playTest.project, { bitDepth: 16 })
      const exportInfo = engine.diagnostics().lastRender
      // A sampled instrument (kit): its decoded sample set goes to the engine, which plays it (no fallback).
      const sampled = fixtures.sampledProject()
      engine.setProject(sampled.project)
      engine.setAssets(new Map())
      await engine.play()
      let sampledMaster = 0
      for (let i = 0; i < 16; i += 1) { await sleep(50); sampledMaster = Math.max(sampledMaster, engine.getMasterLevel()) }
      const sampledOn = engine.diagnostics()
      engine.stop()
      // Back to the first project.
      engine.setProject(playTest.project)
      engine.setAssets(assetsOf(playTest))
      await engine.play()
      await sleep(200)
      const resumed = engine.diagnostics().playing
      engine.stop()
      engine.dispose()
      const realtime = {
        master, beatsAdvance: beats[beats.length - 1] - beats[0], playingOn: playing.playing, sharedChannel: playing.sharedChannel, accepted: playing.accepted,
        quanta: playing.status.quanta, afterSeek, paused: paused.playing, pausedBeat: paused.beat, pausedLater, exportRenderMs: exportInfo?.renderMs, exportBytes: exported.blob.size, resumed,
        sampled: { playingOn: sampledOn.playing, accepted: sampledOn.accepted, reason: sampledOn.reason, master: sampledMaster },
      }
      return { exports, realtime }
      }

      // 5. Web host paths on the engine (no handoff to the Web Audio graph).
      const host = async () => {
        const test = fixtures.effectsProject()
        const chain = test.project.tracks[0]
        const mic = { ...createTrack('audio'), id: 'mic-track', name: 'mic', clips: [] }
        const routed = { ...createTrack('audio'), id: 'routed-track', name: 'routed', clips: [], inputRoute: { kind: 'track', trackId: chain.id, tap: 'postFx' } }
        test.project.tracks = [...test.project.tracks, mic, routed]
        const engine = new WebAudioEngine(test.project)
        engine.setAssets(assetsOf(test))
        engine.setMetronome({ enabled: true, sound: 'janggu', volume: 0.8, accent: true })
        const out = {}
        const began = performance.now()
        await engine.play({ countInBars: 1 })
        out.countInMs = Math.round(performance.now() - began)
        out.countInOn = engine.diagnostics().playing
        out.beatAfterCountIn = engine.getSnapshot().beat
        await sleep(700)
        out.trackLevel = engine.getTrackLevel(chain.id)
        out.masterLevel = engine.getMasterLevel()
        const compressor = chain.devices.find(device => device.type === 'compressor')
        out.deviceMeter = engine.getDeviceMeter(compressor.id)
        // The EQ editor's spectrum and the utility's scope: an analysis tap the engine streams while the editor looks.
        const { deviceAnalysisTap } = await import('/src/devices/effects/analysis.ts')
        const eqDevice = chain.devices.find(device => device.type === 'eq')
        out.spectrum = null
        for (let i = 0; i < 40 && !out.spectrum; i += 1) {
          await sleep(50)
          const tap = deviceAnalysisTap(eqDevice.id)
          if (!tap) continue
          const bins = new Float32Array(tap.analyser.frequencyBinCount), left = new Float32Array(tap.left.fftSize)
          tap.analyser.getFloatFrequencyData(bins)
          tap.left.getFloatTimeDomainData(left)
          const loudest = Math.max(...bins), peak = Math.max(...left.map(Math.abs))
          if (loudest > -90 && peak > 0) out.spectrum = { loudestDb: loudest, scopePeak: peak, afterMs: (i + 1) * 50 }
        }
        // A library preview (no track) plays on the preview engine; the project keeps playing.
        await engine.previewNote('keys', 64).catch(error => { out.previewError = String(error) })
        out.afterPreview = engine.diagnostics().playing
        const context = engine.context
        const osc = context.createOscillator(), stream = context.createMediaStreamDestination()
        osc.connect(stream)
        osc.start()
        engine.setInputMonitor(stream.stream, ['mic-track'])
        engine.setRouteMonitor(['routed-track'])
        await sleep(700)
        let d = engine.diagnostics()
        out.monitoring = { on: d.playing, indices: d.monitoring, mic: engine.getTrackLevel('mic-track'), routed: engine.getTrackLevel('routed-track') }
        await engine.prepareRouteRecording()
        const takes = await new Promise((resolve, reject) => {
          const recording = engine.createRouteRecordings(['routed-track'], { onComplete: resolve, onError: reject })
          recording.start().then(() => sleep(900)).then(() => recording.stop()).catch(reject)
        })
        d = engine.diagnostics()
        out.recording = { on: d.playing, taps: d.taps, seconds: takes[0].durationSeconds, error: takes[0].error ? String(takes[0].error) : null, rms: await wavRms(takes[0].blob) }
        osc.stop()
        engine.setInputMonitor(null, [])
        engine.setRouteMonitor([])
        out.status = { budgetMisses: d.status.budgetMisses, quanta: d.status.quanta, kernels: d.kernels }
        engine.stop()
        const stem = await engine.renderAudio(test.project, { bitDepth: 32, preMaster: true })
        out.preMaster = { engine: engine.diagnostics().lastRender?.preMaster ? 'engine' : null, frames: stem.frames }
        engine.dispose()
        return out
      }
      const wavRms = async blob => {
        const view = new DataView(await blob.arrayBuffer())
        let at = 12
        while (at + 8 <= view.byteLength) {
          const id = String.fromCharCode(...new Uint8Array(view.buffer, at, 4)), size = view.getUint32(at + 4, true)
          if (id === 'data') { let sum = 0; const n = size / 2; for (let i = 0; i < n; i += 1) sum += (view.getInt16(at + 8 + i * 2, true) / 32768) ** 2; return Math.sqrt(sum / Math.max(1, n)) }
          at += 8 + size + (size & 1)
        }
        return 0
      }
      if (name === 'host') return host()

      // 4. CPU: realtime load, then offline render speed (separate pages, see session()).
      const load = async test => {
        engineBenchmark.preciseClock = globalThis.crossOriginIsolated === true
        const e = new WebAudioEngine(test.project)
        e.setAssets(assetsOf(test))
        await e.play()
        const context = e.context
        let capacity = null
        if (context?.renderCapacity?.start) {
          const loads = []
          context.renderCapacity.onupdate = event => loads.push([event.averageLoad, event.peakLoad, event.underrunRatio])
          context.renderCapacity.start({ updateInterval: 0.5 })
          await sleep(3000)
          context.renderCapacity.stop()
          if (loads.length) capacity = { average: Math.max(...loads.map(l => l[0])), peak: Math.max(...loads.map(l => l[1])), underruns: Math.max(...loads.map(l => l[2])) }
        } else await sleep(3000)
        const d = e.diagnostics()
        e.stop(); e.dispose()
        const status = d?.status
        return {
          renderCapacity: capacity, workletUsPerQuantum: status?.quanta ? Math.round(status.renderMs * 1000 / status.quanta) : null, workletMaxUs: status ? Math.round(status.renderMaxMs * 1000) : null, budgetMisses: status?.budgetMisses ?? null,
          // Steady playback only (no project load, staged build or edit in that quantum).
          playing: status?.playingQuanta ? { quanta: status.playingQuanta, meanUs: Math.round(status.playingMs * 1000 / status.playingQuanta), maxUs: Math.round(status.playingMaxMs * 1000), misses: status.playingMisses } : null,
          preciseClock: engineBenchmark.preciseClock, playing: d.playing,
        }
      }
      if (name === 'load') return load(fixtures.benchProject(arg.tracks, 6))
      if (name === 'offline') {
        const rendered = await exportWith(fixtures.benchProject(arg.tracks, 6))
        return { wallMs: Math.round(rendered.wallMs), renderMs: Math.round(rendered.info?.renderMs ?? 0), renderedSeconds: +(rendered.audio.left.length / 48000).toFixed(2) }
      }
      return { factoryPicksEngine, crossOriginIsolated: globalThis.crossOriginIsolated === true, ...(await main()) }
}

const browser = await chromium.launch({
  headless: true,
  ...(process.env.GARAK_CHROMIUM_EXECUTABLE ? { executablePath: process.env.GARAK_CHROMIUM_EXECUTABLE } : {}),
  args: ['--autoplay-policy=no-user-gesture-required'],
})
try {
  for (const isolated of [false, true]) {
    const { result, errors, notes } = await session(browser, isolated, isolated ? 4176 : 4175)
    console.log(JSON.stringify({ isolated, ...result, notes }, null, 2))
    assert.equal(result.factoryPicksEngine, true, 'createAudioEngine must return the engine host')
    assert.equal(result.crossOriginIsolated, isolated)
    const r = result.realtime
    assert.equal(r.playingOn, true, 'the project must play on the worklet')
    assert.equal(r.accepted, true)
    assert.equal(r.sharedChannel, isolated, 'the SharedArrayBuffer channel is used exactly when the page is isolated')
    assert(r.master > 0.01, `the worklet must be audible (master ${r.master})`)
    assert(r.beatsAdvance > 1, 'the transport must advance while playing')
    assert(r.afterSeek >= 1 && r.afterSeek < 1.6, `seek must move the transport (beat ${r.afterSeek})`)
    assert.equal(r.paused, false)
    assert(Math.abs(r.pausedLater - r.pausedBeat) < 0.01, 'pause must hold the transport')
    assert(r.exportRenderMs > 0, 'the export must run on the engine worker')
    assert.equal(r.sampled.playingOn, true, `a sampled-instrument project plays on the engine (${r.sampled.reason})`)
    assert(r.sampled.master > 0.01, `the sampled kit is audible on the engine (master ${r.sampled.master})`)
    assert.equal(r.resumed, true, 'switching projects keeps playing on the engine')
    for (const [name, entry] of Object.entries(result.exports)) {
      assert(entry.finite, `${name}: finite export`)
      assert(entry.peakDb > -40, `${name}: audible export (${entry.peakDb.toFixed(1)} dBFS)`)
    }
    const h = result.host
    assert.equal(h.countInOn, true, 'a count-in plays on the engine (scheduled start)')
    assert(h.countInMs > 1500 && h.countInMs < 3500, `play() resolves on the downbeat after one 4/4 bar at 120 BPM (${h.countInMs} ms)`)
    assert(h.beatAfterCountIn < 0.25, `the transport starts at the downbeat (beat ${h.beatAfterCountIn})`)
    assert(h.trackLevel > 0.001, `track meters read the engine (${h.trackLevel})`)
    assert(h.deviceMeter && h.deviceMeter.input > 0, 'dynamics meters read the engine')
    assert(h.spectrum, 'the EQ editor spectrum and scope read an engine analysis tap')
    assert.equal(h.previewError, undefined)
    assert.equal(h.afterPreview, true, 'a library preview does not stop the project')
    assert.equal(h.monitoring.on, true, 'monitoring while playing')
    assert.equal(h.monitoring.indices.length, 2)
    assert(h.monitoring.mic > 0.01, `the monitored input is heard through its track (${h.monitoring.mic})`)
    assert(h.monitoring.routed > 0.001, `the routed track hears its source (${h.monitoring.routed})`)
    assert.equal(h.recording.on, true, 'route recording while playing')
    assert.equal(h.recording.error, null)
    assert(h.recording.seconds > 0.5 && h.recording.rms > 0.001, `the route take records the engine's tap (${h.recording.seconds} s, rms ${h.recording.rms})`)
    assert.equal(h.preMaster.engine, 'engine', 'pre-master stems render on the engine')
    assert.deepEqual(errors, [])
  }
} finally {
  await browser.close()
}

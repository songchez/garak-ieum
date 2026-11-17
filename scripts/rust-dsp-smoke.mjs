// Browser check of the web Rust DSP path (docs/RUST.md, stage 3): loads the app in Chromium, adds a
// track with every Rust-backed built-in effect, plays it in realtime and exports it, and checks that
// the worklets run the Rust kernels (not the TS / Web Audio fallback) and that the output is audible.
// Also renders the same export with the Rust path opted out (localStorage garak.rustDsp=0) and
// prints how far the old Web Audio sound is from the Rust (desktop) sound, for listening notes.
// Run after `pnpm rust:wasm`: `node scripts/rust-dsp-smoke.mjs`. Optional GARAK_CHROMIUM_EXECUTABLE.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 4174, hmr: false } })
await server.listen()
let browser
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.GARAK_CHROMIUM_EXECUTABLE ? { executablePath: process.env.GARAK_CHROMIUM_EXECUTABLE } : {}),
    args: ['--autoplay-policy=no-user-gesture-required'],
  })
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage()
  const errors = [], logs = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => logs.push(`${message.type()}: ${message.text()}`))
  await page.goto(server.resolvedUrls.local[0])
  await page.getByRole('button', { name: '새 빈 프로젝트', exact: true }).click()
  await page.getByRole('button', { name: '트랙 추가', exact: true }).waitFor()

  const run = () => page.evaluate(async () => {
    const { WebAudioEngine } = await import('/src/audio/WebAudioEngine.ts')
    const { createEmptyProject, createTrack, createDevice } = await import('/src/core/project.ts')
    const { createAudioAsset } = await import('/src/audio/assetPcm.ts')
    const { encodeWav } = await import('/src/audio/wavEncode.ts')
    const stats = values => {
      let peak = 0, sum = 0, finite = true
      for (const value of values) { peak = Math.max(peak, Math.abs(value)); sum += value * value; finite &&= Number.isFinite(value) }
      return { peak, rms: Math.sqrt(sum / values.length), finite }
    }
    const rate = 48000
    const source = new OfflineAudioContext(2, rate * 2, rate).createBuffer(2, rate * 2, rate)
    for (let c = 0; c < 2; c += 1) {
      const data = source.getChannelData(c)
      let noise = 7 + c
      for (let i = 0; i < data.length; i += 1) {
        const t = i / rate
        noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0
        data[i] = 0.25 * Math.exp(-(t % 0.5) * 6) * (Math.sin(2 * Math.PI * 110 * t) + 0.4 * Math.sin(2 * Math.PI * 1760 * t) + 0.2 * (noise / 2147483648 - 1))
      }
    }
    const project = createEmptyProject(), track = createTrack('audio')
    project.bpm = 120; project.lengthBeats = 4; project.loop = { enabled: false, startBeat: 0, endBeat: 4 }
    track.clips = [{ id: 'clip', name: 'Synthetic', kind: 'audio', assetId: 'src', startBeat: 0, lengthBeats: 4, gain: 1, offsetSeconds: 0, fadeIn: 0, fadeOut: 0 }]
    track.devices = [
      createDevice('eq', { low: 4, high: -3, b4On: 1, b4Type: 0, b4Freq: 2500, b4Gain: 6, b4Q: 2 }),
      createDevice('filter', { cutoff: 9000, mode: 0, slope: 1 }),
      createDevice('compressor', { threshold: -24, ratio: 4 }),
      createDevice('drive', { drive: 12, mix: 0.6 }),
      createDevice('phaser', {}),
      createDevice('delay', { amount: 0.25 }),
      createDevice('reverb', { amount: 0.4, size: 0.6, type: 2 }),
    ]
    project.tracks = [track]
    const engine = new WebAudioEngine(project)
    engine.setAssets(new Map([['src', createAudioAsset('src', 'Synthetic', encodeWav([source.getChannelData(0), source.getChannelData(1)], rate, 32), source)]]))
    const wav = new DataView(await (await engine.exportWav()).arrayBuffer())
    // 16-bit PCM after a 44-byte header (exportWav); left channel only.
    const samples = []
    for (let offset = 44; offset + 1 < wav.byteLength; offset += 4) samples.push(wav.getInt16(offset, true) / 32768)
    const exported = stats(samples)
    // Realtime: play and read the track / master meters.
    await engine.play()
    let trackLevel = 0, masterLevel = 0
    for (let i = 0; i < 30; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 50))
      trackLevel = Math.max(trackLevel, engine.getTrackLevel(track.id)); masterLevel = Math.max(masterLevel, engine.getMasterLevel())
    }
    engine.stop()
    engine.dispose()
    return { stats: { ...globalThis.__garakRustDsp }, exported, trackLevel, masterLevel, samples: samples.slice(0, rate * 2) }
  })

  const rust = await run()
  await page.evaluate(() => localStorage.setItem('garak.rustDsp', '0'))
  await page.reload()
  // The reloaded app may reopen the saved project instead of the start screen.
  await page.getByRole('button', { name: '새 빈 프로젝트', exact: true }).click({ timeout: 5000 }).catch(() => undefined)
  const web = await run()
  await page.evaluate(() => localStorage.removeItem('garak.rustDsp'))

  let diff = 0, ref = 0
  for (let i = 0; i < Math.min(rust.samples.length, web.samples.length); i += 1) { diff += (rust.samples[i] - web.samples[i]) ** 2; ref += web.samples[i] ** 2 }
  const summary = {
    rust: { worklets: rust.stats, exported: rust.exported, trackLevel: rust.trackLevel, masterLevel: rust.masterLevel },
    optedOut: { worklets: web.stats, exported: web.exported, trackLevel: web.trackLevel, masterLevel: web.masterLevel },
    rustVsWebAudioDifferenceDb: 10 * Math.log10(diff / ref),
    console: logs.filter(line => line.includes('가락이음') || line.startsWith('error')),
  }
  console.log(JSON.stringify(summary, null, 2))
  assert(rust.stats.rust >= 7 && rust.stats.fallback === 0, 'every effect worklet must run its Rust kernel')
  assert(web.stats.rust === 0, 'the opt-out must keep the Rust kernels off')
  assert(rust.exported.finite && rust.exported.rms > 0.01, 'the Rust export must be audible')
  assert(rust.trackLevel > 0.01 && rust.masterLevel > 0.01, 'realtime playback through the Rust worklets must be audible')
  assert.deepEqual(errors, [])
} finally {
  await browser?.close()
  await server.close()
}

// Browser check of the vintage instruments on the web (docs/RUST.md, 빈티지 악기): loads the app in
// Chromium, checks that 옥구슬 EP / 한밤 106 load from the same garak-dsp.wasm module the 시김새 kernels
// use (not greyed out), then exports and plays a short MIDI part on each and checks it is audible.
// Repeats with the Rust effects opted out (localStorage garak.rustDsp=0): the instruments must still play.
// Run after `pnpm rust:wasm` (or `pnpm build`): `node scripts/vintage-web-smoke.mjs`. Optional GARAK_CHROMIUM_EXECUTABLE.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 4175, hmr: false } })
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
    const { createEmptyProject, createTrack } = await import('/src/core/project.ts')
    const { loadVintageWasm, vintageWasmStatus } = await import('/src/devices/vintage/availability.ts')
    const { sharedGarakWasmModule } = await import('/src/audio/rust/garakWasm.ts')
    const loaded = await loadVintageWasm()
    const shared = await sharedGarakWasmModule('/')
    const stats = values => {
      let peak = 0, sum = 0, finite = true
      for (const value of values) { peak = Math.max(peak, Math.abs(value)); sum += value * value; finite &&= Number.isFinite(value) }
      return { peak, rms: Math.sqrt(sum / values.length), finite }
    }
    const results = {}
    for (const instrument of ['okgu-ep', 'hanbam-106']) {
      const project = createEmptyProject(), track = createTrack('instrument', instrument)
      project.bpm = 120; project.lengthBeats = 4; project.loop = { enabled: false, startBeat: 0, endBeat: 4 }
      const notes = [48, 55, 60, 64, 67].map((pitch, index) => ({ id: `n${index}`, pitch, start: index * 0.25, duration: 2, velocity: 0.8 }))
      track.clips = [{ id: 'clip', name: 'Chord', kind: 'midi', startBeat: 0, lengthBeats: 4, gain: 1, notes }]
      project.tracks = [track]
      const engine = new WebAudioEngine(project)
      const wav = new DataView(await (await engine.exportWav()).arrayBuffer())
      const samples = []
      for (let offset = 44; offset + 1 < wav.byteLength; offset += 4) samples.push(wav.getInt16(offset, true) / 32768)
      await engine.play()
      let trackLevel = 0, masterLevel = 0
      for (let i = 0; i < 30; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 50))
        trackLevel = Math.max(trackLevel, engine.getTrackLevel(track.id)); masterLevel = Math.max(masterLevel, engine.getMasterLevel())
      }
      engine.stop()
      engine.dispose()
      results[instrument] = { exported: stats(samples), trackLevel, masterLevel }
    }
    return { status: vintageWasmStatus(), sameModule: loaded !== null && loaded === shared, rustEffects: { ...globalThis.__garakRustDsp }, results }
  })

  const rust = await run()
  await page.evaluate(() => localStorage.setItem('garak.rustDsp', '0'))
  await page.reload()
  await page.getByRole('button', { name: '새 빈 프로젝트', exact: true }).click({ timeout: 5000 }).catch(() => undefined)
  const optedOut = await run()
  await page.evaluate(() => localStorage.removeItem('garak.rustDsp'))

  console.log(JSON.stringify({ rust, optedOut, console: logs.filter(line => line.includes('가락이음') || line.startsWith('error')) }, null, 2))
  for (const result of [rust, optedOut]) {
    assert.equal(result.status, 'ready', 'the vintage instruments must load from garak-dsp.wasm')
    assert(result.sameModule, 'the instruments must use the shared garak-dsp module')
    for (const [instrument, { exported, trackLevel, masterLevel }] of Object.entries(result.results)) {
      assert(exported.finite && exported.rms > 0.005, `${instrument}: the export must be audible`)
      assert(trackLevel > 0.005 && masterLevel > 0.005, `${instrument}: realtime playback must be audible`)
    }
  }
  assert.deepEqual(errors, [])
} finally {
  await browser?.close()
  await server.close()
}

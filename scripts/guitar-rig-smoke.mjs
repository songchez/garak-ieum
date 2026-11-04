// Browser UI + actual Web Audio rendering. No physical guitar or latency measurement.
// Run with `node scripts/guitar-rig-smoke.mjs` after installing Playwright Chromium.
// A preinstalled browser can be selected with GARAK_CHROMIUM_EXECUTABLE and
// a JSON array in GARAK_CHROMIUM_ARGS. No additional runtime dependency is needed.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 4173, hmr: false } })
await server.listen()
let browser
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.GARAK_CHROMIUM_EXECUTABLE ? { executablePath: process.env.GARAK_CHROMIUM_EXECUTABLE } : {}),
    args: [...JSON.parse(process.env.GARAK_CHROMIUM_ARGS || '[]'), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    window.__rigInputRequests = 0
    window.__rigInputStreams = []
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.__rigInputRequests += 1
      const stream = await getUserMedia(constraints)
      window.__rigInputStreams.push(stream)
      return stream
    }
  })
  await page.goto(server.resolvedUrls.local[0])
  await page.getByRole('button', { name: '새 빈 프로젝트', exact: true }).click()
  await page.getByRole('button', { name: '트랙 추가', exact: true }).click()
  await page.getByRole('radio', { name: '기타 앰프 · 컴프 · 이펙터', exact: true }).click()
  await page.getByRole('button', { name: '생성', exact: true }).click()
  await page.getByRole('button', { name: '기타 앰프 편집기 열기', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '기타 앰프', exact: true })
  await editor.waitFor()
  assert.equal(await page.evaluate(() => window.__rigInputRequests), 0, 'Opening a guitar track must not request microphone access')
  assert.equal(await editor.locator('.knob--image').count(), 18)
  const imageSizes = await editor.locator('img').evaluateAll(images => [...new Map(images.map(image => [image.src, [image.naturalWidth, image.naturalHeight]])).values()])
  assert.deepEqual(imageSizes.sort((a, b) => a[0] - b[0]), [[128, 128], [360, 600], [768, 512], [1440, 480]])

  const gain = editor.getByRole('slider', { name: '앰프 게인', exact: true })
  const original = Number(await gain.getAttribute('aria-valuenow'))
  await gain.press('ArrowUp')
  const coarse = Number(await gain.getAttribute('aria-valuenow'))
  await gain.press('Shift+ArrowUp')
  const fine = Number(await gain.getAttribute('aria-valuenow'))
  assert(coarse > original && fine > coarse && fine - coarse < coarse - original, 'Shift must be finer than a normal key step')
  await gain.press('Control+z')
  await page.waitForFunction(value => Number(document.querySelector('[role="slider"][aria-label="앰프 게인"]')?.getAttribute('aria-valuenow')) === value, coarse)

  const preset = editor.getByRole('combobox', { name: '기타 앰프 프리셋', exact: true })
  await preset.selectOption('lead')
  assert.equal(await editor.getByRole('combobox', { name: '마이크 성향', exact: true }).inputValue(), '1')
  await preset.press('Control+z')
  await page.waitForFunction(value => Number(document.querySelector('[role="slider"][aria-label="앰프 게인"]')?.getAttribute('aria-valuenow')) === value, coarse)
  await preset.selectOption('wide-clean')
  const position = editor.locator('.gr-range input').first()
  await position.fill('0.8')
  assert.equal(await editor.locator('.gr-mic-marker').getAttribute('transform'), 'translate(321 260)')
  await editor.getByRole('button', { name: '코러스 페달 켜기/바이패스', exact: true }).click()

  // A user click is required before a fake test input is acquired and monitored.
  await editor.getByRole('button', { name: '입력 모니터 끔', exact: true }).click()
  await page.waitForFunction(() => window.__rigInputStreams.some(stream => stream.active))
  await editor.getByRole('button', { name: '입력 모니터 켬', exact: true }).click()
  await page.waitForFunction(() => window.__rigInputStreams.every(stream => !stream.active))
  await preset.press('Control+s')
  await page.waitForFunction(async () => {
    const { loadProject } = await import('/src/core/storage.ts')
    const saved = await loadProject()
    const rig = saved?.project.tracks[0]?.devices[0]
    return rig?.type === 'guitar-rig' && rig.params.micPosition === 0.8 && rig.params.chorusEnabled === 0
  })

  if (process.env.GARAK_RIG_SCREENSHOTS) {
    const directory = resolve(process.env.GARAK_RIG_SCREENSHOTS)
    await mkdir(directory, { recursive: true })
    await page.screenshot({ path: resolve(directory, 'guitar-rig-desktop.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: resolve(directory, 'guitar-rig-narrow.png') })
    assert(await editor.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Editor must fit the narrow viewport')
    await page.setViewportSize({ width: 1440, height: 1000 })
  }
  await preset.press('Escape')
  assert.equal(await page.getByRole('button', { name: '기타 앰프 편집기 열기', exact: true }).evaluate(element => element === document.activeElement), true)
  await page.reload()
  await page.getByRole('button', { name: '디바이스', exact: true }).click()
  await page.getByRole('button', { name: '기타 앰프 편집기 열기', exact: true }).click()
  assert.equal(await page.locator('.gr-range input').first().inputValue(), '0.8')
  assert.equal(await page.getByRole('button', { name: '코러스 페달 켜기/바이패스', exact: true }).getAttribute('aria-pressed'), 'false')

  const audio = await page.evaluate(async () => {
    const rig = await import('/src/devices/guitar-rig/index.ts')
    const { WebAudioEngine } = await import('/src/audio/WebAudioEngine.ts')
    const { createEmptyProject, createGuitarTrack } = await import('/src/core/project.ts')
    const stats = values => {
      let peak = 0, sum = 0, finite = true
      for (const value of values) { peak = Math.max(peak, Math.abs(value)); sum += value * value; finite &&= Number.isFinite(value) }
      return { peak, rms: Math.sqrt(sum / values.length), finite }
    }
    const difference = (a, b) => stats(a.map((value, i) => value - b[i])).rms
    const render = async (patch, rate = 48000) => {
      const offline = new OfflineAudioContext(2, rate, rate)
      await rig.prepareGuitarRig(offline)
      const nodes = [], processor = rig.guitarRigEffect.create(offline, node => { nodes.push(node); return node })
      processor.update({ ...rig.GUITAR_RIG_DEFAULTS, ...patch }, 120, 0, false)
      const buffer = offline.createBuffer(1, rate, rate), input = buffer.getChannelData(0)
      let noise = 19
      for (let i = 0; i < rate * 0.6; i += 1) {
        const t = i / rate
        noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0
        input[i] = 0.16 * Math.exp(-t * 2) * (Math.sin(2 * Math.PI * 110 * t) + 0.35 * Math.sin(2 * Math.PI * 330 * t) + 0.2 * Math.sin(2 * Math.PI * 2200 * t) + 0.1 * (noise / 2147483648 - 1))
      }
      const source = offline.createBufferSource()
      source.buffer = buffer; source.connect(processor.input); processor.output.connect(offline.destination); source.start()
      const output = await offline.startRendering(), values = output.getChannelData(0).slice()
      processor.dispose?.(); for (const node of nodes) node.disconnect()
      return { input, values, buffer, ...stats(values) }
    }
    const clean = await render({})
    const off = await render({ compEnabled: 0, driveEnabled: 0, ampEnabled: 0, cabinetEnabled: 0, chorusEnabled: 0, delayEnabled: 0 })
    const edge = await render({ micPosition: 1 }), ribbon = await render({ micType: 1 }), far = await render({ micDistance: 1 })
    const delayed = await render({ delayEnabled: 1, delayTime: 300 })
    const rate96 = await render({}, 96000)
    const presets = []
    for (const preset of rig.GUITAR_RIG_PRESETS) {
      const rendered = await render(preset.params)
      presets.push({ name: preset.name, peak: rendered.peak, rms: rendered.rms, finite: rendered.finite })
    }
    const project = createEmptyProject(), track = createGuitarTrack()
    project.lengthBeats = 2; project.loop = { enabled: false, startBeat: 0, endBeat: 2 }; project.bpm = 120
    track.clips = [{ id: 'test-di', name: 'Synthetic guitar input', kind: 'audio', assetId: 'test-source', startBeat: 0, lengthBeats: 2, gain: 1, offsetSeconds: 0, fadeIn: 0, fadeOut: 0 }]
    project.tracks = [track]
    const engine = new WebAudioEngine(project)
    engine.setAssets(new Map([['test-source', { id: 'test-source', name: 'Synthetic guitar input', blob: new Blob(['test']), buffer: clean.buffer, peaks: [] }]]))
    const wav = new Uint8Array(await (await engine.exportWav()).arrayBuffer())
    engine.dispose()
    return {
      clean: { peak: clean.peak, rms: clean.rms, finite: clean.finite },
      bypassDifference: difference(off.values, off.input),
      micPositionDifference: difference(clean.values, edge.values),
      micTypeDifference: difference(clean.values, ribbon.values),
      micDistanceDifference: difference(clean.values, far.values),
      delayTail: stats(delayed.values.slice(36000)).rms,
      rate96: { peak: rate96.peak, rms: rate96.rms, finite: rate96.finite }, presets,
      wav: { bytes: wav.length, riff: new TextDecoder().decode(wav.slice(0, 4)), nonzero: wav.slice(44).some(value => value !== 0) },
    }
  })
  assert.equal(audio.bypassDifference, 0)
  assert(audio.clean.finite && audio.clean.rms > 0.001 && audio.rate96.finite && audio.rate96.rms > 0.001)
  for (const key of ['micPositionDifference', 'micTypeDifference', 'micDistanceDifference']) assert(audio[key] > 0.0001, `${key} must change the rendered signal`)
  assert(audio.delayTail > 0.001)
  assert(audio.presets.every(preset => preset.finite && preset.rms > 0.001 && preset.peak < 4))
  assert(audio.wav.riff === 'RIFF' && audio.wav.bytes > 48000 * 4 && audio.wav.nonzero)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ui: 'passed', fakeInputMonitoring: 'passed', persistence: 'passed', audio }, null, 2))
} finally {
  await browser?.close()
  await server.close()
}

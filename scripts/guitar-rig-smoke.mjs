// Browser UI + the rig rendered by the engine (garak-engine.wasm). No physical guitar or latency measurement.
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
  // Pedal art 360×600, knob caps 128×128, the cabinet 768×512 and the microphone 480×360 (src/assets/guitar-rig).
  const imageSizes = await editor.locator('img').evaluateAll(images => [...new Set(images.map(image => `${image.naturalWidth}x${image.naturalHeight}`))])
  assert.deepEqual(imageSizes.sort(), ['128x128', '360x600', '480x360', '768x512'])

  const gain = editor.getByRole('slider', { name: '앰프 게인', exact: true })
  const original = Number(await gain.getAttribute('aria-valuenow'))
  await gain.press('ArrowUp')
  const coarse = Number(await gain.getAttribute('aria-valuenow'))
  await gain.press('Shift+ArrowUp')
  const fine = Number(await gain.getAttribute('aria-valuenow'))
  assert(coarse > original && fine > coarse && fine - coarse < coarse - original, 'Shift must be finer than a normal key step')
  await gain.press('Control+z')
  await page.waitForFunction(value => Number(document.querySelector('[role="slider"][aria-label="앰프 게인"]')?.getAttribute('aria-valuenow')) === value, coarse)

  // The preset picker: a searchable list in a popover; undo restores the tone before the preset.
  const choosePreset = async name => {
    await editor.getByRole('button', { name: /^기타 앰프 프리셋:/ }).click()
    await page.getByRole('dialog', { name: '프리셋 고르기' }).getByRole('option', { name: new RegExp(name) }).click()
    await page.waitForFunction(label => document.querySelector('.rp-trigger')?.getAttribute('aria-label') === `기타 앰프 프리셋: ${label}`, name)
  }
  const mic = editor.getByRole('combobox', { name: '마이크', exact: true })
  await choosePreset('Warm Lead')
  assert.equal(await mic.inputValue(), '1', 'Warm Lead uses the ribbon microphone')
  await gain.focus()
  await page.keyboard.press('Control+z')
  await page.waitForFunction(value => Number(document.querySelector('[role="slider"][aria-label="앰프 게인"]')?.getAttribute('aria-valuenow')) === value, coarse)
  await choosePreset('Wide Clean')
  assert.equal(await mic.inputValue(), '2')
  const position = editor.getByRole('slider', { name: '마이크 위치', exact: true })
  // As a player does it (a gesture: key down, key up).
  await position.press('End')
  assert.equal(await position.inputValue(), '1')
  // Wide Clean has the chorus on: bypass it with its footswitch.
  const chorus = editor.getByRole('button', { name: 'Blue Ripple 페달 켜기/바이패스', exact: true })
  assert.equal(await chorus.getAttribute('aria-pressed'), 'true')
  await chorus.click()
  assert.equal(await chorus.getAttribute('aria-pressed'), 'false')

  // A user click is required before a fake test input is acquired and monitored.
  await editor.getByRole('button', { name: '입력 모니터 끔', exact: true }).click()
  await page.waitForFunction(() => window.__rigInputStreams.some(stream => stream.active))
  await editor.getByRole('button', { name: '입력 모니터 켬', exact: true }).click()
  await page.waitForFunction(() => window.__rigInputStreams.every(stream => !stream.active))
  await gain.focus()
  await page.keyboard.press('Control+s')
  await page.waitForFunction(async () => {
    const { loadProject } = await import('/src/core/storage.ts')
    const saved = await loadProject()
    const rig = saved?.project.tracks[0]?.devices[0]
    return rig?.type === 'guitar-rig' && rig.params.chorusEnabled === 0 && rig.params.micPosition === 1 && rig.params.micType === 2
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
  await editor.press('Escape')
  await editor.waitFor({ state: 'hidden' })
  assert.equal(await page.getByRole('button', { name: '기타 앰프 편집기 열기', exact: true }).evaluate(element => element === document.activeElement), true)
  await page.waitForFunction(async () => {
    const { loadProject } = await import('/src/core/storage.ts')
    const rig = (await loadProject())?.project.tracks[0]?.devices[0]
    return rig?.params.chorusEnabled === 0
  })
  await page.reload()
  await page.getByRole('button', { name: '시김새 체인', exact: true }).click()
  await page.getByRole('button', { name: '기타 앰프 편집기 열기', exact: true }).click()
  await editor.waitFor()
  // The edits survive the reload (the autosave flushes pending edits on Ctrl+S, pagehide and its 5 s ceiling).
  assert.equal(await editor.getByRole('slider', { name: '마이크 위치', exact: true }).inputValue(), '1', 'the mic position survives a reload')
  assert.equal(await editor.getByRole('combobox', { name: '마이크', exact: true }).inputValue(), '2', 'the mic type survives a reload')
  assert.equal(await editor.getByRole('button', { name: 'Blue Ripple 페달 켜기/바이패스', exact: true }).getAttribute('aria-pressed'), 'false')
  await editor.press('Escape')

  // The rig renders in the engine (garak-dsp GuitarRig in garak-engine.wasm): a guitar track playing a synthetic DI clip.
  const audio = await page.evaluate(async () => {
    const rig = await import('/src/devices/guitar-rig/index.ts')
    const { WebAudioEngine } = await import('/src/audio/WebAudioEngine.ts')
    const { createEmptyProject, createGuitarTrack } = await import('/src/core/project.ts')
    const { createAudioAsset } = await import('/src/audio/assetPcm.ts')
    const { encodeWav } = await import('/src/audio/wavEncode.ts')
    const stats = values => {
      let peak = 0, sum = 0, finite = true
      for (const value of values) { peak = Math.max(peak, Math.abs(value)); sum += value * value; finite &&= Number.isFinite(value) }
      return { peak, rms: Math.sqrt(sum / values.length), finite }
    }
    const difference = (a, b) => stats(a.map((value, i) => value - b[i])).rms
    const source = rate => {
      const buffer = new AudioBuffer({ length: rate, numberOfChannels: 1, sampleRate: rate }), input = buffer.getChannelData(0)
      let noise = 19
      for (let i = 0; i < rate * 0.6; i += 1) {
        const t = i / rate
        noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0
        input[i] = 0.16 * Math.exp(-t * 2) * (Math.sin(2 * Math.PI * 110 * t) + 0.35 * Math.sin(2 * Math.PI * 330 * t) + 0.2 * Math.sin(2 * Math.PI * 2200 * t) + 0.1 * (noise / 2147483648 - 1))
      }
      return buffer
    }
    const floats = async blob => {
      const view = new DataView(await blob.arrayBuffer())
      let at = 12
      while (at + 8 <= view.byteLength) {
        const id = String.fromCharCode(...new Uint8Array(view.buffer, at, 4)), size = view.getUint32(at + 4, true)
        if (id === 'data') { const out = new Float32Array(size / 8); for (let k = 0; k < out.length; k += 1) out[k] = view.getFloat32(at + 8 + k * 8, true); return out }
        at += 8 + size + (size & 1)
      }
      throw new Error('no data chunk')
    }
    const render = async (patch, rate = 48000) => {
      const project = createEmptyProject(), track = createGuitarTrack()
      project.sampleRate = rate; project.lengthBeats = 2; project.loop = { enabled: false, startBeat: 0, endBeat: 2 }; project.bpm = 120; project.masterVolume = 1
      track.devices = track.devices.map(device => device.type === 'guitar-rig' ? { ...device, params: { ...rig.GUITAR_RIG_DEFAULTS, ...patch } } : device)
      track.clips = [{ id: 'test-di', name: 'Synthetic guitar input', kind: 'audio', assetId: 'test-source', startBeat: 0, lengthBeats: 2, gain: 1, offsetSeconds: 0, fadeIn: 0, fadeOut: 0 }]
      project.tracks = [track]
      const buffer = source(rate)
      const engine = new WebAudioEngine(project)
      engine.setAssets(new Map([['test-source', createAudioAsset('test-source', 'Synthetic guitar input', encodeWav([buffer.getChannelData(0)], rate, 32), buffer)]]))
      // Pre-master and no tail: the rig's own output, frame-aligned with its input.
      const rendered = await engine.renderAudio(project, { bitDepth: 32, preMaster: true, tailSeconds: 0 })
      engine.dispose()
      const values = Array.from((await floats(rendered.blob)).subarray(0, rate))
      return { input: Array.from(buffer.getChannelData(0)), values, ...stats(values) }
    }
    const clean = await render({})
    const edge = await render({ micPosition: 1 }), ribbon = await render({ micType: 1 }), far = await render({ micDistance: 1 })
    const delayed = await render({ delayEnabled: 1, delayTime: 300 })
    const rate96 = await render({}, 96000)
    const presets = []
    for (const preset of rig.GUITAR_RIG_PRESETS) {
      const rendered = await render(preset.params)
      presets.push({ name: preset.name, peak: rendered.peak, rms: rendered.rms, finite: rendered.finite })
    }
    // The tuner readout: the engine streams the signal at the tuner's rack position while the editor looks.
    const tunerReading = await (async () => {
      const project = createEmptyProject(), track = createGuitarTrack()
      project.lengthBeats = 8; project.loop = { enabled: true, startBeat: 0, endBeat: 2 }; project.bpm = 120
      track.devices = [{ ...track.devices[0], params: { ...rig.GUITAR_RIG_DEFAULTS, ...rig.guitarRigOrderParams(['tuner', 'amp', 'cabinet']), tunerEnabled: 1 } }]
      track.clips = [{ id: 'test-di', name: 'Synthetic guitar input', kind: 'audio', assetId: 'test-source', startBeat: 0, lengthBeats: 2, gain: 1, offsetSeconds: 0, fadeIn: 0, fadeOut: 0 }]
      project.tracks = [track]
      const engine = new WebAudioEngine(project)
      // A sustained open A string (110 Hz with two overtones): the tuner's job, not the noisy test DI above.
      const string = new AudioBuffer({ length: 48000, numberOfChannels: 1, sampleRate: 48000 }), samples = string.getChannelData(0)
      for (let i = 0; i < samples.length; i += 1) { const t = i / 48000; samples[i] = 0.2 * (Math.sin(2 * Math.PI * 110 * t) + 0.4 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 330 * t)) }
      engine.setAssets(new Map([['test-source', createAudioAsset('test-source', 'Open A string', encodeWav([samples], 48000, 32), string)]]))
      await engine.play()
      const deviceId = track.devices[0].id
      // Like the editor, read repeatedly: a window across the loop restart can misread, the median does not.
      const readings = []
      let master = 0
      for (let i = 0; i < 80 && readings.length < 9; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 50))
        master = Math.max(master, engine.getMasterLevel())
        const tap = rig.guitarTunerTap(deviceId)
        if (!tap) continue
        const buffer = new Float32Array(tap.analyser.fftSize)
        tap.analyser.getFloatTimeDomainData(buffer)
        const hz = rig.detectPitch(buffer, tap.sampleRate)
        if (hz) readings.push(hz)
      }
      engine.stop(); engine.dispose()
      readings.sort((x, y) => x - y)
      return { hz: readings.length ? readings[Math.floor(readings.length / 2)] : null, readings: readings.length, master }
    })()
    return {
      tuner: tunerReading,
      clean: { peak: clean.peak, rms: clean.rms, finite: clean.finite },
      micPositionDifference: difference(clean.values, edge.values),
      micTypeDifference: difference(clean.values, ribbon.values),
      micDistanceDifference: difference(clean.values, far.values),
      delayTail: stats(delayed.values.slice(36000)).rms,
      rate96: { peak: rate96.peak, rms: rate96.rms, finite: rate96.finite }, presets,
    }
  })
  assert(audio.clean.finite && audio.clean.rms > 0.001 && audio.rate96.finite && audio.rate96.rms > 0.001)
  for (const key of ['micPositionDifference', 'micTypeDifference', 'micDistanceDifference']) assert(audio[key] > 0.0001, `${key} must change the rendered signal`)
  assert(audio.delayTail > 0.001)
  assert(audio.tuner.hz && Math.abs(audio.tuner.hz - 110) < 1, `the tuner reads the 110 Hz input from the engine (${audio.tuner.hz})`)
  assert.equal(audio.tuner.master, 0, 'the engaged tuner mutes the rig')
  assert(audio.presets.every(preset => preset.finite && preset.rms > 0.001 && preset.peak < 4))
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ui: 'passed', fakeInputMonitoring: 'passed', persistence: 'passed', audio }, null, 2))
} finally {
  await browser?.close()
  await server.close()
}

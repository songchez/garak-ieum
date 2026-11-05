import assert from 'node:assert/strict'
import { verifyMidiImportUI } from './desktop-midi-ui-smoke.mjs'

/**
 * Real packaged UI + real native host. The caller launches with
 * GARAK_NATIVE_TEST_CLOCK=1; this does not validate physical WASAPI/ASIO/Core Audio.
 * No bridge, output API, file picker, or plugin processor is mocked here.
 */
export async function verifyNativeAudioUI(page, { screenshot } = {}) {
  const before = await page.evaluate(async () => ({
    platform: window.garakDesktop.platform,
    state: await window.garakDesktop.audio.request('engine.snapshot'),
  }))
  assert.equal(before.state.testClock, true, 'Native UI smoke requires the explicit test-clock harness')

  await page.locator('button.audio-status').click()
  const dialog = page.getByRole('dialog', { name: '설정', exact: true })
  await dialog.waitFor()
  const backend = dialog.getByRole('combobox', { name: '오디오 드라이버', exact: true })
  const choices = await backend.locator('option').evaluateAll(options => options.map(option => option.value))
  assert.deepEqual(choices, before.platform === 'darwin' ? ['coreaudio'] : ['wasapi', 'asio'])
  assert.equal(await backend.inputValue(), before.platform === 'darwin' ? 'coreaudio' : 'wasapi')
  if (!before.state.ready) {
    await dialog.getByRole('button', { name: '적용', exact: true }).click()
    await page.waitForFunction(async () => (await window.garakDesktop.audio.request('engine.snapshot')).ready === true)
    before.state = await page.evaluate(() => window.garakDesktop.audio.request('engine.snapshot'))
  }
  assert.equal(before.state.device?.backend, 'test')
  assert.equal(before.state.device?.testClock, true)
  assert.ok(before.state.ready, 'Native device settings did not start the real host')
  // The buffer list comes from the driver probe: its recommended value plus allowed sizes only.
  const buffer = dialog.getByRole('combobox', { name: '오디오 I/O 버퍼 크기', exact: true })
  assert.ok(await buffer.isVisible(), 'Native I/O buffer control is missing')
  const bufferValues = await buffer.locator('option').evaluateAll(options => options.map(option => option.value))
  assert.ok(bufferValues.includes('driver'), 'The driver-recommended buffer choice is missing')
  assert.ok(bufferValues.filter(value => value !== 'driver').every(value => Number(value) >= 16 && Number(value) <= 8192), 'Buffer choices escaped the driver range')
  assert.equal(await dialog.getByRole('combobox', { name: '오디오 출력 장치', exact: true }).count(), 1)
  assert.equal(await dialog.getByRole('button', { name: '입력 테스트', exact: true }).count(), 0, 'Desktop mounted the browser capture probe')

  await dialog.getByRole('button', { name: '상태·진단', exact: true }).click()
  await dialog.getByText('테스트 클록 · 하드웨어 미사용', { exact: true }).waitFor()
  const facts = await dialog.locator('.audio-settings-facts').innerText()
  assert.ok(facts.includes(`${before.state.device.bufferFrames} 프레임`), 'Actual native buffer was not displayed')
  assert.ok(facts.includes('드라이버 보고'), 'Driver latency was presented as a measured round trip')
  assert.ok(facts.includes('실제 레이트'))

  await dialog.getByRole('button', { name: '녹음·모니터링', exact: true }).click()
  assert.ok(await dialog.getByRole('checkbox', { name: /^저지연 모니터링/ }).isVisible())
  // Input channels moved to their own tab; the recording tab now measures a real loopback.
  assert.ok(await dialog.getByRole('combobox', { name: '측정 입력', exact: true }).isVisible(), 'Latency wizard input is missing')
  assert.ok(await dialog.getByRole('button', { name: /^측정 시작/ }).isVisible(), 'Latency wizard is missing')
  assert.ok(await dialog.getByRole('textbox', { name: '녹음 위치 보정 프레임', exact: true }).isVisible())
  assert.equal(await dialog.getByRole('checkbox', { name: /에코 제거|노이즈 제거|자동 게인/ }).count(), 0)

  await dialog.getByRole('button', { name: '입출력 채널', exact: true }).click()
  const channels = dialog.getByRole('group', { name: '입력 채널', exact: true })
  await channels.waitFor()
  assert.ok(await channels.getByRole('checkbox').count() >= 2, 'Probed input channels are not offered')
  assert.ok(await dialog.getByRole('textbox', { name: '입력 1 이름', exact: true }).isVisible(), 'Input channels cannot be renamed')

  await dialog.getByRole('button', { name: '오디오 장치', exact: true }).click()
  await dialog.getByRole('button', { name: '출력 테스트', exact: true }).click()
  await dialog.getByRole('button', { name: '테스트 중지', exact: true }).click({ timeout: 5000 })
  await dialog.getByRole('button', { name: '출력 테스트', exact: true }).waitFor()
  const afterTest = await page.evaluate(() => window.garakDesktop.audio.request('engine.snapshot'))
  assert.equal(afterTest.device.backend, 'test')
  assert.equal(afterTest.device.testClock, true)
  assert.equal(afterTest.device.inputChannels, 0, 'Output testing opened native microphone capture')
  assert.ok(afterTest.ready)
  await dialog.getByRole('button', { name: '설정 닫기', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })

  // The preceding desktop smoke starts from an empty project. Add a single
  // empty builtin MIDI track so the real device rack and VST controls mount.
  await page.getByRole('button', { name: '트랙 추가', exact: true }).click()
  const tracks = page.getByRole('dialog', { name: '새 트랙', exact: true })
  await tracks.getByRole('radio', { name: /^MIDI/ }).click()
  await tracks.getByRole('combobox', { name: '악기', exact: true }).selectOption('keys')
  await tracks.getByRole('checkbox', { name: '라이브러리 열기', exact: true }).uncheck()
  await tracks.getByRole('button', { name: '생성', exact: true }).click()
  await tracks.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '디바이스', exact: true }).click()
  const expand = page.getByRole('button', { name: '편집 영역 펼치기', exact: true })
  if (await expand.count()) await expand.click()
  // VST3 effects are added from the chain's own add card; registration lives in Settings › 플러그인.
  assert.ok(await page.getByRole('list', { name: /디바이스 체인$/ }).count())
  assert.equal(await page.getByRole('region', { name: 'VST3 플러그인', exact: true }).count(), 0, 'The separate VST3 panel came back')
  const pluginGroup = page.getByRole('group', { name: 'VST3 이펙트 추가', exact: true })
  const register = pluginGroup.getByRole('button', { name: /^(VST3 등록…|플러그인 관리…)$/ })
  await register.scrollIntoViewIfNeeded()
  assert.ok(await register.isVisible())
  await register.click()
  const pluginSettings = page.getByRole('dialog', { name: '설정', exact: true })
  const addPlugin = pluginSettings.getByRole('button', { name: 'VST3 파일 추가…', exact: true })
  await addPlugin.waitFor()
  const geometry = await addPlugin.boundingBox(), viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  assert.ok(geometry && geometry.width > 0 && geometry.x >= 0 && geometry.x + geometry.width <= viewport.width + 1, 'VST registration overflows the settings dialog')
  await pluginSettings.getByRole('button', { name: '설정 닫기', exact: true }).click()
  await pluginSettings.waitFor({ state: 'hidden' })

  const wave = await verifyWavetableUI(page, screenshot)
  const midi = await verifyMidiImportUI(page, { waveTrackId: wave.trackId, screenshot })
  return { backend: 'test', testClock: true, platform: before.platform, sampleRate: afterTest.sampleRate, bufferFrames: afterTest.device.bufferFrames, outputTestCanceled: true, vstPanelVisible: true, wave, midi }
}

/** Follow the real editor's bridge through Electron IPC into the native DSP. */
async function verifyWavetableUI(page, screenshot) {
  const previousTracks = await page.locator('.track-header[data-track-id]').evaluateAll(tracks => tracks.map(track => track.dataset.trackId))
  await page.getByRole('button', { name: '트랙 추가', exact: true }).click()
  const tracks = page.getByRole('dialog', { name: '새 트랙', exact: true })
  await tracks.getByRole('radio', { name: /^MIDI/ }).click()
  await tracks.getByRole('combobox', { name: '악기', exact: true }).selectOption('wavetable')
  await tracks.getByRole('checkbox', { name: '라이브러리 열기', exact: true }).uncheck()
  await tracks.getByRole('button', { name: '생성', exact: true }).click()
  await tracks.waitFor({ state: 'hidden' })
  const added = await page.locator('.track-header[data-track-id]').evaluateAll((tracks, previous) => tracks.map(track => track.dataset.trackId).filter(id => !previous.includes(id)), previousTracks)
  assert.equal(added.length, 1)
  const trackId = added[0]
  await page.getByRole('button', { name: '디바이스', exact: true }).click()
  await page.getByRole('button', { name: 'IEUM WAVE 편집기 열기', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'IEUM WAVE', exact: true })
  await editor.waitFor()
  const key = editor.getByRole('button', { name: 'C3 미리 듣기', exact: true })
  await page.waitForFunction(() => {
    const button = document.querySelector('.iw-keyboard button[aria-label="C3 미리 듣기"]')
    return button instanceof HTMLButtonElement && !button.disabled
  })
  const audible = () => page.waitForFunction(async id => {
    const state = await window.garakDesktop.audio.request('engine.snapshot')
    return state.playing === false && state.levels?.[id] > .005
  }, trackId)
  const released = () => page.waitForFunction(async id => {
    const state = await window.garakDesktop.audio.request('engine.snapshot')
    return state.playing === false && (state.levels?.[id] ?? 1) < .0001
  }, trackId)
  await key.focus(); await page.keyboard.down('Space')
  await audible()
  await screenshot?.('qa-native-wave-audible.png')
  await page.keyboard.up('Space'); await released()
  await editor.getByRole('combobox', { name: '프리셋 선택', exact: true }).selectOption('low-orbit')
  await page.waitForFunction(() => {
    const button = document.querySelector('.iw-keyboard button[aria-label="C3 미리 듣기"]')
    return button instanceof HTMLButtonElement && !button.disabled
  })
  await key.focus(); await page.keyboard.down('Space'); await audible()
  await editor.getByRole('button', { name: '이음 웨이브 닫기', exact: true }).click()
  await page.keyboard.up('Space')
  await editor.waitFor({ state: 'hidden' }); await released()
  return { trackId, nativeKeyboardAudible: true, presetApplied: true, releasedOnClose: true }
}

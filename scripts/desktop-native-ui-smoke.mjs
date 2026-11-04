import assert from 'node:assert/strict'

/**
 * Real packaged UI + real native host. The caller launches with
 * GARAK_NATIVE_TEST_CLOCK=1; this is deliberately not hardware-ASIO validation.
 * No bridge, output API, file picker, or plugin processor is mocked here.
 */
export async function verifyNativeAudioUI(page) {
  const before = await page.evaluate(async () => ({
    platform: window.garakDesktop.platform,
    state: await window.garakDesktop.audio.request('engine.snapshot'),
  }))
  assert.equal(before.state.testClock, true, 'Native UI smoke requires the explicit test-clock harness')
  assert.equal(before.state.device?.backend, 'test')
  assert.equal(before.state.device?.testClock, true)
  assert.ok(before.state.ready, 'Run native WAV export before native UI checks')

  await page.locator('button.audio-status').click()
  const dialog = page.getByRole('dialog', { name: '설정', exact: true })
  await dialog.waitFor()
  const backend = dialog.getByRole('combobox', { name: '오디오 드라이버', exact: true })
  const choices = await backend.locator('option').evaluateAll(options => options.map(option => option.value))
  assert.deepEqual(choices, before.platform === 'darwin' ? ['coreaudio'] : ['wasapi', 'asio'])
  assert.equal(await backend.inputValue(), before.platform === 'darwin' ? 'coreaudio' : 'wasapi')
  const buffer = dialog.getByRole('spinbutton', { name: '오디오 I/O 버퍼 크기', exact: true })
  assert.ok(await buffer.isVisible(), 'Native I/O buffer control is missing')
  assert.ok(Number(await buffer.inputValue()) >= 16)
  assert.equal(await buffer.getAttribute('max'), '8192')
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
  assert.ok(await dialog.getByRole('spinbutton', { name: '첫 번째 물리 입력', exact: true }).isVisible())
  assert.ok(await dialog.getByText(/물리 왕복을 측정한 값은 아니며/).isVisible())
  assert.equal(await dialog.getByRole('checkbox', { name: /에코 제거|노이즈 제거|자동 게인/ }).count(), 0)

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
  const panel = page.getByRole('region', { name: 'VST3 플러그인', exact: true })
  const addPlugin = panel.getByRole('button', { name: 'VST3 파일 추가…', exact: true })
  await addPlugin.scrollIntoViewIfNeeded()
  assert.ok(await addPlugin.isVisible())
  assert.ok(await panel.getByRole('combobox', { name: '설치된 VST3 플러그인', exact: true }).isVisible())
  assert.equal(await panel.getByRole('button', { name: '트랙에 추가', exact: true }).isDisabled(), true)
  assert.ok(await page.getByRole('list', { name: /디바이스 체인$/ }).count())
  const geometry = await addPlugin.boundingBox(), viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  assert.ok(geometry && geometry.width > 0 && geometry.x >= 0 && geometry.x + geometry.width <= viewport.width + 1, 'VST controls overflow the device panel')

  return { backend: 'test', testClock: true, platform: before.platform, sampleRate: afterTest.sampleRate, bufferFrames: afterTest.device.bufferFrames, outputTestCanceled: true, vstPanelVisible: true }
}

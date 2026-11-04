// Browser project/editor workflow. The desktop's WAVE audio capability is
// verified by native-smoke; a browser must continue to gate native-only playback.
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
    args: JSON.parse(process.env.GARAK_CHROMIUM_ARGS || '[]'),
  })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    window.__waveAudioRequests = 0
    const OriginalAudioContext = window.AudioContext
    window.AudioContext = new Proxy(OriginalAudioContext, { construct(target, args) {
      window.__waveAudioRequests += 1
      return Reflect.construct(target, args)
    } })
  })
  await page.goto(server.resolvedUrls.local[0])
  await page.getByRole('button', { name: '새 빈 프로젝트', exact: true }).click()
  await page.getByRole('button', { name: '트랙 추가', exact: true }).click()
  await page.getByRole('dialog', { name: '새 트랙', exact: true }).getByRole('combobox', { name: '악기', exact: true }).selectOption('wavetable')
  await page.getByRole('button', { name: '생성', exact: true }).click()
  await page.getByRole('button', { name: '디바이스', exact: true }).click()
  const open = page.getByRole('button', { name: 'IEUM WAVE 편집기 열기', exact: true })
  await open.click()
  const editor = page.getByRole('dialog', { name: 'IEUM WAVE', exact: true })
  await editor.waitFor()
  assert.match(await editor.locator('.iw-engine-status').innerText(), /네이티브.*연결/)
  assert.equal(await editor.locator('.iw-keyboard button:not(:disabled)').count(), 0)
  assert.equal(await page.evaluate(() => window.__waveAudioRequests), 0)

  const position = editor.getByRole('slider', { name: 'OSC 1 · 프레임', exact: true })
  const initial = Number(await position.getAttribute('aria-valuenow'))
  await position.press('ArrowUp')
  const coarse = Number(await position.getAttribute('aria-valuenow'))
  await position.press('Shift+ArrowUp')
  const fine = Number(await position.getAttribute('aria-valuenow'))
  assert(coarse > initial && fine > coarse && fine - coarse < coarse - initial)
  await position.press('Control+z')
  await page.waitForFunction(value => Number(document.querySelector('[role="slider"][aria-label="OSC 1 · 프레임"]')?.getAttribute('aria-valuenow')) === value, coarse)

  const preset = editor.getByRole('combobox', { name: '프리셋 선택', exact: true })
  await preset.selectOption('warm-loft')
  assert.equal(await preset.inputValue(), 'warm-loft')
  await preset.press('Control+z')
  await page.waitForFunction(value => Number(document.querySelector('[role="slider"][aria-label="OSC 1 · 프레임"]')?.getAttribute('aria-valuenow')) === value, coarse)

  await editor.getByRole('tab', { name: /변조/ }).click()
  await editor.getByRole('combobox', { name: '새 변조 소스', exact: true }).selectOption('lfo1')
  await editor.getByRole('combobox', { name: '새 변조 대상', exact: true }).selectOption('osc1Position')
  await editor.getByRole('button', { name: '+ 연결 추가', exact: true }).click()
  assert.equal(await editor.locator('.iw-route').count(), 1)
  await editor.getByRole('combobox', { name: '1번 보조 변조 소스', exact: true }).selectOption('macro1')

  await editor.getByRole('tab', { name: /파형 편집/ }).click()
  await editor.getByRole('button', { name: '사용자 슬롯에 복사', exact: true }).click()
  await editor.getByRole('textbox', { name: '사용자 웨이브테이블 이름', exact: true }).fill('Smoke custom wave')
  await editor.getByRole('textbox', { name: '사용자 웨이브테이블 이름', exact: true }).press('Enter')
  await editor.getByRole('button', { name: '상하 반전', exact: true }).click()
  await editor.getByRole('button', { name: '+ 프레임 복제', exact: true }).click()
  await editor.getByRole('button', { name: '이음 웨이브 닫기', exact: true }).press('Control+s')
  await page.waitForFunction(async () => {
    const { loadProject } = await import('/src/core/storage.ts')
    const track = (await loadProject())?.project.tracks[0]
    return track?.instrument === 'wavetable' && track.instrumentParams.osc1Bank === 4
      && track.instrumentState?.customBanks[0]?.name === 'Smoke custom wave'
      && track.instrumentState.customBanks[0].frames.length === 9
      && track.instrumentState.routes[0]?.aux === 'macro1'
  })

  for (const [width, height] of [[768, 1024], [390, 844]]) {
    await page.setViewportSize({ width, height })
    await editor.getByRole('tab', { name: /음원/ }).click()
    assert(await editor.evaluate(element => element.scrollWidth <= element.clientWidth + 1), `Editor must fit ${width}px`)
    await editor.getByRole('tab', { name: /변조/ }).click()
    assert(await editor.evaluate(element => element.scrollWidth <= element.clientWidth + 1), `Matrix must fit ${width}px`)
    await editor.getByRole('tab', { name: /파형 편집/ }).click()
    assert(await editor.evaluate(element => element.scrollWidth <= element.clientWidth + 1), `Wave editor must fit ${width}px`)
  }
  await page.setViewportSize({ width: 1440, height: 1000 })

  await editor.getByRole('button', { name: '이음 웨이브 닫기', exact: true }).click()
  assert.equal(await open.evaluate(element => element === document.activeElement), true, 'Focus must return to the opener')
  await page.reload()
  await page.getByRole('button', { name: '디바이스', exact: true }).click()
  await page.getByRole('button', { name: 'IEUM WAVE 편집기 열기', exact: true }).click()
  await editor.getByRole('tab', { name: /파형 편집/ }).click()
  assert.equal(await editor.getByRole('textbox', { name: '사용자 웨이브테이블 이름', exact: true }).inputValue(), 'Smoke custom wave')
  assert.equal(await editor.locator('.iw-frame-strip button').count(), 9)
  await editor.getByRole('tab', { name: /변조/ }).click()
  assert.equal(await editor.getByRole('combobox', { name: '1번 보조 변조 소스', exact: true }).inputValue(), 'macro1')
  assert.equal(await page.evaluate(() => window.__waveAudioRequests), 0)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ editor: 'IEUM WAVE', projectRoundTrip: true, undo: true, customFrames: 9, modulationAux: true, nativePreviewGated: true, pageErrors: errors }, null, 2))
} finally {
  await browser?.close()
  await server.close()
}

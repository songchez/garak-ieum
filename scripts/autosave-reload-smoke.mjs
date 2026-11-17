// Browser regression: device edits made right before a reload must survive it.
// The guitar rig flow that lost them: pick a preset, move the mic (key gesture), change the mic, stomp a pedal,
// then reload inside the autosave quiet period. The page-hide / beforeunload flush (src/App.tsx, core/autosave.ts)
// must write the latest snapshot before the document goes away.
// Run with `pnpm autosave:smoke`; a preinstalled browser can be selected with GARAK_CHROMIUM_EXECUTABLE and a JSON
// array in GARAK_CHROMIUM_ARGS.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 4176, hmr: false } })
await server.listen()
let browser
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.GARAK_CHROMIUM_EXECUTABLE ? { executablePath: process.env.GARAK_CHROMIUM_EXECUTABLE } : {}),
    args: JSON.parse(process.env.GARAK_CHROMIUM_ARGS || '[]'),
  })
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  // "Leave anyway" on the unsaved-changes prompt, as a user who reloads regardless.
  page.on('dialog', dialog => dialog.accept())
  await page.goto(server.resolvedUrls.local[0])
  await page.getByRole('button', { name: '새 빈 프로젝트', exact: true }).click()
  await page.getByRole('button', { name: '트랙 추가', exact: true }).click()
  await page.getByRole('radio', { name: '기타 앰프 · 컴프 · 이펙터', exact: true }).click()
  await page.getByRole('button', { name: '생성', exact: true }).click()
  await page.getByRole('button', { name: '기타 앰프 편집기 열기', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '기타 앰프', exact: true })
  await editor.waitFor()
  // Let the new project's first autosave land, so the reload below can only be served by the flush.
  await page.waitForTimeout(1500)

  await editor.getByRole('button', { name: /^기타 앰프 프리셋:/ }).click()
  await page.getByRole('dialog', { name: '프리셋 고르기' }).getByRole('option', { name: /Wide Clean/ }).click()
  const mic = editor.getByRole('combobox', { name: '마이크', exact: true })
  const position = editor.getByRole('slider', { name: '마이크 위치', exact: true })
  assert.equal(await mic.inputValue(), '2', 'Wide Clean uses the third microphone')
  await position.press('End')
  await mic.selectOption('3')
  const chorus = editor.getByRole('button', { name: /^Blue Ripple 페달 켜기\/바이패스$/ })
  assert.equal(await chorus.getAttribute('aria-pressed'), 'true')
  await chorus.click()
  const before = await page.evaluate(async () => {
    const { loadProject } = await import('/src/core/storage.ts')
    return (await loadProject())?.project.tracks[0]?.devices[0]?.params.micType
  })

  await page.reload()
  await page.getByRole('button', { name: '시김새 체인', exact: true }).click()
  await page.getByRole('button', { name: '기타 앰프 편집기 열기', exact: true }).click()
  await editor.waitFor()
  const after = {
    position: await position.inputValue(),
    mic: await mic.inputValue(),
    chorus: await editor.getByRole('button', { name: /^Blue Ripple 페달 켜기\/바이패스$/ }).getAttribute('aria-pressed'),
  }
  assert.deepEqual(after, { position: '1', mic: '3', chorus: 'false' }, 'Edits made just before the reload must be restored')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ storedBeforeReload: { micType: before }, restored: after }, null, 2))
} finally {
  await browser?.close()
  await server.close()
}

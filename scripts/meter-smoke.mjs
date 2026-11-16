// Browser smoke for time-signature changes (docs/METER_MAP.md): the 박자 global track and the ruler.
// Adds a 7/8 change by double-click, checks the ruler's bar lines, undoes/redoes it, drags it along bars,
// edits it in the popover and deletes it, each as one undo step.
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(server.resolvedUrls.local[0])
  await page.getByRole('button', { name: '새 빈 프로젝트', exact: true }).click()
  const global = page.getByRole('button', { name: '글로벌 트랙 보기', exact: true })
  if (await global.getAttribute('aria-pressed') !== 'true') await global.click()
  const lane = page.locator('.meter-lane')
  await lane.waitFor()
  const changes = lane.locator('.meter-change')
  assert.equal(await changes.count(), 1)
  assert.equal(await changes.first().innerText(), '4/4')

  /** Left edge (viewport x) of the ruler's bar line with this label. */
  const barX = async label => {
    const box = await page.locator('.timeline-ruler-mark--bar', { has: page.locator(`span:text-is("${label}")`) }).first().boundingBox()
    assert(box, `ruler bar ${label} is not drawn`)
    return box.x
  }
  const [bar1, bar2, bar3] = [await barX('1'), await barX('2'), await barX('3')]
  const quarter = (bar2 - bar1) / 4
  const laneBox = await lane.boundingBox()
  const y = laneBox.y + laneBox.height / 2

  // Double-click near bar 3 opens the editor for a change at bar 3; a preset commits it.
  await page.mouse.dblclick(bar3 + 3, y)
  const editor = page.getByRole('dialog', { name: '3마디 박자', exact: true })
  await editor.waitFor()
  await editor.getByRole('button', { name: '7/8', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.meter-lane .meter-change').length === 2)
  assert.equal(await changes.nth(1).innerText(), '7/8')
  assert.equal(await changes.nth(1).getAttribute('aria-label'), '박자 7/8, 3마디')
  // Bar 3 is a 7/8 bar (3.5 quarters); bar 4 onwards keep 7/8.
  assert(Math.abs(await barX('4') - (bar3 + 3.5 * quarter)) < 1.5, 'the ruler does not follow the 7/8 bar')
  assert(Math.abs(await barX('5') - (bar3 + 7 * quarter)) < 1.5, 'later bars do not keep the new meter')
  if (process.env.GARAK_METER_SCREENSHOT) await page.screenshot({ path: process.env.GARAK_METER_SCREENSHOT, clip: { x: 0, y: 0, width: 1440, height: 420 } })

  // One undo step per gesture.
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => document.querySelectorAll('.meter-lane .meter-change').length === 1)
  assert(Math.abs(await barX('4') - (bar3 + 4 * quarter)) < 1.5, 'undo did not restore 4/4 bar lines')
  await page.keyboard.press('Control+Shift+z')
  await page.waitForFunction(() => document.querySelectorAll('.meter-lane .meter-change').length === 2)

  // Drag the change two bars to the right (4/4 bars before it): it lands on bar 5.
  const change = changes.nth(1)
  const box = await change.boundingBox()
  await page.mouse.move(box.x + 4, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 4 + quarter * 4, box.y + box.height / 2, { steps: 4 })
  await page.mouse.move(box.x + 4 + quarter * 8, box.y + box.height / 2, { steps: 4 })
  await page.mouse.up()
  await page.waitForFunction(() => document.querySelectorAll('.meter-lane .meter-change')[1]?.getAttribute('aria-label') === '박자 7/8, 5마디')
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => document.querySelectorAll('.meter-lane .meter-change')[1]?.getAttribute('aria-label') === '박자 7/8, 3마디')

  // Edit in the popover: numerator/denominator.
  await changes.nth(1).dblclick()
  const edit = page.getByRole('dialog', { name: '3마디 박자', exact: true })
  await edit.getByRole('spinbutton', { name: '박자표 분자', exact: true }).fill('5')
  await edit.getByRole('combobox', { name: '박자표 분모', exact: true }).selectOption('4')
  await edit.getByRole('button', { name: '확인', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.meter-lane .meter-change')[1]?.textContent === '5/4')
  assert(Math.abs(await barX('4') - (bar3 + 5 * quarter)) < 1.5, 'the ruler does not follow the edited 5/4 bar')

  // Delete from the keyboard.
  await changes.nth(1).focus()
  await page.keyboard.press('Delete')
  await page.waitForFunction(() => document.querySelectorAll('.meter-lane .meter-change').length === 1)
  assert.deepEqual(errors, [])
  console.log('meter smoke passed')
} finally {
  await browser?.close()
  await server.close()
}

// Piano-roll lane pane: the splitter between the note grid and the velocity/pedal/controller lanes, lane
// collapse, and the default heights at 1280×720 and 1920×1080 in a dark and a light theme.
// Usage: node scripts/piano-lanes-smoke.mjs [screenshot-dir]
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const shotDir = process.argv[2]
if (shotDir) mkdirSync(shotDir, { recursive: true })
const STORAGE_KEY = 'garak-ieum:piano-lanes'
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 4176, hmr: false } })
await server.listen()
let browser
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.GARAK_CHROMIUM_EXECUTABLE ? { executablePath: process.env.GARAK_CHROMIUM_EXECUTABLE } : {}),
    args: JSON.parse(process.env.GARAK_CHROMIUM_ARGS || '[]'),
  })
  for (const [width, height] of [[1280, 720], [1920, 1080]]) for (const theme of ['dawn-hanok', 'porcelain']) {
    const context = await browser.newContext({ viewport: { width, height } })
    await context.addInitScript(id => { try { localStorage.clear(); localStorage.setItem('garak-ieum:theme:v1', id) } catch { /* storage blocked */ } }, theme)
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(server.resolvedUrls.local[0])
    await page.getByRole('button', { name: '새 빈 프로젝트', exact: true }).click()
    await page.getByRole('button', { name: '트랙 추가', exact: true }).click()
    await page.getByRole('button', { name: '생성', exact: true }).click()
    await page.getByRole('button', { name: /MIDI 클립 만들기/ }).click()
    const roll = page.locator('.piano-roll')
    await roll.waitFor()
    const splitter = roll.getByRole('separator', { name: '음표 영역과 레인 사이 크기 조절' })
    await splitter.waitFor()

    const measure = () => page.evaluate(() => {
      const rect = selector => document.querySelector(selector)?.getBoundingClientRect()
      const scroll = rect('.piano-scroll'), ruler = rect('.piano-ruler'), bar = rect('.piano-lane-splitter'), velocity = rect('.piano-velocity-lane')
      return {
        // What the note grid shows between the ruler and the splitter.
        grid: Math.round(bar.top - ruler.bottom),
        velocity: velocity ? Math.round(velocity.height) : 0,
        lanes: [...document.querySelectorAll('.piano-lane-slot')].map(el => Math.round(el.getBoundingClientRect().height)),
        scroll: Math.round(scroll.height),
        now: Number(document.querySelector('.piano-lane-splitter').getAttribute('aria-valuenow')),
      }
    })
    const initial = await measure()
    console.log(`${width}x${height} ${theme}`, JSON.stringify(initial))
    assert(initial.velocity >= 64, `velocity lane is usable by default (${initial.velocity}px)`)
    assert(initial.grid >= 3 * 19 - 1, `note grid keeps three rows by default (${initial.grid}px)`)

    // A few notes (and later a modulation lane) so the screenshots show real content.
    const grid = roll.locator('.piano-grid')
    const box = await grid.boundingBox()
    const scrollBox = await roll.locator('.piano-scroll').boundingBox()
    const y = Math.max(box.y, scrollBox.y + 30) + 8
    for (const [index, x] of [0.04, 0.16, 0.3, 0.45].entries()) await page.mouse.click(scrollBox.x + 70 + x * (scrollBox.width - 70), y + (index % 2) * 19)

    if (width === 1280 && theme === 'dawn-hanok') {
      const auto = Number(await splitter.getAttribute('aria-valuenow'))
      const max = Number(await splitter.getAttribute('aria-valuemax'))
      const min = Number(await splitter.getAttribute('aria-valuemin'))
      assert(min < max, `splitter has a range (${min}..${max})`)
      // Keyboard: arrows move by 8 px, Home is the minimum, Enter resets.
      await splitter.focus()
      await page.keyboard.press('Home')
      assert.equal(Number(await splitter.getAttribute('aria-valuenow')), min)
      await page.keyboard.press('ArrowUp')
      assert.equal(Number(await splitter.getAttribute('aria-valuenow')), min + 8)
      assert.equal(JSON.parse(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).height, min + 8)
      await page.keyboard.press('Enter')
      assert.equal(Number(await splitter.getAttribute('aria-valuenow')), auto)
      // Pointer drag down shrinks the lanes, double-click restores the default.
      const bar = await splitter.boundingBox()
      await page.mouse.move(bar.x + bar.width / 2, bar.y + 2)
      await page.mouse.down()
      await page.mouse.move(bar.x + bar.width / 2, bar.y + 22, { steps: 4 })
      await page.mouse.up()
      const dragged = Number(await splitter.getAttribute('aria-valuenow'))
      assert.equal(dragged, Math.max(min, auto - 20))
      assert.equal(JSON.parse(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).height, dragged)
      await splitter.dblclick()
      assert.equal(Number(await splitter.getAttribute('aria-valuenow')), auto)
      // Collapsing the pedal lane gives its room to the others; expanding brings it back.
      await roll.getByRole('button', { name: '서스테인 레인 접기' }).click()
      assert.equal(await roll.locator('.piano-lane-strip').count(), 1)
      assert.deepEqual(JSON.parse(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).collapsed, ['sustain'])
      if (shotDir) await page.screenshot({ path: join(shotDir, `piano-lanes-${width}x${height}-${theme}-collapsed.png`) })
      await roll.getByRole('button', { name: '서스테인 레인 펼치기' }).click()
      assert.equal(await roll.locator('.piano-lane-strip').count(), 0)
    }
    // The pane keeps the grid's last row even with three lanes stacked.
    await roll.getByRole('button', { name: '+ 레인' }).click()
    await page.getByRole('menuitemradio', { name: '모듈레이션 (CC1)' }).click()
    if (shotDir) await page.screenshot({ path: join(shotDir, `piano-lanes-${width}x${height}-${theme}.png`) })
    const stacked = await measure()
    assert(stacked.grid >= 19, `note grid stays visible with three lanes (${stacked.grid}px)`)
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log('piano lanes smoke passed')
} finally {
  await browser?.close()
  await server.close()
}

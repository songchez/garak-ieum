import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'

// Run against the packaged application, with normal sandbox/security settings.
// Native dialogs are stubbed only through Playwright's Electron main context;
// the product contains no automation-only IPC or filesystem access.
const repository = fileURLToPath(new URL('../', import.meta.url))
const artifacts = path.join(repository, 'release', 'desktop-smoke')
const defaultExecutable = process.platform === 'darwin'
  ? path.join(repository, 'release', 'mac-arm64', '가락이음.app', 'Contents', 'MacOS', '가락이음')
  : path.join(repository, 'release', 'win-unpacked', '가락이음.exe')
const executable = process.env.GARAK_ELECTRON_EXECUTABLE
  ? path.resolve(process.env.GARAK_ELECTRON_EXECUTABLE)
  : defaultExecutable
// Windows MCP must use the installed console launcher, not the GUI subsystem's
// stdout/stdin handles. The launcher alone configures its child Node runtime.
const mcpExecutable = process.platform === 'win32' ? path.join(path.dirname(executable), 'garak-mcp.exe') : executable
const macInstalledSmoke = process.platform === 'darwin' && Boolean(process.env.GARAK_MAC_APP_BUNDLE)
const closeTimeout = 30_000 // Main waits 12 seconds before its recovery dialog.
const dialogMarker = 'GARAK_SMOKE_UNEXPECTED_NATIVE_DIALOG'
const report = { status: 'running', startedAt: new Date().toISOString(), executable, mcpExecutable, checks: [], artifacts: [], launches: [], cli: [] }
let profile, session, phase = 'setup'

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function within(promise, milliseconds, description) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} timed out after ${milliseconds}ms`)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}
async function eventually(description, predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(100)
  }
  throw new Error(`${description} did not become true within ${timeout}ms`)
}
async function valueIs(locator, expected) {
  await eventually(`input value ${JSON.stringify(expected)}`, async () => await locator.inputValue() === expected)
}
function readRpcResponses(output) {
  const lines = output.split('\n'), remainder = lines.pop()
  const responses = lines.map(line => {
    let message
    try { message = JSON.parse(line) }
    catch { throw new Error('MCP stdout contained a blank or non-JSON protocol line') }
    assert.ok(message && !Array.isArray(message) && message.jsonrpc === '2.0' && Number.isInteger(message.id), 'Invalid JSON-RPC response envelope')
    return message
  })
  return { responses, remainder }
}
async function checked(name, action) {
  phase = name
  const began = Date.now()
  try {
    await action()
    if (session) {
      assert.deepEqual(session.rendererErrors, [], 'Unexpected uncaught renderer errors')
      assert.equal(session.unexpectedDialog, false, 'A native recovery/error dialog appeared')
      if (session.dialogs) assert.deepEqual(await session.dialogs.evaluate(state => state.messages), [], 'A native recovery/error dialog appeared')
    }
    report.checks.push({ name, status: 'passed', durationMs: Date.now() - began })
    console.log(`PASS ${name}`)
  } catch (error) {
    report.checks.push({ name, status: 'failed', durationMs: Date.now() - began, error: String(error) })
    throw error
  }
}
async function independentChecked(name, action) {
  try { await checked(name, action) }
  catch { console.error(`FAIL ${name}; continuing independent smoke checks`) }
}

function launchEnvironment(overrides = {}) {
  // Never inherit a developer's real bridge token into the smoke processes.
  const excluded = new Set(['ELECTRON_RUN_AS_NODE', 'GARAK_MCP_TOKEN', 'GARAK_MCP_PORT', 'GARAK_DESKTOP_TEST_PROFILE'])
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => !excluded.has(key.toUpperCase()) && typeof value === 'string'))
  return { ...environment, GARAK_DESKTOP_TEST_PROFILE: profile, ...overrides }
}
async function freeLoopbackPort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}
async function runCli(label, args, environment = {}, readyText, whileRunning) {
  return runProcess(mcpExecutable, label, args, environment, readyText, whileRunning)
}
async function runProcess(executablePath, label, args, environment = {}, readyText, whileRunning) {
  const began = Date.now()
  const child = spawn(executablePath, args, { cwd: repository, env: launchEnvironment(environment), stdio: 'pipe', windowsHide: true })
  const entry = { label, executable: executablePath, args, spawned: false, parentClosedStdin: false }
  report.cli.push(entry)
  child.once('spawn', () => { entry.spawned = true; entry.pid = child.pid })
  let stdout = '', stderr = '', outputBytes = 0, overflow = false, ready
  const started = new Promise(resolve => { ready = resolve })
  const closed = new Promise((resolve, reject) => {
    child.once('error', error => { entry.processErrorCode = error.code ?? error.name; reject(error) })
    child.once('close', (code, signal) => { Object.assign(entry, { code, signal }); resolve({ code, signal }) })
  })
  // An early configuration failure may close stdin first; retain safe diagnostics.
  child.stdin.on('error', error => { entry.stdinErrorCode = error.code ?? error.name })
  child.stdout.setEncoding('utf8').on('data', data => {
    outputBytes += Buffer.byteLength(data)
    if (outputBytes <= 65_536) stdout += data
    else { overflow = true; child.kill() }
  })
  child.stderr.setEncoding('utf8').on('data', data => {
    outputBytes += Buffer.byteLength(data)
    if (outputBytes <= 65_536) stderr += data
    else { overflow = true; child.kill() }
    if (readyText && stderr.includes(readyText)) ready()
  })
  try {
    if (readyText) {
      await within(Promise.race([started, closed.then(() => { throw new Error(`${label} exited before MCP became ready`) })]), 15_000, `${label} startup`)
    }
    if (whileRunning) {
      const io = {
        stdout: () => stdout,
        sendJson: message => new Promise((resolve, reject) => {
          child.stdin.write(`${JSON.stringify(message)}\n`, error => error ? reject(error) : resolve())
        }),
      }
      await within(Promise.race([whileRunning(io), closed.then(() => { throw new Error(`${label} exited during its smoke interaction`) })]), 30_000, `${label} interaction`)
    }
    entry.parentClosedStdin = true
    child.stdin.end()
    const result = await within(closed, 15_000, `${label} exit`)
    Object.assign(entry, result)
    assert.equal(overflow, false, `${label} exceeded the output limit`)
    return { ...result, stdout, stderr }
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill()
      await within(closed.catch(() => {}), 5000, `${label} cleanup`).catch(() => {})
      entry.cleanupTerminatedTestProcess = true
    }
    entry.durationMs = Date.now() - began
    // Generated token stdout must never reach reports, assertions, or CI logs.
    entry.stdoutBytes = Buffer.byteLength(stdout)
    entry.stdoutLayout = {
      characters: stdout.length,
      trimmedCharacters: stdout.trim().length,
      whitespaceCodePoints: [...stdout].filter(character => /\s/u.test(character)).slice(0, 64).map(character => character.codePointAt(0)),
    }
    entry.stderr = stderr.replace(/[A-Za-z0-9_-]{32,256}/g, '[redacted-token-like-value]').slice(0, 8000)
  }
}

async function launch(label) {
  const application = await _electron.launch({ executablePath: executable, args: [], cwd: repository, env: launchEnvironment(), timeout: 30_000 })
  let reportDialog
  const running = {
    application, label, page: null, dialogs: null, rendererErrors: [], logs: [], unexpectedDialog: false,
    dialogDetected: new Promise(resolve => { reportDialog = resolve }),
  }
  session = running // Ensure failures during startup still terminate this test process.
  report.launches.push({ label, rendererErrors: running.rendererErrors })
  const log = (source, text) => {
    const message = String(text)
    running.logs.push({ source, text: message.slice(0, 8000) })
    if (running.logs.length > 1000) running.logs.shift()
    if (message.includes(dialogMarker)) {
      running.unexpectedDialog = true
      reportDialog(message)
    }
  }
  const processHandle = application.process()
  processHandle.stdout?.on('data', data => log('main stdout', data))
  processHandle.stderr?.on('data', data => log('main stderr', data))
  const page = await application.firstWindow({ timeout: 30_000 })
  running.page = page
  page.setDefaultTimeout(15_000)
  page.on('pageerror', error => { running.rendererErrors.push(String(error)); log('renderer error', error) })
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') log(`renderer ${message.type()}`, message.text()) })
  await page.waitForURL('garak://app/', { timeout: 30_000 })
  await page.getByRole('button', { name: '새 빈 프로젝트', exact: true }).waitFor({ state: 'visible' })

  const details = await application.evaluate(({ app, BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
    return { packaged: app.isPackaged, userData: app.getPath('userData'), version: app.getVersion(),
      preferences: { nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation, sandbox: preferences.sandbox, webSecurity: preferences.webSecurity } }
  })
  assert.equal(details.packaged, true, 'This smoke test must run the packaged app')
  assert.equal(path.resolve(details.userData).toLowerCase(), path.resolve(profile).toLowerCase(), 'App ignored the isolated test profile')
  assert.deepEqual(details.preferences, { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true })
  report.launches.at(-1).details = details

  running.dialogs = await application.evaluateHandle(({ dialog }, marker) => {
    const state = { save: { canceled: true }, open: { canceled: true, filePaths: [] }, saveCalls: 0, openCalls: 0, messages: [] }
    dialog.showSaveDialog = async () => { state.saveCalls++; return { ...state.save } }
    dialog.showOpenDialog = async () => { state.openCalls++; return { ...state.open } }
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1)
      state.messages.push({ title: options.title, message: options.message, buttons: options.buttons })
      console.error(marker, JSON.stringify(state.messages.at(-1)))
      const cancel = Number.isInteger(options.cancelId) ? options.cancelId : (options.buttons ?? []).findIndex(button => /취소|cancel|계속 기다리기/i.test(button))
      if (cancel < 0) throw new Error('Unexpected native message box has no cancel action')
      return { response: cancel, checkboxChecked: false }
    }
    return state
  }, dialogMarker)
  return running
}

async function nativeMenu(id) {
  await session.application.evaluate(({ Menu, BrowserWindow }, commandId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(commandId)
    if (!item || !item.enabled || typeof item.click !== 'function') throw new Error(`Menu item unavailable: ${commandId}`)
    item.click(item, BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0], {})
  }, id)
}
async function macShortcut(key, shift = false) {
  // Send Electron key input rather than Playwright's browser editing-command
  // shortcuts, so native menu dispatch and before-input-event both participate.
  await session.application.evaluate(({ BrowserWindow }, chord) => {
    const window = BrowserWindow.getAllWindows().find(candidate => !candidate.webContents.getURL().startsWith('garak://app/licenses/'))
    if (!window) throw new Error('No editor window for the macOS shortcut check.')
    window.focus(); window.webContents.focus()
    const modifiers = chord.shift ? ['meta', 'shift'] : ['meta']
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: chord.key, modifiers })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: chord.key, modifiers })
  }, { key, shift })
}
async function pasteWithMacClipboard(locator, value) {
  // The installation step only sets this path in a disposable hosted Mac.
  // Never overwrite a developer's clipboard during a local unpacked smoke.
  assert.ok(macInstalledSmoke && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted')
  await session.application.evaluate(({ clipboard }, text) => clipboard.writeText(text), value)
  try {
    await locator.focus()
    await macShortcut('A')
    await macShortcut('V')
    // Avoid including MCP keys in assertion output or locator timeout messages.
    await eventually('native macOS clipboard paste into the text field', async () => await locator.inputValue() === value)
  } finally {
    await session.application.evaluate(({ clipboard }) => clipboard.clear())
  }
}
async function screenshot(name, width = 1280, height = 900) {
  const windowHandle = await session.application.browserWindow(session.page)
  await windowHandle.evaluate((window, size) => window.setContentSize(size.width, size.height), { width, height })
  await session.page.waitForFunction(size => innerWidth === size.width && innerHeight === size.height, { width, height })
  await session.page.screenshot({ path: path.join(artifacts, name) })
  report.artifacts.push(name)
}
async function saveLogs(running) {
  const file = `${running.label}-logs.json`
  await writeFile(path.join(artifacts, file), JSON.stringify(running.logs, null, 2))
  if (!report.artifacts.includes(file)) report.artifacts.push(file)
}
async function closeNormally() {
  const running = session, child = running.application.process()
  const processClosed = new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode })
    else child.once('close', (code, signal) => resolve({ code, signal }))
  })
  const closed = running.application.waitForEvent('close', { timeout: closeTimeout })
  await running.application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) throw new Error('No application window to close')
    // Return from evaluation before normal window-close IPC can destroy the context.
    setTimeout(() => window.close(), 0)
  })
  await Promise.race([closed, running.dialogDetected.then(message => { throw new Error(message) })])
  const exit = await within(processClosed, closeTimeout, 'Electron process exit')
  assert.equal(exit.code, 0, `Electron exited unexpectedly: ${JSON.stringify(exit)}`)
  assert.equal(running.unexpectedDialog, false, 'A close recovery dialog appeared')
  assert.deepEqual(running.rendererErrors, [], 'Unexpected uncaught renderer errors')
  await saveLogs(running)
  session = null
}

try {
  await mkdir(artifacts, { recursive: true })
  await access(executable)
  if (!['win32', 'darwin'].includes(process.platform) && !process.env.GARAK_ELECTRON_EXECUTABLE) throw new Error('Run the packaged smoke on Windows or macOS, or set GARAK_ELECTRON_EXECUTABLE to a compatible packaged app.')
  if (process.env.ELECTRON_DISABLE_SANDBOX) throw new Error('Remove ELECTRON_DISABLE_SANDBOX before testing the packaged app.')
  profile = await mkdtemp(path.join(tmpdir(), 'garak-desktop-smoke-'))
  report.profile = profile
  const projectName = `Desktop smoke ${Date.now()}`
  const projectFile = path.join(artifacts, 'smoke project.garak')
  const wavFile = path.join(artifacts, 'smoke-audio.wav')

  await independentChecked('packaged MCP token generation', async () => {
    const result = await runCli('token generation', ['--mcp-token'])
    assert.equal(result.code, 0, 'Packaged token CLI failed')
    assert.ok(/^[A-Za-z0-9_-]{43}$/.test(result.stdout.trim()), 'Token CLI must emit exactly one 43-character base64url token value')
  })
  await independentChecked('packaged MCP missing and invalid token validation', async () => {
    for (const token of [undefined, 'desktop-smoke-invalid-token!']) {
      const result = await runCli(token === undefined ? 'missing token' : 'invalid token', ['--mcp'], token === undefined ? {} : { GARAK_MCP_TOKEN: token })
      assert.equal(result.code, 1, 'MCP must reject missing/invalid tokens')
      assert.ok(result.stdout === '', 'Configuration errors must not contaminate MCP stdout')
      assert.ok(result.stderr.includes('GARAK_MCP_TOKEN'), 'Missing sanitized token configuration guidance')
      assert.ok(!token || !result.stderr.includes(token), 'Configuration errors echoed the supplied token')
      assert.ok(!/\n\s+at\s/.test(result.stderr), 'Configuration errors exposed a stack trace')
    }
  })
  await independentChecked('packaged MCP startup and clean stdin EOF shutdown', async () => {
    const port = await freeLoopbackPort()
    const token = 'Garak_Desktop_Smoke_Test_Only_000000000000000'
    const result = await runCli('stdio EOF shutdown', ['--mcp'], { GARAK_MCP_TOKEN: token, GARAK_MCP_PORT: String(port) }, `loopback bridge 127.0.0.1:${port}`)
    assert.equal(result.code, 0, 'MCP failed to shut down after stdin EOF')
    assert.ok(result.stdout === '', 'MCP emitted non-protocol stdout without a request')
    assert.ok(!result.stderr.includes(token), 'MCP diagnostics echoed the test token')
  })
  await independentChecked('packaged MCP initialize and tools/list stdio roundtrip', async () => {
    const port = await freeLoopbackPort()
    const token = 'Garak_Desktop_Smoke_Test_Only_000000000000000'
    const roundtrip = { initialized: false, requestCount: 0, responseCount: 0, toolCount: 0 }
    report.mcpStdio = roundtrip
    const result = await runCli('stdio JSON-RPC roundtrip', ['--mcp'], { GARAK_MCP_TOKEN: token, GARAK_MCP_PORT: String(port) }, `loopback bridge 127.0.0.1:${port}`, async io => {
      const request = async (id, method, params) => {
        roundtrip.requestCount++
        await io.sendJson({ jsonrpc: '2.0', id, method, params })
        let response
        await eventually(`${method} JSON-RPC response`, async () => {
          response = readRpcResponses(io.stdout()).responses.find(message => message.id === id)
          return Boolean(response)
        })
        assert.ok(!Object.hasOwn(response, 'error') && Object.hasOwn(response, 'result'), `${method} returned a JSON-RPC error or omitted its result`)
        roundtrip.responseCount++
        return response.result
      }
      // This server deliberately supports the SDK's legacy initialize protocol.
      const initialized = await request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'garak-desktop-smoke', version: '1.0.0' } })
      assert.ok(initialized?.protocolVersion === '2025-11-25' && initialized.serverInfo?.name === 'garak-ieum' && initialized.capabilities?.tools, 'MCP initialization did not return the expected server and tool capability')
      roundtrip.initialized = true
      await io.sendJson({ jsonrpc: '2.0', method: 'notifications/initialized' })
      const listed = await request(2, 'tools/list', {})
      assert.ok(Array.isArray(listed?.tools), 'tools/list omitted its tools array')
      const names = listed.tools.map(tool => tool.name)
      assert.ok(['list_instances', 'get_state', 'apply_edits'].every(name => names.includes(name)), 'tools/list omitted expected Garak Ieum tools')
      roundtrip.toolCount = names.length
    })
    assert.equal(result.code, 0, 'MCP failed to exit cleanly after the stdio roundtrip')
    const output = readRpcResponses(result.stdout)
    assert.ok(output.remainder === '' && output.responses.length === 2 && output.responses[0].id === 1 && output.responses[1].id === 2, 'MCP stdout included incomplete or unsolicited data')
    assert.ok(!result.stderr.includes(token), 'MCP diagnostics echoed the test token')
  })

  await checked('packaged startup and renderer isolation', async () => {
    await launch('first-launch')
    const isolation = await session.page.evaluate(() => {
      const bridge = window.garakDesktop
      return {
        protocol: location.protocol, host: location.host,
        require: typeof window.require, process: typeof window.process, buffer: typeof window.Buffer, fs: typeof window.fs,
        desktop: bridge?.isDesktop, platform: bridge?.platform, version: bridge?.version,
        methods: Object.fromEntries(['openProject', 'saveFile', 'onOpenProject', 'onSaveProject', 'onNewProject', 'onBeforeClose', 'ready'].map(name => [name, typeof bridge?.[name]])),
        exposedFilesystem: ['fs', 'readFile', 'writeFile', 'require', 'ipcRenderer'].some(name => bridge && name in bridge),
      }
    })
    assert.equal(isolation.protocol, 'garak:'); assert.equal(isolation.host, 'app')
    for (const key of ['require', 'process', 'buffer', 'fs']) assert.equal(isolation[key], 'undefined', `Renderer exposes ${key}`)
    assert.equal(isolation.desktop, true); assert.equal(isolation.platform, process.platform)
    assert.equal(isolation.version, report.launches.at(-1).details.version)
    assert.equal(isolation.exposedFilesystem, false)
    for (const [name, type] of Object.entries(isolation.methods)) assert.equal(type, 'function', `Missing bridge method ${name}`)
    await session.page.getByText('이 컴퓨터의 작업실', { exact: true }).waitFor()
    await screenshot('01-launcher.png')
  })

  await checked('packaged GPL notices and source identity', async () => {
    const documents = await session.page.evaluate(async () => {
      const files = ['GPL-3.0-only.txt', 'garak-ieum-MIT-notice.txt', 'THIRD_PARTY_NOTICES.txt', 'SOURCE.txt', 'SOURCE.json']
      return Object.fromEntries(await Promise.all(files.map(async name => {
        const response = await fetch(`/licenses/${name}`)
        if (!response.ok) throw new Error(`Missing packaged notice: ${name}`)
        return [name, await response.text()]
      })))
    })
    assert.equal(documents['GPL-3.0-only.txt'], await readFile(path.join(repository, 'LICENSE'), 'utf8'))
    assert.equal(documents['garak-ieum-MIT-notice.txt'], await readFile(path.join(repository, 'public', 'licenses', 'garak-ieum-MIT-notice.txt'), 'utf8'))
    assert.match(documents['THIRD_PARTY_NOTICES.txt'], /react@/)
    assert.match(documents['THIRD_PARTY_NOTICES.txt'], /@modelcontextprotocol\/server@/)
    const source = JSON.parse(documents['SOURCE.json'])
    const built = JSON.parse(await readFile(path.join(repository, 'dist', 'licenses', 'SOURCE.json'), 'utf8'))
    assert.deepEqual(source, built, 'Installed app contains another build\'s source identity')
    assert.equal(source.version, report.launches.at(-1).details.version)
    assert.match(documents['SOURCE.txt'], /GPL-3\.0-only/)
    if (process.env.GITHUB_SHA) {
      assert.equal(source.commit, process.env.GITHUB_SHA)
      assert.equal(source.dirty, false)
      assert.ok(documents['SOURCE.txt'].includes(source.archive))
    }
    report.source = { version: source.version, commit: source.commit, dirty: source.dirty, archive: source.archive }
  })

  await checked('project creation and numeric BPM editing', async () => {
    const page = session.page
    await page.getByRole('button', { name: '새 빈 프로젝트', exact: true }).click()
    await page.waitForURL(/\/projects\//)
    await page.locator('.save-indicator.saved').waitFor()
    const name = page.getByRole('textbox', { name: '프로젝트 이름', exact: true })
    if (macInstalledSmoke) {
      await pasteWithMacClipboard(name, projectName)
      await macShortcut('A'); await macShortcut('C')
      await eventually('native macOS text copy', async () => await session.application.evaluate(({ clipboard }) => clipboard.readText()) === projectName)
      await session.application.evaluate(({ clipboard }) => clipboard.clear())
    } else await name.fill(projectName)
    await name.press('Tab')
    const bpm = page.getByRole('spinbutton', { name: '템포 BPM', exact: true })
    const original = await bpm.inputValue()
    await bpm.focus(); await bpm.press('ControlOrMeta+A'); await bpm.press('Backspace')
    assert.equal(await bpm.inputValue(), '')
    await bpm.pressSequentially('9')
    assert.equal(await bpm.inputValue(), '9')
    assert.equal(await bpm.getAttribute('aria-valuenow'), original, 'Incomplete BPM changed playback tempo')
    await bpm.pressSequentially('5'); await bpm.press('Enter'); await valueIs(bpm, '95')
    await bpm.fill('999'); await bpm.press('Enter'); await valueIs(bpm, '300')
    await bpm.fill('1'); await bpm.press('Enter'); await valueIs(bpm, '30')
    await bpm.fill(''); await bpm.pressSequentially('eE-+. abc')
    assert.equal(await bpm.inputValue(), '', 'BPM accepts non-digit characters')
    await bpm.press('Escape'); await valueIs(bpm, '30')
    await bpm.fill('137'); await bpm.press('Enter'); await valueIs(bpm, '137')
    await bpm.fill('88'); await bpm.press('Escape'); await valueIs(bpm, '137')
    await bpm.focus(); await bpm.press('ArrowUp'); await valueIs(bpm, '138')
    await bpm.press('ArrowDown'); await valueIs(bpm, '137'); await bpm.press('Enter')
  })

  await checked('bundled license links switch isolated document windows', async () => {
    const page = session.page
    await page.getByRole('button', { name: '가락이음 메뉴', exact: true }).click()
    await page.getByRole('menuitem', { name: '가락이음 정보', exact: true }).click()
    for (const filename of ['GPL-3.0-only.txt', 'garak-ieum-MIT-notice.txt', 'THIRD_PARTY_NOTICES.txt', 'SOURCE.txt']) {
      await page.bringToFront()
      await page.locator(`a[href="/licenses/${filename}"]`).click()
      let document
      await eventually(`isolated license document ${filename}`, async () => {
        document = await session.application.evaluate(({ BrowserWindow }, expected) => {
          const windows = BrowserWindow.getAllWindows()
          const child = windows.find(candidate => candidate.webContents.getURL() === `garak://app/licenses/${expected}`)
          if (!child || !child.isVisible() || child.webContents.isLoading()) return null
          const preferences = child.webContents.getLastWebPreferences()
          return {
            windows: windows.length, javascript: preferences.javascript, sandbox: preferences.sandbox,
            nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation,
            webSecurity: preferences.webSecurity, preload: Boolean(preferences.preload),
          }
        }, filename)
        return document !== null
      })
      assert.deepEqual(document, {
        windows: 2, javascript: false, sandbox: true, nodeIntegration: false,
        contextIsolation: true, webSecurity: true, preload: false,
      })
    }
    await session.application.evaluate(({ BrowserWindow }) => {
      for (const child of BrowserWindow.getAllWindows()) {
        if (child.webContents.getURL().startsWith('garak://app/licenses/')) child.close()
      }
    })
    await page.bringToFront()
    await page.getByRole('button', { name: '창 닫기', exact: true }).click()
  })

  await checked('time signature, undo and visible header controls', async () => {
    const page = session.page, numerator = page.getByLabel('박자표 분자', { exact: true }), denominator = page.getByLabel('박자표 분모', { exact: true })
    await numerator.selectOption('3'); await valueIs(numerator, '3'); await valueIs(denominator, '4')
    await numerator.selectOption('6'); await denominator.selectOption('8')
    await valueIs(numerator, '6'); await valueIs(denominator, '8')
    await page.getByRole('button', { name: /^실행 취소/ }).click(); await valueIs(denominator, '4')
    await page.getByRole('button', { name: /^다시 실행/ }).click(); await valueIs(denominator, '8')
    for (const [width, height] of [[1280, 900], [1000, 800]]) {
      await screenshot(`02-editor-${width}x${height}.png`, width, height)
      const layout = await page.evaluate(() => {
        const boxes = ['.tempo-box', '.time-signature', '.header-actions'].map(selector => {
          const element = document.querySelector(selector), rect = element.getBoundingClientRect()
          return { x: rect.x, right: rect.right, width: rect.width, visible: Boolean(element.getClientRects().length) }
        })
        return { width: innerWidth, boxes }
      })
      for (const box of layout.boxes) assert.ok(box.visible && box.width > 0 && box.x >= 0 && box.right <= layout.width, 'Header control is hidden or outside the window')
      assert.ok(layout.boxes[0].right <= layout.boxes[1].x + 1 && layout.boxes[1].right <= layout.boxes[2].x + 1, 'Header controls overlap')
    }
  })

  await checked('packaged GUI authenticates to the real MCP loopback server', async () => {
    const page = session.page, port = await freeLoopbackPort()
    const token = 'Garak_Desktop_Smoke_Test_Only_000000000000000'
    const connection = { origin: await page.evaluate(() => location.origin), url: `ws://127.0.0.1:${port}/bridge`, receivedReady: false, socketClosed: false, socketError: false }
    report.mcpLoopback = connection
    assert.equal(connection.origin, 'garak://app')
    // Observe actual network frames, never outgoing auth data. Neither WebSocket,
    // CSP, permission handlers nor the application bridge is replaced here.
    const observe = socket => {
      if (socket.url() !== connection.url) return
      socket.on('framereceived', ({ payload }) => {
        try {
          const message = JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8'))
          if (message.type === 'ready' && message.protocol === 1) connection.receivedReady = true
        } catch { /* The client itself reports a malformed bridge response. */ }
      })
      socket.on('socketerror', () => { connection.socketError = true })
      socket.on('close', () => { connection.socketClosed = true })
    }
    page.on('websocket', observe)
    let result
    try {
      result = await runCli('GUI loopback pairing', ['--mcp'], { GARAK_MCP_TOKEN: token, GARAK_MCP_PORT: String(port) }, `loopback bridge 127.0.0.1:${port}`, async () => {
        await page.getByRole('button', { name: '가락이음 메뉴', exact: true }).click()
        await page.getByRole('menuitem', { name: /^AI 연결/ }).click()
        const dialog = page.getByRole('dialog', { name: 'AI 연결', exact: true })
        await dialog.getByLabel('브리지 주소', { exact: true }).fill(connection.url)
        if (macInstalledSmoke) await pasteWithMacClipboard(dialog.getByLabel('연결 키', { exact: true }), token)
        else await dialog.getByLabel('연결 키', { exact: true }).fill(token)
        await dialog.getByRole('button', { name: '연결', exact: true }).click()
        await dialog.getByText('연결됨', { exact: true }).waitFor()
        await eventually('authenticated bridge ready frame', async () => connection.receivedReady)
        assert.equal(connection.socketError, false, 'The renderer WebSocket reported an error')
        assert.ok((await dialog.getByLabel('연결 키', { exact: true }).inputValue()).length === 0, 'The connection key was not cleared after pairing')
        await screenshot('mcp-connected.png')
        await dialog.getByRole('button', { name: '연결 해제', exact: true }).click()
        await dialog.getByText('연결 안 됨', { exact: true }).waitFor()
        await eventually('renderer WebSocket close', async () => connection.socketClosed)
        assert.equal(connection.socketError, false, 'The renderer WebSocket failed during disconnect')
        await dialog.getByRole('button', { name: 'AI 연결 창 닫기', exact: true }).click()
      })
    } catch (error) {
      // Playwright can include fill arguments in timeout diagnostics. Keep even
      // this deterministic test key out of reports and CI output.
      throw new Error(String(error).replaceAll(token, '[test token redacted]'))
    } finally { page.off('websocket', observe) }
    assert.equal(result.code, 0, 'The paired MCP process failed to exit after stdin EOF')
    assert.ok(result.stdout === '', 'GUI pairing contaminated MCP protocol stdout')
    assert.ok(!result.stderr.includes(token), 'MCP diagnostics echoed the test token')
  })

  await checked('native save cancellation and project menu export', async () => {
    await nativeMenu('project-save')
    await session.page.getByText('프로젝트 파일 저장을 취소했습니다.', { exact: true }).waitFor()
    await session.dialogs.evaluate((state, filePath) => { state.save = { canceled: false, filePath } }, projectFile)
    await nativeMenu('project-save')
    await session.page.getByText('프로젝트와 원본 음원을 파일로 저장했습니다.', { exact: true }).waitFor()
    const bundle = JSON.parse(await readFile(projectFile, 'utf8'))
    assert.equal(bundle.project.name, projectName); assert.equal(bundle.project.bpm, 137)
    assert.deepEqual(bundle.project.timeSignature, { numerator: 6, denominator: 8 })
    report.artifacts.push(path.basename(projectFile))
  })

  await checked('native WAV export', async () => {
    await session.dialogs.evaluate((state, filePath) => { state.save = { canceled: false, filePath } }, wavFile)
    await session.page.getByRole('button', { name: '오디오 내보내기', exact: true }).click()
    await session.page.getByRole('button', { name: 'WAV 내보내기', exact: true }).click()
    await session.page.getByText('스테레오 WAV 파일을 저장했습니다.', { exact: true }).waitFor({ timeout: 30_000 })
    const wav = await readFile(wavFile)
    assert.ok(wav.length > 44); assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE')
    report.artifacts.push('smoke-audio.wav')
  })

  let reopenURL
  await checked('native New and Open menu commands', async () => {
    const previous = session.page.url()
    await nativeMenu('project-new')
    await eventually('new project route', async () => session.page.url() !== previous)
    await session.page.locator('.save-indicator.saved').waitFor()
    await session.dialogs.evaluate((state, filePath) => { state.open = { canceled: false, filePaths: [filePath] } }, projectFile)
    const blank = session.page.url()
    await nativeMenu('project-open')
    await eventually('imported project route', async () => session.page.url() !== blank)
    await valueIs(session.page.getByRole('textbox', { name: '프로젝트 이름', exact: true }), projectName)
    await valueIs(session.page.getByRole('spinbutton', { name: '템포 BPM', exact: true }), '137')
    await valueIs(session.page.getByLabel('박자표 분자', { exact: true }), '6')
    await valueIs(session.page.getByLabel('박자표 분모', { exact: true }), '8')
    await session.page.locator('.save-indicator.saved').waitFor()
    reopenURL = session.page.url()
    assert.match(reopenURL, /^garak:\/\/app\/projects\//)
    report.reopenURL = reopenURL
  })

  if (macInstalledSmoke) {
    await checked('macOS native text editing preserves DAW and File menu shortcuts', async () => {
      const page = session.page
      const fixture = JSON.parse(await readFile(projectFile, 'utf8'))
      fixture.project.tracks = [{
        id: 'mac-keyboard-track', name: 'Mac keyboard smoke', kind: 'instrument', instrument: 'keys', color: '#5c9b8e',
        volume: 0.7, pan: 0, mute: false, solo: false, soloSafe: false, enabled: true, armed: false, monitor: false,
        hidden: false, transpose: 0, velocityOffset: 0, keyLimit: [0, 127], velocityLimit: [1, 127], delayTicks: 0,
        instrumentParams: {}, devices: [],
        clips: [0, 8].map((startBeat, index) => ({
          id: `mac-keyboard-clip-${index}`, name: `Mac keyboard ${index + 1}`, kind: 'midi', startBeat, lengthBeats: 4, gain: 1,
          notes: [{ id: `mac-keyboard-note-${index}`, pitch: 60 + index * 4, start: 0, duration: 1, velocity: 0.7 }],
        })),
      }]
      const fixtureFile = path.join(artifacts, 'mac keyboard project.garak')
      await writeFile(fixtureFile, JSON.stringify(fixture))
      const arrangement = page.locator('[data-keyboard-scope="timeline"]')
      const command = async (key, shift = false) => { await arrangement.focus(); await macShortcut(key, shift) }
      const previous = page.url()
      await session.dialogs.evaluate((state, filePath) => { state.open = { canceled: false, filePaths: [filePath] } }, fixtureFile)
      await command('O')
      await eventually('keyboard-open imported project route', async () => page.url() !== previous)
      const clips = page.locator('.timeline-clip.midi')
      await eventually('two imported MIDI clips', async () => await clips.count() === 2)
      await clips.first().click()
      await command('A')
      await eventually('DAW select-all', async () => await page.locator('.timeline-clip.clip-selected').count() === 2)
      await command('C'); await arrangement.press('Delete')
      await eventually('DAW delete', async () => await clips.count() === 0)
      await command('V')
      await eventually('DAW clipboard paste', async () => await clips.count() === 2)
      await command('Z')
      await eventually('DAW undo paste', async () => await clips.count() === 0)
      await command('Z', true)
      await eventually('DAW redo paste', async () => await clips.count() === 2)
      await command('A'); await command('X')
      await eventually('DAW cut', async () => await clips.count() === 0)
      await command('Z')
      await eventually('DAW undo cut', async () => await clips.count() === 2)
      await page.locator('.save-indicator.saved').waitFor()
      const saves = await session.dialogs.evaluate(state => { state.save = { canceled: true }; return state.saveCalls })
      await command('S')
      await eventually('keyboard File Save dialog', async () => await session.dialogs.evaluate(state => state.saveCalls) === saves + 1)
      const modified = page.url()
      await session.dialogs.evaluate((state, filePath) => { state.open = { canceled: false, filePaths: [filePath] } }, projectFile)
      await command('O')
      await eventually('keyboard-open restored original project', async () => page.url() !== modified)
      await valueIs(page.getByRole('textbox', { name: '프로젝트 이름', exact: true }), projectName)
      await page.locator('.save-indicator.saved').waitFor()
      reopenURL = page.url()
      report.reopenURL = reopenURL
      report.macKeyboard = { textClipboard: true, mcpPaste: true, dawSelectCopyPasteCutUndoRedo: true, fileOpenSave: true }
    })
  }

  await checked('second executable forwards a spaced .garak path to the original window', async () => {
    const page = session.page, previous = page.url()
    // The same isolated profile must hit the installed app's single-instance
    // path, as the quoted file-association command does when the app is open.
    const result = await runProcess(executable, 'single-instance project file open', [projectFile])
    assert.equal(result.code, 0, 'The second app process did not hand off the project cleanly')
    assert.equal(page.isClosed(), false, 'The original app window was closed during file handoff')
    await eventually('second-instance imported project route', async () => page.url() !== previous)
    await valueIs(page.getByRole('textbox', { name: '프로젝트 이름', exact: true }), projectName)
    await valueIs(page.getByRole('spinbutton', { name: '템포 BPM', exact: true }), '137')
    await valueIs(page.getByLabel('박자표 분자', { exact: true }), '6')
    await valueIs(page.getByLabel('박자표 분모', { exact: true }), '8')
    await page.locator('.save-indicator.saved').waitFor()
    assert.equal(await session.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, 'File handoff created another application window')
    reopenURL = page.url()
    assert.match(reopenURL, /^garak:\/\/app\/projects\//)
    report.reopenURL = reopenURL
    report.secondInstanceOpen = { fileName: path.basename(projectFile), exitCode: result.code, route: reopenURL }
  })

  if (macInstalledSmoke) {
    await checked('macOS Launch Services opens a .garak file in the existing app', async () => {
      const application = path.resolve(process.env.GARAK_MAC_APP_BUNDLE)
      assert.equal(executable.normalize('NFC'), path.join(application, 'Contents', 'MacOS', '가락이음').normalize('NFC'), 'Launch Services must target the same isolated test app.')
      const page = session.page, previous = page.url()
      // Explicitly select the installed temporary app. No default-app changes,
      // additional user profile, or Finder automation permissions are required.
      const result = await runProcess('/usr/bin/open', 'Launch Services project file open', ['-a', application, '--', projectFile])
      assert.equal(result.code, 0, 'Launch Services rejected the project file.')
      await eventually('Launch Services imported project route', async () => page.url() !== previous)
      await valueIs(page.getByRole('textbox', { name: '프로젝트 이름', exact: true }), projectName)
      await valueIs(page.getByRole('spinbutton', { name: '템포 BPM', exact: true }), '137')
      await valueIs(page.getByLabel('박자표 분자', { exact: true }), '6')
      await valueIs(page.getByLabel('박자표 분모', { exact: true }), '8')
      await page.locator('.save-indicator.saved').waitFor()
      assert.equal(await session.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
      reopenURL = page.url()
      report.reopenURL = reopenURL
      report.launchServicesOpen = { fileName: path.basename(projectFile), route: reopenURL }
    })
  }

  await checked('normal close commits active BPM input and flushes autosave', async () => {
    const bpm = session.page.getByRole('spinbutton', { name: '템포 BPM', exact: true })
    await bpm.fill('143') // Intentionally leave the draft focused and uncommitted.
    assert.equal(await bpm.getAttribute('aria-valuenow'), '137')
    await closeNormally()
  })

  await checked('same-profile relaunch and project persistence', async () => {
    await launch('second-launch')
    await session.page.goto(reopenURL)
    await valueIs(session.page.getByRole('textbox', { name: '프로젝트 이름', exact: true }), projectName)
    await valueIs(session.page.getByRole('spinbutton', { name: '템포 BPM', exact: true }), '143')
    await valueIs(session.page.getByLabel('박자표 분자', { exact: true }), '6')
    await valueIs(session.page.getByLabel('박자표 분모', { exact: true }), '8')
    await session.page.locator('.save-indicator.saved').waitFor()
    await screenshot('03-reopened-project.png')
    await closeNormally()
  })
  const failedChecks = report.checks.filter(check => check.status === 'failed')
  if (failedChecks.length) {
    phase = 'independent CLI results'
    throw new Error(`Independent smoke checks failed: ${failedChecks.map(check => check.name).join(', ')}`)
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = { phase, message: String(error), stack: error instanceof Error ? error.stack : undefined }
  console.error(`Desktop smoke failed during ${phase}:`, error)
  if (session?.page && !session.page.isClosed()) {
    try {
      await within(session.page.screenshot({ path: path.join(artifacts, 'failure.png') }), 5000, 'failure screenshot')
      report.artifacts.push('failure.png')
    } catch { /* Keep the original failure if the renderer is no longer available. */ }
  }
  process.exitCode = 1
} finally {
  if (session) {
    await saveLogs(session).catch(() => {})
    try { await within(session.application.close(), 5000, 'test cleanup') }
    catch {
      // Cleanup only after failure; never count forced termination as a passing close test.
      session.application.process().kill()
      report.cleanupTerminatedTestProcess = true
    }
  }
  report.finishedAt = new Date().toISOString()
  await mkdir(artifacts, { recursive: true })
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2))
  if (profile && report.status === 'passed') await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(error => console.warn('Could not remove temporary smoke profile:', error.message))
  console.log(`Desktop smoke ${report.status}; artifacts: ${artifacts}`)
}

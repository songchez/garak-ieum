import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session, shell, systemPreferences } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron'
import { mkdirSync } from 'node:fs'
import { open, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { DesktopFile, DesktopSaveResult, DesktopViewCommand } from './contracts.js'
import { ipcNativeError, NativeAudioService } from './native-audio.js'
import { APP_URL, CONTENT_SECURITY_POLICY, MAX_PROJECT_BYTES, PROJECT_EXTENSIONS, assetRelativePath, desktopMcpStartupErrorMessage, exportExtension, isAppUrl, isBundledLicenseUrl, isExternalUrl, validateSaveRequest } from './policy.js'

const directory = dirname(fileURLToPath(import.meta.url))
const cliMode = process.argv.includes('--mcp') ? 'mcp' : process.argv.includes('--mcp-token') ? 'token' : null

app.setName('가락이음')
app.enableSandbox()
protocol.registerSchemesAsPrivileged([
  { scheme: 'garak', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

let window: BrowserWindow | null = null
let licenseWindow: BrowserWindow | null = null
let rendererReady = false
let textFocused = false
let allowClose = false
let fileDialogPending = false
let microphoneAllowed = false
let microphoneRequest: Promise<boolean> | null = null
let nativeAudio: NativeAudioService | null = null
const pendingFiles: string[] = []
let pendingClose: { id: string; timer: NodeJS.Timeout | null } | null = null

function trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && isAppUrl(event.senderFrame?.url ?? ''))
}

function assertTrusted(event: IpcMainInvokeEvent): void {
  if (!trusted(event)) throw new Error('이 요청은 가락이음 작업실에서만 사용할 수 있습니다.')
}

async function readProject(path: string): Promise<DesktopFile> {
  if (!PROJECT_EXTENSIONS.includes(extname(path).slice(1).toLowerCase())) throw new Error('.garak, .noct 또는 .json 프로젝트 파일을 선택해주세요.')
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size === 0 || info.size > MAX_PROJECT_BYTES) throw new Error('프로젝트 파일은 0바이트보다 크고 512MB 이하여야 합니다.')
    const data = await file.readFile()
    if (data.byteLength > MAX_PROJECT_BYTES) throw new Error('프로젝트 파일이 너무 큽니다.')
    return { name: basename(path), data: new Uint8Array(data) }
  } finally { await file.close() }
}

async function showOpenProject(): Promise<DesktopFile | null> {
  if (!window || fileDialogPending || pendingClose) return null
  fileDialogPending = true
  try {
    const result = await dialog.showOpenDialog(window, {
      title: '가락이음 프로젝트 가져오기',
      properties: ['openFile'],
      filters: [{ name: '가락이음 프로젝트', extensions: PROJECT_EXTENSIONS }],
    })
    return result.canceled || !result.filePaths[0] ? null : await readProject(result.filePaths[0])
  } finally { fileDialogPending = false }
}

/** Replace only after all bytes have reached disk; a failed write leaves the previous file intact. */
async function atomicSave(path: string, data: Uint8Array): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }).catch(() => {}) }
}

function reportFileError(): void {
  if (window && !window.isDestroyed()) void dialog.showMessageBox(window, { type: 'error', title: '프로젝트를 열 수 없습니다', message: '프로젝트 파일을 읽지 못했습니다.', detail: '.garak 파일인지, 파일에 접근할 수 있는지 확인해주세요.' })
}

async function deliverPendingFiles(): Promise<void> {
  if (!rendererReady || !window || window.isDestroyed() || !pendingFiles.length) return
  // The renderer owns project navigation; do not begin several imports at once.
  const path = pendingFiles.shift()!
  try {
    const file = await readProject(path)
    if (window && rendererReady && !window.isDestroyed()) window.webContents.send('garak:project-opened', file)
  } catch { reportFileError() }
  pendingFiles.length = 0
}

function queueProject(path: string): void {
  if (!isAbsolute(path) || extname(path).toLowerCase() !== '.garak') return
  pendingFiles.push(path)
  if (rendererReady) void deliverPendingFiles()
}

function clearCloseRequest(): void {
  if (pendingClose?.timer) clearTimeout(pendingClose.timer)
  pendingClose = null
}

function closeApproved(): void {
  clearCloseRequest()
  allowClose = true
  window?.close()
}

function waitForClose(id: string): void {
  if (!pendingClose || pendingClose.id !== id) return
  pendingClose.timer = setTimeout(async () => {
    if (!window || window.isDestroyed() || pendingClose?.id !== id) return
    const result = await dialog.showMessageBox(window, {
      type: 'warning', title: '작업을 저장하는 중입니다',
      message: '저장을 마친 뒤 종료하려고 기다리고 있습니다.',
      detail: '기다리기를 선택하면 저장을 계속합니다. 강제로 종료하면 아직 저장하지 못한 변경사항이 사라질 수 있습니다.',
      buttons: ['계속 기다리기', '저장하지 않고 종료'], defaultId: 0, cancelId: 0,
      noLink: true,
    })
    if (pendingClose?.id !== id) return
    if (result.response === 1) closeApproved()
    else waitForClose(id)
  }, 12_000)
}

function requestClose(): void {
  if (pendingClose || !window) return
  if (fileDialogPending) { window.focus(); return }
  const id = randomUUID()
  pendingClose = { id, timer: null }
  window.webContents.send('garak:before-close', id)
  waitForClose(id)
}

// Electron's zoomIn/zoomOut roles step by 0.5 level; Chromium clamps at roughly 25%–500%.
const VIEW_COMMANDS = new Set<DesktopViewCommand>(['zoomIn', 'zoomOut', 'resetZoom', 'toggleFullscreen'])
const ZOOM_STEP = 0.5, MIN_ZOOM_LEVEL = -7.5, MAX_ZOOM_LEVEL = 9

function installIpc(): void {
  ipcMain.handle('garak:window-colors', (event, colors: unknown) => {
    assertTrusted(event)
    if (!colors || typeof colors !== 'object') throw new Error('Invalid window colors.')
    const { background, foreground } = colors as Record<string, unknown>
    if (typeof background !== 'string' || typeof foreground !== 'string'
      || !/^#[0-9a-f]{6}$/i.test(background) || !/^#[0-9a-f]{6}$/i.test(foreground)) throw new Error('Invalid window colors.')
    if (process.platform !== 'darwin') window?.setTitleBarOverlay({ color: background, symbolColor: foreground })
  })
  // The in-app 보기 menu reaches the same window actions as the native View menu roles.
  ipcMain.on('garak:window-view', (event, command: unknown) => {
    if (!trusted(event) || !window || pendingClose || typeof command !== 'string' || !VIEW_COMMANDS.has(command as DesktopViewCommand)) return
    const contents = window.webContents
    switch (command as DesktopViewCommand) {
      case 'zoomIn': contents.setZoomLevel(Math.min(MAX_ZOOM_LEVEL, contents.getZoomLevel() + ZOOM_STEP)); break
      case 'zoomOut': contents.setZoomLevel(Math.max(MIN_ZOOM_LEVEL, contents.getZoomLevel() - ZOOM_STEP)); break
      case 'resetZoom': contents.setZoomLevel(0); break
      case 'toggleFullscreen': window.setFullScreen(!window.isFullScreen()); break
    }
  })
  ipcMain.handle('garak:audio-request', async (event, method: unknown, params: unknown) => {
    assertTrusted(event)
    if (!nativeAudio) throw new Error('네이티브 오디오 엔진을 사용할 수 없습니다.')
    try { return await nativeAudio.request(method, params) }
    catch (error) { throw ipcNativeError(error) }
  })
  ipcMain.on('garak:text-focus', (event, value: unknown) => {
    if (process.platform === 'darwin' && trusted(event) && typeof value === 'boolean') textFocused = value
  })
  ipcMain.handle('garak:open-project', async event => { assertTrusted(event); return showOpenProject() })
  ipcMain.handle('garak:save-file', async (event, value: unknown): Promise<DesktopSaveResult> => {
    assertTrusted(event)
    const request = validateSaveRequest(value)
    if (!window || fileDialogPending || pendingClose) return { canceled: true }
    fileDialogPending = true
    try {
      const extension = exportExtension(request.kind)
      const result = await dialog.showSaveDialog(window, {
        title: request.kind === 'audio' ? 'WAV 오디오 내보내기' : '프로젝트 파일 저장',
        defaultPath: request.name,
        filters: [{ name: request.kind === 'audio' ? 'WAV 오디오' : '가락이음 프로젝트', extensions: [extension] }],
        properties: ['showOverwriteConfirmation', 'createDirectory'],
      })
      if (result.canceled || !result.filePath) return { canceled: true }
      // Never append an extension after the dialog: that could bypass its overwrite confirmation.
      if (extname(result.filePath).toLowerCase() !== `.${extension}`) throw new Error(`파일 이름 끝에 .${extension} 확장자를 붙여주세요.`)
      await atomicSave(result.filePath, request.data)
      return { canceled: false, fileName: basename(result.filePath) }
    } finally { fileDialogPending = false }
  })
  ipcMain.on('garak:ready', event => {
    if (!trusted(event)) return
    rendererReady = true
    void deliverPendingFiles()
  })
  // The renderer is asking the user (e.g. the final save failed); a second, native
  // "still saving" dialog on top of that question would only confuse.
  ipcMain.on('garak:close-awaiting-user', (event, value: unknown) => {
    if (!trusted(event) || !pendingClose || !value || typeof value !== 'object') return
    if ((value as { requestId?: unknown }).requestId !== pendingClose.id) return
    if (pendingClose.timer) clearTimeout(pendingClose.timer)
    pendingClose.timer = null
  })
  ipcMain.on('garak:close-response', (event, result: unknown) => {
    if (!trusted(event) || !result || typeof result !== 'object') return
    const response = result as { requestId?: unknown; allowed?: unknown }
    if (response.requestId !== pendingClose?.id || typeof response.allowed !== 'boolean') return
    if (response.allowed) closeApproved()
    else clearCloseRequest()
  })
}

/** macOS shows this menu in the system bar. Elsewhere it stays hidden behind the custom title bar
 * and only supplies accelerators (Ctrl+N/O/S, zoom, full screen); the in-app menu bar is the visible one. */
function buildMenu(): void {
  const send = (channel: string) => { if (rendererReady && !pendingClose) window?.webContents.send(channel) }
  const menu: MenuItemConstructorOptions[] = [
    { label: '파일', submenu: [
      { id: 'project-new', label: '새 프로젝트', accelerator: 'CmdOrCtrl+N', click: () => send('garak:new-project') },
      { id: 'project-open', label: '프로젝트 파일 열기…', accelerator: 'CmdOrCtrl+O', click: () => { void showOpenProject().then(file => { if (file && rendererReady) window?.webContents.send('garak:project-opened', file) }).catch(reportFileError) } },
      { id: 'project-save', label: '프로젝트 파일 저장…', accelerator: 'CmdOrCtrl+S', click: () => send('garak:save-project') },
      { type: 'separator' },
      process.platform === 'darwin'
        ? { role: 'close', label: '창 닫기' }
        : { label: '종료', accelerator: 'Alt+F4', click: () => window?.close() },
    ] },
    { label: '보기', submenu: [{ role: 'resetZoom', label: '화면 배율 초기화' }, { role: 'zoomIn', label: '화면 확대' }, { role: 'zoomOut', label: '화면 축소' }, { type: 'separator' }, { role: 'togglefullscreen', label: '전체 화면' }] },
  ]
  if (process.platform === 'darwin') {
    menu.splice(1, 0, { label: '편집', submenu: [
      { role: 'undo', label: '실행 취소' }, { role: 'redo', label: '다시 실행' },
      { type: 'separator' },
      { role: 'cut', label: '잘라내기' }, { role: 'copy', label: '복사' }, { role: 'paste', label: '붙여넣기' },
      { role: 'pasteAndMatchStyle', label: '스타일에 맞추어 붙여넣기' }, { role: 'selectAll', label: '모두 선택' },
    ] })
    menu.unshift({ role: 'appMenu' })
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu))
}

async function approveMicrophone(): Promise<boolean> {
  if (microphoneAllowed) return true
  if (!window) return false
  if (!microphoneRequest) microphoneRequest = (async () => {
    const answer = await dialog.showMessageBox(window!, {
      type: 'question', title: '오디오 입력 사용', message: '녹음과 입력 모니터링에 마이크·오디오 입력을 사용하시겠습니까?',
      detail: '입력 소리는 이 컴퓨터의 가락이음에서 처리합니다.', buttons: ['허용', '취소'], defaultId: 1, cancelId: 1, noLink: true,
    })
    if (answer.response !== 0) return false
    if (process.platform === 'darwin' && !(await systemPreferences.askForMediaAccess('microphone'))) return false
    microphoneAllowed = true
    return true
  })().finally(() => { microphoneRequest = null })
  return microphoneRequest
}

function installPermissions(): void {
  const own = (contents: Electron.WebContents | null) => Boolean(window && contents === window.webContents && isAppUrl(contents?.getURL() ?? ''))
  // Output selection and local project/MCP operations do not grant microphone capture.
  const localPermissions = new Set(['speaker-selection', 'persistent-storage', 'loopback-network', 'clipboard-sanitized-write'])
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (!own(contents) || !isAppUrl(origin) || !details.isMainFrame) return false
    return localPermissions.has(permission) || (permission === 'media' && details.mediaType === 'audio' && microphoneAllowed)
  })
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!own(contents) || !isAppUrl(details.requestingUrl) || !details.isMainFrame) { callback(false); return }
    if (localPermissions.has(permission)) { callback(true); return }
    const audioOnly = 'mediaTypes' in details && Boolean(details.mediaTypes?.length) && details.mediaTypes?.every(type => type === 'audio')
    if (permission !== 'media' || !audioOnly) { callback(false); return }
    void approveMicrophone().then(callback, () => callback(false))
  })
  session.defaultSession.setDevicePermissionHandler(() => false)
}

async function serveAssets(): Promise<void> {
  const root = resolve(app.getAppPath(), 'dist')
  protocol.handle('garak', async request => {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
    const relative = assetRelativePath(request.url)
    if (relative === null) return new Response(null, { status: 400 })
    let path = resolve(root, relative)
    if (path !== root && !path.startsWith(`${root}${sep}`)) return new Response(null, { status: 403 })
    let exists = await stat(path).then(info => info.isFile(), () => false)
    if (!exists && (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html'))) {
      path = join(root, 'index.html')
      exists = true
    }
    if (!exists) return new Response(null, { status: 404 })
    const file = await net.fetch(pathToFileURL(path).href)
    const headers = new Headers(file.headers)
    headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY)
    headers.set('X-Content-Type-Options', 'nosniff')
    headers.set('Referrer-Policy', 'no-referrer')
    headers.set('Cache-Control', 'no-cache')
    return new Response(request.method === 'HEAD' ? null : file.body, { status: file.status, headers })
  })
}

function openBundledLicense(url: string): void {
  const parent = window
  if (!parent || parent.isDestroyed() || !isBundledLicenseUrl(url)) return
  if (licenseWindow && !licenseWindow.isDestroyed()) {
    if (licenseWindow.webContents.getURL() === url) {
      if (licenseWindow.isMinimized()) licenseWindow.restore()
      licenseWindow.show(); licenseWindow.focus()
      return
    }
    // Each read-only window pins its navigation to one notice. Recreate it
    // when another allowed notice is requested, without widening that boundary.
    licenseWindow.destroy()
  }
  // Create explicitly rather than inheriting window.open preferences or the app preload.
  const child = new BrowserWindow({
    parent, title: '라이선스 · 가락이음', width: 820, height: 680, minWidth: 480, minHeight: 320,
    backgroundColor: '#ffffff', show: false,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      javascript: false, devTools: false,
    },
  })
  licenseWindow = child
  child.setMenu(null)
  const closeWithParent = () => { if (!child.isDestroyed()) child.destroy() }
  parent.once('closed', closeWithParent)
  child.once('closed', () => {
    parent.removeListener('closed', closeWithParent)
    if (licenseWindow === child) licenseWindow = null
  })
  child.once('ready-to-show', () => { if (!child.isDestroyed()) child.show() })
  child.webContents.on('will-navigate', (event, destination) => { if (destination !== url) event.preventDefault() })
  child.webContents.on('will-redirect', (event, destination) => { if (destination !== url) event.preventDefault() })
  child.webContents.on('will-frame-navigate', event => { if (!event.isMainFrame || event.url !== url) event.preventDefault() })
  child.webContents.on('will-attach-webview', event => event.preventDefault())
  child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  void child.loadURL(url).catch(() => {
    if (child.isDestroyed()) return
    closeWithParent()
    if (!parent.isDestroyed()) void dialog.showMessageBox(parent, {
      type: 'error', title: '라이선스 문서를 열 수 없습니다',
      message: '설치 파일에 포함된 라이선스 문서를 열지 못했습니다.',
    }).catch(() => {})
  })
}

async function createWindow(): Promise<void> {
  rendererReady = false
  textFocused = false
  allowClose = false
  window = new BrowserWindow({
    title: '가락이음', width: 1440, height: 940, minWidth: 960, minHeight: 640,
    backgroundColor: '#141719', show: false, icon: join(app.getAppPath(), 'dist/brand/garak-ieum-mark.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#303831', symbolColor: '#eee9dc', height: 32 },
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 10 } } : { autoHideMenuBar: true }),
    webPreferences: {
      preload: join(directory, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      backgroundThrottling: false,
      additionalArguments: [`--garak-version=${app.getVersion()}`],
    },
  })
  window.once('ready-to-show', () => window?.show())
  window.on('close', event => { if (!allowClose) { event.preventDefault(); requestClose() } })
  window.on('closed', () => { clearCloseRequest(); window = null; rendererReady = false; textFocused = false })
  if (process.platform === 'darwin') {
    const contents = window.webContents
    contents.on('before-input-event', (_event, input) => {
      // Text controls need AppKit's editing roles; the DAW owns these same
      // chords outside text. Keep File/App shortcuts (Cmd+O/S/Q…) available.
      const editingChord = input.meta && !input.control && !input.alt && /^Key[ACVXZ]$/.test(input.code)
      contents.setIgnoreMenuShortcuts(editingChord && !textFocused)
    })
    contents.on('did-start-loading', () => { textFocused = false; contents.setIgnoreMenuShortcuts(false) })
  }
  window.webContents.on('will-navigate', (event, url) => { if (!isAppUrl(url)) event.preventDefault() })
  window.webContents.on('will-frame-navigate', event => { if (!isAppUrl(event.url)) event.preventDefault() })
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.webContents.on('will-prevent-unload', event => {
    // The awaited native close guard has already flushed the current revision.
    // React's older beforeunload closure may still see saveStatus='saving'.
    if (allowClose) event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url).catch(() => {})
    else if (isBundledLicenseUrl(url)) openBundledLicense(url)
    return { action: 'deny' }
  })
  window.webContents.on('render-process-gone', () => {
    rendererReady = false; clearCloseRequest()
    void nativeAudio?.request('engine.close').catch(() => {})
  })
  await window.loadURL(APP_URL)
}

async function runCli(): Promise<void> {
  if (process.platform === 'win32') {
    // A GUI-subsystem executable cannot reliably preserve the MCP host's pipes.
    // garak-mcp.exe sets Node mode before Electron initializes and owns those handles.
    process.stderr.write('Windows MCP 연결에는 같은 설치 폴더의 garak-mcp.exe --mcp 또는 --mcp-token을 사용해주세요.\n', () => app.exit(1))
    return
  }
  try {
    if (process.argv.includes('--mcp') && process.argv.includes('--mcp-token')) throw new Error('Choose one CLI mode.')
    if (cliMode === 'token') {
      const { runTokenCli } = await import(pathToFileURL(join(app.getAppPath(), 'dist-mcp/mcp/token.js')).href)
      await runTokenCli()
    } else {
      const { startMcpServer } = await import(pathToFileURL(join(app.getAppPath(), 'dist-mcp/mcp/server.js')).href)
      const handle = await startMcpServer()
      await handle.closed
    }
    app.exit(0)
  } catch (error) {
    process.stderr.write(`${desktopMcpStartupErrorMessage(error)}\n`, () => app.exit(1))
  }
}

if (cliMode) {
  void runCli()
} else {
  const profile = process.env.GARAK_DESKTOP_TEST_PROFILE
  if (profile && !isAbsolute(profile)) throw new Error('GARAK_DESKTOP_TEST_PROFILE must be an absolute path.')
  const userData = profile || join(app.getPath('appData'), 'GarakIeum')
  mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)
  if (!app.requestSingleInstanceLock()) app.quit()
  else {
    app.on('open-file', (event, path) => { event.preventDefault(); queueProject(path) })
    app.on('second-instance', (_event, argv) => {
      if (window?.isMinimized()) window.restore()
      window?.show(); window?.focus()
      const path = argv.find(argument => isAbsolute(argument) && extname(argument).toLowerCase() === '.garak')
      if (path) queueProject(path)
    })
    app.on('before-quit', event => { if (window && !allowClose) { event.preventDefault(); window.close() } })
    app.on('window-all-closed', () => {
      if (nativeAudio) void nativeAudio.dispose().then(() => app.quit(), () => app.quit())
      else app.quit()
    })
    app.whenReady().then(async () => {
      await serveAssets()
      nativeAudio = new NativeAudioService({
        executable: join(app.isPackaged ? process.resourcesPath : app.getAppPath(), app.isPackaged ? 'native' : 'build/native-audio', process.platform === 'win32' ? 'garak-audio-host.exe' : 'garak-audio-host'),
        profileDirectory: app.getPath('userData'),
        testClock: Boolean(profile && process.env.GARAK_NATIVE_TEST_CLOCK === '1'),
        allowInput: approveMicrophone,
        onState: state => { if (window && !window.isDestroyed()) window.webContents.send('garak:audio-state', state) },
        selectPlugin: async () => {
          if (!window || fileDialogPending || pendingClose) return null
          fileDialogPending = true
          try {
            const selection = await dialog.showMessageBox(window, {
              title: 'VST3 플러그인 추가', message: '추가할 .vst3 플러그인의 형식을 선택해주세요.',
              buttons: ['파일 선택', '번들 폴더 선택', '취소'], defaultId: process.platform === 'darwin' ? 1 : 0, cancelId: 2, noLink: true,
            })
            if (selection.response === 2) return null
            const result = await dialog.showOpenDialog(window, {
              title: 'VST3 플러그인 선택',
              properties: selection.response === 1 ? ['openDirectory', 'treatPackageAsDirectory'] : ['openFile'],
              filters: [{ name: 'VST3', extensions: ['vst3'] }],
            })
            return result.canceled ? null : result.filePaths[0] ?? null
          } finally { fileDialogPending = false }
        },
      })
      installIpc()
      installPermissions()
      buildMenu()
      for (const argument of process.argv.slice(process.defaultApp ? 2 : 1)) queueProject(argument)
      await createWindow()
    }).catch(() => {
      dialog.showErrorBox('가락이음을 시작하지 못했습니다', '설치 파일을 다시 실행해주세요. 기존 프로젝트 데이터는 이 컴퓨터에 보관되어 있습니다.')
      app.exit(1)
    })
  }
}

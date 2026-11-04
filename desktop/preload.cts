import electron = require('electron')
import type { DesktopBridge, DesktopFile, DesktopSaveRequest, DesktopSaveResult } from './contracts.js'

const { contextBridge, ipcRenderer } = electron
const version = process.argv.find(argument => argument.startsWith('--garak-version='))?.slice('--garak-version='.length) ?? 'unknown'

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

const bridge: DesktopBridge = {
  isDesktop: true,
  platform: process.platform,
  version,
  windowChrome: {
    setColors: colors => ipcRenderer.invoke('garak:window-colors', colors),
    view: command => { ipcRenderer.send('garak:window-view', command) },
  },
  audio: {
    request: (method, params) => ipcRenderer.invoke('garak:audio-request', method, params ?? {}),
    subscribe: callback => subscribe('garak:audio-state', callback),
  },
  openProject: (): Promise<DesktopFile | null> => ipcRenderer.invoke('garak:open-project'),
  saveFile: (request: DesktopSaveRequest): Promise<DesktopSaveResult> => ipcRenderer.invoke('garak:save-file', request),
  onOpenProject: callback => subscribe('garak:project-opened', callback),
  onSaveProject: callback => subscribe('garak:save-project', callback),
  onNewProject: callback => subscribe('garak:new-project', callback),
  onBeforeClose(callback) {
    let active = true
    const release = subscribe<string>('garak:before-close', async requestId => {
      if (!active || typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(requestId)) return
      let allowed = false
      try { allowed = await callback() === true } catch { /* A failed autosave must never authorize closing. */ }
      if (active) ipcRenderer.send('garak:close-response', { requestId, allowed })
    })
    return () => { active = false; release() }
  },
  ready: () => { ipcRenderer.send('garak:ready') },
}

contextBridge.exposeInMainWorld('garakDesktop', Object.freeze(bridge))

if (process.platform === 'darwin') {
  // Keep this signal private to the isolated preload. Never send field values,
  // selected text, clipboard contents, or keystrokes across this IPC channel.
  let lastTextFocus: boolean | undefined
  const reportTextFocus = () => {
    const active = document.activeElement
    const focused = document.hasFocus() && active instanceof HTMLElement && (active.isContentEditable
      || Boolean(active.closest('input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]),textarea,[data-selectable-text],[role="textbox"],[role="searchbox"],[role="spinbutton"]')))
    if (focused !== lastTextFocus) {
      lastTextFocus = focused
      ipcRenderer.send('garak:text-focus', focused)
    }
  }
  document.addEventListener('focusin', reportTextFocus, true)
  document.addEventListener('focusout', () => queueMicrotask(reportTextFocus), true)
  document.addEventListener('DOMContentLoaded', reportTextFocus, { once: true })
  window.addEventListener('focus', reportTextFocus)
  window.addEventListener('blur', reportTextFocus)
}

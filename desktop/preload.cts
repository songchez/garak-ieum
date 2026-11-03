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

/** Narrow desktop capabilities; the renderer never receives a filesystem API. */
export interface DesktopFile {
  name: string
  data: Uint8Array
}

export type DesktopExportKind = 'project' | 'audio' | 'json'

/** Window-level 보기 commands the in-app menu bar forwards to the native frame. */
export type DesktopViewCommand = 'zoomIn' | 'zoomOut' | 'resetZoom' | 'toggleFullscreen'

export interface DesktopSaveRequest extends DesktopFile {
  kind: DesktopExportKind
}

export interface DesktopSaveResult {
  canceled: boolean
  fileName?: string
}

export interface DesktopBridge {
  readonly isDesktop: true
  readonly platform: string
  readonly version: string
  /** Native caption buttons remain OS-owned; only their appearance is exposed. */
  readonly windowChrome?: {
    setColors(colors: { background: string; foreground: string }): Promise<void>
    view(command: DesktopViewCommand): void
  }
  readonly audio: {
    request(method: string, params?: Record<string, unknown>): Promise<unknown>
    subscribe(callback: (event: { type: 'state' | 'error'; error?: string | null }) => void): () => void
  }
  openProject(): Promise<DesktopFile | null>
  saveFile(request: DesktopSaveRequest): Promise<DesktopSaveResult>
  onOpenProject(callback: (file: DesktopFile) => void): () => void
  onSaveProject(callback: () => void): () => void
  onNewProject(callback: () => void): () => void
  onBeforeClose(callback: () => Promise<boolean>): () => void
  ready(): void
}

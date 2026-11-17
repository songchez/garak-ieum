/** Narrow desktop capabilities; the renderer never receives a filesystem API. */
export interface DesktopFile {
  name: string
  data: Uint8Array
}

export type DesktopExportKind = 'project' | 'audio' | 'json' | 'midi'

/** Window-level 보기 commands the in-app menu bar forwards to the native frame. */
export type DesktopViewCommand = 'zoomIn' | 'zoomOut' | 'resetZoom' | 'toggleFullscreen'

export interface DesktopSaveRequest extends DesktopFile {
  kind: DesktopExportKind
}

export interface DesktopSaveResult {
  canceled: boolean
  fileName?: string
}

/** A folder the user picked for a multi-file export (stems); files are written into a new subfolder. */
export interface DesktopFolderResult {
  canceled: boolean
  /** Opaque handle for writeExportFile; no filesystem path crosses into the renderer. */
  token?: string
  folderName?: string
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
  /** Stem export: pick a parent folder; a subfolder named after `name` is created there. */
  chooseExportFolder?(name: string): Promise<DesktopFolderResult>
  /** Writes one .wav into the chosen folder (a plain file name, never a path). */
  writeExportFile?(token: string, name: string, data: Uint8Array): Promise<void>
  /** Forgets the folder handle. */
  closeExportFolder?(token: string): Promise<void>
  onOpenProject(callback: (file: DesktopFile) => void): () => void
  onSaveProject(callback: () => void): () => void
  onNewProject(callback: () => void): () => void
  /** `awaitingUser` stops the main process's "still saving" fallback dialog while the app asks the user a question. */
  onBeforeClose(callback: (control: { awaitingUser(): void }) => Promise<boolean>): () => void
  ready(): void
}

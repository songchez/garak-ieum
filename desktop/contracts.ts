/** Narrow desktop capabilities; the renderer never receives a filesystem API. */
export interface DesktopFile {
  name: string
  data: Uint8Array
}

export type DesktopExportKind = 'project' | 'audio' | 'json'

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

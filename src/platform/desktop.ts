import type { DesktopBridge, DesktopExportKind, DesktopFile } from '../../desktop/contracts'

declare global {
  interface Window { readonly garakDesktop?: DesktopBridge }
}

export type ExportResult =
  | { status: 'saved'; fileName?: string }
  | { status: 'canceled' }
  | { status: 'download-started' }

export function getDesktopBridge(): DesktopBridge | undefined {
  return typeof window !== 'undefined' && window.garakDesktop?.isDesktop === true ? window.garakDesktop : undefined
}

export const isDesktopApp = (): boolean => Boolean(getDesktopBridge())

/** Copy only the selected bytes; no filesystem path crosses into the renderer. */
export function desktopProjectFile(file: DesktopFile): File {
  return new File([new Uint8Array(file.data)], file.name, { type: 'application/json' })
}

/** Cancellation is a completed dialog, not a successful write or a browser fallback. */
export async function saveExport(blob: Blob, name: string, kind: DesktopExportKind): Promise<ExportResult> {
  const desktop = getDesktopBridge()
  if (desktop) {
    const result = await desktop.saveFile({ name, kind, data: new Uint8Array(await blob.arrayBuffer()) })
    return result.canceled ? { status: 'canceled' } : { status: 'saved', ...(result.fileName ? { fileName: result.fileName } : {}) }
  }
  const url = URL.createObjectURL(blob)
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }
  // A browser does not report whether its download was ultimately kept or canceled.
  return { status: 'download-started' }
}

/** Keep the web file input on the original click's activation stack. */
export async function chooseProjectFile(openBrowserPicker: () => void): Promise<File | null> {
  const desktop = getDesktopBridge()
  if (!desktop) { openBrowserPicker(); return null }
  const file = await desktop.openProject()
  return file ? desktopProjectFile(file) : null
}

export interface DesktopProjectHandlers {
  open(file: File): void | Promise<void>
  save(): void | Promise<void>
  create(): void | Promise<void>
  beforeClose(): Promise<boolean>
  error(error: unknown): void
}

/** Install all lifecycle handlers before queued OS/menu events are released. */
export function bindDesktopProjectEvents(handlers: DesktopProjectHandlers): () => void {
  const desktop = getDesktopBridge()
  if (!desktop) return () => {}
  const releases: (() => void)[] = []
  const run = (action: () => void | Promise<void>) => {
    try { void Promise.resolve(action()).catch(handlers.error) }
    catch (error) { handlers.error(error) }
  }
  const dispose = () => { for (const release of releases.splice(0).reverse()) release() }
  try {
    releases.push(desktop.onOpenProject(file => run(() => handlers.open(desktopProjectFile(file)))))
    releases.push(desktop.onSaveProject(() => run(handlers.save)))
    releases.push(desktop.onNewProject(() => run(handlers.create)))
    releases.push(desktop.onBeforeClose(async () => {
      try { return await handlers.beforeClose() }
      catch (error) { handlers.error(error); return false }
    }))
    desktop.ready()
    return dispose
  } catch (error) {
    dispose()
    throw error
  }
}

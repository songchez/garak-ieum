import { useEffect, useSyncExternalStore } from 'react'
import type { NativePluginDescriptor } from '../audio/native/contracts'

/** The subset of the native engine the catalog needs; Web Audio engines have none of it. */
export interface PluginCatalogEngine {
  kind?: string
  listPlugins?(): Promise<NativePluginDescriptor[]>
  scanPlugins?(): Promise<NativePluginDescriptor[]>
}

export interface PluginCatalog {
  /** False on Web Audio: VST3 needs the desktop engine. */
  supported: boolean
  plugins: readonly NativePluginDescriptor[]
  loaded: boolean
  scanning: boolean
  error: string
  /** Set by the last scan: how many plugins it registered. */
  lastScanAdded: number | null
}

export const pluginKey = (plugin: { pluginId: string; classId: string }) => `${plugin.pluginId}:${plugin.classId.toUpperCase()}`

const UNSUPPORTED: PluginCatalog = Object.freeze({ supported: false, plugins: [], loaded: true, scanning: false, error: '', lastScanAdded: null })
const supports = (engine: PluginCatalogEngine): engine is Required<PluginCatalogEngine> =>
  engine.kind === 'native' && typeof engine.listPlugins === 'function' && typeof engine.scanPlugins === 'function'

/** One catalog per engine, shared by the device chain, the library and the settings plugin tab. */
class CatalogStore {
  private snapshot: PluginCatalog = { supported: true, plugins: [], loaded: false, scanning: false, error: '', lastScanAdded: null }
  private listeners = new Set<() => void>()
  private loading: Promise<void> | null = null
  constructor(private readonly engine: Required<PluginCatalogEngine>) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.snapshot
  private set(patch: Partial<PluginCatalog>) { this.snapshot = { ...this.snapshot, ...patch }; for (const listener of this.listeners) listener() }
  load(): Promise<void> {
    if (this.snapshot.loaded) return Promise.resolve()
    this.loading ??= this.engine.listPlugins().then(plugins => this.set({ plugins, loaded: true, error: '' }), error => {
      this.loading = null
      this.set({ error: error instanceof Error ? error.message : String(error) })
    })
    return this.loading
  }
  async scan(): Promise<void> {
    if (this.snapshot.scanning) return
    this.set({ scanning: true, error: '', lastScanAdded: null })
    try {
      const added = await this.engine.scanPlugins()
      const plugins = [...new Map([...this.snapshot.plugins, ...added].map(plugin => [pluginKey(plugin), plugin])).values()]
      this.set({ plugins, loaded: true, scanning: false, lastScanAdded: added.length })
    } catch (error) {
      this.set({ scanning: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

const stores = new WeakMap<object, CatalogStore>()
function storeFor(engine: PluginCatalogEngine): CatalogStore | null {
  if (!supports(engine)) return null
  let store = stores.get(engine)
  if (!store) { store = new CatalogStore(engine); stores.set(engine, store) }
  return store
}
const noSubscribe = () => () => {}
const unsupported = () => UNSUPPORTED

export function usePluginCatalog(engine: PluginCatalogEngine): PluginCatalog & { scan(): Promise<void> } {
  const store = storeFor(engine)
  const catalog = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.getSnapshot ?? unsupported, store?.getSnapshot ?? unsupported)
  useEffect(() => { void store?.load() }, [store])
  return { ...catalog, scan: () => store?.scan() ?? Promise.resolve() }
}

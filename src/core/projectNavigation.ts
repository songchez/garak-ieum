export type ProjectRoute = { kind: 'home' } | { kind: 'project'; id: string } | { kind: 'not-found'; path: string }

export interface ProjectNavigationSnapshot {
  route: ProjectRoute
  pending: boolean
}

export interface NavigationLocation {
  pathname: string
  state: unknown
  /** Same-origin pathname, search and hash. Defaults to pathname in non-browser hosts. */
  url?: string
  /** Optional, read-only Navigation API index; never guessed from history.length. */
  position?: number
}

/** Small history adapter; neither the controller nor the browser adapter patches global APIs. */
export interface NavigationHost {
  read(): NavigationLocation
  push(url: string, state: unknown): void
  replace(url: string, state: unknown): void
  go(delta: number): void
  listen(listener: () => void): () => void
  /** Commit an active name/number input before the pending UI makes the editor inert. */
  prepareLeave?(): void
}

const STATE_KEY = '__garakProjectNavigation'
const PREVIOUS_STATE_KEY = '__garakPreviousHistoryState'
const CANCELLED = Symbol('navigation cancelled')
const RETRY_TRAVERSAL_MS = 120
const SETTLE_TRAVERSAL_MS = 24
const TRAVERSAL_TIMEOUT_MS = 5000

interface HistoryStamp { version: 1; epoch: string; index: number; key: string }
interface Entry { location: NavigationLocation; stamp: HistoryStamp | null }
interface Task {
  source: Entry
  phase: 'restore' | 'guard' | 'factory' | 'commit' | 'unmanaged'
  cancelled: Promise<typeof CANCELLED>
  cancel(): void
  wake?: () => void
  recovery: Promise<void> | null
  preparationFailed: boolean
  preparationError?: unknown
}

function validId(id: string): boolean {
  // Dot segments are normalized by browsers, even when percent-encoded.
  return typeof id === 'string' && !!id.trim() && id.length <= 200 && id !== '.' && id !== '..'
}

export function parseProjectRoute(pathname: string): ProjectRoute {
  if (pathname === '/') return { kind: 'home' }
  const match = /^\/projects\/([^/\\?#\u0000-\u0020]+)$/.exec(pathname)
  if (match) {
    try {
      const id = decodeURIComponent(match[1])
      if (validId(id)) return { kind: 'project', id }
    } catch { /* A malformed escape is a missing route, not a render-time exception. */ }
  }
  return { kind: 'not-found', path: pathname }
}

export function projectPath(id: string): string {
  if (!validId(id)) throw new Error('프로젝트 ID로 URL을 만들 수 없습니다.')
  // encodeURIComponent also rejects lone surrogates instead of silently changing an ID.
  return `/projects/${encodeURIComponent(id)}`
}

function pathForRoute(route: ProjectRoute): string {
  if (route.kind === 'home') return '/'
  if (route.kind === 'project') return projectPath(route.id)
  if (!route.path.startsWith('/') || route.path.startsWith('//') || /[\\?#\u0000-\u0020]/.test(route.path)) {
    throw new Error('프로젝트 경로가 올바르지 않습니다.')
  }
  return route.path
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stampOf(state: unknown): HistoryStamp | null {
  const value = record(state) ? state[STATE_KEY] : undefined
  if (!record(value) || value.version !== 1 || typeof value.epoch !== 'string' || !value.epoch || value.epoch.length > 200 ||
    typeof value.key !== 'string' || !value.key || value.key.length > 200 ||
    !Number.isSafeInteger(value.index) || (value.index as number) < 0) return null
  return { version: 1, epoch: value.epoch, index: value.index as number, key: value.key }
}

function stateWithStamp(state: unknown, stamp: HistoryStamp): unknown {
  const ordinaryObject = record(state) && (Object.getPrototypeOf(state) === Object.prototype || Object.getPrototypeOf(state) === null)
  return ordinaryObject ? { ...state, [STATE_KEY]: stamp } : {
    ...(state == null ? {} : { [PREVIOUS_STATE_KEY]: state }), [STATE_KEY]: stamp,
  }
}

let serial = 0
function identifier(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${(++serial).toString(36)}-${Math.random().toString(36).slice(2)}`
}

function readEntry(host: NavigationHost): Entry {
  const location = host.read()
  return { location, stamp: stampOf(location.state) }
}

function urlOf(entry: Entry): string { return entry.location.url ?? entry.location.pathname }
function positioned(location: NavigationLocation): boolean { return Number.isSafeInteger(location.position) && location.position! >= 0 }

function sameEntry(a: Entry, b: Entry): boolean {
  if (urlOf(a) !== urlOf(b)) return false
  if (a.stamp && b.stamp) return a.stamp.epoch === b.stamp.epoch && a.stamp.key === b.stamp.key && a.stamp.index === b.stamp.index
  if (positioned(a.location) && positioned(b.location)) return a.location.position === b.location.position
  return !a.stamp && !b.stamp
}

function distance(from: Entry, to: Entry): number | null {
  if (positioned(from.location) && positioned(to.location)) {
    const delta = to.location.position! - from.location.position!
    return delta || (sameEntry(from, to) ? 0 : null)
  }
  if (from.stamp && to.stamp && from.stamp.epoch === to.stamp.epoch) {
    const delta = to.stamp.index - from.stamp.index
    return delta || (sameEntry(from, to) ? 0 : null)
  }
  return null
}

function sameRoute(a: ProjectRoute, b: ProjectRoute): boolean {
  return a.kind === b.kind && (a.kind === 'home' || (a.kind === 'project' && b.kind === 'project' ? a.id === b.id : a.kind === 'not-found' && b.kind === 'not-found' && a.path === b.path))
}

/**
 * One navigation at a time. A factory runs only after the old editor has saved;
 * the destination is published only after its creation/persistence has finished.
 *
 * Managed Back/Forward first traverses back to the editing entry, runs the same
 * guard as navigate(), and then traverses to the approved entry. Neither denial
 * nor approval replaces an existing history entry or discards its forward branch.
 */
export class ProjectNavigation {
  private snapshot: ProjectNavigationSnapshot
  private readonly listeners = new Set<() => void>()
  private current: Entry | null = null
  private task: Task | null = null
  private starts = 0
  private unlisten: (() => void) | null = null
  private restoreOnStart = false

  constructor(private readonly host: NavigationHost, private readonly beforeLeave: () => Promise<boolean>) {
    // React StrictMode can construct this twice. Do not stamp or subscribe here.
    this.snapshot = { route: parseProjectRoute(host.read().pathname), pending: false }
  }

  getSnapshot = (): ProjectNavigationSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  start(): () => void {
    if (this.starts++ === 0) {
      this.unlisten = this.host.listen(this.onPop)
      if (this.restoreOnStart && this.current) {
        this.restoreOnStart = false
        const task = this.begin()
        void this.recover(task)
      } else {
        this.current = this.adopt(readEntry(this.host))
        this.publish(false)
      }
    }
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      if (--this.starts !== 0) return
      this.unlisten?.()
      this.unlisten = null
      if (this.task) {
        this.restoreOnStart = true
        const task = this.task
        this.task = null
        task.cancel()
        task.wake?.()
      }
      this.publish(false)
    }
  }

  async navigate(destination: ProjectRoute | (() => Promise<ProjectRoute>)): Promise<boolean> {
    if (!this.starts || !this.current || this.task) return false
    if (typeof destination !== 'function' && pathForRoute(destination) === this.current.location.pathname) return true
    const task = this.begin()
    try {
      await this.restore(task)
      this.checkPreparation(task)
      task.phase = 'guard'
      const allowed = await this.wait(task, this.beforeLeave())
      await this.restore(task)
      this.check(task)
      if (!allowed) return false
      task.phase = 'factory'
      const route = typeof destination === 'function' ? await this.wait(task, destination()) : destination
      await this.restore(task)
      this.check(task)
      const path = pathForRoute(route)
      if (path !== this.current!.location.pathname) this.current = this.push(path)
      return true
    } catch (error) {
      if (error === CANCELLED) return false
      await this.restoreAfterFailure(task)
      throw error
    } finally { this.finish(task) }
  }

  private begin(): Task {
    let cancel!: () => void
    const cancelled = new Promise<typeof CANCELLED>(resolve => { cancel = () => resolve(CANCELLED) })
    const task: Task = { source: this.current!, phase: 'restore', cancelled, cancel, recovery: null, preparationFailed: false }
    this.task = task
    try { this.host.prepareLeave?.() } catch (error) { task.preparationFailed = true; task.preparationError = error }
    this.publish(true)
    return task
  }

  private check(task: Task): void { if (!this.starts || this.task !== task) throw CANCELLED }
  private checkPreparation(task: Task): void { this.check(task); if (task.preparationFailed) throw task.preparationError }

  private async wait<T>(task: Task, value: Promise<T>): Promise<T> {
    const result = await Promise.race([value, task.cancelled])
    this.check(task)
    if (result === CANCELLED) throw CANCELLED
    return result as T
  }

  private publish(pending: boolean): void {
    const route = this.current ? parseProjectRoute(this.current.location.pathname) : this.snapshot.route
    if (pending === this.snapshot.pending && sameRoute(route, this.snapshot.route)) return
    this.snapshot = { route: sameRoute(route, this.snapshot.route) ? this.snapshot.route : route, pending }
    for (const listener of this.listeners) listener()
  }

  private finish(task: Task): void {
    if (this.task !== task) return
    this.task = null
    this.publish(false)
  }

  private adopt(entry: Entry, newEpoch = false): Entry {
    if (!newEpoch && entry.stamp) return entry
    const stamp: HistoryStamp = { version: 1, epoch: identifier(), index: 0, key: identifier() }
    this.host.replace(urlOf(entry), stateWithStamp(entry.location.state, stamp))
    return readEntry(this.host)
  }

  private push(url: string, freshEpoch = false, state: unknown = null): Entry {
    const previous = this.current?.stamp
    const continueEpoch = !freshEpoch && previous && previous.index < Number.MAX_SAFE_INTEGER
    const stamp: HistoryStamp = { version: 1, epoch: continueEpoch ? previous.epoch : identifier(), index: continueEpoch ? previous.index + 1 : 0, key: identifier() }
    this.host.push(url, stateWithStamp(state, stamp))
    return readEntry(this.host)
  }

  private onPop = (): void => {
    if (!this.starts || !this.current) return
    if (this.task) {
      const task = this.task
      task.wake?.()
      if (task.phase !== 'commit' && task.phase !== 'unmanaged') {
        // The first action owns the guard/factory. Later browser actions only
        // restore that action's source; they cannot publish a stale destination.
        void this.restore(task).catch(() => { /* The owning operation also awaits recovery. */ })
      }
      return
    }
    const target = readEntry(this.host)
    if (sameEntry(this.current, target)) return
    const task = this.begin()
    void this.pop(task, target)
  }

  private async pop(task: Task, target: Entry): Promise<void> {
    try {
      if (distance(target, task.source) === null) {
        // The History API supplies no index for arbitrary external pushState
        // entries. Do not guess a direction or overwrite the unknown entry.
        task.phase = 'unmanaged'
        this.checkPreparation(task)
        const allowed = await this.wait(task, this.beforeLeave())
        if (allowed) {
          this.current = sameEntry(readEntry(this.host), target)
            ? this.adopt(readEntry(this.host), true)
            : this.push(urlOf(target), true, target.location.state)
        } else this.restoreUnmanaged(task)
        return
      }
      await this.restore(task)
      this.checkPreparation(task)
      task.phase = 'guard'
      const allowed = await this.wait(task, this.beforeLeave())
      await this.restore(task)
      if (!allowed) return
      task.phase = 'commit'
      if (await this.travel(task, target)) this.current = this.adopt(readEntry(this.host))
      else {
        // Only an intervening unmanaged entry can lose the index relationship.
        // The already-approved destination gets a new entry, never a replacement.
        this.current = this.push(urlOf(target), true, target.location.state)
      }
    } catch (error) {
      if (error !== CANCELLED) {
        await this.restoreAfterFailure(task)
        // There is no navigate() caller to catch popstate errors. The editor's
        // guard presents save failures; unexpected adapter errors remain visible.
        console.error('프로젝트 이동을 중단했습니다.', error)
      }
    } finally { this.finish(task) }
  }

  private restoreUnmanaged(task: Task): void {
    this.check(task)
    if (sameEntry(readEntry(this.host), task.source)) return
    // Limited fallback for externally inserted, index-less history only:
    // preserve the unknown target entry by pushing the editor URL. The browser
    // may discard a forward branch here; managed navigation never uses this.
    this.current = this.push(urlOf(task.source), true, task.source.location.state)
    task.source = this.current
  }

  private restore(task: Task): Promise<void> {
    this.check(task)
    if (task.recovery) return task.recovery
    const recovery = (async () => {
      if (!await this.travel(task, task.source)) this.restoreUnmanaged(task)
    })()
    task.recovery = recovery
    const clear = () => { if (task.recovery === recovery) task.recovery = null }
    void recovery.then(clear, clear)
    return recovery
  }

  private async restoreAfterFailure(task: Task): Promise<void> {
    if (this.task !== task || !this.starts) return
    task.phase = 'restore'
    try { await this.restore(task) } catch (error) {
      if (error !== CANCELLED) console.error('프로젝트 URL을 복구하지 못했습니다.', error)
    }
  }

  private async recover(task: Task): Promise<void> {
    try { await this.restore(task) } catch (error) {
      if (error !== CANCELLED) console.error('프로젝트 URL을 복구하지 못했습니다.', error)
    } finally { this.finish(task) }
  }

  private async pause(task: Task, milliseconds: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let wake!: () => void
    const signal = new Promise<boolean>(resolve => { wake = () => resolve(false); timer = setTimeout(() => resolve(true), milliseconds) })
    task.wake = wake
    try { return await this.wait(task, signal) } finally {
      clearTimeout(timer)
      if (task.wake === wake) task.wake = undefined
    }
  }

  private async travel(task: Task, target: Entry): Promise<boolean> {
    const began = Date.now()
    let lastCommand = -Infinity
    let issued = false
    while (true) {
      this.check(task)
      if (Date.now() - began > TRAVERSAL_TIMEOUT_MS) throw new Error('브라우저 방문 기록 이동이 완료되지 않았습니다.')
      const actual = readEntry(this.host)
      if (sameEntry(actual, target)) {
        if (!issued) return true
        // A short quiet period lets queued rapid Back/Forward tasks drain before
        // a guard/provider can commit. popstate itself cannot be cancelled.
        const quiet = await this.pause(task, SETTLE_TRAVERSAL_MS)
        if (quiet && sameEntry(readEntry(this.host), target)) return true
      } else {
        const delta = distance(actual, target)
        if (delta === null) return false
        const remaining = RETRY_TRAVERSAL_MS - (Date.now() - lastCommand)
        if (remaining > 0) { await this.pause(task, remaining); continue }
        // Only one corrective go is issued per settling interval. If several
        // native traversals were queued first, recompute from the actual entry
        // after they settle instead of accumulating obsolete relative deltas.
        this.host.go(delta)
        issued = true
        lastCommand = Date.now()
        await this.pause(task, RETRY_TRAVERSAL_MS)
      }
    }
  }
}

export function browserNavigationHost(browser: Window = window): NavigationHost {
  return {
    read: () => {
      const navigation = (browser as Window & { navigation?: { currentEntry?: { index?: number } } }).navigation
      const position = navigation?.currentEntry?.index
      return { pathname: browser.location.pathname, url: `${browser.location.pathname}${browser.location.search}${browser.location.hash}`, state: browser.history.state,
        ...(Number.isSafeInteger(position) && position! >= 0 ? { position } : {}) }
    },
    push: (url, state) => { browser.history.pushState(state, '', url) },
    replace: (url, state) => { browser.history.replaceState(state, '', url) },
    go: delta => { browser.history.go(delta) },
    listen: listener => { browser.addEventListener('popstate', listener); return () => browser.removeEventListener('popstate', listener) },
    prepareLeave: () => {
      const active = browser.document.activeElement
      if (active && 'blur' in active && typeof active.blur === 'function') active.blur()
    },
  }
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserNavigationHost, parseProjectRoute, projectPath, ProjectNavigation, type NavigationHost, type NavigationLocation, type ProjectRoute } from './projectNavigation'

interface HistoryEntry { url: string; state: unknown }

/**
 * EventTarget history stack with asynchronous, relative traversals. In particular,
 * go() does not synchronously change the URL: user and corrective traversals share
 * a FIFO queue, and the delta is applied when that queued traversal actually runs.
 */
class HistoryHost extends EventTarget implements NavigationHost {
  entries: HistoryEntry[]
  cursor: number
  queue: number[] = []
  writes: { kind: 'push' | 'replace'; url: string }[] = []
  corrections: number[] = []
  listening = 0
  prepare = vi.fn()

  constructor(entries: HistoryEntry[] = [{ url: '/', state: null }], cursor = entries.length - 1, private positions = false) {
    super()
    this.entries = structuredClone(entries)
    this.cursor = cursor
  }

  read(): NavigationLocation {
    const entry = this.entries[this.cursor], url = new URL(entry.url, 'https://garak.test')
    return { pathname: url.pathname, url: `${url.pathname}${url.search}${url.hash}`, state: structuredClone(entry.state), ...(this.positions ? { position: this.cursor } : {}) }
  }

  push(url: string, state: unknown): void {
    this.entries.splice(this.cursor + 1, Infinity, { url, state: structuredClone(state) })
    this.cursor++
    this.writes.push({ kind: 'push', url })
  }

  replace(url: string, state: unknown): void {
    this.entries[this.cursor] = { url, state: structuredClone(state) }
    this.writes.push({ kind: 'replace', url })
  }

  go(delta: number): void { this.corrections.push(delta); this.queue.push(delta) }
  userGo(delta: number): void { this.queue.push(delta) }

  step(): void {
    const delta = this.queue.shift()
    if (delta === undefined) return
    const next = this.cursor + delta
    if (next < 0 || next >= this.entries.length) return
    this.cursor = next
    this.dispatchEvent(new Event('popstate'))
  }

  listen(listener: () => void): () => void {
    this.listening++
    this.addEventListener('popstate', listener)
    return () => { this.listening--; this.removeEventListener('popstate', listener) }
  }

  prepareLeave(): void { this.prepare() }
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function microtasks(): Promise<void> { for (let index = 0; index < 12; index++) await Promise.resolve() }

async function drain(host: HistoryHost): Promise<void> {
  for (let index = 0; index < 100; index++) {
    await microtasks()
    if (host.queue.length) host.step()
    else if (vi.getTimerCount()) await vi.advanceTimersToNextTimerAsync()
    else return
  }
  throw new Error('History did not settle')
}

const project = (id: string): ProjectRoute => ({ kind: 'project', id })
const stops: (() => void)[] = []

function start(host: HistoryHost, guard: () => Promise<boolean> = async () => true) {
  const controller = new ProjectNavigation(host, guard)
  stops.push(controller.start())
  return controller
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('project URL grammar', () => {
  it('parses the chooser, exact project paths, and URL-encoded legacy IDs', () => {
    expect(parseProjectRoute('/')).toEqual({ kind: 'home' })
    for (const id of ['abc-123', '첫 작업', '기존/ID', '100%#?&', '한옥 🎵', ' leading space ', '~id', 'id.with.dots']) {
      const path = projectPath(id)
      expect(parseProjectRoute(path)).toEqual(project(id))
      expect(new URL(path, 'https://garak.test').pathname).toBe(path)
    }
    expect(projectPath('기존/ID')).toBe('/projects/%EA%B8%B0%EC%A1%B4%2FID')
  })

  it('rejects malformed escapes, missing IDs, unknown paths and non-roundtrippable IDs', () => {
    for (const path of ['/projects', '/projects/', '/projects/a/', '/projects/a/b', '/project/a', '//projects/a', '/projects/%', '/projects/%E0%A4', '/projects/%20', '/projects/.', '/projects/..', '/projects/a?b', '/projects/a#b', '/projects/a\\b', '/projects/' + 'x'.repeat(201)]) {
      expect(parseProjectRoute(path)).toEqual({ kind: 'not-found', path })
    }
    for (const id of ['', ' ', '.', '..', 'x'.repeat(201), '\uD800']) expect(() => projectPath(id)).toThrow()
  })
})

describe('project navigation', () => {
  it('constructs without writes, keeps stable snapshots, and supports StrictMode start/cleanup', () => {
    const host = new HistoryHost([{ url: '/projects/a?view=mix#bar-2', state: { foreign: { keep: true } } }])
    const controller = new ProjectNavigation(host, async () => true)
    const initial = controller.getSnapshot(), changed = vi.fn()
    const unsubscribe = controller.subscribe(changed)
    expect(host.writes).toEqual([])
    expect(host.listening).toBe(0)
    expect(controller.getSnapshot()).toBe(initial)
    const firstStop = controller.start()
    expect(controller.getSnapshot()).toBe(initial)
    expect(host.writes).toEqual([{ kind: 'replace', url: '/projects/a?view=mix#bar-2' }])
    expect(host.read().state).toMatchObject({ foreign: { keep: true } })
    firstStop(); firstStop()
    const stop = controller.start()
    stops.push(stop)
    expect(host.listening).toBe(1)
    expect(host.writes).toHaveLength(1)
    expect(changed).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('commits the active input before pending, awaits the save guard, then awaits creation before push', async () => {
    const host = new HistoryHost(), saving = deferred<boolean>(), creating = deferred<ProjectRoute>()
    const order: string[] = []
    host.prepare.mockImplementation(() => { order.push('prepare') })
    const guard = vi.fn(() => { order.push('guard'); return saving.promise })
    const controller = start(host, guard)
    controller.subscribe(() => { if (controller.getSnapshot().pending) order.push('pending') })
    const factory = vi.fn(() => { order.push('factory'); return creating.promise })
    const first = controller.getSnapshot()
    const result = controller.navigate(factory)
    await microtasks()
    expect(order).toEqual(['prepare', 'pending', 'guard'])
    expect(controller.getSnapshot()).not.toBe(first)
    expect(controller.getSnapshot()).toEqual({ route: { kind: 'home' }, pending: true })
    expect(host.read().pathname).toBe('/')
    saving.resolve(true)
    await microtasks()
    expect(order).toEqual(['prepare', 'pending', 'guard', 'factory'])
    expect(host.entries).toHaveLength(1)
    creating.resolve(project('created'))
    expect(await result).toBe(true)
    expect(host.read().pathname).toBe('/projects/created')
    expect(controller.getSnapshot()).toEqual({ route: project('created'), pending: false })
    expect(host.writes.filter(write => write.kind === 'push')).toHaveLength(1)
  })

  it('does not guard or duplicate an already active route', async () => {
    const host = new HistoryHost([{ url: '/projects/a', state: null }]), guard = vi.fn(async () => true)
    const controller = start(host, guard)
    expect(await controller.navigate(project('a'))).toBe(true)
    expect(guard).not.toHaveBeenCalled()
    expect(host.prepare).not.toHaveBeenCalled()
    expect(host.entries).toHaveLength(1)
  })

  it('denies a dirty editor without creating the destination and ignores concurrent navigate calls', async () => {
    const host = new HistoryHost([{ url: '/projects/a', state: null }]), saving = deferred<boolean>()
    const controller = start(host, () => saving.promise)
    const firstFactory = vi.fn(async () => project('b')), laterFactory = vi.fn(async () => project('c'))
    const first = controller.navigate(firstFactory)
    await microtasks()
    expect(await controller.navigate(laterFactory)).toBe(false)
    saving.resolve(false)
    expect(await first).toBe(false)
    expect(firstFactory).not.toHaveBeenCalled()
    expect(laterFactory).not.toHaveBeenCalled()
    expect(host.read().pathname).toBe('/projects/a')
    expect(controller.getSnapshot().pending).toBe(false)
  })

  it.each(['guard', 'factory', 'push'] as const)('recovers from a rejecting %s and accepts the next navigation', async failure => {
    const host = new HistoryHost([{ url: '/projects/a', state: null }]), error = new Error('save/create/history failed')
    const guard = vi.fn(async () => true)
    if (failure === 'guard') guard.mockRejectedValueOnce(error)
    const controller = start(host, guard)
    if (failure === 'push') vi.spyOn(host, 'push').mockImplementationOnce(() => { throw error })
    await expect(controller.navigate(failure === 'factory' ? async () => { throw error } : project('b'))).rejects.toBe(error)
    expect(controller.getSnapshot()).toEqual({ route: project('a'), pending: false })
    expect(host.read().pathname).toBe('/projects/a')
    expect(await controller.navigate(project('c'))).toBe(true)
    expect(host.read().pathname).toBe('/projects/c')
  })

  it('restores Back before the guard, then denies without replacing entries or losing Forward', async () => {
    const host = new HistoryHost(), saving = deferred<boolean>()
    const guard = vi.fn(async () => true), controller = start(host, guard)
    await controller.navigate(project('a')); await controller.navigate(project('b')); await controller.navigate(project('c'))
    // First reach b with c retained in Forward history.
    host.userGo(-1); await drain(host)
    expect(host.read().pathname).toBe('/projects/b')
    const entries = structuredClone(host.entries), writeCount = host.writes.length
    guard.mockImplementation(() => saving.promise)
    const observations: string[] = []
    host.prepare.mockImplementation(() => { observations.push('prepare') })
    controller.subscribe(() => { if (controller.getSnapshot().pending) observations.push('pending') })
    guard.mockImplementation(() => { observations.push(host.read().pathname); return saving.promise })
    host.userGo(-1); host.step()
    expect(controller.getSnapshot()).toEqual({ route: project('b'), pending: true })
    expect(host.read().pathname).toBe('/projects/a')
    await drain(host)
    expect(observations).toEqual(['prepare', 'pending', '/projects/b'])
    saving.resolve(false); await drain(host)
    expect(controller.getSnapshot()).toEqual({ route: project('b'), pending: false })
    expect(host.read().pathname).toBe('/projects/b')
    expect(host.entries).toEqual(entries)
    expect(host.writes).toHaveLength(writeCount)
    guard.mockResolvedValue(true)
    host.userGo(1); await drain(host)
    expect(controller.getSnapshot().route).toEqual(project('c'))
    expect(host.entries).toEqual(entries)
  })

  it('keeps the old project mounted until an approved Back finishes, then supports Forward', async () => {
    const host = new HistoryHost(), saving = deferred<boolean>(), guard = vi.fn(async () => true)
    const controller = start(host, guard)
    await controller.navigate(project('a')); await controller.navigate(project('b'))
    const entries = structuredClone(host.entries)
    guard.mockImplementationOnce(() => saving.promise)
    host.userGo(-1); await drain(host)
    expect(controller.getSnapshot()).toEqual({ route: project('b'), pending: true })
    expect(host.read().pathname).toBe('/projects/b')
    saving.resolve(true); await drain(host)
    expect(controller.getSnapshot()).toEqual({ route: project('a'), pending: false })
    expect(host.read().pathname).toBe('/projects/a')
    host.userGo(1); await drain(host)
    expect(controller.getSnapshot()).toEqual({ route: project('b'), pending: false })
    expect(host.entries).toEqual(entries)
  })

  it('handles rapid queued Back/Forward and additional traversal during a pending guard with one decision', async () => {
    const host = new HistoryHost(), saving = deferred<boolean>(), guard = vi.fn(async () => true)
    const controller = start(host, guard)
    await controller.navigate(project('a')); await controller.navigate(project('b')); await controller.navigate(project('c'))
    const entries = structuredClone(host.entries), writes = host.writes.length
    guard.mockClear().mockImplementation(() => saving.promise)
    host.userGo(-1); host.userGo(-1); host.userGo(1)
    await drain(host)
    expect(host.read().pathname).toBe('/projects/c')
    expect(guard).toHaveBeenCalledTimes(1)
    // This queue deliberately makes an already-issued corrective go miss its
    // destination; the controller must recompute from the final actual index.
    host.userGo(-2); host.userGo(1)
    await drain(host)
    expect(host.read().pathname).toBe('/projects/c')
    expect(guard).toHaveBeenCalledTimes(1)
    const extraFactory = vi.fn(async () => project('extra'))
    expect(await controller.navigate(extraFactory)).toBe(false)
    expect(extraFactory).not.toHaveBeenCalled()
    saving.resolve(true); await drain(host)
    expect(controller.getSnapshot()).toEqual({ route: project('b'), pending: false })
    expect(host.read().pathname).toBe('/projects/b')
    expect(host.entries).toEqual(entries)
    expect(host.writes).toHaveLength(writes)
  })

  it('restores browser Back during a pending factory and commits that factory exactly once', async () => {
    const host = new HistoryHost(), creating = deferred<ProjectRoute>(), guard = vi.fn(async () => true)
    const controller = start(host, guard)
    await controller.navigate(project('a')); await controller.navigate(project('b'))
    guard.mockClear()
    const factory = vi.fn(() => creating.promise), result = controller.navigate(factory)
    await microtasks()
    host.userGo(-1); await drain(host)
    expect(host.read().pathname).toBe('/projects/b')
    expect(controller.getSnapshot()).toEqual({ route: project('b'), pending: true })
    expect(guard).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledTimes(1)
    creating.resolve(project('c')); await drain(host)
    expect(await result).toBe(true)
    expect(host.entries.map(entry => entry.url)).toEqual(['/', '/projects/a', '/projects/b', '/projects/c'])
    expect(controller.getSnapshot()).toEqual({ route: project('c'), pending: false })
  })

  it('handles a rejecting popstate guard without an unhandled rejection or a stuck pending state', async () => {
    const host = new HistoryHost(), guard = vi.fn(async () => true), log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const controller = start(host, guard)
    await controller.navigate(project('a')); await controller.navigate(project('b'))
    const entries = structuredClone(host.entries)
    guard.mockRejectedValueOnce(new Error('save failed'))
    host.userGo(-1); await drain(host)
    expect(controller.getSnapshot()).toEqual({ route: project('b'), pending: false })
    expect(host.read().pathname).toBe('/projects/b')
    expect(host.entries).toEqual(entries)
    expect(log).toHaveBeenCalledOnce()
    host.userGo(-1); await drain(host)
    expect(controller.getSnapshot().route).toEqual(project('a'))
  })

  it('reuses valid history metadata after reload and safely replaces malformed initial metadata', async () => {
    const host = new HistoryHost([{ url: '/', state: { __garakProjectNavigation: { version: 1, epoch: 'broken', index: -1, key: 'bad' }, foreign: 42 } }])
    const first = new ProjectNavigation(host, async () => true), firstStop = first.start()
    await first.navigate(project('a')); await first.navigate(project('b'))
    firstStop()
    const entries = structuredClone(host.entries), writes = host.writes.length
    const second = start(host, async () => false)
    expect(host.writes).toHaveLength(writes)
    expect(host.entries[0].state).toMatchObject({ foreign: 42 })
    host.userGo(-1); await drain(host)
    expect(second.getSnapshot()).toEqual({ route: project('b'), pending: false })
    expect(host.entries).toEqual(entries)
  })

  it('cancels stale factories on cleanup, permits remount, and removes each listener once', async () => {
    const host = new HistoryHost(), creating = deferred<ProjectRoute>(), guard = vi.fn(async () => true)
    const controller = new ProjectNavigation(host, guard), stop = controller.start()
    const result = controller.navigate(() => creating.promise)
    await microtasks()
    stop(); stop()
    expect(await result).toBe(false)
    expect(host.listening).toBe(0)
    expect(controller.getSnapshot().pending).toBe(false)
    const restart = controller.start()
    stops.push(restart)
    await drain(host)
    creating.resolve(project('stale')); await microtasks()
    expect(host.read().pathname).toBe('/')
    expect(controller.getSnapshot()).toEqual({ route: { kind: 'home' }, pending: false })
    expect(await controller.navigate(project('fresh'))).toBe(true)
    expect(host.entries.map(entry => entry.url)).toEqual(['/', '/projects/fresh'])
    expect(host.listening).toBe(1)
  })

  it('settles queued corrective traversal after cleanup/remount without publishing the stale Back target', async () => {
    const host = new HistoryHost(), guard = vi.fn(async () => true)
    const controller = new ProjectNavigation(host, guard), stop = controller.start()
    await controller.navigate(project('a')); await controller.navigate(project('b')); await controller.navigate(project('c'))
    host.userGo(-1); await drain(host) // b, with c in the forward branch
    guard.mockClear()
    host.userGo(-1); host.step() // a, corrective +1 queued
    stop()
    const restart = controller.start(); stops.push(restart)
    await drain(host)
    expect(controller.getSnapshot()).toEqual({ route: project('b'), pending: false })
    expect(host.read().pathname).toBe('/projects/b')
    expect(guard).not.toHaveBeenCalled()
    expect(host.entries.map(entry => entry.url)).toEqual(['/', '/projects/a', '/projects/b', '/projects/c'])
  })

  it('accepts an unmanaged entry after its guard without replacing its URL or adding a duplicate entry', async () => {
    const host = new HistoryHost([{ url: '/unknown?keep=1', state: { external: true } }, { url: '/projects/a', state: null }])
    const controller = start(host)
    host.userGo(-1); await drain(host)
    expect(controller.getSnapshot()).toEqual({ route: { kind: 'not-found', path: '/unknown' }, pending: false })
    expect(host.entries).toHaveLength(2)
    expect(host.read().url).toBe('/unknown?keep=1')
    expect(host.read().state).toMatchObject({ external: true })
    expect(host.corrections).toEqual([])
    expect(host.writes.at(-1)).toEqual({ kind: 'replace', url: '/unknown?keep=1' })
  })

  it('denies an index-less unmanaged entry by pushing the editor URL and explicitly permits forward-branch loss', async () => {
    const host = new HistoryHost([{ url: '/external', state: { external: true } }, { url: '/projects/a', state: null }, { url: '/projects/forward', state: null }], 1)
    const controller = start(host, async () => false), unknown = structuredClone(host.entries[0]), writes = host.writes.length
    host.userGo(-1); await drain(host)
    expect(controller.getSnapshot()).toEqual({ route: project('a'), pending: false })
    expect(host.read().pathname).toBe('/projects/a')
    expect(host.entries[0]).toEqual(unknown) // never replace the unknown target
    expect(host.corrections).toEqual([]) // never guess a traversal direction
    expect(host.writes.slice(writes)).toEqual([{ kind: 'push', url: '/projects/a' }])
    expect(host.entries.map(entry => entry.url)).toEqual(['/external', '/projects/a'])
  })

  it('uses a read-only native position to preserve unmanaged history and its forward branch when available', async () => {
    const host = new HistoryHost([{ url: '/external', state: { external: true } }, { url: '/projects/a', state: null }, { url: '/projects/forward', state: null }], 1, true)
    const controller = start(host, async () => false), entries = structuredClone(host.entries), writes = host.writes.length
    host.userGo(-1); await drain(host)
    expect(controller.getSnapshot()).toEqual({ route: project('a'), pending: false })
    expect(host.read().pathname).toBe('/projects/a')
    expect(host.corrections).toEqual([1])
    expect(host.entries).toEqual(entries)
    expect(host.writes).toHaveLength(writes)
  })
})

describe('browser history adapter', () => {
  it('reads optional native indices, preserves search/hash while stamping, blurs inputs, and never patches history', () => {
    const stack = new HistoryHost([{ url: '/projects/a?mode=mix#bar-8', state: { keep: 'yes' } }])
    const blur = vi.fn(), pushState = vi.fn((state: unknown, _unused: string, url: string) => stack.push(url, state)), replaceState = vi.fn((state: unknown, _unused: string, url: string) => stack.replace(url, state))
    const history = { get state() { return stack.read().state }, pushState, replaceState, go: vi.fn((delta: number) => stack.go(delta)) }
    const browser = { get location() { return new URL(stack.read().url!, 'https://garak.test') }, history,
      document: { activeElement: { blur } }, navigation: { currentEntry: { index: 7 } },
      addEventListener: stack.addEventListener.bind(stack), removeEventListener: stack.removeEventListener.bind(stack),
    } as unknown as Window
    const host = browserNavigationHost(browser)
    expect(host.read()).toMatchObject({ pathname: '/projects/a', url: '/projects/a?mode=mix#bar-8', position: 7 })
    const controller = new ProjectNavigation(host, async () => true), stop = controller.start(); stops.push(stop)
    expect(stack.read().url).toBe('/projects/a?mode=mix#bar-8')
    expect(browser.history.pushState).toBe(pushState)
    expect(browser.history.replaceState).toBe(replaceState)
    host.prepareLeave?.()
    expect(blur).toHaveBeenCalledOnce()
  })
})

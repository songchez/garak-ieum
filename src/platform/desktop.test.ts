import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge, DesktopFile } from '../../desktop/contracts'
import { bindDesktopProjectEvents, chooseProjectFile, desktopProjectFile, isDesktopApp, saveExport, type DesktopProjectHandlers } from './desktop'

function bridge(patch: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    isDesktop: true, platform: 'win32', version: '1.0.0',
    audio: { request: vi.fn(async () => ({})), subscribe: vi.fn(() => () => {}) },
    openProject: vi.fn(async () => null), saveFile: vi.fn(async () => ({ canceled: false, fileName: 'song.garak' })),
    onOpenProject: vi.fn(() => () => {}), onSaveProject: vi.fn(() => () => {}), onNewProject: vi.fn(() => () => {}),
    onBeforeClose: vi.fn(() => () => {}), ready: vi.fn(), ...patch,
  }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('native file dialogs and web fallback', () => {
  it('preserves native bytes and identifies project/audio/JSON exports', async () => {
    const desktop = bridge()
    vi.stubGlobal('window', { garakDesktop: desktop })
    expect(isDesktopApp()).toBe(true)
    for (const [name, kind] of [['song.garak', 'project'], ['song.wav', 'audio'], ['analysis.json', 'json']] as const) {
      expect(await saveExport(new Blob([new Uint8Array([0, 128, 255])]), name, kind)).toEqual({ status: 'saved', fileName: 'song.garak' })
      expect(desktop.saveFile).toHaveBeenLastCalledWith({ name, kind, data: new Uint8Array([0, 128, 255]) })
    }
  })

  it('reports canceled native save without claiming success or starting a download', async () => {
    const desktop = bridge({ saveFile: vi.fn(async () => ({ canceled: true })) })
    vi.stubGlobal('window', { garakDesktop: desktop })
    const createUrl = vi.spyOn(URL, 'createObjectURL')
    expect(await saveExport(new Blob(['song']), 'song.garak', 'project')).toEqual({ status: 'canceled' })
    expect(createUrl).not.toHaveBeenCalled()
  })

  it('propagates a native write failure without attempting a different save path', async () => {
    const error = new Error('disk full'), desktop = bridge({ saveFile: vi.fn(async () => { throw error }) })
    vi.stubGlobal('window', { garakDesktop: desktop })
    const createUrl = vi.spyOn(URL, 'createObjectURL')
    await expect(saveExport(new Blob(['song']), 'song.garak', 'project')).rejects.toBe(error)
    expect(createUrl).not.toHaveBeenCalled()
  })

  it('keeps web downloads and releases their object URLs, without claiming the file was saved', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {})
    const link = { href: '', download: '', click: vi.fn() }
    vi.stubGlobal('document', { createElement: vi.fn(() => link) })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:project')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    expect(isDesktopApp()).toBe(false)
    expect(await saveExport(new Blob(['song']), 'song.garak', 'project')).toEqual({ status: 'download-started' })
    expect(link).toMatchObject({ href: 'blob:project', download: 'song.garak' })
    expect(link.click).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(5000)
    expect(revoke).toHaveBeenCalledWith('blob:project')
  })

  it('opens only the selected typed-array slice as a portable project File', async () => {
    const bytes = new Uint8Array([99, 123, 125, 100])
    const file = desktopProjectFile({ name: 'song.garak', data: bytes.subarray(1, 3) })
    expect(file.name).toBe('song.garak')
    expect(file.type).toBe('application/json')
    expect(await file.text()).toBe('{}')
    bytes[1] = 0
    expect(await file.text()).toBe('{}')
  })

  it('routes native open, cancel and failure without opening the web picker', async () => {
    const pick = vi.fn(), openProject = vi.fn<DesktopBridge['openProject']>()
    vi.stubGlobal('window', { garakDesktop: bridge({ openProject }) })
    openProject.mockResolvedValueOnce({ name: 'song.garak', data: new TextEncoder().encode('{}') })
    expect(await (await chooseProjectFile(pick))?.text()).toBe('{}')
    openProject.mockResolvedValueOnce(null)
    expect(await chooseProjectFile(pick)).toBeNull()
    openProject.mockRejectedValueOnce(new Error('read failed'))
    await expect(chooseProjectFile(pick)).rejects.toThrow('read failed')
    expect(pick).not.toHaveBeenCalled()
  })

  it('opens the web picker synchronously when no desktop bridge is present', async () => {
    vi.stubGlobal('window', {})
    const pick = vi.fn()
    const result = chooseProjectFile(pick)
    expect(pick).toHaveBeenCalledOnce()
    expect(await result).toBeNull()
  })
})

describe('desktop menu and close ownership', () => {
  it('wires every listener before ready, forwards commands, and cleans up once', async () => {
    const order: string[] = [], callbacks: { open?: (file: DesktopFile) => void; save?: () => void; create?: () => void; close?: () => Promise<boolean> } = {}
    const desktop = bridge({
      onOpenProject: fn => { order.push('open'); callbacks.open = fn; return () => { order.push('-open') } },
      onSaveProject: fn => { order.push('save'); callbacks.save = fn; return () => { order.push('-save') } },
      onNewProject: fn => { order.push('new'); callbacks.create = fn; return () => { order.push('-new') } },
      onBeforeClose: fn => { order.push('close'); callbacks.close = fn; return () => { order.push('-close') } },
      ready: () => { order.push('ready') },
    })
    vi.stubGlobal('window', { garakDesktop: desktop })
    const handlers: DesktopProjectHandlers = { open: vi.fn(), save: vi.fn(), create: vi.fn(), beforeClose: vi.fn(async () => true), error: vi.fn() }
    const dispose = bindDesktopProjectEvents(handlers)
    expect(order).toEqual(['open', 'save', 'new', 'close', 'ready'])
    callbacks.open?.({ name: 'song.garak', data: new TextEncoder().encode('{}') })
    expect(handlers.open).toHaveBeenCalledWith(expect.any(File))
    callbacks.save?.(); callbacks.create?.()
    expect(handlers.save).toHaveBeenCalledOnce(); expect(handlers.create).toHaveBeenCalledOnce()
    expect(await callbacks.close?.()).toBe(true)
    dispose(); dispose()
    expect(order.slice(5)).toEqual(['-close', '-new', '-save', '-open'])
  })

  it('rejects closure when the existing save guard rejects or throws', async () => {
    let close!: () => Promise<boolean>
    vi.stubGlobal('window', { garakDesktop: bridge({ onBeforeClose: callback => { close = callback; return () => {} } }) })
    const beforeClose = vi.fn(async () => false), error = vi.fn()
    const dispose = bindDesktopProjectEvents({ open: vi.fn(), save: vi.fn(), create: vi.fn(), beforeClose, error })
    expect(await close()).toBe(false)
    beforeClose.mockRejectedValueOnce(new Error('save failed'))
    expect(await close()).toBe(false)
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'save failed' }))
    dispose()
  })

  it('waits for the autosave guard before approving closure', async () => {
    let close!: () => Promise<boolean>, finishSave!: (saved: boolean) => void
    const saving = new Promise<boolean>(resolve => { finishSave = resolve })
    vi.stubGlobal('window', { garakDesktop: bridge({ onBeforeClose: callback => { close = callback; return () => {} } }) })
    const dispose = bindDesktopProjectEvents({ open: vi.fn(), save: vi.fn(), create: vi.fn(), beforeClose: () => saving, error: vi.fn() })
    const approved = vi.fn()
    const result = close().then(approved)
    await Promise.resolve()
    expect(approved).not.toHaveBeenCalled()
    finishSave(true)
    await result
    expect(approved).toHaveBeenCalledWith(true)
    dispose()
  })

  it('does not duplicate menu actions after StrictMode cleanup and re-entry', () => {
    const saves = new Set<() => void>()
    vi.stubGlobal('window', { garakDesktop: bridge({ onSaveProject: callback => { saves.add(callback); return () => { saves.delete(callback) } } }) })
    const save = vi.fn(), handlers = { open: vi.fn(), save, create: vi.fn(), beforeClose: vi.fn(async () => true), error: vi.fn() }
    bindDesktopProjectEvents(handlers)()
    const dispose = bindDesktopProjectEvents(handlers)
    for (const callback of saves) callback()
    expect(save).toHaveBeenCalledOnce()
    dispose()
    expect(saves.size).toBe(0)
  })

  it('does not leak partially installed listeners when desktop readiness fails', () => {
    const release = vi.fn()
    vi.stubGlobal('window', { garakDesktop: bridge({ onOpenProject: () => release, ready: () => { throw new Error('not ready') } }) })
    expect(() => bindDesktopProjectEvents({ open: vi.fn(), save: vi.fn(), create: vi.fn(), beforeClose: vi.fn(async () => true), error: vi.fn() })).toThrow('not ready')
    expect(release).toHaveBeenCalledOnce()
  })
})

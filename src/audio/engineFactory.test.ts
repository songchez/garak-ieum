import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '../../desktop/contracts'
import { DEFAULT_AUDIO_SETTINGS } from '../core/audioSettings'
import { createAudioEngine } from './engineFactory'
import { NativeAudioEngine } from './native/NativeAudioEngine'
import { WebAudioEngine } from './WebAudioEngine'

afterEach(() => vi.unstubAllGlobals())
describe('audio engine selection', () => {
  it('keeps the browser demo on Web Audio', () => {
    vi.stubGlobal('window', {})
    const engine = createAudioEngine(DEFAULT_AUDIO_SETTINGS)
    expect(engine).toBeInstanceOf(WebAudioEngine)
    engine.dispose()
  })
  it('selects native in desktop even when an old preload is missing the audio API', async () => {
    const desktop = { isDesktop: true, platform: 'win32' } as DesktopBridge
    const engine = createAudioEngine(DEFAULT_AUDIO_SETTINGS, desktop)
    expect(engine).toBeInstanceOf(NativeAudioEngine)
    await expect(engine.resume()).rejects.toThrow('네이티브')
    expect(engine.getAudioState().status).toBe('error')
    engine.dispose()
  })
  it('passes the actual macOS platform and native bridge through', async () => {
    const request = vi.fn(async () => []), desktop = { isDesktop: true, platform: 'darwin', audio: { request, subscribe: () => () => undefined } } as unknown as DesktopBridge
    const engine = createAudioEngine(DEFAULT_AUDIO_SETTINGS, desktop)
    expect(engine).toBeInstanceOf(NativeAudioEngine)
    if (engine.kind !== 'native') throw new Error('wrong engine')
    await engine.listDevices()
    expect(request).toHaveBeenCalledWith('devices.list', { backend: 'coreaudio' })
    engine.dispose()
  })
  it('does not silently use browser audio if the entire Electron preload is absent', async () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 Chrome/150.0 Electron/45.2.1 Safari/537.36' })
    const engine = createAudioEngine(DEFAULT_AUDIO_SETTINGS)
    expect(engine).toBeInstanceOf(NativeAudioEngine)
    await expect(engine.resume()).rejects.toThrow('네이티브')
    engine.dispose()
  })
})

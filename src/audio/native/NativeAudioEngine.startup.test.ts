import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyProject, createTrack } from '../../core/project'
import { DEFAULT_AUDIO_SETTINGS } from '../../core/audioSettings'
import type { Project } from '../../core/types'
import { NativeAudioEngine } from './NativeAudioEngine'
import { withNativeCode } from './deviceErrors'
import type { NativeAudioBridge, NativeDeviceState } from './contracts'
import type { NativeProjectTimeline } from './timeline'
import { WAVE_SCHEMA_FINGERPRINT } from '../../devices/wavetable-synth/schema.generated'

function deferred<T = unknown>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const project = (): Project => ({ ...createEmptyProject(), id: 'project', sampleRate: 48000, bpm: 120, tracks: [{ ...createTrack('instrument', 'keys'), id: 'keys' }] })
const opened = (params: Record<string, unknown>): NativeDeviceState => ({ backend: params.backend, inputDeviceId: params.inputDeviceId || 'input', outputDeviceId: params.outputDeviceId || 'output', inputChannels: 0, outputChannels: 2, sampleRate: params.sampleRate, bufferFrames: 160 } as NativeDeviceState)
const engines: NativeAudioEngine[] = []
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose() })

function harness() {
  const handlers = new Map<string, (params: Record<string, unknown>) => unknown>()
  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (handlers.has(method)) return handlers.get(method)!(params)
    if (method === 'engine.capabilities') return { protocol: 1, wavetable: { protocolVersion: 1, schemaFingerprint: WAVE_SCHEMA_FINGERPRINT } }
    if (method === 'engine.configure') return opened(params)
    if (method === 'devices.list') return []
    if (method === 'project.set') return { revision: (params.timeline as NativeProjectTimeline).revision }
    return {}
  })
  const bridge: NativeAudioBridge = { request, subscribe: () => () => undefined }
  const engine = new NativeAudioEngine(bridge, 'win32', project(), DEFAULT_AUDIO_SETTINGS)
  engines.push(engine)
  const calls = (method: string) => request.mock.calls.filter(call => call[0] === method).map(call => call[1] as Record<string, unknown>)
  return { engine, handlers, calls }
}
const noWait = () => Promise.resolve()
const sleepLog = () => { const delays: number[] = []; return { delays, sleep: (ms: number) => { delays.push(ms); return Promise.resolve() } } }

describe('launch connection (autoStart)', () => {
  it('opens the saved settings at launch through engine.configure, with no 적용 and no notice', async () => {
    const h = harness()
    const saved = { ...DEFAULT_AUDIO_SETTINGS, outputDeviceId: 'output' }
    h.handlers.set('devices.list', () => [{ id: 'output', name: 'Speakers', backend: 'wasapi', inputChannels: 0, outputChannels: 2 }])
    const report = await h.engine.autoStart(saved, 48000, { sleep: noWait })
    expect(report).toMatchObject({ state: 'ready', notice: null, preferredMissing: false })
    expect(h.calls('engine.configure')).toEqual([expect.objectContaining({ backend: 'wasapi', outputDeviceId: 'output', sampleRate: 48000, inputChannels: 0 })])
    expect(h.engine.getSnapshot().ready).toBe(true)
    expect(h.engine.getAudioState()).toMatchObject({ status: 'ready', settings: saved })
    expect(h.engine.getAudioState().startup?.log.map(entry => entry.step)).toEqual(['start', 'host', 'devices', 'configure', 'ready'])
  })

  it('retries a busy driver with backoff and keeps the saved device when it frees up', async () => {
    const h = harness(), { delays, sleep } = sleepLog()
    let refusals = 2
    h.handlers.set('devices.list', () => [{ id: 'focusrite', name: 'Focusrite USB ASIO', backend: 'asio', inputChannels: 2, outputChannels: 2 }])
    h.handlers.set('engine.configure', params => {
      if (refusals-- > 0) throw withNativeCode(new Error('busy'), 'DEVICE_IN_USE')
      return opened(params)
    })
    const report = await h.engine.autoStart({ ...DEFAULT_AUDIO_SETTINGS, nativeBackend: 'asio', outputDeviceId: 'focusrite' }, 48000, { sleep })
    expect(report.state).toBe('ready')
    expect(delays).toEqual([400, 800])
    expect(h.calls('engine.configure').map(params => params.backend)).toEqual(['asio', 'asio', 'asio'])
  })

  it('falls back to the default device when the saved one is gone, without overwriting the saved choice', async () => {
    const h = harness()
    h.handlers.set('devices.list', () => [{ id: 'speakers', name: 'Speakers', backend: 'wasapi', inputChannels: 0, outputChannels: 2, isDefault: true }])
    const saved = { ...DEFAULT_AUDIO_SETTINGS, outputDeviceId: 'unplugged-usb', inputDeviceId: 'unplugged-usb' }
    const report = await h.engine.autoStart(saved, 48000, { sleep: noWait })
    expect(report).toMatchObject({ state: 'fallback', preferredMissing: true, reason: '장치를 찾지 못했습니다' })
    expect(report.notice).toContain('저장된 오디오 장치(WASAPI · 저장된 출력 장치)')
    // The missing device was never opened; only the default endpoint was.
    expect(h.calls('engine.configure')).toEqual([expect.objectContaining({ backend: 'wasapi', outputDeviceId: '', inputDeviceId: '' })])
    expect(h.engine.getAudioState().settings).toMatchObject({ outputDeviceId: '', inputDeviceId: '' })
    expect(saved.outputDeviceId).toBe('unplugged-usb')
    expect(h.engine.getSnapshot().ready).toBe(true)
  })

  it('falls back from a refusing ASIO driver to WASAPI, and fails with the saved driver reason when nothing opens', async () => {
    const h = harness(), { sleep } = sleepLog()
    h.handlers.set('devices.list', params => params.backend === 'asio' ? [{ id: 'rme', name: 'ASIO Fireface', backend: 'asio', inputChannels: 2, outputChannels: 2 }] : [])
    h.handlers.set('engine.configure', params => {
      if (params.backend === 'asio') throw withNativeCode(new Error('rate'), 'SAMPLE_RATE_UNSUPPORTED', { supported: [44100] })
      return opened(params)
    })
    const saved = { ...DEFAULT_AUDIO_SETTINGS, nativeBackend: 'asio' as const, outputDeviceId: 'rme' }
    const report = await h.engine.autoStart(saved, 48000, { sleep })
    expect(report).toMatchObject({ state: 'fallback', reason: '장치가 프로젝트 샘플레이트를 지원하지 않습니다' })
    expect(report.notice).toContain('ASIO · ASIO Fireface')
    expect(h.calls('engine.configure').map(params => params.backend)).toEqual(['asio', 'wasapi'])

    h.handlers.set('engine.configure', () => { throw withNativeCode(new Error('busy'), 'DEVICE_IN_USE') })
    const failed = await h.engine.autoStart(saved, 48000, { sleep })
    expect(failed.state).toBe('failed')
    expect(failed.notice).toContain('다른 앱이 장치를 사용 중입니다')
    expect(h.engine.getAudioState().status).toBe('error')
  })

  it('makes Play wait for the launch connection instead of opening the device twice', async () => {
    const h = harness()
    const gate = deferred<NativeDeviceState>()
    h.handlers.set('engine.configure', () => gate.promise)
    const startup = h.engine.autoStart(DEFAULT_AUDIO_SETTINGS, 48000, { sleep: noWait })
    const play = h.engine.play()
    await vi.waitFor(() => expect(h.calls('engine.configure')).toHaveLength(1))
    gate.resolve(opened({ backend: 'wasapi', sampleRate: 48000 }))
    await startup; await play
    expect(h.calls('engine.configure')).toHaveLength(1)
    expect(h.engine.getSnapshot().playing).toBe(true)
  })

  it('is cancelled by an explicit 적용 and records that in diagnostics', async () => {
    const h = harness()
    const slow = deferred<NativeDeviceState>()
    h.handlers.set('engine.configure', () => slow.promise)
    const startup = h.engine.autoStart(DEFAULT_AUDIO_SETTINGS, 48000, { sleep: noWait })
    await vi.waitFor(() => expect(h.calls('engine.configure')).toHaveLength(1))
    h.handlers.delete('engine.configure')
    const applied = h.engine.configure(DEFAULT_AUDIO_SETTINGS, 48000)
    slow.resolve(opened({ backend: 'wasapi', sampleRate: 48000 }))
    expect((await startup).state).toBe('cancelled')
    await applied
    expect(h.engine.getAudioState()).toMatchObject({ status: 'ready', startup: { state: 'cancelled' } })
  })
})

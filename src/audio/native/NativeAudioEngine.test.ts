import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyProject, createTrack } from '../../core/project'
import { DEFAULT_AUDIO_SETTINGS } from '../../core/audioSettings'
import type { AudioAsset, AudioClip, Project } from '../../core/types'
import type { SampleLibrary } from '../samples'
import { NativeAudioEngine, nativeBackendForPlatform } from './NativeAudioEngine'
import type { NativeAudioBridge, NativeDeviceState, NativeEngineEvent, NativePluginInstance } from './contracts'

function deferred<T = unknown>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const project = (): Project => ({ ...createEmptyProject(), id: 'project', sampleRate: 48000, bpm: 120, tracks: [{ ...createTrack('instrument', 'keys'), id: 'keys' }] })
const plugin = (): NativePluginInstance => ({ id: 'vst', pluginId: 'approved-catalog-id', classId: '0123456789ABCDEF0123456789ABCDEF', name: 'Instrument', enabled: true, parameters: { '1': .2 } })
function asset(id = 'pcm'): AudioAsset {
  const values = new Float32Array([.25, -.25, .1, 0])
  return { id, name: id, blob: new Blob(['original']), peaks: [.25], buffer: { sampleRate: 48000, numberOfChannels: 1, length: values.length, duration: values.length / 48000, getChannelData: () => values } as unknown as AudioBuffer }
}
function audioProject(): Project {
  const clip: AudioClip = { id: 'clip', kind: 'audio', name: 'Take', assetId: 'pcm', startBeat: 0, lengthBeats: 1, offsetSeconds: 0, gain: 1, fadeIn: 0, fadeOut: 0 }
  return { ...project(), tracks: [{ ...createTrack('audio'), id: 'audio', clips: [clip] }] }
}
function harness(input = project(), samples?: SampleLibrary) {
  const listeners = new Set<(event: NativeEngineEvent) => void>()
  const handlers = new Map<string, (params: Record<string, unknown>) => unknown | Promise<unknown>>()
  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (handlers.has(method)) return handlers.get(method)!(params)
    if (method === 'engine.configure') return { backend: params.backend, inputDeviceId: params.inputDeviceId || 'input', outputDeviceId: params.outputDeviceId || 'output', inputChannels: params.inputChannels, inputChannelOffset: params.inputChannelOffset, outputChannels: 2, sampleRate: params.sampleRate, bufferFrames: 160, inputLatencyFrames: 80, outputLatencyFrames: 240 } as NativeDeviceState
    if (method === 'render.wav') return { data: new Uint8Array(48) }
    if (method === 'plugins.state') return { component: 'AQID', controller: 'BA==' }
    if (method === 'plugins.parameters') return [{ id: 1, title: 'Gain', value: .8, defaultValue: .5, stepCount: 0 }]
    return {}
  })
  const bridge: NativeAudioBridge = { request, subscribe: callback => { listeners.add(callback); return () => { listeners.delete(callback) } } }
  const engine = new NativeAudioEngine(bridge, 'win32', input, DEFAULT_AUDIO_SETTINGS, samples)
  const calls = (method: string) => request.mock.calls.filter(call => call[0] === method).map(call => call[1])
  return { engine, request, bridge, handlers, calls, emit: (event: NativeEngineEvent) => { for (const listener of listeners) listener(event) } }
}
const engines: NativeAudioEngine[] = []
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); vi.unstubAllGlobals(); vi.useRealTimers() })
const managed = (input?: Project, samples?: SampleLibrary) => { const h = harness(input, samples); engines.push(h.engine); return h }

describe('desktop native runtime boundary', () => {
  it('plays and previews synths through native controls without constructing Web Audio or opening microphone input', async () => {
    const forbidden = vi.fn(() => { throw new Error('realtime browser audio forbidden') })
    vi.stubGlobal('AudioContext', forbidden); vi.stubGlobal('OfflineAudioContext', forbidden); vi.stubGlobal('MediaRecorder', forbidden)
    const h = managed()
    await h.engine.play()
    expect(h.calls('engine.configure')[0]).toMatchObject({ backend: 'wasapi', inputChannels: 0, bufferFrames: 128 })
    expect(h.calls('project.set')).toHaveLength(1)
    expect(h.calls('transport.play')).toEqual([{ frame: 0 }])
    await h.engine.previewNote('keys', 64, .75)
    expect(h.calls('note.preview')[0]).toMatchObject({ pitch: 64, source: { kind: 'builtin-synth', instrumentId: 'keys' } })
    expect(forbidden).not.toHaveBeenCalled()
    expect(h.engine.getAudioState()).toMatchObject({ sampleRate: 48000, renderQuantumSize: 160, outputLatency: .005, baseLatency: null })
  })

  it('requires a native bridge and explicit recovery after a native error, without browser fallback', async () => {
    const missing = new NativeAudioEngine(undefined, 'win32', project()); engines.push(missing)
    await expect(missing.play()).rejects.toThrow('네이티브')
    expect(missing.getAudioState().status).toBe('error')
    const h = managed()
    h.handlers.set('engine.configure', () => { throw new Error('ASIO device unavailable') })
    await expect(h.engine.play()).rejects.toThrow('ASIO device unavailable')
    expect(h.engine.getSnapshot().ready).toBe(false)
    await expect(h.engine.play()).rejects.toThrow('ASIO device unavailable')
    expect(h.calls('engine.configure')).toHaveLength(1)
    h.handlers.delete('engine.configure')
    await h.engine.configure(DEFAULT_AUDIO_SETTINGS, 48000)
    await h.engine.play()
    expect(h.engine.getSnapshot().playing).toBe(true)
  })

  it('rejects a silent driver fallback even when rate and channels match', async () => {
    const h = managed()
    h.handlers.set('engine.configure', () => ({ backend: 'wasapi', sampleRate: 48000, bufferFrames: 128, inputChannels: 0, outputChannels: 2, inputDeviceId: '', outputDeviceId: 'output' }))
    await expect(h.engine.configure({ ...DEFAULT_AUDIO_SETTINGS, nativeBackend: 'asio' }, 48000)).rejects.toThrow('드라이버')
    expect(h.engine.getSnapshot().ready).toBe(false)
  })

  it('never presents a different actual sample rate as a successful configuration', async () => {
    const h = managed()
    h.handlers.set('engine.configure', () => ({ sampleRate: 44100, bufferFrames: 512 }))
    await expect(h.engine.play()).rejects.toThrow('44100')
    expect(h.calls('transport.play')).toHaveLength(0)
    expect(h.engine.getAudioState().status).toBe('error')
  })

  it('compiles the candidate device rate before App commits a project-rate change', async () => {
    const h = managed(); await h.engine.resume()
    await h.engine.configure(DEFAULT_AUDIO_SETTINGS, 44100)
    expect(h.calls('project.set').at(-1)).toMatchObject({ timeline: { sampleRate: 44100 } })
    expect(h.engine.getSnapshot().sampleRate).toBe(44100)
    h.engine.setProject({ ...project(), sampleRate: 44100 }); await h.engine.play()
    expect(h.calls('engine.configure')).toHaveLength(2)
  })

  it('keeps Stop authoritative when native configuration is delayed', async () => {
    const h = managed(), pending = deferred<NativeDeviceState>()
    h.handlers.set('engine.configure', () => pending.promise)
    const playing = h.engine.play()
    h.engine.stop()
    pending.resolve({ backend: 'wasapi', sampleRate: 48000, bufferFrames: 128, inputChannels: 0, outputChannels: 2, inputDeviceId: '', outputDeviceId: 'output' })
    await playing
    expect(h.calls('transport.play')).toHaveLength(0)
    expect(h.engine.getSnapshot()).toMatchObject({ playing: false, beat: 0 })
  })

  it('reuses a global engine after dispose and waits for close before opening the next project', async () => {
    const h = managed(audioProject()), pcm = asset()
    h.engine.setAssets(new Map([[pcm.id, pcm]])); await h.engine.play()
    const closing = deferred(); h.handlers.set('engine.close', () => closing.promise)
    h.engine.dispose()
    h.engine.setProject({ ...audioProject(), id: 'next-project' }); h.engine.setAssets(new Map([[pcm.id, pcm]]))
    const playing = h.engine.play()
    await Promise.resolve()
    expect(h.calls('engine.configure')).toHaveLength(1)
    closing.resolve({}); await playing
    expect(h.calls('engine.configure')).toHaveLength(2)
    expect(h.calls('asset.put')).toHaveLength(2)
    expect(h.engine.getSnapshot().playing).toBe(true)
    h.handlers.delete('engine.close')
  })

  it('closes a device whose initial configure was still pending when the editor was disposed', async () => {
    const h = managed(), pending = deferred<NativeDeviceState>()
    h.handlers.set('engine.configure', () => pending.promise)
    const playing = h.engine.play()
    h.engine.dispose()
    pending.resolve({ backend: 'wasapi', sampleRate: 48000, bufferFrames: 128, inputChannels: 0, outputChannels: 2, inputDeviceId: '', outputDeviceId: 'output' })
    await expect(playing).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.calls('engine.close')).toHaveLength(1)
    expect(h.calls('transport.play')).toHaveLength(0)
  })

  it('opens microphone channels only for an explicit record/monitor action and honors selected physical offset', async () => {
    const p = audioProject(), h = managed(p), pcm = asset()
    h.engine.setAssets(new Map([[pcm.id, pcm]]))
    const settings = { ...DEFAULT_AUDIO_SETTINGS, inputChannels: 1 as const, nativeInputChannel: 3 }
    await h.engine.configure(settings, 48000)
    expect(h.calls('engine.configure')[0]).toMatchObject({ inputChannels: 0 })
    await h.engine.setNativeMonitoring(['audio'])
    expect(h.calls('engine.configure')[1]).toMatchObject({ inputChannels: 1, inputChannelOffset: 3 })
    await h.engine.setNativeMonitoring(['audio'])
    expect(h.calls('engine.configure')).toHaveLength(2)
    await h.engine.setNativeMonitoring([])
    expect(h.calls('monitor.set').at(-1)).toEqual({ trackIds: [], enabled: false })
  })

  it('does not turn monitoring back on after a delayed request has been canceled', async () => {
    const h = managed(), pending = deferred<NativeDeviceState>()
    h.handlers.set('engine.configure', () => pending.promise)
    const on = h.engine.setNativeMonitoring(['keys'])
    await h.engine.setNativeMonitoring([])
    pending.resolve({ backend: 'wasapi', sampleRate: 48000, bufferFrames: 128, inputChannels: 2, outputChannels: 2, inputDeviceId: 'input', outputDeviceId: 'output' })
    await on
    expect(h.calls('monitor.set').filter(value => value?.enabled === true)).toHaveLength(0)
  })

  it('reports actual frame clock, device latency and native faults without claiming a test clock is ASIO', async () => {
    const h = managed(); await h.engine.play()
    h.emit({ type: 'state', generation: 1, frame: 48000, playing: true, sampleRate: 48000, levels: { keys: .5 }, masterLevel: .3, latencyFrames: 32,
      device: { backend: 'test', testClock: true, sampleRate: 48000, bufferFrames: 256, inputChannels: 0, outputChannels: 2, inputDeviceId: '', outputDeviceId: 'test', outputLatencyFrames: 512 } })
    expect(h.engine.getSnapshot().beat).toBe(2)
    expect(h.engine.getTrackLevel('keys')).toBe(.5)
    expect(h.engine.getAudioState()).toMatchObject({ nativeDevice: { backend: 'test', testClock: true }, outputLatency: 512 / 48000, pluginLatencyFrames: 32 })
    h.emit({ type: 'error', generation: 2, error: 'native process exited' })
    expect(h.engine.getSnapshot()).toMatchObject({ ready: false, playing: false })
    expect(h.engine.getTrackLevel('keys')).toBe(0)
    await expect(h.engine.play()).rejects.toThrow('native process exited')
  })

  it('restricts backend selection to the supported operating system', () => {
    expect(nativeBackendForPlatform(DEFAULT_AUDIO_SETTINGS, 'darwin')).toBe('coreaudio')
    expect(nativeBackendForPlatform({ ...DEFAULT_AUDIO_SETTINGS, nativeBackend: 'asio' }, 'win32')).toBe('asio')
    expect(() => nativeBackendForPlatform({ ...DEFAULT_AUDIO_SETTINGS, nativeBackend: 'asio' }, 'darwin')).toThrow()
    expect(() => nativeBackendForPlatform(DEFAULT_AUDIO_SETTINGS, 'linux')).toThrow()
  })
})

describe('native asset and project synchronization', () => {
  it('uploads each source once, coalesces many edits, and sends only the latest prepared revision', async () => {
    const p = audioProject(), h = managed(p), pcm = asset(), uploading = deferred()
    h.engine.setAssets(new Map([[pcm.id, pcm]]))
    h.handlers.set('asset.put', () => uploading.promise)
    const playing = h.engine.play()
    await vi.waitFor(() => expect(h.calls('asset.put')).toHaveLength(1))
    for (let value = 1; value <= 50; value++) h.engine.setProject({ ...p, bpm: 120 + value })
    uploading.resolve({}); await playing
    expect(h.calls('asset.put')).toHaveLength(1)
    expect(h.calls('project.set')).toHaveLength(1)
    expect(h.calls('project.set')[0]).toMatchObject({ timeline: { bpm: 170 } })
    h.engine.pause(); await h.engine.play()
    expect(h.calls('asset.put')).toHaveLength(1)
  })

  it('refuses playback with missing PCM rather than silently leaving a track empty', async () => {
    const h = managed(audioProject())
    await expect(h.engine.play()).rejects.toThrow('오디오 자산')
    expect(h.calls('transport.play')).toHaveLength(0)
  })

  it('reuploads PCM after the native process generation changes', async () => {
    const h = managed(audioProject()), pcm = asset()
    h.engine.setAssets(new Map([[pcm.id, pcm]])); await h.engine.play()
    h.emit({ type: 'state', generation: 1 })
    h.emit({ type: 'error', generation: 2, error: 'host restart' })
    await h.engine.configure(DEFAULT_AUDIO_SETTINGS, 48000)
    expect(h.calls('asset.put')).toHaveLength(2)
  })

  it('recovers on the first explicit Apply when the replacement process announces a new generation', async () => {
    const h = managed(audioProject()), pcm = asset()
    h.engine.setAssets(new Map([[pcm.id, pcm]])); await h.engine.play()
    h.emit({ type: 'state', generation: 1 })
    h.emit({ type: 'error', generation: 1, ready: false, error: 'process crashed' })
    h.handlers.set('engine.configure', params => {
      h.emit({ type: 'state', generation: 2, ready: false, playing: false })
      return { backend: 'wasapi', inputDeviceId: '', outputDeviceId: 'output', inputChannels: 0, outputChannels: 2, sampleRate: params.sampleRate, bufferFrames: 128 }
    })
    await h.engine.configure(DEFAULT_AUDIO_SETTINGS, 48000)
    expect(h.calls('asset.put')).toHaveLength(2)
    expect(h.engine.getSnapshot().ready).toBe(true)
  })

  it('waits for graph edits before exporting native WAV bytes and propagates render errors', async () => {
    const h = managed(); await h.engine.play(); h.engine.pause()
    const update = deferred(); h.handlers.set('project.set', () => update.promise)
    h.engine.setProject({ ...project(), bpm: 139 })
    const render = h.engine.exportWav()
    await vi.waitFor(() => expect(h.calls('project.set')).toHaveLength(2))
    expect(h.calls('render.wav')).toHaveLength(0)
    update.resolve({})
    const file = await render
    expect(file.type).toBe('audio/wav'); expect(file.size).toBe(48)
    expect(h.calls('render.wav')[0]).toMatchObject({ timeline: { bpm: 139 } })
    h.handlers.set('render.wav', () => { throw new Error('disk full') })
    await expect(h.engine.exportWav()).rejects.toThrow('disk full')
  })

  it('captures both opaque state and editor-changed normalized parameters, without mutating its input', async () => {
    const p = project(); p.tracks[0].pluginInstrument = plugin()
    const h = managed(p); await h.engine.play()
    const captured = await h.engine.capturePluginStates(p)
    expect(captured.tracks[0].pluginInstrument).toMatchObject({ parameters: { '1': .8 }, state: { component: 'AQID', controller: 'BA==' } })
    expect(p.tracks[0].pluginInstrument!.parameters).toEqual({ '1': .2 })
    expect(p.tracks[0].pluginInstrument!.state).toBeUndefined()
    expect(h.calls('transport.pause').length).toBeGreaterThan(0)
    h.engine.setProject(captured)
    expect(await h.engine.capturePluginStates(captured)).toBe(captured)
    h.handlers.set('plugins.state', () => ({ component: 'not a base64 state' }))
    await expect(h.engine.capturePluginStates(captured)).rejects.toThrow('base64')
  })

  it('awaits the native transport pause before rendering, including projects with no VST instances', async () => {
    const h = managed(); await h.engine.play()
    const paused = deferred(); h.handlers.set('transport.pause', () => paused.promise)
    const exported = h.engine.exportWav()
    await vi.waitFor(() => expect(h.calls('transport.pause')).toHaveLength(1))
    expect(h.calls('render.wav')).toHaveLength(0)
    paused.resolve({}); await exported
    expect(h.engine.getSnapshot().playing).toBe(false)
    expect(h.calls('render.wav')).toHaveLength(1)
  })

  it('retains serialized state for an explicitly unloaded bypassed plugin but does not swallow a missing enabled instance', async () => {
    const p = project(); p.tracks[0].pluginInserts = [{ ...plugin(), enabled: false }]
    const h = managed(p); await h.engine.resume()
    h.handlers.set('plugins.state', () => null)
    expect(await h.engine.capturePluginStates(p)).toBe(p)
    expect(h.calls('plugins.state').at(-1)).toEqual({ instanceId: 'vst', allowUnloaded: true })
    const enabled = { ...p, tracks: [{ ...p.tracks[0], pluginInserts: [plugin()] }] }
    h.engine.setProject(enabled)
    await expect(h.engine.capturePluginStates(enabled)).rejects.toThrow('object')
  })

  it('stops the native output test when the user cancels, including after its immediate acknowledgement', async () => {
    vi.useFakeTimers()
    const h = managed(); await h.engine.resume()
    const abort = new AbortController(), testing = h.engine.testOutput(abort.signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls('output.test')[0]).toMatchObject({ active: true })
    abort.abort(); await testing
    expect(h.calls('output.test').at(-1)).toEqual({ active: false })
  })
})


describe('offline file decoding and sample transfer', () => {
  it('uses a tiny offline decoder and transfers sample/release PCM once, without a realtime graph', async () => {
    const pcm = asset(), decode = vi.fn(async () => pcm.buffer), constructed: number[][] = []
    vi.stubGlobal('AudioContext', vi.fn(() => { throw new Error('realtime output is forbidden') }))
    vi.stubGlobal('OfflineAudioContext', class {
      sampleRate = 48000
      decodeAudioData = decode
      constructor(channels: number, frames: number, rate: number) { constructed.push([channels, frames, rate]) }
    })
    const loaded = { set: { id: 'sample-set', kind: 'pitched', formats: ['webm'], gainDb: -4, release: .3,
      zones: [{ file: 'sustain', root: 60, lo: 0, hi: 127, vlo: 0, vhi: 1, loop: [1, 3] }],
      releaseZones: [{ file: 'release', root: 60, lo: 0, hi: 127, vlo: 0, vhi: 1 }], attribution: { title: 'Test', author: 'Test', license: 'CC0' } },
      startOffset: .044, buffers: new Map([['sustain', pcm.buffer], ['release', pcm.buffer]]) }
    const samples = { load: vi.fn(async () => loaded), get: () => loaded } as unknown as SampleLibrary
    const h = managed(project(), samples)
    const original = new Blob(['compressed bytes'], { type: 'audio/webm' })
    const decoded = await h.engine.decodeAsset(original, 'Imported', 'import-id')
    expect(decoded).toMatchObject({ id: 'import-id', name: 'Imported', buffer: pcm.buffer, blob: original })
    expect(decoded.peaks).toEqual([.25, .25, expect.closeTo(.1), 0])
    expect(h.calls('asset.put')).toHaveLength(0)
    await h.engine.preloadSamples('sample-set'); await h.engine.preloadSamples('sample-set')
    expect(constructed).toEqual([[1, 1, 48000]])
    expect(h.calls('asset.put')).toHaveLength(2)
    expect(h.calls('samples.register')).toEqual([{ id: 'sample-set', manifest: loaded.set, startOffset: .044,
      files: { sustain: 'sample:sample-set:sustain', release: 'sample:sample-set:release' } }])
    expect(h.engine.sampleStatus('sample-set')).toBe('ready')
    expect(h.calls('engine.configure')).toHaveLength(0)
    expect(AudioContext).not.toHaveBeenCalled()
    decode.mockRejectedValueOnce(new Error('unsupported codec'))
    await expect(h.engine.decodeAsset(original, 'broken', 'bad')).rejects.toThrow('오디오 파일을 읽을 수 없습니다')
  })

  it('cancels a delayed sample decode before any upload if its editor has been disposed', async () => {
    vi.stubGlobal('OfflineAudioContext', class { sampleRate = 48000 })
    const loading = deferred(), samples = { load: () => loading.promise, get: () => undefined } as unknown as SampleLibrary
    const h = managed(project(), samples), preloading = h.engine.preloadSamples('old-project')
    const canceled = expect(preloading).rejects.toMatchObject({ name: 'AbortError' })
    h.engine.dispose(); loading.resolve({ set: {}, buffers: new Map([['sample', asset().buffer]]) })
    await canceled
    expect(h.calls('asset.put')).toHaveLength(0)
    expect(h.calls('samples.register')).toHaveLength(0)
  })
})

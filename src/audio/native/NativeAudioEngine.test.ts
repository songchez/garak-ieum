import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyProject, createTrack } from '../../core/project'
import { DEFAULT_AUDIO_SETTINGS } from '../../core/audioSettings'
import type { AudioAsset, AudioClip, Project, Track } from '../../core/types'
import { exportProjectBundle, importProjectBundle } from '../../core/storage'
import type { SampleLibrary } from '../samples'
import { NativeAudioEngine, nativeBackendForPlatform } from './NativeAudioEngine'
import type { NativeAudioBridge, NativeDeviceState, NativeEngineEvent, NativePluginInstance } from './contracts'
import type { NativeProjectTimeline } from './timeline'
import { combineWavetablePatch } from '../../devices/wavetable-synth/model'
import { encodeWavetablePatch } from '../../devices/wavetable-synth/bridge'
import { WAVE_SCHEMA_FINGERPRINT } from '../../devices/wavetable-synth/schema.generated'

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
function harness(input = project(), samples?: SampleLibrary, supportsWave = true, platform = 'win32') {
  const listeners = new Set<(event: NativeEngineEvent) => void>()
  const handlers = new Map<string, (params: Record<string, unknown>) => unknown | Promise<unknown>>()
  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (handlers.has(method)) return handlers.get(method)!(params)
    if (method === 'engine.capabilities') return { protocol: 1, ...(supportsWave ? { wavetable: { protocolVersion: 1, schemaFingerprint: WAVE_SCHEMA_FINGERPRINT } } : {}) }
    if (method === 'engine.configure') return { backend: params.backend, inputDeviceId: params.inputDeviceId || 'input', outputDeviceId: params.outputDeviceId || 'output', inputChannels: params.inputChannels, inputChannelOffset: params.inputChannelOffset, outputChannels: 2, sampleRate: params.sampleRate, bufferFrames: 160, inputLatencyFrames: 80, outputLatencyFrames: 240 } as NativeDeviceState
    if (method === 'project.set') return { revision: (params.timeline as NativeProjectTimeline).revision }
    if (method === 'render.wav') return { data: new Uint8Array(48) }
    if (method === 'plugins.state') return { component: 'AQID', controller: 'BA==' }
    if (method === 'plugins.parameters') return [{ id: 1, title: 'Gain', value: .8, defaultValue: .5, stepCount: 0 }]
    return {}
  })
  const bridge: NativeAudioBridge = { request, subscribe: callback => { listeners.add(callback); return () => { listeners.delete(callback) } } }
  const engine = new NativeAudioEngine(bridge, platform, input, DEFAULT_AUDIO_SETTINGS, samples)
  const calls = (method: string) => request.mock.calls.filter(call => call[0] === method).map(call => call[1])
  return { engine, request, bridge, handlers, calls, emit: (event: NativeEngineEvent) => { for (const listener of listeners) listener(event) } }
}
const engines: NativeAudioEngine[] = []
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); vi.unstubAllGlobals(); vi.useRealTimers() })
const managed = (input?: Project, samples?: SampleLibrary, supportsWave = true, platform = 'win32') => { const h = harness(input, samples, supportsWave, platform); engines.push(h.engine); return h }
const managedUnsupported = (input?: Project) => managed(input, undefined, false)

function waveProject(): Project {
  const wave: Track = { ...createTrack('instrument', 'wavetable'), id: 'wave', clips: [{
    id: 'wave-phrase', kind: 'midi', name: 'Wave phrase', startBeat: 0, lengthBeats: 4, gain: 1,
    notes: [{ id: 'wave-note', start: 0, duration: 1, pitch: 60, velocity: .8 }],
  }] }
  return { ...project(), tracks: [...project().tracks, wave] }
}
const patchOf = (p: Project, id = 'wave') => {
  const track = p.tracks.find(track => track.id === id)!
  return combineWavetablePatch(track.instrumentParams, track.instrumentState)
}
const editWave = (p: Project, macro1: number): Project => ({ ...p, tracks: p.tracks.map(track => track.id === 'wave' ? { ...track, instrumentParams: { ...track.instrumentParams, macro1 } } : track) })

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
    const p = project(); p.tracks[0].devices = [{ ...plugin(), type: 'vst3', enabled: false }]
    const h = managed(p); await h.engine.resume()
    h.handlers.set('plugins.state', () => null)
    expect(await h.engine.capturePluginStates(p)).toBe(p)
    expect(h.calls('plugins.state').at(-1)).toEqual({ instanceId: 'vst', allowUnloaded: true })
    const enabled = { ...p, tracks: [{ ...p.tracks[0], devices: [{ ...plugin(), type: 'vst3' as const }] }] }
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


describe('IEUM WAVE on the native device host', () => {
  it.each([
    ['win32', 'auto', 'wasapi'], ['win32', 'asio', 'asio'], ['darwin', 'auto', 'core-audio'],
  ] as const)('plays, previews and exports unopened WAVE tracks on %s / %s', async (platform, backend, reported) => {
    const p = waveProject(), h = managed(p, undefined, true, platform)
    if (backend !== 'auto') await h.engine.configure({ ...DEFAULT_AUDIO_SETTINGS, nativeBackend: backend }, 48000)
    await h.engine.play()
    expect(h.engine.wavetable.getStatus()).toMatchObject({ available: true, backend: reported, sampleRate: 48000 })
    expect(h.calls('engine.configure')[0]).toMatchObject({ backend: reported === 'core-audio' ? 'coreaudio' : reported, inputChannels: 0 })
    const sent = h.calls('project.set')[0] as { awaitApplied: boolean; timeline: { tracks: Array<{ source: { kind: string; patch?: unknown; patchData?: string }; notes: unknown[] }> } }
    expect(sent.awaitApplied).toBe(true)
    const source = sent.timeline.tracks[1].source
    expect(source.kind).toBe('native-wavetable'); expect(source.patch).toBeUndefined()
    const bytes = Uint8Array.from(atob(source.patchData!), character => character.charCodeAt(0))
    expect(new TextDecoder().decode(bytes.slice(0, 8))).toBe('IEWAVE01')
    expect(bytes).toEqual(encodeWavetablePatch(patchOf(p)))
    expect(sent.timeline.tracks[1].notes).toHaveLength(1)
    await h.engine.previewNote('wavetable', 60, .7, 'wave')
    expect(h.calls('note.preview')[0]).toMatchObject({ trackId: 'wave', pitch: 60, velocity: .7 })
    await expect(h.engine.previewNote('wavetable', 60)).rejects.toThrow('트랙')
    const wav = await h.engine.exportWav()
    expect(wav.size).toBe(48)
    expect(h.calls('render.wav')[0]).toMatchObject({ timeline: { tracks: [{ id: 'keys' }, { id: 'wave', source: { kind: 'native-wavetable', patchData: source.patchData } }] } })
  })

  it('discovers an explicit matching host capability without opening hardware or changing the cached snapshot on reads', async () => {
    const h = managed(waveProject()), hello = deferred()
    h.handlers.set('engine.capabilities', () => hello.promise)
    const snapshots: boolean[] = [], release = h.engine.wavetable.subscribe(status => snapshots.push(status.available))
    const pending = h.engine.wavetable.getStatus()
    expect(h.engine.wavetable.getStatus()).toBe(pending)
    expect(pending.available).toBe(false)
    expect(h.calls('engine.configure')).toHaveLength(0)
    hello.resolve({ protocol: 1, wavetable: { protocolVersion: 1, schemaFingerprint: WAVE_SCHEMA_FINGERPRINT } })
    await vi.waitFor(() => expect(h.engine.wavetable.getStatus().available).toBe(true))
    expect(snapshots).toEqual([true])
    expect(h.engine.wavetable.getStatus().backend).toBeUndefined()
    expect(h.calls('engine.configure')).toHaveLength(0)
    release()
  })

  it.each([
    { protocol: 1 },
    { protocol: 1, wavetable: { protocolVersion: 2, schemaFingerprint: WAVE_SCHEMA_FINGERPRINT } },
    { protocol: 1, wavetable: { protocolVersion: 1, schemaFingerprint: 0 } },
  ])('keeps missing or incompatible WAVE capabilities unavailable: %j', async capabilities => {
    const h = managed(waveProject())
    h.handlers.set('engine.capabilities', () => capabilities)
    await expect(h.engine.play()).rejects.toThrow('IEUM WAVE')
    expect(h.engine.wavetable.getStatus().available).toBe(false)
    expect(h.calls('engine.configure')).toHaveLength(0)
  })

  it('does not reopen hardware when resume is canceled after an idle capability lookup', async () => {
    const h = managed(waveProject()), release = h.engine.wavetable.subscribe(() => {})
    await vi.waitFor(() => expect(h.engine.wavetable.getStatus().available).toBe(true))
    const resuming = h.engine.resume()
    h.engine.dispose()
    await expect(resuming).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.calls('engine.configure')).toHaveLength(0)
    release()
  })

  it('does not carry an idle host capability into a different native process generation', async () => {
    const h = managed(waveProject()), release = h.engine.wavetable.subscribe(() => {})
    await vi.waitFor(() => expect(h.engine.wavetable.getStatus().available).toBe(true))
    h.emit({ type: 'state', generation: 1 })
    h.emit({ type: 'state', generation: 2 })
    expect(h.engine.wavetable.getStatus().available).toBe(false)
    h.handlers.set('engine.capabilities', () => ({ protocol: 1 }))
    await h.engine.configure(DEFAULT_AUDIO_SETTINGS, 48000)
    await expect(h.engine.play()).rejects.toThrow('IEUM WAVE')
    expect(h.calls('engine.capabilities')).toHaveLength(2)
    release()
  })

  it('starts the first editor audition and acknowledges only after the graph reaches the audio callback', async () => {
    const p = waveProject(), h = managed(p), applied = deferred()
    h.handlers.set('project.set', () => applied.promise)
    const audition = h.engine.wavetable.applyPatch('wave', patchOf(p), 1)
    let ready = false; void audition.then(() => { ready = true })
    await vi.waitFor(() => expect(h.calls('project.set')).toHaveLength(1))
    expect(h.calls('engine.configure')[0]).toMatchObject({ backend: 'wasapi' })
    expect(h.calls('project.set')[0]?.awaitApplied).toBe(true)
    expect(ready).toBe(false)
    expect(() => h.engine.wavetable.previewNoteOn('wave', 60, .8)).toThrow('최신 음색')
    applied.resolve({ revision: (h.calls('project.set')[0]?.timeline as NativeProjectTimeline).revision })
    await expect(audition).resolves.toEqual({ revision: 1 })
    h.engine.wavetable.previewNoteOn('wave', 60, .8)
    expect(h.calls('note.on')[0]).toMatchObject({ trackId: 'wave', pitch: 60, velocity: .8, noteId: expect.any(Number) })
  })

  it('releases only the editor-owned note IDs on the requested track, including separate MIDI channels', async () => {
    const p = waveProject(); p.tracks.push({ ...p.tracks[1], id: 'other-wave', clips: [] })
    const h = managed(p)
    await h.engine.wavetable.applyPatch('wave', patchOf(p), 1)
    await h.engine.wavetable.applyPatch('other-wave', patchOf(p, 'other-wave'), 1)
    h.engine.wavetable.previewNoteOn('wave', 60, .8, 0)
    h.engine.wavetable.previewNoteOn('wave', 60, .7, 1)
    h.engine.wavetable.previewNoteOn('other-wave', 60, .6)
    const on = h.calls('note.on')
    expect(new Set(on.map(note => note?.noteId)).size).toBe(3)
    h.engine.wavetable.allNotesOff('wave')
    expect(h.calls('note.off')).toEqual(on.slice(0, 2).map(note => ({ trackId: 'wave', pitch: 60, noteId: note?.noteId })))
    expect(h.calls('note.allOff')).toHaveLength(0)
    expect(h.calls('transport.stop')).toHaveLength(0)
    h.engine.wavetable.previewNoteOff('other-wave', 60)
    expect(h.calls('note.off').at(-1)).toEqual({ trackId: 'other-wave', pitch: 60, noteId: on[2]?.noteId })
  })

  it('coalesces patch edits into the authoritative project and never acknowledges a superseded editor revision', async () => {
    const p = waveProject(), h = managed(p); await h.engine.resume()
    const first = editWave(p, .2), latest = editWave(p, .7), waiting = deferred()
    let submissions = 0
    h.handlers.set('project.set', ({ timeline }) => ++submissions === 1 ? waiting.promise : { revision: (timeline as NativeProjectTimeline).revision })
    h.engine.setProject(first)
    const stale = h.engine.wavetable.applyPatch('wave', patchOf(first), 1)
    const canceled = expect(stale).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(h.calls('project.set')).toHaveLength(2))
    h.engine.setProject(latest)
    const current = h.engine.wavetable.applyPatch('wave', patchOf(latest), 2)
    waiting.resolve({ revision: (h.calls('project.set')[1]?.timeline as NativeProjectTimeline).revision })
    await canceled
    await expect(current).resolves.toEqual({ revision: 2 })
    const source = (h.calls('project.set').at(-1)?.timeline as { tracks: Array<{ source: { patchData?: string } }> }).tracks[1].source
    expect(Uint8Array.from(atob(source.patchData!), character => character.charCodeAt(0))).toEqual(encodeWavetablePatch(patchOf(latest)))
    h.engine.wavetable.previewNoteOn('wave', 64, .8)
    expect(h.calls('note.on')).toHaveLength(1)
    const callsBefore = h.calls('project.set').length
    await expect(h.engine.wavetable.applyPatch('wave', patchOf(first), 3)).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.calls('project.set')).toHaveLength(callsBefore)
  })

  it('rejects a mismatched graph acknowledgment without enabling the keyboard', async () => {
    const p = waveProject(), h = managed(p)
    h.handlers.set('project.set', ({ timeline }) => ({ revision: (timeline as NativeProjectTimeline).revision + 1 }))
    await expect(h.engine.wavetable.applyPatch('wave', patchOf(p), 1)).rejects.toThrow('확인 번호')
    expect(h.engine.wavetable.getStatus().available).toBe(false)
    expect(() => h.engine.wavetable.previewNoteOn('wave', 60, .8)).toThrow()
    expect(h.calls('note.on')).toHaveLength(0)
  })

  it('releases held notes on driver changes and requires the patch to be applied at the new device rate', async () => {
    const p = waveProject(), h = managed(p)
    await h.engine.wavetable.applyPatch('wave', patchOf(p), 1)
    h.engine.wavetable.previewNoteOn('wave', 60, .8)
    const statuses: boolean[] = [], release = h.engine.wavetable.subscribe(status => statuses.push(status.available))
    await h.engine.configure({ ...DEFAULT_AUDIO_SETTINGS, nativeBackend: 'asio' }, 44100)
    expect(h.calls('note.off')).toHaveLength(1)
    expect(statuses).toContain(false)
    expect(h.engine.wavetable.getStatus()).toMatchObject({ available: true, backend: 'asio', sampleRate: 44100 })
    expect(() => h.engine.wavetable.previewNoteOn('wave', 62, .8)).toThrow('최신 음색')
    h.engine.setProject({ ...p, sampleRate: 44100 })
    await h.engine.wavetable.applyPatch('wave', patchOf(p), 2)
    h.engine.wavetable.previewNoteOn('wave', 62, .8)
    expect(h.calls('project.set').at(-1)).toMatchObject({ awaitApplied: true, timeline: { sampleRate: 44100 } })
    h.engine.stop()
    expect(h.calls('note.off')).toHaveLength(2)
    release()
  })

  it('does not let a delayed old-device graph acknowledgment poison a newly configured device', async () => {
    const p = waveProject(), h = managed(p); await h.engine.resume()
    const edited = editWave(p, .4), delayed = deferred()
    let submissions = 0
    h.handlers.set('project.set', ({ timeline }) => ++submissions === 1 ? delayed.promise : { revision: (timeline as NativeProjectTimeline).revision })
    h.engine.setProject(edited)
    const applying = h.engine.wavetable.applyPatch('wave', patchOf(edited), 1)
    const canceled = expect(applying).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(h.calls('project.set')).toHaveLength(2))
    await h.engine.configure({ ...DEFAULT_AUDIO_SETTINGS, nativeBackend: 'asio' }, 48000)
    delayed.resolve({ revision: (h.calls('project.set')[1]?.timeline as NativeProjectTimeline).revision })
    await canceled
    expect(h.engine.getAudioState().status).toBe('ready')
    await expect(h.engine.wavetable.applyPatch('wave', patchOf(edited), 2)).resolves.toEqual({ revision: 2 })
    expect(h.engine.wavetable.getStatus()).toMatchObject({ available: true, backend: 'asio' })
  })

  it('invalidates WAVE on host loss, rediscovers it during recovery, and discards late replies after close', async () => {
    const p = waveProject(), h = managed(p)
    await h.engine.wavetable.applyPatch('wave', patchOf(p), 1)
    h.engine.wavetable.previewNoteOn('wave', 60, .8)
    h.emit({ type: 'state', generation: 1 })
    h.emit({ type: 'error', generation: 1, error: 'host disconnected' })
    expect(h.engine.wavetable.getStatus().available).toBe(false)
    expect(() => h.engine.wavetable.previewNoteOn('wave', 62, .8)).toThrow()
    await h.engine.configure(DEFAULT_AUDIO_SETTINGS, 48000)
    await h.engine.wavetable.applyPatch('wave', patchOf(p), 2)
    expect(h.calls('engine.capabilities')).toHaveLength(2)
    const edited = editWave(p, .6), delayed = deferred()
    h.handlers.set('project.set', () => delayed.promise)
    h.engine.setProject(edited)
    const applying = h.engine.wavetable.applyPatch('wave', patchOf(edited), 3)
    const canceled = expect(applying).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(h.calls('project.set')).toHaveLength(3))
    const revision = (h.calls('project.set').at(-1)?.timeline as NativeProjectTimeline).revision
    h.engine.dispose(); delayed.resolve({ revision }); await canceled
    expect(h.engine.wavetable.getStatus().available).toBe(false)
    h.handlers.delete('project.set')
    h.engine.setProject({ ...p, id: 'reopened' })
    await expect(h.engine.wavetable.applyPatch('wave', patchOf(p), 4)).resolves.toEqual({ revision: 4 })
    expect(h.calls('engine.capabilities')).toHaveLength(3)
    expect(h.engine.wavetable.getStatus()).toMatchObject({ available: true, backend: 'wasapi' })
  })
})

describe('unsupported native host coexistence with the WAVE editor', () => {
  it('rejects unavailable WAVE playback, export and direct preview before opening a device', async () => {
    const h = managedUnsupported(waveProject())
    await expect(h.engine.play()).rejects.toThrow('IEUM WAVE')
    await expect(h.engine.exportWav()).rejects.toThrow('IEUM WAVE')
    await expect(h.engine.previewNote('wavetable', 60)).rejects.toThrow('IEUM WAVE')
    await expect(h.engine.previewNote('keys', 60, .8, 'wave')).rejects.toThrow('IEUM WAVE')
    expect(h.calls('engine.configure')).toHaveLength(0)
    expect(h.calls('note.preview')).toHaveLength(0)
    expect(h.calls('render.wav')).toHaveLength(0)
    expect(h.engine.getAudioState().error).toBeNull()
  })

  it('keeps WAVE patches and both tracks\' VST states savable without sending an unsupported source to the device host', async () => {
    const p = waveProject()
    p.tracks[0].pluginInstrument = plugin()
    p.tracks[1].devices = [{ ...plugin(), type: 'vst3', id: 'wave-insert', name: 'Wave insert' }]
    p.tracks[1].instrumentParams.macro1 = .37
    const originalState = structuredClone(p.tracks[1].instrumentState)
    const h = managedUnsupported(p)
    h.handlers.set('project.set', ({ timeline }) => {
      for (const track of (timeline as NativeProjectTimeline).tracks) {
        if (track.source.kind === 'native-wavetable') throw new Error('Unsupported native track source: native-wavetable')
      }
      return {}
    })
    await h.engine.resume()
    const timeline = h.calls('project.set')[0]?.timeline as NativeProjectTimeline
    expect(timeline.tracks[0].source.kind).toBe('vst3')
    expect(timeline.tracks[1]).toMatchObject({ source: { kind: 'audio' }, notes: [], inserts: [{ type: 'vst3', plugin: { id: 'wave-insert' } }] })
    const captured = await h.engine.capturePluginStates(p)
    expect(captured.tracks[0].pluginInstrument).toMatchObject({ state: { component: 'AQID', controller: 'BA==' }, parameters: { '1': .8 } })
    expect(captured.tracks[1].devices[0]).toMatchObject({ type: 'vst3', state: { component: 'AQID', controller: 'BA==' }, parameters: { '1': .8 } })
    expect(captured.tracks[1].instrumentState).toEqual(originalState)
    expect(captured.tracks[1].instrumentParams.macro1).toBe(.37)
    expect(captured.tracks[1].clips).toEqual(p.tracks[1].clips)
    const saved = await importProjectBundle(await exportProjectBundle(captured, new Map()))
    expect(saved.project).toEqual(captured)
    await expect(h.engine.play()).rejects.toThrow('IEUM WAVE')
    expect(h.calls('transport.play')).toHaveLength(0)
  })

  it.each([{ mute: true }, { enabled: false }, { volume: 0 }, { clips: [] }])('allows inaudible WAVE tracks to coexist with native playback: %j', async patch => {
    const p = waveProject(); p.tracks[1] = { ...p.tracks[1], ...patch }
    const h = managedUnsupported(p)
    await h.engine.play(); await h.engine.exportWav()
    expect(h.calls('transport.play')).toHaveLength(1)
    expect(h.calls('render.wav')).toHaveLength(1)
  })

  it('honors a VST3 source override on a track that retains a WAVE patch', async () => {
    const p = waveProject(); p.tracks[1].pluginInstrument = plugin()
    const h = managedUnsupported(p)
    await h.engine.play(); await h.engine.previewNote('wavetable', 60, .8, 'wave')
    const timeline = h.calls('project.set')[0]?.timeline as NativeProjectTimeline
    expect(timeline.tracks[1].source.kind).toBe('vst3')
    expect(timeline.tracks[1].notes).toHaveLength(1)
    expect(h.calls('note.preview')[0]).toMatchObject({ trackId: 'wave', pitch: 60 })
  })

  it('stops live playback when an edit introduces unavailable WAVE notes without turning that into a device failure', async () => {
    const h = managedUnsupported(); await h.engine.play()
    h.engine.setProject(waveProject())
    expect(h.engine.getSnapshot().playing).toBe(false)
    expect(h.calls('transport.pause')).toHaveLength(1)
    await h.engine.resume()
    await expect(h.engine.play()).rejects.toThrow('IEUM WAVE')
    expect(h.engine.getAudioState().status).toBe('ready')
    expect(h.calls('transport.play')).toHaveLength(1)
  })

  it('rechecks WAVE availability after a delayed device configuration', async () => {
    const h = managedUnsupported(), pending = deferred<NativeDeviceState>()
    h.handlers.set('engine.configure', () => pending.promise)
    const playing = h.engine.play()
    const rejected = expect(playing).rejects.toThrow('IEUM WAVE')
    h.engine.setProject(waveProject())
    pending.resolve({ backend: 'wasapi', sampleRate: 48000, bufferFrames: 128, inputChannels: 0, outputChannels: 2, inputDeviceId: '', outputDeviceId: 'output' })
    await rejected
    expect(h.calls('transport.play')).toHaveLength(0)
  })

  it.each(['play', 'record', 'monitor'] as const)('cancels native playback when WAVE is introduced while the %s response is pending', async mode => {
    const h = managedUnsupported(), pending = deferred()
    if (mode !== 'play') await h.engine.play()
    h.handlers.set('transport.play', () => pending.promise)
    const playing = mode === 'play' ? h.engine.play() : mode === 'record' ? h.engine.prepareRecording() : h.engine.setNativeMonitoring(['keys'])
    const starts = mode === 'play' ? 1 : 2
    await vi.waitFor(() => expect(h.calls('transport.play')).toHaveLength(starts))
    h.engine.setProject(waveProject())
    const pausesDuringStart = h.calls('transport.pause').length
    pending.resolve({}); await playing
    expect(pausesDuringStart).toBe(1)
    expect(h.engine.getSnapshot().playing).toBe(false)
    await expect(h.engine.play()).rejects.toThrow('IEUM WAVE')
    expect(h.calls('transport.play')).toHaveLength(starts)
  })

  it.each(['record', 'monitor'] as const)('rechecks WAVE before restoring playback after %s input configuration', async mode => {
    const h = managedUnsupported(); await h.engine.play()
    const pending = deferred<NativeDeviceState>()
    h.handlers.set('engine.configure', () => pending.promise)
    const preparation = mode === 'record' ? h.engine.prepareRecording() : h.engine.setNativeMonitoring(['keys'])
    const rejected = expect(preparation).rejects.toThrow('IEUM WAVE')
    await vi.waitFor(() => expect(h.calls('engine.configure')).toHaveLength(2))
    h.engine.setProject(waveProject())
    pending.resolve({ backend: 'wasapi', sampleRate: 48000, bufferFrames: 128, inputChannels: 1, outputChannels: 2, inputDeviceId: 'input', outputDeviceId: 'output' })
    await rejected
    expect(h.calls('transport.play')).toHaveLength(1)
    expect(h.engine.getSnapshot().playing).toBe(false)
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AUDIO_SETTINGS } from '../core/audioSettings'
import { createDevice, createEmptyProject, createTrack } from '../core/project'
import type { Project } from '../core/types'
import { WebAudioEngine } from './WebAudioEngine'
import { prepareEffects } from './effectPreparation'
import { EFFECT_MODULES } from '../devices/effects/registry'
import * as guitarRig from '../devices/guitar-rig'
import type { RememberNode } from '../devices/contracts'

vi.mock('./effectPreparation', () => ({ prepareEffects: vi.fn(() => Promise.resolve()) }))

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Web Audio API spies exercise real engine/graph wiring. They do not measure DSP or hardware latency.
class Parameter {
  value = 1
  cancelScheduledValues = vi.fn()
  setValueAtTime = vi.fn((value: number, _time: number) => { this.value = value })
  setTargetAtTime = vi.fn((value: number, _time: number, _constant: number) => { this.value = value })
}

class NodeSpy {
  connections = new Set<unknown>()
  connect = vi.fn((target: unknown) => { this.connections.add(target); return target as NodeSpy })
  disconnect = vi.fn((target?: unknown) => { if (target) this.connections.delete(target); else this.connections.clear() })
  gain = new Parameter()
  pan = new Parameter()
  threshold = new Parameter()
  knee = new Parameter()
  ratio = new Parameter()
  attack = new Parameter()
  release = new Parameter()
  fftSize = 256
  getFloatTimeDomainData = (values: Float32Array) => { values.fill(0) }
}

interface ContextPlan {
  resume?: Promise<void>
  sinkError?: Error
  sinkOverride?: string
  actualRate?: number
  renderSize?: number | null
  outputLatency?: number | null
  noSinkSelection?: boolean
  onMonitor?: (context: ContextSpy) => void
}

class ContextSpy extends EventTarget {
  static instances: ContextSpy[] = []
  static plans: ContextPlan[] = []
  readonly plan: ContextPlan
  readonly sampleRate: number
  readonly options: AudioContextOptions & { renderSizeHint?: string | number }
  currentTime = 0
  state: AudioContextState = 'suspended'
  baseLatency = 0.004
  outputLatency?: number
  renderQuantumSize?: number
  sinkId = ''
  onstatechange: (() => void) | null = null
  destination = new NodeSpy()
  gains: NodeSpy[] = []
  monitors: NodeSpy[] = []

  constructor(options: AudioContextOptions & { renderSizeHint?: string | number } = {}) {
    super()
    this.plan = ContextSpy.plans.shift() ?? {}
    this.options = options
    this.sampleRate = this.plan.actualRate ?? options.sampleRate ?? 48000
    this.outputLatency = this.plan.outputLatency === null ? undefined : this.plan.outputLatency ?? 0.012
    this.renderQuantumSize = this.plan.renderSize === null ? undefined : this.plan.renderSize ?? 128
    if (this.plan.noSinkSelection) Object.defineProperty(this, 'setSinkId', { value: undefined })
    ContextSpy.instances.push(this)
  }

  resume = vi.fn(async () => {
    if (this.plan.resume) await this.plan.resume
    if (this.state === 'closed') throw new DOMException('Closed context', 'InvalidStateError')
    this.state = 'running'
    this.onstatechange?.()
  })
  close = vi.fn(async () => { this.state = 'closed'; this.onstatechange?.() })
  setSinkId = vi.fn(async (sinkId: string) => {
    if (this.plan.sinkError) throw this.plan.sinkError
    this.sinkId = this.plan.sinkOverride ?? sinkId
  })
  createGain = () => { const node = new NodeSpy(); this.gains.push(node); return node }
  createStereoPanner = () => new NodeSpy()
  createAnalyser = () => new NodeSpy()
  createDynamicsCompressor = () => new NodeSpy()
  createMediaStreamSource = vi.fn((_stream: MediaStream) => {
    this.plan.onMonitor?.(this)
    const node = new NodeSpy()
    this.monitors.push(node)
    return node
  })
}

class OfflineContextSpy {
  static instances: OfflineContextSpy[] = []
  currentTime = 0
  destination = new NodeSpy()
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    OfflineContextSpy.instances.push(this)
  }
  createGain = () => new NodeSpy()
  createStereoPanner = () => new NodeSpy()
  createAnalyser = () => new NodeSpy()
  createDynamicsCompressor = () => new NodeSpy()
  startRendering = vi.fn(async () => ({ sampleRate: this.sampleRate, getChannelData: () => new Float32Array(8) }))
  decodeAudioData = async () => ({ sampleRate: this.sampleRate, length: 8, duration: 8 / this.sampleRate, numberOfChannels: 1, getChannelData: () => new Float32Array(8) })
}

const outputDevices = (...ids: string[]): MediaDeviceInfo[] => ids.map(deviceId => ({ kind: 'audiooutput', deviceId }) as MediaDeviceInfo)
class MediaDevicesSpy extends EventTarget {
  enumerateDevices = vi.fn<() => Promise<MediaDeviceInfo[]>>().mockResolvedValue(outputDevices('default', 'usb'))
}

let engines: WebAudioEngine[] = []
let mediaDevices: MediaDevicesSpy
function engineFor(project: Project = createEmptyProject()) {
  const engine = new WebAudioEngine(project)
  engines.push(engine)
  return engine
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(prepareEffects).mockReset().mockResolvedValue(undefined)
  ContextSpy.instances = []
  ContextSpy.plans = []
  OfflineContextSpy.instances = []
  mediaDevices = new MediaDevicesSpy()
  vi.stubGlobal('navigator', { mediaDevices })
  vi.stubGlobal('AudioContext', ContextSpy)
  vi.stubGlobal('OfflineAudioContext', OfflineContextSpy)
})

describe('selected output device health', () => {
  it('cancels a pending track audition if the track changes to a native instrument', async () => {
    const track = createTrack('instrument', 'keys')
    const project = { ...createEmptyProject(), tracks: [track] }
    const engine = engineFor(project)
    await engine.resume()
    const ready = deferred<void>()
    vi.spyOn(engine, 'resume').mockReturnValue(ready.promise)
    const audition = engine.previewNote('keys', 60, 0.8, track.id)
    engine.setProject({ ...project, tracks: [{ ...createTrack('instrument', 'wavetable'), id: track.id }] })
    const nodes = ContextSpy.instances[0].gains.length
    ready.resolve()
    await expect(audition).resolves.toBeUndefined()
    expect(ContextSpy.instances[0].gains).toHaveLength(nodes)
  })

  it('rechecks native support after asynchronous device startup before beginning playback', async () => {
    const ready = deferred<void>()
    ContextSpy.plans.push({ resume: ready.promise })
    const project = createEmptyProject()
    const engine = engineFor(project)
    const starting = engine.play()
    const native = createTrack('instrument', 'wavetable')
    native.clips = [{ id: 'native-pending-clip', kind: 'midi', name: 'Native', startBeat: 0, lengthBeats: 4, gain: 1, notes: [{ id: 'native-pending-note', pitch: 60, start: 0, duration: 1, velocity: 0.8 }] }]
    engine.setProject({ ...project, tracks: [native] })
    ready.resolve()
    await expect(starting).rejects.toThrow(/네이티브/)
    expect(engine.getSnapshot().playing).toBe(false)
  })

  it('stops an active browser transport if a project edit introduces audible native notes', async () => {
    const project = createEmptyProject()
    const engine = engineFor(project)
    await engine.play()
    expect(engine.getSnapshot().playing).toBe(true)
    const native = createTrack('instrument', 'wavetable')
    native.clips = [{ id: 'native-clip', kind: 'midi', name: 'Native', startBeat: 0, lengthBeats: 4, gain: 1, notes: [{ id: 'native-note', pitch: 60, start: 0, duration: 1, velocity: 0.8 }] }]
    engine.setProject({ ...project, tracks: [native] })
    expect(engine.getSnapshot().playing).toBe(false)
    await expect(engine.play()).rejects.toThrow(/네이티브/)
  })

  it('stops transport and monitoring if an explicit output can no longer be verified, and keeps the saved choice', async () => {
    const project = { ...createEmptyProject(), tracks: [{ ...createTrack('audio'), id: 'input', monitor: true }] }
    const engine = engineFor(project)
    const stream = { active: true } as MediaStream
    engine.setInputMonitor(stream, ['input'])
    await engine.configure({ ...DEFAULT_AUDIO_SETTINGS, outputDeviceId: 'usb' }, 48000)
    await engine.play()
    vi.advanceTimersByTime(40)
    const context = ContextSpy.instances[0]
    const source = context.monitors[0]
    const gate = context.gains.at(-4)!
    expect(source.connections.size).toBe(1)
    mediaDevices.enumerateDevices.mockResolvedValue(outputDevices('default'))
    mediaDevices.dispatchEvent(new Event('devicechange'))
    await Promise.resolve()
    expect(engine.getSnapshot()).toMatchObject({ playing: false, ready: false })
    expect(source.connections.size).toBe(0)
    expect(gate.gain.value).toBe(0)
    expect(engine.getAudioState()).toMatchObject({ status: 'error', needsReconfiguration: true, settings: { outputDeviceId: 'usb' } })
    expect(engine.getAudioState().error).toContain('연결·스피커 권한')
    engine.pause()
    engine.setInputMonitor(stream, ['input'])
    expect(context.createMediaStreamSource).toHaveBeenCalledTimes(1)
    expect(context.gains.at(-4)!.gain.value).toBe(0)
    await expect(engine.play()).rejects.toThrow('출력 장치')
    engine.setProject({ ...project, sampleRate: 96000 })
    expect(engine.getAudioState().status).toBe('error')
  })

  it('does not clear a device fault through an input-only fast path; explicit default selection recovers', async () => {
    const engine = engineFor()
    const selected = { ...DEFAULT_AUDIO_SETTINGS, outputDeviceId: 'usb' }
    await engine.configure(selected, 48000)
    const context = ContextSpy.instances[0]
    context.dispatchEvent(new Event('error'))
    ContextSpy.plans.push({ sinkError: new DOMException('Device missing', 'NotFoundError') })
    await expect(engine.configure({ ...selected, inputChannels: 2 }, 48000)).rejects.toThrow('Device missing')
    expect(ContextSpy.instances).toHaveLength(2)
    expect(context.close).not.toHaveBeenCalled()
    expect(engine.getAudioState()).toMatchObject({ status: 'error', needsReconfiguration: true, settings: { outputDeviceId: 'usb', inputChannels: 'default' } })
    await engine.configure(DEFAULT_AUDIO_SETTINGS, 48000)
    expect(engine.getAudioState()).toMatchObject({ status: 'ready', error: null, needsReconfiguration: false, settings: { outputDeviceId: '' } })
    expect(context.state).toBe('closed')
    // Choosing the system default permits system device routing; it does not pin a removed USB ID.
    mediaDevices.dispatchEvent(new Event('devicechange'))
    context.dispatchEvent(new Event('error'))
    expect(mediaDevices.enumerateDevices).not.toHaveBeenCalled()
    expect(engine.getAudioState().status).toBe('ready')
  })

  it('blocks an unexpected sink substitution and requires a newly validated context to clear it', async () => {
    const engine = engineFor()
    const selected = { ...DEFAULT_AUDIO_SETTINGS, outputDeviceId: 'usb' }
    await engine.configure(selected, 48000)
    const context = ContextSpy.instances[0]
    context.sinkId = ''
    context.dispatchEvent(new Event('sinkchange'))
    expect(engine.getAudioState()).toMatchObject({ status: 'error', sinkId: '', needsReconfiguration: true, settings: { outputDeviceId: 'usb' } })
    await engine.configure(selected, 48000)
    expect(ContextSpy.instances).toHaveLength(2)
    expect(engine.getAudioState()).toMatchObject({ status: 'ready', sinkId: 'usb', needsReconfiguration: false })
    ContextSpy.plans.push({ sinkOverride: '' })
    await expect(engine.configure({ ...selected, outputDeviceId: 'another-usb' }, 48000)).rejects.toThrow('실제 출력이 선택한 장치와 다릅니다')
    expect(ContextSpy.instances[2].state).toBe('closed')
    expect(ContextSpy.instances[1].state).toBe('running')
  })

  it('ignores stale enumeration replies after a newer event, context replacement, or disposal', async () => {
    const engine = engineFor()
    const selected = { ...DEFAULT_AUDIO_SETTINGS, outputDeviceId: 'usb' }
    await engine.configure(selected, 48000)
    const first = deferred<MediaDeviceInfo[]>()
    mediaDevices.enumerateDevices.mockReturnValueOnce(first.promise).mockResolvedValueOnce(outputDevices('usb'))
    mediaDevices.dispatchEvent(new Event('devicechange'))
    mediaDevices.dispatchEvent(new Event('devicechange'))
    await Promise.resolve()
    first.resolve([])
    await Promise.resolve()
    expect(engine.getAudioState().status).toBe('ready')
    const replaced = deferred<MediaDeviceInfo[]>()
    mediaDevices.enumerateDevices.mockReturnValueOnce(replaced.promise)
    mediaDevices.dispatchEvent(new Event('devicechange'))
    await engine.configure({ ...selected, latencyHint: 'balanced' }, 48000)
    replaced.resolve([])
    await Promise.resolve()
    expect(engine.getAudioState().status).toBe('ready')
    const disposed = deferred<MediaDeviceInfo[]>()
    mediaDevices.enumerateDevices.mockReturnValueOnce(disposed.promise)
    mediaDevices.dispatchEvent(new Event('devicechange'))
    engine.dispose()
    mediaDevices.dispatchEvent(new Event('devicechange'))
    disposed.resolve([])
    await Promise.resolve()
    ContextSpy.instances[1].dispatchEvent(new Event('sinkchange'))
    ContextSpy.instances[1].dispatchEvent(new Event('error'))
    expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(4)
    expect(engine.getAudioState()).toMatchObject({ status: 'idle', error: null, sampleRate: null })
  })

  it('explains restricted device lists without falsely claiming a physical disconnection', async () => {
    const engine = engineFor()
    await engine.configure({ ...DEFAULT_AUDIO_SETTINGS, outputDeviceId: 'usb' }, 48000)
    mediaDevices.enumerateDevices.mockResolvedValue([])
    mediaDevices.dispatchEvent(new Event('devicechange'))
    await Promise.resolve()
    expect(engine.getAudioState().error).toContain('출력 장치 목록을 제공하지 않아')
    expect(engine.getAudioState().error).toContain('스피커 권한')
    expect(engine.getAudioState().settings.outputDeviceId).toBe('usb')
  })

  it('rolls back a candidate that emits an output error before its resume completes', async () => {
    const engine = engineFor()
    await engine.resume()
    const wait = deferred()
    ContextSpy.plans.push({ resume: wait.promise })
    const failed = engine.configure({ ...DEFAULT_AUDIO_SETTINGS, outputDeviceId: 'usb' }, 48000).catch(error => error)
    await Promise.resolve()
    ContextSpy.instances[1].dispatchEvent(new Event('error'))
    wait.resolve()
    expect(await failed).toBeInstanceOf(Error)
    expect(ContextSpy.instances[1].state).toBe('closed')
    expect(ContextSpy.instances[0].state).toBe('running')
    expect(engine.getAudioState().settings.outputDeviceId).toBe('')
  })
})

afterEach(() => {
  for (const engine of engines) engine.dispose()
  engines = []
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('playback toggles during device startup', () => {
  it('treats a second toggle before resume completes as pause and permits a later retry', async () => {
    const engine = engineFor(), wait = deferred()
    engine.seek(4)
    ContextSpy.plans.push({ resume: wait.promise })
    const first = engine.togglePlayback()
    await engine.togglePlayback()
    expect(engine.getSnapshot()).toMatchObject({ playing: false, beat: 4 })
    wait.resolve()
    await first
    expect(engine.getSnapshot()).toMatchObject({ playing: false, beat: 4, ready: true })
    await engine.togglePlayback()
    expect(engine.getSnapshot().playing).toBe(true)
    await engine.togglePlayback()
    expect(engine.getSnapshot().playing).toBe(false)
  })

  it('honors three rapid toggles while the shared context is still preparing', async () => {
    const engine = engineFor(), wait = deferred()
    ContextSpy.plans.push({ resume: wait.promise })
    const first = engine.togglePlayback()
    const second = engine.togglePlayback()
    const third = engine.togglePlayback()
    expect(ContextSpy.instances).toHaveLength(1)
    expect(engine.getSnapshot().playing).toBe(false)
    wait.resolve()
    await Promise.all([first, second, third])
    expect(engine.getSnapshot().playing).toBe(true)
    await engine.togglePlayback()
    expect(engine.getSnapshot().playing).toBe(false)
  })

  it('does not resume after a pending toggle is stopped, and the next toggle starts at zero', async () => {
    const engine = engineFor(), wait = deferred()
    engine.seek(7)
    ContextSpy.plans.push({ resume: wait.promise })
    const pending = engine.togglePlayback()
    engine.stop()
    wait.resolve()
    await pending
    expect(engine.getSnapshot()).toMatchObject({ playing: false, beat: 0 })
    await engine.togglePlayback()
    expect(engine.getSnapshot()).toMatchObject({ playing: true, beat: 0 })
  })

  it('keeps a newer pending toggle owned when an older configure-cancelled play settles late', async () => {
    const engine = engineFor(), oldResume = deferred(), newResume = deferred()
    ContextSpy.plans.push({ resume: oldResume.promise })
    const stale = engine.togglePlayback().catch(error => error)
    ContextSpy.plans.push({ resume: newResume.promise })
    const configure = engine.configure({ ...DEFAULT_AUDIO_SETTINGS, latencyHint: 'balanced' }, 48000)
    const newer = engine.togglePlayback()
    expect(ContextSpy.instances[0].state).toBe('closed')
    oldResume.resolve()
    expect(await stale).toMatchObject({ name: 'AbortError' })
    // If the stale finally cleared the newer token, this would start playback.
    // It must cancel the newer pending play without waiting for device startup.
    await engine.togglePlayback()
    newResume.resolve()
    await Promise.all([configure, newer])
    expect(engine.getSnapshot().playing).toBe(false)
    expect(engine.getAudioState()).toMatchObject({ status: 'ready', settings: { latencyHint: 'balanced' } })
    await engine.togglePlayback()
    expect(engine.getSnapshot().playing).toBe(true)
  })

  it('allows an explicit toggle after disposal without the disposed request overriding it', async () => {
    const engine = engineFor(), oldResume = deferred(), newResume = deferred()
    ContextSpy.plans.push({ resume: oldResume.promise })
    const stale = engine.togglePlayback().catch(error => error)
    engine.dispose()
    ContextSpy.plans.push({ resume: newResume.promise })
    const fresh = engine.togglePlayback()
    oldResume.resolve()
    expect(await stale).toMatchObject({ name: 'AbortError' })
    expect(engine.getSnapshot().playing).toBe(false)
    newResume.resolve()
    await fresh
    expect(engine.getSnapshot()).toMatchObject({ playing: true, ready: true })
    expect(ContextSpy.instances).toHaveLength(2)
  })

  it('clears a failed startup request so the next toggle retries playback', async () => {
    const engine = engineFor(), wait = deferred()
    ContextSpy.plans.push({ resume: wait.promise })
    const failure = engine.togglePlayback().catch(error => error)
    const denied = new DOMException('Device startup denied', 'NotAllowedError')
    wait.reject(denied)
    expect(await failure).toBe(denied)
    expect(engine.getSnapshot().playing).toBe(false)
    expect(ContextSpy.instances[0].state).toBe('closed')
    await engine.togglePlayback()
    expect(engine.getSnapshot()).toMatchObject({ playing: true, ready: true })
    expect(ContextSpy.instances).toHaveLength(2)
  })
})

describe('audio settings and context transactions', () => {
  it('stays idle during construction and opens the project rate on first playback', async () => {
    const engine = engineFor({ ...createEmptyProject(), sampleRate: 96000 })
    expect(ContextSpy.instances).toHaveLength(0)
    expect(engine.getAudioState()).toMatchObject({ status: 'idle', requestedSampleRate: 96000, sampleRate: null })
    const snapshot = engine.getAudioState()
    expect(engine.getAudioState()).toBe(snapshot)
    await engine.play()
    expect(ContextSpy.instances[0].options).toMatchObject({ sampleRate: 96000, latencyHint: 'interactive' })
    expect(engine.getSnapshot()).toMatchObject({ playing: true, ready: true, sampleRate: 96000 })
  })

  it('reports accepted hints separately from the actual render quantum and output latency', async () => {
    const engine = engineFor()
    const changed = vi.fn()
    engine.subscribeAudioState(changed)
    const settings = { ...DEFAULT_AUDIO_SETTINGS, outputDeviceId: 'usb-speakers', latencyHint: 'playback' as const, renderSizeHint: 512 as const }
    ContextSpy.plans.push({ renderSize: 256, outputLatency: 0.02 })
    await engine.configure(settings, 96000)
    expect(ContextSpy.instances[0].setSinkId).toHaveBeenCalledWith('usb-speakers')
    expect(ContextSpy.instances[0].options).toEqual({ sampleRate: 96000, latencyHint: 'playback', renderSizeHint: 512 })
    expect(engine.getAudioState()).toMatchObject({ status: 'ready', sampleRate: 96000, requestedSampleRate: 96000,
      baseLatency: 0.004, outputLatency: 0.02, renderQuantumSize: 256, sinkId: 'usb-speakers', settings, supportsRenderSize: true })
    expect(changed).toHaveBeenCalled()
  })

  it('keeps the working context and preferences when output selection fails', async () => {
    const engine = engineFor()
    await engine.resume()
    engine.seek(4)
    const original = ContextSpy.instances[0]
    const denied = new DOMException('Permission denied', 'NotAllowedError')
    ContextSpy.plans.push({ sinkError: denied })
    await expect(engine.configure({ ...DEFAULT_AUDIO_SETTINGS, outputDeviceId: 'missing' }, 96000)).rejects.toBe(denied)
    expect(original.state).toBe('running')
    expect(original.close).not.toHaveBeenCalled()
    expect(ContextSpy.instances[1].state).toBe('closed')
    expect(engine.getAudioState()).toMatchObject({ status: 'error', sampleRate: 48000, requestedSampleRate: 48000,
      settings: DEFAULT_AUDIO_SETTINGS, error: 'Permission denied' })
    expect(engine.getSnapshot()).toMatchObject({ beat: 4, ready: true })
    await engine.play()
    expect(engine.getSnapshot().playing).toBe(true)
    expect(ContextSpy.instances).toHaveLength(2)
  })

  it('rejects an unsupported explicit render hint or sample rate instead of silently accepting another', async () => {
    const engine = engineFor()
    ContextSpy.plans.push({ renderSize: null })
    await expect(engine.configure({ ...DEFAULT_AUDIO_SETTINGS, renderSizeHint: 256 }, 48000)).rejects.toThrow('렌더 블록')
    expect(ContextSpy.instances[0].state).toBe('closed')
    ContextSpy.plans.push({ actualRate: 48000 })
    await expect(engine.configure(DEFAULT_AUDIO_SETTINGS, 96000)).rejects.toThrow('96000 Hz 대신 48000 Hz')
    ContextSpy.plans.push({ renderSize: null, outputLatency: null, noSinkSelection: true })
    await engine.configure(DEFAULT_AUDIO_SETTINGS, 48000)
    expect(engine.getAudioState()).toMatchObject({ sampleRate: 48000, outputLatency: null, renderQuantumSize: null,
      supportsRenderSize: false, supportsOutputSelection: false })
  })

  it('closes a superseded candidate and prevents its late completion from overwriting the winner', async () => {
    const engine = engineFor()
    await engine.resume()
    const wait = deferred()
    ContextSpy.plans.push({ resume: wait.promise })
    const stale = engine.configure(DEFAULT_AUDIO_SETTINGS, 96000).catch(error => error)
    const losingContext = ContextSpy.instances[1]
    await engine.configure({ ...DEFAULT_AUDIO_SETTINGS, latencyHint: 'balanced' }, 44100)
    expect(losingContext.state).toBe('closed')
    wait.resolve()
    expect(await stale).toMatchObject({ name: 'AbortError' })
    expect(engine.getAudioState()).toMatchObject({ status: 'ready', sampleRate: 44100, requestedSampleRate: 44100,
      settings: { latencyHint: 'balanced' }, error: null })
    expect(ContextSpy.instances[2].state).toBe('running')
  })

  it('does not resurrect a candidate after disposal and permits a later explicit resume', async () => {
    const engine = engineFor()
    const wait = deferred()
    ContextSpy.plans.push({ resume: wait.promise })
    const pending = engine.configure(DEFAULT_AUDIO_SETTINGS, 96000).catch(error => error)
    engine.dispose()
    wait.resolve()
    expect(await pending).toMatchObject({ name: 'AbortError' })
    expect(engine.getAudioState()).toMatchObject({ status: 'idle', contextState: 'uninitialized', sampleRate: null })
    expect(engine.getSnapshot()).toMatchObject({ playing: false, ready: false })
    await engine.resume()
    expect(engine.getAudioState()).toMatchObject({ status: 'ready', sampleRate: 48000 })
  })

  it('cancels pending playback when settings Apply takes over and rejects Apply during playback', async () => {
    const engine = engineFor()
    const wait = deferred()
    ContextSpy.plans.push({ resume: wait.promise })
    const pendingPlay = engine.play().catch(error => error)
    await engine.configure({ ...DEFAULT_AUDIO_SETTINGS, latencyHint: 'balanced' }, 48000)
    wait.resolve()
    expect(await pendingPlay).toMatchObject({ name: 'AbortError' })
    expect(engine.getSnapshot().playing).toBe(false)
    await engine.play()
    await expect(engine.configure(DEFAULT_AUDIO_SETTINGS, 96000)).rejects.toThrow('재생을 멈춘')
    expect(engine.getSnapshot().playing).toBe(true)
    expect(engine.getAudioState().sampleRate).toBe(48000)
  })

  it('defers a project rate change until resume, then follows undo back to the earlier rate', async () => {
    const project = createEmptyProject()
    const engine = engineFor(project)
    await engine.play()
    engine.setProject({ ...project, sampleRate: 96000 })
    expect(engine.getSnapshot().playing).toBe(false)
    expect(engine.getAudioState()).toMatchObject({ requestedSampleRate: 96000, sampleRate: 48000, needsReconfiguration: true })
    expect(ContextSpy.instances).toHaveLength(1)
    await engine.resume()
    expect(engine.getAudioState()).toMatchObject({ sampleRate: 96000, needsReconfiguration: false })
    expect(ContextSpy.instances[0].state).toBe('closed')
    engine.setProject(project)
    await engine.resume()
    expect(engine.getAudioState()).toMatchObject({ requestedSampleRate: 48000, sampleRate: 48000, needsReconfiguration: false })
  })

  it('gates the candidate monitor until swap and applies software monitoring without reopening the context', async () => {
    const project = { ...createEmptyProject(), tracks: [{ ...createTrack('audio'), id: 'input', monitor: true }] }
    const engine = engineFor(project)
    const stream = { active: true } as MediaStream
    engine.setInputMonitor(stream, ['input'])
    await engine.resume()
    const original = ContextSpy.instances[0]
    const originalSource = original.monitors[0]
    expect(originalSource.connections.size).toBe(1)
    ContextSpy.plans.push({ onMonitor: candidate => {
      expect(candidate.gains[2].gain.value).toBe(0)
      expect(originalSource.connections.size).toBe(1)
      expect(original.state).toBe('running')
    } })
    await engine.configure({ ...DEFAULT_AUDIO_SETTINGS, latencyHint: 'balanced' }, 48000)
    const current = ContextSpy.instances[1]
    expect(originalSource.connections.size).toBe(0)
    expect(current.monitors[0].connections.size).toBe(1)
    expect(originalSource.disconnect.mock.invocationCallOrder[0]).toBeLessThan(current.gains[2].gain.setValueAtTime.mock.invocationCallOrder[0])
    await engine.configure({ ...DEFAULT_AUDIO_SETTINGS, latencyHint: 'balanced', softwareMonitoring: false }, 48000)
    expect(ContextSpy.instances).toHaveLength(2)
    expect(current.monitors[0].connections.size).toBe(0)
    await engine.configure({ ...DEFAULT_AUDIO_SETTINGS, latencyHint: 'balanced' }, 48000)
    expect(current.createMediaStreamSource).toHaveBeenCalledTimes(1)
    expect(current.monitors[0].connections.size).toBe(1)
  })

  it('exports the project rate independently of the live context and decodes files without opening output', async () => {
    const engine = engineFor()
    await engine.decodeAsset(new Blob(['audio']), 'test.wav', 'asset')
    expect(ContextSpy.instances).toHaveLength(0)
    await engine.resume()
    const wav = await engine.exportWav({ ...createEmptyProject(), lengthBeats: 1, sampleRate: 96000 })
    const header = new DataView(await wav.arrayBuffer())
    expect(header.getUint32(24, true)).toBe(96000)
    expect(header.getUint16(34, true)).toBe(16)
    expect(OfflineContextSpy.instances.at(-1)?.sampleRate).toBe(96000)
    expect(engine.getAudioState().sampleRate).toBe(48000)
  })
})


describe('worklet preparation and graph startup', () => {
  it('keeps monitor input detached until all built-in processors are ready', async () => {
    const prepared = deferred()
    vi.mocked(prepareEffects).mockReturnValueOnce(prepared.promise)
    const project = { ...createEmptyProject(), tracks: [{ ...createTrack('audio'), id: 'input' }] }
    const engine = engineFor(project)
    engine.setInputMonitor({ active: true } as MediaStream, ['input'])
    const startup = engine.resume()
    await Promise.resolve()
    const candidate = ContextSpy.instances[0]
    expect(prepareEffects).toHaveBeenCalledExactlyOnceWith(candidate)
    expect(candidate.monitors).toHaveLength(0)
    expect(candidate.gains).toHaveLength(0)
    expect(engine.getAudioState().status).toBe('configuring')
    prepared.resolve()
    await startup
    expect(candidate.monitors[0].connections.size).toBe(1)
    expect(engine.getAudioState().status).toBe('ready')
  })

  it('shows preparation failures and preserves the working output during failed reconfiguration', async () => {
    const engine = engineFor()
    await engine.resume()
    const active = ContextSpy.instances[0]
    vi.mocked(prepareEffects).mockRejectedValueOnce(new Error('앰프 프로세서 로딩 실패'))
    await expect(engine.configure({ ...DEFAULT_AUDIO_SETTINGS, latencyHint: 'balanced' }, 48000)).rejects.toThrow('앰프 프로세서 로딩 실패')
    expect(ContextSpy.instances[1].state).toBe('closed')
    expect(ContextSpy.instances[1].gains).toHaveLength(0)
    expect(active.state).toBe('running')
    expect(engine.getAudioState()).toMatchObject({ status: 'error', error: '앰프 프로세서 로딩 실패', settings: DEFAULT_AUDIO_SETTINGS })
  })

  it('does not publish a prepared context after disposal cancelled startup', async () => {
    const prepared = deferred()
    vi.mocked(prepareEffects).mockReturnValueOnce(prepared.promise)
    const engine = engineFor()
    const startup = engine.resume().catch(error => error)
    await Promise.resolve()
    engine.dispose()
    prepared.resolve()
    expect(await startup).toMatchObject({ name: 'AbortError' })
    expect(ContextSpy.instances[0].state).toBe('closed')
    expect(ContextSpy.instances[0].gains).toHaveLength(0)
    expect(engine.getSnapshot()).toMatchObject({ playing: false, ready: false })
  })

  it('prepares each offline context before graph construction and rendering', async () => {
    const engine = engineFor()
    await engine.resume()
    const prepared = deferred()
    vi.mocked(prepareEffects).mockReturnValueOnce(prepared.promise)
    const exporting = engine.exportWav({ ...createEmptyProject(), lengthBeats: 1 })
    const offline = OfflineContextSpy.instances.at(-1)!
    expect(prepareEffects).toHaveBeenLastCalledWith(offline)
    expect(offline.startRendering).not.toHaveBeenCalled()
    prepared.resolve()
    await exporting
    expect(offline.startRendering).toHaveBeenCalledTimes(1)
    expect(prepareEffects).toHaveBeenCalledTimes(2)
  })

  it('rejects export on processor loading failure without rendering a dry substitute', async () => {
    const engine = engineFor()
    vi.mocked(prepareEffects).mockRejectedValueOnce(new Error('오프라인 앰프 로딩 실패'))
    await expect(engine.exportWav({ ...createEmptyProject(), lengthBeats: 1 })).rejects.toThrow('오프라인 앰프 로딩 실패')
    expect(OfflineContextSpy.instances.at(-1)!.startRendering).not.toHaveBeenCalled()
    expect(ContextSpy.instances).toHaveLength(0)
  })
})


describe('guitar graph changes and recovery', () => {
  function stubRig() {
    const masterDispose = vi.fn()
    const rigDispose = vi.fn()
    const create = (context: BaseAudioContext, remember: RememberNode) => {
      const input = remember(context.createGain())
      return { input, output: input, update: vi.fn(), dispose: rigDispose }
    }
    const master = vi.spyOn(guitarRig, 'createGuitarRigMaster').mockImplementation((context, remember) => ({ ...create(context, remember), dispose: masterDispose }))
    const rig = vi.spyOn(EFFECT_MODULES['guitar-rig'], 'create').mockImplementation(create)
    return { create, master, rig, masterDispose, rigDispose }
  }
  const inputProject = () => ({ ...createEmptyProject(), tracks: [{ ...createTrack('audio'), id: 'input' }] })

  it('preserves guitar monitoring while audible native notes block browser playback and export', async () => {
    const { master, rig } = stubRig()
    const input = { ...createTrack('audio'), id: 'input', devices: [createDevice('guitar-rig')] }
    const native = createTrack('instrument', 'wavetable')
    native.clips = [{ id: 'native-clip', kind: 'midi', name: 'Native', startBeat: 0, lengthBeats: 4, gain: 1, notes: [{ id: 'native-note', pitch: 60, start: 0, duration: 1, velocity: 0.8 }] }]
    const project = { ...createEmptyProject(), tracks: [input, { ...native, mute: true }] }
    const engine = engineFor(project)
    engine.setInputMonitor({ active: true } as MediaStream, ['input'])
    await engine.play()
    vi.advanceTimersByTime(31)
    const source = ContextSpy.instances[0].monitors[0]
    expect(master).toHaveBeenCalled()
    expect(rig).toHaveBeenCalled()
    expect(source.connections.size).toBe(1)

    engine.setProject({ ...project, tracks: [input, native] })
    vi.advanceTimersByTime(31)
    expect(engine.getSnapshot()).toMatchObject({ playing: false, ready: true })
    expect(source.connections.size).toBe(1)
    await expect(engine.play()).rejects.toThrow(/네이티브/)
    await expect(engine.exportWav()).rejects.toThrow(/네이티브/)
    expect(OfflineContextSpy.instances).toHaveLength(0)
    expect(engine.getAudioState()).toMatchObject({ status: 'ready', error: null })

    engine.setProject(project)
    await engine.play()
    vi.advanceTimersByTime(31)
    expect(engine.getSnapshot()).toMatchObject({ playing: true, ready: true })
    expect(source.connections.size).toBe(1)
    expect(prepareEffects).toHaveBeenCalledTimes(1)
  })

  it('switches the master when a monitored guitar track is enabled or disabled while stopped', async () => {
    const { master, rig } = stubRig()
    const project = inputProject()
    const engine = engineFor(project)
    engine.setInputMonitor({ active: true } as MediaStream, ['input'])
    await engine.resume()
    const context = ContextSpy.instances[0]
    const source = context.monitors[0]
    const withRig = { ...project, tracks: [{ ...project.tracks[0], devices: [createDevice('guitar-rig')] }] }
    engine.setProject(withRig)
    expect(master).toHaveBeenCalledTimes(1)
    expect(rig).toHaveBeenCalledTimes(1)
    engine.setProject({ ...withRig, tracks: [{ ...withRig.tracks[0], enabled: false }] })
    expect(master).toHaveBeenCalledTimes(1)
    expect(rig).toHaveBeenCalledTimes(2)
    engine.setProject(withRig)
    expect(master).toHaveBeenCalledTimes(2)
    expect(rig).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(31)
    expect(source.connections.size).toBe(1)
    expect(context.createMediaStreamSource).toHaveBeenCalledTimes(1)
    expect(prepareEffects).toHaveBeenCalledTimes(1)
    expect(ContextSpy.instances).toHaveLength(1)
    expect(engine.getSnapshot()).toMatchObject({ playing: false, ready: true })
  })

  it('crossfades monitored graphs with complementary gains before retiring the old route', async () => {
    stubRig()
    const project = inputProject()
    const engine = engineFor(project)
    engine.setInputMonitor({ active: true } as MediaStream, ['input'])
    await engine.resume()
    const context = ContextSpy.instances[0]
    const source = context.monitors[0]
    const oldGate = context.gains[2]
    const oldStart = oldGate.gain.value
    const previousGains = context.gains.length
    context.currentTime = 0.125
    engine.setProject({ ...project, tracks: [{ ...project.tracks[0], devices: [createDevice('guitar-rig')] }] })
    const incomingGate = context.gains.slice(previousGains).find(node =>
      node.gain.setValueAtTime.mock.calls.some(([value, time]) => value === 0 && time === context.currentTime),
    )!
    expect(incomingGate).toBeDefined()
    expect(source.connections.size).toBe(2)
    expect(oldGate.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, context.currentTime, 0.003)
    expect(incomingGate.gain.setValueAtTime).toHaveBeenLastCalledWith(0, context.currentTime)
    expect(incomingGate.gain.setTargetAtTime).toHaveBeenLastCalledWith(1, context.currentTime, 0.003)
    expect(incomingGate.gain.setTargetAtTime.mock.invocationCallOrder.at(-1)!)
      .toBeLessThan(source.connect.mock.invocationCallOrder.at(-1)!)
    // Evaluate the Web Audio target envelopes from the scheduled values, including
    // the first instant that previously duplicated the live input at full gain.
    const [outTarget, outTime, outConstant] = oldGate.gain.setTargetAtTime.mock.calls.at(-1)!
    const [inTarget, inTime, inConstant] = incomingGate.gain.setTargetAtTime.mock.calls.at(-1)!
    const [inStart] = incomingGate.gain.setValueAtTime.mock.calls.at(-1)!
    for (const elapsed of [0, 0.001, 0.003, 0.01, 0.029]) {
      const time = context.currentTime + elapsed
      const outgoing = outTarget + (oldStart - outTarget) * Math.exp(-(time - outTime) / outConstant)
      const incoming = inTarget + (inStart - inTarget) * Math.exp(-(time - inTime) / inConstant)
      expect(outgoing + incoming).toBeCloseTo(1, 12)
    }
    vi.advanceTimersByTime(31)
    expect(source.connections.size).toBe(1)
    expect(oldGate.disconnect).toHaveBeenCalledTimes(1)
    expect(incomingGate.disconnect).not.toHaveBeenCalled()
  })

  it('mutes a failed rebuild and recovers with unchanged settings after a failed retry', async () => {
    const { rig, create, masterDispose } = stubRig()
    const project = inputProject()
    const engine = engineFor(project)
    const stream = { active: true } as MediaStream
    engine.setInputMonitor(stream, ['input'])
    await engine.play()
    vi.advanceTimersByTime(31)
    const original = ContextSpy.instances[0]
    const source = original.monitors[0]
    let fail = true
    rig.mockImplementation((context, remember) => {
      if (fail) throw new Error('amp allocation failed')
      return create(context, remember)
    })
    const withRig = { ...project, tracks: [{ ...project.tracks[0], devices: [createDevice('guitar-rig')] }] }
    expect(() => engine.setProject(withRig)).not.toThrow()
    expect(source.connections.size).toBe(0)
    expect(masterDispose).toHaveBeenCalledTimes(1)
    expect(engine.getSnapshot()).toMatchObject({ playing: false, ready: false })
    expect(engine.getAudioState()).toMatchObject({ status: 'error', needsReconfiguration: true })
    expect(engine.getAudioState().error).toContain('amp allocation failed')
    expect(() => { engine.pause(); engine.stop(); engine.setInputMonitor(stream, ['input']) }).not.toThrow()
    expect(rig).toHaveBeenCalledTimes(1)
    await expect(engine.play()).rejects.toThrow('amp allocation failed')
    await expect(engine.configure(DEFAULT_AUDIO_SETTINGS, 48000)).rejects.toThrow('amp allocation failed')
    expect(ContextSpy.instances[1].state).toBe('closed')
    expect(original.state).toBe('running')
    expect(engine.getAudioState().needsReconfiguration).toBe(true)
    fail = false
    await engine.configure(DEFAULT_AUDIO_SETTINGS, 48000)
    const recovered = ContextSpy.instances[2]
    expect(original.state).toBe('closed')
    expect(recovered.monitors[0].connections.size).toBe(1)
    expect(engine.getAudioState()).toMatchObject({ status: 'ready', error: null, needsReconfiguration: false })
    await engine.play()
    expect(engine.getSnapshot()).toMatchObject({ playing: true, ready: true })
  })

  it('reports a processor creation failure during Play and leaves Stop usable', async () => {
    const { rig } = stubRig()
    const project = inputProject()
    project.tracks[0].devices = [createDevice('guitar-rig')]
    const engine = engineFor(project)
    await engine.resume()
    rig.mockImplementationOnce(() => { throw new Error('processor unavailable') })
    await expect(engine.play()).rejects.toThrow('processor unavailable')
    expect(engine.getSnapshot()).toMatchObject({ playing: false, ready: false })
    expect(() => engine.stop()).not.toThrow()
  })

  it('reports a processor error as an audio processing failure and blocks live monitoring', async () => {
    const engine = engineFor(inputProject())
    engine.setInputMonitor({ active: true } as MediaStream, ['input'])
    await engine.play()
    const context = ContextSpy.instances[0]
    vi.spyOn(guitarRig, 'assertGuitarRigHealthy').mockImplementation(candidate => {
      if (candidate === (context as unknown as BaseAudioContext)) throw new Error('기타 앰프 오디오 처리 중 오류')
    })
    context.dispatchEvent(new Event('error'))
    expect(engine.getAudioState().error).toBe('기타 앰프 오디오 처리 중 오류')
    expect(context.monitors[0].connections.size).toBe(0)
    expect(engine.getSnapshot()).toMatchObject({ playing: false, ready: false })
    await engine.configure(DEFAULT_AUDIO_SETTINGS, 48000)
    expect(engine.getAudioState()).toMatchObject({ status: 'ready', error: null })
  })

  it('rejects a completed offline render with a processor error and still disposes every processor', async () => {
    const { masterDispose, rigDispose } = stubRig()
    const project = inputProject()
    project.tracks[0].devices = [createDevice('guitar-rig')]
    const engine = engineFor(project)
    vi.spyOn(guitarRig, 'assertGuitarRigHealthy').mockImplementation(() => { throw new Error('offline processor failed') })
    await expect(engine.exportWav(project)).rejects.toThrow('offline processor failed')
    expect(OfflineContextSpy.instances.at(-1)!.startRendering).toHaveBeenCalledTimes(1)
    expect(masterDispose).toHaveBeenCalledTimes(1)
    expect(rigDispose).toHaveBeenCalledTimes(1)
    expect(ContextSpy.instances).toHaveLength(0)
  })
})

describe('browser track inputs', () => {
  it('numbers input choices from the requested count, then from the live stream, and records one take at a time', () => {
    const engine = new WebAudioEngine(undefined, { ...DEFAULT_AUDIO_SETTINGS, inputChannels: 2 })
    expect(engine.maxSimultaneousRecordings).toBe(1)
    expect(engine.getInputChoices().map(choice => choice.channels)).toEqual([[0], [1], [0, 1]])
    const listener = vi.fn()
    engine.subscribeAudioState(listener)
    engine.observeInputStream({ getAudioTracks: () => [{ getSettings: () => ({ channelCount: 1 }) }] } as unknown as MediaStream)
    expect(engine.getInputChoices()).toEqual([{ channels: [0], label: '입력 1' }])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(new WebAudioEngine().getInputChoices()).toEqual([])
    engine.dispose()
  })
})

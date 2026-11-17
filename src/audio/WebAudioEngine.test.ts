import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AUDIO_SETTINGS } from '../core/audioSettings'
import { createDevice, createEmptyProject, createTrack } from '../core/project'
import type { Project } from '../core/types'
import { ENGINE_LOAD_FAILED, resetEngineModuleForTests, WebAudioEngine } from './WebAudioEngine'
import { deviceAnalysisTap } from '../devices/effects/analysis'
import { guitarTunerTap } from '../devices/guitar-rig'
import { renderInEngineWorker, RustEngineNode, sharedGarakEngineModule } from './rust/engineHost'
import { emptyStatus } from './rust/engineChannel'
import { GarakEngineError } from './rust/garakEngineWasm'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Web Audio API spies exercise the engine host's device and transport wiring. The engine itself (garak-engine.wasm)
// is replaced by FakeEngineNode below; its rendering is covered by src/audio/rust/*.test.ts and the browser smoke.
class NodeSpy {
  connections = new Set<unknown>()
  connect = vi.fn((target: unknown) => { this.connections.add(target); return target as NodeSpy })
  disconnect = vi.fn((target?: unknown) => { if (target) this.connections.delete(target); else this.connections.clear() })
}

/** The engine worklet bridge: transport and status as the worklet would apply them on the next quantum. */
class FakeEngineNode {
  static instances: FakeEngineNode[] = []
  static plan: { create?: Promise<void>; refuse?: string } = {}
  readonly node = new NodeSpy()
  readonly sharedChannel = false
  error: string | null = null
  private seq = 0
  private readonly state = emptyStatus()
  constructor(readonly context: ContextSpy) {
    this.node.connect(context.destination)
    FakeEngineNode.instances.push(this)
  }
  static create = vi.fn(async (context: ContextSpy) => {
    if (FakeEngineNode.plan.create) await FakeEngineNode.plan.create
    return new FakeEngineNode(context)
  })
  putAsset = vi.fn(async () => undefined)
  registerSamples = vi.fn(async () => undefined)
  removeAsset = vi.fn(async () => undefined)
  update = vi.fn(async () => {
    if (FakeEngineNode.plan.refuse) throw new GarakEngineError(FakeEngineNode.plan.refuse)
    return { applied: 'full', latencyFrames: 0, tailSeconds: 0 }
  })
  importKernels = vi.fn(async () => undefined)
  metronome = vi.fn(async () => undefined)
  monitor = vi.fn(async () => undefined)
  taps = vi.fn(async () => undefined)
  live = vi.fn(() => ++this.seq)
  readMeters = vi.fn(() => null)
  analysis = vi.fn(async (_taps: { track: number; insert: number; tuner: boolean }[]) => undefined)
  analysisVersion = 0
  readAnalysis = vi.fn((_slot: number, out: Float32Array) => { out.fill(0.25); return true })
  transport = vi.fn((command: string, frame = 0) => {
    const seq = ++this.seq
    if (command === 'play' || command === 'countIn') this.state.playing = true
    if (command === 'pause' || command === 'stop') this.state.playing = false
    if (command === 'seek') this.state.frame = frame
    this.state.appliedSeq = seq
    return seq
  })
  readStatus = vi.fn(() => ({ ...this.state }))
  dispose = vi.fn(() => { this.node.disconnect() })
}

vi.mock('./rust/engineHost', () => ({
  ENGINE_WORKLET_UNSUPPORTED: 'AudioWorklet 없음',
  sharedGarakEngineModule: vi.fn(async () => ({ fake: 'module' })),
  RustEngineNode: { create: vi.fn((context: ContextSpy) => FakeEngineNode.create(context)) },
  KernelHelper: class { compute = async () => []; dispose = () => undefined },
  renderInEngineWorker: vi.fn(async (_module: unknown, request: { sampleRate: number }) => ({
    left: new Float32Array(8), right: new Float32Array(8), frames: 8, sampleRate: request.sampleRate, latencyFrames: 0, tailSeconds: 0.85, renderMs: 1,
  })),
}))

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
  monitors: (NodeSpy & { mediaStream: MediaStream; context: ContextSpy })[] = []

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
  createMediaStreamSource = vi.fn((stream: MediaStream) => {
    this.plan.onMonitor?.(this)
    const node = Object.assign(new NodeSpy(), { mediaStream: stream, context: this })
    this.monitors.push(node)
    return node
  })
}

class OfflineContextSpy {
  static instances: OfflineContextSpy[] = []
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    OfflineContextSpy.instances.push(this)
  }
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
const bridgeOf = (context: ContextSpy) => FakeEngineNode.instances.find(item => item.context === context)!

beforeEach(() => {
  vi.clearAllMocks()
  resetEngineModuleForTests()
  vi.useFakeTimers()
  ContextSpy.instances = []
  ContextSpy.plans = []
  OfflineContextSpy.instances = []
  FakeEngineNode.instances = []
  FakeEngineNode.plan = {}
  mediaDevices = new MediaDevicesSpy()
  vi.stubGlobal('navigator', { mediaDevices })
  vi.stubGlobal('AudioContext', ContextSpy)
  vi.stubGlobal('OfflineAudioContext', OfflineContextSpy)
  vi.stubGlobal('AudioWorkletNode', class {})
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
    ready.resolve()
    await expect(audition).resolves.toBeUndefined()
    expect(FakeEngineNode.instances[0].live).not.toHaveBeenCalled()
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
    const bridge = bridgeOf(context)
    expect(source.connections).toEqual(new Set([bridge.node]))
    mediaDevices.enumerateDevices.mockResolvedValue(outputDevices('default'))
    mediaDevices.dispatchEvent(new Event('devicechange'))
    await Promise.resolve()
    expect(engine.getSnapshot()).toMatchObject({ playing: false, ready: false })
    expect(source.connections.size).toBe(0)
    expect(bridge.transport).toHaveBeenLastCalledWith('pause')
    expect(bridge.monitor).toHaveBeenLastCalledWith([])
    expect(bridge.node.disconnect).toHaveBeenCalledWith(context.destination)
    expect(engine.getAudioState()).toMatchObject({ status: 'error', needsReconfiguration: true, settings: { outputDeviceId: 'usb' } })
    expect(engine.getAudioState().error).toContain('연결·스피커 권한')
    engine.pause()
    engine.setInputMonitor(stream, ['input'])
    expect(context.createMediaStreamSource).toHaveBeenCalledTimes(1)
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

  it('moves monitoring to the new engine on swap and applies software monitoring without reopening the context', async () => {
    const project = { ...createEmptyProject(), tracks: [{ ...createTrack('audio'), id: 'input', monitor: true }] }
    const engine = engineFor(project)
    const stream = { active: true } as MediaStream
    engine.setInputMonitor(stream, ['input'])
    await engine.resume()
    await vi.advanceTimersByTimeAsync(20)
    const original = ContextSpy.instances[0]
    const originalSource = original.monitors[0]
    expect(originalSource.connections).toEqual(new Set([bridgeOf(original).node]))
    await engine.configure({ ...DEFAULT_AUDIO_SETTINGS, latencyHint: 'balanced' }, 48000)
    expect(originalSource.connections.size).toBe(0)
    expect(bridgeOf(original).dispose).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(20)
    const current = ContextSpy.instances[1]
    expect(current.monitors[0].connections).toEqual(new Set([bridgeOf(current).node]))
    await engine.configure({ ...DEFAULT_AUDIO_SETTINGS, latencyHint: 'balanced', softwareMonitoring: false }, 48000)
    expect(ContextSpy.instances).toHaveLength(2)
    expect(current.monitors[0].connections.size).toBe(0)
    expect(bridgeOf(current).monitor).toHaveBeenLastCalledWith([])
    await engine.configure({ ...DEFAULT_AUDIO_SETTINGS, latencyHint: 'balanced' }, 48000)
    expect(current.createMediaStreamSource).toHaveBeenCalledTimes(2)
    expect(current.monitors[1].connections.size).toBe(1)
    expect(bridgeOf(current).monitor).toHaveBeenLastCalledWith([0])
  })

  it('exports the project rate independently of the live context and decodes files without opening output', async () => {
    const engine = engineFor()
    await engine.decodeAsset(new Blob(['audio']), 'test.wav', 'asset')
    expect(ContextSpy.instances).toHaveLength(0)
    await engine.resume()
    const wav = await engine.exportWav({ ...createEmptyProject(), lengthBeats: 32, sampleRate: 96000 })
    const header = new DataView(await wav.arrayBuffer())
    expect(header.getUint32(24, true)).toBe(96000)
    expect(header.getUint16(34, true)).toBe(16)
    expect(renderInEngineWorker).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ sampleRate: 96000 }))
    expect(engine.getAudioState().sampleRate).toBe(48000)
  })
})

describe('engine startup', () => {
  it('keeps monitor input detached until the engine worklet is ready', async () => {
    const created = deferred()
    FakeEngineNode.plan.create = created.promise
    const project = { ...createEmptyProject(), tracks: [{ ...createTrack('audio'), id: 'input' }] }
    const engine = engineFor(project)
    engine.setInputMonitor({ active: true } as MediaStream, ['input'])
    const startup = engine.resume()
    await vi.advanceTimersByTimeAsync(0)
    const candidate = ContextSpy.instances[0]
    expect(candidate.monitors).toHaveLength(0)
    expect(engine.getAudioState().status).toBe('configuring')
    created.resolve()
    await startup
    await vi.advanceTimersByTimeAsync(20)
    expect(candidate.monitors[0].connections).toEqual(new Set([bridgeOf(candidate).node]))
    expect(bridgeOf(candidate).monitor).toHaveBeenLastCalledWith([0])
    expect(engine.getAudioState().status).toBe('ready')
  })

  it('reports a module that cannot load in Korean, closes the candidate and opens nothing for export', async () => {
    vi.mocked(sharedGarakEngineModule).mockResolvedValue(null)
    const engine = engineFor()
    await expect(engine.play()).rejects.toThrow(ENGINE_LOAD_FAILED)
    expect(ContextSpy.instances[0].state).toBe('closed')
    expect(engine.getAudioState()).toMatchObject({ status: 'error', error: ENGINE_LOAD_FAILED })
    await expect(engine.exportWav({ ...createEmptyProject(), lengthBeats: 32 })).rejects.toThrow(ENGINE_LOAD_FAILED)
    expect(renderInEngineWorker).not.toHaveBeenCalled()
    // A later load succeeds: the next Play starts on a fresh context.
    vi.mocked(sharedGarakEngineModule).mockResolvedValue({ fake: 'module' } as unknown as WebAssembly.Module)
    await engine.play()
    expect(engine.getSnapshot()).toMatchObject({ playing: true, ready: true })
  })

  it('shows a worklet start failure and preserves the working output during a failed reconfiguration', async () => {
    const engine = engineFor()
    await engine.resume()
    const active = ContextSpy.instances[0]
    vi.mocked(RustEngineNode.create).mockRejectedValueOnce(new Error('addModule failed'))
    await expect(engine.configure({ ...DEFAULT_AUDIO_SETTINGS, latencyHint: 'balanced' }, 48000)).rejects.toThrow('오디오 엔진을 시작하지 못했습니다')
    expect(ContextSpy.instances[1].state).toBe('closed')
    expect(active.state).toBe('running')
    expect(engine.getAudioState().error).toContain('addModule failed')
    expect(engine.getAudioState().settings).toEqual(DEFAULT_AUDIO_SETTINGS)
  })

  it('does not publish a prepared context after disposal cancelled startup', async () => {
    const created = deferred()
    FakeEngineNode.plan.create = created.promise
    const engine = engineFor()
    const startup = engine.resume().catch(error => error)
    await vi.advanceTimersByTimeAsync(0)
    engine.dispose()
    created.resolve()
    expect(await startup).toMatchObject({ name: 'AbortError' })
    expect(ContextSpy.instances[0].state).toBe('closed')
    expect(FakeEngineNode.instances[0].dispose).toHaveBeenCalled()
    expect(engine.getSnapshot()).toMatchObject({ playing: false, ready: false })
  })
})

describe('the engine is the only renderer', () => {
  it('refuses to play a project the engine rejects, with its reason, instead of switching renderers', async () => {
    FakeEngineNode.plan.refuse = 'unsupported insert'
    const engine = engineFor()
    await expect(engine.play()).rejects.toThrow('오디오 엔진이 이 프로젝트를 재생할 수 없습니다: unsupported insert')
    expect(engine.getSnapshot().playing).toBe(false)
    expect(engine.diagnostics()).toMatchObject({ accepted: false, reason: 'unsupported insert' })
    FakeEngineNode.plan.refuse = undefined
    engine.setProject({ ...createEmptyProject(), bpm: 100 })
    await engine.play()
    expect(engine.getSnapshot().playing).toBe(true)
  })

  it('stops the transport where it was heard when an edit is refused while playing', async () => {
    const project = createEmptyProject()
    const engine = engineFor(project)
    await engine.play()
    FakeEngineNode.plan.refuse = 'too many tracks'
    engine.setProject({ ...project, bpm: 120 })
    await vi.advanceTimersByTimeAsync(20)
    expect(engine.getSnapshot().playing).toBe(false)
    expect(FakeEngineNode.instances[0].transport).toHaveBeenLastCalledWith('pause')
  })

  it('auditions a track through its engine track and a library instrument on a preview engine', async () => {
    const keys = { ...createTrack('instrument', 'keys'), id: 'keys' }
    const engine = engineFor({ ...createEmptyProject(), tracks: [keys] })
    await engine.previewNote('keys', 60, 0.8, 'keys')
    const main = FakeEngineNode.instances[0]
    expect(main.live).toHaveBeenCalledWith(0, 'noteOn', 60, expect.closeTo(0.8, 2), expect.any(Number))
    vi.advanceTimersByTime(400)
    expect(main.live).toHaveBeenLastCalledWith(0, 'noteOff', 60, 0, expect.any(Number))
    await engine.previewNote('bass', 48)
    const preview = FakeEngineNode.instances[1]
    expect(preview).toBeDefined()
    expect(preview.update).toHaveBeenCalledWith('project.set', expect.objectContaining({ tracks: [expect.objectContaining({ id: 'preview' })] }), null)
    expect(preview.live).toHaveBeenCalledWith(0, 'noteOn', 48, expect.closeTo(0.8, 2), expect.any(Number))
    // The project's engine never hears a library preview.
    expect(main.live).toHaveBeenCalledTimes(2)
  })

  it('renders exports, stems and freezes on the engine worker, pre-master when asked', async () => {
    const engine = engineFor()
    const project = { ...createEmptyProject(), lengthBeats: 32, tracks: [{ ...createTrack('audio'), id: 'a', devices: [createDevice('delay', { amount: 1, time: 1, feedback: 0.5 })] }] }
    const rendered = await engine.renderAudio(project, { bitDepth: 32, preMaster: true, tailSeconds: 3 })
    expect(renderInEngineWorker).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ masterBypass: true, tailSeconds: 3, sampleRate: 48000 }))
    expect(rendered).toMatchObject({ frames: 8, sampleRate: 48000, tailSeconds: 0.85 })
    expect(rendered.trackTailSeconds).toBeGreaterThan(1)
    expect(await engine.renderTail(project)).toBeGreaterThan(1)
    expect(ContextSpy.instances).toHaveLength(0)
  })
})

describe('engine analysis taps', () => {
  it('stream what the open editors look up, and stop when they close', async () => {
    const eq = { ...createDevice('eq'), id: 'eq' }, rig = { ...createDevice('guitar-rig', { tunerEnabled: 1 }), id: 'rig' }
    const project = { ...createEmptyProject(), tracks: [{ ...createTrack('audio'), id: 'a', devices: [eq] }, { ...createTrack('audio'), id: 'g', devices: [createDevice('filter'), rig] }] }
    const engine = engineFor(project)
    await engine.resume()
    await vi.advanceTimersByTimeAsync(20)
    const bridge = FakeEngineNode.instances[0]
    await vi.advanceTimersByTimeAsync(400)
    expect(bridge.analysis).not.toHaveBeenCalled()
    // The editors look their taps up (the spectrum every 800 ms, the tuner every frame).
    expect(deviceAnalysisTap('eq')).toBeUndefined()
    expect(guitarTunerTap('rig')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(250)
    expect(bridge.analysis).toHaveBeenLastCalledWith([{ track: 0, insert: 0, tuner: false }, { track: 1, insert: 1, tuner: true }])
    const spectrum = deviceAnalysisTap('eq')!, tuner = guitarTunerTap('rig')!
    expect(spectrum.analyser.fftSize).toBe(4096)
    expect(tuner.analyser.fftSize).toBe(4096)
    expect(tuner.sampleRate).toBe(48000)
    const samples = new Float32Array(16)
    tuner.analyser.getFloatTimeDomainData(samples)
    expect(samples.every(v => v === 0.25)).toBe(true)
    expect(bridge.readAnalysis).toHaveBeenCalledWith(1, expect.any(Float32Array))
    // Nobody looks any more: the taps go, and the engine stops copying them.
    await vi.advanceTimersByTimeAsync(2000)
    expect(bridge.analysis).toHaveBeenLastCalledWith([])
    expect(deviceAnalysisTap('eq')).toBeUndefined()
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

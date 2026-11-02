import { describe, expect, it, vi } from 'vitest'
import { AudioDeviceProbe } from './AudioDeviceProbe'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function microphone(label = 'USB input') {
  class Track extends EventTarget {
    label = label
    readyState: MediaStreamTrackState = 'live'
    stop = vi.fn(() => { this.readyState = 'ended' })
    getSettings = () => ({ deviceId: label, sampleRate: 48000, channelCount: 2, echoCancellation: false })
    end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')) }
  }
  const track = new Track()
  const stream = {
    get active() { return track.readyState === 'live' },
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream
  return { stream, track }
}

function harness() {
  const open = vi.fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>()
  const contexts: ReturnType<typeof context>[] = []
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  let amplitude = .25
  function context() {
    const source = { connect: vi.fn(), disconnect: vi.fn() }
    const analyser = {
      fftSize: 1024,
      disconnect: vi.fn(),
      connect: vi.fn(),
      getFloatTimeDomainData: vi.fn((values: Float32Array) => values.fill(amplitude)),
    }
    const ctx = {
      state: 'running' as AudioContextState,
      resume: vi.fn(async () => {}),
      close: vi.fn(async () => { ctx.state = 'closed' }),
      createMediaStreamSource: vi.fn(() => source),
      createAnalyser: vi.fn(() => analyser),
      source,
      analyser,
    }
    return ctx
  }
  const createContext = vi.fn(() => {
    const ctx = context()
    contexts.push(ctx)
    return ctx as unknown as AudioContext
  })
  const deps = {
    open,
    createContext,
    requestFrame: (callback: FrameRequestCallback) => { const id = ++frameId; frames.set(id, callback); return id },
    cancelFrame: (id: number) => { frames.delete(id) },
  }
  const probe = new AudioDeviceProbe(deps)
  return {
    probe, open, contexts, frames, createContext,
    setAmplitude(value: number) { amplitude = value },
    tick(time: number) { for (const [id, callback] of [...frames]) { frames.delete(id); callback(time) } },
  }
}

const constraints: MediaStreamConstraints = { audio: { deviceId: { exact: 'usb' }, echoCancellation: false } }

describe('temporary audio-device input lifecycle', () => {
  it('does not request permission when constructed or configured', () => {
    const h = harness()
    h.probe.configure(constraints)
    expect(h.open).not.toHaveBeenCalled()
    expect(h.createContext).not.toHaveBeenCalled()
    expect(h.probe.getSnapshot().status).toBe('idle')
  })

  it('keeps a permission-only stream live during enumeration and then releases it', async () => {
    const h = harness(), mic = microphone()
    h.open.mockResolvedValue(mic.stream)
    const enumeration = deferred<void>()
    const enumerate = vi.fn(async () => {
      expect(mic.stream.active).toBe(true)
      await enumeration.promise
    })
    const task = h.probe.requestAccess(constraints, enumerate)
    await vi.waitFor(() => expect(enumerate).toHaveBeenCalledOnce())
    expect(mic.track.stop).not.toHaveBeenCalled()
    expect(h.createContext).not.toHaveBeenCalled()
    enumeration.resolve()
    await task
    expect(mic.track.stop).toHaveBeenCalledOnce()
  })

  it('shares an active meter with discovery and measures without a speaker connection', async () => {
    const h = harness(), mic = microphone()
    h.open.mockResolvedValue(mic.stream)
    await h.probe.start(constraints)
    await h.probe.requestAccess(constraints, async () => {})
    expect(h.open).toHaveBeenCalledOnce()
    expect(mic.track.stop).not.toHaveBeenCalled()
    expect(h.probe.getSnapshot()).toMatchObject({ status: 'active', label: 'USB input', settings: { sampleRate: 48000, channelCount: 2 } })
    expect(h.contexts[0].source.connect).toHaveBeenCalledWith(h.contexts[0].analyser)
    expect(h.contexts[0].analyser.connect).not.toHaveBeenCalled()
    h.tick(0)
    expect(h.probe.getSnapshot().level).toBeCloseTo(.25)
    h.setAmplitude(2)
    h.tick(60)
    expect(h.probe.getSnapshot().level).toBe(1)
    h.probe.stop()
    expect(mic.track.stop).toHaveBeenCalledOnce()
    expect(h.contexts[0].close).toHaveBeenCalledOnce()
    expect(h.frames.size).toBe(0)
    expect(h.probe.getSnapshot()).toMatchObject({ status: 'idle', level: 0, settings: null })
  })

  it('stops a microphone granted after the user cancels the input test', async () => {
    const h = harness(), mic = microphone(), permission = deferred<MediaStream>()
    h.open.mockReturnValue(permission.promise)
    const task = h.probe.start(constraints)
    h.probe.stop()
    expect(h.contexts[0].close).toHaveBeenCalledOnce()
    permission.resolve(mic.stream)
    await task
    expect(mic.track.stop).toHaveBeenCalledOnce()
    expect(h.contexts[0].createMediaStreamSource).not.toHaveBeenCalled()
    expect(h.probe.getSnapshot().status).toBe('idle')
  })

  it('shares pending access, and canceling the meter does not stop a discovery lease', async () => {
    const h = harness(), mic = microphone(), permission = deferred<MediaStream>(), enumeration = deferred<void>()
    h.open.mockReturnValue(permission.promise)
    const access = h.probe.requestAccess(constraints, async () => { await enumeration.promise })
    const test = h.probe.start(constraints)
    h.probe.stop()
    permission.resolve(mic.stream)
    await test
    expect(h.open).toHaveBeenCalledOnce()
    expect(mic.track.stop).not.toHaveBeenCalled()
    expect(h.probe.getSnapshot().status).toBe('idle')
    enumeration.resolve()
    await access
    expect(mic.track.stop).toHaveBeenCalledOnce()
  })

  it('does not let a late old device replace the newest test after input settings change', async () => {
    const h = harness(), oldMic = microphone('old'), newMic = microphone('new')
    const oldPermission = deferred<MediaStream>(), newPermission = deferred<MediaStream>()
    h.open.mockReturnValueOnce(oldPermission.promise).mockReturnValueOnce(newPermission.promise)
    const oldTest = h.probe.start(constraints)
    const newTest = h.probe.start({ audio: { deviceId: { exact: 'new' } } })
    newPermission.resolve(newMic.stream)
    await newTest
    oldPermission.resolve(oldMic.stream)
    await oldTest
    expect(oldMic.track.stop).toHaveBeenCalledOnce()
    expect(newMic.track.stop).not.toHaveBeenCalled()
    expect(h.probe.getSnapshot()).toMatchObject({ status: 'active', label: 'new' })
    h.probe.dispose()
  })

  it('invalidates pending permission discovery when the dialog is disposed', async () => {
    const h = harness(), mic = microphone(), permission = deferred<MediaStream>()
    h.open.mockReturnValue(permission.promise)
    const enumerate = vi.fn(async () => {})
    const access = h.probe.requestAccess(constraints, enumerate)
    h.probe.dispose()
    permission.resolve(mic.stream)
    await access
    expect(enumerate).not.toHaveBeenCalled()
    expect(mic.track.stop).toHaveBeenCalledOnce()
  })

  it('cleans up when a device ends and allows a new explicit test afterwards', async () => {
    const h = harness(), mic = microphone(), retryMic = microphone('reconnected')
    h.open.mockResolvedValueOnce(mic.stream).mockResolvedValueOnce(retryMic.stream)
    await h.probe.start(constraints)
    mic.track.end()
    expect(h.probe.getSnapshot()).toMatchObject({ status: 'error', level: 0 })
    expect(h.probe.getSnapshot().error).toContain('연결이 끊어졌습니다')
    expect(h.frames.size).toBe(0)
    expect(h.contexts[0].close).toHaveBeenCalledOnce()
    await h.probe.start(constraints)
    expect(h.probe.getSnapshot()).toMatchObject({ status: 'active', label: 'reconnected' })
    h.probe.dispose()
  })

  it('releases failed test demand and retries after permission denial', async () => {
    const h = harness(), mic = microphone()
    h.open.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError')).mockResolvedValueOnce(mic.stream)
    await h.probe.start(constraints)
    expect(h.probe.getSnapshot()).toMatchObject({ status: 'error', level: 0 })
    expect(h.contexts[0].close).toHaveBeenCalledOnce()
    await h.probe.start(constraints)
    expect(h.probe.getSnapshot().status).toBe('active')
    h.probe.dispose()
  })

  it('still releases a late microphone if audio-context resume fails first', async () => {
    const h = harness(), mic = microphone(), permission = deferred<MediaStream>()
    h.open.mockReturnValue(permission.promise)
    const original = h.createContext.getMockImplementation()!
    h.createContext.mockImplementation(() => {
      const context = original()
      h.contexts.at(-1)!.resume.mockRejectedValue(new DOMException('blocked', 'NotAllowedError'))
      return context
    })
    await h.probe.start(constraints)
    expect(h.probe.getSnapshot().status).toBe('error')
    permission.resolve(mic.stream)
    await vi.waitFor(() => expect(mic.track.stop).toHaveBeenCalledOnce())
    expect(h.frames.size).toBe(0)
  })

  it('remains reusable after effect cleanup, without reviving an earlier request', async () => {
    const h = harness(), oldMic = microphone('old'), newMic = microphone('new'), oldPermission = deferred<MediaStream>()
    h.open.mockReturnValueOnce(oldPermission.promise).mockResolvedValueOnce(newMic.stream)
    const stale = h.probe.start(constraints)
    h.probe.dispose()
    await h.probe.start(constraints)
    oldPermission.resolve(oldMic.stream)
    await stale
    expect(h.probe.getSnapshot()).toMatchObject({ status: 'active', label: 'new' })
    expect(oldMic.track.stop).toHaveBeenCalledOnce()
    expect(newMic.track.stop).not.toHaveBeenCalled()
    h.probe.dispose()
  })
})

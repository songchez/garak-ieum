import { describe, expect, it, vi } from 'vitest'
import { playOutputTest } from './OutputTest'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness() {
  const events = new EventTarget()
  const oscillators: ReturnType<typeof makeOscillator>[] = []
  const gains: ReturnType<typeof makeGain>[] = []
  function makeOscillator() {
    const node = {
      type: 'sine', frequency: { value: 0 }, onended: null as (() => void) | null,
      connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(),
      end: () => node.onended?.(),
    }
    return node
  }
  function makeGain() {
    return { gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() }
  }
  const context = {
    state: 'running' as AudioContextState, currentTime: 12, destination: {}, sinkId: 'usb-output',
    resume: vi.fn(), suspend: vi.fn(), close: vi.fn(),
    addEventListener: vi.fn(events.addEventListener.bind(events)),
    removeEventListener: vi.fn(events.removeEventListener.bind(events)),
    createOscillator: vi.fn(() => { const node = makeOscillator(); oscillators.push(node); return node }),
    createGain: vi.fn(() => { const node = makeGain(); gains.push(node); return node }),
  }
  return {
    context, oscillators, gains,
    getContext: vi.fn(async () => context as unknown as AudioContext),
    changeState(state: AudioContextState) { context.state = state; events.dispatchEvent(new Event('statechange')) },
    emit(type: string) { events.dispatchEvent(new Event(type)) },
  }
}

describe('applied-output test tone lifecycle', () => {
  it('does not request a context when the test is already cancelled', async () => {
    const h = harness(), controller = new AbortController()
    controller.abort()
    await expect(playOutputTest(h.getContext, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.getContext).not.toHaveBeenCalled()
  })

  it('cancels immediately while context resume is pending and never sounds a late context', async () => {
    const h = harness(), controller = new AbortController(), pending = deferred<AudioContext>()
    const getContext = vi.fn(() => pending.promise)
    const task = playOutputTest(getContext, controller.signal)
    expect(getContext).toHaveBeenCalledOnce()
    controller.abort()
    await expect(task).rejects.toMatchObject({ name: 'AbortError' })
    pending.resolve(h.context as unknown as AudioContext)
    await Promise.resolve()
    expect(h.context.createOscillator).not.toHaveBeenCalled()
    expect(h.context.createGain).not.toHaveBeenCalled()
    expect(h.context.close).not.toHaveBeenCalled()
  })

  it('handles a late context failure after cancellation without changing the result', async () => {
    const controller = new AbortController(), pending = deferred<AudioContext>()
    const task = playOutputTest(() => pending.promise, controller.signal)
    controller.abort()
    await expect(task).rejects.toMatchObject({ name: 'AbortError' })
    pending.reject(new Error('Resume failed late'))
    await Promise.resolve()
  })

  it('plays a quiet 440 Hz tone directly to the applied destination and resolves only after its fade ends', async () => {
    const h = harness(), controller = new AbortController()
    let finished = false
    const task = playOutputTest(h.getContext, controller.signal).then(() => { finished = true })
    await Promise.resolve()
    const oscillator = h.oscillators[0], gain = h.gains[0]
    expect(oscillator.frequency.value).toBe(440)
    expect(oscillator.type).toBe('sine')
    expect(oscillator.connect).toHaveBeenCalledWith(gain)
    expect(gain.connect).toHaveBeenCalledWith(h.context.destination)
    expect(gain.gain.value).toBe(0)
    expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0, h.context.currentTime)
    const ramps = gain.gain.linearRampToValueAtTime.mock.calls
    expect(ramps[0][0]).toBeGreaterThan(0)
    expect(ramps[0][0]).toBeLessThanOrEqual(.03)
    expect(ramps[0][1]).toBeGreaterThan(h.context.currentTime)
    expect(ramps[1][0]).toBe(0)
    const end = oscillator.stop.mock.calls[0][0]
    expect(end - h.context.currentTime).toBeGreaterThanOrEqual(.4)
    expect(end - h.context.currentTime).toBeLessThanOrEqual(.5)
    expect(ramps[1][1]).toBe(end)
    expect(finished).toBe(false)
    oscillator.end()
    await task
    expect(finished).toBe(true)
    expect(oscillator.disconnect).toHaveBeenCalledOnce()
    expect(gain.disconnect).toHaveBeenCalledOnce()
    expect(oscillator.onended).toBeNull()
    controller.abort()
    expect(oscillator.stop).toHaveBeenCalledTimes(1)
    expect(h.context.close).not.toHaveBeenCalled()
    expect(h.context.suspend).not.toHaveBeenCalled()
  })

  it('stops and disconnects an active tone immediately on abort without stopping the shared context', async () => {
    const h = harness(), controller = new AbortController()
    const task = playOutputTest(h.getContext, controller.signal)
    await Promise.resolve()
    const oscillator = h.oscillators[0], gain = h.gains[0]
    controller.abort()
    await expect(task).rejects.toMatchObject({ name: 'AbortError' })
    expect(oscillator.stop).toHaveBeenLastCalledWith()
    expect(oscillator.disconnect).toHaveBeenCalledOnce()
    expect(gain.disconnect).toHaveBeenCalledOnce()
    expect(oscillator.onended).toBeNull()
    expect(h.context.close).not.toHaveBeenCalled()
    expect(h.context.suspend).not.toHaveBeenCalled()
  })

  it('gives each AbortSignal ownership of only its own tone on a shared context', async () => {
    const h = harness(), firstController = new AbortController(), secondController = new AbortController()
    const first = playOutputTest(h.getContext, firstController.signal)
    const second = playOutputTest(h.getContext, secondController.signal)
    await Promise.resolve()
    firstController.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.oscillators[1].stop).toHaveBeenCalledTimes(1)
    expect(h.oscillators[1].disconnect).not.toHaveBeenCalled()
    expect(h.gains[1].disconnect).not.toHaveBeenCalled()
    h.oscillators[1].end()
    await expect(second).resolves.toBeUndefined()
  })

  it('propagates unavailable-context errors without creating audio nodes', async () => {
    const failure = new Error('Output permission denied'), controller = new AbortController()
    await expect(playOutputTest(async () => { throw failure }, controller.signal)).rejects.toBe(failure)
    const h = harness()
    h.context.state = 'closed'
    await expect(playOutputTest(h.getContext, controller.signal)).rejects.toThrow('실행 중이 아닙니다')
    expect(h.context.createOscillator).not.toHaveBeenCalled()
    expect(h.context.close).not.toHaveBeenCalled()
  })

  it('disconnects a partially constructed graph when a node cannot be created', async () => {
    const h = harness(), failure = new Error('Gain unavailable')
    h.context.createGain.mockImplementation(() => { throw failure })
    await expect(playOutputTest(h.getContext, new AbortController().signal)).rejects.toBe(failure)
    expect(h.oscillators[0].start).not.toHaveBeenCalled()
    expect(h.oscillators[0].disconnect).toHaveBeenCalledOnce()
    expect(h.oscillators[0].onended).toBeNull()
    expect(h.context.close).not.toHaveBeenCalled()
  })

  it('cleans up both nodes and preserves the failure when oscillator start throws', async () => {
    const h = harness(), failure = new Error('Oscillator start failed')
    const create = h.context.createOscillator.getMockImplementation()!
    h.context.createOscillator.mockImplementation(() => {
      const node = create()
      node.start.mockImplementation(() => { throw failure })
      return node
    })
    await expect(playOutputTest(h.getContext, new AbortController().signal)).rejects.toBe(failure)
    expect(h.oscillators[0].stop).toHaveBeenCalledWith()
    expect(h.oscillators[0].disconnect).toHaveBeenCalledOnce()
    expect(h.gains[0].disconnect).toHaveBeenCalledOnce()
    expect(h.oscillators[0].onended).toBeNull()
  })

  it('does not leave a pending test or connected nodes when the applied context stops mid-tone', async () => {
    const h = harness(), controller = new AbortController()
    const task = playOutputTest(h.getContext, controller.signal)
    await Promise.resolve()
    h.changeState('closed')
    await expect(task).rejects.toThrow('출력 장치가 중지')
    expect(h.oscillators[0].stop).toHaveBeenLastCalledWith()
    expect(h.oscillators[0].disconnect).toHaveBeenCalledOnce()
    expect(h.gains[0].disconnect).toHaveBeenCalledOnce()
    h.changeState('suspended')
    controller.abort()
    expect(h.oscillators[0].disconnect).toHaveBeenCalledOnce()
  })

  it('ignores a queued selection event but stops immediately if the actual output switches', async () => {
    const h = harness(), controller = new AbortController()
    const task = playOutputTest(h.getContext, controller.signal)
    await Promise.resolve()
    h.emit('sinkchange')
    expect(h.oscillators[0].disconnect).not.toHaveBeenCalled()
    h.context.sinkId = ''
    h.emit('sinkchange')
    await expect(task).rejects.toThrow('출력 장치가 변경')
    expect(h.oscillators[0].stop).toHaveBeenLastCalledWith()
    expect(h.oscillators[0].disconnect).toHaveBeenCalledOnce()
    expect(h.gains[0].disconnect).toHaveBeenCalledOnce()
    expect(h.context.close).not.toHaveBeenCalled()
  })

  it('stops its direct destination tone on an output error before UI cancellation arrives', async () => {
    const h = harness(), controller = new AbortController()
    const task = playOutputTest(h.getContext, controller.signal)
    await Promise.resolve()
    h.emit('error')
    await expect(task).rejects.toThrow('출력 장치에 문제가')
    expect(h.oscillators[0].stop).toHaveBeenLastCalledWith()
    expect(h.oscillators[0].disconnect).toHaveBeenCalledOnce()
    expect(h.gains[0].disconnect).toHaveBeenCalledOnce()
    controller.abort()
    h.emit('error')
    expect(h.oscillators[0].disconnect).toHaveBeenCalledOnce()
  })
})

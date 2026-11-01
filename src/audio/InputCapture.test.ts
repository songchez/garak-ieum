import { describe, expect, it, vi } from 'vitest'
import { InputCapture } from './InputCapture'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function microphone() {
  let active = true
  const stop = vi.fn(() => { active = false })
  const stream = { get active() { return active }, getTracks: () => [{ stop }] } as unknown as MediaStream
  return { stream, stop }
}

describe('InputCapture microphone ownership', () => {
  it('shares one pending request and keeps input until both monitoring and recording release it', async () => {
    const permission = deferred<MediaStream>()
    const open = vi.fn(() => permission.promise)
    const input = new InputCapture(open)
    input.setNeeded('monitor', true)
    const monitoring = input.acquire()
    input.setNeeded('record', true)
    const recording = input.acquire()
    expect(recording).toBe(monitoring)
    const mic = microphone()
    permission.resolve(mic.stream)
    expect(await monitoring).toBe(mic.stream)
    expect(open).toHaveBeenCalledTimes(1)
    input.setNeeded('monitor', false)
    expect(mic.stop).not.toHaveBeenCalled()
    expect(await input.acquire()).toBe(mic.stream)
    input.setNeeded('record', false)
    expect(mic.stop).toHaveBeenCalledTimes(1)
  })

  it.each(['monitor', 'record'] as const)('stops a late permission grant after %s has been cancelled', async consumer => {
    const permission = deferred<MediaStream>()
    const input = new InputCapture(() => permission.promise)
    input.setNeeded(consumer, true)
    const result = input.acquire().catch(error => error)
    await Promise.resolve()
    input.setNeeded(consumer, false)
    const mic = microphone()
    permission.resolve(mic.stream)
    expect(await result).toMatchObject({ name: 'AbortError' })
    expect(mic.stop).toHaveBeenCalledTimes(1)
    expect(mic.stream.active).toBe(false)
  })

  it('does not open a permission prompt when disposal wins before acquisition starts', async () => {
    const open = vi.fn<() => Promise<MediaStream>>()
    const input = new InputCapture(open)
    input.setNeeded('monitor', true)
    const result = input.acquire().catch(error => error)
    input.dispose()
    expect(await result).toMatchObject({ name: 'AbortError' })
    expect(open).not.toHaveBeenCalled()
  })

  it('does not stop a shared grant when recording is preparing and monitoring is cancelled', async () => {
    const permission = deferred<MediaStream>()
    const input = new InputCapture(() => permission.promise)
    input.setNeeded('monitor', true)
    const monitoring = input.acquire()
    // Recording declares demand before resume/permission completes, before a MediaRecorder exists.
    input.setNeeded('record', true)
    input.setNeeded('monitor', false)
    const recording = input.acquire()
    const mic = microphone()
    permission.resolve(mic.stream)
    expect(await monitoring).toBe(mic.stream)
    expect(await recording).toBe(mic.stream)
    expect(mic.stop).not.toHaveBeenCalled()
    input.setNeeded('record', false)
    expect(mic.stop).toHaveBeenCalledTimes(1)
  })

  it('allows a retry after permission is denied', async () => {
    const mic = microphone()
    const denied = new DOMException('Permission denied', 'NotAllowedError')
    const open = vi.fn<() => Promise<MediaStream>>().mockRejectedValueOnce(denied).mockResolvedValueOnce(mic.stream)
    const input = new InputCapture(open)
    input.setNeeded('monitor', true)
    await expect(input.acquire()).rejects.toBe(denied)
    input.setNeeded('monitor', false)
    input.setNeeded('monitor', true)
    expect(await input.acquire()).toBe(mic.stream)
    expect(open).toHaveBeenCalledTimes(2)
    input.dispose()
    expect(mic.stop).toHaveBeenCalledTimes(1)
  })

  it('stops a late stream after unmount without replacing a newly acquired stream', async () => {
    const oldPermission = deferred<MediaStream>()
    const nextPermission = deferred<MediaStream>()
    const open = vi.fn<() => Promise<MediaStream>>().mockReturnValueOnce(oldPermission.promise).mockReturnValueOnce(nextPermission.promise)
    const input = new InputCapture(open)
    input.setNeeded('monitor', true)
    const oldResult = input.acquire().catch(error => error)
    await Promise.resolve()
    input.dispose()
    input.setNeeded('record', true)
    const nextResult = input.acquire()
    const next = microphone()
    nextPermission.resolve(next.stream)
    expect(await nextResult).toBe(next.stream)
    const old = microphone()
    oldPermission.resolve(old.stream)
    expect(await oldResult).toMatchObject({ name: 'AbortError' })
    expect(old.stop).toHaveBeenCalledTimes(1)
    expect(next.stop).not.toHaveBeenCalled()
    expect(await input.acquire()).toBe(next.stream)
    input.dispose()
    expect(next.stop).toHaveBeenCalledTimes(1)
  })

  it('invalidates an old request without clearing another request that is still pending', async () => {
    const oldPermission = deferred<MediaStream>()
    const nextPermission = deferred<MediaStream>()
    const open = vi.fn<() => Promise<MediaStream>>().mockReturnValueOnce(oldPermission.promise).mockReturnValueOnce(nextPermission.promise)
    const input = new InputCapture(open)
    input.setNeeded('monitor', true)
    const oldResult = input.acquire().catch(error => error)
    await Promise.resolve()
    input.dispose()
    input.setNeeded('monitor', true)
    const nextResult = input.acquire()
    const old = microphone()
    oldPermission.resolve(old.stream)
    expect(await oldResult).toMatchObject({ name: 'AbortError' })
    expect(input.acquire()).toBe(nextResult)
    const next = microphone()
    nextPermission.resolve(next.stream)
    await nextResult
    expect(open).toHaveBeenCalledTimes(2)
    input.dispose()
  })
})

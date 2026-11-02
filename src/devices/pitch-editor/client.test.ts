import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { analyzePitchInWorker, renderPitchInWorker } from './client'

class FakeWorker {
  static created: FakeWorker[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null
  onmessageerror: (() => void) | null = null
  terminated = 0
  sent: { kind: string; channels: Float32Array[]; sampleRate: number } | null = null
  constructor(readonly url: URL, readonly options: WorkerOptions) { FakeWorker.created.push(this) }
  postMessage(message: unknown, transfer: Transferable[]) {
    this.sent = structuredClone(message, { transfer }) as typeof this.sent
  }
  terminate() { this.terminated += 1 }
  emit(data: unknown) { this.onmessage?.({ data }) }
}

describe('pitch worker client lifecycle', () => {
  beforeEach(() => { FakeWorker.created = []; vi.stubGlobal('Worker', FakeWorker) })
  afterEach(() => vi.unstubAllGlobals())

  it('transfers copied PCM and releases the worker on completion', async () => {
    const input = Float32Array.of(0.1, 0.2, 0.3)
    const promise = analyzePitchInWorker([input], 48000)
    const worker = FakeWorker.created[0]
    expect(worker.options.type).toBe('module')
    expect(worker.url.pathname.endsWith('/worker.ts')).toBe(true)
    expect(worker.sent?.channels[0]).toEqual(input)
    expect(input.byteLength).toBe(12)
    worker.sent!.channels[0][0] = 9
    expect(input[0]).toBeCloseTo(0.1)
    const result = { version: 1, algorithm: 'yin-v1', sampleRate: 48000, sourceFrames: 3, notes: [], contour: [] }
    worker.emit({ kind: 'result', result })
    expect(await promise).toEqual(result)
    expect(worker.terminated).toBe(1)
  })

  it('rejects invalid or oversized input before copying PCM or creating a worker', async () => {
    const tooLong = new Float32Array(8000 * 60 + 1)
    await expect(analyzePitchInWorker([tooLong], 8000)).rejects.toThrow('60초')
    await expect(analyzePitchInWorker([Float32Array.of(0)], 7999)).rejects.toThrow()
    await expect(analyzePitchInWorker([Float32Array.of(0), Float32Array.of(0, 0)], 48000)).rejects.toThrow()
    await expect(analyzePitchInWorker([], 48000)).rejects.toThrow()
    expect(FakeWorker.created).toHaveLength(0)
    expect(tooLong.byteLength).toBe((8000 * 60 + 1) * 4)
  })

  it('aborts without starting a worker and terminates an in-flight worker', async () => {
    const done = new AbortController()
    done.abort()
    await expect(analyzePitchInWorker([Float32Array.of(0)], 48000, { signal: done.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.created).toHaveLength(0)
    const active = new AbortController()
    const promise = analyzePitchInWorker([Float32Array.of(0)], 48000, { signal: active.signal })
    const worker = FakeWorker.created[0]
    active.abort()
    worker.emit({ kind: 'result', result: {} })
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.terminated).toBe(1)
  })

  it('forwards render data/progress and removes the abort handler after success', async () => {
    const abort = new AbortController(), progress = vi.fn()
    const promise = renderPitchInWorker([Float32Array.of(0)], 48000, [], {}, { signal: abort.signal, onProgress: progress })
    const worker = FakeWorker.created[0]
    expect(worker.sent?.kind).toBe('render')
    worker.emit({ kind: 'progress', value: 0.5 })
    worker.emit({ kind: 'result', result: [Float32Array.of(0)] })
    expect(await promise).toEqual([Float32Array.of(0)])
    abort.abort()
    expect(progress).toHaveBeenCalledWith(0.5)
    expect(worker.terminated).toBe(1)
  })

  it('rejects worker and progress callback errors with cleanup', async () => {
    const p1 = analyzePitchInWorker([Float32Array.of(0)], 48000)
    const first = FakeWorker.created.at(-1)!
    first.emit({ kind: 'error', message: 'invalid PCM' })
    await expect(p1).rejects.toThrow('invalid PCM')
    expect(first.terminated).toBe(1)
    const p2 = analyzePitchInWorker([Float32Array.of(0)], 48000)
    const second = FakeWorker.created.at(-1)!
    second.onerror?.({ message: 'worker unavailable' })
    await expect(p2).rejects.toThrow('worker unavailable')
    const p3 = analyzePitchInWorker([Float32Array.of(0)], 48000, { onProgress: () => { throw new Error('listener failed') } })
    const third = FakeWorker.created.at(-1)!
    third.emit({ kind: 'progress', value: 0.2 })
    await expect(p3).rejects.toThrow('listener failed')
    expect(third.terminated).toBe(1)
  })
})

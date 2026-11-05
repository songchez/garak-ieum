import { describe, expect, it, vi } from 'vitest'
import type { AudioRecordingResult } from '../AudioRecording'
import type { NativeAudioBridge } from './contracts'
import { NativeRecording, NativeRecordings, type NativeTakeResult } from './NativeRecording'

function deferred<T = unknown>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function harness() {
  let clock = 0
  const start = deferred(), stop = deferred()
  const request = vi.fn((method: string) => method === 'record.start' ? start.promise : stop.promise)
  const bridge: NativeAudioBridge = { request, subscribe: () => () => undefined }
  const onComplete = vi.fn<(result: AudioRecordingResult) => void>(), onError = vi.fn<(error: Error) => void>()
  const recording = new NativeRecording(bridge, 'audio', { onComplete, onError }, 48000, () => clock)
  const complete = (extra = {}) => stop.resolve({ data: new Uint8Array(48), frames: 96000, sampleRate: 48000, channels: 1, ...extra })
  return { recording, request, start, stop, onComplete, onError, complete, at: (value: number) => { clock = value } }
}

describe('native recording clock and ownership', () => {
  it('uses the native start frame and final sample count rather than IPC/finalization time', async () => {
    const h = harness(), started = h.recording.start()
    h.at(1000); h.start.resolve({ startFrame: 123456, sampleRate: 48000 }); await started
    expect(h.recording.startFrame).toBe(123456)
    h.at(2050); expect(h.recording.elapsedSeconds).toBe(1.05)
    h.recording.stop(); h.at(9999)
    h.complete(); await vi.waitFor(() => expect(h.onComplete).toHaveBeenCalledTimes(1))
    expect(h.onComplete.mock.calls[0][0]).toMatchObject({ durationSeconds: 2, error: null })
    expect(h.recording.elapsedSeconds).toBe(2)
    expect(h.onComplete.mock.calls[0][0].blob.type).toBe('audio/wav')
    expect(h.request.mock.calls.map(([method]) => method)).toEqual(['record.start', 'record.stop'])
  })

  it('honors Stop before the asynchronous native start is acknowledged and finalizes only once', async () => {
    const h = harness(), started = h.recording.start()
    h.recording.stop(); h.recording.stop()
    h.start.resolve({ startFrame: 24000, sampleRate: 48000 }); await started
    h.recording.stop(); h.complete()
    await vi.waitFor(() => expect(h.onComplete).toHaveBeenCalledTimes(1))
    h.recording.stop(); h.recording.dispose()
    expect(h.request.mock.calls.filter(([method]) => method === 'record.stop')).toHaveLength(1)
  })

  it('stops a late native start after unmount without publishing an orphan recording', async () => {
    const h = harness(), started = h.recording.start()
    h.recording.dispose()
    h.start.resolve({ startFrame: 0, sampleRate: 48000 }); h.complete()
    await started
    expect(h.request.mock.calls.filter(([method]) => method === 'record.stop')).toHaveLength(1)
    expect(h.onComplete).not.toHaveBeenCalled(); expect(h.onError).not.toHaveBeenCalled()
  })

  it('stops an already recording take on dispose and ignores its later result', async () => {
    const h = harness(), started = h.recording.start()
    h.start.resolve({ startFrame: 0, sampleRate: 48000 }); await started
    h.recording.dispose(); h.complete(); await Promise.resolve()
    expect(h.request.mock.calls.filter(([method]) => method === 'record.stop')).toHaveLength(1)
    expect(h.onComplete).not.toHaveBeenCalled()
  })

  it('keeps useful partial WAV data while reporting native write overflow', async () => {
    const h = harness(), started = h.recording.start()
    h.start.resolve({ startFrame: 0, sampleRate: 48000 }); await started
    h.recording.stop(); h.complete({ error: 'recording overflow', frames: 24000 })
    await vi.waitFor(() => expect(h.onComplete).toHaveBeenCalledTimes(1))
    const result = h.onComplete.mock.calls[0][0]
    expect(result.blob.size).toBe(48); expect(result.durationSeconds).toBe(.5)
    expect(result.error?.message).toBe('recording overflow')
    expect(h.onError).toHaveBeenCalledTimes(1)
  })

  it('releases App ownership with an empty result when stop fails', async () => {
    const h = harness(), started = h.recording.start()
    h.start.resolve({ startFrame: 0, sampleRate: 48000 }); await started
    h.recording.stop(); h.stop.reject(new Error('host exited'))
    await vi.waitFor(() => expect(h.onComplete).toHaveBeenCalledTimes(1))
    expect(h.onComplete.mock.calls[0][0].blob.size).toBe(0)
    expect(h.onError.mock.calls[0][0].message).toBe('host exited')
  })

  it.each([{ startFrame: NaN }, { startFrame: -Infinity }, { startFrame: 2.5 }, { startFrame: 0, sampleRate: 44100 }])('stops a native take whose successful acknowledgement is invalid: %j', async response => {
    const h = harness(), started = h.recording.start()
    const rejected = expect(started).rejects.toThrow()
    h.start.resolve(response); h.complete()
    await rejected
    expect(h.request.mock.calls.filter(([method]) => method === 'record.stop')).toHaveLength(1)
    expect(h.onComplete).not.toHaveBeenCalled()
  })

  it('preserves signed driver-compensated start frames and their uncertainty', async () => {
    const h = harness(), started = h.recording.start()
    h.start.resolve({ startFrame: -960, rawStartFrame: 0, compensationFrames: 960, compensationKnown: false, sampleRate: 48000 }); await started
    expect(h.recording.startFrame).toBe(-960); expect(h.recording.rawStartFrame).toBe(0)
    expect(h.recording.compensationFrames).toBe(960); expect(h.recording.compensationKnown).toBe(false)
    h.recording.dispose(); h.complete()
  })

  it('does not stop someone else’s take when start was rejected before ownership', async () => {
    const h = harness(), started = h.recording.start()
    const rejected = expect(started).rejects.toThrow('already recording')
    h.start.reject(new Error('already recording')); await rejected
    h.recording.dispose()
    expect(h.request.mock.calls.map(([method]) => method)).toEqual(['record.start'])
  })
})

function multiHarness(trackIds = ['drums', 'bass']) {
  let clock = 0
  const start = deferred(), stop = deferred()
  const request = vi.fn((method: string, _params?: Record<string, unknown>) => method === 'record.start' ? start.promise : stop.promise)
  const bridge: NativeAudioBridge = { request, subscribe: () => () => undefined }
  const onComplete = vi.fn<(results: NativeTakeResult[]) => void>(), onError = vi.fn<(error: Error) => void>()
  const recording = new NativeRecordings(bridge, trackIds, { onComplete, onError }, 48000, () => clock)
  const take = (trackId: string, extra = {}) => ({ trackId, takeId: `take-${trackId}`, channels: 1, startFrame: -100, rawStartFrame: 900, compensationFrames: 1000, compensationKnown: true, ...extra })
  return { recording, request, start, stop, onComplete, onError, take, at: (value: number) => { clock = value } }
}

describe('native multi-track recording', () => {
  it('starts every track in one request and returns each take with its own file in track order', async () => {
    const h = multiHarness(), started = h.recording.start()
    expect(h.request.mock.calls[0]).toEqual(['record.start', { takes: [{ trackId: 'drums' }, { trackId: 'bass' }] }])
    h.start.resolve({ takes: [h.take('bass', { channels: 2 }), h.take('drums')], sampleRate: 48000 }); await started
    expect(h.recording.startFrame).toBe(-100); expect(h.recording.rawStartFrame).toBe(900); expect(h.recording.compensationKnown).toBe(true)
    expect(h.recording.startedTakes.map(take => [take.trackId, take.channels])).toEqual([['drums', 1], ['bass', 2]])
    h.recording.stop()
    h.stop.resolve({ sampleRate: 48000, takes: [
      { trackId: 'bass', takeId: 'take-bass', data: new Uint8Array(64), frames: 48000, sampleRate: 48000, channels: 2 },
      { trackId: 'drums', takeId: 'take-drums', data: new Uint8Array(48), frames: 48000, sampleRate: 48000, channels: 1 },
    ] })
    await vi.waitFor(() => expect(h.onComplete).toHaveBeenCalledTimes(1))
    const results = h.onComplete.mock.calls[0][0]
    expect(results.map(result => [result.trackId, result.takeId, result.channels, result.blob.size, result.durationSeconds, result.error])).toEqual([
      ['drums', 'take-drums', 1, 48, 1, null], ['bass', 'take-bass', 2, 64, 1, null],
    ])
    expect(h.onError).not.toHaveBeenCalled()
    expect(h.request.mock.calls.map(([method]) => method)).toEqual(['record.start', 'record.stop'])
  })

  it('keeps the good takes and reports a failed or missing one once', async () => {
    const h = multiHarness(['a', 'b', 'c']), started = h.recording.start()
    h.start.resolve({ takes: [h.take('a'), h.take('b'), h.take('c')], sampleRate: 48000 }); await started
    h.recording.stop()
    h.stop.resolve({ takes: [
      { trackId: 'a', data: new Uint8Array(48), frames: 24000, sampleRate: 48000 },
      { trackId: 'b', data: new Uint8Array(0), error: 'too large' },
    ] })
    await vi.waitFor(() => expect(h.onComplete).toHaveBeenCalledTimes(1))
    const [a, b, c] = h.onComplete.mock.calls[0][0]
    expect(a).toMatchObject({ trackId: 'a', error: null, durationSeconds: .5 })
    expect(b.blob.size).toBe(0); expect(b.error?.message).toBe('too large')
    expect(c.error?.message).toMatch(/결과/)
    expect(h.onError).toHaveBeenCalledTimes(1)
  })

  it.each([
    { takes: [{ trackId: 'drums', startFrame: 0 }], sampleRate: 48000 },
    { takes: [{ trackId: 'drums', startFrame: 0 }, { trackId: 'bass', startFrame: 1 }], sampleRate: 48000 },
    { takes: [{ trackId: 'drums', startFrame: 0 }, { trackId: 'bass', startFrame: 0 }], sampleRate: 44100 },
    { startFrame: 0, sampleRate: 48000 },
  ])('stops a multi-take start that does not match the request: %j', async response => {
    const h = multiHarness(), started = h.recording.start()
    const rejected = expect(started).rejects.toThrow()
    h.start.resolve(response); h.stop.resolve({ takes: [] })
    await rejected
    expect(h.request.mock.calls.filter(([method]) => method === 'record.stop')).toHaveLength(1)
    expect(h.onComplete).not.toHaveBeenCalled()
  })

  it('completes every track with the stop failure and never publishes after dispose', async () => {
    const h = multiHarness(), started = h.recording.start()
    h.start.resolve({ takes: [h.take('drums'), h.take('bass')], sampleRate: 48000 }); await started
    h.recording.stop(); h.stop.reject(new Error('host exited'))
    await vi.waitFor(() => expect(h.onComplete).toHaveBeenCalledTimes(1))
    expect(h.onComplete.mock.calls[0][0].map(result => [result.trackId, result.error?.message])).toEqual([['drums', 'host exited'], ['bass', 'host exited']])
    const late = multiHarness(), lateStart = late.recording.start()
    late.recording.dispose(); late.start.resolve({ takes: [late.take('drums'), late.take('bass')], sampleRate: 48000 }); late.stop.resolve({ takes: [] })
    await lateStart
    expect(late.request.mock.calls.filter(([method]) => method === 'record.stop')).toHaveLength(1)
    expect(late.onComplete).not.toHaveBeenCalled()
  })

  it('rejects an empty or duplicated track list before contacting the host', () => {
    const bridge: NativeAudioBridge = { request: vi.fn(), subscribe: () => () => undefined }
    expect(() => new NativeRecordings(bridge, [], { onComplete: vi.fn() }, 48000)).toThrow()
    expect(() => new NativeRecordings(bridge, ['a', 'a'], { onComplete: vi.fn() }, 48000)).toThrow()
    expect(bridge.request).not.toHaveBeenCalled()
  })
})

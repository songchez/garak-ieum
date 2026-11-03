import { describe, expect, it, vi } from 'vitest'
import { AudioRecording, type AudioRecordingResult } from './AudioRecording'

function harness() {
  let clock = 1000
  const recorder = {
    state: 'inactive' as RecordingState,
    mimeType: 'audio/webm;codecs=opus',
    ondataavailable: null as ((event: BlobEvent) => void) | null,
    onstop: null as (() => void) | null,
    onerror: null as ((event: Event) => void) | null,
    start: vi.fn((_timeslice: number) => {
      if (recorder.state !== 'inactive') throw new DOMException('Already recording', 'InvalidStateError')
      recorder.state = 'recording'
    }),
    stop: vi.fn(() => {
      if (recorder.state === 'inactive') throw new DOMException('Already stopped', 'InvalidStateError')
      recorder.state = 'inactive'
      // The browser queues the final dataavailable and stop after stop() returns.
    }),
  }
  const onComplete = vi.fn<(result: AudioRecordingResult) => void>()
  const onError = vi.fn<(error: Error) => void>()
  const recording = new AudioRecording(recorder as unknown as MediaRecorder, { onComplete, onError }, () => clock)
  const data = (text: string, type = recorder.mimeType) => recorder.ondataavailable?.({ data: new Blob([text], { type }) } as BlobEvent)
  const finish = () => { recorder.state = 'inactive'; recorder.onstop?.() }
  const fail = (error: Error) => { recorder.state = 'inactive'; recorder.onerror?.(Object.assign(new Event('error'), { error })) }
  return { recorder, recording, onComplete, onError, data, finish, fail, at: (ms: number) => { clock = ms } }
}

describe('audio recording completion', () => {
  it('starts the clock at capture and includes the final chunk without adding finalization latency', async () => {
    const h = harness()
    expect(h.recording.startedAtMs).toBe(0)
    expect(h.recording.elapsedSeconds).toBe(0)
    h.at(5000)
    h.recording.start()
    expect(h.recorder.start).toHaveBeenCalledExactlyOnceWith(100)
    expect(h.recording.startedAtMs).toBe(5000)
    h.data('first-')
    h.at(6250)
    expect(h.recording.elapsedSeconds).toBe(1.25)
    h.recording.stop()
    expect(h.onComplete).not.toHaveBeenCalled()
    expect(h.recorder.ondataavailable).not.toBeNull()
    h.at(9900)
    h.data('last')
    h.finish()
    const result = h.onComplete.mock.calls[0][0]
    expect(await result.blob.text()).toBe('first-last')
    expect(result.blob.type).toBe(h.recorder.mimeType)
    expect(result.durationSeconds).toBe(1.25)
    expect(result.error).toBeNull()
    expect(h.recording.elapsedSeconds).toBe(1.25)
    expect(h.onComplete).toHaveBeenCalledTimes(1)
    expect(h.recorder.ondataavailable).toBeNull()
    expect(h.recorder.onstop).toBeNull()
    expect(h.recorder.onerror).toBeNull()
  })

  it('requests one native stop and completes once even when old events are delivered again', async () => {
    const h = harness()
    h.recording.start()
    const lateData = h.recorder.ondataavailable!, lateStop = h.recorder.onstop!, lateError = h.recorder.onerror!
    h.at(2000)
    h.recording.stop()
    h.at(3000)
    h.recording.stop()
    h.data('take')
    h.finish()
    h.recording.stop()
    lateData({ data: new Blob(['duplicate']) } as BlobEvent)
    lateStop()
    lateError(Object.assign(new Event('error'), { error: new Error('late error') }))
    expect(h.recorder.stop).toHaveBeenCalledTimes(1)
    expect(h.onComplete).toHaveBeenCalledTimes(1)
    expect(h.onError).not.toHaveBeenCalled()
    expect(await h.onComplete.mock.calls[0][0].blob.text()).toBe('take')
    expect(h.onComplete.mock.calls[0][0].durationSeconds).toBe(1)
  })

  it('can stop a paused native recorder', () => {
    const h = harness()
    h.recording.start()
    h.recorder.state = 'paused'
    h.recording.stop()
    h.finish()
    expect(h.recorder.stop).toHaveBeenCalledTimes(1)
    expect(h.onComplete).toHaveBeenCalledTimes(1)
  })

  it('waits for final data when the native recorder is already inactive', async () => {
    const h = harness()
    h.recording.start()
    h.recorder.state = 'inactive'
    h.at(3500)
    h.recording.stop()
    expect(h.recorder.stop).not.toHaveBeenCalled()
    expect(h.onComplete).not.toHaveBeenCalled()
    h.at(6000)
    h.data('native-last')
    h.finish()
    expect(await h.onComplete.mock.calls[0][0].blob.text()).toBe('native-last')
    expect(h.onComplete.mock.calls[0][0].durationSeconds).toBe(2.5)
  })

  it('handles an automatic native stop without an explicit stop request', () => {
    const h = harness()
    h.recording.start()
    h.at(2250)
    h.data('complete')
    h.finish()
    h.at(4000)
    expect(h.recording.elapsedSeconds).toBe(1.25)
    expect(h.onComplete.mock.calls[0][0].durationSeconds).toBe(1.25)
    expect(h.recorder.stop).not.toHaveBeenCalled()
  })

  it('reports empty results so the app can release input and explain the missing region', () => {
    const h = harness()
    h.recording.start()
    h.data('')
    h.recording.stop()
    h.finish()
    expect(h.onComplete).toHaveBeenCalledTimes(1)
    expect(h.onComplete.mock.calls[0][0]).toMatchObject({ blob: { size: 0 }, durationSeconds: 0, error: null })
  })

  it('preserves partial audio and its final chunk after a recorder error', async () => {
    const h = harness()
    h.recording.start()
    h.data('partial-')
    h.at(1800)
    const error = new DOMException('Input ended', 'NotReadableError')
    h.fail(error)
    expect(h.onError).toHaveBeenCalledExactlyOnceWith(error)
    expect(h.onComplete).not.toHaveBeenCalled()
    h.at(4000)
    h.recording.stop()
    h.data('last')
    h.finish()
    const result = h.onComplete.mock.calls[0][0]
    expect(await result.blob.text()).toBe('partial-last')
    expect(result.error).toBe(error)
    expect(result.durationSeconds).toBe(.8)
    expect(h.onComplete).toHaveBeenCalledTimes(1)
    expect(h.recorder.stop).not.toHaveBeenCalled()
  })

  it('supplies a useful error when an error event carries no native error', () => {
    const h = harness()
    h.recording.start()
    h.recorder.onerror?.(new Event('error'))
    h.finish()
    expect(h.onError.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(h.onError.mock.calls[0][0].message).not.toBe('')
    expect(h.onComplete.mock.calls[0][0].error).toBe(h.onError.mock.calls[0][0])
  })

  it('uses the chunk MIME type if the recorder does not report one', () => {
    const h = harness()
    h.recorder.mimeType = ''
    h.recording.start()
    h.data('take', 'audio/ogg')
    h.finish()
    expect(h.onComplete.mock.calls[0][0].blob.type).toBe('audio/ogg')
  })
})

describe('audio recording cleanup', () => {
  it.each([false, true])('detaches on start failure, including a partially started recorder (%s)', partiallyStarted => {
    const h = harness()
    const error = new DOMException('Cannot encode', 'NotSupportedError')
    let lateStop: (() => void) | null = null
    h.recorder.start.mockImplementationOnce(() => {
      lateStop = h.recorder.onstop
      if (partiallyStarted) h.recorder.state = 'recording'
      throw error
    })
    expect(() => h.recording.start()).toThrow(error)
    expect(h.recorder.ondataavailable).toBeNull()
    expect(h.recorder.onstop).toBeNull()
    expect(h.recorder.onerror).toBeNull()
    expect(h.recorder.stop).toHaveBeenCalledTimes(partiallyStarted ? 1 : 0)
    expect(h.recording.elapsedSeconds).toBe(0)
    ;(lateStop as (() => void) | null)?.()
    h.recording.stop()
    h.recording.dispose()
    expect(h.onComplete).not.toHaveBeenCalled()
    expect(h.onError).not.toHaveBeenCalled()
  })

  it('disposes before stopping the recorder and rejects all cached late callbacks', () => {
    const h = harness()
    h.recording.start()
    h.data('discard')
    const lateData = h.recorder.ondataavailable!, lateStop = h.recorder.onstop!, lateError = h.recorder.onerror!
    h.recorder.stop.mockImplementationOnce(() => {
      expect(h.recorder.ondataavailable).toBeNull()
      expect(h.recorder.onstop).toBeNull()
      expect(h.recorder.onerror).toBeNull()
      h.recorder.state = 'inactive'
      lateData({ data: new Blob(['late']) } as BlobEvent)
      lateStop()
      lateError(new Event('error'))
    })
    h.at(1500)
    h.recording.dispose()
    h.at(9000)
    h.recording.dispose()
    h.recording.stop()
    expect(h.recorder.stop).toHaveBeenCalledTimes(1)
    expect(h.recording.elapsedSeconds).toBe(.5)
    expect(h.onComplete).not.toHaveBeenCalled()
    expect(h.onError).not.toHaveBeenCalled()
  })

  it('can dispose after stop was requested without completing the pending take', () => {
    const h = harness()
    h.recording.start()
    const lateStop = h.recorder.onstop!
    h.recording.stop()
    h.recording.dispose()
    lateStop()
    expect(h.recorder.stop).toHaveBeenCalledTimes(1)
    expect(h.onComplete).not.toHaveBeenCalled()
  })

  it('does not start a disposed capture or interrupt an active capture on a second start', () => {
    const discarded = harness()
    discarded.recording.dispose()
    expect(() => discarded.recording.start()).toThrow(expect.objectContaining({ name: 'InvalidStateError' }))
    expect(discarded.recorder.start).not.toHaveBeenCalled()
    expect(discarded.recorder.stop).not.toHaveBeenCalled()
    const active = harness()
    active.recording.stop()
    active.recording.start()
    expect(() => active.recording.start()).toThrow(expect.objectContaining({ name: 'InvalidStateError' }))
    expect(active.recorder.start).toHaveBeenCalledTimes(1)
    expect(active.recorder.stop).not.toHaveBeenCalled()
    active.finish()
    expect(active.onComplete).toHaveBeenCalledTimes(1)
  })
})

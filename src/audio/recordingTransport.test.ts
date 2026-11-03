import { describe, expect, it, vi } from 'vitest'
import { AudioRecording, type AudioRecordingResult } from './AudioRecording'
import { InputCapture } from './InputCapture'
import { bindRecordingToTransport, pausePlaybackWithRecording, stopPlaybackWithRecording, togglePlaybackWithRecording } from './recordingTransport'

function harness() {
  let clock = 1000
  let playing = false
  let beat = 4
  let active: AudioRecording | null = null
  const listeners = new Set<() => void>()
  const publish = (next: boolean) => { playing = next; for (const listener of listeners) listener() }
  const recorder = {
    state: 'inactive' as RecordingState,
    mimeType: 'audio/webm',
    ondataavailable: null as ((event: BlobEvent) => void) | null,
    onstop: null as (() => void) | null,
    onerror: null as ((event: Event) => void) | null,
    start: vi.fn(() => { recorder.state = 'recording' }),
    stop: vi.fn(() => { recorder.state = 'inactive' }),
  }
  const onComplete = vi.fn<(result: AudioRecordingResult) => void>()
  const recording = new AudioRecording(recorder as unknown as MediaRecorder, {
    onComplete: result => { active = null; onComplete(result) },
  }, () => clock)
  const engine = {
    getSnapshot: () => ({ playing, beat }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    pause: vi.fn(() => publish(false)),
    stop: vi.fn(() => { beat = 0; publish(false) }),
    togglePlayback: vi.fn(async () => publish(!playing)),
  }
  const controls = {
    cancelPreparation: vi.fn(() => false),
    finishRecording: vi.fn(() => { if (!active) return false; active.stop(); return true }),
  }
  return {
    engine, controls, recorder, recording, onComplete, publish,
    begin: () => { active = recording; recording.start(); publish(true) },
    data: (text: string) => recorder.ondataavailable?.({ data: new Blob([text]) } as BlobEvent),
    finish: () => { recorder.state = 'inactive'; recorder.onstop?.() },
    at: (ms: number) => { clock = ms },
  }
}

describe('recording and transport integration', () => {
  it('finishes a Space/play toggle once, retains the final chunk, and never resumes a pending take', async () => {
    const h = harness()
    const unbind = bindRecordingToTransport(h.engine, h.controls.finishRecording)
    h.begin()
    h.data('first-')
    h.at(2250)
    await togglePlaybackWithRecording(h.engine, h.controls)
    expect(h.recorder.stop).toHaveBeenCalledTimes(1)
    expect(h.engine.pause).toHaveBeenCalledTimes(1)
    expect(h.engine.getSnapshot()).toEqual({ playing: false, beat: 4 })
    expect(h.engine.togglePlayback).not.toHaveBeenCalled()
    expect(h.onComplete).not.toHaveBeenCalled()
    h.at(5000)
    await togglePlaybackWithRecording(h.engine, h.controls)
    expect(h.recorder.stop).toHaveBeenCalledTimes(1)
    expect(h.engine.togglePlayback).not.toHaveBeenCalled()
    h.data('last')
    h.finish()
    expect(h.onComplete).toHaveBeenCalledTimes(1)
    expect(await h.onComplete.mock.calls[0][0].blob.text()).toBe('first-last')
    expect(h.onComplete.mock.calls[0][0].durationSeconds).toBe(1.25)
    await togglePlaybackWithRecording(h.engine, h.controls)
    expect(h.engine.togglePlayback).toHaveBeenCalledTimes(1)
    expect(h.engine.getSnapshot().playing).toBe(true)
    unbind()
  })

  it.each(['pause', 'stop'] as const)('%s finalizes the same recording while preserving its own transport position behavior', async action => {
    const h = harness()
    h.begin()
    h.data('take-')
    h.at(1800)
    const command = action === 'pause' ? pausePlaybackWithRecording : stopPlaybackWithRecording
    command(h.engine, h.controls)
    expect(h.controls.cancelPreparation).toHaveBeenCalledTimes(1)
    expect(h.recorder.stop).toHaveBeenCalledTimes(1)
    expect(h.engine[action]).toHaveBeenCalledTimes(1)
    expect(h.engine.getSnapshot()).toEqual({ playing: false, beat: action === 'stop' ? 0 : 4 })
    h.data('tail')
    h.finish()
    expect(h.onComplete).toHaveBeenCalledTimes(1)
    expect(await h.onComplete.mock.calls[0][0].blob.text()).toBe('take-tail')
  })

  it('cancels a real pending input acquisition so late permission cannot start the recorder or playback', async () => {
    const h = harness()
    let resolve!: (stream: MediaStream) => void
    const permission = new Promise<MediaStream>(yes => { resolve = yes })
    const input = new InputCapture(() => permission)
    input.setNeeded('record', true)
    const preparation = input.acquire().then(() => { h.begin(); return null }, error => error)
    await Promise.resolve()
    h.publish(true)
    let preparing = true
    h.controls.cancelPreparation.mockImplementation(() => {
      if (!preparing) return false
      preparing = false
      input.setNeeded('record', false)
      return true
    })
    await togglePlaybackWithRecording(h.engine, h.controls)
    // Both controls run even when cancelPreparation returned true.
    expect(h.controls.finishRecording).toHaveBeenCalledTimes(1)
    expect(h.engine.pause).toHaveBeenCalledTimes(1)
    expect(h.engine.togglePlayback).not.toHaveBeenCalled()
    const stopInput = vi.fn()
    resolve({ active: true, getTracks: () => [{ stop: stopInput }] } as unknown as MediaStream)
    expect(await preparation).toMatchObject({ name: 'AbortError' })
    expect(stopInput).toHaveBeenCalledTimes(1)
    expect(h.recorder.start).not.toHaveBeenCalled()
    expect(h.onComplete).not.toHaveBeenCalled()
    expect(h.engine.getSnapshot().playing).toBe(false)
  })

  it('keeps ordinary playback toggling when there is no recording or preparation', async () => {
    const h = harness()
    await togglePlaybackWithRecording(h.engine, h.controls)
    expect(h.engine.getSnapshot().playing).toBe(true)
    await togglePlaybackWithRecording(h.engine, h.controls)
    expect(h.engine.getSnapshot().playing).toBe(false)
    expect(h.engine.togglePlayback).toHaveBeenCalledTimes(2)
    expect(h.engine.pause).not.toHaveBeenCalled()
    expect(h.recorder.stop).not.toHaveBeenCalled()
    expect(h.onComplete).not.toHaveBeenCalled()
  })

  it('finishes automatic playback end only on true-to-false, including reentrant notifications', async () => {
    const h = harness()
    const finish = vi.fn(() => {
      const stopped = h.controls.finishRecording()
      h.engine.pause()
      return stopped
    })
    const unbind = bindRecordingToTransport(h.engine, finish)
    h.publish(false)
    expect(finish).not.toHaveBeenCalled()
    h.begin()
    h.publish(true)
    expect(finish).not.toHaveBeenCalled()
    h.data('automatic-')
    h.at(3000)
    h.publish(false)
    expect(finish).toHaveBeenCalledTimes(1)
    expect(h.recorder.stop).toHaveBeenCalledTimes(1)
    expect(h.onComplete).not.toHaveBeenCalled()
    h.data('tail')
    h.finish()
    expect(h.onComplete).toHaveBeenCalledTimes(1)
    expect(await h.onComplete.mock.calls[0][0].blob.text()).toBe('automatic-tail')
    expect(h.onComplete.mock.calls[0][0].durationSeconds).toBe(2)
    unbind()
    h.publish(true)
    h.publish(false)
    expect(finish).toHaveBeenCalledTimes(1)
  })
})

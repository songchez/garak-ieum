import { PITCH_LIMITS, type PitchAnalysis, type PitchNote, type PitchTaskOptions } from './model'

type Job = { kind: 'analyze' | 'render'; sampleRate: number; segments?: readonly PitchNote[]; shifts?: Readonly<Record<string, number>> }
const aborted = () => new DOMException('피치 작업을 취소했습니다.', 'AbortError')

/** A worker per job makes cancellation immediate even during a synchronous WASM block. */
function run<T>(channels: readonly Float32Array[], job: Job, options: PitchTaskOptions = {}): Promise<T> {
  if (options.signal?.aborted) return Promise.reject(aborted())
  // Reject oversized/malformed jobs before allocating transferable PCM copies.
  // The worker also checks every sample for finiteness off the UI thread.
  const frames = channels?.[0]?.length ?? 0
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > PITCH_LIMITS.maxChannels || !Number.isInteger(job.sampleRate) || job.sampleRate < PITCH_LIMITS.minSampleRate || job.sampleRate > PITCH_LIMITS.maxSampleRate || frames < 1 || frames / job.sampleRate > PITCH_LIMITS.maxDurationSeconds || channels.some(channel => !(channel instanceof Float32Array) || channel.length !== frames)) {
    return Promise.reject(new Error('피치 작업은 60초 이하의 8~192 kHz 모노/스테레오 음원을 지원합니다.'))
  }
  return new Promise((resolve, reject) => {
    let worker: Worker
    try { worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) }
    catch (error) { reject(error); return }
    let settled = false
    const finish = (error?: unknown, result?: T) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', cancel)
      worker.terminate()
      if (error) reject(error)
      else resolve(result as T)
    }
    const cancel = () => finish(aborted())
    options.signal?.addEventListener('abort', cancel, { once: true })
    worker.onmessage = ({ data }) => {
      if (settled) return
      if (data.kind === 'progress') {
        try { options.onProgress?.(Math.max(0, Math.min(1, data.value))) }
        catch (error) { finish(error) }
      } else if (data.kind === 'result') finish(undefined, data.result as T)
      else if (data.kind === 'error') finish(new Error(data.message))
    }
    worker.onerror = event => finish(new Error(event.message || '피치 작업을 실행하지 못했습니다.'))
    worker.onmessageerror = () => finish(new Error('피치 작업 결과를 읽지 못했습니다.'))
    try {
      // Transfer copies only: detaching a playing AudioBuffer's data would break playback.
      const copies = channels.map(channel => channel.slice())
      if (options.signal?.aborted) { cancel(); return }
      worker.postMessage({ ...job, channels: copies }, copies.map(channel => channel.buffer))
    } catch (error) { finish(error) }
  })
}

export function analyzePitchInWorker(channels: readonly Float32Array[], sampleRate: number, options?: PitchTaskOptions): Promise<PitchAnalysis> {
  return run<PitchAnalysis>(channels, { kind: 'analyze', sampleRate }, options)
}

export function renderPitchInWorker(
  channels: readonly Float32Array[], sampleRate: number, segments: readonly PitchNote[],
  shifts: Readonly<Record<string, number>>, options?: PitchTaskOptions,
): Promise<Float32Array[]> {
  return run<Float32Array[]>(channels, { kind: 'render', sampleRate, segments, shifts }, options)
}

import { prepareTempoSignal, type TempoAnalysis } from './tempo'
import { validateRenderJob, validateStretchJob, type PcmRenderJob } from './limits'

export interface WarpTaskOptions { signal?: AbortSignal; onProgress?: (fraction: number) => void }
const aborted = () => new DOMException('워프 작업을 취소했습니다.', 'AbortError')

/** A worker per job makes cancellation immediate even during a synchronous WASM block. */
function run<T>(message: Record<string, unknown>, transfer: Transferable[], options: WarpTaskOptions = {}): Promise<T> {
  if (options.signal?.aborted) return Promise.reject(aborted())
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
        try { options.onProgress?.(Math.max(0, Math.min(1, data.value))) } catch (error) { finish(error) }
      } else if (data.kind === 'result') finish(undefined, data.result as T)
      else if (data.kind === 'error') finish(new Error(data.message))
    }
    worker.onerror = event => finish(new Error(event.message || '워프 작업을 실행하지 못했습니다.'))
    worker.onmessageerror = () => finish(new Error('워프 작업 결과를 읽지 못했습니다.'))
    try { worker.postMessage(message, transfer) } catch (error) { finish(error) }
  })
}

const channelsOf = (buffer: Pick<AudioBuffer, 'numberOfChannels' | 'getChannelData'>) => Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel))

/** Mixdown and decimation run here (cheap), so the worker receives a small mono signal. */
export function analyzeTempoInWorker(buffer: Pick<AudioBuffer, 'numberOfChannels' | 'getChannelData' | 'sampleRate'>, options?: WarpTaskOptions): Promise<TempoAnalysis | null> {
  let prepared: ReturnType<typeof prepareTempoSignal>
  try { prepared = prepareTempoSignal(channelsOf(buffer), buffer.sampleRate) } catch (error) { return Promise.reject(error) }
  return run<TempoAnalysis | null>({ kind: 'analyze', signal: prepared.signal, sampleRate: prepared.sampleRate }, [prepared.signal.buffer], options)
}

export function stretchInWorker(buffer: Pick<AudioBuffer, 'numberOfChannels' | 'getChannelData' | 'sampleRate'>, ratio: number, options?: WarpTaskOptions): Promise<Float32Array[]> {
  const channels = channelsOf(buffer)
  try { validateStretchJob(channels, buffer.sampleRate, ratio) } catch (error) { return Promise.reject(error) }
  // Transfer copies only: detaching a playing AudioBuffer's data would break playback.
  const copies = channels.map(channel => channel.slice())
  return run<Float32Array[]>({ kind: 'stretch', channels: copies, sampleRate: buffer.sampleRate, ratio }, copies.map(channel => channel.buffer), options)
}

/** Combined warp + region-pitch render (stretch.renderPcm) off the main thread. */
export function renderInWorker(buffer: Pick<AudioBuffer, 'numberOfChannels' | 'getChannelData' | 'sampleRate'>, job: PcmRenderJob, options?: WarpTaskOptions): Promise<Float32Array[]> {
  const channels = channelsOf(buffer)
  try { validateRenderJob(channels, buffer.sampleRate, job) } catch (error) { return Promise.reject(error) }
  const copies = channels.map(channel => channel.slice())
  return run<Float32Array[]>({ kind: 'render', channels: copies, sampleRate: buffer.sampleRate, job }, copies.map(channel => channel.buffer), options)
}

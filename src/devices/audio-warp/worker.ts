import { analyzeTempoSignal } from './tempo'
import { stretchPcm } from './stretch'

type Request =
  | { kind: 'analyze'; signal: Float32Array; sampleRate: number }
  | { kind: 'stretch'; channels: Float32Array[]; sampleRate: number; ratio: number }

// A small structural scope type avoids adding DOM WebWorker declarations to the app.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}
scope.onmessage = async ({ data }) => {
  try {
    let lastProgressAt = -Infinity
    const progress = (value: number) => {
      const now = performance.now()
      if (value === 0 || value === 1 || now - lastProgressAt >= 60) { scope.postMessage({ kind: 'progress', value }); lastProgressAt = now }
    }
    if (data.kind === 'analyze') {
      scope.postMessage({ kind: 'result', result: analyzeTempoSignal({ signal: data.signal, sampleRate: data.sampleRate }, progress) })
    } else if (data.kind === 'stretch') {
      const result = await stretchPcm(data.channels, data.sampleRate, data.ratio, progress)
      scope.postMessage({ kind: 'result', result }, result.map(channel => channel.buffer))
    } else throw new Error('알 수 없는 워프 작업입니다.')
  } catch (error) {
    scope.postMessage({ kind: 'error', message: error instanceof Error ? error.message : '워프 작업에 실패했습니다.' })
  }
}

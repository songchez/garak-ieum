import { analyzePitch } from './analysis'
import { renderPitch } from './render'
import type { PitchNote } from './model'

type Request = {
  kind: 'analyze' | 'render'
  channels: Float32Array[]
  sampleRate: number
  segments?: PitchNote[]
  shifts?: Record<string, number>
}

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
      if (value === 0 || value === 1 || now - lastProgressAt >= 40) {
        scope.postMessage({ kind: 'progress', value })
        lastProgressAt = now
      }
    }
    if (data.kind === 'analyze') {
      const result = analyzePitch(data.channels, data.sampleRate, progress)
      scope.postMessage({ kind: 'result', result })
    } else if (data.kind === 'render') {
      const result = await renderPitch(data.channels, data.sampleRate, data.segments ?? [], data.shifts ?? {}, progress)
      scope.postMessage({ kind: 'result', result }, result.map(channel => channel.buffer))
    } else throw new Error('알 수 없는 피치 작업입니다.')
  } catch (error) {
    scope.postMessage({ kind: 'error', message: error instanceof Error ? error.message : '피치 작업에 실패했습니다.' })
  }
}

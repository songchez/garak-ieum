/// <reference path="../devices/guitar-rig/worklet-assets.d.ts" />
import type { RecordingSession, TakeCallbacks, TakeResult } from '../core/recording'
import { encodePcm16Wav } from './math'

const prepared = new WeakMap<BaseAudioContext, Promise<void>>()

/** Registers the route recorder processor once per context. */
export function prepareRouteRecorder(context: BaseAudioContext): Promise<void> {
  const existing = prepared.get(context)
  if (existing) return existing
  if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') return Promise.reject(new Error('이 브라우저에서는 트랙 녹음 프로세서를 사용할 수 없습니다. 지원되는 데스크톱 앱 또는 보안 연결에서 열어 주세요.'))
  const promise = import('./routeRecorder.worklet.ts?worker&url')
    .then(({ default: url }) => context.audioWorklet.addModule(url))
    .catch(error => { prepared.delete(context); throw error })
  prepared.set(context, promise)
  return promise
}

/** What the Web Audio engine lends a route recording: its clock and the routed inputs of the live graph. */
export interface RouteRecordingHost {
  readonly context: AudioContext
  /** Connects a recorder to the track's route input now and after every graph replacement; returns the detach. */
  attach(trackId: string, node: AudioNode): () => void
  /** Project frame (at `projectSampleRate`) of the transport at a context time; linear while playing. */
  projectFrameAt(contextTime: number): number
}

interface Take {
  trackId: string
  node: AudioWorkletNode
  detach: () => void
  chunks: { left: Float32Array; right: Float32Array }[]
  firstFrame: number | null
  frames: number | null
  started: Promise<void>
  done: Promise<void>
}

/**
 * Several routed tracks recorded from the graph (RouteGraph.input) by one AudioWorklet each. All takes are
 * asked to start at the same context frame; each reports the frame of its first sample, which maps to the
 * transport exactly because scheduled sources play at their context times. Internal routes have no
 * converter latency, so no hardware compensation is applied (docs/TRACK_INPUT_ROUTING.md).
 */
export class RouteRecordings implements RecordingSession {
  private takes: Take[] = []
  private state: 'ready' | 'recording' | 'stopping' | 'complete' | 'disposed' = 'ready'
  private startedAt = 0
  private endedAt: number | null = null
  private completedSeconds: number | null = null
  readonly compensationKnown = true

  constructor(
    private readonly host: RouteRecordingHost,
    readonly trackIds: readonly string[],
    private readonly callbacks: TakeCallbacks,
    private readonly now: () => number = () => performance.now(),
  ) {
    if (!trackIds.length || new Set(trackIds).size !== trackIds.length) throw new Error('녹음할 트랙이 없거나 중복되었습니다.')
  }

  get startedAtMs(): number { return this.startedAt }
  get elapsedSeconds(): number {
    if (this.completedSeconds !== null) return this.completedSeconds
    return this.state === 'ready' ? 0 : Math.max(0, ((this.endedAt ?? this.now()) - this.startedAt) / 1000)
  }
  get startFrame(): number | null { return this.takes[0] ? this.startFrameOf(this.takes[0].trackId) : null }
  startFrameOf(trackId: string): number | null {
    const take = this.takes.find(item => item.trackId === trackId)
    return take?.firstFrame == null ? null : this.host.projectFrameAt(take.firstFrame / this.host.context.sampleRate)
  }

  async start(): Promise<void> {
    if (this.state !== 'ready') throw new DOMException('이 녹음은 다시 시작할 수 없습니다.', 'InvalidStateError')
    const context = this.host.context
    await prepareRouteRecorder(context)
    if (this.state !== 'ready') return
    // A few render quanta ahead, so every take's start message arrives before that frame.
    const startFrame = Math.ceil((context.currentTime + 0.02) * context.sampleRate)
    this.takes = this.trackIds.map(trackId => {
      const node = new AudioWorkletNode(context, 'garak-route-recorder', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
      let started!: () => void, done!: () => void
      const take: Take = { trackId, node, detach: () => undefined, chunks: [], firstFrame: null, frames: null,
        started: new Promise(resolve => { started = resolve }), done: new Promise(resolve => { done = resolve }) }
      node.port.onmessage = (event: MessageEvent<{ type: string; frame?: number; frames?: number; left?: Float32Array; right?: Float32Array }>) => {
        const message = event.data
        if (message.type === 'started') { take.firstFrame = message.frame ?? null; started() }
        else if (message.type === 'chunk' && message.left && message.right) take.chunks.push({ left: message.left, right: message.right })
        else if (message.type === 'done') { take.frames = message.frames ?? 0; started(); done() }
      }
      take.detach = this.host.attach(trackId, node)
      node.port.postMessage({ type: 'start', frame: startFrame })
      return take
    })
    this.state = 'recording'
    this.startedAt = this.now()
    await Promise.all(this.takes.map(take => take.started))
  }

  stop(): void {
    if (this.state !== 'recording') return
    this.state = 'stopping'
    this.endedAt = this.now()
    for (const take of this.takes) take.node.port.postMessage({ type: 'stop' })
    void Promise.all(this.takes.map(take => take.done)).then(() => this.complete())
  }

  dispose(): void {
    if (this.state === 'disposed') return
    this.state = 'disposed'
    for (const take of this.takes) {
      try { take.node.port.postMessage({ type: 'stop' }) } catch { /* Closed context. */ }
      take.detach()
      take.node.port.onmessage = null
    }
  }

  private complete(): void {
    if (this.state === 'disposed') return
    this.state = 'complete'
    const rate = this.host.context.sampleRate
    const results: TakeResult[] = this.takes.map(take => {
      take.detach()
      const frames = take.chunks.reduce((total, chunk) => total + chunk.left.length, 0)
      const left = new Float32Array(frames), right = new Float32Array(frames)
      let at = 0
      for (const chunk of take.chunks) { left.set(chunk.left, at); right.set(chunk.right, at); at += chunk.left.length }
      take.chunks = []
      if (!frames) return { trackId: take.trackId, blob: new Blob([], { type: 'audio/wav' }), durationSeconds: 0, error: new Error('트랙 입력에서 녹음된 오디오가 없습니다.') }
      return { trackId: take.trackId, blob: new Blob([encodePcm16Wav([left, right], rate)], { type: 'audio/wav' }), durationSeconds: frames / rate, error: null }
    })
    this.completedSeconds = Math.max(0, ...results.map(result => result.durationSeconds))
    this.callbacks.onComplete(results)
  }
}

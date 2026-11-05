import type { AudioRecordingCallbacks, AudioRecordingResult } from '../AudioRecording'
import type { NativeAudioBridge, NativeAudioFile, NativeRecordingTake } from './contracts'

type StartResult = { startFrame: number; sampleRate: number; rawStartFrame?: number; compensationFrames?: number; compensationKnown?: boolean }
type CaptureState = 'ready' | 'starting' | 'recording' | 'stopping' | 'complete' | 'disposed'

const safeFrame = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
const failure = (error: unknown): Error => error instanceof Error ? error : new Error(String(error))

/** Validates the frame clock fields of a `record.start` answer (single or per take). */
type StartFields = { startFrame?: unknown; rawStartFrame?: unknown; compensationFrames?: unknown; compensationKnown?: unknown }
function parseStart(value: StartFields | undefined, rateValue: unknown, expectedRate: number): StartResult {
  if (typeof value?.startFrame !== 'number' || !Number.isSafeInteger(value.startFrame)) throw new Error('네이티브 엔진이 녹음 시작 위치를 반환하지 않았습니다.')
  const rate = rateValue === undefined ? expectedRate : rateValue
  if (typeof rate !== 'number' || !Number.isSafeInteger(rate) || rate !== expectedRate) throw new Error('녹음 장치와 프로젝트의 샘플레이트가 일치하지 않습니다.')
  const rawStartFrame = safeFrame(value.rawStartFrame), compensationFrames = safeFrame(value.compensationFrames)
  if (rawStartFrame !== undefined && compensationFrames !== undefined && rawStartFrame - compensationFrames !== value.startFrame) throw new Error('녹음 위치와 드라이버 지연 보정 값이 일치하지 않습니다.')
  return { startFrame: value.startFrame, sampleRate: rate, rawStartFrame, compensationFrames, compensationKnown: typeof value.compensationKnown === 'boolean' ? value.compensationKnown : undefined }
}

/**
 * Matches the lifetime of the browser recorder (ready → start → stop → one completion), but
 * the native engine owns the audio clock. Subclasses choose the request and its result shape.
 */
abstract class NativeCapture {
  private state: CaptureState = 'ready'
  private startedAt: number | null = null
  private endedAt: number | null = null
  private stopRequested = false
  protected startResult: StartResult | null = null
  private stopTask: Promise<void> | null = null
  protected completedSeconds: number | null = null
  protected get disposed(): boolean { return this.state === 'disposed' }

  constructor(
    protected readonly bridge: NativeAudioBridge,
    protected readonly sampleRate: number,
    private readonly now: () => number,
  ) {}

  protected abstract startParams(): Record<string, unknown>
  /** Throws for an answer that does not describe the requested recording. */
  protected abstract acceptStart(value: unknown): StartResult
  /** Delivers `record.stop`'s answer exactly once; runs only while not disposed. */
  protected abstract complete(value: unknown): void
  protected abstract completeWithError(error: Error): void

  get startedAtMs(): number { return this.startedAt ?? 0 }
  get startFrame(): number | null { return this.startResult?.startFrame ?? null }
  get rawStartFrame(): number | null { return this.startResult?.rawStartFrame ?? null }
  get compensationFrames(): number | null { return this.startResult?.compensationFrames ?? null }
  get compensationKnown(): boolean | null { return this.startResult?.compensationKnown ?? null }
  get elapsedSeconds(): number {
    if (this.completedSeconds !== null) return this.completedSeconds
    return this.startedAt === null ? 0 : Math.max(0, ((this.endedAt ?? this.now()) - this.startedAt) / 1000)
  }

  async start(): Promise<void> {
    if (this.state !== 'ready') throw new DOMException('이 녹음은 다시 시작할 수 없습니다.', 'InvalidStateError')
    this.state = 'starting'
    let acknowledged = false
    try {
      const value = await this.bridge.request('record.start', this.startParams())
      acknowledged = true
      this.startResult = this.acceptStart(value)
      this.startedAt = this.now()
      if (this.disposed) { await this.bridge.request('record.stop'); return }
      this.state = 'recording'
      if (this.stopRequested) this.stop()
    } catch (error) {
      // A successful start with an invalid response must not leave a hidden take running.
      if (acknowledged && !this.startResult) await this.bridge.request('record.stop').catch(() => undefined)
      if (!this.disposed) this.state = 'complete'
      throw error
    }
  }

  stop(): void {
    if (this.state === 'starting') { this.stopRequested = true; return }
    if (this.state !== 'recording') return
    this.state = 'stopping'
    this.endedAt = this.now()
    this.stopTask = this.finish()
    // finish reports errors through onComplete, including useful partial recordings.
    void this.stopTask
  }

  dispose(): void {
    if (this.state === 'disposed') return
    const mustStop = this.state === 'recording'
    this.stopRequested = true
    this.endedAt ??= this.now()
    this.state = 'disposed'
    if (mustStop) void this.bridge.request('record.stop').catch(() => undefined)
  }

  private async finish(): Promise<void> {
    try {
      const result = await this.bridge.request('record.stop')
      if (this.disposed) return
      this.state = 'complete'
      this.complete(result)
    } catch (error) {
      if (this.disposed) return
      this.state = 'complete'
      this.completeWithError(failure(error))
    }
  }

  /** One take's file and its native sample count; the elapsed wall time is only a fallback. */
  protected takeResult(file: Partial<NativeAudioFile> | undefined): AudioRecordingResult {
    if (!(file?.data instanceof Uint8Array) || file.data.byteLength < 44) {
      return { blob: new Blob([], { type: 'audio/wav' }), durationSeconds: this.elapsedSeconds, error: new Error(file?.error || '녹음 파일에 오디오 데이터가 없습니다.') }
    }
    const durationSeconds = typeof file.frames === 'number' && Number.isSafeInteger(file.frames) && file.frames >= 0 && typeof file.sampleRate === 'number' && file.sampleRate === this.startResult?.sampleRate
      ? file.frames / file.sampleRate : this.elapsedSeconds
    return { blob: new Blob([new Uint8Array(file.data)], { type: 'audio/wav' }), durationSeconds, error: file.error ? new Error(file.error) : null }
  }
}

/** One track, the former `record.start { trackId }` request. */
export class NativeRecording extends NativeCapture {
  constructor(
    bridge: NativeAudioBridge,
    private readonly trackId: string,
    private readonly callbacks: AudioRecordingCallbacks,
    sampleRate: number,
    now: () => number = () => performance.now(),
  ) { super(bridge, sampleRate, now) }

  protected startParams(): Record<string, unknown> { return { trackId: this.trackId } }
  protected acceptStart(value: unknown): StartResult {
    const answer = value as (StartFields & { sampleRate?: unknown }) | undefined
    return parseStart(answer, answer?.sampleRate, this.sampleRate)
  }
  protected complete(value: unknown): void {
    const file = value as NativeAudioFile | undefined
    if (!(file?.data instanceof Uint8Array) || file.data.byteLength < 44) { this.completeWithError(new Error('녹음 파일에 오디오 데이터가 없습니다.')); return }
    const result = this.takeResult(file)
    this.completedSeconds = result.durationSeconds
    if (result.error) this.callbacks.onError?.(result.error)
    this.callbacks.onComplete(result)
  }
  protected completeWithError(error: Error): void {
    this.callbacks.onError?.(error)
    this.callbacks.onComplete({ blob: new Blob([], { type: 'audio/wav' }), durationSeconds: this.elapsedSeconds, error })
  }
}

/** One recorded track of a multi-track take: the single-take result plus its track. */
export interface NativeTakeResult extends AudioRecordingResult {
  trackId: string
  takeId?: string
  channels?: number
}
export interface NativeRecordingsCallbacks {
  /** Once, in the requested track order, also when some or all takes failed. */
  onComplete(results: NativeTakeResult[]): void
  /** At most once per session, with the first failure. */
  onError?(error: Error): void
}

/**
 * Several tracks recorded from the same transport frame (`record.start { takes }`). Each
 * track writes its own file from its own input; they start and stop together.
 */
export class NativeRecordings extends NativeCapture {
  private takes: NativeRecordingTake[] = []

  constructor(
    bridge: NativeAudioBridge,
    readonly trackIds: readonly string[],
    private readonly callbacks: NativeRecordingsCallbacks,
    sampleRate: number,
    now: () => number = () => performance.now(),
  ) {
    super(bridge, sampleRate, now)
    if (!trackIds.length || new Set(trackIds).size !== trackIds.length) throw new Error('녹음할 트랙이 없거나 중복되었습니다.')
  }

  /** Per-take native metadata (take ID, channel count) once started. */
  get startedTakes(): readonly NativeRecordingTake[] { return this.takes }

  protected startParams(): Record<string, unknown> { return { takes: this.trackIds.map(trackId => ({ trackId })) } }
  protected acceptStart(value: unknown): StartResult {
    const answer = value as { takes?: unknown; sampleRate?: unknown } | undefined
    const takes = Array.isArray(answer?.takes) ? answer.takes as Partial<NativeRecordingTake>[] : []
    if (takes.length !== this.trackIds.length || !this.trackIds.every(id => takes.some(take => take?.trackId === id))) throw new Error('네이티브 엔진이 요청한 트랙의 녹음을 모두 시작하지 않았습니다.')
    const starts = takes.map(take => parseStart(take, answer?.sampleRate, this.sampleRate))
    // One transport start for every take: a different frame would misalign the recorded tracks.
    if (starts.some(start => start.startFrame !== starts[0].startFrame)) throw new Error('녹음 테이크의 시작 위치가 서로 다릅니다.')
    this.takes = this.trackIds.map(id => {
      const take = takes.find(item => item.trackId === id)!
      return { trackId: id, takeId: typeof take.takeId === 'string' ? take.takeId : '', channels: typeof take.channels === 'number' ? take.channels : 0,
        startFrame: starts[0].startFrame, rawStartFrame: starts[0].rawStartFrame ?? starts[0].startFrame, compensationFrames: starts[0].compensationFrames ?? 0, compensationKnown: starts[0].compensationKnown ?? false }
    })
    return starts[0]
  }
  protected complete(value: unknown): void {
    const files = Array.isArray((value as { takes?: unknown } | undefined)?.takes) ? (value as { takes: (Partial<NativeAudioFile> & { trackId?: unknown })[] }).takes : []
    const results = this.trackIds.map((trackId): NativeTakeResult => {
      const file = files.find(item => item?.trackId === trackId)
      const result = this.takeResult(file ?? { error: '네이티브 엔진이 이 트랙의 녹음 결과를 보내지 않았습니다.' })
      return { ...result, trackId, ...(typeof file?.takeId === 'string' ? { takeId: file.takeId } : {}), ...(typeof file?.channels === 'number' ? { channels: file.channels } : {}) }
    })
    this.completedSeconds = Math.max(0, ...results.map(result => result.durationSeconds))
    const error = results.find(result => result.error)?.error
    if (error) this.callbacks.onError?.(error)
    this.callbacks.onComplete(results)
  }
  protected completeWithError(error: Error): void {
    this.callbacks.onError?.(error)
    this.callbacks.onComplete(this.trackIds.map(trackId => ({ trackId, blob: new Blob([], { type: 'audio/wav' }), durationSeconds: this.elapsedSeconds, error })))
  }
}

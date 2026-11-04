import type { AudioRecordingCallbacks } from '../AudioRecording'
import type { NativeAudioBridge, NativeAudioFile } from './contracts'

/** Matches the lifetime of the browser recorder, but the native engine owns the audio clock. */
export class NativeRecording {
  private state: 'ready' | 'starting' | 'recording' | 'stopping' | 'complete' | 'disposed' = 'ready'
  private startedAt: number | null = null
  private endedAt: number | null = null
  private stopRequested = false
  private startResult: { startFrame: number; sampleRate: number; rawStartFrame?: number; compensationFrames?: number; compensationKnown?: boolean } | null = null
  private stopTask: Promise<void> | null = null
  private completedSeconds: number | null = null
  private get disposed(): boolean { return this.state === 'disposed' }

  constructor(
    private readonly bridge: NativeAudioBridge,
    private readonly trackId: string,
    private readonly callbacks: AudioRecordingCallbacks,
    private readonly sampleRate: number,
    private readonly now: () => number = () => performance.now(),
  ) {}

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
      const value = await this.bridge.request('record.start', { trackId: this.trackId }) as { startFrame?: unknown; sampleRate?: unknown; rawStartFrame?: unknown; compensationFrames?: unknown; compensationKnown?: unknown }
      acknowledged = true
      if (typeof value?.startFrame !== 'number' || !Number.isSafeInteger(value.startFrame)) {
        throw new Error('네이티브 엔진이 녹음 시작 위치를 반환하지 않았습니다.')
      }
      const rate = value.sampleRate === undefined ? this.sampleRate : value.sampleRate
      if (typeof rate !== 'number' || !Number.isSafeInteger(rate) || rate !== this.sampleRate) throw new Error('녹음 장치와 프로젝트의 샘플레이트가 일치하지 않습니다.')
      const rawStartFrame = typeof value.rawStartFrame === 'number' && Number.isSafeInteger(value.rawStartFrame) && value.rawStartFrame >= 0 ? value.rawStartFrame : undefined
      const compensationFrames = typeof value.compensationFrames === 'number' && Number.isSafeInteger(value.compensationFrames) && value.compensationFrames >= 0 ? value.compensationFrames : undefined
      if (rawStartFrame !== undefined && compensationFrames !== undefined && rawStartFrame - compensationFrames !== value.startFrame) throw new Error('녹음 위치와 드라이버 지연 보정 값이 일치하지 않습니다.')
      this.startResult = { startFrame: value.startFrame, sampleRate: rate, rawStartFrame, compensationFrames, compensationKnown: typeof value.compensationKnown === 'boolean' ? value.compensationKnown : undefined }
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
      const result = await this.bridge.request('record.stop') as NativeAudioFile
      if (this.disposed) return
      if (!(result?.data instanceof Uint8Array) || result.data.byteLength < 44) throw new Error('녹음 파일에 오디오 데이터가 없습니다.')
      const durationSeconds = typeof result.frames === 'number' && Number.isSafeInteger(result.frames) && result.frames >= 0 && typeof result.sampleRate === 'number' && result.sampleRate === this.startResult?.sampleRate
        ? result.frames / result.sampleRate : this.elapsedSeconds
      this.completedSeconds = durationSeconds
      const error = result.error ? new Error(result.error) : null
      this.state = 'complete'
      if (error) this.callbacks.onError?.(error)
      this.callbacks.onComplete({ blob: new Blob([new Uint8Array(result.data)], { type: 'audio/wav' }), durationSeconds, error })
    } catch (error) {
      if (this.disposed) return
      this.state = 'complete'
      const failure = error instanceof Error ? error : new Error(String(error))
      this.callbacks.onError?.(failure)
      this.callbacks.onComplete({ blob: new Blob([], { type: 'audio/wav' }), durationSeconds: this.elapsedSeconds, error: failure })
    }
  }
}

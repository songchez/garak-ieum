export interface AudioRecordingResult {
  blob: Blob
  durationSeconds: number
  error: Error | null
}

export interface AudioRecordingCallbacks {
  onComplete(result: AudioRecordingResult): void
  onError?(error: Error): void
}

type RecordingState = 'ready' | 'recording' | 'stopping' | 'complete' | 'disposed'

/** Owns one recording through its final dataavailable event, including partial results after an error. */
export class AudioRecording {
  private state: RecordingState = 'ready'
  private chunks: Blob[] = []
  private startedAt: number | null = null
  private endedAt: number | null = null
  private error: Error | null = null

  constructor(
    private readonly recorder: MediaRecorder,
    private readonly callbacks: AudioRecordingCallbacks,
    private readonly now: () => number = () => performance.now(),
  ) {}

  get startedAtMs(): number { return this.startedAt ?? 0 }

  get elapsedSeconds(): number {
    return this.startedAt === null ? 0 : Math.max(0, ((this.endedAt ?? this.now()) - this.startedAt) / 1000)
  }

  start(): void {
    if (this.state !== 'ready') throw new DOMException('이 녹음은 다시 시작할 수 없습니다.', 'InvalidStateError')
    this.recorder.ondataavailable = this.onData
    this.recorder.onstop = this.onStop
    this.recorder.onerror = this.onError
    this.startedAt = this.now()
    this.state = 'recording'
    try {
      this.recorder.start(100)
    } catch (error) {
      this.dispose()
      this.startedAt = null
      this.endedAt = null
      throw error
    }
  }

  stop(): void {
    if (this.state !== 'recording') return
    this.finishClock()
    this.state = 'stopping'
    // Native stop/errors may have made the recorder inactive while its last
    // dataavailable and stop events are still queued. Keep owning those events.
    if (this.recorder.state !== 'inactive') this.recorder.stop()
  }

  dispose(): void {
    if (this.state === 'disposed') return
    this.finishClock()
    this.state = 'disposed'
    this.detach()
    this.chunks = []
    if (this.recorder.state !== 'inactive') {
      try { this.recorder.stop() } catch { /* disposal must not revive or complete a discarded recording */ }
    }
  }

  private get pending(): boolean { return this.state === 'recording' || this.state === 'stopping' }

  private finishClock(): void {
    if (this.startedAt !== null && this.endedAt === null) this.endedAt = this.now()
  }

  private readonly onData = (event: BlobEvent): void => {
    if (this.pending && event.data.size) this.chunks.push(event.data)
  }

  private readonly onError = (event: Event): void => {
    if (!this.pending) return
    const details = event as Event & { error?: unknown; message?: string }
    const error = details.error instanceof Error || details.error instanceof DOMException
      ? details.error
      : new Error(details.message || '녹음 중 오류가 발생했습니다.')
    this.error ??= error
    this.finishClock()
    // A recorder error is followed by its final data and stop. Completing here
    // would discard that last chunk and can make a useful partial take undecodable.
    this.callbacks.onError?.(error)
  }

  private readonly onStop = (): void => {
    if (!this.pending) return
    this.finishClock()
    this.state = 'complete'
    this.detach()
    const blob = new Blob(this.chunks, { type: this.recorder.mimeType || this.chunks.find(chunk => chunk.type)?.type || '' })
    this.chunks = []
    // Empty recordings are results too: the caller can explain why no region
    // was added and release its input/busy state on the same completion path.
    this.callbacks.onComplete({ blob, durationSeconds: this.elapsedSeconds, error: this.error })
  }

  private detach(): void {
    if (this.recorder.ondataavailable === this.onData) this.recorder.ondataavailable = null
    if (this.recorder.onstop === this.onStop) this.recorder.onstop = null
    if (this.recorder.onerror === this.onError) this.recorder.onerror = null
  }
}

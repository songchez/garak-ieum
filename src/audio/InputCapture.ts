import type { InputState } from '../core/audioSettings'

type InputConsumer = 'monitor' | 'record'
export interface PreparedInput {
  stream: MediaStream | null
  commit(): void
  rollback(): void
}

/** One microphone shared by monitoring and recording, including permission requests in flight. */
export class InputCapture {
  private stream: MediaStream | null = null
  private pending: Promise<MediaStream> | null = null
  private consumers = new Set<InputConsumer>()
  private generation = 0
  private listeners = new Set<() => void>()
  private snapshot: InputState = { status: 'idle', deviceLabel: null, settings: null, error: null }
  private removeEndedListener: (() => void) | null = null
  private preparation = 0
  private preparedStreams = new Set<MediaStream>()

  constructor(private readonly open: () => Promise<MediaStream>) {}

  readonly getInputState = (): InputState => this.snapshot
  readonly subscribeInputState = (callback: () => void): (() => void) => {
    this.listeners.add(callback)
    return () => { this.listeners.delete(callback) }
  }

  private publish(status: InputState['status'], error: string | null = null): void {
    const track = this.stream?.getAudioTracks?.()[0] ?? this.stream?.getTracks()[0]
    this.snapshot = { status, error, deviceLabel: track?.label || null, settings: track?.getSettings?.() ?? null }
    for (const listener of this.listeners) listener()
  }

  /** Declare demand before awaiting audio-context resume or microphone permission. */
  setNeeded(consumer: InputConsumer, needed: boolean): void {
    const hadConsumers = this.consumers.size > 0
    if (needed) this.consumers.add(consumer)
    else this.consumers.delete(consumer)
    if (!this.consumers.size) {
      // A later I/Record request may use different device preferences. It must
      // never adopt a permission reply opened before the last owner released it.
      if (hadConsumers) {
        this.generation += 1
        this.pending = null
        this.cancelPreparation()
      }
      this.releaseStream()
    }
  }

  acquire(): Promise<MediaStream> {
    if (!this.consumers.size) return Promise.reject(this.cancelled())
    if (this.stream?.active) return Promise.resolve(this.stream)
    if (this.pending) return this.pending
    this.releaseStream()
    const generation = this.generation
    this.publish('requesting')
    const pending = Promise.resolve().then(() => {
      if (generation !== this.generation || !this.consumers.size) throw this.cancelled()
      return this.open()
    }).then(stream => {
      // Permission can finish after I is turned off or after the owning app unmounts.
      if (generation !== this.generation || !this.consumers.size) {
        this.stop(stream)
        throw this.cancelled()
      }
      this.acceptStream(stream)
      return stream
    }).catch(error => {
      if (generation === this.generation && this.consumers.size) this.publish('error', error instanceof Error ? error.message : String(error))
      throw error
    }).finally(() => {
      // An old, cancelled permission request must not clear a newer request.
      if (this.pending === pending) this.pending = null
    })
    this.pending = pending
    return pending
  }

  /** Prepare a settings change without replacing a working input or opening an unused microphone. */
  async prepare(open: () => Promise<MediaStream>): Promise<PreparedInput> {
    this.cancelPreparation()
    const request = this.preparation
    const generation = this.generation
    const current = () => request === this.preparation && generation === this.generation
    let candidate: MediaStream | null = null
    if (this.consumers.size) {
      candidate = await open()
      if (!current()) { this.stop(candidate); throw this.cancelled() }
      if (!this.consumers.size) { this.stop(candidate); candidate = null }
      else this.preparedStreams.add(candidate)
    }
    let settled = false
    const discard = () => { if (candidate && this.preparedStreams.delete(candidate)) this.stop(candidate) }
    return {
      stream: candidate,
      commit: () => {
        if (settled) return
        settled = true
        if (!current()) { discard(); throw this.cancelled() }
        if (candidate && !candidate.active) { discard(); throw new Error('선택한 입력 장치 연결이 종료되어 설정을 적용하지 못했습니다.') }
        this.generation += 1
        this.pending = null
        this.releaseStream()
        if (candidate) {
          this.preparedStreams.delete(candidate)
          if (this.consumers.size) this.acceptStream(candidate)
          else this.stop(candidate)
        }
      },
      rollback: () => { if (!settled) { settled = true; discard() } },
    }
  }

  private acceptStream(stream: MediaStream): void {
    this.stream = stream
    const track = stream.getAudioTracks?.()[0] ?? stream.getTracks()[0]
    const ended = () => {
      if (this.stream !== stream) return
      this.releaseStream()
      this.publish('error', '입력 장치 연결이 종료되었습니다. 장치를 확인하고 다시 연결해 주세요.')
    }
    track?.addEventListener?.('ended', ended)
    this.removeEndedListener = () => track?.removeEventListener?.('ended', ended)
    this.publish('active')
  }

  private cancelPreparation(): void {
    this.preparation += 1
    for (const stream of this.preparedStreams) this.stop(stream)
    this.preparedStreams.clear()
  }

  /** Invalidates late permission replies; a subsequent explicit request may reuse this service. */
  dispose(): void {
    this.cancelPreparation()
    this.generation += 1
    this.consumers.clear()
    this.pending = null
    this.releaseStream()
  }

  private releaseStream(): void {
    this.removeEndedListener?.()
    this.removeEndedListener = null
    if (this.stream) this.stop(this.stream)
    this.stream = null
    this.publish('idle')
  }

  private stop(stream: MediaStream): void {
    for (const track of stream.getTracks()) track.stop()
  }

  private cancelled(): DOMException {
    return new DOMException('Microphone input is no longer needed.', 'AbortError')
  }
}

type InputConsumer = 'monitor' | 'record'

/** One microphone shared by monitoring and recording, including permission requests in flight. */
export class InputCapture {
  private stream: MediaStream | null = null
  private pending: Promise<MediaStream> | null = null
  private consumers = new Set<InputConsumer>()
  private generation = 0

  constructor(private readonly open: () => Promise<MediaStream>) {}

  /** Declare demand before awaiting audio-context resume or microphone permission. */
  setNeeded(consumer: InputConsumer, needed: boolean): void {
    if (needed) this.consumers.add(consumer)
    else this.consumers.delete(consumer)
    if (!this.consumers.size) this.releaseStream()
  }

  acquire(): Promise<MediaStream> {
    if (!this.consumers.size) return Promise.reject(this.cancelled())
    if (this.stream?.active) return Promise.resolve(this.stream)
    if (this.pending) return this.pending
    this.releaseStream()
    const generation = this.generation
    const pending = Promise.resolve().then(() => {
      if (generation !== this.generation || !this.consumers.size) throw this.cancelled()
      return this.open()
    }).then(stream => {
      // Permission can finish after I is turned off or after the owning app unmounts.
      if (generation !== this.generation || !this.consumers.size) {
        this.stop(stream)
        throw this.cancelled()
      }
      this.stream = stream
      return stream
    }).finally(() => {
      // An old, cancelled permission request must not clear a newer request.
      if (this.pending === pending) this.pending = null
    })
    this.pending = pending
    return pending
  }

  /** Invalidates late permission replies; a subsequent explicit request may reuse this service. */
  dispose(): void {
    this.generation += 1
    this.consumers.clear()
    this.pending = null
    this.releaseStream()
  }

  private releaseStream(): void {
    if (this.stream) this.stop(this.stream)
    this.stream = null
  }

  private stop(stream: MediaStream): void {
    for (const track of stream.getTracks()) track.stop()
  }

  private cancelled(): DOMException {
    return new DOMException('Microphone input is no longer needed.', 'AbortError')
  }
}

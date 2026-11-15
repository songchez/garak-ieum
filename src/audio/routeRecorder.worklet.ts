// Records one routed track input (docs/TRACK_INPUT_ROUTING.md) sample-exactly on the audio thread.
declare const currentFrame: number
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
}
declare function registerProcessor(name: string, constructor: typeof AudioWorkletProcessor): void

const CHUNK = 8192

/**
 * Messages in: { type: 'start', frame } records from that context frame (or the first block after it
 * arrives, whichever is later); { type: 'stop', frame? } ends before that frame (default: now).
 * Messages out: { type: 'started', frame } with the context frame of the first recorded sample,
 * { type: 'chunk', left, right } (transferred), and { type: 'done', frames } once.
 */
class RouteRecorderProcessor extends AudioWorkletProcessor {
  private state: 'idle' | 'armed' | 'recording' | 'done' = 'idle'
  private startAt = 0
  private stopAt = Number.POSITIVE_INFINITY
  private left = new Float32Array(CHUNK)
  private right = new Float32Array(CHUNK)
  private fill = 0
  private frames = 0

  constructor(options?: unknown) {
    super(options)
    this.port.onmessage = (event: MessageEvent<{ type: string; frame?: number }>) => {
      const message = event.data
      if (message.type === 'start' && this.state === 'idle') { this.startAt = Math.max(0, Math.floor(message.frame ?? 0)); this.state = 'armed' }
      else if (message.type === 'stop') {
        this.stopAt = typeof message.frame === 'number' ? Math.floor(message.frame) : currentFrame
        if (this.state === 'idle' || this.state === 'armed') this.finish()
      }
    }
  }

  private flush(): void {
    if (!this.fill) return
    const left = this.left.slice(0, this.fill), right = this.right.slice(0, this.fill)
    this.port.postMessage({ type: 'chunk', left, right }, [left.buffer, right.buffer])
    this.fill = 0
  }

  private finish(): void {
    this.flush()
    this.state = 'done'
    this.port.postMessage({ type: 'done', frames: this.frames })
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.state === 'done') return false
    if (this.state === 'idle') return true
    const input = inputs[0] ?? []
    const length = input[0]?.length ?? 128
    const blockEnd = currentFrame + length
    if (this.state === 'armed') {
      if (blockEnd <= this.startAt) return true
      this.state = 'recording'
      this.startAt = Math.max(this.startAt, currentFrame)
      this.port.postMessage({ type: 'started', frame: this.startAt })
    }
    const from = Math.max(this.startAt, currentFrame) - currentFrame
    const to = Math.min(this.stopAt, blockEnd) - currentFrame
    const left = input[0], right = input[1] ?? input[0]
    for (let i = from; i < to; i += 1) {
      this.left[this.fill] = left ? left[i] : 0
      this.right[this.fill] = right ? right[i] : 0
      this.fill += 1
      this.frames += 1
      if (this.fill === CHUNK) this.flush()
    }
    if (blockEnd >= this.stopAt) this.finish()
    return (this.state as string) !== 'done'
  }
}

registerProcessor('garak-route-recorder', RouteRecorderProcessor)

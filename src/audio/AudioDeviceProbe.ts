export interface AudioProbeSnapshot {
  status: 'idle' | 'requesting' | 'active' | 'error'
  /** Normalized RMS input level; this probe never connects to the speakers. */
  level: number
  label: string | null
  settings: MediaTrackSettings | null
  error: string | null
}

interface ProbeDependencies {
  open: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  createContext: () => AudioContext
  requestFrame: (callback: FrameRequestCallback) => number
  cancelFrame: (id: number) => void
}

const idle = (): AudioProbeSnapshot => ({ status: 'idle', level: 0, label: null, settings: null, error: null })

export function audioDeviceError(error: unknown): string {
  const name = error instanceof Error || error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return '오디오 장치 접근이 허용되지 않았습니다. 브라우저의 마이크·출력 권한을 확인해주세요.'
  if (name === 'NotFoundError') return '선택한 오디오 장치를 찾을 수 없습니다. 연결 상태를 확인하고 장치 목록을 새로고침해주세요.'
  if (name === 'NotReadableError') return '오디오 장치를 열 수 없습니다. 다른 앱의 사용 여부와 운영체제 오디오 설정을 확인해주세요.'
  if (name === 'OverconstrainedError') return '이 장치가 요청한 입력 설정을 지원하지 않습니다. 채널 수나 입력 장치를 바꿔주세요.'
  if (name === 'NotSupportedError') return '현재 브라우저에서 이 오디오 기능을 사용할 수 없습니다.'
  if (name === 'InvalidStateError') return '설정 창의 버튼을 다시 눌러 오디오 장치를 선택해주세요.'
  return error instanceof Error && error.message ? error.message : '오디오 장치에 연결하지 못했습니다.'
}

/** A temporary input shared by permission discovery and the silent input meter. */
export class AudioDeviceProbe {
  private snapshot: AudioProbeSnapshot = idle()
  private listeners = new Set<() => void>()
  private constraintsKey = ''
  private generation = 0
  private testGeneration = 0
  private leases = new Set<symbol>()
  private testLease: symbol | null = null
  private stream: MediaStream | null = null
  private pending: Promise<MediaStream | null> | null = null
  private testPending: Promise<void> | null = null
  private context: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private analyser: AnalyserNode | null = null
  private frame: number | null = null
  private removeEnded: (() => void) | null = null

  constructor(private readonly deps: ProbeDependencies = {
    open: constraints => {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return Promise.reject(new DOMException('Microphone access is unavailable.', 'NotSupportedError'))
      return navigator.mediaDevices.getUserMedia(constraints)
    },
    createContext: () => {
      if (typeof AudioContext === 'undefined') throw new DOMException('Audio metering is unavailable.', 'NotSupportedError')
      return new AudioContext({ latencyHint: 'interactive' })
    },
    requestFrame: callback => requestAnimationFrame(callback),
    cancelFrame: id => cancelAnimationFrame(id),
  }) {}

  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  getSnapshot = (): AudioProbeSnapshot => this.snapshot

  /** Changing capture settings invalidates every earlier permission response. */
  configure(constraints: MediaStreamConstraints): void {
    const key = JSON.stringify(constraints)
    if (key === this.constraintsKey) return
    this.constraintsKey = key
    this.dispose()
  }

  async requestAccess(constraints: MediaStreamConstraints, whilePermitted: () => Promise<void>): Promise<void> {
    this.configure(constraints)
    const lease = Symbol('device-access')
    this.leases.add(lease)
    try {
      const stream = await this.acquire(constraints)
      if (stream && this.leases.has(lease)) await whilePermitted()
    } finally {
      this.release(lease)
    }
  }

  start(constraints: MediaStreamConstraints): Promise<void> {
    this.configure(constraints)
    if (this.snapshot.status === 'active') return Promise.resolve()
    if (this.testPending) return this.testPending
    this.stop()
    const lease = Symbol('input-test')
    const generation = this.testGeneration
    this.testLease = lease
    this.leases.add(lease)
    this.publish({ ...idle(), status: 'requesting' })
    const current = () => generation === this.testGeneration && this.testLease === lease
    const pending = (async () => {
      try {
        // Resume starts in the user's button event, before waiting for microphone permission.
        const context = this.deps.createContext()
        this.context = context
        const resume = context.resume()
        const [stream] = await Promise.all([this.acquire(constraints), resume])
        if (!stream || !current()) return
        const track = stream.getAudioTracks()[0]
        if (!track || track.readyState === 'ended') throw new DOMException('Input ended.', 'NotReadableError')
        const source = context.createMediaStreamSource(stream)
        const analyser = context.createAnalyser()
        analyser.fftSize = 1024
        source.connect(analyser)
        // AnalyserNode works without an output connection: no microphone monitoring.
        this.source = source
        this.analyser = analyser
        this.publish({ status: 'active', level: 0, label: track.label || null, settings: track.getSettings(), error: null })
        const samples = new Float32Array(analyser.fftSize)
        let lastPaint = -Infinity
        const read: FrameRequestCallback = time => {
          if (!current()) return
          if (time - lastPaint >= 50) {
            analyser.getFloatTimeDomainData(samples)
            let sum = 0
            for (const value of samples) sum += value * value
            const rms = Math.sqrt(sum / samples.length)
            const level = Number.isFinite(rms) ? Math.min(1, rms) : 0
            if (Math.abs(level - this.snapshot.level) >= .002 || (level === 0 && this.snapshot.level !== 0)) this.publish({ ...this.snapshot, level })
            lastPaint = time
          }
          this.frame = this.deps.requestFrame(read)
        }
        this.frame = this.deps.requestFrame(read)
      } catch (error) {
        if (!current()) return
        this.cleanupMeter()
        this.testLease = null
        this.release(lease)
        this.publish({ ...idle(), status: 'error', error: audioDeviceError(error) })
      }
    })().finally(() => {
      if (this.testPending === pending) this.testPending = null
    })
    this.testPending = pending
    return pending
  }

  stop(): void {
    this.testGeneration += 1
    this.testPending = null
    this.cleanupMeter()
    const lease = this.testLease
    this.testLease = null
    if (lease) this.release(lease)
    this.publish(idle())
  }

  /** Reusable after disposal, including React's development effect replay. */
  dispose(): void {
    this.stop()
    this.leases.clear()
    this.releaseCapture()
  }

  private acquire(constraints: MediaStreamConstraints): Promise<MediaStream | null> {
    if (this.stream?.active) return Promise.resolve(this.stream)
    if (this.pending) return this.pending
    const generation = this.generation
    const current = () => generation === this.generation && this.leases.size > 0
    let request: Promise<MediaStream>
    try { request = this.deps.open(constraints) } catch (error) { request = Promise.reject(error) }
    const pending = request.then(stream => {
      if (!current()) { this.stopTracks(stream); return null }
      const tracks = stream.getAudioTracks()
      if (!tracks.length || tracks.every(track => track.readyState === 'ended')) {
        this.stopTracks(stream)
        throw new DOMException('No live microphone track.', 'NotFoundError')
      }
      this.stream = stream
      const ended = () => {
        if (this.stream !== stream) return
        const testing = this.testLease !== null
        this.dispose()
        if (testing) this.publish({ ...idle(), status: 'error', error: '입력 장치 연결이 끊어졌습니다. 장치를 다시 연결하고 입력 테스트를 시작해주세요.' })
      }
      for (const track of tracks) track.addEventListener('ended', ended)
      this.removeEnded = () => { for (const track of tracks) track.removeEventListener('ended', ended) }
      return stream
    }).catch(error => {
      if (!current()) return null
      throw error
    }).finally(() => {
      if (this.pending === pending) this.pending = null
    })
    this.pending = pending
    return pending
  }

  private release(lease: symbol): void {
    this.leases.delete(lease)
    if (!this.leases.size) this.releaseCapture()
  }

  private releaseCapture(): void {
    this.generation += 1
    this.pending = null
    this.removeEnded?.()
    this.removeEnded = null
    if (this.stream) this.stopTracks(this.stream)
    this.stream = null
  }

  private cleanupMeter(): void {
    if (this.frame !== null) this.deps.cancelFrame(this.frame)
    this.frame = null
    try { this.source?.disconnect() } catch { /* already disconnected */ }
    try { this.analyser?.disconnect() } catch { /* already disconnected */ }
    this.source = null
    this.analyser = null
    const context = this.context
    this.context = null
    if (context && context.state !== 'closed') {
      try { void context.close().catch(() => {}) } catch { /* browser already released it */ }
    }
  }

  private stopTracks(stream: MediaStream): void { for (const track of stream.getTracks()) track.stop() }
  private publish(snapshot: AudioProbeSnapshot): void { this.snapshot = snapshot; for (const listener of this.listeners) listener() }
}

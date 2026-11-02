import {
  BRIDGE_PROTOCOL_VERSION, MAX_BRIDGE_MESSAGE_BYTES, MAX_BRIDGE_REQUEST_MS,
  BridgeError, errorData, isBridgeError, isBridgeId, isBridgeToken, isDawMethod, isRecord,
  validateBridgeUrl, type BridgeParams, type BridgeRequest, type BridgeResponse, type DawMethod,
} from './protocol'

export interface BridgeSnapshot {
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  url?: string
  message?: string
}
export interface BridgeRequestContext { signal: AbortSignal; requestId: string; deadline: number }
export type DawBridgeHandler = (method: DawMethod, params: BridgeParams, context: BridgeRequestContext) => Promise<unknown> | unknown
interface QueuedRequest { request: BridgeRequest; controller: AbortController }

/** One explicitly paired tab. No token persistence, global application hook, or arbitrary execution. */
export class DawBridgeClient {
  private snapshot: BridgeSnapshot = { status: 'disconnected' }
  private listeners = new Set<() => void>()
  private socket: WebSocket | null = null
  private generation = 0
  private authenticated = false
  private authTimer: ReturnType<typeof setTimeout> | undefined
  private drainTimer: ReturnType<typeof setTimeout> | undefined
  private drainingGeneration: number | null = null
  private pending = new Map<string, QueuedRequest>()
  private queue: string[] = []

  constructor(private readonly handler: DawBridgeHandler) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getSnapshot = (): BridgeSnapshot => this.snapshot

  connect({ url, token, instanceId }: { url: string; token: string; instanceId: string }): void {
    const safeUrl = validateBridgeUrl(url)
    if (!isBridgeToken(token)) throw new BridgeError('INVALID_TOKEN', '연결 토큰은 32~256자의 영문·숫자·밑줄·하이픈이어야 합니다.')
    if (!isBridgeId(instanceId)) throw new BridgeError('INVALID_INSTANCE_ID', '올바른 DAW 인스턴스 ID가 필요합니다.')
    this.disconnect()
    const generation = this.generation
    this.update({ status: 'connecting', url: safeUrl })
    let socket: WebSocket
    try { socket = new WebSocket(safeUrl) }
    catch { this.stop('로컬 브리지에 연결하지 못했습니다.'); return }
    this.socket = socket
    const current = () => this.socket === socket && this.generation === generation
    this.authTimer = setTimeout(() => { if (current()) this.stop('브리지 인증 응답을 기다리는 시간이 초과됐습니다.') }, 6000)
    socket.onopen = () => {
      if (!current()) return
      try { socket.send(JSON.stringify({ type: 'auth', protocol: BRIDGE_PROTOCOL_VERSION, token, instanceId })) }
      catch { this.stop('브리지 인증 요청을 보내지 못했습니다.') }
    }
    socket.onmessage = event => {
      if (!current()) return
      if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).byteLength > MAX_BRIDGE_MESSAGE_BYTES) {
        this.stop('브리지 메시지가 허용 크기나 형식을 벗어났습니다.'); return
      }
      let message: unknown
      try { message = JSON.parse(event.data) }
      catch { this.stop('브리지 메시지를 읽을 수 없습니다.'); return }
      if (!isRecord(message)) { this.stop('올바르지 않은 브리지 메시지입니다.'); return }
      if (message.type === 'error' && isBridgeError(message.error)) { this.stop(message.error.message); return }
      if (!this.authenticated) {
        if (message.type !== 'ready' || message.protocol !== BRIDGE_PROTOCOL_VERSION) { this.stop('브리지 인증 또는 버전이 일치하지 않습니다.'); return }
        clearTimeout(this.authTimer)
        this.authenticated = true
        this.update({ status: 'connected', url: safeUrl })
        return
      }
      if (message.type === 'cancel' && isBridgeId(message.id)) {
        this.pending.get(message.id)?.controller.abort()
        this.pending.delete(message.id)
        this.queue = this.queue.filter(id => id !== message.id)
        return
      }
      if (message.type !== 'request' || !isBridgeId(message.id) || !isDawMethod(message.method)
        || !isRecord(message.params) || typeof message.deadline !== 'number' || !Number.isSafeInteger(message.deadline)
        || message.deadline > Date.now() + MAX_BRIDGE_REQUEST_MS + 1000 || this.pending.has(message.id)) {
        this.stop('지원하지 않거나 올바르지 않은 DAW 요청입니다.'); return
      }
      if (this.pending.size >= 64) {
        this.respond({ type: 'response', id: message.id, error: { code: 'BRIDGE_BUSY', message: '대기 중인 DAW 요청이 너무 많습니다.' } })
        return
      }
      const request = message as unknown as BridgeRequest
      this.pending.set(request.id, { request, controller: new AbortController() })
      this.queue.push(request.id)
      this.scheduleDrain(generation)
    }
    socket.onerror = () => { if (current()) this.stop('로컬 브리지에 연결하지 못했습니다. 실행 상태·포트·허용된 앱 주소를 확인해주세요.') }
    socket.onclose = () => { if (current()) this.stop('로컬 브리지 연결이 종료됐습니다.') }
  }

  disconnect(): void { this.stop() }

  private update(next: BridgeSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }

  private stop(message?: string): void {
    this.generation++
    clearTimeout(this.authTimer)
    clearTimeout(this.drainTimer)
    this.authTimer = this.drainTimer = undefined
    for (const pending of this.pending.values()) pending.controller.abort()
    this.pending.clear()
    this.queue = []
    this.authenticated = false
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
      socket.close()
    }
    this.update(message ? { status: 'error', message } : { status: 'disconnected' })
  }

  private scheduleDrain(generation: number): void {
    if (this.drainTimer !== undefined || this.drainingGeneration === generation) return
    // Admit requests on a separate task so cancellation/deadline checks happen before a queued edit.
    this.drainTimer = setTimeout(() => { this.drainTimer = undefined; void this.drain(generation) }, 0)
  }

  private async drain(generation: number): Promise<void> {
    if (generation !== this.generation || !this.authenticated) return
    this.drainingGeneration = generation
    try {
      while (this.queue.length && generation === this.generation && this.authenticated) {
        const id = this.queue.shift()!
        const pending = this.pending.get(id)
        if (!pending || pending.controller.signal.aborted) continue
        const { request, controller } = pending
        if (Date.now() >= request.deadline) {
          this.pending.delete(id)
          this.respond({ type: 'response', id, error: { code: 'REQUEST_EXPIRED', message: '실행 전에 요청 시간이 만료됐습니다. 프로젝트 상태를 다시 확인해주세요.' } })
          continue
        }
        try {
          // Current edit handlers commit synchronously. Future async handlers must honor signal before committing.
          const result = await this.handler(request.method, request.params, { signal: controller.signal, requestId: id, deadline: request.deadline })
          if (!controller.signal.aborted && generation === this.generation) this.respond({ type: 'response', id, result: result ?? null })
        } catch (error) {
          if (!controller.signal.aborted && generation === this.generation) this.respond({ type: 'response', id, error: errorData(error) })
        } finally {
          if (this.pending.get(id) === pending) this.pending.delete(id)
        }
      }
    } finally {
      if (this.drainingGeneration === generation) this.drainingGeneration = null
      if (this.queue.length && generation === this.generation) this.scheduleDrain(generation)
    }
  }

  private respond(response: BridgeResponse): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.authenticated) return
    let text: string
    try {
      text = JSON.stringify(response)
      if (new TextEncoder().encode(text).byteLength > MAX_BRIDGE_MESSAGE_BYTES) throw new Error('oversized')
    } catch {
      text = JSON.stringify({ type: 'response', id: response.id, error: { code: 'RESPONSE_TOO_LARGE', message: '결과가 너무 큽니다. 조회 범위를 줄여주세요.' } })
    }
    try { this.socket.send(text) }
    catch { this.stop('DAW 실행 결과를 브리지로 보내지 못했습니다. 상태를 다시 조회해주세요.') }
  }
}

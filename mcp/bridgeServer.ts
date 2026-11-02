import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import {
  BRIDGE_PROTOCOL_VERSION, DEFAULT_BRIDGE_PORT, MAX_BRIDGE_MESSAGE_BYTES, MAX_BRIDGE_REQUEST_MS,
  BridgeError, isBridgeError, isBridgeId, isBridgeToken, isDawMethod, isRecord,
  type BridgeParams, type DawMethod,
} from '../src/automation/protocol.js'

export const ALLOWED_APP_ORIGINS = new Set([
  'http://127.0.0.1:5173', 'http://localhost:5173',
  'http://127.0.0.1:4173', 'http://localhost:4173',
])
interface Instance { instanceId: string; connectedAt: string; socket: WebSocket }
interface Pending {
  socket: WebSocket
  timer: ReturnType<typeof setTimeout>
  cleanupAbort: () => void
  resolve: (value: unknown) => void
  reject: (error: BridgeError) => void
}
export interface DawBridge {
  readonly port: number
  listInstances(): { instanceId: string; connectedAt: string }[]
  request(method: DawMethod, params: BridgeParams, instanceId?: string, signal?: AbortSignal): Promise<unknown>
  close(): Promise<void>
}
export interface BridgeOptions {
  token: string
  port?: number
  requestTimeoutMs?: number
  authTimeoutMs?: number
}

function deny(socket: Socket, status: 403 | 404 | 503): void {
  socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}
function bytes(data: RawData): Buffer {
  return Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data
}
function send(socket: WebSocket, message: unknown): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false
  try { socket.send(JSON.stringify(message)); return true }
  catch { return false }
}

/** Listens only on IPv4 loopback. The HTTP listener is not an MCP endpoint. */
export async function startDawBridge(options: BridgeOptions): Promise<DawBridge> {
  if (!isBridgeToken(options.token)) throw new BridgeError('INVALID_TOKEN', 'GARAK_MCP_TOKEN에 32~256자의 무작위 연결 토큰이 필요합니다.')
  const port = options.port ?? DEFAULT_BRIDGE_PORT
  const requestTimeout = options.requestTimeoutMs ?? 10_000
  const authTimeout = options.authTimeoutMs ?? 3000
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new BridgeError('INVALID_PORT', '브리지 포트가 올바르지 않습니다.')
  if (!Number.isInteger(requestTimeout) || requestTimeout < 20 || requestTimeout > MAX_BRIDGE_REQUEST_MS
    || !Number.isInteger(authTimeout) || authTimeout < 20 || authTimeout > 10_000) throw new BridgeError('INVALID_TIMEOUT', '브리지 대기 시간이 올바르지 않습니다.')
  const tokenHash = createHash('sha256').update(options.token).digest()
  const instances = new Map<string, Instance>()
  const sockets = new Set<WebSocket>()
  const pending = new Map<string, Pending>()
  let closed = false
  let actualPort = port
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000 }, (_request, response) => {
    response.writeHead(404, { 'Connection': 'close', 'Content-Length': '0' })
    response.end()
  })
  server.maxConnections = 32
  const wsServer = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_BRIDGE_MESSAGE_BYTES })

  function settle(id: string, error?: BridgeError, result?: unknown): void {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    clearTimeout(entry.timer)
    entry.cleanupAbort()
    if (error) entry.reject(error)
    else entry.resolve(result)
  }
  function failSocket(socket: WebSocket): void {
    for (const [id, entry] of pending) {
      if (entry.socket === socket) settle(id, new BridgeError('DAW_DISCONNECTED', 'DAW 연결이 종료됐습니다. 적용 여부를 다시 조회해주세요.'))
    }
  }
  function refuse(socket: WebSocket, code: string, message: string): void {
    send(socket, { type: 'error', error: { code, message } })
    socket.close(1008, code)
  }

  server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    if (closed || sockets.size >= 16) { deny(socket, 503); return }
    if (request.url !== '/bridge') { deny(socket, 404); return }
    const host = request.headers.host
    const origin = request.headers.origin
    if (request.method !== 'GET' || !host || ![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(host)
      || typeof origin !== 'string' || !ALLOWED_APP_ORIGINS.has(origin)
      || request.headers['transfer-encoding'] || (request.headers['content-length'] && request.headers['content-length'] !== '0')) {
      deny(socket, 403); return
    }
    wsServer.handleUpgrade(request, socket, head, webSocket => wsServer.emit('connection', webSocket, request))
  })

  wsServer.on('connection', (socket: WebSocket) => {
    sockets.add(socket)
    let instanceId: string | undefined
    const timer = setTimeout(() => refuse(socket, 'AUTH_TIMEOUT', '브리지 인증 시간이 초과됐습니다.'), authTimeout)
    socket.on('error', () => { failSocket(socket); socket.terminate() })
    socket.on('close', () => {
      clearTimeout(timer)
      sockets.delete(socket)
      if (instanceId && instances.get(instanceId)?.socket === socket) instances.delete(instanceId)
      failSocket(socket)
    })
    socket.on('message', (raw: RawData, binary: boolean) => {
      if (binary) { refuse(socket, 'INVALID_MESSAGE', '텍스트 JSON 메시지만 허용합니다.'); return }
      let message: unknown
      try { message = JSON.parse(bytes(raw).toString('utf8')) }
      catch { refuse(socket, 'INVALID_MESSAGE', '올바른 JSON 메시지가 필요합니다.'); return }
      if (!isRecord(message)) { refuse(socket, 'INVALID_MESSAGE', '올바른 브리지 메시지가 필요합니다.'); return }
      if (!instanceId) {
        if (message.type !== 'auth' || message.protocol !== BRIDGE_PROTOCOL_VERSION || !isBridgeToken(message.token)
          || !isBridgeId(message.instanceId) || !timingSafeEqual(createHash('sha256').update(message.token).digest(), tokenHash)) {
          refuse(socket, 'AUTH_FAILED', '브리지 인증에 실패했습니다.'); return
        }
        if (instances.has(message.instanceId)) { refuse(socket, 'INSTANCE_EXISTS', '같은 인스턴스 ID가 이미 연결돼 있습니다.'); return }
        clearTimeout(timer)
        instanceId = message.instanceId
        instances.set(instanceId, { instanceId, connectedAt: new Date().toISOString(), socket })
        send(socket, { type: 'ready', protocol: BRIDGE_PROTOCOL_VERSION })
        return
      }
      if (message.type !== 'response' || !isBridgeId(message.id)
        || (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))
        || (Object.hasOwn(message, 'error') && !isBridgeError(message.error))) {
        refuse(socket, 'INVALID_MESSAGE', '올바른 DAW 실행 결과가 필요합니다.'); return
      }
      const entry = pending.get(message.id)
      if (!entry || entry.socket !== socket) return // Late or foreign results cannot settle another tab's request.
      if (isBridgeError(message.error)) settle(message.id, new BridgeError(message.error.code, message.error.message, message.error.details))
      else settle(message.id, undefined, message.result)
    })
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      server.once('error', onError)
      server.listen(port, '127.0.0.1', () => { server.off('error', onError); resolve() })
    })
  } catch (error) {
    wsServer.close()
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string') throw new BridgeError('LISTEN_FAILED', '브리지 주소를 확인하지 못했습니다.')
  actualPort = address.port
  // Avoid an unhandled server error and fail in-flight operations honestly if the listener fails.
  server.on('error', () => {
    for (const id of [...pending.keys()]) settle(id, new BridgeError('BRIDGE_UNAVAILABLE', '로컬 브리지를 사용할 수 없습니다.'))
  })

  return {
    port: actualPort,
    listInstances: () => [...instances.values()].map(({ instanceId, connectedAt }) => ({ instanceId, connectedAt })).sort((a, b) => a.instanceId.localeCompare(b.instanceId)),
    request(method, params, requestedInstance, signal) {
      if (closed) return Promise.reject(new BridgeError('BRIDGE_CLOSED', '브리지가 종료됐습니다.'))
      if (!isDawMethod(method) || !isRecord(params)) return Promise.reject(new BridgeError('INVALID_REQUEST', '지원하는 DAW 명령과 객체 인자가 필요합니다.'))
      if (signal?.aborted) return Promise.reject(new BridgeError('REQUEST_CANCELLED', '요청이 취소됐습니다.'))
      let instance: Instance | undefined
      if (requestedInstance !== undefined) {
        if (!isBridgeId(requestedInstance)) return Promise.reject(new BridgeError('INVALID_INSTANCE_ID', '올바른 DAW 인스턴스 ID가 필요합니다.'))
        instance = instances.get(requestedInstance)
        if (!instance) return Promise.reject(new BridgeError('INSTANCE_NOT_FOUND', '지정한 DAW 인스턴스가 연결돼 있지 않습니다.'))
      } else {
        if (instances.size === 0) return Promise.reject(new BridgeError('DAW_NOT_CONNECTED', '먼저 가락이음에서 MCP 브리지에 연결해주세요.'))
        if (instances.size !== 1) return Promise.reject(new BridgeError('AMBIGUOUS_INSTANCE', '여러 DAW가 연결돼 있습니다. list_instances로 확인한 instanceId를 지정해주세요.'))
        instance = instances.values().next().value as Instance
      }
      if (pending.size >= 64) return Promise.reject(new BridgeError('BRIDGE_BUSY', '대기 중인 DAW 요청이 너무 많습니다.'))
      const socket = instance.socket
      const id = randomUUID()
      const deadline = Date.now() + requestTimeout
      let text: string
      try { text = JSON.stringify({ type: 'request', id, method, params, deadline }) }
      catch { return Promise.reject(new BridgeError('INVALID_REQUEST', 'JSON으로 전달할 수 없는 인자입니다.')) }
      if (Buffer.byteLength(text) > MAX_BRIDGE_MESSAGE_BYTES) return Promise.reject(new BridgeError('REQUEST_TOO_LARGE', '요청이 너무 큽니다. 편집 또는 조회 범위를 줄여주세요.'))
      return new Promise((resolve, reject) => {
        const cancel = (code: string, message: string) => {
          send(socket, { type: 'cancel', id })
          settle(id, new BridgeError(code, message))
        }
        const onAbort = () => cancel('REQUEST_CANCELLED', '요청이 취소됐습니다. 이미 적용됐는지는 같은 operationId로 다시 확인해주세요.')
        const timer = setTimeout(() => cancel('REQUEST_TIMEOUT', 'DAW 응답 시간이 초과됐습니다. 같은 operationId로 적용 여부를 다시 확인해주세요.'), requestTimeout)
        pending.set(id, { socket, timer, cleanupAbort: () => signal?.removeEventListener('abort', onAbort), resolve, reject })
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) { onAbort(); return }
        if (socket.readyState !== WebSocket.OPEN) { settle(id, new BridgeError('DAW_DISCONNECTED', 'DAW 연결이 종료됐습니다.')); return }
        socket.send(text, error => { if (error) settle(id, new BridgeError('DAW_DISCONNECTED', 'DAW에 요청을 전달하지 못했습니다.')) })
      })
    },
    async close() {
      if (closed) return
      closed = true
      for (const id of [...pending.keys()]) settle(id, new BridgeError('BRIDGE_CLOSED', '브리지가 종료됐습니다.'))
      for (const socket of sockets) socket.terminate()
      instances.clear()
      await Promise.all([
        new Promise<void>(resolve => wsServer.close(() => resolve())),
        new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }),
      ])
    },
  }
}

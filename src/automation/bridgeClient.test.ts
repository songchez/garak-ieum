import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DawBridgeClient, type DawBridgeHandler } from './bridgeClient'
import { DEFAULT_BRIDGE_URL, validateBridgeUrl } from './protocol'

class FakeSocket {
  static OPEN = 1
  static instances: FakeSocket[] = []
  readyState = 0
  sent: Record<string, unknown>[] = []
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  constructor(readonly url: string) { FakeSocket.instances.push(this) }
  send(value: string) { this.sent.push(JSON.parse(value)) }
  open() { this.readyState = 1; this.onopen?.({} as Event) }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent) }
  close() { this.readyState = 3; this.onclose?.({} as CloseEvent) }
}
const token = 'test_pairing_token_0123456789abcdefghijk'
const request = (id: string, method = 'apply_edits', deadline = Date.now() + 1000) => ({ type: 'request', id, method, params: { operationId: id }, deadline })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-02T12:00:00Z'))
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function connected(handler: DawBridgeHandler = vi.fn(() => ({ ok: true }))) {
  const client = new DawBridgeClient(handler)
  client.connect({ url: DEFAULT_BRIDGE_URL, token, instanceId: 'tab-one' })
  const socket = FakeSocket.instances.at(-1)!
  socket.open()
  socket.receive({ type: 'ready', protocol: 1 })
  return { client, socket, handler }
}

describe('DawBridgeClient admission and pairing', () => {
  it('never creates a socket or sends a token to non-loopback URLs', () => {
    const client = new DawBridgeClient(vi.fn())
    for (const url of ['ws://example.com:47831/bridge', 'wss://localhost:47831/bridge', 'ws://127.0.0.1.evil.test:47831/bridge', 'ws://user:secret@127.0.0.1:47831/bridge', 'ws://127.0.0.1:47831/bridge?token=x']) {
      expect(() => client.connect({ url, token, instanceId: 'tab-one' })).toThrow()
    }
    expect(FakeSocket.instances).toHaveLength(0)
    expect(validateBridgeUrl(DEFAULT_BRIDGE_URL)).toBe(DEFAULT_BRIDGE_URL)
  })

  it('sends the token only in the auth frame and waits for the ready acknowledgement', () => {
    const client = new DawBridgeClient(vi.fn())
    const url = 'ws://127.0.0.1:47832/bridge'
    client.connect({ url, token, instanceId: 'tab-one' })
    expect(client.getSnapshot().status).toBe('connecting')
    const socket = FakeSocket.instances[0]
    socket.open()
    expect(socket.url).not.toContain(token)
    expect(socket.sent).toEqual([{ type: 'auth', protocol: 1, token, instanceId: 'tab-one' }])
    expect(client.getSnapshot().status).toBe('connecting')
    socket.receive({ type: 'ready', protocol: 1 })
    expect(client.getSnapshot().status).toBe('connected')
    expect(client.getSnapshot().url).toBe(url)
    client.disconnect()
  })

  it('does not run an expired edit', async () => {
    const { client, socket, handler } = connected()
    socket.receive(request('expired', 'apply_edits', Date.now() - 1))
    await vi.runOnlyPendingTimersAsync()
    expect(handler).not.toHaveBeenCalled()
    expect(socket.sent.at(-1)).toMatchObject({ type: 'response', id: 'expired', error: { code: 'REQUEST_EXPIRED' } })
    client.disconnect()
  })

  it('removes a cancelled queued edit before it reaches the handler', async () => {
    const { client, socket, handler } = connected()
    socket.receive(request('cancelled'))
    socket.receive({ type: 'cancel', id: 'cancelled' })
    await vi.runOnlyPendingTimersAsync()
    expect(handler).not.toHaveBeenCalled()
    expect(socket.sent.filter(item => item.type === 'response')).toEqual([])
    client.disconnect()
  })

  it('disconnect prevents queued edits and signals an admitted async handler', async () => {
    let resolve!: (value: unknown) => void
    let signal: AbortSignal | undefined
    const handler = vi.fn<DawBridgeHandler>((_method, _params, context) => { signal = context.signal; return new Promise(done => { resolve = done }) })
    const { client, socket } = connected(handler)
    socket.receive(request('first', 'get_state'))
    await vi.advanceTimersByTimeAsync(0)
    socket.receive(request('second'))
    client.disconnect()
    expect(signal?.aborted).toBe(true)
    resolve({ ok: true })
    await vi.runOnlyPendingTimersAsync()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(client.getSnapshot().status).toBe('disconnected')
  })

  it('returns structured domain errors without an error stack', async () => {
    const error = Object.assign(new Error('현재 프로젝트가 변경됐습니다.'), { code: 'REVISION_CONFLICT', details: { expected: 2, actual: 3 } })
    const { client, socket } = connected(vi.fn(() => { throw error }))
    socket.receive(request('conflict'))
    await vi.runOnlyPendingTimersAsync()
    expect(socket.sent.at(-1)).toEqual({ type: 'response', id: 'conflict', error: { code: 'REVISION_CONFLICT', message: error.message, details: error.details } })
    client.disconnect()
  })

  it('rejects requests before authentication and never evaluates unknown methods', async () => {
    const handler = vi.fn()
    const client = new DawBridgeClient(handler)
    client.connect({ url: DEFAULT_BRIDGE_URL, token, instanceId: 'tab-one' })
    FakeSocket.instances[0].receive(request('unauthenticated'))
    await vi.runOnlyPendingTimersAsync()
    expect(handler).not.toHaveBeenCalled()
    expect(client.getSnapshot().status).toBe('error')
    const fresh = connected(handler)
    fresh.socket.receive(request('unknown', 'eval'))
    await vi.runOnlyPendingTimersAsync()
    expect(handler).not.toHaveBeenCalled()
    fresh.client.disconnect()
  })
})

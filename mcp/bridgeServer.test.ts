import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startDawBridge, type DawBridge } from './bridgeServer'
import { MAX_BRIDGE_MESSAGE_BYTES } from '../src/automation/protocol'

const TOKEN = 'test_pairing_token_0123456789abcdefghijk'
const ORIGIN = 'http://127.0.0.1:5173'
const bridges: DawBridge[] = []
afterEach(async () => { await Promise.all(bridges.splice(0).map(bridge => bridge.close())) })
async function bridge(options: { requestTimeoutMs?: number; authTimeoutMs?: number } = {}) {
  const value = await startDawBridge({ token: TOKEN, port: 0, ...options })
  bridges.push(value)
  return value
}
function message(socket: WebSocket): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('message timeout')) }, 2000)
    const receive = (data: Buffer) => { cleanup(); resolve(JSON.parse(data.toString())) }
    const fail = (error: Error) => { cleanup(); reject(error) }
    const cleanup = () => { clearTimeout(timer); socket.off('message', receive); socket.off('error', fail) }
    socket.once('message', receive)
    socket.once('error', fail)
  })
}
async function open(value: DawBridge, origin = ORIGIN) {
  const socket = new WebSocket(`ws://127.0.0.1:${value.port}/bridge`, { origin })
  socket.on('error', () => {})
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  return socket
}
async function pair(value: DawBridge, instanceId = 'tab-one', token = TOKEN, origin = ORIGIN) {
  const socket = await open(value, origin)
  const ready = message(socket)
  socket.send(JSON.stringify({ type: 'auth', protocol: 1, token, instanceId }))
  return { socket, reply: await ready }
}
function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('close', receive); reject(new Error('close timeout')) }, 2000)
    const receive = (code: number) => { clearTimeout(timer); resolve(code) }
    socket.once('close', receive)
  })
}
function paddedPacket(packet: Record<string, unknown>, length: number): string {
  const overhead = Buffer.byteLength(JSON.stringify({ ...packet, padding: '' }))
  const text = JSON.stringify({ ...packet, padding: 'x'.repeat(length - overhead) })
  expect(Buffer.byteLength(text)).toBe(length)
  return text
}
async function acknowledgeState(value: DawBridge, socket: WebSocket, instanceId: string, responseBytes?: number): Promise<void> {
  const incoming = message(socket)
  const result = value.request('get_state', {}, instanceId).then(result => ({ result }), error => ({ error }))
  const packet = await incoming
  expect(packet).toMatchObject({ type: 'request', method: 'get_state' })
  const response = { type: 'response', id: packet.id, result: { revision: 7 } }
  socket.send(responseBytes ? paddedPacket(response, responseBytes) : JSON.stringify(response))
  await expect(result).resolves.toEqual({ result: { revision: 7 } })
}

describe('loopback DAW bridge', () => {
  it('requires a strong-format token and fails without an active DAW', async () => {
    await expect(startDawBridge({ token: 'short', port: 0 })).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
    const value = await bridge()
    await expect(value.request('get_state', {})).rejects.toMatchObject({ code: 'DAW_NOT_CONNECTED' })
  })

  it.each([
    { origin: 'https://evil.example', host: undefined },
    { origin: undefined, host: undefined },
    { origin: 'null', host: undefined },
    { origin: 'file://', host: undefined },
    { origin: 'garak://app.evil.example', host: undefined },
    { origin: 'garak://evil@app', host: undefined },
    { origin: 'garak://app:5173', host: undefined },
    { origin: 'garak://app/', host: undefined },
    { origin: 'https://app', host: undefined },
    { origin: ORIGIN, host: 'evil.example' },
    { origin: 'garak://app', host: 'evil.example' },
  ])('rejects an untrusted Origin or Host before WebSocket authentication: %j', async ({ origin, host }) => {
    const value = await bridge()
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${value.port}/bridge`, { ...(origin ? { origin } : {}), ...(host ? { headers: { Host: host } } : {}) })
      socket.on('error', () => {})
      socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode!); socket.terminate() })
      socket.once('open', () => { socket.close(); reject(new Error('Unexpected accepted connection')) })
    })
    expect(status).toBe(403)
    expect(value.listInstances()).toEqual([])
  })

  it('requires authentication for the exact desktop origin and routes acknowledged requests', async () => {
    const value = await bridge()
    const bad = await pair(value, 'bad-desktop', 'incorrect_token_0123456789abcdefghijk', 'garak://app')
    expect(bad.reply).toMatchObject({ type: 'error', error: { code: 'AUTH_FAILED' } })
    expect(value.listInstances()).toEqual([])

    const { socket, reply } = await pair(value, 'desktop-window', TOKEN, 'garak://app')
    expect(reply).toEqual({ type: 'ready', protocol: 1 })
    const incoming = message(socket)
    const result = value.request('get_state', { projectId: 'desktop-project' }, 'desktop-window')
    const packet = await incoming
    expect(packet).toMatchObject({ type: 'request', method: 'get_state', params: { projectId: 'desktop-project' } })
    socket.send(JSON.stringify({ type: 'response', id: packet.id, result: { projectId: 'desktop-project', revision: 4 } }))
    await expect(result).resolves.toEqual({ projectId: 'desktop-project', revision: 4 })
  })

  it('refuses a wrong token and duplicate instance without evicting the legitimate tab', async () => {
    const value = await bridge()
    const bad = await pair(value, 'bad', 'incorrect_token_0123456789abcdefghijk')
    expect(bad.reply).toMatchObject({ type: 'error', error: { code: 'AUTH_FAILED' } })
    const first = await pair(value)
    expect(first.reply).toEqual({ type: 'ready', protocol: 1 })
    const duplicate = await pair(value)
    expect(duplicate.reply).toMatchObject({ type: 'error', error: { code: 'INSTANCE_EXISTS' } })
    expect(value.listInstances().map(item => item.instanceId)).toEqual(['tab-one'])
  })

  it('waits for the selected tab acknowledgement and ignores a foreign result', async () => {
    const value = await bridge()
    const first = await pair(value, 'one')
    const second = await pair(value, 'two')
    await expect(value.request('get_state', {})).rejects.toMatchObject({ code: 'AMBIGUOUS_INSTANCE' })
    await expect(value.request('get_state', {}, 'absent')).rejects.toMatchObject({ code: 'INSTANCE_NOT_FOUND' })
    const incoming = message(first.socket)
    let settled = false
    const result = value.request('get_state', { projectId: 'p' }, 'one').then(value => { settled = true; return value })
    const packet = await incoming
    expect(packet).toMatchObject({ type: 'request', method: 'get_state', params: { projectId: 'p' } })
    second.socket.send(JSON.stringify({ type: 'response', id: packet.id, result: { wrong: true } }))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    first.socket.send(JSON.stringify({ type: 'response', id: packet.id, result: { revision: 3 } }))
    await expect(result).resolves.toEqual({ revision: 3 })
  })

  it('returns a timeout and sends cancellation instead of assuming an edit succeeded', async () => {
    const value = await bridge({ requestTimeoutMs: 40 })
    const { socket } = await pair(value)
    const incoming = message(socket)
    const result = value.request('apply_edits', { operationId: 'edit-1' })
    const failed = expect(result).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
    const packet = await incoming
    const cancelled = message(socket)
    await failed
    expect(await cancelled).toEqual({ type: 'cancel', id: packet.id })
  })

  it('propagates abort and rejects pending requests when the DAW disconnects', async () => {
    const value = await bridge()
    const { socket } = await pair(value)
    const controller = new AbortController()
    const incoming = message(socket)
    const result = value.request('get_state', {}, undefined, controller.signal)
    const rejected = expect(result).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    const packet = await incoming
    const cancelled = message(socket)
    controller.abort()
    await rejected
    expect(await cancelled).toEqual({ type: 'cancel', id: packet.id })
    const next = value.request('get_state', {})
    const disconnected = expect(next).rejects.toMatchObject({ code: 'DAW_DISCONNECTED' })
    socket.close()
    await disconnected
  })

  it('rejects oversized outgoing requests without sending them and accepts the exact incoming size limit', async () => {
    const value = await bridge()
    const { socket } = await pair(value)
    const received: unknown[] = []
    socket.on('message', data => received.push(JSON.parse(data.toString())))
    await expect(value.request('get_state', { large: 'x'.repeat(MAX_BRIDGE_MESSAGE_BYTES) })).rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' })
    await acknowledgeState(value, socket, 'tab-one', MAX_BRIDGE_MESSAGE_BYTES)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ type: 'request', method: 'get_state', params: {} })
  })

  it('closes an oversized authentication frame with 1009 without registering the DAW, then accepts a healthy connection', async () => {
    const value = await bridge()
    const socket = await open(value)
    const received: unknown[] = []
    socket.on('message', data => received.push(JSON.parse(data.toString())))
    const closed = closeCode(socket)
    socket.send(paddedPacket({ type: 'auth', protocol: 1, token: TOKEN, instanceId: 'oversized-auth' }, MAX_BRIDGE_MESSAGE_BYTES + 1))
    expect(await closed).toBe(1009)
    expect(socket.readyState).toBe(WebSocket.CLOSED)
    expect(received).toEqual([])
    expect(value.listInstances()).toEqual([])
    await expect(value.request('get_state', {}, 'oversized-auth')).rejects.toMatchObject({ code: 'INSTANCE_NOT_FOUND' })
    const healthy = await pair(value, 'oversized-auth')
    expect(healthy.reply).toEqual({ type: 'ready', protocol: 1 })
    await acknowledgeState(value, healthy.socket, 'oversized-auth')
  })

  it('closes an oversized response with 1009 and fails pending work without accepting its result', async () => {
    const value = await bridge()
    const { socket } = await pair(value)
    const incoming = message(socket)
    const result = value.request('get_state', {})
    const disconnected = expect(result).rejects.toMatchObject({ code: 'DAW_DISCONNECTED' })
    const packet = await incoming
    const closed = closeCode(socket)
    socket.send(paddedPacket({ type: 'response', id: packet.id, result: { mustNotBeAccepted: true } }, MAX_BRIDGE_MESSAGE_BYTES + 1))
    await disconnected
    // The invalid DAW is removed as soon as ws emits the error, before TCP close completes.
    expect(value.listInstances()).toEqual([])
    expect(await closed).toBe(1009)
    expect(socket.readyState).toBe(WebSocket.CLOSED)
    const healthy = await pair(value)
    expect(healthy.reply).toEqual({ type: 'ready', protocol: 1 })
    await acknowledgeState(value, healthy.socket, 'tab-one')
  })
})

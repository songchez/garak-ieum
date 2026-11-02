/** The local bridge is an application protocol, separate from MCP's transport. */
export const BRIDGE_PROTOCOL_VERSION = 1 as const
export const DEFAULT_BRIDGE_PORT = 47831
export const DEFAULT_BRIDGE_URL = `ws://127.0.0.1:${DEFAULT_BRIDGE_PORT}/bridge`
export const MAX_BRIDGE_MESSAGE_BYTES = 512 * 1024
export const MAX_BRIDGE_REQUEST_MS = 30_000
export const DAW_METHODS = ['get_state', 'get_catalog', 'get_capabilities', 'preview_edits', 'apply_edits', 'history'] as const
export type DawMethod = typeof DAW_METHODS[number]
export type BridgeParams = Record<string, unknown>

export interface BridgeErrorData { code: string; message: string; details?: unknown }
export class BridgeError extends Error {
  readonly code: string
  readonly details?: unknown
  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.details = details
  }
}

export interface BridgeAuth {
  type: 'auth'
  protocol: typeof BRIDGE_PROTOCOL_VERSION
  token: string
  instanceId: string
}
export interface BridgeRequest {
  type: 'request'
  id: string
  method: DawMethod
  params: BridgeParams
  /** Same-machine wall clock deadline; stale requests must never enter the command handler. */
  deadline: number
}
export type BridgeResponse =
  | { type: 'response'; id: string; result: unknown }
  | { type: 'response'; id: string; error: BridgeErrorData }
export type ServerMessage =
  | { type: 'ready'; protocol: typeof BRIDGE_PROTOCOL_VERSION }
  | BridgeRequest
  | { type: 'cancel'; id: string }
  | { type: 'error'; error: BridgeErrorData }

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
export const isBridgeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value)
export const isDawMethod = (value: unknown): value is DawMethod =>
  typeof value === 'string' && (DAW_METHODS as readonly string[]).includes(value)
export const isBridgeToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(value)
export const isBridgeError = (value: unknown): value is BridgeErrorData =>
  isRecord(value) && typeof value.code === 'string' && value.code.length > 0 && value.code.length <= 128
  && typeof value.message === 'string' && value.message.length <= 2048

export function errorData(error: unknown): BridgeErrorData {
  if (isBridgeError(error)) return { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }
  return { code: 'INTERNAL_ERROR', message: 'DAW 요청을 처리하지 못했습니다.' }
}

/** Reject URLs that could transmit the pairing token off this computer. */
export function validateBridgeUrl(value: string): string {
  let url: URL
  try { url = new URL(value) }
  catch { throw new BridgeError('INVALID_BRIDGE_URL', '올바른 로컬 브리지 주소를 입력해주세요.') }
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/bridge'
    || !url.port || Number(url.port) < 1 || Number(url.port) > 65535) {
    throw new BridgeError('INVALID_BRIDGE_URL', '브리지는 ws://127.0.0.1:포트/bridge 또는 ws://localhost:포트/bridge 주소만 허용합니다.')
  }
  return url.href
}

import { SAMPLE_RATES } from '../../core/audioSettings'
import type { NativeErrorCode, NativeRequestError } from './contracts'

/**
 * Electron keeps only `message` of an error thrown by an IPC handler, so the main process appends
 * `code`/`details` as JSON after this marker (desktop/native-audio.ts `ipcNativeError`). Keep the
 * two copies of the marker identical.
 */
export const NATIVE_ERROR_MARKER = '\n[garak-native-error]'
const ELECTRON_PREFIX = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/
const CODES: ReadonlySet<string> = new Set<NativeErrorCode>(['DEVICE_NOT_FOUND', 'DEVICE_IN_USE', 'DRIVER_INIT_FAILED', 'SAMPLE_RATE_UNSUPPORTED', 'BUFFER_UNSUPPORTED', 'CHANNELS_UNAVAILABLE', 'DEVICE_LOST'])

export function withNativeCode(error: Error, code: NativeErrorCode, details?: unknown): NativeRequestError {
  const result = error as NativeRequestError
  result.code = code
  if (details !== undefined) result.details = details
  return result
}

/** Restores `code`/`details` from the IPC relay and drops Electron's "Error invoking remote method" prefix. */
export function nativeRequestError(error: unknown): unknown {
  if (!(error instanceof Error) || (error as NativeRequestError).code) return error
  const at = error.message.indexOf(NATIVE_ERROR_MARKER)
  const text = (at < 0 ? error.message : error.message.slice(0, at)).replace(ELECTRON_PREFIX, '')
  if (at < 0 && text === error.message) return error
  const result: NativeRequestError = new Error(text)
  if (at >= 0) {
    try {
      const payload = JSON.parse(error.message.slice(at + NATIVE_ERROR_MARKER.length)) as { code?: unknown; details?: unknown }
      if (typeof payload.code === 'string' && CODES.has(payload.code)) result.code = payload.code as NativeErrorCode
      if (payload.details !== undefined) result.details = payload.details
    } catch { /* A damaged suffix still leaves a readable message. */ }
  }
  return result
}

export const nativeErrorCode = (error: unknown): NativeErrorCode | undefined => {
  const code = error instanceof Error ? (error as NativeRequestError).code : undefined
  return code && CODES.has(code) ? code : undefined
}

const details = (error: unknown): Record<string, unknown> => {
  const value = error instanceof Error ? (error as NativeRequestError).details : undefined
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** `details.supported` of SAMPLE_RATE_UNSUPPORTED, limited to rates a project can use. */
export function supportedRatesOf(error: unknown, fallback: readonly number[] = []): number[] {
  const raw = details(error).supported
  const values = Array.isArray(raw) && raw.length ? raw : fallback
  return [...new Set(values.filter((rate): rate is number => SAMPLE_RATES.some(item => item === rate)))].sort((a, b) => a - b)
}

export type NativeErrorAction = 'retry' | 'controlPanel' | 'otherDevice' | 'supportedRate' | 'driverBuffer' | 'channels'
export const NATIVE_ACTION_LABELS: Record<NativeErrorAction, string> = {
  retry: '다시 시도', controlPanel: '제어판 열기', otherDevice: '다른 장치 선택',
  supportedRate: '지원 레이트로 변경', driverBuffer: '드라이버 권장 버퍼로', channels: '채널 설정 열기',
}
export interface NativeErrorAdvice {
  code: NativeErrorCode
  title: string
  text: string
  actions: NativeErrorAction[]
  /** Project rates the device accepts (SAMPLE_RATE_UNSUPPORTED only). */
  supportedRates: number[]
}

const kHz = (rate: number) => `${+(rate / 1000).toFixed(1)} kHz`

/** Explanation and fix-it actions for a coded host error; null for errors without a known code. */
export function describeNativeError(error: unknown, context: { backend: string; requestedRate?: number; probeRates?: readonly number[] }): NativeErrorAdvice | null {
  const code = nativeErrorCode(error)
  if (!code) return null
  // Only ASIO drivers have a control panel the host can open.
  const panel = (actions: NativeErrorAction[]) => context.backend === 'asio' ? actions : actions.filter(action => action !== 'controlPanel')
  const supportedRates = code === 'SAMPLE_RATE_UNSUPPORTED' ? supportedRatesOf(error, context.probeRates) : []
  const advice = (title: string, text: string, actions: NativeErrorAction[]): NativeErrorAdvice => ({ code, title, text, actions: panel(actions), supportedRates })
  switch (code) {
    case 'DEVICE_NOT_FOUND': return advice('장치를 찾지 못했습니다', '드라이버가 설치되지 않았거나 64비트 드라이버가 아닙니다. 인터페이스의 연결과 전원을 확인한 뒤 다시 시도하거나 다른 장치를 선택해 주세요.', ['retry', 'otherDevice'])
    case 'DEVICE_IN_USE': return advice('다른 앱이 장치를 사용하고 있습니다', '다른 DAW, 브라우저, 통화 앱처럼 이 장치를 독점하는 프로그램을 닫은 뒤 다시 시도해 주세요. ASIO 드라이버는 대부분 한 번에 한 앱만 열 수 있습니다.', ['retry', 'otherDevice'])
    case 'DRIVER_INIT_FAILED': return advice('드라이버를 시작하지 못했습니다', '드라이버가 원인을 알려 주지 않았습니다. 드라이버 제어판에서 설정을 확인하거나 인터페이스를 다시 연결한 뒤 시도해 주세요.', ['retry', 'controlPanel', 'otherDevice'])
    case 'SAMPLE_RATE_UNSUPPORTED': {
      const requested = context.requestedRate ? `${kHz(context.requestedRate)}를` : '요청한 샘플레이트를'
      return advice('장치가 이 샘플레이트를 쓸 수 없습니다', `장치가 ${requested} 지원하지 않습니다.${supportedRates.length ? ` 사용할 수 있는 레이트: ${supportedRates.map(kHz).join(', ')}.` : ''}`, [...(supportedRates.length ? ['supportedRate' as const] : []), 'controlPanel', 'retry'])
    }
    case 'BUFFER_UNSUPPORTED': {
      const range = details(error).buffer as { min?: unknown; max?: unknown } | undefined
      const known = typeof range?.min === 'number' && typeof range?.max === 'number'
      return advice('이 버퍼 크기를 쓸 수 없습니다', `드라이버가 허용하는 버퍼 크기가 아닙니다.${known ? ` 허용 범위는 ${range!.min}–${range!.max} 프레임입니다.` : ''} 드라이버 권장값으로 바꾸거나 제어판에서 버퍼를 확인해 주세요.`, ['driverBuffer', 'controlPanel'])
    }
    case 'CHANNELS_UNAVAILABLE': return advice('선택한 입력 채널이 장치에 없습니다', '켜 둔 입력 채널 일부를 이 장치에서 찾지 못했습니다. 입출력 채널 설정에서 사용할 채널을 다시 고르거나 다른 장치를 선택해 주세요.', ['channels', 'otherDevice'])
    case 'DEVICE_LOST': return advice('장치 연결이 끊어졌습니다', '인터페이스가 분리됐거나 전원이 꺼졌습니다. 다시 연결하면 자동으로 복구를 시도합니다. 계속 실패하면 다시 시도하거나 다른 장치를 선택해 주세요.', ['retry', 'otherDevice'])
  }
}

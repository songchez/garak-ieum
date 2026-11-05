import { describe, expect, it } from 'vitest'
import type { NativeErrorCode, NativeRequestError } from './contracts'
import { describeNativeError, NATIVE_ERROR_MARKER, nativeErrorCode, nativeRequestError, supportedRatesOf, withNativeCode } from './deviceErrors'

const ipc = (text: string, payload?: unknown) => new Error(`Error invoking remote method 'garak:audio-request': Error: ${text}${payload === undefined ? '' : NATIVE_ERROR_MARKER + JSON.stringify(payload)}`)
const coded = (code: NativeErrorCode, details?: unknown) => withNativeCode(new Error('host message'), code, details)

describe('host error codes across IPC', () => {
  it('restores code and details and drops the Electron prefix', () => {
    const error = nativeRequestError(ipc('ASIO 드라이버를 열 수 없습니다.', { code: 'DEVICE_IN_USE', details: { owner: 'other' } })) as NativeRequestError
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('ASIO 드라이버를 열 수 없습니다.')
    expect(error.code).toBe('DEVICE_IN_USE')
    expect(error.details).toEqual({ owner: 'other' })
    expect(nativeErrorCode(error)).toBe('DEVICE_IN_USE')
  })

  it('cleans uncoded relay errors and leaves everything else untouched', () => {
    expect((nativeRequestError(ipc('plain')) as Error).message).toBe('plain')
    expect((nativeRequestError(ipc('plain')) as NativeRequestError).code).toBeUndefined()
    const local = new Error('local')
    expect(nativeRequestError(local)).toBe(local)
    const already = coded('DEVICE_LOST')
    expect(nativeRequestError(already)).toBe(already)
    expect(nativeRequestError('text')).toBe('text')
    // Unknown codes and damaged suffixes still give a readable message.
    expect(nativeErrorCode(nativeRequestError(ipc('x', { code: 'SOMETHING_NEW' })))).toBeUndefined()
    expect((nativeRequestError(new Error(`broken${NATIVE_ERROR_MARKER}{`)) as Error).message).toBe('broken')
  })
})

describe('error explanations and actions', () => {
  it('maps every code to Korean text and fix-it actions; only ASIO offers the control panel', () => {
    const actions = (code: NativeErrorCode, backend = 'asio', details?: unknown) => describeNativeError(coded(code, details), { backend, requestedRate: 96000 })?.actions
    expect(actions('DEVICE_NOT_FOUND')).toEqual(['retry', 'otherDevice'])
    expect(actions('DEVICE_IN_USE')).toEqual(['retry', 'otherDevice'])
    expect(actions('DRIVER_INIT_FAILED')).toEqual(['retry', 'controlPanel', 'otherDevice'])
    expect(actions('DRIVER_INIT_FAILED', 'wasapi')).toEqual(['retry', 'otherDevice'])
    expect(actions('SAMPLE_RATE_UNSUPPORTED', 'asio', { supported: [44100, 48000] })).toEqual(['supportedRate', 'controlPanel', 'retry'])
    expect(actions('SAMPLE_RATE_UNSUPPORTED', 'wasapi')).toEqual(['retry'])
    expect(actions('BUFFER_UNSUPPORTED')).toEqual(['driverBuffer', 'controlPanel'])
    expect(actions('CHANNELS_UNAVAILABLE')).toEqual(['channels', 'otherDevice'])
    expect(actions('DEVICE_LOST')).toEqual(['retry', 'otherDevice'])
    expect(describeNativeError(new Error('no code'), { backend: 'asio' })).toBeNull()
  })

  it('names the requested and supported rates and the allowed buffer range', () => {
    const rate = describeNativeError(coded('SAMPLE_RATE_UNSUPPORTED', { supported: [48000, 44100, 32000] }), { backend: 'asio', requestedRate: 96000 })!
    expect(rate.supportedRates).toEqual([44100, 48000])
    expect(rate.text).toBe('장치가 96 kHz를 지원하지 않습니다. 사용할 수 있는 레이트: 44.1 kHz, 48 kHz.')
    // Without details the probe's rates are used.
    expect(describeNativeError(coded('SAMPLE_RATE_UNSUPPORTED'), { backend: 'asio', probeRates: [44100] })!.supportedRates).toEqual([44100])
    expect(describeNativeError(coded('BUFFER_UNSUPPORTED', { buffer: { min: 64, max: 512 } }), { backend: 'asio' })!.text).toContain('허용 범위는 64–512 프레임입니다.')
    expect(supportedRatesOf(coded('SAMPLE_RATE_UNSUPPORTED', { supported: 'bad' }))).toEqual([])
  })
})

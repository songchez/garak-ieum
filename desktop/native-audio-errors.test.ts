import { describe, expect, it } from 'vitest'
import { ipcNativeError } from './native-audio'
import { nativeRequestError } from '../src/audio/native/deviceErrors'
import type { NativeRequestError } from '../src/audio/native/contracts'

describe('native error relay', () => {
  it('carries host error codes through the IPC message and back into a renderer Error', () => {
    const host = Object.assign(new Error('요청한 샘플레이트를 쓸 수 없습니다.'), { code: 'SAMPLE_RATE_UNSUPPORTED', details: { supported: [44100, 48000] } })
    const relayed = ipcNativeError(host)
    // Electron forwards only the message and prefixes it in the renderer.
    const received = nativeRequestError(new Error(`Error invoking remote method 'garak:audio-request': Error: ${relayed.message}`)) as NativeRequestError
    expect(received.message).toBe('요청한 샘플레이트를 쓸 수 없습니다.')
    expect(received.code).toBe('SAMPLE_RATE_UNSUPPORTED')
    expect(received.details).toEqual({ supported: [44100, 48000] })
  })

  it('leaves uncoded errors unchanged', () => {
    const plain = new Error('plain')
    expect(ipcNativeError(plain)).toBe(plain)
    expect(ipcNativeError('text').message).toBe('text')
  })
})

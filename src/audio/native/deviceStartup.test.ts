import { describe, expect, it } from 'vitest'
import { DEFAULT_AUDIO_SETTINGS, type AudioSettings } from '../../core/audioSettings'
import { withNativeCode } from './deviceErrors'
import { classifyStartupError, decideStartup, missingDevice, startupBackend, startupCandidates, startupNotice, startupReason, STARTUP_RETRY_DELAYS } from './deviceStartup'
import type { NativeDevice, NativeErrorCode } from './contracts'

const settings = (patch: Partial<AudioSettings> = {}): AudioSettings => ({ ...DEFAULT_AUDIO_SETTINGS, ...patch })
const coded = (code: NativeErrorCode) => withNativeCode(new Error(code), code)
const device = (id: string, backend: NativeDevice['backend'] = 'wasapi'): NativeDevice => ({ id, name: `Name ${id}`, backend, inputChannels: 2, outputChannels: 2 })

describe('launch fallback candidates', () => {
  it('tries a saved ASIO driver, then its driver buffer, then the WASAPI default; never another ASIO driver', () => {
    const preferred = settings({ nativeBackend: 'asio', outputDeviceId: 'focusrite', inputDeviceId: 'focusrite', nativeBufferFrames: 64, clockSource: 1, directMonitoring: true })
    const candidates = startupCandidates(preferred, 'win32')
    expect(candidates.map(candidate => [candidate.step, candidate.backend])).toEqual([['preferred', 'asio'], ['driverBuffer', 'asio'], ['platformDefault', 'wasapi']])
    expect(candidates[0].settings).toBe(preferred)
    expect(candidates[1].settings).toMatchObject({ outputDeviceId: 'focusrite', nativeBufferFrames: 'driver', clockSource: 1 })
    const fallback = candidates[2].settings
    expect(fallback).toMatchObject({ nativeBackend: 'wasapi', outputDeviceId: '', inputDeviceId: '', nativeBufferFrames: 'driver', directMonitoring: false })
    expect('clockSource' in fallback).toBe(false)
    // Unrelated preferences travel with the fallback.
    expect(fallback.processingThreads).toBe(preferred.processingThreads)
    expect(fallback.nativeDeviceProfiles).toBe(preferred.nativeDeviceProfiles)
  })

  it('falls back from a chosen WASAPI endpoint to the default endpoint once (no duplicate OS default)', () => {
    const candidates = startupCandidates(settings({ outputDeviceId: 'usb', inputDeviceId: 'usb-mic' }), 'win32')
    expect(candidates.map(candidate => candidate.step)).toEqual(['preferred', 'defaultDevice'])
    expect(candidates[1].settings).toMatchObject({ nativeBackend: 'auto', outputDeviceId: '', inputDeviceId: '' })
  })

  it('has nothing to fall back to when the saved settings already are the default device', () => {
    expect(startupCandidates(DEFAULT_AUDIO_SETTINGS, 'win32').map(candidate => candidate.step)).toEqual(['preferred'])
    expect(startupCandidates(DEFAULT_AUDIO_SETTINGS, 'darwin').map(candidate => [candidate.step, candidate.backend])).toEqual([['preferred', 'coreaudio']])
  })

  it('uses Core Audio defaults on macOS and drops a backend this OS cannot run', () => {
    expect(startupBackend(settings({ nativeBackend: 'asio' }), 'darwin')).toBeNull()
    expect(startupCandidates(settings({ nativeBackend: 'asio', outputDeviceId: 'x' }), 'darwin').map(candidate => [candidate.step, candidate.backend])).toEqual([['platformDefault', 'coreaudio']])
    expect(startupCandidates(settings({ outputDeviceId: 'interface' }), 'darwin').map(candidate => [candidate.step, candidate.backend])).toEqual([['preferred', 'coreaudio'], ['defaultDevice', 'coreaudio']])
    expect(startupCandidates(DEFAULT_AUDIO_SETTINGS, 'linux')).toEqual([])
  })
})

describe('launch fallback decisions', () => {
  const asio = startupCandidates(settings({ nativeBackend: 'asio', outputDeviceId: 'focusrite', nativeBufferFrames: 64 }), 'win32')

  it('classifies host errors', () => {
    expect(classifyStartupError(coded('DEVICE_IN_USE'))).toBe('transient')
    expect(classifyStartupError(coded('DRIVER_INIT_FAILED'))).toBe('transient')
    expect(classifyStartupError(coded('DEVICE_LOST'))).toBe('transient')
    expect(classifyStartupError(coded('BUFFER_UNSUPPORTED'))).toBe('buffer')
    for (const code of ['DEVICE_NOT_FOUND', 'SAMPLE_RATE_UNSUPPORTED', 'CHANNELS_UNAVAILABLE'] as const) expect(classifyStartupError(coded(code))).toBe('device')
    expect(classifyStartupError(new DOMException('cancelled', 'AbortError'))).toBe('transient')
    expect(classifyStartupError(new Error('오디오 엔진 응답 시간이 초과되었습니다: engine.configure'))).toBe('transient')
    expect(classifyStartupError(new Error('선택한 출력 장치와 실제 열린 장치가 다릅니다.'))).toBe('device')
  })

  it('retries a busy or still-starting saved driver with growing backoff before falling back', () => {
    const delays = STARTUP_RETRY_DELAYS.preferred
    delays.forEach((delayMs, at) => expect(decideStartup(asio, 0, at + 1, coded('DEVICE_IN_USE'))).toEqual({ kind: 'retry', delayMs }))
    expect([...delays].every((value, at) => at === 0 || value > delays[at - 1])).toBe(true)
    // Exhausted: the device itself is the problem, so the buffer-only variant is skipped.
    expect(decideStartup(asio, 0, delays.length + 1, coded('DEVICE_IN_USE'))).toEqual({ kind: 'next', index: 2 })
  })

  it('moves to the driver buffer only for a buffer refusal', () => {
    expect(decideStartup(asio, 0, 1, coded('BUFFER_UNSUPPORTED'))).toEqual({ kind: 'next', index: 1 })
    expect(decideStartup(asio, 0, 1, coded('DEVICE_NOT_FOUND'))).toEqual({ kind: 'next', index: 2 })
    expect(decideStartup(asio, 0, 1, coded('SAMPLE_RATE_UNSUPPORTED'))).toEqual({ kind: 'next', index: 2 })
  })

  it('gives fallbacks one quick retry and then fails', () => {
    expect(decideStartup(asio, 2, 1, coded('DEVICE_IN_USE'))).toEqual({ kind: 'retry', delayMs: STARTUP_RETRY_DELAYS.fallback[0] })
    expect(decideStartup(asio, 2, 2, coded('DEVICE_IN_USE'))).toEqual({ kind: 'fail' })
    expect(decideStartup(asio, 2, 1, coded('DEVICE_NOT_FOUND'))).toEqual({ kind: 'fail' })
  })

  it('detects a missing saved device from the list without opening it', () => {
    const [preferred, , osDefault] = asio
    expect(missingDevice(preferred, [device('focusrite', 'asio')])).toBe(false)
    expect(missingDevice(preferred, [device('other', 'asio')])).toBe(true)
    // An unreadable list is not evidence; the open attempt decides.
    expect(missingDevice(preferred, null)).toBe(false)
    expect(missingDevice(osDefault, [])).toBe(false)
    expect(missingDevice({ ...preferred, settings: settings({ nativeBackend: 'asio' }) }, null)).toBe(true)
  })
})

describe('launch notice', () => {
  const asio = startupCandidates(settings({ nativeBackend: 'asio', outputDeviceId: 'focusrite', nativeBufferFrames: 64 }), 'win32')

  it('says nothing when the saved settings started', () => {
    expect(startupNotice({ preferred: asio[0], used: asio[0], error: null })).toBeNull()
  })

  it('names the saved device, the replacement and the reason, and promises the saved setting is kept', () => {
    const text = startupNotice({ preferred: asio[0], used: asio[2], error: coded('DEVICE_NOT_FOUND'), preferredName: 'Focusrite USB ASIO' })!
    expect(text).toBe('저장된 오디오 장치(ASIO · Focusrite USB ASIO)를 열지 못해 WASAPI · 기본 장치로 연결했습니다 — 장치를 찾지 못했습니다. 저장된 설정은 그대로 두고 다음 실행 때 다시 시도합니다.')
    expect(startupNotice({ preferred: asio[0], used: asio[2], error: coded('DEVICE_IN_USE') })).toContain('ASIO · 저장된 출력 장치')
  })

  it('explains a buffer-only change and a total failure', () => {
    expect(startupNotice({ preferred: asio[0], used: asio[1], error: coded('BUFFER_UNSUPPORTED') })).toContain('I/O 버퍼(64 프레임)')
    expect(startupNotice({ preferred: asio[0], used: null, error: coded('DEVICE_IN_USE') })).toBe('오디오 장치를 자동으로 연결하지 못했습니다 — 다른 앱이 장치를 사용 중입니다. 설정에서 장치를 확인해 주세요.')
    expect(startupReason(new Error(`${'x'.repeat(200)}\nsecond line`))).toHaveLength(118)
  })
})

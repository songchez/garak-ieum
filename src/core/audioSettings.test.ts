import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUDIO_SETTINGS_STORAGE_KEY, DEFAULT_AUDIO_SETTINGS, inputConstraints, loadAudioSettings, normalizeAudioSettings, saveAudioSettings } from './audioSettings'

afterEach(() => vi.unstubAllGlobals())

describe('local audio preferences', () => {
  it('normalizes unknown, damaged and out-of-range fields without changing defaults', () => {
    expect(normalizeAudioSettings(null)).toEqual(DEFAULT_AUDIO_SETTINGS)
    expect(normalizeAudioSettings({ latencyHint: 'fast', renderSizeHint: 999, inputChannels: 8, recordingOffsetMs: Infinity, softwareMonitoring: 'false' })).toEqual(DEFAULT_AUDIO_SETTINGS)
    const result = normalizeAudioSettings({ outputDeviceId: 'usb', latencyHint: 'balanced', renderSizeHint: 256, inputChannels: 2, recordingOffsetMs: -2000, softwareMonitoring: false, arbitrary: true })
    expect(result).toMatchObject({ outputDeviceId: 'usb', latencyHint: 'balanced', renderSizeHint: 256, inputChannels: 2, recordingOffsetMs: -1000, softwareMonitoring: false })
    expect(result).not.toHaveProperty('arbitrary')
    expect(DEFAULT_AUDIO_SETTINGS.softwareMonitoring).toBe(true)
  })

  it('round-trips local preferences and reports unavailable persistence', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
    const settings = { ...DEFAULT_AUDIO_SETTINGS, inputDeviceId: 'mic', outputDeviceId: 'speakers', noiseSuppression: true }
    expect(saveAudioSettings(settings)).toBe(true)
    expect(loadAudioSettings()).toEqual(settings)
    values.set(AUDIO_SETTINGS_STORAGE_KEY, '{broken')
    expect(loadAudioSettings()).toEqual(DEFAULT_AUDIO_SETTINGS)
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('full') } })
    expect(saveAudioSettings(settings)).toBe(false)
    expect(loadAudioSettings()).toEqual(DEFAULT_AUDIO_SETTINGS)
  })
})

describe('capture constraints', () => {
  it('requires the selected input identity and requests channel count, rate and processing independently', () => {
    expect(inputConstraints({ ...DEFAULT_AUDIO_SETTINGS, inputDeviceId: 'usb-interface', inputChannels: 2, echoCancellation: true }, 96000)).toEqual({ audio: {
      deviceId: { exact: 'usb-interface' }, channelCount: { ideal: 2 }, sampleRate: { ideal: 96000 },
      echoCancellation: true, noiseSuppression: false, autoGainControl: false,
    } })
  })

  it('does not invent a device, input rate, port or buffer size for system-default capture', () => {
    expect(inputConstraints(DEFAULT_AUDIO_SETTINGS)).toEqual({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
  })
})

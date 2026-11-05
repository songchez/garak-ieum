import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AUDIO_SETTINGS_STORAGE_KEY, DEFAULT_AUDIO_SETTINGS, inputConstraints, loadAudioSettings, nativeInputChannelList, nativeInputProfile, nativeOutputProfile,
  normalizeAudioSettings, normalizeDeviceProfile, parseRecordingOffsetFrames, recordingOffsetMs, saveAudioSettings,
} from './audioSettings'

afterEach(() => vi.unstubAllGlobals())

describe('local audio preferences', () => {
  it('normalizes unknown, damaged and out-of-range fields without changing defaults', () => {
    expect(normalizeAudioSettings(null)).toEqual(DEFAULT_AUDIO_SETTINGS)
    expect(normalizeAudioSettings({ latencyHint: 'fast', renderSizeHint: 999, inputChannels: 8, recordingOffsetMs: Infinity, softwareMonitoring: 'false' })).toEqual(DEFAULT_AUDIO_SETTINGS)
    const result = normalizeAudioSettings({ outputDeviceId: 'usb', latencyHint: 'balanced', renderSizeHint: 256, inputChannels: 2, recordingOffsetMs: -2000, softwareMonitoring: false, arbitrary: true })
    // A legacy millisecond offset is clamped to ±1000 ms and converted at 48 kHz.
    expect(result).toMatchObject({ outputDeviceId: 'usb', latencyHint: 'balanced', renderSizeHint: 256, inputChannels: 2, recordingOffsetFrames: -48000, softwareMonitoring: false })
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

describe('native device settings', () => {
  it('migrates millisecond offsets to frames and prefers a stored frame value', () => {
    expect(normalizeAudioSettings({ recordingOffsetMs: 10 }).recordingOffsetFrames).toBe(480)
    expect(normalizeAudioSettings({ recordingOffsetMs: 10, recordingOffsetFrames: -37 }).recordingOffsetFrames).toBe(-37)
    expect(normalizeAudioSettings({ recordingOffsetFrames: 1e9 }).recordingOffsetFrames).toBe(192000)
    expect(normalizeAudioSettings({ recordingOffsetMs: 'x' })).not.toHaveProperty('recordingOffsetMs')
    expect(recordingOffsetMs({ ...DEFAULT_AUDIO_SETTINGS, recordingOffsetFrames: 441 }, 44100)).toBe(10)
    expect(parseRecordingOffsetFrames(' -128 ')).toBe(-128)
    for (const text of ['', '-', '1.5', '192001', '1e3']) expect(parseRecordingOffsetFrames(text)).toBeNull()
  })

  it('accepts the driver buffer default or a sane number', () => {
    expect(DEFAULT_AUDIO_SETTINGS.nativeBufferFrames).toBe('driver')
    expect(normalizeAudioSettings({ nativeBufferFrames: 256 }).nativeBufferFrames).toBe(256)
    expect(normalizeAudioSettings({ nativeBufferFrames: 'driver' }).nativeBufferFrames).toBe('driver')
    for (const value of [8, 9000, 100.5, 'auto']) expect(normalizeAudioSettings({ nativeBufferFrames: value }).nativeBufferFrames).toBe('driver')
  })

  it('normalizes clock, direct monitoring and background release', () => {
    expect(normalizeAudioSettings({ clockSource: 2, directMonitoring: true, releaseInBackground: true })).toMatchObject({ clockSource: 2, directMonitoring: true, releaseInBackground: true })
    expect(normalizeAudioSettings({ clockSource: -1 })).not.toHaveProperty('clockSource')
    expect(DEFAULT_AUDIO_SETTINGS).toMatchObject({ directMonitoring: false, releaseInBackground: false, nativeDeviceProfiles: {} })
  })

  it('normalizes processing threads and render-ahead', () => {
    expect(DEFAULT_AUDIO_SETTINGS).toMatchObject({ processingThreads: 'auto', renderAhead: 'off' })
    for (const value of ['auto', 0, 1, 2, 16] as const) expect(normalizeAudioSettings({ processingThreads: value }).processingThreads).toBe(value)
    for (const value of [-1, 17, 2.5, '4', null]) expect(normalizeAudioSettings({ processingThreads: value }).processingThreads).toBe('auto')
    for (const value of ['off', 'normal', 'high'] as const) expect(normalizeAudioSettings({ renderAhead: value }).renderAhead).toBe(value)
    for (const value of ['max', true, 2]) expect(normalizeAudioSettings({ renderAhead: value }).renderAhead).toBe('off')
  })

  it('normalizes device profiles: sorted bounded inputs, valid non-overlapping pairs, trimmed names', () => {
    expect(normalizeDeviceProfile({
      inputs: [3, 1, 1, 0, -1, 300, 2.5, 2], stereoPairs: [2, 0, 1, 5], inputNames: { 0: ' Vox ', 1: '', 999: 'x', a: 'y', 2: 7 }, outputNames: { 0: 'M'.repeat(80) },
    })).toEqual({ inputs: [0, 1, 2, 3], stereoPairs: [0, 2], inputNames: { 0: 'Vox' }, outputNames: { 0: 'M'.repeat(64) } })
    expect(normalizeDeviceProfile({ inputs: Array.from({ length: 40 }, (_, index) => index) }).inputs).toHaveLength(32)
    const settings = normalizeAudioSettings({ nativeDeviceProfiles: { 'asio:Focusrite': { inputs: [0] }, 'other:x': { inputs: [1] }, broken: null } })
    expect(Object.keys(settings.nativeDeviceProfiles)).toEqual(['asio:Focusrite'])
  })

  it('derives a profile from the legacy single input until the device has its own', () => {
    const legacy = normalizeAudioSettings({ inputDeviceId: 'mic', inputChannels: 2, nativeInputChannel: 4 })
    expect(nativeInputProfile(legacy, 'wasapi')).toEqual({ inputs: [4, 5], stereoPairs: [4], inputNames: {}, outputNames: {} })
    expect(nativeInputChannelList(legacy, 'wasapi')).toEqual([4, 5])
    expect(nativeInputChannelList(normalizeAudioSettings({ nativeInputChannel: 3 }), 'wasapi')).toEqual([3])
    const saved = normalizeAudioSettings({ ...legacy, nativeDeviceProfiles: { 'wasapi:mic': { inputs: [7, 1] } } })
    expect(nativeInputChannelList(saved, 'wasapi')).toEqual([1, 7])
    // ASIO opens one device; its profile is keyed by the driver, not by the (mirrored) input id.
    const asio = normalizeAudioSettings({ outputDeviceId: 'drv', inputDeviceId: 'drv', nativeDeviceProfiles: { 'asio:drv': { inputs: [2, 3], stereoPairs: [2], outputNames: { 0: 'Main L' } } } })
    expect(nativeInputChannelList(asio, 'asio')).toEqual([2, 3])
    expect(nativeOutputProfile(asio, 'asio').outputNames).toEqual({ 0: 'Main L' })
  })
})

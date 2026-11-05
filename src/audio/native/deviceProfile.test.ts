import { describe, expect, it } from 'vitest'
import type { NativeDeviceProfile } from '../../core/audioSettings'
import type { NativeDevice, NativeDeviceProbe } from './contracts'
import {
  backgroundAction, bufferPlan, driverChannelName, inputChoices, latencyOffsetFrames, nearestSampleRate, parseDeviceProbe,
  shouldAlertOverload, streamInputChoices, toggleInput, toggleStereoPair,
} from './deviceProfile'

const profile = (value: Partial<NativeDeviceProfile> = {}): NativeDeviceProfile => ({ inputs: [], stereoPairs: [], inputNames: {}, outputNames: {}, ...value })
const probe = (buffer: Partial<NativeDeviceProbe['buffer']> = {}, rest: Partial<NativeDeviceProbe> = {}): NativeDeviceProbe => ({
  id: 'asio-1', name: 'Interface', backend: 'asio', inputs: [], outputs: [], sampleRates: [44100, 48000], currentSampleRate: 48000,
  buffer: { min: 64, max: 1024, preferred: 256, granularity: -1, sizes: [64, 128, 256, 512, 1024], fixed: false, ...buffer },
  clockSources: [], canDirectMonitor: false, inputLatencyFrames: 312, outputLatencyFrames: 288, ...rest,
})

describe('devices.probe parsing', () => {
  it('keeps the contract shape and turns unknown values into empty lists or null', () => {
    const value = parseDeviceProbe({
      id: 'asio-1', name: 'Interface', backend: 'asio',
      inputs: [{ index: 1, name: 'Mic/Inst 2' }, { index: 0, name: 'Mic/Inst 1' }, { index: -1, name: 'bad' }, { index: 2 }],
      outputs: 'none', sampleRates: [48000, 44100, 48000, -1], currentSampleRate: 0,
      buffer: { min: 128, max: 128, preferred: 128, sizes: [128, 128, 1.5] }, clockSources: [{ index: 0, name: 'Internal', current: true }, { name: 'missing index' }],
      canDirectMonitor: 1, inputLatencyFrames: 12.5,
    }, 'asio', 'asio-1')
    expect(value).toEqual({
      id: 'asio-1', name: 'Interface', backend: 'asio',
      inputs: [{ index: 0, name: 'Mic/Inst 1' }, { index: 1, name: 'Mic/Inst 2' }], outputs: [],
      sampleRates: [44100, 48000], currentSampleRate: null,
      buffer: { min: 128, max: 128, preferred: 128, granularity: null, sizes: [128], fixed: true },
      clockSources: [{ index: 0, name: 'Internal', current: true }], canDirectMonitor: false,
      inputLatencyFrames: null, outputLatencyFrames: null,
    })
    // The requested backend wins over a mismatched reply; only the explicit test clock is kept.
    expect(parseDeviceProbe({ backend: 'coreaudio' }, 'wasapi', 'x').backend).toBe('wasapi')
    expect(parseDeviceProbe({ backend: 'test' }, 'wasapi', 'x')).toMatchObject({ backend: 'test', id: 'x', inputs: [], buffer: { sizes: [], fixed: false } })
    expect(() => parseDeviceProbe(null, 'asio', 'x')).toThrow('장치 정보를 읽지 못했습니다.')
  })
})

describe('input choices', () => {
  it('lists a mono choice per enabled channel and a stereo choice per pair, with numbered fallbacks', () => {
    expect(inputChoices(profile({ inputs: [0, 1, 3], stereoPairs: [0] }))).toEqual([
      { channels: [0], label: '입력 1' }, { channels: [1], label: '입력 2' }, { channels: [3], label: '입력 4' },
      { channels: [0, 1], label: '입력 1-2' },
    ])
  })

  it('prefers custom names, then real driver names; generic driver names stay localized', () => {
    const value = inputChoices(profile({ inputs: [0, 1, 2, 3], stereoPairs: [0, 2], inputNames: { 0: 'Vox', 1: '  ' } }), ['Mic/Inst 1', 'Mic/Inst 2', 'Input 3', 'In 4'])
    expect(value.map(choice => choice.label)).toEqual(['Vox', 'Mic/Inst 2', '입력 3', '입력 4', 'Vox / Mic/Inst 2', '입력 3-4'])
  })

  it('hides channels the current device does not have', () => {
    expect(inputChoices(profile({ inputs: [0, 1, 4, 5], stereoPairs: [0, 4] }), undefined, 2).map(choice => choice.channels)).toEqual([[0], [1], [0, 1]])
  })

  it('builds browser choices from the stream channel count', () => {
    expect(streamInputChoices(1)).toEqual([{ channels: [0], label: '입력 1' }])
    expect(streamInputChoices(2)).toEqual([{ channels: [0], label: '입력 1' }, { channels: [1], label: '입력 2' }, { channels: [0, 1], label: '입력 1-2' }])
    expect(streamInputChoices(0)).toHaveLength(1)
  })

  it('localizes only generic driver channel names', () => {
    expect(driverChannelName('Output 7', 0, 'output')).toBe('출력 7')
    expect(driverChannelName('', 2, 'input')).toBe('입력 3')
    expect(driverChannelName(' Main L ', 0, 'output')).toBe('Main L')
  })
})

describe('channel profile editing', () => {
  it('ends the stereo pair of a disabled channel and keeps names', () => {
    const value = toggleInput(profile({ inputs: [0, 1], stereoPairs: [0], inputNames: { 1: 'Gtr' } }), 1, false)
    expect(value).toEqual(profile({ inputs: [0], inputNames: { 1: 'Gtr' } }))
    expect(toggleInput(value, 4, true).inputs).toEqual([0, 4])
  })

  it('enables both channels of a new pair, refuses overlaps and stops at 32 inputs', () => {
    expect(toggleStereoPair(profile({ inputs: [3] }), 2, true)).toEqual(profile({ inputs: [2, 3], stereoPairs: [2] }))
    const paired = profile({ inputs: [0, 1], stereoPairs: [0] })
    expect(toggleStereoPair(paired, 1, true)).toBe(paired)
    expect(toggleStereoPair(paired, 0, false)).toEqual(profile({ inputs: [0, 1] }))
    const full = profile({ inputs: Array.from({ length: 32 }, (_, index) => index) })
    expect(toggleInput(full, 40, true)).toBe(full)
    expect(toggleStereoPair(profile({ inputs: Array.from({ length: 31 }, (_, index) => index) }), 40, true).stereoPairs).toEqual([])
  })
})

describe('buffer options', () => {
  it('offers the driver default first and only the sizes the driver allows', () => {
    const plan = bufferPlan(probe(), undefined, 'driver')
    expect(plan.fixed).toBe(false)
    expect(plan.options.map(option => option.value)).toEqual(['driver', 64, 128, 256, 512, 1024])
    expect(plan.options[0].label).toBe('드라이버 권장값 (256)')
    expect(plan.options.find(option => option.value === 256)?.label).toBe('256 프레임 · 권장')
  })

  it('locks a fixed driver to its single size', () => {
    const plan = bufferPlan(probe({ min: 512, max: 512, preferred: 512, sizes: [512], fixed: true }), undefined, 128)
    expect(plan).toEqual({ fixed: true, preferred: 512, options: [{ value: 'driver', label: '드라이버 고정값 (512)' }] })
  })

  it('derives sizes from a reported range, then from the device list, then from common sizes', () => {
    expect(bufferPlan(probe({ sizes: [], min: 96, max: 1000, preferred: null }), undefined, 'driver').options.map(option => option.value)).toEqual(['driver', 96, 128, 256, 512, 1000])
    const device: NativeDevice = { id: 'd', name: 'D', backend: 'wasapi', inputChannels: 2, outputChannels: 2, bufferSizes: [480], preferredBufferFrames: 480 }
    expect(bufferPlan(null, device, 'driver').options.map(option => option.value)).toEqual(['driver', 480])
    expect(bufferPlan(null, undefined, 'driver').options.map(option => option.value)).toEqual(['driver', 64, 128, 256, 512, 1024, 2048])
  })

  it('keeps a saved size that this driver does not list', () => {
    expect(bufferPlan(probe(), undefined, 96).options.at(-1)).toEqual({ value: 96, label: '96 프레임 · 저장한 값' })
  })
})

describe('sample rate and latency helpers', () => {
  it('picks the closest project rate the device supports', () => {
    expect(nearestSampleRate([44100, 48000], 96000)).toBe(48000)
    expect(nearestSampleRate([44100, 88200, 32000], 48000)).toBe(44100)
    expect(nearestSampleRate([32000], 48000)).toBeNull()
  })

  it('moves recordings earlier by the latency the driver did not report', () => {
    expect(latencyOffsetFrames({ roundTripFrames: 700, reportedFrames: 600, extraFrames: 100, confidence: .9, attempts: 5 })).toBe(-100)
    expect(latencyOffsetFrames({ roundTripFrames: 700, reportedFrames: null, extraFrames: null, confidence: .9, attempts: 5 })).toBe(-700)
    expect(latencyOffsetFrames({ roundTripFrames: 550, reportedFrames: 600, extraFrames: -50, confidence: .9, attempts: 5 })).toBe(50)
    expect(latencyOffsetFrames({ roundTripFrames: null, reportedFrames: 600, extraFrames: null, confidence: 0, attempts: 5 })).toBeNull()
    expect(latencyOffsetFrames({ roundTripFrames: 10_000_000, reportedFrames: 0, extraFrames: null, confidence: 1, attempts: 1 })).toBe(-192000)
  })
})

describe('background release and overload alerts', () => {
  it('suspends only when enabled, in the background and idle; resumes when it returns or the option is turned off', () => {
    expect(backgroundAction({ enabled: true, background: true, busy: false, suspended: false })).toBe('suspend')
    expect(backgroundAction({ enabled: true, background: true, busy: true, suspended: false })).toBeNull()
    expect(backgroundAction({ enabled: false, background: true, busy: false, suspended: false })).toBeNull()
    expect(backgroundAction({ enabled: true, background: false, busy: false, suspended: false })).toBeNull()
    expect(backgroundAction({ enabled: true, background: true, busy: false, suspended: true })).toBeNull()
    expect(backgroundAction({ enabled: true, background: false, busy: true, suspended: true })).toBe('resume')
    expect(backgroundAction({ enabled: false, background: true, busy: false, suspended: true })).toBe('resume')
  })

  it('alerts on a rise in the cumulative count while running, at most once per interval', () => {
    expect(shouldAlertOverload(2, 3, true, 40_000, 0)).toBe(true)
    expect(shouldAlertOverload(2, 3, false, 40_000, 0)).toBe(false)
    expect(shouldAlertOverload(3, 3, true, 40_000, 0)).toBe(false)
    expect(shouldAlertOverload(undefined, 3, true, 40_000, 0)).toBe(false)
    expect(shouldAlertOverload(3, 4, true, 40_000, 20_000)).toBe(false)
  })
})

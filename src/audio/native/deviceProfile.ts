import { MAX_ENABLED_INPUTS, MAX_RECORDING_OFFSET_FRAMES, SAMPLE_RATES, type NativeBufferFrames, type NativeDeviceProfile, type SampleRate } from '../../core/audioSettings'
import type { InputChoice } from '../../core/types'
import type { NativeBackend, NativeDevice, NativeDeviceProbe, NativeLatencyMeasurement } from './contracts'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const positive = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
const frames = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
const channels = (value: unknown) => (Array.isArray(value) ? value : []).map(record)
  .filter(item => Number.isInteger(item.index) && (item.index as number) >= 0 && typeof item.name === 'string')
  .map(item => ({ index: item.index as number, name: (item.name as string).slice(0, 128) }))
  .sort((a, b) => a.index - b.index)

/** Untrusted host reply → a probe whose unknown values are empty or null, as the contract promises. */
export function parseDeviceProbe(value: unknown, backend: NativeBackend, deviceId: string): NativeDeviceProbe {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('장치 정보를 읽지 못했습니다.')
  const raw = record(value), buffer = record(raw.buffer)
  const min = positive(buffer.min), max = positive(buffer.max)
  return {
    id: typeof raw.id === 'string' ? raw.id : deviceId,
    name: typeof raw.name === 'string' ? raw.name : '',
    backend: raw.backend === 'test' ? 'test' : backend,
    inputs: channels(raw.inputs), outputs: channels(raw.outputs),
    sampleRates: [...new Set((Array.isArray(raw.sampleRates) ? raw.sampleRates : []).filter((rate): rate is number => positive(rate) !== null))].sort((a, b) => a - b),
    currentSampleRate: positive(raw.currentSampleRate),
    buffer: {
      min, max, preferred: positive(buffer.preferred), granularity: typeof buffer.granularity === 'number' && Number.isFinite(buffer.granularity) ? buffer.granularity : null,
      sizes: [...new Set((Array.isArray(buffer.sizes) ? buffer.sizes : []).filter((size): size is number => Number.isInteger(size) && size > 0))].sort((a, b) => a - b).slice(0, 32),
      fixed: buffer.fixed === true || (min !== null && min === max),
    },
    clockSources: (Array.isArray(raw.clockSources) ? raw.clockSources : []).map(record)
      .filter(item => Number.isInteger(item.index) && (item.index as number) >= 0 && typeof item.name === 'string')
      .map(item => ({ index: item.index as number, name: (item.name as string).slice(0, 128), current: item.current === true })),
    canDirectMonitor: raw.canDirectMonitor === true,
    inputLatencyFrames: frames(raw.inputLatencyFrames), outputLatencyFrames: frames(raw.outputLatencyFrames),
  }
}

/** Driver names by physical index (`devices.probe` lists, or the snapshot's `inputNames`). */
export const namesByIndex = (list: readonly { index: number; name: string }[] | undefined): string[] => {
  const result: string[] = []
  for (const item of list ?? []) result[item.index] = item.name
  return result
}

/** Generic driver names ("Input 3") read better in the app's language; real names are kept as is. */
export function driverChannelName(name: string | undefined, index: number, kind: 'input' | 'output'): string {
  const generic = name?.match(/^\s*(?:Input|Output|In|Out|Channel|Ch)\s*(\d+)\s*$/i)
  if (!name?.trim() || generic) return `${kind === 'input' ? '입력' : '출력'} ${generic ? Number(generic[1]) : index + 1}`
  return name.trim()
}

/** A blank custom name (still being typed, or cleared) falls back to the driver's name. */
export const channelName = (index: number, custom: Record<number, string>, driver: readonly (string | undefined)[] | undefined, kind: 'input' | 'output'): string =>
  custom[index]?.trim() || driverChannelName(driver?.[index], index, kind)

/** Enabling stops at MAX_ENABLED_INPUTS; disabling a channel also ends the stereo pair it belongs to. Names are kept. */
export function toggleInput(profile: NativeDeviceProfile, channel: number, enabled: boolean): NativeDeviceProfile {
  if (enabled === profile.inputs.includes(channel)) return profile
  if (enabled) return profile.inputs.length >= MAX_ENABLED_INPUTS ? profile : { ...profile, inputs: [...profile.inputs, channel].sort((a, b) => a - b) }
  return { ...profile, inputs: profile.inputs.filter(item => item !== channel), stereoPairs: profile.stereoPairs.filter(left => left !== channel && left + 1 !== channel) }
}

/** A pair `left, left + 1` enables both channels; ending it keeps them as mono inputs. */
export function toggleStereoPair(profile: NativeDeviceProfile, left: number, enabled: boolean): NativeDeviceProfile {
  if (!enabled) return { ...profile, stereoPairs: profile.stereoPairs.filter(item => item !== left) }
  if (profile.stereoPairs.some(item => Math.abs(item - left) < 2)) return profile
  const inputs = [...new Set([...profile.inputs, left, left + 1])].sort((a, b) => a - b)
  if (inputs.length > MAX_ENABLED_INPUTS) return profile
  return { ...profile, inputs, stereoPairs: [...profile.stereoPairs, left].sort((a, b) => a - b) }
}

/**
 * Ableton-style input list: one mono choice per enabled channel, then one stereo choice per pair.
 * `available` (physical input count, when known) hides channels the current device does not have.
 */
export function inputChoices(profile: NativeDeviceProfile, driverNames?: readonly (string | undefined)[], available?: number): InputChoice[] {
  const exists = (channel: number) => available === undefined || channel < available
  const name = (channel: number) => channelName(channel, profile.inputNames, driverNames, 'input')
  const mono: InputChoice[] = profile.inputs.filter(exists).map(channel => ({ channels: [channel], label: name(channel) }))
  const stereo: InputChoice[] = profile.stereoPairs.filter(left => exists(left + 1)).map(left => {
    const a = name(left), b = name(left + 1)
    const numbered = a === `입력 ${left + 1}` && b === `입력 ${left + 2}`
    return { channels: [left, left + 1], label: numbered ? `입력 ${left + 1}/${left + 2}` : `${a} / ${b}` }
  })
  return [...mono, ...stereo]
}

export interface BufferChoice { value: NativeBufferFrames; label: string }
export interface BufferPlan {
  options: BufferChoice[]
  /** The driver accepts one size only; change it in the driver's control panel. */
  fixed: boolean
  preferred: number | null
}

const FALLBACK_SIZES = [64, 128, 256, 512, 1024, 2048]
const usable = (size: number) => Number.isInteger(size) && size >= 16 && size <= 8192

/** Allowed I/O buffer sizes from a probe; without one, from the device list, then from common sizes. */
export function bufferPlan(probe: NativeDeviceProbe | null | undefined, device: NativeDevice | undefined, current: NativeBufferFrames): BufferPlan {
  const preferred = probe?.buffer.preferred ?? device?.preferredBufferFrames ?? null
  const fixed = !!probe?.buffer.fixed
  let sizes = probe?.buffer.sizes.length ? probe.buffer.sizes : device?.bufferSizes?.length ? device.bufferSizes : []
  const min = probe?.buffer.min ?? device?.minBufferFrames ?? null, max = probe?.buffer.max ?? device?.maxBufferFrames ?? null
  if (!sizes.length && min !== null && max !== null) {
    // WASAPI/Core Audio report a range only; offer the powers of two inside it plus its ends.
    sizes = [min, max]
    for (let size = 16; size <= max; size *= 2) if (size > min) sizes.push(size)
  }
  if (!sizes.length) sizes = FALLBACK_SIZES
  const list = [...new Set([...sizes, ...(preferred ? [preferred] : [])])].filter(usable).sort((a, b) => a - b)
  const label = preferred ? `드라이버 권장값 (${preferred})` : '드라이버 권장값'
  if (fixed) return { options: [{ value: 'driver', label: preferred ? `드라이버 고정값 (${preferred})` : '드라이버 고정값' }], fixed, preferred }
  const options: BufferChoice[] = [{ value: 'driver', label }, ...list.map(size => ({ value: size, label: `${size} 프레임${size === preferred ? ' · 권장' : ''}` }))]
  // A size saved for another driver stays visible; ASIO snaps it to the nearest allowed size.
  if (typeof current === 'number' && !list.includes(current)) options.push({ value: current, label: `${current} 프레임 · 저장한 값` })
  return { options, fixed, preferred }
}

/** The project rate closest to the requested one among those a device accepts. */
export function nearestSampleRate(supported: readonly number[], requested: number): SampleRate | null {
  const rates = SAMPLE_RATES.filter(rate => supported.includes(rate))
  if (!rates.length) return null
  return rates.reduce((best, rate) => Math.abs(rate - requested) < Math.abs(best - requested) || (Math.abs(rate - requested) === Math.abs(best - requested) && rate > best) ? rate : best)
}

/**
 * The host already compensates the driver-reported latency (`reportedFrames`). What a loopback finds
 * beyond it arrives that much late, so the recording must move earlier: offset = −extra.
 */
export function latencyOffsetFrames(measurement: NativeLatencyMeasurement): number | null {
  if (!(measurement.confidence > 0)) return null
  const extra = measurement.extraFrames ?? (measurement.roundTripFrames === null ? null : measurement.roundTripFrames - (measurement.reportedFrames ?? 0))
  if (extra === null || !Number.isFinite(extra)) return null
  return Math.round(Math.min(MAX_RECORDING_OFFSET_FRAMES, Math.max(-MAX_RECORDING_OFFSET_FRAMES, -extra)))
}

/** Driver release in the background (Cubase "Release Driver when Application is in Background"). */
export function backgroundAction(state: { enabled: boolean; background: boolean; busy: boolean; suspended: boolean }): 'suspend' | 'resume' | null {
  if (state.suspended) return state.background && state.enabled ? null : 'resume'
  return state.enabled && state.background && !state.busy ? 'suspend' : null
}

/** One toast per burst: overloads are cumulative and can rise every callback while a project is too heavy. */
export function shouldAlertOverload(previous: number | undefined, next: number | undefined, active: boolean, now: number, lastAlert: number, interval = 30_000): boolean {
  return active && typeof next === 'number' && typeof previous === 'number' && next > previous && now - lastAlert >= interval
}

import type { DeviceGraph } from '../contracts.js'

/**
 * Live dynamics metering for the compressor / limiter / gate views.
 *
 * `input` is the loudest detector level (linear peak) and `gain` the lowest gain the processor applied
 * (linear, 1 = no reduction) over the last ~30-50 ms. Makeup / output gain is not part of `gain`.
 * Web Audio: a realtime device graph may expose `dynamicsMeter`; the audio graph binds it to the
 * device id (offline/export contexts never register). Native: the desktop host sends the same pair
 * per insert in its state snapshot (`dynamics`), read through AudioEngine.getDeviceMeter.
 */
export interface DynamicsReading { input: number; gain: number }
export interface DynamicsMeterSource {
  read(): DynamicsReading | null
  /** Set by the graph's dispose(): the registry then forgets the source. */
  disposed?: boolean
}

const sources = new Map<string, DynamicsMeterSource>()

export function bindDynamicsMeter(graph: DeviceGraph, deviceId: string, context: BaseAudioContext): void {
  const source = (graph as DeviceGraph & { dynamicsMeter?: DynamicsMeterSource }).dynamicsMeter
  if (!source || 'startRendering' in context) return
  sources.set(deviceId, source)
}

/** The latest Web Audio reading of a device, or null when it is not playing in a realtime graph. */
export function webDynamicsReading(deviceId: string): DynamicsReading | null {
  const source = sources.get(deviceId)
  if (!source) return null
  if (source.disposed) { sources.delete(deviceId); return null }
  return source.read()
}

/** Validates a reading from an untrusted channel (native IPC). */
export function dynamicsReadingFrom(value: unknown): DynamicsReading | null {
  if (!value || typeof value !== 'object') return null
  const { input, gain } = value as { input?: unknown; gain?: unknown }
  if (typeof input !== 'number' || typeof gain !== 'number' || !Number.isFinite(input) || !Number.isFinite(gain)) return null
  return { input: Math.max(0, Math.min(64, input)), gain: Math.max(0, Math.min(1, gain)) }
}

/** Peak (linear) of an analyser's current time-domain window. */
export function analyserPeak(analyser: AnalyserNode, scratch: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(scratch)
  let peak = 0
  for (let i = 0; i < scratch.length; i += 1) { const v = Math.abs(scratch[i]); if (v > peak) peak = v }
  return Number.isFinite(peak) ? peak : 0
}

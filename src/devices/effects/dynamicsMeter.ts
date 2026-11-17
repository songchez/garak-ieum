/**
 * Live dynamics metering for the compressor / limiter / gate views.
 *
 * `input` is the loudest detector level (linear peak) and `gain` the lowest gain the processor applied
 * (linear, 1 = no reduction) over the last ~30-50 ms. Makeup / output gain is not part of `gain`.
 * Both engines meter their own inserts and report them through AudioEngine.getDeviceMeter: the desktop
 * host in its state snapshot (`dynamics`), the web engine worklet in its meter block.
 */
export interface DynamicsReading { input: number; gain: number }

/** Validates a reading from an untrusted channel (native IPC). */
export function dynamicsReadingFrom(value: unknown): DynamicsReading | null {
  if (!value || typeof value !== 'object') return null
  const { input, gain } = value as { input?: unknown; gain?: unknown }
  if (typeof input !== 'number' || typeof gain !== 'number' || !Number.isFinite(input) || !Number.isFinite(gain)) return null
  return { input: Math.max(0, Math.min(64, input)), gain: Math.max(0, Math.min(1, gain)) }
}

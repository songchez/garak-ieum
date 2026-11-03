import type { Project, TimeSignature, TimeSignatureDenominator } from './types'

export const MIN_TIME_SIGNATURE_NUMERATOR = 1
export const MAX_TIME_SIGNATURE_NUMERATOR = 32
export const TIME_SIGNATURE_DENOMINATORS: readonly TimeSignatureDenominator[] = [2, 4, 8, 16]
export const DEFAULT_TIME_SIGNATURE: Readonly<TimeSignature> = { numerator: 4, denominator: 4 }

/** Project positions and BPM always use quarter notes, including compound meters. */
export function quarterNotesPerBeat(signature: TimeSignature): number {
  return 4 / signature.denominator
}

export function quarterNotesPerBar(signature: TimeSignature): number {
  return signature.numerator * quarterNotesPerBeat(signature)
}

/** Parse fresh data for imports and UI changes; do not coerce text or fractional values. */
export function validateTimeSignature(value: unknown): TimeSignature {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Time signature must contain a numerator and denominator.')
  const { numerator, denominator } = value as Record<string, unknown>
  if (typeof numerator !== 'number' || !Number.isSafeInteger(numerator)
    || numerator < MIN_TIME_SIGNATURE_NUMERATOR || numerator > MAX_TIME_SIGNATURE_NUMERATOR) {
    throw new Error(`Time signature numerator must be an integer from ${MIN_TIME_SIGNATURE_NUMERATOR} to ${MAX_TIME_SIGNATURE_NUMERATOR}.`)
  }
  if (typeof denominator !== 'number' || !TIME_SIGNATURE_DENOMINATORS.includes(denominator as TimeSignatureDenominator)) {
    throw new Error('Time signature denominator must be 2, 4, 8 or 16.')
  }
  return { numerator, denominator: denominator as TimeSignatureDenominator }
}

/** Changing meter re-groups existing quarter-note positions without moving or stretching music. */
export function setProjectTimeSignature(project: Project, numerator: number, denominator: number): Project {
  const timeSignature = validateTimeSignature({ numerator, denominator })
  if (project.timeSignature.numerator === numerator && project.timeSignature.denominator === denominator) return project
  return { ...project, timeSignature, beatsPerBar: quarterNotesPerBar(timeSignature) }
}

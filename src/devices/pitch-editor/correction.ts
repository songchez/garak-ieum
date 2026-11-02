import { PITCH_LIMITS, type PitchEditDocument } from './model'
import { segmentShift } from './uiEditing'

const SCALE_INTERVALS = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  'natural-minor': [0, 2, 3, 5, 7, 8, 10],
} as const

export type PitchCorrectionScale = keyof typeof SCALE_INTERVALS
export const PITCH_CORRECTION_SCALES: readonly { value: PitchCorrectionScale; label: string }[] = [
  { value: 'chromatic', label: '반음계' },
  { value: 'major', label: '장음계' },
  { value: 'natural-minor', label: '자연 단음계' },
]
/** Detector confidence is a heuristic, not a calibrated probability of correctness. */
export const CORRECTION_CONFIDENCE_THRESHOLD = 0.75

export interface PitchCorrectionOptions {
  root: number
  scale: PitchCorrectionScale
  strength: number
  skipUncertain: boolean
}

const correctionToolSettings = new Map<string, PitchCorrectionOptions>()
const DEFAULT_CORRECTION_OPTIONS: PitchCorrectionOptions = { root: 0, scale: 'chromatic', strength: 100, skipUncertain: true }

/** Session-only tool preferences; never part of an audio document or Undo history. */
export function readPitchCorrectionSettings(projectId: string): PitchCorrectionOptions {
  return { ...(correctionToolSettings.get(projectId) ?? DEFAULT_CORRECTION_OPTIONS) }
}

export function rememberPitchCorrectionSettings(projectId: string, settings: PitchCorrectionOptions): void {
  correctionToolSettings.set(projectId, { ...settings })
}

export interface PitchCorrectionResult {
  document: PitchEditDocument
  changed: number
  skipped: number
  /** Notes whose chosen target is outside the cumulative pitch-delta limits. */
  limited: number
}

/** Signed octaves are intentional: a shifted MIDI 0 note can have a negative center. */
export function nearestScalePitch(midi: number, root: number, scale: PitchCorrectionScale): number {
  if (!Number.isFinite(midi) || !Number.isInteger(root) || !Object.hasOwn(SCALE_INTERVALS, scale)) return midi
  const tonic = ((root % 12) + 12) % 12
  const octave = Math.floor((midi - tonic) / 12)
  let nearest = midi, distance = Infinity
  for (let candidateOctave = octave - 1; candidateOctave <= octave + 1; candidateOctave++) {
    for (const interval of SCALE_INTERVALS[scale]) {
      const candidate = tonic + candidateOctave * 12 + interval
      const difference = Math.abs(candidate - midi)
      // Minimize movement; an exact halfway tie always chooses the lower pitch.
      if (difference < distance - 1e-9 || (Math.abs(difference - distance) <= 1e-9 && candidate < nearest)) {
        nearest = candidate
        distance = difference
      }
    }
  }
  return nearest
}

/**
 * Explicit batch edit: callers pass only the selected, visible segment IDs.
 * Each note moves by a constant amount. Source analysis, contour/vibrato,
 * segmentation, and formant settings remain untouched. Partial strength acts on
 * the remaining error from the current edited center on every invocation.
 */
export function correctSelectedPitch(document: PitchEditDocument, ids: ReadonlySet<string>, options: PitchCorrectionOptions): PitchCorrectionResult {
  const unchanged = { document, changed: 0, skipped: 0, limited: 0 }
  if (!ids.size || !Number.isInteger(options.root) || !Object.hasOwn(SCALE_INTERVALS, options.scale) || !Number.isFinite(options.strength) || options.strength <= 0 || options.strength > 100) return unchanged
  const shifts: Record<string, number> = Object.assign(Object.create(null), document.shifts)
  let changed = 0, skipped = 0, limited = 0
  for (const note of document.segments) {
    if (!ids.has(note.id)) continue
    if (options.skipUncertain && note.confidence < CORRECTION_CONFIDENCE_THRESHOLD) { skipped++; continue }
    const before = segmentShift(document, note.id)
    const currentCenter = note.midi + before / 100
    const target = nearestScalePitch(currentCenter, options.root, options.scale)
    const targetShift = (target - note.midi) * 100
    if (targetShift < PITCH_LIMITS.minCents - 1e-7 || targetShift > PITCH_LIMITS.maxCents + 1e-7) limited++
    const requested = before + (targetShift - before) * options.strength / 100
    const after = Math.round(Math.max(PITCH_LIMITS.minCents, Math.min(PITCH_LIMITS.maxCents, requested)) * 10) / 10
    if (before === after) continue
    changed++
    if (after === 0) delete shifts[note.id]
    else shifts[note.id] = after
  }
  return { document: changed ? { ...document, shifts } : document, changed, skipped, limited }
}

// Display convention shared by the piano roll and track inspector: MIDI 60 = C3.
// MIDI values, tuning and sample-file names keep their existing meaning.
const PITCH_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']

export const pitchClassName = (midi: number) => PITCH_NAMES[((midi % 12) + 12) % 12]
export const pitchName = (midi: number) => `${pitchClassName(midi)}${Math.floor(midi / 12) - 2}`

/** Parse the shared display convention; callers retain responsibility for range limits. */
export function parsePitchName(text: string): number | null {
  const m = /^\s*([A-Ga-g])\s*(#|♯|b|♭)?\s*(-?\d+)\s*$/.exec(text)
  if (!m) { const n = Number(text); return Number.isFinite(n) ? n : null }
  const base = PITCH_NAMES.indexOf(m[1].toUpperCase()) + (m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0)
  return (Number(m[3]) + 2) * 12 + base
}

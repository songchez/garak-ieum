/** Keep partial signed input in the UI until it is a complete, valid millisecond value. */
export function parseRecordingOffset(value: string): number | null {
  const text = value.trim()
  if (!/^[+-]?\d+$/.test(text)) return null
  const number = Number(text)
  return Number.isInteger(number) && number >= -1000 && number <= 1000 ? number : null
}

/** Move a new recording on the timeline; crop at time zero without shifting its content. */
export function recordingPlacement(beat: number, bpm: number, durationSeconds: number, offsetMs: number): { startBeat: number; lengthBeats: number; offsetSeconds: number } | null {
  if (![beat, bpm, durationSeconds, offsetMs].every(Number.isFinite) || beat < 0 || bpm <= 0 || durationSeconds <= 0) throw new Error('녹음 위치를 계산할 수 없습니다.')
  const shiftedSeconds = beat * 60 / bpm + offsetMs / 1000
  const offsetSeconds = Math.max(0, -shiftedSeconds)
  const remaining = durationSeconds - offsetSeconds
  if (remaining <= 0) return null
  return { startBeat: Math.max(0, shiftedSeconds * bpm / 60), lengthBeats: remaining * bpm / 60, offsetSeconds }
}

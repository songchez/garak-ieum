import { beatAfterSeconds, spanSeconds, type Tempo } from './tempoMap'

/** Keep partial signed input in the UI until it is a complete, valid millisecond value. */
export function parseRecordingOffset(value: string): number | null {
  const text = value.trim()
  if (!/^[+-]?\d+$/.test(text)) return null
  const number = Number(text)
  return Number.isInteger(number) && number >= -1000 && number <= 1000 ? number : null
}

/** Apply the manual offset after native driver compensation; crop negative pre-roll without shifting the remaining content.
 * `tempo` is the project's tempo map (or a constant bpm): the take plays at 1×, so its length in beats follows the map. */
export function recordingPlacement(beat: number, tempo: Tempo, durationSeconds: number, offsetMs: number): { startBeat: number; lengthBeats: number; offsetSeconds: number } | null {
  const bpm = typeof tempo === 'number' ? tempo : 1
  if (![beat, bpm, durationSeconds, offsetMs].every(Number.isFinite) || bpm <= 0 || durationSeconds <= 0) throw new Error('녹음 위치를 계산할 수 없습니다.')
  const shiftedSeconds = spanSeconds(tempo, 0, beat) + offsetMs / 1000
  const offsetSeconds = Math.max(0, -shiftedSeconds)
  const remaining = durationSeconds - offsetSeconds
  if (remaining <= 0) return null
  const startBeat = Math.max(0, beatAfterSeconds(tempo, 0, shiftedSeconds))
  return { startBeat, lengthBeats: beatAfterSeconds(tempo, startBeat, remaining) - startBeat, offsetSeconds }
}

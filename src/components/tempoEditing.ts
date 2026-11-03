export const MIN_BPM = 30
export const MAX_BPM = 300

export interface TempoDraft { text: string; dirty: boolean }
export type TempoAction =
  | { type: 'focus' | 'sync' | 'commit' | 'cancel' }
  | { type: 'input'; text: string }
  | { type: 'step'; delta: -1 | 1 }
export interface TempoTransition { draft: TempoDraft | null; commit?: number }

export const isTempoText = (text: string): boolean => /^[0-9]*$/.test(text)

/** Empty input is an editing state, never a zero-BPM project value. */
function resolveTempo(text: string, current: number): number {
  if (!text || !isTempoText(text)) return current
  return Math.max(MIN_BPM, Math.min(MAX_BPM, Number(text)))
}

/** Keep an unfinished numeric edit separate from the tempo used for playback. */
export function editTempo(draft: TempoDraft | null, action: TempoAction, current: number): TempoTransition {
  switch (action.type) {
    case 'focus': return { draft: { text: String(current), dirty: false } }
    case 'sync': return { draft: draft && !draft.dirty ? { text: String(current), dirty: false } : draft }
    case 'input': return { draft: isTempoText(action.text) ? { text: action.text, dirty: true } : draft }
    case 'cancel': return { draft: null }
    case 'commit': {
      const value = draft?.dirty ? resolveTempo(draft.text, current) : current
      return { draft: null, ...(value === current ? {} : { commit: value }) }
    }
    case 'step': {
      const text = draft?.text ?? ''
      const base = text && isTempoText(text) ? Number(text) : current
      const value = Math.max(MIN_BPM, Math.min(MAX_BPM, base + action.delta))
      return { draft: { text: String(value), dirty: false }, ...(value === current ? {} : { commit: value }) }
    }
  }
}

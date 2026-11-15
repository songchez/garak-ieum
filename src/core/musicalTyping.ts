import type { ShortcutEvent } from './input'

/**
 * 컴퓨터 키보드 연주 (Logic Musical Typing / Ableton Computer MIDI Keyboard), docs/MIDI_RECORDING.md.
 * Keys match the physical `code`, so a Korean layout plays the same notes. While it is on, these unmodified keys
 * play notes instead of their app shortcuts (S solo, M mute, K metronome, C cycle, Z zoom, X mixer, F/G/H/T…);
 * Space, R, arrows, Enter, Delete and every modified chord keep working.
 */
export const MUSICAL_TYPING_NOTES: Readonly<Record<string, number>> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11,
  KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17,
}
/** Z/X octave down/up, C/V velocity down/up (Ableton). */
export const MUSICAL_TYPING_CONTROLS: Readonly<Record<string, 'octaveDown' | 'octaveUp' | 'velocityDown' | 'velocityUp'>> = {
  KeyZ: 'octaveDown', KeyX: 'octaveUp', KeyC: 'velocityDown', KeyV: 'velocityUp',
}
const KEY_FALLBACK: Readonly<Record<string, string>> = {
  a: 'KeyA', w: 'KeyW', s: 'KeyS', e: 'KeyE', d: 'KeyD', f: 'KeyF', t: 'KeyT', g: 'KeyG', y: 'KeyY', h: 'KeyH', u: 'KeyU', j: 'KeyJ',
  k: 'KeyK', o: 'KeyO', l: 'KeyL', p: 'KeyP', ';': 'Semicolon', "'": 'Quote', z: 'KeyZ', x: 'KeyX', c: 'KeyC', v: 'KeyV',
}

export interface MusicalTypingState {
  /** MIDI note of the A key; 60 = C3 in this app's naming. Multiple of 12, 0…108. */
  base: number
  /** 1…127 */
  velocity: number
}
export const DEFAULT_MUSICAL_TYPING: MusicalTypingState = { base: 60, velocity: 100 }
export const VELOCITY_STEP = 20
const MIN_BASE = 0, MAX_BASE = 108

export type MusicalTypingAction =
  | { kind: 'note'; code: string; pitch: number }
  | { kind: 'control'; code: string; state: MusicalTypingState }

const codeOf = (event: Pick<ShortcutEvent, 'code' | 'key'>): string | undefined =>
  event.code && (event.code in MUSICAL_TYPING_NOTES || event.code in MUSICAL_TYPING_CONTROLS) ? event.code : KEY_FALLBACK[event.key?.toLowerCase?.() ?? '']

/** Only unmodified keys (Shift excluded too) play, so every chord shortcut keeps its meaning. */
export function musicalTypingAction(event: ShortcutEvent, state: MusicalTypingState): MusicalTypingAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing) return null
  const code = codeOf(event)
  if (!code) return null
  const offset = MUSICAL_TYPING_NOTES[code]
  if (offset !== undefined) {
    const pitch = state.base + offset
    return pitch >= 0 && pitch <= 127 ? { kind: 'note', code, pitch } : null
  }
  const control = MUSICAL_TYPING_CONTROLS[code]
  if (!control) return null
  const next = { ...state }
  if (control === 'octaveDown') next.base = Math.max(MIN_BASE, state.base - 12)
  if (control === 'octaveUp') next.base = Math.min(MAX_BASE, state.base + 12)
  // 1, 20, 40 … 120, 127: the ends stay reachable from any value.
  if (control === 'velocityDown') next.velocity = state.velocity >= 127 ? 120 : Math.max(1, Math.ceil(state.velocity / VELOCITY_STEP) * VELOCITY_STEP - VELOCITY_STEP)
  if (control === 'velocityUp') next.velocity = state.velocity >= 120 ? 127 : Math.min(127, Math.floor(state.velocity / VELOCITY_STEP) * VELOCITY_STEP + VELOCITY_STEP)
  if (next.velocity === 0) next.velocity = 1
  return { kind: 'control', code, state: next }
}

/** The key that releases a note on keyup (any modifiers: Shift may have been pressed meanwhile). */
export const musicalTypingNoteCode = (event: Pick<ShortcutEvent, 'code' | 'key'>): string | undefined => {
  const code = codeOf(event)
  return code && code in MUSICAL_TYPING_NOTES ? code : undefined
}

/** Octave label in this app's naming (C3 = 60). */
export const musicalTypingOctaveLabel = (base: number): string => `C${Math.floor(base / 12) - 2}`

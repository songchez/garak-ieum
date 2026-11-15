import { describe, expect, it } from 'vitest'
import { DEFAULT_MUSICAL_TYPING, musicalTypingAction, musicalTypingNoteCode, musicalTypingOctaveLabel } from './musicalTyping'
import { resolveProjectShortcut } from './input'

const key = (code: string, key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  ({ code, key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })

describe('musical typing keymap', () => {
  it('A row is white keys from C3 (60), W/E/T/Y/U black keys, K the next C', () => {
    const pitch = (code: string, k: string) => { const action = musicalTypingAction(key(code, k), DEFAULT_MUSICAL_TYPING); return action?.kind === 'note' ? action.pitch : null }
    expect(['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK'].map(c => pitch(c, c.slice(3).toLowerCase()))).toEqual([60, 62, 64, 65, 67, 69, 71, 72])
    expect(['KeyW', 'KeyE', 'KeyT', 'KeyY', 'KeyU'].map(c => pitch(c, c.slice(3).toLowerCase()))).toEqual([61, 63, 66, 68, 70])
  })
  it('matches the physical key on a Korean layout and falls back to key without code', () => {
    const korean = musicalTypingAction(key('KeyA', 'ㅁ'), DEFAULT_MUSICAL_TYPING)
    expect(korean).toEqual({ kind: 'note', code: 'KeyA', pitch: 60 })
    expect(musicalTypingAction({ ...key('', 'd'), code: undefined }, DEFAULT_MUSICAL_TYPING)).toEqual({ kind: 'note', code: 'KeyD', pitch: 64 })
  })
  it('Z/X change the octave within range, C/V the velocity in steps keeping 1 and 127 reachable', () => {
    const control = (code: string, state = DEFAULT_MUSICAL_TYPING) => { const action = musicalTypingAction(key(code, ''), state); return action?.kind === 'control' ? action.state : null }
    expect(control('KeyZ')).toEqual({ base: 48, velocity: 100 })
    expect(control('KeyX', { base: 108, velocity: 100 })).toEqual({ base: 108, velocity: 100 })
    expect(control('KeyV')!.velocity).toBe(120)
    expect(control('KeyV', { base: 60, velocity: 120 })!.velocity).toBe(127)
    expect(control('KeyC', { base: 60, velocity: 127 })!.velocity).toBe(120)
    expect(control('KeyC', { base: 60, velocity: 20 })!.velocity).toBe(1)
    expect(control('KeyV', { base: 60, velocity: 1 })!.velocity).toBe(20)
  })
  it('modified keys never play, so every chord shortcut keeps working', () => {
    for (const mods of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) expect(musicalTypingAction(key('KeyA', 'a', mods), DEFAULT_MUSICAL_TYPING)).toBeNull()
    expect(musicalTypingAction(key('Space', ' '), DEFAULT_MUSICAL_TYPING)).toBeNull()
    expect(musicalTypingAction(key('KeyR', 'r'), DEFAULT_MUSICAL_TYPING)).toBeNull() // record stays R
  })
  it('keyup releases by physical key regardless of modifiers', () => {
    expect(musicalTypingNoteCode(key('KeyA', 'A', { shiftKey: true }))).toBe('KeyA')
    expect(musicalTypingNoteCode(key('KeyZ', 'z'))).toBeUndefined()
  })
  it('labels the octave in this app’s naming', () => {
    expect(musicalTypingOctaveLabel(60)).toBe('C3')
    expect(musicalTypingOctaveLabel(0)).toBe('C-2')
  })
  it('the toggle (⌘K / Ctrl+K) and Capture (⇧R) are free app shortcuts', () => {
    expect(resolveProjectShortcut(key('KeyK', 'k', { ctrlKey: true }), 'timeline', false, 'windows')).toBe('musicalTyping')
    expect(resolveProjectShortcut(key('KeyK', 'k', { metaKey: true }), 'piano', false, 'mac')).toBe('musicalTyping')
    expect(resolveProjectShortcut(key('KeyK', 'k'), 'timeline', false, 'windows')).toBe('metronome')
    expect(resolveProjectShortcut(key('KeyR', 'R', { shiftKey: true }), 'workspace', false, 'mac')).toBe('captureMidi')
  })
})

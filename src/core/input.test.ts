import { describe, expect, it } from 'vitest'
import { crossedDragThreshold, isShortcutSuppressed, resolveProjectShortcut, shortcutPlatform, snapDragDelta } from './input'
import type { ShortcutEvent, ShortcutScope } from './input'

const key = (patch: Partial<ShortcutEvent> = {}): ShortcutEvent => ({ key: 'Delete', code: 'Delete', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...patch })

describe('editing keyboard ownership', () => {
  it('never routes a note-area or native-control Delete to a region or track', () => {
    expect(resolveProjectShortcut(key(), 'timeline')).toBe('deleteClip')
    for (const scope of ['piano', 'workspace', 'text', 'control', 'dialog', 'outside'] as ShortcutScope[]) {
      expect(resolveProjectShortcut(key(), scope)).toBeNull()
    }
  })

  it('does not repeat deletion, transport toggles, history, or download commands', () => {
    for (const event of [key(), key({ key: ' ', code: 'Space' }), key({ key: 'z', code: 'KeyZ', ctrlKey: true }), key({ key: 's', code: 'KeyS', metaKey: true })]) {
      expect(resolveProjectShortcut({ ...event, repeat: true }, 'timeline')).toBeNull()
      expect(resolveProjectShortcut({ ...event, repeat: true }, 'timeline', true)).not.toBeNull()
    }
    expect(isShortcutSuppressed(key({ repeat: true }), true)).toBe(false)
  })

  it('ignores Korean IME composition, its legacy 229 event, dead keys, and AltGraph', () => {
    const space = key({ key: ' ', code: 'Space' })
    for (const patch of [{ isComposing: true }, { keyCode: 229 }, { key: 'Process' }, { key: 'Dead' }, { getModifierState: (name: string) => name === 'AltGraph' }]) {
      expect(resolveProjectShortcut({ ...space, ...patch }, 'timeline')).toBeNull()
    }
  })

  it('distinguishes Firefox macOS Option from Windows and Linux AltGr', () => {
    const option = key({ key: 'ArrowRight', code: 'ArrowRight', altKey: true, getModifierState: name => name === 'AltGraph' })
    expect(shortcutPlatform('MacIntel')).toBe('mac')
    expect(shortcutPlatform('Win32')).toBe('windows')
    expect(shortcutPlatform('Linux x86_64')).toBe('linux')
    expect(isShortcutSuppressed(option, false, 'mac')).toBe(false)
    expect(isShortcutSuppressed({ ...option, shiftKey: true }, false, 'mac')).toBe(false)
    for (const platform of ['windows', 'linux', 'other'] as const) {
      expect(isShortcutSuppressed(option, false, platform)).toBe(true)
      expect(isShortcutSuppressed({ ...option, ctrlKey: true }, false, platform)).toBe(true)
    }
    // The macOS exception must not bypass composition or other modifier guards.
    expect(isShortcutSuppressed({ ...option, ctrlKey: true }, false, 'mac')).toBe(true)
    expect(isShortcutSuppressed({ ...option, metaKey: true }, false, 'mac')).toBe(true)
    expect(isShortcutSuppressed({ ...option, isComposing: true }, false, 'mac')).toBe(true)
    expect(isShortcutSuppressed({ ...option, key: 'Dead' }, false, 'mac')).toBe(true)
  })

  it('uses physical command letters outside composition and preserves exact modifiers', () => {
    expect(resolveProjectShortcut(key({ key: 'ㅓ', code: 'KeyZ', metaKey: true }), 'piano')).toBe('undo')
    expect(resolveProjectShortcut(key({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true }), 'timeline')).toBe('redo')
    expect(resolveProjectShortcut(key({ key: 'z', code: 'KeyZ', ctrlKey: true, altKey: true }), 'timeline')).toBeNull()
    expect(resolveProjectShortcut(key({ key: ' ', code: 'Space', ctrlKey: true }), 'timeline')).toBeNull()
    expect(resolveProjectShortcut(key({ key: 'Delete', shiftKey: true }), 'timeline')).toBeNull()
  })

  it('does not reprocess a handled event or override browser-reserved region shortcuts', () => {
    expect(resolveProjectShortcut(key({ defaultPrevented: true }), 'timeline')).toBeNull()
    for (const letter of ['d', 't', 'r']) {
      expect(resolveProjectShortcut(key({ key: letter, code: `Key${letter.toUpperCase()}`, ctrlKey: true }), 'timeline')).toBeNull()
    }
    expect(resolveProjectShortcut(key({ key: 's', code: 'KeyS' }), 'timeline')).toBeNull()
  })
})

describe('pointer gesture timing', () => {
  it('preserves a humanized start during a pitch-only drag and a snapped translation', () => {
    const original = .025
    expect(original + snapDragDelta(0, .25)).toBe(.025)
    expect(original + snapDragDelta(.27, .25)).toBe(.275)
    expect(snapDragDelta(.023, 0)).toBe(.023)
  })

  it('treats small pointer jitter as a click and permits a vertical note drag', () => {
    expect(crossedDragThreshold(3, 3)).toBe(false)
    expect(crossedDragThreshold(4)).toBe(true)
    expect(crossedDragThreshold(0, 4)).toBe(true)
    expect(snapDragDelta(0, .25)).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import { SHORTCUT_BINDINGS, SHORTCUT_TABLE, ZOOM_COMMANDS, crossedDragThreshold, dragModifiers, isShortcutSuppressed, resolveProjectShortcut, shortcutLabel, shortcutPlatform, snapDragDelta } from './input'
import type { ProjectShortcut, ShortcutEvent, ShortcutPlatform, ShortcutScope } from './input'

const key = (patch: Partial<ShortcutEvent> = {}): ShortcutEvent => ({ key: 'Delete', code: 'Delete', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...patch })

describe('editing keyboard ownership', () => {
  it('never routes a note-area or native-control Delete to a region or track', () => {
    for (const k of ['Delete', 'Backspace']) {
      expect(resolveProjectShortcut(key({ key: k, code: k }), 'timeline')).toBe('deleteClip')
      expect(resolveProjectShortcut(key({ key: k, code: k }), 'piano')).toBe('deleteNotes')
      for (const scope of ['workspace', 'text', 'control', 'dialog', 'outside'] as ShortcutScope[]) {
        expect(resolveProjectShortcut(key({ key: k, code: k }), scope)).toBeNull()
      }
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

  it('does not reprocess a handled event and keeps region shortcuts inside the timeline', () => {
    expect(resolveProjectShortcut(key({ defaultPrevented: true }), 'timeline')).toBeNull()
    for (const [letter, command] of [['d', 'duplicate'], ['t', 'split'], ['r', 'repeat']] as const) {
      const event = key({ key: letter, code: `Key${letter.toUpperCase()}`, ctrlKey: true })
      expect(resolveProjectShortcut(event, 'timeline')).toBe(command)
      for (const scope of ['piano', 'workspace', 'text'] as ShortcutScope[]) expect(resolveProjectShortcut(event, scope)).toBeNull()
    }
  })
})

const ALL: ShortcutScope[] = ['timeline', 'piano', 'mixer', 'devices', 'workspace', 'text', 'control', 'dialog', 'outside']
const k = (name: string, code: string, patch: Partial<ShortcutEvent> = {}) => key({ key: name, code, ...patch })
const L = (c: string, patch: Partial<ShortcutEvent> = {}) => k(c.toLowerCase(), `Key${c}`, patch)
const MOD = { ctrlKey: true }, CMD = { metaKey: true }, ALT = { altKey: true }, SHIFT = { shiftKey: true }

/** Resolves only in the listed scopes and nowhere else. The mixer and device rack inherit workspace keys. */
function expectScopes(event: ShortcutEvent, command: ProjectShortcut, scopes: ShortcutScope[], platform: ShortcutPlatform = 'windows') {
  const expected = scopes.includes('workspace') ? [...scopes, 'mixer', 'devices'] : scopes
  for (const scope of ALL) expect(resolveProjectShortcut(event, scope, false, platform), `${command} in ${scope}`).toBe(expected.includes(scope) ? command : null)
}

describe('Logic-style key commands', () => {
  const cases: [ShortcutEvent, ProjectShortcut, ShortcutScope[]][] = [
    [L('T', MOD), 'split', ['timeline']], [L('E', MOD), 'split', ['timeline']], [L('T', CMD), 'split', ['timeline']], [L('E', CMD), 'split', ['timeline']],
    [L('J', MOD), 'join', ['timeline']], [L('D', MOD), 'duplicate', ['timeline']], [L('R', MOD), 'repeat', ['timeline']],
    [L('C', MOD), 'copy', ['timeline', 'piano']], [L('X', MOD), 'cut', ['timeline', 'piano']], [L('V', MOD), 'paste', ['timeline', 'piano']], [L('A', MOD), 'selectAll', ['timeline', 'piano']],
    [L('L'), 'loopClip', ['timeline']], [L('M', ALT), 'muteClip', ['timeline']],
    [L('M'), 'muteTrack', ['timeline', 'workspace']], [L('S'), 'soloTrack', ['timeline', 'workspace']],
    [k('ArrowLeft', 'ArrowLeft', ALT), 'nudgeLeft', ['timeline', 'piano']], [k('ArrowRight', 'ArrowRight', ALT), 'nudgeRight', ['timeline', 'piano']],
    [k('ArrowLeft', 'ArrowLeft', { ...ALT, ...SHIFT }), 'trimEndLeft', ['timeline', 'piano']], [k('ArrowRight', 'ArrowRight', { ...ALT, ...SHIFT }), 'trimEndRight', ['timeline', 'piano']],
    [k('[', 'BracketLeft', MOD), 'trimStartToPlayhead', ['timeline']], [k(']', 'BracketRight', CMD), 'trimEndToPlayhead', ['timeline']],
    [k(';', 'Semicolon'), 'moveToPlayhead', ['timeline']],
    [k('ArrowLeft', 'ArrowLeft'), 'selectPrev', ['timeline']], [k('ArrowRight', 'ArrowRight'), 'selectNext', ['timeline']],
    [k('ArrowUp', 'ArrowUp'), 'trackUp', ['timeline', 'workspace']], [k('ArrowDown', 'ArrowDown'), 'trackDown', ['timeline', 'workspace']],
    [k('Backspace', 'Backspace', MOD), 'deleteTrack', ['timeline', 'workspace']], [k('Delete', 'Delete', CMD), 'deleteTrack', ['timeline', 'workspace']],
    [L('N', { ...MOD, ...ALT }), 'newTrack', ['timeline', 'workspace']], [L('N', { ...CMD, ...ALT }), 'newTrack', ['timeline', 'workspace']],
    [k('N', 'KeyN', SHIFT), 'renameClip', ['timeline']], [k('Enter', 'Enter', SHIFT), 'renameTrack', ['timeline', 'workspace']],
    [L('C'), 'cycle', ['timeline', 'piano', 'workspace']], [L('R'), 'record', ['timeline', 'piano', 'workspace']], [L('K'), 'metronome', ['timeline', 'piano', 'workspace']],
    [k('Enter', 'Enter'), 'home', ['timeline', 'workspace']], [k('Home', 'Home'), 'home', ['timeline', 'piano', 'workspace']],
    [k(',', 'Comma'), 'rewind', ['timeline', 'workspace']], [k('.', 'Period'), 'forward', ['timeline', 'workspace']],
    [k('ArrowRight', 'ArrowRight', MOD), 'zoomIn', ['timeline', 'piano', 'workspace']], [k('ArrowLeft', 'ArrowLeft', CMD), 'zoomOut', ['timeline', 'piano', 'workspace']], [L('Z'), 'zoomToFit', ['timeline', 'piano', 'workspace']],
    [k('ArrowDown', 'ArrowDown', MOD), 'zoomInV', ['timeline', 'piano', 'workspace']], [k('ArrowUp', 'ArrowUp', CMD), 'zoomOutV', ['timeline', 'piano', 'workspace']],
    [L('U', MOD), 'setLoopFromSelection', ['timeline']], [L('G', MOD), 'snapToggle', ['timeline', 'piano', 'workspace']],
    [L('Q'), 'quantize', ['piano']],
    [k('ArrowUp', 'ArrowUp', ALT), 'transposeUp', ['timeline', 'piano']], [k('ArrowDown', 'ArrowDown', ALT), 'transposeDown', ['timeline', 'piano']],
    [k('ArrowUp', 'ArrowUp', { ...ALT, ...SHIFT }), 'transposeOctaveUp', ['timeline', 'piano']], [k('ArrowDown', 'ArrowDown', { ...ALT, ...SHIFT }), 'transposeOctaveDown', ['timeline', 'piano']],
    [k(' ', 'Space'), 'playback', ['timeline', 'piano', 'workspace']], [k(' ', 'Space', SHIFT), 'playFromSelection', ['timeline', 'piano', 'workspace']],
    [k('Escape', 'Escape'), 'escape', ['timeline', 'piano', 'workspace']], [k('?', 'Slash', SHIFT), 'help', ['timeline', 'piano', 'workspace']],
    [L('S', MOD), 'save', ['timeline', 'piano', 'workspace']], [L('Z', CMD), 'undo', ['timeline', 'piano', 'workspace']], [L('Z', { ...MOD, ...SHIFT }), 'redo', ['timeline', 'piano', 'workspace']],
  ]

  it.each(cases.map(([event, command, scopes]) => ({ event, command, scopes })))('$command resolves only in its scopes', ({ event, command, scopes }) => {
    expectScopes(event, command, scopes)
    expectScopes(event, command, scopes, 'mac')
  })

  it('rejects extra or missing modifiers for every binding', () => {
    for (const [event, command, scopes] of cases) {
      for (const flip of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
        // '?' needs Shift on some layouts and not on others.
        if (command === 'help' && flip === 'shiftKey') continue
        const result = resolveProjectShortcut({ ...event, [flip]: !event[flip] }, scopes[0], false, 'windows')
        expect(result, `${command} with ${flip} toggled`).not.toBe(command)
      }
    }
  })

  it('never fires single-letter or punctuation commands with a modifier or in text', () => {
    const plain = [L('L'), L('M'), L('S'), L('C'), L('R'), L('K'), L('Z'), L('Q'), k(';', 'Semicolon'), k(',', 'Comma'), k('.', 'Period')]
    for (const event of plain) {
      for (const scope of ['text', 'control', 'dialog', 'outside'] as ShortcutScope[]) expect(resolveProjectShortcut(event, scope)).toBeNull()
      for (const scope of ['timeline', 'piano', 'workspace'] as ShortcutScope[]) {
        expect(resolveProjectShortcut({ ...event, shiftKey: true }, scope)).toBeNull()
        expect(resolveProjectShortcut({ ...event, ctrlKey: true, altKey: true }, scope)).toBeNull()
      }
    }
    expect(resolveProjectShortcut(L('L', ALT), 'timeline')).toBeNull()
    expect(resolveProjectShortcut(L('Q', MOD), 'piano')).toBeNull()
  })

  it('uses the physical key on a Korean layout and falls back to key without code', () => {
    expect(resolveProjectShortcut(k('ㅡ', 'KeyM'), 'timeline')).toBe('muteTrack')
    expect(resolveProjectShortcut(k('ㅅ', 'KeyT', CMD), 'timeline', false, 'mac')).toBe('split')
    expect(resolveProjectShortcut(k('µ', 'KeyM', ALT), 'timeline', false, 'mac')).toBe('muteClip')
    expect(resolveProjectShortcut({ ...k('j', ''), code: undefined, ctrlKey: true }, 'timeline')).toBe('join')
    expect(resolveProjectShortcut({ ...k('N', ''), code: undefined, shiftKey: true }, 'timeline')).toBe('renameClip')
  })

  it('only accepts Ctrl+Y as redo on Windows and Linux', () => {
    const ctrlY = L('Y', MOD)
    expect(resolveProjectShortcut(ctrlY, 'timeline', false, 'windows')).toBe('redo')
    expect(resolveProjectShortcut(ctrlY, 'piano', false, 'linux')).toBe('redo')
    expect(resolveProjectShortcut(ctrlY, 'timeline', false, 'mac')).toBeNull()
    expect(resolveProjectShortcut(ctrlY, 'timeline', false, 'other')).toBeNull()
    expect(resolveProjectShortcut(L('Y', CMD), 'timeline', false, 'windows')).toBeNull()
    expect(resolveProjectShortcut(L('Y', { ...MOD, ...SHIFT }), 'timeline', false, 'windows')).toBeNull()
    expect(resolveProjectShortcut(L('Y', MOD), 'text', false, 'windows')).toBeNull()
    for (const platform of ['mac', 'windows', 'linux', 'other'] as const) expect(resolveProjectShortcut(L('Z', { ...CMD, ...SHIFT }), 'workspace', false, platform)).toBe('redo')
  })

  it('rejects Alt on Mod commands except the explicit new-track chord', () => {
    for (const c of ['T', 'E', 'J', 'D', 'R', 'C', 'X', 'V', 'A', 'U', 'G', 'S']) expect(resolveProjectShortcut(L(c, { ...MOD, ...ALT }), 'timeline')).toBeNull()
    expect(resolveProjectShortcut(L('N', MOD), 'timeline')).toBeNull()
    expect(resolveProjectShortcut(L('N', { ...MOD, ...CMD, ...ALT }), 'timeline')).toBeNull()
    expect(resolveProjectShortcut(L('N', { ...MOD, ...ALT, ...SHIFT }), 'timeline')).toBeNull()
  })

  it('keeps AltGr text entry and IME composition away from Alt commands', () => {
    const altGr = (name: string) => name === 'AltGraph'
    expect(resolveProjectShortcut(L('M', { ...ALT, ...MOD, getModifierState: altGr }), 'timeline', false, 'windows')).toBeNull()
    expect(resolveProjectShortcut(k('ArrowLeft', 'ArrowLeft', { ...ALT, getModifierState: altGr }), 'timeline', false, 'windows')).toBeNull()
    expect(resolveProjectShortcut(k('ArrowLeft', 'ArrowLeft', { ...ALT, getModifierState: altGr }), 'timeline', false, 'mac')).toBe('nudgeLeft')
    expect(resolveProjectShortcut(L('M', { isComposing: true }), 'timeline')).toBeNull()
  })
})

describe('per-area zoom keys', () => {
  it('maps Logic zoom arrows in every focusable area', () => {
    for (const scope of ['timeline', 'piano', 'mixer', 'devices', 'workspace'] as ShortcutScope[]) {
      expect(resolveProjectShortcut(k('ArrowRight', 'ArrowRight', MOD), scope)).toBe('zoomIn')
      expect(resolveProjectShortcut(k('ArrowLeft', 'ArrowLeft', MOD), scope)).toBe('zoomOut')
      expect(resolveProjectShortcut(k('ArrowDown', 'ArrowDown', CMD), scope, false, 'mac')).toBe('zoomInV')
      expect(resolveProjectShortcut(k('ArrowUp', 'ArrowUp', CMD), scope, false, 'mac')).toBe('zoomOutV')
      expect(resolveProjectShortcut(L('Z'), scope)).toBe('zoomToFit')
    }
    for (const scope of ['text', 'control', 'dialog', 'outside'] as ShortcutScope[]) expect(resolveProjectShortcut(k('ArrowDown', 'ArrowDown', MOD), scope)).toBeNull()
  })

  it('keeps note and clip editing out of the mixer and device rack', () => {
    for (const scope of ['mixer', 'devices'] as ShortcutScope[]) {
      expect(resolveProjectShortcut(k('Delete', 'Delete'), scope)).toBeNull()
      expect(resolveProjectShortcut(L('C', MOD), scope)).toBeNull()
      expect(resolveProjectShortcut(L('Q'), scope)).toBeNull()
      expect(resolveProjectShortcut(k(' ', 'Space'), scope)).toBe('playback')
      expect(resolveProjectShortcut(L('Z', MOD), scope)).toBe('undo')
    }
  })

  it('labels the vertical zoom with Logic keys', () => {
    expect(shortcutLabel('zoomInV', 'mac')).toBe('⌘↓')
    expect(shortcutLabel('zoomOutV', 'windows')).toBe('Ctrl+↑')
    for (const command of ZOOM_COMMANDS) expect(SHORTCUT_TABLE.find(r => r.command === command)?.scopes).toEqual(['timeline', 'piano', 'workspace'])
  })
})

describe('shortcut labels and table', () => {
  it('formats the primary binding per platform', () => {
    expect(shortcutLabel('split', 'mac')).toBe('⌘T')
    expect(shortcutLabel('split', 'windows')).toBe('Ctrl+T')
    expect(shortcutLabel('redo', 'mac')).toBe('⇧⌘Z')
    expect(shortcutLabel('redo', 'linux')).toBe('Ctrl+Shift+Z')
    expect(shortcutLabel('newTrack', 'mac')).toBe('⌥⌘N')
    expect(shortcutLabel('newTrack', 'windows')).toBe('Ctrl+Alt+N')
    expect(shortcutLabel('muteClip', 'windows')).toBe('Alt+M')
    expect(shortcutLabel('transposeOctaveUp', 'mac')).toBe('⌥⇧↑')
    expect(shortcutLabel('deleteTrack', 'mac')).toBe('⌘⌫')
    expect(shortcutLabel('renameTrack', 'windows')).toBe('Shift+Enter')
    expect(shortcutLabel('playback', 'mac')).toBe('Space')
    expect(shortcutLabel('moveToPlayhead', 'windows')).toBe(';')
  })

  it('lists every command once with consistent scopes and platform alternates', () => {
    const commands = SHORTCUT_TABLE.map(row => row.command)
    expect(new Set(commands).size).toBe(commands.length)
    expect(new Set(SHORTCUT_BINDINGS.map(b => b.command))).toEqual(new Set(commands))
    const row = (command: ProjectShortcut) => SHORTCUT_TABLE.find(r => r.command === command)!
    expect(row('split')).toMatchObject({ mac: '⌘T / ⌘E', win: 'Ctrl+T / Ctrl+E', scopes: ['timeline'] })
    expect(row('redo')).toMatchObject({ mac: '⇧⌘Z', win: 'Ctrl+Shift+Z / Ctrl+Y' })
    expect(row('home').scopes).toEqual(['timeline', 'piano', 'workspace'])
    for (const r of SHORTCUT_TABLE) {
      expect(r.label && r.mac && r.win && r.logic, r.command).toBeTruthy()
      for (const scope of r.scopes) expect(SHORTCUT_BINDINGS.some(b => b.command === r.command && b.scopes.includes(scope))).toBe(true)
    }
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

  it('snaps to the grid, a fine step, or not at all', () => {
    expect(snapDragDelta(.3, .25, 'snap')).toBe(.25)
    expect(snapDragDelta(.3, .25, 'fine')).toBe(.3125)
    expect(snapDragDelta(.3, .25, 'fine', 1 / 16)).toBe(.3125)
    expect(snapDragDelta(.3, .25, 'fine', .1)).toBeCloseTo(.3)
    expect(snapDragDelta(.27, 1, 'fine', 0)).toBe(.27)
    expect(snapDragDelta(.3, .25, 'none')).toBe(.3)
    expect(snapDragDelta(-.13, .25, 'none', .0625)).toBe(-.13)
  })

  it('maps drag modifiers the same way on every platform', () => {
    const mods = (altKey: boolean, ctrlKey: boolean, shiftKey: boolean, metaKey = false) => ({ altKey, ctrlKey, shiftKey, metaKey })
    for (const platform of ['mac', 'windows', 'linux', 'other'] as const) {
      expect(dragModifiers(mods(false, false, false), platform)).toEqual({ copy: false, fine: false, noSnap: false, axisLock: false })
      expect(dragModifiers(mods(true, false, false), platform)).toEqual({ copy: true, fine: false, noSnap: false, axisLock: false })
      expect(dragModifiers(mods(false, true, false), platform)).toEqual({ copy: false, fine: true, noSnap: false, axisLock: false })
      expect(dragModifiers(mods(false, true, true), platform)).toEqual({ copy: false, fine: false, noSnap: true, axisLock: false })
      expect(dragModifiers(mods(false, false, true), platform)).toEqual({ copy: false, fine: false, noSnap: false, axisLock: true })
      expect(dragModifiers(mods(true, false, true), platform)).toEqual({ copy: true, fine: false, noSnap: false, axisLock: true })
      expect(dragModifiers(mods(true, true, true), platform)).toEqual({ copy: true, fine: false, noSnap: true, axisLock: false })
      expect(dragModifiers(mods(false, false, false, true), platform)).toEqual({ copy: false, fine: false, noSnap: false, axisLock: false })
    }
  })
})

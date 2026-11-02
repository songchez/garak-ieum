import { describe, expect, it, vi } from 'vitest'
import { bindTransportShortcuts, isTransportTextControl, type TransportShortcutContext } from './transportShortcuts'

type Control = Parameters<typeof isTransportTextControl>[0]
const control = (tagName: string, patch: Partial<Control> = {}, attributes: Record<string, string> = {}): Control => ({
  tagName, getAttribute: name => attributes[name] ?? null, ...patch,
})

function keyboard(type: 'keydown' | 'keyup', patch: Partial<KeyboardEvent> = {}) {
  return Object.assign(new Event(type, { cancelable: true }), {
    key: ' ', code: 'Space', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    repeat: false, isComposing: false, keyCode: 32, getModifierState: () => false, ...patch,
  }) as KeyboardEvent
}

function setup() {
  const host = new EventTarget()
  const context: TransportShortcutContext = { modalOpen: false, textEditing: false, enabled: true }
  const state = { held: false }
  const run = vi.fn()
  const bind = () => bindTransportShortcuts(host, () => context, run, state)
  const dispose = bind()
  const send = (type: 'keydown' | 'keyup', patch: Partial<KeyboardEvent> = {}) => {
    const event = keyboard(type, patch)
    host.dispatchEvent(event)
    return event
  }
  return { host, context, state, run, bind, dispose, send }
}

describe('transport focus ownership', () => {
  it('takes Space from selectors, numeric editors, sliders, buttons, menus and toggles', () => {
    const controls = [
      control('SELECT'), control('BUTTON'), control('INPUT', { type: 'number' }),
      control('INPUT', { type: 'range' }), control('INPUT', { type: 'checkbox' }),
      control('INPUT', { type: 'radio' }), control('INPUT', { type: 'color' }),
      control('INPUT', { type: 'file' }), control('INPUT', { type: 'date' }),
      ...['slider', 'spinbutton', 'combobox', 'listbox', 'menuitem', 'switch', 'checkbox'].map(role => control('DIV', {}, { role })),
      control('BODY'), control('DIV', {}, { 'data-selectable-text': '' }),
    ]
    for (const target of controls) expect(isTransportTextControl(target), `${target.tagName} ${target.type ?? target.getAttribute('role')}`).toBe(false)
  })

  it('leaves spaces to active text editing, including editable comboboxes and inherited contenteditable', () => {
    const controls = [
      control('INPUT'), ...['text', 'search', 'email', 'url', 'tel', 'password'].map(type => control('INPUT', { type })),
      control('TEXTAREA'), control('DIV', {}, { role: 'textbox' }), control('DIV', {}, { role: 'searchbox' }),
      control('INPUT', { type: 'text' }, { role: 'combobox' }), control('SPAN', { isContentEditable: true }),
    ]
    for (const target of controls) expect(isTransportTextControl(target)).toBe(true)
    expect(isTransportTextControl(control('INPUT', { readOnly: true }))).toBe(false)
    expect(isTransportTextControl(control('TEXTAREA', { readOnly: true }))).toBe(false)
    expect(isTransportTextControl(control('DIV', {}, { role: 'textbox', 'aria-readonly': 'true' }))).toBe(false)
  })
})

describe('global transport key lifecycle', () => {
  it('captures both halves before control handlers and toggles once per physical press', () => {
    const { host, send, run } = setup()
    const controlDown = vi.fn(), controlUp = vi.fn()
    host.addEventListener('keydown', controlDown)
    host.addEventListener('keyup', controlUp)
    expect(send('keydown').defaultPrevented).toBe(true)
    for (let i = 0; i < 4; i++) expect(send('keydown', { repeat: true }).defaultPrevented).toBe(true)
    // Even a duplicate non-repeat event cannot toggle again before key release.
    expect(send('keydown').defaultPrevented).toBe(true)
    expect(send('keyup').defaultPrevented).toBe(true)
    expect(controlDown).not.toHaveBeenCalled()
    expect(controlUp).not.toHaveBeenCalled()
    expect(run.mock.calls).toEqual([['playback']])
    send('keydown'); send('keyup')
    expect(run.mock.calls).toEqual([['playback'], ['playback']])
  })

  it('keeps owned release from activating a newly focused dialog button or text field', () => {
    const { send, context, run } = setup()
    send('keydown')
    context.modalOpen = true; context.textEditing = true
    expect(send('keydown', { repeat: true, shiftKey: true }).defaultPrevented).toBe(true)
    expect(send('keyup', { shiftKey: true, ctrlKey: true }).defaultPrevented).toBe(true)
    expect(send('keydown').defaultPrevented).toBe(false)
    expect(send('keyup').defaultPrevented).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('gives modals and text fields their complete native Space press', () => {
    for (const field of ['modalOpen', 'textEditing'] as const) {
      const { send, context, run } = setup()
      context[field] = true
      expect(send('keydown').defaultPrevented).toBe(false)
      expect(send('keydown', { repeat: true }).defaultPrevented).toBe(false)
      expect(send('keyup').defaultPrevented).toBe(false)
      expect(run).not.toHaveBeenCalled()
    }
  })

  it('consumes workspace Space during busy work without activating a dropdown or playing', () => {
    const { send, context, run } = setup()
    context.enabled = false
    expect(send('keydown').defaultPrevented).toBe(true)
    context.enabled = true
    expect(send('keydown', { repeat: true }).defaultPrevented).toBe(true)
    send('keyup')
    expect(run).not.toHaveBeenCalled()
    send('keydown')
    expect(run).toHaveBeenCalledWith('playback')
  })

  it('retains key ownership across a React effect rebind and removes old listeners', () => {
    const { send, bind, dispose, run } = setup()
    send('keydown')
    dispose()
    const clean = bind()
    expect(send('keyup').defaultPrevented).toBe(true)
    send('keydown'); send('keyup')
    expect(run).toHaveBeenCalledTimes(2)
    clean()
    expect(send('keydown').defaultPrevented).toBe(false)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('clears a lost release on window blur and never starts playback from a stray repeat', () => {
    const { host, send, run } = setup()
    send('keydown')
    host.dispatchEvent(new Event('blur'))
    expect(send('keyup').defaultPrevented).toBe(false)
    expect(send('keydown', { repeat: true }).defaultPrevented).toBe(true)
    send('keyup')
    expect(run).toHaveBeenCalledTimes(1)
    send('keydown')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('preserves IME, AltGraph and system modifier chords', () => {
    const patches: Partial<KeyboardEvent>[] = [
      { ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true },
      { keyCode: 229 }, { key: 'Process' }, { key: 'Dead' },
      { getModifierState: name => name === 'AltGraph' }, { key: 'a', code: 'KeyA' },
    ]
    for (const patch of patches) {
      const { send, run } = setup()
      expect(send('keydown', patch).defaultPrevented).toBe(false)
      expect(send('keyup', patch).defaultPrevented).toBe(false)
      expect(run).not.toHaveBeenCalled()
    }
    const { host, run } = setup()
    const prevented = keyboard('keydown'); prevented.preventDefault(); host.dispatchEvent(prevented)
    expect(run).not.toHaveBeenCalled()
  })

  it('routes Shift+Space from the same controls and supports key-only browser events', () => {
    const { send, run } = setup()
    send('keydown', { shiftKey: true }); send('keyup')
    send('keydown', { code: '' }); send('keyup', { code: '' })
    send('keydown', { code: '', key: 'Spacebar' }); send('keyup', { code: '', key: 'Spacebar' })
    expect(run.mock.calls).toEqual([['playFromSelection'], ['playback'], ['playback']])
  })

  it('keeps Enter native except for workspace checkbox/radio activation', () => {
    const { send, context, run } = setup()
    const enter = { key: 'Enter', code: 'Enter' }
    expect(send('keydown', enter).defaultPrevented).toBe(false)
    const activate = vi.fn(); context.activateToggle = activate
    expect(send('keydown', enter).defaultPrevented).toBe(true)
    expect(send('keydown', { ...enter, repeat: true }).defaultPrevented).toBe(true)
    expect(activate).toHaveBeenCalledTimes(1)
    context.modalOpen = true
    expect(send('keydown', enter).defaultPrevented).toBe(false)
    expect(activate).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()
  })
})

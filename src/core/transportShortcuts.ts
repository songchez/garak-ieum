import { isShortcutSuppressed, isUnmodified, type ShortcutEvent } from './input'

export type TransportCommand = 'playback' | 'playFromSelection'

/** Only controls that accept text own Space; numeric/range/select controls do not. */
export function isTransportTextControl(control: {
  tagName: string
  type?: string
  readOnly?: boolean
  isContentEditable?: boolean
  getAttribute(name: string): string | null
}): boolean {
  if (control.isContentEditable) return true
  if (control.readOnly || control.getAttribute('aria-readonly') === 'true') return false
  const tag = control.tagName.toLowerCase()
  if (tag === 'textarea') return true
  if (tag === 'input') return ['text', 'search', 'email', 'url', 'tel', 'password'].includes(control.type ?? 'text')
  return ['textbox', 'searchbox'].includes(control.getAttribute('role') ?? '')
}

export function isTransportTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target instanceof HTMLElement && target.isContentEditable) return true
  const control = target.closest<HTMLElement>('input,textarea,[role="textbox"],[role="searchbox"]')
  return !!control && isTransportTextControl(control)
}

export interface TransportShortcutContext {
  modalOpen: boolean
  textEditing: boolean
  enabled: boolean
  /** Enter replaces Space activation for native checkbox/radio controls outside modals. */
  activateToggle?: () => void
}

export interface TransportKeyState { held: boolean }

const isSpace = (event: ShortcutEvent) => event.code ? event.code === 'Space' : event.key === ' ' || event.key === 'Spacebar'
const consume = (event: KeyboardEvent) => { event.preventDefault(); event.stopImmediatePropagation() }

/**
 * Capture before React, native control defaults, and editor propagation guards.
 * Keep `state` across React renders: the matching keyup still belongs to the
 * transport even if focus, modifiers, or the open modal changed after keydown.
 */
export function bindTransportShortcuts(
  host: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  getContext: (event: KeyboardEvent) => TransportShortcutContext,
  run: (command: TransportCommand) => void,
  state: TransportKeyState,
): () => void {
  const down = (event: KeyboardEvent) => {
    const space = isSpace(event)
    if (space && state.held) { consume(event); return }
    if ((!space && event.key !== 'Enter') || isShortcutSuppressed(event, true) || !isUnmodified(event, space)) return
    const context = getContext(event)
    if (context.modalOpen || context.textEditing) return
    if (!space) {
      if (context.activateToggle) {
        consume(event)
        if (!event.repeat && context.enabled) context.activateToggle()
      }
      return
    }
    consume(event)
    state.held = true
    if (!event.repeat && context.enabled) run(event.shiftKey ? 'playFromSelection' : 'playback')
  }
  const up = (event: KeyboardEvent) => {
    if (!isSpace(event) || !state.held) return
    consume(event)
    state.held = false
  }
  const blur = () => { state.held = false }
  const capture = { capture: true }
  host.addEventListener('keydown', down, capture)
  host.addEventListener('keyup', up, capture)
  host.addEventListener('blur', blur)
  return () => {
    host.removeEventListener('keydown', down, capture)
    host.removeEventListener('keyup', up, capture)
    host.removeEventListener('blur', blur)
  }
}

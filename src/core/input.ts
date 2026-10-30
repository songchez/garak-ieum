/** Keyboard routing uses a logical editing scope, never selection alone. */
export type ShortcutScope = 'timeline' | 'piano' | 'workspace' | 'text' | 'control' | 'dialog' | 'outside'
export type ShortcutPlatform = 'mac' | 'windows' | 'linux' | 'other'

export function shortcutPlatform(platform = typeof navigator === 'undefined' ? '' : navigator.platform): ShortcutPlatform {
  if (/^Mac/i.test(platform)) return 'mac'
  if (/^Win/i.test(platform)) return 'windows'
  if (/Linux/i.test(platform)) return 'linux'
  return 'other'
}

export interface ShortcutEvent {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
  defaultPrevented?: boolean
  isComposing?: boolean
  keyCode?: number
  getModifierState?: (name: string) => boolean
}

export type ProjectShortcut = 'playback' | 'undo' | 'redo' | 'save' | 'deleteClip' | 'home' | 'escape' | 'help'

export function isShortcutSuppressed(event: ShortcutEvent, allowRepeat = false, platform: ShortcutPlatform = shortcutPlatform()): boolean {
  // Firefox on macOS can report Option as AltGraph. Only that Option-only
  // case (with optional Shift) is exempt; actual AltGr remains protected.
  const macOption = platform === 'mac' && event.altKey && !event.ctrlKey && !event.metaKey
  const altGraph = !!event.getModifierState?.('AltGraph') && !macOption
  return !!(event.defaultPrevented || event.isComposing || event.keyCode === 229
    || event.key === 'Process' || event.key === 'Dead'
    || altGraph || (!allowRepeat && event.repeat))
}

export function isUnmodified(event: ShortcutEvent, allowShift = false): boolean {
  return !event.ctrlKey && !event.metaKey && !event.altKey && (allowShift || !event.shiftKey)
}

/** Native text/control keys remain native, including inherited contenteditable. */
export function shortcutScope(target: EventTarget | null): ShortcutScope {
  if (!(target instanceof Element)) return 'outside'
  if (target.closest('[role="dialog"],dialog,[aria-modal="true"]')) return 'dialog'
  if ((target instanceof HTMLElement && target.isContentEditable)
    || target.closest('input,textarea,select,[role="textbox"],[role="searchbox"],[role="combobox"],[role="spinbutton"],[role="slider"]')) return 'text'
  const area = target.closest<HTMLElement>('[data-keyboard-scope]')?.dataset.keyboardScope
  // Note buttons are editing objects, while piano keys and ordinary buttons
  // retain native Space/Enter activation and do not edit the selected note.
  if (target.closest('button,a[href],[role="checkbox"],[role="switch"]') && !target.closest('.piano-note')) return 'control'
  if (area === 'piano' || area === 'timeline') return area
  if (target.closest('.studio-app') || target === document.body) return 'workspace'
  return 'outside'
}

/** includeRepeat lets a dispatcher consume a held key without executing it. */
export function resolveProjectShortcut(event: ShortcutEvent, scope: ShortcutScope, includeRepeat = false, platform: ShortcutPlatform = shortcutPlatform()): ProjectShortcut | null {
  if (isShortcutSuppressed(event, includeRepeat, platform) || ['text', 'control', 'dialog', 'outside'].includes(scope)) return null
  const mod = event.ctrlKey !== event.metaKey && !event.altKey
  const letter = (code: string, key: string) => event.code ? event.code === code : event.key.toLowerCase() === key
  if (mod && letter('KeyZ', 'z')) return event.shiftKey ? 'redo' : 'undo'
  if (mod && !event.shiftKey && letter('KeyS', 's')) return 'save'
  // Mod+D (browser bookmark / Logic track settings) and Mod+T (new browser tab)
  // are deliberately not assigned to region editing.
  if (isUnmodified(event)) {
    if (event.code === 'Space' || event.key === ' ') return 'playback'
    if (event.key === 'Home') return 'home'
    if (event.key === 'Escape') return 'escape'
    if (scope === 'timeline' && (event.key === 'Delete' || event.key === 'Backspace')) return 'deleteClip'
  }
  if (event.key === '?' && isUnmodified(event, true)) return 'help'
  return null
}

/** Snap movement relative to the original timing, preserving humanized offsets. */
export function snapDragDelta(delta: number, step: number): number {
  return step > 0 ? Math.round(delta / step) * step : delta
}

export function crossedDragThreshold(dx: number, dy = 0, threshold = 4): boolean {
  return Math.abs(dx) >= threshold || Math.abs(dy) >= threshold
}

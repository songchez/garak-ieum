/** Keyboard routing uses a logical editing scope, never selection alone. */
export type ShortcutScope = 'timeline' | 'piano' | 'mixer' | 'devices' | 'workspace' | 'text' | 'control' | 'dialog' | 'outside'
export type ShortcutEditScope = Extract<ShortcutScope, 'timeline' | 'piano' | 'mixer' | 'devices' | 'workspace'>
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

export type ProjectShortcut =
  | 'playback' | 'playFromSelection' | 'undo' | 'redo' | 'save' | 'home' | 'rewind' | 'forward' | 'escape' | 'help'
  | 'cycle' | 'record' | 'metronome' | 'snapToggle' | 'zoomIn' | 'zoomOut' | 'zoomInV' | 'zoomOutV' | 'zoomToFit' | 'setLoopFromSelection'
  | 'deleteClip' | 'split' | 'join' | 'duplicate' | 'repeat' | 'copy' | 'cut' | 'paste' | 'selectAll'
  | 'loopClip' | 'muteClip' | 'renameClip' | 'moveToPlayhead' | 'selectPrev' | 'selectNext'
  | 'nudgeLeft' | 'nudgeRight' | 'trimEndLeft' | 'trimEndRight' | 'trimStartToPlayhead' | 'trimEndToPlayhead'
  | 'muteTrack' | 'soloTrack' | 'trackUp' | 'trackDown' | 'newTrack' | 'deleteTrack' | 'renameTrack'
  | 'deleteNotes' | 'quantize' | 'transposeUp' | 'transposeDown' | 'transposeOctaveUp' | 'transposeOctaveDown'

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
  if (area === 'piano' || area === 'timeline' || area === 'mixer' || area === 'devices') return area
  if (target.closest('.studio-app') || target === document.body) return 'workspace'
  return 'outside'
}

/**
 * Modifier sets are exact. "mod" is exactly one of Ctrl/⌘ (either is accepted
 * on every platform); 'ctrl' is the literal Ctrl key; 'anyShift' ignores Shift
 * for characters such as '?' whose Shift depends on the layout.
 */
export type ShortcutMods = '' | 'shift' | 'anyShift' | 'alt' | 'altShift' | 'mod' | 'modShift' | 'modAlt' | 'ctrl'
/** Letters and punctuation match the physical `code` first, then `key` (Korean layout, no-code events). */
export interface ShortcutKey { code?: string; key: string; mac: string; win: string }
export interface ShortcutBinding { command: ProjectShortcut; key: ShortcutKey; mods: ShortcutMods; scopes: readonly ShortcutEditScope[]; platforms?: readonly ShortcutPlatform[] }

const MODS: Record<ShortcutMods, (e: ShortcutEvent) => boolean> = {
  '': e => isUnmodified(e),
  shift: e => isUnmodified(e, true) && e.shiftKey,
  anyShift: e => isUnmodified(e, true),
  alt: e => !e.ctrlKey && !e.metaKey && e.altKey && !e.shiftKey,
  altShift: e => !e.ctrlKey && !e.metaKey && e.altKey && e.shiftKey,
  mod: e => e.ctrlKey !== e.metaKey && !e.altKey && !e.shiftKey,
  modShift: e => e.ctrlKey !== e.metaKey && !e.altKey && e.shiftKey,
  modAlt: e => e.ctrlKey !== e.metaKey && e.altKey && !e.shiftKey,
  ctrl: e => e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey,
}
const MAC_MODS: Record<ShortcutMods, string> = { '': '', shift: '⇧', anyShift: '', alt: '⌥', altShift: '⌥⇧', mod: '⌘', modShift: '⇧⌘', modAlt: '⌥⌘', ctrl: '⌃' }
const WIN_MODS: Record<ShortcutMods, string> = { '': '', shift: 'Shift+', anyShift: '', alt: 'Alt+', altShift: 'Alt+Shift+', mod: 'Ctrl+', modShift: 'Ctrl+Shift+', modAlt: 'Ctrl+Alt+', ctrl: 'Ctrl+' }

const letter = (c: string): ShortcutKey => ({ code: `Key${c}`, key: c.toLowerCase(), mac: c, win: c })
const named = (key: string, mac: string, win = mac): ShortcutKey => ({ key, mac, win })
const punct = (code: string, key: string): ShortcutKey => ({ code, key, mac: key, win: key })
const SPACE: ShortcutKey = { code: 'Space', key: ' ', mac: 'Space', win: 'Space' }
const ENTER = named('Enter', '↩', 'Enter'), DEL = named('Delete', '⌦', 'Delete'), BACK = named('Backspace', '⌫', 'Backspace')
const LEFT = named('ArrowLeft', '←'), RIGHT = named('ArrowRight', '→'), UP = named('ArrowUp', '↑'), DOWN = named('ArrowDown', '↓')
const TPW = ['timeline', 'piano', 'workspace'] as const, TW = ['timeline', 'workspace'] as const, TP = ['timeline', 'piano'] as const
const T = ['timeline'] as const, P = ['piano'] as const
const PC = ['windows', 'linux'] as const

const bind = (command: ProjectShortcut, key: ShortcutKey, mods: ShortcutMods, scopes: readonly ShortcutEditScope[], platforms?: readonly ShortcutPlatform[]): ShortcutBinding => ({ command, key, mods, scopes, platforms })

/** Every binding, primary first per command. Mod+D/T/R are bound only in the timeline. */
export const SHORTCUT_BINDINGS: readonly ShortcutBinding[] = [
  bind('playback', SPACE, '', TPW), bind('playFromSelection', SPACE, 'shift', TPW),
  bind('undo', letter('Z'), 'mod', TPW), bind('redo', letter('Z'), 'modShift', TPW), bind('redo', letter('Y'), 'ctrl', TPW, PC),
  bind('save', letter('S'), 'mod', TPW),
  bind('home', named('Home', 'Home'), '', TPW), bind('home', ENTER, '', TW),
  bind('rewind', punct('Comma', ','), '', TW), bind('forward', punct('Period', '.'), '', TW),
  bind('escape', named('Escape', 'Esc'), '', TPW), bind('help', named('?', '?'), 'anyShift', TPW),
  bind('cycle', letter('C'), '', TPW), bind('record', letter('R'), '', TPW), bind('metronome', letter('K'), '', TPW),
  bind('snapToggle', letter('G'), 'mod', TPW),
  bind('zoomIn', RIGHT, 'mod', TPW), bind('zoomOut', LEFT, 'mod', TPW), bind('zoomInV', DOWN, 'mod', TPW), bind('zoomOutV', UP, 'mod', TPW),
  bind('zoomToFit', letter('Z'), '', TPW),
  bind('setLoopFromSelection', letter('U'), 'mod', T),
  bind('deleteClip', DEL, '', T), bind('deleteClip', BACK, '', T),
  bind('split', letter('T'), 'mod', T), bind('split', letter('E'), 'mod', T),
  bind('join', letter('J'), 'mod', T), bind('duplicate', letter('D'), 'mod', T), bind('repeat', letter('R'), 'mod', T),
  bind('copy', letter('C'), 'mod', TP), bind('cut', letter('X'), 'mod', TP), bind('paste', letter('V'), 'mod', TP), bind('selectAll', letter('A'), 'mod', TP),
  bind('loopClip', letter('L'), '', T), bind('muteClip', letter('M'), 'alt', T), bind('renameClip', letter('N'), 'shift', T),
  bind('moveToPlayhead', punct('Semicolon', ';'), '', T),
  bind('selectPrev', LEFT, '', T), bind('selectNext', RIGHT, '', T),
  bind('nudgeLeft', LEFT, 'alt', TP), bind('nudgeRight', RIGHT, 'alt', TP),
  bind('trimEndLeft', LEFT, 'altShift', TP), bind('trimEndRight', RIGHT, 'altShift', TP),
  bind('trimStartToPlayhead', punct('BracketLeft', '['), 'mod', T), bind('trimEndToPlayhead', punct('BracketRight', ']'), 'mod', T),
  bind('muteTrack', letter('M'), '', TW), bind('soloTrack', letter('S'), '', TW),
  bind('trackUp', UP, '', TW), bind('trackDown', DOWN, '', TW),
  bind('newTrack', letter('N'), 'modAlt', TW),
  bind('deleteTrack', BACK, 'mod', TW), bind('deleteTrack', DEL, 'mod', TW),
  bind('renameTrack', ENTER, 'shift', TW),
  bind('deleteNotes', DEL, '', P), bind('deleteNotes', BACK, '', P),
  bind('quantize', letter('Q'), '', P),
  bind('transposeUp', UP, 'alt', TP), bind('transposeDown', DOWN, 'alt', TP),
  bind('transposeOctaveUp', UP, 'altShift', TP), bind('transposeOctaveDown', DOWN, 'altShift', TP),
]

const keyMatches = (event: ShortcutEvent, spec: ShortcutKey) =>
  spec.code && event.code ? event.code === spec.code : event.key.toLowerCase() === spec.key.toLowerCase()
const onPlatform = (binding: ShortcutBinding, platform: ShortcutPlatform) => !binding.platforms || binding.platforms.includes(platform)

const EDIT_SCOPES: readonly ShortcutScope[] = ['timeline', 'piano', 'mixer', 'devices', 'workspace']
/** The mixer and device rack inherit every workspace binding (transport, history, zoom…). */
const inScope = (binding: ShortcutBinding, scope: ShortcutEditScope) =>
  binding.scopes.includes(scope) || ((scope === 'mixer' || scope === 'devices') && binding.scopes.includes('workspace'))

/** includeRepeat lets a dispatcher consume a held key without executing it. */
export function resolveProjectShortcut(event: ShortcutEvent, scope: ShortcutScope, includeRepeat = false, platform: ShortcutPlatform = shortcutPlatform()): ProjectShortcut | null {
  if (isShortcutSuppressed(event, includeRepeat, platform) || !EDIT_SCOPES.includes(scope)) return null
  const editScope = scope as ShortcutEditScope
  return SHORTCUT_BINDINGS.find(b => inScope(b, editScope) && onPlatform(b, platform) && MODS[b.mods](event) && keyMatches(event, b.key))?.command ?? null
}

const formatBinding = (b: ShortcutBinding, platform: ShortcutPlatform) =>
  platform === 'mac' ? MAC_MODS[b.mods] + b.key.mac : WIN_MODS[b.mods] + b.key.win

/** Primary binding as shown in help, e.g. '⌘T' on macOS and 'Ctrl+T' elsewhere. */
export function shortcutLabel(command: ProjectShortcut, platform: ShortcutPlatform = shortcutPlatform()): string {
  const binding = SHORTCUT_BINDINGS.find(b => b.command === command && onPlatform(b, platform))
  return binding ? formatBinding(binding, platform) : ''
}

const META: Record<ProjectShortcut, { label: string; logic: string }> = {
  playback: { label: '재생 / 정지', logic: 'Space' },
  playFromSelection: { label: '선택 위치부터 재생', logic: '⇧Space' },
  undo: { label: '실행 취소', logic: '⌘Z' },
  redo: { label: '다시 실행', logic: '⇧⌘Z' },
  save: { label: '.garak 파일 저장', logic: '⌘S' },
  home: { label: '처음으로 이동', logic: '↩' },
  rewind: { label: '뒤로 감기', logic: ',' },
  forward: { label: '앞으로 감기', logic: '.' },
  escape: { label: '선택 해제 / 취소', logic: 'Esc (도구 메뉴)' },
  help: { label: '단축키 도움말', logic: '—' },
  cycle: { label: '반복 구간(사이클) 켜기/끄기', logic: 'C' },
  record: { label: '녹음', logic: 'R' },
  metronome: { label: '메트로놈 켜기/끄기', logic: 'K' },
  snapToggle: { label: '스냅 켜기/끄기', logic: '⌘G' },
  zoomIn: { label: '가로 확대', logic: '⌘→' },
  zoomOut: { label: '가로 축소', logic: '⌘←' },
  zoomInV: { label: '세로 확대 (트랙·건반 높이)', logic: '⌘↓' },
  zoomOutV: { label: '세로 축소', logic: '⌘↑' },
  zoomToFit: { label: '선택(없으면 전체)에 맞춰 보기', logic: 'Z' },
  setLoopFromSelection: { label: '선택 클립으로 반복 구간 지정', logic: '⌘U' },
  deleteClip: { label: '선택 클립 삭제', logic: '⌫' },
  split: { label: '재생 커서에서 클립 분할', logic: '⌘T' },
  join: { label: '클립 합치기', logic: '⌘J' },
  duplicate: { label: '선택 클립 복제', logic: '⌘D (트랙 복제)' },
  repeat: { label: '클립 반복 붙이기', logic: '⌘R' },
  copy: { label: '복사', logic: '⌘C' },
  cut: { label: '잘라내기', logic: '⌘X' },
  paste: { label: '붙여넣기', logic: '⌘V' },
  selectAll: { label: '모두 선택', logic: '⌘A' },
  loopClip: { label: '클립 루프 켜기/끄기', logic: 'L' },
  muteClip: { label: '클립 음소거', logic: '⌃M' },
  renameClip: { label: '클립 이름 변경', logic: '⇧N' },
  moveToPlayhead: { label: '클립을 재생 커서로 이동', logic: ';' },
  selectPrev: { label: '이전 클립 선택', logic: '←' },
  selectNext: { label: '다음 클립 선택', logic: '→' },
  nudgeLeft: { label: '조금씩 왼쪽으로 이동', logic: '⌥←' },
  nudgeRight: { label: '조금씩 오른쪽으로 이동', logic: '⌥→' },
  trimEndLeft: { label: '끝 지점 줄이기', logic: '⌥⇧←' },
  trimEndRight: { label: '끝 지점 늘리기', logic: '⌥⇧→' },
  trimStartToPlayhead: { label: '시작 지점을 재생 커서로 자르기', logic: '⌘[' },
  trimEndToPlayhead: { label: '끝 지점을 재생 커서로 자르기', logic: '⌘]' },
  muteTrack: { label: '트랙 음소거', logic: 'M' },
  soloTrack: { label: '트랙 솔로', logic: 'S' },
  trackUp: { label: '위 트랙 선택', logic: '↑' },
  trackDown: { label: '아래 트랙 선택', logic: '↓' },
  newTrack: { label: '새 트랙', logic: '⌥⌘N' },
  deleteTrack: { label: '선택 트랙 삭제', logic: '⌘⌫' },
  renameTrack: { label: '트랙 이름 변경', logic: '⇧↩' },
  deleteNotes: { label: '선택 음표 삭제', logic: '⌫' },
  quantize: { label: '퀀타이즈', logic: 'Q' },
  transposeUp: { label: '반음 올리기', logic: '⌥↑' },
  transposeDown: { label: '반음 내리기', logic: '⌥↓' },
  transposeOctaveUp: { label: '옥타브 올리기', logic: '⌥⇧↑' },
  transposeOctaveDown: { label: '옥타브 내리기', logic: '⌥⇧↓' },
}

export interface ShortcutRow { command: ProjectShortcut; label: string; mac: string; win: string; scopes: readonly ShortcutEditScope[]; logic: string }

const formatAll = (command: ProjectShortcut, platform: ShortcutPlatform) =>
  SHORTCUT_BINDINGS.filter(b => b.command === command && onPlatform(b, platform)).map(b => formatBinding(b, platform)).join(' / ')

/** Zoom commands act on the area with key focus: timeline, piano roll, mixer or device rack. */
export const ZOOM_COMMANDS: readonly ProjectShortcut[] = ['zoomIn', 'zoomOut', 'zoomInV', 'zoomOutV', 'zoomToFit']

/** One row per command for the help modal and docs; alternates are joined with ' / '. */
export const SHORTCUT_TABLE: readonly ShortcutRow[] = (Object.keys(META) as ProjectShortcut[]).map(command => ({
  command, ...META[command], mac: formatAll(command, 'mac'), win: formatAll(command, 'windows'),
  scopes: TPW.filter(scope => SHORTCUT_BINDINGS.some(b => b.command === command && b.scopes.includes(scope))),
}))

export interface DragModifiers { copy: boolean; fine: boolean; noSnap: boolean; axisLock: boolean }

/**
 * Logic-style drag modifiers, identical on every platform:
 * Alt/⌥ copies, Ctrl/⌃ moves by the fine step, Ctrl/⌃+Shift ignores snap,
 * Shift alone locks the axis. ⌘ is never a drag modifier. On macOS a Ctrl
 * press-click opens the context menu, so ⌃ should be read during the move.
 */
export function dragModifiers(event: Pick<ShortcutEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>, _platform: ShortcutPlatform = shortcutPlatform()): DragModifiers {
  return { copy: event.altKey, fine: event.ctrlKey && !event.shiftKey, noSnap: event.ctrlKey && event.shiftKey, axisLock: event.shiftKey && !event.ctrlKey }
}

export type SnapMode = 'snap' | 'fine' | 'none'

/** Snap movement relative to the original timing, preserving humanized offsets. 'fine' defaults to a quarter of the step. */
export function snapDragDelta(delta: number, step: number, mode: SnapMode = 'snap', fineStep = step / 4): number {
  const unit = mode === 'none' ? 0 : mode === 'fine' ? fineStep : step
  return unit > 0 ? Math.round(delta / unit) * unit : delta
}

export function crossedDragThreshold(dx: number, dy = 0, threshold = 4): boolean {
  return Math.abs(dx) >= threshold || Math.abs(dy) >= threshold
}

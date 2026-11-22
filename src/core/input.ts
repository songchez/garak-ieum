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
  | 'playback' | 'playFromSelection' | 'undo' | 'redo' | 'save' | 'home' | 'rewind' | 'forward' | 'escape' | 'help' | 'openSettings'
  | 'cycle' | 'record' | 'metronome' | 'snapToggle' | 'zoomIn' | 'zoomOut' | 'zoomInV' | 'zoomOutV' | 'zoomToFit' | 'setLoopFromSelection'
  | 'deleteClip' | 'split' | 'join' | 'repeat' | 'copy' | 'cut' | 'paste' | 'selectAll'
  | 'loopClip' | 'muteClip' | 'renameClip' | 'moveToPlayhead' | 'selectPrev' | 'selectNext'
  | 'nudgeLeft' | 'nudgeRight' | 'trimEndLeft' | 'trimEndRight' | 'trimStartToPlayhead' | 'trimEndToPlayhead'
  | 'muteTrack' | 'soloTrack' | 'armTrack' | 'monitorTrack' | 'toggleTrackOn' | 'clearRecallSolo'
  | 'trackUp' | 'trackDown' | 'trackUpExtend' | 'trackDownExtend'
  | 'newTracksDialog' | 'newAudioTrack' | 'newInstrumentTrack' | 'duplicateTrack' | 'duplicateTrackContent' | 'deleteTrack' | 'renameTrack'
  | 'hideSelectedTracks' | 'unhideAllTracks' | 'toggleHideView' | 'colorPalette' | 'configureTrackHeader'
  | 'trackZoomIn' | 'trackZoomOut' | 'trackZoomToggle' | 'trackZoomReset' | 'zoomFocusedTrack'
  | 'toggleInspector' | 'toggleMixer' | 'toggleBrowser' | 'globalTracks' | 'createMarker'
  | 'deleteNotes' | 'quantize' | 'transposeUp' | 'transposeDown' | 'transposeOctaveUp' | 'transposeOctaveDown'
  | 'musicalTyping' | 'captureMidi' | 'toggleAutomation' | 'countIn'
  | 'end' | 'selectNoteAbove' | 'selectNoteBelow' | 'drawMode'

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

/** Editing and explicitly copyable text keep native keys, including inherited contenteditable. */
export function shortcutScope(target: EventTarget | null): ShortcutScope {
  if (!(target instanceof Element)) return 'outside'
  if (target.closest('[role="dialog"],dialog,[aria-modal="true"]')) return 'dialog'
  if ((target instanceof HTMLElement && target.isContentEditable)
    || target.closest('input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]),textarea,[data-selectable-text],[role="textbox"],[role="searchbox"],[role="spinbutton"]')) return 'text'
  // Controls keep native activation/navigation. Other commands can use their
  // owning editor through resolveRoutedShortcut; note buttons are edit objects.
  if (target.closest('button,a[href],select,input,[role="checkbox"],[role="switch"],[role="slider"],[role="combobox"]') && !target.closest('.piano-note,.piano-key')) return 'control'
  const area = shortcutEditorScope(target)
  if (area) return area
  if (target.closest('.studio-app') || target === document.body) return 'workspace'
  return 'outside'
}

/** Keep editor ownership when a toolbar control takes DOM focus. */
export function shortcutEditorScope(target: EventTarget | null): ShortcutEditScope | null {
  if (!(target instanceof Element)) return null
  const area = target.closest<HTMLElement>('[data-keyboard-scope]')?.dataset.keyboardScope
  return area === 'piano' || area === 'timeline' || area === 'mixer' || area === 'devices' ? area : null
}

/**
 * Modifier sets are exact. "mod" is exactly one of Ctrl/⌘ (either is accepted
 * on every platform); 'ctrl'/'ctrlShift' is the literal Ctrl key without ⌘;
 * 'anyShift' ignores Shift for characters such as '?' whose Shift depends on
 * the layout.
 *
 * Platform rule for ⌃ chords: on macOS they are bound as 'ctrl' and
 * listed before every 'mod' binding, so Ctrl+R is armTrack while ⌘R (and
 * Ctrl on the other keys) still reads as Mod. On Windows/Linux Ctrl is Mod,
 * so ⌃key becomes Alt+Shift+key (⌃⇧H becomes Ctrl+Alt+H; ⌃Z has no key
 * because Ctrl+Z is undo).
 */
export type ShortcutMods = '' | 'shift' | 'anyShift' | 'alt' | 'altShift' | 'mod' | 'modShift' | 'modAlt' | 'modAltShift' | 'ctrl' | 'ctrlShift'
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
  modAltShift: e => e.ctrlKey !== e.metaKey && e.altKey && e.shiftKey,
  ctrl: e => e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey,
  ctrlShift: e => e.ctrlKey && !e.metaKey && !e.altKey && e.shiftKey,
}
// Glyphs follow Apple's order ⌃⌥⇧⌘.
const MAC_MODS: Record<ShortcutMods, string> = { '': '', shift: '⇧', anyShift: '', alt: '⌥', altShift: '⌥⇧', mod: '⌘', modShift: '⇧⌘', modAlt: '⌥⌘', modAltShift: '⌥⇧⌘', ctrl: '⌃', ctrlShift: '⌃⇧' }
const WIN_MODS: Record<ShortcutMods, string> = { '': '', shift: 'Shift+', anyShift: '', alt: 'Alt+', altShift: 'Alt+Shift+', mod: 'Ctrl+', modShift: 'Ctrl+Shift+', modAlt: 'Ctrl+Alt+', modAltShift: 'Ctrl+Alt+Shift+', ctrl: 'Ctrl+', ctrlShift: 'Ctrl+Shift+' }

const letter = (c: string): ShortcutKey => ({ code: `Key${c}`, key: c.toLowerCase(), mac: c, win: c })
const named = (key: string, mac: string, win = mac): ShortcutKey => ({ key, mac, win })
const punct = (code: string, key: string): ShortcutKey => ({ code, key, mac: key, win: key })
const SPACE: ShortcutKey = { code: 'Space', key: ' ', mac: 'Space', win: 'Space' }
const ENTER = named('Enter', '↩', 'Enter'), DEL = named('Delete', '⌦', 'Delete'), BACK = named('Backspace', '⌫', 'Backspace')
const LEFT = named('ArrowLeft', '←'), RIGHT = named('ArrowRight', '→'), UP = named('ArrowUp', '↑'), DOWN = named('ArrowDown', '↓')
const TPW = ['timeline', 'piano', 'workspace'] as const, TW = ['timeline', 'workspace'] as const, TP = ['timeline', 'piano'] as const
const T = ['timeline'] as const, P = ['piano'] as const
const MAC = ['mac'] as const, PC = ['windows', 'linux'] as const, NOT_MAC = ['windows', 'linux', 'other'] as const

const bind = (command: ProjectShortcut, key: ShortcutKey, mods: ShortcutMods, scopes: readonly ShortcutEditScope[], platforms?: readonly ShortcutPlatform[]): ShortcutBinding => ({ command, key, mods, scopes, platforms })

/**
 * Every binding, primary first per command; the first match wins. ⌃
 * chords come first so that on macOS the literal Ctrl key beats the same
 * key's 'mod' binding (see ShortcutMods). Mod+D/T/R and ⌃M are timeline-only
 * region commands; Mod+T/N/W are browser-reserved, hence the Mod+E alias.
 */
export const SHORTCUT_BINDINGS: readonly ShortcutBinding[] = [
  bind('armTrack', letter('R'), 'ctrl', TW, MAC), bind('armTrack', letter('R'), 'altShift', TW, NOT_MAC),
  bind('monitorTrack', letter('I'), 'ctrl', TW, MAC), bind('monitorTrack', letter('I'), 'altShift', TW, NOT_MAC),
  bind('muteClip', letter('M'), 'ctrl', T, MAC), bind('muteClip', letter('M'), 'altShift', T, NOT_MAC),
  bind('hideSelectedTracks', letter('H'), 'ctrl', TW, MAC), bind('hideSelectedTracks', letter('H'), 'altShift', TW, NOT_MAC),
  bind('unhideAllTracks', letter('H'), 'ctrlShift', TW, MAC), bind('unhideAllTracks', letter('H'), 'modAlt', TW, NOT_MAC),
  bind('zoomFocusedTrack', letter('Z'), 'ctrl', TW, MAC),
  bind('playback', SPACE, '', TPW), bind('playFromSelection', SPACE, 'shift', TPW),
  bind('undo', letter('Z'), 'mod', TPW), bind('redo', letter('Z'), 'modShift', TPW), bind('redo', letter('Y'), 'ctrl', TPW, PC),
  bind('save', letter('S'), 'mod', TPW), bind('openSettings', punct('Comma', ','), 'mod', TPW),
  bind('home', named('Home', 'Home'), '', TPW), bind('home', ENTER, '', TW),
  bind('rewind', punct('Comma', ','), '', TW), bind('forward', punct('Period', '.'), '', TW),
  bind('escape', named('Escape', 'Esc'), '', TPW), bind('help', named('?', '?'), 'anyShift', TPW),
  bind('cycle', letter('C'), '', TPW), bind('record', letter('R'), '', TPW), bind('metronome', letter('K'), '', TPW), bind('countIn', letter('K'), 'shift', TPW),
  // docs/MIDI_RECORDING.md: ⌘K musical typing, ⇧R capture recording.
  bind('musicalTyping', letter('K'), 'mod', TPW), bind('captureMidi', letter('R'), 'shift', TPW),
  bind('snapToggle', letter('G'), 'mod', TPW),
  bind('zoomIn', RIGHT, 'mod', TPW), bind('zoomOut', LEFT, 'mod', TPW), bind('zoomInV', DOWN, 'mod', TPW), bind('zoomOutV', UP, 'mod', TPW),
  bind('zoomToFit', letter('Z'), '', TPW),
  bind('setLoopFromSelection', letter('U'), 'mod', T),
  bind('deleteClip', DEL, '', T), bind('deleteClip', BACK, '', T),
  bind('split', letter('T'), 'mod', T), bind('split', letter('E'), 'mod', T),
  bind('join', letter('J'), 'mod', T), bind('repeat', letter('R'), 'mod', T),
  bind('copy', letter('C'), 'mod', TP), bind('cut', letter('X'), 'mod', TP), bind('paste', letter('V'), 'mod', TP), bind('selectAll', letter('A'), 'mod', TP),
  bind('loopClip', letter('L'), '', T), bind('renameClip', letter('N'), 'shift', T),
  bind('moveToPlayhead', punct('Semicolon', ';'), '', T),
  bind('selectPrev', LEFT, '', T), bind('selectNext', RIGHT, '', T),
  // docs/EDITING_UX_PLAN.md: in the piano roll arrows move notes, ⇧ = length/octave, and ⌥ walks notes.
  bind('selectPrev', LEFT, 'alt', P), bind('selectNext', RIGHT, 'alt', P),
  bind('selectNoteAbove', UP, 'alt', P), bind('selectNoteBelow', DOWN, 'alt', P),
  bind('nudgeLeft', LEFT, 'alt', T), bind('nudgeRight', RIGHT, 'alt', T),
  bind('nudgeLeft', LEFT, '', P), bind('nudgeRight', RIGHT, '', P),
  bind('trimEndLeft', LEFT, 'altShift', T), bind('trimEndRight', RIGHT, 'altShift', T),
  bind('trimEndLeft', LEFT, 'shift', P), bind('trimEndRight', RIGHT, 'shift', P),
  bind('end', named('End', 'End'), '', P), bind('drawMode', letter('B'), '', P),
  bind('trimStartToPlayhead', punct('BracketLeft', '['), 'mod', T), bind('trimEndToPlayhead', punct('BracketRight', ']'), 'mod', T),
  bind('muteTrack', letter('M'), '', TW), bind('soloTrack', letter('S'), '', TW),
  bind('toggleTrackOn', letter('M'), 'alt', TW), bind('clearRecallSolo', letter('S'), 'alt', TW),
  bind('trackUp', UP, '', TW), bind('trackDown', DOWN, '', TW), bind('trackUpExtend', UP, 'shift', TW), bind('trackDownExtend', DOWN, 'shift', TW),
  bind('newTracksDialog', letter('N'), 'modAlt', TW), bind('newAudioTrack', letter('A'), 'modAlt', TW), bind('newInstrumentTrack', letter('S'), 'modAlt', TW),
  bind('duplicateTrack', letter('D'), 'mod', TW), bind('duplicateTrackContent', letter('D'), 'modAltShift', TW),
  bind('deleteTrack', BACK, 'mod', TW), bind('deleteTrack', DEL, 'mod', TW),
  bind('renameTrack', ENTER, 'shift', TW),
  bind('toggleHideView', letter('H'), '', TW), bind('toggleAutomation', letter('A'), '', TW), bind('colorPalette', letter('C'), 'alt', TW), bind('configureTrackHeader', letter('T'), 'alt', TW),
  bind('trackZoomIn', DOWN, 'modAlt', TW), bind('trackZoomOut', UP, 'modAlt', TW), bind('trackZoomToggle', letter('Z'), 'modAlt', TW), bind('trackZoomReset', BACK, 'modAlt', TW),
  bind('toggleInspector', letter('I'), '', TW), bind('toggleMixer', letter('X'), '', TW), bind('toggleBrowser', letter('F'), '', TW), bind('globalTracks', letter('G'), '', TW),
  bind('createMarker', punct('Quote', "'"), 'alt', TW),
  bind('deleteNotes', DEL, '', P), bind('deleteNotes', BACK, '', P),
  bind('quantize', letter('Q'), '', P),
  bind('transposeUp', UP, 'alt', T), bind('transposeDown', DOWN, 'alt', T),
  bind('transposeUp', UP, '', P), bind('transposeDown', DOWN, '', P),
  bind('transposeOctaveUp', UP, 'altShift', T), bind('transposeOctaveDown', DOWN, 'altShift', T),
  bind('transposeOctaveUp', UP, 'shift', P), bind('transposeOctaveDown', DOWN, 'shift', P),
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

const GLOBAL_ONLY_COMMANDS = new Set<ProjectShortcut>(['playback', 'playFromSelection', 'undo', 'redo', 'save', 'home', 'rewind', 'forward', 'help', 'openSettings', 'cycle', 'record', 'metronome', 'countIn', 'musicalTyping', 'captureMidi', 'toggleInspector', 'toggleMixer', 'toggleBrowser'])
export interface ShortcutVisibility { editors: readonly ShortcutEditScope[]; preferred?: ShortcutEditScope }

/** Resolve app/editor keys without stealing typing, modal keys, or control navigation. */
export function resolveRoutedShortcut(event: ShortcutEvent, targetScope: ShortcutScope, activeEditor: ShortcutEditScope, includeRepeat = false, platform: ShortcutPlatform = shortcutPlatform(), visibility?: ShortcutVisibility): { command: ProjectShortcut; scope: ShortcutEditScope } | null {
  if (targetScope === 'text' || targetScope === 'dialog' || targetScope === 'outside') return null
  if (targetScope === 'control' && !event.ctrlKey && !event.metaKey && !event.altKey
    && ['Enter', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return null
  let scope: ShortcutEditScope | null = targetScope === 'control' || targetScope === 'workspace' ? activeEditor : targetScope
  if (visibility && !visibility.editors.includes(scope)) {
    scope = [visibility.preferred, activeEditor, 'timeline' as const, ...visibility.editors]
      .find((candidate): candidate is ShortcutEditScope => !!candidate && visibility.editors.includes(candidate)) ?? null
  }
  const command = resolveProjectShortcut(event, scope ?? 'workspace', includeRepeat, platform)
  // A maximized audio/pitch editor owns its local edits. Do not send a toolbar
  // Delete, Select All, or track command into an invisible arrangement.
  return command && (scope !== null || GLOBAL_ONLY_COMMANDS.has(command)) ? { command, scope: scope ?? 'workspace' } : null
}

const formatBinding = (b: ShortcutBinding, platform: ShortcutPlatform) =>
  platform === 'mac' ? MAC_MODS[b.mods] + b.key.mac : WIN_MODS[b.mods] + b.key.win

/** Primary binding as shown in help, e.g. '⌘T' on macOS and 'Ctrl+T' elsewhere. */
export function shortcutLabel(command: ProjectShortcut, platform: ShortcutPlatform = shortcutPlatform()): string {
  const binding = SHORTCUT_BINDINGS.find(b => b.command === command && onPlatform(b, platform))
  return binding ? formatBinding(binding, platform) : ''
}

const META: Record<ProjectShortcut, { label: string }> = {
  playback: { label: '재생 / 일시 정지' },
  playFromSelection: { label: '선택 위치부터 재생' },
  undo: { label: '실행 취소' },
  redo: { label: '다시 실행' },
  save: { label: '.garak 파일 저장' },
  home: { label: '처음으로 이동' },
  rewind: { label: '뒤로 감기' },
  forward: { label: '앞으로 감기' },
  escape: { label: '선택 해제 / 취소' },
  help: { label: '단축키 도움말' },
  openSettings: { label: '설정 열기' },
  cycle: { label: '반복 구간(사이클) 켜기/끄기' },
  record: { label: '녹음' },
  metronome: { label: '메트로놈 켜기/끄기' },
  countIn: { label: '녹음 카운트인 켜기/끄기' },
  snapToggle: { label: '스냅 켜기/끄기' },
  zoomIn: { label: '가로 확대' },
  zoomOut: { label: '가로 축소' },
  zoomInV: { label: '세로 확대 (트랙·건반 높이)' },
  zoomOutV: { label: '세로 축소' },
  zoomToFit: { label: '선택(없으면 전체)에 맞춰 보기' },
  setLoopFromSelection: { label: '선택 클립으로 반복 구간 지정' },
  deleteClip: { label: '선택 클립 삭제' },
  split: { label: '재생 커서에서 클립 분할' },
  join: { label: '클립 합치기' },
  repeat: { label: '클립 반복 붙이기' },
  copy: { label: '복사' },
  cut: { label: '잘라내기' },
  paste: { label: '붙여넣기' },
  selectAll: { label: '모두 선택' },
  loopClip: { label: '클립 루프 켜기/끄기' },
  muteClip: { label: '클립 음소거' },
  renameClip: { label: '클립 이름 변경' },
  moveToPlayhead: { label: '클립을 재생 커서로 이동' },
  selectPrev: { label: '이전 클립/음표 선택' },
  selectNext: { label: '다음 클립/음표 선택' },
  selectNoteAbove: { label: '위쪽 음표 선택' },
  selectNoteBelow: { label: '아래쪽 음표 선택' },
  end: { label: '클립 끝으로 이동' },
  drawMode: { label: '그리기 모드 켜기/끄기' },
  nudgeLeft: { label: '조금씩 왼쪽으로 이동' },
  nudgeRight: { label: '조금씩 오른쪽으로 이동' },
  trimEndLeft: { label: '끝 지점 줄이기' },
  trimEndRight: { label: '끝 지점 늘리기' },
  trimStartToPlayhead: { label: '시작 지점을 재생 커서로 자르기' },
  trimEndToPlayhead: { label: '끝 지점을 재생 커서로 자르기' },
  muteTrack: { label: '트랙 음소거' },
  soloTrack: { label: '트랙 솔로' },
  armTrack: { label: '트랙 녹음 활성화 켜기/끄기' },
  monitorTrack: { label: '트랙 입력 모니터링 켜기/끄기' },
  toggleTrackOn: { label: '트랙 켬/끔' },
  clearRecallSolo: { label: '솔로 전체 해제 / 복원' },
  trackUp: { label: '위 트랙 선택' },
  trackDown: { label: '아래 트랙 선택' },
  trackUpExtend: { label: '위 트랙까지 선택 확장' },
  trackDownExtend: { label: '아래 트랙까지 선택 확장' },
  newTracksDialog: { label: '새로운 트랙… 창' },
  newAudioTrack: { label: '새로운 오디오 트랙' },
  newInstrumentTrack: { label: '새로운 소프트웨어 악기 트랙' },
  duplicateTrack: { label: '트랙 복제' },
  duplicateTrackContent: { label: '트랙과 내용 복제' },
  deleteTrack: { label: '선택 트랙 삭제' },
  renameTrack: { label: '트랙 이름 변경' },
  hideSelectedTracks: { label: '선택 트랙 가리기' },
  unhideAllTracks: { label: '모든 트랙 가리기 해제' },
  toggleHideView: { label: '트랙 가리기(H) 버튼 보기/감추기' },
  colorPalette: { label: '색상 팔레트' },
  configureTrackHeader: { label: '트랙 헤더 구성' },
  trackZoomIn: { label: '포커스 트랙 확대' },
  trackZoomOut: { label: '포커스 트랙 축소' },
  trackZoomToggle: { label: '포커스 트랙 확대 켜기/끄기' },
  trackZoomReset: { label: '트랙 확대 초기화' },
  zoomFocusedTrack: { label: '포커스 트랙만 확대 (macOS)' },
  toggleInspector: { label: '인스펙터 보기/가리기' },
  toggleMixer: { label: '믹서 보기/가리기' },
  toggleBrowser: { label: '라이브러리 보기/가리기' },
  globalTracks: { label: '글로벌 트랙 보기/가리기' },
  createMarker: { label: '마커 생성' },
  deleteNotes: { label: '선택 음표 삭제' },
  quantize: { label: '퀀타이즈' },
  transposeUp: { label: '반음 올리기' },
  transposeDown: { label: '반음 내리기' },
  transposeOctaveUp: { label: '옥타브 올리기' },
  transposeOctaveDown: { label: '옥타브 내리기' },
  musicalTyping: { label: '컴퓨터 키보드 연주 켜기/끄기' },
  captureMidi: { label: '마지막 MIDI 연주 캡처' },
  toggleAutomation: { label: '트랙 오토메이션 보기/가리기' },
}

export interface ShortcutRow { command: ProjectShortcut; label: string; mac: string; win: string; scopes: readonly ShortcutEditScope[] }

const SCOPE_LABELS: Record<ShortcutEditScope, string> = { timeline: '타임라인', piano: '피아노롤', mixer: '믹서', devices: '시김새 체인', workspace: '작업 공간' }
const formatAll = (command: ProjectShortcut, platform: ShortcutPlatform) => {
  const bindings = SHORTCUT_BINDINGS.filter(b => b.command === command && onPlatform(b, platform))
  const scopes = new Set(bindings.flatMap(binding => binding.scopes))
  // A row can combine aliases with different owners. Label narrower aliases
  // so a piano-only arrow is never advertised as an arrangement edit key.
  return bindings.map(binding => `${formatBinding(binding, platform)}${binding.scopes.length < scopes.size ? ` (${binding.scopes.map(scope => SCOPE_LABELS[scope]).join('·')})` : ''}`).join(' / ')
}

/** Zoom commands act on the area with key focus: timeline, piano roll, mixer or device rack. */
export const ZOOM_COMMANDS: readonly ProjectShortcut[] = ['zoomIn', 'zoomOut', 'zoomInV', 'zoomOutV', 'zoomToFit']

/** One row per command for the help modal and docs; alternates are joined with ' / '. */
export const SHORTCUT_TABLE: readonly ShortcutRow[] = (Object.keys(META) as ProjectShortcut[]).map(command => ({
  command, ...META[command], mac: formatAll(command, 'mac'), win: formatAll(command, 'windows'),
  scopes: TPW.filter(scope => SHORTCUT_BINDINGS.some(b => b.command === command && b.scopes.includes(scope))),
}))

export interface DragModifiers { copy: boolean; fine: boolean; noSnap: boolean; axisLock: boolean }

/**
 * Drag modifiers, identical on every platform:
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

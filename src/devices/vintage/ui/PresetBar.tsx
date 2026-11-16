import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Icon } from '../../../components/Icon'
import type { VintageInstrumentId } from '../params'
import { VINTAGE_PRESETS } from '../presets'
import { cleanPresetName, loadUserPresets, MAX_PRESET_NAME, putUserPreset, removeUserPreset, saveUserPresets, userPresetStorageKey, type VintageUserPreset } from '../userPresets'
import { applyPresetChoice, currentPreset, USER_PREFIX, VINTAGE_NAMES } from './presetActions'

/** The user's saved presets for one instrument, kept in sync with other windows through the storage event. */
export function useVintageUserPresets(instrument: VintageInstrumentId): [VintageUserPreset[], (next: VintageUserPreset[]) => boolean] {
  const [list, setList] = useState(() => loadUserPresets(instrument))
  useEffect(() => {
    setList(loadUserPresets(instrument))
    const sync = (event: StorageEvent) => { if (event.key === userPresetStorageKey(instrument)) setList(loadUserPresets(instrument)) }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [instrument])
  return [list, next => { const ok = saveUserPresets(instrument, next); if (ok) setList(next); return ok }]
}

interface Option { value: string; name: string; detail?: string }

interface Props {
  instrument: VintageInstrumentId
  params: Readonly<Record<string, number>>
  onParams(params: Record<string, number>, label: string): void
  onAnnounce(message: string): void
  /** Injected in tests; defaults to localStorage. */
  userPresets?: readonly VintageUserPreset[]
}

/** Preset picker (factory + 내 프리셋) with save-as / overwrite / delete, themed with the app tokens. */
export function PresetBar({ instrument, params, onParams, onAnnounce, userPresets: injected }: Props) {
  const [stored, store] = useVintageUserPresets(instrument)
  const users = injected ?? stored
  const current = currentPreset(instrument, params, users)
  const [open, setOpen] = useState(false), [active, setActive] = useState(0)
  const [saving, setSaving] = useState<string | null>(null), [confirmDelete, setConfirmDelete] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null), triggerRef = useRef<HTMLButtonElement>(null), listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const factory: Option[] = VINTAGE_PRESETS[instrument].map(item => ({ value: item.id, name: item.name, detail: item.description }))
  const mine: Option[] = users.map(item => ({ value: USER_PREFIX + item.id, name: item.name, detail: `${new Date(item.savedAt).toLocaleDateString('ko-KR')} 저장` }))
  const flat = [...factory, ...mine]

  const apply = (value: string) => {
    setConfirmDelete(false)
    const name = applyPresetChoice(instrument, value, users, onParams)
    if (name) onAnnounce(`'${name}' 프리셋을 불러왔습니다. 실행 취소할 수 있습니다.`)
  }
  const close = (focus = true) => { setOpen(false); if (focus) triggerRef.current?.focus({ preventScroll: true }) }
  const show = () => { setOpen(true); setActive(Math.max(0, flat.findIndex(option => option.value === current.value))) }
  const step = (direction: number) => {
    const index = factory.findIndex(option => option.value === current.value)
    const next = index < 0 ? (direction > 0 ? 0 : factory.length - 1) : (index + direction + factory.length) % factory.length
    apply(factory[next].value)
  }

  useEffect(() => {
    if (!open) return
    listRef.current?.focus({ preventScroll: true })
    const outside = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) close(false) }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])
  useEffect(() => { if (open) listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' }) }, [active, open])

  const listKey = (event: ReactKeyboardEvent) => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => setActive(index => Math.min(flat.length - 1, index + 1)),
      ArrowUp: () => setActive(index => Math.max(0, index - 1)),
      Home: () => setActive(0), End: () => setActive(flat.length - 1),
      Enter: () => { if (flat[active]) { close(); apply(flat[active].value) } },
      ' ': () => { if (flat[active]) { close(); apply(flat[active].value) } },
      Escape: () => close(), Tab: () => close(),
    }
    const action = keys[event.key]
    if (!action) return
    event.preventDefault(); event.stopPropagation(); action()
  }

  const save = (name: string) => {
    try {
      const result = putUserPreset(instrument, users, name, { ...params })
      if (!store(result.list)) { onAnnounce('프리셋을 저장하지 못했습니다. 저장 공간을 확인해 주세요.'); return }
      setSaving(null); onAnnounce(`'${result.preset.name}' 프리셋을 ${result.replaced ? '덮어썼습니다' : '저장했습니다'}.`)
    } catch (error) { onAnnounce(error instanceof Error ? error.message : String(error)) }
  }
  const remove = (item: VintageUserPreset) => { if (store(removeUserPreset(users, item.id))) onAnnounce(`'${item.name}' 프리셋을 지웠습니다. 지금 소리는 그대로입니다.`); setConfirmDelete(false) }
  const overwriting = saving !== null && users.some(item => item.name.toLocaleLowerCase() === cleanPresetName(saving).toLocaleLowerCase())

  let index = -1
  const group = (label: string, options: Option[], empty?: string) => <div className="vt-preset-group" role="group" aria-label={label}>
    <div className="vt-preset-group-label">{label}</div>
    {options.length === 0 && empty && <p className="vt-preset-hint">{empty}</p>}
    {options.map(option => { index += 1; const i = index, selected = option.value === current.value
      return <div key={option.value} id={`${listId}-${i}`} data-index={i} role="option" aria-selected={selected} className="vt-preset-item" data-active={i === active}
        onPointerMove={() => setActive(i)} onClick={() => { close(); apply(option.value) }}>
        <span className="vt-preset-check" aria-hidden="true">{selected && <Icon name="check" size={13}/>}</span>
        <span className="vt-preset-text"><span>{option.name}</span>{option.detail && <small>{option.detail}</small>}</span>
      </div> })}
  </div>

  return <div className="vt-presets" ref={rootRef}>
    <div className="vt-preset-picker">
      <button type="button" className="vt-preset-step" onClick={() => step(-1)} aria-label="이전 프리셋" title="이전 프리셋"><Icon name="left" size={14}/></button>
      <button ref={triggerRef} type="button" className="vt-preset-trigger" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
        aria-label={`${VINTAGE_NAMES[instrument]} 프리셋: ${current.name}`} onClick={() => open ? close() : show()}
        onKeyDown={event => { if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); show() } }}>
        <span className="vt-preset-current"><strong data-custom={current.value === 'custom'}>{current.name}</strong>{current.detail && <small>{current.detail}</small>}</span>
        <Icon name="chevron" size={14}/>
      </button>
      <button type="button" className="vt-preset-step" onClick={() => step(1)} aria-label="다음 프리셋" title="다음 프리셋"><Icon name="right" size={14}/></button>
      {open && <div className="vt-preset-popover">
        <div className="vt-preset-list" id={listId} role="listbox" tabIndex={-1} ref={listRef} aria-label={`${VINTAGE_NAMES[instrument]} 프리셋`}
          aria-activedescendant={flat[active] ? `${listId}-${active}` : undefined} onKeyDown={listKey}>
          {group('기본 프리셋', factory)}
          {group('내 프리셋', mine, '아직 저장한 프리셋이 없습니다.')}
        </div>
      </div>}
    </div>
    {saving === null ? <div className="vt-preset-actions">
      <button type="button" className="vt-button" onClick={() => { setConfirmDelete(false); setSaving(current.user?.name ?? '') }} title="지금 소리를 내 프리셋으로 저장"><Icon name="save" size={13}/>{current.user ? '다시 저장' : '프리셋 저장'}</button>
      {current.user && (confirmDelete
        ? <span className="vt-preset-confirm" role="group" aria-label="프리셋 지우기 확인"><span>'{current.user.name}' 지울까요?</span><button type="button" className="vt-button vt-button--danger" onClick={() => remove(current.user!)}>지우기</button><button type="button" className="vt-button" onClick={() => setConfirmDelete(false)}>취소</button></span>
        : <button type="button" className="vt-button vt-button--icon" onClick={() => setConfirmDelete(true)} aria-label={`내 프리셋 ${current.user.name} 지우기`} title="이 프리셋 지우기"><Icon name="trash" size={13}/></button>)}
    </div> : <form className="vt-preset-form" onSubmit={event => { event.preventDefault(); save(saving) }}>
      <input autoFocus value={saving} maxLength={MAX_PRESET_NAME} placeholder="프리셋 이름" aria-label="저장할 프리셋 이름" onChange={event => setSaving(event.target.value)}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setSaving(null) } }}/>
      <button type="submit" className="vt-button vt-button--primary" disabled={!saving.trim()}>{overwriting ? '덮어쓰기' : '저장'}</button>
      <button type="button" className="vt-button" onClick={() => setSaving(null)}>취소</button>
    </form>}
  </div>
}

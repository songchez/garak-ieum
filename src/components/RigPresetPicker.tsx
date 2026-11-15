import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Icon } from './Icon'

export interface PresetOption { value: string; name: string; detail?: string }
export interface PresetGroup { label: string; options: readonly PresetOption[]; empty?: string }

interface Props {
  value: string
  /** Shown on the trigger when the current sound matches no preset. */
  placeholder: string
  groups: readonly PresetGroup[]
  onSelect(value: string): void
  onSaveCurrent?(): void
}

/**
 * A searchable preset picker in the style of a shadcn Select/Combobox: a trigger showing the current preset,
 * and a popover with a search field, grouped options, a check on the active one and full keyboard control.
 * Replaces the native <select>, whose option list follows the OS theme and is unreadable on the dark rig.
 */
export function RigPresetPicker({ value, placeholder, groups, onSelect, onSaveCurrent }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null), triggerRef = useRef<HTMLButtonElement>(null), searchRef = useRef<HTMLInputElement>(null), listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const current = groups.flatMap(group => group.options).find(option => option.value === value)
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    return groups.map(group => ({ ...group, options: q ? group.options.filter(option => `${option.name} ${option.detail ?? ''}`.toLocaleLowerCase().includes(q)) : group.options }))
  }, [groups, query])
  const flat = filtered.flatMap(group => group.options)

  const close = (focusTrigger = true) => { setOpen(false); setQuery(''); if (focusTrigger) triggerRef.current?.focus({ preventScroll: true }) }
  const choose = (option: PresetOption) => { close(); if (option.value !== value) onSelect(option.value) }
  const show = () => { setOpen(true); setQuery(''); setActive(Math.max(0, groups.flatMap(group => group.options).findIndex(option => option.value === value))) }

  useEffect(() => {
    if (!open) return
    searchRef.current?.focus({ preventScroll: true })
    const outside = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) close(false) }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])
  useEffect(() => { setActive(index => Math.min(index, Math.max(0, flat.length - 1))) }, [flat.length])
  useEffect(() => { if (open) listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }) }, [active, open])

  const keyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(flat.length - 1, index + 1)) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, index - 1)) }
    else if (event.key === 'Home') { event.preventDefault(); setActive(0) }
    else if (event.key === 'End') { event.preventDefault(); setActive(flat.length - 1) }
    else if (event.key === 'Enter') { event.preventDefault(); if (flat[active]) choose(flat[active]) }
    else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close() }
  }

  let index = -1
  return <div className="rp" ref={rootRef}>
    <button ref={triggerRef} type="button" className="rp-trigger" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-label={`기타 앰프 프리셋: ${current?.name ?? placeholder}`}
      onClick={() => open ? close() : show()} onKeyDown={event => { if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); show() } }}>
      <span className="rp-trigger-text"><strong data-placeholder={!current}>{current?.name ?? placeholder}</strong>{current?.detail && <small>{current.detail}</small>}</span>
      <Icon name="chevron" size={14}/>
    </button>
    {open && <div className="rp-popover" role="dialog" aria-label="프리셋 고르기" onKeyDown={keyDown}>
      <div className="rp-search"><Icon name="search" size={14}/><input ref={searchRef} value={query} placeholder="프리셋 검색…" aria-label="프리셋 검색" aria-controls={listId} aria-activedescendant={flat[active] ? `${listId}-${active}` : undefined} onChange={event => { setQuery(event.target.value); setActive(0) }}/></div>
      <div className="rp-list" id={listId} role="listbox" ref={listRef} aria-label="프리셋">
        {flat.length === 0 && <p className="rp-empty">‘{query}’와(과) 맞는 프리셋이 없습니다.</p>}
        {filtered.map(group => (group.options.length > 0 || (!query && group.empty)) && <div key={group.label} className="rp-group" role="group" aria-label={group.label}>
          <div className="rp-label">{group.label}</div>
          {group.options.length === 0 && group.empty && <p className="rp-hint">{group.empty}</p>}
          {group.options.map(option => { index += 1; const i = index; const selected = option.value === value
            return <div key={option.value} id={`${listId}-${i}`} data-index={i} role="option" aria-selected={selected} className="rp-item" data-active={i === active} data-selected={selected}
              onPointerMove={() => setActive(i)} onClick={() => choose(option)}>
              <span className="rp-check" aria-hidden="true">{selected && <Icon name="check" size={14}/>}</span>
              <span className="rp-item-text"><span>{option.name}</span>{option.detail && <small>{option.detail}</small>}</span>
            </div> })}
        </div>)}
      </div>
      {onSaveCurrent && <><div className="rp-separator"/><button type="button" className="rp-footer" onClick={() => { close(false); onSaveCurrent() }}><Icon name="save" size={14}/>지금 톤을 내 프리셋으로 저장…</button></>}
    </div>}
  </div>
}

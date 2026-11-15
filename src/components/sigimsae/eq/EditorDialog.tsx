import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../Icon'

/** Large modal editor shell (dark/light themed): Esc closes, Tab is trapped, focus returns to the opener. */
export function EditorDialog({ eyebrow, title, subtitle, onClose, children, actions, hint }: {
  eyebrow: string; title: string; subtitle?: string; onClose(): void
  children: React.ReactNode; actions?: React.ReactNode; hint?: React.ReactNode
}) {
  const dialog = useRef<HTMLElement>(null), titleId = useId(), hintId = useId()
  const close = useRef(onClose); close.current = onClose
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.focus({ preventScroll: true })
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }) }
  }, [])
  function keyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close.current(); return }
    if (event.key !== 'Tab') return
    const items = Array.from(dialog.current!.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex="0"]')).filter(item => item.getClientRects().length > 0)
    if (!items.length) return
    const first = items[0], last = items[items.length - 1], active = document.activeElement
    if (event.shiftKey && (active === first || active === dialog.current)) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus() }
  }
  return createPortal(<div className="sgd-backdrop" onPointerDown={event => { event.stopPropagation(); if (event.target === event.currentTarget && !document.querySelector('[data-daw-gesture]')) close.current() }}>
    <section ref={dialog} className="sgd" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={hint ? hintId : undefined} tabIndex={-1} onKeyDown={keyDown}>
      <header className="sgd-head">
        <div className="sgd-heading"><span className="sgd-eyebrow">{eyebrow}</span><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <div className="sgd-actions">{actions}<button className="sgd-close" onClick={() => close.current()} aria-label={`${title} 편집기 닫기`} title="닫기 (Esc)"><Icon name="close" size={18}/></button></div>
      </header>
      {children}
      {hint && <footer className="sgd-foot" id={hintId}>{hint}</footer>}
    </section>
  </div>, document.body)
}

/** Text number field: type a value (e.g. "1.2k"), Enter/blur commits, ↑/↓ step (Shift = fine). */
export function NumberField({ label, value, format, parse, step, onCommit, disabled, suffix }: {
  label: string; value: number; format(value: number): string; parse(text: string): number | null
  step(value: number, direction: 1 | -1, fine: boolean): number; onCommit(value: number): void; disabled?: boolean; suffix?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => { if (draft !== null) { const parsed = parse(draft); if (parsed !== null && Number.isFinite(parsed)) onCommit(parsed) } setDraft(null) }
  return <label className={`sgd-field${disabled ? ' is-disabled' : ''}`}>
    <span>{label}</span>
    <input type="text" inputMode="decimal" role="spinbutton" aria-valuenow={value} aria-valuetext={format(value)} value={draft ?? format(value)} disabled={disabled}
      onFocus={event => event.currentTarget.select()} onChange={event => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); commit(); event.currentTarget.blur() }
        else if (event.key === 'Escape' && draft !== null) { event.preventDefault(); event.stopPropagation(); setDraft(null) }
        else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setDraft(null); onCommit(step(value, event.key === 'ArrowUp' ? 1 : -1, event.shiftKey)) }
      }}/>
    {suffix && <small>{suffix}</small>}
  </label>
}

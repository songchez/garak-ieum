import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import './ContextMenu.css'

export type ContextMenuItem =
  | { type?: 'item'; label: string; icon?: string; shortcut?: string; disabled?: boolean; danger?: boolean; checked?: boolean; onSelect?: () => void; items?: ContextMenuItem[] }
  | { type: 'separator' }

export interface ContextMenuProps {
  /** Viewport (client) coordinates of the pointer or anchor. */
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
  label?: string
  /** The button that toggles this menu; presses on it are left to its own click handler. */
  trigger?: Element | null
}

const isSeparator = (item: ContextMenuItem): item is { type: 'separator' } => item.type === 'separator'
const menuButtons = (menu: Element | null | undefined) => menu ? [...menu.querySelectorAll<HTMLButtonElement>(':scope > li > [role^="menuitem"]:not(:disabled)')] : []

function MenuList({ items, onClose, label, flip, submenu = false }: { items: ContextMenuItem[]; onClose: () => void; label?: string; flip: boolean; submenu?: boolean }) {
  const [open, setOpen] = useState<number | null>(null)
  const ref = useRef<HTMLUListElement>(null)
  const hasIcons = items.some(item => !isSeparator(item) && !!item.icon)
  useEffect(() => { if (submenu) menuButtons(ref.current)[0]?.focus({ preventScroll: true }) }, [submenu])
  return <ul ref={ref} className={`context-menu-list${submenu ? ' context-menu-list--sub' : ''}${flip ? ' context-menu-list--flip' : ''}${hasIcons ? ' context-menu-list--icons' : ''}`} role="menu" aria-label={label}>
    {items.map((item, index) => isSeparator(item)
      ? <li key={`sep-${index}`} role="separator" className="context-menu-separator" />
      : <li key={`${item.label}-${index}`} className="context-menu-entry" role="none"
        onMouseEnter={() => setOpen(item.items ? index : null)}
        onKeyDown={event => {
          const button = event.currentTarget.querySelector<HTMLButtonElement>(':scope > [role^="menuitem"]')
          if (!item.items || !button) return
          if (event.target === button && (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault(); event.stopPropagation(); setOpen(index)
          } else if (event.target !== button && (event.key === 'ArrowLeft' || event.key === 'Escape')) {
            event.preventDefault(); event.stopPropagation(); setOpen(null); button.focus({ preventScroll: true })
          }
        }}>
        <button type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={item.checked} disabled={item.disabled}
          className={`context-menu-item${item.danger ? ' context-menu-item--danger' : ''}${item.checked ? ' context-menu-item--checked' : ''}`}
          aria-haspopup={item.items ? 'menu' : undefined} aria-expanded={item.items ? open === index : undefined}
          onMouseEnter={event => event.currentTarget.focus({ preventScroll: true })}
          onClick={() => {
            if (item.items) { setOpen(index); return }
            onClose()
            item.onSelect?.()
          }}
        >
          {hasIcons && <span className="context-menu-icon" aria-hidden="true">{item.icon && <Icon name={item.icon} size={15}/>}</span>}
          <span className="context-menu-label">{item.label}</span>
          {item.items ? <span className="context-menu-arrow" aria-hidden="true"><Icon name="right" size={12}/></span> : item.shortcut && <kbd className="context-menu-shortcut">{item.shortcut}</kbd>}
        </button>
        {item.items && open === index && <MenuList items={item.items} onClose={onClose} label={item.label} flip={flip} submenu />}
      </li>)}
  </ul>
}

/** A positioned menu that closes on Escape, outside press, scroll, resize and window blur. */
export default function ContextMenu({ x, y, items, onClose, label = '컨텍스트 메뉴', trigger }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  const triggerRef = useRef(trigger)
  const [position, setPosition] = useState({ left: x, top: y, flip: false, ready: false })
  useEffect(() => { closeRef.current = onClose; triggerRef.current = trigger })

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const { width, height } = element.getBoundingClientRect()
    const left = Math.max(4, Math.min(x, window.innerWidth - width - 4))
    const top = y + height > window.innerHeight - 4 ? Math.max(4, y - height) : y
    setPosition({ left, top, flip: left + width * 2 > window.innerWidth - 4, ready: true })
  }, [x, y])

  useEffect(() => {
    if (position.ready && !ref.current?.contains(document.activeElement)) menuButtons(ref.current?.firstElementChild)[0]?.focus({ preventScroll: true })
  }, [position.ready])

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const close = () => closeRef.current()
    const outside = (event: Event) => { if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) close() }
    const press = (event: Event) => { if (!(event.target instanceof Node && triggerRef.current?.contains(event.target))) outside(event) }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || (event.target instanceof Node && ref.current?.contains(event.target))) return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    document.addEventListener('pointerdown', press, true)
    window.addEventListener('keydown', escape, true)
    window.addEventListener('scroll', outside, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('pointerdown', press, true)
      window.removeEventListener('keydown', escape, true)
      window.removeEventListener('scroll', outside, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      const active = document.activeElement
      if (previous?.isConnected && (!active || active === document.body || !active.isConnected || ref.current?.contains(active))) previous.focus({ preventScroll: true })
    }
  }, [])

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    // Menu navigation stays local. Global transport consumes Space in capture first.
    event.stopPropagation()
    const active = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null
    const list = menuButtons(active?.closest('[role="menu"]') ?? ref.current?.firstElementChild)
    const index = active ? list.indexOf(active) : -1
    const focus = (next: number) => list[(next + list.length) % list.length]?.focus({ preventScroll: true })
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); focus(index + 1); break
      case 'ArrowUp': event.preventDefault(); focus(index < 0 ? -1 : index - 1); break
      case 'Home': event.preventDefault(); focus(0); break
      case 'End': event.preventDefault(); focus(-1); break
      case 'Escape': case 'Tab': event.preventDefault(); onClose(); break
    }
  }

  return createPortal(<div ref={ref} className="context-menu" style={{ left: position.left, top: position.top, visibility: position.ready ? undefined : 'hidden' }}
    onKeyDown={handleKeyDown} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation() }}>
    <MenuList items={items} onClose={onClose} label={label} flip={position.flip} />
  </div>, document.body)
}

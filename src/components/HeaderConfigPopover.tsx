import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TrackHeaderConfig } from '../core/trackUi'
import { Icon } from './Icon'
import './ColorPalette.css'

/** Floating, non-modal panel anchored at viewport (x, y): Escape, outside press, scroll, resize and window blur close it. */
export function Popover({ x, y, title, label = title, className = '', onClose, children }: { x: number; y: number; title: string; label?: string; className?: string; onClose(): void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [position, setPosition] = useState({ left: x, top: y, ready: false })

  useLayoutEffect(() => {
    const el = ref.current; if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPosition({ left: Math.max(4, Math.min(x, window.innerWidth - width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - height - 4)), ready: true })
  }, [x, y])

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const close = () => closeRef.current()
    const outside = (event: Event) => { if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) close() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', escape, true)
    window.addEventListener('scroll', outside, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('keydown', escape, true)
      window.removeEventListener('scroll', outside, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      const active = document.activeElement
      if (previous?.isConnected && (!active || active === document.body || !active.isConnected || ref.current?.contains(active))) previous.focus({ preventScroll: true })
    }
  }, [])

  return createPortal(<div ref={ref} className={`popover ${className}`} role="group" aria-label={label} style={{ left: position.left, top: position.top, visibility: position.ready ? undefined : 'hidden' }}
    onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} onContextMenu={e => { e.preventDefault(); e.stopPropagation() }}>
    <div className="popover-title"><strong>{title}</strong><button type="button" className="popover-close" aria-label="닫기" title="닫기 (Esc)" onClick={onClose}><Icon name="close" size={11}/></button></div>
    {children}
  </div>, document.body)
}

const GROUPS: { title: string; items: [keyof TrackHeaderConfig, string][] }[] = [
  { title: '버튼', items: [['mute', '음소거'], ['solo', '솔로'], ['record', '녹음 가능'], ['monitor', '입력 모니터링'], ['onOff', '켬/끔'], ['hide', '가리기']] },
  { title: '컨트롤', items: [['volume', '볼륨'], ['pan', '팬']] },
  { title: '기타', items: [['trackNumber', '트랙 번호'], ['colorBar', '색상 막대'], ['icon', '트랙 아이콘']] },
]

export function HeaderConfigPopover({ x, y, config, onChange, onClose }: { x: number; y: number; config: TrackHeaderConfig; onChange(next: TrackHeaderConfig): void; onClose(): void }) {
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => { first.current?.focus({ preventScroll: true }) }, [])
  return <Popover x={x} y={y} title="트랙 헤더 구성" className="header-config" onClose={onClose}>
    <div className="header-config-groups">
      {GROUPS.map(group => <fieldset key={group.title} className="header-config-group"><legend>{group.title}</legend>
        {group.items.map(([key, label], i) => <label key={key} className="header-config-item"><input ref={group === GROUPS[0] && i === 0 ? first : undefined} type="checkbox" checked={config[key]} onChange={e => onChange({ ...config, [key]: e.target.checked })}/><span>{label}</span></label>)}
      </fieldset>)}
    </div>
  </Popover>
}

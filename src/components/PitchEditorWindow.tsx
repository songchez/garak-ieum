import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import './PitchEditorWindow.css'

interface Props {
  title: string
  /** Analysis or rendering is running: closing would abandon it. */
  busy: boolean
  dirty: boolean
  onClose(): void
  children: ReactNode
}

/**
 * A floating, non-modal editor window inside the studio. It is not a dialog on
 * purpose: Space, undo and the other studio shortcuts keep working while you
 * listen to the corrected take. Drag the title bar to move it.
 */
export function PitchEditorWindow({ title, busy, dirty, onClose, children }: Props) {
  const root = useRef<HTMLElement>(null)
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [maximized, setMaximized] = useState(false)
  useEffect(() => { root.current?.querySelector<HTMLElement>('.pitch-editor')?.focus({ preventScroll: true }) }, [])
  const close = () => { if (!busy) onClose() }
  return <section ref={root} className={`pitch-window${maximized ? ' is-maximized' : ''}`} role="region" aria-label="피치 편집 창"
    style={maximized ? undefined : { translate: `${offset.x}px ${offset.y}px` }}>
    <header className="pitch-window-bar"
      onPointerDown={event => {
        if (maximized || event.button !== 0 || (event.target instanceof Element && event.target.closest('button'))) return
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: offset.x, top: offset.y }
      }}
      onPointerMove={event => {
        const current = drag.current
        if (!current || current.pointerId !== event.pointerId) return
        // Keep the title bar reachable: it can leave the edges but never the top.
        const x = current.left + event.clientX - current.x
        const y = Math.max(-(root.current?.offsetTop ?? 0) + 4, current.top + event.clientY - current.y)
        setOffset({ x, y })
      }}
      onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}
      onDoubleClick={event => { if (!(event.target instanceof Element && event.target.closest('button'))) setMaximized(value => !value) }}>
      <Icon name="wave" size={14}/>
      <strong>피치 편집</strong>
      <span className="pitch-window-title" title={title}>{title}{dirty ? ' · 적용하지 않은 변경' : ''}</span>
      <span className="pitch-window-tools">
        <button type="button" onClick={() => setMaximized(value => !value)} aria-pressed={maximized} aria-label={maximized ? '창 크기 복원' : '창 최대화'} title={maximized ? '복원 (제목 표시줄 더블 클릭)' : '최대화 (제목 표시줄 더블 클릭)'}><Icon name="fit" size={12}/></button>
        <button type="button" onClick={close} disabled={busy} aria-label="피치 편집 창 닫기" title={busy ? '분석·렌더가 끝나거나 취소한 뒤 닫을 수 있습니다' : dirty ? '닫기 · 적용하지 않은 변경은 다시 열면 이어집니다' : '닫기'}><Icon name="close" size={13}/></button>
      </span>
    </header>
    <div className="pitch-window-body">{children}</div>
  </section>
}

import { createContext, useContext, useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react'
import { defaultEditorPanel, editorPanelHeight, loadEditorPanel, PANEL_COLLAPSED_HEIGHT, PANEL_MIN_HEIGHT, saveEditorPanel, type EditorKind, type EditorPanelLayout } from '../core/editorPanel'
import { Icon } from './Icon'
import './EditorPanel.css'

interface PanelControls { collapsed: boolean; maximized: boolean; contentId: string; collapse(): void; maximize(): void }
const PanelContext = createContext<PanelControls | null>(null)
interface ResizeGesture { pointerId: number; y: number; height: number; layout: EditorPanelLayout; maximized: boolean }

export function EditorPanel({ kind, openRequest = 0, children }: { kind: EditorKind; openRequest?: number; children: ReactNode }) {
  const [layout, setLayout] = useState(loadEditorPanel)
  const [maximized, setMaximized] = useState(false)
  const [available, setAvailable] = useState(640)
  const [resizing, setResizing] = useState(false)
  const root = useRef<HTMLElement>(null), handle = useRef<HTMLDivElement>(null)
  const gesture = useRef<ResizeGesture | null>(null)
  const request = useRef(openRequest)
  const contentId = useId()
  const height = editorPanelHeight(layout.heights[kind], available, layout.collapsed, maximized)

  useEffect(() => {
    const parent = root.current?.parentElement
    if (!parent) return
    const measure = () => setAvailable(parent.getBoundingClientRect().height)
    const observer = new ResizeObserver(measure)
    observer.observe(parent); measure()
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (request.current === openRequest) return
    request.current = openRequest
    setLayout(value => value.collapsed ? { ...value, collapsed: false } : value)
  }, [openRequest])
  useEffect(() => {
    if (resizing) return
    saveEditorPanel(layout)
  }, [layout, resizing])

  const finish = (commit: boolean) => {
    const current = gesture.current
    if (!current) return
    gesture.current = null
    if (!commit) { setLayout(current.layout); setMaximized(current.maximized) }
    setResizing(false)
    if (handle.current?.hasPointerCapture(current.pointerId)) handle.current.releasePointerCapture(current.pointerId)
  }
  useEffect(() => {
    const blur = () => finish(false)
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || !gesture.current) return
      event.preventDefault(); event.stopPropagation(); finish(false)
    }
    window.addEventListener('blur', blur); window.addEventListener('keydown', escape, true)
    return () => { window.removeEventListener('blur', blur); window.removeEventListener('keydown', escape, true) }
  }, [])

  function resizeTo(next: number) {
    setMaximized(false)
    setLayout(value => ({ ...value, collapsed: false, heights: { ...value.heights, [kind]: Math.max(PANEL_MIN_HEIGHT, editorPanelHeight(next, available)) } }))
  }
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true })
    gesture.current = { pointerId: event.pointerId, y: event.clientY, height, layout, maximized }
    event.currentTarget.setPointerCapture(event.pointerId)
    setResizing(true)
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
    const change = event.shiftKey ? 64 : 24
    if (event.key === 'ArrowUp') resizeTo(height + change)
    else if (event.key === 'ArrowDown') resizeTo(height - change)
    else if (event.key === 'Home') resizeTo(PANEL_MIN_HEIGHT)
    else if (event.key === 'End') { setLayout(value => ({ ...value, collapsed: false })); setMaximized(true) }
    else if (event.key === 'Enter') setLayout(value => ({ ...value, collapsed: !value.collapsed }))
    else return
    event.preventDefault(); event.stopPropagation()
  }
  const controls: PanelControls = {
    collapsed: layout.collapsed, maximized, contentId,
    collapse: () => { setMaximized(false); setLayout(value => ({ ...value, collapsed: !value.collapsed })) },
    maximize: () => { setLayout(value => ({ ...value, collapsed: false })); setMaximized(value => !value) },
  }

  return <PanelContext.Provider value={controls}>
    <section ref={root} className={`bottom-panel resizable-editor-panel${kind === 'pitch' ? ' pitch-panel' : ''}${layout.collapsed ? ' is-collapsed' : ''}${maximized && !layout.collapsed ? ' is-maximized' : ''}${resizing ? ' is-resizing' : ''}`} style={{ height }} data-editor-kind={kind} data-daw-gesture={resizing ? 'editor-resize' : undefined} aria-label="하단 편집 영역">
      <div ref={handle} role="separator" className="editor-resize-handle" tabIndex={0} aria-label="편집 영역 높이 조절" aria-orientation="horizontal" aria-controls={contentId} aria-valuemin={PANEL_COLLAPSED_HEIGHT} aria-valuemax={Math.round(available)} aria-valuenow={Math.round(height)} aria-valuetext={`${Math.round(height)} 픽셀`} title="위아래로 드래그 · ↑↓ 높이 조절 · 더블 클릭 기본 높이" onPointerDown={pointerDown} onPointerMove={event => { const current = gesture.current; if (current?.pointerId === event.pointerId) resizeTo(current.height + current.y - event.clientY) }} onPointerUp={event => { if (gesture.current?.pointerId === event.pointerId) finish(true) }} onPointerCancel={() => finish(false)} onLostPointerCapture={() => { if (gesture.current) finish(false) }} onKeyDown={keyDown} onDoubleClick={() => { setMaximized(false); setLayout(value => ({ ...value, collapsed: false, heights: { ...value.heights, [kind]: defaultEditorPanel().heights[kind] } })) }}><span/></div>
      {children}
    </section>
  </PanelContext.Provider>
}

export function EditorPanelActions() {
  const panel = useContext(PanelContext)
  if (!panel) return null
  return <span className="editor-panel-actions">
    <button type="button" className="icon-button small" onClick={panel.maximize} aria-label={panel.maximized ? '편집 영역 크기 복원' : '편집 영역 최대화'} title={panel.maximized ? '편집 영역 크기 복원' : '편집 영역 최대화'} aria-pressed={panel.maximized}><Icon name={panel.maximized ? 'compressor' : 'fit'} size={14}/></button>
    <button type="button" className="icon-button small" onClick={panel.collapse} aria-label={panel.collapsed ? '편집 영역 펼치기' : '편집 영역 접기'} title={panel.collapsed ? '편집 영역 펼치기' : '편집 영역 접기'} aria-expanded={!panel.collapsed} aria-controls={panel.contentId}><Icon name="chevron" size={15} style={{ transform: panel.collapsed ? 'rotate(180deg)' : undefined }}/></button>
  </span>
}

/** Hide without unmounting, so a pitch draft, selection and editor scroll position survive folding. */
export function EditorPanelBody({ children }: { children: ReactNode }) {
  const panel = useContext(PanelContext)
  return <div id={panel?.contentId} className="editor-panel-body" hidden={panel?.collapsed}>{children}</div>
}

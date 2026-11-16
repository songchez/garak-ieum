import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../components/Icon'
import { OKGU_EP_ID, VINTAGE_PARAMS, type VintageInstrumentId } from '../params'
import type { VintageUserPreset } from '../userPresets'
import { VintageControls } from './controls'
import { Hanbam106Panel, OkguEpPanel } from './panels'
import { PresetBar } from './PresetBar'
import { VINTAGE_NAMES } from './presetActions'
import './VintageEditor.css'

export interface VintageEditorProps {
  instrument: VintageInstrumentId
  trackName?: string
  /** `track.instrumentParams` (missing ids = defaults). */
  params: Readonly<Record<string, number>>
  /** Instrument colour: knob arcs and graph accents. */
  color?: string
  onParam(id: string, value: number): void
  /** A whole preset as one undo step. */
  onParams(params: Record<string, number>, label: string): void
  onClose(): void
  /** '' when the instrument can play; otherwise why not (instrumentUnavailableReason). Editing still works. */
  unavailableReason?: string
  onPreview?(): void
  /** Injected in tests; defaults to localStorage. */
  userPresets?: readonly VintageUserPreset[]
}

const SUBTITLE: Record<VintageInstrumentId, string> = { [OKGU_EP_ID]: 'TINE ELECTRIC PIANO', 'hanbam-106': 'POLYPHONIC SYNTHESIZER' }
const ACCENT: Record<VintageInstrumentId, string> = { [OKGU_EP_ID]: '#7fb4e6', 'hanbam-106': '#c48ad9' }
const FOCUSABLE = 'button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex]:not([tabindex="-1"])'

/** The editor content (no portal / focus handling), rendered by VintageEditor and by tests. */
export function VintageEditorPanel({ instrument, trackName, params, color, onParam, onParams, onClose, unavailableReason, onPreview, userPresets, titleId, announce, onAnnounce }:
  VintageEditorProps & { titleId: string; announce: string; onAnnounce(message: string): void }) {
  const name = VINTAGE_NAMES[instrument], accent = ACCENT[instrument]
  return <VintageControls.Provider value={{ defs: VINTAGE_PARAMS[instrument], params, onParam, color: color ?? accent }}>
    <header className="vt-header">
      <div className="vt-brand">
        <span className="vt-brand-mark" aria-hidden="true"><Icon name={instrument === OKGU_EP_ID ? 'keys' : 'synth'} size={20}/></span>
        <div><h2 id={titleId}>{name}</h2><span>{SUBTITLE[instrument]}{trackName ? <> <i>·</i> {trackName}</> : null}</span></div>
      </div>
      <PresetBar instrument={instrument} params={params} onParams={onParams} onAnnounce={onAnnounce} userPresets={userPresets}/>
      <div className="vt-header-actions">
        {onPreview && <button type="button" className="vt-button" onClick={onPreview} disabled={!!unavailableReason} title={unavailableReason || '현재 설정으로 미리 듣기'}><Icon name="play" size={12}/>미리 듣기</button>}
        <button type="button" className="vt-close" onClick={onClose} aria-label={`${name} 편집기 닫기`} title="닫기 (Esc)"><Icon name="close" size={18}/></button>
      </div>
    </header>
    {unavailableReason && <p className="vt-status" role="status"><Icon name="info" size={14}/><span>{unavailableReason}</span></p>}
    <div className="vt-body">{instrument === OKGU_EP_ID ? <OkguEpPanel/> : <Hanbam106Panel/>}</div>
    <footer className="vt-footer"><span>드래그·휠 조절 <i>·</i> Shift 미세 조절 <i>·</i> 더블 클릭 기본값 <i>·</i> 우클릭 오토메이션</span><span>그래프는 원리를 보여 주는 그림이며 실시간 측정값이 아닙니다.</span></footer>
    <div className="vt-sr-only" role="status" aria-live="polite">{announce}</div>
  </VintageControls.Provider>
}

/** Overlay editor for the vintage instruments (옥구슬 EP / 한밤 106), like the IEUM WAVE editor. */
export function VintageEditor(props: VintageEditorProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const [announce, setAnnounce] = useState('')
  const latestClose = useRef(props.onClose); latestClose.current = props.onClose

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.focus({ preventScroll: true })
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => { if (!announce) return; const timer = setTimeout(() => setAnnounce(''), 4200); return () => clearTimeout(timer) }, [announce])

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Project undo/redo/save stays with the app while the editor is open.
    if ((event.ctrlKey || event.metaKey) && ['z', 'y', 's'].includes(event.key.toLowerCase())) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); latestClose.current(); return }
    if (event.key === 'Tab') {
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(element => element.tabIndex >= 0 && element.getClientRects().length)
      if (!controls.length) { event.preventDefault(); return }
      const first = controls[0], last = controls[controls.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first.focus() }
    }
    event.stopPropagation()
  }

  return createPortal(<div className="vt-overlay" onPointerDown={event => { event.stopPropagation(); if (event.target === event.currentTarget && !document.querySelector('[data-daw-gesture]')) latestClose.current() }}>
    <div ref={dialogRef} className="vt-editor" data-vintage-editor={props.instrument} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={keyDown}
      style={{ '--vt-accent': ACCENT[props.instrument] } as CSSProperties}>
      <VintageEditorPanel {...props} titleId={titleId} announce={announce} onAnnounce={setAnnounce}/>
    </div>
  </div>, document.body)
}

export default VintageEditor

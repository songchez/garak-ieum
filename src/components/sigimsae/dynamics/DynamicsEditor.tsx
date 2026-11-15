import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatParam, type ParamDef } from '../../../core/devices'
import { Knob } from '../../Knob'
import { Icon } from '../../Icon'
import { clamp } from './curve'
import type { DynamicsFeed } from './feed'
import { GateEnvelope, GrMeter, HistoryGraph, TransferGraph, VuNeedle, type DynamicsKind, type ParamAccess } from './graphs'

const HINTS: Record<DynamicsKind, string> = {
  compressor: '꺾이는 점을 끌면 스레숄드, 그 오른쪽 곡선을 위아래로 끌면 비율이 바뀝니다. 기록 화면의 점선을 위아래로 끌어도 스레숄드가 바뀝니다.',
  limiter: '꺾이는 점을 위아래로 끌면 실링, 좌우로 끌면 입력 게인이 바뀝니다. 기록 화면의 점선이 실링입니다.',
  gate: '꺾이는 점을 좌우로 끌면 스레숄드가 바뀝니다. 아래 엔벨로프의 손잡이를 끌어 어택·홀드·릴리즈를 정합니다. 어두운 구간은 게이트가 닫힌 시간입니다.',
}

/** A knob plus an exact numeric field for one parameter. */
export function ParamField({ def, value, onChange, color }: { def: ParamDef; value: number; onChange(v: number): void; color?: string }) {
  const [draft, setDraft] = useState<string | null>(null)
  const id = useId()
  const commit = () => {
    if (draft === null) return
    const parsed = Number(draft.replace(',', '.').replace(/[^0-9.+\-e]/gi, ''))
    if (Number.isFinite(parsed)) onChange(clamp(parsed, def.min, def.max))
    setDraft(null)
  }
  const digits = def.unit === 'ratio' || Math.abs(def.max) <= 50 ? 1 : 0
  return (
    <div className="dyn-field">
      <Knob def={def} value={value} onChange={onChange} color={color} size={44}/>
      <label htmlFor={id} className="dyn-field-input">
        <input id={id} inputMode="decimal" aria-label={`${def.label} 값 입력`} value={draft ?? value.toFixed(digits)}
          onChange={event => setDraft(event.target.value)} onBlur={commit}
          onKeyDown={event => { if (event.key === 'Enter') { commit(); (event.target as HTMLInputElement).select() } else if (event.key === 'Escape' && draft !== null) { event.stopPropagation(); setDraft(null) } }}/>
        <span>{def.unit === 'db' ? 'dB' : def.unit === 'ms' ? 'ms' : def.unit === 'ratio' ? ': 1' : ''}</span>
      </label>
    </div>
  )
}

interface EditorProps extends ParamAccess {
  kind: DynamicsKind
  feed: DynamicsFeed
  name: string
  label: string
  enabled: boolean
  vu: boolean
  color?: string
  onClose(): void
}

/** Large editor (dark, like the guitar rig dialog). Esc closes; focus stays inside until closed. */
export function DynamicsEditor(props: EditorProps) {
  const { kind, feed, name, label, enabled, vu, color, onClose } = props
  const dialogRef = useRef<HTMLElement>(null)
  const titleId = useId(), hintId = useId()
  const [graphSize, setGraphSize] = useState(300)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current!
    dialog.focus({ preventScroll: true })
    const focusInside = (event: FocusEvent) => { if (event.target instanceof Node && !dialog.contains(event.target)) dialog.focus({ preventScroll: true }) }
    document.addEventListener('focusin', focusInside)
    const fit = () => setGraphSize(window.innerWidth < 720 ? Math.max(200, Math.min(300, window.innerWidth - 80)) : window.innerHeight < 760 ? 240 : 300)
    fit(); window.addEventListener('resize', fit)
    return () => {
      document.removeEventListener('focusin', focusInside); window.removeEventListener('resize', fit)
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  const keyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onClose(); return }
    if (event.key !== 'Tab') return
    const items = Array.from(dialogRef.current!.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),[tabindex="0"]')).filter(item => item.getClientRects().length > 0)
    const first = items[0], last = items[items.length - 1], active = document.activeElement
    if (!first) { event.preventDefault(); return }
    if (event.shiftKey && (active === first || active === dialogRef.current)) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && (active === last || active === dialogRef.current)) { event.preventDefault(); first.focus() }
  }
  const range = kind === 'gate' ? 60 : 24
  return createPortal(
    <div className="dyn-backdrop" onPointerDown={event => { event.stopPropagation(); if (event.target === event.currentTarget && !document.querySelector('[data-daw-gesture]')) onClose() }}>
      <section ref={dialogRef} className="dyn-editor" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={hintId} tabIndex={-1} onKeyDown={keyDown} data-kind={kind}>
        <header className="dyn-editor-head">
          <div>
            <p className="dyn-eyebrow">시김새 · 다이내믹</p>
            <h2 id={titleId}>{name}</h2>
            <p className="dyn-sub">{label}{enabled ? '' : ' · 바이패스 중'}{feed.live ? '' : ' · 재생하면 실시간 레벨이 표시됩니다'}</p>
          </div>
          <button className="dyn-close" onClick={onClose} aria-label={`${name} 편집기 닫기`} title="닫기 (Esc)"><Icon name="close" size={16}/></button>
        </header>
        <div className="dyn-editor-body">
          <div className="dyn-editor-graphs">
            <figure className="dyn-panel dyn-panel-curve">
              <figcaption>입출력 곡선</figcaption>
              <TransferGraph {...props} size={graphSize} name={name}/>
            </figure>
            <figure className="dyn-panel dyn-panel-history">
              <figcaption>레벨 · 게인 리덕션 기록 <small>최근 6초</small></figcaption>
              <HistoryGraph {...props} height={graphSize} name={name}/>
            </figure>
            <figure className="dyn-panel dyn-panel-meter">
              <figcaption>{kind === 'gate' ? '감쇠' : 'GR'}</figcaption>
              <GrMeter feed={feed} height={graphSize - 22} range={range} label={`${name} 게인 리덕션 미터`}/>
            </figure>
          </div>
          <div className="dyn-editor-controls">
            {vu && <figure className="dyn-panel dyn-panel-vu"><VuNeedle feed={feed} width={200} label={`${name} VU 미터 (게인 리덕션)`}/></figure>}
            {kind === 'gate' && <figure className="dyn-panel dyn-panel-env"><figcaption>엔벨로프</figcaption><GateEnvelope {...props} width={400} height={130} name={name}/></figure>}
            <div className="dyn-fields" role="group" aria-label={`${name} 파라미터`}>
              {props.defs.map(def => <ParamField key={def.id} def={def} value={props.value(def.id)} color={color} onChange={v => props.onParam(def.id, v)}/>)}
            </div>
          </div>
        </div>
        <footer className="dyn-editor-foot">
          <p id={hintId}>{HINTS[kind]}</p>
          <p><kbd>Shift</kbd> 미세 조절 · <kbd>Alt</kbd>+클릭 기본값 · 화살표 키로 손잡이 조절 · <kbd>Esc</kbd> 닫기</p>
        </footer>
      </section>
    </div>, document.body)
}

/** "−18.0 dB · 4.0:1" readout chips for the compact card. */
export function summary(kind: DynamicsKind, p: ParamAccess): { label: string; text: string }[] {
  const d = (id: string) => p.defs.find(def => def.id === id)!
  if (kind === 'compressor') return [{ label: '스레숄드', text: formatParam(d('threshold'), p.value('threshold')) }, { label: '비율', text: formatParam(d('ratio'), p.value('ratio')) }]
  if (kind === 'limiter') return [{ label: '실링', text: formatParam(d('ceiling'), p.value('ceiling')) }, { label: '입력', text: formatParam(d('gain'), p.value('gain')) }]
  return [{ label: '스레숄드', text: formatParam(d('threshold'), p.value('threshold')) }]
}

import { useEffect, useRef, useState } from 'react'
import type { Project, TimeSignature, TimeSignatureDenominator } from '../core/types'
import { MAX_TIME_SIGNATURE_NUMERATOR, MIN_TIME_SIGNATURE_NUMERATOR, TIME_SIGNATURE_DENOMINATORS } from '../core/meter'
import { MeterMap, addMeterEvent, deleteMeterEvent, meterMapOf, moveMeterEvent, setMeterEvent } from '../core/meterMap'
import { crossedDragThreshold } from '../core/input'
import type { ContextMenuItem } from './ContextMenu'
import { Icon } from './Icon'

/** Height of the 박자 global track (px). */
export const METER_ROW_HEIGHT = 22

/** Common meters offered in the editor, including the compound ones (겹박자). */
const PRESETS: readonly TimeSignature[] = [
  { numerator: 2, denominator: 4 }, { numerator: 3, denominator: 4 }, { numerator: 4, denominator: 4 }, { numerator: 5, denominator: 4 },
  { numerator: 6, denominator: 8 }, { numerator: 7, denominator: 8 }, { numerator: 9, denominator: 8 }, { numerator: 12, denominator: 8 },
]

interface Props {
  project: Project
  width: number
  ppb: number
  laneStyle: React.CSSProperties
  playheadBeat(): number
  /** One call = one undo step. */
  onChange(edit: (project: Project) => Project, label: string): void
  onSeek(beat: number): void
  openMenu(e: React.MouseEvent, items: ContextMenuItem[], label: string): void
}

interface Drag { index: number; bar: number; beat: number }
/** The editor: a new change at `bar`, or event `index`. Anchored at viewport coordinates. */
type Editor = { kind: 'add'; bar: number; x: number; y: number } | { kind: 'edit'; index: number; x: number; y: number }

const label = (meter: TimeSignature) => `${meter.numerator}/${meter.denominator}`

/**
 * 박자 global track (docs/METER_MAP.md, Logic's Signature track): time-signature changes on bar lines.
 * Double-click (or the menu) on the lane opens the editor for a change at that bar; drag a change along
 * bars; double-click it to edit; right-click or ⌫ deletes it. Every gesture commits one undo step.
 */
export function MeterTrack({ project, width, ppb, laneStyle, playheadBeat, onChange, onSeek, openMenu }: Props) {
  const [drag, setDrag] = useState<Drag | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const laneRef = useRef<HTMLDivElement>(null)
  const meters = meterMapOf(project)
  const segments = meters.segments
  useEffect(() => { if (selected !== null && selected >= segments.length) setSelected(null) }, [selected, segments.length])

  const remove = (index: number) => {
    if (index <= 0) return
    setSelected(null)
    onChange(project => deleteMeterEvent(project, index), '박자 변경 삭제')
  }
  const barOfClient = (clientX: number) => {
    const lane = laneRef.current
    if (!lane) return 0
    return Math.max(0, Math.round(meters.barAt(Math.max(0, (clientX - lane.getBoundingClientRect().left) / ppb))))
  }
  const openAdd = (bar: number, x: number, y: number) => {
    const existing = segments.findIndex(segment => segment.bar === bar)
    setEditor(existing >= 0 ? { kind: 'edit', index: existing, x, y } : { kind: 'add', bar, x, y })
  }

  function beginEvent(e: React.PointerEvent<HTMLElement>, index: number) {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    setSelected(index)
    const target = e.currentTarget, startX = e.clientX
    const origin = segments[index]
    // Bar lines a moved change can land on: the map without it (the meter before it extends up to the next change).
    const without = new MeterMap(project.timeSignature, meters.events.filter((_, at) => at !== index))
    const lower = index > 0 ? segments[index - 1].bar + 1 : 0
    const upper = segments[index + 1] ? segments[index + 1].bar - 1 : Infinity
    let started = false, current: Drag = { index, bar: origin.bar, beat: origin.beat }
    try { target.setPointerCapture(e.pointerId) } catch { /* window listeners still end the drag */ }
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      if (!started && !crossedDragThreshold(dx, 0)) return
      started = true
      if (index === 0) return
      const bar = Math.min(upper, Math.max(lower, Math.round(without.barAt(Math.max(0, origin.beat + dx / ppb)))))
      current = { index, bar, beat: without.beatAtBar(bar) }
      setDrag(current)
    }
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel)
      setDrag(null)
      if (!commit) return
      if (!started) { onSeek(origin.beat); return }
      if (current.bar !== origin.bar) onChange(project => moveMeterEvent(project, index, current.bar), '박자 변경 이동')
    }
    const up = () => finish(true), cancel = () => finish(false)
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel)
  }

  function eventMenu(e: React.MouseEvent<HTMLElement>, index: number) {
    setSelected(index)
    const segment = segments[index], rect = e.currentTarget.getBoundingClientRect()
    const items: ContextMenuItem[] = [
      { label: '박자 편집…', icon: 'metronome', onSelect: () => setEditor({ kind: 'edit', index, x: rect.left, y: rect.bottom }) },
      { label: '재생 위치로 이동', icon: 'locate', onSelect: () => onSeek(segment.beat) },
    ]
    if (index > 0) items.push({ label: '박자 변경 삭제', icon: 'trash', danger: true, onSelect: () => remove(index) })
    openMenu(e, items, '박자 변경')
  }

  function laneMenu(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return
    const bar = barOfClient(e.clientX), x = e.clientX, y = e.currentTarget.getBoundingClientRect().bottom
    openMenu(e, [{ label: `${bar + 1}마디에 박자 변경 추가…`, icon: 'plus', onSelect: () => openAdd(bar, x, y) }], '박자')
  }

  const commitEditor = (meter: TimeSignature) => {
    const current = editor
    setEditor(null)
    if (!current) return
    if (current.kind === 'add') {
      onChange(project => addMeterEvent(project, current.bar, meter.numerator, meter.denominator), current.bar === 0 ? '박자표 변경' : '박자 변경 추가')
      return
    }
    const segment = segments[current.index]
    if (!segment || (segment.numerator === meter.numerator && segment.denominator === meter.denominator)) return
    onChange(project => setMeterEvent(project, current.index, meter.numerator, meter.denominator), current.index === 0 ? '박자표 변경' : '박자 변경')
  }

  return <div className="timeline-global-row meter-row" style={{ height: METER_ROW_HEIGHT }}>
    <div className="global-header"><span className="global-name">박자</span>
      <button type="button" className="corner-button" title="재생 위치 다음 마디에 박자 변경 추가" aria-label="박자 변경 추가"
        onClick={e => {
          const beat = Math.max(0, playheadBeat()), start = meters.barStart(beat)
          const bar = meters.barIndexAt(beat) + (beat - start > 1e-6 ? 1 : 0)
          const rect = e.currentTarget.getBoundingClientRect()
          openAdd(bar, rect.right + 4, rect.bottom)
          if (e.detail) e.currentTarget.blur()
        }}><Icon name="plus" size={11} /></button></div>
    <div ref={laneRef} className="global-lane meter-lane" style={{ width, ...laneStyle }}
      onDoubleClick={e => { if (e.target !== e.currentTarget) return; openAdd(barOfClient(e.clientX), e.clientX, e.currentTarget.getBoundingClientRect().bottom) }}
      onContextMenu={laneMenu}
      onPointerDown={e => { if (e.target === e.currentTarget && e.button === 0) setSelected(null) }}
      title="더블 클릭: 박자 변경 추가 · 드래그: 마디 단위 이동 · 더블 클릭(표시): 편집 · 우클릭: 메뉴 · ⌫: 삭제">
      {segments.map((segment, index) => {
        const dragged = drag?.index === index
        const beat = dragged ? drag.beat : segment.beat
        const isSelected = selected === index || dragged
        return <div key={`${index}:${segment.bar}`} className={`meter-change ${isSelected ? 'selected' : ''} ${dragged ? 'dragging' : ''}`} style={{ left: beat * ppb }}
          tabIndex={0} role="button" aria-pressed={isSelected}
          aria-label={`박자 ${label(segment)}, ${(dragged ? drag.bar : segment.bar) + 1}마디`}
          onPointerDown={e => beginEvent(e, index)}
          onDoubleClick={e => { e.stopPropagation(); const rect = e.currentTarget.getBoundingClientRect(); setEditor({ kind: 'edit', index, x: rect.left, y: rect.bottom }) }}
          onContextMenu={e => eventMenu(e, index)}
          onFocus={() => setSelected(index)}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing) return
            if ((e.key === 'Delete' || e.key === 'Backspace') && index > 0) { e.preventDefault(); e.stopPropagation(); remove(index) }
            else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); const rect = e.currentTarget.getBoundingClientRect(); setEditor({ kind: 'edit', index, x: rect.left, y: rect.bottom }) }
          }}>
          {label(segment)}
        </div>
      })}
    </div>
    {editor && <MeterEditor key={editor.kind === 'add' ? `add:${editor.bar}` : `edit:${editor.index}`} x={editor.x} y={editor.y}
      title={editor.kind === 'add' ? `${editor.bar + 1}마디 박자` : `${segments[editor.index]?.bar + 1}마디 박자`}
      initial={editor.kind === 'add' ? meters.meterAt(meters.beatAtBar(editor.bar)) : segments[editor.index] ?? project.timeSignature}
      onCommit={commitEditor} onCancel={() => setEditor(null)} />}
  </div>
}

/** Numerator/denominator popover (fixed position so the short lane never clips it). */
function MeterEditor({ x, y, title, initial, onCommit, onCancel }: { x: number; y: number; title: string; initial: TimeSignature; onCommit(meter: TimeSignature): void; onCancel(): void }) {
  const [numerator, setNumerator] = useState(String(initial.numerator))
  const [denominator, setDenominator] = useState<TimeSignatureDenominator>(initial.denominator)
  const ref = useRef<HTMLFormElement>(null)
  const latest = useRef(onCancel); latest.current = onCancel
  useEffect(() => {
    ref.current?.querySelector<HTMLInputElement>('input')?.select()
    const outside = (event: PointerEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) latest.current() }
    window.addEventListener('pointerdown', outside, true)
    return () => window.removeEventListener('pointerdown', outside, true)
  }, [])
  const value = Number(numerator)
  const valid = Number.isInteger(value) && value >= MIN_TIME_SIGNATURE_NUMERATOR && value <= MAX_TIME_SIGNATURE_NUMERATOR
  const left = Math.max(8, Math.min(x, (typeof window === 'undefined' ? 1200 : window.innerWidth) - 220))
  return <form ref={ref} className="meter-editor" role="dialog" aria-label={title} style={{ left, top: y + 4 }}
    onSubmit={e => { e.preventDefault(); if (valid) onCommit({ numerator: value, denominator }) }}
    onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() } else e.stopPropagation() }}>
    <div className="meter-editor-title">{title}</div>
    <div className="meter-editor-fields">
      <input type="number" min={MIN_TIME_SIGNATURE_NUMERATOR} max={MAX_TIME_SIGNATURE_NUMERATOR} step={1} value={numerator} aria-label="박자표 분자" aria-invalid={!valid} onChange={e => setNumerator(e.target.value)} />
      <span>/</span>
      <select value={denominator} aria-label="박자표 분모" onChange={e => setDenominator(Number(e.target.value) as TimeSignatureDenominator)}>
        {TIME_SIGNATURE_DENOMINATORS.map(value => <option key={value} value={value}>{value}</option>)}
      </select>
    </div>
    <div className="meter-editor-presets">
      {PRESETS.map(preset => <button type="button" key={label(preset)} className={preset.numerator === value && preset.denominator === denominator ? 'active' : ''}
        onClick={() => onCommit(preset)}>{label(preset)}</button>)}
    </div>
    <div className="meter-editor-actions">
      <button type="button" onClick={onCancel}>취소</button>
      <button type="submit" className="primary" disabled={!valid}>확인</button>
    </div>
  </form>
}

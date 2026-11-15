import { useRef, useState } from 'react'
import type { Project, TempoPoint } from '../core/types'
import { TEMPO_MAX, TEMPO_MIN, TempoMap, addTempoPoint, deleteTempoPoint, moveTempoPoint, normalizeTempoPoints, setTempoCurve } from '../core/tempoMap'
import { crossedDragThreshold } from '../core/input'
import type { ContextMenuItem } from './ContextMenu'
import { Icon } from './Icon'

/** Height of the 템포 global track (px); the tempo curve gets the lane minus a small margin. */
export const TEMPO_ROW_HEIGHT = 46
const PAD = 7

interface Props {
  project: Project
  width: number
  ppb: number
  laneStyle: React.CSSProperties
  /** Beat grid for point positions (the arrangement snap; ⇧ while dragging = 1/16 beat). */
  snapBeat(beat: number): number
  playheadBeat(): number
  /** One call = one undo step. */
  onChange(edit: (project: Project) => Project, label: string): void
  onSeek(beat: number): void
  openMenu(e: React.MouseEvent, items: ContextMenuItem[], label: string): void
}

interface Drag { index: number; beat: number; bpm: number }

/**
 * 템포 global track (docs/TEMPO_MAP.md, Logic's Tempo track): the tempo curve under the ruler.
 * Double-click adds a point at that position and tempo; drag moves it (beat and BPM); right-click or
 * ⌫ deletes it; the menu (or R) switches the segment after a point between step and ramp.
 */
export function TempoTrack({ project, width, ppb, laneStyle, snapBeat, playheadBeat, onChange, onSeek, openMenu }: Props) {
  const [drag, setDrag] = useState<Drag | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const laneRef = useRef<HTMLDivElement>(null)
  const committed = normalizeTempoPoints(project.bpm, project.tempoMap)
  const points: TempoPoint[] = drag ? committed.map((point, index) => index === drag.index ? { ...point, beat: drag.beat, bpm: drag.bpm } : point) : committed
  const map = new TempoMap(points[0].bpm, points)
  const lo0 = Math.min(...points.map(point => point.bpm)), hi0 = Math.max(...points.map(point => point.bpm))
  // Keep the vertical range steady while dragging so the point follows the pointer.
  const range = useRef<[number, number]>([lo0, hi0])
  if (!drag) range.current = [Math.max(TEMPO_MIN, Math.min(lo0 - 10, (lo0 + hi0) / 2 - 20)), Math.min(TEMPO_MAX, Math.max(hi0 + 10, (lo0 + hi0) / 2 + 20))]
  const [lo, hi] = range.current
  const height = TEMPO_ROW_HEIGHT - 1
  const yOf = (bpm: number) => PAD + (1 - (bpm - lo) / Math.max(1, hi - lo)) * (height - 2 * PAD)
  const bpmOfY = (y: number) => lo + (1 - (y - PAD) / Math.max(1, height - 2 * PAD)) * (hi - lo)
  const end = Math.max(project.lengthBeats, points[points.length - 1].beat + 4)

  // The curve: steps hold, ramps are sampled densely enough to show their exact (linear-in-beats) shape.
  let path = `M0 ${yOf(points[0].bpm)}`
  points.forEach((point, index) => {
    const next = points[index + 1]
    const to = next ? next.beat : end
    path += ` L${point.beat * ppb} ${yOf(point.bpm)}`
    if (next && point.curve === 'ramp') path += ` L${to * ppb} ${yOf(map.bpmAt(to - 1e-9))}`
    else path += ` L${to * ppb} ${yOf(point.bpm)}`
  })

  const format = (bpm: number) => `${+bpm.toFixed(2)}`
  const commitCurve = (index: number) => {
    const point = committed[index]
    if (!point || index === committed.length - 1) return
    onChange(project => setTempoCurve(project, index, point.curve === 'ramp' ? 'step' : 'ramp'), point.curve === 'ramp' ? '템포 계단으로 바꾸기' : '템포 램프로 바꾸기')
  }
  const remove = (index: number) => {
    if (index <= 0) return
    setSelected(null)
    onChange(project => deleteTempoPoint(project, index), '템포 포인트 삭제')
  }

  function beginPoint(e: React.PointerEvent<SVGElement>, index: number) {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    setSelected(index)
    const target = e.currentTarget, startX = e.clientX, startY = e.clientY
    const origin = committed[index]
    const perPx = (hi - lo) / Math.max(1, height - 2 * PAD)
    let started = false, current: Drag = { index, beat: origin.beat, bpm: origin.bpm }
    try { target.setPointerCapture(e.pointerId) } catch { /* window listeners still end the drag */ }
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY
      if (!started && !crossedDragThreshold(dx, dy)) return
      started = true
      const beat = index === 0 ? 0 : Math.max(1 / 960, ev.shiftKey ? Math.round((origin.beat + dx / ppb) * 16) / 16 : snapBeat(origin.beat + dx / ppb))
      const bpm = Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, Math.round((origin.bpm - dy * perPx * (ev.altKey ? 0.1 : 1)) * (ev.altKey ? 10 : 1)) / (ev.altKey ? 10 : 1)))
      current = { index, beat, bpm }
      setDrag(current)
    }
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel)
      setDrag(null)
      if (!commit) return
      if (!started) { onSeek(origin.beat); return }
      if (current.beat !== origin.beat || current.bpm !== origin.bpm) onChange(project => moveTempoPoint(project, index, current.beat, current.bpm), '템포 포인트 이동')
    }
    const up = () => finish(true), cancel = () => finish(false)
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel)
  }

  function addAt(e: React.MouseEvent<HTMLElement>) {
    const lane = laneRef.current
    if (!lane || (e.target instanceof Element && e.target.closest('.tempo-point'))) return
    const rect = lane.getBoundingClientRect()
    const beat = Math.max(0, snapBeat((e.clientX - rect.left) / ppb))
    const bpm = Math.round(Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, bpmOfY(e.clientY - rect.top))))
    onChange(project => addTempoPoint(project, beat, bpm), '템포 포인트 추가')
  }

  function pointMenu(e: React.MouseEvent, index: number) {
    setSelected(index)
    const point = committed[index]
    const items: ContextMenuItem[] = []
    if (index < committed.length - 1) items.push({ label: point.curve === 'ramp' ? '계단으로 바꾸기 (다음 포인트에서 바로 변경)' : '램프로 바꾸기 (다음 포인트까지 서서히)', icon: 'metronome', onSelect: () => commitCurve(index) })
    items.push({ label: '재생 위치로 이동', icon: 'locate', onSelect: () => onSeek(point.beat) })
    if (index > 0) items.push({ label: '템포 포인트 삭제', icon: 'trash', danger: true, onSelect: () => remove(index) })
    openMenu(e, items, '템포 포인트')
  }

  return <div className="timeline-global-row tempo-row" style={{ height: TEMPO_ROW_HEIGHT }}>
    <div className="global-header"><span className="global-name">템포</span>
      <button type="button" className="corner-button" title="재생 위치에 템포 포인트 추가" aria-label="템포 포인트 추가"
        onClick={e => { const beat = Math.max(0, snapBeat(playheadBeat())); onChange(project => addTempoPoint(project, beat, Math.round(map.bpmAt(beat))), '템포 포인트 추가'); if (e.detail) e.currentTarget.blur() }}><Icon name="plus" size={11} /></button></div>
    <div ref={laneRef} className="global-lane tempo-lane" style={{ width, ...laneStyle }} onDoubleClick={addAt}
      onPointerDown={e => { if (e.target === e.currentTarget || e.target instanceof SVGPathElement) setSelected(null) }}
      title="더블 클릭: 템포 포인트 추가 · 드래그: 위치/BPM (⇧ 미세 위치, ⌥ 0.1 BPM) · 우클릭: 램프/계단, 삭제">
      <svg className="tempo-curve" width={width} height={height} aria-hidden="true">
        <path d={path} />
      </svg>
      {points.map((point, index) => {
        const x = point.beat * ppb, y = yOf(point.bpm)
        const isSelected = selected === index || drag?.index === index
        return <div key={index} className={`tempo-point ${isSelected ? 'selected' : ''} ${point.curve === 'ramp' && index < points.length - 1 ? 'ramp' : ''}`} style={{ left: x, top: y }}
          tabIndex={0} role="button" aria-label={`템포 ${format(point.bpm)} BPM, ${+(point.beat + 1).toFixed(3)}박${point.curve === 'ramp' && index < points.length - 1 ? ', 램프' : ''}`} aria-pressed={isSelected}
          onFocus={() => setSelected(index)}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing) return
            if ((e.key === 'Delete' || e.key === 'Backspace') && index > 0) { e.preventDefault(); e.stopPropagation(); remove(index) }
            else if (e.key.toLowerCase() === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); commitCurve(index) }
          }}
          onContextMenu={e => pointMenu(e, index)}>
          <svg width="12" height="12" viewBox="-6 -6 12 12" onPointerDown={e => beginPoint(e, index)}><circle r="4" /></svg>
          <span className="tempo-label" style={{ top: y > height / 2 ? -12 : 2 }}>{format(point.bpm)}</span>
        </div>
      })}
    </div>
  </div>
}

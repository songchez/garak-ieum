import { useMemo, useRef, useState } from 'react'
import {
  AUTOMATION_MODE_LABELS, AUTOMATION_MODES, automationValue, evaluateLane, isDiscrete, laneFor, newLaneId, normalizeValue, removeLane, sortPoints,
  staticValue, targetDef, targetGroups, targetKey, parseTargetKey, updateLane,
} from '../core/automation'
import { formatParam, toNormalized } from '../core/devices'
import { dragModifiers } from '../core/input'
import type { AutomationLane, AutomationMode, AutomationPoint, AutomationTarget, Track } from '../core/types'
import { Icon } from './Icon'
import './Automation.css'

/**
 * Lanes under a track (docs/AUTOMATION.md): Logic's track automation view with Ableton-style breakpoint
 * editing. Click adds a point (and drags it), drag moves the selection, ⇧drag on empty space selects,
 * ⌥drag on a segment bends it, double-click resets (point → default value, segment → straight),
 * Delete removes the selection. Snapping follows the timeline grid (⌃/⌘ or the usual no-snap modifier: off).
 */

const PAD = 5
const VOLUME_TARGET: AutomationTarget = { kind: 'track', param: 'volume' }

export interface AutomationLanesProps {
  track: Track
  width: number
  ppb: number
  laneHeight: number
  snapBeats: number
  lengthBeats: number
  gridClass: string
  laneStyle: React.CSSProperties
  onEdit(edit: (track: Track) => Track, label: string): void
  onModeChange(mode: AutomationMode): void
  /** Seek on ⇧-click like the track lanes. */
  onSeek?(beat: number): void
  /** Return track names by id, for the 센드 lanes' labels. */
  returnNames?: ReadonlyMap<string, string>
}

export function AutomationLanes(props: AutomationLanesProps) {
  const { track } = props
  const lanes = track.automation ?? []
  // A track without lanes shows its volume lane, saved on the first point (Logic's default lane).
  const [virtualTarget, setVirtualTarget] = useState<AutomationTarget>(VOLUME_TARGET)
  const rows: { lane: AutomationLane | null; target: AutomationTarget }[] = lanes.length ? lanes.map(lane => ({ lane, target: lane.target })) : [{ lane: null, target: virtualTarget }]
  const groups = useMemo(() => targetGroups(track, undefined, props.returnNames), [track, props.returnNames])
  function addLane() {
    const used = new Set(lanes.map(lane => targetKey(lane.target)))
    const next = groups.flatMap(group => group.options).find(option => !used.has(option.key))
    if (!next) return
    props.onEdit(t => updateLane(t, next.target, lane => lane), '오토메이션 레인 추가')
  }
  return <>{rows.map((row, index) => <LaneRow key={row.lane?.id ?? 'virtual'} {...props} lane={row.lane} target={row.target} first={index === 0} groups={groups}
    onTarget={target => {
      if (!row.lane) { setVirtualTarget(target); return }
      if (laneFor(track, target)) return
      props.onEdit(t => ({ ...t, automation: t.automation?.map(lane => lane.id === row.lane!.id ? { ...lane, target, points: target.kind === row.target.kind && targetDef(t, target) && isDiscrete(targetDef(t, target)!) === isDiscrete(targetDef(t, row.target)!) ? lane.points : [] } : lane) }), '오토메이션 대상 변경')
    }}
    onAdd={addLane}/>)}</>
}

interface RowProps extends AutomationLanesProps {
  lane: AutomationLane | null
  target: AutomationTarget
  first: boolean
  groups: ReturnType<typeof targetGroups>
  onTarget(target: AutomationTarget): void
  onAdd(): void
}

type Gesture =
  | { kind: 'move'; origin: AutomationPoint[]; selected: number[]; startBeat: number; startValue: number }
  | { kind: 'curve'; segment: number; startY: number; startCurve: number; sign: number }
  | { kind: 'marquee'; startX: number; startY: number; x: number; y: number }

function LaneRow({ track, lane, target, first, groups, width, ppb, laneHeight, snapBeats, lengthBeats, gridClass, laneStyle, onEdit, onModeChange, onTarget, onAdd, onSeek }: RowProps) {
  const def = targetDef(track, target)
  const discrete = def ? isDiscrete(def) : false
  const enabled = lane?.enabled !== false
  const stored = useMemo(() => lane?.points ?? [], [lane])
  const [draft, setDraft] = useState<AutomationPoint[] | null>(null)
  const [selection, setSelection] = useState<ReadonlySet<number>>(new Set())
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const gesture = useRef<Gesture | null>(null)
  /** The point the last click added: a double-click's first click adds one, which the double-click takes back. */
  const added = useRef<{ beat: number; value: number; x: number; y: number; time: number } | null>(null)
  const points = draft ?? stored
  const h = laneHeight
  const yOf = (value: number) => PAD + (1 - value) * (h - PAD * 2)
  const valueOf = (y: number) => {
    const raw = Math.min(1, Math.max(0, 1 - (y - PAD) / (h - PAD * 2)))
    if (!def?.options) return raw
    const steps = def.options.length - 1
    return steps > 0 ? Math.round(raw * steps) / steps : 0
  }
  const format = (value: number) => def ? formatParam(def, automationValue(def, value)) : value.toFixed(2)
  const staticNormalized = def ? normalizeValue(track, target, staticValue(track, target) ?? def.default) ?? 0 : 0
  const label = groups.flatMap(group => group.options.map(option => ({ group: group.label, ...option }))).find(option => option.key === targetKey(target))

  const commit = (next: AutomationPoint[], text: string) => {
    onEdit(t => updateLane(t, target, current => ({ ...current, id: current.id || newLaneId(), points: next })), text)
  }

  const path = useMemo(() => {
    if (!points.length) return ''
    const end = Math.max(lengthBeats, points[points.length - 1].beat) * ppb
    let d = `M0 ${yOf(points[0].value).toFixed(2)} L${(points[0].beat * ppb).toFixed(2)} ${yOf(points[0].value).toFixed(2)}`
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1]
      const x0 = a.beat * ppb, x1 = b.beat * ppb
      if (discrete) { d += ` L${x1.toFixed(2)} ${yOf(a.value).toFixed(2)} L${x1.toFixed(2)} ${yOf(b.value).toFixed(2)}`; continue }
      const steps = a.curve && x1 - x0 > 4 ? Math.min(48, Math.ceil((x1 - x0) / 4)) : 1
      for (let s = 1; s <= steps; s++) {
        const beat = a.beat + (b.beat - a.beat) * s / steps
        d += ` L${(beat * ppb).toFixed(2)} ${yOf(evaluateLane([a, b], beat)!).toFixed(2)}`
      }
    }
    return `${d} L${end.toFixed(2)} ${yOf(points[points.length - 1].value).toFixed(2)}`
  }, [points, ppb, lengthBeats, discrete, h])

  const local = (event: { clientX: number; clientY: number }, element: Element) => {
    const rect = element.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }
  const snap = (beat: number, event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    const clamped = Math.max(0, Math.min(lengthBeats, beat))
    return snapBeats > 0 && !dragModifiers(event).noSnap ? Math.max(0, Math.min(lengthBeats, Math.round(clamped / snapBeats) * snapBeats)) : clamped
  }
  const hitPoint = (x: number, y: number) => {
    let best = -1, distance = 7
    points.forEach((point, index) => { const d = Math.hypot(point.beat * ppb - x, yOf(point.value) - y); if (d <= distance) { distance = d; best = index } })
    return best
  }
  const segmentAt = (x: number) => {
    const beat = x / ppb
    for (let i = 0; i < points.length - 1; i++) if (beat > points[i].beat && beat < points[i + 1].beat) return i
    return -1
  }

  function pointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !def) return
    const element = event.currentTarget
    element.focus({ preventScroll: true })
    const { x, y } = local(event, element)
    const recent = added.current
    if (recent && performance.now() - recent.time < 450 && Math.abs(recent.x - x) < 6 && Math.abs(recent.y - y) < 6) {
      // Second press of a double-click: leave it to onDoubleClick.
      event.preventDefault(); event.stopPropagation()
      return
    }
    const hit = hitPoint(x, y)
    if (event.shiftKey && hit < 0 && !event.altKey) {
      gesture.current = { kind: 'marquee', startX: x, startY: y, x, y }
      setMarquee({ x0: x, y0: y, x1: x, y1: y })
    } else if (event.altKey && hit < 0) {
      const segment = segmentAt(x)
      if (segment < 0 || discrete) return
      gesture.current = { kind: 'curve', segment, startY: y, startCurve: points[segment].curve ?? 0, sign: points[segment + 1].value >= points[segment].value ? 1 : -1 }
      setDraft(points.map(point => ({ ...point })))
    } else {
      let next = points.map(point => ({ ...point }))
      let selected: number[]
      if (hit >= 0) {
        selected = selection.has(hit) ? [...selection] : event.shiftKey ? [...selection, hit] : [hit]
      } else {
        // Click on empty space adds a point there (snapped) and keeps dragging it.
        const point: AutomationPoint = { beat: snap(x / ppb, event), value: valueOf(y) }
        added.current = { beat: point.beat, value: point.value, x, y, time: performance.now() }
        next = sortPoints([...next, point])
        selected = [next.indexOf(point)]
      }
      setSelection(new Set(selected))
      const anchor = next[selected[0]]
      gesture.current = { kind: 'move', origin: next, selected, startBeat: anchor.beat, startValue: anchor.value }
      setDraft(next)
      setTip({ x: anchor.beat * ppb, y: yOf(anchor.value), text: format(anchor.value) })
    }
    element.setPointerCapture(event.pointerId)
    element.dataset.dawGesture = 'automation'
    event.preventDefault()
    event.stopPropagation()
  }

  function pointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const active = gesture.current
    if (!active) return
    const { x, y } = local(event, event.currentTarget)
    if (active.kind === 'marquee') {
      active.x = x; active.y = y
      setMarquee({ x0: Math.min(active.startX, x), y0: Math.min(active.startY, y), x1: Math.max(active.startX, x), y1: Math.max(active.startY, y) })
      return
    }
    if (active.kind === 'curve') {
      const curve = Math.max(-1, Math.min(1, active.startCurve + active.sign * (y - active.startY) / h * 2))
      setDraft(current => (current ?? points).map((point, index) => index === active.segment ? { ...point, curve: Math.abs(curve) < 0.02 ? 0 : curve } : point))
      return
    }
    const anchorBeat = snap(x / ppb, event)
    const dBeat = anchorBeat - active.startBeat
    const dValue = valueOf(y) - active.startValue
    const moved = active.origin.map((point, index) => active.selected.includes(index)
      ? { ...point, beat: Math.max(0, Math.min(lengthBeats, point.beat + dBeat)), value: Math.min(1, Math.max(0, point.value + dValue)) } : point)
    setDraft(moved)
    const anchor = moved[active.selected[0]]
    setTip({ x: anchor.beat * ppb, y: yOf(anchor.value), text: format(anchor.value) })
  }

  function pointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const active = gesture.current
    gesture.current = null
    delete event.currentTarget.dataset.dawGesture
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setTip(null)
    if (!active) return
    if (active.kind === 'marquee') {
      setMarquee(null)
      const x0 = Math.min(active.startX, active.x), x1 = Math.max(active.startX, active.x), y0 = Math.min(active.startY, active.y), y1 = Math.max(active.startY, active.y)
      if (x1 - x0 < 2 && y1 - y0 < 2) { onSeek?.(Math.max(0, x0 / ppb)); return }
      setSelection(new Set(points.flatMap((point, index) => { const px = point.beat * ppb, py = yOf(point.value); return px >= x0 && px <= x1 && py >= y0 && py <= y1 ? [index] : [] })))
      return
    }
    const next = draft
    setDraft(null)
    if (!next) return
    const sorted = sortPoints(next)
    if (active.kind === 'move') setSelection(new Set(active.selected.map(index => sorted.indexOf(next[index]))))
    if (JSON.stringify(sorted) !== JSON.stringify(stored)) commit(sorted, active.kind === 'curve' ? '오토메이션 곡선' : '오토메이션 편집')
  }

  function doubleClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!def) return
    const { x, y } = local(event, event.currentTarget)
    const hit = hitPoint(x, y)
    const fresh = added.current && performance.now() - added.current.time < 800 ? added.current : null
    added.current = null
    const freshIndex = fresh ? stored.findIndex(point => Math.abs(point.beat - fresh.beat) < 1e-9 && Math.abs(point.value - fresh.value) < 1e-9) : -1
    if (freshIndex >= 0 && (freshIndex === hit || hit < 0)) {
      // Double-click on a segment: drop the point its first click added and straighten the segment.
      const remaining = stored.filter((_, index) => index !== freshIndex)
      const segment = remaining.findIndex((point, index) => index < remaining.length - 1 && point.beat <= fresh!.beat && remaining[index + 1].beat >= fresh!.beat)
      commit(remaining.map((point, index) => index === segment ? { beat: point.beat, value: point.value } : point), '오토메이션 곡선 초기화')
      setSelection(new Set())
    } else if (hit >= 0) commit(stored.map((point, index) => index === hit ? { ...point, value: toNormalized(def, def.default) } : point), '오토메이션 포인트 초기화')
    else { const segment = segmentAt(x); if (segment >= 0 && stored[segment]?.curve) commit(stored.map((point, index) => index === segment ? { beat: point.beat, value: point.value } : point), '오토메이션 곡선 초기화') }
  }

  function keyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if ((event.key === 'Delete' || event.key === 'Backspace') && selection.size && !event.ctrlKey && !event.metaKey) {
      event.preventDefault(); event.stopPropagation()
      commit(stored.filter((_, index) => !selection.has(index)), '오토메이션 포인트 삭제')
      setSelection(new Set())
    } else if (event.key === 'Escape' && gesture.current) {
      event.preventDefault(); event.stopPropagation()
      gesture.current = null; setDraft(null); setMarquee(null); setTip(null)
    } else if ((event.key === 'a' || event.key === 'A') && (event.ctrlKey || event.metaKey) && !event.altKey) {
      event.preventDefault(); event.stopPropagation()
      setSelection(new Set(stored.map((_, index) => index)))
    }
  }

  const mode = track.automationMode ?? 'read'
  const lastBeat = points.length ? points[points.length - 1].beat : 0
  return <div className="automation-row" data-automation-track={track.id} data-automation-target={targetKey(target)} style={{ height: h, '--track-color': track.color } as React.CSSProperties}>
    <div className="automation-header">
      <div className="automation-header-row">
        <select aria-label={`${track.name} 오토메이션 대상`} value={targetKey(target)} onChange={e => { const next = parseTargetKey(e.target.value); if (next) onTarget(next) }}>
          {!label && <option value={targetKey(target)}>{targetKey(target)}</option>}
          {groups.map(group => <optgroup key={group.label} label={group.label}>{group.options.map(option => <option key={option.key} value={option.key} disabled={option.key !== targetKey(target) && !!laneFor(track, option.target) && !!lane}>{option.label}</option>)}</optgroup>)}
        </select>
        {lane && <button className={enabled ? 'on' : ''} aria-pressed={enabled} title={enabled ? '오토메이션 끄기 (수동 값 사용)' : '오토메이션 다시 켜기'} aria-label={enabled ? '오토메이션 끄기' : '오토메이션 다시 켜기'}
          onClick={() => onEdit(t => updateLane(t, target, current => enabled ? { ...current, enabled: false } : (({ enabled: _off, ...rest }) => rest)(current)), enabled ? '오토메이션 끄기' : '오토메이션 다시 켜기')}><Icon name="power" size={10}/></button>}
        {lane && <button title="이 레인 지우기" aria-label="오토메이션 레인 지우기" onClick={() => onEdit(t => removeLane(t, lane.id), '오토메이션 지우기')}><Icon name="close" size={10}/></button>}
      </div>
      {h >= 40 && <div className="automation-header-row">
        {first && <select className="automation-mode" aria-label={`${track.name} 오토메이션 모드`} title="오토메이션 모드: 읽기 · 터치 · 래치 · 쓰기" value={mode} onChange={e => onModeChange(e.target.value as AutomationMode)}>
          {AUTOMATION_MODES.map(item => <option key={item} value={item}>{AUTOMATION_MODE_LABELS[item]}</option>)}
        </select>}
        <span className="automation-value" title="현재 정적 값">{def ? formatParam(def, staticValue(track, target) ?? def.default) : ''}</span>
        {first && <button title="오토메이션 레인 추가" aria-label="오토메이션 레인 추가" onClick={onAdd} style={{ marginLeft: 'auto' }}><Icon name="plus" size={10}/></button>}
      </div>}
    </div>
    <div className={`automation-lane ${gridClass}${enabled ? '' : ' disabled'}`} style={{ width, ...laneStyle }} tabIndex={0} role="application"
      aria-label={`${track.name} ${label?.label ?? ''} 오토메이션 · 클릭: 포인트 추가 · 드래그: 이동 · ⌥드래그: 곡선 · 더블 클릭: 초기화 · Delete: 삭제`}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onDoubleClick={doubleClick} onKeyDown={keyDown}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation() }}>
      <svg aria-hidden="true">
        {!points.length && <line className="automation-static" x1={0} x2={width} y1={yOf(staticNormalized)} y2={yOf(staticNormalized)}/>}
        {path && <path className="automation-fill" d={`${path} L${(Math.max(lengthBeats, lastBeat) * ppb).toFixed(2)} ${h} L0 ${h} Z`}/>}
        {path && <path className="automation-line" d={path}/>}
        {points.slice(0, -1).map((point, index) => <line key={`s${index}`} className="automation-segment" x1={point.beat * ppb} x2={points[index + 1].beat * ppb} y1={yOf(point.value)} y2={yOf(points[index + 1].value)}/>)}
        {points.map((point, index) => <circle key={index} className={`automation-point${selection.has(index) ? ' selected' : ''}`} cx={point.beat * ppb} cy={yOf(point.value)} r={3.5}/>)}
        {marquee && <rect className="automation-marquee" x={marquee.x0} y={marquee.y0} width={marquee.x1 - marquee.x0} height={marquee.y1 - marquee.y0}/>}
      </svg>
      {!points.length && <span className="automation-hint">{def ? '클릭해서 오토메이션 포인트 추가' : '대상이 없습니다'}</span>}
      {tip && <span className="automation-tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</span>}
    </div>
  </div>
}

import { useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent } from 'react'
import type { ControllerKey, ControllerPoint, MidiClip } from '../core/types'
import { MAX_BEND_RANGE, applyVisibleController, bendRangeOf, clampControllerValue, controllerSpec, lineController, normalizeController, thinController, visibleController } from '../core/controllers'

/**
 * One MIDI controller lane under the piano roll (docs/MIDI_CONTROLLERS.md): pitch bend, a CC, aftertouch or
 * program change, drawn as the step curve the instrument hears. Tools: 연필 (free drawing, thinned), 직선, 곡선,
 * 선택 (click/box select, drag to move, Delete to remove) and 지우개. Double-click writes the default at that
 * position (pitch bend back to center); with 선택, double-clicking a point deletes it.
 */
export type ControllerTool = 'pencil' | 'line' | 'curve' | 'select' | 'erase'
export const CONTROLLER_TOOLS: [ControllerTool, string, string][] = [
  ['pencil', '연필', '드래그로 자유롭게 그리기 (자동 감량)'],
  ['line', '직선', '드래그한 두 점 사이를 직선으로'],
  ['curve', '곡선', '드래그한 두 점 사이를 곡선으로 (Shift: 반대 곡률)'],
  ['select', '선택', '점 클릭·드래그로 선택, 끌어서 이동, Delete로 삭제'],
  ['erase', '지우개', '드래그한 구간의 점 지우기'],
]

interface ControllerLaneProps {
  clip: MidiClip
  laneKey: ControllerKey
  tool: ControllerTool
  beatWidth: number
  gridWidth: number
  gridStyle: CSSProperties
  keyWidth: number
  height: number
  snap: number
  playhead: number | null
  onChange: (clip: MidiClip) => void
  onRemove: () => void
}

const EPSILON = 1e-9
const PAD = 5
type Drag =
  | { kind: 'draw'; pointerId: number; points: ControllerPoint[] }
  | { kind: 'line'; pointerId: number; from: ControllerPoint; to: ControllerPoint; curve: number }
  | { kind: 'erase'; pointerId: number; from: number; to: number }
  | { kind: 'box'; pointerId: number; from: ControllerPoint; to: ControllerPoint; base: Set<number> }
  | { kind: 'move'; pointerId: number; origin: ControllerPoint; originals: ControllerPoint[]; indices: number[]; delta: ControllerPoint }

/** Visible events with `range` replaced by `points` (a drawn stroke, line or curve). */
export function replaceRange(events: readonly ControllerPoint[], points: readonly ControllerPoint[], from: number, to: number): ControllerPoint[] {
  return [...events.filter(event => event.beat < from - EPSILON || event.beat > to + EPSILON), ...points].sort((a, b) => a.beat - b.beat)
}

export const formatControllerValue = (key: ControllerKey, value: number, range = 2): string => {
  if (key === 'pitchBend') return `${value > 0 ? '+' : ''}${value} (${value / 8192 * range >= 0 ? '+' : ''}${(value / 8192 * range).toFixed(2)} 반음)`
  if (key === 'program') return `${value + 1}번 음색`
  return String(value)
}

export default function ControllerLane({ clip, laneKey, tool, beatWidth, gridWidth, gridStyle, keyWidth, height, snap, playhead, onChange, onRemove }: ControllerLaneProps) {
  const spec = controllerSpec(laneKey)
  const events = useMemo(() => visibleController(clip, laneKey), [clip, laneKey])
  const [draft, setDraft] = useState<ControllerPoint[] | null>(null)
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [overlay, setOverlay] = useState<Drag | null>(null)
  const drag = useRef<Drag | null>(null)
  const length = clip.lengthBeats
  const shown = draft ?? events
  const range = bendRangeOf(clip)
  // The lane's top border takes one pixel of `height`.
  const trackHeight = height - 1
  const usable = trackHeight - PAD * 2
  const y = (value: number) => PAD + (1 - (value - spec.min) / (spec.max - spec.min)) * usable
  const pointAt = (event: PointerEvent<HTMLElement> | MouseEvent<HTMLElement>, snapBeat = true): ControllerPoint => {
    const rect = event.currentTarget.getBoundingClientRect()
    let beat = Math.min(length, Math.max(0, (event.clientX - rect.left) / beatWidth))
    if (snapBeat && snap > 0 && !event.ctrlKey) beat = Math.min(length, Math.round(beat / snap) * snap)
    const ratio = 1 - (event.clientY - rect.top - PAD) / usable
    let value = clampControllerValue(laneKey, spec.min + Math.max(0, Math.min(1, ratio)) * (spec.max - spec.min))
    // Pitch bend snaps to center near the middle.
    if (laneKey === 'pitchBend' && Math.abs(value) < 160) value = 0
    return { beat, value }
  }
  const step = Math.max(1 / 64, snap > 0 ? snap / 4 : 1 / 32)
  const commit = (visible: readonly ControllerPoint[]) => {
    const next = applyVisibleController(clip, laneKey, normalizeController(laneKey, visible).filter(point => point.beat < length - EPSILON))
    if (next !== clip) onChange(next)
  }
  const hitIndex = (event: PointerEvent<HTMLElement> | MouseEvent<HTMLElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left, yy = event.clientY - rect.top
    let best = -1, distance = 7
    events.forEach((point, index) => {
      const d = Math.hypot(point.beat * beatWidth - x, y(point.value) - yy)
      if (d < distance) { best = index; distance = d }
    })
    return best
  }
  const strokePoints = (state: Extract<Drag, { kind: 'draw' }>) => {
    const sorted = [...state.points].sort((a, b) => a.beat - b.beat)
    return thinController(laneKey, sorted)
  }
  const previewOf = (state: Drag): ControllerPoint[] | null => {
    if (state.kind === 'draw') {
      const points = strokePoints(state)
      return replaceRange(events, points, points[0].beat, points[points.length - 1].beat)
    }
    if (state.kind === 'line') {
      const points = lineController(laneKey, state.from, state.to, step, state.curve)
      return replaceRange(events, points, Math.min(state.from.beat, state.to.beat), Math.max(state.from.beat, state.to.beat))
    }
    if (state.kind === 'erase') return events.filter(point => point.beat < Math.min(state.from, state.to) - EPSILON || point.beat > Math.max(state.from, state.to) + EPSILON)
    if (state.kind === 'move') {
      const moving = new Set(state.indices)
      return [...events.filter((_, index) => !moving.has(index)), ...state.originals.map(point => ({
        beat: Math.min(length - 1 / 960, Math.max(0, point.beat + state.delta.beat)), value: clampControllerValue(laneKey, point.value + state.delta.value),
      }))].sort((a, b) => a.beat - b.beat)
    }
    return null
  }

  // The step curve the instrument hears: a reset lane starts at its default, a hold lane at its first value.
  const initial = spec.reset ? spec.default : shown[0]?.value ?? spec.default
  let path = `M0 ${y(initial)}`
  for (const point of shown) path += ` H${point.beat * beatWidth} V${y(point.value)}`
  path += ` H${length * beatWidth}`

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.key === 'Delete' || event.key === 'Backspace') && selected.size) {
      event.preventDefault(); event.stopPropagation()
      commit(events.filter((_, index) => !selected.has(index)))
      setSelected(new Set())
    } else if (event.key === 'Escape' && selected.size) { event.stopPropagation(); setSelected(new Set()) }
    else if ((event.key === 'a' || event.key === 'A') && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); setSelected(new Set(events.map((_, index) => index))) }
  }

  return <div className="piano-controller-lane" style={{ height }}>
    <div className="piano-velocity-corner piano-controller-corner" style={{ width: keyWidth }} title={`${spec.label} 레인`}>
      <span className="piano-controller-name">{spec.short}</span>
      {laneKey === 'pitchBend' && <select className="piano-controller-range" value={range} aria-label="피치 벤드 범위(반음)" title="내장 악기의 피치 벤드 범위(반음). 이음웨이브·VST3는 악기 설정을 따릅니다."
        onChange={event => { const value = Number(event.currentTarget.value); const { bendRange: _range, ...rest } = clip; onChange(value === 2 ? rest : { ...rest, bendRange: value }) }}>
        {[1, 2, 3, 4, 5, 7, 12, 24, MAX_BEND_RANGE].map(value => <option key={value} value={value}>±{value}</option>)}
      </select>}
      <button type="button" className="piano-controller-remove" onClick={onRemove} title={`${spec.label} 레인 숨기기 (데이터는 유지)`} aria-label={`${spec.label} 레인 숨기기`}>×</button>
    </div>
    <div className={`piano-controller-track piano-controller-track--${tool}`} style={{ width: gridWidth, ...gridStyle }} tabIndex={0}
      role="group" aria-label={`${spec.label} 레인: ${CONTROLLER_TOOLS.find(([id]) => id === tool)?.[2] ?? ''}. 더블 클릭: 그 위치를 기본값${laneKey === 'pitchBend' ? '(가운데)' : ''}으로, 선택 도구에서는 점 삭제.`}
      onKeyDown={onKeyDown}
      onPointerDown={event => {
        if (event.button !== 0) return
        event.stopPropagation()
        // The second press of a double-click belongs to onDoubleClick.
        if (event.detail >= 2) return
        event.currentTarget.focus({ preventScroll: true })
        const point = pointAt(event)
        let state: Drag
        if (tool === 'select') {
          const hit = hitIndex(event)
          if (hit >= 0) {
            const indices = selected.has(hit) ? [...selected] : [hit]
            if (!selected.has(hit)) setSelected(new Set([hit]))
            state = { kind: 'move', pointerId: event.pointerId, origin: pointAt(event, false), originals: indices.map(index => events[index]), indices, delta: { beat: 0, value: 0 } }
          } else state = { kind: 'box', pointerId: event.pointerId, from: pointAt(event, false), to: pointAt(event, false), base: event.shiftKey ? new Set(selected) : new Set() }
        } else if (tool === 'erase') state = { kind: 'erase', pointerId: event.pointerId, from: point.beat, to: point.beat }
        else if (tool === 'line' || tool === 'curve') state = { kind: 'line', pointerId: event.pointerId, from: point, to: point, curve: tool === 'curve' ? (event.shiftKey ? -.6 : .6) : 0 }
        else state = { kind: 'draw', pointerId: event.pointerId, points: [point] }
        drag.current = state
        event.currentTarget.setPointerCapture?.(event.pointerId)
        setDraft(previewOf(state)); setOverlay(state)
      }}
      onPointerMove={event => {
        const state = drag.current
        if (!state || state.pointerId !== event.pointerId) return
        const point = pointAt(event, state.kind !== 'draw' && state.kind !== 'box')
        if (state.kind === 'draw') state.points.push(pointAt(event, false))
        else if (state.kind === 'line') state.to = point
        else if (state.kind === 'erase') state.to = point.beat
        else if (state.kind === 'box') state.to = pointAt(event, false)
        else {
          const raw = pointAt(event, false)
          let beat = raw.beat - state.origin.beat
          if (snap > 0 && !event.ctrlKey) beat = Math.round(beat / snap) * snap
          state.delta = event.shiftKey ? { beat: 0, value: raw.value - state.origin.value } : { beat, value: raw.value - state.origin.value }
        }
        setDraft(previewOf(state)); setOverlay({ ...state })
      }}
      onPointerUp={event => {
        const state = drag.current
        if (!state || state.pointerId !== event.pointerId) return
        drag.current = null
        const preview = previewOf(state)
        setDraft(null); setOverlay(null)
        if (state.kind === 'box') {
          const [b0, b1] = [Math.min(state.from.beat, state.to.beat), Math.max(state.from.beat, state.to.beat)]
          const [v0, v1] = [Math.min(state.from.value, state.to.value), Math.max(state.from.value, state.to.value)]
          const picked = new Set(state.base)
          events.forEach((point, index) => { if (point.beat >= b0 - EPSILON && point.beat <= b1 + EPSILON && point.value >= v0 && point.value <= v1) picked.add(index) })
          setSelected(picked)
          return
        }
        if (state.kind === 'move') setSelected(new Set())
        if (preview) commit(preview)
      }}
      onPointerCancel={() => { drag.current = null; setDraft(null); setOverlay(null) }}
      onDoubleClick={event => {
        event.stopPropagation()
        const hit = tool === 'select' ? hitIndex(event) : -1
        if (hit >= 0) { commit(events.filter((_, index) => index !== hit)); setSelected(new Set()); return }
        const { beat } = pointAt(event)
        // Also replaces what the double-click's first press just wrote (within two pixels).
        const slack = 2 / beatWidth
        commit(replaceRange(events, [{ beat, value: spec.default }], beat - slack, beat + slack))
      }}
    >
      <svg className="piano-controller-svg" width={gridWidth} height={trackHeight} aria-hidden="true">
        {laneKey === 'pitchBend' && <line className="piano-controller-center" x1={0} x2={gridWidth} y1={y(0)} y2={y(0)} />}
        {path && <path className="piano-controller-fill" d={`${path} V${laneKey === 'pitchBend' ? y(0) : trackHeight} H0 Z`} />}
        {path && <path className="piano-controller-line" d={path} />}
        {shown.map((point, index) => <circle key={`${point.beat}-${index}`} className={`piano-controller-point${!draft && selected.has(index) ? ' piano-controller-point--selected' : ''}`} cx={point.beat * beatWidth} cy={y(point.value)} r={!draft && selected.has(index) ? 3.5 : 2.5} />)}
        {overlay?.kind === 'box' && <rect className="piano-controller-box" x={Math.min(overlay.from.beat, overlay.to.beat) * beatWidth} width={Math.abs(overlay.to.beat - overlay.from.beat) * beatWidth}
          y={Math.min(y(overlay.from.value), y(overlay.to.value))} height={Math.abs(y(overlay.from.value) - y(overlay.to.value))} />}
        {overlay?.kind === 'erase' && <rect className="piano-controller-erase" x={Math.min(overlay.from, overlay.to) * beatWidth} width={Math.abs(overlay.to - overlay.from) * beatWidth} y={0} height={height} />}
      </svg>
      {shown.length > 0 && <span className="piano-controller-readout" aria-hidden="true">{formatControllerValue(laneKey, (draft ? shown : events).reduce((value, point) => playhead !== null && point.beat <= playhead ? point.value : value, (draft ? shown : events)[0].value), range)}</span>}
      {playhead !== null && <div className="piano-playhead" style={{ left: playhead * beatWidth }} aria-hidden="true" />}
    </div>
  </div>
}

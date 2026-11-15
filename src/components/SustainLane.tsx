import { useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent, PointerEvent } from 'react'
import type { MidiClip } from '../core/types'
import { applyVisibleSustain, spansToSustain, sustainSpans, visibleSustain } from '../core/sustain'

/**
 * Sustain pedal (CC64) lane under the piano roll notes (docs/SUSTAIN_PEDAL.md). Pedal-down spans are bars.
 * Drag on empty lane draws a span, drag starting on a span erases that range, double-click toggles: inside a
 * span removes it, on empty lane adds one up to the next bar line (or the next span).
 */
interface SustainLaneProps {
  clip: MidiClip
  beatWidth: number
  gridWidth: number
  gridStyle: CSSProperties
  keyWidth: number
  height: number
  snap: number
  beatsPerBar: number
  playhead: number | null
  onChange: (clip: MidiClip) => void
}

type Span = [number, number]
const EPSILON = 1e-9

export function addSpan(spans: readonly Span[], range: Span): Span[] {
  return [...spans, range].sort((a, b) => a[0] - b[0]).reduce<Span[]>((merged, span) => {
    const last = merged[merged.length - 1]
    if (last && span[0] <= last[1] + EPSILON) last[1] = Math.max(last[1], span[1])
    else merged.push([span[0], span[1]])
    return merged
  }, [])
}
export function removeRange(spans: readonly Span[], [from, to]: Span): Span[] {
  return spans.flatMap(([start, end]): Span[] => {
    if (end <= from + EPSILON || start >= to - EPSILON) return [[start, end]]
    return [...(start < from - EPSILON ? [[start, from] as Span] : []), ...(end > to + EPSILON ? [[to, end] as Span] : [])]
  })
}

export default function SustainLane({ clip, beatWidth, gridWidth, gridStyle, keyWidth, height, snap, beatsPerBar, playhead, onChange }: SustainLaneProps) {
  const spans = useMemo(() => sustainSpans(visibleSustain(clip), 0, clip.lengthBeats), [clip])
  const [draft, setDraft] = useState<Span[] | null>(null)
  const drag = useRef<{ pointerId: number; origin: number; originX: number; erase: boolean; moved: boolean } | null>(null)
  const shown = draft ?? spans
  const length = clip.lengthBeats

  const beatAt = (event: PointerEvent<HTMLElement> | MouseEvent<HTMLElement>, round = true): number => {
    const rect = event.currentTarget.getBoundingClientRect()
    const beat = Math.min(length, Math.max(0, (event.clientX - rect.left) / beatWidth))
    if (!round || !(snap > 0) || event.ctrlKey) return beat
    return Math.min(length, Math.round(beat / snap) * snap)
  }
  const inside = (beat: number) => spans.find(([start, end]) => start <= beat + EPSILON && beat < end - EPSILON)
  const commit = (next: Span[]) => {
    const updated = applyVisibleSustain(clip, spansToSustain(next.filter(([s, e]) => e - s > EPSILON)))
    if (updated !== clip) onChange(updated)
  }
  const preview = (event: PointerEvent<HTMLElement>, state: NonNullable<typeof drag.current>): Span[] => {
    const beat = beatAt(event)
    const range: Span = [Math.min(state.origin, beat), Math.max(state.origin, beat)]
    return state.erase ? removeRange(spans, range) : addSpan(spans, range)
  }

  return <div className="piano-sustain-lane" style={{ height }}>
    <div className="piano-velocity-corner piano-sustain-corner" style={{ width: keyWidth }} title="서스테인 페달(CC64). 페달을 밟은 동안 손을 뗀 음도 페달을 뗄 때까지 울립니다.">SUSTAIN</div>
    <div className="piano-sustain-track" style={{ width: gridWidth, ...gridStyle }}
      role="group" aria-label="서스테인 페달 레인: 빈 곳을 드래그하면 페달 구간을 그리고, 구간에서 시작해 드래그하면 지웁니다. 더블 클릭으로 구간을 켜고 끕니다."
      onPointerDown={event => {
        if (event.button !== 0) return
        const origin = beatAt(event)
        drag.current = { pointerId: event.pointerId, origin, originX: event.clientX, erase: !!inside(beatAt(event, false)), moved: false }
        event.currentTarget.setPointerCapture?.(event.pointerId)
        event.stopPropagation()
      }}
      onPointerMove={event => {
        const state = drag.current
        if (!state || state.pointerId !== event.pointerId) return
        if (!state.moved && Math.abs(event.clientX - state.originX) < 3) return
        state.moved = true
        setDraft(preview(event, state))
      }}
      onPointerUp={event => {
        const state = drag.current
        if (!state || state.pointerId !== event.pointerId) return
        drag.current = null
        const next = state.moved ? preview(event, state) : null
        setDraft(null)
        if (next) commit(next)
      }}
      onPointerCancel={() => { drag.current = null; setDraft(null) }}
      onDoubleClick={event => {
        event.stopPropagation()
        const beat = beatAt(event, false)
        const hit = inside(beat)
        if (hit) { commit(spans.filter(span => span !== hit)); return }
        const start = beatAt(event)
        const nextBar = (Math.floor(start / beatsPerBar + EPSILON) + 1) * beatsPerBar
        const nextSpan = spans.find(([s]) => s > start + EPSILON)?.[0] ?? Infinity
        const end = Math.min(length, nextBar, nextSpan)
        if (end - start > EPSILON) commit(addSpan(spans, [start, end]))
      }}
    >
      {shown.map(([start, end]) => <span key={`${start}-${end}`} className={`piano-sustain-span${draft ? ' piano-sustain-span--draft' : ''}`}
        style={{ left: start * beatWidth, width: Math.max(2, (end - start) * beatWidth) }}
        title={`페달 ${Number((start + 1).toFixed(3))}박 ~ ${Number((end + 1).toFixed(3))}박 · 더블 클릭으로 삭제 · 드래그로 일부 지우기`}>
        {(end - start) * beatWidth > 30 && <span className="piano-sustain-label" aria-hidden="true">Ped.</span>}
      </span>)}
      {playhead !== null && <div className="piano-playhead" style={{ left: playhead * beatWidth }} aria-hidden="true" />}
    </div>
  </div>
}

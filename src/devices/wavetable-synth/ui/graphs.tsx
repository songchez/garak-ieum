import { useEffect, useId, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { useHistoryGesture } from '../../../core/historyGesture'
import { clamp } from './controls'

function samplesPath(samples: readonly number[], width: number, height: number, bipolar = true, padding = 12) {
  const innerW = width - padding * 2, innerH = height - padding * 2
  return samples.map((sample, index) => {
    const y = bipolar ? (clamp(sample, -1, 1) + 1) / 2 : clamp(sample)
    return `${index ? 'L' : 'M'}${(padding + index / Math.max(1, samples.length - 1) * innerW).toFixed(2)},${(height - padding - y * innerH).toFixed(2)}`
  }).join('')
}
export function WavePlot({ samples, ghosts = [], label, compact = false }: { samples: readonly number[]; ghosts?: readonly (readonly number[])[]; label: string; compact?: boolean }) {
  const id = useId(), width = 420, height = compact ? 88 : 144
  const path = samplesPath(samples, width, height)
  return <svg className={`iw-wave-plot${compact ? ' is-compact' : ''}`} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} preserveAspectRatio="none">
    <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".14"/><stop offset="1" stopColor="currentColor" stopOpacity="0"/></linearGradient></defs>
    <path className="iw-graph-grid" d={`${[.25, .5, .75].map(t => `M${12 + 396 * t} 12V${height - 12}`).join('')}${[.25, .5, .75].map(t => `M12 ${12 + (height - 24) * t}H408`).join('')}`}/>
    {ghosts.map((frame, index) => <path key={index} className="iw-wave-ghost" d={samplesPath(frame, width, height)}/>) }
    {samples.length > 1 && <><path d={`${path}L408,${height - 12}L12,${height - 12}Z`} fill={`url(#${id})`}/><path className="iw-wave-line" d={path}/></>}
  </svg>
}

interface CurveEditorProps {
  values: readonly number[]
  label: string
  onChange: (values: number[]) => void
  bipolar?: boolean
  commitOnEnd?: boolean
  large?: boolean
}
export function CurveEditor({ values, label, onChange, bipolar = false, commitOnEnd = false, large = false }: CurveEditorProps) {
  const svgRef = useRef<SVGSVGElement>(null), finishRef = useRef<(() => void) | null>(null)
  const latest = useRef({ values, onChange }); latest.current = { values, onChange }
  const [draft, setDraft] = useState<number[] | null>(null), [selected, setSelected] = useState(0)
  const gesture = useHistoryGesture(`${label} 그리기`), history = useRef(gesture); history.current = gesture
  const shown = draft ?? values, width = 600, height = large ? 220 : 150
  useEffect(() => () => finishRef.current?.(), [])
  function begin(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return
    event.preventDefault(); event.stopPropagation(); finishRef.current?.()
    const svg = event.currentTarget, pointerId = event.pointerId, initial = [...latest.current.values]
    if (initial.length < 2) return
    let next = [...initial], previousIndex: number | undefined, previousValue = 0, active = true
    history.current.begin(); svg.dataset.dawGesture = 'wavetable-curve'
    const paint = (x: number, y: number) => {
      const bounds = svg.getBoundingClientRect(), xn = clamp((x - bounds.left) / bounds.width), yn = 1 - clamp((y - bounds.top) / bounds.height)
      const index = Math.round(xn * (next.length - 1)), value = bipolar ? yn * 2 - 1 : yn
      if (previousIndex !== undefined && previousIndex !== index) {
        const lo = Math.min(index, previousIndex), hi = Math.max(index, previousIndex)
        for (let i = lo; i <= hi; i++) next[i] = previousValue + (value - previousValue) * (i - previousIndex) / (index - previousIndex)
      }
      next[index] = value; previousIndex = index; previousValue = value
      setSelected(index); setDraft([...next]); if (!commitOnEnd) latest.current.onChange([...next])
    }
    const finish = (restore: boolean) => {
      if (!active) return
      active = false; finishRef.current = null; delete svg.dataset.dawGesture
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', escape, true); window.removeEventListener('blur', blur); svg.removeEventListener('lostpointercapture', lost)
      if (svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId)
      if (restore) { if (!commitOnEnd) latest.current.onChange(initial); history.current.cancel() }
      else { if (commitOnEnd) latest.current.onChange([...next]); history.current.end() }
      setDraft(null)
    }
    const move = (e: globalThis.PointerEvent) => { if (active && e.pointerId === pointerId) paint(e.clientX, e.clientY) }
    const up = (e: globalThis.PointerEvent) => { if (e.pointerId === pointerId) finish(false) }
    const cancel = (e: globalThis.PointerEvent) => { if (e.pointerId === pointerId) finish(true) }
    const escape = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(true) } }
    const lost = () => finish(false), blur = () => finish(false)
    finishRef.current = () => finish(false)
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', escape, true); window.addEventListener('blur', blur); svg.addEventListener('lostpointercapture', lost)
    try { svg.setPointerCapture(pointerId) } catch { /* Window pointer listeners remain active. */ }
    paint(event.clientX, event.clientY)
  }
  const index = Math.min(selected, Math.max(0, shown.length - 1))
  const sampleValue = shown[index] ?? 0
  const sampleX = index / Math.max(1, shown.length - 1) * width
  const sampleY = (1 - (bipolar ? (sampleValue + 1) / 2 : sampleValue)) * height
  return <div className={`iw-curve-editor${large ? ' is-large' : ''}`}>
    <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${label}. 그래프를 드래그해 그리거나 아래 선택점 값을 조절하세요.`} onPointerDown={begin}>
      <path className="iw-graph-grid" d={`${Array.from({ length: 7 }, (_, i) => `M${(i + 1) * width / 8} 0V${height}`).join('')}${[.25, .5, .75].map(t => `M0 ${height * t}H${width}`).join('')}`}/>
      <path className="iw-curve-fill" d={`${samplesPath(shown, width, height, bipolar, 0)}L${width},${height}L0,${height}Z`}/><path className="iw-wave-line" d={samplesPath(shown, width, height, bipolar, 0)}/>
      <line className="iw-curve-cursor" x1={sampleX} x2={sampleX} y1={0} y2={height}/><circle className="iw-curve-point" cx={sampleX} cy={sampleY} r={3.5}/>
    </svg>
    <div className="iw-curve-access"><label>선택점<input aria-label={`${label} 선택점`} type="number" min={1} max={shown.length} step={1} value={index + 1} onChange={event => setSelected(clamp(Math.round(Number(event.target.value)) - 1, 0, shown.length - 1))}/><span>/ {shown.length}</span></label><label>값<input aria-label={`${label} 선택점 값`} type="number" min={bipolar ? -1 : 0} max={1} step={.01} value={Number(sampleValue.toFixed(3))} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value)) { const next = [...values]; next[index] = clamp(value, bipolar ? -1 : 0, 1); onChange(next) } }}/></label><span className="iw-curve-hint">드래그로 그리기 · Esc 취소</span></div>
  </div>
}

export function EnvelopePlot({ attack, hold, decay, sustain, release }: { attack: number; hold: number; decay: number; sustain: number; release: number }) {
  // Stage lengths come from the patch; the note's sustained duration is illustrative.
  const width = 420, height = 118, padding = 12, heldNote = Math.max(.1, (attack + hold + decay + release) * .28)
  const total = Math.max(.001, attack + hold + decay + heldNote + release)
  const x = (t: number) => padding + t / total * (width - padding * 2), y = (v: number) => height - padding - clamp(v) * (height - padding * 2)
  const points = [[0, 0], [attack, 1], [attack + hold, 1], [attack + hold + decay, sustain], [attack + hold + decay + heldNote, sustain], [total, 0]]
  const d = points.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t)} ${y(v)}`).join('')
  return <svg className="iw-envelope-plot" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`AHDSR 단계: 어택 ${attack.toFixed(3)}초, 홀드 ${hold.toFixed(3)}초, 디케이 ${decay.toFixed(3)}초, 서스테인 ${Math.round(sustain * 100)}퍼센트, 릴리즈 ${release.toFixed(3)}초. 노트를 누르고 있는 길이는 설명용입니다.`}>
    <path className="iw-graph-grid" d={`M12 ${height / 2}H408M${x(attack + hold + decay + heldNote)} 12V106`}/><path className="iw-curve-fill" d={`${d}Z`}/><path className="iw-wave-line" d={d}/>{points.slice(1, 5).map(([t, v], i) => <circle className="iw-curve-point" key={i} cx={x(t)} cy={y(v)} r={3}/>) }
    <text className="iw-graph-caption" x={x(attack + hold + decay + heldNote) - 4} y={height - 2} textAnchor="end">NOTE OFF</text>
  </svg>
}

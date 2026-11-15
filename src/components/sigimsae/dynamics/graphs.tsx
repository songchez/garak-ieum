import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { formatParam, fromNormalized, toNormalized, type ParamDef } from '../../../core/devices'
import { useHistoryGesture } from '../../../core/historyGesture'
import {
  clamp, compressorOutput, dbToX, dbToY, FLOOR_DB, GATE_HYSTERESIS_DB, gateEnvelope, gateOutput, gridLines,
  limiterOutput, ratioThrough, segmentToNormalized, transferPath, vuStep, xToDb, yToDb, type DbScale, type MeterFrame,
} from './curve'
import type { DynamicsFeed } from './feed'

export type DynamicsKind = 'compressor' | 'limiter' | 'gate'
export interface ParamAccess {
  defs: readonly ParamDef[]
  value(id: string): number
  onParam(id: string, value: number): void
  onParams(params: Record<string, number>): void
}
export const defOf = (defs: readonly ParamDef[], id: string) => defs.find(d => d.id === id)!
const within = (def: ParamDef, v: number) => clamp(v, def.min, def.max)
const round = (v: number, step: number) => Math.round(v / step) * step

/** Level range shown by each device (input and output axes share it). */
export function scaleFor(kind: DynamicsKind): DbScale {
  return kind === 'gate' ? { min: -84, max: 0 } : kind === 'limiter' ? { min: -42, max: 6 } : { min: -60, max: 6 }
}

/** Output level for a measured frame (what the device actually sent out). */
export function outputDb(kind: DynamicsKind, frame: MeterFrame, p: ParamAccess): number {
  if (frame.inputDb <= FLOOR_DB + 1) return FLOOR_DB
  if (kind === 'compressor') return frame.inputDb - frame.reductionDb + p.value('makeup')
  if (kind === 'limiter') return Math.min(p.value('ceiling'), frame.inputDb + p.value('gain') - frame.reductionDb)
  return frame.inputDb - frame.reductionDb
}

/** Static curve of the device with its current parameters. */
export function staticCurve(kind: DynamicsKind, p: ParamAccess, open = false): (inputDb: number) => number {
  if (kind === 'compressor') { const t = p.value('threshold'), r = p.value('ratio'), m = p.value('makeup'); return x => compressorOutput(x, t, r, m) }
  if (kind === 'limiter') { const g = p.value('gain'), c = p.value('ceiling'); return x => limiterOutput(x, g, c) }
  const t = p.value('threshold'); return x => gateOutput(x, t, open)
}

/** Pointer capture with a cleanup that also runs on unmount; one undo step per drag. */
function useDrag(label: string) {
  const gesture = useHistoryGesture(label)
  const cancel = useRef<(() => void) | null>(null)
  useEffect(() => () => cancel.current?.(), [])
  return useCallback((event: React.PointerEvent<Element>, move: (e: PointerEvent, start: { x: number; y: number }) => void, done?: () => void) => {
    if (event.button !== 0) return
    event.preventDefault(); event.stopPropagation()
    cancel.current?.()
    const target = event.currentTarget as Element & { dataset?: DOMStringMap }
    const pointerId = event.pointerId, start = { x: event.clientX, y: event.clientY }
    try { target.setPointerCapture(pointerId) } catch { /* jsdom */ }
    if (target instanceof HTMLElement || target instanceof SVGElement) target.dataset.dawGesture = 'dynamics'
    gesture.begin()
    const onMove = (e: PointerEvent) => { if (e.pointerId === pointerId) move(e, start) }
    const finish = () => {
      window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp)
      if (target instanceof HTMLElement || target instanceof SVGElement) delete target.dataset.dawGesture
      cancel.current = null; gesture.end(); done?.()
    }
    const onUp = (e: PointerEvent) => { if (e.pointerId === pointerId) finish() }
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); window.addEventListener('pointercancel', onUp)
    cancel.current = finish
  }, [gesture])
}

/** Arrow/Page/Home/End handling for a dB-ish slider. Returns the new value or null. */
export function keyStep(event: React.KeyboardEvent, def: ParamDef, value: number, fine: number, coarse: number, log = false): number | null {
  const step = event.shiftKey ? fine : coarse
  let next: number | null = null
  if (log || def.scale === 'log') {
    const n = toNormalized(def, value), s = event.shiftKey ? 0.004 : 0.03
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') next = fromNormalized(def, n + s)
    else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') next = fromNormalized(def, n - s)
    else if (event.key === 'PageUp') next = fromNormalized(def, n + 0.15)
    else if (event.key === 'PageDown') next = fromNormalized(def, n - 0.15)
  } else {
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') next = value + step
    else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') next = value - step
    else if (event.key === 'PageUp') next = value + step * 6
    else if (event.key === 'PageDown') next = value - step * 6
  }
  if (event.key === 'Home') next = def.min
  else if (event.key === 'End') next = def.max
  if (next === null) return null
  event.preventDefault()
  return within(def, next)
}

interface TransferProps extends ParamAccess {
  kind: DynamicsKind
  feed: DynamicsFeed
  /** CSS pixels of the square plot. */
  size: number
  /** Short labels and fewer grid lines (rack card). */
  compact?: boolean
  name: string
}

/**
 * Input → output transfer curve. Compressor: drag the knee (threshold), drag the curve above it
 * (ratio: the curve follows the pointer). Limiter: the knee handle moves ceiling (y) and input
 * gain (x). Gate: drag the threshold. A live dot shows the current input and output level.
 */
export function TransferGraph(props: TransferProps) {
  const { kind, feed, size, compact, defs, value, onParams, name } = props
  const scale = scaleFor(kind)
  const svgRef = useRef<SVGSVGElement>(null)
  const dotRef = useRef<SVGCircleElement>(null)
  const guideRef = useRef<SVGPathElement>(null)
  const drag = useDrag(`${name} 그래프 조절`)
  const clipId = useId()
  const latest = useRef(props); latest.current = props
  const [gateOpen, setGateOpen] = useState(false)

  const X = (db: number) => dbToX(db, scale, size)
  const Y = (db: number) => dbToY(db, scale, size)
  const curve = staticCurve(kind, props, gateOpen)

  // Live dot without React renders.
  useEffect(() => feed.subscribe(frame => {
    const dot = dotRef.current, guide = guideRef.current
    if (!dot || !guide) return
    const p = latest.current
    const out = outputDb(p.kind, frame, p)
    const visible = frame.inputDb > scale.min - 1
    dot.style.opacity = visible ? '1' : '0'
    guide.style.opacity = visible ? '1' : '0'
    if (!visible) return
    const x = dbToX(frame.inputDb, scale, p.size), y = dbToY(Math.max(out, scale.min), scale, p.size)
    dot.setAttribute('cx', x.toFixed(1)); dot.setAttribute('cy', y.toFixed(1))
    guide.setAttribute('d', `M${x.toFixed(1)} ${p.size}V${y.toFixed(1)}H0`)
    if (p.kind === 'gate') { const open = frame.reductionDb < 20; setGateOpen(prev => prev === open ? prev : open) }
  }), [feed, scale.min, scale.max])

  const local = (e: PointerEvent | React.PointerEvent) => {
    const box = svgRef.current!.getBoundingClientRect()
    return { x: (e.clientX - box.left) * size / box.width, y: (e.clientY - box.top) * size / box.height }
  }

  let knee: { x: number; y: number }
  let kneeLabel = '', kneeDef: ParamDef, kneeValue: number
  if (kind === 'limiter') {
    const c = value('ceiling'), g = value('gain')
    knee = { x: X(c - g), y: Y(c) }; kneeDef = defOf(defs, 'ceiling'); kneeValue = c
    kneeLabel = `실링 ${formatParam(kneeDef, c)}, 입력 게인 ${formatParam(defOf(defs, 'gain'), g)}`
  } else {
    const t = value('threshold')
    knee = { x: X(t), y: Y(curve(t)) }; kneeDef = defOf(defs, 'threshold'); kneeValue = t
    kneeLabel = `스레숄드 ${formatParam(kneeDef, t)}`
  }

  const pointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return
    if (event.altKey) { // Alt+click: defaults, like the knobs.
      event.preventDefault()
      const reset: Record<string, number> = {}
      for (const id of kind === 'limiter' ? ['ceiling', 'gain'] : kind === 'compressor' ? ['threshold', 'ratio'] : ['threshold']) reset[id] = defOf(defs, id).default
      onParams(reset); return
    }
    const start = local(event)
    const nearKnee = Math.hypot(start.x - knee.x, start.y - knee.y) < (compact ? 14 : 18)
    const p0 = latest.current
    const fine = (e: PointerEvent) => e.shiftKey ? 0.2 : 1
    const perPx = (scale.max - scale.min) / size
    if (kind === 'compressor' && !nearKnee && start.x > knee.x + 4) {
      // Ratio: the curve passes through the pointer.
      const tDef = defOf(defs, 'ratio')
      drag(event, e => {
        const p = latest.current, at = local(e)
        const r = ratioThrough(xToDb(at.x, scale, size), yToDb(at.y, scale, size), p.value('threshold'), p.value('makeup'), p.value('ratio'), tDef.min, tDef.max)
        p.onParams({ ratio: round(r, r < 4 ? 0.05 : 0.1) })
      })
      return
    }
    if (kind === 'limiter') {
      const c0 = p0.value('ceiling'), g0 = p0.value('gain'), cDef = defOf(defs, 'ceiling'), gDef = defOf(defs, 'gain')
      drag(event, (e, s) => {
        const k = fine(e) * perPx * size / svgRef.current!.getBoundingClientRect().width
        const ceiling = within(cDef, round(c0 - (e.clientY - s.y) * k, 0.1))
        // Moving the knee right means less input gain (the curve shifts right).
        const gain = within(gDef, round(g0 - (e.clientX - s.x) * k + (ceiling - c0), 0.1))
        latest.current.onParams({ ceiling, gain })
      })
      return
    }
    const tDef = defOf(defs, 'threshold'), t0 = p0.value('threshold')
    drag(event, (e, s) => {
      const k = fine(e) * perPx * size / svgRef.current!.getBoundingClientRect().width
      latest.current.onParams({ threshold: within(tDef, round(t0 + (e.clientX - s.x) * k, 0.1)) })
    })
  }

  const kneeKey = (event: React.KeyboardEvent) => {
    if (kind === 'limiter') {
      const cDef = defOf(defs, 'ceiling'), gDef = defOf(defs, 'gain')
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        const step = (event.shiftKey ? 0.1 : 1) * (event.key === 'ArrowRight' ? -1 : 1)
        onParams({ gain: within(gDef, round(value('gain') + step, 0.1)) }); return
      }
      const next = keyStep(event, cDef, value('ceiling'), 0.1, 0.5)
      if (next !== null) onParams({ ceiling: round(next, 0.1) })
      return
    }
    const next = keyStep(event, kneeDef, kneeValue, 0.1, 1)
    if (next !== null) onParams({ threshold: round(next, 0.1) })
  }

  const ratioDef = kind === 'compressor' ? defOf(defs, 'ratio') : null
  const ratioKey = (event: React.KeyboardEvent) => {
    if (!ratioDef) return
    const next = keyStep(event, ratioDef, value('ratio'), 0, 0, true)
    if (next !== null) onParams({ ratio: round(next, 0.05) })
  }
  const ratioEnd = kind === 'compressor' ? { x: X(scale.max), y: Y(curve(scale.max)) } : null
  const lines = gridLines(scale, compact ? (kind === 'gate' ? 24 : 18) : undefined)
  const threshold = kind === 'limiter' ? value('ceiling') : value('threshold')

  return (
    <svg ref={svgRef} className={`dyn-transfer${compact ? ' is-compact' : ''}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      role="group" aria-label={`${name} 입출력 곡선`} onPointerDown={pointerDown} data-kind={kind}>
      <defs><clipPath id={clipId}><rect width={size} height={size} rx={compact ? 4 : 6}/></clipPath></defs>
      <g clipPath={`url(#${clipId})`}>
        <rect className="dyn-plot-bg" width={size} height={size}/>
        {kind === 'gate' && <>
          <rect className="dyn-gate-closed" x={0} y={0} width={X(threshold - GATE_HYSTERESIS_DB)} height={size}/>
          <rect className="dyn-gate-band" x={X(threshold - GATE_HYSTERESIS_DB)} y={0} width={X(threshold) - X(threshold - GATE_HYSTERESIS_DB)} height={size}/>
        </>}
        {kind === 'compressor' && <rect className="dyn-comp-zone" x={knee.x} y={0} width={size - knee.x} height={size}/>}
        {lines.map(db => <g key={db} className="dyn-grid">
          <line x1={X(db)} x2={X(db)} y1={0} y2={size}/><line x1={0} x2={size} y1={Y(db)} y2={Y(db)}/>
          {!compact && <text x={X(db) + 3} y={size - 4}>{db}</text>}
          {!compact && db !== scale.min && <text x={3} y={Y(db) - 3}>{db}</text>}
        </g>)}
        <line className="dyn-unity" x1={X(scale.min)} y1={Y(scale.min)} x2={X(scale.max)} y2={Y(scale.max)}/>
        {kind === 'limiter' && <line className="dyn-ceiling" x1={0} x2={size} y1={Y(threshold)} y2={Y(threshold)}/>}
        <line className="dyn-threshold" x1={kind === 'limiter' ? knee.x : X(threshold)} x2={kind === 'limiter' ? knee.x : X(threshold)} y1={0} y2={size}/>
        <path className="dyn-curve-fill" d={`${transferPath(curve, scale, size)}L${size} ${size}L0 ${size}Z`}/>
        {kind === 'gate' && <path className="dyn-curve dyn-curve-alt" d={transferPath(x => gateOutput(x, threshold, !gateOpen), scale, size)}/>}
        <path className="dyn-curve" d={transferPath(curve, scale, size)}/>
        <path ref={guideRef} className="dyn-live-guide" d="" style={{ opacity: 0 }}/>
        <circle ref={dotRef} className="dyn-live-dot" r={compact ? 3.2 : 4.5} cx={-10} cy={-10} style={{ opacity: 0 }}/>
      </g>
      {ratioEnd && ratioDef && <circle className="dyn-handle dyn-handle-ratio" cx={ratioEnd.x - (compact ? 5 : 7)} cy={clamp(ratioEnd.y, 6, size - 6)} r={compact ? 4 : 5.5}
        tabIndex={0} role="slider" aria-label={`${name} 비율 (곡선 세로 드래그)`} aria-valuemin={ratioDef.min} aria-valuemax={ratioDef.max}
        aria-valuenow={Number(value('ratio').toFixed(2))} aria-valuetext={formatParam(ratioDef, value('ratio'))} onKeyDown={ratioKey}/>}
      <circle className="dyn-handle dyn-handle-knee" cx={knee.x} cy={clamp(knee.y, 6, size - 6)} r={compact ? 5 : 7}
        tabIndex={0} role="slider" aria-label={kind === 'limiter' ? `${name} 실링 (좌우 화살표: 입력 게인)` : `${name} 스레숄드`}
        aria-valuemin={kneeDef.min} aria-valuemax={kneeDef.max} aria-valuenow={Number(kneeValue.toFixed(1))} aria-valuetext={kneeLabel} onKeyDown={kneeKey}/>
      {!compact && <text className="dyn-axis-label" x={size - 4} y={14} textAnchor="end">출력 dB ↑ · 입력 dB →</text>}
    </svg>
  )
}

/** Vertical gain-reduction bar with a falling peak marker. */
export function GrMeter({ feed, height, range = 24, label }: { feed: DynamicsFeed; height: number; range?: number; label: string }) {
  const barRef = useRef<HTMLDivElement>(null), peakRef = useRef<HTMLDivElement>(null), textRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let peak = 0, held = 0, shown = 0
    return feed.subscribe((frame, seconds) => {
      // Reduction of silence is meaningless: cap by the input's height above −100 dBFS.
      const reduction = Math.min(frame.reductionDb, Math.max(0, frame.inputDb + 100), range)
      shown = Math.max(reduction, shown - seconds * 60) // a little release so it reads smoothly
      if (reduction >= peak) { peak = reduction; held = 1 } else if ((held -= seconds) <= 0) peak = Math.max(shown, peak - seconds * 12)
      const f = (db: number) => `${(clamp(db / range, 0, 1) * 100).toFixed(1)}%`
      if (barRef.current) barRef.current.style.height = f(shown)
      if (peakRef.current) peakRef.current.style.top = f(peak)
      if (textRef.current) textRef.current.textContent = shown >= 0.05 ? `−${shown >= 10 ? shown.toFixed(0) : shown.toFixed(1)}` : '0'
    })
  }, [feed, range])
  const ticks = [0, 3, 6, 12, range].filter((v, i, a) => v <= range && a.indexOf(v) === i)
  return (
    <div className="dyn-gr" style={{ height }} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={range}>
      <div className="dyn-gr-track">
        <div ref={barRef} className="dyn-gr-bar"/>
        <div ref={peakRef} className="dyn-gr-peak"/>
        {ticks.map(t => <i key={t} style={{ top: `${t / range * 100}%` }} data-db={t}/>)}
      </div>
      <span ref={textRef} className="dyn-gr-text">0</span>
    </div>
  )
}

/**
 * "76"-style VU needle in gain-reduction mode: rests at 0, swings left with reduction.
 * Ballistics ~300 ms like a VU movement.
 */
export function VuNeedle({ feed, width, label }: { feed: DynamicsFeed; width: number; label: string }) {
  const needleRef = useRef<SVGLineElement>(null)
  const height = width * 0.56
  const cx = width / 2, cy = height * 1.08, radius = height * 0.88
  // GR dB → angle: 0 dB at +38°, 20 dB at −46° (compressed scale like the hardware meter).
  const angleFor = (gr: number) => 38 - 84 * Math.pow(clamp(gr / 20, 0, 1), 0.62)
  useEffect(() => {
    let value = 0
    return feed.subscribe((frame, seconds) => {
      value = vuStep(value, frame.reductionDb, seconds)
      const a = angleFor(value) * Math.PI / 180
      const n = needleRef.current
      if (n) { n.setAttribute('x2', (cx + Math.sin(a) * radius).toFixed(2)); n.setAttribute('y2', (cy - Math.cos(a) * radius).toFixed(2)) }
    })
  }, [feed, cx, cy, radius])
  const marks = [0, 1, 2, 3, 5, 7, 10, 15, 20]
  const at = (gr: number, r: number) => { const a = angleFor(gr) * Math.PI / 180; return { x: cx + Math.sin(a) * r, y: cy - Math.cos(a) * r } }
  const a0 = at(0, radius * 0.86), a1 = at(20, radius * 0.86)
  const rest = at(0, radius)
  return (
    <svg className="dyn-vu" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <rect className="dyn-vu-face" x={0.5} y={0.5} width={width - 1} height={height - 1} rx={5}/>
      <path className="dyn-vu-arc" d={`M${a1.x} ${a1.y}A${radius * 0.86} ${radius * 0.86} 0 0 1 ${a0.x} ${a0.y}`}/>
      {marks.map(m => { const o = at(m, radius * 0.86), i = at(m, radius * (m % 5 === 0 || m < 4 ? 0.76 : 0.8)), t = at(m, radius * 0.64)
        return <g key={m}><line className="dyn-vu-tick" x1={i.x} y1={i.y} x2={o.x} y2={o.y}/>{(m === 0 || m === 3 || m === 10 || m === 20) && <text className="dyn-vu-num" x={t.x} y={t.y} textAnchor="middle">{m}</text>}</g> })}
      <text className="dyn-vu-title" x={cx} y={height * 0.62} textAnchor="middle">GR dB</text>
      <line ref={needleRef} className="dyn-vu-needle" x1={cx} y1={cy} x2={rest.x} y2={rest.y}/>
      <circle className="dyn-vu-pivot" cx={cx} cy={height - 1} r={width * 0.045}/>
    </svg>
  )
}

interface HistoryProps extends ParamAccess {
  kind: DynamicsKind
  feed: DynamicsFeed
  height: number
  name: string
}

/**
 * Scrolling level history (Pro-C/Pro-L style): input level as a filled area, output as a line,
 * gain reduction in red from the top on the same dB scale, and a draggable threshold / ceiling
 * line. The gate shades the time it was closed.
 */
export function HistoryGraph(props: HistoryProps) {
  const { kind, feed, height, defs, value, name } = props
  const scale = scaleFor(kind)
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(480)
  const latest = useRef(props); latest.current = props
  const drag = useDrag(`${name} 기준선 조절`)
  const lineId = kind === 'limiter' ? 'ceiling' : 'threshold'
  const lineDef = defOf(defs, lineId)

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => setWidth(Math.max(160, Math.round(el.clientWidth)))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(3, window.devicePixelRatio || 1)
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr)
    const css = getComputedStyle(canvas)
    const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
    const palette = {
      bg: color('--dyn-hist-bg', '#151b17'), grid: color('--dyn-hist-grid', '#ffffff14'), text: color('--dyn-hist-text', '#ffffff66'),
      input: color('--dyn-hist-input', '#7d8f8455'), output: color('--dyn-hist-output', '#cfe3c8'), gr: color('--dyn-hist-gr', '#ff6b5b'),
      line: color('--dyn-hist-line', '#e8c77a'), closed: color('--dyn-hist-closed', '#00000055'),
    }
    const Y = (db: number) => dbToY(db, scale, height)
    const draw = () => {
      const p = latest.current, h = feed.history, n = h.capacity
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = palette.bg; ctx.fillRect(0, 0, width, height)
      ctx.strokeStyle = palette.grid; ctx.lineWidth = 1; ctx.fillStyle = palette.text; ctx.font = '9px ui-monospace, Consolas, monospace'
      for (const db of gridLines(scale)) { const y = Math.round(Y(db)) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); if (db > scale.min) ctx.fillText(`${db}`, 4, y - 3) }
      const step = width / (n - 1)
      const xAt = (age: number) => width - age * step
      // Gate: shade closed spans.
      if (p.kind === 'gate') {
        ctx.fillStyle = palette.closed
        for (let age = 0; age < n; age += 1) if (h.reduction[h.index(age)] >= 20) ctx.fillRect(xAt(age) - step / 2, 0, step + 0.5, height)
      }
      // Input area.
      ctx.beginPath(); ctx.moveTo(width, height)
      for (let age = 0; age < n; age += 1) ctx.lineTo(xAt(age), Y(h.input[h.index(age)]))
      ctx.lineTo(0, height); ctx.closePath(); ctx.fillStyle = palette.input; ctx.fill()
      // Output line.
      ctx.beginPath()
      for (let age = 0; age < n; age += 1) {
        const i = h.index(age)
        const out = outputDb(p.kind, { inputDb: h.input[i], reductionDb: h.reduction[i] }, p)
        const y = Y(Math.max(out, scale.min)); if (age) ctx.lineTo(xAt(age), y); else ctx.moveTo(xAt(age), y)
      }
      ctx.strokeStyle = palette.output; ctx.lineWidth = 1.4; ctx.lineJoin = 'round'; ctx.stroke()
      // Gain reduction from the top, on the level scale (1 dB = same height).
      const pxPerDb = height / (scale.max - scale.min)
      ctx.beginPath(); ctx.moveTo(width, 0)
      // Never more than the input had above the floor (a closed gate on silence reduces nothing visible).
      for (let age = 0; age < n; age += 1) { const i = h.index(age); ctx.lineTo(xAt(age), Math.min(height, Math.min(h.reduction[i], Math.max(0, h.input[i] - scale.min)) * pxPerDb)) }
      ctx.lineTo(0, 0); ctx.closePath()
      ctx.fillStyle = palette.gr + '40'; ctx.fill(); ctx.strokeStyle = palette.gr; ctx.lineWidth = 1.2; ctx.stroke()
      // Threshold / ceiling.
      const ly = Math.round(Y(p.value(lineId))) + 0.5
      ctx.setLineDash([5, 4]); ctx.strokeStyle = palette.line; ctx.lineWidth = 1.2
      ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(width, ly); ctx.stroke(); ctx.setLineDash([])
      ctx.fillStyle = palette.line; ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
      const label = `${p.kind === 'limiter' ? '실링' : '스레숄드'} ${formatParam(lineDef, p.value(lineId))}`
      ctx.fillText(label, width - ctx.measureText(label).width - 8, ly > 16 ? ly - 5 : ly + 13)
    }
    draw()
    return feed.subscribe(draw)
  }, [feed, width, height, scale.min, scale.max, lineId, lineDef])

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const y = event.clientY - box.top
    const lineY = dbToY(latest.current.value(lineId), scale, height)
    if (Math.abs(y - lineY) > 10 && !event.shiftKey) {
      // Click away from the line: jump the line there, then keep dragging.
      latest.current.onParams({ [lineId]: within(lineDef, round(yToDb(y, scale, height), 0.1)) })
    }
    drag(event, e => {
      const yy = e.clientY - box.top
      latest.current.onParams({ [lineId]: within(lineDef, round(yToDb(yy, scale, height), 0.1)) })
    })
  }
  const onKey = (event: React.KeyboardEvent) => {
    const next = keyStep(event, lineDef, value(lineId), 0.1, 1)
    if (next !== null) props.onParams({ [lineId]: round(next, 0.1) })
  }
  return (
    <div ref={wrapRef} className="dyn-history" style={{ height }} onPointerDown={startDrag} tabIndex={0} role="slider"
      aria-label={`${name} 레벨 기록 · ${kind === 'limiter' ? '실링' : '스레숄드'} 선 (세로 드래그)`}
      aria-valuemin={lineDef.min} aria-valuemax={lineDef.max} aria-valuenow={Number(value(lineId).toFixed(1))} aria-valuetext={formatParam(lineDef, value(lineId))} onKeyDown={onKey}>
      <canvas ref={canvasRef} style={{ width, height }} aria-hidden="true"/>
      <ul className="dyn-history-legend" aria-hidden="true">
        <li data-k="input">입력</li><li data-k="output">출력</li><li data-k="gr">게인 리덕션</li>{kind === 'gate' && <li data-k="closed">닫힘</li>}
      </ul>
    </div>
  )
}

/**
 * Gate envelope sketch: closed → attack → open → hold → release. Drag a segment's end handle
 * sideways to change that time; arrows nudge the focused handle.
 */
export function GateEnvelope(props: ParamAccess & { width: number; height: number; name: string }) {
  const { defs, value, width, height, name } = props
  const latest = useRef(props); latest.current = props
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useDrag(`${name} 엔벨로프 조절`)
  const ids = ['attack', 'hold', 'release'] as const
  const n = (id: string) => toNormalized(defOf(defs, id), value(id))
  const sketch = gateEnvelope(n('attack'), n('hold'), n('release'), width, height)
  const starts = { attack: width * 0.08, hold: sketch.signalEndX, release: sketch.holdX }
  const ends = { attack: sketch.attackX, hold: sketch.holdX, release: sketch.releaseX }
  const path = sketch.points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('')
  const begin = (id: typeof ids[number]) => (event: React.PointerEvent) => {
    const box = svgRef.current!.getBoundingClientRect()
    const start = starts[id]
    drag(event, e => {
      const x = (e.clientX - box.left) * width / box.width
      const def = defOf(defs, id)
      latest.current.onParam(id, fromNormalized(def, segmentToNormalized(x - start, width)))
    })
  }
  const labels = { attack: '어택', hold: '홀드', release: '릴리즈' }
  return (
    <svg ref={svgRef} className="dyn-envelope" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`${name} 게이트 엔벨로프`}>
      <rect className="dyn-plot-bg" width={width} height={height} rx={6}/>
      <rect className="dyn-env-signal" x={width * 0.08} y={height * 0.05} width={sketch.signalEndX - width * 0.08} height={height * 0.04} rx={2}/>
      <text className="dyn-env-caption" x={width * 0.08 + 2} y={height * 0.05 - 2 < 8 ? height * 0.2 : height * 0.05 - 2}>신호</text>
      <path className="dyn-env-fill" d={`${path}L${width} ${height}L0 ${height}Z`}/>
      <path className="dyn-curve" d={path}/>
      {ids.map(id => {
        const def = defOf(defs, id), x = ends[id]
        return <g key={id}>
          <line className="dyn-env-mark" x1={x} x2={x} y1={height * 0.1} y2={height}/>
          <text className="dyn-env-label" x={x + 5} y={id === 'attack' ? height * 0.62 : id === 'hold' ? height * 0.4 : height * 0.7}>{labels[id]} {formatParam(def, value(id))}</text>
          <circle className="dyn-handle" cx={x} cy={id === 'release' ? height * 0.88 : height * 0.12} r={6} tabIndex={0} role="slider"
            aria-label={`${name} ${def.label}`} aria-valuemin={def.min} aria-valuemax={def.max} aria-valuenow={Number(value(id).toFixed(2))} aria-valuetext={formatParam(def, value(id))}
            onPointerDown={begin(id)} onKeyDown={event => { const next = keyStep(event, def, value(id), 1, 10); if (next !== null) props.onParam(id, def.scale === 'log' ? next : round(next, 1)) }}/>
        </g>
      })}
    </svg>
  )
}

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { EFFECT_DEFS, formatParam, fromNormalized, toNormalized, type ParamDef } from '../../../core/devices'
import { useHistoryGesture } from '../../../core/historyGesture'
import { Knob } from '../../Knob'
import { Icon } from '../../Icon'
import type { DeviceViewProps } from '../types'
import './space.css'

export const defOf = (defs: readonly ParamDef[], id: string): ParamDef => defs.find(d => d.id === id)!
export const show = (defs: readonly ParamDef[], id: string, value: number) => formatParam(defOf(defs, id), value)
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** One keyboard / wheel step, the same sizes as Knob (1 %, Shift 0.1 %, options one by one). */
export function stepValue(def: ParamDef, value: number, sign: number, fine: boolean, coarse = false): number {
  if (def.options) {
    const index = Math.max(0, def.options.findIndex(o => Math.abs(o.value - value) < 1e-6))
    return def.options[clamp(index + sign, 0, def.options.length - 1)].value
  }
  return fromNormalized(def, toNormalized(def, value) + sign * (coarse ? 0.1 : fine ? 0.001 : 0.01))
}

/** Prefers-reduced-motion, live. */
export function useReducedMotion(): boolean {
  const query = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
  const [reduced, setReduced] = useState(() => !!query?.matches)
  useEffect(() => {
    if (!query) return
    const change = () => setReduced(query.matches)
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [query])
  return reduced
}

/**
 * requestAnimationFrame loop that only runs while `ref` is on screen, the tab is visible, motion
 * is allowed and `active`. Otherwise it draws one still frame (t = 0). `draw` must not set React
 * state; it writes to DOM refs directly so animation never re-renders the rack.
 */
export function useAnimation(ref: React.RefObject<Element | null>, active: boolean, draw: (seconds: number) => void) {
  const reduced = useReducedMotion()
  const drawRef = useRef(draw); drawRef.current = draw
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(entries => setVisible(entries.some(e => e.isIntersecting)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  useEffect(() => {
    const change = () => setPageVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  }, [])
  const running = active && visible && pageVisible && !reduced
  // Still frame follows parameter changes while paused (every render, cheap).
  useEffect(() => { if (!running) drawRef.current(0) })
  useEffect(() => {
    if (!running) { drawRef.current(0); return }
    let frame = 0
    const origin = performance.now()
    const tick = (now: number) => { drawRef.current((now - origin) / 1000); frame = requestAnimationFrame(tick) }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [running])
  return running
}

export interface DragSpec<S> {
  label: string
  start(event: PointerEvent): S
  /** dx/dy: pointer travel since the start in the SVG's viewBox units (Shift travels 1/5). */
  move(dx: number, dy: number, snap: S, event: PointerEvent): void
  restore(snap: S): void
}

/**
 * Pointer drag that is one undo step (history gesture), Esc restores and cancels it, Shift is a
 * fine mode. Travel is measured in viewBox units of the nearest <svg>, so it is zoom-proof.
 */
export function useDrag<S>(spec: DragSpec<S>) {
  const gesture = useHistoryGesture(spec.label)
  const latest = useRef(spec); latest.current = spec
  const cancel = useRef<(() => void) | null>(null)
  useEffect(() => () => cancel.current?.(), [])
  return useCallback((e: React.PointerEvent<Element>) => {
    if (e.button !== 0) return
    e.preventDefault(); e.stopPropagation()
    cancel.current?.()
    const el = e.currentTarget as Element, pointerId = e.pointerId
    const svg = el.closest('svg')
    const rect = svg?.getBoundingClientRect(), box = svg?.viewBox.baseVal
    const sx = rect && box && rect.width ? box.width / rect.width : 1, sy = rect && box && rect.height ? box.height / rect.height : 1
    ;(el as HTMLElement | SVGElement).focus?.({ preventScroll: true })
    gesture.begin()
    const snap = latest.current.start(e.nativeEvent)
    let lastX = e.clientX, lastY = e.clientY, dx = 0, dy = 0, moved = false
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return
      const k = event.shiftKey ? 0.2 : 1
      dx += (event.clientX - lastX) * sx * k; dy += (event.clientY - lastY) * sy * k
      lastX = event.clientX; lastY = event.clientY
      if (!moved && Math.hypot(dx, dy) < 1) return
      moved = true
      latest.current.move(dx, dy, snap, event)
    }
    const finish = (restore: boolean) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up)
      window.removeEventListener('keydown', key, true); window.removeEventListener('blur', blur)
      cancel.current = null
      try { if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId) } catch { /* detached */ }
      // A plain click may already have changed values in start() (XY pad jump): keep it.
      if (restore) { latest.current.restore(snap); gesture.cancel() }
      else gesture.end()
    }
    const up = (event: PointerEvent) => { if (event.pointerId === pointerId) finish(false) }
    const blur = () => finish(false)
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(true) } }
    cancel.current = () => finish(false)
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up)
    window.addEventListener('keydown', key, true); window.addEventListener('blur', blur)
    try { el.setPointerCapture(pointerId) } catch { /* window listeners finish */ }
  }, [gesture])
}

const KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']
/**
 * Arrow-key adjustment as one undo step per held key. `adjust` returns true when handled.
 * x keys: Left/Right, y keys: Up/Down (PageUp/PageDown = coarse y).
 */
export function useKeyAdjust(label: string, adjust: (axis: 'x' | 'y', sign: number, fine: boolean, coarse: boolean, key: string) => boolean) {
  const gesture = useHistoryGesture(label)
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing || !KEYS.includes(e.key)) return
    gesture.begin()
    const axis = e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? 'x' : 'y'
    const sign = e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'End' ? 1 : -1
    if (adjust(axis, sign, e.shiftKey, e.key.startsWith('Page') || e.key === 'Home' || e.key === 'End', e.key)) { e.preventDefault(); e.stopPropagation() }
  }
  const onKeyUp = (e: React.KeyboardEvent) => { if (KEYS.includes(e.key)) { e.stopPropagation(); gesture.end() } }
  return { onKeyDown, onKeyUp, onBlur: gesture.end }
}

/** Run one immediate change as its own undo step (resets, chip clicks). */
export function useOneShot(label: string) {
  const gesture = useHistoryGesture(label)
  return (apply: () => void) => { gesture.begin(); apply(); gesture.end() }
}

/** Draggable, focusable SVG point. */
export function Handle({ cx, cy, r = 6, label, valueText, onPointerDown, keys, onReset, className = '', children }: {
  cx: number; cy: number; r?: number; label: string; valueText: string
  onPointerDown: (e: React.PointerEvent<Element>) => void
  keys: ReturnType<typeof useKeyAdjust>; onReset?: () => void; className?: string; children?: ReactNode
}) {
  return <g className={`sx-handle ${className}`} role="slider" tabIndex={0} aria-label={label} aria-valuetext={valueText}
    onPointerDown={onPointerDown} {...keys} onDoubleClick={e => { e.stopPropagation(); onReset?.() }}>
    <title>{`${label} · ${valueText} (Shift: 미세 · 더블 클릭: 기본값 · Esc: 드래그 취소)`}</title>
    <circle className="sx-handle-hit" cx={cx} cy={cy} r={r + 7}/>
    <circle className="sx-handle-dot" cx={cx} cy={cy} r={r}/>
    {children}
  </g>
}

/** 2-D pad: X and Y parameters. Click jumps, drag follows, Shift is fine, double-click resets both. */
export function XYPad({ defs, xId, yId, value, onParams, label, width = 150, height = 110, xLabel, yLabel, disabledX, children }: {
  defs: readonly ParamDef[]; xId: string; yId: string; value(id: string): number; onParams(p: Record<string, number>): void
  label: string; width?: number; height?: number; xLabel?: string; yLabel?: string; disabledX?: string; children?: ReactNode
}) {
  const xd = defOf(defs, xId), yd = defOf(defs, yId)
  const nx = toNormalized(xd, value(xId)), ny = toNormalized(yd, value(yId))
  const pad = 8, iw = width - pad * 2, ih = height - pad * 2
  const reset = useOneShot(`${label} 기본값`)
  const set = (x: number, y: number) => {
    const next: Record<string, number> = { [yId]: fromNormalized(yd, y) }
    if (!disabledX) next[xId] = fromNormalized(xd, x)
    onParams(next)
  }
  const drag = useDrag<{ x: number; y: number; ox: number; oy: number }>({
    label: `${label} 조절`,
    start(event) {
      const svg = (event.target as Element).closest('svg')!, rect = svg.getBoundingClientRect()
      const x = clamp(((event.clientX - rect.left) / rect.width * width - pad) / iw, 0, 1)
      const y = clamp(1 - ((event.clientY - rect.top) / rect.height * height - pad) / ih, 0, 1)
      const shift = event.shiftKey
      if (!shift) set(x, y)
      return { x: shift ? nx : x, y: shift ? ny : y, ox: value(xId), oy: value(yId) }
    },
    move(dx, dy, s) { set(clamp(s.x + dx / iw, 0, 1), clamp(s.y - dy / ih, 0, 1)) },
    restore(s) { onParams(disabledX ? { [yId]: s.oy } : { [xId]: s.ox, [yId]: s.oy }) },
  })
  const keys = useKeyAdjust(`${label} 조절`, (axis, sign, fine, coarse) => {
    if (axis === 'x') { if (disabledX) return false; onParams({ [xId]: stepValue(xd, value(xId), sign, fine, coarse) }) }
    else onParams({ [yId]: stepValue(yd, value(yId), sign, fine, coarse) })
    return true
  })
  const px = pad + nx * iw, py = pad + (1 - ny) * ih
  const text = `${xLabel ?? xd.label} ${disabledX ?? formatParam(xd, value(xId))} · ${yLabel ?? yd.label} ${formatParam(yd, value(yId))}`
  return <div className="sx-xy">
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="sx-xy-svg" role="slider" tabIndex={0}
      aria-label={`${label}: 좌우 ${xLabel ?? xd.label}, 위아래 ${yLabel ?? yd.label}`} aria-valuetext={text} onPointerDown={drag} {...keys}
      onDoubleClick={() => reset(() => onParams(disabledX ? { [yId]: yd.default } : { [xId]: xd.default, [yId]: yd.default }))}>
      <title>{`${text} (클릭·드래그 · 방향키 · Shift: 미세 · 더블 클릭: 기본값)`}</title>
      <rect x={pad} y={pad} width={iw} height={ih} rx={4} className="sx-xy-bg"/>
      {[0.25, 0.5, 0.75].map(f => <g key={f} className="sx-grid"><line x1={pad + f * iw} x2={pad + f * iw} y1={pad} y2={pad + ih}/><line y1={pad + f * ih} y2={pad + f * ih} x1={pad} x2={pad + iw}/></g>)}
      {children}
      <line x1={px} x2={px} y1={pad} y2={pad + ih} className="sx-xy-cross"/><line y1={py} y2={py} x1={pad} x2={pad + iw} className="sx-xy-cross"/>
      <circle cx={px} cy={py} r={7} className="sx-xy-glow"/><circle cx={px} cy={py} r={4.5} className="sx-xy-dot"/>
    </svg>
    <div className="sx-xy-labels"><span>← {xLabel ?? xd.label} →</span><span>↑ {yLabel ?? yd.label}</span></div>
  </div>
}

/** Option chips (radio group), optionally illustrated. */
export function Chips({ def, value, onChange, label, icons, className = '' }: {
  def: ParamDef; value: number; onChange(v: number): void; label?: string
  icons?: Record<number, ReactNode>; className?: string
}) {
  const options = def.options ?? []
  const pick = useOneShot(`${label ?? def.label} 변경`)
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const selected = Math.max(0, options.findIndex(o => Math.abs(o.value - value) < 1e-6))
  const key = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!d) return
    e.preventDefault(); e.stopPropagation()
    const next = (i + d + options.length) % options.length
    pick(() => onChange(options[next].value)); refs.current[next]?.focus()
  }
  return <div className={`sx-chips ${icons ? 'sx-chips--icons' : ''} ${className}`} role="radiogroup" aria-label={label ?? def.label}>
    {options.map((o, i) => <button key={o.value} ref={el => { refs.current[i] = el }} type="button" role="radio" aria-checked={i === selected} tabIndex={i === selected ? 0 : -1}
      className="sx-chip" data-on={i === selected} onClick={() => { if (i !== selected) pick(() => onChange(o.value)) }} onKeyDown={e => key(e, i)}>
      {icons?.[o.value]}<span>{o.label}</span>
    </button>)}
  </div>
}

/** Small toggle button bound to a 0/1 (or bit) parameter. */
export function Toggle({ on, label, title, onClick, children }: { on: boolean; label: string; title?: string; onClick(): void; children?: ReactNode }) {
  const once = useOneShot(`${label} 전환`)
  return <button type="button" className="sx-toggle" aria-pressed={on} data-on={on} aria-label={label} title={title ?? label} onClick={() => once(onClick)}>{children ?? label}</button>
}

const F_LO = 20, F_HI = 20000
export const freqX = (f: number, w: number) => Math.log(f / F_LO) / Math.log(F_HI / F_LO) * w
export const xFreq = (x: number, w: number) => F_LO * Math.pow(F_HI / F_LO, clamp(x / w, 0, 1))

function useBandEdge(id: string, def: ParamDef, value: (id: string) => number, onParam: (id: string, v: number) => void, width: number) {
  const drag = useDrag<number>({
    label: `${def.label} 조절`,
    start: () => value(id),
    move(dx, _dy, start) { onParam(id, clamp(xFreq(freqX(start, width) + dx, width), def.min, def.max)) },
    restore: start => onParam(id, start),
  })
  const keys = useKeyAdjust(`${def.label} 조절`, (_axis, sign, fine, coarse) => { onParam(id, stepValue(def, value(id), sign, fine, coarse)); return true })
  return { drag, keys }
}

/**
 * Pass band of a low cut + high cut on a log frequency axis with two draggable edges.
 * The curve is the idealised 12 dB/oct response (for orientation; the DSP filters differ slightly).
 */
export function BandStrip({ defs, lowId, highId, value, onParam, width, height = 28, label = '필터 대역', lowOffAtMin = true }: {
  defs: readonly ParamDef[]; lowId: string; highId: string; value(id: string): number; onParam(id: string, v: number): void
  width: number; height?: number; label?: string; lowOffAtMin?: boolean
}) {
  const ld = defOf(defs, lowId), hd = defOf(defs, highId)
  const lo = value(lowId), hi = value(highId)
  const lowOff = lowOffAtMin && lo <= ld.min + 0.5
  const pts: string[] = []
  for (let i = 0; i <= 60; i += 1) {
    const x = i / 60 * width, f = xFreq(x, width)
    const hp = lowOff ? 1 : (f / lo) ** 2 / Math.sqrt(1 + (f / lo) ** 4)
    const lp = 1 / Math.sqrt(1 + (f / hi) ** 4)
    const level = clamp(20 * Math.log10(Math.max(1e-6, hp * lp)), -30, 0)
    pts.push(`${x.toFixed(1)},${(2 + (-level / 30) * (height - 4)).toFixed(1)}`)
  }
  const lowEdge = useBandEdge(lowId, ld, value, onParam, width), highEdge = useBandEdge(highId, hd, value, onParam, width)
  const reset = useOneShot('필터 기본값')
  const lx = freqX(lo, width), hx = freqX(hi, width)
  return <svg className="sx-band" viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-label={label} role="group">
    <rect x={0} y={0} width={width} height={height} rx={3} className="sx-band-bg"/>
    {[100, 1000, 10000].map(f => <line key={f} x1={freqX(f, width)} x2={freqX(f, width)} y1={0} y2={height} className="sx-grid"/>)}
    <polygon points={`0,${height} ${pts.join(' ')} ${width},${height}`} className="sx-band-fill"/>
    <polyline points={pts.join(' ')} className="sx-band-line"/>
    {[{ x: lx, e: lowEdge, d: ld, id: lowId, v: lo, off: lowOff }, { x: hx, e: highEdge, d: hd, id: highId, v: hi, off: false }].map(h =>
      <g key={h.id} className="sx-band-edge" role="slider" tabIndex={0} aria-label={h.d.label} aria-valuetext={h.off ? '끔' : formatParam(h.d, h.v)}
        onPointerDown={h.e.drag} {...h.e.keys} onDoubleClick={e => { e.stopPropagation(); reset(() => onParam(h.id, h.d.default)) }}>
        <title>{`${h.d.label} · ${h.off ? '끔' : formatParam(h.d, h.v)} (드래그 · 방향키 · 더블 클릭: 기본값)`}</title>
        <rect x={h.x - 6} y={0} width={12} height={height} className="sx-handle-hit"/>
        <line x1={h.x} x2={h.x} y1={2} y2={height - 2}/>
      </g>)}
  </svg>
}

/** A row of precision knobs for the given ids. */
export function Knobs({ props, ids, size = 32, className = '' }: { props: DeviceViewProps; ids: readonly string[]; size?: number; className?: string }) {
  return <div className={`sx-knobs ${className}`}>
    {ids.map(id => { const def = props.defs.find(d => d.id === id); return def ? <Knob key={id} def={def} value={props.value(id)} onChange={v => props.onParam(id, v)} size={size}/> : null })}
  </div>
}

/** Large editor overlay: portal, focus trap, Esc closes, focus returns to the opener. */
export function EditorModal({ title, subtitle, icon, onClose, children }: { title: string; subtitle?: string; icon?: string; onClose(): void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const closeRef = useRef(onClose); closeRef.current = onClose
  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const first = panel.current?.querySelector<HTMLElement>('[data-autofocus]') ?? panel.current
    first?.focus({ preventScroll: true })
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }) }
  }, [])
  const keyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current(); return }
    if (e.key !== 'Tab' || !panel.current) return
    const focusables = [...panel.current.querySelectorAll<HTMLElement | SVGElement>('button:not([disabled]),[tabindex]:not([tabindex="-1"]),input,select')]
      .filter(el => !(el as HTMLElement).hidden && el.getClientRects().length > 0)
    if (!focusables.length) return
    const first = focusables[0], last = focusables[focusables.length - 1]
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); (last as HTMLElement).focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); (first as HTMLElement).focus() }
  }
  return createPortal(<div className="sx-overlay" onPointerDown={e => { if (e.target === e.currentTarget) closeRef.current() }}>
    <div ref={panel} className="sx-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={keyDown}>
      <header className="sx-modal-head">
        {icon && <span className="sx-modal-icon"><Icon name={icon} size={16}/></span>}
        <div><strong id={titleId}>{title}</strong>{subtitle && <small>{subtitle}</small>}</div>
        <span className="sx-modal-hint">드래그로 조절 · Shift 미세 · 더블 클릭 기본값 · Esc 닫기</span>
        <button type="button" className="sx-modal-close" onClick={onClose} aria-label="큰 편집기 닫기" title="닫기 (Esc)"><Icon name="close" size={14}/></button>
      </header>
      <div className="sx-modal-body">{children}</div>
    </div>
  </div>, document.body)
}

/**
 * Compact card body with an expand button. The graph area opens the big editor on double-click
 * (handles inside it stop that event and reset themselves instead).
 */
export function CompactCard({ props, graph, controls, editor, editorTitle, icon, width = 252 }: {
  props: DeviceViewProps; graph: ReactNode; controls: ReactNode; editor: () => ReactNode; editorTitle: string; icon: string; width?: number
}) {
  const [open, setOpen] = useState(false)
  const name = props.device.name ?? EFFECT_DEFS[props.device.type]?.name ?? editorTitle
  return <div className="sx-root" data-off={!props.device.enabled} style={{ width, '--sx-track': props.color ?? 'var(--accent)' } as React.CSSProperties}>
    <div className="sx-graph" onDoubleClick={() => setOpen(true)}>
      {graph}
      <button type="button" className="sx-expand" onClick={() => setOpen(true)} aria-label={`${name} 큰 편집기 열기`} title="크게 편집 (그래프 더블 클릭)"><Icon name="fit" size={11}/></button>
    </div>
    {controls}
    {open && <EditorModal title={name} subtitle={editorTitle} icon={icon} onClose={() => setOpen(false)}>{editor()}</EditorModal>}
  </div>
}

export const pathOf = (points: ArrayLike<number>, xs: (i: number) => number) => {
  let d = ''
  for (let i = 0; i < points.length; i += 1) d += `${i ? 'L' : 'M'}${xs(i).toFixed(1)} ${points[i].toFixed(1)}`
  return d
}

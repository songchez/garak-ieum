import { useEffect, useRef } from 'react'
import { formatParam, type ParamDef } from '../core/devices'
import './TrackHeader.css'

const PAN: ParamDef = { id: 'pan', label: '팬', min: -1, max: 1, default: 0, unit: 'pan' }
const SWEEP = 135
const point = (c: number, r: number, deg: number) => { const a = deg * Math.PI / 180; return [c + r * Math.sin(a), c - r * Math.cos(a)] }
function arc(c: number, r: number, from: number, to: number) { if (Math.abs(to - from) < .01) return ''; const [a, b] = from < to ? [from, to] : [to, from]; const [x1, y1] = point(c, r, a), [x2, y2] = point(c, r, b); return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${r} ${r} 0 ${b - a > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}` }

export const formatPan = (value: number) => formatParam(PAN, value)

export function PanKnob({ value, onChange, size = 20, ariaLabel = '팬' }: { value: number; onChange(v: number, final: boolean): void; size?: number; ariaLabel?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const latest = useRef({ value, onChange })
  latest.current = { value, onChange }
  const cancelDrag = useRef<(() => void) | null>(null)
  const set = (next: number, final: boolean) => { const l = latest.current; const v = Math.min(1, Math.max(-1, Math.round(next * 100) / 100)); if (v !== l.value || final) l.onChange(v, final) }
  const step = (direction: number, amount: number, final: boolean) => set(latest.current.value + direction * amount * 2, final)

  useEffect(() => {
    const el = ref.current; if (!el) return
    const wheel = (e: WheelEvent) => { if (!e.deltaY || e.ctrlKey || e.metaKey || e.altKey) return; e.preventDefault(); step(e.deltaY < 0 ? 1 : -1, e.shiftKey ? .005 : .02, true) }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => { el.removeEventListener('wheel', wheel); cancelDrag.current?.() }
  }, [])

  function startDrag(e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation()
    if (e.button !== 0) return
    e.preventDefault(); cancelDrag.current?.()
    const el = e.currentTarget, pointerId = e.pointerId, startValue = latest.current.value
    el.focus({ preventScroll: true })
    if (e.altKey) { set(0, true); return }
    let v = startValue, lastY = e.clientY, lastX = e.clientX, active = true
    el.dataset.dawGesture = 'knob'
    const move = (event: PointerEvent) => {
      if (!active || event.pointerId !== pointerId) return
      const d = (lastY - event.clientY) + (event.clientX - lastX); lastY = event.clientY; lastX = event.clientX
      v = Math.min(1, Math.max(-1, v + d / (event.shiftKey ? 400 : 80)))
      set(v, false)
    }
    const finish = (restore: boolean) => {
      if (!active) return
      active = false; cancelDrag.current = null
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up)
      window.removeEventListener('keydown', key, true); window.removeEventListener('blur', blur)
      el.removeEventListener('lostpointercapture', lost); delete el.dataset.dawGesture
      if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId)
      set(restore ? startValue : latest.current.value, true)
    }
    const up = (event: PointerEvent) => { if (event.pointerId === pointerId) finish(false) }
    const lost = () => finish(false)
    const blur = () => finish(false)
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(true) } }
    cancelDrag.current = () => finish(false)
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up)
    window.addEventListener('keydown', key, true); window.addEventListener('blur', blur)
    el.addEventListener('lostpointercapture', lost)
    try { el.setPointerCapture(pointerId) } catch { /* window listeners still finish the drag */ }
  }

  function keyDown(e: React.KeyboardEvent) {
    const fine = e.shiftKey
    switch (e.key) {
      case 'ArrowUp': case 'ArrowRight': step(1, fine ? .1 : .01, false); break
      case 'ArrowDown': case 'ArrowLeft': step(-1, fine ? .1 : .01, false); break
      case 'PageUp': step(1, .1, false); break
      case 'PageDown': step(-1, .1, false); break
      case 'Home': set(-1, false); break
      case 'End': set(1, false); break
      case '0': set(0, false); break
      default: return
    }
    e.preventDefault(); e.stopPropagation()
  }
  function keyUp(e: React.KeyboardEvent) {
    if (['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'PageUp', 'PageDown', 'Home', 'End', '0'].includes(e.key)) { e.stopPropagation(); set(latest.current.value, true) }
  }

  const c = 20, r = 15, angle = (value + 1) / 2 * SWEEP * 2 - SWEEP
  const [px, py] = point(c, r - 3, angle), [ix, iy] = point(c, 7, angle)
  const text = formatPan(value)
  return <div ref={ref} className="pan-knob" role="slider" tabIndex={0} aria-label={ariaLabel} aria-valuemin={-1} aria-valuemax={1} aria-valuenow={value} aria-valuetext={text}
    title={`${ariaLabel} · ${text} (⌥클릭·더블 클릭: 중앙)`} onPointerDown={startDrag} onKeyDown={keyDown} onKeyUp={keyUp} onDoubleClick={e => { e.stopPropagation(); set(0, true) }} style={{ width: size, height: size }}>
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true"><circle cx={c} cy={c} r={12} className="pan-cap"/><path d={arc(c, r, -SWEEP, SWEEP)} className="pan-track"/><path d={arc(c, r, 0, angle)} className="pan-value"/><line x1={ix} y1={iy} x2={px} y2={py} className="pan-pointer"/></svg>
  </div>
}

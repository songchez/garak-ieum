import { useEffect, useRef } from 'react'
import { useHistoryGesture } from '../core/historyGesture'
import { SEND_LEVEL_DEFAULT, SEND_LEVEL_MAX } from '../core/sends'

/** Send knob travel: −∞ at the left stop, 0 dB at three quarters (like a fader's unity mark), +6 dB at the right. */
const UNITY = 0.75
export const sendToPos = (gain: number): number => gain <= 1 ? UNITY * Math.cbrt(Math.max(0, gain)) : UNITY + (Math.min(SEND_LEVEL_MAX, gain) - 1) / (SEND_LEVEL_MAX - 1) * (1 - UNITY)
export const posToSend = (position: number): number => {
  const n = Math.min(1, Math.max(0, position))
  return n <= UNITY ? (n / UNITY) ** 3 : 1 + (n - UNITY) / (1 - UNITY) * (SEND_LEVEL_MAX - 1)
}
export const formatSendDb = (gain: number): string => gain <= 0.00001 ? '−∞' : `${gain > 1 ? '+' : ''}${(20 * Math.log10(gain)).toFixed(1)} dB`

const SWEEP = 135
const point = (c: number, r: number, deg: number) => { const a = deg * Math.PI / 180; return [c + r * Math.sin(a), c - r * Math.cos(a)] }
function arc(c: number, r: number, from: number, to: number) { if (Math.abs(to - from) < .01) return ''; const [a, b] = from < to ? [from, to] : [to, from]; const [x1, y1] = point(c, r, a), [x2, y2] = point(c, r, b); return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${r} ${r} 0 ${b - a > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}` }

/**
 * A small send-level knob (docs/SENDS_RETURNS.md): vertical drag (Shift: fine), wheel, arrow keys,
 * double-click or Alt/⌥-click resets to −∞. One drag is one undo step.
 */
export function SendKnob({ value, onChange, label, ariaLabel, color = 'var(--accent)', size = 22, disabled = false }: {
  value: number; onChange(value: number): void; label: string; ariaLabel: string; color?: string; size?: number; disabled?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const latest = useRef({ value, onChange })
  latest.current = { value, onChange }
  const cancelDrag = useRef<(() => void) | null>(null)
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const gesture = useHistoryGesture(`${ariaLabel} 조절`)
  const gestureRef = useRef(gesture); gestureRef.current = gesture
  const set = (next: number) => { const l = latest.current; const v = Math.min(SEND_LEVEL_MAX, Math.max(0, next)); if (Math.abs(v - l.value) > 1e-9) { l.value = v; l.onChange(v) } }
  const nudge = (amount: number) => set(posToSend(sendToPos(latest.current.value) + amount))

  useEffect(() => {
    const el = ref.current; if (!el) return
    const wheel = (e: WheelEvent) => {
      if (!e.deltaY || e.ctrlKey || e.metaKey || e.altKey || el.getAttribute('aria-disabled') === 'true') return
      e.preventDefault(); if (cancelDrag.current) return
      gestureRef.current.begin(); nudge((e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? .005 : .02))
      clearTimeout(wheelTimer.current); wheelTimer.current = setTimeout(() => { wheelTimer.current = undefined; gestureRef.current.end() }, 180)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => { el.removeEventListener('wheel', wheel); clearTimeout(wheelTimer.current); cancelDrag.current?.(); gestureRef.current.end() }
  }, [])

  function reset() { gestureRef.current.begin(); set(SEND_LEVEL_DEFAULT); gestureRef.current.end() }
  function startDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || disabled) return
    e.preventDefault(); e.stopPropagation(); cancelDrag.current?.()
    if (e.altKey) { reset(); return }
    gestureRef.current.begin()
    const el = e.currentTarget, pointerId = e.pointerId, start = latest.current.value
    el.focus({ preventScroll: true })
    let position = sendToPos(start), lastY = e.clientY, active = true
    el.dataset.dawGesture = 'send-knob'
    const move = (event: PointerEvent) => { if (!active || event.pointerId !== pointerId) return; const dy = lastY - event.clientY; lastY = event.clientY; position = Math.min(1, Math.max(0, position + dy / (event.shiftKey ? 800 : 140))); set(posToSend(position)) }
    const finish = (restore: boolean) => {
      if (!active) return
      active = false; cancelDrag.current = null
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up)
      window.removeEventListener('keydown', key, true); window.removeEventListener('blur', blur)
      delete el.dataset.dawGesture
      if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId)
      if (restore) set(start)
      if (restore || Math.abs(latest.current.value - start) < 1e-9) gestureRef.current.cancel(); else gestureRef.current.end()
    }
    const up = (event: PointerEvent) => { if (event.pointerId === pointerId) finish(false) }
    const blur = () => finish(false)
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(true) } }
    cancelDrag.current = () => finish(false)
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up)
    window.addEventListener('keydown', key, true); window.addEventListener('blur', blur)
    try { el.setPointerCapture(pointerId) } catch { /* window listeners still finish the drag */ }
  }
  function keyDown(e: React.KeyboardEvent) {
    if (disabled || e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing) return
    const step = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0
    if (!step && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault(); e.stopPropagation()
    gestureRef.current.begin()
    if (e.key === 'Home') set(0); else if (e.key === 'End') set(SEND_LEVEL_MAX); else nudge(step * (e.shiftKey ? .002 : .02))
    gestureRef.current.end()
  }
  const c = 20, r = 15, angle = -SWEEP + sendToPos(value) * SWEEP * 2
  const [px, py] = point(c, r - 3, angle), [ix, iy] = point(c, 6, angle)
  const text = formatSendDb(value)
  return <div ref={ref} className={`send-knob${value > 0 ? ' active' : ''}`} role="slider" tabIndex={disabled ? -1 : 0} aria-label={ariaLabel} aria-disabled={disabled || undefined}
    aria-valuemin={0} aria-valuemax={SEND_LEVEL_MAX} aria-valuenow={value} aria-valuetext={text}
    title={`${ariaLabel} · ${text} (드래그 · Shift: 미세 조절 · 더블 클릭·${'Alt/⌥'}클릭: −∞)`}
    onPointerDown={startDrag} onKeyDown={keyDown} onClick={e => e.stopPropagation()} onDoubleClick={e => { e.stopPropagation(); if (!disabled) reset() }}>
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true"><circle cx={c} cy={c} r={11} className="knob-cap"/><path d={arc(c, r, -SWEEP, SWEEP)} className="knob-track"/><path d={arc(c, r, -SWEEP, angle)} className="knob-value" style={{ stroke: color }}/><line x1={ix} y1={iy} x2={px} y2={py} className="knob-pointer"/></svg>
    <span className="send-knob-label">{label}</span>
  </div>
}

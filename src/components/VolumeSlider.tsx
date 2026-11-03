import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { AudioEngine } from '../core/types'
import { getThemeSnapshot, subscribeTheme } from '../core/theme'
import { useHistoryGesture } from '../core/historyGesture'
import './TrackHeader.css'

export const VOLUME_MAX = 1.5
/** Fader taper: 0 dB sits at 75 % of the travel, the lower part is a power curve, the top quarter is linear up to +3.5 dB. */
const UNITY = .75, CURVE = 2.5
export const gainToPos = (g: number) => g <= 1 ? UNITY * Math.pow(Math.max(0, g), 1 / CURVE) : UNITY + (Math.min(VOLUME_MAX, g) - 1) / (VOLUME_MAX - 1) * (1 - UNITY)
export const posToGain = (p: number) => { const n = Math.min(1, Math.max(0, p)); return n <= UNITY ? Math.pow(n / UNITY, CURVE) : 1 + (n - UNITY) / (1 - UNITY) * (VOLUME_MAX - 1) }
export const gainToDb = (g: number) => g <= 0 ? '-∞' : (20 * Math.log10(g)).toFixed(1)

const HOLD = .88

export function VolumeSlider({ value, onChange, orientation, meter, ariaLabel = '볼륨', disabled = false }: {
  value: number; onChange(v: number, final: boolean): void; orientation: 'horizontal' | 'vertical'
  meter?: { engine: AudioEngine; trackId?: string }; ariaLabel?: string; disabled?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeSnapshot)
  const latest = useRef({ value, onChange, disabled })
  latest.current = { value, onChange, disabled }
  const cancelDrag = useRef<(() => void) | null>(null)
  const vertical = orientation === 'vertical'
  const gesture = useHistoryGesture('볼륨 조절')
  const gestureRef = useRef(gesture); gestureRef.current = gesture

  const set = (next: number, final: boolean) => {
    const l = latest.current
    const v = Math.min(VOLUME_MAX, Math.max(0, next))
    if (v !== l.value || final) { l.value = v; l.onChange(v, final) }
  }
  const step = (direction: number, amount: number, final: boolean) => set(posToGain(gainToPos(latest.current.value) + direction * amount), final)

  useEffect(() => {
    const el = ref.current; if (!el) return
    // Ctrl/⌘/Alt + wheel belongs to zoom.
    const wheel = (e: WheelEvent) => { if (!e.deltaY || e.ctrlKey || e.metaKey || e.altKey || latest.current.disabled) return; e.preventDefault(); step(e.deltaY < 0 ? 1 : -1, e.shiftKey ? .005 : .02, true) }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => { el.removeEventListener('wheel', wheel); cancelDrag.current?.() }
  }, [])

  const engine = meter?.engine, trackId = meter?.trackId
  useEffect(() => {
    if (!engine) return
    const element = canvas.current; if (!element) return
    const styles = getComputedStyle(element), low = styles.getPropertyValue('--meter-low').trim(), high = styles.getPropertyValue('--meter-high').trim()
    let raf = 0, held = 0, last = 0
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (now - last < 33) return
      last = now
      const c = canvas.current, ctx = c?.getContext('2d'); if (!c || !ctx) return
      const dpr = window.devicePixelRatio || 1, w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr))
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h }
      const level = trackId ? engine.getTrackLevel(trackId) : engine.getMasterLevel()
      held = Math.max(level, held * HOLD)
      const fill = Math.min(1, Math.sqrt(held) * 1.6)
      ctx.clearRect(0, 0, w, h)
      if (fill <= 0) return
      ctx.fillStyle = held > .85 ? high : low
      if (vertical) ctx.fillRect(0, h * (1 - fill), w, h * fill); else ctx.fillRect(0, 0, w * fill, h)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [engine, trackId, vertical, theme])

  function startDrag(e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation()
    if (e.button !== 0 || latest.current.disabled) return
    e.preventDefault(); cancelDrag.current?.()
    const el = e.currentTarget, pointerId = e.pointerId, startValue = latest.current.value
    el.focus({ preventScroll: true })
    gestureRef.current.begin()
    if (e.altKey) { set(1, true); gestureRef.current.end(); return }
    const rect = el.getBoundingClientRect(), span = Math.max(24, vertical ? rect.height : rect.width)
    let pos = gainToPos(startValue), lastX = e.clientX, lastY = e.clientY, active = true
    el.dataset.dawGesture = 'fader'
    const move = (event: PointerEvent) => {
      if (!active || event.pointerId !== pointerId) return
      const d = vertical ? lastY - event.clientY : event.clientX - lastX
      lastX = event.clientX; lastY = event.clientY
      pos = Math.min(1, Math.max(0, pos + d / span / (event.shiftKey ? 5 : 1)))
      set(posToGain(pos), false)
    }
    const finish = (restore: boolean) => {
      if (!active) return
      active = false; cancelDrag.current = null
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancelPointer)
      window.removeEventListener('keydown', key, true); window.removeEventListener('blur', blur)
      el.removeEventListener('lostpointercapture', lost); delete el.dataset.dawGesture
      if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId)
      const cancelled = restore || Math.abs(latest.current.value - startValue) < 1e-9
      set(restore ? startValue : latest.current.value, true)
      if (cancelled) gestureRef.current.cancel(); else gestureRef.current.end()
    }
    const up = (event: PointerEvent) => { if (event.pointerId === pointerId) finish(false) }
    const cancelPointer = (event: PointerEvent) => { if (event.pointerId === pointerId) finish(false) }
    const lost = () => finish(false)
    const blur = () => finish(false)
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(true) } }
    cancelDrag.current = () => finish(false)
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancelPointer)
    window.addEventListener('keydown', key, true); window.addEventListener('blur', blur)
    el.addEventListener('lostpointercapture', lost)
    try { el.setPointerCapture(pointerId) } catch { /* window listeners still finish the drag */ }
  }

  function keyDown(e: React.KeyboardEvent) {
    if (latest.current.disabled) return
    if (e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing) return
    if (!['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'PageUp', 'PageDown', 'Home', 'End', '0'].includes(e.key)) return
    gestureRef.current.begin()
    const fine = e.shiftKey
    switch (e.key) {
      case 'ArrowUp': case 'ArrowRight': step(1, fine ? .1 : .01, false); break
      case 'ArrowDown': case 'ArrowLeft': step(-1, fine ? .1 : .01, false); break
      case 'PageUp': step(1, .1, false); break
      case 'PageDown': step(-1, .1, false); break
      case 'Home': set(0, false); break
      case 'End': set(VOLUME_MAX, false); break
      case '0': set(1, false); break
      default: return
    }
    e.preventDefault(); e.stopPropagation()
  }
  function keyUp(e: React.KeyboardEvent) {
    if (['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'PageUp', 'PageDown', 'Home', 'End', '0'].includes(e.key)) { e.stopPropagation(); set(latest.current.value, true); gestureRef.current.end() }
  }

  const pos = gainToPos(value) * 100, text = `${gainToDb(value)} dB`
  return <div ref={ref} className={`volume-slider volume-slider--${orientation}${disabled ? ' disabled' : ''}`} role="slider" tabIndex={disabled ? -1 : 0} aria-label={ariaLabel} aria-valuemin={0} aria-valuemax={VOLUME_MAX} aria-valuenow={value} aria-valuetext={text} aria-disabled={disabled || undefined}
    title={`${ariaLabel} · ${text} (⌥클릭: 0 dB · ⇧드래그: 미세 조절)`} onPointerDown={startDrag} onKeyDown={keyDown} onKeyUp={keyUp} onBlur={() => { if (!cancelDrag.current) gestureRef.current.end() }} onDoubleClick={e => e.stopPropagation()}>
    <div className="volume-track"><canvas ref={canvas} className="volume-meter" aria-hidden="true"/><i className="volume-unity" style={{ [vertical ? 'bottom' : 'left']: `${UNITY * 100}%` }}/><i className="volume-thumb" style={{ [vertical ? 'bottom' : 'left']: `${pos}%` }}/></div>
    <span className="volume-readout">{gainToDb(value)}</span>
  </div>
}

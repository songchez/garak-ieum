import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { useHistoryGesture } from '../../../core/historyGesture'

export const MOD_MIME = 'application/x-ieum-wave-mod-source'
export interface ControlDefinition {
  id: string
  label: string
  min: number
  max: number
  default: number
  unit?: string
  scale?: 'log'
  options?: readonly { value: number; label: string }[]
}
export interface KnobModulation { id: string; name: string; amount: number; bipolar: boolean; enabled: boolean }
export const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value))
export function normalized(def: ControlDefinition, value: number) {
  if (def.options) return Math.max(0, def.options.findIndex(option => option.value === value)) / Math.max(1, def.options.length - 1)
  return clamp(def.scale === 'log' && def.min > 0 ? Math.log(value / def.min) / Math.log(def.max / def.min) : (value - def.min) / (def.max - def.min))
}
export function denormalized(def: ControlDefinition, value: number) {
  const n = clamp(value)
  if (def.options) return def.options[Math.round(n * (def.options.length - 1))].value
  const result = def.scale === 'log' && def.min > 0 ? def.min * Math.pow(def.max / def.min, n) : def.min + n * (def.max - def.min)
  return Number(clamp(result, def.min, def.max).toPrecision(6))
}
export function formatValue(def: ControlDefinition, value: number) {
  const option = def.options?.find(item => item.value === value)
  if (option) return option.label
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''
  switch (def.unit) {
    case 'hz': return value >= 1000 ? `${(value / 1000).toFixed(2)} kHz` : `${value < 10 ? value.toFixed(2) : Math.round(value)} Hz`
    case 'db': return `${sign}${Math.abs(value).toFixed(1)} dB`
    case 's': return value < 1 ? `${Math.round(value * 1000)} ms` : `${value.toFixed(2)} s`
    case 'ms': return value < 10 ? `${value.toFixed(1)} ms` : `${Math.round(value)} ms`
    case 'pct': return `${Math.round(value * 100)}%`
    case 'st': return `${sign}${Math.abs(value).toFixed(0)} st`
    case 'ct': return `${sign}${Math.abs(value).toFixed(1)} ct`
    case 'pan': return Math.abs(value) < .005 ? 'C' : `${Math.round(Math.abs(value) * 100)}${value < 0 ? 'L' : 'R'}`
    case 'gain': return value <= 0 ? '−∞ dB' : `${(20 * Math.log10(value)).toFixed(1)} dB`
    case 'x': return `${Number(value.toFixed(2))}×`
    case 'ratio': return `${value.toFixed(1)}:1`
    default: return String(Number(value.toFixed(2)))
  }
}
const point = (angle: number, radius: number) => { const rad = angle * Math.PI / 180; return [24 + radius * Math.sin(rad), 24 - radius * Math.cos(rad)] }
function arc(from: number, to: number, radius = 18) {
  if (Math.abs(from - to) < .01) return ''
  const [a, b] = from < to ? [from, to] : [to, from], [x, y] = point(a, radius), [x2, y2] = point(b, radius)
  return `M${x} ${y}A${radius} ${radius} 0 ${b - a > 180 ? 1 : 0} 1 ${x2} ${y2}`
}
const angle = (value: number) => -135 + clamp(value) * 270
const CHANGE_KEYS = ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'PageUp', 'PageDown', 'Home', 'End']

interface SynthKnobProps {
  def: ControlDefinition
  value: number
  label?: string
  ariaLabel?: string
  onChange: (value: number) => void
  modulations?: readonly KnobModulation[]
  onAssign?: (source: string) => void
  onOpenModulation?: () => void
  compact?: boolean
}
export function SynthKnob({ def, value, label, ariaLabel, onChange, modulations = [], onAssign, onOpenModulation, compact }: SynthKnobProps) {
  const ref = useRef<HTMLDivElement>(null), inputRef = useRef<HTMLInputElement>(null)
  const latest = useRef({ def, value, onChange }); latest.current = { def, value, onChange }
  const dragEnd = useRef<(() => void) | null>(null), wheelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [draft, setDraft] = useState<string | null>(null), [over, setOver] = useState(false)
  const inputCancelled = useRef(false)
  const title = ariaLabel ?? def.label
  const gesture = useHistoryGesture(`${title} 조절`), history = useRef(gesture); history.current = gesture
  const set = (next: number) => { const state = latest.current; if (!Number.isFinite(next)) return; const v = clamp(next, state.def.min, state.def.max); if (v !== state.value) { state.value = v; state.onChange(v) } }
  function endWheel() { if (wheelTimer.current !== undefined) { clearTimeout(wheelTimer.current); wheelTimer.current = undefined; history.current.end() } }
  const step = (direction: number, amount: number) => {
    const state = latest.current, options = state.def.options
    if (options) { const index = Math.max(0, options.findIndex(option => option.value === state.value)); set(options[clamp(index + direction, 0, options.length - 1)].value) }
    else set(denormalized(state.def, normalized(state.def, state.value) + direction * amount))
  }
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      if (!event.deltaY || event.ctrlKey || event.metaKey || event.altKey) return
      event.preventDefault(); event.stopPropagation()
      if (dragEnd.current) return
      history.current.begin(); step(event.deltaY < 0 ? 1 : -1, event.shiftKey ? .002 : .02)
      clearTimeout(wheelTimer.current); wheelTimer.current = setTimeout(() => { wheelTimer.current = undefined; history.current.end() }, 180)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => { element.removeEventListener('wheel', wheel); clearTimeout(wheelTimer.current); dragEnd.current?.(); history.current.end() }
  }, [])
  useEffect(() => { if (draft !== null) { inputCancelled.current = false; inputRef.current?.focus(); inputRef.current?.select() } }, [draft === null])
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || draft !== null) return
    event.preventDefault(); event.stopPropagation(); dragEnd.current?.(); endWheel(); history.current.begin()
    if (event.altKey) { set(latest.current.def.default); history.current.end(); return }
    const element = event.currentTarget, id = event.pointerId, initial = latest.current.value
    let lastY = event.clientY, current = normalized(latest.current.def, initial), active = true
    element.focus({ preventScroll: true }); element.dataset.dawGesture = 'wavetable-knob'
    const move = (e: globalThis.PointerEvent) => {
      if (!active || e.pointerId !== id) return
      const delta = lastY - e.clientY; lastY = e.clientY
      current = clamp(current + delta / (e.shiftKey ? 1200 : 180)); set(denormalized(latest.current.def, current))
    }
    const finish = (restore: boolean) => {
      if (!active) return
      active = false; dragEnd.current = null; delete element.dataset.dawGesture
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', escape, true); window.removeEventListener('blur', blur); element.removeEventListener('lostpointercapture', lost)
      if (element.hasPointerCapture(id)) element.releasePointerCapture(id)
      const unchanged = Math.abs(latest.current.value - initial) < 1e-9
      if (restore) set(initial)
      if (restore || unchanged) history.current.cancel(); else history.current.end()
    }
    const up = (e: globalThis.PointerEvent) => { if (e.pointerId === id) finish(false) }
    const cancel = (e: globalThis.PointerEvent) => { if (e.pointerId === id) finish(true) }
    const lost = () => finish(false), blur = () => finish(false)
    const escape = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(true) } }
    dragEnd.current = () => finish(false)
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', escape, true); window.addEventListener('blur', blur); element.addEventListener('lostpointercapture', lost)
    try { element.setPointerCapture(id) } catch { /* The window listeners retain ownership. */ }
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); endWheel(); setDraft(String(latest.current.value)); return }
    if (event.key.toLowerCase() === 'm' && onOpenModulation) { event.preventDefault(); event.stopPropagation(); onOpenModulation(); return }
    if (!CHANGE_KEYS.includes(event.key)) return
    event.preventDefault(); event.stopPropagation(); endWheel(); history.current.begin()
    if (event.key === 'Home') set(def.min)
    else if (event.key === 'End') set(def.max)
    else step(['ArrowUp', 'ArrowRight', 'PageUp'].includes(event.key) ? 1 : -1, event.key.startsWith('Page') ? .1 : event.shiftKey ? .001 : .01)
  }
  function commit() {
    if (draft === null) return
    if (inputCancelled.current) { setDraft(null); return }
    const next = Number(draft)
    if (draft.trim() !== '' && Number.isFinite(next)) { history.current.begin(); set(next); history.current.end() }
    setDraft(null); ref.current?.focus({ preventScroll: true })
  }
  const n = normalized(def, value), [x, y] = point(angle(n), 11), [x0, y0] = point(angle(n), 5)
  const activeMods = modulations.filter(mod => mod.enabled), depth = activeMods.reduce((sum, mod) => sum + Math.abs(mod.amount), 0)
  const low = activeMods.reduce((sum, mod) => sum + (mod.bipolar ? -Math.abs(mod.amount) : Math.min(mod.amount, 0)), n)
  const high = activeMods.reduce((sum, mod) => sum + Math.max(mod.amount, mod.bipolar ? Math.abs(mod.amount) : 0), n)
  return <div className={`iw-control${compact ? ' iw-control-compact' : ''}${over ? ' is-drop-target' : ''}${activeMods.length ? ' is-modulated' : ''}`} data-mod-target={onAssign ? def.id : undefined}
    onDragOver={event => { if (onAssign && event.dataTransfer.types.includes(MOD_MIME)) { event.preventDefault(); event.dataTransfer.dropEffect = 'link'; setOver(true) } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false) }}
    onDrop={event => { const source = event.dataTransfer.getData(MOD_MIME); setOver(false); if (source && onAssign) { event.preventDefault(); event.stopPropagation(); onAssign(source) } }}>
    <div ref={ref} className="iw-knob" role="slider" tabIndex={0} data-param-id={def.id} aria-label={title} aria-valuemin={def.min} aria-valuemax={def.max} aria-valuenow={value} aria-valuetext={formatValue(def, value)}
      title={`${title} · ${formatValue(def, value)}\n드래그·휠 조절 / Shift 미세 조절 / Enter·더블 클릭 숫자 입력 / Alt 클릭 초기값`}
      onPointerDown={pointerDown} onDoubleClick={event => { event.preventDefault(); endWheel(); setDraft(String(value)) }} onKeyDown={keyDown} onKeyUp={event => { if (CHANGE_KEYS.includes(event.key)) { event.stopPropagation(); history.current.end() } }} onBlur={() => { if (!dragEnd.current) { endWheel(); history.current.end() } }}>
      <svg viewBox="0 0 48 48" aria-hidden="true"><path className="iw-knob-track" d={arc(-135, 135)}/><path className="iw-knob-fill" d={arc(-135, angle(n))}/>{depth > 0 && <path className="iw-knob-mod-range" d={arc(angle(low), angle(high), 22)}/>}<circle className="iw-knob-disc" cx={24} cy={24} r={13}/><circle className="iw-knob-disc-inner" cx={24} cy={24} r={10}/><path className="iw-knob-tick" d={`M${x0} ${y0}L${x} ${y}`}/></svg>
    </div>
    {draft === null ? <button className="iw-value" onClick={() => { endWheel(); setDraft(String(value)) }} aria-label={`${title} 숫자 입력`}>{formatValue(def, value)}</button> : <input ref={inputRef} className="iw-value-input" type="number" aria-label={`${title} 값`} min={def.min} max={def.max} step="any" value={draft} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') return; event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); commit() } else if (event.key === 'Escape') { event.preventDefault(); inputCancelled.current = true; setDraft(null); ref.current?.focus({ preventScroll: true }) } }}/>}
    <span className="iw-control-label">{label ?? def.label}</span>
    {onOpenModulation && <button className="iw-mod-count" onClick={onOpenModulation} aria-label={`${title} 변조 연결 ${modulations.length}개`} title="변조 연결 편집">{modulations.length || '+'}</button>}
  </div>
}

export function ModSource({ id, label, selected, onSelect, color = 'cyan' }: { id: string; label: string; selected?: boolean; onSelect: () => void; color?: 'cyan' | 'amber' | 'violet' }) {
  return <button className={`iw-mod-source iw-source-${color}${selected ? ' is-selected' : ''}`} draggable aria-pressed={selected} onClick={onSelect} onDragStart={event => { event.dataTransfer.setData(MOD_MIME, id); event.dataTransfer.effectAllowed = 'link' }} title={`${label} · 노브로 끌어 연결하거나 클릭 후 노브의 +를 누르세요`}><span className="iw-source-grip" aria-hidden="true">⠿</span>{label}</button>
}

export function PowerSwitch({ enabled, onChange, label }: { enabled: boolean; onChange: (enabled: boolean) => void; label: string }) {
  return <button type="button" className={`iw-power${enabled ? ' is-on' : ''}`} aria-label={`${label} 켜기/끄기`} aria-pressed={enabled} onClick={() => onChange(!enabled)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v5M4.3 4.4a5 5 0 1 0 7.4 0"/></svg></button>
}

export function Choice({ def, value, onChange, label }: { def: ControlDefinition; value: number; onChange: (value: number) => void; label?: string }) {
  return <label className="iw-choice"><span>{label ?? def.label}</span><select value={value} onChange={event => onChange(Number(event.target.value))}>{def.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
}

export function Toggle({ checked, onChange, children, label }: { checked: boolean; onChange: (value: boolean) => void; children: React.ReactNode; label?: string }) {
  return <button className={`iw-toggle${checked ? ' is-on' : ''}`} aria-pressed={checked} aria-label={label} onClick={() => onChange(!checked)}>{children}</button>
}

export function RangeControl({ label, value, min = 0, max = 1, step = .01, onChange, valueText, className = '' }: { label: string; value: number; min?: number; max?: number; step?: number; onChange: (value: number) => void; valueText?: string; className?: string }) {
  const gesture = useHistoryGesture(`${label} 조절`)
  return <label className={`iw-range ${className}`}><span>{label}<output>{valueText ?? Number(value.toFixed(2))}</output></span><input type="range" aria-label={label} aria-valuetext={valueText} min={min} max={max} step={step} value={value} onPointerDown={() => gesture.begin()} onPointerUp={() => gesture.end()} onPointerCancel={() => gesture.end()} onKeyDown={event => { if (CHANGE_KEYS.includes(event.key)) gesture.begin() }} onKeyUp={event => { if (CHANGE_KEYS.includes(event.key)) gesture.end() }} onBlur={() => gesture.end()} onChange={event => onChange(Number(event.target.value))}/></label>
}

export function SegmentControl({ label, value, options, onChange }: { label: string; value: number; options: readonly { value: number; label: string }[]; onChange: (value: number) => void }) {
  return <div className="iw-segments" role="group" aria-label={label}>{options.map(option => <button key={option.value} aria-pressed={option.value === value} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>
}

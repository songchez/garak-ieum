import { createContext, useContext, useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { paramValue, type ParamDef } from '../../../core/devices'
import { useHistoryGesture } from '../../../core/historyGesture'
import { Knob } from '../../../components/Knob'
import { useAutomationControl } from '../../../components/automationUi'

/** What every control in a vintage editor reads and writes: one instrument's catalog and values. */
export interface VintageControlContext {
  defs: readonly ParamDef[]
  params: Readonly<Record<string, number>>
  onParam(id: string, value: number): void
  color: string
}
export const VintageControls = createContext<VintageControlContext | null>(null)

export function useVintage(): VintageControlContext & { value(id: string): number; def(id: string): ParamDef } {
  const context = useContext(VintageControls)
  if (!context) throw new Error('VintageControls provider missing')
  return {
    ...context,
    value: id => paramValue(context.defs, context.params as Record<string, number>, id),
    def: id => {
      const found = context.defs.find(item => item.id === id)
      if (!found) throw new Error(`unknown vintage parameter ${id}`)
      return found
    },
  }
}

/** A catalog knob: automation-aware through the surrounding AutomationScope (kind 'instrument'). */
export function ParamKnob({ id, label, size = 40 }: { id: string; label?: string; size?: number }) {
  const { def, value, onParam, color } = useVintage()
  const base = def(id)
  return <Knob def={label ? { ...base, label } : base} ariaLabel={base.label} value={value(id)} color={color} size={size} onChange={next => onParam(id, next)}/>
}

/**
 * Options parameters (ParamDef.options) as a segmented radio group: arrow keys move and select,
 * right-click opens the automation menu like a knob's.
 */
export function Segmented({ id, label, variant, vertical }: { id: string; label?: string; variant?: 'hardware' | 'switch'; vertical?: boolean }) {
  const { def, value, onParam } = useVintage()
  const base = def(id), current = value(id), options = base.options ?? []
  const automation = useAutomationControl(id)
  const gesture = useHistoryGesture(`${base.label} 변경`)
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const selected = Math.max(0, options.findIndex(option => option.value === current))
  const choose = (index: number, focus = false) => {
    const option = options[index]
    if (!option) return
    if (option.value !== current) { gesture.begin(); onParam(id, option.value); gesture.end() }
    if (focus) refs.current[index]?.focus()
  }
  const keyDown = (event: KeyboardEvent) => {
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? selected + 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? selected - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : null
    if (next === null) return
    event.preventDefault(); event.stopPropagation()
    choose((next + options.length) % options.length, true)
  }
  const name = label ?? base.label
  return <div className={`vt-seg${variant ? ` vt-seg--${variant}` : ''}${vertical ? ' vt-seg--vertical' : ''}${automation.state ? ` vt-seg--auto-${automation.state}` : ''}`}>
    <span className="vt-seg-label" aria-hidden="true">{name}</span>
    <div role="radiogroup" aria-label={base.label} className="vt-seg-options" onKeyDown={keyDown} onContextMenu={automation.onContextMenu}
      title={automation.onContextMenu ? `${base.label} · 우클릭: 오토메이션` : base.label}>
      {options.map((option, index) => <button key={option.value} ref={element => { refs.current[index] = element }} type="button" role="radio" aria-checked={index === selected}
        tabIndex={index === selected ? 0 : -1} className="vt-seg-option" onClick={() => choose(index)}>
        {variant === 'hardware' && <i className="vt-led" aria-hidden="true"/>}<span>{option.label}</span>
      </button>)}
    </div>
  </div>
}

export function Section({ eyebrow, title, children, graph, className }: { eyebrow: string; title: string; children: ReactNode; graph?: ReactNode; className?: string }) {
  return <section className={`vt-section${className ? ` ${className}` : ''}`} aria-label={title}>
    <header className="vt-section-head"><span className="vt-eyebrow">{eyebrow}</span><h3>{title}</h3></header>
    {graph && <div className="vt-graph">{graph}</div>}
    <div className="vt-controls">{children}</div>
  </section>
}

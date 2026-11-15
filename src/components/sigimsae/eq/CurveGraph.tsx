import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DeviceAnalysisTap } from '../../../devices/effects/analysis'
import { C_NOTES, MAJOR_FREQS, MINOR_FREQS, dbAt, dbTicks, freqAt, freqLabel, formatDb, formatHz, linePath, noteName, sampleFreqs, xOf, yOf, type Plot } from './scale'
import { useSpectrumPath } from './useSpectrum'

/** A draggable point on the curve (an EQ band or the filter cutoff). */
export interface GraphNode {
  key: number
  freq: number
  /** Vertical position in dB on the plot. */
  db: number
  /** CSS color (usually a var()). */
  color: string
  on: boolean
  /** Short tag drawn in the dot ("1"…"8"). */
  tag: string
  /** Accessible description, e.g. "밴드 2 벨, 1.00 kHz, +3.0 dB, Q 0.90". */
  label: string
}

export interface CurveGraphProps {
  nodes: readonly GraphNode[]
  /** Total response in dB. */
  response(freq: number): number
  /** One node's own response (filled behind the curve while hovered/selected). */
  nodeResponse?(key: number, freq: number): number
  range: number
  compact?: boolean
  selected: number | null
  onSelect(key: number | null): void
  onDragStart(key: number, source: 'pointer' | 'keyboard'): void
  /** Target position: absolute freq and dB, plus dB moved since the gesture began. */
  onDrag(key: number, freq: number, db: number, deltaDb: number): void
  onDragEnd(): void
  /** Wheel or [ ] keys: positive steps widen Q / steepen slope. */
  onStep?(key: number, steps: number, fine: boolean): void
  onToggle?(key: number): void
  onReset?(key: number): void
  onRemove?(key: number): void
  onAdd?(freq: number, db: number): void
  onMenu?(key: number | null, clientX: number, clientY: number, freq: number, db: number): void
  spectrum?: DeviceAnalysisTap
  showNotes?: boolean
  /** Hint shown in the empty state / for screen readers. */
  ariaLabel: string
  hintId?: string
}

/**
 * Interactive frequency-response graph (log 20 Hz–20 kHz × ±range dB) in the spirit of
 * FabFilter Pro-Q: drag nodes, wheel = Q, double-click adds, right-click menus, Alt-click
 * bypasses, Shift = fine, arrows move the focused node. Renders crisp SVG at any size.
 */
export function CurveGraph(props: CurveGraphProps) {
  const { nodes, range, compact = false, selected } = props
  const host = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [hover, setHover] = useState<number | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const drag = useRef<{ key: number; x: number; y: number; nodeX: number; nodeY: number; startDb: number; pointer: number; moved: boolean; fine: boolean } | null>(null)
  const latest = useRef(props); latest.current = props
  const gradientId = useId().replace(/:/g, '')

  useLayoutEffect(() => {
    const el = host.current
    if (!el) return
    const measure = () => setSize(previous => {
      const width = Math.round(el.clientWidth), height = Math.round(el.clientHeight)
      return previous.width === width && previous.height === height ? previous : { width, height }
    })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const plot: Plot = useMemo(() => ({ width: size.width, height: size.height, range, padTop: compact ? 6 : 10, padBottom: compact ? 14 : 22 }), [size.width, size.height, range, compact])
  const freqs = useMemo(() => sampleFreqs(Math.max(64, Math.min(480, Math.round(size.width / (compact ? 2 : 2.5))))), [size.width, compact])

  const curve = useMemo(() => {
    if (!size.width) return { line: '', fill: '' }
    const zero = yOf(plot, 0)
    const points = freqs.map(f => [xOf(plot, f), clampY(yOf(plot, props.response(f)), plot)] as const)
    const line = linePath(points)
    return { line, fill: `${line}L${plot.width} ${zero}L0 ${zero}Z` }
  }, [freqs, plot, props.response, size.width]) // eslint-disable-line react-hooks/exhaustive-deps

  const focusKey = hover ?? selected
  const bandFill = useMemo(() => {
    if (focusKey === null || !props.nodeResponse || !size.width) return ''
    const node = nodes.find(n => n.key === focusKey)
    if (!node || !node.on) return ''
    const zero = yOf(plot, 0)
    const line = linePath(freqs.map(f => [xOf(plot, f), clampY(yOf(plot, props.nodeResponse!(focusKey, f)), plot)] as const))
    return `${line}L${plot.width} ${zero}L0 ${zero}Z`
  }, [focusKey, nodes, freqs, plot, props.nodeResponse, size.width]) // eslint-disable-line react-hooks/exhaustive-deps

  const spectrumFill = useRef<SVGPathElement>(null), spectrumLine = useRef<SVGPathElement>(null)
  useSpectrumPath(props.spectrum, plot.width, plot.height - plot.padBottom, spectrumFill, spectrumLine)

  // Wheel needs a non-passive listener to keep the rack/page from scrolling while adjusting Q.
  useEffect(() => {
    const el = svg.current
    if (!el) return
    const wheel = (event: WheelEvent) => {
      const p = latest.current
      if (!p.onStep || event.ctrlKey || event.metaKey) return
      const target = (event.target as Element).closest('[data-node]')
      const key = target ? Number(target.getAttribute('data-node')) : (!p.compact ? p.selected : null)
      if (key === null || Number.isNaN(key)) return
      event.preventDefault(); event.stopPropagation()
      p.onStep(key, event.deltaY < 0 ? 1 : -1, event.shiftKey)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [size.width > 0]) // the <svg> mounts once the host has been measured

  const local = (event: { clientX: number; clientY: number }) => {
    const box = svg.current!.getBoundingClientRect()
    return { x: event.clientX - box.left, y: event.clientY - box.top }
  }
  const nodeXY = (node: GraphNode) => ({ x: xOf(plot, node.freq), y: clampY(yOf(plot, node.db), plot) })

  function nodeDown(event: React.PointerEvent, node: GraphNode) {
    if (event.button !== 0) return
    event.stopPropagation()
    ;(event.currentTarget as SVGGElement).focus({ preventScroll: true })
    if (event.altKey) { event.preventDefault(); props.onToggle?.(node.key); return }
    props.onSelect(node.key)
    const at = local(event), xy = nodeXY(node)
    drag.current = { key: node.key, x: at.x, y: at.y, nodeX: xy.x, nodeY: yOf(plot, node.db), startDb: node.db, pointer: event.pointerId, moved: false, fine: event.shiftKey }
    svg.current!.setPointerCapture(event.pointerId)
    svg.current!.setAttribute('data-daw-gesture', '')
    props.onDragStart(node.key, 'pointer')
  }
  function move(event: React.PointerEvent) {
    const at = local(event)
    const d = drag.current
    if (!d || d.pointer !== event.pointerId) { if (!compact) setCursor(at); return }
    const k = event.shiftKey ? 0.15 : 1
    // Fine mode is relative to where Shift was pressed: rebase so the node doesn't jump.
    if (d.fine !== event.shiftKey) {
      const node = latest.current.nodes.find(n => n.key === d.key)
      if (node) { d.x = at.x; d.y = at.y; d.nodeX = xOf(plot, node.freq); d.nodeY = yOf(plot, node.db) }
      d.fine = event.shiftKey
    }
    const x = d.nodeX + (at.x - d.x) * k, y = d.nodeY + (at.y - d.y) * k
    if (!d.moved && Math.hypot(at.x - d.x, at.y - d.y) < 2) return
    d.moved = true
    const db = Math.max(-range * 1.34, Math.min(range * 1.34, dbAt(plot, y)))
    props.onDrag(d.key, freqAt(plot, Math.max(0, Math.min(plot.width, x))), db, dbAt(plot, y) - d.startDb)
  }
  function up(event: React.PointerEvent) {
    const d = drag.current
    if (!d || d.pointer !== event.pointerId) return
    drag.current = null
    svg.current?.releasePointerCapture(event.pointerId)
    svg.current?.removeAttribute('data-daw-gesture')
    props.onDragEnd()
  }
  function backgroundDown(event: React.PointerEvent) {
    if (event.button === 0 && !(event.target as Element).closest('[data-node]')) props.onSelect(null)
  }
  function doubleClick(event: React.MouseEvent) {
    const target = (event.target as Element).closest('[data-node]')
    if (target) { props.onReset?.(Number(target.getAttribute('data-node'))); return }
    const at = local(event)
    props.onAdd?.(freqAt(plot, at.x), dbAt(plot, at.y))
  }
  function contextMenu(event: React.MouseEvent) {
    if (!props.onMenu) return
    event.preventDefault(); event.stopPropagation()
    const target = (event.target as Element).closest('[data-node]')
    const at = local(event)
    const key = target ? Number(target.getAttribute('data-node')) : null
    if (key !== null) props.onSelect(key)
    props.onMenu(key, event.clientX, event.clientY, freqAt(plot, at.x), dbAt(plot, at.y))
  }
  function nodeKey(event: React.KeyboardEvent, node: GraphNode) {
    const fine = event.shiftKey
    let freq = node.freq, db = node.db, handled = true, delta = 0
    switch (event.key) {
      case 'ArrowLeft': freq = node.freq / Math.pow(2, fine ? 1 / 48 : 1 / 12); break
      case 'ArrowRight': freq = node.freq * Math.pow(2, fine ? 1 / 48 : 1 / 12); break
      case 'ArrowUp': delta = fine ? 0.1 : 0.5; db = node.db + delta; break
      case 'ArrowDown': delta = -(fine ? 0.1 : 0.5); db = node.db + delta; break
      case 'PageUp': case ']': props.onStep?.(node.key, 1, fine); break
      case 'PageDown': case '[': props.onStep?.(node.key, -1, fine); break
      case 'Delete': case 'Backspace': props.onRemove?.(node.key); break
      case 'Enter': case ' ': props.onToggle?.(node.key); break
      case 'Home': props.onReset?.(node.key); break
      default: handled = false
    }
    if (!handled) return
    event.preventDefault(); event.stopPropagation()
    if (event.key.startsWith('Arrow')) {
      props.onSelect(node.key)
      props.onDragStart(node.key, 'keyboard')
      props.onDrag(node.key, Math.min(20000, Math.max(20, freq)), db, delta)
      props.onDragEnd()
    }
  }

  const ready = size.width > 0
  const zeroY = yOf(plot, 0)
  const ticks = dbTicks(range)
  const hoverNode = nodes.find(n => n.key === (drag.current?.key ?? hover ?? selected))
  return <div ref={host} className={`cg${compact ? ' cg-compact' : ''}`}>
    {ready && <svg ref={svg} className="cg-svg" width={plot.width} height={plot.height} viewBox={`0 0 ${plot.width} ${plot.height}`} role="group" aria-label={props.ariaLabel} aria-describedby={props.hintId}
      onPointerDown={backgroundDown} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={() => setCursor(null)} onDoubleClick={doubleClick} onContextMenu={contextMenu}>
      <defs>
        <linearGradient id={`${gradientId}-curve`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--cg-curve)" stopOpacity=".28"/>
          <stop offset={Math.max(0, Math.min(1, zeroY / plot.height))} stopColor="var(--cg-curve)" stopOpacity=".04"/>
          <stop offset="1" stopColor="var(--cg-curve)" stopOpacity=".28"/>
        </linearGradient>
        <linearGradient id={`${gradientId}-spectrum`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--cg-spectrum)" stopOpacity=".42"/>
          <stop offset="1" stopColor="var(--cg-spectrum)" stopOpacity=".04"/>
        </linearGradient>
      </defs>
      <rect className="cg-bg" x="0" y="0" width={plot.width} height={plot.height}/>
      <path ref={spectrumFill} className="cg-spectrum-fill" fill={`url(#${gradientId}-spectrum)`}/>
      <path ref={spectrumLine} className="cg-spectrum-line"/>
      <g className="cg-grid" aria-hidden="true">
        {!compact && MINOR_FREQS.map(f => <line key={f} className="cg-minor" x1={xOf(plot, f)} x2={xOf(plot, f)} y1={plot.padTop} y2={plot.height - plot.padBottom}/>)}
        {MAJOR_FREQS.map(f => <line key={f} className="cg-major" x1={xOf(plot, f)} x2={xOf(plot, f)} y1={plot.padTop} y2={plot.height - plot.padBottom}/>)}
        {ticks.map(db => <line key={db} className={db === 0 ? 'cg-zero' : 'cg-major'} x1={0} x2={plot.width} y1={yOf(plot, db)} y2={yOf(plot, db)}/>)}
        {MAJOR_FREQS.filter(f => (compact ? [100, 1000, 10000] : MAJOR_FREQS.slice(1, -1)).includes(f)).map(f => <text key={f} className="cg-label" x={xOf(plot, f)} y={plot.height - (compact ? 3 : 7)} textAnchor="middle">{freqLabel(f)}</text>)}
        {!compact && ticks.filter(db => db !== -range && db !== range).map(db => <text key={db} className="cg-label cg-db" x={plot.width - 5} y={yOf(plot, db) - 3} textAnchor="end">{db > 0 ? `+${db}` : db}</text>)}
        {props.showNotes && !compact && C_NOTES.map(note => <g key={note.label}><line className="cg-note" x1={xOf(plot, note.hz)} x2={xOf(plot, note.hz)} y1={plot.height - plot.padBottom} y2={plot.height - plot.padBottom + 5}/><text className="cg-label cg-note-label" x={xOf(plot, note.hz) + 2} y={plot.padTop + 10}>{note.label}</text></g>)}
      </g>
      {bandFill && <path className="cg-band-fill" d={bandFill} style={{ fill: nodes.find(n => n.key === focusKey)?.color }}/>}
      <path className="cg-curve-fill" d={curve.fill} fill={`url(#${gradientId}-curve)`}/>
      <path className="cg-curve" d={curve.line}/>
      {!compact && cursor && !drag.current && hover === null && <g className="cg-cursor" aria-hidden="true">
        <line x1={cursor.x} x2={cursor.x} y1={plot.padTop} y2={plot.height - plot.padBottom}/>
        <text x={Math.min(plot.width - 70, cursor.x + 6)} y={Math.max(plot.padTop + 12, cursor.y - 8)}>{formatHz(freqAt(plot, cursor.x))}{props.showNotes ? ` · ${noteName(freqAt(plot, cursor.x))}` : ''} · {formatDb(dbAt(plot, cursor.y))}</text>
      </g>}
      {nodes.map(node => {
        const { x, y } = nodeXY(node), active = node.key === selected, r = compact ? 6 : 8
        return <g key={node.key} data-node={node.key} className={`cg-node${active ? ' is-selected' : ''}${node.on ? '' : ' is-off'}`} style={{ '--node': node.color } as React.CSSProperties}
          transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`} tabIndex={0} role="slider" aria-label={node.label} aria-valuetext={node.label}
          aria-valuemin={20} aria-valuemax={20000} aria-valuenow={Math.round(node.freq)}
          onPointerDown={event => nodeDown(event, node)} onPointerEnter={() => setHover(node.key)} onPointerLeave={() => setHover(h => h === node.key ? null : h)}
          onFocus={() => props.onSelect(node.key)} onKeyDown={event => nodeKey(event, node)}>
          <circle className="cg-node-hit" r={r + 7}/>
          {active && <circle className="cg-node-ring" r={r + 4}/>}
          <circle className="cg-node-dot" r={r}/>
          <text className="cg-node-tag" y={compact ? 2.6 : 3.4} textAnchor="middle">{node.tag}</text>
        </g>
      })}
      {!compact && hoverNode && <NodeReadout node={hoverNode} plot={plot} showNotes={props.showNotes}/>}
    </svg>}
  </div>
}

function NodeReadout({ node, plot, showNotes }: { node: GraphNode; plot: Plot; showNotes?: boolean }) {
  const x = xOf(plot, node.freq), y = clampY(yOf(plot, node.db), plot)
  const text = `${formatHz(node.freq)}${showNotes ? ` · ${noteName(node.freq)}` : ''}`
  const width = text.length * 6.2 + 16
  const left = Math.max(4, Math.min(plot.width - width - 4, x - width / 2))
  const top = y > 46 ? y - 40 : y + 18
  return <g className="cg-readout" aria-hidden="true" transform={`translate(${left.toFixed(1)} ${top.toFixed(1)})`}>
    <rect width={width} height={20} rx={5}/>
    <text x={width / 2} y={13.5} textAnchor="middle">{text}</text>
  </g>
}

function clampY(y: number, plot: Plot): number { return Math.max(1, Math.min(plot.height - 1, y)) }

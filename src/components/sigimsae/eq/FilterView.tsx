import { useCallback, useMemo, useRef, useState } from 'react'
import ContextMenu, { type ContextMenuItem } from '../../ContextMenu'
import { Icon } from '../../Icon'
import type { DeviceViewProps } from '../types'
import { FILTER_SLOPES, filterSections, sectionsResponseDb } from '../../../devices/effects/eqModel'
import { effectDeviceName } from '../../../core/sigimsaeDevices'
import { CurveGraph, type GraphNode } from './CurveGraph'
import { EditorDialog, NumberField } from './EditorDialog'
import { formatHz, noteName, parseHz } from './scale'
import { useAnalysisTap } from './useSpectrum'
import './eq.css'

const RATE = 48000
const MODES = [{ value: 0, label: '로우패스', short: 'LP' }, { value: 1, label: '하이패스', short: 'HP' }, { value: 2, label: '밴드패스', short: 'BP' }] as const
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const round = (value: number, digits: number) => Number(value.toPrecision(digits))
const HINT = '노드 좌우: 컷오프 · 위아래: 레조넌스 · 휠: 기울기 · Shift: 미세 · 우클릭: 모드 메뉴 · 방향키로도 조절'

function ModeGlyph({ mode }: { mode: number }) {
  const d = ['M2 4L9 4C13 4 14 12 18 12', 'M2 12C6 12 7 4 11 4L18 4', 'M2 12C6 12 7 3 10 3C13 3 14 12 18 12'][mode]
  return <svg className="eqv-glyph" width={18} height={13} viewBox="0 0 20 14" aria-hidden="true"><path d={d}/></svg>
}

/** "Sweep" card body: draggable cutoff/resonance node on the live response, mode and slope switches. */
export function FilterView(props: DeviceViewProps) {
  const { device, value, onParams } = props
  const cutoff = value('cutoff'), resonance = value('resonance'), mode = Math.round(value('mode')), slope = Math.round(value('slope'))
  const sections = useMemo(() => filterSections(mode, cutoff, resonance, slope, RATE), [mode, cutoff, resonance, slope])
  const response = useCallback((f: number) => sectionsResponseDb(sections, f, RATE), [sections])
  const [open, setOpen] = useState(false), [selected, setSelected] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const gesture = useRef<{ resonance: number; id: string } | null>(null)
  const tap = useAnalysisTap(device.id, device.enabled)
  const name = effectDeviceName(device)
  const set = (params: Record<string, number>, label: string, mergeKey?: string) => onParams(params, { label, mergeKey })
  const node: GraphNode = {
    key: 1, freq: cutoff, db: clamp(response(cutoff), -30, 30), color: 'var(--eq-c5)', on: true, tag: MODES[mode]?.short ?? 'LP',
    label: `${MODES[mode]?.label} 컷오프 ${formatHz(cutoff)}, 레조넌스 ${resonance.toFixed(2)}, ${FILTER_SLOPES[slope]} dB/oct`,
  }
  const graphProps = {
    nodes: [node], response, selected, onSelect: setSelected,
    onDragStart: (_key: number, source: 'pointer' | 'keyboard') => { gesture.current = { resonance, id: source === 'keyboard' ? 'filter-key' : `filter-drag-${Date.now()}` } },
    onDrag: (_key: number, freq: number, _db: number, deltaDb: number) => {
      const g = gesture.current
      if (!g) return
      set({ cutoff: round(clamp(freq, 20, 20000), 4), resonance: round(clamp(g.resonance * Math.pow(2, deltaDb / 6), 0.1, 18), 3) }, '필터 조절', g.id)
    },
    onDragEnd: () => { gesture.current = null },
    onStep: (_key: number, steps: number) => { const next = clamp(slope + steps, 0, 2); if (next !== slope) set({ slope: next }, '필터 기울기 변경', 'filter-slope') },
    onReset: () => set({ resonance: 0.7 }, '레조넌스 초기화'),
    onMenu: (_key: number | null, x: number, y: number) => setMenu({ x, y }),
    spectrum: tap,
  }
  const menuItems: ContextMenuItem[] = [
    ...MODES.map(m => ({ label: m.label, checked: mode === m.value, onSelect: () => set({ mode: m.value }, '필터 모드 변경') })),
    { type: 'separator' },
    { label: '기울기', items: FILTER_SLOPES.map((s, v) => ({ label: `${s} dB/oct`, checked: slope === v, onSelect: () => set({ slope: v }, '필터 기울기 변경') })) },
    { label: '레조넌스 초기화', icon: 'refresh', shortcut: '더블클릭', onSelect: () => set({ resonance: 0.7 }, '레조넌스 초기화') },
  ]
  const switches = <div className="fv-switches">
    <div className="sgd-seg fv-modes" role="radiogroup" aria-label="필터 모드">{MODES.map(m => <button key={m.value} role="radio" aria-checked={mode === m.value} className={mode === m.value ? 'is-on' : ''} title={m.label} aria-label={m.label} onClick={() => set({ mode: m.value }, '필터 모드 변경')}><ModeGlyph mode={m.value}/></button>)}</div>
    <div className="sgd-seg" role="radiogroup" aria-label="기울기">{FILTER_SLOPES.map((s, v) => <button key={v} role="radio" aria-checked={slope === v} className={slope === v ? 'is-on' : ''} title={`${s} dB/oct`} onClick={() => set({ slope: v }, '필터 기울기 변경')}>{s}</button>)}</div>
  </div>
  return <div className="eqv fv">
    <div className="eqv-graph">
      <CurveGraph compact {...graphProps} range={24} ariaLabel={`${name} 필터 응답 그래프`}/>
      <button className="eqv-expand" onClick={() => setOpen(true)} title="큰 편집기 열기" aria-label={`${name} 큰 편집기 열기`}><Icon name="fit" size={12}/></button>
    </div>
    {switches}
    <p className="eqv-readout"><b style={{ color: node.color }}>{formatHz(cutoff)}</b> · 레조넌스 {resonance.toFixed(2)}</p>
    {menu && !open && <ContextMenu x={menu.x} y={menu.y} label="필터 메뉴" items={menuItems} onClose={() => setMenu(null)}/>}
    {open && <EditorDialog eyebrow="SIGIMSAE · FILTER" title={name} subtitle={`${MODES[mode]?.label} · ${FILTER_SLOPES[slope]} dB/oct`} onClose={() => setOpen(false)} hint={HINT}>
      <div className="eqe-graph"><CurveGraph {...graphProps} range={24} showNotes ariaLabel="필터 응답 그래프. 노드를 선택해 방향키로 조절"/>
        {!tap && <span className="eqe-note">분석기: 오디오 엔진은 아직 스펙트럼을 보내지 않습니다</span>}</div>
      <div className="eqe-panel"><div className="eqe-controls" style={{ '--node': node.color } as React.CSSProperties}>
        {switches}
        <NumberField label="컷오프" value={cutoff} format={formatHz} parse={parseHz} suffix={noteName(cutoff)} step={(v, d, fine) => clamp(v * Math.pow(2, d * (fine ? 1 / 48 : 1 / 12)), 20, 20000)} onCommit={v => set({ cutoff: round(clamp(v, 20, 20000), 4) }, '필터 컷오프 입력')}/>
        <NumberField label="레조넌스" value={resonance} format={v => v.toFixed(2)} parse={text => { const v = parseFloat(text); return Number.isFinite(v) ? v : null }} step={(v, d, fine) => clamp(v * Math.pow(2, d * (fine ? 1 / 24 : 1 / 6)), 0.1, 18)} onCommit={v => set({ resonance: round(clamp(v, 0.1, 18), 3) }, '필터 레조넌스 입력')}/>
      </div></div>
      {menu && <ContextMenu x={menu.x} y={menu.y} label="필터 메뉴" items={menuItems} onClose={() => setMenu(null)}/>}
    </EditorDialog>}
  </div>
}

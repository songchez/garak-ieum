import { useCallback, useMemo, useRef, useState } from 'react'
import ContextMenu, { type ContextMenuItem } from '../../ContextMenu'
import { Icon } from '../../Icon'
import type { DeviceViewProps } from '../types'
import { EQ_BAND_COUNT, EQ_GAIN_RANGE, EQ_OUTPUT_ID, EQ_SLOPES, EQ_TYPE_LABELS, EQ_TYPE_MENU, EqState, EqType, eqBandDefault, eqBandInUse, eqBandResponseDb, eqParamId, eqResponseDb, readEqBands, typeHasGain, typeHasQ, typeHasSlope, type EqBand, type EqField, type EqTypeValue } from '../../../devices/effects/eqModel'
import { effectDeviceName } from '../../../core/sigimsaeDevices'
import { CurveGraph, type GraphNode } from './CurveGraph'
import { EditorDialog, NumberField } from './EditorDialog'
import { formatDb, formatHz, noteName, parseHz } from './scale'
import { useAnalysisTap } from './useSpectrum'
import './eq.css'

/** Display sample rate for the drawn curve (the audible curve matches it to within a hair below 15 kHz). */
const DISPLAY_RATE = 48000
const bandColor = (n: number) => `var(--eq-c${n})`
const round = (value: number, digits: number) => Number(value.toPrecision(digits))
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

type BandPatch = Partial<Record<EqField, number>>
function patchParams(band: number, patch: BandPatch): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [field, value] of Object.entries(patch)) if (value !== undefined) out[eqParamId(band, field as EqField)] = value
  return out
}

/** The node's vertical position: gain for bells/shelves, the curve height for cuts, 0 dB for a notch. */
function nodeDb(band: EqBand): number {
  if (typeHasGain(band.type)) return band.gain
  if (band.type === EqType.notch) return 0
  return clamp(eqBandResponseDb(band, band.freq, DISPLAY_RATE), -EQ_GAIN_RANGE, EQ_GAIN_RANGE)
}
const bandSummary = (band: EqBand) => `${EQ_TYPE_LABELS[band.type]} · ${formatHz(band.freq)}${typeHasGain(band.type) ? ` · ${formatDb(band.gain)}` : ''}${typeHasQ(band.type) ? ` · Q ${band.q.toFixed(2)}` : ''}${typeHasSlope(band.type) ? ` · ${EQ_SLOPES[band.slope]} dB/oct` : ''}`

export function TypeGlyph({ type, size = 18 }: { type: EqTypeValue; size?: number }) {
  const d: Record<EqTypeValue, string> = {
    [EqType.lowCut]: 'M2 12C5 12 6 4 10 4L18 4',
    [EqType.lowShelf]: 'M2 4L6 4C9 4 9 9 12 9L18 9',
    [EqType.bell]: 'M2 10L5 10C8 10 8 3 10 3C12 3 12 10 15 10L18 10',
    [EqType.notch]: 'M2 4L7.5 4C9 4 9.4 12 10 12C10.6 12 11 4 12.5 4L18 4',
    [EqType.highShelf]: 'M2 9L8 9C11 9 11 4 14 4L18 4',
    [EqType.highCut]: 'M2 4L10 4C14 4 15 12 18 12',
  }
  return <svg className="eqv-glyph" width={size} height={size * 0.7} viewBox="0 0 20 14" aria-hidden="true"><path d={d[type]}/></svg>
}

/** Shared state + edit operations for the compact card and the large editor. */
function useEqModel({ device, value, onParams }: DeviceViewProps) {
  const bands = useMemo(() => readEqBands(value), [device.params]) // eslint-disable-line react-hooks/exhaustive-deps
  const output = value(EQ_OUTPUT_ID)
  const response = useCallback((f: number) => eqResponseDb(bands, output, f, DISPLAY_RATE), [bands, output])
  const nodeResponse = useCallback((key: number, f: number) => eqBandResponseDb(bands[key - 1], f, DISPLAY_RATE), [bands])
  const gesture = useRef<{ band: EqBand; id: string } | null>(null)
  const [message, setMessage] = useState('')

  const edit = (band: number, patch: BandPatch, label: string, mergeKey?: string) => onParams(patchParams(band, patch), { label, mergeKey })
  const ops = {
    dragStart(key: number, source: 'pointer' | 'keyboard') {
      gesture.current = { band: bands[key - 1], id: source === 'keyboard' ? `eq-key-${key}` : `eq-drag-${key}-${Date.now()}` }
    },
    drag(key: number, freq: number, db: number, deltaDb: number) {
      const g = gesture.current
      if (!g || g.band.index !== key) return
      const band = g.band, patch: BandPatch = { freq: round(clamp(freq, 20, 20000), 4) }
      if (typeHasGain(band.type)) patch.gain = Math.round(clamp(db, -EQ_GAIN_RANGE, EQ_GAIN_RANGE) * 10) / 10
      else patch.q = round(clamp(band.q * Math.pow(2, deltaDb / 6), 0.1, 18), 3)
      edit(key, patch, 'EQ 밴드 조절', g.id)
    },
    dragEnd() { gesture.current = null },
    step(key: number, steps: number, fine: boolean) {
      const band = bands[key - 1]
      if (typeHasSlope(band.type)) { const slope = clamp(band.slope + steps, 0, 3); if (slope !== band.slope) edit(key, { slope }, 'EQ 기울기 변경', `eq-slope-${key}`) }
      else if (typeHasQ(band.type)) edit(key, { q: round(clamp(band.q * Math.pow(2, steps * (fine ? 1 / 24 : 1 / 6)), 0.1, 18), 3) }, 'EQ Q 조절', `eq-q-${key}`)
      else setMessage('셸프는 기울기가 고정되어 있어 Q 대신 게인과 주파수로 조절합니다.')
    },
    toggle(key: number) { const on = bands[key - 1].on; edit(key, { on: on ? EqState.bypassed : EqState.on }, on ? 'EQ 밴드 바이패스' : 'EQ 밴드 켜기') },
    reset(key: number) {
      const band = bands[key - 1]
      if (typeHasGain(band.type)) edit(key, { gain: 0 }, 'EQ 게인 초기화')
      else edit(key, { q: 0.71 }, 'EQ Q 초기화')
    },
    remove(key: number) { const d = eqBandDefault(key); edit(key, { on: 0, type: d.type, freq: d.freq, gain: 0, q: d.q, slope: 0 }, 'EQ 밴드 삭제') },
    setType(key: number, type: EqTypeValue) {
      const band = bands[key - 1], patch: BandPatch = { type, on: 1 }
      if (typeHasSlope(type) && !typeHasSlope(band.type)) { patch.q = 0.71; patch.slope = Math.max(band.slope, 1) }
      if (!typeHasSlope(type) && typeHasSlope(band.type)) patch.q = 1
      edit(key, patch, 'EQ 밴드 모양 변경')
    },
    set(key: number, patch: BandPatch, label = 'EQ 밴드 값 입력') { edit(key, patch, label) },
    /** Adds a band at a point; returns its number, or null when all eight are in use. */
    add(freq: number, db: number, type?: EqTypeValue): number | null {
      const free = bands.find(band => !eqBandInUse(band))
      if (!free) { setMessage(`밴드 ${EQ_BAND_COUNT}개를 모두 쓰고 있습니다. 쓰지 않는 밴드를 지우고 추가하세요.`); return null }
      const t = type ?? (freq < 32 ? EqType.lowCut : freq > 15000 ? EqType.highCut : EqType.bell)
      edit(free.index, { on: 1, type: t, freq: round(clamp(freq, 20, 20000), 4), gain: typeHasGain(t) ? Math.round(clamp(db, -EQ_GAIN_RANGE, EQ_GAIN_RANGE) * 10) / 10 : 0, q: typeHasSlope(t) ? 0.71 : 1, slope: 1 }, 'EQ 밴드 추가')
      setMessage('')
      return free.index
    },
    output(db: number) { onParams({ [EQ_OUTPUT_ID]: Math.round(clamp(db, -24, 24) * 10) / 10 }, { label: 'EQ 출력 게인', mergeKey: 'eq-output' }) },
  }
  const nodes: GraphNode[] = bands.filter(eqBandInUse).map(band => ({
    key: band.index, freq: band.freq, db: nodeDb(band), color: bandColor(band.index), on: band.on, tag: String(band.index),
    label: `밴드 ${band.index} ${band.on ? '' : '(바이패스) '}${bandSummary(band)}`,
  }))
  return { bands, output, response, nodeResponse, ops, nodes, message, setMessage }
}

function menuItems(model: ReturnType<typeof useEqModel>, key: number | null, freq: number, db: number, select: (key: number | null) => void): ContextMenuItem[] {
  const { ops, bands } = model
  if (key === null) {
    return [{ label: `${formatHz(freq)}에 밴드 추가`, icon: 'plus', items: EQ_TYPE_MENU.map(type => ({ label: EQ_TYPE_LABELS[type], onSelect: () => select(ops.add(freq, db, type)) })) }]
  }
  const band = bands[key - 1]
  const items: ContextMenuItem[] = EQ_TYPE_MENU.map(type => ({ label: EQ_TYPE_LABELS[type], checked: band.type === type, onSelect: () => ops.setType(key, type) }))
  items.push({ type: 'separator' })
  if (typeHasSlope(band.type)) items.push({ label: '기울기', items: EQ_SLOPES.map((slope, value) => ({ label: `${slope} dB/oct`, checked: band.slope === value, onSelect: () => ops.set(key, { slope: value }, 'EQ 기울기 변경') })) })
  items.push({ label: band.on ? '밴드 끄기 (바이패스)' : '밴드 켜기', icon: 'power', shortcut: 'Alt+클릭', onSelect: () => ops.toggle(key) })
  items.push({ label: typeHasGain(band.type) ? '게인 0 dB로' : 'Q 초기화', icon: 'refresh', shortcut: '더블클릭', onSelect: () => ops.reset(key) })
  items.push({ label: '밴드 삭제', icon: 'trash', danger: true, shortcut: 'Del', onSelect: () => { ops.remove(key); select(null) } })
  return items
}

const GRAPH_HINT = '더블클릭: 밴드 추가 · 드래그: 주파수/게인 · 휠: Q(컷은 기울기) · Shift: 미세 · Alt+클릭: 켜기/끄기 · 우클릭: 모양 메뉴 · 방향키: 선택 밴드 이동'

/** "Curve 8" card body: a live, draggable mini curve plus an expander to the full editor. */
export function EqView(props: DeviceViewProps) {
  const model = useEqModel(props)
  const [selected, setSelected] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; key: number | null; freq: number; db: number } | null>(null)
  const tap = useAnalysisTap(props.device.id, props.device.enabled)
  const band = selected ? model.bands[selected - 1] : null
  const name = effectDeviceName(props.device)
  return <div className="eqv">
    <div className="eqv-graph">
      <CurveGraph compact nodes={model.nodes} response={model.response} nodeResponse={model.nodeResponse} range={18} selected={selected} onSelect={setSelected}
        onDragStart={model.ops.dragStart} onDrag={model.ops.drag} onDragEnd={model.ops.dragEnd} onStep={model.ops.step} onToggle={model.ops.toggle}
        onReset={model.ops.reset} onRemove={key => { model.ops.remove(key); setSelected(null) }} onAdd={(f, db) => setSelected(model.ops.add(f, db))}
        onMenu={(key, x, y, freq, db) => setMenu({ x, y, key, freq, db })} spectrum={tap} ariaLabel={`${name} 주파수 응답 그래프`}/>
      <button className="eqv-expand" onClick={() => setOpen(true)} title="큰 편집기 열기" aria-label={`${name} 큰 편집기 열기`}><Icon name="fit" size={12}/></button>
    </div>
    <div className="eqv-bar">
      <div className="eqv-chips" role="group" aria-label="EQ 밴드">
        {model.bands.map(b => <button key={b.index} className={`eqv-chip${b.on ? ' is-on' : eqBandInUse(b) ? ' is-bypassed' : ''}${selected === b.index ? ' is-selected' : ''}`} style={{ '--node': bandColor(b.index) } as React.CSSProperties}
          aria-pressed={b.on} aria-label={`밴드 ${b.index} ${b.on ? '켜짐' : b.bypassed ? '바이패스' : '비어 있음'} · ${bandSummary(b)}`} title={`밴드 ${b.index} · ${bandSummary(b)}\n클릭: 선택(빈 밴드는 추가) · Alt+클릭: 켜기/끄기`}
          onClick={event => { if (event.altKey) model.ops.toggle(b.index); else { if (!eqBandInUse(b)) model.ops.set(b.index, { on: 1 }, 'EQ 밴드 추가'); setSelected(b.index) } }}>{b.index}</button>)}
      </div>
    </div>
    <p className="eqv-readout" aria-live="polite">{model.message || (band ? <><b style={{ color: bandColor(band.index) }}>{band.index}</b> {bandSummary(band)}{band.on ? '' : band.bypassed ? ' · 바이패스' : ' · 비어 있음'}</> : '노드를 끌어 조절 · 빈 곳 더블클릭으로 밴드 추가')}</p>
    {menu && !open && <ContextMenu x={menu.x} y={menu.y} label="EQ 밴드 메뉴" items={menuItems(model, menu.key, menu.freq, menu.db, setSelected)} onClose={() => setMenu(null)}/>}
    {open && <EqEditor {...props} model={model} selected={selected} onSelect={setSelected} spectrum={tap} onClose={() => setOpen(false)}/>}
  </div>
}

function EqEditor(props: DeviceViewProps & { model: ReturnType<typeof useEqModel>; selected: number | null; onSelect(key: number | null): void; spectrum: ReturnType<typeof useAnalysisTap>; onClose(): void }) {
  const { model, selected, onSelect } = props
  const [range, setRange] = useState(12)
  const [analyzer, setAnalyzer] = useState(true)
  const [notes, setNotes] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; key: number | null; freq: number; db: number } | null>(null)
  const band = selected ? model.bands[selected - 1] : null
  // Only while an engine streams this device's analysis (none does yet: devices/effects/analysis.ts).
  const web = !!props.spectrum
  const hz = (v: number) => formatHz(v)
  return <EditorDialog eyebrow="SIGIMSAE · PARAMETRIC EQ" title={effectDeviceName(props.device)} subtitle={`파라메트릭 EQ · 밴드 ${model.bands.filter(b => b.on).length}/${EQ_BAND_COUNT} 사용`} onClose={props.onClose}
    hint={GRAPH_HINT}
    actions={<>
      <div className="sgd-seg" role="radiogroup" aria-label="그래프 범위">{[6, 12, 24].map(r => <button key={r} role="radio" aria-checked={range === r} className={range === r ? 'is-on' : ''} onClick={() => setRange(r)}>±{r}</button>)}</div>
      <button className={`sgd-toggle${analyzer && web ? ' is-on' : ''}`} aria-pressed={analyzer && web} disabled={!web} onClick={() => setAnalyzer(a => !a)} title={web ? '스펙트럼 분석기 (EQ 뒤 신호)' : '스펙트럼 분석기는 아직 오디오 엔진에서 지원하지 않습니다'}><Icon name="synth" size={14}/>분석기</button>
      <button className={`sgd-toggle${notes ? ' is-on' : ''}`} aria-pressed={notes} onClick={() => setNotes(n => !n)} title="음이름 표시"><Icon name="note" size={14}/>음이름</button>
    </>}>
    <div className="eqe-graph">
      <CurveGraph nodes={model.nodes} response={model.response} nodeResponse={model.nodeResponse} range={range} selected={selected} onSelect={onSelect}
        onDragStart={model.ops.dragStart} onDrag={model.ops.drag} onDragEnd={model.ops.dragEnd} onStep={model.ops.step} onToggle={model.ops.toggle}
        onReset={model.ops.reset} onRemove={key => { model.ops.remove(key); onSelect(null) }} onAdd={(f, db) => onSelect(model.ops.add(f, db))}
        onMenu={(key, x, y, freq, db) => setMenu({ x, y, key, freq, db })} spectrum={analyzer ? props.spectrum : undefined} showNotes={notes} ariaLabel="EQ 주파수 응답 그래프. 노드를 선택해 방향키로 조절"/>
      {!web && <span className="eqe-note">분석기: 오디오 엔진은 아직 스펙트럼을 보내지 않습니다</span>}
      {model.message && <span className="eqe-message" role="status">{model.message}</span>}
    </div>
    <div className="eqe-panel">
      <div className="eqe-bands" role="group" aria-label="밴드 선택">
        {model.bands.map(b => <button key={b.index} className={`eqe-band${b.on ? ' is-on' : eqBandInUse(b) ? ' is-bypassed' : ''}${selected === b.index ? ' is-selected' : ''}`} style={{ '--node': bandColor(b.index) } as React.CSSProperties}
          aria-pressed={selected === b.index} onClick={event => { if (event.altKey) model.ops.toggle(b.index); else { if (!eqBandInUse(b)) model.ops.set(b.index, { on: 1 }, 'EQ 밴드 추가'); onSelect(b.index) } }} title={`밴드 ${b.index} · ${bandSummary(b)}`}>
          <span className="eqe-band-num">{b.index}</span><TypeGlyph type={b.type} size={16}/><span className="eqe-band-freq">{eqBandInUse(b) ? formatHz(b.freq).replace(' ', '') : '추가'}</span>
        </button>)}
      </div>
      {band ? <div className="eqe-controls" style={{ '--node': bandColor(band.index) } as React.CSSProperties}>
        <button className={`eqe-power${band.on ? ' is-on' : ''}`} aria-pressed={band.on} onClick={() => model.ops.toggle(band.index)} title="밴드 켜기/끄기 (Alt+클릭)" aria-label={`밴드 ${band.index} 켜기/끄기`}><Icon name="power" size={14}/></button>
        <div className="eqe-types" role="radiogroup" aria-label="밴드 모양">
          {EQ_TYPE_MENU.map(type => <button key={type} role="radio" aria-checked={band.type === type} className={band.type === type ? 'is-on' : ''} onClick={() => model.ops.setType(band.index, type)} title={EQ_TYPE_LABELS[type]} aria-label={EQ_TYPE_LABELS[type]}><TypeGlyph type={type}/></button>)}
        </div>
        <NumberField label="주파수" value={band.freq} format={hz} parse={parseHz} suffix={notes ? noteName(band.freq) : undefined}
          step={(v, d, fine) => clamp(v * Math.pow(2, d * (fine ? 1 / 48 : 1 / 12)), 20, 20000)} onCommit={v => model.ops.set(band.index, { freq: round(clamp(v, 20, 20000), 4) })}/>
        <NumberField label="게인" value={band.gain} format={formatDb} parse={text => { const v = parseFloat(text.replace('−', '-')); return Number.isFinite(v) ? v : null }} disabled={!typeHasGain(band.type)}
          step={(v, d, fine) => clamp(v + d * (fine ? 0.1 : 0.5), -EQ_GAIN_RANGE, EQ_GAIN_RANGE)} onCommit={v => model.ops.set(band.index, { gain: Math.round(clamp(v, -EQ_GAIN_RANGE, EQ_GAIN_RANGE) * 10) / 10 })}/>
        <NumberField label="Q" value={band.q} format={v => typeHasQ(band.type) ? v.toFixed(2) : '고정'} parse={text => { const v = parseFloat(text); return Number.isFinite(v) ? v : null }} disabled={!typeHasQ(band.type)}
          step={(v, d, fine) => clamp(v * Math.pow(2, d * (fine ? 1 / 24 : 1 / 6)), 0.1, 18)} onCommit={v => model.ops.set(band.index, { q: round(clamp(v, 0.1, 18), 3) })}/>
        {typeHasSlope(band.type) && <label className="sgd-field"><span>기울기</span><select value={band.slope} onChange={event => model.ops.set(band.index, { slope: Number(event.target.value) }, 'EQ 기울기 변경')}>{EQ_SLOPES.map((slope, value) => <option key={value} value={value}>{slope} dB/oct</option>)}</select></label>}
        <button className="eqe-remove" onClick={() => { model.ops.remove(band.index); onSelect(null) }} title="밴드 삭제 (Del)"><Icon name="trash" size={13}/>삭제</button>
      </div> : <p className="eqe-empty">그래프의 노드나 위 밴드를 선택하세요. 빈 곳을 더블클릭하면 새 밴드가 생깁니다.</p>}
      <div className="eqe-output">
        <NumberField label="출력" value={model.output} format={formatDb} parse={text => { const v = parseFloat(text.replace('−', '-')); return Number.isFinite(v) ? v : null }}
          step={(v, d, fine) => clamp(v + d * (fine ? 0.1 : 0.5), -24, 24)} onCommit={model.ops.output}/>
      </div>
    </div>
    {menu && <ContextMenu x={menu.x} y={menu.y} label="EQ 밴드 메뉴" items={menuItems(model, menu.key, menu.freq, menu.db, onSelect)} onClose={() => setMenu(null)}/>}
  </EditorDialog>
}

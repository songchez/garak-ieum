import { useState, type ReactNode } from 'react'
import type { DeviceViewProps } from '../types'
import { formatMs, reverbEnvelopeDb, reverbRt60, sizeForRt60 } from './math'
import { BandStrip, Chips, CompactCard, Handle, Knobs, XYPad, clamp, defOf, show, stepValue, useDrag, useKeyAdjust, useOneShot } from './ui'

const FLOOR = -66
const WINDOWS = [0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6]

/** Little drawings for the space chips (홀 / 룸 / 플레이트 / 스프링). */
export const SPACE_ICONS: Record<number, ReactNode> = {
  0: <svg viewBox="0 0 24 16" aria-hidden="true" className="sx-chip-icon"><path d="M2 15V7l10-5 10 5v8M6 15V9.5a2 2 0 0 1 4 0V15M14 15V9.5a2 2 0 0 1 4 0V15"/></svg>,
  1: <svg viewBox="0 0 24 16" aria-hidden="true" className="sx-chip-icon"><path d="M5 5h11v10H5zM5 5l3-3h11v10l-3 3M16 5l3-3"/></svg>,
  2: <svg viewBox="0 0 24 16" aria-hidden="true" className="sx-chip-icon"><path d="M5 4h14v9H5zM2 1l3 3M22 1l-3 3M2 16l3-3M22 16l-3-3"/></svg>,
  3: <svg viewBox="0 0 24 16" aria-hidden="true" className="sx-chip-icon"><path d="M1 8h2c1-5 3-5 3 0s2 5 3 0 2-5 3 0 2 5 3 0 2-5 3 0 2 5 3 0h2"/></svg>,
}

/**
 * Decay picture (Pro-R / ChromaVerb / Valhalla): dry spike at 0, pre-delay gap, then the wet tail in
 * dB down to −60 (RT60 marker). Handle A at the start of the tail: sideways = pre-delay, up/down =
 * amount. Handle B at the −60 dB point: sideways = decay time (Size).
 */
function ReverbGraph({ props, w, h, big }: { props: DeviceViewProps; w: number; h: number; big?: boolean }) {
  const { value: p, onParams, defs } = props
  const space = p('type'), size = p('size'), amount = p('amount'), pre = p('predelay') / 1000
  const rt = reverbRt60(space, size)
  const [frozen, setFrozen] = useState<number | null>(null)
  const window = frozen ?? (WINDOWS.find(v => v >= (pre + rt) * 1.18) ?? 6)
  const left = big ? 30 : 6, right = 8, top = big ? 22 : 15, bottom = big ? 18 : 6
  const plotW = w - left - right, plotH = h - top - bottom
  const x = (t: number) => left + t / window * plotW
  const y = (dB: number) => top + clamp(-dB / -FLOOR, 0, 1) * plotH
  const reset = useOneShot('리버브 기본값')
  const unfreeze = () => setFrozen(null)

  const startDrag = useDrag<{ pre: number; amount: number; window: number }>({
    label: '프리딜레이·양 조절',
    start: () => { setFrozen(window); return { pre: p('predelay'), amount, window } },
    move(dx, dy, s) {
      const nextDb = clamp(20 * Math.log10(Math.max(0.001, s.amount)) - dy / plotH * -FLOOR, -40, 0)
      onParams({ predelay: clamp(Math.round(s.pre + dx / plotW * s.window * 1000), 0, 250), amount: clamp(Math.pow(10, nextDb / 20), 0, 1) })
    },
    restore: s => { setFrozen(null); onParams({ predelay: s.pre, amount: s.amount }) },
  })
  const tailDrag = useDrag<{ rt: number; size: number; window: number }>({
    label: '잔향 길이 조절',
    start: () => { setFrozen(window); return { rt, size, window } },
    move(dx, _dy, s) { onParams({ size: Math.round(sizeForRt60(space, Math.max(0.01, s.rt + dx / plotW * s.window)) * 1000) / 1000 }) },
    restore: s => { setFrozen(null); onParams({ size: s.size }) },
  })
  const startKeys = useKeyAdjust('프리딜레이·양 조절', (axis, sign, fine, coarse) => {
    if (axis === 'x') onParams({ predelay: stepValue(defOf(defs, 'predelay'), p('predelay'), sign, fine, coarse) })
    else onParams({ amount: stepValue(defOf(defs, 'amount'), amount, sign, fine, coarse) })
    return true
  })
  const tailKeys = useKeyAdjust('잔향 길이 조절', (axis, sign, fine, coarse) => {
    if (axis !== 'x') return false
    onParams({ size: stepValue(defOf(defs, 'size'), size, sign, fine, coarse) }); return true
  })

  const n = big ? 220 : 90, pts: string[] = []
  for (let i = 0; i <= n; i += 1) {
    const t = i / n * (window - pre)
    let dB = reverbEnvelopeDb(space, size, amount, t, FLOOR)
    if (Math.round(space) === 3) dB += 1.2 * Math.cos(2 * Math.PI * t / 0.0293) * (dB > FLOOR + 1 ? 1 : 0) // spring drip
    pts.push(`${x(pre + t).toFixed(1)},${y(dB).toFixed(1)}`)
  }
  const tailX = x(pre + rt), startY = y(reverbEnvelopeDb(space, size, amount, 0, FLOOR))
  const brightness = clamp(Math.log(p('tone') / 1000) / Math.log(20), 0, 1)
  const gradient = `sx-rv-${props.device.id}-${big ? 'b' : 's'}`
  return <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} className={big ? 'sx-svg sx-big' : 'sx-svg'} onPointerUp={unfreeze} aria-label={`리버브 잔향 그림: RT60 ${formatMs(rt)}, 프리딜레이 ${formatMs(pre)}`}>
    <defs><linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity={0.25 + 0.5 * brightness}/><stop offset="1" stopColor="var(--accent)" stopOpacity={0.04}/></linearGradient></defs>
    <rect x={left} y={top - 2} width={plotW} height={plotH + 4} rx={3} className="sx-plot"/>
    {[-20, -40, -60].map(dB => <g key={dB}><line x1={left} x2={w - right} y1={y(dB)} y2={y(dB)} className={dB === -60 ? 'sx-axis sx-dashed' : 'sx-grid'}/>{big && <text x={left - 4} y={y(dB) + 3} className="sx-tiny" textAnchor="end">{dB}</text>}</g>)}
    {big && WINDOWS.filter(v => v < window).concat([0.25, 0.1].filter(v => v < window && window <= 1)).map(t => <text key={t} x={x(t)} y={h - 5} className="sx-tiny" textAnchor="middle">{formatMs(t)}</text>)}
    {pre > 0 && <rect x={x(0)} y={top} width={x(pre) - x(0)} height={plotH} className="sx-predelay"/>}
    <line x1={x(0)} x2={x(0)} y1={top} y2={top + plotH} className="sx-dry"/>
    <polygon points={`${x(pre).toFixed(1)},${y(FLOOR)} ${pts.join(' ')} ${x(window)},${y(FLOOR)}`} fill={`url(#${gradient})`}/>
    <polyline points={pts.join(' ')} className="sx-curve"/>
    <line x1={tailX} x2={tailX} y1={top} y2={top + plotH} className="sx-marker"/>
    <Handle cx={x(pre)} cy={startY} r={big ? 6 : 4.5} label="잔향 시작 (좌우: 프리딜레이, 위아래: 양)" valueText={`프리딜레이 ${show(defs, 'predelay', p('predelay'))}, 양 ${show(defs, 'amount', amount)}`}
      onPointerDown={startDrag} keys={startKeys} onReset={() => reset(() => onParams({ predelay: defOf(defs, 'predelay').default, amount: defOf(defs, 'amount').default }))}/>
    <Handle cx={tailX} cy={y(-60)} r={big ? 6 : 4.5} className="sx-handle--alt" label="잔향 길이 RT60 (좌우)" valueText={`RT60 ${formatMs(rt)} (크기 ${show(defs, 'size', size)})`}
      onPointerDown={tailDrag} keys={tailKeys} onReset={() => reset(() => onParams({ size: defOf(defs, 'size').default }))}/>
    <text x={left + 3} y={big ? 15 : 10} className={big ? 'sx-label' : 'sx-tiny sx-strong'}>RT60 {formatMs(rt)}<tspan className="sx-tiny" dx={5}>프리딜레이 {formatMs(pre)}</tspan></text>
    <text x={w - right - (big ? 0 : 20)} y={big ? 15 : 10} className="sx-tiny" textAnchor="end">{defOf(defs, 'type').options?.find(o => o.value === Math.round(space))?.label} · 양 {show(defs, 'amount', amount)}</text>
  </svg>
}

/** A box that grows with Size and brightens with Tone, drawn behind the XY pad cursor. */
function RoomPicture({ props, w, h }: { props: DeviceViewProps; w: number; h: number }) {
  const s = 0.25 + 0.75 * props.value('size'), bw = (w - 30) * s, bh = (h - 30) * s, cx = w / 2, cy = h / 2 + 4
  const d = 10 * s, op = 0.2 + 0.5 * clamp(Math.log(props.value('tone') / 1000) / Math.log(20), 0, 1)
  return <g className="sx-room" style={{ opacity: op }} aria-hidden="true">
    <rect x={cx - bw / 2} y={cy - bh / 2} width={bw} height={bh}/>
    <path d={`M${cx - bw / 2} ${cy - bh / 2}l${d} ${-d}h${bw}v${bh}l${-d} ${d}M${cx + bw / 2} ${cy - bh / 2}l${d} ${-d}`}/>
  </g>
}

export function ReverbView(props: DeviceViewProps) {
  const def = (id: string) => defOf(props.defs, id)
  return <CompactCard props={props} icon="reverb" editorTitle="리버브"
    graph={<ReverbGraph props={props} w={244} h={96}/>}
    controls={<>
      <Chips def={def('type')} value={props.value('type')} onChange={v => props.onParam('type', v)} label="공간 종류" icons={SPACE_ICONS} className="sx-chips--fill"/>
      <Knobs props={props} ids={['amount', 'size', 'tone', 'lowcut']}/>
    </>}
    editor={() => <div className="sx-editor">
      <ReverbGraph props={props} w={720} h={230} big/>
      <BandStrip defs={props.defs} lowId="lowcut" highId="tone" value={props.value} onParam={props.onParam} width={720} height={40} label="잔향 대역 (로우컷·톤)"/>
      <div className="sx-editor-row">
        <section className="sx-panel"><h4>공간</h4><Chips def={def('type')} value={props.value('type')} onChange={v => props.onParam('type', v)} label="공간 종류" icons={SPACE_ICONS} className="sx-chips--big"/>
          <p className="sx-note">홀은 부드럽고 길게, 룸은 짧고 빠르게, 플레이트는 밝고 촘촘하게, 스프링은 ‘뚝뚝’ 떨어지는 금속 울림입니다.</p></section>
        <section className="sx-panel"><h4>크기 × 밝기</h4><XYPad defs={props.defs} xId="size" yId="tone" value={props.value} onParams={props.onParams} label="공간 크기와 밝기" width={210} height={140} yLabel="밝기(톤)">
          <RoomPicture props={props} w={210} h={140}/></XYPad></section>
        <section className="sx-panel"><h4>세밀 조절</h4><Knobs props={props} ids={['amount', 'size', 'tone', 'predelay', 'lowcut']} size={40}/></section>
      </div>
    </div>}/>
}

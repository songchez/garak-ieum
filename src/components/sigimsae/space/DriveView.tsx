import { useMemo } from 'react'
import type { DeviceViewProps } from '../types'
import { crushSequence, driveTransfer, harmonics, tapeTransfer } from './math'
import { CompactCard, Handle, Knobs, XYPad, clamp, defOf, show, stepValue, useDrag, useKeyAdjust, useOneShot } from './ui'

type SatType = 'drive' | 'tape'
const TEST = 0.5 // test sine peak (−6 dBFS)

/**
 * Saturn / Decapitator style: the transfer curve (input → output) beside a sine before (dim) and
 * after (bright). The dot sits where the −6 dBFS test sine peaks; drag up/down anywhere on the
 * curve panel = drive, sideways = mix. Big view adds the harmonic spectrum of that sine.
 */
function SatGraph({ props, type, w, h, big }: { props: DeviceViewProps; type: SatType; w: number; h: number; big?: boolean }) {
  const { value: p, onParams, defs } = props
  const curve = useMemo(() => (type === 'drive' ? driveTransfer : tapeTransfer)(p),
    [type, p('drive'), p('mix'), p('output')])
  const pad = 6, top = big ? 22 : 13
  const sq = h - top - pad, cx = pad + sq / 2, cy = top + sq / 2, half = sq / 2 - 2
  const tx = (v: number) => cx + v * half, ty = (v: number) => cy - clamp(v, -1.15, 1.15) * half
  const n = big ? 160 : 80
  let transfer = ''
  for (let i = 0; i <= n; i += 1) { const x = -1 + 2 * i / n; transfer += `${i ? 'L' : 'M'}${tx(x).toFixed(1)} ${ty(curve(x)).toFixed(1)}` }
  const harmW = big ? 220 : 0
  const wx0 = pad + sq + 10, ww = w - wx0 - pad - (big ? harmW + 12 : 0)
  const wy = (v: number) => cy - clamp(v, -1.15, 1.15) * half
  let before = '', after = ''
  for (let i = 0; i <= n; i += 1) {
    const u = i / n, s = TEST * Math.sin(u * 1.5 * 2 * Math.PI)
    before += `${i ? 'L' : 'M'}${(wx0 + u * ww).toFixed(1)} ${wy(s).toFixed(1)}`
    after += `${i ? 'L' : 'M'}${(wx0 + u * ww).toFixed(1)} ${wy(curve(s)).toFixed(1)}`
  }
  const bars = useMemo(() => big ? harmonics(curve, TEST) : [], [big, curve])
  const reset = useOneShot('드라이브 기본값')
  const drag = useDrag<{ drive: number; mix: number }>({
    label: '드라이브 조절',
    start: () => ({ drive: p('drive'), mix: p('mix') }),
    move(dx, dy, s) {
      const dd = defOf(defs, 'drive')
      onParams({ drive: clamp(Math.round((s.drive - dy / sq * (dd.max - dd.min) * 0.9) * 10) / 10, dd.min, dd.max), mix: clamp(Math.round((s.mix + dx / sq * 0.8) * 100) / 100, 0, 1) })
    },
    restore: s => onParams({ drive: s.drive, mix: s.mix }),
  })
  const keys = useKeyAdjust('드라이브 조절', (axis, sign, fine, coarse) => {
    const id = axis === 'y' ? 'drive' : 'mix'
    onParams({ [id]: stepValue(defOf(defs, id), p(id), sign, fine, coarse) }); return true
  })
  const hx = pad + sq + 10 + ww + 12
  return <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} className={big ? 'sx-svg sx-big' : 'sx-svg'} aria-label={`전달 곡선과 사인파 전후: 드라이브 ${show(defs, 'drive', p('drive'))}`}>
    <g className="sx-drag-surface" onPointerDown={drag} onDoubleClick={e => { e.stopPropagation(); reset(() => onParams({ drive: defOf(defs, 'drive').default, mix: defOf(defs, 'mix').default })) }}>
      <rect x={pad} y={top} width={sq} height={sq} rx={3} className="sx-plot"/>
      <line x1={pad} x2={pad + sq} y1={cy} y2={cy} className="sx-grid"/><line x1={cx} x2={cx} y1={top} y2={top + sq} className="sx-grid"/>
      <line x1={tx(-1)} y1={ty(-1)} x2={tx(1)} y2={ty(1)} className="sx-axis sx-dashed"/>
      <rect x={tx(-TEST)} y={top} width={tx(TEST) - tx(-TEST)} height={sq} className="sx-predelay"/>
      <path d={transfer} className="sx-curve"/>
    </g>
    <Handle cx={tx(TEST)} cy={ty(curve(TEST))} r={big ? 6 : 4} label="드라이브 (위아래) · 믹스 (좌우)" valueText={`드라이브 ${show(defs, 'drive', p('drive'))}, 믹스 ${show(defs, 'mix', p('mix'))}`}
      onPointerDown={drag} keys={keys} onReset={() => reset(() => onParams({ drive: defOf(defs, 'drive').default, mix: defOf(defs, 'mix').default }))}/>
    <rect x={wx0} y={top} width={ww} height={sq} rx={3} className="sx-plot"/>
    <line x1={wx0} x2={wx0 + ww} y1={cy} y2={cy} className="sx-grid"/>
    <path d={before} className="sx-wave-before"/><path d={after} className="sx-curve"/>
    {big && <g>
      <rect x={hx} y={top} width={harmW} height={sq} rx={3} className="sx-plot"/>
      {bars.map((dB, i) => { const bw = harmW / bars.length, hgt = clamp((dB + 90) / 90, 0, 1) * (sq - 18)
        return <g key={i}><rect x={hx + i * bw + 4} y={top + sq - 14 - hgt} width={bw - 8} height={hgt} rx={2} className={i === 0 ? 'sx-harm sx-harm--f' : i % 2 ? 'sx-harm sx-harm--even' : 'sx-harm'}/>
          <text x={hx + i * bw + bw / 2} y={top + sq - 3} className="sx-tiny" textAnchor="middle">{i + 1}</text></g> })}
      <text x={hx + harmW} y={top - 5} className="sx-tiny" textAnchor="end">배음 (−6 dBFS 사인) · 짝수 따뜻함 · 홀수 거칠음</text>
    </g>}
    <text x={pad + 2} y={big ? 15 : 9} className={big ? 'sx-label' : 'sx-tiny sx-strong'}>{show(defs, 'drive', p('drive'))}<tspan className="sx-tiny" dx={5}>{big ? '입력 → 출력 곡선' : ''}</tspan></text>
    <text x={wx0 + ww - (big ? 0 : 20)} y={big ? top - 5 : 9} className="sx-tiny" textAnchor="end">{big ? '사인파 원음(흐림) → 결과' : `믹스 ${show(defs, 'mix', p('mix'))}`}</text>
  </svg>
}

/** Staircase (bit depth × sample-and-hold) on a 500 Hz sine, exactly the kernel's algorithm. */
function CrushGraph({ props, w, h, big }: { props: DeviceViewProps; w: number; h: number; big?: boolean }) {
  const { value: p, onParams, defs } = props
  const sampleRate = props.engine.getSnapshot().sampleRate || 48000
  const bits = p('bits'), down = p('downsample'), mix = p('mix')
  const period = sampleRate / 500, count = Math.round(period * (big ? 2 : 1.5))
  const crushed = useMemo(() => {
    const input = Float64Array.from({ length: count }, (_, i) => 0.9 * Math.sin(2 * Math.PI * i / period)), out = new Float64Array(count)
    crushSequence(input, bits, down, out)
    for (let i = 0; i < count; i += 1) out[i] = input[i] * (1 - mix) + out[i] * mix
    return { input, out }
  }, [count, period, bits, down, mix])
  const pad = 6, top = big ? 22 : 13, plotW = w - pad * 2, plotH = h - top - pad
  const x = (i: number) => pad + i / (count - 1) * plotW, y = (v: number) => top + (1 - (v + 1) / 2) * plotH
  let before = '', after = ''
  for (let i = 0; i < count; i += 1) {
    before += `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(crushed.input[i]).toFixed(1)}`
    after += i ? `H${x(i).toFixed(1)}V${y(crushed.out[i]).toFixed(1)}` : `M${x(0).toFixed(1)} ${y(crushed.out[0]).toFixed(1)}`
  }
  const reset = useOneShot('크러셔 기본값')
  const bd = defOf(defs, 'bits'), dd = defOf(defs, 'downsample')
  const drag = useDrag<{ bits: number; down: number }>({
    label: '비트·다운샘플 조절',
    start: () => ({ bits, down }),
    move(dx, dy, s) {
      onParams({ bits: clamp(Math.round((s.bits - dy / plotH * 15) * 10) / 10, bd.min, bd.max), downsample: clamp(Math.round(s.down * Math.pow(32, dx / plotW) * 100) / 100, dd.min, dd.max) })
    },
    restore: s => onParams({ bits: s.bits, downsample: s.down }),
  })
  const keys = useKeyAdjust('비트·다운샘플 조절', (axis, sign, fine, coarse) => {
    if (axis === 'y') onParams({ bits: stepValue(bd, bits, sign, fine, coarse) })
    else onParams({ downsample: stepValue(dd, down, sign, fine, coarse) })
    return true
  })
  const effective = sampleRate / down
  return <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} className={big ? 'sx-svg sx-big' : 'sx-svg'} aria-label={`계단 파형: ${show(defs, 'bits', bits)}, 샘플레이트 ${(effective / 1000).toFixed(1)} kHz`}>
    <g className="sx-drag-surface sx-focusable" role="slider" tabIndex={0} aria-label="계단 파형 (위아래: 비트, 좌우: 다운샘플)" aria-valuetext={`${show(defs, 'bits', bits)}, 다운샘플 ${show(defs, 'downsample', down)}`}
      onPointerDown={drag} {...keys} onDoubleClick={e => { e.stopPropagation(); reset(() => onParams({ bits: bd.default, downsample: dd.default })) }}>
      <title>위아래로 끌면 비트, 좌우로 끌면 다운샘플 (Shift 미세 · 더블 클릭 기본값)</title>
      <rect x={pad} y={top} width={plotW} height={plotH} rx={3} className="sx-plot"/>
      <line x1={pad} x2={pad + plotW} y1={y(0)} y2={y(0)} className="sx-grid"/>
      <path d={before} className="sx-wave-before"/>
      <path d={after} className="sx-curve sx-stairs"/>
    </g>
    <text x={pad + 2} y={big ? 15 : 9} className={big ? 'sx-label' : 'sx-tiny sx-strong'}>{show(defs, 'bits', bits)} · {(effective / 1000).toFixed(effective >= 10000 ? 1 : 2)} kHz<tspan className="sx-tiny" dx={5}>{big ? `500 Hz 사인 · 단계 ${Math.round(Math.pow(2, bits))}개` : ''}</tspan></text>
    <text x={w - pad - (big ? 0 : 20)} y={big ? 15 : 9} className="sx-tiny" textAnchor="end">↕ 비트 ↔ 다운샘플</text>
  </svg>
}

export function satView(type: SatType) {
  return function SatView(props: DeviceViewProps) {
    const ids = props.defs.map(d => d.id)
    return <CompactCard props={props} icon={type} editorTitle={type === 'drive' ? '진공관 드라이브' : '테이프 새츄레이션'}
      graph={<SatGraph props={props} type={type} w={244} h={96}/>}
      controls={<Knobs props={props} ids={ids}/>}
      editor={() => <div className="sx-editor">
        <SatGraph props={props} type={type} w={720} h={250} big/>
        <div className="sx-editor-row">
          <section className="sx-panel"><h4>드라이브 × 믹스</h4><XYPad defs={props.defs} xId="mix" yId="drive" value={props.value} onParams={props.onParams} label="드라이브와 믹스" width={220} height={140}/></section>
          <section className="sx-panel"><h4>세밀 조절</h4><Knobs props={props} ids={ids} size={40}/>
            <p className="sx-note">{type === 'drive' ? '대칭 곡선이라 홀수 배음(3·5·7…)이 생깁니다. 톤은 왜곡 뒤의 하이컷입니다.' : '테이프는 비대칭이라 짝수 배음(2·4…)이 더해져 따뜻해집니다. 온기는 고역을 줄이고 저역을 살짝 부풀립니다(곡선에는 안 보임).'}</p></section>
        </div>
      </div>}/>
  }
}

export function CrushView(props: DeviceViewProps) {
  return <CompactCard props={props} icon="bitcrusher" editorTitle="비트크러셔"
    graph={<CrushGraph props={props} w={244} h={96}/>}
    controls={<Knobs props={props} ids={['bits', 'downsample', 'mix']}/>}
    editor={() => <div className="sx-editor">
      <CrushGraph props={props} w={720} h={250} big/>
      <div className="sx-editor-row">
        <section className="sx-panel"><h4>다운샘플 × 비트</h4><XYPad defs={props.defs} xId="downsample" yId="bits" value={props.value} onParams={props.onParams} label="다운샘플과 비트" width={220} height={140}/></section>
        <section className="sx-panel"><h4>세밀 조절</h4><Knobs props={props} ids={['bits', 'downsample', 'mix']} size={40}/>
          <p className="sx-note">비트를 낮추면 계단이 굵어지고(잡음), 다운샘플을 올리면 계단이 넓어집니다(고역이 접혀 금속성 소리).</p></section>
      </div>
    </div>}/>
}

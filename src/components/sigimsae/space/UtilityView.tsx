import { useMemo, useRef } from 'react'
import type { DeviceViewProps } from '../types'
import { randomGenerator } from '../../../devices/effects/shared'
import { deviceAnalysisTap, type StereoScopeTap } from '../../../devices/effects/analysis'
import { utilityCorrelation, utilityLevelDb, utilityMatrix } from './math'
import { CompactCard, Handle, Knobs, Toggle, clamp, defOf, show, stepValue, useAnimation, useDrag, useKeyAdjust, useOneShot } from './ui'

const RHO = 0.6
/** A fixed stereo test signal (correlation 0.6, like a typical mix) for the image preview. */
const TEST_POINTS = (() => {
  const random = randomGenerator(424242), gauss = () => { let s = 0; for (let i = 0; i < 6; i += 1) s += random(); return (s - 3) * Math.SQRT2 }
  const out: [number, number][] = []
  for (let i = 0; i < 360; i += 1) { const a = gauss(), b = gauss(); out.push([a, RHO * a + Math.sqrt(1 - RHO * RHO) * b]) }
  return out
})()

/**
 * Goniometer (Ozone Imager / vectorscope): mid up, side across. On the web engine it draws the
 * device's real output (stereo scope tap, auto-gained) with its live correlation; without a tap
 * (desktop engine) or in silence it shows the fixed test signal through the utility matrix.
 */
function Goniometer({ props, size, big }: { props: DeviceViewProps; size: number; big?: boolean }) {
  const p = props.value
  const m = utilityMatrix(p)
  const r = size / 2 - 4, c = size / 2, k = r * 0.3
  const cloud = useMemo(() => {
    let d = ''
    for (const [l, rr] of TEST_POINTS) {
      const L = m[0][0] * l + m[0][1] * rr, R = m[1][0] * l + m[1][1] * rr
      const side = (L - R) / Math.SQRT2, mid = (L + R) / Math.SQRT2
      d += `M${(c + clamp(side * k, -r, r)).toFixed(1)} ${(c - clamp(mid * k, -r, r)).toFixed(1)}h0`
    }
    return d
  }, [m[0][0], m[0][1], m[1][0], m[1][1], size])
  const root = useRef<SVGSVGElement>(null), group = useRef<SVGGElement>(null), live = useRef<SVGPathElement>(null), status = useRef<SVGTextElement>(null)
  const buffers = useRef<[Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] | null>(null)
  const liveState = useRef('')
  useAnimation(root, props.device.enabled, () => {
    const tap = deviceAnalysisTap(props.device.id) as Partial<StereoScopeTap> | undefined
    let d = '', text = tap?.left ? '신호 대기 · 테스트 신호 미리보기' : '테스트 신호 미리보기'
    if (tap?.left && tap.right) {
      const n = tap.left.fftSize
      if (!buffers.current || buffers.current[0].length !== n) buffers.current = [new Float32Array(n), new Float32Array(n)]
      const [L, R] = buffers.current
      tap.left.getFloatTimeDomainData(L); tap.right.getFloatTimeDomainData(R)
      let sl = 0, sr = 0, slr = 0, peak = 0
      for (let i = 0; i < n; i += 1) { sl += L[i] * L[i]; sr += R[i] * R[i]; slr += L[i] * R[i]; peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])) }
      if (peak > 0.003) { // ~ −50 dBFS: below that the picture is noise
        const g = r * 0.62 / Math.max(0.12, peak)
        for (let i = 0; i < n; i += 2) {
          const side = (L[i] - R[i]) * g, mid = (L[i] + R[i]) * g
          d += `M${(c + clamp(side, -r, r)).toFixed(1)} ${(c - clamp(mid, -r, r)).toFixed(1)}h0`
        }
        text = `실시간 · 상관도 ${sl > 1e-9 && sr > 1e-9 ? (slr / Math.sqrt(sl * sr)).toFixed(2) : '—'}`
      }
    }
    live.current?.setAttribute('d', d)
    group.current?.setAttribute('opacity', d ? '0.12' : '1')
    if (status.current && liveState.current !== text) { liveState.current = text; status.current.textContent = text }
  })
  return <svg ref={root} viewBox={`0 0 ${size} ${size + (big ? 14 : 0)}`} width={size} height={size + (big ? 14 : 0)} className={big ? 'sx-svg sx-big' : 'sx-svg'} aria-label="스테레오 이미지 미리보기 (고니오미터)">
    <circle cx={c} cy={c} r={r} className="sx-plot"/>
    <line x1={c - r} x2={c + r} y1={c} y2={c} className="sx-grid"/><line x1={c} x2={c} y1={c - r} y2={c + r} className="sx-grid"/>
    <line x1={c - r * 0.707} y1={c - r * 0.707} x2={c + r * 0.707} y2={c + r * 0.707} className="sx-grid"/><line x1={c + r * 0.707} y1={c - r * 0.707} x2={c - r * 0.707} y2={c + r * 0.707} className="sx-grid"/>
    <g ref={group}><path d={cloud} className="sx-cloud" strokeWidth={big ? 2.4 : 1.8}/></g>
    <path ref={live} className="sx-cloud sx-cloud--live" strokeWidth={big ? 1.8 : 1.4}/>
    <text ref={status} x={c} y={size + 10} className="sx-tiny" textAnchor="middle" visibility={big ? 'visible' : 'hidden'}/>
    <text x={c - r * 0.72} y={c - r * 0.72 + (big ? 2 : 6)} className="sx-tiny" textAnchor="middle">L</text>
    <text x={c + r * 0.72} y={c - r * 0.72 + (big ? 2 : 6)} className="sx-tiny" textAnchor="middle">R</text>
    {big && <text x={c} y={c - r + 12} className="sx-tiny" textAnchor="middle">M</text>}
  </svg>
}

/** Stereo field: speakers at ±1, the image span is 2 × width wide around the balance; drag the edges = width, the middle = pan. */
function StereoField({ props, w, big }: { props: DeviceViewProps; w: number; big?: boolean }) {
  const { value: p, onParams, defs } = props
  const h = big ? 96 : 60, pad = 8, cy = big ? 44 : 27
  const unit = (w - pad * 2) / 4 // −2 … +2 speaker units
  const x = (u: number) => w / 2 + u * unit
  const mono = p('mono') >= 0.5, width = mono ? 0 : p('width'), pan = p('pan')
  const half = width * (1 - Math.abs(pan)), center = pan
  const corr = utilityCorrelation(p, RHO)
  const levelDb = utilityLevelDb(p, RHO), phaseLoss = Math.round(p('phase')) > 0 && levelDb < p('gain') - 4
  const reset = useOneShot('유틸리티 기본값')
  const edge = useDrag<{ width: number; side: number }>({
    label: '스테레오 폭 조절',
    start: event => ({ width: p('width'), side: (event.target as Element).closest('[data-side]')?.getAttribute('data-side') === 'L' ? -1 : 1 }),
    move(dx, _dy, s) { if (Math.abs(pan) > 0.98) return; onParams({ width: clamp(Math.round((s.width + s.side * dx / unit / (1 - Math.abs(pan))) * 100) / 100, 0, 2), ...(mono ? { mono: 0 } : {}) }) },
    restore: s => onParams({ width: s.width }),
  })
  const mid = useDrag<number>({
    label: '팬 조절',
    start: () => pan,
    move(dx, _dy, s) { onParams({ pan: clamp(Math.round((s + dx / unit) * 100) / 100, -1, 1) }) },
    restore: s => onParams({ pan: s }),
  })
  const widthKeys = useKeyAdjust('스테레오 폭 조절', (axis, sign, fine, coarse) => { if (axis !== 'x') return false; onParams({ width: stepValue(defOf(defs, 'width'), p('width'), sign, fine, coarse) }); return true })
  const panKeys = useKeyAdjust('팬 조절', (axis, sign, fine, coarse) => { if (axis !== 'x') return false; onParams({ pan: stepValue(defOf(defs, 'pan'), pan, sign, fine, coarse) }); return true })
  const cw = w - pad * 2, my = h - (big ? 20 : 15)
  return <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} className={big ? 'sx-svg sx-big' : 'sx-svg'} aria-label={`스테레오 폭 ${show(defs, 'width', width)}, 팬 ${show(defs, 'pan', pan)}`}>
    <rect x={x(-2)} y={cy - 9} width={unit * 4} height={18} rx={9} className="sx-field"/>
    <rect x={x(-1)} y={cy - 9} width={unit * 2} height={18} className="sx-field-in"/>
    {[-1, 1].map(u => <path key={u} d={`M${x(u) - 4} ${cy - 15}h8l-4 5z`} className="sx-speaker"/>)}
    <rect x={x(center - half)} y={cy - 6} width={Math.max(2, x(center + half) - x(center - half))} height={12} rx={6} className={`sx-span ${width > 1 ? 'sx-span--wide' : ''}`}
      onPointerDown={mid} onDoubleClick={e => { e.stopPropagation(); reset(() => onParams({ pan: 0 })) }}/>
    <Handle cx={x(center)} cy={cy} r={big ? 5 : 3.5} className="sx-handle--alt" label="팬 (좌우)" valueText={show(defs, 'pan', pan)} onPointerDown={mid} keys={panKeys} onReset={() => reset(() => onParams({ pan: 0 }))}/>
    {(['L', 'R'] as const).map(side => <g key={side} data-side={side}>
      <Handle cx={x(center + (side === 'L' ? -half : half))} cy={cy} r={big ? 6 : 4.5} label={`스테레오 폭 (${side === 'L' ? '왼쪽' : '오른쪽'} 끝)`}
        valueText={`폭 ${show(defs, 'width', width)}${mono ? ' (모노)' : ''}`} onPointerDown={edge} keys={widthKeys} onReset={() => reset(() => onParams({ width: 1, mono: 0 }))}/>
    </g>)}
    <text x={pad} y={cy - 19} className="sx-tiny">{mono ? '모노' : `폭 ${show(defs, 'width', width)}`}</text>
    <text x={w - pad - (big ? 0 : 18)} y={cy - 19} className="sx-tiny" textAnchor="end">팬 {show(defs, 'pan', pan)}</text>
    <rect x={pad} y={my - 3} width={cw} height={6} rx={3} className="sx-field"/>
    <line x1={w / 2} x2={w / 2} y1={my - 5} y2={my + 5} className="sx-grid"/>
    {corr !== null && <rect x={corr >= 0 ? w / 2 : w / 2 + corr * cw / 2} y={my - 3} width={Math.abs(corr) * cw / 2} height={6} rx={3} className={corr < 0 ? 'sx-corr sx-corr--bad' : 'sx-corr'}/>}
    <text x={pad} y={my + (big ? 13 : 9)} className="sx-tiny">−1</text><text x={w - pad} y={my + (big ? 13 : 9)} className="sx-tiny" textAnchor="end">+1</text>
    <text x={w / 2} y={my + (big ? 13 : 9)} className={`sx-tiny ${corr === null || corr < 0 || phaseLoss ? 'sx-warn' : ''}`} textAnchor="middle">{corr === null ? '모노 합산 시 소리가 사라짐' : `상관도 ${corr.toFixed(2)}${corr < 0 ? ' · 위상 주의' : phaseLoss ? ` · 레벨 ${levelDb.toFixed(1)} dB` : ''}`}</text>
  </svg>
}

function Switches({ props }: { props: DeviceViewProps }) {
  const p = props.value, phase = Math.round(p('phase'))
  return <div className="sx-row sx-switches">
    <Toggle on={p('mono') >= 0.5} label="모노" title="모노 합산 (폭 0)" onClick={() => props.onParam('mono', p('mono') >= 0.5 ? 0 : 1)}/>
    <Toggle on={(phase & 1) > 0} label="왼쪽 위상 반전" title="왼쪽 위상 반전 (Ø L)" onClick={() => props.onParam('phase', phase ^ 1)}>Ø L</Toggle>
    <Toggle on={(phase & 2) > 0} label="오른쪽 위상 반전" title="오른쪽 위상 반전 (Ø R)" onClick={() => props.onParam('phase', phase ^ 2)}>Ø R</Toggle>
  </div>
}

export function UtilityView(props: DeviceViewProps) {
  const level = utilityLevelDb(props.value, RHO)
  return <CompactCard props={props} icon="utility" editorTitle="유틸리티 · 게인/팬/폭"
    graph={<div className="sx-util">
      <Goniometer props={props} size={78}/>
      <div className="sx-util-side"><StereoField props={props} w={160}/><Switches props={props}/></div>
    </div>}
    controls={<Knobs props={props} ids={['gain', 'pan', 'width']}/>}
    editor={() => <div className="sx-editor">
      <div className="sx-editor-row sx-editor-row--top">
        <section className="sx-panel"><h4>스테레오 이미지</h4><Goniometer props={props} size={240} big/>
          <p className="sx-note">웹 엔진에서는 이 장치의 실제 출력을 그립니다(자동 크기). 소리가 없거나 데스크톱 엔진에서는 상관도 0.6 테스트 신호를 이 설정에 통과시킨 미리보기입니다.</p></section>
        <section className="sx-panel sx-grow"><h4>폭 · 팬</h4><StereoField props={props} w={420} big/><Switches props={props}/>
          <p className="sx-note">끝점을 끌면 폭(0 = 모노, 100% = 원래, 200% = 스피커 밖까지), 가운데를 끌면 팬입니다. 예상 출력 {level >= 0 ? '+' : ''}{level.toFixed(1)} dB.</p>
          <Knobs props={props} ids={['gain', 'pan', 'width']} size={40}/></section>
      </div>
    </div>}/>
}

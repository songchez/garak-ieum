import type { CSSProperties, ReactNode } from 'react'
import { adsrPath, damperPath, dbY, dcoPath, filterResponsePath, freqX, lfoPath, pickupPaths, tremoloPaths, type Box } from './curves'

/** Shared frame: an explanatory picture (role="img" with a text summary), not a live measurement. */
function Graph({ box, label, children, className }: { box: Box; label: string; children: ReactNode; className?: string }) {
  return <svg className={`vt-svg${className ? ` ${className}` : ''}`} viewBox={`0 0 ${box.w} ${box.h}`} role="img" aria-label={label}>
    {children}
  </svg>
}
const fmtHz = (f: number) => f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)} kHz` : `${Math.round(f)} Hz`

const PICKUP_BOX: Box = { w: 150, h: 96, pad: 6 }
export function PickupCurve({ bark, pickup }: { bark: number; pickup: number }) {
  const box = PICKUP_BOX, { curves } = pickupPaths(bark, pickup, [0.3, 1], box)
  return <figure className="vt-figure">
    <Graph box={box} label={`픽업 전달 곡선: 바크 ${Math.round(bark * 100)}%, 비대칭 ${Math.round(pickup * 100)}%. 약하게(0.3)와 세게(1.0) 친 소리`}>
      <line className="vt-grid" x1={box.w / 2} y1={0} x2={box.w / 2} y2={box.h}/><line className="vt-grid" x1={0} y1={box.h / 2} x2={box.w} y2={box.h / 2}/>
      <path className="vt-curve vt-curve--soft" d={curves[0]}/>
      <path className="vt-curve" d={curves[1]}/>
    </Graph>
    <figcaption><span className="vt-key vt-key--soft">약하게</span><span className="vt-key">세게</span></figcaption>
  </figure>
}

const DAMPER_BOX: Box = { w: 150, h: 64, pad: 4 }
export function DamperCurve({ release, decay, thump }: { release: number; decay: number; thump: number }) {
  const box = DAMPER_BOX, { line, area, keyUpX } = damperPath(release, decay, box)
  return <Graph box={box} label={`건반을 놓은 뒤 댐퍼가 소리를 멈추는 곡선: ${release < 1 ? Math.round(release * 1000) + ' ms' : release.toFixed(2) + ' s'}`}>
    <line className="vt-grid vt-grid--dash" x1={keyUpX} y1={0} x2={keyUpX} y2={box.h}/>
    <path className="vt-fill" d={area}/><path className="vt-curve" d={line}/>
    {thump > 0.001 && <path className="vt-curve vt-curve--accent2" d={`M${keyUpX.toFixed(1)} ${box.h - 4}l3 ${(-thump * (box.h - 12)).toFixed(1)}l3 ${(thump * (box.h - 12)).toFixed(1)}`}/>}
  </Graph>
}

const TREM_BOX: Box = { w: 180, h: 64, pad: 5 }
export function TremoloDisplay({ rate, depth, autopan }: { rate: number; depth: number; autopan: number }) {
  const box = TREM_BOX, { left, right } = tremoloPaths(rate, depth, autopan, box)
  const off = depth < 0.001
  return <figure className="vt-figure">
    <Graph box={box} label={`트레몰로 ${rate.toFixed(1)} Hz, 깊이 ${Math.round(depth * 100)}%, 오토팬 ${Math.round(autopan * 100)}%: 1초 동안의 왼쪽·오른쪽 음량`}>
      <path className="vt-curve" d={left}/>{autopan > 0.001 && <path className="vt-curve vt-curve--accent2" d={right}/>}
    </Graph>
    <figcaption>
      <span className="vt-key">L</span>{autopan > 0.001 && <span className="vt-key vt-key--accent2">R</span>}
      <span className="vt-pan" aria-hidden="true"><i data-off={off} style={{ '--vt-period': `${(1 / rate).toFixed(3)}s`, '--vt-pan': autopan, '--vt-depth': depth } as CSSProperties}/></span>
    </figcaption>
  </figure>
}

const DCO_BOX: Box = { w: 160, h: 60, pad: 5 }
export function DcoPreview(levels: { saw: number; pulse: number; pwm: number; sub: number; noise: number }) {
  const box = DCO_BOX
  const silent = levels.saw + levels.pulse + levels.sub + levels.noise < 0.001
  return <Graph box={box} label={`DCO 파형 미리보기: 톱니 ${Math.round(levels.saw * 100)}%, 펄스 ${Math.round(levels.pulse * 100)}%, 서브 ${Math.round(levels.sub * 100)}%, 노이즈 ${Math.round(levels.noise * 100)}%`}>
    <line className="vt-grid" x1={0} y1={box.h / 2} x2={box.w} y2={box.h / 2}/>
    {!silent && <path className="vt-curve" d={dcoPath(levels, box)}/>}
  </Graph>
}

const FILTER_BOX: Box = { w: 220, h: 96, pad: 5 }
export function FilterResponse({ cutoff, resonance, hpf }: { cutoff: number; resonance: number; hpf: number }) {
  const box = FILTER_BOX, { line, area } = filterResponsePath(cutoff, resonance, hpf, box), x = freqX(cutoff, box)
  return <Graph box={box} label={`필터 응답: 24 dB 로우패스 컷오프 ${fmtHz(cutoff)}, 레조넌스 ${Math.round(resonance * 100)}%`}>
    {[100, 1000, 10000].map(f => <line key={f} className="vt-grid" x1={freqX(f, box)} y1={0} x2={freqX(f, box)} y2={box.h}/>)}
    <line className="vt-grid vt-grid--dash" x1={0} y1={dbY(0, box)} x2={box.w} y2={dbY(0, box)}/>
    <path className="vt-fill" d={area}/><path className="vt-curve" d={line}/>
    <line className="vt-marker" x1={x} y1={0} x2={x} y2={box.h}/>
    <text className="vt-graph-text" x={Math.min(box.w - 4, x + 4)} y={11} textAnchor={x > box.w - 50 ? 'end' : 'start'}>{fmtHz(cutoff)}</text>
  </Graph>
}

const ADSR_BOX: Box = { w: 220, h: 80, pad: 6 }
export function AdsrGraph({ attack, decay, sustain, release, gate }: { attack: number; decay: number; sustain: number; release: number; gate: boolean }) {
  const box = ADSR_BOX, { line, area, points } = adsrPath({ attack, decay, sustain, release }, box)
  const pad = box.pad ?? 4
  return <Graph box={box} label={`엔벨로프: 어택 ${attack.toFixed(3)} s, 디케이 ${decay.toFixed(2)} s, 서스테인 ${Math.round(sustain * 100)}%, 릴리즈 ${release.toFixed(2)} s${gate ? ', VCA는 게이트' : ''}`}>
    <path className="vt-fill" d={area}/><path className="vt-curve" d={line}/>
    {gate && <path className="vt-curve vt-curve--accent2 vt-curve--dash" d={`M${pad} ${box.h - pad}V${pad}H${points[2][0].toFixed(1)}V${box.h - pad}`}/>}
    {points.map(([px, py], i) => <circle key={i} className="vt-dot" cx={px} cy={py} r={2.6}/>)}
  </Graph>
}

const LFO_BOX: Box = { w: 180, h: 56, pad: 5 }
export function LfoDisplay({ rate, delay }: { rate: number; delay: number }) {
  const box = LFO_BOX, { line, envelope } = lfoPath(rate, delay, box)
  return <Graph box={box} label={`LFO 삼각파 ${rate.toFixed(2)} Hz, 지연 ${delay.toFixed(2)} s (2초 동안)`}>
    <line className="vt-grid" x1={0} y1={box.h / 2} x2={box.w} y2={box.h / 2}/>
    <path className="vt-curve" d={line}/>{envelope && <path className="vt-curve vt-curve--accent2 vt-curve--dash" d={envelope}/>}
  </Graph>
}

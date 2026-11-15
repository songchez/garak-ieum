import { useMemo, useRef } from 'react'
import type { DeviceViewProps } from '../types'
import { chorusDelays, flangerDelays, flangerResponse, lfoRate, logFrequencies, phaserFrequency, phaserResponse, syncLabel, tremoloGains, type ModType } from './math'
import { Chips, CompactCard, Knobs, XYPad, clamp, defOf, freqX, useAnimation } from './ui'

const TAU = Math.PI * 2
const FREQS_SMALL = logFrequencies(120), FREQS_BIG = logFrequencies(360)

/** LFO output in display units for a type at phase (radians): [left, right] (right = null if mono). */
function lfoSides(type: ModType, p: (id: string) => number, phase: number): [number, number] {
  switch (type) {
    case 'chorus': { const [l, r] = chorusDelays(phase, p('depth')); return [(l - 9) / 13, (r - 9) / 13] }
    case 'flanger': { const [l, r] = flangerDelays(phase, p('depth')); return [l / 6.6, r / 6.6] }
    case 'phaser': return [Math.log(phaserFrequency(phase, p('depth'), 0) / 200) / Math.log(16), Math.log(phaserFrequency(phase, p('depth'), 1) / 200) / Math.log(16)]
    case 'tremolo': { const [l, r] = tremoloGains(phase, p('depth'), p('shape'), p('pan') >= 0.5); return [l, r] }
  }
}

const CAPTION: Record<ModType, string> = { chorus: '두 목소리의 지연 시간 (L/R 반대 방향)', flanger: '지연 시간 스윕 · 콤 필터', phaser: '노치 주파수 스윕 · 6단 올패스', tremolo: '음량 변화' }

/**
 * Animated LFO (Arturia / PhaseMistress / Crystallizer): two cycles of the modulation per side with a
 * moving playhead, and for phaser / flanger the live frequency response the LFO is sweeping. All
 * per-frame work writes DOM attributes through refs (no React renders) into preallocated arrays.
 */
function ModGraph({ props, type, w, h, big }: { props: DeviceViewProps; type: ModType; w: number; h: number; big?: boolean }) {
  const { value: p } = props
  const bpm = props.bpm ?? 120
  const rate = lfoRate(type, p, bpm)
  const autopan = type === 'tremolo' && p('pan') >= 0.5
  const hasResponse = type === 'phaser' || type === 'flanger'
  const hasField = type === 'tremolo'
  const pad = 6, top = big ? 20 : 13
  const fieldH = hasField ? (big ? 34 : 18) : 0
  const respH = hasResponse ? (h - top - pad) * 0.56 : 0
  const lfoTop = top + respH + (hasResponse ? 6 : 0), lfoH = h - lfoTop - pad - fieldH - (hasField ? 4 : 0)
  const plotW = w - pad * 2
  const lx = (u: number) => pad + u * plotW, ly = (v: number) => lfoTop + (1 - v) * lfoH
  const sampleRate = props.engine.getSnapshot().sampleRate || 48000

  const paths = useMemo(() => {
    const out: [string, string] = ['', '']
    for (let i = 0; i <= 120; i += 1) {
      const u = i / 120, [l, r] = lfoSides(type, p, u * 2 * TAU)
      out[0] += `${i ? 'L' : 'M'}${lx(u).toFixed(1)} ${ly(clamp(l, 0, 1)).toFixed(1)}`
      out[1] += `${i ? 'L' : 'M'}${lx(u).toFixed(1)} ${ly(clamp(r, 0, 1)).toFixed(1)}`
    }
    return out
  }, [type, p('depth'), p('shape'), p('pan'), w, h])

  const root = useRef<SVGSVGElement>(null)
  const dotL = useRef<SVGCircleElement>(null), dotR = useRef<SVGCircleElement>(null), head = useRef<SVGLineElement>(null)
  const resp = useRef<SVGPathElement>(null), respFill = useRef<SVGPathElement>(null), stereo = useRef<SVGCircleElement>(null), levelBar = useRef<SVGRectElement>(null)
  const FREQS = big ? FREQS_BIG : FREQS_SMALL
  const buffer = useRef(new Float64Array(FREQS.length))
  const ry = (dB: number) => top + clamp(-dB / 30 + 0.2, 0, 1) * respH
  const rx = (f: number) => pad + freqX(f, plotW)

  const running = useAnimation(root, props.device.enabled, seconds => {
    const cycles = seconds * rate, phase = (cycles % 1) * TAU + (seconds ? 0 : Math.PI / 2)
    const u = ((seconds ? cycles : 0.25) % 2) / 2
    const [l, r] = lfoSides(type, p, phase)
    head.current?.setAttribute('x1', lx(u).toFixed(1)); head.current?.setAttribute('x2', lx(u).toFixed(1))
    dotL.current?.setAttribute('cx', lx(u).toFixed(1)); dotL.current?.setAttribute('cy', ly(clamp(l, 0, 1)).toFixed(1))
    dotR.current?.setAttribute('cx', lx(u).toFixed(1)); dotR.current?.setAttribute('cy', ly(clamp(r, 0, 1)).toFixed(1))
    if (hasResponse && resp.current) {
      const out = buffer.current
      if (type === 'flanger') flangerResponse(FREQS, flangerDelays(phase, p('depth'))[0] / 1000, p('feedback'), p('mix'), out)
      else phaserResponse(FREQS, phaserFrequency(phase, p('depth'), 0), p('feedback'), p('mix'), sampleRate, out)
      let d = ''
      for (let i = 0; i < out.length; i += 1) d += `${i ? 'L' : 'M'}${rx(FREQS[i]).toFixed(1)} ${ry(out[i]).toFixed(1)}`
      resp.current.setAttribute('d', d)
      respFill.current?.setAttribute('d', `${d}L${rx(FREQS[FREQS.length - 1]).toFixed(1)} ${top + respH}L${rx(FREQS[0]).toFixed(1)} ${top + respH}Z`)
    }
    if (hasField) {
      const [gl, gr] = tremoloGains(phase, p('depth'), p('shape'), autopan)
      const pos = autopan ? (gr - gl) / Math.max(1e-6, gr + gl) : 0
      stereo.current?.setAttribute('cx', (w / 2 + pos * (plotW / 2 - 8)).toFixed(1))
      stereo.current?.setAttribute('r', ((big ? 4 : 3) + (big ? 6 : 3.5) * Math.max(gl, gr)).toFixed(1))
      levelBar.current?.setAttribute('width', (plotW * Math.max(gl, gr)).toFixed(1))
    }
  })

  const label = type === 'tremolo' && p('sync') > 0 ? `${syncLabel(p('sync'))} (${rate.toFixed(2)} Hz)` : `${rate < 1 ? rate.toFixed(2) : rate.toFixed(1)} Hz`
  const fieldY = h - pad - fieldH
  return <svg ref={root} viewBox={`0 0 ${w} ${h}`} width={w} height={h} className={big ? 'sx-svg sx-big' : 'sx-svg'} data-running={running} aria-label={`${CAPTION[type]}: 속도 ${label}`}>
    {hasResponse && <g>
      <rect x={pad} y={top - 2} width={plotW} height={respH + 2} rx={3} className="sx-plot"/>
      {[100, 1000, 10000].map(f => <line key={f} x1={rx(f)} x2={rx(f)} y1={top} y2={top + respH} className="sx-grid"/>)}
      {big && [100, 1000, 10000].map(f => <text key={f} x={rx(f) + 3} y={top + respH - 3} className="sx-tiny">{f >= 1000 ? `${f / 1000}k` : f}</text>)}
      <path ref={respFill} className="sx-resp-fill"/><path ref={resp} className="sx-curve"/>
    </g>}
    <rect x={pad} y={lfoTop - 2} width={plotW} height={lfoH + 4} rx={3} className="sx-plot"/>
    <line x1={lx(0.5)} x2={lx(0.5)} y1={lfoTop} y2={lfoTop + lfoH} className="sx-grid"/>
    {(type !== 'tremolo' || autopan) && <path d={paths[1]} className="sx-lfo sx-lfo--r"/>}
    <path d={paths[0]} className="sx-lfo"/>
    <line ref={head} y1={lfoTop} y2={lfoTop + lfoH} className="sx-playhead"/>
    {(type !== 'tremolo' || autopan) && <circle ref={dotR} r={big ? 4 : 3} className="sx-lfo-dot sx-lfo-dot--r"/>}
    <circle ref={dotL} r={big ? 4 : 3} className="sx-lfo-dot"/>
    {hasField && <g>
      <rect x={pad} y={fieldY} width={plotW} height={fieldH} rx={fieldH / 2} className="sx-field"/>
      {autopan ? <>
        <text x={pad + 6} y={fieldY + fieldH / 2 + 3} className="sx-tiny">L</text><text x={w - pad - 6} y={fieldY + fieldH / 2 + 3} className="sx-tiny" textAnchor="end">R</text>
        <circle ref={stereo} cy={fieldY + fieldH / 2} cx={w / 2} r={4} className="sx-stereo-dot"/>
      </> : <rect ref={levelBar} x={pad} y={fieldY + fieldH * 0.3} height={fieldH * 0.4} width={plotW} rx={fieldH * 0.2} className="sx-level"/>}
    </g>}
    <text x={pad + 2} y={big ? 14 : 9} className={big ? 'sx-label' : 'sx-tiny sx-strong'}>{label}<tspan className="sx-tiny" dx={5}>{big ? CAPTION[type] : autopan ? '오토팬' : ''}</tspan></text>
    <text x={w - pad - (big ? 0 : 20)} y={big ? 14 : 9} className="sx-tiny" textAnchor="end">{type !== 'tremolo' || autopan ? 'L ━ R ┅' : ''}</text>
  </svg>
}

const COMPACT: Record<ModType, string[]> = { chorus: ['rate', 'depth', 'mix'], phaser: ['rate', 'depth', 'feedback', 'mix'], flanger: ['rate', 'depth', 'feedback', 'mix'], tremolo: ['rate', 'depth', 'shape'] }
const TITLES: Record<ModType, { title: string; icon: string }> = { chorus: { title: '코러스', icon: 'chorus' }, phaser: { title: '페이저', icon: 'phaser' }, flanger: { title: '플랜저', icon: 'flanger' }, tremolo: { title: '트레몰로·오토팬', icon: 'tremolo' } }

export function modView(type: ModType) {
  return function ModView(props: DeviceViewProps) {
    const def = (id: string) => defOf(props.defs, id)
    const synced = type === 'tremolo' && props.value('sync') > 0
    const compactIds = synced ? COMPACT[type].map(id => id === 'rate' ? 'sync' : id) : COMPACT[type]
    return <CompactCard props={props} icon={TITLES[type].icon} editorTitle={TITLES[type].title}
      graph={<ModGraph props={props} type={type} w={244} h={type === 'tremolo' ? 92 : 100}/>}
      controls={<>
        {type === 'tremolo' && <Chips def={def('pan')} value={props.value('pan')} onChange={v => props.onParam('pan', v)} label="모드" className="sx-chips--fill"/>}
        <Knobs props={props} ids={compactIds}/>
      </>}
      editor={() => <div className="sx-editor">
        <ModGraph props={props} type={type} w={720} h={type === 'tremolo' ? 220 : 250} big/>
        <div className="sx-editor-row">
          <section className="sx-panel"><h4>속도 × 깊이</h4>
            <XYPad defs={props.defs} xId="rate" yId="depth" value={props.value} onParams={props.onParams} label="속도와 깊이" width={220} height={140}
              disabledX={synced ? `${syncLabel(props.value('sync'))} (템포)` : undefined}/></section>
          {type === 'tremolo' && <section className="sx-panel"><h4>템포 동기</h4>
            <Chips def={def('sync')} value={props.value('sync')} onChange={v => props.onParam('sync', v)} label="템포 동기 음표" className="sx-chips--grid"/>
            <Chips def={def('pan')} value={props.value('pan')} onChange={v => props.onParam('pan', v)} label="모드"/>
            <p className="sx-note">음표를 고르면 곡 템포를 따라 흔들립니다. ‘끔’이면 Hz 속도를 씁니다.</p></section>}
          <section className="sx-panel"><h4>세밀 조절</h4><Knobs props={props} ids={props.defs.map(d => d.id).filter(id => id !== 'pan')} size={40}/></section>
        </div>
      </div>}/>
  }
}

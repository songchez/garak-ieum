import { useState } from 'react'
import type { DeviceViewProps } from '../types'
import { delayParamsForTime, delayReadout, delayTime, delayWindow, echoTaps, formatMs, snapBeats } from './math'
import { BandStrip, Chips, CompactCard, Handle, Knobs, clamp, defOf, show, stepValue, useDrag, useKeyAdjust, useOneShot } from './ui'

/**
 * 메아리 Echo: repeats on a time axis (EchoBoy / Timeless / Ableton Echo). Left lane grows up, right
 * lane grows down; ping-pong alternates lanes. Drag any repeat sideways = time (snaps to note values
 * when synced; dragging repeat n moves the grid so repeat n lands under the pointer), up/down = feedback.
 */
function DelayGraph({ props, w, h, big }: { props: DeviceViewProps; w: number; h: number; big?: boolean }) {
  const { value: p, onParams, defs } = props
  const bpm = props.bpm ?? 120
  const synced = p('sync') >= 0.5
  const time = delayTime(p, bpm), feedback = p('feedback')
  const [frozen, setFrozen] = useState<number | null>(null)
  const window = frozen ?? delayWindow(time, feedback, p('amount'))
  const left = big ? 26 : 14, right = 8, top = big ? 22 : 15, bottom = big ? 18 : 4
  const plotW = w - left - right, mid = top + (h - top - bottom) / 2, laneH = (h - top - bottom) / 2 - 2
  const x = (t: number) => left + t / window * plotW
  const taps = echoTaps(p, bpm, window)
  /** Bars in dB (48 dB range) so quiet late repeats stay visible. */
  const level = (gain: number) => Math.max(0.04, 1 + 20 * Math.log10(Math.max(1e-6, gain)) / 48)
  const reset = useOneShot('딜레이 기본값')

  const drag = useDrag<{ n: number; t1: number; fb: number; window: number; time: number; ms: number }>({
    label: '메아리 시간·피드백 조절',
    start(event) {
      const n = Number((event.target as Element).closest('[data-tap]')?.getAttribute('data-tap') ?? 1) || 1
      setFrozen(window)
      return { n, t1: time, fb: feedback, window, time: p('time'), ms: p('ms') }
    },
    move(dx, dy, s) {
      const t = Math.max(0.001, (s.t1 * s.n + dx / plotW * s.window) / s.n)
      onParams({ ...delayParamsForTime(t, synced, bpm), feedback: clamp(s.fb - dy / (laneH * 2.5), 0, 0.95) })
    },
    restore(s) { setFrozen(null); onParams({ time: s.time, ms: s.ms, feedback: s.fb }) },
  })
  const up = () => setFrozen(null)
  const keys = useKeyAdjust('메아리 조절', (axis, sign, fine, coarse) => {
    if (axis === 'x') { const id = synced ? 'time' : 'ms'; onParams({ [id]: stepValue(defOf(defs, id), p(id), sign, fine, coarse) }) }
    else onParams({ feedback: stepValue(defOf(defs, 'feedback'), feedback, sign, fine, coarse) })
    return true
  })

  const readout = delayReadout(p, bpm)
  const beat = 60 / bpm
  const grid: number[] = []
  const step = synced ? (window / beat > 16 ? beat * 4 : window / beat > 6 ? beat : beat / 2) : window > 2 ? 0.5 : window > 0.6 ? 0.1 : 0.05
  for (let t = step; t < window - 1e-6; t += step) grid.push(t)
  const envelope = taps.map(tap => `${x(tap.time).toFixed(1)},${(mid - level(tap.gain) * laneH).toFixed(1)}`).join(' ')
  const barW = big ? 7 : 4
  const first = taps[0]
  return <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} className={big ? 'sx-svg sx-big' : 'sx-svg'} onPointerUp={up} aria-label={`딜레이 메아리 그림: ${readout.main}, 피드백 ${show(defs, 'feedback', feedback)}`}>
    <rect x={left} y={top - 2} width={plotW} height={h - top - bottom + 4} rx={3} className="sx-plot"/>
    {grid.map(t => <line key={t} x1={x(t)} x2={x(t)} y1={top} y2={h - bottom} className="sx-grid"/>)}
    <line x1={left} x2={w - right} y1={mid} y2={mid} className="sx-axis"/>
    <text x={left - 4} y={mid - laneH / 2 + 3} className="sx-tiny" textAnchor="end">L</text>
    <text x={left - 4} y={mid + laneH / 2 + 3} className="sx-tiny" textAnchor="end">R</text>
    {big && grid.filter((_, i) => i % 2 === 1 || grid.length < 8).map(t => <text key={t} x={x(t)} y={h - 5} className="sx-tiny" textAnchor="middle">{synced ? `${+(t / beat).toFixed(2)}박` : formatMs(t)}</text>)}
    <line x1={x(0)} x2={x(0)} y1={mid - laneH} y2={mid + laneH} className="sx-dry"/>
    {taps.length > 1 && <polyline points={envelope} className="sx-envelope"/>}
    {taps.length > 1 && <polyline points={taps.map(tap => `${x(tap.time).toFixed(1)},${(mid + level(tap.gain) * laneH).toFixed(1)}`).join(' ')} className="sx-envelope"/>}
    {taps.map(tap => {
      const hgt = level(tap.gain) * laneH, op = 0.35 + 0.65 * tap.brightness
      return <g key={tap.index} data-tap={tap.index} className="sx-tap" onPointerDown={drag} onDoubleClick={e => e.stopPropagation()} style={{ opacity: op }}>
        <rect x={x(tap.time) - 7} y={top} width={14} height={h - top - bottom} className="sx-handle-hit"/>
        {tap.lane !== 'R' && <rect x={x(tap.time) - barW / 2} y={mid - hgt} width={barW} height={hgt} rx={1.5} className="sx-tap-bar"/>}
        {tap.lane !== 'L' && <rect x={x(tap.time) - barW / 2} y={mid} width={barW} height={hgt} rx={1.5} className="sx-tap-bar sx-tap-bar--r"/>}
      </g>
    })}
    {first && <Handle cx={x(first.time)} cy={mid - level(first.gain) * laneH} r={big ? 6 : 4.5} label="첫 메아리 (좌우: 시간, 위아래: 피드백)"
      valueText={`${readout.main} (${readout.hint}), 피드백 ${show(defs, 'feedback', feedback)}`} onPointerDown={drag} keys={keys}
      onReset={() => reset(() => onParams({ time: defOf(defs, 'time').default, ms: defOf(defs, 'ms').default, feedback: defOf(defs, 'feedback').default }))}/>}
    <text x={left + 3} y={big ? 15 : 10} className={big ? 'sx-label' : 'sx-tiny sx-strong'}>{readout.main}<tspan className="sx-tiny" dx={4}>{readout.hint}</tspan></text>
    <text x={w - right - (big ? 0 : 20)} y={big ? 15 : 10} className="sx-tiny" textAnchor="end">{p('mode') >= 0.5 ? '핑퐁' : '스테레오'} · FB {show(defs, 'feedback', feedback)}{p('age') > 0.01 ? ' · 테이프' : ''}</text>
  </svg>
}

function NoteGrid({ props }: { props: DeviceViewProps }) {
  const def = defOf(props.defs, 'time')
  return <Chips def={def} value={props.value('time')} onChange={v => props.onParams({ time: v, sync: 1 })} label="박자 (음표 길이)" className="sx-chips--grid"/>
}

/** Switching 박자 ↔ ms keeps the current echo time (snapped to the nearest note when going to 박자). */
function setSync(props: DeviceViewProps, v: number) {
  const seconds = delayTime(props.value, props.bpm ?? 120)
  if (v >= 0.5) props.onParams({ sync: 1, time: snapBeats(seconds * (props.bpm ?? 120) / 60) })
  else props.onParams({ sync: 0, ms: Math.min(2000, Math.max(1, Math.round(seconds * 1000))) })
}

export function DelayView(props: DeviceViewProps) {
  const synced = props.value('sync') >= 0.5
  const def = (id: string) => defOf(props.defs, id)
  return <CompactCard props={props} icon="delay" editorTitle="스테레오 딜레이"
    graph={<>
      <DelayGraph props={props} w={244} h={84}/>
      <BandStrip defs={props.defs} lowId="lowcut" highId="tone" value={props.value} onParam={props.onParam} width={244} height={16} label="메아리 필터 대역 (로우컷·하이컷)"/>
    </>}
    controls={<>
      <div className="sx-row">
        <Chips def={def('sync')} value={props.value('sync')} onChange={v => setSync(props, v)} label="템포 동기"/>
        <Chips def={def('mode')} value={props.value('mode')} onChange={v => props.onParam('mode', v)} label="모드"/>
      </div>
      <Knobs props={props} ids={['amount', synced ? 'time' : 'ms', 'feedback', 'age']}/>
    </>}
    editor={() => <div className="sx-editor">
      <DelayGraph props={props} w={720} h={230} big/>
      <BandStrip defs={props.defs} lowId="lowcut" highId="tone" value={props.value} onParam={props.onParam} width={720} height={44} label="메아리 필터 대역 (로우컷·하이컷)"/>
      <div className="sx-editor-row">
        <section className="sx-panel"><h4>박자</h4>
          <div className="sx-row"><Chips def={def('sync')} value={props.value('sync')} onChange={v => setSync(props, v)} label="템포 동기"/><Chips def={def('mode')} value={props.value('mode')} onChange={v => props.onParam('mode', v)} label="모드"/></div>
          {synced ? <NoteGrid props={props}/> : <p className="sx-note">자유 시간(ms) 모드입니다. 그래프의 메아리를 좌우로 끌거나 ‘시간’ 노브로 맞추세요. 박자로 돌아가면 가장 가까운 음표로 맞춥니다.</p>}
        </section>
        <section className="sx-panel"><h4>세밀 조절</h4><Knobs props={props} ids={['amount', 'time', 'ms', 'feedback', 'tone', 'lowcut', 'age']} size={40}/></section>
      </div>
    </div>}/>
}

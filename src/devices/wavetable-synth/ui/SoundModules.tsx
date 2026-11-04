import { useMemo } from 'react'
import { WAVE_FACTORY_BANKS } from '../definition'
import type { WavetableParamId } from '../model'
import { ParamChoice, ParamKnob, ParamPower, useSynthEditor } from './editor-context'
import { bankFrames, bankName, interpolateFrame } from './data'
import { WavePlot, EnvelopePlot } from './graphs'
import { ModSource, SegmentControl } from './controls'

export function Oscillator({ number, onEdit }: { number: number; onEdit: (number: number) => void }) {
  const { patch, setParameter } = useSynthEditor(), prefix = 'osc' + number
  const bank = patch.params[(prefix + 'Bank') as WavetableParamId], position = patch.params[(prefix + 'Position') as WavetableParamId]
  const frames = useMemo(() => bankFrames(patch, bank), [bank, patch.customBanks])
  const currentFrame = useMemo(() => interpolateFrame(frames, position), [frames, position])
  const enabled = patch.params[(prefix + 'Enabled') as WavetableParamId] === 1
  return <section className={'iw-module iw-oscillator' + (enabled ? '' : ' is-disabled')} aria-label={'오실레이터 ' + number}>
    <header className="iw-module-heading"><div><span className="iw-module-number">{String(number).padStart(2, '0')}</span><h3>OSC <b>{number}</b></h3></div><ParamPower id={prefix + 'Enabled'} label={'OSC ' + number}/></header>
    <div className="iw-bank-select"><label><span className="iw-sr-only">{'OSC ' + number + ' 웨이브테이블'}</span><select value={bank} onChange={event => setParameter((prefix + 'Bank') as WavetableParamId, Number(event.target.value))}>{WAVE_FACTORY_BANKS.map(item => <option key={item.index} value={item.index}>{item.name}</option>)}{patch.customBanks.map(item => <option key={item.slot} value={item.slot}>{item.name}</option>)}</select></label><button title={'OSC ' + number + ' 파형 편집'} aria-label={'OSC ' + number + ' 파형 편집'} onClick={() => onEdit(number)}><svg viewBox="0 0 18 18" aria-hidden="true"><path d="m4 12 8-8 2 2-8 8-3 1zM10.5 5.5l2 2"/></svg></button></div>
    <div className="iw-osc-wave"><WavePlot samples={currentFrame} ghosts={frames.length > 1 ? [frames[0], frames[frames.length - 1]] : []} label={'OSC ' + number + ' ' + bankName(patch, bank) + ' 프레임 보간 파형'}/><div className="iw-wave-legend"><span>WAVETABLE</span><span>{frames.length ? (1 + position * (frames.length - 1)).toFixed(1) : '—'} <i>/ {frames.length}</i></span></div></div>
    <div className="iw-knobs iw-osc-main-knobs"><ParamKnob id={prefix + 'Position'} label="POSITION"/><ParamKnob id={prefix + 'Tune'} label="TUNE"/><ParamKnob id={prefix + 'Level'} label="LEVEL"/><ParamKnob id={prefix + 'Pan'} label="PAN"/></div>
    <div className="iw-unison-row"><ParamChoice id={prefix + 'Unison'} label="UNISON"/><ParamKnob id={prefix + 'Detune'} label="DETUNE" compact/><ParamKnob id={prefix + 'Spread'} label="SPREAD" compact/></div>
    <details className="iw-details"><summary>위상·미세 음정 <span>PHASE / FINE</span></summary><div className="iw-knobs"><ParamKnob id={prefix + 'Fine'} label="FINE" compact/><ParamKnob id={prefix + 'Phase'} label="PHASE" compact/><ParamKnob id={prefix + 'RandomPhase'} label="RANDOM" compact/></div><p className="iw-caption">RANDOM을 올리면 노트마다 시작 위상이 달라집니다.</p></details>
  </section>
}

export function Filters() {
  const { patch, setParameter } = useSynthEditor()
  return <section className="iw-module iw-filters" aria-label="듀얼 필터">
    <div className="iw-section-heading"><div><span className="iw-eyebrow">DUAL FILTER</span><h3>음색의 결을 다듬기</h3></div><SegmentControl label="필터 연결" value={patch.params.filterRouting} options={[{ value: 0, label: '직렬' }, { value: 1, label: '병렬' }]} onChange={value => setParameter('filterRouting', value)}/></div>
    <div className="iw-filter-pair">{[1, 2].map(number => <div key={number} className={'iw-filter' + (patch.params[('filter' + number + 'Enabled') as WavetableParamId] ? '' : ' is-disabled')}><div className="iw-filter-heading"><strong>{'FILTER ' + number}</strong><ParamPower id={'filter' + number + 'Enabled'} label={'FILTER ' + number}/></div><ParamChoice id={'filter' + number + 'Type'} label="TYPE"/><div className="iw-knobs"><ParamKnob id={'filter' + number + 'Cutoff'} label="CUTOFF"/><ParamKnob id={'filter' + number + 'Resonance'} label="RESONANCE"/></div></div>)}</div>
    <div className="iw-filter-routing"><span className="iw-routing-symbol" aria-hidden="true">{patch.params.filterRouting === 0 ? 'IN → F1 → F2 → OUT' : 'IN → F1 + F2 → OUT'}</span>{patch.params.filterRouting === 1 ? <ParamKnob id="filterBlend" label="F1 / F2" compact/> : <span>두 필터를 차례로 통과합니다.</span>}</div>
  </section>
}

export function SubNoise() {
  return <section className="iw-module iw-sub-noise" aria-label="서브와 노이즈"><div className="iw-section-heading"><div><span className="iw-eyebrow">SUB + NOISE</span><h3>바탕과 질감</h3></div></div><div className="iw-sub-content"><div className="iw-sub-selects"><ParamChoice id="subWave" label="SUB WAVE"/><ParamChoice id="subOctave" label="OCTAVE"/></div><div className="iw-knobs"><ParamKnob id="subLevel" label="SUB"/><ParamKnob id="noiseLevel" label="NOISE"/></div></div><p className="iw-caption">낮은 음을 보강하거나 노이즈로 표면감을 더하세요.</p></section>
}

export function EnvelopeModule({ number, onSelectSource }: { number: number; onSelectSource: () => void }) {
  const { patch, selectedSource } = useSynthEditor(), prefix = 'env' + number
  const value = (suffix: string) => patch.params[(prefix + suffix) as WavetableParamId]
  return <div className="iw-envelope-content"><div className="iw-envelope-top"><ModSource id={prefix} label={'ENV ' + number} selected={selectedSource === prefix} onSelect={onSelectSource} color="amber"/><span>{number === 1 ? '음량에 기본 연결 · 다른 노브에도 연결 가능' : '노트를 누를 때 시작하는 움직임'}</span></div><EnvelopePlot attack={value('Attack')} hold={value('Hold')} decay={value('Decay')} sustain={value('Sustain')} release={value('Release')}/><div className="iw-knobs iw-envelope-knobs">{['Attack', 'Hold', 'Decay', 'Sustain', 'Release'].map(name => <ParamKnob key={name} id={prefix + name} label={name.toUpperCase()} compact/>)}</div></div>
}

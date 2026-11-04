import { useEffect, useMemo, useRef, useState } from 'react'
import { WAVE_LIMITS } from '../definition'
import type { WavetableCustomBank, WavetableParamId, WavetablePatch } from '../model'
import { CurveEditor, WavePlot } from './graphs'
import { bankFrames, bankName, factoryFrames, SHAPES, shapeSamples } from './data'
import { ParamKnob, useSynthEditor } from './editor-context'
import { SegmentControl } from './controls'

export function WaveEditor({ oscillator, onOscillatorChange, onChange }: { oscillator: number; onOscillatorChange: (number: number) => void; onChange: (patch: WavetablePatch, label: string, mergeKey?: string) => void }) {
  const { patch } = useSynthEditor(), id = ('osc' + oscillator + 'Bank') as WavetableParamId, bankIndex = patch.params[id]
  const custom = patch.customBanks.find(bank => bank.slot === bankIndex)
  const frames = useMemo(() => bankFrames(patch, bankIndex), [bankIndex, patch.customBanks])
  const [frameIndex, setFrameIndex] = useState(0), [nameDraft, setNameDraft] = useState<string | null>(null)
  const nameCancelled = useRef(false)
  const selected = Math.min(frameIndex, Math.max(0, frames.length - 1))
  useEffect(() => { setFrameIndex(0); setNameDraft(null) }, [bankIndex, oscillator])
  const unusedSlot = Array.from({ length: WAVE_LIMITS.customBanks }, (_, index) => index + WAVE_LIMITS.factoryBanks).find(slot => !patch.customBanks.some(bank => bank.slot === slot))
  function updateBank(next: WavetableCustomBank, label: string, mergeKey?: string) {
    onChange({ ...patch, customBanks: patch.customBanks.map(bank => bank.slot === next.slot ? next : bank) }, label, mergeKey)
  }
  function copyToUser() {
    if (unusedSlot === undefined) return
    const source = custom?.frames ?? factoryFrames(bankIndex)
    const bank: WavetableCustomBank = { slot: unusedSlot, name: bankName(patch, bankIndex).slice(0, 57) + ' Custom', frames: source.map(frame => [...frame]) }
    onChange({ ...patch, params: { ...patch.params, [id]: unusedSlot }, customBanks: [...patch.customBanks, bank] }, '사용자 웨이브테이블 만들기')
  }
  function updateFrame(values: number[], label = '파형 프레임 그리기') {
    if (!custom) return
    updateBank({ ...custom, frames: custom.frames.map((frame, index) => index === selected ? values : frame) }, label, label === '파형 프레임 그리기' ? 'frame:' + bankIndex + ':' + selected : undefined)
  }
  function duplicateFrame() {
    if (!custom || frames.length >= WAVE_LIMITS.framesPerBank) return
    const next = [...custom.frames]; next.splice(selected + 1, 0, [...custom.frames[selected]])
    updateBank({ ...custom, frames: next }, '웨이브테이블 프레임 복제'); setFrameIndex(selected + 1)
  }
  function removeFrame() {
    if (!custom || frames.length <= 1) return
    updateBank({ ...custom, frames: custom.frames.filter((_, index) => index !== selected) }, '웨이브테이블 프레임 삭제'); setFrameIndex(Math.max(0, selected - 1))
  }
  function processFrame(mode: 'normalize' | 'smooth' | 'invert') {
    if (!custom) return
    const source = custom.frames[selected]
    let next: number[]
    if (mode === 'invert') next = source.map(value => -value)
    else if (mode === 'smooth') next = source.map((value, index) => (source[(index + source.length - 1) % source.length] + value * 2 + source[(index + 1) % source.length]) / 4)
    else { const dc = source.reduce((sum, value) => sum + value, 0) / source.length; const corrected = source.map(value => value - dc), peak = Math.max(...corrected.map(Math.abs)); next = peak > 0 ? corrected.map(value => value / peak) : corrected }
    updateFrame(next, ({ normalize: '파형 DC 제거·정규화', smooth: '파형 부드럽게', invert: '파형 반전' })[mode])
  }
  return <section className="iw-wave-editor" aria-label="웨이브테이블 편집기">
    <div className="iw-section-heading"><div><span className="iw-eyebrow">WAVETABLE STUDIO</span><h2>소리의 재료를 직접 그리세요</h2><p>프레임을 하나씩 만들고 POSITION으로 그 사이를 움직입니다.</p></div><SegmentControl label="편집할 오실레이터" value={oscillator} options={[1, 2, 3].map(value => ({ value, label: 'OSC ' + value }))} onChange={onOscillatorChange}/></div>
    <div className="iw-wave-workbench"><div className="iw-wave-editor-main">
      <div className="iw-wave-bank-heading"><div><span className={'iw-tag' + (custom ? ' is-custom' : '')}>{custom ? 'USER ' + (bankIndex - 3) : 'FACTORY'}</span>{custom ? <input aria-label="사용자 웨이브테이블 이름" maxLength={64} value={nameDraft ?? custom.name} onChange={event => { nameCancelled.current = false; setNameDraft(event.target.value) }} onBlur={() => { if (nameDraft !== null && !nameCancelled.current) { const name = nameDraft.trim().slice(0, 64) || custom.name; if (name !== custom.name) updateBank({ ...custom, name }, '웨이브테이블 이름 변경'); setNameDraft(null) } }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.stopPropagation(); nameCancelled.current = true; setNameDraft(null); event.currentTarget.blur() } }}/>: <h3>{bankName(patch, bankIndex)}</h3>}</div><span>{frames.length} FRAMES · {WAVE_LIMITS.frameSize} SAMPLES</span></div>
      {custom ? <CurveEditor values={frames[selected] ?? []} label={'USER ' + (bankIndex - 3) + ' 프레임 ' + (selected + 1)} onChange={values => updateFrame(values)} bipolar commitOnEnd large/> : <div className="iw-factory-wave"><WavePlot samples={frames[selected] ?? []} label={bankName(patch, bankIndex) + ' 기본 프레임 ' + (selected + 1)}/><div><span>기본 웨이브테이블</span><p>사용자 슬롯에 복사한 뒤 자유롭게 그릴 수 있습니다.</p><button className="iw-button iw-button-accent" disabled={unusedSlot === undefined} onClick={copyToUser}>사용자 슬롯에 복사</button>{unusedSlot === undefined && <p>사용자 슬롯 4개를 모두 사용 중입니다.</p>}</div></div>}
      {custom && <div className="iw-wave-tools"><div>{SHAPES.map(shape => <button className="iw-button iw-button-small" key={shape.id} title={shape.label + ' 파형으로 바꾸기'} onClick={() => updateFrame(shapeSamples(shape.id, WAVE_LIMITS.frameSize, true), shape.label + ' 파형 만들기')}><span aria-hidden="true">{shape.symbol}</span>{shape.label}</button>)}</div><div><button className="iw-button iw-button-small" onClick={() => processFrame('normalize')}>DC 제거·정규화</button><button className="iw-button iw-button-small" onClick={() => processFrame('smooth')}>부드럽게</button><button className="iw-button iw-button-small" onClick={() => processFrame('invert')}>상하 반전</button></div></div>}
      <div className="iw-frame-strip" role="group" aria-label="웨이브테이블 프레임">{frames.map((frame, index) => <button className={index === selected ? 'is-selected' : ''} key={index} aria-label={'프레임 ' + (index + 1) + ' 선택'} aria-pressed={index === selected} onClick={() => setFrameIndex(index)}><WavePlot samples={frame} label={'프레임 ' + (index + 1)} compact/><span>{String(index + 1).padStart(2, '0')}</span></button>)}</div>
      {custom && <div className="iw-frame-actions"><button className="iw-button iw-button-small" disabled={frames.length >= WAVE_LIMITS.framesPerBank} onClick={duplicateFrame}>+ 프레임 복제</button><button className="iw-button iw-button-small" disabled={frames.length <= 1} onClick={removeFrame}>선택 프레임 삭제</button><span>{frames.length} / {WAVE_LIMITS.framesPerBank} 프레임</span></div>}
    </div><aside className="iw-wave-editor-side"><span className="iw-eyebrow">FRAME MORPH</span><ParamKnob id={'osc' + oscillator + 'Position'} label="POSITION"/><p>이 노브에 LFO를 연결하면 여러 프레임 사이를 오가는 움직임이 만들어집니다.</p><div className="iw-editor-note"><strong>편집한 파형은 음색과 함께 저장됩니다.</strong><p>사용자 뱅크는 최대 4개, 뱅크당 최대 16프레임을 담습니다. 한 뱅크를 여러 OSC에서 쓰면 수정 내용도 함께 반영됩니다. 재생할 때는 각 프레임의 DC를 제거하고 뱅크 전체를 같은 비율로 정규화합니다.</p></div>{custom && <button className="iw-button" disabled={unusedSlot === undefined} onClick={copyToUser}>다른 사용자 슬롯에 복제</button>}</aside></div>
  </section>
}

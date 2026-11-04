import { useEffect, useId, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { WAVE_LIMITS, WAVE_MOD_DESTINATIONS, WAVE_SOURCES } from './definition'
import { createDefaultWavetablePatch, parseWavetablePatchJson, serializeWavetablePatch } from './model'
import type { WavetableModRoute, WavetableModSource, WavetableParamId, WavetablePatch } from './model'
import { getWavetablePreset, WAVE_PRESETS } from './presets'
import { ModSource, SegmentControl, Toggle } from './ui/controls'
import { CurveEditor } from './ui/graphs'
import { ModulationMatrix, destinationName, sourceName } from './ui/Matrix'
import { ParamChoice, ParamKnob, parameter, SynthEditorContext } from './ui/editor-context'
import { EnvelopeModule, Filters, Oscillator, SubNoise } from './ui/SoundModules'
import { WaveEditor } from './ui/WaveEditor'
import { SHAPES, shapeSamples } from './ui/data'
import { SynthKeyboard } from './ui/Keyboard'
import { useNativePreview } from './ui/useNativePreview'
import type { WavetableSynthProps } from './ui/editor-contract'
import './WavetableSynth.css'

export type { WavetableSynthProps } from './ui/editor-contract'
const TABS = [{ id: 'sound', name: '음원', detail: 'OSC / FILTER' }, { id: 'motion', name: '변조', detail: 'ENV / LFO' }, { id: 'effects', name: '이펙트', detail: 'FX' }, { id: 'wave', name: '파형 편집', detail: 'WAVETABLE' }] as const
type TabId = typeof TABS[number]['id']
const FOCUSABLE = 'button:not(:disabled),select:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href],summary,[tabindex]:not([tabindex="-1"])'

export function WavetableSynth({ patch, onPatchChange, onClose, trackId, trackName, nativeBridge, onSave, bpm }: WavetableSynthProps) {
  const dialogRef = useRef<HTMLDivElement>(null), bodyRef = useRef<HTMLDivElement>(null), importRef = useRef<HTMLInputElement>(null)
  const id = useId(), latest = useRef({ patch, onPatchChange, onClose }); latest.current = { patch, onPatchChange, onClose }
  const [tab, setTab] = useState<TabId>('sound'), [envelope, setEnvelope] = useState(1), [lfo, setLfo] = useState(1), [waveOscillator, setWaveOscillator] = useState(1)
  const [selectedSource, setSelectedSource] = useState<WavetableModSource | null>(null), [inspector, setInspector] = useState<WavetableParamId | null>(null)
  const [message, setMessage] = useState(''), [fileError, setFileError] = useState(''), [rename, setRename] = useState<string | null>(null)
  const renameCancelled = useRef(false)
  const native = useNativePreview(nativeBridge, trackId, patch)
  const preset = WAVE_PRESETS.find(item => item.patch.metadata.name === patch.metadata.name)

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null, overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus({ preventScroll: true })
    const focusIn = (event: FocusEvent) => { if (event.target instanceof Node && dialogRef.current && !dialogRef.current.contains(event.target)) dialogRef.current.focus({ preventScroll: true }) }
    document.addEventListener('focusin', focusIn)
    return () => { document.removeEventListener('focusin', focusIn); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }) }, [tab])
  useEffect(() => { if (inspector) bodyRef.current?.scrollTo({ top: 0 }) }, [inspector])
  useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(''), 4200); return () => clearTimeout(timer) }, [message])

  function commit(next: WavetablePatch, label: string, mergeKey?: string) {
    latest.current.patch = next
    latest.current.onPatchChange(next, label, mergeKey)
  }
  function setParameter(paramId: WavetableParamId, value: number) {
    const current = latest.current.patch
    if (!Number.isFinite(value) || current.params[paramId] === value) return
    const def = parameter(paramId), clamped = Math.min(def.max, Math.max(def.min, value))
    commit({ ...current, params: { ...current.params, [paramId]: clamped } }, destinationName(paramId) + ' 조절', 'param:' + paramId)
  }
  function selectSource(source: WavetableModSource) { setSelectedSource(current => current === source ? null : source) }
  function addRoute(source: string, destination: WavetableParamId) {
    const current = latest.current.patch
    if (!WAVE_SOURCES.some(item => item.id === source) || !WAVE_MOD_DESTINATIONS.some(item => item.id === destination)) return
    const existing = current.routes.find(route => route.source === source && route.destination === destination)
    if (existing) { setInspector(destination); setSelectedSource(null); setMessage('이미 연결되어 있습니다. 변조량을 조절하세요.'); return }
    if (current.routes.length >= WAVE_LIMITS.routes) { setMessage('변조 연결은 최대 16개입니다. 사용하지 않는 연결을 먼저 지워 주세요.'); return }
    const route: WavetableModRoute = { id: crypto.randomUUID(), enabled: true, source: source as WavetableModSource, destination, amount: .2, bipolar: source.startsWith('lfo'), aux: null, curve: 0 }
    commit({ ...current, routes: [...current.routes, route] }, sourceName(source) + ' → ' + destinationName(destination) + ' 연결')
    setSelectedSource(null); setMessage(sourceName(source) + ' → ' + destinationName(destination) + ' 연결됨')
  }
  function updateRoute(routeId: string, changes: Partial<WavetableModRoute>) {
    const current = latest.current.patch
    const merge = 'amount' in changes ? ':amount' : 'curve' in changes ? ':curve' : undefined
    commit({ ...current, routes: current.routes.map(route => route.id === routeId ? { ...route, ...changes } : route) }, '변조 연결 편집', merge ? 'route:' + routeId + merge : undefined)
  }
  function removeRoute(routeId: string) { const current = latest.current.patch; commit({ ...current, routes: current.routes.filter(route => route.id !== routeId) }, '변조 연결 삭제') }
  function choosePreset(presetId: string) {
    const next = getWavetablePreset(presetId)
    commit(next, next.metadata.name + ' 프리셋 불러오기'); setInspector(null); setSelectedSource(null); setFileError(''); setMessage(next.metadata.name + ' 불러옴')
  }
  function nextPreset(direction: number) {
    const index = Math.max(0, WAVE_PRESETS.findIndex(item => item.id === preset?.id))
    choosePreset(WAVE_PRESETS[(index + direction + WAVE_PRESETS.length) % WAVE_PRESETS.length].id)
  }
  function editLfo(values: number[], atomic = false) {
    const current = latest.current.patch
    commit({ ...current, lfoCurves: current.lfoCurves.map((curve, index) => index === lfo - 1 ? values : curve) }, 'LFO ' + lfo + ' 곡선 편집', atomic ? undefined : 'lfo:' + lfo)
  }
  function exportPatch() {
    const blob = new Blob([serializeWavetablePatch(latest.current.patch)], { type: 'application/json' }), url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = (latest.current.patch.metadata.name.replace(/[^a-zA-Z0-9가-힣 _-]/g, '').trim() || 'IEUM WAVE') + '.ieum-wave.json'
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setMessage('음색 파일을 내보냈습니다.')
  }
  async function importPatch(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ''
    if (!file) return
    try {
      if (file.size > WAVE_LIMITS.maxTextBytes) throw new Error('음색 파일은 4 MB 이하여야 합니다.')
      const next = parseWavetablePatchJson(await file.text())
      commit(next, '음색 파일 불러오기'); setInspector(null); setSelectedSource(null); setFileError(''); setMessage(next.metadata.name + ' 불러옴')
    } catch (error) { setFileError(error instanceof Error ? error.message : '음색 파일을 읽지 못했습니다.') }
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Project undo/redo/save is routed by App even while this local dialog is open.
    if ((event.ctrlKey || event.metaKey) && ['z', 'y', 's'].includes(event.key.toLowerCase())) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (inspector) setInspector(null); else if (selectedSource) setSelectedSource(null); else latest.current.onClose(); return }
    if (event.key === 'Tab') {
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(element => element.getClientRects().length && !element.closest('[hidden]'))
      if (!controls.length) { event.preventDefault(); return }
      const first = controls[0], last = controls[controls.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first.focus() }
    }
    event.stopPropagation()
  }
  const nativeMessage = !native.engine.available ? '네이티브 오디오 엔진 연결 준비 중 · 음색 편집과 저장 가능' : native.error ? '음색을 엔진에 적용하지 못했습니다' : native.ready ? '네이티브 엔진 · 최신 음색 적용 완료' : '음색을 네이티브 엔진에 적용하는 중…'
  const tabIndex = TABS.findIndex(item => item.id === tab)
  const matrixProps = { routes: patch.routes, onUpdate: updateRoute, onRemove: removeRoute, onAdd: addRoute }
  return createPortal(<div className="iw-overlay" onPointerDown={event => { if (event.target === event.currentTarget) latest.current.onClose() }}>
    <div className="iw-synth" data-wavetable-synth-dialog="" role="dialog" aria-modal="true" aria-labelledby={id + '-title'} aria-describedby={id + '-engine-status'} tabIndex={-1} ref={dialogRef} onKeyDown={keyDown}>
      <SynthEditorContext.Provider value={{ patch, setParameter, selectedSource, assign: addRoute, inspect: setInspector }}>
        <header className="iw-header">
          <div className="iw-brand"><svg className="iw-brand-mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M3 18V9m6 17V5m7 18V9m7 18V4m6 15v-7"/></svg><div><h1 id={id + '-title'}>IEUM <b>WAVE</b></h1><span>이음 웨이브 <i>·</i> WAVETABLE SYNTHESIZER</span></div></div>
          <div className="iw-preset"><button onClick={() => nextPreset(-1)} aria-label="이전 프리셋" title="이전 프리셋">‹</button><label><span className="iw-preset-category">{preset?.category.toUpperCase() ?? 'USER PATCH'}</span><select aria-label="프리셋 선택" value={preset?.id ?? ''} onChange={event => choosePreset(event.target.value)}>{!preset && <option value="">{patch.metadata.name}</option>}{['Init', 'Bass', 'Lead', 'Pad', 'Pluck', 'Keys', 'Texture'].map(category => <optgroup key={category} label={category}>{WAVE_PRESETS.filter(item => item.category === category).map(item => <option value={item.id} key={item.id}>{item.name + ' · ' + item.nameKo}</option>)}</optgroup>)}</select></label><button onClick={() => nextPreset(1)} aria-label="다음 프리셋" title="다음 프리셋">›</button></div>
          <div className="iw-header-actions"><details className="iw-patch-menu"><summary title="음색 이름·파일">음색 <span aria-hidden="true">⌄</span></summary><div><label>음색 이름<input value={rename ?? patch.metadata.name} maxLength={64} onChange={event => { renameCancelled.current = false; setRename(event.target.value) }} onBlur={() => { if (rename !== null && !renameCancelled.current) { const name = rename.trim().slice(0, 64) || patch.metadata.name; if (name !== patch.metadata.name) commit({ ...latest.current.patch, metadata: { ...latest.current.patch.metadata, name } }, '음색 이름 변경'); setRename(null) } }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.stopPropagation(); renameCancelled.current = true; setRename(null); event.currentTarget.blur() } }}/></label><button onClick={exportPatch}>음색 파일 내보내기</button><button onClick={() => importRef.current?.click()}>음색 파일 불러오기</button><button onClick={() => { commit(createDefaultWavetablePatch(), '기본 음색으로 초기화'); setInspector(null); setMessage('기본 음색으로 초기화했습니다. 실행 취소할 수 있습니다.') }}>기본 음색으로 초기화</button><small>IEUM WAVE 형식 · 사용자 파형 포함</small></div></details>{onSave && <button className="iw-save" onClick={onSave}>저장</button>}<button className="iw-close" onClick={onClose} aria-label="이음 웨이브 닫기" title="닫기 (Esc)">×</button></div>
          <input className="iw-sr-only" ref={importRef} tabIndex={-1} type="file" accept=".json,.ieum-wave.json,application/json" onChange={event => void importPatch(event)}/>
        </header>
        <div className="iw-info-bar"><div className={'iw-engine-status' + (native.ready ? ' is-ready' : '') + (native.engine.available && native.error ? ' is-error' : '')} id={id + '-engine-status'} role="status"><span className="iw-status-dot"/><span>{nativeMessage}</span>{native.engine.available && native.error && <span className="iw-native-error">{native.error}</span>}</div><span className="iw-track-name" title={trackName}>{trackName ?? '이음 웨이브 트랙'}</span></div>
        <nav className="iw-tabs" role="tablist" aria-label="이음 웨이브 편집 페이지">{TABS.map((item, index) => <button id={id + '-tab-' + item.id} key={item.id} role="tab" aria-selected={tab === item.id} aria-controls={id + '-panel'} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : (tabIndex + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length; setTab(TABS[next].id); document.getElementById(id + '-tab-' + TABS[next].id)?.focus() }}><span className="iw-tab-number">{String(index + 1).padStart(2, '0')}</span>{item.name}<small>{item.detail}</small></button>)}<span className="iw-tabs-caption">YOUR SOUND, IN MOTION.</span></nav>
        <div className="iw-body" ref={bodyRef}>
          {fileError && <div className="iw-error" role="alert"><strong>음색을 불러오지 못했습니다.</strong><span>{fileError}</span><button onClick={() => setFileError('')} aria-label="파일 오류 안내 닫기">×</button></div>}
          {selectedSource && <div className="iw-assignment-banner" role="status"><span><strong>{sourceName(selectedSource)}</strong> 연결할 노브의 <b>+</b>를 누르세요.</span><button onClick={() => setSelectedSource(null)}>취소</button></div>}
          {inspector && <div className="iw-mod-inspector"><div className="iw-inspector-title"><span>선택한 노브의 변조</span><button onClick={() => setInspector(null)} aria-label="노브 변조 편집 닫기">×</button></div><ModulationMatrix {...matrixProps} selectedDestination={inspector}/></div>}
          <main id={id + '-panel'} role="tabpanel" aria-labelledby={id + '-tab-' + tab}>
            {tab === 'sound' && <><div className="iw-sound-intro"><span><b>01—03</b> 파형을 고르고, 겹치고, 움직이세요.</span><span>3 OSC <i>·</i> 2 FILTER <i>·</i> 16 VOICES</span></div><div className="iw-osc-grid">{[1, 2, 3].map(number => <Oscillator number={number} key={number} onEdit={value => { setWaveOscillator(value); setTab('wave') }}/>)}</div><div className="iw-sound-bottom"><SubNoise/><Filters/><section className="iw-module iw-amp-envelope"><div className="iw-section-heading"><div><span className="iw-eyebrow">AMPLITUDE</span><h3>소리의 시작과 끝</h3></div><button className="iw-text-button" onClick={() => { setEnvelope(1); setTab('motion') }}>변조 편집 ↗</button></div><EnvelopeModule number={1} onSelectSource={() => selectSource('env1')}/></section></div></>}
            {tab === 'motion' && <><div className="iw-motion-intro"><div><span className="iw-eyebrow">MAKE IT MOVE</span><h2>정적인 파형에 표정을 더하세요</h2><p>소스 이름을 노브로 끌어 놓거나, 소스를 선택한 뒤 노브의 +를 누르세요.</p></div><span className="iw-count">{patch.routes.length} / {WAVE_LIMITS.routes} 연결</span></div><div className="iw-modulator-grid"><section className="iw-module iw-env-module"><div className="iw-section-heading"><span className="iw-eyebrow">ENVELOPES</span><SegmentControl label="엔벌로프 선택" value={envelope} options={[1, 2, 3, 4].map(value => ({ value, label: String(value) }))} onChange={setEnvelope}/></div><EnvelopeModule number={envelope} onSelectSource={() => selectSource(('env' + envelope) as WavetableModSource)}/><p className="iw-caption">ENV 1은 음량에 기본 연결됩니다. 네 개 모두 다른 파라미터에도 연결할 수 있습니다.</p></section><section className="iw-module iw-lfo-module"><div className="iw-section-heading"><ModSource id={'lfo' + lfo} label={'LFO ' + lfo} selected={selectedSource === 'lfo' + lfo} onSelect={() => selectSource(('lfo' + lfo) as WavetableModSource)}/><SegmentControl label="LFO 선택" value={lfo} options={[1, 2, 3, 4].map(value => ({ value, label: String(value) }))} onChange={setLfo}/></div><CurveEditor values={patch.lfoCurves[lfo - 1]} label={'LFO ' + lfo + ' 곡선'} onChange={editLfo}/><div className="iw-lfo-shapes">{SHAPES.map(shape => <button key={shape.id} title={shape.label + ' LFO 만들기'} onClick={() => editLfo(shapeSamples(shape.id, WAVE_LIMITS.lfoPoints), true)}><span aria-hidden="true">{shape.symbol}</span>{shape.label}</button>)}</div><div className="iw-lfo-settings"><div className="iw-lfo-toggles"><Toggle checked={patch.params[('lfo' + lfo + 'Sync') as WavetableParamId] === 1} onChange={value => setParameter(('lfo' + lfo + 'Sync') as WavetableParamId, value ? 1 : 0)}>TEMPO SYNC</Toggle><Toggle checked={patch.params[('lfo' + lfo + 'Retrigger') as WavetableParamId] === 1} onChange={value => setParameter(('lfo' + lfo + 'Retrigger') as WavetableParamId, value ? 1 : 0)}>NOTE RETRIGGER</Toggle><span>{patch.params[('lfo' + lfo + 'Retrigger') as WavetableParamId] ? '노트마다 곡선의 처음부터' : '노트 사이에도 위상 유지'}</span></div>{patch.params[('lfo' + lfo + 'Sync') as WavetableParamId] ? <div className="iw-sync-division"><ParamChoice id={'lfo' + lfo + 'Division'} label="DIVISION"/><span>{bpm ? bpm + ' BPM · ' + (60 / bpm * patch.params[('lfo' + lfo + 'Division') as WavetableParamId]).toFixed(2) + ' s / cycle' : '프로젝트 템포에 동기화'}</span></div> : <ParamKnob id={'lfo' + lfo + 'Rate'} label="RATE"/>}</div></section></div><section className="iw-source-tray" aria-label="변조 소스"><span>연결할 소스</span><div>{WAVE_SOURCES.filter(source => !source.id.startsWith('macro')).map(source => <ModSource key={source.id} id={source.id} label={sourceName(source.id)} color={source.id.startsWith('env') ? 'amber' : source.id.startsWith('lfo') ? 'cyan' : 'violet'} selected={selectedSource === source.id} onSelect={() => selectSource(source.id)}/>)}</div></section><ModulationMatrix {...matrixProps}/></>}
            {tab === 'effects' && <section className="iw-effects"><div className="iw-section-heading"><div><span className="iw-eyebrow">FINISHING TOUCHES</span><h2>색을 더하고, 공간을 넓히세요</h2><p>MIX를 0으로 내리면 해당 이펙트가 섞이지 않습니다.</p></div><span className="iw-effects-flow">DRIVE → CHORUS → DELAY</span></div><div className="iw-effects-grid"><section className={'iw-module iw-fx-module' + (patch.params.driveMix === 0 ? ' is-disabled' : '')}><div className="iw-fx-heading"><span>01</span><h3>DRIVE</h3><small>{patch.params.driveMix > 0 ? 'ACTIVE' : 'DRY'}</small></div><div className="iw-fx-art iw-drive-art" aria-hidden="true"><svg viewBox="0 0 280 100"><path d="M15 75 65 75Q90 75 105 50T145 25H265"/><path className="iw-fx-guide" d="m15 85 250-70"/></svg></div><p>드라이브로 배음을 더해 밀도와 거친 결을 만듭니다.</p><div className="iw-knobs"><ParamKnob id="drive" label="DRIVE"/><ParamKnob id="driveMix" label="MIX"/></div></section><section className={'iw-module iw-fx-module' + (patch.params.chorusMix === 0 ? ' is-disabled' : '')}><div className="iw-fx-heading"><span>02</span><h3>CHORUS</h3><small>{patch.params.chorusMix > 0 ? 'ACTIVE' : 'DRY'}</small></div><div className="iw-fx-art iw-chorus-art" aria-hidden="true"><svg viewBox="0 0 280 100"><path d="M10 50Q42-4 75 50T140 50 205 50 270 50"/><path d="M10 60Q42 6 75 60T140 60 205 60 270 60"/><path d="M10 40Q42-14 75 40T140 40 205 40 270 40"/></svg></div><p>조금씩 움직이는 지연을 섞어 넓고 풍성하게 만듭니다.</p><div className="iw-knobs"><ParamKnob id="chorusRate" label="RATE"/><ParamKnob id="chorusDepth" label="DEPTH"/><ParamKnob id="chorusMix" label="MIX"/></div></section><section className={'iw-module iw-fx-module' + (patch.params.delayMix === 0 ? ' is-disabled' : '')}><div className="iw-fx-heading"><span>03</span><h3>DELAY</h3><small>{patch.params.delayMix > 0 ? 'ACTIVE' : 'DRY'}</small></div><div className="iw-fx-art iw-delay-art" aria-hidden="true"><svg viewBox="0 0 280 100"><path d="M30 85V15M80 85V32M130 85V47M180 85V59M230 85V68"/></svg></div><p>반복되는 여운의 간격과 되먹임, 섞이는 양을 정합니다.</p><div className="iw-knobs"><ParamKnob id="delayTime" label="TIME"/><ParamKnob id="delayFeedback" label="FEEDBACK"/><ParamKnob id="delayMix" label="MIX"/></div></section></div><p className="iw-caption">위의 도형은 이펙트 원리를 설명하는 표시입니다. 실시간 오디오 측정값이 아닙니다.</p></section>}
            {tab === 'wave' && <WaveEditor oscillator={waveOscillator} onOscillatorChange={setWaveOscillator} onChange={commit}/>}
          </main>
          <section className="iw-macros" aria-label="매크로 컨트롤"><div className="iw-macro-intro"><span className="iw-eyebrow">PERFORM</span><h3>MACROS</h3><p>여러 변화를<br/>하나의 손짓으로.</p></div><div className="iw-macro-grid">{Array.from({ length: WAVE_LIMITS.macros }, (_, index) => index + 1).map(number => <div className="iw-macro" key={number}><ModSource id={'macro' + number} label={String(number).padStart(2, '0')} selected={selectedSource === 'macro' + number} onSelect={() => selectSource(('macro' + number) as WavetableModSource)}/><ParamKnob id={'macro' + number} label={'MACRO ' + number} compact/><span className="iw-macro-links">{patch.routes.filter(route => route.source === 'macro' + number || route.aux === 'macro' + number).length} 연결</span></div>)}</div></section>
          <div className="iw-patch-description"><span>{patch.metadata.name}</span><p>{patch.metadata.description || '나만의 웨이브테이블 음색'}</p></div>
        </div>
        <footer className="iw-footer"><SynthKeyboard ready={native.ready} connected={native.engine.available} onNoteOn={native.noteOn} onNoteOff={native.noteOff}/><div className="iw-output"><button className="iw-panic" disabled={!native.engine.available} onClick={native.allNotesOff} title="이 트랙의 미리 듣기 음을 모두 끕니다">음 끄기</button><ParamKnob id="level" label="OUTPUT" compact/></div></footer>
        <div className="iw-footnote"><span>드래그·휠 조절 <i>·</i> Shift 미세 조절 <i>·</i> Enter 숫자 입력 <i>·</i> Alt 클릭 초기값</span><span>편집 내용은 프로젝트에 반영됩니다.</span></div>
        <div className="iw-live-message" role="status" aria-live="polite">{message}</div>
      </SynthEditorContext.Provider>
    </div>
  </div>, document.body)
}

export default WavetableSynth

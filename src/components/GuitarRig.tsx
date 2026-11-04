import { useEffect, useId, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Device, Track } from '../core/types'
import type { AudioState } from '../core/audioSettings'
import { formatParam, paramValue, type ParamDef } from '../core/devices'
import { useHistoryGesture } from '../core/historyGesture'
import { GUITAR_RIG_PARAMS, GUITAR_RIG_PRESETS, GUITAR_RIG_SECTIONS, GUITAR_RIG_SOUND_DESCRIPTION } from '../devices/guitar-rig/definition'
import { Icon } from './Icon'
import { Knob } from './Knob'
import ampImage from '../assets/guitar-rig/amp-panel.png'
import pedalImage from '../assets/guitar-rig/pedal-body.png'
import cabinetImage from '../assets/guitar-rig/cabinet.png'
import knobImage from '../assets/guitar-rig/knob-cap.png'
import './GuitarRig.css'

const PARAMS = new Map(GUITAR_RIG_PARAMS.map(def => [def.id, def]))
const AMP_IDS = ['ampGain', 'ampBass', 'ampMid', 'ampTreble', 'ampPresence', 'ampLevel'] as const
const AMP_LABELS = ['GAIN', 'BASS', 'MID', 'TREBLE', 'PRESENCE', 'MASTER'] as const
const PEDAL_META = {
  comp: { name: '컴프', english: 'SUSTAIN COMPRESSOR', labels: ['SUSTAIN', 'ATTACK', 'LEVEL'], route: '앰프 앞 · 01' },
  drive: { name: '드라이브', english: 'WARM OVERDRIVE', labels: ['DRIVE', 'TONE', 'LEVEL'], route: '앰프 앞 · 02' },
  chorus: { name: '코러스', english: 'SLOW CHORUS', labels: ['RATE', 'DEPTH', 'MIX'], route: '캐비닛 뒤 · 05' },
  delay: { name: '딜레이', english: 'WARM DELAY', labels: ['TIME', 'FEEDBACK', 'MIX'], route: '캐비닛 뒤 · 06' },
} as const
const PEDAL_POINTS = [[52, 97], [128, 97], [90, 162]] as const
const RANGE_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']
const valueOf = (params: Record<string, number>, id: string) => paramValue(GUITAR_RIG_PARAMS, params, id)
const choiceLabel = (params: Record<string, number>, id: string) => PARAMS.get(id)?.options?.find(option => option.value === valueOf(params, id))?.label ?? ''
const matchedPreset = (params: Record<string, number>) => GUITAR_RIG_PRESETS.find(preset => GUITAR_RIG_PARAMS.every(def => Math.abs(valueOf(params, def.id) - preset.params[def.id]) < 0.000001))

export function GuitarRigSummary({ device, onOpen }: { device: Device; onOpen: () => void }) {
  const preset = matchedPreset(device.params)
  return <div className="dc-guitar-summary">
    <button className="dc-guitar-open" onClick={onOpen} aria-haspopup="dialog" aria-label="기타 앰프 편집기 열기">
      <span className="dc-guitar-thumbnail" aria-hidden="true"><img src={ampImage} alt="" width={1440} height={480}/><span>가락이음</span><i>{AMP_IDS.map(id => <img key={id} src={knobImage} alt="" width={128} height={128}/>)}</i></span>
      <span className="dc-guitar-title">{preset?.name ?? '나만의 톤'}<Icon name="external" size={12}/></span>
      <span className="dc-guitar-caption">{choiceLabel(device.params, 'ampModel')} · {choiceLabel(device.params, 'cabinet')}</span>
    </button>
    <div className="dc-guitar-stages" aria-label="기타 앰프 내부 효과 상태">{GUITAR_RIG_SECTIONS.map(section => <span key={section.id} data-on={valueOf(device.params, section.enabledParam) >= .5}>{section.name === 'CABINET / MIC' ? 'CAB' : section.name}</span>)}</div>
  </div>
}

function RigKnob({ id, label, section, params, onParam }: { id: string; label: string; section: string; params: Record<string, number>; onParam: (key: string, value: number) => void }) {
  const def = PARAMS.get(id)!
  return <Knob def={{ ...def, label }} ariaLabel={`${section} ${def.label}`} value={valueOf(params, id)} size={44} imageSrc={knobImage} formatValue={id==='chorusRate'?value=>`${value.toFixed(2)} Hz`:undefined} onChange={value => onParam(id, value)}/>
}

function RigChoice({ id, params, onParam, label }: { id: string; params: Record<string, number>; onParam: (key: string, value: number) => void; label?: string }) {
  const def = PARAMS.get(id)!
  return <label className="gr-choice"><span>{label ?? def.label}</span><select value={valueOf(params, id)} onChange={event => onParam(id, Number(event.target.value))}>{def.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
}

function RigRange({ def, value, onChange, left, right }: { def: ParamDef; value: number; onChange: (value: number) => void; left: string; right: string }) {
  const gesture = useHistoryGesture(`${def.label} 조절`)
  const end = useRef(gesture.end); end.current = gesture.end
  useEffect(() => {
    const finish = () => end.current()
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => { window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish) }
  }, [])
  return <label className="gr-range"><span>{def.label}<output>{formatParam(def, value)}</output></span>
    <input type="range" min={def.min} max={def.max} step={.01} value={value} aria-label={def.id==='micPosition'?'마이크 위치':def.id==='micDistance'?'마이크 거리':def.label} aria-valuetext={formatParam(def, value)} onChange={event => onChange(Number(event.target.value))} onPointerDown={() => gesture.begin()} onKeyDown={event => { if (RANGE_KEYS.includes(event.key)) gesture.begin() }} onKeyUp={event => { if (RANGE_KEYS.includes(event.key)) gesture.end() }} onBlur={() => gesture.end()}/>
    <small><span>{left}</span><span>{right}</span></small>
  </label>
}

interface EditorProps {
  device: Device
  track: Track
  audioState: AudioState | null
  onParam: (key: string, value: number) => void
  onParams: (params: Record<string, number>) => void
  onToggle: () => void
  onTrackChange: (patch: Partial<Track>) => void
  onOpenAudioSettings?: () => void
  onClose: () => void
}

export function GuitarRigEditor({ device, track, audioState, onParam, onParams, onToggle, onTrackChange, onOpenAudioSettings, onClose }: EditorProps) {
  const titleId = useId(), hintId = useId(), inputStatusId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const shouldRestoreFocus = useRef(true)
  const latestClose = useRef(onClose); latestClose.current = onClose
  const params = device.params
  const preset = matchedPreset(params)
  const ampOn = valueOf(params, 'ampEnabled') >= .5
  const cabOn = valueOf(params, 'cabinetEnabled') >= .5
  const monitoringOff = track.kind === 'audio' && audioState?.settings.softwareMonitoring === false
  const audioError = audioState?.error || (audioState?.status === 'error' ? '오디오 엔진을 시작하지 못했습니다.' : null)
  const audioNotReady = !!audioState?.needsReconfiguration
  const monitorBlocked = monitoringOff || !!audioError || audioNotReady
  const audioNotice = [
    audioError ? `오디오 오류: ${audioError} 오디오 설정에서 장치와 상태를 확인해 주세요.` : audioNotReady ? '오디오 설정을 다시 적용해야 합니다. 오디오 설정에서 장치와 상태를 확인해 주세요.' : '',
    monitoringOff ? '소프트웨어 모니터링이 꺼져 있습니다. 오디오 설정의 녹음·모니터링에서 켜 주세요.' : '',
  ].filter(Boolean).join(' ')

  const toggle = (id: string) => onParam(id, valueOf(params, id) >= .5 ? 0 : 1)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.focus({ preventScroll: true })
    const focusInside = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) dialog.focus({ preventScroll: true })
    }
    document.addEventListener('focusin', focusInside)
    return () => {
      document.removeEventListener('focusin', focusInside)
      document.body.style.overflow = overflow
      if (shouldRestoreFocus.current && previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  const settings = () => { shouldRestoreFocus.current = false; onClose(); onOpenAudioSettings?.() }
  function keyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault(); event.stopPropagation(); latestClose.current(); return
    }
    if (event.key === 'Tab') {
      const dialog = dialogRef.current!
      const items = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),[tabindex="0"]')).filter(item => item.getClientRects().length > 0)
      const first = items[0], last = items.at(-1), active = document.activeElement
      if (!first) { event.preventDefault(); dialog.focus() }
      else if (event.shiftKey && (active === first || active === dialog)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (active === last || active === dialog)) { event.preventDefault(); first.focus() }
      event.stopPropagation(); return
    }
    if ((event.ctrlKey || event.metaKey) && event.key === ',') {
      event.preventDefault(); event.stopPropagation(); if (onOpenAudioSettings) settings(); return
    }
    // Keep the application's undo/redo and save commands available in this editor.
    if ((event.ctrlKey || event.metaKey) && ['z', 'y', 's'].includes(event.key.toLowerCase())) return
    event.stopPropagation()
  }

  return createPortal(<div className="gr-backdrop" onPointerDown={event => { event.stopPropagation(); if (event.target === event.currentTarget && !document.querySelector('[data-daw-gesture]')) onClose() }}>
    <section ref={dialogRef} className="gr-editor" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={hintId} tabIndex={-1} data-guitar-rig-dialog="" onKeyDown={keyDown}>
      <header className="gr-header"><div className="gr-heading"><span className="gr-eyebrow">GARAKIEUM · GUITAR WORKSHOP</span><h2 id={titleId}>기타 앰프</h2><p>{track.name}</p></div>
        <div className="gr-header-actions"><button className={`gr-power${device.enabled ? ' is-on' : ''}`} onClick={onToggle} aria-pressed={device.enabled}><Icon name="power" size={15}/>{device.enabled ? '앰프 시스템 켜짐' : '전체 바이패스'}</button><button className="gr-close" onClick={onClose} aria-label="기타 앰프 편집기 닫기"><Icon name="close" size={20}/></button></div>
      </header>
      <div className="gr-toolbar"><label className="gr-preset"><span>PRESET</span><select aria-label="기타 앰프 프리셋" value={preset?.id ?? 'custom'} onChange={event => { const next = GUITAR_RIG_PRESETS.find(item => item.id === event.target.value); if (next) onParams({ ...next.params }) }}>{!preset && <option value="custom" disabled>나만의 톤</option>}{GUITAR_RIG_PRESETS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><span className="gr-preset-description">{preset?.description ?? '노브를 움직여 나만의 톤을 만드세요.'}</span><button className="gr-reset" onClick={() => onParams({ ...GUITAR_RIG_PRESETS[0].params })}><Icon name="refresh" size={13}/>초기 톤</button></div>
      <div className="gr-scroll">
        <div className="gr-input-bar"><Icon name={track.kind === 'audio' ? 'guitar' : 'note'} size={17}/><div><strong>{track.kind === 'audio' ? '기타를 연결하고 연주하세요' : '이 트랙의 악기 소리에 적용됩니다'}</strong><p>{track.kind === 'audio' ? '오디오 설정에서 입력을 선택한 뒤 모니터를 켜세요. 인터페이스의 직접 모니터는 꺼 두세요.' : '실제 기타 입력을 들으려면 오디오 트랙의 입력 모니터를 사용하세요.'}</p></div>{track.kind === 'audio' && <button className={`gr-monitor${track.monitor && !monitorBlocked ? ' is-on' : ''}`} aria-pressed={track.monitor} aria-describedby={audioNotice?inputStatusId:undefined} onClick={() => onTrackChange({ monitor: !track.monitor })}><Icon name="headphones" size={14}/>입력 모니터 {track.monitor ? monitorBlocked ? '대기' : '켬' : '끔'}</button>}{onOpenAudioSettings && <button className="gr-settings" onClick={settings}><Icon name="settings" size={14}/>오디오 설정</button>}</div>
        {audioNotice && <p id={inputStatusId} className="gr-audio-notice" role="status"><Icon name="info" size={14}/><span>{audioNotice}</span></p>}
        {!device.enabled && <p className="gr-bypass-note" role="status">전체 바이패스 중입니다. 설정은 편집할 수 있으며, 앰프 시스템을 켜면 소리에 적용됩니다.</p>}
        <section className="gr-amplifier" aria-label="앰프 조절">
          <div className="gr-section-head"><div><span className="gr-section-index">03</span><h3>Amplifier</h3></div><RigChoice id="ampModel" label="앰프 성향" params={params} onParam={onParam}/></div>
          <div className="gr-amp-stage" data-bypassed={!ampOn}>
            <div className="gr-amp-visual"><img className="gr-amp-art" src={ampImage} alt="" width={1440} height={480} draggable={false}/><div className="gr-amp-brand" aria-hidden="true">가락이음<small>GARAKIEUM</small></div><div className="gr-amp-model" aria-hidden="true">GA · 01<small>{choiceLabel(params, 'ampModel').toUpperCase()}</small></div><span className="gr-amp-led" aria-hidden="true"/><button className="gr-amp-switch" aria-label="앰프 단계 켜기/바이패스" aria-pressed={ampOn} onClick={() => toggle('ampEnabled')}><span/></button><span className="gr-amp-power-label" aria-hidden="true">POWER</span></div>
            <div className="gr-amp-knobs">{AMP_IDS.map((id, index) => <div className="gr-placed-knob" key={id} style={{ left: `${(190 + index * 76) / 720 * 100}%`, top: `${164 / 240 * 100}%` }}><RigKnob id={id} label={AMP_LABELS[index]} section="앰프" params={params} onParam={onParam}/></div>)}</div>
          </div>
        </section>
        <div className="gr-lower-grid">
          <section className="gr-pedals" aria-label="네 개의 이펙터"><div className="gr-section-head"><div><h3>Pedalboard</h3><span className="gr-section-caption">앰프 앞 / 캐비닛 뒤</span></div></div>
            <div className="gr-pedal-grid">{GUITAR_RIG_SECTIONS.filter(section => section.id in PEDAL_META).map(section => {
              const meta = PEDAL_META[section.id as keyof typeof PEDAL_META]
              const enabled = valueOf(params, section.enabledParam) >= .5
              return <article className="gr-pedal-cell" key={section.id} aria-label={`${meta.name} 페달`}><div className={`gr-pedal-stage gr-pedal-${section.id}`} data-bypassed={!enabled}>
                <img className="gr-pedal-art" src={pedalImage} alt="" width={360} height={600} draggable={false}/><div className="gr-pedal-name"><h4>{meta.name}</h4><span>{meta.english}</span></div>
                {section.params.map((id, index) => <div className="gr-placed-knob" key={id} style={{ left: PEDAL_POINTS[index][0], top: PEDAL_POINTS[index][1] }}><RigKnob id={id} label={meta.labels[index]} section={meta.name} params={params} onParam={onParam}/></div>)}
                <span className="gr-pedal-led" aria-hidden="true"/><button className="gr-footswitch" aria-label={`${meta.name} 페달 켜기/바이패스`} aria-pressed={enabled} title={`${meta.name} ${enabled ? '켜짐' : '바이패스'}`} onClick={() => toggle(section.enabledParam)}/>
              </div><div className="gr-pedal-caption"><button aria-pressed={enabled} onClick={() => toggle(section.enabledParam)} aria-label={`${meta.name} 상태 ${enabled ? '켜짐' : '바이패스'}`}>{enabled ? 'ON' : 'BYPASS'}</button><span>{meta.route}</span></div></article>
            })}</div>
          </section>
          <section className="gr-cabinet" aria-label="캐비닛과 마이크 조절"><div className="gr-section-head"><div><span className="gr-section-index">04</span><h3>Cabinet & Mic</h3></div><button className="gr-small-toggle" aria-label="캐비닛과 마이크 켜기/바이패스" aria-pressed={cabOn} onClick={() => toggle('cabinetEnabled')}>{cabOn ? 'ON' : 'BYPASS'}</button></div>
            <div className="gr-cabinet-stage" data-bypassed={!cabOn}><img src={cabinetImage} alt="2×12 캐비닛 패널, 왼쪽 스피커를 기준으로 마이크 위치 표시" width={768} height={512} draggable={false}/><span className="gr-cabinet-badge" aria-hidden="true">가락이음</span><svg className="gr-mic-overlay" viewBox="0 0 768 512" aria-hidden="true"><path className="gr-mic-guide" d="M225 260H345"/><circle className="gr-mic-center" cx={225} cy={260} r={3}/><g transform={`translate(${225 + valueOf(params, 'micPosition') * 120} 260)`} className="gr-mic-marker"><circle r={18}/><path d="M-25 0H-8M8 0H25M0 -25V-8M0 8V25"/><text x={0} y={-32} textAnchor="middle">MIC</text></g></svg></div>
            <div className="gr-cab-controls"><RigChoice id="cabinet" params={params} onParam={onParam}/><RigChoice id="micType" params={params} onParam={onParam}/><RigRange def={PARAMS.get('micPosition')!} value={valueOf(params, 'micPosition')} onChange={value => onParam('micPosition', value)} left="스피커 중앙 · 밝게" right="가장자리 · 부드럽게"/><RigRange def={PARAMS.get('micDistance')!} value={valueOf(params, 'micDistance')} onChange={value => onParam('micDistance', value)} left="가까이 · 밀도 있게" right="멀리 · 여유 있게"/>
              <p className="gr-model-note">캐비닛과 마이크는 필터 모델로 음색을 바꿉니다. 그림은 공통 패널이며 실측 IR을 사용하지 않습니다.</p>
            </div>
          </section>
        </div>
        <ol className="gr-signal-path" aria-label="실제 오디오 처리 순서">{['컴프', '드라이브', '앰프', '캐비닛 / 마이크', '코러스', '딜레이'].map((name, index) => <li key={name}><span>{String(index + 1).padStart(2, '0')}</span>{name}</li>)}</ol>
      </div>
      <footer className="gr-footer"><p id={hintId}>{GUITAR_RIG_SOUND_DESCRIPTION}</p><p><kbd>Shift</kbd> 미세 조절 · 더블 클릭 초기값 · <kbd>Esc</kbd> 닫기</p></footer>
    </section>
  </div>, document.body)
}

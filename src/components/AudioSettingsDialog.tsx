import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { WebAudioEngine } from '../audio/WebAudioEngine'
import type { InputCapture } from '../audio/InputCapture'
import {
  DEFAULT_AUDIO_SETTINGS, DEFAULT_SAMPLE_RATE, RENDER_SIZES, SAMPLE_RATES,
  type AudioSettings, type SampleRate,
} from '../core/audioSettings'
import type { Project } from '../core/types'
import { parseRecordingOffset } from '../core/recordingOffset'
import { Icon } from './Icon'
import { useAudioDevices } from './useAudioDevices'
import './AudioSettingsDialog.css'

type Tab = 'devices' | 'recording' | 'project' | 'status'
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'devices', label: '오디오 장치', icon: 'headphones' },
  { id: 'recording', label: '녹음·모니터링', icon: 'mic' },
  { id: 'project', label: '프로젝트 오디오', icon: 'wave' },
  { id: 'status', label: '상태·진단', icon: 'info' },
]
const rateText = (rate: number | null | undefined) => rate ? `${+(rate / 1000).toFixed(1)} kHz` : '확인되지 않음'
const latencyText = (seconds: number | null | undefined) => seconds == null ? '확인되지 않음' : `${(seconds * 1000).toFixed(2)} ms`
const toggleText = (value: boolean | string | undefined) => value === undefined ? '확인되지 않음' : value === 'all' ? '전체 에코 제거' : value === 'remote-only' ? '원격 오디오 에코 제거' : typeof value === 'string' ? value : value ? '켬' : '끔'
const channelText = (value: number | undefined) => value === undefined ? '확인되지 않음' : `${value}채널${value === 1 ? ' · 모노' : value === 2 ? ' · 스테레오' : ''}`

interface Props {
  engine: WebAudioEngine
  inputCapture: InputCapture
  settings: AudioSettings
  project: Project
  blockedReason: string | null
  onApply: (settings: AudioSettings, sampleRate: SampleRate) => Promise<{ persisted: boolean }>
  onClose: () => void
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="audio-setting-row"><div><strong>{label}</strong>{hint && <p>{hint}</p>}</div><div className="audio-setting-control">{children}</div></div>
}
function Fact({ name, value }: { name: string; value: ReactNode }) { return <><dt>{name}</dt><dd>{value}</dd></> }

export default function AudioSettingsDialog({ engine, inputCapture, settings, project, blockedReason, onApply, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('devices')
  const [draft, setDraft] = useState<AudioSettings>(() => ({ ...settings }))
  const [sampleRate, setSampleRate] = useState<SampleRate>(project.sampleRate)
  const [offsetText, setOffsetText] = useState(String(settings.recordingOffsetMs))
  const [applying, setApplying] = useState(false)
  const [outputTesting, setOutputTesting] = useState(false)
  const outputRequest = useRef<AbortController | null>(null)
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const audio = useSyncExternalStore(engine.subscribeAudioState, engine.getAudioState, engine.getAudioState)
  const input = useSyncExternalStore(inputCapture.subscribeInputState, inputCapture.getInputState, inputCapture.getInputState)
  const devices = useAudioDevices(draft, sampleRate)
  const offsetValue = parseRecordingOffset(offsetText)
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings) || sampleRate !== project.sampleRate || offsetValue !== settings.recordingOffsetMs
  const requiresApply = audio.needsReconfiguration || audio.status === 'error'
  const locked = applying || !!blockedReason
  const patch = (next: Partial<AudioSettings>) => { setDraft(value => ({ ...value, ...next })); setFeedback(null) }
  const inputs = devices.inputs.filter(device => device.deviceId && device.deviceId !== 'default')
  const outputs = devices.outputs.filter(device => device.deviceId && device.deviceId !== 'default')
  const missingInput = draft.inputDeviceId && !inputs.some(device => device.deviceId === draft.inputDeviceId)
  const missingOutput = draft.outputDeviceId && !outputs.some(device => device.deviceId === draft.outputDeviceId)
  const actualInput = devices.test.status === 'active' ? devices.test.settings : input.settings
  const inputLabel = devices.test.status === 'active' ? devices.test.label : input.deviceLabel
  const currentOutput = audio.contextState === 'uninitialized' ? '아직 시작하지 않음' : audio.sinkId === null ? '확인되지 않음' : audio.sinkId === '' || audio.sinkId === 'default' ? '시스템 기본 출력' : devices.outputs.find(device => device.deviceId === audio.sinkId)?.label || '선택한 출력 · 연결/권한 확인 필요'
  const problem = (feedback?.error ? feedback.text : null) || devices.test.error || devices.error || audio.error || input.error
  const message = problem || feedback?.text

  function stopOutputTest() { outputRequest.current?.abort(); outputRequest.current = null; if (alive.current) setOutputTesting(false) }
  useEffect(() => () => { outputRequest.current?.abort() }, [])
  useEffect(() => { stopOutputTest() }, [draft.outputDeviceId, draft.latencyHint, draft.renderSizeHint, sampleRate])
  useEffect(() => { if (audio.status === 'error' || audio.needsReconfiguration) stopOutputTest() }, [audio.status, audio.needsReconfiguration])

  async function apply(close = false) {
    if (locked) return
    if (offsetValue === null) { setTab('recording'); setFeedback({ error: true, text: '녹음 위치 보정은 -1000부터 1000까지의 정수로 입력해주세요.' }); return }
    if (!dirty && !requiresApply) { if (close) onClose(); return }
    setApplying(true); setFeedback(null); devices.stopInputTest(); stopOutputTest()
    const applied = { ...draft, recordingOffsetMs: offsetValue }
    try {
      const result = await onApply(applied, sampleRate)
      if (!alive.current) return
      setDraft(applied); setOffsetText(String(offsetValue))
      if (close && result.persisted) onClose()
      else setFeedback({ error: !result.persisted, text: result.persisted ? '설정을 적용했습니다.' : '설정은 적용됐지만 이 브라우저에 저장하지 못했습니다. 현재 세션에서만 유지됩니다.' })
    } catch (error) {
      if (alive.current) setFeedback({ error: true, text: error instanceof Error ? error.message : '오디오 설정을 적용하지 못했습니다.' })
    } finally { if (alive.current) setApplying(false) }
  }

  async function chooseOutput() {
    const device = await devices.chooseOutput(draft.outputDeviceId || undefined)
    if (alive.current && device) patch({ outputDeviceId: device.deviceId === 'default' ? '' : device.deviceId })
  }
  async function testOutput() {
    stopOutputTest(); setFeedback(null)
    const request = new AbortController(); outputRequest.current = request; setOutputTesting(true)
    try { await engine.testOutput(request.signal); if (alive.current && !request.signal.aborted) setFeedback({ error: false, text: '현재 적용된 출력으로 짧은 테스트 음을 재생했습니다.' }) }
    catch (error) { if (alive.current && !request.signal.aborted) setFeedback({ error: true, text: error instanceof Error ? error.message : '출력을 테스트하지 못했습니다.' }) }
    finally { if (outputRequest.current === request) { outputRequest.current = null; if (alive.current) setOutputTesting(false) } }
  }
  async function copyDiagnostics() {
    const text = [
      '가락이음 오디오 상태', `엔진: ${audio.status} · ${audio.contextState}`, ...(audio.error ? [`오디오 오류: ${audio.error}`] : []), `프로젝트 샘플레이트: ${rateText(project.sampleRate)}`,
      `엔진 샘플레이트: ${rateText(audio.sampleRate)}`, `입력: ${inputLabel || '사용 중인 입력 없음'}`,
      `입력 샘플레이트: ${rateText(actualInput?.sampleRate)}`, `입력 채널: ${channelText(actualInput?.channelCount)}`,
      `출력: ${currentOutput}`, `처리 지연: ${latencyText(audio.baseLatency)}`, `출력 지연 추정: ${latencyText(audio.outputLatency)}`,
      `렌더 블록: ${audio.renderQuantumSize ?? '확인되지 않음'}`, `소프트웨어 모니터링: ${settings.softwareMonitoring ? '켬' : '끔'}`,
    ].join('\n')
    try { await navigator.clipboard.writeText(text); if (alive.current) setFeedback({ error: false, text: '장치 ID를 제외한 오디오 상태를 복사했습니다.' }) }
    catch { if (alive.current) setFeedback({ error: true, text: '클립보드에 접근하지 못했습니다. 아래 상태 문구를 선택해 복사할 수 있습니다.' }) }
  }

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !applying) onClose() }}>
    <section className="modal audio-settings" role="dialog" aria-modal="true" aria-labelledby="audio-settings-title" aria-busy={applying}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!applying) onClose() } }}>
      <header className="audio-settings-heading"><div className="audio-settings-symbol"><Icon name="settings" size={20}/></div><div><h2 id="audio-settings-title">설정</h2><p>오디오 장치와 프로젝트의 소리를 설정합니다.</p></div><button className="icon-button" aria-label="설정 닫기" disabled={applying} onClick={onClose}><Icon name="close" size={17}/></button></header>
      <div className="audio-settings-layout">
        <nav className="audio-settings-nav" aria-label="설정 분류">
          {TABS.map(item => <button key={item.id} type="button" aria-current={tab === item.id ? 'page' : undefined} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}><Icon name={item.icon} size={16}/><span>{item.label}</span></button>)}
          <p>장치 설정은 이 브라우저에,<br/>샘플레이트는 프로젝트에<br/>저장합니다.</p>
        </nav>
        <div className="audio-settings-content">
          {tab === 'devices' && <>
            <div className="audio-settings-section-title"><h3>입출력 장치</h3><button className="audio-small-button" disabled={locked || devices.loading} onClick={() => void devices.refresh()}>{devices.loading ? '확인 중…' : '목록 새로고침'}</button></div>
            <SettingRow label="입력 장치" hint="녹음과 트랙 입력 모니터링에 사용할 마이크 또는 오디오 인터페이스입니다.">
              <select aria-label="오디오 입력 장치" value={draft.inputDeviceId} disabled={locked} onChange={event => patch({ inputDeviceId: event.target.value })}>
                <option value="">시스템 기본 입력</option>{missingInput && <option value={draft.inputDeviceId}>저장한 입력 · 연결/권한 확인 필요</option>}
                {inputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `오디오 입력 ${index + 1}`}</option>)}
              </select>
            </SettingRow>
            <SettingRow label="출력 장치" hint={audio.supportsOutputSelection ? '재생과 모니터링을 들을 스피커·헤드폰을 선택합니다.' : '이 브라우저에서는 운영체제의 기본 출력을 사용합니다.'}>
              <select aria-label="오디오 출력 장치" value={draft.outputDeviceId} disabled={locked || !audio.supportsOutputSelection} onChange={event => patch({ outputDeviceId: event.target.value })}>
                <option value="">시스템 기본 출력</option>{missingOutput && <option value={draft.outputDeviceId}>저장한 출력 · 연결/권한 확인 필요</option>}
                {outputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `오디오 출력 ${index + 1}`}</option>)}
              </select>
              {!audio.supportsOutputSelection && draft.outputDeviceId && <button className="audio-small-button" disabled={locked} onClick={() => patch({ outputDeviceId: '' })}>시스템 기본 출력으로 변경</button>}
            </SettingRow>
            <div className="audio-settings-actions">
              <button disabled={locked} onClick={() => void devices.requestInputAccess()}>마이크 접근 허용·장치 확인</button>
              {audio.supportsOutputSelection && devices.canSelectOutput && <button disabled={locked} onClick={() => void chooseOutput()}>출력 장치 선택·권한 확인</button>}
            </div>
            <p className="audio-settings-note">장치 이름이 없거나 목록에 보이지 않으면 권한과 연결을 확인하세요. 설정 창을 여는 것만으로 마이크를 켜지 않습니다.</p>
            <h3>지연과 처리</h3>
            <SettingRow label="지연 우선순위" hint="연주·녹음은 낮은 지연을, 듣기 위주의 재생은 지연을 허용한 전력 효율을 우선할 수 있습니다.">
              <select aria-label="오디오 지연 우선순위" value={draft.latencyHint} disabled={locked} onChange={event => patch({ latencyHint: event.target.value as AudioSettings['latencyHint'] })}>
                <option value="interactive">연주·녹음 · 낮은 지연 요청</option><option value="balanced">균형</option><option value="playback">재생 · 전력 효율 우선</option>
              </select>
            </SettingRow>
            <SettingRow label="렌더 블록 크기" hint={audio.supportsRenderSize ? '오디오 처리 블록의 크기를 요청합니다. 실제 적용값은 상태·진단에서 확인합니다.' : '이 브라우저에서 렌더 블록 크기 변경을 지원하지 않습니다.'}>
              <select aria-label="오디오 렌더 블록 크기" value={draft.renderSizeHint} disabled={locked || !audio.supportsRenderSize} onChange={event => patch({ renderSizeHint: event.target.value === 'default' || event.target.value === 'hardware' ? event.target.value : +event.target.value as AudioSettings['renderSizeHint'] })}>
                {RENDER_SIZES.map(size => <option key={size} value={size}>{size === 'default' ? '브라우저 기본' : size === 'hardware' ? '장치에 맞춤' : `${size} 프레임`}</option>)}
              </select>
              {!audio.supportsRenderSize && draft.renderSizeHint !== 'default' && <button className="audio-small-button" disabled={locked} onClick={() => patch({ renderSizeHint: 'default' })}>브라우저 기본으로 변경</button>}
            </SettingRow>
            <p className="audio-settings-note">지연·렌더 블록은 요청값이며 브라우저가 최종 값을 결정합니다. 오디오 인터페이스의 하드웨어 I/O 버퍼는 드라이버 설정에서 조절하세요.</p>
            <div className="audio-current-strip"><span>처리 지연 <b>{latencyText(audio.baseLatency)}</b></span><span>출력 지연 추정 <b>{latencyText(audio.outputLatency)}</b></span><button disabled={locked || (!outputTesting && (dirty || requiresApply))} onClick={() => outputTesting ? stopOutputTest() : void testOutput()} title={dirty || requiresApply ? '오디오 설정을 적용한 뒤 테스트하세요.' : '현재 적용된 출력으로 테스트 음 재생'}><Icon name={outputTesting ? 'stop' : 'play'} size={13}/>{outputTesting ? '테스트 중지' : '출력 테스트'}</button></div>
          </>}

          {tab === 'recording' && <>
            <h3>입력과 모니터링</h3>
            <label className="audio-settings-check"><input type="checkbox" checked={draft.softwareMonitoring} disabled={locked} onChange={event => patch({ softwareMonitoring: event.target.checked })}/><span><strong>소프트웨어 모니터링</strong><small>트랙의 I·녹음 상태에 따라 입력을 듣습니다. 오인페의 직접 모니터링을 사용하면 꺼주세요.</small></span></label>
            <SettingRow label="입력 채널 수" hint="브라우저에 요청할 채널 수입니다. 오인페의 개별 물리 입력 라우팅은 현재 지원하지 않습니다.">
              <select aria-label="입력 채널 수" value={draft.inputChannels} disabled={locked || !devices.supportedConstraints.channelCount} onChange={event => patch({ inputChannels: event.target.value === 'default' ? 'default' : +event.target.value as 1 | 2 })}><option value="default">장치 기본</option><option value="1">모노 · 1채널 요청</option><option value="2">스테레오 · 2채널 요청</option></select>
            </SettingRow>
            <div className="audio-input-test"><div><strong>입력 레벨 테스트</strong><span>소리를 스피커로 보내지 않고 입력만 확인합니다.</span></div><button disabled={locked} onClick={() => devices.test.status === 'active' || devices.test.status === 'requesting' ? devices.stopInputTest() : void devices.startInputTest()}>{devices.test.status === 'requesting' ? '요청 취소' : devices.test.status === 'active' ? '테스트 중지' : '입력 테스트 시작'}</button><div className="audio-test-meter" role="meter" aria-label="입력 레벨" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(devices.test.level * 100)}><i style={{ width: `${Math.min(100, devices.test.level * 100)}%` }}/></div><small>{devices.test.status === 'active' ? `${devices.test.label || '오디오 입력'} · ${rateText(devices.test.settings?.sampleRate)} · ${channelText(devices.test.settings?.channelCount)}` : devices.test.status === 'requesting' ? '마이크 권한 응답을 기다리고 있습니다.' : '테스트를 시작하면 실제 입력 상태를 확인할 수 있습니다.'}</small></div>
            <h3>입력 신호 처리</h3>
            <p className="audio-settings-note">음악 녹음 기본값은 아래 처리를 모두 끈 상태입니다. 장치에서 실제 적용한 값은 상태·진단에서 확인하세요.</p>
            {([
              ['echoCancellation', '에코 제거', '스피커 소리가 마이크에 다시 들어가는 소리를 줄이도록 요청합니다.'],
              ['noiseSuppression', '노이즈 억제', '배경 소음을 줄이도록 요청합니다. 악기 음색에도 영향을 줄 수 있습니다.'],
              ['autoGainControl', '자동 입력 레벨', '입력 소리의 크기를 자동 조절하도록 요청합니다.'],
            ] as const).map(([key, label, hint]) => <label key={key} className="audio-settings-check"><input type="checkbox" checked={draft[key]} disabled={locked || !devices.supportedConstraints[key]} onChange={event => patch({ [key]: event.target.checked })}/><span><strong>{label}{!devices.supportedConstraints[key] && <em> · 요청 미지원</em>}</strong><small>{hint}</small></span></label>)}
            <SettingRow label="녹음 위치 보정" hint="새 녹음 리전을 수동으로 정렬합니다. 양수는 뒤로, 음수는 앞으로 이동합니다. 자동 왕복 지연 측정값은 아닙니다."><div className="audio-unit-input"><input type="text" inputMode="decimal" aria-label="녹음 위치 보정 밀리초" aria-invalid={offsetValue === null} value={offsetText} disabled={locked} onChange={event => { setOffsetText(event.target.value); setFeedback(null) }} onBlur={() => { if (offsetValue === null) setFeedback({ error: true, text: '녹음 위치 보정은 -1000부터 1000까지의 정수로 입력해주세요.' }); else { patch({ recordingOffsetMs: offsetValue }); setOffsetText(String(offsetValue)) } }}/><span>ms</span></div></SettingRow>
          </>}

          {tab === 'project' && <>
            <h3>프로젝트 오디오</h3><p className="audio-project-name">{project.name}</p>
            <SettingRow label="프로젝트 샘플레이트" hint="프로젝트와 함께 저장되며 오디오 엔진의 처리율과 WAV 내보내기에 사용합니다."><select aria-label="프로젝트 샘플레이트" value={sampleRate} disabled={locked} onChange={event => { setSampleRate(+event.target.value as SampleRate); setFeedback(null) }}>{SAMPLE_RATES.map(rate => <option key={rate} value={rate}>{rateText(rate)}</option>)}</select></SettingRow>
            <p className="audio-settings-note">변경을 적용하면 재생을 일시 정지하고 오디오 엔진을 다시 준비합니다. 높은 샘플레이트는 처리량과 메모리를 더 사용하며, 브라우저가 지원하지 않는 값은 적용 오류로 안내합니다.</p>
            <dl className="audio-settings-facts" data-selectable-text="" tabIndex={0}><Fact name="저장된 프로젝트 값" value={rateText(project.sampleRate)}/><Fact name="현재 엔진 값" value={rateText(audio.sampleRate)}/><Fact name="현재 입력 값" value={rateText(actualInput?.sampleRate)}/><Fact name="WAV 내보내기" value="스테레오 · PCM 16-bit"/><Fact name="녹음 원본 형식" value="브라우저가 지원하는 WebM / MP4 / Ogg"/></dl>
            <p className="audio-settings-note">녹음 원본 코덱과 물리 장치의 클럭은 프로젝트 처리율과 별도로 결정됩니다. 현재 버전은 24-bit·32-bit PCM 원본 녹음과 다중 입력 녹음을 지원하지 않습니다.</p>
          </>}

          {tab === 'status' && <>
            <div className="audio-settings-section-title"><h3>현재 오디오 상태</h3><button className="audio-small-button" onClick={() => void copyDiagnostics()}>진단 복사</button></div>
            <dl className="audio-settings-facts" data-selectable-text="" tabIndex={0}>
              <Fact name="엔진" value={audio.status === 'error' ? '오디오 장치 확인 필요' : audio.status === 'configuring' ? '설정 적용 중' : audio.needsReconfiguration ? '설정 적용 필요' : audio.contextState === 'running' ? '실행 중' : audio.contextState === 'suspended' ? '대기 중' : audio.contextState === 'closed' ? '종료됨' : '아직 시작하지 않음'}/>
              <Fact name="프로젝트 샘플레이트" value={rateText(project.sampleRate)}/><Fact name="실제 엔진 샘플레이트" value={rateText(audio.sampleRate)}/>
              <Fact name="현재 출력" value={currentOutput}/><Fact name="처리 지연" value={latencyText(audio.baseLatency)}/><Fact name="출력 지연 추정" value={latencyText(audio.outputLatency)}/><Fact name="실제 렌더 블록" value={audio.renderQuantumSize === null ? '확인되지 않음' : `${audio.renderQuantumSize} 프레임`}/>
              <Fact name={devices.test.status === 'active' ? '테스트 중인 입력' : '사용 중인 입력'} value={inputLabel || '활성 입력 없음'}/><Fact name="실제 입력 샘플레이트" value={rateText(actualInput?.sampleRate)}/><Fact name="실제 입력 채널" value={channelText(actualInput?.channelCount)}/>
              <Fact name="실제 에코 제거" value={toggleText(actualInput?.echoCancellation)}/><Fact name="실제 노이즈 억제" value={toggleText(actualInput?.noiseSuppression)}/><Fact name="실제 자동 입력 레벨" value={toggleText(actualInput?.autoGainControl)}/>
            </dl>
            <p className="audio-settings-note">지연 값은 브라우저가 보고한 출력 경로의 추정값입니다. 마이크에서 스피커까지의 왕복 지연은 별도 측정이 필요합니다. 장치가 보고하지 않은 값은 ‘확인되지 않음’으로 표시합니다.</p>
            <h3>오디오 인터페이스에서 설정할 항목</h3><p className="audio-settings-note">하드웨어 버퍼·마이크 프리앰프 게인·팬텀 파워·직접 모니터링·클럭 소스는 오인페의 제어판 또는 운영체제 오디오 설정을 사용하세요.</p>
          </>}

          {message && <div className={`audio-settings-feedback ${problem ? 'error' : ''}`} role="status" data-selectable-text="" tabIndex={0}>{message}</div>}
          {audio.needsReconfiguration && <p className="audio-settings-note">오디오 장치를 다시 준비해야 합니다. 장치와 샘플레이트를 확인하고 적용해주세요.</p>}
        </div>
      </div>
      <footer className="audio-settings-footer"><button className="audio-reset-button" disabled={locked} onClick={() => { setDraft({ ...DEFAULT_AUDIO_SETTINGS }); setSampleRate(DEFAULT_SAMPLE_RATE); setOffsetText('0'); setFeedback(null) }}>기본값으로</button><div className="audio-settings-footer-status" role="status">{applying ? '오디오 설정을 적용하는 중…' : blockedReason || (dirty ? '적용하지 않은 변경 사항이 있습니다.' : requiresApply ? '오디오 장치를 다시 확인하고 적용해주세요.' : '현재 설정')}</div><div className="audio-settings-footer-actions"><button disabled={applying} onClick={onClose}>취소</button><button disabled={locked || (!dirty && !requiresApply)} onClick={() => void apply()}>적용</button><button className="primary" disabled={locked} onClick={() => void apply(true)}>완료</button></div></footer>
    </section>
  </div>
}

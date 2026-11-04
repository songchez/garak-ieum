import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { NativeAudioEngine } from '../audio/native/NativeAudioEngine'
import { nativeBackendForPlatform } from '../audio/native/NativeAudioEngine'
import type { NativeBackend, NativeDevice } from '../audio/native/contracts'
import { DEFAULT_AUDIO_SETTINGS, SAMPLE_RATES, type AudioSettings, type SampleRate } from '../core/audioSettings'
import { parseRecordingOffset } from '../core/recordingOffset'
import type { Project } from '../core/types'
import AppearanceSettings from './AppearanceSettings'
import { PluginSettings } from './PluginSettings'
import { Icon } from './Icon'
import './AudioSettingsDialog.css'

interface Props {
  engine: NativeAudioEngine
  settings: AudioSettings
  project: Project
  blockedReason: string | null
  onApply(settings: AudioSettings, rate: SampleRate): Promise<{ persisted: boolean }>
  onClose(): void
  initialTab?: Tab
}
export type Tab = 'devices' | 'recording' | 'project' | 'plugins' | 'appearance' | 'status'
const tabs: { id: Tab; label: string; icon: string }[] = [
  { id: 'devices', label: '오디오 장치', icon: 'headphones' },
  { id: 'recording', label: '녹음·모니터링', icon: 'mic' },
  { id: 'project', label: '프로젝트 오디오', icon: 'wave' },
  { id: 'plugins', label: '플러그인', icon: 'plug' },
  { id: 'appearance', label: '화면 테마', icon: 'palette' },
  { id: 'status', label: '상태·진단', icon: 'info' },
]
const rateText = (rate?: number | null) => rate ? `${+(rate / 1000).toFixed(1)} kHz` : '확인되지 않음'
const latency = (seconds?: number | null) => seconds == null ? '드라이버에서 보고하지 않음' : `${(seconds * 1000).toFixed(2)} ms`
const backendName = (backend: string) => backend === 'test' ? '테스트 클록 · 하드웨어 미사용' : backend === 'coreaudio' ? 'Core Audio' : backend.toUpperCase()
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="audio-setting-row"><div><strong>{label}</strong>{hint && <p>{hint}</p>}</div><div className="audio-setting-control">{children}</div></div>
}
function Fact({ name, value }: { name: string; value: ReactNode }) { return <><dt>{name}</dt><dd>{value}</dd></> }

export default function NativeAudioSettingsDialog({ engine, settings, project, blockedReason, onApply, onClose, initialTab = 'devices' }: Props) {
  const audio = useSyncExternalStore(engine.subscribeAudioState, engine.getAudioState, engine.getAudioState)
  const [tab, setTab] = useState<Tab>(initialTab)
  const [draft, setDraft] = useState({ ...settings })
  const [rate, setRate] = useState<SampleRate>(project.sampleRate)
  const [offset, setOffset] = useState(String(settings.recordingOffsetMs))
  const [devices, setDevices] = useState<NativeDevice[]>([])
  const [refreshId, setRefreshId] = useState(0)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [testing, setTesting] = useState(false)
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null)
  const [deviceError, setDeviceError] = useState<string | null>(null)
  const test = useRef<AbortController | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false; test.current?.abort() } }, [])
  const fallback: NativeBackend = engine.platform === 'darwin' ? 'coreaudio' : 'wasapi'
  let backend: NativeBackend
  try { backend = nativeBackendForPlatform(draft, engine.platform) } catch { backend = fallback }
  const patch = (value: Partial<AudioSettings>) => { setDraft(previous => ({ ...previous, ...value })); setFeedback(null); test.current?.abort(); setTesting(false) }
  useEffect(() => {
    let canceled = false
    setLoading(true); setDeviceError(null)
    void engine.listDevices(backend).then(value => { if (!canceled) setDevices(value) }, error => { if (!canceled) { setDevices([]); setDeviceError(error instanceof Error ? error.message : String(error)) } }).finally(() => { if (!canceled) setLoading(false) })
    return () => { canceled = true }
  }, [engine, backend, refreshId])
  const inputs = devices.filter(device => device.backend === 'asio' || device.inputChannels > 0), outputs = devices.filter(device => device.backend === 'asio' || device.outputChannels > 0)
  const input = inputs.find(device => device.id === draft.inputDeviceId) ?? (!draft.inputDeviceId ? inputs.find(device => device.isDefault) : undefined)
  const output = outputs.find(device => device.id === draft.outputDeviceId) ?? (!draft.outputDeviceId ? outputs.find(device => device.isDefault) : undefined)
  const offsetValue = parseRecordingOffset(offset)
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings) || rate !== project.sampleRate || offsetValue !== settings.recordingOffsetMs
  const locked = applying || !!blockedReason
  const actual = audio.nativeDevice
  const missingInput = !!draft.inputDeviceId && !inputs.some(device => device.id === draft.inputDeviceId)
  const missingOutput = !!draft.outputDeviceId && !outputs.some(device => device.id === draft.outputDeviceId)
  const actualInputLatency = actual?.inputLatencyFrames == null ? null : actual.inputLatencyFrames / actual.sampleRate
  const actualOutputLatency = actual?.outputLatencyFrames == null ? null : actual.outputLatencyFrames / actual.sampleRate

  async function apply(close: boolean) {
    if (locked) return
    if (offsetValue === null) { setTab('recording'); setFeedback({ error: true, text: '녹음 위치 보정은 -1000부터 1000까지의 정수로 입력해 주세요.' }); return }
    if (backend === 'asio' && !draft.outputDeviceId) { setTab('devices'); setFeedback({ error: true, text: '사용할 ASIO 드라이버를 선택해 주세요.' }); return }
    if (!Number.isInteger(draft.nativeBufferFrames) || draft.nativeBufferFrames < 16 || draft.nativeBufferFrames > 8192) { setFeedback({ error: true, text: '버퍼 크기는 16부터 8192까지의 정수로 입력해 주세요.' }); return }
    const value = { ...draft, recordingOffsetMs: offsetValue }
    setApplying(true); setFeedback(null); test.current?.abort()
    try {
      const result = await onApply(value, rate)
      if (!alive.current) return
      setDraft(value)
      if (close && result.persisted) onClose()
      else setFeedback({ error: !result.persisted, text: result.persisted ? '오디오 장치 설정을 적용했습니다.' : '설정은 적용됐지만 저장하지 못했습니다. 현재 앱 세션에서만 유지됩니다.' })
    } catch (error) { if (alive.current) setFeedback({ error: true, text: error instanceof Error ? error.message : String(error) }) }
    finally { if (alive.current) setApplying(false) }
  }

  async function outputTest() {
    if (testing) { test.current?.abort(); setTesting(false); return }
    const controller = new AbortController(); test.current = controller; setTesting(true); setFeedback(null)
    try { await engine.testOutput(controller.signal) }
    catch (error) { if (alive.current && !controller.signal.aborted) setFeedback({ error: true, text: error instanceof Error ? error.message : String(error) }) }
    finally { if (alive.current && test.current === controller) { test.current = null; setTesting(false) } }
  }

  async function copyStatus() {
    const text = [
      '가락이음 네이티브 오디오 상태', `플랫폼: ${engine.platform}`, `상태: ${audio.status}`,
      `드라이버: ${actual ? backendName(actual.backend) : '아직 열지 않음'}`,
      `입력: ${actual?.inputName ?? '사용하지 않음'}`, `출력: ${actual?.outputName ?? '확인되지 않음'}`,
      `프로젝트 레이트: ${rateText(project.sampleRate)}`, `실제 레이트: ${rateText(actual?.sampleRate)}`,
      `실제 I/O 버퍼: ${actual?.bufferFrames ?? '확인되지 않음'} 프레임`,
      `드라이버 입력 지연: ${latency(actualInputLatency)}`, `드라이버 출력 지연: ${latency(actualOutputLatency)}`,
      `플러그인 지연: ${audio.pluginLatencyFrames ?? 0} 프레임`, `언더런: ${audio.underruns ?? '확인되지 않음'}`,
      `명령 큐 초과: ${audio.commandOverflows ?? 0}`, `음성 수 초과: ${audio.voiceOverflows ?? 0}`,
    ].join('\n')
    try { await navigator.clipboard.writeText(text); setFeedback({ error: false, text: '장치 ID와 파일 경로를 제외한 진단 정보를 복사했습니다.' }) }
    catch { setFeedback({ error: true, text: '클립보드에 접근하지 못했습니다.' }) }
  }

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !applying) onClose() }}>
    <section className="modal audio-settings" role="dialog" aria-modal="true" aria-labelledby="native-audio-settings-title" aria-busy={applying}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!applying) onClose() } }}>
      <header className="audio-settings-heading"><div className="audio-settings-symbol"><Icon name="settings" size={20}/></div><div><h2 id="native-audio-settings-title">설정</h2><p>오디오 인터페이스와 녹음 환경을 설정합니다.</p></div><button className="icon-button" aria-label="설정 닫기" disabled={applying} onClick={onClose}><Icon name="close" size={17}/></button></header>
      <div className="audio-settings-layout">
        <nav className="audio-settings-nav" aria-label="설정 분류">{tabs.map(item => <button key={item.id} type="button" aria-current={tab === item.id ? 'page' : undefined} className={tab === item.id ? 'active' : ''} disabled={applying} onClick={() => setTab(item.id)}><Icon name={item.icon} size={16}/><span>{item.label}</span></button>)}<p>장치 설정은 이 컴퓨터에,<br/>프로젝트 레이트와 플러그인은<br/>프로젝트에 저장합니다.</p></nav>
        <div className="audio-settings-content">
          {tab === 'appearance' && <AppearanceSettings disabled={applying}/>}
          {tab === 'plugins' && <PluginSettings engine={engine}/>}
          {tab === 'devices' && <>
            <div className="audio-settings-section-title"><h3>드라이버와 장치</h3><button className="audio-small-button" disabled={locked || loading} onClick={() => setRefreshId(value => value + 1)}>{loading ? '확인 중…' : '목록 새로고침'}</button></div>
            <Row label="오디오 드라이버" hint={engine.platform === 'darwin' ? 'Apple Silicon Mac의 Core Audio 장치를 사용합니다.' : '오디오 인터페이스의 ASIO 드라이버 또는 Windows WASAPI를 선택합니다.'}>
              <select aria-label="오디오 드라이버" value={backend} disabled={locked} onChange={event => patch({ nativeBackend: event.target.value as NativeBackend, inputDeviceId: '', outputDeviceId: '', nativeInputChannel: 0 })}>
                {engine.platform === 'darwin' ? <option value="coreaudio">Core Audio</option> : <><option value="wasapi">WASAPI</option><option value="asio">ASIO</option></>}
              </select>
            </Row>
            <Row label={backend === 'asio' ? 'ASIO 장치' : '출력 장치'} hint="선택한 장치가 없으면 오류를 표시하고 재생을 중지합니다.">
              <select aria-label="오디오 출력 장치" value={draft.outputDeviceId} disabled={locked || loading} onChange={event => patch({ outputDeviceId: event.target.value, ...(backend === 'asio' ? { inputDeviceId: event.target.value } : {}) })}>
                <option value="">{backend === 'asio' ? 'ASIO 드라이버 선택' : '시스템 기본 출력'}</option>
                {missingOutput && <option value={draft.outputDeviceId}>저장한 장치 · 연결 확인 필요</option>}
                {outputs.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}
              </select>
            </Row>
            {backend !== 'asio' && <Row label="입력 장치" hint="녹음 또는 모니터링을 시작할 때 입력을 엽니다.">
              <select aria-label="오디오 입력 장치" value={draft.inputDeviceId} disabled={locked || loading} onChange={event => patch({ inputDeviceId: event.target.value, nativeInputChannel: 0 })}><option value="">시스템 기본 입력</option>{missingInput && <option value={draft.inputDeviceId}>저장한 입력 · 연결 확인 필요</option>}{inputs.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}</select>
            </Row>}
            {deviceError && <p role="alert" className="audio-settings-note">{deviceError}</p>}
            {backend === 'asio' && <button className="audio-small-button" disabled={locked || dirty || actual?.backend !== 'asio'} onClick={() => void engine.openDriverPanel().catch(error => setFeedback({ error: true, text: error instanceof Error ? error.message : String(error) }))}>ASIO 드라이버 설정 열기</button>}
            <h3>장치 버퍼</h3>
            <Row label="I/O 버퍼 크기" hint={`장치가 지원하는 프레임 수를 요청합니다.${output?.minBufferFrames ? ` 지원 범위 ${output.minBufferFrames}–${output.maxBufferFrames ?? '?'} 프레임.` : ''} 작은 버퍼는 연주 지연을 줄이지만 처리 여유도 줄어듭니다.`}>
              <div className="audio-unit-input"><input aria-label="오디오 I/O 버퍼 크기" type="number" inputMode="numeric" min={16} max={8192} step={1} value={draft.nativeBufferFrames} disabled={locked} onChange={event => patch({ nativeBufferFrames: Number(event.target.value) })}/><span>프레임</span></div>
            </Row>
            <div className="audio-settings-actions">{(output?.bufferSizes?.length ? output.bufferSizes : [64, 128, 256, 512]).filter(frames => frames >= 16 && frames <= 8192).map(frames => <button key={frames} disabled={locked} onClick={() => patch({ nativeBufferFrames: frames })}>{frames} 프레임</button>)}</div>
            <p className="audio-settings-note">실제 적용된 버퍼는 {actual ? `${actual.bufferFrames} 프레임 · ${rateText(actual.sampleRate)}` : '장치를 연 뒤 표시됩니다.'} 드라이버가 보고한 지연은 물리 왕복 측정값과 다를 수 있습니다.</p>
            <div className="audio-current-strip"><span>입력 지연 <b>{latency(actualInputLatency)}</b></span><span>출력 지연 <b>{latency(actualOutputLatency)}</b></span><button disabled={locked || (!testing && (dirty || audio.needsReconfiguration))} onClick={() => void outputTest()}><Icon name={testing ? 'stop' : 'play'} size={13}/>{testing ? '테스트 중지' : '출력 테스트'}</button></div>
          </>}
          {tab === 'recording' && <>
            <h3>입력 채널과 모니터링</h3>
            <Row label="입력 채널 구성" hint="모노는 선택한 물리 입력을 양쪽 출력으로 보냅니다. 스테레오는 연속한 두 입력을 사용합니다."><select aria-label="입력 채널 수" value={draft.inputChannels} disabled={locked} onChange={event => patch({ inputChannels: event.target.value === 'default' ? 'default' : Number(event.target.value) as 1 | 2 })}><option value="default">모노 · 기본</option><option value="1">모노</option><option value="2">스테레오</option></select></Row>
            <Row label="첫 번째 물리 입력" hint={input?.inputChannels ? `${input.name} · ${input.inputChannels}개 입력` : '선택한 장치의 물리 입력 번호입니다.'}><div className="audio-unit-input"><input type="number" aria-label="첫 번째 물리 입력" min={1} max={input?.inputChannels || 256} step={1} value={draft.nativeInputChannel + 1} disabled={locked} onChange={event => patch({ nativeInputChannel: Math.max(0, Number(event.target.value) - 1) })}/></div></Row>
            <label className="audio-settings-check"><input type="checkbox" checked={draft.softwareMonitoring} disabled={locked} onChange={event => patch({ softwareMonitoring: event.target.checked })}/><span><strong>소프트웨어 모니터링</strong><small>트랙의 I 버튼 또는 녹음 상태에 따라 이펙트를 거친 입력을 듣습니다.</small></span></label>
            <label className="audio-settings-check"><input type="checkbox" checked={draft.lowLatencyMonitoring} disabled={locked} onChange={event => patch({ lowLatencyMonitoring: event.target.checked })}/><span><strong>저지연 모니터링</strong><small>다른 트랙의 지연에 맞추는 대기를 줄입니다. 모니터링 경로에 있는 플러그인 자체의 지연은 남습니다.</small></span></label>
            <Row label="녹음 위치 보정" hint="드라이버가 보고한 지연과 엔진 지연을 먼저 보정한 뒤 추가 적용합니다. 음수는 앞으로, 양수는 뒤로 배치합니다."><div className="audio-unit-input"><input aria-label="녹음 위치 보정" inputMode="numeric" value={offset} disabled={locked} onChange={event => setOffset(event.target.value)}/><span> ms</span></div></Row>
            <p className="audio-settings-note">녹음 위치의 자동 보정은 드라이버 보고값을 바탕으로 한 추정입니다. 물리 왕복을 측정한 값은 아니며, 지연 정보가 없는 장치는 수동 보정이 필요할 수 있습니다.</p>
          </>}
          {tab === 'project' && <>
            <h3>프로젝트 샘플레이트</h3>
            <Row label="샘플레이트" hint="장치와 네이티브 재생·WAV 출력이 같은 프로젝트 레이트를 사용합니다."><select aria-label="프로젝트 샘플레이트" value={rate} disabled={locked} onChange={event => setRate(Number(event.target.value) as SampleRate)}>{SAMPLE_RATES.map(value => <option key={value} value={value}>{rateText(value)}</option>)}</select></Row>
            <p className="audio-settings-note">원본 오디오 파일은 보존하며 재생 시 필요한 레이트 변환을 수행합니다. 입력 장치가 이 레이트를 지원하는지 적용 결과를 확인해 주세요.</p>
          </>}
          {tab === 'status' && <>
            <div className="audio-settings-section-title"><h3>네이티브 엔진 상태</h3><button className="audio-small-button" onClick={() => void copyStatus()}>진단 복사</button></div>
            <dl className="audio-settings-facts" data-selectable-text="" tabIndex={0}><Fact name="상태" value={audio.status}/><Fact name="드라이버" value={actual ? backendName(actual.backend) : '아직 열지 않음'}/><Fact name="출력 장치" value={actual?.outputName ?? '확인되지 않음'}/><Fact name="입력 장치" value={actual?.inputChannels ? actual.inputName ?? '선택한 입력' : '열지 않음'}/><Fact name="프로젝트 레이트" value={rateText(project.sampleRate)}/><Fact name="실제 레이트" value={rateText(actual?.sampleRate)}/><Fact name="입력 장치 레이트" value={rateText(actual?.inputDeviceSampleRate)}/><Fact name="출력 장치 레이트" value={rateText(actual?.outputDeviceSampleRate)}/><Fact name="장치 레이트 변환" value={actual?.resampling ? '사용 중' : actual ? '없음' : '확인되지 않음'}/><Fact name="실제 I/O 버퍼" value={actual ? `${actual.bufferFrames} 프레임` : '확인되지 않음'}/><Fact name="입력 지연 · 드라이버 보고" value={latency(actualInputLatency)}/><Fact name="출력 지연 · 드라이버 보고" value={latency(actualOutputLatency)}/><Fact name="플러그인 지연" value={`${audio.pluginLatencyFrames ?? 0} 프레임`}/><Fact name="언더런" value={audio.underruns ?? '드라이버에서 보고하지 않음'}/><Fact name="명령 큐 초과" value={audio.commandOverflows ?? 0}/><Fact name="음성 수 초과" value={audio.voiceOverflows ?? 0}/></dl>
            {audio.error && <p role="alert">{audio.error}</p>}
          </>}
          {blockedReason && <p className="audio-settings-note">{blockedReason}</p>}
          {feedback && <p role={feedback.error ? 'alert' : 'status'} className={`audio-settings-feedback${feedback.error ? ' error' : ''}`}>{feedback.text}</p>}
        </div>
      </div>
      <footer className="audio-settings-footer"><button className="audio-reset-button" disabled={locked} onClick={() => { setDraft({ ...DEFAULT_AUDIO_SETTINGS }); setRate(project.sampleRate); setOffset('0'); setFeedback(null) }}>장치 설정 초기화</button><span className="audio-settings-footer-status">{dirty?'설정 변경 사항을 적용해 주세요.':'장치가 보고한 실제 값을 표시합니다.'}</span><div className="audio-settings-footer-actions"><button disabled={applying} onClick={onClose}>닫기</button><button disabled={locked || (!dirty && audio.status === 'ready' && !audio.needsReconfiguration)} onClick={() => void apply(false)}>적용</button><button className="primary-button" disabled={locked} onClick={() => void apply(true)}>{applying ? '적용 중…' : '확인'}</button></div></footer>
    </section>
  </div>
}

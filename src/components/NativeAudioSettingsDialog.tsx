import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { NativeAudioEngine } from '../audio/native/NativeAudioEngine'
import { nativeBackendForPlatform } from '../audio/native/NativeAudioEngine'
import type { NativeBackend, NativeDevice, NativeDeviceProbe } from '../audio/native/contracts'
import { describeNativeError, NATIVE_ACTION_LABELS, type NativeErrorAction, type NativeErrorAdvice } from '../audio/native/deviceErrors'
import { bufferPlan, driverChannelName, inputChoices, namesByIndex, nearestSampleRate, snapshotInputNames } from '../audio/native/deviceProfile'
import {
  DEFAULT_AUDIO_SETTINGS, MAX_RECORDING_OFFSET_FRAMES, SAMPLE_RATES, nativeInputDeviceId, nativeInputProfile, nativeOutputProfile,
  nativeProfileKey, normalizeAudioSettings, parseRecordingOffsetFrames, type AudioSettings, type NativeDeviceProfile, type SampleRate,
} from '../core/audioSettings'
import type { Project } from '../core/types'
import AppearanceSettings from './AppearanceSettings'
import { PluginSettings } from './PluginSettings'
import { NativeChannelConfig } from './NativeChannelConfig'
import { NativeLatencyWizard } from './NativeLatencyWizard'
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
export type Tab = 'devices' | 'channels' | 'recording' | 'project' | 'plugins' | 'appearance' | 'status'
const tabs: { id: Tab; label: string; icon: string }[] = [
  { id: 'devices', label: '오디오 장치', icon: 'headphones' },
  { id: 'channels', label: '입출력 채널', icon: 'mixer' },
  { id: 'recording', label: '녹음·모니터링', icon: 'mic' },
  { id: 'project', label: '프로젝트 오디오', icon: 'wave' },
  { id: 'plugins', label: '플러그인', icon: 'plug' },
  { id: 'appearance', label: '화면 테마', icon: 'palette' },
  { id: 'status', label: '상태·진단', icon: 'info' },
]
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const rateText = (rate?: number | null) => rate ? `${+(rate / 1000).toFixed(1)} kHz` : '확인되지 않음'
const latency = (seconds?: number | null) => seconds == null ? '드라이버에서 보고하지 않음' : `${(seconds * 1000).toFixed(2)} ms`
const framesLatency = (frames: number | null | undefined, rate: number | null | undefined) => frames == null || !rate ? '드라이버에서 보고하지 않음' : `${(frames * 1000 / rate).toFixed(2)} ms · ${frames} 프레임`
const backendName = (backend: string) => backend === 'test' ? '테스트 클록 · 하드웨어 미사용' : backend === 'coreaudio' ? 'Core Audio' : backend.toUpperCase()
const channelList = (channels: { index: number; name: string }[], kind: 'input' | 'output') => {
  if (!channels.length) return '없음'
  const names = channels.slice(0, 4).map(channel => driverChannelName(channel.name, channel.index, kind)).join(', ')
  return `${channels.length}개 · ${names}${channels.length > 4 ? ` 외 ${channels.length - 4}개` : ''}`
}
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="audio-setting-row"><div><strong>{label}</strong>{hint && <p>{hint}</p>}</div><div className="audio-setting-control">{children}</div></div>
}
function Fact({ name, value }: { name: string; value: ReactNode }) { return <><dt>{name}</dt><dd>{value}</dd></> }
/** The supported project rate closest to the refused one; never the refused rate itself. */
const otherRate = (advice: { supportedRates: number[]; requestedRate: number }) => nearestSampleRate(advice.supportedRates.filter(value => value !== advice.requestedRate), advice.requestedRate)

/** `devices.probe` for the selected driver; paused while recording so a probe never disturbs a take. */
function useDeviceProbe(engine: NativeAudioEngine, backend: NativeBackend, deviceId: string | null, paused: boolean, refresh: number) {
  const key = deviceId ? nativeProfileKey(backend, deviceId) : ''
  const [state, setState] = useState<{ key: string; probe: NativeDeviceProbe | null; error: string | null }>({ key: '', probe: null, error: null })
  useEffect(() => {
    if (!deviceId || paused) return
    let canceled = false
    void engine.probeDevice(backend, deviceId).then(
      probe => { if (!canceled) setState({ key, probe, error: null }) },
      error => { if (!canceled) setState({ key, probe: null, error: message(error) }) })
    return () => { canceled = true }
  }, [engine, backend, deviceId, key, paused, refresh])
  const current = state.key === key ? state : null
  return { probe: current?.probe ?? null, error: current?.error ?? null, loading: !!deviceId && !paused && !current }
}

export default function NativeAudioSettingsDialog({ engine, settings, project, blockedReason, onApply, onClose, initialTab = 'devices' }: Props) {
  const audio = useSyncExternalStore(engine.subscribeAudioState, engine.getAudioState, engine.getAudioState)
  const [tab, setTab] = useState<Tab>(initialTab)
  const [draft, setDraft] = useState({ ...settings })
  const [rate, setRate] = useState<SampleRate>(project.sampleRate)
  const [offset, setOffset] = useState(String(settings.recordingOffsetFrames))
  const [devices, setDevices] = useState<NativeDevice[]>([])
  const [refreshId, setRefreshId] = useState(0)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [testing, setTesting] = useState(false)
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null)
  const [advice, setAdvice] = useState<(NativeErrorAdvice & { requestedRate: number }) | null>(null)
  const [panelHint, setPanelHint] = useState(false)
  const [deviceError, setDeviceError] = useState<string | null>(null)
  const test = useRef<AbortController | null>(null)
  const alive = useRef(true)
  const deviceSelect = useRef<HTMLSelectElement>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false; test.current?.abort() } }, [])
  const fallback: NativeBackend = engine.platform === 'darwin' ? 'coreaudio' : 'wasapi'
  let backend: NativeBackend
  try { backend = nativeBackendForPlatform(draft, engine.platform) } catch { backend = fallback }
  const update = (change: (previous: AudioSettings) => AudioSettings) => { setDraft(change); setFeedback(null); test.current?.abort(); setTesting(false) }
  const patch = (value: Partial<AudioSettings>) => update(previous => ({ ...previous, ...value }))
  useEffect(() => {
    let canceled = false
    setLoading(true); setDeviceError(null)
    void engine.listDevices(backend).then(value => { if (!canceled) setDevices(value) }, error => { if (!canceled) { setDevices([]); setDeviceError(message(error)) } }).finally(() => { if (!canceled) setLoading(false) })
    return () => { canceled = true }
  }, [engine, backend, refreshId])
  const inputs = devices.filter(device => device.backend === 'asio' || device.inputChannels > 0), outputs = devices.filter(device => device.backend === 'asio' || device.outputChannels > 0)
  const input = inputs.find(device => device.id === draft.inputDeviceId) ?? (!draft.inputDeviceId ? inputs.find(device => device.isDefault) : undefined)
  const output = outputs.find(device => device.id === draft.outputDeviceId) ?? (!draft.outputDeviceId ? outputs.find(device => device.isDefault) : undefined)
  const offsetValue = parseRecordingOffsetFrames(offset)
  // Compare normalized values: names are trimmed and empty entries dropped only when settings are saved.
  const dirty = JSON.stringify(normalizeAudioSettings(draft)) !== JSON.stringify(settings) || rate !== project.sampleRate || offsetValue !== settings.recordingOffsetFrames
  const locked = applying || !!blockedReason
  const actual = audio.nativeDevice
  const missingInput = !!draft.inputDeviceId && !inputs.some(device => device.id === draft.inputDeviceId)
  const missingOutput = !!draft.outputDeviceId && !outputs.some(device => device.id === draft.outputDeviceId)
  const actualInputLatency = actual?.inputLatencyFrames == null ? null : actual.inputLatencyFrames / actual.sampleRate
  const actualOutputLatency = actual?.outputLatencyFrames == null ? null : actual.outputLatencyFrames / actual.sampleRate

  // ASIO is one device for both directions; other backends probe output and input separately.
  const outputProbeId = backend === 'asio' ? draft.outputDeviceId || null : output?.id ?? (draft.outputDeviceId || null)
  const inputProbeId = backend === 'asio' ? null : input?.id ?? (draft.inputDeviceId || null)
  const outputProbe = useDeviceProbe(engine, backend, outputProbeId, !!blockedReason || applying, refreshId)
  const separateInputProbe = useDeviceProbe(engine, backend, inputProbeId, !!blockedReason || applying, refreshId)
  const inputProbe = backend === 'asio' ? outputProbe : separateInputProbe
  const probe = outputProbe.probe
  const runningHere = !!actual && actual.backend === backend && !!probe && actual.outputDeviceId === probe.id
  const buffer = bufferPlan(probe, output, draft.nativeBufferFrames)
  const deviceRate = probe?.currentSampleRate ?? actual?.sampleRate ?? rate
  const rateUnsupported = !!probe?.sampleRates.length && !probe.sampleRates.includes(rate)
  const suggestedRate = probe ? nearestSampleRate(probe.sampleRates, rate) : null

  // Channel configuration: driver channel lists from the probe, else the device list's counts.
  const inputKey = nativeProfileKey(backend, nativeInputDeviceId(draft, backend)), outputKey = nativeProfileKey(backend, draft.outputDeviceId)
  const inputProfile = nativeInputProfile(draft, backend), outputProfile = nativeOutputProfile(draft, backend)
  const countList = (count: number | undefined) => Array.from({ length: Math.min(256, count ?? 0) }, (_, index) => ({ index, name: '' }))
  const inputChannels = inputProbe.probe?.inputs.length ? inputProbe.probe.inputs : countList(input?.inputChannels)
  const outputChannels = probe?.outputs.length ? probe.outputs : countList(output?.outputChannels)
  const changeProfile = (key: string, change: (profile: NativeDeviceProfile) => NativeDeviceProfile) => update(previous => {
    // Start from what is in effect for that key: a saved profile or the one migrated from legacy settings.
    const base = previous.nativeDeviceProfiles[key] ?? (key === nativeProfileKey(backend, nativeInputDeviceId(previous, backend)) ? nativeInputProfile(previous, backend) : nativeOutputProfile(previous, backend))
    return { ...previous, nativeDeviceProfiles: { ...previous.nativeDeviceProfiles, [key]: change(base) } }
  })
  const channelNote = backend === 'asio' && !draft.outputDeviceId ? 'ASIO 드라이버를 먼저 선택해 주세요.'
    : inputProbe.loading ? '장치의 채널 정보를 읽는 중…'
    : blockedReason && !inputProbe.probe ? '녹음이 끝난 뒤 장치의 채널 정보를 읽습니다.'
    : inputProbe.error ? `장치 채널 이름을 읽지 못해 번호로 표시합니다. ${inputProbe.error}`
    : !inputChannels.length ? '이 장치에서 사용할 수 있는 입력을 찾지 못했습니다.' : null

  // The latency wizard measures the applied, running device.
  const appliedBackend = actual?.backend === 'test' ? backend : actual?.backend ?? backend
  const appliedProfile = nativeInputProfile(settings, appliedBackend)
  const appliedNames = runningHere && inputProbe.probe ? namesByIndex(inputProbe.probe.inputs) : snapshotInputNames(actual)
  const wizardInputs = inputChoices(appliedProfile, appliedNames).filter(choice => choice.channels.length === 1)
  const outputCount = actual?.outputChannels || probe?.outputs.length || 2
  const wizardOutputs = Array.from({ length: Math.max(1, Math.floor(outputCount / 2)) }, (_, pair) => ({ offset: pair * 2, label: `출력 ${pair * 2 + 1}-${pair * 2 + 2}` }))
  const wizardBlocked = dirty ? '변경한 설정을 먼저 적용한 뒤 측정해 주세요.' : blockedReason ?? (audio.status !== 'ready' || !actual ? '오디오 장치를 먼저 적용해 주세요.' : null)

  async function apply(close: boolean, override: { settings?: AudioSettings; rate?: SampleRate } = {}) {
    if (locked) return
    if (offsetValue === null) { setTab('recording'); setFeedback({ error: true, text: `녹음 위치 보정은 -${MAX_RECORDING_OFFSET_FRAMES}부터 ${MAX_RECORDING_OFFSET_FRAMES}까지의 정수(프레임)로 입력해 주세요.` }); return }
    const base = override.settings ?? draft, targetRate = override.rate ?? rate
    if (backend === 'asio' && !base.outputDeviceId) { setTab('devices'); setFeedback({ error: true, text: '사용할 ASIO 드라이버를 선택해 주세요.' }); return }
    const value = normalizeAudioSettings({ ...base, recordingOffsetFrames: offsetValue })
    setApplying(true); setFeedback(null); setAdvice(null); setPanelHint(false); test.current?.abort()
    try {
      const result = await onApply(value, targetRate)
      if (!alive.current) return
      setDraft(value)
      if (close && result.persisted) onClose()
      else setFeedback({ error: !result.persisted, text: result.persisted ? '오디오 장치 설정을 적용했습니다.' : '설정은 적용됐지만 저장하지 못했습니다. 현재 앱 세션에서만 유지됩니다.' })
    } catch (error) {
      if (!alive.current) return
      const described = describeNativeError(error, { backend, requestedRate: targetRate, probeRates: probe?.sampleRates })
      if (described) setAdvice({ ...described, requestedRate: targetRate })
      else setFeedback({ error: true, text: message(error) })
    } finally { if (alive.current) setApplying(false) }
  }

  async function openPanel() {
    // Name the selected driver: after a failed configure it is not the running one.
    try { await engine.openDriverPanel(runningHere ? undefined : { backend, deviceId: draft.outputDeviceId }); return true }
    catch (error) { if (alive.current) setFeedback({ error: true, text: message(error) }); return false }
  }

  function act(action: NativeErrorAction) {
    switch (action) {
      case 'retry': void apply(false); break
      case 'controlPanel': void openPanel(); break
      case 'otherDevice': setAdvice(null); setTab('devices'); requestAnimationFrame(() => deviceSelect.current?.focus()); break
      case 'channels': setAdvice(null); setTab('channels'); break
      case 'driverBuffer': { const value = { ...draft, nativeBufferFrames: 'driver' as const }; setDraft(value); void apply(false, { settings: value }); break }
      case 'supportedRate': { const next = advice && otherRate(advice); if (next) { setRate(next); void apply(false, { rate: next }) } break }
    }
  }

  /** Live changes on the running device; the draft keeps them for the next engine.configure too. */
  function liveDevice(run: () => Promise<void>) {
    if (!runningHere || locked) return
    void run().catch(error => { if (alive.current) setFeedback({ error: true, text: message(error) }) })
  }

  async function outputTest() {
    if (testing) { test.current?.abort(); setTesting(false); return }
    const controller = new AbortController(); test.current = controller; setTesting(true); setFeedback(null)
    try { await engine.testOutput(controller.signal) }
    catch (error) { if (alive.current && !controller.signal.aborted) setFeedback({ error: true, text: message(error) }) }
    finally { if (alive.current && test.current === controller) { test.current = null; setTesting(false) } }
  }

  async function copyStatus() {
    const text = [
      '가락이음 네이티브 오디오 상태', `플랫폼: ${engine.platform}`, `상태: ${audio.status}`,
      `드라이버: ${actual ? backendName(actual.backend) : '아직 열지 않음'}`,
      `입력: ${actual?.inputName ?? '사용하지 않음'}`, `출력: ${actual?.outputName ?? '확인되지 않음'}`,
      `열린 입력 채널: ${actual?.inputChannelList?.map(channel => channel + 1).join(', ') || '없음'}`,
      `프로젝트 레이트: ${rateText(project.sampleRate)}`, `실제 레이트: ${rateText(actual?.sampleRate)}`,
      `실제 I/O 버퍼: ${actual?.bufferFrames ?? '확인되지 않음'} 프레임${actual?.bufferAdjusted ? ' (드라이버가 맞춤)' : ''}`,
      `드라이버 입력 지연: ${latency(actualInputLatency)}`, `드라이버 출력 지연: ${latency(actualOutputLatency)}`,
      `플러그인 지연: ${audio.pluginLatencyFrames ?? 0} 프레임`, `언더런: ${audio.underruns ?? '확인되지 않음'}`,
      `과부하: ${actual?.overloads ?? '확인되지 않음'}`, `콜백 부하: ${actual?.lastCallbackLoad == null ? '확인되지 않음' : `${Math.round(actual.lastCallbackLoad * 100)}%`}`,
      `장치 복구: ${actual?.recovering ? '다시 연결하는 중' : '정상'} · ${actual?.recoveries ?? 0}회`, `드라이버 해제: ${actual?.suspended ? '예' : '아니요'}`,
      `명령 큐 초과: ${audio.commandOverflows ?? 0}`, `음성 수 초과: ${audio.voiceOverflows ?? 0}`,
    ].join('\n')
    try { await navigator.clipboard.writeText(text); setFeedback({ error: false, text: '장치 ID와 파일 경로를 제외한 진단 정보를 복사했습니다.' }) }
    catch { setFeedback({ error: true, text: '클립보드에 접근하지 못했습니다.' }) }
  }

  const rateAdvice = advice?.code === 'SAMPLE_RATE_UNSUPPORTED' ? advice : null
  const rateChoice = rateAdvice ? otherRate(rateAdvice) : null
  const footerStatus = actual?.recovering ? '장치를 다시 연결하는 중…' : actual?.suspended ? '백그라운드에서 드라이버를 해제했습니다.' : dirty ? '설정 변경 사항을 적용해 주세요.' : '장치가 보고한 실제 값을 표시합니다.'

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
              <select aria-label="오디오 드라이버" value={backend} disabled={locked} onChange={event => patch({ nativeBackend: event.target.value as NativeBackend, inputDeviceId: '', outputDeviceId: '', nativeInputChannel: 0, clockSource: undefined })}>
                {engine.platform === 'darwin' ? <option value="coreaudio">Core Audio</option> : <><option value="wasapi">WASAPI</option><option value="asio">ASIO</option></>}
              </select>
            </Row>
            <Row label={backend === 'asio' ? 'ASIO 장치' : '출력 장치'} hint="선택한 장치가 없으면 오류를 표시하고 재생을 중지합니다.">
              <select ref={deviceSelect} aria-label="오디오 출력 장치" value={draft.outputDeviceId} disabled={locked || loading} onChange={event => patch({ outputDeviceId: event.target.value, clockSource: undefined, ...(backend === 'asio' ? { inputDeviceId: event.target.value } : {}) })}>
                <option value="">{backend === 'asio' ? 'ASIO 드라이버 선택' : '시스템 기본 출력'}</option>
                {missingOutput && <option value={draft.outputDeviceId}>저장한 장치 · 연결 확인 필요</option>}
                {outputs.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}
              </select>
            </Row>
            {backend !== 'asio' && <Row label="입력 장치" hint="녹음 또는 모니터링을 시작할 때 입력을 엽니다.">
              <select aria-label="오디오 입력 장치" value={draft.inputDeviceId} disabled={locked || loading} onChange={event => patch({ inputDeviceId: event.target.value, nativeInputChannel: 0 })}><option value="">시스템 기본 입력</option>{missingInput && <option value={draft.inputDeviceId}>저장한 입력 · 연결 확인 필요</option>}{inputs.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}</select>
            </Row>}
            {deviceError && <p role="alert" className="audio-settings-note">{deviceError}</p>}
            {outputProbeId && <div className="audio-device-info" aria-live="polite">
              {outputProbe.loading ? <p className="audio-settings-note">장치 정보를 읽는 중…</p>
                : outputProbe.error ? <p className="audio-settings-note">장치 정보를 읽지 못했습니다. {outputProbe.error}</p>
                : blockedReason && !probe ? <p className="audio-settings-note">녹음이 끝난 뒤 장치 정보를 읽습니다.</p>
                : probe && <dl className="audio-settings-facts">
                  <Fact name="입력 채널" value={channelList(inputProbe.probe?.inputs ?? [], 'input')}/>
                  <Fact name="출력 채널" value={channelList(probe.outputs, 'output')}/>
                  <Fact name="지원 샘플레이트" value={probe.sampleRates.length ? probe.sampleRates.map(rateText).join(', ') : '드라이버에서 보고하지 않음'}/>
                  <Fact name="현재 장치 레이트" value={rateText(probe.currentSampleRate)}/>
                  <Fact name="입력 지연 · 드라이버 보고" value={framesLatency(probe.inputLatencyFrames, deviceRate)}/>
                  <Fact name="출력 지연 · 드라이버 보고" value={framesLatency(probe.outputLatencyFrames, deviceRate)}/>
                </dl>}
              {rateUnsupported && <p className="audio-settings-note audio-warning">이 장치는 프로젝트 레이트 {rateText(rate)}를 지원하지 않습니다.{suggestedRate && <> <button className="audio-small-button" disabled={locked} onClick={() => { setRate(suggestedRate); setFeedback(null) }}>프로젝트를 {rateText(suggestedRate)}로 변경</button></>}</p>}
            </div>}
            {probe && probe.clockSources.length > 1 && <Row label="클럭 소스" hint="여러 장비를 디지털로 연결했다면 마스터 클럭을 고릅니다. 잘못 고르면 잡음이나 끊김이 생깁니다.">
              <select aria-label="클럭 소스" value={draft.clockSource ?? probe.clockSources.find(source => source.current)?.index ?? probe.clockSources[0].index} disabled={locked}
                onChange={event => { const index = Number(event.target.value); patch({ clockSource: index }); liveDevice(() => engine.setClockSource(index)) }}>
                {probe.clockSources.map(source => <option key={source.index} value={source.index}>{source.name}</option>)}
              </select>
            </Row>}
            {backend === 'asio' && <button className="audio-small-button" disabled={locked || !draft.outputDeviceId} onClick={() => void openPanel()}>ASIO 드라이버 설정 열기</button>}
            <h3>장치 버퍼</h3>
            <Row label="I/O 버퍼 크기" hint={buffer.fixed ? '이 드라이버는 버퍼 크기를 하나만 허용합니다. 바꾸려면 드라이버 제어판을 사용하세요.' : '드라이버가 허용하는 크기만 보여 줍니다. 작은 버퍼는 연주 지연을 줄이지만 처리 여유도 줄어듭니다.'}>
              <select aria-label="오디오 I/O 버퍼 크기" value={buffer.fixed ? 'driver' : String(draft.nativeBufferFrames)} disabled={locked || buffer.fixed} onChange={event => patch({ nativeBufferFrames: event.target.value === 'driver' ? 'driver' : Number(event.target.value) })}>
                {buffer.options.map(option => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
              </select>
              {buffer.fixed && backend === 'asio' && <button className="audio-small-button" disabled={locked || !draft.outputDeviceId} onClick={() => void openPanel()}>제어판 열기</button>}
            </Row>
            {actual?.bufferAdjusted && <p className="audio-settings-note audio-warning" role="status">드라이버가 {actual.bufferFrames} 프레임으로 맞췄습니다. 요청한 크기는 이 드라이버에서 쓸 수 없습니다.</p>}
            <p className="audio-settings-note">실제 적용된 버퍼는 {actual ? `${actual.bufferFrames} 프레임 · ${rateText(actual.sampleRate)}` : '장치를 연 뒤 표시됩니다.'} 드라이버가 보고한 지연은 물리 왕복 측정값과 다를 수 있습니다.</p>
            <div className="audio-current-strip"><span>입력 지연 <b>{latency(actualInputLatency)}</b></span><span>출력 지연 <b>{latency(actualOutputLatency)}</b></span><button disabled={locked || (!testing && (dirty || audio.needsReconfiguration))} onClick={() => void outputTest()}><Icon name={testing ? 'stop' : 'play'} size={13}/>{testing ? '테스트 중지' : '출력 테스트'}</button></div>
            <h3>드라이버 사용</h3>
            <label className="audio-settings-check"><input type="checkbox" checked={draft.releaseInBackground} disabled={locked} onChange={event => patch({ releaseInBackground: event.target.checked })}/><span><strong>백그라운드에서 드라이버 해제</strong><small>다른 앱으로 전환하면 재생을 멈추고 장치를 닫아 다른 프로그램이 쓸 수 있게 합니다. 돌아오면 같은 설정으로 다시 엽니다. 녹음 중에는 해제하지 않습니다.</small></span></label>
          </>}
          {tab === 'channels' && <NativeChannelConfig inputs={inputChannels} outputs={outputChannels} inputProfile={inputProfile} outputProfile={outputProfile} disabled={locked} note={channelNote}
            onInputs={change => changeProfile(inputKey, change)} onOutputs={change => changeProfile(outputKey, change)}/>}
          {tab === 'recording' && <>
            <h3>모니터링</h3>
            <label className="audio-settings-check"><input type="checkbox" checked={draft.softwareMonitoring} disabled={locked} onChange={event => patch({ softwareMonitoring: event.target.checked })}/><span><strong>소프트웨어 모니터링</strong><small>트랙의 I 버튼 또는 녹음 상태에 따라 이펙트를 거친 입력을 듣습니다.</small></span></label>
            <label className="audio-settings-check"><input type="checkbox" checked={draft.lowLatencyMonitoring} disabled={locked} onChange={event => patch({ lowLatencyMonitoring: event.target.checked })}/><span><strong>저지연 모니터링</strong><small>다른 트랙의 지연에 맞추는 대기를 줄입니다. 모니터링 경로에 있는 플러그인 자체의 지연은 남습니다.</small></span></label>
            {probe?.canDirectMonitor && <label className="audio-settings-check"><input type="checkbox" checked={draft.directMonitoring} disabled={locked} onChange={event => { const enabled = event.target.checked; patch({ directMonitoring: enabled }); liveDevice(() => engine.setDirectMonitoring(enabled)) }}/><span><strong>직접 모니터링</strong><small>인터페이스가 입력을 바로 출력으로 보냅니다. 지연이 없지만 이펙트는 들리지 않으므로 소프트웨어 모니터링과 함께 켜면 소리가 겹칠 수 있습니다.</small></span></label>}
            <h3>녹음 위치 보정</h3>
            <Row label="추가 보정" hint="드라이버가 보고한 지연과 엔진 지연을 먼저 보정한 뒤 추가로 적용합니다. 음수는 앞으로, 양수는 뒤로 배치합니다. 아래 측정 결과를 적용할 수도 있습니다.">
              <div className="audio-unit-input"><input aria-label="녹음 위치 보정 프레임" inputMode="numeric" aria-invalid={offsetValue === null} value={offset} disabled={locked} onChange={event => { setOffset(event.target.value); setFeedback(null) }}/><span>프레임{offsetValue !== null && offsetValue !== 0 ? ` · ${(offsetValue * 1000 / rate).toFixed(2)} ms` : ''}</span></div>
            </Row>
            <h3>왕복 지연 측정</h3>
            <NativeLatencyWizard engine={engine} inputs={wizardInputs} outputs={wizardOutputs} sampleRate={actual?.sampleRate ?? rate} blocked={wizardBlocked}
              onApply={frames => { setOffset(String(frames)); setFeedback({ error: false, text: `녹음 위치 보정을 ${frames} 프레임으로 바꿨습니다. 적용을 눌러 저장하세요.` }) }}/>
          </>}
          {tab === 'project' && <>
            <h3>프로젝트 샘플레이트</h3>
            <Row label="샘플레이트" hint="장치와 네이티브 재생·WAV 출력이 같은 프로젝트 레이트를 사용합니다."><select aria-label="프로젝트 샘플레이트" value={rate} disabled={locked} onChange={event => setRate(Number(event.target.value) as SampleRate)}>{SAMPLE_RATES.map(value => <option key={value} value={value}>{rateText(value)}{probe?.sampleRates.length && !probe.sampleRates.includes(value) ? ' · 장치 미지원' : ''}</option>)}</select></Row>
            <p className="audio-settings-note">원본 오디오 파일은 보존하며 재생 시 필요한 레이트 변환을 수행합니다. 프로젝트 레이트 변경은 실행 취소할 수 있습니다.</p>
          </>}
          {tab === 'status' && <>
            <div className="audio-settings-section-title"><h3>네이티브 엔진 상태</h3><button className="audio-small-button" onClick={() => void copyStatus()}>진단 복사</button></div>
            <dl className="audio-settings-facts" data-selectable-text="" tabIndex={0}><Fact name="상태" value={audio.status}/><Fact name="드라이버" value={actual ? backendName(actual.backend) : '아직 열지 않음'}/><Fact name="출력 장치" value={actual?.outputName ?? '확인되지 않음'}/><Fact name="입력 장치" value={actual?.inputChannels ? actual.inputName ?? '선택한 입력' : '열지 않음'}/><Fact name="열린 입력 채널" value={actual?.inputChannelList?.length ? actual.inputChannelList.map(channel => channel + 1).join(', ') : actual?.inputChannels ? `${actual.inputChannels}개` : '없음'}/><Fact name="프로젝트 레이트" value={rateText(project.sampleRate)}/><Fact name="실제 레이트" value={rateText(actual?.sampleRate)}/><Fact name="입력 장치 레이트" value={rateText(actual?.inputDeviceSampleRate)}/><Fact name="출력 장치 레이트" value={rateText(actual?.outputDeviceSampleRate)}/><Fact name="장치 레이트 변환" value={actual?.resampling ? '사용 중' : actual ? '없음' : '확인되지 않음'}/><Fact name="실제 I/O 버퍼" value={actual ? `${actual.bufferFrames} 프레임${actual.bufferAdjusted ? ' · 드라이버가 맞춤' : ''}` : '확인되지 않음'}/><Fact name="입력 지연 · 드라이버 보고" value={latency(actualInputLatency)}/><Fact name="출력 지연 · 드라이버 보고" value={latency(actualOutputLatency)}/><Fact name="플러그인 지연" value={`${audio.pluginLatencyFrames ?? 0} 프레임`}/><Fact name="과부하" value={actual?.overloads ?? '확인되지 않음'}/><Fact name="최근 콜백 부하" value={actual?.lastCallbackLoad == null ? '확인되지 않음' : `${Math.round(actual.lastCallbackLoad * 100)}%`}/><Fact name="장치 복구" value={actual?.recovering ? '장치를 다시 연결하는 중…' : actual ? `정상 · 자동 복구 ${actual.recoveries ?? 0}회` : '확인되지 않음'}/><Fact name="드라이버 해제" value={actual?.suspended ? '백그라운드에서 해제됨' : '사용 중'}/><Fact name="언더런" value={audio.underruns ?? '드라이버에서 보고하지 않음'}/><Fact name="명령 큐 초과" value={audio.commandOverflows ?? 0}/><Fact name="음성 수 초과" value={audio.voiceOverflows ?? 0}/></dl>
            {audio.error && <p role="alert">{audio.error}</p>}
          </>}
          {blockedReason && <p className="audio-settings-note">{blockedReason}</p>}
          {advice && <div className="audio-problem" role="alert">
            <strong>{rateAdvice ? '장치와 프로젝트의 샘플레이트가 다릅니다' : advice.title}</strong>
            <p>{advice.text}</p>
            {rateAdvice ? <>
              {panelHint && <p>{backend === 'asio' ? `드라이버 제어판에서 샘플레이트를 ${rateText(rateAdvice.requestedRate)}로 바꾼 뒤 다시 시도를 눌러 주세요.` : `운영체제의 소리 설정에서 장치 형식을 ${rateText(rateAdvice.requestedRate)}로 바꾼 뒤 다시 시도를 눌러 주세요.`}</p>}
              <div className="audio-settings-actions">
                {!panelHint ? <button disabled={locked} onClick={() => { setPanelHint(true); if (backend === 'asio') void openPanel() }}>장치를 {rateText(rateAdvice.requestedRate)}로 맞추기</button> : <button disabled={locked} onClick={() => void apply(false)}>다시 시도</button>}
                {rateChoice && <button disabled={locked} onClick={() => act('supportedRate')}>프로젝트를 {rateText(rateChoice)}로 변경</button>}
                <button disabled={applying} onClick={() => { setAdvice(null); setPanelHint(false) }}>취소</button>
              </div>
              {rateChoice && <p>프로젝트 레이트 변경은 실행 취소할 수 있습니다. 원본 오디오는 그대로 두고 재생할 때 변환합니다.</p>}
            </> : <div className="audio-settings-actions">{advice.actions.map(action => <button key={action} disabled={locked && action !== 'otherDevice' && action !== 'channels'} onClick={() => act(action)}>{NATIVE_ACTION_LABELS[action]}</button>)}</div>}
          </div>}
          {feedback && <p role={feedback.error ? 'alert' : 'status'} className={`audio-settings-feedback${feedback.error ? ' error' : ''}`}>{feedback.text}</p>}
        </div>
      </div>
      <footer className="audio-settings-footer"><button className="audio-reset-button" disabled={locked} onClick={() => { setDraft({ ...DEFAULT_AUDIO_SETTINGS, nativeDeviceProfiles: draft.nativeDeviceProfiles }); setRate(project.sampleRate); setOffset('0'); setFeedback(null); setAdvice(null) }}>장치 설정 초기화</button><span className="audio-settings-footer-status">{footerStatus}</span><div className="audio-settings-footer-actions"><button disabled={applying} onClick={onClose}>닫기</button><button disabled={locked || (!dirty && audio.status === 'ready' && !audio.needsReconfiguration)} onClick={() => void apply(false)}>적용</button><button className="primary-button" disabled={locked} onClick={() => void apply(true)}>{applying ? '적용 중…' : '확인'}</button></div></footer>
    </section>
  </div>
}

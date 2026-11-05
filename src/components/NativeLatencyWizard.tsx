import { useEffect, useRef, useState } from 'react'
import type { NativeAudioEngine } from '../audio/native/NativeAudioEngine'
import type { NativeLatencyMeasurement } from '../audio/native/contracts'
import { latencyOffsetFrames } from '../audio/native/deviceProfile'
import type { InputChoice } from '../core/types'

/** WP2 adds `measureLatency` (host `latency.measure`); older engines are detected at run time. */
type Measurer = NativeAudioEngine & { measureLatency?: (options: { inputChannel: number; outputChannelOffset?: number }) => Promise<NativeLatencyMeasurement> }

interface Props {
  engine: NativeAudioEngine
  /** Mono inputs the running device has open. */
  inputs: InputChoice[]
  /** Output pairs as `{ offset, label }` (first channel of each pair). */
  outputs: { offset: number; label: string }[]
  sampleRate: number
  /** Why measuring is not possible right now, or null. */
  blocked: string | null
  onApply(frames: number): void
}

const ms = (frames: number | null, rate: number) => frames === null || !rate ? '확인되지 않음' : `${(frames * 1000 / rate).toFixed(2)} ms · ${frames} 프레임`

/** Loopback wizard: a cable from an output to an input measures the real round trip the driver report misses. */
export function NativeLatencyWizard({ engine, inputs, outputs, sampleRate, blocked, onApply }: Props) {
  const [input, setInput] = useState(inputs[0]?.channels[0] ?? 0)
  const [output, setOutput] = useState(outputs[0]?.offset ?? 0)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<NativeLatencyMeasurement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { if (inputs.length && !inputs.some(choice => choice.channels[0] === input)) setInput(inputs[0].channels[0]) }, [inputs, input])
  const measurer = engine as Measurer
  const supported = typeof measurer.measureLatency === 'function'
  const offset = result ? latencyOffsetFrames(result) : null

  async function measure() {
    if (!measurer.measureLatency) return
    setRunning(true); setError(null); setResult(null)
    try {
      engine.pause()
      const value = await measurer.measureLatency({ inputChannel: input, outputChannelOffset: output })
      if (alive.current) setResult(value)
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { if (alive.current) setRunning(false) }
  }

  return <div className="audio-latency-wizard">
    <ol>
      <li>모니터 스피커와 헤드폰 볼륨을 줄입니다. 측정 신호는 짧은 클릭음입니다.</li>
      <li>케이블로 인터페이스의 출력 하나를 입력 하나에 직접 연결합니다(루프백). 마이크·프리앰프 게인은 중간 정도로 둡니다.</li>
      <li>연결한 출력과 입력을 고른 뒤 측정을 시작합니다. 재생은 멈춥니다.</li>
    </ol>
    <div className="audio-latency-controls">
      <label><span>출력</span><select aria-label="측정 출력" value={output} disabled={running || !outputs.length} onChange={event => setOutput(Number(event.target.value))}>{outputs.map(item => <option key={item.offset} value={item.offset}>{item.label}</option>)}</select></label>
      <label><span>입력</span><select aria-label="측정 입력" value={input} disabled={running || !inputs.length} onChange={event => setInput(Number(event.target.value))}>{inputs.map(choice => <option key={choice.channels[0]} value={choice.channels[0]}>{choice.label}</option>)}</select></label>
      <button type="button" className="audio-small-button" disabled={running || !!blocked || !supported || !inputs.length} onClick={() => void measure()}>{running ? '측정 중…' : '측정 시작'}</button>
    </div>
    {!supported && <p className="audio-settings-note">이 버전의 오디오 엔진은 지연 측정을 지원하지 않습니다. 앱을 업데이트해 주세요.</p>}
    {supported && blocked && <p className="audio-settings-note">{blocked}</p>}
    {supported && !blocked && !inputs.length && <p className="audio-settings-note">입출력 채널 설정에서 측정에 쓸 입력을 켜 주세요.</p>}
    {error && <p role="alert" className="audio-settings-feedback error">{error}</p>}
    {result && <div role="status" className="audio-latency-result">
      {result.confidence > 0 ? <dl className="audio-settings-facts">
        <dt>측정한 왕복 지연</dt><dd>{ms(result.roundTripFrames, sampleRate)}</dd>
        <dt>드라이버 보고값 · 이미 보정됨</dt><dd>{ms(result.reportedFrames, sampleRate)}</dd>
        <dt>추가로 보정할 지연</dt><dd>{ms(result.extraFrames ?? (offset === null ? null : -offset), sampleRate)}</dd>
        <dt>신뢰도</dt><dd>{Math.round(result.confidence * 100)}% · {result.attempts}회 측정</dd>
      </dl> : <p className="audio-settings-feedback error">신호를 찾지 못했습니다. 케이블 연결, 선택한 출력·입력, 입력 게인을 확인한 뒤 다시 측정해 주세요.</p>}
      {result.confidence > 0 && result.confidence < .6 && <p className="audio-settings-note">측정값이 고르지 않습니다. 잡음이 적은 곳에서 게인을 조정하고 다시 측정하는 것을 권장합니다.</p>}
      {offset !== null && <button type="button" className="audio-small-button" onClick={() => onApply(offset)}>녹음 위치 보정에 적용 ({offset > 0 ? '+' : ''}{offset} 프레임)</button>}
    </div>}
  </div>
}

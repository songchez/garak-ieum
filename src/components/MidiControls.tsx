import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { MIDI_RECORD_MODE_LABELS, type MidiRecordMode } from '../core/midiRecording'
import { musicalTypingOctaveLabel } from '../core/musicalTyping'
import type { MidiPerformance } from './useMidiPerformance'
import './MidiControls.css'

/** Header MIDI tools: input activity, computer-keyboard playing, Capture and the record mode (docs/MIDI_RECORDING.md). */
export function MidiControls({ midi, captureShortcut, typingShortcut }: { midi: MidiPerformance; captureShortcut: string; typingShortcut: string }) {
  const [active, setActive] = useState(false)
  const timer = useRef<number | null>(null)
  const { subscribeInput } = midi
  useEffect(() => subscribeInput(() => {
    setActive(true)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setActive(false), 140)
  }), [subscribeInput])
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current) }, [])
  if (!midi.supported) return null
  const typing = midi.typing
  return <div className="midi-controls" role="group" aria-label="MIDI">
    <span className={`midi-activity${active ? ' on' : ''}`} title="MIDI 입력 표시" aria-hidden="true" />
    <button type="button" className={`icon-button header-toggle${typing.enabled ? ' active' : ''}`} aria-pressed={typing.enabled} onClick={() => midi.toggleTyping()}
      title={`컴퓨터 키보드 연주 · ${typingShortcut}\nA~K: 건반 · W E T Y U: 검은 건반 · Z/X: 옥타브 · C/V: 벨로시티`} aria-label="컴퓨터 키보드 연주">
      <Icon name="keyboard" size={16} />
    </button>
    {typing.enabled && <span className="midi-typing-state" aria-live="polite" title="A 키의 음 · 벨로시티">{musicalTypingOctaveLabel(typing.base)} · {typing.velocity}</span>}
    <button type="button" className="icon-button" onClick={midi.captureMidi} title={`MIDI 캡처 · ${captureShortcut}\n녹음하지 않은 마지막 연주를 리전으로 만듭니다`} aria-label="MIDI 캡처">
      <Icon name="capture" size={16} />
    </button>
    <select className="midi-mode-select" aria-label="MIDI 녹음 모드" title="겹치는 MIDI 리전에 녹음할 때: 합치기 = 기존 음표와 합침 · 대체 = 녹음 구간을 새 연주로 바꿈" value={midi.mode} onChange={event => midi.setMode(event.target.value as MidiRecordMode)}>
      {(Object.keys(MIDI_RECORD_MODE_LABELS) as MidiRecordMode[]).map(mode => <option key={mode} value={mode}>{MIDI_RECORD_MODE_LABELS[mode]}</option>)}
    </select>
  </div>
}

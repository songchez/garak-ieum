import { useSyncExternalStore } from 'react'
import type { MidiInputService, MidiInputState } from '../audio/MidiInput'

const EMPTY: MidiInputState = { access: 'unsupported', devices: [] }
const ACCESS_TEXT: Record<MidiInputState['access'], string> = {
  unsupported: 'MIDI 입력을 사용할 수 없습니다.',
  idle: 'MIDI 장치를 아직 열지 않았습니다.',
  requesting: 'MIDI 장치를 여는 중…',
  ready: '',
  denied: 'MIDI 장치 접근이 거부되었습니다.',
  error: 'MIDI 장치를 열지 못했습니다.',
}

/** Settings › 오디오 장치: MIDI 입력 장치 목록, 장치별 사용 켬/끔 (docs/MIDI_RECORDING.md). */
export function MidiDevicesSection({ service, disabled }: { service: MidiInputService | null | undefined; disabled?: boolean }) {
  const state = useSyncExternalStore(listener => service?.subscribe(listener) ?? (() => undefined), () => service?.getState() ?? EMPTY, () => EMPTY)
  const web = service?.kind === 'web'
  return <section className="midi-settings" aria-label="MIDI 입력 장치">
    <div className="audio-settings-section-title"><h3>MIDI 입력</h3>
      {service && state.access !== 'unsupported' && <button className="audio-small-button" disabled={disabled || state.access === 'requesting'} onClick={() => void service.requestAccess()}>
        {state.access === 'ready' ? '목록 새로고침' : web ? 'MIDI 장치 사용 허용' : 'MIDI 장치 찾기'}
      </button>}
    </div>
    {(state.error || ACCESS_TEXT[state.access]) && <p className={`audio-settings-note${state.access === 'denied' || state.access === 'error' ? ' audio-warning' : ''}`}>{state.error ?? ACCESS_TEXT[state.access]}</p>}
    {state.access === 'ready' && !state.devices.length && <p className="audio-settings-note">연결된 MIDI 입력 장치가 없습니다. 키보드를 연결하면 자동으로 나타납니다. 장치 없이도 컴퓨터 키보드 연주(⌘K / Ctrl+K)로 연주·녹음할 수 있습니다.</p>}
    {state.devices.length > 0 && <ul className="midi-device-list">
      {state.devices.map(device => <li key={device.id}>
        <label><input type="checkbox" checked={device.enabled} disabled={disabled || !device.connected} onChange={event => service?.setEnabled(device.id, event.target.checked)} aria-label={`${device.name} 사용`} />
          <span>{device.name}</span>{device.manufacturer && <small>{device.manufacturer}</small>}{!device.connected && <small>연결 끊김</small>}</label>
      </li>)}
    </ul>}
    <p className="audio-settings-note">사용으로 표시한 장치의 연주는 녹음 활성화(R)했거나 입력 모니터링(I)을 켠 악기 트랙, 또는 선택한 악기 트랙으로 갑니다. 트랙마다 인스펙터에서 MIDI 입력 장치와 채널을 고를 수 있습니다.</p>
  </section>
}

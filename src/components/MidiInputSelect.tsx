import { useSyncExternalStore } from 'react'
import type { TrackMidiInput } from '../core/types'
import { DEFAULT_MIDI_INPUT } from '../core/midiInput'
import { midiDeviceDirectory } from '../audio/MidiInput'

const ALL = '__all__', NONE = '__none__'

/** Instrument track MIDI input: 모든 MIDI 입력 (default) / one device / 없음, plus a channel filter. */
export function MidiInputSelect({ value, onChange }: { value: TrackMidiInput | undefined; onChange(next: TrackMidiInput | null): void }) {
  const devices = useSyncExternalStore(midiDeviceDirectory.subscribe, midiDeviceDirectory.get, midiDeviceDirectory.get)
  const input = value ?? DEFAULT_MIDI_INPUT
  const selected = input.source === 'all' ? ALL : input.source === 'none' ? NONE : input.deviceId ?? NONE
  const missing = input.source === 'device' && !devices.some(device => device.id === input.deviceId)
  const channel = input.channel ?? 0
  const emit = (next: TrackMidiInput) => onChange(next.source === 'all' && !next.channel ? null : next)
  return <span className="insp-pair">
    <select className="insp-select" aria-label="트랙 MIDI 입력" value={selected} onChange={event => {
      const id = event.target.value
      const keep = channel ? { channel } : {}
      if (id === ALL) emit({ source: 'all', ...keep })
      else if (id === NONE) emit({ source: 'none' })
      else { const device = devices.find(item => item.id === id); emit({ source: 'device', deviceId: id, ...(device ? { deviceName: device.name } : input.deviceName ? { deviceName: input.deviceName } : {}), ...keep }) }
    }}>
      <option value={ALL}>모든 MIDI 입력</option>
      {devices.map(device => <option key={device.id} value={device.id}>{device.name}{device.enabled ? '' : ' (사용 안 함)'}</option>)}
      {missing && <option value={input.deviceId}>{input.deviceName ?? input.deviceId} · 연결 안 됨</option>}
      <option value={NONE}>없음</option>
    </select>
    <select className="insp-select insp-select--narrow" aria-label="트랙 MIDI 채널" value={channel} disabled={input.source === 'none'} onChange={event => {
      const next = Number(event.target.value)
      const { channel: _channel, ...rest } = input
      emit(next ? { ...rest, channel: next } : rest)
    }}>
      <option value={0}>모든 채널</option>
      {Array.from({ length: 16 }, (_, index) => <option key={index + 1} value={index + 1}>채널 {index + 1}</option>)}
    </select>
  </span>
}

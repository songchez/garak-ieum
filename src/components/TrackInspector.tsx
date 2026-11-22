import { useState } from 'react'
import type { InputChoice, InstrumentId, Track, TrackInput, TrackInputRoute, TrackMonitorMode } from '../core/types'
import { instrumentDef } from '../core/instruments'
import { monitorModeOf, monitorModePatch } from '../core/trackActions'
import { InputSelect, TapSelect } from './InputSelect'
import { MidiInputSelect } from './MidiInputSelect'
import { parsePitchName, pitchName } from '../core/pitch'
import { Icon } from './Icon'
import { InstrumentOptions } from './InstrumentOptions'
import { ValueField, signed, ticksToMs } from './RegionInspector'

export const trackIcon = (track: Track) => track.icon ?? (track.kind === 'audio' ? 'wave' : track.kind === 'return' ? 'return' : instrumentDef(track.instrument).icon)

function TextField({ value, onCommit, ariaLabel }: { value: string; onCommit: (name: string) => void; ariaLabel: string }) {
  const [draft, setDraft] = useState<string | null>(null)
  return <input type="text" className="insp-text" value={draft ?? value} maxLength={512} aria-label={ariaLabel} onChange={e => setDraft(e.target.value)}
    onBlur={() => { const name = draft?.trim(); setDraft(null); if (name && name !== value) onCommit(name) }}
    onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur() } }} />
}

interface Props {
  track: Track
  bpm: number
  onTrackChange: (id: string, patch: Partial<Track>, key?: string) => void
  onInstrumentChange: (trackId: string, instrument: InstrumentId) => void
  onOpenColorPalette: (trackId: string, e: React.MouseEvent) => void
  onIconMenu: (trackId: string, e: React.MouseEvent) => void
  /** Mono/stereo inputs of the current device; empty = unknown (only the default input). */
  inputChoices?: readonly InputChoice[]
  onInputChange?: (trackId: string, input: TrackInput | null) => void
  /** Project tracks, for the internal (track/master) inputs. */
  tracks?: readonly Track[]
  onRouteChange?: (trackId: string, route: TrackInputRoute | null, input?: TrackInput | null) => void
}

const MONITOR_MODES: { mode: TrackMonitorMode; label: string; help: string }[] = [
  { mode: 'in', label: '켬', help: '항상 입력을 듣습니다' },
  { mode: 'auto', label: '자동', help: '녹음 대기 중에 듣고, 녹음 없이 재생하는 동안에는 녹음된 소리를 듣습니다' },
  { mode: 'off', label: '끔', help: '입력을 듣지 않습니다(녹음은 됩니다)' },
]

export function TrackInspector({ track, bpm, onTrackChange, onInstrumentChange, onOpenColorPalette, onIconMenu, inputChoices = [], onInputChange, tracks, onRouteChange }: Props) {
  const id = track.id
  const patch = (p: Partial<Track>, key: string) => onTrackChange(id, p, `${id}:${key}`)
  /** Two-field range: the edited bound pushes the other one along. */
  function limit(label: string, field: 'keyLimit' | 'velocityLimit', min: number, max: number, format?: (v: number) => string, parse?: (s: string) => number | null) {
    const [lo, hi] = track[field]
    const set = (which: 0 | 1, v: number) => { const next: [number, number] = which === 0 ? [v, Math.max(v, hi)] : [Math.min(lo, v), v]; patch({ [field]: next }, `${field}:${which}`) }
    return <div className="insp-row"><span className="insp-label">{label}</span><span className="insp-pair">
      <ValueField value={lo} min={min} max={max} format={format} parse={parse} ariaLabel={`${label} 최소`} onChange={v => set(0, v)} />
      <ValueField value={hi} min={min} max={max} format={format} parse={parse} ariaLabel={`${label} 최대`} onChange={v => set(1, v)} />
    </span></div>
  }
  const delayMs = ticksToMs(track.delayTicks, bpm)
  return <div className="track-inspector">
    <div className="insp-row"><span className="insp-label">이름</span><TextField value={track.name} ariaLabel="트랙 이름" onCommit={name => patch({ name }, 'name')} /></div>
    <div className="insp-row"><span className="insp-label">아이콘</span><span className="insp-pair">
      <button type="button" className="insp-icon-button" onClick={e => onIconMenu(id, e)} aria-haspopup="menu" title="트랙 아이콘 변경" aria-label="트랙 아이콘 변경" style={{ color: track.color }}><Icon name={trackIcon(track)} size={16} /></button>
      <button type="button" className="insp-swatch" onClick={e => onOpenColorPalette(id, e)} aria-haspopup="dialog" title="트랙 색상 변경" aria-label="트랙 색상 변경" style={{ background: track.color }} />
    </span></div>
    {track.kind === 'audio' && <>
      <div className="insp-row"><span className="insp-label">입력</span><InputSelect input={track.input} choices={inputChoices} ariaLabel="트랙 입력" disabled={!onInputChange} onChange={input => onInputChange?.(id, input)}
        routing={tracks && onRouteChange ? { track, tracks, onChange: (route, input) => onRouteChange(id, route, input) } : undefined} /></div>
      {track.inputRoute?.kind === 'track' && onRouteChange && <div className="insp-row"><span className="insp-label">탭</span><TapSelect value={track.inputRoute.tap} onChange={tap => track.inputRoute?.kind === 'track' && onRouteChange(id, { ...track.inputRoute, tap })} /></div>}
      {track.inputRoute?.kind === 'none' && <div className="insp-row"><span className="insp-label" /><span className="insp-note" role="note">입력 트랙이 삭제되어 무음이 녹음됩니다. 다른 입력을 골라 주세요.</span></div>}
      <div className="insp-row"><span className="insp-label">모니터</span><span className="insp-pair insp-monitor-modes" role="radiogroup" aria-label="입력 모니터링">
        {MONITOR_MODES.map(({ mode, label, help }) => <button key={mode} type="button" role="radio" aria-checked={monitorModeOf(track) === mode} className={`insp-mode${monitorModeOf(track) === mode ? ' active' : ''}`} title={`${label}: ${help}`}
          onClick={() => onTrackChange(id, monitorModePatch(mode), `${id}:monitorMode`)}>{label}</button>)}
      </span></div>
    </>}
    {track.kind === 'instrument' && <>
      <div className="insp-row"><span className="insp-label">MIDI 입력</span><MidiInputSelect value={track.midiInput} onChange={midiInput => patch({ midiInput: midiInput ?? undefined }, 'midiInput')} /></div>
      <div className="insp-row"><span className="insp-label">모니터</span><span className="insp-pair insp-monitor-modes" role="radiogroup" aria-label="MIDI 입력 모니터링">
        {MONITOR_MODES.map(({ mode, label }) => <button key={mode} type="button" role="radio" aria-checked={monitorModeOf(track) === mode} className={`insp-mode${monitorModeOf(track) === mode ? ' active' : ''}`} title={`${label}: ${mode === 'auto' ? '녹음 활성화했거나 선택한 트랙에서 연주가 들립니다' : mode === 'in' ? '항상 MIDI 입력을 연주합니다' : 'MIDI 입력을 연주하지 않습니다'}`}
          onClick={() => onTrackChange(id, monitorModePatch(mode), `${id}:monitorMode`)}>{label}</button>)}
      </span></div>
      <div className="insp-row"><span className="insp-label">악기</span><select className="insp-select" aria-label="악기 변경" value={track.pluginInstrument ? 'vst3' : track.instrument} onChange={e => { if (e.target.value !== 'vst3') onInstrumentChange(id, e.target.value) }}>{track.pluginInstrument && <optgroup label="VST3 악기"><option value="vst3">{track.pluginInstrument.name}</option></optgroup>}<InstrumentOptions /></select></div>
      <div className="insp-row"><span className="insp-label">트랜스포즈</span><ValueField value={track.transpose} min={-96} max={96} format={signed} ariaLabel="트랙 트랜스포즈" onChange={transpose => patch({ transpose }, 'transpose')} /></div>
      <div className="insp-row"><span className="insp-label">벨로시티 오프셋</span><ValueField value={track.velocityOffset} min={-99} max={99} format={signed} ariaLabel="트랙 벨로시티 오프셋" onChange={velocityOffset => patch({ velocityOffset }, 'velocityOffset')} /></div>
      {limit('키 제한', 'keyLimit', 0, 127, pitchName, parsePitchName)}
      {limit('벨로시티 제한', 'velocityLimit', 1, 127)}
    </>}
    {track.kind === 'return' && <div className="insp-row"><span className="insp-label">리턴</span><span className="insp-note insp-note-info" role="note">다른 트랙의 센드로 받은 소리에 시김새를 걸어 마스터로 보냅니다. 센드는 믹서나 각 트랙 채널의 ‘센드’ 노브로 조절합니다.</span></div>}
    {track.kind !== 'return' && <div className="insp-row"><span className="insp-label">딜레이</span><ValueField value={track.delayTicks} min={-1920} max={1920} format={v => `${signed(v)} 틱`} ariaLabel="트랙 딜레이" onChange={delayTicks => patch({ delayTicks }, 'delayTicks')} /><small className="insp-unit">{`${delayMs < 0 ? '−' : ''}${Math.abs(delayMs).toFixed(1)} ms`}</small></div>}
  </div>
}

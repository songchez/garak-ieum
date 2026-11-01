import { useState } from 'react'
import type { InstrumentId, Track } from '../core/types'
import { instrumentDef } from '../core/instruments'
import { parsePitchName, pitchName } from '../core/pitch'
import { Icon } from './Icon'
import { InstrumentOptions } from './InstrumentOptions'
import { ValueField, signed, ticksToMs } from './RegionInspector'

export const trackIcon = (track: Track) => track.icon ?? (track.kind === 'audio' ? 'wave' : instrumentDef(track.instrument).icon)

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
}

export function TrackInspector({ track, bpm, onTrackChange, onInstrumentChange, onOpenColorPalette, onIconMenu }: Props) {
  const id = track.id
  const patch = (p: Partial<Track>, key: string) => onTrackChange(id, p, `${id}:${key}`)
  /** Two-field range: the edited bound pushes the other one along (Logic). */
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
    {track.kind === 'instrument' && <>
      <div className="insp-row"><span className="insp-label">악기</span><select className="insp-select" aria-label="악기 변경" value={track.instrument} onChange={e => onInstrumentChange(id, e.target.value)}><InstrumentOptions /></select></div>
      <div className="insp-row"><span className="insp-label">트랜스포즈</span><ValueField value={track.transpose} min={-96} max={96} format={signed} ariaLabel="트랙 트랜스포즈" onChange={transpose => patch({ transpose }, 'transpose')} /></div>
      <div className="insp-row"><span className="insp-label">벨로시티 오프셋</span><ValueField value={track.velocityOffset} min={-99} max={99} format={signed} ariaLabel="트랙 벨로시티 오프셋" onChange={velocityOffset => patch({ velocityOffset }, 'velocityOffset')} /></div>
      {limit('키 제한', 'keyLimit', 0, 127, pitchName, parsePitchName)}
      {limit('벨로시티 제한', 'velocityLimit', 1, 127)}
    </>}
    <div className="insp-row"><span className="insp-label">딜레이</span><ValueField value={track.delayTicks} min={-1920} max={1920} format={v => `${signed(v)} 틱`} ariaLabel="트랙 딜레이" onChange={delayTicks => patch({ delayTicks }, 'delayTicks')} /><small className="insp-unit">{`${delayMs < 0 ? '−' : ''}${Math.abs(delayMs).toFixed(1)} ms`}</small></div>
  </div>
}

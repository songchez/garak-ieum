import { useState } from 'react'
import type { AudioEngine, Clip, EffectType, InstrumentId, Project, Track } from '../core/types'
import type { TrackButtonKind, TrackButtonMods } from '../core/trackActions'
import type { InspectorSections } from '../core/trackUi'
import { RegionInspector, regionTitle, type ClipEntry } from './RegionInspector'
import { TrackInspector } from './TrackInspector'
import { ChannelStrip } from './ChannelStrip'
import './Inspector.css'

export type { ClipEntry }

export interface InspectorProps {
  project: Project
  focusedTrack: Track | undefined
  selection: ClipEntry[]
  engine: AudioEngine
  recording: boolean
  arm: 'off' | 'auto' | 'armed'
  implicitMute: boolean
  sections: InspectorSections
  onSectionsChange: (next: InspectorSections) => void
  /** Applies to every selected clip. */
  onClipsEdit: (fn: (clip: Clip) => Clip, key?: string) => void
  onTrackChange: (id: string, patch: Partial<Track>, key?: string) => void
  onTrackButton: (trackId: string, kind: TrackButtonKind, mods: TrackButtonMods) => void
  onTrackSweep: (trackId: string, kind: TrackButtonKind, value: boolean) => void
  onInstrumentChange: (trackId: string, instrument: InstrumentId) => void
  onAddDevice: (trackId: string, type: EffectType) => void
  onToggleDevice: (trackId: string, deviceId: string) => void
  onMoveDevice: (trackId: string, deviceId: string, offset: number) => void
  onRemoveDevice: (trackId: string, deviceId: string) => void
  onOpenDevices: (trackId: string, deviceId?: string) => void
  onMasterChange: (v: number) => void
  onOpenColorPalette: (trackId: string, e: React.MouseEvent) => void
  onIconMenu: (trackId: string, e: React.MouseEvent) => void
}

function Section({ id, open, title, onToggle, children, className = '' }: { id: string; open: boolean; title: React.ReactNode; onToggle: () => void; children?: React.ReactNode; className?: string }) {
  return <section className={`insp-section ${open ? 'open' : ''} ${className}`}>
    <button type="button" className="insp-section-head" onClick={onToggle} aria-expanded={open} aria-controls={`insp-${id}`}><span className="insp-disclosure" aria-hidden="true">{open ? '▾' : '▸'}</span><span className="insp-section-title">{title}</span></button>
    {open && <div className="insp-section-body" id={`insp-${id}`}>{children}</div>}
  </section>
}

export function Inspector(props: InspectorProps) {
  const { project, focusedTrack, selection, sections, onSectionsChange } = props
  const [renaming, setRenaming] = useState<string | null>(null)
  const toggle = (key: keyof InspectorSections) => onSectionsChange({ ...sections, [key]: !sections[key] })
  const single = selection.length === 1 ? selection[0].clip : null
  const regionHead = renaming !== null && single
    ? <input className="insp-rename" autoFocus value={renaming} aria-label="리전 이름" onChange={e => setRenaming(e.target.value)} onClick={e => e.stopPropagation()}
      onBlur={() => { const name = renaming.trim(); setRenaming(null); if (name && name !== single.name) props.onClipsEdit(c => ({ ...c, name })) }}
      onKeyDown={e => { if (e.nativeEvent.isComposing) return; e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') setRenaming(null) }} />
    : <span onDoubleClick={e => { if (single) { e.stopPropagation(); setRenaming(single.name) } }} title={single ? '더블클릭: 이름 변경' : undefined}>{regionTitle(selection)}</span>
  return <div className="inspector" aria-label="인스펙터">
    <Section id="region" open={sections.region} title={regionHead} onToggle={() => toggle('region')} className="insp-region">
      {selection.length > 0 && <RegionInspector selection={selection} bpm={project.bpm} onClipsEdit={props.onClipsEdit} />}
    </Section>
    <Section id="track" open={sections.track} title={focusedTrack ? `트랙: ${focusedTrack.name}` : '트랙'} onToggle={() => toggle('track')} className="insp-track">
      {focusedTrack ? <TrackInspector track={focusedTrack} bpm={project.bpm} onTrackChange={props.onTrackChange} onInstrumentChange={props.onInstrumentChange} onOpenColorPalette={props.onOpenColorPalette} onIconMenu={props.onIconMenu} /> : <p className="insp-empty">트랙을 선택해주세요</p>}
    </Section>
    <Section id="strips" open={sections.strips} title="채널 스트립" onToggle={() => toggle('strips')} className="insp-strips">
      <div className="strips">
        {focusedTrack ? <ChannelStrip track={focusedTrack} project={project} engine={props.engine} recording={props.recording} arm={props.arm} implicitMute={props.implicitMute} focused
          onTrackChange={props.onTrackChange} onTrackButton={props.onTrackButton} onTrackSweep={props.onTrackSweep} onInstrumentChange={props.onInstrumentChange}
          onAddDevice={props.onAddDevice} onToggleDevice={props.onToggleDevice} onMoveDevice={props.onMoveDevice} onRemoveDevice={props.onRemoveDevice} onOpenDevices={props.onOpenDevices}
          onOpenColorPalette={props.onOpenColorPalette} onIconMenu={props.onIconMenu} /> : <div className="cstrip cstrip-placeholder"><span>트랙 없음</span></div>}
        <ChannelStrip track={undefined} project={project} engine={props.engine} recording={props.recording} arm="off" implicitMute={false} onTrackChange={props.onTrackChange} onTrackButton={props.onTrackButton} onTrackSweep={props.onTrackSweep} onMasterChange={props.onMasterChange} />
      </div>
    </Section>
  </div>
}

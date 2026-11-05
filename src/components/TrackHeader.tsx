import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AudioEngine, InputChoice, SampleStatus, Track, TrackInput } from '../core/types'
import type { ArmState } from '../core/trackActions'
import type { TrackHeaderConfig } from '../core/trackUi'
import { instrumentDef } from '../core/instruments'
import { shortcutPlatform } from '../core/input'
import { Icon } from './Icon'
import { TrackButtons, type TrackButtonKind, type TrackButtonMods } from './TrackButtons'
import { VolumeSlider } from './VolumeSlider'
import { PanKnob } from './PanKnob'
import { InputSelect } from './InputSelect'
import './TrackHeader.css'

const MAC = shortcutPlatform() === 'mac'
const MOD = MAC ? '⌘' : 'Ctrl+'

/** Rows that fit: 0 = name + M/S on one line, 1 = name over buttons, 2 = + volume, 3 = + pan. */
export const headerTier = (height: number) => height < 44 ? 0 : height < 72 ? 1 : height < 96 ? 2 : 3
export const trackIcon = (track: Track) => track.icon ?? (track.kind === 'audio' ? 'wave' : instrumentDef(track.instrument).icon)
const CONTROL = 'button,input,select,[role="slider"],.track-resize-corner'

export interface TrackHeaderProps {
  track: Track; index: number; focused: boolean; selected: boolean; multi: boolean; height: number
  config: TrackHeaderConfig; ui: { hideView: boolean; recording: boolean }; arm: ArmState; implicitMute: boolean; renaming: boolean
  engine: AudioEngine; loading?: SampleStatus
  /** Shown as a compact input chooser on audio tracks tall enough for a third row. */
  inputChoices?: readonly InputChoice[]
  onInputChange?(input: TrackInput | null): void
  onClick(mods: { range: boolean; toggle: boolean; trackOnly: boolean }): void
  onFocus(): void
  onDoubleClickBackground?(): void
  onButton(trackId: string, kind: TrackButtonKind, mods: TrackButtonMods): void
  onSweep(trackId: string, kind: TrackButtonKind, value: boolean): void
  onChange(patch: Partial<Track>, key?: string): void
  onRename(name: string | null): void
  onOpenLibrary(): void
  onIconMenu(e: React.MouseEvent): void
  onContextMenu(e: React.MouseEvent): void
  onReorderStart(e: React.PointerEvent): void
  onResizeStart(e: React.PointerEvent, all: boolean, reset: boolean): void
}

export function TrackHeader(props: TrackHeaderProps) {
  const { track, index, focused, selected, multi, height, config, ui, arm, implicitMute, renaming, engine, loading } = props
  const tier = headerTier(height)
  const [editing, setEditing] = useState(renaming)
  useEffect(() => { if (renaming) setEditing(true) }, [renaming])
  const set = track.kind === 'instrument' ? instrumentDef(track.instrument).set : undefined
  const sampleStatus = useSyncExternalStore(engine.subscribeSamples, () => set ? engine.sampleStatus(set) : 'idle', () => 'idle' as const)
  const status = loading ?? sampleStatus

  const kinds: TrackButtonKind[] = []
  if (tier === 0) { if (config.mute) kinds.push('mute'); if (config.solo) kinds.push('solo') }
  else {
    if (config.onOff) kinds.push('enabled')
    if (config.hide && ui.hideView) kinds.push('hidden')
    if (config.mute) kinds.push('mute')
    if (config.solo) kinds.push('solo')
    if (config.record) kinds.push('arm')
    if (config.monitor && track.kind === 'audio') kinds.push('monitor')
  }
  const showVolume = tier >= 2 && config.volume, showPan = tier >= 3 && config.pan
  const showInput = tier >= 2 && track.kind === 'audio' && !!props.onInputChange
  const hiddenNow = track.hidden && ui.hideView

  function pointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || !(e.target instanceof Element) || e.target.closest(CONTROL)) return
    const mods = { range: e.shiftKey, toggle: MAC ? e.metaKey : e.ctrlKey, trackOnly: e.altKey }
    props.onFocus()
    // Number click during a multi-selection only moves the focus (Logic).
    if (multi && e.target.closest('.track-number') && !mods.range && !mods.toggle && !mods.trackOnly) return
    props.onClick(mods)
    if (!mods.range && !mods.toggle && !mods.trackOnly && !e.target.closest('.track-name')) props.onReorderStart(e)
  }
  function doubleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!(e.target instanceof Element) || e.target.closest(CONTROL)) return
    if (e.target.closest('.track-name')) { setEditing(true); return }
    if (e.target.closest('.track-icon')) { props.onOpenLibrary(); return }
    props.onDoubleClickBackground?.()
  }
  function renameDone(name: string | null) { setEditing(false); props.onRename(name) }

  const cls = ['track-header', `tier-${tier}`]
  if (focused) cls.push('focused'); if (selected) cls.push('selected'); if (multi) cls.push('multi')
  if (!track.enabled) cls.push('track-off'); if (hiddenNow) cls.push('track-hidden'); if (editing) cls.push('renaming')
  if (config.colorBar) cls.push('with-color-bar')

  return <div className={cls.join(' ')} data-track-id={track.id} data-kind={track.kind} style={{ height, '--track-color': track.color } as React.CSSProperties}
    onPointerDown={pointerDown} onDoubleClick={doubleClick} onContextMenu={props.onContextMenu}>
    {config.colorBar && <i className="track-color-bar" aria-hidden="true"/>}
    {config.trackNumber && <span className={`track-number${multi && focused ? ' focused' : ''}`} title={multi ? '클릭: 포커스 이동 · 드래그: 순서 바꾸기' : '드래그하여 트랙 순서 바꾸기'}>{index + 1}</span>}
    {config.icon && <span className="track-icon" title="더블 클릭: 라이브러리 · 우클릭: 아이콘 바꾸기" onContextMenu={e => { e.preventDefault(); e.stopPropagation(); props.onIconMenu(e) }}>
      <Icon name={trackIcon(track)} size={tier === 0 ? 14 : 17}/>
      {status === 'loading' && <i className="sample-dot loading" title="샘플을 불러오는 중" aria-label="샘플을 불러오는 중"/>}
      {status === 'error' && <i className="sample-dot error" title="샘플을 불러오지 못했습니다" aria-label="샘플을 불러오지 못했습니다"/>}
    </span>}
    <div className="track-main">
      <div className="track-name-row">
        {editing ? <InlineName value={track.name} label="트랙 이름" onDone={renameDone}/> : <span className="track-name" title={`${track.name} · 더블 클릭: 이름 바꾸기`}>{track.name}</span>}
        {hiddenNow && <b className="track-hide-badge" title="가려진 트랙">H</b>}
        {!track.enabled && <b className="track-off-badge" title="꺼진 트랙"><Icon name="power" size={9}/></b>}
      </div>
      {kinds.length > 0 && <TrackButtons track={track} kinds={kinds} arm={arm} recording={ui.recording} implicitMute={implicitMute} onPress={props.onButton} onSweep={props.onSweep}/>}
      {showInput && <InputSelect className="track-input-select" input={track.input} choices={props.inputChoices ?? []} ariaLabel={`${track.name} 입력`} onChange={input => props.onInputChange?.(input)}/>}
    </div>
    {(showVolume || showPan) && <div className="track-side">
      {showVolume && <VolumeSlider value={track.volume} orientation="horizontal" meter={{ engine, trackId: track.id }} ariaLabel={`${track.name} 볼륨`} disabled={!track.enabled} onChange={v => props.onChange({ volume: v }, `${track.id}:volume`)}/>}
      {showPan && <PanKnob value={track.pan} size={20} ariaLabel={`${track.name} 팬`} onChange={v => props.onChange({ pan: v }, `${track.id}:pan`)}/>}
    </div>}
    <i className="track-resize-corner" title={`개별 트랙 확대/축소 (${MOD}드래그: 전체 · ⇧클릭: 초기화)`} onPointerDown={e => { e.stopPropagation(); if (e.button !== 0) return; e.preventDefault(); props.onResizeStart(e, MAC ? e.metaKey : e.ctrlKey, e.shiftKey) }}/>
  </div>
}

function InlineName({ value, label, onDone }: { value: string; label: string; onDone(name: string | null): void }) {
  const [draft, setDraft] = useState(value)
  const done = useRef(false)
  const finish = (name: string | null) => { if (done.current) return; done.current = true; const trimmed = name?.trim(); onDone(trimmed && trimmed !== value ? name!.slice(0, 512) : null) }
  return <input className="inline-name track-name-input" aria-label={label} value={draft} autoFocus onFocus={e => e.currentTarget.select()} onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onContextMenu={e => e.stopPropagation()} onChange={e => setDraft(e.target.value)} onBlur={() => finish(draft)} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); finish(draft) } else if (e.key === 'Escape') { e.preventDefault(); finish(null) } }}/>
}

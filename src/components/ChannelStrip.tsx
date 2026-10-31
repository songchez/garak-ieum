import { useRef, useState } from 'react'
import type { AudioEngine, EffectType, InstrumentId, Project, Track } from '../core/types'
import { EFFECT_DEFS, EFFECT_TYPES } from '../core/devices'
import { INSTRUMENTS, INSTRUMENT_SECTIONS, instrumentDef } from '../core/instruments'
import type { TrackButtonKind, TrackButtonMods } from '../core/trackActions'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import { Icon } from './Icon'
import { TrackButtons } from './TrackButtons'
import { VolumeSlider } from './VolumeSlider'
import { PanKnob } from './PanKnob'
import { trackIcon } from './TrackInspector'

export const formatGainDb = (v: number) => v <= 0 ? '−∞' : `${v > 1 ? '+' : ''}${(20 * Math.log10(v)).toFixed(1)}`
const BUTTONS: TrackButtonKind[] = ['mute', 'solo', 'arm', 'monitor']

export interface ChannelStripProps {
  /** undefined = the Stereo Out (master) strip. */
  track: Track | undefined
  project: Project
  engine: AudioEngine
  recording: boolean
  arm: 'off' | 'auto' | 'armed'
  implicitMute: boolean
  focused?: boolean
  onTrackChange: (id: string, patch: Partial<Track>, key?: string) => void
  onTrackButton: (trackId: string, kind: TrackButtonKind, mods: TrackButtonMods) => void
  onTrackSweep: (trackId: string, kind: TrackButtonKind, value: boolean) => void
  onInstrumentChange?: (trackId: string, instrument: InstrumentId) => void
  onAddDevice?: (trackId: string, type: EffectType) => void
  onToggleDevice?: (trackId: string, deviceId: string) => void
  onMoveDevice?: (trackId: string, deviceId: string, offset: number) => void
  onRemoveDevice?: (trackId: string, deviceId: string) => void
  onOpenDevices?: (trackId: string, deviceId?: string) => void
  onMasterChange?: (v: number) => void
  onSelect?: () => void
  onOpenColorPalette?: (trackId: string, e: React.MouseEvent) => void
  onIconMenu?: (trackId: string, e: React.MouseEvent) => void
  compact?: boolean
}

type Menu = { kind: 'instrument' | 'add' | 'device'; deviceId?: string; x: number; y: number; trigger?: HTMLElement }

export function ChannelStrip(props: ChannelStripProps) {
  const { track, project, engine, focused, compact, onSelect } = props
  const [menu, setMenu] = useState<Menu | null>(null)
  const dragFrom = useRef<{ id: string; index: number; pointerId: number } | null>(null)
  const open = (kind: Menu['kind'], e: React.MouseEvent, deviceId?: string) => { const trigger = e.currentTarget as HTMLElement; const r = trigger.getBoundingClientRect(); setMenu(m => m?.trigger === trigger ? null : { kind, deviceId, x: r.left, y: r.bottom + 2, trigger }) }
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()

  if (!track) {
    return <div className={`cstrip cstrip-master ${compact ? 'compact' : ''}`} aria-label="Stereo Out 채널 스트립">
      <div className="cstrip-slot cstrip-kind">출력</div>
      <div className="cstrip-fill" />
      <div className="cstrip-db">{formatGainDb(project.masterVolume)}</div>
      <div className="cstrip-fader"><VolumeSlider value={project.masterVolume} orientation="vertical" meter={{ engine }} ariaLabel="마스터 출력 볼륨" onChange={v => props.onMasterChange?.(v)} /></div>
      <div className="cstrip-icon"><Icon name="volume" size={14} /></div>
      <div className="cstrip-name" style={{ '--track-color': 'var(--ink-33)' } as React.CSSProperties}><span>Stereo Out</span></div>
    </div>
  }

  const id = track.id
  const def = instrumentDef(track.instrument)
  const items = (): ContextMenuItem[] => {
    if (!menu) return []
    if (menu.kind === 'instrument') return INSTRUMENT_SECTIONS.map(section => ({ label: section.title, items: INSTRUMENTS.filter(i => section.categories.includes(i.category)).map(i => ({ label: `${i.name} · ${i.nameKo}`, checked: i.id === track.instrument, onSelect: () => props.onInstrumentChange?.(id, i.id) })) }))
    if (menu.kind === 'add') return EFFECT_TYPES.map(type => ({ label: EFFECT_DEFS[type].name, onSelect: () => props.onAddDevice?.(id, type) }))
    const index = track.devices.findIndex(d => d.id === menu.deviceId), device = track.devices[index]
    if (!device) return []
    return [
      { label: device.enabled ? '바이패스' : '켜기', onSelect: () => props.onToggleDevice?.(id, device.id) },
      { label: '위로 이동', disabled: index === 0, onSelect: () => props.onMoveDevice?.(id, device.id, -1) },
      { label: '아래로 이동', disabled: index === track.devices.length - 1, onSelect: () => props.onMoveDevice?.(id, device.id, 1) },
      { type: 'separator' },
      { label: '제거', danger: true, onSelect: () => props.onRemoveDevice?.(id, device.id) },
    ]
  }
  /** Vertical drag across insert slots reorders the chain one step at a time. */
  function insertPointerDown(e: React.PointerEvent<HTMLDivElement>, deviceId: string, index: number) {
    if (e.button !== 0 || !props.onMoveDevice) return
    dragFrom.current = { id: deviceId, index, pointerId: e.pointerId }
    const move = (ev: PointerEvent) => {
      const d = dragFrom.current; if (!d || ev.pointerId !== d.pointerId) return
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-insert-index]')
      const target = over ? Number(over.dataset.insertIndex) : NaN
      if (Number.isFinite(target) && target !== d.index) { props.onMoveDevice?.(id, d.id, target - d.index); d.index = target }
    }
    const up = () => { dragFrom.current = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up)
  }
  return <div className={`cstrip ${focused ? 'focused' : ''} ${compact ? 'compact' : ''} ${track.enabled ? '' : 'off'}`} style={{ '--track-color': track.color } as React.CSSProperties} aria-label={`${track.name} 채널 스트립`} onClick={onSelect}>
    <div className="cstrip-slot cstrip-kind">{track.kind === 'audio' ? '오디오' : '악기'}</div>
    {track.kind === 'instrument' && <div className="cstrip-slot cstrip-instrument" title={`${def.name} · ${def.nameKo}`}>
      <button type="button" className="cstrip-slot-main" onClick={e => { stop(e); if (props.onOpenDevices) props.onOpenDevices(id); else open('instrument', e) }} aria-label={`악기 ${def.name}`}><Icon name={def.icon} size={11} /><span>{def.name}</span></button>
      <button type="button" className="cstrip-slot-caret" onClick={e => { stop(e); open('instrument', e) }} aria-label="악기 선택" aria-haspopup="menu" aria-expanded={menu?.kind === 'instrument'}><Icon name="chevron" size={10} /></button>
    </div>}
    <div className="cstrip-inserts" role="list" aria-label="인서트">
      {track.devices.map((device, index) => <div key={device.id} role="listitem" data-insert-index={index} className={`cstrip-slot cstrip-insert ${device.enabled ? '' : 'bypassed'}`} onPointerDown={e => insertPointerDown(e, device.id, index)} onContextMenu={e => { e.preventDefault(); stop(e); setMenu({ kind: 'device', deviceId: device.id, x: e.clientX, y: e.clientY }) }}>
        <button type="button" className={`cstrip-power ${device.enabled ? 'on' : ''}`} aria-pressed={device.enabled} aria-label={`${EFFECT_DEFS[device.type].name} 켜기/끄기`} title="켜기/끄기 (바이패스)" onClick={e => { stop(e); props.onToggleDevice?.(id, device.id) }} />
        <button type="button" className="cstrip-slot-main" onClick={e => { stop(e); props.onOpenDevices?.(id, device.id) }} title={`${EFFECT_DEFS[device.type].name} 열기`}><span>{EFFECT_DEFS[device.type].name}</span></button>
      </div>)}
      <button type="button" className="cstrip-slot cstrip-insert-empty" onClick={e => { stop(e); open('add', e) }} aria-label="디바이스 추가" aria-haspopup="menu" aria-expanded={menu?.kind === 'add'} title="디바이스 추가"><Icon name="plus" size={10} /></button>
    </div>
    <div className="cstrip-slot cstrip-output" title="출력">Stereo Out</div>
    <div className="cstrip-fill" />
    <div className="cstrip-pan" onClick={stop}><PanKnob value={track.pan} size={compact ? 26 : 30} ariaLabel={`${track.name} 팬`} onChange={pan => props.onTrackChange(id, { pan }, `${id}:pan`)} /></div>
    <div className="cstrip-buttons" onClick={stop}><TrackButtons track={track} kinds={BUTTONS} arm={props.arm} recording={props.recording} implicitMute={props.implicitMute} onPress={props.onTrackButton} onSweep={props.onTrackSweep} size="strip" /></div>
    <div className="cstrip-db">{formatGainDb(track.volume)}</div>
    <div className="cstrip-fader" onClick={stop}><VolumeSlider value={track.volume} orientation="vertical" meter={{ engine, trackId: id }} ariaLabel={`${track.name} 볼륨`} disabled={!track.enabled} onChange={volume => props.onTrackChange(id, { volume }, `${id}:volume`)} /></div>
    <button type="button" className="cstrip-icon" onClick={e => { if (props.onIconMenu) { stop(e); props.onIconMenu(id, e) } }} aria-label="트랙 아이콘" title={props.onIconMenu ? '트랙 아이콘 변경' : undefined}><Icon name={trackIcon(track)} size={14} /></button>
    <div className="cstrip-name" title={track.name} onDoubleClick={e => { if (props.onOpenColorPalette) { stop(e); props.onOpenColorPalette(id, e) } }}><span>{track.name}</span></div>
    {menu && <ContextMenu x={menu.x} y={menu.y} items={items()} onClose={() => setMenu(null)} trigger={menu.trigger} label={menu.kind === 'instrument' ? '악기 선택' : menu.kind === 'add' ? '디바이스 추가' : '디바이스'} />}
  </div>
}

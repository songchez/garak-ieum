import { useEffect, useRef, useState } from 'react'
import type { AudioEngine, Device, EffectType, InstrumentId, Project, Track } from '../core/types'
import { EFFECT_DEFS, EFFECT_TYPES } from '../core/devices'
import { effectLabel } from '../devices/effects/registry'
import { effectDeviceName } from '../core/sigimsaeDevices'
import { INSTRUMENTS, INSTRUMENT_SECTIONS, instrumentDef } from '../core/instruments'
import { contrastTextColor } from '../core/colors'
import type { TrackButtonKind, TrackButtonMods } from '../core/trackActions'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import { Icon } from './Icon'
import { TrackButtons } from './TrackButtons'
import { VolumeSlider } from './VolumeSlider'
import { PanKnob } from './PanKnob'
import { trackIcon } from './TrackInspector'
import { useHistoryGesture } from '../core/historyGesture'
import { canSend, returnLetter, returnTracks, sendTo, sendersOf, type SendPatch } from '../core/sends'
import { SendKnob, formatSendDb } from './SendKnob'
import { useDisplayTrack } from './automationUi'
import { draggedLibraryRole, readLibraryDrag } from '../core/libraryDrag'

const deviceName = (device: Device) => device.type === 'vst3' ? device.name : effectDeviceName(device)

export const formatGainDb = (v: number) => v <= 0 ? '−∞' : `${v > 1 ? '+' : ''}${(20 * Math.log10(v)).toFixed(1)}`
const BUTTONS: TrackButtonKind[] = ['mute', 'solo', 'arm', 'monitor']
const RETURN_BUTTONS: TrackButtonKind[] = ['mute', 'solo']

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
  /** `variantId` names a library variant (src/core/sigimsaeVariants.ts) when the effect comes from a library drop. */
  onAddDevice?: (trackId: string, type: EffectType, variantId?: string) => void
  onToggleDevice?: (trackId: string, deviceId: string) => void
  onMoveDevice?: (trackId: string, deviceId: string, offset: number) => void
  onRemoveDevice?: (trackId: string, deviceId: string) => void
  onOpenDevices?: (trackId: string, deviceId?: string) => void
  /** Opens the left library on its 시김새 tab for this track (the empty insert slot's action). */
  onOpenLibrary?: (trackId: string) => void
  onMasterChange?: (v: number) => void
  onSelect?: () => void
  onOpenColorPalette?: (trackId: string, e: React.MouseEvent) => void
  onIconMenu?: (trackId: string, e: React.MouseEvent) => void
  /** Aux send edits (docs/SENDS_RETURNS.md); without it the 센드 section is read-only. */
  onSendChange?: (trackId: string, returnId: string, patch: SendPatch, key?: string) => void
  compact?: boolean
}

type Menu = { kind: 'instrument' | 'add' | 'device'; deviceId?: string; x: number; y: number; trigger?: HTMLElement }

export function ChannelStrip(props: ChannelStripProps) {
  const { track, project, engine, focused, compact, onSelect } = props
  // Pan, fader and mute follow automation during playback (docs/AUTOMATION.md).
  const shown = useDisplayTrack(track)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [libraryOver, setLibraryOver] = useState(false)
  const dragFrom = useRef<{ id: string; index: number; pointerId: number } | null>(null)
  const insertGesture = useHistoryGesture('시김새 순서 변경')
  const cancelInsertDrag = useRef<(() => void) | null>(null)
  useEffect(() => () => cancelInsertDrag.current?.(), [])
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
  // Library drops, like the 시김새 chain: effects join the end of the chain, instruments replace an instrument track's source.
  const acceptsDrop = (data: DataTransfer) => { const role = draggedLibraryRole(data); return (role === 'effect' && !!props.onAddDevice) || (role === 'instrument' && track.kind === 'instrument' && !!props.onInstrumentChange) }
  function libraryDrop(e: React.DragEvent) {
    if (!acceptsDrop(e.dataTransfer)) return
    e.preventDefault(); e.stopPropagation(); setLibraryOver(false)
    const item = readLibraryDrag(e.dataTransfer)
    if (item?.kind === 'effect') props.onAddDevice?.(id, item.effectType, item.variantId)
    else if (item?.kind === 'instrument') props.onInstrumentChange?.(id, item.instrument)
  }
  const items = (): ContextMenuItem[] => {
    if (!menu) return []
    if (menu.kind === 'instrument') return INSTRUMENT_SECTIONS.map(section => ({ label: section.title, items: INSTRUMENTS.filter(i => section.categories.includes(i.category)).map(i => ({ label: `${i.name} · ${i.nameKo}`, checked: i.id === track.instrument, onSelect: () => props.onInstrumentChange?.(id, i.id) })) }))
    if (menu.kind === 'add') return EFFECT_TYPES.map(type => ({ label: `${EFFECT_DEFS[type].name} · ${effectLabel(type)}`, onSelect: () => props.onAddDevice?.(id, type) }))
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
    cancelInsertDrag.current?.()
    const slots = e.currentTarget.parentElement!
    insertGesture.begin()
    slots.dataset.dawGesture = 'insert-order'
    dragFrom.current = { id: deviceId, index, pointerId: e.pointerId }
    const move = (ev: PointerEvent) => {
      const d = dragFrom.current; if (!d || ev.pointerId !== d.pointerId) return
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-insert-index]')
      const target = over && slots.contains(over) ? Number(over.dataset.insertIndex) : NaN
      if (Number.isFinite(target) && target !== d.index) { props.onMoveDevice?.(id, d.id, target - d.index); d.index = target }
    }
    const finish = () => { dragFrom.current = null; cancelInsertDrag.current = null; delete slots.dataset.dawGesture; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); window.removeEventListener('blur', finish); insertGesture.end() }
    const up = (event: PointerEvent) => { if (event.pointerId === e.pointerId) finish() }
    cancelInsertDrag.current = finish
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up); window.addEventListener('blur', finish)
  }
  return <div className={`cstrip ${focused ? 'focused' : ''} ${compact ? 'compact' : ''} ${track.enabled ? '' : 'off'} ${libraryOver ? 'library-drop' : ''}`} style={{ '--track-color': track.color, '--track-label-color': contrastTextColor(track.color) } as React.CSSProperties} aria-label={`${track.name} 채널 스트립`} onClick={onSelect}
    onDragOver={e => { if (!acceptsDrop(e.dataTransfer)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; if (!libraryOver) setLibraryOver(true) }}
    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setLibraryOver(false) }} onDrop={libraryDrop}>
    <div className="cstrip-slot cstrip-kind">{track.kind === 'audio' ? '오디오' : track.kind === 'return' ? '리턴' : '악기'}</div>
    {track.kind === 'instrument' && <div className="cstrip-slot cstrip-instrument" title={track.pluginInstrument ? `${track.pluginInstrument.name} · VST3` : `${def.name} · ${def.nameKo}`}>
      <button type="button" className="cstrip-slot-main" onClick={e => { stop(e); if (props.onOpenDevices) props.onOpenDevices(id); else open('instrument', e) }} aria-label={`악기 ${track.pluginInstrument?.name ?? def.name}`}><Icon name={track.pluginInstrument ? 'plug' : def.icon} size={11} /><span>{track.pluginInstrument?.name ?? def.name}</span></button>
      <button type="button" className="cstrip-slot-caret" onClick={e => { stop(e); open('instrument', e) }} aria-label="악기 선택" aria-haspopup="menu" aria-expanded={menu?.kind === 'instrument'}><Icon name="chevron" size={10} /></button>
    </div>}
    <div className="cstrip-inserts" role="list" aria-label="인서트">
      {track.devices.map((device, index) => <div key={device.id} role="listitem" data-insert-index={index} className={`cstrip-slot cstrip-insert ${device.enabled ? '' : 'bypassed'}`} onPointerDown={e => insertPointerDown(e, device.id, index)} onContextMenu={e => { e.preventDefault(); stop(e); setMenu({ kind: 'device', deviceId: device.id, x: e.clientX, y: e.clientY }) }}>
        <button type="button" className={`cstrip-power ${device.enabled ? 'on' : ''}`} aria-pressed={device.enabled} aria-label={`${deviceName(device)} 켜기/끄기`} title="켜기/끄기 (바이패스)" onClick={e => { stop(e); props.onToggleDevice?.(id, device.id) }} />
        <button type="button" className="cstrip-slot-main" onClick={e => { stop(e); props.onOpenDevices?.(id, device.id) }} title={`${deviceName(device)}${device.type === 'vst3' ? '' : ` · ${effectLabel(device.type)}`} 열기`}><span>{deviceName(device)}</span></button>
      </div>)}
      {props.onOpenLibrary
        ? <button type="button" className="cstrip-slot cstrip-insert-empty" onClick={e => { stop(e); props.onOpenLibrary?.(id) }} aria-label="시김새 추가: 왼쪽 라이브러리에서 끌어다 놓기 · 라이브러리 열기" title="시김새 추가 — 왼쪽 라이브러리에서 이 스트립으로 끌어다 놓으세요. 클릭하면 라이브러리의 시김새 목록을 엽니다."><Icon name="plus" size={10} /></button>
        : <button type="button" className="cstrip-slot cstrip-insert-empty" onClick={e => { stop(e); open('add', e) }} aria-label="시김새 추가" aria-haspopup="menu" aria-expanded={menu?.kind === 'add'} title="시김새 추가"><Icon name="plus" size={10} /></button>}
    </div>
    <Sends track={track} project={project} compact={compact} onSendChange={props.onSendChange} />
    <div className="cstrip-slot cstrip-output" title="출력">Stereo Out</div>
    <div className="cstrip-fill" />
    <div className="cstrip-pan" onClick={stop}><PanKnob value={shown!.pan} size={compact ? 26 : 30} ariaLabel={`${track.name} 팬`} onChange={pan => props.onTrackChange(id, { pan }, `${id}:pan`)} /></div>
    <div className="cstrip-buttons" onClick={stop}><TrackButtons track={track} kinds={track.kind === 'return' ? RETURN_BUTTONS : BUTTONS} arm={props.arm} recording={props.recording} implicitMute={props.implicitMute} onPress={props.onTrackButton} onSweep={props.onTrackSweep} size="strip" /></div>
    <div className="cstrip-db">{formatGainDb(shown!.volume)}</div>
    <div className="cstrip-fader" onClick={stop}><VolumeSlider value={shown!.volume} orientation="vertical" meter={{ engine, trackId: id }} ariaLabel={`${track.name} 볼륨`} disabled={!track.enabled} onChange={volume => props.onTrackChange(id, { volume }, `${id}:volume`)} /></div>
    <button type="button" className="cstrip-icon" onClick={e => { if (props.onIconMenu) { stop(e); props.onIconMenu(id, e) } }} aria-label="트랙 아이콘" title={props.onIconMenu ? '트랙 아이콘 변경' : undefined}><Icon name={trackIcon(track)} size={14} /></button>
    <div className="cstrip-name" title={track.name} onDoubleClick={e => { if (props.onOpenColorPalette) { stop(e); props.onOpenColorPalette(id, e) } }}><span>{track.name}</span></div>
    {menu && <ContextMenu x={menu.x} y={menu.y} items={items()} onClose={() => setMenu(null)} trigger={menu.trigger} label={menu.kind === 'instrument' ? '악기 선택' : menu.kind === 'add' ? '시김새 추가' : '시김새'} />}
  </div>
}

/** The 센드 section: one small knob per return track (letter A, B, …) with a pre/post-fader toggle. A return
 * strip lists how many tracks feed it instead (returns do not send). */
function Sends({ track, project, compact, onSendChange }: { track: Track; project: Project; compact?: boolean; onSendChange?: ChannelStripProps['onSendChange'] }) {
  const returns = returnTracks(project.tracks)
  if (!returns.length) return null
  if (!canSend(track)) {
    const feeding = sendersOf(project.tracks, track.id).length
    const letter = returnLetter(returns.findIndex(item => item.id === track.id))
    return <div className="cstrip-sends cstrip-sends-return" title={`리턴 ${letter} · 센드를 받는 트랙 ${feeding}개`}><span className="cstrip-sends-title">센드 받음</span><span className="cstrip-sends-count">{feeding}</span></div>
  }
  return <div className="cstrip-sends" role="group" aria-label="센드" onClick={e => e.stopPropagation()}>
    {!compact && <span className="cstrip-sends-title">센드</span>}
    {returns.map((item, index) => {
      const send = sendTo(track, item.id), letter = returnLetter(index), level = send?.level ?? 0, pre = !!send?.pre
      return <div className={`cstrip-send${pre ? ' pre' : ''}`} key={item.id}>
        <SendKnob value={level} label={letter} color={item.color} size={compact ? 20 : 22} ariaLabel={`${item.name}(${letter})로 보내는 센드`} disabled={!onSendChange || !track.enabled}
          onChange={value => onSendChange?.(track.id, item.id, { level: value }, `${track.id}:send:${item.id}`)} />
        <button type="button" className={`cstrip-send-mode${pre ? ' pre' : ''}`} aria-pressed={pre} disabled={!onSendChange}
          title={`${item.name}: ${pre ? '프리 페이더 (팬·페이더 전)' : '포스트 페이더 (팬·페이더 후)'} · ${formatSendDb(level)} · 클릭: 전환`}
          aria-label={`${item.name} 센드 ${pre ? '프리 페이더' : '포스트 페이더'}`}
          onClick={e => { e.stopPropagation(); onSendChange?.(track.id, item.id, { pre: !pre }) }}>{pre ? 'Pre' : 'Post'}</button>
      </div>
    })}
  </div>
}

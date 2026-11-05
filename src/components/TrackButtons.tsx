import { useEffect, useRef } from 'react'
import type { Track } from '../core/types'
import { monitorModeOf, type ArmState, type TrackButtonKind as Kind } from '../core/trackActions'
import { shortcutPlatform } from '../core/input'
import { Icon } from './Icon'
import './TrackHeader.css'

export type TrackButtonKind = Kind
export type TrackButtonMods = { alt: boolean; mod: boolean; soloSafe: boolean }

const MAC = shortcutPlatform() === 'mac'
const ALT = MAC ? '⌥' : 'Alt+', MOD = MAC ? '⌘' : 'Ctrl+', SAFE = MAC ? '⌃클릭' : 'Alt+Shift+클릭'

const LABEL: Record<Kind, string> = { mute: '음소거', solo: '솔로', arm: '녹음 가능', monitor: '입력 모니터링', enabled: '켬/끔', hidden: '가리기' }
const HELP: Record<Kind, string> = {
  mute: `${ALT}클릭: 이 트랙만 · ${MOD}클릭: 같은 상태 전부 반전 · 드래그: 연속 전환`,
  solo: `${ALT}클릭: 이 트랙만 · ${MOD}클릭: 전부 · ${SAFE}: Solo Safe · 드래그: 연속 전환`,
  arm: `${ALT}클릭: 이 트랙만(이미 켜져 있으면 전부 해제) · 드래그: 연속 전환`,
  monitor: '켜면 항상 입력을 듣고, 끄면 듣지 않습니다(자동은 인스펙터에서) · 드래그: 연속 전환',
  enabled: `${MOD}클릭: 전부 · 드래그: 연속 전환`,
  hidden: '가리기 보기를 끄면 숨겨집니다 · 드래그: 연속 전환',
}

export function trackButtonValue(track: Track, kind: Kind, arm: ArmState): boolean {
  switch (kind) {
    case 'mute': return track.mute
    case 'solo': return track.solo
    case 'arm': return arm === 'armed'
    case 'monitor': return monitorModeOf(track) === 'in'
    case 'enabled': return track.enabled
    default: return track.hidden
  }
}

export function TrackButtons({ track, kinds, arm, recording, implicitMute, onPress, onSweep, size = 'header' }: {
  track: Track; kinds: Kind[]; arm: ArmState; recording: boolean; implicitMute: boolean
  onPress(trackId: string, kind: Kind, mods: TrackButtonMods): void
  onSweep(trackId: string, kind: Kind, value: boolean): void
  size?: 'header' | 'strip'
}) {
  const latest = useRef({ track, arm, onPress, onSweep })
  latest.current = { track, arm, onPress, onSweep }
  const stop = useRef<(() => void) | null>(null)
  useEffect(() => () => stop.current?.(), [])

  function press(kind: Kind, mods: TrackButtonMods) { latest.current.onPress(latest.current.track.id, kind, mods) }

  // Drag-across activation: every same-kind button the pointer crosses takes the value computed at pointerdown.
  function sweep(e: React.PointerEvent<HTMLButtonElement>, kind: Kind, value: boolean) {
    stop.current?.()
    const pointerId = e.pointerId, origin = latest.current.track.id
    const seen = new Set([origin])
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return
      const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-track-button]')
      const id = hit?.dataset.trackId
      if (!hit || !id || hit.dataset.trackButton !== kind || seen.has(id)) return
      seen.add(id)
      latest.current.onSweep(id, kind, value)
    }
    const finish = () => {
      stop.current = null
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up)
      window.removeEventListener('keydown', key, true); window.removeEventListener('blur', finish)
    }
    const up = (event: PointerEvent) => { if (event.pointerId === pointerId) finish() }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') finish() }
    stop.current = finish
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up)
    window.addEventListener('keydown', key, true); window.addEventListener('blur', finish)
  }

  function pointerDown(e: React.PointerEvent<HTMLButtonElement>, kind: Kind) {
    e.stopPropagation()
    if (e.button !== 0) return
    e.preventDefault()
    const soloSafe = kind === 'solo' && (MAC ? e.ctrlKey && !e.metaKey : e.altKey && e.shiftKey)
    const mods = { alt: e.altKey && !soloSafe, mod: MAC ? e.metaKey : e.ctrlKey, soloSafe }
    const value = !trackButtonValue(latest.current.track, kind, latest.current.arm)
    press(kind, mods)
    if (!mods.alt && !mods.mod && !soloSafe) sweep(e, kind, value)
  }

  function render(kind: Kind) {
    const on = trackButtonValue(track, kind, arm)
    const cls = ['track-button', `track-button--${kind}`]
    if (on) cls.push('on')
    if (kind === 'mute' && implicitMute && !track.mute) cls.push('implicit')
    if (kind === 'solo' && track.soloSafe) cls.push('safe')
    if (kind === 'arm') { if (arm === 'auto') cls.push('auto'); if (arm === 'armed' && recording) cls.push('recording') }
    if (kind === 'enabled' && !track.enabled) cls.push('off')
    if (kind === 'monitor') { const mode = monitorModeOf(track); if (mode === 'auto' && track.armed) cls.push('auto'); if (mode === 'off') cls.push('mode-off') }
    const state = kind === 'arm' ? arm === 'armed' ? recording ? '녹음 중' : '대기' : arm === 'auto' ? '자동(포커스 트랙)' : '끔' : kind === 'solo' && track.soloSafe ? 'Solo Safe' : kind === 'monitor' && monitorModeOf(track) === 'auto' ? '자동(녹음 대기 중에 들림)' : on ? '켬' : '끔'
    return <button key={kind} type="button" className={cls.join(' ')} data-track-button={kind} data-track-id={track.id}
      aria-pressed={on} aria-label={`${track.name} ${LABEL[kind]}`} title={`${LABEL[kind]}: ${state}\n${HELP[kind]}`}
      onPointerDown={e => pointerDown(e, kind)}
      onClick={e => { if (e.detail === 0) press(kind, { alt: e.altKey, mod: MAC ? e.metaKey : e.ctrlKey, soloSafe: false }) }}
      onContextMenu={e => { if (kind === 'solo' && MAC && e.ctrlKey && !e.metaKey) { e.preventDefault(); e.stopPropagation(); press(kind, { alt: false, mod: false, soloSafe: true }) } }}>
      {kind === 'mute' ? 'M' : kind === 'solo' ? 'S' : kind === 'arm' ? 'R' : kind === 'monitor' ? 'I' : kind === 'hidden' ? 'H' : <Icon name="power" size={size === 'strip' ? 12 : 10}/>}
    </button>
  }

  return <div className={`track-buttons track-buttons--${size}`} role="group" aria-label={`${track.name} 트랙 버튼`}>{kinds.map(render)}</div>
}

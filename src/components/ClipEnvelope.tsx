import { useContext, useId, useRef, useState } from 'react'
import { spanSeconds, type Tempo } from '../core/tempoMap'
import type { AudioAsset, AudioClip, Clip, FadeCurve } from '../core/types'
import { HistoryGestureContext } from '../core/historyGesture'
import { FADE_CURVES, FADE_CURVE_LABELS, NORMALIZE_TARGET_DB, clipGainMaxDb, clipSeconds, fadeCurveOf, fadeLengths, fadeShape, gainToDb, normalizeGain, regionPeak, withClipGainDb, withFade, withFadeCurve, type FadeEdge } from '../core/clipEnvelope'
import type { ContextMenuItem } from './ContextMenu'

/** Applies `fn` to the listed clips as one history step per gesture (Inspector-style multi edit). */
export type ClipsEdit = (clipIds: string[], fn: (clip: Clip) => Clip, label: string) => void

export interface EnvelopeActions {
  /** The region plus every other selected audio region when the region is part of the selection. */
  targets: (clip: AudioClip) => AudioClip[]
  edit: ClipsEdit
  /** Selects the region when it is not selected yet (keeps a multi-selection that contains it). */
  touch: (clip: AudioClip) => void
}

/** Top of the waveform area = +12 dB, bottom = −36 dB; 0 dB sits a quarter of the way down. */
const TOP_DB = 12, SPAN_DB = 48
const gainY = (db: number) => Math.min(100, Math.max(0, (TOP_DB - db) / SPAN_DB * 100))
const DB_PER_PX = 0.25, FINE_DB_PER_PX = 0.025
export const formatGainDb = (db: number) => db <= -60 ? '−∞ dB' : `${db > 0.049 ? '+' : db < -0.049 ? '−' : ''}${Math.abs(db).toFixed(1)} dB`
export const formatFadeSeconds = (s: number) => s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`


type Drag = { kind: 'gain' | FadeEdge; id: number; x: number; y: number; moved: boolean; start: Map<string, number>; ids: string[] }

/**
 * On-region gain line (Reaper/Cubase volume handle) and fade handles at the top corners
 * (Reaper/Studio One/Cubase). Drag edits every selected audio region; double-click resets.
 */
export function ClipEnvelope({ clip, widthPx, tempo, asset, showFades, readOnly = false, actions }: {
  clip: AudioClip; widthPx: number; tempo: Tempo; asset?: AudioAsset; showFades: boolean
  /** Loop repeats and moving previews show the fades only. */
  readOnly?: boolean
  actions: React.RefObject<EnvelopeActions | null>
}) {
  const host = useContext(HistoryGestureContext)
  const gestureId = useId()
  const drag = useRef<Drag | null>(null)
  const [readout, setReadout] = useState<{ kind: Drag['kind']; text: string } | null>(null)
  const regionSeconds = clipSeconds(clip, tempo, asset?.buffer.duration)
  // Across a tempo change the region's pixels per second vary; fades use the region's average.
  const pxPerSecond = widthPx / Math.max(1e-6, spanSeconds(tempo, clip.startBeat, clip.startBeat + clip.lengthBeats))
  const [fadeIn, fadeOut] = fadeLengths(regionSeconds, clip.fadeIn, clip.fadeOut)
  const inPx = Math.min(widthPx, fadeIn * pxPerSecond), outPx = Math.min(widthPx, fadeOut * pxPerSecond)
  const db = gainToDb(clip.gain)
  const label = (kind: Drag['kind']) => kind === 'gain' ? '리전 게인 조절' : kind === 'in' ? '리전 페이드 인 조절' : '리전 페이드 아웃 조절'

  function begin(e: React.PointerEvent<HTMLElement>, kind: Drag['kind']) {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    const act = actions.current; if (!act) return
    act.touch(clip)
    const targets = act.targets(clip)
    const start = new Map(targets.map(c => [c.id, kind === 'gain' ? gainToDb(c.gain) : kind === 'in' ? c.fadeIn : c.fadeOut] as const))
    drag.current = { kind, id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, start, ids: targets.map(c => c.id) }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* window listeners finish the drag */ }
    setReadout({ kind, text: kind === 'gain' ? formatGainDb(db) : formatFadeSeconds(kind === 'in' ? fadeIn : fadeOut) })
  }
  function move(e: React.PointerEvent<HTMLElement>) {
    const d = drag.current; if (!d || e.pointerId !== d.id) return
    const dx = e.clientX - d.x, dy = e.clientY - d.y
    if (!d.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return
    if (!d.moved) { d.moved = true; host?.beginGesture(gestureId, label(d.kind)) }
    const act = actions.current; if (!act) return
    if (d.kind === 'gain') {
      const delta = -dy * (e.shiftKey ? FINE_DB_PER_PX : DB_PER_PX)
      const anchor = (d.start.get(clip.id) ?? db) + delta
      act.edit(d.ids, c => c.kind === 'audio' ? withClipGainDb(c, Math.round(((d.start.get(c.id) ?? 0) + delta) * 100) / 100) : c, label('gain'))
      setReadout({ kind: 'gain', text: formatGainDb(Math.min(clipGainMaxDb(clip), anchor)) })
    } else {
      // Fades take the same absolute length on every selected region (Logic/Cubase), each limited by its own length.
      const base = d.start.get(clip.id) ?? 0
      const seconds = Math.max(0, base + (d.kind === 'in' ? dx : -dx) / pxPerSecond * (e.shiftKey ? 0.1 : 1))
      const edge = d.kind
      act.edit(d.ids, c => c.kind === 'audio' ? withFade(c, edge, seconds, clipSeconds(c, tempo, c.id === clip.id ? asset?.buffer.duration : undefined)) : c, label(edge))
      setReadout({ kind: edge, text: formatFadeSeconds(Math.min(seconds, regionSeconds - (edge === 'in' ? clip.fadeOut : clip.fadeIn))) })
    }
  }
  function end(e: React.PointerEvent<HTMLElement>, cancel = false) {
    const d = drag.current; if (!d || e.pointerId !== d.id) return
    drag.current = null; setReadout(null)
    if (e.currentTarget.hasPointerCapture(d.id)) e.currentTarget.releasePointerCapture(d.id)
    if (d.moved) { if (cancel) host?.cancelGesture(gestureId); else host?.endGesture(gestureId) }
  }
  function keyDown(e: React.KeyboardEvent<HTMLElement>) {
    const d = drag.current
    if (e.key === 'Escape' && d) { e.preventDefault(); e.stopPropagation(); drag.current = null; setReadout(null); if (d.moved) host?.cancelGesture(gestureId) }
  }
  function reset(e: React.MouseEvent, kind: Drag['kind']) {
    e.stopPropagation(); e.preventDefault()
    const act = actions.current; if (!act) return
    const ids = act.targets(clip).map(c => c.id)
    if (kind === 'gain') act.edit(ids, c => c.kind === 'audio' ? withClipGainDb(c, 0) : c, '리전 게인 초기화')
    else act.edit(ids, c => c.kind === 'audio' ? withFade(c, kind, 0, Infinity) : c, kind === 'in' ? '페이드 인 제거' : '페이드 아웃 제거')
  }
  const handlers = (kind: Drag['kind']) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => begin(e, kind), onPointerMove: move,
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => end(e), onPointerCancel: (e: React.PointerEvent<HTMLElement>) => end(e, true),
    onLostPointerCapture: (e: React.PointerEvent<HTMLElement>) => end(e), onKeyDown: keyDown,
    onDoubleClick: (e: React.MouseEvent) => reset(e, kind), onClick: (e: React.MouseEvent) => e.stopPropagation(),
  })
  const y = gainY(db)
  const active = readout?.kind
  // One envelope line (Ableton/Logic): rises from the bottom along the fade-in curve to the gain level,
  // stays flat, then falls along the fade-out curve. Same fadeShape as playback, so the line is the sound.
  const fadeVisible = showFades && (inPx > 0.5 || outPx > 0.5)
  const at = (shape: number) => (100 - (100 - y) * shape).toFixed(2)
  const span = (x0: number, w: number, rising: boolean, curve: FadeCurve | undefined, steps = 24) => Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps
    return `${(x0 + t * w).toFixed(2)},${at(fadeShape(curve, rising ? t : 1 - t))}`
  })
  const inPts = fadeVisible && inPx > 0.5 ? span(0, inPx, true, clip.fadeInCurve) : [`0,${y.toFixed(2)}`]
  const outPts = fadeVisible && outPx > 0.5 ? span(widthPx - outPx, outPx, false, clip.fadeOutCurve) : [`${widthPx},${y.toFixed(2)}`]
  const line = [...inPts, ...outPts].join(' ')
  const envelope = <svg className="clip-fades" aria-hidden="true" width={widthPx} height="100%" viewBox={`0 0 ${Math.max(1, widthPx)} 100`} preserveAspectRatio="none">
    {fadeVisible && inPx > 0.5 && <polygon className="clip-fade-shade" points={`0,0 ${inPts.join(' ')} ${inPx},0`}/>}
    {fadeVisible && outPx > 0.5 && <polygon className="clip-fade-shade" points={`${widthPx - outPx},0 ${outPts.join(' ')} ${widthPx},0`}/>}
    <polyline className="clip-envelope-line" points={line}/>
  </svg>
  if (readOnly) return fadeVisible || Math.abs(db) > 0.05 ? <div className={`clip-envelope read-only${Math.abs(db) > 0.05 ? ' gain-changed' : ''}${fadeVisible ? ' has-fades' : ''}`}>{envelope}</div> : null
  const flatLeft = fadeVisible ? inPx : 0, flatRight = fadeVisible ? widthPx - outPx : widthPx
  return <div className={`clip-envelope${active ? ' dragging' : ''}${Math.abs(db) > 0.05 ? ' gain-changed' : ''}${fadeVisible ? ' has-fades' : ''}`}>
    {envelope}
    <div className="clip-gain-line" style={{ top: `${y}%`, left: flatLeft, width: Math.max(4, flatRight - flatLeft) }} role="slider" tabIndex={-1} aria-label="리전 게인 핸들" aria-valuemin={-60} aria-valuemax={clipGainMaxDb(clip)} aria-valuenow={Math.round(db * 10) / 10} aria-valuetext={formatGainDb(db)}
      title={`리전 게인 ${formatGainDb(db)} · 위아래로 드래그 (Shift: 미세 조절) · 더블 클릭: 0 dB`} {...handlers('gain')}/>
    {widthPx >= 24 && <>
      <div className="clip-fade-handle in" style={{ left: inPx, top: `${y}%` }} role="slider" tabIndex={-1} aria-label="페이드 인 핸들" aria-valuetext={formatFadeSeconds(fadeIn)}
        title={`페이드 인 ${formatFadeSeconds(fadeIn)} · 좌우로 드래그 · 더블 클릭: 제거 · 우클릭: 곡선`} {...handlers('in')}/>
      <div className="clip-fade-handle out" style={{ left: widthPx - outPx, top: `${y}%` }} role="slider" tabIndex={-1} aria-label="페이드 아웃 핸들" aria-valuetext={formatFadeSeconds(fadeOut)}
        title={`페이드 아웃 ${formatFadeSeconds(fadeOut)} · 좌우로 드래그 · 더블 클릭: 제거 · 우클릭: 곡선`} {...handlers('out')}/>
    </>}
    {readout && <output className={`clip-envelope-readout ${readout.kind}`} style={readout.kind === 'gain' ? { top: `${y}%`, left: (flatLeft + flatRight) / 2 } : readout.kind === 'in' ? { top: `${y}%`, left: inPx } : { top: `${y}%`, left: widthPx - outPx }}>{readout.text}</output>}
  </div>
}

/**
 * Region-menu entries for gain and fades. `targets` are the audio regions the menu acts on;
 * `onCrossfade` is absent when the host cannot rearrange regions.
 */
export function envelopeMenuItems(clip: AudioClip, targets: AudioClip[], assets: Map<string, AudioAsset>, tempo: Tempo, edit: ClipsEdit, onCrossfade?: () => void): ContextMenuItem[] {
  const ids = targets.map(c => c.id)
  const curveItems = (edge: FadeEdge): ContextMenuItem[] => FADE_CURVES.map(curve => ({
    label: FADE_CURVE_LABELS[curve], checked: fadeCurveOf(edge === 'in' ? clip.fadeInCurve : clip.fadeOutCurve) === curve,
    onSelect: () => edit(ids, c => c.kind === 'audio' ? withFadeCurve(c, edge, curve) : c, edge === 'in' ? '페이드 인 곡선 변경' : '페이드 아웃 곡선 변경'),
  }))
  const normalize = () => {
    const gains = new Map<string, number>()
    for (const c of targets) {
      const asset = assets.get(c.assetId); if (!asset) continue
      const channels = Array.from({ length: asset.buffer.numberOfChannels }, (_, i) => asset.buffer.getChannelData(i))
      const gain = normalizeGain(regionPeak(channels, asset.buffer.sampleRate, c.offsetSeconds, clipSeconds(c, tempo, asset.buffer.duration)))
      if (gain !== null) gains.set(c.id, gain)
    }
    if (gains.size) edit([...gains.keys()], c => gains.has(c.id) ? { ...c, gain: gains.get(c.id)! } : c, '리전 노멀라이즈')
  }
  return [
    { label: '페이드 인 곡선', icon: 'wave', items: curveItems('in') },
    { label: '페이드 아웃 곡선', icon: 'wave', items: curveItems('out') },
    { label: '크로스페이드 만들기', icon: 'merge', disabled: !onCrossfade || targets.length < 2, onSelect: onCrossfade },
    { label: `노멀라이즈 (${NORMALIZE_TARGET_DB} dBFS 피크)`, icon: 'volume', disabled: !targets.some(c => assets.has(c.assetId)), onSelect: normalize },
    { label: '게인 초기화 (0 dB)', disabled: targets.every(c => Math.abs(c.gain - 1) < 1e-9), onSelect: () => edit(ids, c => c.kind === 'audio' ? withClipGainDb(c, 0) : c, '리전 게인 초기화') },
    { label: '페이드 제거', disabled: targets.every(c => c.fadeIn <= 0 && c.fadeOut <= 0), onSelect: () => edit(ids, c => c.kind === 'audio' ? { ...c, fadeIn: 0, fadeOut: 0 } : c, '페이드 제거') },
  ]
}

import { useEffect, useRef, useState } from 'react'
import type { AudioClip, Clip, MidiClip } from '../core/types'
import { QUANTIZE_VALUES, type FadeCurve } from '../core/types'
import { AUDIO_CLIP_GAIN_MAX_DB, FADE_CURVES, FADE_CURVE_LABELS, MIDI_CLIP_GAIN_MAX, clipGainMax, fadeCurveOf, withFadeCurve, type FadeEdge } from '../core/clipEnvelope'
import { formatFadeSeconds } from './ClipEnvelope'
import { attachWarpTempo, disableWarp, enableWarp, setWarpSourceBpm, WARP_BPM, warpRatioSupported } from '../devices/audio-warp/state'

export interface ClipEntry { trackId: string; clip: Clip }

export const QUANTIZE_LABELS = ['끔', '1/1', '1/2', '1/4', '1/8', '1/16', '1/32', '1/64', '1/2T', '1/4T', '1/8T', '1/16T'] as const
export const quantizeIndex = (value: number) => QUANTIZE_VALUES.findIndex(q => Math.abs(q - value) < 1e-6)
export const ticksToMs = (ticks: number, bpm: number) => (ticks / 960) * (60000 / bpm)
export const gainToDb = (gain: number) => gain <= 0.001 ? -60 : Math.max(-60, 20 * Math.log10(gain))
export const dbToGain = (db: number, max = MIDI_CLIP_GAIN_MAX) => db <= -60 ? 0 : Math.min(max, Math.pow(10, db / 20))
export const signed = (v: number) => v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : '0'
export const formatDb = (v: number) => v <= -60 ? '−∞ dB' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} dB`
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
/** "250 ms", "0.25 s" or a bare number of seconds. */
const parseSeconds = (s: string) => { const n = parseNumber(s); return n === null ? null : /ms/i.test(s) ? n / 1000 : n }
const parseNumber = (s: string) => { const n = Number(s.replace(/[−–]/g, '-').replace(/[^\d.\-]/g, '')); return Number.isFinite(n) ? n : null }

export interface ValueFieldProps {
  value: number
  /** Selected items disagree: the field shows `*` until it is edited. */
  mixed?: boolean
  min: number
  max: number
  step?: number
  /** Pointer travel per step while dragging. */
  pxPerStep?: number
  format?: (v: number) => string
  parse?: (s: string) => number | null
  /** absolute = ⌥⇧ was held at commit (Logic: every selected item gets the same value). */
  onChange: (next: number, final: boolean, absolute: boolean) => void
  ariaLabel: string
  disabled?: boolean
  className?: string
}

/** Logic-style value field: drag vertically to change, click to type, ↑/↓ to step, Esc to revert. */
export function ValueField({ value, mixed, min, max, step = 1, pxPerStep = 3, format = String, parse = parseNumber, onChange, ariaLabel, disabled, className = '' }: ValueFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const latest = useRef({ value, min, max, step, onChange })
  latest.current = { value, min, max, step, onChange }
  const drag = useRef<{ id: number; startY: number; startValue: number; moved: boolean; last: number } | null>(null)
  const decimals = Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)))
  const round = (v: number) => Number(clamp(v, min, max).toFixed(decimals))
  useEffect(() => () => { drag.current = null }, [])
  function pointerDown(e: React.PointerEvent<HTMLInputElement>) {
    if (disabled || e.button !== 0 || draft !== null) return
    e.preventDefault()
    const el = e.currentTarget
    drag.current = { id: e.pointerId, startY: e.clientY, startValue: latest.current.value, moved: false, last: latest.current.value }
    const move = (ev: PointerEvent) => {
      const d = drag.current; if (!d || ev.pointerId !== d.id) return
      const dy = d.startY - ev.clientY
      if (!d.moved && Math.abs(dy) < 3) return
      if (!d.moved) { d.moved = true; el.dataset.dawGesture = 'value'; try { el.setPointerCapture(d.id) } catch { /* window listeners still finish the drag */ } }
      const l = latest.current
      const next = round(d.startValue + (dy / (ev.shiftKey ? pxPerStep * 8 : pxPerStep)) * l.step)
      if (next !== d.last) { d.last = next; l.onChange(next, false, ev.altKey && ev.shiftKey) }
    }
    const finish = (ev: PointerEvent | KeyboardEvent | FocusEvent, restore: boolean) => {
      const d = drag.current; if (!d) return
      drag.current = null
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up)
      window.removeEventListener('keydown', key, true); window.removeEventListener('blur', blur)
      delete el.dataset.dawGesture
      if (el.hasPointerCapture(d.id)) el.releasePointerCapture(d.id)
      if (!d.moved) { setDraft(format(latest.current.value)); requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select() }); return }
      const abs = 'altKey' in ev ? ev.altKey && ev.shiftKey : false
      latest.current.onChange(restore ? d.startValue : d.last, true, abs)
    }
    const up = (ev: PointerEvent) => { if (ev.pointerId === drag.current?.id) finish(ev, false) }
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(ev, true) } }
    const blur = (ev: FocusEvent) => finish(ev, false)
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up)
    window.addEventListener('keydown', key, true); window.addEventListener('blur', blur)
  }
  const skipBlur = useRef(false)
  function commitDraft(e: React.SyntheticEvent) {
    if (skipBlur.current) { skipBlur.current = false; return }
    if (draft === null) return
    const parsed = parse(draft)
    setDraft(null)
    if (parsed === null) return
    const next = round(parsed)
    const ne = e.nativeEvent as KeyboardEvent | FocusEvent
    const abs = 'altKey' in ne ? ne.altKey && ne.shiftKey : false
    if (next !== latest.current.value || abs) latest.current.onChange(next, true, abs)
  }
  function keyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return
    const leave = () => { const el = inputRef.current; if (el && document.activeElement === el) { skipBlur.current = true; el.blur() } }
    if (e.key === 'Enter') { e.preventDefault(); commitDraft(e); leave(); return }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDraft(null); leave(); return }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const dir = e.key === 'ArrowUp' ? 1 : -1
      const next = round(value + dir * step * (e.shiftKey && !e.altKey ? 10 : 1))
      setDraft(null)
      if (next !== value) onChange(next, true, e.altKey && e.shiftKey)
    }
  }
  const text = draft ?? (mixed ? `*${format(value)}` : format(value))
  return <input ref={inputRef} type="text" inputMode="decimal" className={`value-field ${mixed ? 'mixed' : ''} ${draft !== null ? 'editing' : ''} ${className}`} value={text} aria-label={ariaLabel} title={`${ariaLabel} · 드래그 또는 입력 (⌥⇧: 전부 같은 값)`} disabled={disabled} readOnly={draft === null}
    onPointerDown={pointerDown} onChange={e => setDraft(e.target.value)} onBlur={commitDraft} onKeyDown={keyDown} onFocus={e => { if (draft === null && !drag.current) { setDraft(format(value)); e.currentTarget.select() } }} />
}

function Check({ label, values, onChange }: { label: string; values: boolean[]; onChange: (next: boolean) => void }) {
  const all = values.length > 0 && values.every(Boolean), some = values.some(Boolean)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = some && !all }, [some, all])
  return <label className="insp-row insp-check"><span className="insp-label">{label}</span><input ref={ref} type="checkbox" checked={all} onChange={() => onChange(!all)} aria-label={label} /></label>
}

interface Props {
  selection: ClipEntry[]
  bpm: number
  beatsPerBar?: number
  /** Applies fn to every selected clip; key merges consecutive edits into one history step. */
  onClipsEdit: (fn: (clip: Clip) => Clip, key?: string) => void
  warp?: WarpControls
}

export interface WarpControls {
  analyzing: boolean
  rendering: boolean
  onAnalyze: (clipId: string) => void
  /** Sets the project tempo to the clip's source tempo. */
  onAdoptTempo: (clipId: string) => void
}

/** Warp toggle, source tempo (typed, ×2, ÷2), analysis and "프로젝트 템포로 설정". */
function WarpSection({ clip, bpm, controls, onClipsEdit }: { clip: AudioClip; bpm: number; controls: WarpControls; onClipsEdit: Props['onClipsEdit'] }) {
  const warp = clip.warp
  const edit = (fn: (clip: AudioClip) => AudioClip, key?: string) => onClipsEdit(c => c.kind === 'audio' && c.id === clip.id ? fn(c) : c, key)
  const setSource = (value: number, key?: string) => edit(c => c.warp ? setWarpSourceBpm(c, value) : attachWarpTempo(c, { bpm: value, confidence: 0, firstBeatSeconds: 0 }), key)
  const locked = !!clip.pitch
  const unsupported = !!warp && !warp.enabled && !warpRatioSupported(warp.sourceBpm, bpm)
  const status = locked ? '피치 편집한 리전은 워프할 수 없습니다. 피치 편집을 초기화해 주세요.'
    : controls.analyzing ? '템포 분석 중…'
    : warp?.enabled && controls.rendering ? '프로젝트 템포에 맞추는 중…'
    : !warp ? '템포를 분석하거나 원본 BPM을 입력하면 워프할 수 있습니다.'
    : unsupported ? '프로젝트 템포와 차이가 너무 커서 워프할 수 없습니다.'
    : warp.confidence > 0 ? `감지 신뢰도 ${Math.round(warp.confidence * 100)}%` : '직접 입력한 템포'
  return <div className="insp-warp" role="group" aria-label="워프">
    <label className="insp-row insp-check"><span className="insp-label">워프</span>
      <input type="checkbox" checked={!!warp?.enabled} disabled={locked || !warp || unsupported} aria-label="워프" title="켜면 리전이 프로젝트 템포를 따라 늘어나거나 줄어듭니다. 끄면 원래 타이밍으로 돌아갑니다."
        onChange={e => edit(c => e.target.checked ? enableWarp(c, bpm) : disableWarp(c, bpm))} />
      {warp?.enabled && <small className="insp-unit">{`${warp.sourceBpm} → ${bpm} BPM`}</small>}
    </label>
    <div className="insp-row"><span className="insp-label">원본 템포</span>
      <ValueField value={warp?.sourceBpm ?? bpm} mixed={!warp} min={WARP_BPM.min} max={WARP_BPM.max} step={.1} pxPerStep={2} format={v => `${+v.toFixed(2)} BPM`} ariaLabel="원본 템포" disabled={locked}
        onChange={next => setSource(next, `region:warp-bpm:${clip.id}`)} />
    </div>
    <div className="insp-row insp-warp-actions">
      <button type="button" disabled={locked || !warp || warp.sourceBpm * 2 > WARP_BPM.max} onClick={() => warp && setSource(warp.sourceBpm * 2)} title="원본 템포 두 배" aria-label="원본 템포 두 배">×2</button>
      <button type="button" disabled={locked || !warp || warp.sourceBpm / 2 < WARP_BPM.min} onClick={() => warp && setSource(warp.sourceBpm / 2)} title="원본 템포 절반" aria-label="원본 템포 절반">÷2</button>
      <button type="button" disabled={locked || controls.analyzing} onClick={() => controls.onAnalyze(clip.id)} title="오디오의 박을 분석해 원본 템포를 찾습니다">템포 분석</button>
    </div>
    <button type="button" className="insp-warp-adopt" disabled={!warp || locked || Math.abs(warp.sourceBpm - bpm) < 1e-6} onClick={() => controls.onAdoptTempo(clip.id)} title="프로젝트 템포를 이 리전의 원본 템포로 바꿉니다">프로젝트 템포로 설정</button>
    <small className="insp-warp-status" aria-live="polite">{status}</small>
  </div>
}

type NumField = { get: (c: Clip) => number; set: (c: Clip, v: number) => Clip; min: number; max: number }
const midiNum = (field: 'transpose' | 'velocity' | 'swing' | 'quantize', fallback: number) => ({ get: (c: Clip) => (c.kind === 'midi' ? c[field] : undefined) ?? fallback, set: (c: Clip, v: number): Clip => c.kind === 'midi' ? { ...c, [field]: v } : c })
const FIELDS = {
  transpose: { ...midiNum('transpose', 0), min: -96, max: 96 },
  velocity: { ...midiNum('velocity', 0), min: -99, max: 99 },
  swing: { ...midiNum('swing', 50), min: 0, max: 100 },
  delay: { get: (c: Clip) => c.delayTicks ?? 0, set: (c: Clip, v: number): Clip => ({ ...c, delayTicks: v }), min: -1920, max: 1920 },
  gain: { get: (c: Clip) => gainToDb(c.gain), set: (c: Clip, v: number): Clip => ({ ...c, gain: dbToGain(v, clipGainMax(c)) }), min: -60, max: AUDIO_CLIP_GAIN_MAX_DB },
  fadeIn: { get: (c: Clip) => c.kind === 'audio' ? c.fadeIn : 0, set: (c: Clip, v: number): Clip => c.kind === 'audio' ? { ...c, fadeIn: Math.max(0, v) } : c, min: 0, max: 30 },
  fadeOut: { get: (c: Clip) => c.kind === 'audio' ? c.fadeOut : 0, set: (c: Clip, v: number): Clip => c.kind === 'audio' ? { ...c, fadeOut: Math.max(0, v) } : c, min: 0, max: 30 },
} satisfies Record<string, NumField>

export function RegionInspector({ selection, bpm, beatsPerBar = 4, onClipsEdit, warp }: Props) {
  const [more, setMore] = useState(false)
  const clips = selection.map(e => e.clip)
  const anchor = clips[0]
  if (!anchor) return null
  const allMidi = clips.every((c): c is MidiClip => c.kind === 'midi'), allAudio = clips.every((c): c is AudioClip => c.kind === 'audio')
  const mixedOf = (get: (c: Clip) => unknown) => clips.some(c => get(c) !== get(anchor))
  function num(name: keyof typeof FIELDS, label: string, opts: { step?: number; pxPerStep?: number; format?: (v: number) => string; parse?: (s: string) => number | null; disabled?: boolean; after?: React.ReactNode } = {}) {
    const f: NumField = FIELDS[name]
    const value = f.get(anchor)
    return <div className="insp-row" key={name}><span className="insp-label">{label}</span>
      <ValueField value={value} mixed={mixedOf(f.get)} min={f.min} max={f.max} step={opts.step} pxPerStep={opts.pxPerStep} format={opts.format} parse={opts.parse} ariaLabel={`리전 ${label}`} disabled={opts.disabled}
        onChange={(next, _final, absolute) => { const delta = next - value; onClipsEdit(c => f.set(c, absolute ? next : clamp(f.get(c) + delta, f.min, f.max)), `region:${name}`) }} />
      {opts.after}</div>
  }
  function curve(edge: FadeEdge, label: string) {
    const get = (c: Clip) => c.kind === 'audio' ? fadeCurveOf(edge === 'in' ? c.fadeInCurve : c.fadeOutCurve) : 'linear'
    const mixed = mixedOf(get)
    return <div className="insp-row" key={`curve-${edge}`}><span className="insp-label">{label}</span>
      <select className="insp-select" aria-label={`리전 페이드 ${edge === 'in' ? '인' : '아웃'} 곡선`} value={mixed ? '' : get(anchor)}
        onChange={e => { const next = e.target.value as FadeCurve; if (next) onClipsEdit(c => c.kind === 'audio' ? withFadeCurve(c, edge, next) : c) }}>
        {mixed && <option value="">*</option>}{FADE_CURVES.map(value => <option key={value} value={value}>{FADE_CURVE_LABELS[value]}</option>)}
      </select></div>
  }
  const quantize = allMidi ? (anchor as MidiClip).quantize ?? 0 : 0
  const qIndex = quantizeIndex(quantize)
  const qMixed = allMidi && mixedOf(c => quantizeIndex((c as MidiClip).quantize ?? 0))
  const delayMs = ticksToMs(FIELDS.delay.get(anchor), bpm)
  const ms = <small className="insp-unit">{`${delayMs >= 0 ? '' : '−'}${Math.abs(delayMs).toFixed(1)} ms`}</small>
  return <div className="region-inspector">
    <Check label="뮤트" values={clips.map(c => !!c.mute)} onChange={v => onClipsEdit(c => ({ ...c, mute: v }))} />
    <Check label="루프" values={clips.map(c => !!c.loop)} onChange={v => onClipsEdit(c => ({ ...c, loop: v }))} />
    {allMidi && <>
      <div className="insp-row"><span className="insp-label">퀀타이즈</span><select className="insp-select" aria-label="리전 퀀타이즈" value={qMixed ? '' : qIndex} onChange={e => { const q = QUANTIZE_VALUES[Number(e.target.value)]; onClipsEdit(c => c.kind === 'midi' ? { ...c, quantize: q } : c) }}>{qMixed && <option value="">*</option>}{QUANTIZE_LABELS.map((label, i) => <option key={label} value={i}>{label}</option>)}</select></div>
      {num('swing', 'Q-스윙', { disabled: qIndex <= 0 && !qMixed, format: v => `${v}%` })}
      {num('transpose', '트랜스포즈', { format: signed })}
      {num('velocity', '벨로시티', { format: signed })}
    </>}
    {allAudio && num('gain', '게인', { step: .1, pxPerStep: 2, format: formatDb })}
    {allAudio && <>
      {num('fadeIn', '페이드 인', { step: .001, pxPerStep: 1, format: formatFadeSeconds, parse: parseSeconds })}
      {curve('in', '인 곡선')}
      {num('fadeOut', '페이드 아웃', { step: .001, pxPerStep: 1, format: formatFadeSeconds, parse: parseSeconds })}
      {curve('out', '아웃 곡선')}
    </>}
    {allAudio && warp && clips.length === 1 && <WarpSection clip={anchor as AudioClip} bpm={bpm} controls={warp} onClipsEdit={onClipsEdit} />}
    <button type="button" className={`insp-more ${more ? 'open' : ''}`} onClick={() => setMore(m => !m)} aria-expanded={more}>{more ? '▾' : '▸'} 더 보기</button>
    {more && <>
      {num('delay', '딜레이', { format: v => `${signed(v)} 틱`, after: ms })}
      {allMidi && num('gain', '게인', { step: .1, pxPerStep: 2, format: formatDb })}
      {allMidi && <div className="insp-row"><span className="insp-label">클립 길이</span><b className="insp-readonly">{(anchor.lengthBeats / beatsPerBar).toFixed(2)}{mixedOf(c => c.lengthBeats) ? '*' : ''} 마디</b></div>}
    </>}
  </div>
}

export const regionTitle = (selection: ClipEntry[]) => selection.length === 0 ? '기본 설정' : selection.length === 1 ? `리전: ${selection[0].clip.name}` : `${selection.length}개 선택됨`

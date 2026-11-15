import { useRef, useState } from 'react'
import type { AudioClip } from '../core/types'
import { Popover } from './HeaderConfigPopover'
import { ValueField } from './RegionInspector'
import { clipNeedsRender } from '../devices/audio-warp/state'
import { DEFAULT_TRANSPOSE, TRANSPOSE_LIMITS, TRANSPOSE_MODE_LABELS, TRANSPOSE_MODES, formatTranspose, isDefaultTranspose, transposeRate, transposeSettings, type TransposeSettings } from '../devices/region-pitch/state'
import './RegionPitchBadge.css'

export type TransposeChange = (change: (current: TransposeSettings) => TransposeSettings, label?: string, key?: string) => void

const signedInt = (v: number) => v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0'

/** True while the clip's audible asset does not yet carry its pitch settings (rendering). */
export const regionPitchPending = (clip: AudioClip, bpm: number) => !!clip.regionPitch && clipNeedsRender(clip, bpm)

/** Semitones, cents, mode (템포 유지 / 자연스럽게), formant and reset: shared by the badge popover and the inspector. */
export function RegionPitchControls({ clip, mixed = false, pending, onChange, idPrefix }: { clip: AudioClip; mixed?: boolean; pending: boolean; onChange: TransposeChange; idPrefix: string }) {
  const settings = transposeSettings(clip)
  const set = (patch: Partial<TransposeSettings>, label: string, key?: string) => onChange(t => ({ ...t, ...patch }), label, key)
  const rate = transposeRate(settings)
  const status = pending ? '피치를 렌더링하는 중… (끝날 때까지 이전 소리로 재생)'
    : settings.mode === 'varispeed' ? (rate === 1 ? '자연스럽게: 피치와 속도가 함께 바뀝니다.' : `자연스럽게: 속도 ×${rate.toFixed(3)} · 길이 ×${(1 / rate).toFixed(3)}`)
    : '템포 유지: 길이는 그대로, 피치만 바뀝니다.'
  return <div className="region-pitch-controls">
    <div className="rp-row"><span className="rp-label">반음</span>
      <button type="button" aria-label="1반음 내리기" title="1반음 내리기" disabled={settings.semitones <= -TRANSPOSE_LIMITS.semitones} onClick={() => set({ semitones: settings.semitones - 1 }, '피치 −1')}>−</button>
      <ValueField value={settings.semitones} mixed={mixed} min={-TRANSPOSE_LIMITS.semitones} max={TRANSPOSE_LIMITS.semitones} step={1} pxPerStep={6} format={signedInt} ariaLabel="리전 피치 반음"
        onChange={(next, final) => set({ semitones: next }, '리전 피치', final ? undefined : `region-pitch:${idPrefix}:semis`)} />
      <button type="button" aria-label="1반음 올리기" title="1반음 올리기" disabled={settings.semitones >= TRANSPOSE_LIMITS.semitones} onClick={() => set({ semitones: settings.semitones + 1 }, '피치 +1')}>+</button>
      <button type="button" className="rp-oct" aria-label="한 옥타브 내리기" title="한 옥타브 내리기 (−12)" onClick={() => set({ semitones: Math.max(-TRANSPOSE_LIMITS.semitones, settings.semitones - 12) }, '피치 −12')}>−12</button>
      <button type="button" className="rp-oct" aria-label="한 옥타브 올리기" title="한 옥타브 올리기 (+12)" onClick={() => set({ semitones: Math.min(TRANSPOSE_LIMITS.semitones, settings.semitones + 12) }, '피치 +12')}>+12</button>
    </div>
    <div className="rp-row"><span className="rp-label">센트</span>
      <ValueField value={settings.cents} mixed={mixed} min={-TRANSPOSE_LIMITS.cents} max={TRANSPOSE_LIMITS.cents} step={1} pxPerStep={2} format={v => `${signedInt(v)} ¢`} ariaLabel="리전 피치 센트"
        onChange={(next, final) => set({ cents: next }, '리전 피치 미세 조정', final ? undefined : `region-pitch:${idPrefix}:cents`)} />
    </div>
    <div className="rp-row rp-modes" role="radiogroup" aria-label="피치 모드">
      {TRANSPOSE_MODES.map(mode => <button key={mode} type="button" role="radio" aria-checked={settings.mode === mode} className={settings.mode === mode ? 'on' : ''}
        title={mode === 'keep' ? '길이(템포)를 그대로 두고 피치만 바꿉니다 (타임 스트레치).' : '테이프처럼 피치와 속도가 함께 바뀝니다. 올리면 짧아지고 내리면 길어집니다.'}
        onClick={() => set({ mode }, `피치 모드: ${TRANSPOSE_MODE_LABELS[mode]}`)}>{TRANSPOSE_MODE_LABELS[mode]}</button>)}
    </div>
    <label className="rp-row rp-check" title="목소리처럼 음색(포먼트)이 피치를 따라 변하지 않게 합니다. 템포 유지 모드에서만 쓸 수 있습니다.">
      <input type="checkbox" checked={settings.formant} disabled={settings.mode !== 'keep'} onChange={e => set({ formant: e.target.checked }, '포먼트 유지')} />
      <span>포먼트 유지</span>
    </label>
    <div className="rp-row rp-foot">
      <small className="rp-status" aria-live="polite">{status}</small>
      <button type="button" className="rp-reset" disabled={isDefaultTranspose(settings) && settings.mode === DEFAULT_TRANSPOSE.mode && !settings.formant} onClick={() => onChange(() => ({ ...DEFAULT_TRANSPOSE }), '피치 초기화')}>초기화</button>
    </div>
  </div>
}

/** Small pitch node at the start of the region name ("+3"); click opens the pitch popover. */
export function RegionPitchBadge({ clip, bpm, selected, onChange }: { clip: AudioClip; bpm: number; selected: boolean; onChange: TransposeChange }) {
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null)
  const closedAt = useRef(0)
  const settings = transposeSettings(clip)
  const active = !isDefaultTranspose(settings)
  const pending = regionPitchPending(clip, bpm)
  if (!active && !selected && !open && !pending) return null
  const vari = settings.mode === 'varispeed'
  const text = formatTranspose(settings)
  const title = `리전 피치 ${text} 반음 · ${TRANSPOSE_MODE_LABELS[settings.mode]}${pending ? ' · 렌더링 중' : ''}. 클릭해 조절합니다.`
  return <>
    <button type="button" className={`clip-pitch${active ? ' on' : ''}${vari ? ' vari' : ''}${pending ? ' pending' : ''}`} aria-label={`리전 피치 ${text}, ${TRANSPOSE_MODE_LABELS[settings.mode]}`} aria-haspopup="dialog" aria-expanded={!!open} aria-busy={pending} title={title}
      onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}
      onClick={e => {
        e.stopPropagation()
        if (open || performance.now() - closedAt.current < 250) { setOpen(null); return }
        const rect = e.currentTarget.getBoundingClientRect()
        setOpen({ x: rect.left, y: rect.bottom + 4 })
      }}>
      <b aria-hidden="true">{vari ? '~' : '♪'}</b>{active ? text : '±0'}
    </button>
    {open && <Popover x={open.x} y={open.y} title="리전 피치" className="region-pitch-popover" onClose={() => { closedAt.current = performance.now(); setOpen(null) }}>
      <RegionPitchControls clip={clip} pending={pending} onChange={onChange} idPrefix={clip.id} />
    </Popover>}
  </>
}

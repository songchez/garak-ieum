import { useEffect, useMemo, useRef, useState } from 'react'
import type { Project, RenderBitDepth } from '../core/types'
import { SAMPLE_RATES, type SampleRate } from '../core/audioSettings'
import { DEFAULT_BOUNCE_OPTIONS, DEFAULT_STEM_PATTERN, planStems, type BounceOptions, type StemOptions } from '../core/renderPlan'
import { Icon } from './Icon'
import './Inspector.css'

/** Bounce in place options (docs/BOUNCE_FREEZE_STEMS.md). */
export function BounceDialog({ title, detail, onBounce, onClose }: { title: string; detail: string; onBounce: (options: BounceOptions) => void; onClose: () => void }) {
  const [options, setOptions] = useState<BounceOptions>(DEFAULT_BOUNCE_OPTIONS)
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => { first.current?.focus() }, [])
  const submit = () => onBounce({ ...options, tailSeconds: Math.min(30, Math.max(0, Number.isFinite(options.tailSeconds) ? options.tailSeconds : 0)) })
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <section className="modal new-tracks render-dialog" role="dialog" aria-modal="true" aria-labelledby="bounce-title" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
      <button type="button" className="modal-close icon-button" onClick={onClose} aria-label="창 닫기"><Icon name="close" /></button>
      <h2 id="bounce-title">{title}</h2>
      <p>{detail}</p>
      <div className="new-tracks-details">
        <label className="new-tracks-row new-tracks-check"><input type="checkbox" checked={options.includeEffects} onChange={e => setOptions({ ...options, includeEffects: e.target.checked })} /><span>시김새(이펙트) 포함 · 끄면 원음을 굽고 새 트랙에 시김새를 복사합니다</span></label>
        <label className="new-tracks-row"><span>꼬리 길이 (초)</span><input className="new-tracks-count" type="number" min={0} max={30} step={0.5} value={options.tailSeconds} onChange={e => setOptions({ ...options, tailSeconds: Number(e.target.value) })} /></label>
        <label className="new-tracks-row new-tracks-check"><input type="checkbox" checked={options.normalize} onChange={e => setOptions({ ...options, normalize: e.target.checked })} /><span>노멀라이즈 (리전 게인으로 피크 −0.3 dB)</span></label>
      </div>
      <p className="modal-note">볼륨·팬·센드는 새 트랙으로 옮겨지고, 원본은 뮤트된 채로 남습니다.</p>
      <div className="modal-buttons"><button ref={first} type="button" onClick={onClose}>취소</button><button type="button" className="primary" onClick={submit}>바운스</button></div>
    </section>
  </div>
}

const BIT_DEPTHS: { value: RenderBitDepth; label: string }[] = [{ value: 16, label: '16-bit PCM' }, { value: 24, label: '24-bit PCM' }, { value: 32, label: '32-bit float' }]

/** File → 스템 내보내기…: per-track and per-return WAV files of one length from a chosen start. */
export function StemExportDialog({ project, desktop, playheadBeat, onExport, onClose }: { project: Project; desktop: boolean; playheadBeat: number; onExport: (options: StemOptions) => void; onClose: () => void }) {
  const [options, setOptions] = useState<StemOptions>(() => ({ tracks: true, returns: true, master: 'pre', startBeat: 0, sampleRate: project.sampleRate, bitDepth: 24, pattern: DEFAULT_STEM_PATTERN }))
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => { first.current?.focus() }, [])
  const plan = useMemo(() => planStems(project, options), [project, options])
  const startChoices = [
    { beat: 0, label: '프로젝트 시작' },
    ...(project.loop.enabled ? [{ beat: project.loop.startBeat, label: `사이클 시작 (${+(project.loop.startBeat / project.beatsPerBar + 1).toFixed(2)} 마디)` }] : []),
    ...(playheadBeat > 0 && playheadBeat < project.lengthBeats ? [{ beat: playheadBeat, label: `재생 위치 (${+(playheadBeat / project.beatsPerBar + 1).toFixed(2)} 마디)` }] : []),
  ]
  const set = (patch: Partial<StemOptions>) => setOptions(current => ({ ...current, ...patch }))
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <section className="modal new-tracks render-dialog" role="dialog" aria-modal="true" aria-labelledby="stems-title" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
      <button type="button" className="modal-close icon-button" onClick={onClose} aria-label="창 닫기"><Icon name="close" /></button>
      <h2 id="stems-title">스템 내보내기</h2>
      <p>트랙과 리턴을 각각의 WAV 파일로 만듭니다. 모든 파일은 같은 위치에서 시작해 같은 길이로 끝나므로 다른 프로그램에서 그대로 정렬됩니다.</p>
      <div className="new-tracks-details">
        <label className="new-tracks-row new-tracks-check"><input type="checkbox" checked={options.tracks} onChange={e => set({ tracks: e.target.checked })} /><span>트랙마다 (센드 제외)</span></label>
        <label className="new-tracks-row new-tracks-check"><input type="checkbox" checked={options.returns} onChange={e => set({ returns: e.target.checked })} /><span>리턴마다 (센드로 들어온 소리)</span></label>
        <label className="new-tracks-row"><span>마스터</span><select className="insp-select" value={options.master} onChange={e => set({ master: e.target.value === 'post' ? 'post' : 'pre' })}><option value="pre">마스터 처리 전 (합치면 믹스와 같음)</option><option value="post">마스터 볼륨·처리 후</option></select></label>
        <label className="new-tracks-row"><span>시작 위치</span><select className="insp-select" value={String(options.startBeat)} onChange={e => set({ startBeat: Number(e.target.value) })}>{startChoices.map(choice => <option key={choice.label} value={String(choice.beat)}>{choice.label}</option>)}</select></label>
        <label className="new-tracks-row"><span>샘플레이트</span><select className="insp-select" value={options.sampleRate} onChange={e => set({ sampleRate: Number(e.target.value) as SampleRate })}>{SAMPLE_RATES.map(rate => <option key={rate} value={rate}>{rate / 1000} kHz{rate === project.sampleRate ? ' (프로젝트)' : ''}</option>)}</select></label>
        <label className="new-tracks-row"><span>비트 깊이</span><select className="insp-select" value={options.bitDepth} onChange={e => set({ bitDepth: Number(e.target.value) as RenderBitDepth })}>{BIT_DEPTHS.map(depth => <option key={depth.value} value={depth.value}>{depth.label}</option>)}</select></label>
        <label className="new-tracks-row"><span>파일 이름</span><input className="insp-select" type="text" value={options.pattern} maxLength={120} onChange={e => set({ pattern: e.target.value })} aria-describedby="stem-pattern-help" /></label>
        <p id="stem-pattern-help" className="modal-note">{'{n}'} 번호 · {'{track}'} 트랙 이름 · {'{project}'} 프로젝트 이름 · {'{type}'} track/return</p>
      </div>
      <div className="export-summary stem-summary" data-selectable-text="" tabIndex={0}>
        <span>파일<b>{plan.stems.length}개 · {desktop ? '폴더에 저장' : 'ZIP으로 내려받기'}</b></span>
        {plan.stems.slice(0, 6).map(stem => <span key={stem.trackId}>{stem.kind === 'return' ? '리턴' : '트랙'}<b>{stem.fileName}</b></span>)}
        {plan.stems.length > 6 && <span>…<b>외 {plan.stems.length - 6}개</b></span>}
        {plan.skipped.length > 0 && <span>제외<b>{plan.skipped.map(item => `${item.name} (${item.reason})`).join(', ')}</b></span>}
      </div>
      <div className="modal-buttons"><button ref={first} type="button" onClick={onClose}>취소</button><button type="button" className="primary" disabled={!plan.stems.length} onClick={() => onExport(options)}>스템 내보내기</button></div>
    </section>
  </div>
}

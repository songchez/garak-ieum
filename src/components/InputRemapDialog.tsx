import { useEffect, useRef, useState } from 'react'
import type { InputChoice, Project, TrackInput } from '../core/types'
import { inputText, type InputRemapPlan } from '../core/trackInputs'
import { Icon } from './Icon'
import { InputSelect } from './InputSelect'
import './Inspector.css'

/** Cubase-style "Missing Ports": saved track inputs this device does not offer, each with a chooser.
 * Inputs found again by name are applied together with the choices, as one Undo step. */
export function InputRemapDialog({ project, plan, choices, onApply, onLater }: {
  project: Project; plan: InputRemapPlan; choices: readonly InputChoice[]
  onApply(updates: { trackId: string; input: TrackInput | null }[]): void
  onLater(): void
}) {
  const tracks = plan.missing.flatMap(id => { const track = project.tracks.find(item => item.id === id); return track ? [track] : [] })
  const [chosen, setChosen] = useState<Record<string, TrackInput | null>>({})
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => { first.current?.focus() }, [])
  const useDefault = () => onApply(tracks.map(track => ({ trackId: track.id, input: null })))
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onLater() }}>
    <section className="modal input-remap" role="dialog" aria-modal="true" aria-labelledby="input-remap-title" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onLater() } }}>
      <button type="button" className="modal-close icon-button" onClick={onLater} aria-label="창 닫기"><Icon name="close" /></button>
      <h2 id="input-remap-title">입력을 다시 연결</h2>
      <p>이 프로젝트에 저장된 입력 일부를 지금 장치에서 찾을 수 없습니다. 연결하지 않은 트랙은 녹음·모니터링 때 소리가 들어오지 않습니다.{plan.relinked.length > 0 && ` 이름이 같은 입력을 찾은 ${plan.relinked.length}개 트랙은 함께 다시 연결합니다.`}</p>
      <div className="input-remap-list">
        {tracks.map(track => <label key={track.id} className="new-tracks-row">
          <span title={track.name}><b>{track.name}</b><small>{inputText(track.input)}</small></span>
          <InputSelect input={chosen[track.id] ?? undefined} choices={choices} ariaLabel={`${track.name} 새 입력`} onChange={input => setChosen(value => ({ ...value, [track.id]: input }))} />
        </label>)}
      </div>
      <div className="modal-buttons">
        <button ref={first} type="button" onClick={onLater}>나중에</button>
        <button type="button" onClick={useDefault}>기본 입력 사용</button>
        <button type="button" className="primary" onClick={() => onApply(tracks.map(track => ({ trackId: track.id, input: chosen[track.id] ?? null })))}>적용</button>
      </div>
    </section>
  </div>
}
